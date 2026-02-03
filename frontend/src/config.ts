/** Pixels per millimeter */
export const SCALE = 4;

/** Hit test tolerance in screen pixels */
export const HIT_TOL = 8;

/** Snap radius in screen pixels */
export const SNAP_RADIUS = 12;

/** Grid spacing in mm */
export const GRID_SPACING_MM = 5;

/** Major grid every N minor lines */
export const GRID_MAJOR_EVERY = 10;

/** Stroke widths in screen pixels */
export const STROKES = {
  line: 1,
  lineSelected: 2.5,
  ghosted: 0.75,
  preview: 1,
  grid: 0.5,
  gridMajor: 0.5,
  snap: 1.5,
  dimension: 0.75,
} as const;

/** Snap indicator circle radius in screen pixels */
export const SNAP_INDICATOR_RADIUS = 5;

/** Endpoint dot radius in screen pixels */
export const ENDPOINT_RADIUS = 3;

/** Dimension annotation defaults */
export const DIMENSION_OFFSET_MM = 8;
export const DIMENSION_FONT_SIZE = 11;
export const DIMENSION_ARROW_LENGTH = 8;
export const DIMENSION_ARROW_HALF_WIDTH = 3;
export const DIMENSION_EXTENSION_GAP = 3;
export const DIMENSION_EXTENSION_OVERSHOOT = 3;
export const DIMENSION_TEXT_PAD = 2;

/** Ghosted sketch opacity */
export const GHOSTED_OPACITY = 0.35;
