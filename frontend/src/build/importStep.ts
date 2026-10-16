/**
 * Seeding a part from an uploaded STEP file. The script imports the file by
 * content hash — ASSETS["<sha256>"] — so the script text alone still decides
 * the build (and the build cache key). The placement lines mirror the backend's
 * documents/api.IMPORT_SCRIPT, which the upload's trial build runs.
 */

import type { AssetInfo } from '@/api/client';

/** File types the picker offers (the server checks again). */
export const STEP_ACCEPT = '.step,.stp';

/** The script for a part that is just the imported file, placed on the plate. */
export function importScript(asset: Pick<AssetInfo, 'sha256' | 'filename'>): string {
  return `# imported: ${asset.filename}  (${asset.sha256.slice(0, 12)})
P = dict()
part = import_step(ASSETS["${asset.sha256}"])
# place on the build plate: centered in XY, resting on Z=0
bb = part.bounding_box()
part = Pos(-(bb.min.X + bb.max.X) / 2, -(bb.min.Y + bb.max.Y) / 2, -bb.min.Z) * part
`;
}

/** The version label for the first build of an imported file. */
export const importLabel = (filename: string) => `imported ${filename}`;

/** A part name from an uploaded file name: "bracket v2.step" → "bracket v2". */
export const partNameFor = (filename: string) => filename.replace(/\.(step|stp)$/i, '') || 'Imported part';
