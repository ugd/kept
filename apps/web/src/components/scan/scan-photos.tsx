import { can, newId, parseScan } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useInvalidateThing } from '@/api/inventory/thing-api';
import { getLocation } from '@/api/locations';
import { keys } from '@/api/queries';
import { grabFrame } from '@/camera/grab';
import { appDetect } from '@/camera/scanner';
import { FilePick } from '@/components/capture/gallery-import';
import { CameraIcon, GalleryIcon, QrIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { CreateThingSheet } from '@/components/things/create-sheet';
import { uploadAndAttach, useUploadErrorText } from '@/components/things/upload';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { useHoldUpdates } from '@/pwa/register';
import { ClaimSheet } from './claim-sheet';
import { type Described, describeTarget } from './describe';
import { LegacyPicker } from './legacy-picker';
import { ManualCode } from './manual-code';
import { PhotoTargetPicker } from './photo-target-picker';
import {
  type Read,
  type Resolution,
  resolveScan,
  type ScanStore,
  type ScanTarget,
} from './resolve';
import { ScannerView } from './scanner-view';

type Shot = { file: File; fileId: string; attachmentId: string };
type Choice =
  | Extract<Resolution, { outcome: 'claim' | 'legacy_ambiguous' }>
  | { outcome: 'pick' }
  | { outcome: 'create'; locationId: string; box: boolean };

export function ScanPhotos({
  store,
  onQueued,
  onExit,
}: {
  store: ScanStore | null;
  onQueued: () => void;
  onExit: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const explain = useErrorText();
  const explainUpload = useUploadErrorText();
  const invalidate = useInvalidateThing();
  const confirm = useConfirm();
  const video = useRef<HTMLVideoElement>(null);
  const lastRead = useRef<string | null>(null);
  const selected = useRef<Described | null>(null);
  const working = useRef(false);
  const [target, setTarget] = useState<Described | null>(null);
  const [step, setStep] = useState<'lookup' | 'save' | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [manual, setManual] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [unmatched, setUnmatched] = useState<{ code: string | null } | null>(null);
  const [pending, setPending] = useState<Shot[]>([]);
  const shot = pending[0];
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(0);
  useHoldUpdates(true);

  useEffect(() => {
    if (!shot) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(shot.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [shot]);

  const select = (value: Described | null) => {
    selected.current = value;
    setTarget(value);
    setSaved(0);
  };

  const lookUp = async (action: () => Promise<void>) => {
    if (working.current) return;
    if (!online) {
      setError(t`Needs a connection`);
      return;
    }
    working.current = true;
    setStep('lookup');
    setError(undefined);
    setUnmatched(null);
    try {
      await action();
    } catch (cause) {
      setError(explain(cause));
    } finally {
      working.current = false;
      setStep(null);
    }
  };

  const open = async (target: ScanTarget) => {
    const record = await describeTarget(target, { store: null, online });
    if (!record) {
      setError(t`Couldn't load this`);
      return;
    }
    const location = await qc.fetchQuery({
      queryKey: keys.location(record.locationId),
      queryFn: () => getLocation(record.locationId),
    });
    if (!can(location.role, 'attachments.add')) {
      setError(t`You don't have permission to do that.`);
      return;
    }
    select(record);
  };

  const find = (read: Read, typed = false) => {
    if (
      working.current ||
      selected.current ||
      choice ||
      (!typed && (manual || read.format !== 'qr_code'))
    )
      return;
    const scan = parseScan(read.text, read.format);
    const key = scan.kind === 'kept' ? scan.code : read.text;
    if (!typed && key === lastRead.current) return;
    setManual(false);
    void lookUp(async () => {
      lastRead.current = key;
      // Write to the label’s current record, even if the phone has an older snapshot.
      const resolution = await resolveScan(read, { store: null, online });
      switch (resolution.outcome) {
        case 'open':
          await open(resolution.target);
          return;
        case 'claim':
        case 'legacy_ambiguous':
          setChoice(resolution);
          return;
        case 'not_on_phone':
          setError(t`Needs a connection`);
          return;
        default:
          setUnmatched({
            code: resolution.outcome === 'not_in_your_kept' ? resolution.code : null,
          });
      }
    });
  };

  const pickTarget = (target: ScanTarget) => {
    setChoice(null);
    void lookUp(() => open(target));
  };

  const save = async (picked: File[] = []) => {
    const record = selected.current;
    if (working.current || !record || !online) return;
    working.current = true;
    setStep('save');
    setError(undefined);
    let uploaded = false;
    try {
      let queue = pending;
      if (!queue.length) {
        let files = picked;
        if (!files.length && video.current) {
          const image = await grabFrame(video.current, 'thing').catch(() => null);
          if (image)
            files = [new File([image.original], 'photo.jpg', { type: image.original.type })];
        }
        if (!files.length) {
          setError(t`Couldn't read the photo`);
          return;
        }
        queue = files.map((file) => ({ file, fileId: newId(), attachmentId: newId() }));
        setPending(queue);
      }
      const subject = record.kind === 'place' ? { placeId: record.id } : { thingId: record.id };
      for (const photo of queue) {
        await uploadAndAttach({ ...photo, locationId: record.locationId, subject, role: 'photo' });
        uploaded = true;
        setPending((rest) => rest.slice(1));
        setSaved((count) => count + 1);
      }
    } catch (cause) {
      setError(explainUpload(cause));
    } finally {
      if (uploaded) void invalidate(record.kind === 'thing' ? record.id : undefined);
      working.current = false;
      setStep(null);
    }
  };

  const exit = async () => {
    if (working.current) return;
    if (
      shot &&
      !(await confirm({
        title: pending.length > 1 ? t`Discard these photos?` : t`Discard this photo?`,
        confirmLabel: t`Discard`,
        destructive: true,
      }))
    )
      return;
    onExit();
  };
  const fileButton = cn(buttonClass('secondary'), 'min-h-11 data-focus-visible:outline-info');
  const status = !online
    ? t`Needs a connection`
    : step === 'lookup'
      ? t`Looking it up…`
      : step === 'save'
        ? t`Saving…`
        : target && saved
          ? plural(saved, { one: '# photo added', other: '# photos added' })
          : target || unmatched
            ? null
            : t`Scan a label`;

  return (
    <div
      data-focused-task="scan"
      className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-surface pt-[env(safe-area-inset-top)] text-ink md:relative md:inset-auto md:z-auto md:mx-auto md:my-4 md:min-h-[calc(100dvh-2rem)] md:max-w-[480px] md:rounded-2xl"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <h1 className="m-0 min-w-0 text-title font-semibold">
          <Trans>Scan and photograph</Trans>
        </h1>
        <Button
          variant="secondary"
          className="min-h-11"
          isDisabled={!!step}
          onPress={() => void exit()}
        >
          <Trans>Done</Trans>
        </Button>
      </header>
      <div className="relative mx-3 min-h-[220px] flex-1 overflow-hidden rounded-[14px] bg-[#1C1A17]">
        <ScannerView
          detect={appDetect()}
          paused={!!target || !!step || !!choice || !!unmatched || manual || !online}
          onRead={find}
          videoRef={video}
          onFrameReady={setFrameReady}
          photographing={!!target}
        />
        {shot && preview ? (
          <img
            src={preview}
            alt={target?.name ?? ''}
            className="absolute inset-0 size-full bg-[#1C1A17] object-contain"
          />
        ) : null}
      </div>
      <div className="grid gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div role="status" className="grid justify-items-start gap-1.5">
          {target ? (
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
              <h2 className="m-0 min-w-0 text-title font-semibold [overflow-wrap:anywhere]">
                <bdi>{target.name ?? t`Unnamed`}</bdi>
              </h2>
              {target.shortCode ? <IdChip code={target.shortCode} /> : null}
            </div>
          ) : null}
          {status ? <p className="m-0 text-small text-ink-2">{status}</p> : null}
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {unmatched ? (
          <Notice tone="info">
            <div className="flex flex-wrap items-center gap-2">
              <Trans>Not in your Kept</Trans>
              {unmatched.code ? <IdChip code={unmatched.code} /> : null}
            </div>
          </Notice>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {target ? (
            shot ? (
              <>
                <Button
                  className="min-h-11"
                  isDisabled={!online}
                  isPending={step === 'save'}
                  onPress={() => void save()}
                >
                  <Trans>Try again</Trans>
                </Button>
                <Button
                  variant="secondary"
                  className="min-h-11"
                  isDisabled={!!step}
                  onPress={() => {
                    setPending([]);
                    setError(undefined);
                  }}
                >
                  <Trans>Discard</Trans>
                </Button>
              </>
            ) : (
              <>
                {frameReady ? (
                  <Button
                    className="min-h-11"
                    isDisabled={!online || !!step}
                    onPress={() => void save()}
                  >
                    <CameraIcon className="size-4" />
                    <Trans>Take a photo</Trans>
                  </Button>
                ) : online && !step ? (
                  <FilePick
                    camera
                    className={cn(buttonClass(), 'min-h-11 data-focus-visible:outline-info')}
                    onFiles={(files) => void save(files)}
                  >
                    <CameraIcon className="size-4" />
                    <Trans>Take a photo</Trans>
                  </FilePick>
                ) : null}
                {online && !step ? (
                  <FilePick multiple className={fileButton} onFiles={(files) => void save(files)}>
                    <GalleryIcon className="size-4" />
                    <Trans>Gallery</Trans>
                  </FilePick>
                ) : null}
                <Button
                  variant="secondary"
                  className="min-h-11"
                  isDisabled={!!step}
                  onPress={() => {
                    select(null);
                    setError(undefined);
                  }}
                >
                  <QrIcon className="size-4" />
                  <Trans>Scan next label</Trans>
                </Button>
              </>
            )
          ) : (
            <>
              <Button
                variant="secondary"
                className="min-h-11"
                isDisabled={!!step || !online}
                onPress={() => setManual(true)}
              >
                <Trans>Type the code</Trans>
              </Button>
              {unmatched && online && !step ? (
                <Button className="min-h-11" onPress={() => setChoice({ outcome: 'pick' })}>
                  <Trans>Choose a thing or place</Trans>
                </Button>
              ) : null}
              {(error || unmatched) && online && !step ? (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onPress={() => {
                    lastRead.current = null;
                    setError(undefined);
                    setUnmatched(null);
                  }}
                >
                  <Trans>Scan again</Trans>
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
      <Sheet isOpen={manual} onOpenChange={setManual} title={t`Type the code`}>
        <ManualCode
          onCancel={() => setManual(false)}
          onCode={(code) => find({ text: code }, true)}
        />
      </Sheet>
      <Sheet
        isOpen={!!choice && choice.outcome !== 'create'}
        onOpenChange={(open) => !open && setChoice(null)}
        title={choice?.outcome === 'pick' ? t`Choose a thing or place` : t`Scan result`}
      >
        {choice?.outcome === 'claim' ? (
          <ClaimSheet
            key={choice.code}
            code={choice.code}
            locationId={choice.locationId}
            store={store}
            online={online}
            onCamera={false}
            onOpen={pickTarget}
            onAgain={() => setChoice(null)}
            onQueued={onQueued}
          />
        ) : choice?.outcome === 'legacy_ambiguous' ? (
          <LegacyPicker candidates={choice.candidates} onOpen={pickTarget} />
        ) : choice?.outcome === 'pick' ? (
          <PhotoTargetPicker
            onPick={pickTarget}
            onCreate={(locationId, box) => setChoice({ outcome: 'create', locationId, box })}
          />
        ) : null}
      </Sheet>
      {choice?.outcome === 'create' ? (
        <CreateThingSheet
          isOpen
          locationId={choice.locationId}
          onClose={() => setChoice({ outcome: 'pick' })}
          onCreated={(thing) => pickTarget({ kind: 'thing', ...thing })}
          openAfter={false}
          {...(choice.box ? { title: t`Add a box`, presetType: 'box_bin' } : {})}
        />
      ) : null}
    </div>
  );
}
