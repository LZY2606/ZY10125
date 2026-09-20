import { describe, it, expect } from 'vitest';
import {
  signedTetVolume, triArea, pointInTet, pointOnTriangle,
  distancePointSegment, pointOnSegment, hausdorff,
} from '../server/src/geometry.js';
import { matchNodes } from '../server/src/correspondence.js';
import { CORNERS, coarseCells } from '../scripts/cube-mesh.mjs';
import { refineTets, assertPositive } from '../scripts/refine.mjs';

const tet = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];

describe('几何约定', () => {
  it('正序 tet4 有符号体积为正且等于 1/6', () => {
    expect(signedTetVolume(...tet)).toBeCloseTo(1 / 6, 12);
  });
  it('翻转后有符号体积为负', () => {
    expect(signedTetVolume(tet[1], tet[0], tet[2], tet[3])).toBeCloseTo(-1 / 6, 12);
  });
  it('重复节点为零体积', () => {
    expect(signedTetVolume(tet[0], tet[0], tet[2], tet[3])).toBe(0);
  });
  it('单位直角三角形面积为 0.5', () => {
    expect(triArea([0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(0.5, 14);
  });
  it('点包含：内部、表面、外部', () => {
    expect(pointInTet([0.1, 0.1, 0.1], tet)).toBe(true);
    expect(pointInTet([0.5, 0, 0], tet)).toBe(true);
    expect(pointInTet([0.9, 0.9, 0.9], tet)).toBe(false);
  });
  it('点在三角形上判定', () => {
    const tri = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    expect(pointOnTriangle([0.25, 0.25, 0], tri)).toBe(true);
    expect(pointOnTriangle([0.25, 0.25, 0.4], tri)).toBe(false);
  });
  it('点到线段距离与在线段上', () => {
    expect(distancePointSegment([1, 1, 0], [0, 0, 0], [2, 0, 0])).toBeCloseTo(1, 12);
    expect(pointOnSegment([0.5, 0, 0], [0, 0, 0], [1, 0, 0])).toBe(true);
    expect(pointOnSegment([0.5, 1e-10, 0], [0, 0, 0], [1, 0, 0], 1e-9)).toBe(true);
  });
  it('Hausdorff 距离', () => {
    expect(hausdorff([[0, 0, 0]], [[0, 0, 0], [1, 0, 0]])).toBe(1);
  });
});

describe('节点对应', () => {
  it('全细化保留 8 个角点一对一，不复制', () => {
    const coordOf = (id) => CORNERS[id];
    const { tets, newNodes } = refineTets(coarseCells(), coordOf);
    assertPositive(tets, (id) => {
      const mid = newNodes.find((n) => n.id === id);
      return mid ? mid.coord : coordOf(id);
    });
    const oldMesh = { nodes: Object.entries(CORNERS).map(([id, coord]) => ({ id, coord })) };
    const newMesh = { nodes: [...oldMesh.nodes, ...newNodes] };
    const { pairs, removed, added } = matchNodes(oldMesh, newMesh, { nodeDistance: 1e-6 });
    expect(pairs).toHaveLength(8);
    expect(new Set(pairs.map((p) => p.newId)).size).toBe(8);
    expect(removed).toEqual([]);
    expect(added).toHaveLength(19);
  });

  it('最近点在容差外时不强行配对', () => {
    const oldMesh = { nodes: [{ id: 'a', coord: [0, 0, 0] }] };
    const newMesh = { nodes: [{ id: 'b', coord: [0.5, 0, 0] }] };
    const { pairs, removed } = matchNodes(oldMesh, newMesh, { nodeDistance: 1e-6 });
    expect(pairs).toHaveLength(0);
    expect(removed).toHaveLength(1);
  });
});
