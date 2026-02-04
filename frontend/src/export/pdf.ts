import type { Document, Point } from '@/types/document';
import type { ThemePalette } from '@/theme';
import { Canvas2DRenderer } from '@/rendering/canvas2d';
import { ViewportImpl } from '@/rendering/viewport';
import { renderFrame, type RenderContext } from '@/rendering/pipeline';
import { SCALE } from '@/config';

/** Padding in mm around the bounding box */
const PADDING_MM = 30;

/**
 * Compute world-space bounding box of all visible entities.
 * Returns { min, max } in mm.  Falls back to a small region around the origin
 * when the document is empty.
 */
function computeWorldBounds(doc: Document): { min: Point; max: Point } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function expandPoint(p: Point) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  for (const sketch of doc.sketches) {
    if (sketch.suppressed) continue;
    for (const entity of sketch.entities) {
      switch (entity.type) {
        case 'line':
          for (const pt of entity.points) expandPoint(pt);
          break;
        case 'circle':
          expandPoint({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
          expandPoint({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
          break;
        case 'rectangle': {
          const hw = entity.width / 2;
          const hh = entity.height / 2;
          expandPoint({ x: entity.center.x - hw, y: entity.center.y - hh });
          expandPoint({ x: entity.center.x + hw, y: entity.center.y + hh });
          break;
        }
        case 'point':
          expandPoint(entity.position);
          break;
        case 'dimension':
          // Dimensions extend outward by their offset; account for clearance
          // We can't resolve the exact geometry here cheaply, but the offset
          // in mm is a reasonable extra margin that the padding already covers.
          break;
      }
    }
  }

  // Fallback for empty documents
  if (minX > maxX) {
    minX = -50;
    minY = -50;
    maxX = 50;
    maxY = 50;
  }

  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/**
 * Export the current document as a PDF blob.
 *
 * Renders to an offscreen canvas using the existing pipeline, encodes as JPEG,
 * then wraps the image in a minimal PDF 1.4 file.
 */
export function exportDocumentToPdf(doc: Document, palette: ThemePalette): Blob {
  const bounds = computeWorldBounds(doc);

  const worldW = bounds.max.x - bounds.min.x;
  const worldH = bounds.max.y - bounds.min.y;

  const scale = SCALE; // 4 px per mm
  const paddingPx = PADDING_MM * scale;

  const canvasW = Math.ceil(worldW * scale + paddingPx * 2);
  const canvasH = Math.ceil(worldH * scale + paddingPx * 2);

  // Create offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx2d = canvas.getContext('2d')!;

  // Set up viewport so the bounding box is centered with padding
  const centerWorldX = (bounds.min.x + bounds.max.x) / 2;
  const centerWorldY = (bounds.min.y + bounds.max.y) / 2;
  const offsetX = canvasW / 2 - centerWorldX * scale;
  const offsetY = canvasH / 2 - centerWorldY * scale;

  const viewport = new ViewportImpl(canvasW, canvasH, { x: offsetX, y: offsetY }, scale);
  const renderer = new Canvas2DRenderer(ctx2d);

  const renderCtx: RenderContext = {
    renderer,
    viewport,
    document: doc,
    selectedEntityIds: new Set(),
    selectedPoints: [],
    selectedSegments: [],
    activeTool: null,
    altKeyHeld: false,
    palette,
  };

  renderFrame(renderCtx);

  // Encode as JPEG
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binaryStr = atob(base64);
  const jpegBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    jpegBytes[i] = binaryStr.charCodeAt(i);
  }

  // Build minimal PDF 1.4
  return buildPdf(jpegBytes, canvasW, canvasH);
}

// ── Minimal PDF builder ──────────────────────────────────────────────

function buildPdf(jpegBytes: Uint8Array, imgW: number, imgH: number): Blob {
  // Convert canvas pixels to PDF points (72 pts/inch, canvas is at 96 dpi equiv)
  const pageW = (imgW * 72) / 96;
  const pageH = (imgH * 72) / 96;

  const enc = new TextEncoder();
  const parts: (Uint8Array | string)[] = [];
  const offsets: number[] = []; // byte offsets of each object
  let pos = 0;

  function write(s: string) {
    parts.push(s);
    pos += enc.encode(s).byteLength;
  }

  function writeBytes(b: Uint8Array) {
    parts.push(b);
    pos += b.byteLength;
  }

  function markObj(n: number) {
    offsets[n] = pos;
  }

  // Header
  write('%PDF-1.4\n%\xC0\xC1\xC2\xC3\n');

  // Obj 1: Catalog
  markObj(1);
  write('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Obj 2: Pages
  markObj(2);
  write('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // Obj 3: Page
  markObj(3);
  write(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n`,
  );

  // Obj 4: Content stream — draw image scaled to full page
  const streamContent = `q ${pageW.toFixed(2)} 0 0 ${pageH.toFixed(2)} 0 0 cm /Img Do Q`;
  markObj(4);
  write(
    `4 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  );

  // Obj 5: Image XObject (JPEG / DCTDecode)
  markObj(5);
  write(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`,
  );
  writeBytes(jpegBytes);
  write('\nendstream\nendobj\n');

  // xref table
  const xrefOffset = pos;
  write('xref\n');
  write(`0 ${offsets.length}\n`);
  write('0000000000 65535 f \n');
  for (let i = 1; i < offsets.length; i++) {
    write(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }

  // Trailer
  write('trailer\n');
  write(`<< /Size ${offsets.length} /Root 1 0 R >>\n`);
  write('startxref\n');
  write(`${xrefOffset}\n`);
  write('%%EOF\n');

  // Merge all parts into a single ArrayBuffer
  const totalLength = parts.reduce(
    (sum, p) => sum + (typeof p === 'string' ? enc.encode(p).byteLength : p.byteLength),
    0,
  );
  const result = new Uint8Array(totalLength);
  let off = 0;
  for (const p of parts) {
    const bytes = typeof p === 'string' ? enc.encode(p) : p;
    result.set(bytes, off);
    off += bytes.byteLength;
  }

  return new Blob([result], { type: 'application/pdf' });
}
