import * as THREE from 'three';
import { computeGridNormals } from '../cloth/restShape.js';

/**
 * Render mesh bound directly to the solver's typed arrays (positions,
 * normals, fold density). One vertex per particle; consistent CCW winding
 * seen from +z so three's BackSide/FrontSide two-pass transparency is valid.
 */
export function createRibbonMesh(solver, material) {
  const { columns, rows, count, shape } = solver;
  const rowLength = columns + 1;
  const geometry = new THREE.BufferGeometry();

  const position = new THREE.BufferAttribute(solver.pos, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  const normal = new THREE.BufferAttribute(solver.nCur, 3);
  normal.setUsage(THREE.DynamicDrawUsage);
  const density = new THREE.BufferAttribute(solver.density, 1);
  density.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setAttribute('aDensity', density);
  geometry.setAttribute('uv', new THREE.BufferAttribute(shape.uv, 2));

  const indices = new Uint32Array(columns * rows * 6);
  let k = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i00 = y * rowLength + x, i10 = i00 + 1, i01 = i00 + rowLength, i11 = i01 + 1;
      indices[k++] = i00; indices[k++] = i10; indices[k++] = i11;
      indices[k++] = i00; indices[k++] = i11; indices[k++] = i01;
    }
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;

  // cut-out shadow that follows the alpha map (density) when one is set
  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
    alphaTest: 0.35,
  });
  mesh.customDepthMaterial = depthMaterial;

  return {
    mesh,
    geometry,
    depthMaterial,
    /** Push the solver state to the GPU. Call once per frame. */
    sync() {
      computeGridNormals(solver.pos, columns, rows, solver.nCur);
      position.needsUpdate = true;
      normal.needsUpdate = true;
      density.needsUpdate = true;
    },
    setShadowAlphaMap(texture) {
      depthMaterial.alphaMap = texture;
      depthMaterial.needsUpdate = true;
    },
    dispose() { geometry.dispose(); depthMaterial.dispose(); },
    count,
  };
}
