import type { Document } from '@/types/document';
import type { ThemePalette } from '@/theme';
import { Canvas2DRenderer } from '@/rendering/canvas2d';
import { ViewportImpl } from '@/rendering/viewport';
import { renderFrame, type RenderContext } from '@/rendering/pipeline';
import { SCALE } from '@/config';
import { computeWorldBounds } from '@/export/pdf';

const PADDING_MM = 20;

export function exportDocumentToImage(
  doc: Document,
  palette: ThemePalette,
  format: 'png' | 'jpeg',
): Blob {
  const bounds = computeWorldBounds(doc);
  const worldW = bounds.max.x - bounds.min.x;
  const worldH = bounds.max.y - bounds.min.y;

  const scale = SCALE;
  const paddingPx = PADDING_MM * scale;

  const canvasW = Math.ceil(worldW * scale + paddingPx * 2);
  const canvasH = Math.ceil(worldH * scale + paddingPx * 2);

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx2d = canvas.getContext('2d')!;

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
    lineWidthScale: 2.5,
    fontSizeScale: 5,
  };

  renderFrame(renderCtx);

  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = format === 'jpeg' ? 0.92 : undefined;
  const dataUrl = canvas.toDataURL(mimeType, quality);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
