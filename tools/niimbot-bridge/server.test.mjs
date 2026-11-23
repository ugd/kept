import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { makeServer } from './server.mjs';

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
