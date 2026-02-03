import { useRef, useCallback } from 'react';
import { Canvas2DRenderer } from '@/rendering/canvas2d';
import { ViewportImpl } from '@/rendering/viewport';
import { renderFrame } from '@/rendering/pipeline';
import type { RenderContext } from '@/rendering/pipeline';
import type { Tool } from '@/tools/types';
import type { Document } from '@/types/document';
import type { SelectedPoint } from '@/stores/editorStore';
import { useThemeStore } from '@/theme';

interface UseCanvasRendererOpts {
  getDocument: () => Document;
  getSelectedEntityIds: () => Set<string>;
  getSelectedPoints: () => SelectedPoint[];
  getActiveTool: () => Tool | null;
  getAltKeyHeld: () => boolean;
  initialViewport?: { offset: { x: number; y: number }; scale: number };
}

export function useCanvasRenderer(opts: UseCanvasRendererOpts) {
  const rendererRef = useRef<Canvas2DRenderer | null>(null);
  const viewportRef = useRef<ViewportImpl | null>(null);
  const rafRef = useRef<number>(0);

  const initCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    rendererRef.current = new Canvas2DRenderer(ctx);
  }, []);

  const updateSize = useCallback((width: number, height: number) => {
    const prev = viewportRef.current;
    const offset = prev?.offset ?? opts.initialViewport?.offset;
    const scale = prev?.scale ?? opts.initialViewport?.scale;
    viewportRef.current = new ViewportImpl(width, height, offset, scale);
  }, [opts.initialViewport]);

  const startLoop = useCallback(() => {
    const loop = () => {
      const renderer = rendererRef.current;
      const viewport = viewportRef.current;
      if (renderer && viewport) {
        const ctx: RenderContext = {
          renderer,
          viewport,
          document: opts.getDocument(),
          selectedEntityIds: opts.getSelectedEntityIds(),
          selectedPoints: opts.getSelectedPoints(),
          activeTool: opts.getActiveTool(),
          altKeyHeld: opts.getAltKeyHeld(),
          palette: useThemeStore.getState().palette,
        };
        try {
          renderFrame(ctx);
        } catch (err) {
          console.error('Render error:', err);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [opts]);

  const stopLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
  }, []);

  return { initCanvas, updateSize, startLoop, stopLoop, viewportRef };
}
