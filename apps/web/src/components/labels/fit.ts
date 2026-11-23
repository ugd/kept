import { estimateWidth, LABEL_SANS, type TextMeasure } from '@kept/shared';
import { useMemo, useSyncExternalStore } from 'react';

export {
  estimateWidth,
  FIT_LINE_HEIGHT,
  type FittedText,
  fitLabel,
  type LabelFit,
  labelsTooLong,
  NAME_MIN,
  PATH_MIN,
  type TextMeasure,
  wrapLines,
} from '@kept/shared';

type Ctx2d = { font: string; measureText: (s: string) => { width: number } };
let ctx: Ctx2d | null | undefined;
const widths = new Map<string, number>();
let version = 0;
let started = false;
/** The faces `loadLabelFaces` asks for have loaded (or failed to: the fallback is final). */
let facesLoaded = false;
const listeners = new Set<() => void>();

function context(): Ctx2d | null {
  if (ctx !== undefined) return ctx;
  try {
    ctx =
      typeof OffscreenCanvas === 'undefined'
        ? null
        : (new OffscreenCanvas(1, 1).getContext('2d') as Ctx2d | null);
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Measures in the label's faces where there is a canvas, else estimates. */
export const canvasMeasure: TextMeasure = (text, size, weight = 600) => {
  const c = context();
  if (!c) return estimateWidth(text, size, weight);
  const key = `${weight}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    c.font = `${weight} 100px ${LABEL_SANS}`;
    w = c.measureText(text).width / 100;
    widths.set(key, w);
  }
  return w * size;
};

/** Loads the faces a label is set in; a canvas never waits for a font on its own. */
export async function loadLabelFaces() {
  if (typeof document === 'undefined' || !document.fonts) return;
  await Promise.all([
    document.fonts.load(`600 10px "IBM Plex Mono"`, '7KQ‑4MZ'),
    document.fonts.load(`600 10px "IBM Plex Sans"`, 'Aa'),
    document.fonts.load(`400 10px "IBM Plex Sans"`, 'Aa'),
    document.fonts.load(`600 10px "IBM Plex Sans Arabic"`, 'بيت'),
    document.fonts.load(`400 10px "IBM Plex Sans Arabic"`, 'بيت'),
  ]).catch(() => undefined);
}

const hasFonts = () => typeof document !== 'undefined' && !!document.fonts;

function remeasure() {
  widths.clear();
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    if (hasFonts()) {
      void loadLabelFaces().then(() => {
        facesLoaded = true;
        remeasure();
      });
      document.fonts.addEventListener('loadingdone', remeasure);
    }
  }
  return () => listeners.delete(listener);
}

/**
 * The browser's measure for fitting labels, new each time the label's faces finish loading (so
 * every label fits again in the real faces), and whether they have loaded: print once `ready`.
 */
export function useLabelMeasure(): { measure: TextMeasure; ready: boolean } {
  const v = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new measure for each version
  const measure = useMemo<TextMeasure>(() => (t, s, w) => canvasMeasure(t, s, w), [v]);
  return { measure, ready: !hasFonts() || (v > 0 && facesLoaded) };
}
