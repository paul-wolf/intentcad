import { useRef, useEffect } from 'react';
import { useThemeStore } from '@/theme';
import { useCamStore } from '@/stores/camStore';

interface GcodePreviewProps {
  gcode: string;
  onClose: () => void;
}

export function GcodePreview({ gcode, onClose }: GcodePreviewProps) {
  const palette = useThemeStore((s) => s.palette);
  const simState = useCamStore((s) => s.simState);
  const simMoveIndex = useCamStore((s) => s.simMoveIndex);
  const simGcodeLineMap = useCamStore((s) => s.simGcodeLineMap);

  const lines = gcode.split('\n');
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // Current highlighted gcode line index
  const highlightedLine = simState !== 'idle' && simGcodeLineMap.length > simMoveIndex
    ? simGcodeLineMap[simMoveIndex]!
    : -1;

  // Auto-scroll to highlighted line
  useEffect(() => {
    if (highlightRef.current && containerRef.current) {
      highlightRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [highlightedLine]);

  const handleCopy = () => {
    navigator.clipboard.writeText(gcode);
  };

  return (
    <div style={{
      padding: '8px 10px',
      borderBottom: `1px solid ${palette.border}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <span style={{ fontSize: '11px', color: palette.textMuted }}>{lines.length} lines</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={handleCopy}
            style={{
              padding: '2px 8px',
              border: `1px solid ${palette.inputBorder}`,
              borderRadius: '3px',
              background: palette.buttonBg,
              color: palette.text,
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Copy
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '2px 8px',
              border: `1px solid ${palette.inputBorder}`,
              borderRadius: '3px',
              background: palette.buttonBg,
              color: palette.text,
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Close
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        style={{
          maxHeight: '300px',
          overflowY: 'auto',
          fontSize: '10px',
          lineHeight: 1.4,
          fontFamily: 'monospace',
          color: palette.text,
          background: palette.inputBg,
          border: `1px solid ${palette.border}`,
          borderRadius: '3px',
          padding: '2px 0',
          margin: 0,
        }}
      >
        {lines.map((line, i) => {
          const isHighlighted = i === highlightedLine;
          return (
            <div
              key={i}
              ref={isHighlighted ? highlightRef : undefined}
              style={{
                padding: '0 6px',
                background: isHighlighted ? '#ff8c0030' : undefined,
                whiteSpace: 'pre',
              }}
            >
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}
