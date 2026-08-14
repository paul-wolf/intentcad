import type { Document } from '@/types/document';
import { renderSheet, canvasToBlob } from '@/export/sheet';

const JPEG_QUALITY = 0.92;

/**
 * Export the current document as a raster drawing sheet — same layout as the
 * PDF export (fitted at a standard scale, black on white, frame and title
 * block), rendered at 300 dpi.
 */
export async function exportDocumentToImage(
  doc: Document,
  format: 'png' | 'jpeg',
): Promise<Blob> {
  const { canvas } = renderSheet(doc);
  return canvasToBlob(
    canvas,
    format === 'png' ? 'image/png' : 'image/jpeg',
    format === 'jpeg' ? JPEG_QUALITY : undefined,
  );
}
