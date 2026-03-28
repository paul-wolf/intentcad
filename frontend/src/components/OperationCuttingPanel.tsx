import { useCamStore } from '@/stores/camStore';
import { useThemeStore } from '@/theme';

export function OperationCuttingPanel({ onClose }: { onClose: () => void }) {
  const palette = useThemeStore((s) => s.palette);
  const jobConfig = useCamStore((s) => s.jobConfig);
  const focusedOperationIndex = useCamStore((s) => s.focusedOperationIndex);
  const updateOperationCutting = useCamStore((s) => s.updateOperationCutting);
  const applyCuttingToAll = useCamStore((s) => s.applyCuttingToAll);

  const focusedOp = focusedOperationIndex !== null ? jobConfig.operations[focusedOperationIndex] ?? null : null;
  const cutting = focusedOp?.cutting ?? null;

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '3px 6px',
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '3px',
    background: palette.inputBg,
    color: palette.text,
    fontSize: '12px',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    color: palette.textMuted,
    marginBottom: '2px',
    display: 'block',
  };

  const sectionStyle: React.CSSProperties = {
    padding: '8px 10px',
    borderBottom: `1px solid ${palette.border}`,
  };

  const headerStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: palette.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginBottom: '6px',
  };

  const btnStyle: React.CSSProperties = {
    padding: '4px 10px',
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '3px',
    background: palette.buttonBg,
    color: palette.text,
    cursor: 'pointer',
    fontSize: '11px',
  };

  if (!cutting || focusedOperationIndex === null) {
    return (
      <div style={{
        width: '200px',
        background: palette.panelBg,
        borderRight: `1px solid ${palette.border}`,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}>
        <div style={{ ...sectionStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={headerStyle}>Cutting</span>
          <button onClick={onClose} style={{ ...btnStyle, fontSize: '10px', padding: '1px 6px' }}>X</button>
        </div>
        <div style={{ fontSize: '11px', color: palette.textMuted, fontStyle: 'italic', padding: '8px 10px', textAlign: 'center' }}>
          Select an operation to edit its cutting settings
        </div>
      </div>
    );
  }

  const opColor = ['#ff8c00', '#00bcd4', '#8bc34a', '#e91e63', '#9c27b0', '#ff5722'][focusedOperationIndex % 6]!;

  return (
    <div style={{
      width: '200px',
      background: palette.panelBg,
      borderRight: `1px solid ${palette.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
    }}>
      {/* Header */}
      <div style={{ ...sectionStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: opColor }}>
          Op {focusedOperationIndex + 1}: {focusedOp!.kind}
        </span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={() => applyCuttingToAll(focusedOperationIndex)}
            style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
            title="Copy these cutting settings to all operations"
          >
            Apply All
          </button>
          <button onClick={onClose} style={{ ...btnStyle, fontSize: '10px', padding: '1px 6px' }}>X</button>
        </div>
      </div>

      {/* Tool */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Tool</div>
        <label style={labelStyle}>Diameter (mm)</label>
        <input
          type="number"
          value={cutting.tool.diameter}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, diameter: +e.target.value } })}
          style={inputStyle}
          min={0.1}
          step={0.5}
        />
        <label style={labelStyle}>Type</label>
        <select
          value={cutting.tool.type}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, type: e.target.value as 'flat' | 'ball' | 'vbit' | 'drill' } })}
          style={inputStyle}
        >
          <option value="flat">Flat End Mill</option>
          <option value="ball">Ball Nose</option>
          <option value="vbit">V-Bit</option>
          <option value="drill">Drill</option>
        </select>
        <label style={labelStyle}>Flute Count</label>
        <input
          type="number"
          value={cutting.tool.fluteCount}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, fluteCount: +e.target.value } })}
          style={inputStyle}
          min={1}
          max={8}
        />
        <label style={labelStyle}>Flute Length (mm)</label>
        <input
          type="number"
          value={cutting.tool.fluteLength}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, fluteLength: +e.target.value } })}
          style={inputStyle}
          min={1}
          step={1}
        />
      </div>

      {/* Cutting Params */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Speeds</div>
        <label style={labelStyle}>Spindle (RPM)</label>
        <input
          type="number"
          value={cutting.spindleSpeed}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { spindleSpeed: +e.target.value })}
          style={inputStyle}
          min={100}
          step={500}
        />
        <label style={labelStyle}>Feed (mm/min)</label>
        <input
          type="number"
          value={cutting.feedRate}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { feedRate: +e.target.value })}
          style={inputStyle}
          min={10}
          step={50}
        />
        <label style={labelStyle}>Plunge (mm/min)</label>
        <input
          type="number"
          value={cutting.plungeRate}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { plungeRate: +e.target.value })}
          style={inputStyle}
          min={10}
          step={10}
        />
        <label style={labelStyle}>Safe Z (mm)</label>
        <input
          type="number"
          value={cutting.safeZ}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { safeZ: +e.target.value })}
          style={inputStyle}
          min={1}
          step={1}
        />
      </div>

      {/* Depth */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Depth</div>
        <label style={labelStyle}>Total (mm)</label>
        <input
          type="number"
          value={cutting.depth.totalDepth}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { depth: { ...cutting.depth, totalDepth: +e.target.value } })}
          style={inputStyle}
          min={0.1}
          step={0.5}
        />
        <label style={labelStyle}>Per Pass (mm)</label>
        <input
          type="number"
          value={cutting.depth.depthPerPass}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { depth: { ...cutting.depth, depthPerPass: +e.target.value } })}
          style={inputStyle}
          min={0.1}
          step={0.25}
        />
        <label style={labelStyle}>Finish Allowance (mm)</label>
        <input
          type="number"
          value={cutting.depth.finalPassAllowance}
          onChange={(e) => updateOperationCutting(focusedOperationIndex, { depth: { ...cutting.depth, finalPassAllowance: +e.target.value } })}
          style={inputStyle}
          min={0}
          step={0.05}
        />
      </div>
    </div>
  );
}
