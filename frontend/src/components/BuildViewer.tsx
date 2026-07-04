import { useEffect, useRef, useState, useCallback } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { buildApi, type BuildResponse } from '@/api/client';
import { sketchToBuildRequest } from '@/build/toBuildRequest';
import { createViewer, type Viewer } from '@/build/webglViewer';
import { downloadTextFile } from '@/export/download';

interface BuildViewerProps {
  onClose: () => void;
}

export function BuildViewer({ onClose }: BuildViewerProps) {
  const palette = useThemeStore((s) => s.palette);
  const sketch = useDocumentStore((s) => s.getActiveSketch());
  const docName = useDocumentStore((s) => s.document.name);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [distance, setDistance] = useState(10);
  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<BuildResponse | null>(null);

  const runBuild = useCallback(async () => {
    if (!sketch) { setStatus('error'); setMessage('No active sketch'); return; }
    setStatus('building');
    setMessage('');
    try {
      const res = await buildApi.build(sketchToBuildRequest(sketch, distance));
      setResult(res);
      viewerRef.current?.update(res.mesh);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  }, [sketch, distance]);

  // Create the viewer once the canvas is mounted, then kick off the first build.
  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      viewerRef.current = createViewer(canvasRef.current);
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
      return;
    }
    runBuild();
    return () => { viewerRef.current?.dispose(); viewerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const downloadStep = () => {
    if (!result) return;
    downloadTextFile(result.step, `${docName}.step`, 'application/step');
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
               justifyContent: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{ background: palette.panelBg, border: `1px solid ${palette.border}`,
                 borderRadius: '8px', width: '80%', maxWidth: '900px', height: '80vh',
                 display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header / controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
                      borderBottom: `1px solid ${palette.border}` }}>
          <h2 style={{ margin: 0, fontSize: '15px', color: palette.text }}>
            3D Build <span style={{ color: palette.textSecondary, fontSize: '12px' }}>(server · experimental)</span>
          </h2>
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: '13px', color: palette.textSecondary }}>Distance</label>
          <input
            type="number" value={distance} min={0.1} step={1}
            onChange={(e) => setDistance(Number(e.target.value) || 0)}
            style={{ width: '70px', padding: '4px 6px', background: palette.inputBg,
                     border: `1px solid ${palette.inputBorder}`, borderRadius: '4px',
                     color: palette.text, fontSize: '13px' }}
          />
          <button
            onClick={runBuild}
            disabled={status === 'building'}
            style={{ padding: '5px 14px', background: palette.primaryBtn, color: '#fff',
                     border: 'none', borderRadius: '4px', fontSize: '13px',
                     cursor: status === 'building' ? 'default' : 'pointer', opacity: status === 'building' ? 0.6 : 1 }}
          >
            {status === 'building' ? 'Building…' : 'Build'}
          </button>
          <button
            onClick={downloadStep}
            disabled={!result}
            style={{ padding: '5px 14px', background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '13px',
                     cursor: result ? 'pointer' : 'default', opacity: result ? 1 : 0.5 }}
          >
            STEP
          </button>
          <button onClick={onClose} style={{ background: 'none', border: 'none',
                   color: palette.textSecondary, fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>
            &times;
          </button>
        </div>

        {/* viewport */}
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block',
                   cursor: 'grab', touchAction: 'none' }} />
          {status === 'error' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                          justifyContent: 'center', padding: '24px', textAlign: 'center',
                          color: palette.danger, fontSize: '13px' }}>
              {message || 'Build failed'}
            </div>
          )}
        </div>

        {/* footer: stats + warnings */}
        <div style={{ padding: '8px 16px', borderTop: `1px solid ${palette.border}`,
                      fontSize: '12px', color: palette.textSecondary, minHeight: '20px' }}>
          {status === 'done' && result && (
            <span>
              {result.mesh.triangle_count.toLocaleString()} triangles · drag to orbit · scroll to zoom
              {result.warnings.length > 0 && (
                <span style={{ color: palette.warning ?? '#c78a1a' }}>
                  {'  ·  '}{result.warnings.length} warning(s): {result.warnings.join('; ')}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
