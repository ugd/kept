import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { MAX_LABEL_PRINT_COPIES, newId } from '@kept/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, own } from '../../test/things.js';
import { fixedSecretKeys } from '../crypto/keyring.js';

const token = 'test-only-label-print-key';
const formats = [{ id: '50x30', widthMm: 50, printableWidthMm: 48, heightMm: 30, dotsPerMm: 8 }];
const submissions: {
  id: string;
  format: (typeof formats)[number];
  png: string;
  copies?: number;
}[] = [];
const bridge = createServer(async (req, res) => {
  const answer = (status: number, body: object) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (req.headers.authorization !== `Bearer ${token}`) return answer(401, { ok: false });
  if (req.method === 'GET' && req.url === '/api/kept/v1/health')
    return answer(200, { ok: true, maxCopies: MAX_LABEL_PRINT_COPIES });
  if (req.method === 'POST' && req.url === '/api/kept/v1/jobs') {
    let payload = '';
    for await (const chunk of req) payload += chunk;
    submissions.push(JSON.parse(payload));
    return answer(202, { state: 'queued' });
  }
  if (req.method === 'GET' && submissions.some(({ id }) => req.url === `/api/kept/v1/jobs/${id}`)) {
    return answer(200, { state: 'done' });
  }
  return answer(404, {});
});
let db: TestDb;
let app: TestApp;
let home: Loc;
let ibrahim: Person;
let louis: Person;
let talia: Person;
let url: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  const key = randomBytes(32);
  app = await peopleApp(db, {
    secretKeys: fixedSecretKeys({ current: { key, keyVersion: 1 }, keyring: new Map([[1, key]]) }),
  });
  ibrahim = await person(app, db, 'ibrahim');
  louis = await person(app, db, 'louis');
  talia = await person(app, db, 'talia');
  home = await createLocation(app, db, ibrahim, 'household');
  await join(db, home.id, louis.userId, 'member');
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const addr = bridge.address();
  if (typeof addr !== 'object' || !addr) throw new Error('Missing test listener');
  url = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  bridge.close();
  await app?.app.close();
});

// catalogue: PUT /api/v1/locations/:id/label-print-server
// catalogue: DELETE /api/v1/locations/:id/label-print-server
it('saves and removes a location print connection while keeping its token out of reads and audit', async () => {
  const route = `/api/v1/locations/${home.id}/label-print-server`;
  expect((await call(app, route, { as: louis })).statusCode).toBe(403);
  expect((await call(app, route, { as: talia })).statusCode).toBe(404);
  const save = (as: Person, body: unknown) => call(app, route, { as, method: 'PUT', body });
  expect((await save(louis, { url, token, formats })).statusCode).toBe(403);
  expect((await save(ibrahim, { url: 'invalid address', token, formats })).statusCode).toBe(400);
  expect((await save(ibrahim, { url: `${url}/?x=y`, token, formats })).statusCode).toBe(400);
  const saved = await save(ibrahim, { url: `${url}/`, token, formats });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json()).toEqual({ connection: { url, formats, source: 'settings' } });
  expect(saved.body).not.toContain(token);
  expect((await call(app, route, { as: ibrahim })).json()).toEqual(saved.json());
  expect((await save(ibrahim, { url, formats })).statusCode).toBe(200);
  expect((await save(ibrahim, { url: 'https://bridge.example.org', formats })).statusCode).toBe(
    400,
  );
  expect(
    (await call(app, `/api/v1/labels/print-server?locationId=${home.id}`, { as: louis })).json(),
  ).toEqual({ formats });
  const check = () => call(app, `${route}/check`, { as: ibrahim, body: {} });
  expect((await check()).json()).toMatchObject({ code: 'private_address' });
  await own(
    db,
    "INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')",
  );
  expect((await check()).json()).toEqual({ ok: true, maxCopies: MAX_LABEL_PRINT_COPIES });
  expect(submissions).toHaveLength(0);
  const sealed = await own<{ config_ciphertext: unknown }>(
    db,
    'SELECT config_ciphertext FROM public.label_print_connections WHERE location_id = $1',
    [home.id],
  );
  expect(sealed).toHaveLength(1);
  expect(JSON.stringify(sealed)).not.toContain(token);

  const created = await call(app, '/api/v1/labels/batches', {
    as: louis,
    body: { locationId: home.id, kind: 'blank', blankCount: 1, stock: 'a4_24_70x37' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const { batch } = created.json();
  const choice = { formatId: '50x30', code: batch.labels[0].code, requestId: newId(), copies: 3 };
  const jobs = `/api/v1/labels/batches/${batch.id}/print-server/jobs`;
  expect(
    (await call(app, jobs, { as: louis, body: { ...choice, copies: MAX_LABEL_PRINT_COPIES + 1 } }))
      .statusCode,
  ).toBe(400);
  expect(submissions).toHaveLength(0);
  expect((await call(app, jobs, { as: louis, body: choice })).json()).toEqual({ state: 'queued' });
  expect((await call(app, `${jobs}/${choice.requestId}`, { as: louis })).json()).toEqual({
    state: 'done',
  });
  expect(submissions).toHaveLength(1);
  const sent = submissions[0];
  expect(sent?.copies).toBe(3);
  expect(sent?.format).toEqual(formats[0]);
  expect(await sharp(Buffer.from(sent?.png ?? '', 'base64')).metadata()).toMatchObject({
    width: 384,
    height: 240,
  });

  expect((await call(app, route, { as: ibrahim, method: 'DELETE' })).statusCode).toBe(204);
  const events = (await auditOf(db, home.id)).filter(({ action }) =>
    action.startsWith('labels.print_connection'),
  );
  expect(events.map(({ action }) => action)).toEqual([
    'labels.print_connection_saved',
    'labels.print_connection_saved',
    'labels.print_connection_removed',
  ]);
  expect(JSON.stringify(events)).not.toContain(token);
});
