import { STROKES, DIMENSION_FONT_SIZE, CONSTRAINT_LINK_DASH, CONSTRAINT_LINK_FONT_SIZE } from '@/config';
import type { ThemePalette } from '@/theme';
import type { LineStyle, TextStyle } from '@/types/renderer';

export interface ThemeStyles {
  line: LineStyle;
  lineSelected: LineStyle;
  construction: LineStyle;
  constructionSelected: LineStyle;
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

export function getStyles(palette: ThemePalette): ThemeStyles {
  return {
    line: { color: palette.line, width: STROKES.line },
    lineSelected: { color: palette.lineSelected, width: STROKES.lineSelected },
    construction: { color: palette.line, width: STROKES.line, dash: [6, 4] },
    constructionSelected: { color: palette.lineSelected, width: STROKES.lineSelected, dash: [6, 4] },
    ghosted: { color: palette.ghosted, width: STROKES.ghosted },
    preview: { color: palette.preview, width: STROKES.preview },
    gridMinor: { color: palette.gridMinor, width: STROKES.grid },
    gridMajor: { color: palette.gridMajor, width: STROKES.gridMajor },
    snap: { color: palette.snap, width: STROKES.snap },
    dimensionLine: { color: palette.dimension, width: STROKES.dimension },
    dimensionSelected: { color: palette.lineSelected, width: STROKES.dimension * 2 },
    dimensionText: { color: palette.dimensionText, fontSize: DIMENSION_FONT_SIZE },
    dimensionOverlayText: { color: palette.dimensionOverlay, fontSize: DIMENSION_FONT_SIZE },
    lineConstrained: { color: palette.constrained, width: STROKES.line },
    lineConstrainedSelected: { color: palette.constrained, width: STROKES.lineSelected },
    constructionConstrained: { color: palette.constrained, width: STROKES.line, dash: [6, 4] },
    constructionConstrainedSelected: { color: palette.constrained, width: STROKES.lineSelected, dash: [6, 4] },
    segmentSelected: { color: palette.accent, width: 3 },
    lineRelated: { color: palette.constraintLink, width: STROKES.line },
    lineRelatedConstrained: { color: palette.constraintLink, width: STROKES.line },
    constraintLinkLine: { color: palette.constraintLink, width: 0.75, dash: [...CONSTRAINT_LINK_DASH], opacity: 0.6 },
    constraintLinkText: { color: palette.constraintLink, fontSize: CONSTRAINT_LINK_FONT_SIZE },
  };
}
