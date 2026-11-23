import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { LabelPrintConnection, LabelPrintFormat } from '@/api/capture/types';
import { api } from '@/api/client';
import { ErrorState, LoadingRows, Notice, Section, useErrorText } from '@/components/page';
import { isPrivateAddressError, PrivateAddressLink } from '@/components/private-address-link';
import { parseNumber } from '@/components/things/form-model';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { PasswordField } from '@/components/ui/password-field';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';

type Settings = { connection: LabelPrintConnection | null };
type Draft = { [Key in keyof Required<LabelPrintFormat>]: string };

const settingsKey = (locationId: string) => ['labels', 'print-server-settings', locationId];

function formatDraft(format: LabelPrintFormat): Draft {
  return {
    id: format.id,
    widthMm: String(format.widthMm),
    printableWidthMm: String(format.printableWidthMm ?? ''),
    heightMm: String(format.heightMm),
    dotsPerMm: String(format.dotsPerMm),
  };
}

function newFormat(id = newId()): Draft {
  return formatDraft({ id, widthMm: 50, heightMm: 30, printableWidthMm: 48, dotsPerMm: 8 });
}

function parsedFormat(draft: Draft): LabelPrintFormat | null {
  const widthMm = parseNumber(draft.widthMm);
  const heightMm = parseNumber(draft.heightMm);
  const dotsPerMm = parseNumber(draft.dotsPerMm);
  const printableWidthMm = parseNumber(draft.printableWidthMm);
  if (widthMm === null || !(widthMm >= 8 && widthMm <= 120)) return null;
  if (heightMm === null || !(heightMm >= 8 && heightMm <= 200)) return null;
  if (dotsPerMm === null || !(dotsPerMm >= 8 && dotsPerMm <= 12)) return null;
  if (printableWidthMm !== null && !(printableWidthMm >= 8 && printableWidthMm <= widthMm))
    return null;
  return {
    id: draft.id,
    widthMm,
    heightMm,
    dotsPerMm,
    ...(printableWidthMm === null ? {} : { printableWidthMm }),
  };
}

export function PrintServerSettings({ locationId }: { locationId: string }) {
  const query = useQuery({
    queryKey: settingsKey(locationId),
    queryFn: ({ signal }) => api.get<Settings>(capturePaths.labelPrintSettings(locationId), signal),
  });
  if (query.isPending) return <LoadingRows rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { connection } = query.data;
  return (
    <ConnectionForm
      key={JSON.stringify([locationId, connection])}
      locationId={locationId}
      connection={connection}
    />
  );
}

function ConnectionForm({
  locationId,
  connection,
}: {
  locationId: string;
  connection: Settings['connection'];
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const path = capturePaths.labelPrintSettings(locationId);
  const [url, setUrl] = useState(connection?.url ?? '');
  const [token, setToken] = useState('');
  const [drafts, setDrafts] = useState(
    () => connection?.formats.map(formatDraft) ?? [newFormat('50x30')],
  );
  const [problem, setProblem] = useState('');
  const keepsToken =
    connection?.source === 'settings' && url.trim().replace(/\/+$/, '') === connection.url;

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: settingsKey(locationId) }),
      qc.invalidateQueries({ queryKey: ['labels', 'print-server', locationId] }),
    ]);
  };
  const save = useMutation({
    mutationFn: (formats: LabelPrintFormat[]) =>
      api.put<Settings>(path, {
        url: url.trim(),
        formats,
        ...(token.trim() ? { token: token.trim() } : {}),
      }),
    onSuccess: async (data) => {
      setToken('');
      qc.setQueryData(settingsKey(locationId), data);
      await refresh();
      toast({ title: t`Print server settings saved`, tone: 'ok' });
    },
    onError: (error) => setProblem(errorText(error)),
  });
  const check = useMutation({
    mutationFn: () => api.post(capturePaths.labelPrintCheck(locationId)),
    onSuccess: () => toast({ title: t`Print server is reachable`, tone: 'ok' }),
  });
  const remove = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: async () => {
      await refresh();
      toast({ title: t`Print server disconnected`, tone: 'ok' });
    },
    onError: (error) => setProblem(errorText(error)),
  });
  const busy = save.isPending || remove.isPending || check.isPending;

  return (
    <Section title={<Trans>Printer connection</Trans>}>
      <p className="m-0 text-ink-2">
        <Trans>
          Use the address of the bridge running near the printer. The Kept server must be able to
          reach it.
        </Trans>
      </p>
      {connection?.source === 'file' ? (
        <Notice tone="info" title={<Trans>Configured on the server</Trans>}>
          <Trans>
            Saving here overrides the print server configuration file for this location.
          </Trans>
        </Notice>
      ) : null}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setProblem('');
          check.reset();
          const formats = drafts.map(parsedFormat);
          if (formats.some((format) => format === null)) {
            setProblem(t`Check the dimensions and resolution of each label format.`);
            return;
          }
          save.mutate(formats.filter((format) => format !== null));
        }}
      >
        <TextField
          label={t`Print server URL`}
          type="url"
          placeholder="https://print.example.com"
          value={url}
          onChange={setUrl}
          isRequired
          isDisabled={busy}
        />
        <PasswordField
          label={t`API token`}
          autoComplete="new-password"
          description={keepsToken ? t`Leave blank to keep the saved token.` : undefined}
          value={token}
          onChange={setToken}
          isRequired={!keepsToken}
          isDisabled={busy}
        />
        <fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0" disabled={busy}>
          <legend className="mb-2 font-semibold">
            <Trans>Label formats</Trans>
          </legend>
          <p className="m-0 text-small text-ink-2">
            <Trans>Leave the printable width empty to use the full roll width.</Trans>
          </p>
          <ol className="m-0 grid list-none gap-3 p-0">
            {drafts.map((draft) => {
              const edit = (field: Exclude<keyof Draft, 'id'>) => (value: string) =>
                setDrafts((rows) =>
                  rows.map((row) => (row.id === draft.id ? { ...row, [field]: value } : row)),
                );
              return (
                <li key={draft.id} className="grid gap-3 rounded-lg border border-line p-3">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <TextField
                      label={t`Roll width (mm)`}
                      value={draft.widthMm}
                      onChange={edit('widthMm')}
                      inputMode="decimal"
                      isRequired
                    />
                    <TextField
                      label={t`Label height (mm)`}
                      value={draft.heightMm}
                      onChange={edit('heightMm')}
                      inputMode="decimal"
                      isRequired
                    />
                    <TextField
                      label={t`Printable width (mm)`}
                      value={draft.printableWidthMm}
                      onChange={edit('printableWidthMm')}
                      inputMode="decimal"
                    />
                    <TextField
                      label={t`Resolution (dots/mm)`}
                      value={draft.dotsPerMm}
                      onChange={edit('dotsPerMm')}
                      inputMode="decimal"
                      isRequired
                    />
                  </div>
                  {drafts.length > 1 ? (
                    <Button
                      className="justify-self-start"
                      size="small"
                      variant="ghost"
                      onPress={() => setDrafts((rows) => rows.filter((row) => row.id !== draft.id))}
                    >
                      <Trans>Remove format</Trans>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <Button
            className="justify-self-start"
            variant="secondary"
            size="small"
            isDisabled={drafts.length >= 30}
            onPress={() => setDrafts((rows) => [...rows, newFormat()])}
          >
            <Trans>Add format</Trans>
          </Button>
        </fieldset>
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {check.error ? (
          <Notice tone="danger">
            <div className="grid gap-1">
              {errorText(check.error)}
              {isPrivateAddressError(check.error) ? <PrivateAddressLink /> : null}
            </div>
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            isPending={save.isPending}
            isDisabled={remove.isPending || check.isPending}
          >
            <Trans>Save</Trans>
          </Button>
          {connection ? (
            <Button
              variant="secondary"
              isPending={check.isPending}
              isDisabled={save.isPending || remove.isPending}
              onPress={() => check.mutate()}
            >
              <Trans>Test connection</Trans>
            </Button>
          ) : null}
          {connection?.source === 'settings' ? (
            <Button
              variant="ghost"
              isPending={remove.isPending}
              isDisabled={save.isPending || check.isPending}
              onPress={async () => {
                if (
                  await confirm({
                    title: t`Disconnect print server?`,
                    confirmLabel: t`Disconnect`,
                    destructive: true,
                  })
                )
                  remove.mutate();
              }}
            >
              <Trans>Disconnect</Trans>
            </Button>
          ) : null}
        </div>
      </form>
    </Section>
  );
}
