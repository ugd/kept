import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { renderPrintLabel } from './print-label.js';
import { loadPrintServer, PrintFormat, printServer } from './print-server.js';

const locationId = 'a42fb121-67a9-47bf-81a7-fee06306712d';
const format = { id: '12x30', widthMm: 12, heightMm: 30, dotsPerMm: 8 };
const label = { code: 'ABC123', url: 'https://kept.example.org/l/ABC123' };

describe('server label printing', () => {
  it('requires the bridge to advertise copy support before sending a multi-copy job', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
    const printer = printServer(
      { url: 'https://bridge.example.org', token: 'test-only-token' },
      { allowPrivate: false },
      fetch,
    );
    await expect(printer.submit('ab'.repeat(16), format, Buffer.alloc(0), 3)).rejects.toMatchObject(
      { code: 'validation' },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://bridge.example.org/api/kept/v1/health');
  });

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

  it('uses the printable width for the raster while retaining the physical roll size', async () => {
    const roll = PrintFormat.parse({
      id: '50x30',
      widthMm: 50,
      printableWidthMm: 48,
      heightMm: 30,
      dotsPerMm: 8,
    });
    const image = await renderPrintLabel(label, roll);
    expect(await sharp(image).metadata()).toMatchObject({ width: 384, height: 240 });
    expect(roll.widthMm).toBe(50);
    expect(PrintFormat.safeParse({ ...roll, printableWidthMm: 51 }).success).toBe(false);
  });

  it.each([
    { id: '50x30', widthMm: 50, printableWidthMm: 48, heightMm: 30 },
    { id: '40x40', widthMm: 40, printableWidthMm: 40, heightMm: 40 },
  ])('fits the QR, code, name and location on $id stock', async (stock) => {
    const roll = { ...stock, dotsPerMm: 8 };
    const withDetails = { ...label, name: 'Dulap', path: 'Camera mea' };
    const raw = async (png: Buffer) =>
      sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = await raw(await renderPrintLabel(withDetails, roll));
    const { data: codeOnly } = await raw(await renderPrintLabel(label, roll));
    const { data: withoutLocation } = await raw(
      await renderPrintLabel({ ...withDetails, path: '' }, roll),
    );
    const { width, height } = info;
    expect([width, height]).toEqual([stock.printableWidthMm * 8, stock.heightMm * 8]);
    expect(new Set(data)).toEqual(new Set([0, 255]));
    const left = (ink: Buffer, y: number) => ink.subarray(y * width, y * width + width / 2);
    const right = (ink: Buffer, y: number) => ink.subarray(y * width + width / 2, (y + 1) * width);
    const text = (ink: Buffer) => Array.from({ length: height }, (_, y) => right(ink, y));
    expect(left(data, Math.floor(height / 2)).includes(0)).toBe(true);
    expect(text(data).some((row) => row.includes(0))).toBe(true);
    expect(text(data)).not.toEqual(text(codeOnly));
    expect(text(data)).not.toEqual(text(withoutLocation));
    for (let y = 0; y < height; y++) {
      expect(left(data, y)).toEqual(left(codeOnly, y));
      expect(data[y * width]).toBe(255);
      expect(data[(y + 1) * width - 1]).toBe(255);
    }
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
