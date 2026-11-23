import type pg from 'pg';
import { z } from 'zod';
import { allowPrivateAddresses } from '../ai/runtime.js';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { rateLimited } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import { open, type Sealed, seal } from '../crypto/envelope.js';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireRole } from '../things/service.js';
import {
  type loadPrintServer,
  PrintConnectionInput,
  PrintConnectionView,
  type PrintFormat,
  PrintServerHealth,
  printServer,
  printServerUrl,
} from './print-server.js';

type FilePrinter = Awaited<ReturnType<typeof loadPrintServer>>;
type View = z.infer<typeof PrintConnectionView>;
type SettingsRow = { base_url: string; formats: PrintFormat[] };

const aad = (rowId: string) => ({ table: 'label_print_connections', rowId, fieldKey: 'config' });
const params = z.object({ id: z.uuid() });

async function settingsRow(client: pg.ClientBase, locationId: string) {
  const { rows } = await client.query<SettingsRow>(
    'SELECT base_url, formats FROM public.label_print_connections WHERE location_id = $1',
    [locationId],
  );
  return rows[0];
}

async function requireSettings(tx: Tx, client: pg.ClientBase, scope: Scope, locationId: string) {
  await requireRole(client, locationId, 'location.settings');
  if (scope.tokenId) throw forbidden();
  if (!(await locationModuleSet(tx, locationId))?.has('labels'))
    throw new AppError('module_off', 404);
}

export function registerPrintSettings(app: KeptApp, deps: InventoryDeps, file: FilePrinter) {
  const { pools } = deps;
  const keys = () => {
    if (!deps.secretKeys)
      throw new AppError('internal', 503, 'Print server credential storage is unavailable.');
    return deps.secretKeys.get();
  };

  function fileConnection(locationId: string): View['connection'] {
    const formats = file?.formatsFor(locationId);
    return file && formats?.length ? { url: file.url, formats, source: 'file' } : null;
  }

  // Call after the scoped transaction has checked permission to manage or use this printer.
  async function printerFor(locationId: string) {
    const { rows } = await pools.system.query<{
      formats: PrintFormat[];
      config_ciphertext: Sealed;
    }>('SELECT formats, config_ciphertext FROM kept.label_print_config($1)', [locationId]);
    const row = rows[0];
    if (row) {
      const config: { url: string; token: string } = JSON.parse(
        open(keys().keyring, row.config_ciphertext, aad(locationId)).toString('utf8'),
      );
      const allowPrivate = await allowPrivateAddresses(pools);
      return {
        printer: printServer(config, { allowPrivate, fromSettings: true }),
        formats: row.formats,
      };
    }
    if (file && fileConnection(locationId))
      return { printer: file, formats: file.formatsFor(locationId) };
    throw notFound();
  }

  async function formatsFor(client: pg.ClientBase, locationId: string) {
    return (await settingsRow(client, locationId))?.formats ?? file?.formatsFor(locationId) ?? [];
  }

  function lock(client: pg.ClientBase, locationId: string) {
    return client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('label-print:' || $1::text, 0))",
      [locationId],
    );
  }

  app.get(
    '/api/v1/locations/:id/label-print-server',
    { schema: { params, response: { 200: PrintConnectionView } } },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope): Promise<View> => {
        const locationId = req.params.id.toLowerCase();
        await requireSettings(tx, client, scope, locationId);
        const row = await settingsRow(client, locationId);
        return {
          connection: row
            ? { url: row.base_url, formats: row.formats, source: 'settings' }
            : fileConnection(locationId),
        };
      }),
  );

  app.put(
    '/api/v1/locations/:id/label-print-server',
    { schema: { params, body: PrintConnectionInput, response: { 200: PrintConnectionView } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const locationId = req.params.id.toLowerCase();
        await requireSettings(tx, client, scope, locationId);
        await lock(client, locationId);
        const { token, formats } = req.body;
        const url = printServerUrl(req.body.url);
        const existing = await settingsRow(client, locationId);
        if (token) {
          const { current } = keys();
          const encrypted = seal(current, JSON.stringify({ url, token }), aad(locationId));
          await client.query(
            `INSERT INTO public.label_print_connections (location_id, base_url, formats, config_ciphertext, key_version)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
           ON CONFLICT (location_id) DO UPDATE SET base_url = $2,
             formats = $3::jsonb, config_ciphertext = $4::jsonb, key_version = $5`,
            [
              locationId,
              url,
              JSON.stringify(formats),
              JSON.stringify(encrypted),
              current.keyVersion,
            ],
          );
        } else {
          if (existing?.base_url !== url)
            throw invalid('Enter the print server token for this address.');
          await client.query(
            'UPDATE public.label_print_connections SET formats = $2::jsonb WHERE location_id = $1',
            [locationId, JSON.stringify(formats)],
          );
        }
        await audited(tx, {
          locationId,
          actor: actorOf(scope),
          action: 'labels.print_connection_saved',
          entity: { type: 'location', id: locationId },
          after: { format_count: formats.length },
          requestId: req.id,
        });
        const body: View = { connection: { url, formats, source: 'settings' } };
        return { status: 200, body };
      }),
  );

  app.delete('/api/v1/locations/:id/label-print-server', { schema: { params } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      const locationId = req.params.id.toLowerCase();
      await requireSettings(tx, client, scope, locationId);
      await lock(client, locationId);
      const deleted = await client.query(
        'DELETE FROM public.label_print_connections WHERE location_id = $1',
        [locationId],
      );
      if (deleted.rowCount)
        await audited(tx, {
          locationId,
          actor: actorOf(scope),
          action: 'labels.print_connection_removed',
          entity: { type: 'location', id: locationId },
          requestId: req.id,
        });
      return { status: 204, body: undefined };
    }),
  );

  app.post(
    '/api/v1/locations/:id/label-print-server/check',
    { schema: { params, response: { 200: PrintServerHealth } } },
    async (req, reply) => {
      const locationId = req.params.id.toLowerCase();
      const userId = await scopedRead(pools, req, async (tx, client, scope) => {
        await requireSettings(tx, client, scope, locationId);
        return scope.userId;
      });
      const decision = await reserveInWindow(
        pools.auth,
        limiterKey('label-print-check', userId),
        6,
        60,
      );
      if (!decision.allowed) throw rateLimited(reply, decision.retryAfter);
      const { printer } = await printerFor(locationId);
      return printer.check();
    },
  );

  return { formatsFor, printerFor };
}
