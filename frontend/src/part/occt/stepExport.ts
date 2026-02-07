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

  // Snapshot root FS before write. The Embind binding for Write() mangles the
  // JS string into a garbled C filename, so we can't predict the actual path.
  // Instead we detect whatever new file appeared after the write.
  const before = new Set(oc.FS.readdir('/') as string[]);

  const status = writer.Write('export.step');

  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error('STEP export failed');
  }

  const after = (oc.FS.readdir('/') as string[]);
  const newFile = after.find((f: string) => !before.has(f));
  if (!newFile) {
    throw new Error('STEP file not found in Emscripten FS after write');
  }

  const path = '/' + newFile;
  const fileData = oc.FS.readFile(path, { encoding: 'binary' });
  oc.FS.unlink(path);

  return new Blob([fileData], { type: 'application/step' });
}
