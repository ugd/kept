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
const maxBytes = 128 * 1024;
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');

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
      if (size > maxBytes) return null;
      chunks.push(chunk);
    }
    const { id, format, png } = JSON.parse(Buffer.concat(chunks).toString());
    if (
      typeof id !== 'string' ||
      !jobId.test(id) ||
      typeof png !== 'string' ||
      !format ||
      format.dotsPerMm !== 8 ||
      !Number.isFinite(format.widthMm) ||
      !Number.isFinite(format.heightMm) ||
      format.widthMm < 8 ||
      format.widthMm > 48 ||
      format.heightMm < 8 ||
      format.heightMm > 200
    )
      return null;
    const image = Buffer.from(png, 'base64');
    if (!image.subarray(0, pngMagic.length).equals(pngMagic)) return null;
    const { width, height, pages } = await sharp(image, {
      limitInputPixels: 384 * 1600,
    }).metadata();
    if (
      pages !== undefined ||
      width !== Math.round(format.widthMm * 8) ||
      height !== Math.round(format.heightMm * 8)
    )
      return null;
    return { id, image, fingerprint: hash(image).toString('hex') };
  } catch {
    return null;
  }
}

export function makeServer({ token, database, printLabel }) {
  if (!/^[A-Za-z0-9._~-]{12,512}$/.test(token ?? '')) throw new Error('Set BRIDGE_TOKEN');
  const expected = hash(`Bearer ${token}`);
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs ((1)) WHERE state IN ('queued', 'printing');
    UPDATE jobs SET state = 'failed' WHERE state = 'queued';
    UPDATE jobs SET state = 'uncertain' WHERE state = 'printing';
  `);
  const find = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const active = db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued', 'printing')");
  const insert = db.prepare("INSERT INTO jobs VALUES (?, ?, 'queued')");
  const update = db.prepare('UPDATE jobs SET state = ? WHERE id = ?');

  async function run({ id, image }) {
    update.run('printing', id);
    try {
      await printLabel(image);
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
    if (request.method === 'GET' && request.url?.startsWith(`${path}/`)) {
      const id = request.url.slice(path.length + 1);
      const job = jobId.test(id) ? find.get(id) : undefined;
      answer(response, job ? 200 : 404, job ? { state: job.state } : { error: 'Not found' });
      return;
    }
    if (request.method === 'POST' && request.url === path) {
      const job = await readPrint(request);
      if (!job) return answer(response, 422, { error: 'Invalid B21S-C2B raster or roll format' });
      const existing = find.get(job.id);
      if (existing) {
        return existing.fingerprint === job.fingerprint
          ? answer(response, 200, { state: existing.state })
          : answer(response, 409, { error: 'Job identifier already in use' });
      }
      if (active.get()) return answer(response, 409, { error: 'Printer is busy' });
      insert.run(job.id, job.fingerprint);
      answer(response, 202, { state: 'queued' });
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
  const printLabel = makePrinter({ transport: NIIMBOT_TRANSPORT, address: NIIMBOT_ADDRESS });
  makeServer({ token: BRIDGE_TOKEN, database: 'data/jobs.sqlite', printLabel }).listen(
    port,
    LISTEN_HOST,
    () => {
      console.log(`NIIMBOT bridge listening on ${LISTEN_HOST}:${port}`);
    },
  );
}
