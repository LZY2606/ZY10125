import type { Element, Face, Mesh, Node, Vec3, Zone } from './types.js';
import { faceKey } from './types.js';
import { faceNormal, signedTetVolume } from './geometry.js';

/**
 * Unit cube decomposed into 5 tets: one central regular tetrahedron on the
 * even-parity cube vertices (0,2,5,7), plus four corner tets at the odd
 * vertices 1,3,4,6. Each tuple is stored UNORDERED and oriented at build time
 * so every signed volume is positive.
 *
 *   (0,0,0)=0  (1,0,0)=1  (1,1,0)=2  (0,1,0)=3
 *   (0,0,1)=4  (1,0,1)=5  (1,1,1)=6  (0,1,1)=7
 */
export const CUBE_CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1]
];

const CUBE_TET_SETS: [number, number, number, number][] = [
  [0, 1, 2, 5],
  [0, 2, 3, 7],
  [0, 4, 5, 7],
  [2, 5, 6, 7],
  [0, 2, 5, 7]
];

function orientPositive(
  tet: [number, number, number, number],
  corners: Vec3[]
): [number, number, number, number] {
  const p = tet.map((i) => corners[i]!) as [Vec3, Vec3, Vec3, Vec3];
  return signedTetVolume(p) < 0 ? [tet[1], tet[0], tet[2], tet[3]] : tet;
}

export const CUBE_5TETS: [number, number, number, number][] = CUBE_TET_SETS.map(
  (t) => orientPositive(t, CUBE_CORNERS)
);

export type CubeRegion = 'bottom' | 'top' | 'front' | 'back' | 'left' | 'right';

const REGION_NORMALS: Record<CubeRegion, Vec3> = {
  bottom: [0, 0, -1],
  top: [0, 0, 1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0]
};

let faceCounter = 0;
export function resetFaceCounter(): void {
  faceCounter = 0;
}

export function cubeNodes(prefix: string, corners: Vec3[] = CUBE_CORNERS): Node[] {
  return corners.map((coord, i) => ({ id: `${prefix}n${i}`, coord }));
}

export function cubeElements(prefix: string, zone: string): Element[] {
  return CUBE_5TETS.map((tet, i) => ({
    id: `${prefix}e${i}`,
    nodes: tet.map((n) => `${prefix}n${n}`) as [string, string, string, string],
    zone
  }));
}

export function cubeZones(zone = 'solid'): Zone[] {
  return [{ id: zone, name: zone, material: { E: 2.1e5, nu: 0.3 } }];
}

/**
 * Boundary faces are derived, not hard-coded: a tri used by exactly one tet is
 * on the surface. It is then oriented to point along the cube-face normal and
 * named from that normal. This guarantees face/tet topology consistency.
 */
export function cubeBoundaryFaces(
  prefix: string,
  regionFor?: (name: string) => string | undefined,
  corners: Vec3[] = CUBE_CORNERS
): Face[] {
  // For each oriented tet face record (sortedKey, wound-as-in-tet, ownerTet,
  // opposite vertex). A face used once is a boundary face; orient it so its
  // normal points AWAY from the owner tet's opposite vertex.
  interface Occ {
    sorted: [number, number, number];
    owner: [number, number, number, number];
    opposite: number;
    count: number;
  }
  const occurrence = new Map<string, Occ>();
  for (const tet of CUBE_5TETS) {
    for (let k = 0; k < 4; k++) {
      const faceVerts = tet.filter((_, i) => i !== k) as [number, number, number];
      const opposite = tet[k]!;
      const sorted = faceVerts.slice().sort((a, b) => a - b) as [number, number, number];
      const key = sorted.join(',');
      const prior = occurrence.get(key);
      if (prior) prior.count++;
      else occurrence.set(key, { sorted, owner: tet, opposite, count: 1 });
    }
  }

  const out: Face[] = [];
  const boundary = [...occurrence.values()].filter((o) => o.count === 1);
  boundary.sort((a, b) => a.sorted.join(',').localeCompare(b.sorted.join(',')));
  for (const o of boundary) {
    const [x, y, z] = o.sorted;
    // Choose the winding whose normal points away from the owner tet's
    // opposite vertex.
    const winding = (w: [number, number, number]): boolean => {
      const [p0, p1, p2] = w.map((i) => corners[i]!) as [Vec3, Vec3, Vec3];
      const n = faceNormal(p0, p1, p2);
      const opp = corners[o.opposite]!;
      return dot3(n, [opp[0] - p0[0], opp[1] - p0[1], opp[2] - p0[2]]) < 0;
    };
    let wound: [number, number, number] = [x, y, z];
    if (!winding(wound)) wound = [y, x, z];
    const orientedN = faceNormal(
      corners[wound[0]]!,
      corners[wound[1]]!,
      corners[wound[2]]!
    );
    const region = regionFromNormal(orientedN);
    faceCounter++;
    out.push({
      id: `${prefix}f${faceCounter}`,
      nodes: wound.map((i) => `${prefix}n${i}`) as [string, string, string],
      region: regionFor ? regionFor(region) : region
    });
  }
  return out;
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The four outward-oriented faces of one tet (winding from TET_FACES may be
 *  either sign; orientation to the cube normal happens afterwards). */
function tetFaces(tet: [number, number, number, number]): [number, number, number][] {
  const [a, b, c, d] = tet;
  return [
    [a, b, c],
    [a, b, d],
    [a, c, d],
    [b, c, d]
  ];
}

function regionFromNormal(n: Vec3): CubeRegion {
  let best: CubeRegion = 'bottom';
  let bestDot = -Infinity;
  for (const [name, ref] of Object.entries(REGION_NORMALS)) {
    const d = dot3(n, ref);
    if (d > bestDot) {
      bestDot = d;
      best = name as CubeRegion;
    }
  }
  return best;
}

export function assembleCube(opts: {
  id: string;
  name: string;
  prefix: string;
  corners?: Vec3[];
  zone?: string;
  regionFor?: (name: string) => string | undefined;
  mesh?: Partial<Mesh>;
}): Mesh {
  resetFaceCounter();
  const corners = opts.corners ?? CUBE_CORNERS;
  return {
    schema: 'fem-json/1',
    id: opts.id,
    name: opts.name,
    nodes: cubeNodes(opts.prefix, corners),
    elements: cubeElements(opts.prefix, opts.zone ?? 'solid'),
    faces: cubeBoundaryFaces(opts.prefix, opts.regionFor, corners),
    zones: cubeZones(opts.zone ?? 'solid'),
    loads: [],
    constraints: [],
    probes: [],
    boundaryRegions: [],
    ...opts.mesh
  };
}

export { faceKey };
