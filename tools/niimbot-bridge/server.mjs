import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { makePrinter } from './printer.mjs';

const path = '/api/kept/v1/jobs';
const hash = (value) => createHash('sha256').update(value).digest();
const jobId = /^[a-f0-9]{32}$/;
const MAX_PNG_LENGTH = 128 * 1024;
const MAX_JOB_BYTES = 16 * 1024 * 1024;
const MAX_LABELS = 1000;
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_ROLL_WIDTH_MM = 50;
const MAX_PRINTABLE_WIDTH_MM = 48;
const DOTS_PER_MM = 8;
// The B1 task reads the completed copy count as a signed 16-bit number.
const MAX_COPIES = 0x7fff;

function answer(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readPrint(request) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_JOB_BYTES) return null;
      chunks.push(chunk);
    }
    const { id, format, png, pngs, copies = 1 } = JSON.parse(Buffer.concat(chunks).toString());
    const { widthMm, heightMm, dotsPerMm, printableWidthMm = widthMm } = format ?? {};
    if (
      typeof id !== 'string' ||
      !jobId.test(id) ||
      (pngs === undefined
        ? typeof png !== 'string'
        : png !== undefined ||
          !Array.isArray(pngs) ||
          pngs.length < 2 ||
          pngs.length > MAX_LABELS) ||
      !Number.isInteger(copies) ||
      copies < 1 ||
      copies > MAX_COPIES ||
      dotsPerMm !== DOTS_PER_MM ||
      !Number.isFinite(widthMm) ||
      widthMm < 8 ||
      widthMm > MAX_ROLL_WIDTH_MM ||
      !Number.isFinite(printableWidthMm) ||
      printableWidthMm < 8 ||
      printableWidthMm > Math.min(widthMm, MAX_PRINTABLE_WIDTH_MM) ||
      !Number.isFinite(heightMm) ||
      heightMm < 8 ||
      heightMm > 200
    )
      return null;
    const images = [];
    for (const raster of pngs ?? [png]) {
      if (typeof raster !== 'string' || raster.length > MAX_PNG_LENGTH) return null;
      const image = Buffer.from(raster, 'base64');
      if (!image.subarray(0, pngMagic.length).equals(pngMagic)) return null;
      const { width, height, pages } = await sharp(image, {
        limitInputPixels: 384 * 1600,
      }).metadata();
      if (
        pages !== undefined ||
        width !== Math.round(printableWidthMm * DOTS_PER_MM) ||
        height !== Math.round(heightMm * DOTS_PER_MM)
      )
        return null;
      images.push(image);
    }
    return { id, images, fingerprint: fingerprint(images, copies), copies };
  } catch {
    return null;
  }
}

function fingerprint(images, copies) {
  const [first] = images;
  // Preserve the fingerprints stored by bridges that only printed one label per job.
  if (images.length === 1 && copies === 1) return hash(first).toString('hex');
  const digest = createHash('sha256')
    .update(images.length === 1 ? 'kept-print-copies' : 'kept-print-batch')
    .update(String(copies))
    .update('\0');
  for (const image of images) digest.update(images.length === 1 ? image : hash(image));
  return digest.digest('hex');
}

function jobState({ state, total_labels, printed_labels }) {
  return total_labels > 1
    ? { state, totalLabels: total_labels, printedLabels: printed_labels }
    : { state };
}

export function makeServer({ token, database, printLabels }) {
  if (!/^[A-Za-z0-9._~-]{12,512}$/.test(token ?? '')) throw new Error('Set BRIDGE_TOKEN');
  const expected = hash(`Bearer ${token}`);
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs ((1)) WHERE state IN ('queued', 'printing');
    UPDATE jobs SET state = 'failed' WHERE state = 'queued';
    UPDATE jobs SET state = 'uncertain' WHERE state = 'printing';
  `);
  const columns = db
    .prepare('PRAGMA table_info(jobs)')
    .all()
    .map(({ name }) => name);
  if (!columns.includes('total_labels')) {
    db.exec('ALTER TABLE jobs ADD COLUMN total_labels INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.includes('printed_labels')) {
    db.exec('ALTER TABLE jobs ADD COLUMN printed_labels INTEGER NOT NULL DEFAULT 0');
  }
  const find = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const active = db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued', 'printing')");
  const insert = db.prepare(
    "INSERT INTO jobs (id, fingerprint, state, total_labels) VALUES (?, ?, 'queued', ?)",
  );
  const update = db.prepare('UPDATE jobs SET state = ? WHERE id = ?');
  const advance = db.prepare('UPDATE jobs SET printed_labels = printed_labels + 1 WHERE id = ?');

  async function run({ id, images, copies }) {
    update.run('printing', id);
    try {
      await printLabels(images, copies, () => advance.run(id));
      update.run('done', id);
    } catch (error) {
      update.run(error.uncertain ? 'uncertain' : 'failed', id);
      console.warn('NIIMBOT job did not complete', error.message);
    }
  }

  const server = createServer(async (request, response) => {
    if (!timingSafeEqual(hash(request.headers.authorization ?? ''), expected)) {
      answer(response, 401, { error: 'Unauthorized' });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/kept/v1/health') {
      answer(response, 200, { ok: true, maxCopies: MAX_COPIES, maxLabels: MAX_LABELS });
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith(`${path}/`)) {
      const id = request.url.slice(path.length + 1);
      const job = jobId.test(id) ? find.get(id) : undefined;
      answer(response, job ? 200 : 404, job ? jobState(job) : { error: 'Not found' });
      return;
    }
    if (request.method === 'POST' && request.url === path) {
      const job = await readPrint(request);
      if (!job)
        return answer(response, 422, {
          error: 'Invalid B21S-C2B raster, roll format or copy count',
        });
      const existing = find.get(job.id);
      if (existing) {
        return existing.fingerprint === job.fingerprint
          ? answer(response, 200, jobState(existing))
          : answer(response, 409, { error: 'Job identifier already in use' });
      }
      if (active.get()) return answer(response, 409, { error: 'Printer is busy' });
      insert.run(job.id, job.fingerprint, job.images.length);
      answer(response, 202, jobState(find.get(job.id)));
      setImmediate(() => void run(job));
      return;
    }
    answer(response, 404, { error: 'Not found' });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    BRIDGE_TOKEN,
    NIIMBOT_TRANSPORT = 'ble',
    NIIMBOT_ADDRESS,
    PORT = '8788',
    LISTEN_HOST = '127.0.0.1',
  } = process.env;
  if (!NIIMBOT_ADDRESS || !['ble', 'serial'].includes(NIIMBOT_TRANSPORT))
    throw new Error('Set NIIMBOT_ADDRESS and NIIMBOT_TRANSPORT');
  const port = Number(PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535');
  await mkdir('data', { recursive: true, mode: 0o700 });
  const printLabels = makePrinter({ transport: NIIMBOT_TRANSPORT, address: NIIMBOT_ADDRESS });
  makeServer({ token: BRIDGE_TOKEN, database: 'data/jobs.sqlite', printLabels }).listen(
    port,
    LISTEN_HOST,
    () => {
      console.log(`NIIMBOT bridge listening on ${LISTEN_HOST}:${port}`);
    },
  );
}
