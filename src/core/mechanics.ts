import type { Vec3 } from './types.js';
import {
  add,
  centroid,
  cross,
  norm,
  scale,
  sub
} from './geometry.js';

export interface ForceResult {
  force: Vec3;
  applicationPoint: Vec3;
}

/**
 * Resultant of a uniform outward pressure on a set of wound triangles.
 *
 * F = sum_i p * A_i * n_i
 *
 * The pressure is the same scalar on every child face of a split surface, so
 * the resultant depends only on area/orientation, not on how the surface was
 * partitioned.
 */
export function pressureResultant(
  faces: { coords: [Vec3, Vec3, Vec3]; area: number; normal: Vec3 }[],
  pressure: number
): { force: Vec3; moment: Vec3; center: Vec3 } {
  let force: Vec3 = [0, 0, 0];
  let weightedCenter: Vec3 = [0, 0, 0];
  let weight = 0;

  for (const f of faces) {
    const fi = scale(f.normal, pressure * f.area);
    force = add(force, fi);
    const c = centroid([...f.coords]);
    weightedCenter = add(weightedCenter, scale(c, f.area));
    weight += f.area;
  }

  const center = weight > 0 ? scale(weightedCenter, 1 / weight) : [0, 0, 0] as Vec3;

  // Moment about the global origin computed from each triangle separately;
  // equal to F x? — actually moment = sum r_i x F_i.
  let moment: Vec3 = [0, 0, 0];
  for (const f of faces) {
    const c = centroid([...f.coords]);
    const fi = scale(f.normal, pressure * f.area);
    moment = add(moment, cross(c, fi));
  }

  return { force, moment, center };
}

export function nodalResultant(
  entries: { coord: Vec3; vector: Vec3 }[]
): { force: Vec3; moment: Vec3 } {
  let force: Vec3 = [0, 0, 0];
  let moment: Vec3 = [0, 0, 0];
  for (const e of entries) {
    force = add(force, e.vector);
    moment = add(moment, cross(e.coord, e.vector));
  }
  return { force, moment };
}

export function vecClose(
  a: Vec3,
  b: Vec3,
  relTol: number,
  absTol: number
): { ok: boolean; error: number; scale: number } {
  const diff = norm(sub(a, b));
  const s = Math.max(norm(a), norm(b));
  const ok = diff <= absTol + relTol * s;
  return { ok, error: diff, scale: s };
}
