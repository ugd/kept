import { type LabelStock, MAX_LABEL_PRINT_COPIES, newId, printedCode } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { LabelBatch, LabelPrintFormat } from '@/api/capture/types';
import { api, isApiError } from '@/api/client';
import { qs } from '@/api/inventory/paths';
import { PrinterIcon } from '@/components/icons';
import { LoadingRows, Notice, useErrorText } from '@/components/page';
import { parseNumber } from '@/components/things/form-model';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { useConfirmPrinted } from './printed-ok';

type Job = { state: 'queued' | 'printing' | 'done' | 'failed' | 'uncertain' };
type Choice = { code: string; formatId: string };
type PrintRequest = Choice & { requestId: string; copies: number };
type CopyPrompt = { value: string; choices: boolean };

function validCopies(copies: unknown): copies is number {
  return (
    typeof copies === 'number' &&
    Number.isInteger(copies) &&
    copies >= 1 &&
    copies <= MAX_LABEL_PRINT_COPIES
  );
}

export function usePrintServer(locationId: string | undefined) {
  return useQuery({
    queryKey: ['labels', 'print-server', locationId],
    queryFn: () =>
      api.get<{ formats: LabelPrintFormat[] }>(capturePaths.labelPrintServer + qs({ locationId })),
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
      typeof saved.formatId === 'string' &&
      (saved.copies === undefined || validCopies(saved.copies))
    )
      return {
        requestId: saved.requestId,
        code: saved.code,
        formatId: saved.formatId,
        copies: saved.copies ?? 1,
      };
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
  stock,
  formats,
  browserMode,
  initiallyOpen = false,
  showServer,
  children,
}: {
  batch: LabelBatch;
  stock: LabelStock;
  formats: LabelPrintFormat[];
  browserMode: boolean;
  initiallyOpen?: boolean;
  showServer: () => void;
  children: (action: ReactNode, details: ReactNode) => ReactNode;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const confirmPrinted = useConfirmPrinted(batch);
  const storageKey = `kept.labels.print.${batch.id}`;
  const [restored] = useState(() => restorePrint(storageKey));
  const [selectedCode, setCode] = useState(restored?.code);
  const [selectedFormat, setFormat] = useState(restored?.formatId);
  const [request, setRequest] = useState(restored);
  const [prompt, setPrompt] = useState<CopyPrompt | null>(() =>
    initiallyOpen ? { value: '1', choices: true } : null,
  );
  const code =
    batch.labels.find((label) => label.code === selectedCode)?.code ?? batch.labels[0]?.code;
  const matchingFormats = formats.filter(
    ({ widthMm, heightMm }) => widthMm === stock.cell.w && heightMm === stock.cell.h,
  );
  const chosenFormat =
    browserMode && !prompt ? undefined : formats.find(({ id }) => id === selectedFormat);
  const format = chosenFormat ?? matchingFormats[0] ?? formats[0];
  const direct =
    batch.labels.length === 1 && (matchingFormats.length === 1 || formats.length === 1);
  const preview = useQuery({
    queryKey: ['labels', 'print-server', batch.id, code, format],
    enabled: !!(code && format) && (!browserMode || !!prompt),
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
    onError: (error) => {
      if (isApiError(error) && error.code === 'validation') rememberPrint(storageKey);
    },
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
  const rejected = isApiError(send.error) && send.error.code === 'validation';
  const retry =
    request?.code === code &&
    request?.formatId === format?.id &&
    ((send.isError && !rejected) || status.isError);
  useEffect(() => {
    if (!send.isPending && result && !active(result)) rememberPrint(storageKey);
  }, [result, send.isPending, storageKey]);

  if (!code || !format) return children(null, null);
  const describeError = (error: unknown) =>
    isApiError(error) && error.code === 'validation' && error.hint ? error.hint : errorText(error);
  const print = (copies: number) => {
    const next =
      retry && request ? request : { requestId: newId(), code, formatId: format.id, copies };
    const unknownJob = isApiError(status.error) && status.error.status === 404;
    if (retry && status.isError && !unknownJob) {
      void status.refetch();
    } else {
      rememberPrint(storageKey, next);
      setRequest(next);
      send.mutate(next);
    }
  };
  const onPress = () => {
    setFormat(format.id);
    if (retry && request) {
      print(request.copies);
      if (browserMode) showServer();
    } else {
      setPrompt({ value: '1', choices: browserMode && !direct });
    }
  };
  const action = (
    <Button
      onPress={onPress}
      isPending={send.isPending}
      isDisabled={blocked || (!browserMode && !retry && !preview.data)}
    >
      <PrinterIcon className="size-5" />
      {retry ? <Trans>Retry print request</Trans> : <Trans>Print on server</Trans>}
    </Button>
  );
  const pickLabel = batch.labels.length > 1;
  const pickFormat = formats.length > 1;
  const rollName = ({ widthMm, heightMm }: LabelPrintFormat) => {
    const width = fmt.num(widthMm);
    const height = fmt.num(heightMm);
    return t`${width} × ${height} mm`;
  };
  const canConfirm =
    result?.state === 'done' && batch.labels.length === 1 && !batch.printedConfirmedAt;
  const copies = parseNumber(prompt?.value ?? '');

  const choices = (
    <div className={pickLabel && pickFormat ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3'}>
      {pickLabel ? (
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
      ) : null}
      {pickFormat ? (
        <Combobox
          label={t`Roll format`}
          items={formats.map((item) => ({ id: item.id, label: rollName(item) }))}
          selectedKey={format.id}
          isDisabled={blocked}
          showsChoice
          onSelectionChange={(key) => {
            if (key !== null) setFormat(String(key));
          }}
        />
      ) : (
        <p className="m-0 text-center text-small text-ink-2">{rollName(format)}</p>
      )}
    </div>
  );

  const details = browserMode ? null : (
    <section
      className="mx-auto grid w-full max-w-lg gap-4 px-4 py-6 print:hidden sm:py-8"
      aria-label={t`Print server`}
    >
      {choices}
      {preview.isPending ? <LoadingRows rows={2} /> : null}
      {preview.data ? <Preview png={preview.data.png} /> : null}
      {preview.isError ? <Notice tone="danger">{describeError(preview.error)}</Notice> : null}
      {rejected ? <Notice tone="danger">{describeError(send.error)}</Notice> : null}
      <div className="grid justify-items-center gap-2 text-center">
        <div role="status" className="text-small text-ink-2">
          {retry ? (
            <Trans>
              Could not confirm the print request. Retrying the same request will not print it
              twice.
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
        {canConfirm ? (
          <Button
            variant="secondary"
            size="small"
            isPending={confirmPrinted.isPending}
            onPress={() => confirmPrinted.mutate()}
          >
            <Trans>Yes, printed OK</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
  return (
    <>
      {children(action, details)}
      <Modal
        isOpen={!!prompt}
        onOpenChange={(open) => !open && setPrompt(null)}
        className="print:hidden"
        overlayClassName="print:hidden"
      >
        <Dialog title={<Trans>Print on server</Trans>} showClose={false}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!prompt || !validCopies(copies) || !preview.data || blocked) return;
              setPrompt(null);
              print(copies);
              if (browserMode) showServer();
            }}
          >
            {prompt?.choices ? choices : null}
            <TextField
              autoFocus
              label={t`Copies`}
              errorMessage={`${fmt.num(1)}–${fmt.num(MAX_LABEL_PRINT_COPIES)}`}
              inputMode="numeric"
              isRequired
              isInvalid={!!prompt?.value && !validCopies(copies)}
              value={prompt?.value ?? ''}
              onChange={(value) => setPrompt((current) => current && { ...current, value })}
            />
            {preview.isError ? <Notice tone="danger">{describeError(preview.error)}</Notice> : null}
            <DialogFooter>
              <Button variant="secondary" onPress={() => setPrompt(null)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" isDisabled={!validCopies(copies) || !preview.data || blocked}>
                <Trans>Print</Trans>
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      </Modal>
    </>
  );
}
