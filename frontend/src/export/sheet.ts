import type { Document, DocumentMetadata, Point } from '@/types/document';
import type { ThemePalette } from '@/theme';
import { LIGHT_PALETTE } from '@/theme';
import { Canvas2DRenderer } from '@/rendering/canvas2d';
import { ViewportImpl } from '@/rendering/viewport';
import { renderFrame, type RenderContext } from '@/rendering/pipeline';
import { DIMENSION_FONT_SIZE, STROKES } from '@/config';
import { BoundsBuilder, type Bounds } from '@/utils/bounds';

/**
 * Sheet export: renders the document as a printable drawing sheet
 * (fixed paper size, fitted at a standard scale, black on white, with a
 * frame and a title block).  Shared by the PDF, PNG and JPEG exporters so
 * all three produce the same drawing.
 */

const MM_PER_INCH = 25.4;

/** Paper: A4, orientation chosen to fit the drawing. */
const PAGE_NAME = 'A4';
const PAGE_LONG_MM = 297;
const PAGE_SHORT_MM = 210;

/** Frame margin from the paper edge, in mm */
const MARGIN_MM = 10;

/** Title block size, in mm */
const TITLE_W_MM = 90;
const TITLE_H_MM = 40;

/** Standard drawing scales (paper mm per world mm), largest first */
const STD_SCALES = [
  100, 50, 20, 10, 5, 2, 1,
  0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001,
];

/** Printed line width for a `STROKES.line` stroke, in mm */
const LINE_WIDTH_MM = 0.35;

/** Printed cap height for dimension text, in mm */
const TEXT_HEIGHT_MM = 3;

/** Resolution used to probe the drawing's true extents (px per paper mm) */
const PROBE_PX_PER_MM = 3;

/** Palette for exported sheets: black on white, no theme / state colours. */
export const PRINT_PALETTE: ThemePalette = {
  ...LIGHT_PALETTE,
  background: '#ffffff',
  gridMinor: '#ffffff',
  gridMajor: '#ffffff',
  line: '#000000',
  lineSelected: '#000000',
  constrained: '#000000',
  constraintLink: '#000000',
  ghosted: '#9ca3af',
  preview: '#000000',
  dimension: '#000000',
  dimensionText: '#000000',
  dimensionOverlay: '#000000',
  origin: '#000000',
};

export type { Bounds };

/**
 * World-space bounding box of the entities that will be drawn.
 *
 * Covers geometry only — dimension annotations extend well beyond it.
 * Use {@link measureDrawingBounds} for the extents of the finished drawing.
 */
export function computeWorldBounds(doc: Document): Bounds {
  const builder = new BoundsBuilder();

  for (const sketch of doc.sketches) {
    if (sketch.suppressed) continue;
    if (!sketch.visible && sketch.id !== doc.activeSketchId) continue;
    // Dimension annotations are skipped here — see measureDrawingBounds
    for (const entity of sketch.entities) builder.expandEntity(entity);
  }

  // Fallback for empty documents
  if (builder.isEmpty) {
    return { min: { x: -50, y: -50 }, max: { x: 50, y: 50 } };
  }

  return builder.toBounds();
}

/** Largest dimension offset in the document, in mm (0 when there are none). */
function maxDimensionOffset(doc: Document): number {
  let max = 0;
  for (const sketch of doc.sketches) {
    if (sketch.suppressed) continue;
    for (const entity of sketch.entities) {
      if (entity.type !== 'dimension') continue;
      const o = Math.abs(entity.offset ?? 0);
      if (o > max) max = o;
    }
  }
  return max;
}

/** Render the drawing (no sheet furniture) into an existing 2D context. */
function drawDrawing(
  ctx2d: CanvasRenderingContext2D,
  doc: Document,
  viewport: ViewportImpl,
  lineWidthScale: number,
  fontSizeScale: number,
): void {
  const renderCtx: RenderContext = {
    renderer: new Canvas2DRenderer(ctx2d),
    viewport,
    document: doc,
    selectedEntityIds: new Set(),
    selectedPoints: [],
    selectedSegments: [],
    activeTool: null,
    altKeyHeld: false,
    palette: PRINT_PALETTE,
    camMode: false,
    exportMode: true,
    lineWidthScale,
    fontSizeScale,
  };
  renderFrame(renderCtx);
}

/**
 * Measure the drawing's true extents, dimension annotations included.
 *
 * Dimension geometry (extension lines, arrows, text) is laid out at render
 * time and cannot be predicted cheaply, so the drawing is rendered once at
 * low resolution onto a generously sized canvas and the inked pixels are
 * measured.  Returns world-space mm.
 *
 * Annotation sizes are fixed on paper, so how far they reach in world units
 * depends on the drawing scale — the probe therefore renders at `drawScale`
 * too, and the caller iterates.
 */
export function measureDrawingBounds(doc: Document, drawScale = 1): Bounds {
  const geom = computeWorldBounds(doc);

  // Slack so nothing lands outside the probe canvas: dimension offsets are
  // world mm, annotation glyphs are paper mm.
  const slack = maxDimensionOffset(doc) + 5 + 40 / drawScale;
  const probeMin: Point = { x: geom.min.x - slack, y: geom.min.y - slack };
  const probeMax: Point = { x: geom.max.x + slack, y: geom.max.y + slack };

  // px per *world* mm at the probe's paper resolution
  const scale = PROBE_PX_PER_MM * drawScale;
  const w = Math.max(1, Math.ceil((probeMax.x - probeMin.x) * scale));
  const h = Math.max(1, Math.ceil((probeMax.y - probeMin.y) * scale));

  // Guard against pathological documents blowing up memory
  if (w * h > 40_000_000) return geom;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return geom;

  const viewport = new ViewportImpl(w, h, { x: -probeMin.x * scale, y: -probeMin.y * scale }, scale);
  drawDrawing(
    ctx2d,
    doc,
    viewport,
    (LINE_WIDTH_MM * PROBE_PX_PER_MM) / STROKES.line,
    (TEXT_HEIGHT_MM * PROBE_PX_PER_MM) / DIMENSION_FONT_SIZE,
  );

  const data = ctx2d.getImageData(0, 0, w, h).data;
  let minPx = Infinity;
  let minPy = Infinity;
  let maxPx = -Infinity;
  let maxPy = -Infinity;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      // Background is opaque white; anything darker is ink
      if (data[i]! > 248 && data[i + 1]! > 248 && data[i + 2]! > 248) continue;
      if (x < minPx) minPx = x;
      if (x > maxPx) maxPx = x;
      if (y < minPy) minPy = y;
      if (y > maxPy) maxPy = y;
    }
  }

  if (minPx > maxPx) return geom;

  return {
    min: { x: probeMin.x + minPx / scale, y: probeMin.y + minPy / scale },
    max: { x: probeMin.x + (maxPx + 1) / scale, y: probeMin.y + (maxPy + 1) / scale },
  };
}

export interface SheetLayout {
  pageName: string;
  pageWidthMm: number;
  pageHeightMm: number;
  /** Paper mm per world mm */
  drawScale: number;
  /** Human-readable scale, e.g. "1:2" or "5:1" */
  scaleLabel: string;
  bounds: Bounds;
}

function formatScale(s: number): string {
  if (s >= 1) {
    const n = Math.round(s * 100) / 100;
    return `${n}:1`;
  }
  return `1:${Math.round(1 / s)}`;
}

/** Fraction of the drawing area the content is fitted into, leaving a guard band. */
const FIT_MARGIN = 0.96;

function fitToPage(bounds: Bounds): { w: number; h: number; scale: number } {
  const contentW = Math.max(bounds.max.x - bounds.min.x, 0.001);
  const contentH = Math.max(bounds.max.y - bounds.min.y, 0.001);

  const orientations = [
    { w: PAGE_LONG_MM, h: PAGE_SHORT_MM },
    { w: PAGE_SHORT_MM, h: PAGE_LONG_MM },
  ];

  let best = { w: PAGE_LONG_MM, h: PAGE_SHORT_MM, scale: STD_SCALES[STD_SCALES.length - 1]! };
  for (const o of orientations) {
    const areaW = (o.w - MARGIN_MM * 2) * FIT_MARGIN;
    const areaH = (o.h - MARGIN_MM * 2 - TITLE_H_MM) * FIT_MARGIN;
    const fit = STD_SCALES.find((s) => contentW * s <= areaW && contentH * s <= areaH);
    if (fit !== undefined && fit > best.scale) best = { w: o.w, h: o.h, scale: fit };
  }
  return best;
}

/**
 * Pick paper orientation and a standard scale that fits the drawing.
 *
 * Extents and scale are mutually dependent (annotations are a fixed size on
 * paper), so this iterates until the scale settles.
 */
export function computeSheetLayout(doc: Document): SheetLayout {
  let bounds = measureDrawingBounds(doc, 1);
  let page = fitToPage(bounds);

  for (let i = 0; i < 2; i++) {
    const nextBounds = measureDrawingBounds(doc, page.scale);
    const nextPage = fitToPage(nextBounds);
    bounds = nextBounds;
    if (nextPage.scale === page.scale) {
      page = nextPage;
      break;
    }
    page = nextPage;
  }

  return {
    pageName: PAGE_NAME,
    pageWidthMm: page.w,
    pageHeightMm: page.h,
    drawScale: page.scale,
    scaleLabel: formatScale(page.scale),
    bounds,
  };
}

/** Draw the sheet frame and title block directly in paper coordinates. */
function drawSheetFurniture(
  ctx2d: CanvasRenderingContext2D,
  layout: SheetLayout,
  pxPerMm: number,
  docName: string,
  meta: DocumentMetadata | undefined,
): void {
  const mm = (v: number) => v * pxPerMm;

  ctx2d.save();
  ctx2d.strokeStyle = '#000000';
  ctx2d.fillStyle = '#000000';
  ctx2d.lineJoin = 'miter';

  // Frame
  ctx2d.lineWidth = mm(0.35);
  ctx2d.strokeRect(
    mm(MARGIN_MM),
    mm(MARGIN_MM),
    mm(layout.pageWidthMm - MARGIN_MM * 2),
    mm(layout.pageHeightMm - MARGIN_MM * 2),
  );

  // Title block, anchored to the bottom-right corner of the frame
  const x0 = layout.pageWidthMm - MARGIN_MM - TITLE_W_MM;
  const y0 = layout.pageHeightMm - MARGIN_MM - TITLE_H_MM;
  const nameRowH = 10;
  const descRowH = 8;
  const rowH = (TITLE_H_MM - nameRowH - descRowH) / 4;
  const labelColW = 25;

  // Opaque so the drawing never shows through
  ctx2d.fillStyle = '#ffffff';
  ctx2d.fillRect(mm(x0), mm(y0), mm(TITLE_W_MM), mm(TITLE_H_MM));
  ctx2d.fillStyle = '#000000';

  ctx2d.lineWidth = mm(0.25);
  ctx2d.strokeRect(mm(x0), mm(y0), mm(TITLE_W_MM), mm(TITLE_H_MM));

  function line(ax: number, ay: number, bx: number, by: number) {
    ctx2d.beginPath();
    ctx2d.moveTo(mm(ax), mm(ay));
    ctx2d.lineTo(mm(bx), mm(by));
    ctx2d.stroke();
  }

  const rowTop = (i: number) => y0 + nameRowH + rowH * i;
  line(x0, y0 + nameRowH, x0 + TITLE_W_MM, y0 + nameRowH);
  for (let i = 1; i <= 4; i++) line(x0, rowTop(i), x0 + TITLE_W_MM, rowTop(i));
  line(x0 + labelColW, y0 + nameRowH, x0 + labelColW, rowTop(4));

  function text(s: string, x: number, y: number, sizeMm: number, bold = false) {
    if (!s) return;
    ctx2d.font = `${bold ? '600 ' : ''}${mm(sizeMm)}px sans-serif`;
    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText(s, mm(x), mm(y));
  }

  // Document name
  text(docName, x0 + 3, y0 + nameRowH / 2, 4.5, true);

  const rows: [string, string][] = [
    ['Scale', layout.scaleLabel],
    ['Size', layout.pageName],
    ['Date', new Date().toLocaleDateString()],
    ['Drawn by', meta?.author ?? ''],
  ];
  if (meta?.revision) rows[1] = ['Rev', meta.revision];

  for (let i = 0; i < rows.length; i++) {
    const cy = rowTop(i) + rowH / 2;
    text(rows[i]![0], x0 + 3, cy, 2.6);
    text(rows[i]![1], x0 + labelColW + 3, cy, 3);
  }

  // Description, clipped to the bottom row
  const desc = meta?.description ?? '';
  if (desc) {
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(mm(x0), mm(rowTop(4)), mm(TITLE_W_MM), mm(descRowH));
    ctx2d.clip();
    text(desc, x0 + 3, rowTop(4) + descRowH / 2, 2.8);
    ctx2d.restore();
  }

  ctx2d.restore();
}

export interface RenderedSheet {
  canvas: HTMLCanvasElement;
  layout: SheetLayout;
}

/**
 * Render the document as a complete drawing sheet.
 *
 * @param dpi output resolution; 300 gives print quality.
 */
export function renderSheet(doc: Document, dpi = 300): RenderedSheet {
  const layout = computeSheetLayout(doc);
  const pxPerMm = dpi / MM_PER_INCH;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.pageWidthMm * pxPerMm);
  canvas.height = Math.round(layout.pageHeightMm * pxPerMm);
  const ctx2d = canvas.getContext('2d')!;

  // Paper
  ctx2d.fillStyle = '#ffffff';
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);

  // Drawing area: the frame, less the band occupied by the title block
  const areaX = MARGIN_MM;
  const areaY = MARGIN_MM;
  const areaW = layout.pageWidthMm - MARGIN_MM * 2;
  const areaH = layout.pageHeightMm - MARGIN_MM * 2 - TITLE_H_MM;

  // px per world mm
  const worldScale = pxPerMm * layout.drawScale;
  const centerWorldX = (layout.bounds.min.x + layout.bounds.max.x) / 2;
  const centerWorldY = (layout.bounds.min.y + layout.bounds.max.y) / 2;
  const offset: Point = {
    x: (areaX + areaW / 2) * pxPerMm - centerWorldX * worldScale,
    y: (areaY + areaH / 2) * pxPerMm - centerWorldY * worldScale,
  };

  const viewport = new ViewportImpl(canvas.width, canvas.height, offset, worldScale);

  // Stroke weights and text are specified in printed mm, independent of dpi
  const lineWidthScale = (LINE_WIDTH_MM * pxPerMm) / STROKES.line;
  const fontSizeScale = (TEXT_HEIGHT_MM * pxPerMm) / DIMENSION_FONT_SIZE;

  // Keep the drawing inside its area even if an annotation overhangs
  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.rect(areaX * pxPerMm, areaY * pxPerMm, areaW * pxPerMm, areaH * pxPerMm);
  ctx2d.clip();
  drawDrawing(ctx2d, doc, viewport, lineWidthScale, fontSizeScale);
  ctx2d.restore();
  drawSheetFurniture(ctx2d, layout, pxPerMm, doc.name, doc.metadata);

  return { canvas, layout };
}

/** Encode a canvas as a Blob, falling back to toDataURL when toBlob is absent. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      const dataUrl = canvas.toDataURL(mimeType, quality);
      resolve(dataUrlToBlob(dataUrl, mimeType));
      return;
    }
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`Failed to encode canvas as ${mimeType}`));
      },
      mimeType,
      quality,
    );
  });
}

function dataUrlToBlob(dataUrl: string, mimeType: string): Blob {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export { MM_PER_INCH };
