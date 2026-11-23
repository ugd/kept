/**
 * Where each label goes and how big its parts are (D44, D134, D175, D185). Pure, so the
 * print sheet (sheet.tsx), the builder's preview and the phone PNG (png.ts) share one geometry
 * and the tests can pin it per stock.
 *
 * All lengths are millimetres. A sheet is physical paper: its cells run left to right from the
 * top-left corner in every language, like the maker's numbering, so the sheet is laid out LTR
 * and only the names inside a label follow their own direction (`dir=auto`, D97).
 */
import { cellsFor, isSheet, type LabelCell, type LabelStock } from '@kept/shared';
import type { LabelCellContent } from '@/api/capture/types';

export {
  CODE_TRACKING,
  cellMetrics,
  directionOfText,
  LABEL_MONO,
  LABEL_SANS,
  PLACE_INK,
} from '@kept/shared';

/** A CSS length in millimetres, rounded to a hundredth so snapshots stay readable. */
export const mm = (n: number) => `${Math.round(n * 100) / 100}mm`;

/** CSS pixels per millimetre (96 per inch). */
export const PX_PER_MM = 96 / 25.4;

/** The paper by name where it has one, so the print dialog picks that paper itself. */
function pageSize(stock: LabelStock): string {
  const { w, h } = stock.page;
  if (w === 210 && h === 297) return 'A4';
  if (w === 215.9 && h === 279.4) return 'letter';
  return `${mm(w)} ${mm(h)}`;
}

/**
 * The one `@page` rule a print view installs for its stock: the paper, and no margin, so the
 * browser's default settings (Margins "Default", scale 100 %) print each label in its cell.
 */
export function pageCss(stock: LabelStock): string {
  return `@page { size: ${pageSize(stock)}; margin: 0; }`;
}

export type PlacedLabel = { label: LabelCellContent; cell: LabelCell };

/**
 * The labels on their pages, from `startCell` (1-based, sheets only; a roll ignores it). Pages
 * with no label are never produced, so a start cell near the end of a sheet can't print a blank
 * page first.
 */
export function placeLabels(
  stock: LabelStock,
  labels: readonly LabelCellContent[],
  startCell = 1,
): PlacedLabel[][] {
  const { pages, cells } = cellsFor(stock, labels.length, isSheet(stock) ? startCell : 1);
  const out: PlacedLabel[][] = Array.from({ length: pages }, () => []);
  cells.forEach((cell, i) => {
    const label = labels[i];
    if (label) out[cell.page]?.push({ label, cell });
  });
  return out;
}

/** Cells per page: 1 on a roll. */
export const perPage = (stock: LabelStock) => stock.cols * stock.rows;

/** The pages `count` labels take from `startCell`, without placing them. */
export function pagesFor(stock: LabelStock, count: number, startCell = 1): number {
  if (count <= 0) return 0;
  const offset = isSheet(stock) ? startCell - 1 : 0;
  return Math.ceil((offset + count) / perPage(stock));
}

/** "Row 4, column 1" for a 1-based cell on a sheet. */
export function rowColOf(stock: LabelStock, cell: number): { row: number; col: number } {
  return { row: Math.floor((cell - 1) / stock.cols) + 1, col: ((cell - 1) % stock.cols) + 1 };
}
