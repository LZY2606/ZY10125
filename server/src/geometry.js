// 纯函数几何工具。
// 坐标约定：右手笛卡尔坐标系，长度单位 m；tri3 三节点、tet4 四节点。
// tet4 方向约定：det([b-a, c-a, d-a]) > 0 为方向正确（有符号体积 > 0）。

export function vec(a, b) {
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}
export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function norm(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
export function dist(a, b) {
  return norm(vec(a, b));
}
export function det3(a, b, c) {
  return dot(cross(a, b), c);
}
export function centroid(points) {
  const c = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return scale(c, 1 / points.length);
}

// 有符号体积，正号代表节点顺序符合上述方向约定。
export function signedTetVolume(a, b, c, d) {
  return det3(vec(a, b), vec(a, c), vec(a, d)) / 6;
}

export function triArea(a, b, c) {
  return norm(cross(vec(a, b), vec(a, c))) / 2;
}

// 求 M x = r，M 的三列由 col0..col2 给出。返回 null 表示奇异。
function solve3(col0, col1, col2, r) {
  const det = det3(col0, col1, col2);
  if (Math.abs(det) < 1e-30) return null;
  const x = det3(r, col1, col2) / det;
  const y = det3(col0, r, col2) / det;
  const z = det3(col0, col1, r) / det;
  return [x, y, z];
}

// 点在四面体内部或表面上（重心坐标 >= -tol）。
export function pointInTet(p, t, tol = 1e-9) {
  const [a, b, c, d] = t;
  const sol = solve3(vec(a, b), vec(a, c), vec(a, d), vec(a, p));
  if (!sol) return false;
  const [lb, lc, ld] = sol;
  const la = 1 - lb - lc - ld;
  return (
    la >= -tol && lb >= -tol && lc >= -tol && ld >= -tol &&
    la <= 1 + tol && lb <= 1 + tol && lc <= 1 + tol && ld <= 1 + tol
  );
}

// 点在三角形上（含边与顶点），tol 为绝对距离容差。
export function pointOnTriangle(p, tri, tol = 1e-9) {
  const [a, b, c] = tri;
  const v0 = vec(a, b);
  const v1 = vec(a, c);
  const v2 = vec(a, p);
  const n = cross(v0, v1);
  const area2 = norm(n);
  if (area2 < 1e-30) return false;
  if (Math.abs(dot(n, v2)) / area2 > tol) return false; // 离面距离
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-30) return false;
  const beta = (d11 * d20 - d01 * d21) / denom;
  const gamma = (d00 * d21 - d01 * d20) / denom;
  const alpha = 1 - beta - gamma;
  return alpha >= -tol && beta >= -tol && gamma >= -tol;
}

export function distancePointSegment(p, a, b) {
  const ab = vec(a, b);
  const len2 = dot(ab, ab);
  if (len2 < 1e-30) return dist(p, a);
  const t = Math.min(1, Math.max(0, dot(vec(a, p), ab) / len2));
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return dist(p, q);
}

// 点在线段上（共线且投影落在段内）。
export function pointOnSegment(p, a, b, tol = 1e-9) {
  return distancePointSegment(p, a, b) <= tol;
}

// 顶点集合之间的对称 Hausdorff 距离（长度口径）。
export function hausdorff(setA, setB) {
  let h = 0;
  for (const p of setA) {
    let best = Infinity;
    for (const q of setB) best = Math.min(best, dist(p, q));
    h = Math.max(h, best);
  }
  for (const p of setB) {
    let best = Infinity;
    for (const q of setA) best = Math.min(best, dist(p, q));
    h = Math.max(h, best);
  }
  return h;
}
