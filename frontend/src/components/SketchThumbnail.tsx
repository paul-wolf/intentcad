import { useRef, useEffect } from 'react';
import type { Sketch } from '@/types/document';
import { renderSketchThumbnail } from '@/rendering/thumbnail';

interface SketchThumbnailProps {
  sketch: Sketch;
  width: number;
  height: number;
  background?: string;
  stroke?: string;
  onClick?: () => void;
  selected?: boolean;
  label?: string;
}

export function SketchThumbnail({ sketch, width, height, background, stroke, onClick, selected, label }: SketchThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderSketchThumbnail(canvas, sketch, {
      width,
      height,
      background,
      stroke,
      lineWidth: 1.5,
      padding: 10,
    });
  }, [sketch, width, height, background, stroke]);

  return (
    <div
      onClick={onClick}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        cursor: onClick ? 'pointer' : 'default',
        borderRadius: '4px',
        border: selected ? '2px solid #60a5fa' : '2px solid transparent',
        flexShrink: 0,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width, height, borderRadius: '3px' }}
      />
      {label && (
        <span style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
          {label}
        </span>
      )}
    </div>
  );
}
