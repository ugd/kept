import { can, newId, parseScan } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useInvalidateThing } from '@/api/inventory/thing-api';
import { getLocation } from '@/api/locations';
import { keys } from '@/api/queries';
import { grabFrame } from '@/camera/grab';
import { appDetect } from '@/camera/scanner';
import { FilePick } from '@/components/capture/gallery-import';
import { CameraIcon, GalleryIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { uploadAndAttach, useUploadErrorText } from '@/components/things/upload';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { useHoldUpdates } from '@/pwa/register';
import { type Described, describeTarget } from './describe';
import { ManualCode } from './manual-code';
import { type Read, resolveScan } from './resolve';
import { ScannerView } from './scanner-view';

type Shot = { file: File; fileId: string; attachmentId: string };

export function ScanPhotos({ onExit }: { onExit: () => void }) {
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
  const [shot, setShot] = useState<Shot | null>(null);
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
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
  };

  const find = async (read: Read, typed = false) => {
    if (working.current || selected.current || (!typed && (manual || read.format !== 'qr_code')))
      return;
    const scan = parseScan(read.text, read.format);
    const key = scan.kind === 'kept' ? scan.code : read.text;
    if (!typed && key === lastRead.current) return;
    setManual(false);
    if (!online) {
      setError(t`Needs a connection`);
      return;
    }
    lastRead.current = key;
    working.current = true;
    setStep('lookup');
    setSaved(false);
    setError(undefined);
    try {
      // Resolve against the server so the photo follows the label’s current record.
      const resolution = await resolveScan(read, { store: null, online });
      if (resolution.outcome !== 'open') {
        setError(
          resolution.outcome === 'not_on_phone'
            ? t`Needs a connection`
            : t`Scan a label already assigned to a thing or place.`,
        );
        return;
      }
      const record = await describeTarget(resolution.target, { store: null, online });
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
    } catch (cause) {
      setError(explain(cause));
    } finally {
      working.current = false;
      setStep(null);
    }
  };

  const save = async (picked?: File) => {
    const record = selected.current;
    if (working.current || !record || !online) return;
    working.current = true;
    setStep('save');
    setError(undefined);
    try {
      let photo = shot;
      if (!photo) {
        let file = picked;
        if (!file && video.current) {
          const image = await grabFrame(video.current, 'thing').catch(() => null);
          if (image) file = new File([image.original], 'photo.jpg', { type: image.original.type });
        }
        if (!file) {
          setError(t`Couldn't read the photo`);
          return;
        }
        photo = { file, fileId: newId(), attachmentId: newId() };
        setShot(photo);
      }
      await uploadAndAttach({
        ...photo,
        locationId: record.locationId,
        subject: record.kind === 'place' ? { placeId: record.id } : { thingId: record.id },
        role: 'photo',
      });
      void invalidate(record.kind === 'thing' ? record.id : undefined);
      setShot(null);
      select(null);
      setSaved(true);
    } catch (cause) {
      setError(explainUpload(cause));
    } finally {
      working.current = false;
      setStep(null);
    }
  };

  const exit = async () => {
    if (working.current) return;
    if (
      shot &&
      !(await confirm({
        title: t`Discard this photo?`,
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
        : target
          ? null
          : saved
            ? t`Photo added. Scan the next label.`
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
          paused={!!target || !!step || manual || !online}
          onRead={(read) => void find(read)}
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
                    setShot(null);
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
                    onFiles={([file]) => void save(file)}
                  >
                    <CameraIcon className="size-4" />
                    <Trans>Take a photo</Trans>
                  </FilePick>
                ) : null}
                {online && !step ? (
                  <FilePick className={fileButton} onFiles={([file]) => void save(file)}>
                    <GalleryIcon className="size-4" />
                    <Trans>Gallery</Trans>
                  </FilePick>
                ) : null}
                <Button
                  variant="ghost"
                  className="min-h-11"
                  isDisabled={!!step}
                  onPress={() => {
                    select(null);
                    setError(undefined);
                  }}
                >
                  <Trans>Skip</Trans>
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
              {error && online && !step ? (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onPress={() => {
                    lastRead.current = null;
                    setError(undefined);
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
          onCode={(code) => void find({ text: code }, true)}
        />
      </Sheet>
    </div>
  );
}
