import type { OC } from './init';
import type { OcctCleanup } from './shapes';

/**
 * Export an OCCT shape to STEP format.
 * Uses STEPControl_Writer to write to Emscripten FS, then reads back as Blob.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exportSTEP(oc: OC, shape: any, cleanup: OcctCleanup): Blob {
  const writer = cleanup.track(new oc.STEPControl_Writer_1());

  writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);

  const filename = '/tmp/export.step';
  const status = writer.Write(filename);

  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error('STEP export failed');
  }

  // Read file from Emscripten virtual filesystem
  const fileData = oc.FS.readFile(filename, { encoding: 'binary' });
  oc.FS.unlink(filename);

  return new Blob([fileData], { type: 'application/step' });
}
