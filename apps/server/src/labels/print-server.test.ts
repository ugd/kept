import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { loadPrintServer, renderPrintLabel } from './print-server.js';

const locationId = 'a42fb121-67a9-47bf-81a7-fee06306712d';
const format = { id: '12x30', widthMm: 12, heightMm: 30, dotsPerMm: 8 };
const label = { code: 'ABC123', url: 'https://kept.example.org/l/ABC123' };

describe('server label printing', () => {
  it('renders an opaque 96 × 240 raster for 12 × 30 mm at eight dots per millimetre', async () => {
    const png = await renderPrintLabel(label, format);
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([96, 240, 1]);
    expect(new Set(data)).toEqual(new Set([0, 255]));
    expect(data[0]).toBe(255);
    expect(data.subarray(50 * 96, 140 * 96).includes(0)).toBe(true);
    expect(data.subarray(145 * 96, 176 * 96).includes(0)).toBe(true);
  });

  it('refuses to shrink a QR below two dots per module', async () => {
    await expect(
      renderPrintLabel({ ...label, url: `${label.url}${'abc'.repeat(60)}` }, format),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('uses a server-side credential and an idempotent job identifier for the configured location', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kept-print-'));
    try {
      const path = join(directory, 'print.json');
      await writeFile(
        path,
        JSON.stringify({
          url: 'https://bridge.example.org/',
          token: 'test-only-token',
          locations: [locationId],
          formats: [format],
        }),
      );
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () =>
          Response.json({ state: 'queued', ignored: 'test-only-token' }),
        );
      const server = await loadPrintServer(path, fetch);
      expect(server?.formatsFor(locationId)).toEqual([format]);
      expect(server?.formatsFor('other')).toEqual([]);
      const id = 'ab'.repeat(16);
      const png = await renderPrintLabel(label, format);
      await expect(server?.submit(id, format, png)).resolves.toEqual({ state: 'queued' });
      const [url, options] = fetch.mock.calls[0] as [URL, RequestInit];
      expect(String(url)).toBe('https://bridge.example.org/api/kept/v1/jobs');
      expect(new Headers(options.headers).get('authorization')).toBe('Bearer test-only-token');
      expect(JSON.parse(String(options.body))).toEqual({ id, format, png: png.toString('base64') });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
