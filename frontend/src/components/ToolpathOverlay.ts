import type { Renderer, Viewport, LineStyle } from '@/types/renderer';
import type { ToolpathMove, CamIssue } from '@/types/cam';
import type { ThemePalette } from '@/theme';

/** Toolpath color for feed moves */
const TOOLPATH_COLOR = '#ff8c00'; // orange

/**
 * Render toolpath overlay on the sketch canvas.
 * Called from pipeline.ts after renderToolOverlay().
 */
export function renderToolpathOverlay(
  renderer: Renderer,
  viewport: Viewport,
  toolpath: ToolpathMove[],
  issues: CamIssue[],
  palette: ThemePalette,
): void {
  const rapidStyle: LineStyle = {
    color: palette.textSecondary,
    width: 1,
    dash: [4, 4],
    opacity: 0.4,
  };

  const feedStyle: LineStyle = {
    color: TOOLPATH_COLOR,
    width: 1.5,
  };

  const arcStyle: LineStyle = {
    color: TOOLPATH_COLOR,
    width: 1.5,
  };

  let currentPos = { x: 0, y: 0 };

  for (const move of toolpath) {
    const to = viewport.worldToScreen(move.to);
    const from = viewport.worldToScreen(currentPos);

    switch (move.kind) {
      case 'rapid': {
        renderer.drawLine(from, to, rapidStyle);
        break;
      }
      case 'linear': {
        if (move.feed > 0) {
          renderer.drawLine(from, to, feedStyle);
        }
        break;
      }
      case 'arc': {
        // Draw the arc if we can, otherwise fall back to a line
        const absCenter = {
          x: currentPos.x + move.center.x,
          y: currentPos.y + move.center.y,
        };
        const screenCenter = viewport.worldToScreen(absCenter);
        const dx = currentPos.x - absCenter.x;
        const dy = currentPos.y - absCenter.y;
        const radius = Math.sqrt(dx * dx + dy * dy) * viewport.scale;
        const startAngle = Math.atan2(currentPos.y - absCenter.y, currentPos.x - absCenter.x);
        const endAngle = Math.atan2(move.to.y - absCenter.y, move.to.x - absCenter.x);
        const counterClockwise = !move.clockwise;

        renderer.drawArc(screenCenter, radius, startAngle, endAngle, counterClockwise, arcStyle);
        break;
      }
    }

    currentPos = move.to;
  }

  // Render issue highlights
  for (const issue of issues) {
    if (issue.position) {
      const screenPos = viewport.worldToScreen(issue.position);
      const color = issue.severity === 'error' ? palette.danger : issue.severity === 'warning' ? palette.warning : palette.accent;
      renderer.drawCircle(screenPos, 8, { color, width: 2 });
      renderer.drawCircle(screenPos, 3, { color, width: 2 });
    }
  }
}
