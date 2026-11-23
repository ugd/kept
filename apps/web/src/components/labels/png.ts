/**
 * Labels as PNGs made on the phone (D44, D185), for label-printer apps that take an
 * image: one PNG per label at 300 dpi of the stock's cell, shared together through the share
 * sheet where the browser can share files, downloaded otherwise.
 *
 * The same geometry as the print sheet (`cellMetrics`) and the same lines (`fitLabel`). QR modules are filled rectangles on a
 * whole-pixel grid; text is `fillText`, so the canvas shapes Arabic, after the Plex faces have
 * loaded (a canvas never waits for a font on its own). `drawLabel` takes any 2D context, so a
 * test can rasterise it without a canvas.
 */
import { drawLabelRaster, type LabelContext, type LabelStock } from '@kept/shared';
import type { LabelCellContent } from '@/api/capture/types';
import { canShareFiles, downloadsWork, saveFile, shareFiles } from '@/lib/files';
import { loadLabelFaces } from './fit';
import { loadQr, qrMatrix } from './qr';

export type { LabelContext };

export const PNG_DPI = 300;

export const pxOf = (millimetres: number) => Math.round((millimetres / 25.4) * PNG_DPI);

/** The PNG's size in pixels: the cell at 300 dpi. */
export function labelPixelSize(stock: LabelStock): { width: number; height: number } {
  return { width: pxOf(stock.cell.w), height: pxOf(stock.cell.h) };
}

export function drawLabel(
  ctx: LabelContext,
  stock: LabelStock,
  label: LabelCellContent,
  matrix: readonly (readonly boolean[])[],
) {
  drawLabelRaster(ctx, stock, label, matrix, PNG_DPI / 25.4);
}

/** One PNG file per label, named by its code. */
export async function labelPngs(
  stock: LabelStock,
  labels: readonly LabelCellContent[],
): Promise<File[]> {
  const [encode] = await Promise.all([loadQr(), loadLabelFaces()]);
  const { width, height } = labelPixelSize(stock);
  const files: File[] = [];
  for (const label of labels) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    drawLabel(ctx, stock, label, qrMatrix(encode, label.url));
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob gave nothing');
    files.push(new File([blob], `kept-${label.code}.png`, { type: 'image/png' }));
  }
  return files;
}

/**
 * Hands the PNGs to the share sheet (a label-printer app, Files, Messages) where the browser can
 * share files; otherwise downloads them. 'cancelled' when the person closed the share sheet,
 * 'refused' when the browser wouldn't share and can't download either (an installed iPhone app,
 * lib/files.ts). Pass files made before the press: iOS refuses a share that waited on them.
 */
export async function shareOrDownload(
  files: File[],
  title: string,
): Promise<'shared' | 'downloaded' | 'cancelled' | 'refused'> {
  if (canShareFiles(files)) {
    const how = await shareFiles(files, title);
    if (how !== 'refused') return how;
    // Refused for another reason (too many files, say): download them where that works.
  }
  if (!downloadsWork()) return 'refused';
  for (const file of files) saveFile(file);
  return 'downloaded';
}
