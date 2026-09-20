import type { Vec3 } from './types.js';
import { cross, dot, normalize, sub } from './geometry.js';

export interface Point2 {
  x: number;
  y: number;
}

/**
 * Build an orthonormal 2D basis (u, v) for the plane with unit normal n.
 */
export function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(n, ref));
  const v = cross(n, u);
  return { u, v };
}

export function project(p: Vec3, origin: Vec3, u: Vec3, v: Vec3): Point2 {
  const d = sub(p, origin);
  return { x: dot(d, u), y: dot(d, v) };
}

export function polygonArea(poly: Point2[]): number {
  if (poly.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

type Edge = { a: Point2; b: Point2 };

function inside(p: Point2, e: Edge): boolean {
  // Interior of a CCW polygon is to the LEFT of directed edge a->b.
  return cross2(sub2(e.b, e.a), sub2(p, e.a)) >= -1e-11;
}

function sub2(p: Point2, q: Point2): Point2 {
  return { x: p.x - q.x, y: p.y - q.y };
}

function cross2(a: Point2, b: Point2): number {
  return a.x * b.y - a.y * b.x;
}

function intersectEdge(p: Point2, q: Point2, e: Edge): Point2 {
  const r = sub2(q, p);
  const s = sub2(e.b, e.a);
  const denom = cross2(r, s);
  const t = cross2(sub2(e.a, p), s) / denom;
  return { x: p.x + t * r.x, y: p.y + t * r.y };
}

/** Sutherland-Hodgman clip of a convex subject polygon by one half-plane. */
function clip(poly: Point2[], e: Edge): Point2[] {
  if (poly.length === 0) return poly;
  const out: Point2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const curIn = inside(cur, e);
    const prevIn = inside(prev, e);
    if (curIn) {
      if (!prevIn) out.push(intersectEdge(prev, cur, e));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersectEdge(prev, cur, e));
    }
  }
  return out;
}

/**
 * Intersection area of two coplanar triangles defined by 3D coordinates.
 * The plane normal is taken from the old triangle.
 */
export function coplanarTriIntersectionArea(
  oldTri: [Vec3, Vec3, Vec3],
  newTri: [Vec3, Vec3, Vec3],
  normal: Vec3
): number {
  const { u, v } = planeBasis(normal);
  const origin = oldTri[0]!;
  const clipPoly = oldTri.map((p) => project(p, origin, u, v));
  let subject = newTri.map((p) => project(p, origin, u, v));

  // Clip by each directed edge of the old triangle.
  for (let i = 0; i < 3; i++) {
    const a = clipPoly[i]!;
    const b = clipPoly[(i + 1) % 3]!;
    subject = clip(subject, { a, b });
    if (subject.length === 0) return 0;
  }
  return polygonArea(subject);
}
