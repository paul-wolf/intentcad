import type { Renderer, Viewport, LineStyle } from '@/types/renderer';
import type { ToolpathMove, CamIssue } from '@/types/cam';
import type { Point } from '@/types/document';
import type { ThemePalette } from '@/theme';
import { interpolateMove } from '@/cam/simulatorInterp';

/** Toolpath color for feed moves */
const TOOLPATH_COLOR = '#ff8c00'; // orange

/**
 * Render toolpath overlay on the sketch canvas.
 * Called from pipeline.ts after renderToolOverlay().
 * origin: the WCS zero point in world coordinates (machine starts here).
 */
export function renderToolpathOverlay(
  renderer: Renderer,
  viewport: Viewport,
  toolpath: ToolpathMove[],
  issues: CamIssue[],
  palette: ThemePalette,
  origin: Point = { x: 0, y: 0 },
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

  let currentPos = { x: origin.x, y: origin.y };

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
        const absCenter = {
          x: currentPos.x + move.center.x,
          y: currentPos.y + move.center.y,
        };
        const screenCenter = viewport.worldToScreen(absCenter);
        const dx = currentPos.x - absCenter.x;
        const dy = currentPos.y - absCenter.y;
        const radius = Math.sqrt(dx * dx + dy * dy) * viewport.scale;

        // Full-circle arc: from ≈ to, so startAngle === endAngle → Canvas2D draws nothing.
        // Use drawCircle for full circles instead.
        const fdx = move.to.x - currentPos.x;
        const fdy = move.to.y - currentPos.y;
        if (fdx * fdx + fdy * fdy < 1e-6) {
          renderer.drawCircle(screenCenter, radius, arcStyle);
        } else {
          const startAngle = Math.atan2(dy, dx);
          const endAngle = Math.atan2(move.to.y - absCenter.y, move.to.x - absCenter.x);
          renderer.drawArc(screenCenter, radius, startAngle, endAngle, !move.clockwise, arcStyle);
        }
        break;
      }
    }

    currentPos = move.to;
  }

  renderIssueHighlights(renderer, viewport, issues, palette);
}

function renderIssueHighlights(
  renderer: Renderer,
  viewport: Viewport,
  issues: CamIssue[],
  palette: ThemePalette,
): void {
  for (const issue of issues) {
    if (issue.position) {
      const screenPos = viewport.worldToScreen(issue.position);
      const color = issue.severity === 'error' ? palette.danger : issue.severity === 'warning' ? palette.warning : palette.accent;
      renderer.drawCircle(screenPos, 8, { color, width: 2 });
      renderer.drawCircle(screenPos, 3, { color, width: 2 });
    }
  }
}

export interface SimulatorState {
  simMoveIndex: number;
  simProgress: number;
  simPosition: Point | null;
}

/**
 * Render toolpath with simulator highlighting: past/current/future moves and tool indicator.
 */
export function renderSimulatorOverlay(
  renderer: Renderer,
  viewport: Viewport,
  toolpath: ToolpathMove[],
  issues: CamIssue[],
  palette: ThemePalette,
  origin: Point,
  sim: SimulatorState,
  toolDiameter: number,
): void {
  const { simMoveIndex, simProgress, simPosition } = sim;

  // NOTE: Canvas2DRenderer's style.opacity REPLACES globalAlpha, not multiplies.
  // So we must use style.opacity on every style — never rely on setGlobalAlpha for moves.
  const FUTURE_OPACITY = 0.2;

  // Past/current styles
  const rapidPast: LineStyle = { color: palette.textSecondary, width: 1, dash: [4, 4], opacity: 0.5 };
  const feedPast: LineStyle = { color: TOOLPATH_COLOR, width: 1.5 };
  const arcPast: LineStyle = { color: TOOLPATH_COLOR, width: 1.5 };

  // Future styles — opacity baked in
  const rapidFuture: LineStyle = { color: palette.textSecondary, width: 1, dash: [4, 4], opacity: FUTURE_OPACITY };
  const feedFuture: LineStyle = { color: TOOLPATH_COLOR, width: 1.5, opacity: FUTURE_OPACITY };
  const arcFuture: LineStyle = { color: TOOLPATH_COLOR, width: 1.5, opacity: FUTURE_OPACITY };

  let currentPos = { x: origin.x, y: origin.y };

  for (let i = 0; i < toolpath.length; i++) {
    const move = toolpath[i]!;
    const from = currentPos;

    if (i < simMoveIndex) {
      drawMove(renderer, viewport, from, move, rapidPast, feedPast, arcPast);
    } else if (i === simMoveIndex) {
      drawPartialMove(renderer, viewport, from, move, simProgress,
        rapidPast, feedPast, arcPast, rapidFuture, feedFuture, arcFuture);
    } else {
      drawMove(renderer, viewport, from, move, rapidFuture, feedFuture, arcFuture);
    }

    currentPos = move.to;
  }

  // Tool indicator at simPosition
  if (simPosition) {
    const screenPos = viewport.worldToScreen(simPosition);
    const toolRadius = (toolDiameter / 2) * viewport.scale;

    // Semi-transparent tool circle (fillCircle has no style.opacity, so setGlobalAlpha works here)
    renderer.setGlobalAlpha(0.3);
    renderer.fillCircle(screenPos, toolRadius, TOOLPATH_COLOR);
    renderer.resetGlobalAlpha();
    renderer.drawCircle(screenPos, toolRadius, { color: TOOLPATH_COLOR, width: 1 });

    // Crosshair
    const ch = 5;
    renderer.drawLine(
      { x: screenPos.x - ch, y: screenPos.y },
      { x: screenPos.x + ch, y: screenPos.y },
      { color: TOOLPATH_COLOR, width: 1.5 },
    );
    renderer.drawLine(
      { x: screenPos.x, y: screenPos.y - ch },
      { x: screenPos.x, y: screenPos.y + ch },
      { color: TOOLPATH_COLOR, width: 1.5 },
    );
  }

  renderIssueHighlights(renderer, viewport, issues, palette);
}

function drawMove(
  renderer: Renderer,
  viewport: Viewport,
  from: Point,
  move: ToolpathMove,
  rapidStyle: LineStyle,
  feedStyle: LineStyle,
  arcStyle: LineStyle,
): void {
  const screenFrom = viewport.worldToScreen(from);
  const screenTo = viewport.worldToScreen(move.to);

  switch (move.kind) {
    case 'rapid':
      renderer.drawLine(screenFrom, screenTo, rapidStyle);
      break;
    case 'linear':
      if (move.feed > 0) renderer.drawLine(screenFrom, screenTo, feedStyle);
      break;
    case 'arc': {
      const absCenter = { x: from.x + move.center.x, y: from.y + move.center.y };
      const screenCenter = viewport.worldToScreen(absCenter);
      const dx = from.x - absCenter.x;
      const dy = from.y - absCenter.y;
      const radius = Math.sqrt(dx * dx + dy * dy) * viewport.scale;

      // Full-circle: from ≈ to → startAngle === endAngle → Canvas2D draws nothing
      const fdx = move.to.x - from.x;
      const fdy = move.to.y - from.y;
      if (fdx * fdx + fdy * fdy < 1e-6) {
        renderer.drawCircle(screenCenter, radius, arcStyle);
      } else {
        const startAngle = Math.atan2(dy, dx);
        const endAngle = Math.atan2(move.to.y - absCenter.y, move.to.x - absCenter.x);
        renderer.drawArc(screenCenter, radius, startAngle, endAngle, !move.clockwise, arcStyle);
      }
      break;
    }
  }
}

function drawPartialMove(
  renderer: Renderer,
  viewport: Viewport,
  from: Point,
  move: ToolpathMove,
  progress: number,
  rapidPast: LineStyle,
  feedPast: LineStyle,
  arcPast: LineStyle,
  rapidFuture: LineStyle,
  feedFuture: LineStyle,
  arcFuture: LineStyle,
): void {
  const midPoint = interpolateMove(from, move, progress);

  // Draw the completed part with past styles + remaining part with future styles
  switch (move.kind) {
    case 'rapid': {
      const screenFrom = viewport.worldToScreen(from);
      const screenMid = viewport.worldToScreen(midPoint);
      const screenTo = viewport.worldToScreen(move.to);
      renderer.drawLine(screenFrom, screenMid, rapidPast);
      renderer.drawLine(screenMid, screenTo, rapidFuture);
      break;
    }
    case 'linear': {
      if (move.feed > 0) {
        const screenFrom = viewport.worldToScreen(from);
        const screenMid = viewport.worldToScreen(midPoint);
        const screenTo = viewport.worldToScreen(move.to);
        renderer.drawLine(screenFrom, screenMid, feedPast);
        renderer.drawLine(screenMid, screenTo, feedFuture);
      }
      break;
    }
    case 'arc': {
      // Use sweep-based angles — atan2 loses winding info for arcs > π radians
      const absCenter = { x: from.x + move.center.x, y: from.y + move.center.y };
      const screenCenter = viewport.worldToScreen(absCenter);
      const dx = from.x - absCenter.x;
      const dy = from.y - absCenter.y;
      const radius = Math.sqrt(dx * dx + dy * dy) * viewport.scale;
      const startAngle = Math.atan2(dy, dx);
      const endAngle = Math.atan2(move.to.y - absCenter.y, move.to.x - absCenter.x);
      const ccw = !move.clockwise;

      // Compute total sweep (always positive), handling full circles
      let sweep = ccw ? startAngle - endAngle : endAngle - startAngle;
      if (sweep <= 1e-9) sweep += 2 * Math.PI;

      const completedSweep = sweep * progress;

      // Completed part angle
      const completedEnd = ccw
        ? startAngle - completedSweep
        : startAngle + completedSweep;

      // Full arc end angle
      const fullEnd = ccw
        ? startAngle - sweep
        : startAngle + sweep;

      // Draw completed (past) and remaining (future) arcs
      renderer.drawArc(screenCenter, radius, startAngle, completedEnd, ccw, arcPast);
      renderer.drawArc(screenCenter, radius, completedEnd, fullEnd, ccw, arcFuture);
      break;
    }
  }
}
