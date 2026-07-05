import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { buildApi } from '@/api/client';
import { persistModelCode } from '@/api/autoSave';
import { createViewer, type Viewer } from '@/build/webglViewer';
import { downloadTextFile } from '@/export/download';

interface Props { onClose: () => void }

// A starter model so an empty document shows something buildable. The whole CAD
// vocabulary is build123d's — this is just a seed to edit / for the AI to replace.
const STARTER = `# build123d — the model is this script. \`part\` is what gets built.
P = dict(plate=60, thick=6, boss_d=24, boss_h=24, bore_d=14, bolt_d=5)

part = Pos(0, 0, P["thick"]/2) * Box(P["plate"], P["plate"], P["thick"])

# a socket (tube) standing on the plate
zc = P["thick"] + P["boss_h"]/2
part += Pos(0, 0, zc) * (Cylinder(P["boss_d"]/2, P["boss_h"])
                         - Cylinder(P["bore_d"]/2, P["boss_h"]))

# retaining cross-hole through the socket wall
part -= Pos(0, 0, zc) * Rot(90, 0, 0) * Cylinder(P["bolt_d"]/2, P["boss_d"]*2)
`;

export function ScriptViewer({ onClose }: Props) {
  const palette = useThemeStore((s) => s.palette);
  const docName = useDocumentStore((s) => s.document.name);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);

  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [stats, setStats] = useState('');
  const stepRef = useRef<string>('');

  const build = async (src: string) => {
    if (!viewerRef.current) return;
    setStatus('building');
    setMessage('');
    try {
      const res = await buildApi.run(src);
      viewerRef.current.update(res.mesh);
      stepRef.current = res.step;
      const m = res.metrics;
      const sz = [0, 1, 2].map((i) => Math.round(m.bbox_max[i]! - m.bbox_min[i]!));
      setStats(`vol ${Math.round(m.volume).toLocaleString()} mm³ · ${sz[0]}×${sz[1]}×${sz[2]} mm · ${res.mesh.triangle_count.toLocaleString()} triangles`);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  };

  // mount: create viewer, seed code from the document (or the starter), build once
  useEffect(() => {
    const saved = useDocumentStore.getState().document.modelCode;
    const initial = saved && saved.trim() ? saved : STARTER;
    setCode(initial);
    if (canvasRef.current) {
      try {
        viewerRef.current = createViewer(canvasRef.current);
        build(initial);
      } catch (err) {
        setStatus('error');
        setMessage(String(err instanceof Error ? err.message : err));
      }
    }
    return () => { viewerRef.current?.dispose(); viewerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rebuild = () => { persistModelCode(code); build(code); };
  const downloadStep = () => {
    if (status === 'done' && stepRef.current) downloadTextFile(stepRef.current, `${docName}.step`, 'application/step');
  };

  const btn: CSSProperties = {
    padding: '5px 14px', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}
         onClick={onClose}>
      <div style={{ background: palette.panelBg, border: `1px solid ${palette.border}`,
                    borderRadius: '8px', width: '88%', maxWidth: '1100px', height: '84vh',
                    display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
           onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
                      borderBottom: `1px solid ${palette.border}` }}>
          <h2 style={{ margin: 0, fontSize: '15px', color: palette.text }}>
            Model <span style={{ color: palette.textSecondary, fontSize: '12px' }}>(build123d · script)</span>
          </h2>
          <div style={{ flex: 1 }} />
          <button onClick={rebuild} disabled={status === 'building'}
            style={{ ...btn, background: palette.primaryBtn, color: '#fff', opacity: status === 'building' ? 0.6 : 1 }}>
            {status === 'building' ? 'Building…' : 'Build'}
          </button>
          <button onClick={downloadStep} disabled={status !== 'done'}
            style={{ ...btn, background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, opacity: status === 'done' ? 1 : 0.5,
                     cursor: status === 'done' ? 'pointer' : 'default' }}>STEP</button>
          <button onClick={onClose} style={{ background: 'none', border: 'none',
                   color: palette.textSecondary, fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>&times;</button>
        </div>

        {/* body: code editor + viewport */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); rebuild(); } }}
            spellCheck={false}
            style={{ width: '46%', resize: 'none', padding: '12px 14px', border: 'none',
                     borderRight: `1px solid ${palette.border}`, background: palette.inputBg,
                     color: palette.text, fontSize: '13px', lineHeight: 1.5, outline: 'none',
                     fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', tabSize: 4 }}
          />
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block',
                     cursor: 'grab', touchAction: 'none' }} />
            {status === 'error' && (
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '45%',
                            overflow: 'auto', padding: '12px 14px', background: 'rgba(0,0,0,0.35)',
                            color: palette.danger, fontSize: '12px', whiteSpace: 'pre-wrap',
                            fontFamily: 'ui-monospace, Menlo, monospace' }}>
                {message || 'Build failed'}
              </div>
            )}
          </div>
        </div>

        {/* footer */}
        <div style={{ padding: '8px 16px', borderTop: `1px solid ${palette.border}`,
                      fontSize: '12px', color: palette.textSecondary, minHeight: '20px' }}>
          {status === 'done' && `${stats} · drag to orbit · scroll to zoom · Ctrl/⌘+Enter to build`}
          {status === 'building' && 'Building…'}
          {status === 'error' && <span style={{ color: palette.danger }}>Build failed — see the editor side.</span>}
        </div>
      </div>
    </div>
  );
}
