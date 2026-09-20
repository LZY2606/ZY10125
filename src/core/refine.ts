import type { Element, Face, Mesh, Node, Vec3 } from './types.js';
import {
  add,
  dot,
  faceNormal,
  scale,
  signedTetVolume
} from './geometry.js';

/**
 * Uniform 1->8 tetrahedron refinement.
 *
 * Each tet gains the six edge midpoints: four corner tets and four interior
 * tets (the central octahedron is split along one of three diagonals).
 * Midpoint nodes are globally shared through a coarse-edge table, so adjacent
 * coarse tets produce a conforming refined mesh.
 */
export interface RefinedMesh {
  nodes: Node[];
  elements: Element[];
  faces: Face[];
  cornerMap: Map<string, string>;
  midpointMap: Map<string, string>;
}

export function refineTetMesh(mesh: Mesh, idPrefix = 'r'): RefinedMesh {
  const cornerMap = new Map<string, string>();
  const nodes: Node[] = [];
  const coord = new Map<string, Vec3>();
  for (const n of mesh.nodes) {
    const id = `${idPrefix}${n.id}`;
    cornerMap.set(n.id, id);
    nodes.push({ id, coord: n.coord });
    coord.set(n.id, n.coord);
  }

  const midpointMap = new Map<string, string>();
  let mCount = 0;
  const midpoint = (a: string, b: string): string => {
    const key = [a, b].sort().join('|');
    const existing = midpointMap.get(key);
    if (existing) return existing;
    const id = `${idPrefix}m${mCount++}`;
    nodes.push({ id, coord: scale(add(coord.get(a)!, coord.get(b)!), 0.5) });
    midpointMap.set(key, id);
    return id;
  };

  const elements: Element[] = [];
  let eCount = 0;
  for (const el of mesh.elements) {
    const [A, B, C, D] = el.nodes;
    const a = cornerMap.get(A)!;
    const b = cornerMap.get(B)!;
    const c = cornerMap.get(C)!;
    const d = cornerMap.get(D)!;
    const e = midpoint(A, B);
    const f = midpoint(A, C);
    const g = midpoint(A, D);
    const h = midpoint(B, C);
    const i = midpoint(B, D);
    const j = midpoint(C, D);

    const tets: [string, string, string, string][] = [
      [a, e, f, g],
      [b, h, e, i],
      [c, f, h, j],
      [d, g, i, j],
      [e, f, g, j],
      [e, f, h, j],
      [e, g, i, j],
      [e, h, i, j]
    ];
    const nodeCoord = new Map(nodes.map((n) => [n.id, n.coord]));
    for (const tet of tets) {
      const p = tet.map((id) => nodeCoord.get(id)!) as [
        Vec3,
        Vec3,
        Vec3,
        Vec3
      ];
      const wound = signedTetVolume(p) < 0 ? ([tet[1], tet[0], tet[2], tet[3]] as const) : tet;
      elements.push({ id: `${idPrefix}e${eCount}`, nodes: [...wound] as [string, string, string, string], zone: el.zone });
      eCount++;
    }
  }

  const faces: Face[] = [];
  let fCount = 0;
  const parentNormalById = new Map<string, Vec3>();
  for (const fm of mesh.faces) {
    parentNormalById.set(
      fm.id,
      faceNormal(coord.get(fm.nodes[0])!, coord.get(fm.nodes[1])!, coord.get(fm.nodes[2])!)
    );
    const [a0, b0, c0] = fm.nodes;
    const a = cornerMap.get(a0)!;
    const b = cornerMap.get(b0)!;
    const c = cornerMap.get(c0)!;
    const e = midpoint(a0, b0);
    const f = midpoint(a0, c0);
    const h = midpoint(b0, c0);
    const parentN = parentNormalById.get(fm.id)!;
    const nodeCoord = new Map(nodes.map((n) => [n.id, n.coord]));
    const tris: [string, string, string][] = [
      [a, e, f],
      [e, b, h],
      [f, h, c],
      [e, h, f]
    ];
    for (const tri of tris) {
      const n = faceNormal(nodeCoord.get(tri[0])!, nodeCoord.get(tri[1])!, nodeCoord.get(tri[2])!);
      const wound = dot(n, parentN) < 0 ? ([tri[1], tri[0], tri[2]] as const) : tri;
      faces.push({ id: `${idPrefix}f${fCount}`, nodes: [...wound] as [string, string, string], region: fm.region });
      fCount++;
    }
  }

  return { nodes, elements, faces, cornerMap, midpointMap };
}

export function buildRefinedMesh(
  coarse: Mesh,
  meta: { id: string; name: string },
  idPrefix = 'r'
): Mesh {
  const r = refineTetMesh(coarse, idPrefix);
  return {
    schema: 'fem-json/1',
    id: meta.id,
    name: meta.name,
    nodes: r.nodes,
    elements: r.elements,
    faces: r.faces,
    zones: coarse.zones,
    loads: [],
    constraints: [],
    probes: [],
    boundaryRegions: coarse.boundaryRegions
  };
}
