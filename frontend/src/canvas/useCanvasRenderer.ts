import { useRef, useCallback } from 'react';
import { Canvas2DRenderer } from '@/rendering/canvas2d';
import { ViewportImpl } from '@/rendering/viewport';
import { renderFrame } from '@/rendering/pipeline';
import type { RenderContext } from '@/rendering/pipeline';
import type { Tool } from '@/tools/types';
import type { Document } from '@/types/document';
import type { SelectedPoint } from '@/stores/editorStore';
import type { SegmentHit } from '@/hittest/hitTest';
import { useThemeStore } from '@/theme';
import { useCamStore } from '@/stores/camStore';

interface UseCanvasRendererOpts {
  getDocument: () => Document;
  getSelectedEntityIds: () => Set<string>;
  getSelectedPoints: () => SelectedPoint[];
  getSelectedSegments: () => SegmentHit[];
  getActiveTool: () => Tool | null;
  getAltKeyHeld: () => boolean;
  initialViewport?: { offset: { x: number; y: number }; scale: number };
  /** Per-frame display options (read every frame). */
  getRenderOptions?: () => Pick<RenderContext, 'transparent' | 'showGrid' | 'soloActiveSketch'>;
  /** Called after every frame is drawn, with the viewport it was drawn with. */
  onFrame?: (viewport: ViewportImpl) => void;
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

  const lastTimeRef = useRef<number>(0);

  const startLoop = useCallback(() => {
    lastTimeRef.current = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = now - lastTimeRef.current;
      lastTimeRef.current = now;

      // Tick simulator
      const camState = useCamStore.getState();
      if (camState.simState === 'playing') {
        camState.simTick(dt);
      }

      const renderer = rendererRef.current;
      const viewport = viewportRef.current;
      if (renderer && viewport) {
        const ctx: RenderContext = {
          renderer,
          viewport,
          document: opts.getDocument(),
          selectedEntityIds: opts.getSelectedEntityIds(),
          selectedPoints: opts.getSelectedPoints(),
          selectedSegments: opts.getSelectedSegments(),
          activeTool: opts.getActiveTool(),
          altKeyHeld: opts.getAltKeyHeld(),
          palette: useThemeStore.getState().palette,
          camMode: useCamStore.getState().camPanelOpen,
          ...opts.getRenderOptions?.(),
        };
        try {
          renderFrame(ctx);
        } catch (err) {
          console.error('Render error:', err);
        }
        opts.onFrame?.(viewport);
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
