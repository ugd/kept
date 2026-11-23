import { hasQr, isTape, type LabelStock } from './label-stocks.js';

/** The label's faces: Plex Sans with Plex Sans Arabic for Arabic names (D97), Plex Mono for codes. */
export const LABEL_SANS = '"IBM Plex Sans", "IBM Plex Sans Arabic", sans-serif';
export const LABEL_MONO = '"IBM Plex Mono", monospace';

export type CellMetrics = {
  /** Inner padding on every side. */
  pad: number;
  /** The QR's side, quiet zone included; 0 on tape too narrow for one. */
  qr: number;
  /**
   * On tape with no QR, the code's own column, before the text column; 0 where the code sits at
   * the top of the text column.
   */
  codeColumn: number;
  /** The text column's width, beside the QR (or the code). */
  text: number;
  /**
   * Font sizes (the em box): the code; the name and the place they start at, before a long one
   * steps down towards `NAME_MIN` and `PATH_MIN` (label-fit.ts).
   */
  code: number;
  name: number;
  path: number;
  /** A compact stock prints only the QR and the code. */
  compact: boolean;
  /** Whether the place prints: not on a compact stock, nor on tape. */
  place: boolean;
};

/** The smallest name and place a label sets, in mm (about 6.2 pt and 5.7 pt): still readable. */
export const NAME_MIN = 2.2;
export const PATH_MIN = 2.0;

/** The place line's ink: near-black, so it reads on paper. */
export const PLACE_INK = '#222222';

/** The space between the code's characters, in em: the HTML label and the PNG both set it. */
export const CODE_TRACKING = 0.06;

/** Plex Mono's advance is 0.6 em; the code is set 0.06 em apart, 7 characters with the hyphen. */
const CODE_EM = 7 * 0.66;

/** Down to a hundredth of a millimetre, so the CSS sets exactly the size the fit worked with. */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

/**
 * The parts of one label, scaled from the designs' 40 × 30 mm label (D134: QR, the code large in
 * mono, the name, the place). The code never wraps: it shrinks to fit the text column. The name
 * starts at about a tenth of the label's height (never larger than four fifths of the code), the
 * place at four fifths of the name; label-fit.ts steps both down when a long one needs it.
 */
export function cellMetrics(stock: LabelStock): CellMetrics {
  if (isTape(stock)) return tapeMetrics(stock);
  const { w, h } = stock.cell;
  const pad = Math.max(1.5, h * 0.06);
  const qr = Math.min(h - 2 * pad, w * 0.48);
  const text = Math.max(0, w - qr - 3 * pad);
  const compact = stock.content === 'compact';
  const code = Math.min(h * (compact ? 0.16 : 0.13), text / CODE_EM);
  const name = floor2(Math.max(NAME_MIN, Math.min(h * 0.095, code * 0.8)));
  return {
    pad,
    qr,
    codeColumn: 0,
    text,
    code,
    name,
    path: floor2(Math.max(PATH_MIN, name * 0.8)),
    compact,
    place: !compact,
  };
}

/**
 * Tape (#303): the label is a band across the tape (three quarters of narrow tape, 18 mm of
 * 24 mm tape, as an 18 mm print head prints it), and the code is set large in it, since the code
 * is what is read on tape: by eye, and by the scanner from its printed text where there is no QR.
 * Narrow tape (no QR): the code fills most of the band's height in a column of its own, the name
 * beside it. Wide tape: the QR fills the band, the code and the name beside it, as on a roll.
 * The place never prints on tape.
 */
function tapeMetrics(stock: LabelStock): CellMetrics {
  const { w, h } = stock.cell;
  const pad = h <= 12 ? h * 0.125 : Math.max(1.5, (h - 18) / 2);
  const band = h - 2 * pad;
  if (hasQr(stock)) {
    const qr = band;
    const text = Math.max(0, w - qr - 3 * pad);
    const code = Math.min(band * 0.42, text / CODE_EM);
    const name = floor2(Math.max(NAME_MIN, Math.min(band * 0.2, code * 0.6)));
    return {
      pad,
      qr,
      codeColumn: 0,
      text,
      code,
      name,
      path: PATH_MIN,
      compact: false,
      place: false,
    };
  }
  const code = band * 0.62;
  const codeColumn = code * CODE_EM;
  const text = Math.max(0, w - codeColumn - 3 * pad);
  const name = floor2(Math.max(NAME_MIN, Math.min(band * 0.4, code * 0.6)));
  return {
    pad,
    qr: 0,
    codeColumn,
    text,
    code,
    name,
    path: PATH_MIN,
    compact: false,
    place: false,
  };
}

/** The name's direction for the canvas (the HTML uses `dir=auto`): its first strong letter's. */
export function directionOfText(text: string): 'ltr' | 'rtl' {
  const m = text.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]|[֐-ࣿיִ-﷿ﹰ-﻿]/);
  return m && /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(m[0]) ? 'rtl' : 'ltr';
}
