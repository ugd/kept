import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { makeServer } from './server.mjs';

for (const format of [
  { id: '50x30', widthMm: 50, printableWidthMm: 48, heightMm: 30, dotsPerMm: 8 },
  { id: '40x40', widthMm: 40, printableWidthMm: 40, heightMm: 40, dotsPerMm: 8 },
]) {
  test(`accepts a ${format.id} mm roll at eight dots per millimetre`, async (t) => {
    const token = 'test-only-bridge-token';
    const { promise: printed, resolve: print } = Promise.withResolvers();
    const server = makeServer({
      token,
      database: ':memory:',
      async printLabels([png]) {
        print(png);
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/api/kept/v1/jobs`;
    const width = format.printableWidthMm * format.dotsPerMm;
    const height = format.heightMm * format.dotsPerMm;
    const png = await sharp({ create: { width, height, channels: 3, background: 'white' } })
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
    assert.equal((await post({ ...format, printableWidthMm: format.widthMm + 1 })).status, 422);
    assert.equal((await post(format)).status, 202);
    assert.deepEqual(await printed, png);
  });
}

test('the bridge validates the raster, authorizes Kept and prints a retry just once', async (t) => {
  const token = 'test-only-bridge-token';
  let printed;
  let copiesPrinted;
  let calls = 0;
  let finish;
  const printing = new Promise((resolve) => {
    finish = resolve;
  });
  const server = makeServer({
    token,
    database: ':memory:',
    async printLabels([png], copies) {
      printed = png;
      copiesPrinted = copies;
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
    { ok: true, maxCopies: 0x7fff, maxLabels: 1000 },
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
    copies: 3,
  };
  const post = (body, auth = token) =>
    fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post(job, 'wrong')).status, 401);
  assert.equal((await post({ ...job, format: { ...job.format, widthMm: 30 } })).status, 422);
  for (const copies of [0, 1.5, 0x8000]) assert.equal((await post({ ...job, copies })).status, 422);
  assert.equal((await post(job)).status, 202);
  assert.equal((await post(job)).status, 200);
  assert.equal((await post({ ...job, copies: 2 })).status, 409);
  assert.equal((await post({ ...job, id: 'aa'.repeat(16) })).status, 409);
  finish();
  const status = await fetch(`${base}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await status.json(), { state: 'done' });
  assert.equal(calls, 1);
  assert.equal(copiesPrinted, 3);
  assert.deepEqual(printed, png);
});

test('a batch validates every label before printing and preserves partial progress on retry', async (t) => {
  const token = 'test-only-bridge-token';
  const firstDone = Promise.withResolvers();
  const next = Promise.withResolvers();
  const received = [];
  const server = makeServer({
    token,
    database: ':memory:',
    async printLabels(images, copies, onLabelPrinted) {
      received.push({ images, copies });
      onLabelPrinted();
      firstDone.resolve();
      await next.promise;
      throw Object.assign(new Error('Lost printer status'), { uncertain: true });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    next.resolve();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/kept/v1/jobs`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const images = [];
  for (const background of ['white', 'black']) {
    images.push(
      await sharp({ create: { width: 384, height: 240, channels: 3, background } })
        .png()
        .toBuffer(),
    );
  }
  const id = 'de'.repeat(16);
  const job = {
    id,
    format: { id: '50x30', widthMm: 50, printableWidthMm: 48, heightMm: 30, dotsPerMm: 8 },
    copies: 2,
    pngs: images.map((image) => image.toString('base64')),
  };
  const post = (body) => fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ ...job, pngs: [job.pngs[0], 'bad raster'] })).status, 422);
  assert.equal(received.length, 0);
  assert.equal((await post(job)).status, 202);
  await firstDone.promise;
  assert.deepEqual(await (await post(job)).json(), {
    state: 'printing',
    totalLabels: 2,
    printedLabels: 1,
  });
  assert.equal((await post({ ...job, pngs: [...job.pngs].reverse() })).status, 409);
  assert.equal((await post({ ...job, id: 'ff'.repeat(16) })).status, 409);
  next.resolve();
  const status = await fetch(`${base}/${id}`, { headers });
  assert.deepEqual(await status.json(), { state: 'uncertain', totalLabels: 2, printedLabels: 1 });
  assert.equal((await post(job)).status, 200);
  assert.deepEqual(received, [{ images, copies: 2 }]);
});
