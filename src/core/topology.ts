import type { Face, Mesh, Node, Vec3 } from './types.js';
import { faceKey } from './types.js';
import {
  faceNormal,
  signedTetVolume,
  triArea
} from './geometry.js';

export interface FaceTopo {
  key: string;
  /** Sorted node tuple (orientation-insensitive identity). */
  nodes: [string, string, string];
  /** Wound node tuple as declared (carries the outward normal orientation). */
  wound: [string, string, string];
  region?: string;
  /** Element ids that reference this face, each with relative orientation. */
  elementRefs: { elementId: string; sameSide: boolean }[];
  centroid: Vec3;
  normal: Vec3;
  area: number;
}

export interface ElementTopo {
  id: string;
  nodes: [string, string, string, string];
  zone: string;
  signedVolume: number;
  volume: number;
  /** Boundary face keys belonging to this element. */
  faces: string[];
}

export interface MeshTopology {
  mesh: Mesh;
  nodeById: Map<string, Node>;
  elements: Map<string, ElementTopo>;
  faces: Map<string, FaceTopo>;
  facesByRegion: Map<string, string[]>;
  /** All edges as orientation-insensitive keys. */
  edges: Set<string>;
  totalVolume: number;
}

const TET_FACES: [number, number, number][] = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [0, 3, 2]
];

/** Face winding from the tet such that each normal points outward. */
export function tetBoundaryFaces(nodes: readonly string[]): string[][] {
  return TET_FACES.map((tri) => tri.map((i) => nodes[i]!));
}

export function buildTopology(mesh: Mesh): MeshTopology {
  const nodeById = new Map<string, Node>();
  for (const n of mesh.nodes) nodeById.set(n.id, n);

  const faces = new Map<string, FaceTopo>();
  const facesByRegion = new Map<string, string[]>();

  for (const f of mesh.faces) {
    const key = faceKey(f.nodes);
    if (f.nodes.some((id) => !nodeById.has(id))) continue;
    const coords = f.nodes.map((id) => nodeById.get(id)!.coord) as [
      Vec3,
      Vec3,
      Vec3
    ];
    const sorted = [...f.nodes].sort() as [string, string, string];
    const topo: FaceTopo = {
      key,
      nodes: sorted,
      wound: [...f.nodes] as [string, string, string],
      region: f.region,
      elementRefs: [],
      centroid: [
        (coords[0][0] + coords[1][0] + coords[2][0]) / 3,
        (coords[0][1] + coords[1][1] + coords[2][1]) / 3,
        (coords[0][2] + coords[1][2] + coords[2][2]) / 3
      ],
      normal: faceNormal(coords[0], coords[1], coords[2]),
      area: triArea(coords[0], coords[1], coords[2])
    };
    faces.set(key, topo);
    if (f.region) {
      const list = facesByRegion.get(f.region) ?? [];
      list.push(key);
      facesByRegion.set(f.region, list);
    }
  }

  const elements = new Map<string, ElementTopo>();
  const edges = new Set<string>();
  let totalVolume = 0;

  for (const el of mesh.elements) {
    if (el.nodes.some((id) => !nodeById.has(id))) continue;
    const coords = el.nodes.map((id) => nodeById.get(id)!.coord) as [
      Vec3,
      Vec3,
      Vec3,
      Vec3
    ];
    const signedVolume = signedTetVolume(coords);
    const volume = Math.abs(signedVolume);
    totalVolume += volume;

    const boundaryFaces = tetBoundaryFaces(el.nodes);
    const ownFaceKeys: string[] = [];
    for (const tri of boundaryFaces) {
      const key = faceKey(tri);
      ownFaceKeys.push(key);
      const ft = faces.get(key);
      if (ft) {
        // The element face is outward-oriented; the declared boundary face is
        // outward-oriented. Same winding => same side, otherwise flipped.
        const sameSide = tri.join(',') === ft.wound.join(',');
        ft.elementRefs.push({ elementId: el.id, sameSide });
      }
    }

    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const [a, b] = [el.nodes[i]!, el.nodes[j]!].sort();
        edges.add(`${a}|${b}`);
      }
    }

    elements.set(el.id, {
      id: el.id,
      nodes: el.nodes,
      zone: el.zone,
      signedVolume,
      volume,
      faces: ownFaceKeys
    });
  }

  return { mesh, nodeById, elements, faces, facesByRegion, edges, totalVolume };
}

export function faceOfMesh(mesh: Mesh, key: string): Face | undefined {
  return mesh.faces.find((f) => faceKey(f.nodes) === key);
}
