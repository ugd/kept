/**
 * A label batch as print-styled sheets (D44, D97, D185): no app shell, one sheet per
 * page at the stock's `@page` size, and a screen-only bar with Print and "Share as images" (one
 * PNG per label, made on the phone, for label-printer apps). Where the browser shares files the
 * PNGs are made as the page opens, so the press opens the share sheet at once: iOS refuses a
 * share that waited on them, and an installed iPhone app can't download them instead
 * (lib/files.ts). Print opens the browser's dialog,
 * then "Printed OK?" records the print date for this batch; until it is answered yes, a bar on
 * this page keeps asking (only after a print here, so opening an old batch never invites
 * confirming the wrong sheet). Arriving from the builder (`?print=1`) opens the dialog by itself
 * once the QR encoder and the label faces are ready (the names are fitted in those faces); a
 * reload doesn't. The `@page` rule names the paper with no margin, so the dialog's defaults print
 * every label in its cell.
 *
 * Reprinting a batch prints the same codes (D45). `?stock=` and `?start=` print it on another
 * stock or from another cell without changing the batch.
 * A location with a print server opens its raster first. `?mode=browser` opens the browser sheet.
 */
import { isSheet, LABEL_STOCKS, type LabelStock, labelStock } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { useLabelBatch } from '@/api/capture/queries';
import type { LabelBatch } from '@/api/capture/types';
import { ChevronStartIcon, PrinterIcon, ShareIcon } from '@/components/icons';
import { useLabelMeasure } from '@/components/labels/fit';
import { perPage } from '@/components/labels/layout';
import { labelPngs, shareOrDownload } from '@/components/labels/png';
import { NotConfirmedBar, PrintedOkDialog } from '@/components/labels/printed-ok';
import { useQrEncoder } from '@/components/labels/qr';
import { ServerPrint, usePrintServer } from '@/components/labels/server-print';
import { LabelSheets } from '@/components/labels/sheet';
import { useStockText } from '@/components/labels/stock-picker';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { canShareType } from '@/lib/files';
import { useFormat } from '@/lib/format';

type PrintSearch = { print?: 1 | 'server'; mode?: 'browser'; stock?: string; start?: number };

export const Route = createFileRoute('/_print/labels/$batchId')({
  validateSearch: (s: Record<string, unknown>): PrintSearch => {
    const out: PrintSearch = {};
    if (s.print === 1 || s.print === '1') out.print = 1;
    if (s.print === 'server') out.print = 'server';
    if (s.mode === 'browser') out.mode = 'browser';
    if (typeof s.stock === 'string' && LABEL_STOCKS.some((x) => x.key === s.stock))
      out.stock = s.stock;
    const start = Number(s.start);
    if (Number.isInteger(start) && start > 0) out.start = start;
    return out;
  },
  component: PrintLabelsPage,
});

function PrintLabelsPage() {
  const { batchId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const batch = useLabelBatch(batchId);
  const data = batch.data;
  const server = usePrintServer(data?.locationId);
  const openCopies = search.print === 'server' && !!server.data?.formats.length;
  useEffect(() => {
    if (!openCopies) return;
    void navigate({
      to: '/labels/$batchId',
      params: { batchId },
      search: (prev) => ({ ...prev, print: undefined }),
      replace: true,
    });
  }, [openCopies, navigate, batchId]);

  if (batch.isPending) return <LoadingRows />;
  if (batch.isError || !data)
    return (
      <div className="mx-auto max-w-lg p-4">
        <ErrorState error={batch.error} onRetry={() => batch.refetch()} />
      </div>
    );

  const stockKey = search.stock ?? data.stock;
  const stock = labelStock(
    LABEL_STOCKS.some(({ key }) => key === stockKey) ? stockKey : 'a4_24_70x37',
  );
  const formats = server.data?.formats ?? [];
  const browserRequested = search.mode === 'browser' || search.print === 1;
  if (server.isPending) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <LoadingRows rows={2} />
      </div>
    );
  }
  if (!formats.length) {
    return <BrowserPrint batch={data} stock={stock} updatedAt={batch.dataUpdatedAt} />;
  }

  return (
    <ServerPrint
      key={batchId}
      batch={data}
      stock={stock}
      formats={formats}
      browserMode={browserRequested}
      initiallyOpen={openCopies}
      showServer={() =>
        void navigate({
          to: '/labels/$batchId',
          params: { batchId },
          search: (prev) => ({ ...prev, print: undefined, mode: undefined }),
        })
      }
    >
      {(action, details) =>
        browserRequested ? (
          <BrowserPrint
            batch={data}
            stock={stock}
            updatedAt={batch.dataUpdatedAt}
            serverAction={action}
          />
        ) : (
          <>
            <PrintHeader
              batch={data}
              actions={
                <div className="flex flex-wrap items-center justify-between gap-2 md:justify-end">
                  <BrowserPrintLink batchId={batchId} />
                  {action}
                </div>
              }
            />
            {details}
          </>
        )
      }
    </ServerPrint>
  );
}

function BrowserPrintLink({ batchId }: { batchId: string }) {
  return (
    <Link
      to="/labels/$batchId"
      params={{ batchId }}
      search={(prev) => ({
        ...prev,
        print: undefined,
        mode: 'browser',
      })}
      className="inline-flex min-h-11 items-center justify-self-start rounded-lg px-2 text-small font-semibold text-ink-2 underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
    >
      <Trans>Browser printing</Trans>
    </Link>
  );
}

function BrowserPrint({
  batch: data,
  stock,
  updatedAt,
  serverAction,
}: {
  batch: LabelBatch;
  stock: LabelStock;
  updatedAt: number;
  serverAction?: ReactNode;
}) {
  const { t } = useLingui();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const stockText = useStockText();
  const encode = useQrEncoder();
  const { measure, ready } = useLabelMeasure();
  const [asking, setAsking] = useState(false);
  const [printedHere, setPrintedHere] = useState(false);
  const autoPrinted = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const batchId = data.id;
  const startCell = isSheet(stock)
    ? Math.min(search.start ?? (search.stock ? 1 : data.startCell), perPage(stock))
    : 1;

  const print = () => {
    window.print();
    // print() returns once the dialog closes (or at once, on iOS): then ask.
    setPrintedHere(true);
    setAsking(true);
  };

  // From the builder: open the dialog once, when the QR and the faces are ready.
  useEffect(() => {
    if (search.print !== 1 || !encode || !ready || autoPrinted.current) return;
    autoPrinted.current = true;
    void navigate({
      to: '/labels/$batchId',
      params: { batchId },
      search: (prev) => ({ ...prev, print: undefined, mode: 'browser' }),
      replace: true,
    });
    void (async () => {
      await document.fonts?.ready;
      print();
    })();
  });

  // Where the share sheet takes PNGs, they're made ahead, so a press shares in its own turn.
  const [shareable] = useState(() => canShareType('kept-label.png', 'image/png'));
  const prepared = useQuery({
    queryKey: ['labels', 'pngs', batchId, stock.key, updatedAt],
    queryFn: () => labelPngs(stock, data.labels),
    enabled: shareable && data.labels.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const [sharing, setSharing] = useState(false);
  const shareImages = async () => {
    setSharing(true);
    try {
      const files = prepared.data ?? (await labelPngs(stock, data.labels));
      const how = await shareOrDownload(files, t`Kept labels`);
      if (how === 'downloaded') toast({ title: t`Saved the label images`, tone: 'ok' });
      if (how === 'refused')
        toast({ title: t`Couldn't share the label images. Try again.`, tone: 'danger' });
    } catch (e) {
      toast({ title: errorText(e), tone: 'danger' });
    } finally {
      setSharing(false);
    }
  };

  const count = data.labels.length;
  const stockTitle = stockText(stock).title;

  return (
    <>
      <PrintHeader
        batch={data}
        stockTitle={stockTitle}
        titleRef={titleRef}
        actions={
          <div className="grid gap-2 md:flex md:items-center">
            {serverAction}
            <div
              data-slot="label-actions"
              className="grid grid-cols-2 gap-2 md:flex md:shrink-0 md:flex-row-reverse"
            >
              <Button
                variant={serverAction ? 'secondary' : 'primary'}
                onPress={print}
                isDisabled={count === 0 || !encode || !ready}
              >
                <PrinterIcon className="size-5" />
                <Trans>Print</Trans>
              </Button>
              <Button
                variant="secondary"
                onPress={() => void shareImages()}
                isPending={sharing || prepared.isFetching}
                isDisabled={count === 0}
              >
                <ShareIcon className="size-5" />
                <Trans>Share as images</Trans>
              </Button>
            </div>
          </div>
        }
      >
        {printedHere && !asking && !data.printedConfirmedAt ? (
          <NotConfirmedBar batch={data} />
        ) : null}
        <p className="m-0 text-small text-ink-2">
          {isSheet(stock) ? (
            <Trans>
              The page is already {stockTitle} with no margins: keep the print dialog's defaults and
              scale 100%, so each label lands in its cell.
            </Trans>
          ) : (
            <Trans>In the print dialog choose your label printer and this label size.</Trans>
          )}
        </p>
      </PrintHeader>
      <LabelSheets
        stock={stock}
        labels={data.labels}
        startCell={startCell}
        encode={encode}
        measure={measure}
      />
      <PrintedOkDialog
        batch={data}
        isOpen={asking}
        onClose={() => setAsking(false)}
        hintAnchor={titleRef}
      />
    </>
  );
}

function PrintHeader({
  batch,
  stockTitle,
  titleRef,
  actions,
  children,
}: {
  batch: LabelBatch;
  stockTitle?: string;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  actions: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const count = batch.labels.length;
  const title =
    batch.kind === 'blank'
      ? plural(count, { one: '# blank label', other: '# blank labels' })
      : plural(count, { one: '# label', other: '# labels' });
  const printedOn = batch.printedConfirmedAt ? fmt.day(batch.printedConfirmedAt) : null;

  return (
    <header className="sticky top-0 z-20 grid gap-2 border-b border-line bg-paper px-3 py-2 print:hidden md:px-6">
      <div className="grid gap-2 md:flex md:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to="/labels"
            aria-label={t`Back to labels`}
            className="grid size-11 shrink-0 place-items-center rounded-[10px] text-ink-2 outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info"
          >
            <ChevronStartIcon />
          </Link>
          <div className="grid min-w-0 flex-1">
            <h1 ref={titleRef} className="m-0 font-semibold text-title text-ink">
              {title}
            </h1>
            {stockTitle ? <span className="text-small text-ink-2">{stockTitle}</span> : null}
          </div>
        </div>
        {actions}
      </div>
      {printedOn ? (
        <Notice tone="ok">
          <Trans>Printed on {printedOn}. Reprinting prints the same codes.</Trans>
        </Notice>
      ) : null}
      {children}
    </header>
  );
}
