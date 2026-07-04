import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { buildApi, type BuildResponse, type BuildFeature } from '@/api/client';
import { treeToBuildRequest, axisForKind, AXIS_LABELS, type AxisKind } from '@/build/toBuildRequest';
import { createViewer, type Viewer } from '@/build/webglViewer';
import { downloadTextFile } from '@/export/download';

interface BuildViewerProps {
  onClose: () => void;
}

type OpType = 'extrude' | 'revolve' | 'fillet' | 'chamfer';

function describe(f: BuildFeature): string {
  switch (f.type) {
    case 'extrude':
      return `Extrude ${f.sketchId}${f.operation === 'remove' ? ' (cut)' : ''} · d=${f.distance}`;
    case 'revolve':
      return `Revolve ${f.sketchId} · ${f.angle}°`;
    case 'fillet':
      return `Fillet ${f.edges} · r=${f.radius}`;
    case 'chamfer':
      return `Chamfer ${f.edges} · d=${f.distance}`;
  }
}

export function BuildViewer({ onClose }: BuildViewerProps) {
  const palette = useThemeStore((s) => s.palette);
  const sketches = useDocumentStore((s) => s.document.sketches);
  const activeSketchId = useDocumentStore((s) => s.document.activeSketchId);
  const docName = useDocumentStore((s) => s.document.name);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const nextId = useRef(1);

  // the feature tree — seeded with a plain extrude of the active sketch
  const [features, setFeatures] = useState<BuildFeature[]>(() =>
    activeSketchId ? [{ id: 'op-0', type: 'extrude', sketchId: activeSketchId, distance: 10, operation: 'add' }] : [],
  );

  // add-operation form state
  const [opType, setOpType] = useState<OpType>('extrude');
  const [opSketchId, setOpSketchId] = useState(activeSketchId);
  const [opCut, setOpCut] = useState(false);
  const [distance, setDistance] = useState(10);
  const [angle, setAngle] = useState(360);
  const [axisKind, setAxisKind] = useState<AxisKind>('left');
  const [edges, setEdges] = useState('all');
  const [size, setSize] = useState(2);

  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<BuildResponse | null>(null);

  const rebuild = useCallback(async () => {
    if (!viewerRef.current) return;
    const sk = useDocumentStore.getState().document.sketches;
    if (features.length === 0) { setResult(null); setStatus('idle'); return; }
    setStatus('building');
    setMessage('');
    try {
      const res = await buildApi.build(treeToBuildRequest(sk, features));
      setResult(res);
      viewerRef.current.update(res.mesh);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  }, [features]);

  // create the viewer once the canvas mounts
  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      viewerRef.current = createViewer(canvasRef.current);
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
      return;
    }
    return () => { viewerRef.current?.dispose(); viewerRef.current = null; };
  }, []);

  // rebuild whenever the tree changes (and once after the viewer exists)
  useEffect(() => { rebuild(); }, [rebuild]);

  const addFeature = () => {
    const id = `op-${nextId.current++}`;
    let feat: BuildFeature;
    if (opType === 'extrude') {
      feat = { id, type: 'extrude', sketchId: opSketchId, distance, operation: opCut ? 'remove' : 'add' };
    } else if (opType === 'revolve') {
      const sk = sketches.find((s) => s.id === opSketchId);
      feat = { id, type: 'revolve', sketchId: opSketchId, angle, operation: 'add',
               axis: sk ? axisForKind(sk, axisKind) : { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } } };
    } else if (opType === 'fillet') {
      feat = { id, type: 'fillet', sketchId: '', edges, radius: size };
    } else {
      feat = { id, type: 'chamfer', sketchId: '', edges, distance: size };
    }
    setFeatures((prev) => [...prev, feat]);
  };

  const removeFeature = (id: string) => setFeatures((prev) => prev.filter((f) => f.id !== id));

  const downloadStep = () => {
    if (result) downloadTextFile(result.step, `${docName}.step`, 'application/step');
  };

  const lbl: CSSProperties = { fontSize: '12px', color: palette.textSecondary };
  const field: CSSProperties = {
    padding: '4px 6px', background: palette.inputBg, border: `1px solid ${palette.inputBorder}`,
    borderRadius: '4px', color: palette.text, fontSize: '13px', width: '100%', boxSizing: 'border-box',
  };
  const row: CSSProperties = { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' };
  const isModify = opType === 'fillet' || opType === 'chamfer';

  return (
    <div
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
               justifyContent: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{ background: palette.panelBg, border: `1px solid ${palette.border}`,
                 borderRadius: '8px', width: '86%', maxWidth: '1000px', height: '82vh',
                 display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
                      borderBottom: `1px solid ${palette.border}` }}>
          <h2 style={{ margin: 0, fontSize: '15px', color: palette.text }}>
            3D Build <span style={{ color: palette.textSecondary, fontSize: '12px' }}>(server · experimental)</span>
          </h2>
          <div style={{ flex: 1 }} />
          <button onClick={rebuild} disabled={status === 'building'}
            style={{ padding: '5px 14px', background: palette.primaryBtn, color: '#fff', border: 'none',
                     borderRadius: '4px', fontSize: '13px', cursor: 'pointer', opacity: status === 'building' ? 0.6 : 1 }}>
            {status === 'building' ? 'Building…' : 'Rebuild'}
          </button>
          <button onClick={downloadStep} disabled={!result}
            style={{ padding: '5px 14px', background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '13px',
                     cursor: result ? 'pointer' : 'default', opacity: result ? 1 : 0.5 }}>
            STEP
          </button>
          <button onClick={onClose} style={{ background: 'none', border: 'none',
                   color: palette.textSecondary, fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>
            &times;
          </button>
        </div>

        {/* body: sidebar (tree) + viewport */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* sidebar */}
          <div style={{ width: '270px', borderRight: `1px solid ${palette.border}`, padding: '12px 14px',
                        overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase',
                          color: palette.textSecondary, marginBottom: '6px' }}>Add operation</div>

            <div style={row}>
              <select value={opType} onChange={(e) => setOpType(e.target.value as OpType)} style={field}>
                <option value="extrude">Extrude</option>
                <option value="revolve">Revolve</option>
                <option value="fillet">Fillet</option>
                <option value="chamfer">Chamfer</option>
              </select>
            </div>

            {!isModify && (
              <div style={row}>
                <label style={{ ...lbl, width: '48px' }}>Sketch</label>
                <select value={opSketchId} onChange={(e) => setOpSketchId(e.target.value)} style={field}>
                  {sketches.map((sk) => <option key={sk.id} value={sk.id}>{sk.name}</option>)}
                </select>
              </div>
            )}

            {opType === 'extrude' && (
              <>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>Dist</label>
                  <input type="number" value={distance} step={1}
                         onChange={(e) => setDistance(Number(e.target.value) || 0)} style={field} />
                </div>
                <label style={{ ...lbl, display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
                  <input type="checkbox" checked={opCut} onChange={(e) => setOpCut(e.target.checked)} />
                  Cut (remove material)
                </label>
              </>
            )}

            {opType === 'revolve' && (
              <>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>Axis</label>
                  <select value={axisKind} onChange={(e) => setAxisKind(e.target.value as AxisKind)} style={field}>
                    {(Object.keys(AXIS_LABELS) as AxisKind[]).map((k) => (
                      <option key={k} value={k}>{AXIS_LABELS[k]}</option>
                    ))}
                  </select>
                </div>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>Angle°</label>
                  <input type="number" value={angle} min={1} max={360} step={5}
                         onChange={(e) => setAngle(Number(e.target.value) || 0)} style={field} />
                </div>
              </>
            )}

            {isModify && (
              <>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>Edges</label>
                  <input value={edges} onChange={(e) => setEdges(e.target.value)}
                         placeholder="all | kind:circle | longest" style={field} />
                </div>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>{opType === 'fillet' ? 'Radius' : 'Size'}</label>
                  <input type="number" value={size} min={0.1} step={0.5}
                         onChange={(e) => setSize(Number(e.target.value) || 0)} style={field} />
                </div>
              </>
            )}

            <button onClick={addFeature}
              style={{ padding: '6px', background: palette.panelBg, color: palette.text,
                       border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '13px',
                       cursor: 'pointer', marginBottom: '14px' }}>
              + Add to tree
            </button>

            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase',
                          color: palette.textSecondary, marginBottom: '6px' }}>
              Features ({features.length})
            </div>
            {features.map((f, i) => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 7px',
                                       background: palette.inputBg, borderRadius: '4px', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: palette.textSecondary, width: '16px' }}>{i + 1}</span>
                <span style={{ flex: 1, fontSize: '12px', color: palette.text, whiteSpace: 'nowrap',
                               overflow: 'hidden', textOverflow: 'ellipsis' }}>{describe(f)}</span>
                <button onClick={() => removeFeature(f.id)} title="Remove"
                  style={{ background: 'none', border: 'none', color: palette.danger, cursor: 'pointer',
                           fontSize: '15px', lineHeight: 1, padding: '0 2px' }}>&times;</button>
              </div>
            ))}
            {features.length === 0 && (
              <div style={{ fontSize: '12px', color: palette.textSecondary }}>No operations yet.</div>
            )}
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
        </div>

        {/* footer: stats + warnings */}
        <div style={{ padding: '8px 16px', borderTop: `1px solid ${palette.border}`,
                      fontSize: '12px', color: palette.textSecondary, minHeight: '20px' }}>
          {status === 'done' && result && (
            <span>
              {(() => {
                const m = result.metrics;
                const sz = [0, 1, 2].map((i) => Math.round(m.bbox_max[i]! - m.bbox_min[i]!));
                const counts: Record<string, number> = {};
                for (const f of result.faces) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
                const faceStr = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
                return `vol ${Math.round(m.volume).toLocaleString()} mm³ · ${sz[0]}×${sz[1]}×${sz[2]} mm · ${result.faces.length} faces (${faceStr}), ${result.edges.length} edges · `;
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
