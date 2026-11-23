import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { printedCode, SHORT_CODE } from '@kept/shared';
import sharp from 'sharp';
import { encode } from 'uqr';
import { z } from 'zod';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import { guardedFetch, PrivateAddressError } from '../net/ssrf.js';
import { drawShortCode } from './print-short-code.js';

export const FormatId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
export const PrintFormat = z.strictObject({
  id: FormatId,
  widthMm: z.number().min(8).max(120),
  heightMm: z.number().min(8).max(200),
  dotsPerMm: z.number().min(8).max(12),
});
export type PrintFormat = z.infer<typeof PrintFormat>;
export const PrintServerState = z.object({
  state: z.enum(['queued', 'printing', 'done', 'failed', 'uncertain']),
});

const Config = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }),
  token: z
    .string()
    .min(12)
    .max(512)
    .regex(/^[A-Za-z0-9._~-]+$/),
  locations: z.array(z.uuid()).min(1).max(100),
  formats: z
    .array(PrintFormat)
    .min(1)
    .max(30)
    .refine((formats) => new Set(formats.map(({ id }) => id)).size === formats.length),
  allowPrivate: z.boolean().default(false),
});

export function printJobId(userId: string, batchId: string, requestId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([userId, batchId, requestId]))
    .digest('hex')
    .slice(0, 32);
}

export async function loadPrintServer(file: string | undefined, send?: typeof fetch) {
  if (!file) return undefined;
  let config: z.infer<typeof Config>;
  try {
    config = Config.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    // A config error must never include the API key or URL in logs.
    throw new Error(
      'Invalid label print server configuration. Check KEPT_LABEL_PRINT_CONFIG_FILE.',
    );
  }
  const request = send ?? guardedFetch({ allowPrivate: config.allowPrivate });
  const base = config.url.replace(/\/+$/, '');

  async function job(path: string, payload?: object) {
    let response: Response;
    try {
      response = await request(new URL(`${base}/api/kept/v1/jobs${path}`), {
        method: payload ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 404 && !payload) throw notFound();
      if (response.status === 409) throw conflict();
      if (!response.ok) throw new Error('Print server rejected the request');
      return PrintServerState.parse(await response.json());
    } catch (error) {
      if (error instanceof PrivateAddressError)
        throw invalid('Enable private addresses in the label print configuration.');
      if (error instanceof AppError) throw error;
      throw new AppError('internal', 502, 'The label print server did not confirm this request.');
    }
  }

  return {
    formatsFor: (locationId: string) =>
      config.locations.includes(locationId) ? config.formats : [],
    submit: (id: string, format: PrintFormat, png: Buffer) =>
      job('', { id, format, png: png.toString('base64') }),
    status: (id: string) => job(`/${id}`),
  };
}

/** Render the same immutable Kept URL and short ID for the preview and the job. */
export async function renderPrintLabel(label: { code: string; url: string }, format: PrintFormat) {
  if (!SHORT_CODE.test(label.code)) throw invalid();
  const width = Math.round(format.widthMm * format.dotsPerMm);
  const height = Math.round(format.heightMm * format.dotsPerMm);
  const matrix = encode(label.url, { ecc: 'M', border: 4 }).data;
  const text = printedCode(label.code);
  const charactersWide = text.length * 6 - 1;
  const textScale = Math.min(
    Math.max(1, Math.round(format.dotsPerMm / 4)),
    Math.floor((width - 4) / charactersWide),
  );
  const textSpace = 7 * textScale + 4;
  const scale = Math.floor(Math.min(width - 4, height - textSpace - 4) / matrix.length);
  if (scale < 2)
    throw invalid('The label is too small to fit this QR code at the printer resolution.');

  const side = matrix.length * scale;
  const startX = Math.floor((width - side) / 2);
  const startY = Math.floor((height - side - textSpace) / 2);
  let path = '';
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${startX + x * scale} ${startY + y * scale}h${scale}v${scale}h-${scale}z`;
    });
  });
  path += drawShortCode(
    text,
    textScale,
    Math.floor((width - charactersWide * textScale) / 2),
    startY + side + 2,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>
    <path d="${path}" fill="#000" shape-rendering="crispEdges"/>
  </svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: '#fff' }).threshold(128).png().toBuffer();
}
