import { COLORS, STROKES, DIMENSION_FONT_SIZE } from '@/config';
import type { LineStyle, TextStyle } from '@/types/renderer';

export const LINE_STYLE: LineStyle = {
  color: COLORS.line,
  width: STROKES.line,
};

export const LINE_SELECTED_STYLE: LineStyle = {
  color: COLORS.lineSelected,
  width: STROKES.lineSelected,
};

export const GHOSTED_STYLE: LineStyle = {
  color: COLORS.ghosted,
  width: STROKES.ghosted,
};

export const PREVIEW_STYLE: LineStyle = {
  color: COLORS.preview,
  width: STROKES.preview,
};

export const GRID_MINOR_STYLE: LineStyle = {
  color: COLORS.gridMinor,
  width: STROKES.grid,
};

export const GRID_MAJOR_STYLE: LineStyle = {
  color: COLORS.gridMajor,
  width: STROKES.gridMajor,
};

export const SNAP_STYLE: LineStyle = {
  color: COLORS.snap,
  width: STROKES.snap,
};

export const DIMENSION_LINE_STYLE: LineStyle = {
  color: COLORS.dimension,
  width: STROKES.dimension,
};

export const DIMENSION_SELECTED_STYLE: LineStyle = {
  color: COLORS.lineSelected,
  width: STROKES.dimension * 2,
};

export const DIMENSION_TEXT_STYLE: TextStyle = {
  color: COLORS.dimensionText,
  fontSize: DIMENSION_FONT_SIZE,
};

export const DIMENSION_OVERLAY_TEXT_STYLE: TextStyle = {
  color: COLORS.dimensionOverlay,
  fontSize: DIMENSION_FONT_SIZE,
};
