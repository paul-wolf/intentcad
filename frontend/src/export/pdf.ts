import type { Document, DocumentMetadata, Point } from '@/types/document';
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
        case 'bezier':
          // Convex hull of control points contains the curve
          for (const cp of entity.controlPoints) expandPoint(cp);
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
    camMode: false,
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
  return buildPdf(jpegBytes, canvasW, canvasH, doc.name, doc.metadata);
}

// ── Minimal PDF builder ──────────────────────────────────────────────

/** Escape special PDF string characters: backslash and parentheses */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Build the title block content stream (PDF drawing operators). */
function buildTitleBlockStream(
  pageW: number,
  _pageH: number,
  name: string,
  meta: DocumentMetadata | undefined,
): string {
  const margin = 10;
  const blockW = 200;
  const rowH = 14;
  const labelCol = 50;
  const nameRowH = 18;
  const descRowH = 20;
  const blockH = nameRowH + rowH * 4 + descRowH; // 18 + 56 + 20 = 94

  const x0 = pageW - margin - blockW;
  const y0 = margin;

  const lines: string[] = [];

  // Save graphics state
  lines.push('q');

  // Draw outer rectangle (stroke)
  lines.push('0.3 0.3 0.3 RG'); // dark gray stroke
  lines.push('0.5 w'); // line width
  lines.push(`${x0} ${y0} ${blockW} ${blockH} re S`);

  // Fill background with white
  lines.push('1 1 1 rg'); // white fill
  lines.push(`${x0} ${y0} ${blockW} ${blockH} re f`);

  // Re-draw outer rectangle on top of fill
  lines.push('0.3 0.3 0.3 RG');
  lines.push('0.5 w');
  lines.push(`${x0} ${y0} ${blockW} ${blockH} re S`);

  // Horizontal dividers (from bottom up):
  // y0 + descRowH = bottom of row 4
  // y0 + descRowH + rowH = bottom of row 3, etc.
  const dividers = [
    y0 + descRowH,
    y0 + descRowH + rowH,
    y0 + descRowH + rowH * 2,
    y0 + descRowH + rowH * 3,
    y0 + descRowH + rowH * 4,
  ];
  for (const dy of dividers) {
    lines.push(`${x0} ${dy} m ${x0 + blockW} ${dy} l S`);
  }

  // Vertical divider for label column (only in the 4 data rows)
  const vx = x0 + labelCol;
  lines.push(`${vx} ${y0 + descRowH} m ${vx} ${y0 + descRowH + rowH * 4} l S`);

  // Helper: place text at absolute position using Tm (text matrix)
  function textAt(tx: number, ty: number, fontSize: number, text: string) {
    lines.push(`/F1 ${fontSize} Tf`);
    lines.push(`1 0 0 1 ${tx.toFixed(2)} ${ty.toFixed(2)} Tm`);
    lines.push(`(${pdfEscape(text)}) Tj`);
  }

  // Text rendering
  lines.push('BT');
  lines.push('0 0 0 rg'); // black text

  // Description (bottom row, full width)
  const descText = meta?.description ?? '';
  textAt(x0 + 4, y0 + 6, 7, descText);

  // Labels + values for the 4 middle rows
  const dataRows = [
    { label: 'Scale', value: '1:1' },
    { label: 'Rev', value: meta?.revision ?? '' },
    { label: 'Date', value: new Date().toLocaleDateString() },
    { label: 'Drawn by', value: meta?.author ?? '' },
  ];

  for (let i = 0; i < dataRows.length; i++) {
    const rowY = y0 + descRowH + rowH * i + 4;
    textAt(x0 + 4, rowY, 7, dataRows[i]!.label);
    textAt(vx + 4, rowY, 8, dataRows[i]!.value);
  }

  // Document name (top row)
  const nameY = y0 + descRowH + rowH * 4 + 5;
  textAt(x0 + 4, nameY, 10, name);

  lines.push('ET');

  // Restore graphics state
  lines.push('Q');

  return lines.join('\n');
}

function buildPdf(
  jpegBytes: Uint8Array,
  imgW: number,
  imgH: number,
  docName: string,
  metadata: DocumentMetadata | undefined,
): Blob {
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

  // Obj 3: Page (with Font resource for title block)
  markObj(3);
  write(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Contents [4 0 R 6 0 R] /Resources << /XObject << /Img 5 0 R >> /Font << /F1 7 0 R >> >> >>\nendobj\n`,
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

  // Obj 6: Title block content stream
  const titleBlockContent = buildTitleBlockStream(pageW, pageH, docName, metadata);
  const titleBlockBytes = enc.encode(titleBlockContent);
  markObj(6);
  write(
    `6 0 obj\n<< /Length ${titleBlockBytes.byteLength} >>\nstream\n`,
  );
  writeBytes(titleBlockBytes);
  write('\nendstream\nendobj\n');

  // Obj 7: Font (Helvetica — built-in PDF font, no embedding needed)
  markObj(7);
  write(
    '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  );

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
