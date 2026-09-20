import type { Vec3 } from './types.js';

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function distance(a: Vec3, b: Vec3): number {
  return norm(sub(a, b));
}

export function centroid(points: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return scale(c, 1 / points.length);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n === 0 ? [0, 0, 0] : scale(a, 1 / n);
}

export function triArea(a: Vec3, b: Vec3, c: Vec3): number {
  return norm(cross(sub(b, a), sub(c, a))) / 2;
}

/**
 * Signed tetrahedron volume for nodes ordered [p0, p1, p2, p3].
 * Positive when p3 lies on the side opposite a right-handed p0-p1-p2 normal.
 */
export function signedTetVolume(p: [Vec3, Vec3, Vec3, Vec3]): number {
  return dot(sub(p[1], p[0]), cross(sub(p[2], p[0]), sub(p[3], p[0]))) / 6;
}

export function tetVolume(p: [Vec3, Vec3, Vec3, Vec3]): number {
  return Math.abs(signedTetVolume(p));
}

/** Unit outward normal of a wound triangle. */
export function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}

export function allClose(a: Vec3, b: Vec3, tol: number): boolean {
  return distance(a, b) <= tol;
}

/** True if n1,n2 point in (nearly) the same or opposite direction. */
export function normalsParallel(n1: Vec3, n2: Vec3, tol: number): boolean {
  return Math.abs(dot(n1, n2)) >= 1 - tol;
}

/**
 * Barycentric containment of a point in a tetrahedron.
 * Returns barycentric coordinates (sum 1) when inside, otherwise null.
 */
export function tetBarycentric(
  p: Vec3,
  t: [Vec3, Vec3, Vec3, Vec3]
): [number, number, number, number] | null {
  const [a, b, c, d] = t;
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(d, a);
  const vp = sub(p, a);
  const det = dot(v0, cross(v1, v2));
  if (det === 0) return null;
  const l1 = dot(vp, cross(v1, v2)) / det;
  const l2 = dot(v0, cross(vp, v2)) / det;
  const l3 = dot(v0, cross(v1, vp)) / det;
  const l0 = 1 - l1 - l2 - l3;
  const eps = 1e-9;
  if (l0 < -eps || l1 < -eps || l2 < -eps || l3 < -eps) return null;
  return [l0, l1, l2, l3];
}

/**
 * Signed distance from point p to plane through a with unit normal n.
 */
export function planeSignedDistance(p: Vec3, a: Vec3, n: Vec3): number {
  return dot(sub(p, a), n);
}
