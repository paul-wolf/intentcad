import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { buildApi, type BuildResponse } from '@/api/client';
import { sketchToBuildRequest, axisForKind, AXIS_LABELS, type BuildOp, type AxisKind } from '@/build/toBuildRequest';
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
  const [operation, setOperation] = useState<'extrude' | 'revolve'>('extrude');
  const [distance, setDistance] = useState(10);
  const [angle, setAngle] = useState(360);
  const [axisKind, setAxisKind] = useState<AxisKind>('left');
  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<BuildResponse | null>(null);

  const runBuild = useCallback(async () => {
    if (!sketch) { setStatus('error'); setMessage('No active sketch'); return; }
    setStatus('building');
    setMessage('');
    const op: BuildOp =
      operation === 'extrude'
        ? { kind: 'extrude', distance }
        : { kind: 'revolve', angle, axis: axisForKind(sketch, axisKind) };
    try {
      const res = await buildApi.build(sketchToBuildRequest(sketch, op));
      setResult(res);
      viewerRef.current?.update(res.mesh);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  }, [sketch, operation, distance, angle, axisKind]);

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

  const lblStyle: CSSProperties = { fontSize: '13px', color: palette.textSecondary };
  const fieldStyle: CSSProperties = {
    padding: '4px 6px', background: palette.inputBg, border: `1px solid ${palette.inputBorder}`,
    borderRadius: '4px', color: palette.text, fontSize: '13px',
  };
  const numStyle: CSSProperties = { ...fieldStyle, width: '64px' };

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
          <select
            value={operation}
            onChange={(e) => setOperation(e.target.value as 'extrude' | 'revolve')}
            style={fieldStyle}
          >
            <option value="extrude">Extrude</option>
            <option value="revolve">Revolve</option>
          </select>
          {operation === 'extrude' ? (
            <>
              <label style={lblStyle}>Distance</label>
              <input
                type="number" value={distance} min={0.1} step={1}
                onChange={(e) => setDistance(Number(e.target.value) || 0)}
                style={numStyle}
              />
            </>
          ) : (
            <>
              <label style={lblStyle}>Axis</label>
              <select
                value={axisKind}
                onChange={(e) => setAxisKind(e.target.value as AxisKind)}
                style={fieldStyle}
              >
                {(Object.keys(AXIS_LABELS) as AxisKind[]).map((k) => (
                  <option key={k} value={k}>{AXIS_LABELS[k]}</option>
                ))}
              </select>
              <label style={lblStyle}>Angle°</label>
              <input
                type="number" value={angle} min={1} max={360} step={5}
                onChange={(e) => setAngle(Number(e.target.value) || 0)}
                style={numStyle}
              />
            </>
          )}
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
          {operation === 'revolve' && status !== 'done' && (
            <span>Revolve spins the profile around the <b>{AXIS_LABELS[axisKind]}</b> — the profile must sit entirely on one side of it. Edge axes (left/right/top/bottom) always satisfy that.</span>
          )}
          {status === 'done' && result && (
            <span>
              {(() => {
                const m = result.metrics;
                const size = [0, 1, 2].map((i) => Math.round(m.bbox_max[i]! - m.bbox_min[i]!));
                return `vol ${Math.round(m.volume).toLocaleString()} mm³ · ${size[0]}×${size[1]}×${size[2]} mm · `;
              })()}
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
