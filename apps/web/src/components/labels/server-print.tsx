import { newId, printedCode } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { LabelBatch } from '@/api/capture/types';
import { api, isApiError } from '@/api/client';
import { qs } from '@/api/inventory/paths';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useFormat } from '@/lib/format';

type Format = { id: string; widthMm: number; heightMm: number };
type Job = { state: 'queued' | 'printing' | 'done' | 'failed' | 'uncertain' };
type Choice = { code: string; formatId: string };
type PrintRequest = Choice & { requestId: string };

export function usePrintServer(locationId: string | undefined) {
  return useQuery({
    queryKey: ['labels', 'print-server', locationId],
    queryFn: () =>
      api.get<{ formats: Format[] }>(capturePaths.labelPrintServer + qs({ locationId })),
    enabled: !!locationId,
    staleTime: 60_000,
    retry: false,
  });
}

function labelPreviewUrl(png: string | undefined) {
  if (!png) return undefined;
  const bytes = Uint8Array.from(atob(png), (byte) => byte.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
}

function Preview({ png }: { png: string }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const url = labelPreviewUrl(png);
    setSource(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [png]);
  const { t } = useLingui();
  return source ? (
    <img src={source} alt={t`Label preview`} className="mx-auto max-h-48 max-w-full bg-white" />
  ) : null;
}

const active = (job?: Job) => job?.state === 'queued' || job?.state === 'printing';

function restorePrint(key: string): PrintRequest | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      typeof saved?.requestId === 'string' &&
      typeof saved.code === 'string' &&
      typeof saved.formatId === 'string'
    )
      return saved as PrintRequest;
  } catch {
    // Printing is still available on devices that block session storage.
  }
}

function rememberPrint(key: string, job?: PrintRequest) {
  try {
    if (job) sessionStorage.setItem(key, JSON.stringify(job));
    else sessionStorage.removeItem(key);
  } catch {
    // The current request is still held in component state.
  }
}

export function ServerPrint({
  batch,
  formats,
  onPrinted,
}: {
  batch: LabelBatch;
  formats: Format[];
  onPrinted: () => void;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const storageKey = `kept.labels.print.${batch.id}`;
  const [restored] = useState(() => restorePrint(storageKey));
  const [selectedCode, setCode] = useState(restored?.code);
  const [selectedFormat, setFormat] = useState(restored?.formatId);
  const [request, setRequest] = useState(restored);
  const code =
    batch.labels.find((label) => label.code === selectedCode)?.code ?? batch.labels[0]?.code;
  const format = formats.find((item) => item.id === selectedFormat) ?? formats[0];
  const preview = useQuery({
    queryKey: ['labels', 'print-server', batch.id, code, format?.id],
    enabled: !!(code && format),
    queryFn: ({ signal }) =>
      api.get<{ png: string }>(
        capturePaths.labelServerPreview(batch.id) + qs({ code, formatId: format?.id }),
        signal,
      ),
    retry: false,
  });
  const send = useMutation({
    mutationFn: (job: PrintRequest) =>
      api.post<Job>(capturePaths.labelServerJobs(batch.id), job, {
        'Idempotency-Key': job.requestId,
      }),
  });
  const tracking =
    !!request &&
    !send.isPending &&
    (request.requestId === restored?.requestId || active(send.data));
  const status = useQuery({
    queryKey: ['labels', 'print-server', batch.id, request?.requestId],
    enabled: tracking,
    queryFn: () => api.get<Job>(capturePaths.labelServerJob(batch.id, request?.requestId ?? '')),
    refetchInterval: ({ state }) =>
      state.status === 'error' || (state.data && !active(state.data)) ? false : 1000,
    retry: 1,
  });
  const result = status.data ?? send.data;
  const blocked =
    send.isPending || (tracking && status.isPending) || (active(result) && !status.isError);
  const retry =
    request?.code === code && request?.formatId === format?.id && (send.isError || status.isError);
  useEffect(() => {
    if (!send.isPending && result && !active(result)) rememberPrint(storageKey);
    if (result?.state === 'done' && batch.labels.length === 1) onPrinted();
  }, [batch.labels.length, onPrinted, result, send.isPending, storageKey]);

  if (!code || !format) return null;
  const print = () => {
    const next = retry && request ? request : { requestId: newId(), code, formatId: format.id };
    const unknownJob = isApiError(status.error) && status.error.status === 404;
    if (retry && status.isError && !unknownJob) {
      void status.refetch();
    } else {
      rememberPrint(storageKey, next);
      setRequest(next);
      send.mutate(next);
    }
  };

  return (
    <section
      className="grid gap-3 rounded-card border border-line p-3 print:hidden"
      aria-label={t`Print server`}
    >
      <h2 className="m-0 text-section font-semibold">
        <Trans>Print server</Trans>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Combobox
          label={t`Label`}
          items={batch.labels.map((label) => ({
            id: label.code,
            label: label.name ?? printedCode(label.code),
          }))}
          selectedKey={code}
          isDisabled={blocked}
          showsChoice
          onSelectionChange={(key) => {
            if (key !== null) setCode(String(key));
          }}
        />
        <Combobox
          label={t`Roll format`}
          items={formats.map((item) => {
            const width = fmt.num(item.widthMm);
            const height = fmt.num(item.heightMm);
            return { id: item.id, label: t`${width} × ${height} mm` };
          })}
          selectedKey={format.id}
          isDisabled={blocked}
          showsChoice
          onSelectionChange={(key) => {
            if (key !== null) setFormat(String(key));
          }}
        />
      </div>
      {preview.data ? <Preview png={preview.data.png} /> : null}
      {preview.isError ? <Notice tone="danger">{errorText(preview.error)}</Notice> : null}
      <div>
        <Button onPress={print} isPending={send.isPending} isDisabled={blocked || !preview.data}>
          {retry ? <Trans>Retry print request</Trans> : <Trans>Print on server</Trans>}
        </Button>
      </div>
      <div role="status" className="text-small text-ink-2">
        {retry ? (
          <Trans>
            Could not confirm the print request. Retrying the same request will not print it twice.
          </Trans>
        ) : null}
        {blocked ? <Trans>Waiting for the print server…</Trans> : null}
        {result?.state === 'done' ? <Trans>The printer finished this label.</Trans> : null}
        {result?.state === 'failed' ? (
          <Trans>The print server could not print the label.</Trans>
        ) : null}
        {result?.state === 'uncertain' ? (
          <Trans>Check the physical label before printing again.</Trans>
        ) : null}
      </div>
    </section>
  );
}
