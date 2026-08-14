import type { Document } from '@/types/document';
import { renderSheet, canvasToBlob, MM_PER_INCH } from '@/export/sheet';

export { computeWorldBounds } from '@/export/sheet';

/** JPEG quality used for the page image */
const JPEG_QUALITY = 0.92;

/**
 * Export the current document as a PDF blob.
 *
 * Renders the document as a drawing sheet (fitted at a standard scale, black
 * on white, with a frame and title block), then wraps it in a minimal
 * PDF 1.4 file at the correct paper size.
 */
export async function exportDocumentToPdf(doc: Document): Promise<Blob> {
  const { canvas, layout } = renderSheet(doc);

  const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  const jpegBytes = new Uint8Array(await blob.arrayBuffer());

  // PDF user space is 72 points per inch
  const pageW = (layout.pageWidthMm / MM_PER_INCH) * 72;
  const pageH = (layout.pageHeightMm / MM_PER_INCH) * 72;

  return buildPdf(jpegBytes, canvas.width, canvas.height, pageW, pageH);
}

// ── Minimal PDF builder ──────────────────────────────────────────────

function buildPdf(
  jpegBytes: Uint8Array,
  imgW: number,
  imgH: number,
  pageW: number,
  pageH: number,
): Blob {
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

  // Obj 4: Content stream — draw the sheet image over the whole page
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
