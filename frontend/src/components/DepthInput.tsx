import { useState, type CSSProperties } from 'react';
import { depthEdit } from '@/build/faceSketch';

/** An extrude depth field: always shows a positive depth. Typing below 0 turns
 *  Flip direction on instead; a half-typed "-" stays in the field until it is
 *  a number. */
export function DepthInput({ depth, flip, both, disabled, autoFocus, style, onChange }: {
  depth: number; flip: boolean; both: boolean; disabled?: boolean; autoFocus?: boolean; style?: CSSProperties;
  onChange: (v: { depth: number; flip: boolean }) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input type="number" step={0.5} value={draft ?? depth} disabled={disabled} autoFocus={autoFocus}
           title="Below 0 turns Flip direction on: the depth stays positive"
           onChange={(e) => {
             const r = depthEdit(e.target.value, flip, both);
             if ('draft' in r) setDraft(r.draft);
             else { setDraft(null); onChange(r); }
           }}
           onBlur={() => setDraft(null)} style={style} />
  );
}
