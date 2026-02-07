import type * as THREE from 'three';

/**
 * Export geometries as a binary STL blob.
 * Binary STL format:
 *   80 bytes header
 *   4 bytes uint32 triangle count
 *   per triangle:
 *     12 bytes normal (3 × float32)
 *     36 bytes vertices (3 × 3 × float32)
 *     2 bytes attribute byte count (0)
 */
export function exportSTL(geometries: THREE.BufferGeometry[]): Blob {
  // Count total triangles
  let totalTriangles = 0;
  for (const geom of geometries) {
    const pos = geom.getAttribute('position');
    if (!pos) continue;
    const idx = geom.getIndex();
    totalTriangles += idx ? idx.count / 3 : pos.count / 3;
  }

  // 80 header + 4 count + 50 bytes per triangle
  const bufferSize = 80 + 4 + totalTriangles * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // Header (80 bytes of zeros)
  let offset = 80;

  // Triangle count
  view.setUint32(offset, totalTriangles, true);
  offset += 4;

  for (const geom of geometries) {
    const posAttr = geom.getAttribute('position');
    const normAttr = geom.getAttribute('normal');
    if (!posAttr) continue;

    const idx = geom.getIndex();
    const triCount = idx ? idx.count / 3 : posAttr.count / 3;
    for (let t = 0; t < triCount; t++) {
      // Resolve vertex indices (indexed vs non-indexed geometry)
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

      // Normal — use first vertex normal or compute from vertices
      if (normAttr) {
        view.setFloat32(offset, normAttr.getX(i0), true); offset += 4;
        view.setFloat32(offset, normAttr.getY(i0), true); offset += 4;
        view.setFloat32(offset, normAttr.getZ(i0), true); offset += 4;
      } else {
        // Zero normal
        offset += 12;
      }

      // Vertex 1
      view.setFloat32(offset, posAttr.getX(i0), true); offset += 4;
      view.setFloat32(offset, posAttr.getY(i0), true); offset += 4;
      view.setFloat32(offset, posAttr.getZ(i0), true); offset += 4;

      // Vertex 2
      view.setFloat32(offset, posAttr.getX(i1), true); offset += 4;
      view.setFloat32(offset, posAttr.getY(i1), true); offset += 4;
      view.setFloat32(offset, posAttr.getZ(i1), true); offset += 4;

      // Vertex 3
      view.setFloat32(offset, posAttr.getX(i2), true); offset += 4;
      view.setFloat32(offset, posAttr.getY(i2), true); offset += 4;
      view.setFloat32(offset, posAttr.getZ(i2), true); offset += 4;

      // Attribute byte count
      view.setUint16(offset, 0, true); offset += 2;
    }
  }

  return new Blob([buffer], { type: 'application/octet-stream' });
}
