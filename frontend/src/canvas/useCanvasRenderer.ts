import { useRef, useCallback } from 'react';
import { Canvas2DRenderer } from '@/rendering/canvas2d';
import { ViewportImpl } from '@/rendering/viewport';
import { renderFrame } from '@/rendering/pipeline';
import type { RenderContext } from '@/rendering/pipeline';
import type { Tool } from '@/tools/types';
import type { Document } from '@/types/document';
import { useThemeStore } from '@/theme';

interface UseCanvasRendererOpts {
  getDocument: () => Document;
  getSelectedEntityIds: () => Set<string>;
  getActiveTool: () => Tool | null;
  getAltKeyHeld: () => boolean;
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
    const prevOffset = viewportRef.current?.offset;
    viewportRef.current = new ViewportImpl(width, height, prevOffset);
  }, []);

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
          activeTool: opts.getActiveTool(),
          altKeyHeld: opts.getAltKeyHeld(),
          palette: useThemeStore.getState().palette,
        };
        renderFrame(ctx);
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
