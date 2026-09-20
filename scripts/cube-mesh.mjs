// 单位立方体的确定性 tet4 网格工具：
// 6 个四面体共享空间对角线 (0,0,0)->(1,1,1)，方向均为正（有符号体积 1/6）。
import { signedTetVolume } from '../server/src/geometry.js';
import { deriveBoundaryFaces } from '../server/src/mesh.js';

export const CORNERS = {
  n0: [0, 0, 0], n1: [1, 0, 0], n2: [1, 1, 0], n3: [0, 1, 0],
  n4: [0, 0, 1], n5: [1, 0, 1], n6: [1, 1, 1], n7: [0, 1, 1],
};

// 每个 tet 的有序节点（保证有符号体积为正）。
export const COARSE_TETS = [
  ['n0', 'n1', 'n2', 'n6'],
  ['n0', 'n2', 'n3', 'n6'],
  ['n0', 'n3', 'n7', 'n6'],
  ['n0', 'n7', 'n4', 'n6'],
  ['n0', 'n4', 'n5', 'n6'],
  ['n0', 'n5', 'n1', 'n6'],
];

export function coarseCells() {
  return COARSE_TETS.map((nodes, i) => ({ id: `c${i + 1}`, type: 'tet4', materialHint: 'steel', nodes }));
}

export function allBoundaryFaces(cells) {
  const { boundary } = deriveBoundaryFaces({ cells });
  return boundary.map((rec, i) => ({ id: `fb${i + 1}`, type: 'tri3', nodes: rec.nodes }));
}

export function facesByNormal(faces, coordOf, axis, value) {
  // 面三节点都在 axis=value 的坐标面上。
  return faces.filter((f) => f.nodes.every((id) => Math.abs(coordOf(id)[axis] - value) < 1e-12));
}

export function verifyPositive(cells, coordOf) {
  for (const c of cells) {
    const p = c.nodes.map(coordOf);
    const v = signedTetVolume(p[0], p[1], p[2], p[3]);
    if (v <= 0) throw new Error(`单元 ${c.id} 非正体积 ${v}`);
  }
}
