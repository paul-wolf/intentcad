import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { useBuildStore } from '@/stores/buildStore';
import { buildApi, type BuildResponse, type BuildFeature } from '@/api/client';
import { treeToBuildRequest, axisForKind, AXIS_LABELS, type AxisKind } from '@/build/toBuildRequest';
import { createViewer, type Viewer } from '@/build/webglViewer';
import { downloadTextFile } from '@/export/download';

interface BuildViewerProps {
  onClose: () => void;
}

type OpType = 'extrude' | 'revolve' | 'fillet' | 'chamfer';

const newId = () => 'op-' + crypto.randomUUID().slice(0, 8);

function place(f: BuildFeature): string {
  const bits: string[] = [];
  if (f.plane && f.plane !== 'XY') bits.push(f.plane);
  if (f.tilt) bits.push(`tilt ${f.tilt}°${f.tiltAxis ?? 'X'}`);
  if (f.offset && (f.offset[0] || f.offset[1] || f.offset[2])) bits.push(`@[${f.offset.join(',')}]`);
  return bits.length ? ` · ${bits.join(' ')}` : '';
}

function describe(f: BuildFeature): string {
  switch (f.type) {
    case 'extrude':
      return `Extrude ${f.sketchId}${f.operation === 'remove' ? ' (cut)' : ''} · d=${f.distance}${place(f)}`;
    case 'revolve':
      return `Revolve ${f.sketchId} · ${f.angle}°${place(f)}`;
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

  // the feature tree persists in a store, so closing/reopening keeps the part
  const features = useBuildStore((s) => s.features);
  const setFeatures = useBuildStore((s) => s.setFeatures);
  const canUndo = useBuildStore((s) => s.past.length > 0);
  const canRedo = useBuildStore((s) => s.future.length > 0);

  // add-operation form state
  const [opType, setOpType] = useState<OpType>('extrude');
  const [opSketchId, setOpSketchId] = useState(activeSketchId);
  const [opCut, setOpCut] = useState(false);
  const [distance, setDistance] = useState(10);
  const [angle, setAngle] = useState(360);
  const [axisKind, setAxisKind] = useState<AxisKind>('left');
  const [edges, setEdges] = useState('all');
  const [size, setSize] = useState(2);
  // placement (for extrude/revolve)
  const [opPlane, setOpPlane] = useState<'XY' | 'XZ' | 'YZ'>('XY');
  const [opTilt, setOpTilt] = useState(0);
  const [opTiltAxis, setOpTiltAxis] = useState<'X' | 'Y' | 'Z'>('X');
  const [ox, setOx] = useState(0);
  const [oy, setOy] = useState(0);
  const [oz, setOz] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [upto, setUpto] = useState<number>(Infinity); // rollback marker: build features[0..upto]

  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<BuildResponse | null>(null);

  const rebuild = useCallback(async () => {
    if (!viewerRef.current) return;
    const sk = useDocumentStore.getState().document.sketches;
    const built = upto === Infinity ? features : features.slice(0, upto + 1);
    if (built.length === 0) { setResult(null); setStatus('idle'); return; }
    setStatus('building');
    setMessage('');
    try {
      const res = await buildApi.build(treeToBuildRequest(sk, built));
      setResult(res);
      viewerRef.current.update(res.mesh);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  }, [features, upto]);

  // create the viewer, claim the keyboard, and seed an empty tree — once on mount
  useEffect(() => {
    useBuildStore.getState().setPanelOpen(true);
    if (useBuildStore.getState().features.length === 0 && activeSketchId) {
      useBuildStore.getState().initTree([{ id: newId(), type: 'extrude', sketchId: activeSketchId, distance: 10, operation: 'add' }]);
    }
    if (canvasRef.current) {
      try {
        viewerRef.current = createViewer(canvasRef.current);
      } catch (err) {
        setStatus('error');
        setMessage(String(err instanceof Error ? err.message : err));
      }
    }
    return () => {
      useBuildStore.getState().setPanelOpen(false);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // rebuild whenever the tree changes (and once after the viewer exists)
  useEffect(() => { rebuild(); }, [rebuild]);

  // Ctrl-Z / Ctrl-Shift-Z (Ctrl-Y) undo/redo the tree while the panel is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (!ctrl || (k !== 'z' && k !== 'y')) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) useBuildStore.getState().redo();
      else useBuildStore.getState().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const placement = (): Partial<BuildFeature> => {
    const p: Partial<BuildFeature> = {};
    if (opPlane !== 'XY') p.plane = opPlane;
    if (opTilt) { p.tilt = opTilt; p.tiltAxis = opTiltAxis; }
    if (ox || oy || oz) p.offset = [ox, oy, oz];
    return p;
  };

  // load an existing feature's params into the form for editing
  const loadFeature = (f: BuildFeature) => {
    setEditingId(f.id);
    setOpType(f.type);
    if (f.sketchId) setOpSketchId(f.sketchId);
    if (f.type === 'extrude') { setDistance(f.distance ?? 10); setOpCut(f.operation === 'remove'); }
    if (f.type === 'revolve') setAngle(f.angle ?? 360);
    if (f.type === 'fillet') { setEdges(f.edges ?? 'all'); setSize(f.radius ?? 2); }
    if (f.type === 'chamfer') { setEdges(f.edges ?? 'all'); setSize(f.distance ?? 2); }
    setOpPlane(f.plane ?? 'XY');
    setOpTilt(f.tilt ?? 0);
    setOpTiltAxis(f.tiltAxis ?? 'X');
    setOx(f.offset?.[0] ?? 0); setOy(f.offset?.[1] ?? 0); setOz(f.offset?.[2] ?? 0);
  };

  const addFeature = () => {
    const id = editingId ?? newId();
    let feat: BuildFeature;
    if (opType === 'extrude') {
      feat = { id, type: 'extrude', sketchId: opSketchId, distance, operation: opCut ? 'remove' : 'add', ...placement() };
    } else if (opType === 'revolve') {
      const sk = sketches.find((s) => s.id === opSketchId);
      feat = { id, type: 'revolve', sketchId: opSketchId, angle, operation: 'add',
               axis: sk ? axisForKind(sk, axisKind) : { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } }, ...placement() };
    } else if (opType === 'fillet') {
      feat = { id, type: 'fillet', sketchId: '', edges, radius: size };
    } else {
      feat = { id, type: 'chamfer', sketchId: '', edges, distance: size };
    }
    setFeatures(editingId ? features.map((f) => (f.id === editingId ? feat : f)) : [...features, feat]);
    setEditingId(null);
    setUpto(Infinity); // show the full build after an add/update
  };

  const removeFeature = (id: string) => {
    if (editingId === id) setEditingId(null);
    setFeatures(features.filter((f) => f.id !== id));
  };

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
          <button onClick={() => useBuildStore.getState().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)"
            style={{ padding: '5px 10px', background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '14px',
                     cursor: canUndo ? 'pointer' : 'default', opacity: canUndo ? 1 : 0.4 }}>↶</button>
          <button onClick={() => useBuildStore.getState().redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"
            style={{ padding: '5px 10px', background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '14px',
                     cursor: canRedo ? 'pointer' : 'default', opacity: canRedo ? 1 : 0.4 }}>↷</button>
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

            {!isModify && (
              <>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>Plane</label>
                  <select value={opPlane} onChange={(e) => setOpPlane(e.target.value as 'XY' | 'XZ' | 'YZ')} style={field}>
                    <option value="XY">XY</option>
                    <option value="XZ">XZ</option>
                    <option value="YZ">YZ</option>
                  </select>
                </div>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>Tilt°</label>
                  <input type="number" value={opTilt} step={5}
                         onChange={(e) => setOpTilt(Number(e.target.value) || 0)}
                         style={{ ...field, flex: 1, width: 'auto', minWidth: 0 }} />
                  <select value={opTiltAxis} onChange={(e) => setOpTiltAxis(e.target.value as 'X' | 'Y' | 'Z')}
                          style={{ ...field, width: 'auto' }}>
                    <option>X</option><option>Y</option><option>Z</option>
                  </select>
                </div>
                <div style={row}>
                  <label style={{ ...lbl, width: '48px' }}>Offset</label>
                  {[[ox, setOx, 'X'], [oy, setOy, 'Y'], [oz, setOz, 'Z']].map(([v, set, t]) => (
                    <input key={t as string} type="number" value={v as number} title={t as string}
                           onChange={(e) => (set as (n: number) => void)(Number(e.target.value) || 0)}
                           style={{ ...field, flex: 1, width: 'auto', minWidth: 0 }} />
                  ))}
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
              <button onClick={addFeature}
                style={{ flex: 1, padding: '6px', background: editingId ? palette.primaryBtn : palette.panelBg,
                         color: editingId ? '#fff' : palette.text,
                         border: `1px solid ${editingId ? palette.primaryBtn : palette.border}`,
                         borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
                {editingId ? 'Update' : '+ Add to tree'}
              </button>
              {editingId && (
                <button onClick={() => setEditingId(null)} title="Stop editing"
                  style={{ padding: '6px 10px', background: 'none', color: palette.textSecondary,
                           border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
                  New
                </button>
              )}
            </div>

            {editingId && (
              <div style={{ fontSize: '12px', color: palette.textSecondary }}>
                Editing feature — change params and hit Update, or “New”.
              </div>
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

        {/* timeline: the feature sequence with a rollback marker */}
        {features.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 12px',
                        borderTop: `1px solid ${palette.border}`, overflowX: 'auto' }}>
            <span style={{ fontSize: '11px', color: palette.textSecondary, marginRight: '4px',
                           textTransform: 'uppercase', letterSpacing: '0.5px', flex: '0 0 auto' }}>Timeline</span>
            {features.map((f, i) => {
              const marker = upto === Infinity ? features.length - 1 : Math.min(upto, features.length - 1);
              const dimmed = i > marker;
              return (
                <div key={f.id}
                  onClick={() => { setUpto(i === features.length - 1 ? Infinity : i); loadFeature(f); }}
                  title={`${describe(f)} — click to roll here / edit`}
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 8px',
                           background: palette.inputBg, borderRadius: '4px', cursor: 'pointer', flex: '0 0 auto',
                           opacity: dimmed ? 0.4 : 1,
                           border: `1px solid ${editingId === f.id ? palette.primaryBtn : 'transparent'}` }}>
                  <span style={{ fontSize: '11px', color: palette.textSecondary }}>{i + 1}</span>
                  <span style={{ fontSize: '12px', color: palette.text }}>{f.type}</span>
                  <button onClick={(e) => { e.stopPropagation(); removeFeature(f.id); }} title="Remove"
                    style={{ background: 'none', border: 'none', color: palette.danger, cursor: 'pointer',
                             fontSize: '13px', lineHeight: 1, padding: '0 1px' }}>&times;</button>
                </div>
              );
            })}
            {upto !== Infinity && (
              <button onClick={() => setUpto(Infinity)} title="Show the full build"
                style={{ marginLeft: '4px', padding: '4px 8px', background: 'none', color: palette.textSecondary,
                         border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '12px',
                         cursor: 'pointer', flex: '0 0 auto', whiteSpace: 'nowrap' }}>full ▶|</button>
            )}
          </div>
        )}

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
