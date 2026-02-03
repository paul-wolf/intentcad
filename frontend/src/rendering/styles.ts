import { STROKES, DIMENSION_FONT_SIZE } from '@/config';
import type { ThemePalette } from '@/theme';
import type { LineStyle, TextStyle } from '@/types/renderer';

export interface ThemeStyles {
  line: LineStyle;
  lineSelected: LineStyle;
  ghosted: LineStyle;
  preview: LineStyle;
  gridMinor: LineStyle;
  gridMajor: LineStyle;
  snap: LineStyle;
  dimensionLine: LineStyle;
  dimensionSelected: LineStyle;
  dimensionText: TextStyle;
  dimensionOverlayText: TextStyle;
}

export function getStyles(palette: ThemePalette): ThemeStyles {
  return {
    line: { color: palette.line, width: STROKES.line },
    lineSelected: { color: palette.lineSelected, width: STROKES.lineSelected },
    ghosted: { color: palette.ghosted, width: STROKES.ghosted },
    preview: { color: palette.preview, width: STROKES.preview },
    gridMinor: { color: palette.gridMinor, width: STROKES.grid },
    gridMajor: { color: palette.gridMajor, width: STROKES.gridMajor },
    snap: { color: palette.snap, width: STROKES.snap },
    dimensionLine: { color: palette.dimension, width: STROKES.dimension },
    dimensionSelected: { color: palette.lineSelected, width: STROKES.dimension * 2 },
    dimensionText: { color: palette.dimensionText, fontSize: DIMENSION_FONT_SIZE },
    dimensionOverlayText: { color: palette.dimensionOverlay, fontSize: DIMENSION_FONT_SIZE },
  };
}
