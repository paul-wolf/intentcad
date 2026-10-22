import { useCamStore } from '@/stores/camStore';
import { CamSetupStep } from './CamSetupStep';
import { CamPlanStep } from './CamPlanStep';
import { CamRunStep } from './CamRunStep';
import { Btn, useTokens, SANS } from './ui';

export { CamHeader } from './CamHeader';

/** The left panel in CAM mode: the step in hand. */
export function CamStepPanel() {
  const step = useCamStore((s) => s.step);
  if (step === 'setup') return <CamSetupStep />;
  if (step === 'plan') return <CamPlanStep />;
  return <CamRunStep />;
}

/** A line over the canvas while it's waiting for a click or a drag. */
export function CamCanvasHint() {
  const t = useTokens();
  const pickingOrigin = useCamStore((s) => s.pickingOrigin);
  const drawingClamp = useCamStore((s) => s.drawingClamp);
  if (!pickingOrigin && !drawingClamp) return null;
  const cancel = () => (pickingOrigin ? useCamStore.getState().setPickingOrigin(false) : useCamStore.getState().setDrawingClamp(false));
  return (
    <div style={{
      position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, display: 'flex', alignItems: 'center', gap: 10,
      background: t.surface, border: `1px solid ${t.accent}`, borderRadius: 10, padding: '7px 8px 7px 14px', boxShadow: t.shadow, fontFamily: SANS, fontSize: 12.5, color: t.text,
    }}>
      {pickingOrigin ? 'Click the point for X0 Y0 (it snaps to shape ends and centres)' : 'Drag a box where the clamp is'}
      <Btn small onClick={cancel}>Cancel</Btn>
    </div>
  );
}
