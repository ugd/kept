import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import { guardedFetch, PrivateAddressError } from '../net/ssrf.js';

export const FormatId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
export const PrintFormat = z
  .strictObject({
    id: FormatId,
    widthMm: z.number().min(8).max(120),
    printableWidthMm: z.number().min(8).max(120).optional(),
    heightMm: z.number().min(8).max(200),
    dotsPerMm: z.number().min(8).max(12),
  })
  .refine(
    ({ widthMm, printableWidthMm }) =>
      printableWidthMm === undefined || printableWidthMm <= widthMm,
    {
      path: ['printableWidthMm'],
      message: 'Printable width must fit on the roll',
    },
  );
export type PrintFormat = z.infer<typeof PrintFormat>;
export const PrintServerState = z.object({
  state: z.enum(['queued', 'printing', 'done', 'failed', 'uncertain']),
});

export function printServerUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

const Connection = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = URL.parse(value);
    return url !== null && !url.username && !url.password && !url.search && !url.hash;
  }),
  token: z
    .string()
    .min(12)
    .max(512)
    .regex(/^[A-Za-z0-9._~-]+$/),
  formats: z
    .array(PrintFormat)
    .min(1)
    .max(30)
    .refine((formats) => new Set(formats.map(({ id }) => id)).size === formats.length),
});
const FileConfig = Connection.extend({
  locations: z.array(z.uuid()).min(1).max(100),
  allowPrivate: z.boolean().default(false),
});
export const PrintConnectionInput = Connection.partial({ token: true }).extend({
  url: Connection.shape.url.refine(
    (value) => URL.canParse(value) && printServerUrl(value).length <= 500,
  ),
});
export const PrintConnectionView = z.object({
  connection: Connection.omit({ token: true })
    .extend({ source: z.enum(['settings', 'file']) })
    .nullable(),
});
export const PrintServerHealth = z.object({ ok: z.literal(true) });

const publicFetch = guardedFetch({ allowPrivate: false });
const privateFetch = guardedFetch({ allowPrivate: true });
const localHttpFetch = guardedFetch({ allowPrivate: true, privateOnly: true });

export function printJobId(userId: string, batchId: string, requestId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([userId, batchId, requestId]))
    .digest('hex')
    .slice(0, 32);
}

export async function loadPrintServer(file: string | undefined, send?: typeof fetch) {
  if (!file) return undefined;
  let config: z.infer<typeof FileConfig>;
  try {
    config = FileConfig.parse(JSON.parse(await readFile(file, 'utf8')));
    config.url = printServerUrl(config.url);
  } catch {
    // A config error must never include the API key or URL in logs.
    throw new Error(
      'Invalid label print server configuration. Check KEPT_LABEL_PRINT_CONFIG_FILE.',
    );
  }
  return {
    ...printServer(config, { allowPrivate: config.allowPrivate }, send),
    url: config.url,
    formatsFor: (locationId: string) =>
      config.locations.includes(locationId) ? config.formats : [],
  };
}

export function printServer(
  config: { url: string; token: string },
  options: { allowPrivate: boolean; fromSettings?: boolean },
  send?: typeof fetch,
) {
  const privateOnly = options.fromSettings === true && new URL(config.url).protocol === 'http:';
  const request =
    send ?? (privateOnly ? localHttpFetch : options.allowPrivate ? privateFetch : publicFetch);

  async function call<T>(path: string, schema: z.ZodType<T>, payload?: object): Promise<T> {
    try {
      if (privateOnly && !options.allowPrivate)
        throw new PrivateAddressError(new URL(config.url).hostname);
      const response = await request(new URL(`${config.url}/api/kept/v1/${path}`), {
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
      if (path === 'health' && (response.status === 401 || response.status === 403)) {
        throw invalid('The print server rejected the saved API token.');
      }
      if (path.startsWith('jobs/') && response.status === 404) throw notFound();
      if (path === 'jobs' && response.status === 409) throw conflict();
      if (!response.ok) throw new Error('Print server rejected the request');
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof PrivateAddressError) {
        if (privateOnly && options.allowPrivate)
          throw invalid('Use HTTPS for public print server addresses.');
        if (options.fromSettings) throw error;
        throw invalid('Enable private addresses in the label print configuration.');
      }
      if (error instanceof AppError) throw error;
      throw new AppError('internal', 502, 'The label print server did not confirm this request.');
    }
  }

  return {
    check: () => call('health', PrintServerHealth),
    submit: (id: string, format: PrintFormat, png: Buffer) =>
      call('jobs', PrintServerState, { id, format, png: png.toString('base64') }),
    status: (id: string) => call(`jobs/${id}`, PrintServerState),
  };
}
