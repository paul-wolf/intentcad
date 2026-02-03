import { useState, useEffect, useRef } from 'react';
import { useThemeStore } from '@/theme';

interface NumberInputProps {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  label?: string;
  precision?: number;
}

export function NumberInput({ value, onChange, disabled, label, precision = 2 }: NumberInputProps) {
  const palette = useThemeStore((s) => s.palette);
  const [text, setText] = useState(() => value.toFixed(precision));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setText(value.toFixed(precision));
    }
  }, [value, precision]);

  const commit = () => {
    const parsed = parseFloat(text);
    if (!isNaN(parsed) && isFinite(parsed)) {
      onChange(parsed);
    } else {
      setText(value.toFixed(precision));
    }
  };

  const revert = () => {
    setText(value.toFixed(precision));
    inputRef.current?.blur();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      {label && (
        <label style={{ fontSize: '11px', color: palette.textMuted, width: '14px', flexShrink: 0 }}>
          {label}
        </label>
      )}
      <input
        ref={inputRef}
        style={{
          flex: 1,
          minWidth: 0,
          background: disabled ? 'transparent' : palette.inputBg,
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '2px',
          color: disabled ? palette.textMuted : palette.text,
          fontSize: '12px',
          padding: '2px 4px',
          outline: 'none',
          opacity: disabled ? 0.6 : 1,
        }}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            commit();
            inputRef.current?.blur();
          }
          if (e.key === 'Escape') {
            revert();
          }
        }}
      />
    </div>
  );
}
