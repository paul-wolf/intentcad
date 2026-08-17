import { STROKES, DIMENSION_FONT_SIZE, CONSTRAINT_LINK_DASH } from '@/config';
import type { ThemePalette } from '@/theme';
import type { LineStyle, TextStyle } from '@/types/renderer';

export interface ThemeStyles {
  line: LineStyle;
  lineSelected: LineStyle;
  construction: LineStyle;
  constructionSelected: LineStyle;
  reference: LineStyle;
  ghosted: LineStyle;
  preview: LineStyle;
  gridMinor: LineStyle;
  gridMajor: LineStyle;
  snap: LineStyle;
  dimensionLine: LineStyle;
  dimensionSelected: LineStyle;
  dimensionText: TextStyle;
  dimensionOverlayText: TextStyle;
  lineConstrained: LineStyle;
  lineConstrainedSelected: LineStyle;
  constructionConstrained: LineStyle;
  constructionConstrainedSelected: LineStyle;
  segmentSelected: LineStyle;
  lineRelated: LineStyle;
  lineRelatedConstrained: LineStyle;
  constraintLinkLine: LineStyle;
  constraintLinkText: TextStyle;
}

export function getStyles(palette: ThemePalette, lineWidthScale = 1, fontSizeScale = lineWidthScale): ThemeStyles {
  const s = lineWidthScale;
  const fs = fontSizeScale;
  return {
    line: { color: palette.line, width: STROKES.line * s },
    lineSelected: { color: palette.lineSelected, width: STROKES.lineSelected * s },
    construction: { color: palette.line, width: STROKES.line * s, dash: [6, 4] },
    constructionSelected: { color: palette.lineSelected, width: STROKES.lineSelected * s, dash: [6, 4] },
    // Datum/reference geometry: real, but drawn as a centreline so it reads as
    // "a marker, not part of the outline".
    reference: { color: palette.warning, width: STROKES.line * s, dash: [10, 3, 2, 3] },
    ghosted: { color: palette.ghosted, width: STROKES.ghosted * s },
    preview: { color: palette.preview, width: STROKES.preview * s },
    gridMinor: { color: palette.gridMinor, width: STROKES.grid * s },
    gridMajor: { color: palette.gridMajor, width: STROKES.gridMajor * s },
    snap: { color: palette.snap, width: STROKES.snap * s },
    dimensionLine: { color: palette.dimension, width: STROKES.dimension * s },
    dimensionSelected: { color: palette.lineSelected, width: STROKES.dimension * 2 * s },
    dimensionText: { color: palette.dimensionText, fontSize: DIMENSION_FONT_SIZE * fs },
    dimensionOverlayText: { color: palette.dimensionOverlay, fontSize: DIMENSION_FONT_SIZE * fs },
    lineConstrained: { color: palette.constrained, width: STROKES.line * s },
    lineConstrainedSelected: { color: palette.constrained, width: STROKES.lineSelected * s },
    constructionConstrained: { color: palette.constrained, width: STROKES.line * s, dash: [6, 4] },
    constructionConstrainedSelected: { color: palette.constrained, width: STROKES.lineSelected * s, dash: [6, 4] },
    segmentSelected: { color: palette.accent, width: 3 * s },
    lineRelated: { color: palette.constraintLink, width: STROKES.line * s },
    lineRelatedConstrained: { color: palette.constraintLink, width: STROKES.line * s },
    constraintLinkLine: { color: palette.constraintLink, width: 0.75 * s, dash: [...CONSTRAINT_LINK_DASH], opacity: 0.6 },
    constraintLinkText: { color: palette.constraintLink, fontSize: DIMENSION_FONT_SIZE * fs },
  };
}
