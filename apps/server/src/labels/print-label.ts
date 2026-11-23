import { join } from 'node:path';
import {
  cellMetrics,
  drawLabelRaster,
  type LabelArtwork,
  labelStock,
  NAME_MIN,
  printedCode,
  SHORT_CODE,
} from '@kept/shared';
import sharp from 'sharp';
import { encode } from 'uqr';
import { invalid } from '../http/errors.js';
import { ensureFonts } from '../reports/render/fonts.js';
import type { PrintFormat } from './print-server.js';
import { drawShortCode } from './print-short-code.js';

const thermalStock = labelStock('thermal_50x30');
const ARTWORK_FONTS = [
  'IBMPlexMono-SemiBold.ttf',
  'IBMPlexSans-Regular.ttf',
  'IBMPlexSans-SemiBold.ttf',
  'IBMPlexSansArabic-Regular.ttf',
  'IBMPlexSansArabic-SemiBold.ttf',
];
let canvasWithFonts: Promise<typeof import('@napi-rs/canvas')> | undefined;

function labelCanvas() {
  canvasWithFonts ??= Promise.all([import('@napi-rs/canvas'), ensureFonts()])
    .then(([canvas, directory]) => {
      for (const font of ARTWORK_FONTS) {
        if (!canvas.GlobalFonts.registerFromPath(join(directory, font))) {
          throw new Error(`Could not load label font ${font}`);
        }
      }
      return canvas;
    })
    .catch((error: unknown) => {
      canvasWithFonts = undefined;
      throw error;
    });
  return canvasWithFonts;
}

/** The phone PNG and the thermal raster use the same QR-left layout and text fitting. */
export async function renderPrintLabel(label: LabelArtwork, format: PrintFormat) {
  if (!SHORT_CODE.test(label.code)) throw invalid();
  const widthMm = format.printableWidthMm ?? format.widthMm;
  const { heightMm, dotsPerMm } = format;
  const width = Math.round(widthMm * dotsPerMm);
  const height = Math.round(heightMm * dotsPerMm);
  const stock = { ...thermalStock, cell: { w: widthMm, h: heightMm } };
  const matrix = encode(label.url, { ecc: 'M', border: 4 }).data;
  const metrics = cellMetrics(stock);
  if (Math.round(metrics.qr * dotsPerMm) < 2 * matrix.length || metrics.code < NAME_MIN) {
    // Very narrow formats still fit the QR and code stacked, using whole printer dots.
    return renderStackedLabel(label.code, matrix, width, height, dotsPerMm);
  }

  const { createCanvas } = await labelCanvas();
  const canvas = createCanvas(width, height);
  const fits = drawLabelRaster(canvas.getContext('2d'), stock, label, matrix, dotsPerMm);
  if (!fits) throw invalid('The name and location are too long for this label format.');
  return monochrome(await canvas.encode('png'));
}

function renderStackedLabel(
  code: string,
  matrix: readonly (readonly boolean[])[],
  width: number,
  height: number,
  dotsPerMm: number,
) {
  const text = printedCode(code);
  const charactersWide = text.length * 6 - 1;
  const textScale = Math.min(
    Math.max(1, Math.round(dotsPerMm / 4)),
    Math.floor((width - 4) / charactersWide),
  );
  const textSpace = 7 * textScale + 4;
  const scale = Math.floor(Math.min(width - 4, height - textSpace - 4) / matrix.length);
  if (scale < 2)
    throw invalid('The label is too small to fit this QR code at the printer resolution.');

  const side = matrix.length * scale;
  const startX = Math.floor((width - side) / 2);
  const startY = Math.floor((height - side - textSpace) / 2);
  let path = '';
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${startX + x * scale} ${startY + y * scale}h${scale}v${scale}h-${scale}z`;
    });
  });
  path += drawShortCode(
    text,
    textScale,
    Math.floor((width - charactersWide * textScale) / 2),
    startY + side + 2,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>
    <path d="${path}" fill="#000" shape-rendering="crispEdges"/>
  </svg>`;
  return monochrome(Buffer.from(svg));
}

function monochrome(artwork: Buffer): Promise<Buffer> {
  return sharp(artwork).flatten({ background: '#fff' }).threshold(128).png().toBuffer();
}
