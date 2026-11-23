import { FIT_LINE_HEIGHT, fitLabel, type TextMeasure } from './label-fit.js';
import {
  CODE_TRACKING,
  cellMetrics,
  directionOfText,
  LABEL_MONO,
  LABEL_SANS,
  PLACE_INK,
} from './label-layout.js';
import type { LabelStock } from './label-stocks.js';
import { printedCode } from './short-code.js';

export type LabelArtwork = { code: string; url: string; name?: string; path?: string };

/** The drawing operations shared by the browser canvas and the server canvas. */
export type LabelContext = {
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  font: string;
  fillStyle: unknown;
  textAlign: string;
  textBaseline: string;
  direction: string;
  letterSpacing?: string;
};

/** The code, its characters 0.06 em apart as on the HTML label: through the canvas's
 * `letterSpacing` where the browser has it, else one character at a time (the code is Latin in a
 * monospaced face, so nothing is lost drawing it that way). */
function fillCode(ctx: LabelContext, text: string, x: number, y: number, size: number) {
  const spacing = size * CODE_TRACKING;
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = `${spacing}px`;
    ctx.fillText(text, x, y);
    ctx.letterSpacing = '0px';
    return;
  }
  let pen = x;
  for (const ch of text) {
    ctx.fillText(ch, pen, y);
    pen += ctx.measureText(ch).width + spacing;
  }
}

/** Draws one label: white ground, the QR (if the stock has one), the code, and the name and
 * place where the stock prints them. */
export function drawLabelRaster(
  ctx: LabelContext,
  stock: LabelStock,
  label: LabelArtwork,
  matrix: readonly (readonly boolean[])[],
  dotsPerMm: number,
) {
  const pxOf = (mm: number) => Math.round(mm * dotsPerMm);
  const width = pxOf(stock.cell.w);
  const height = pxOf(stock.cell.h);
  const m = cellMetrics(stock);
  const pad = pxOf(m.pad);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // The QR on whole pixels per module, centred in its square, so no module blurs. Narrow tape has
  // none: the code takes its place, in a column of its own.
  const side = pxOf(m.qr);
  if (m.qr > 0) {
    const n = matrix.length;
    // One extra dot fits in the gutter and can keep a whole larger module at printer resolution.
    const unit = Math.max(1, Math.floor((side + 1) / n));
    const qx = pad + Math.floor((side - unit * n) / 2);
    const qy = Math.floor((height - unit * n) / 2);
    ctx.fillStyle = '#000000';
    matrix.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) ctx.fillRect(qx + x * unit, qy + y * unit, unit, unit);
      });
    });
  }

  const beside = m.codeColumn > 0;
  const x0 = beside ? pad + pxOf(m.codeColumn) + pad : pad + side + pad;
  const textWidth = pxOf(m.text);
  const code = pxOf(m.code);
  type Block = {
    lines: string[];
    step: number;
    font: string;
    color: string;
    rtl: boolean;
    code?: boolean;
  };
  const blocks: Block[] = [];
  ctx.textBaseline = 'top';
  ctx.font = `600 ${code}px ${LABEL_MONO}`;
  const codeBlock: Block = {
    lines: [printedCode(label.code)],
    step: code,
    font: ctx.font,
    color: '#000000',
    rtl: false,
    code: true,
  };
  if (beside) {
    ctx.fillStyle = '#000000';
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    fillCode(ctx, printedCode(label.code), pad, Math.round((height - code) / 2), code);
  } else blocks.push(codeBlock);
  // The same lines and sizes as the HTML label (fit.ts), measured on this canvas.
  const measure: TextMeasure = (text, size, weight = 600) => {
    ctx.font = `${weight} 100px ${LABEL_SANS}`;
    return (ctx.measureText(text).width / 100) * size;
  };
  const fit = fitLabel(stock, label, measure);
  for (const [part, text, weight, color] of [
    [fit.name, label.name, 600, '#000000'],
    [fit.path, label.path, 400, PLACE_INK],
  ] as const) {
    if (!part || !text) continue;
    const size = pxOf(part.size);
    blocks.push({
      lines: part.lines,
      step: Math.round(size * FIT_LINE_HEIGHT),
      font: `${weight} ${size}px ${LABEL_SANS}`,
      color,
      rtl: directionOfText(text) === 'rtl',
    });
  }

  // Centred as a block beside the QR, like the HTML label.
  const gap = Math.round(pad * 0.6);
  const total =
    blocks.reduce((sum, b) => sum + b.step * b.lines.length, 0) +
    gap * Math.max(0, blocks.length - 1);
  let y = Math.max(pad, Math.round((height - total) / 2));
  for (const b of blocks) {
    ctx.font = b.font;
    ctx.fillStyle = b.color;
    ctx.direction = b.rtl ? 'rtl' : 'ltr';
    ctx.textAlign = b.rtl ? 'right' : 'left';
    const x = b.rtl ? x0 + textWidth : x0;
    for (const line of b.lines) {
      if (b.code) fillCode(ctx, line, x, y, code);
      else ctx.fillText(line, x, y);
      y += b.step;
    }
    y += gap;
  }
  return fit.fits;
}
