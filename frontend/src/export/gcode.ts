import { downloadTextFile } from './download';

/**
 * Download G-code as a .nc file.
 */
export function downloadGcode(gcode: string, filename: string): void {
  const name = filename.endsWith('.nc') ? filename : `${filename}.nc`;
  downloadTextFile(gcode, name, 'text/plain');
}
