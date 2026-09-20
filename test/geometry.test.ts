import { describe, expect, it } from 'vitest';
import { coplanarTriIntersectionArea } from '../src/core/overlap.js';
import { signedTetVolume } from '../src/core/geometry.js';
import type { Vec3 } from '../src/core/types.js';

describe('coplanar triangle clipping', () => {
  const big: [Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0]
  ];
  const n: Vec3 = [0, 0, 1];

  it('returns the small triangle area when fully contained', () => {
    const small: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [0.5, 0, 0],
      [0, 0.5, 0]
    ];
    expect(coplanarTriIntersectionArea(big, small, n)).toBeCloseTo(0.125, 12);
  });

  it('splits a mid-edge triangle into four quarters summing to the parent', () => {
    const children: [Vec3, Vec3, Vec3][] = [
      [[0, 0, 0], [0.5, 0, 0], [0, 0.5, 0]],
      [[0.5, 0, 0], [1, 0, 0], [0.5, 0.5, 0]],
      [[0, 0.5, 0], [0.5, 0.5, 0], [0, 1, 0]],
      [[0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0]]
    ];
    const sum = children.reduce((a, c) => a + coplanarTriIntersectionArea(big, c, n), 0);
    expect(sum).toBeCloseTo(0.5, 10);
  });

  it('is zero for disjoint triangles', () => {
    const far: [Vec3, Vec3, Vec3] = [
      [5, 5, 0],
      [6, 5, 0],
      [5, 6, 0]
    ];
    expect(coplanarTriIntersectionArea(big, far, n)).toBeCloseTo(0, 12);
  });
});

describe('tetrahedron orientation', () => {
  it('positive and negative winding flip sign', () => {
    const p: [Vec3, Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];
    expect(signedTetVolume(p)).toBeCloseTo(1 / 6, 12);
    expect(signedTetVolume([p[1], p[0], p[2], p[3]])).toBeCloseTo(-1 / 6, 12);
  });
});
