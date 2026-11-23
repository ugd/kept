import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { makeServer } from './server.mjs';

test('accepts a 50 mm roll using 48 mm of printable width', async (t) => {
  const token = 'test-only-bridge-token';
  const { promise: printed, resolve: print } = Promise.withResolvers();
  const server = makeServer({
    token,
    database: ':memory:',
    async printLabel(png) {
      print(png);
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/kept/v1/jobs`;
  const format = { id: '50x30', widthMm: 50, printableWidthMm: 48, heightMm: 30, dotsPerMm: 8 };
  const png = await sharp({ create: { width: 384, height: 240, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const post = (selectedFormat) =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'af'.repeat(16),
        format: selectedFormat,
        png: png.toString('base64'),
      }),
    });
  assert.equal((await post({ ...format, printableWidthMm: 50 })).status, 422);
  assert.equal((await post(format)).status, 202);
  assert.deepEqual(await printed, png);
});

test('the bridge validates the raster, authorizes Kept and prints a retry just once', async (t) => {
  const token = 'test-only-bridge-token';
  let printed;
  let calls = 0;
  let finish;
  const printing = new Promise((resolve) => {
    finish = resolve;
  });
  const server = makeServer({
    token,
    database: ':memory:',
    async printLabel(png) {
      printed = png;
      calls += 1;
      await printing;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    finish();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/kept/v1/jobs`;
  const health = new URL('../health', `${base}/`);
  assert.equal((await fetch(health)).status, 401);
  assert.deepEqual(
    await (await fetch(health, { headers: { Authorization: `Bearer ${token}` } })).json(),
    { ok: true },
  );
  assert.equal(calls, 0);
  const png = await sharp({ create: { width: 96, height: 240, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const id = 'bc'.repeat(16);
  const job = {
    id,
    format: { id: '12x30', widthMm: 12, heightMm: 30, dotsPerMm: 8 },
    png: png.toString('base64'),
  };
  const post = (body, auth = token) =>
    fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post(job, 'wrong')).status, 401);
  assert.equal((await post({ ...job, format: { ...job.format, widthMm: 30 } })).status, 422);
  assert.equal((await post(job)).status, 202);
  assert.equal((await post(job)).status, 200);
  assert.equal((await post({ ...job, id: 'aa'.repeat(16) })).status, 409);
  finish();
  const status = await fetch(`${base}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await status.json(), { state: 'done' });
  assert.equal(calls, 1);
  assert.deepEqual(printed, png);
});
