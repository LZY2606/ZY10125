import type { Mesh, Vec3 } from './types.js';
import {
  centroid,
  distance,
  dot,
  planeSignedDistance
} from './geometry.js';
import { buildTopology, type MeshTopology, type FaceTopo } from './topology.js';
import { coplanarTriIntersectionArea } from './overlap.js';
import type { Tolerances } from './tolerances.js';

/**
 * Candidate correspondences are geometric evidence only. They are never
 * silently accepted when ambiguous:
 *
 *   1:1   complete  - identity, or a unique geometric relocation
 *   1:N   split     - one old entity fans out to several new entities
 *   N:1   merged    - several old entities collapse onto one new entity
 *   N:M   ambiguous - genuine remesh overlap; engineer must decide
 *   none  unmatched - an entity appears or disappears
 *
 * "Ambiguous" and "unmatched" are normal results. We deliberately do NOT fall
 * back to nearest-neighbour to make every row look green.
 */

export type MatchStatus =
  | 'complete'
  | 'split'
  | 'merged'
  | 'ambiguous'
  | 'unmatched';

export interface NodeCandidate {
  oldId: string | null;
  newId: string | null;
  distance: number;
  /** True when the pair coincides within nodeSnap. */
  snapped: boolean;
}

export interface FaceCandidate {
  oldKey: string | null;
  newKey: string | null;
  planeDistance: number;
  normalDot: number;
  /** Area of the intersection polygon of the coplanar triangles. */
  overlapArea: number;
  oldArea: number;
  newArea: number;
  sharedNodes: number;
  region?: string;
}

export interface ElementCandidate {
  oldId: string | null;
  newId: string | null;
  centroidInside: boolean;
  sharedFaces: number;
  sharedNodes: number;
}

export interface CorrespondenceTable {
  nodeCandidates: NodeCandidate[];
  nodeMap: Map<string, NodeCandidate[]>;
  newNodeMap: Map<string, NodeCandidate[]>;
  faceCandidates: FaceCandidate[];
  faceMap: Map<string, FaceCandidate[]>;
  newFaceMap: Map<string, FaceCandidate[]>;
  elementCandidates: ElementCandidate[];
  elementMap: Map<string, ElementCandidate[]>;
  newElementMap: Map<string, ElementCandidate[]>;
  counts: TopologyDiff;
}

export interface TopologyDiff {
  oldNodes: number;
  newNodes: number;
  oldEdges: number;
  newEdges: number;
  oldFaces: number;
  newFaces: number;
  oldElements: number;
  newElements: number;
  sharedEdges: number;
}

export function buildCorrespondence(
  oldMesh: Mesh,
  newMesh: Mesh,
  tol: Tolerances
): CorrespondenceTable {
  const oldTopo = buildTopology(oldMesh);
  const newTopo = buildTopology(newMesh);

  const nodeCandidates = matchNodes(oldTopo, newTopo, tol);
  const faceCandidates = matchFaces(oldTopo, newTopo, tol);
  const elementCandidates = matchElements(oldTopo, newTopo, tol);

  let sharedEdgeCount = 0;
  for (const e of oldTopo.edges) if (newTopo.edges.has(e)) sharedEdgeCount++;

  return {
    nodeCandidates,
    nodeMap: groupOld(nodeCandidates, (c) => c.oldId),
    newNodeMap: groupNew(nodeCandidates, (c) => c.newId),
    faceCandidates,
    faceMap: groupOld(faceCandidates, (c) => c.oldKey),
    newFaceMap: groupNew(faceCandidates, (c) => c.newKey),
    elementCandidates,
    elementMap: groupOld(elementCandidates, (c) => c.oldId),
    newElementMap: groupNew(elementCandidates, (c) => c.newId),
    counts: {
      oldNodes: oldMesh.nodes.length,
      newNodes: newMesh.nodes.length,
      oldEdges: oldTopo.edges.size,
      newEdges: newTopo.edges.size,
      oldFaces: oldMesh.faces.length,
      newFaces: newMesh.faces.length,
      oldElements: oldMesh.elements.length,
      newElements: newMesh.elements.length,
      sharedEdges: sharedEdgeCount
    }
  };
}

function groupOld<T>(rows: T[], key: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

function groupNew<T>(rows: T[], key: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

/**
 * Node matching.
 *
 * Emits every coincident pair within nodeSnap. When an old node has none we
 * attach a single nearest row flagged snapped=false as evidence only; rules
 * downstream must never copy a fixed constraint onto that nearest node.
 */
function matchNodes(
  oldTopo: MeshTopology,
  newTopo: MeshTopology,
  tol: Tolerances
): NodeCandidate[] {
  const out: NodeCandidate[] = [];
  const matchedNew = new Set<string>();

  for (const on of oldTopo.mesh.nodes) {
    let found = false;
    for (const nn of newTopo.mesh.nodes) {
      const d = distance(on.coord, nn.coord);
      if (d <= tol.nodeSnap) {
        out.push({ oldId: on.id, newId: nn.id, distance: d, snapped: true });
        matchedNew.add(nn.id);
        found = true;
      }
    }
    if (!found) {
      const best = nearest(on.coord, newTopo);
      if (best)
        out.push({ oldId: on.id, newId: best.id, distance: best.d, snapped: false });
    }
  }

  for (const nn of newTopo.mesh.nodes) {
    if (!matchedNew.has(nn.id))
      out.push({ oldId: null, newId: nn.id, distance: 0, snapped: false });
  }
  return out;
}

function nearest(
  coord: Vec3,
  topo: MeshTopology
): { id: string; d: number } | null {
  let best: { id: string; d: number } | null = null;
  for (const n of topo.mesh.nodes) {
    const d = distance(coord, n.coord);
    if (!best || d < best.d) best = { id: n.id, d };
  }
  return best;
}

/**
 * Face matching.
 *
 * Candidates must share a plane (facePlane), parallel normals
 * (normalAngle) and genuinely overlap in area. Exact node coincidence is not
 * required, so refined new faces match the coarse old face they subdivide.
 */
function matchFaces(
  oldTopo: MeshTopology,
  newTopo: MeshTopology,
  tol: Tolerances
): FaceCandidate[] {
  const out: FaceCandidate[] = [];
  const matchedNew = new Set<string>();

  for (const of of oldTopo.faces.values()) {
    const oldCoords = of.wound.map((id) => oldTopo.nodeById.get(id)!.coord) as [
      Vec3,
      Vec3,
      Vec3
    ];
    for (const nf of newTopo.faces.values()) {
      const plane = Math.abs(
        planeSignedDistance(nf.centroid, of.centroid, of.normal)
      );
      if (plane > tol.facePlane) continue;
      const nd = Math.abs(dot(of.normal, nf.normal));
      if (nd < 1 - tol.normalAngle) continue;

      const newCoords = nf.wound.map((id) => newTopo.nodeById.get(id)!.coord) as [
        Vec3,
        Vec3,
        Vec3
      ];
      const overlap = coplanarTriIntersectionArea(oldCoords, newCoords, of.normal);
      const sharedNodes = sharedNodeCount(of.nodes, nf.nodes);

      if (overlap > tol.zeroVolume || sharedNodes === 3) {
        out.push({
          oldKey: of.key,
          newKey: nf.key,
          planeDistance: plane,
          normalDot: nd,
          overlapArea: overlap,
          oldArea: of.area,
          newArea: nf.area,
          sharedNodes,
          region: of.region ?? nf.region
        });
        matchedNew.add(nf.key);
      }
    }
  }

  for (const nf of newTopo.faces.values()) {
    if (!matchedNew.has(nf.key)) {
      out.push({
        oldKey: null,
        newKey: nf.key,
        planeDistance: 0,
        normalDot: 1,
        overlapArea: 0,
        oldArea: 0,
        newArea: nf.area,
        sharedNodes: 0,
        region: nf.region
      });
    }
  }
  return out;
}

export function faceCoords(topo: MeshTopology, f: FaceTopo): [Vec3, Vec3, Vec3] {
  return f.wound.map((id) => topo.nodeById.get(id)!.coord) as [Vec3, Vec3, Vec3];
}

function sharedNodeCount(a: readonly string[], b: readonly string[]): number {
  const set = new Set(b);
  let n = 0;
  for (const x of a) if (set.has(x)) n++;
  return n;
}

/**
 * Element matching.
 *
 * - identical tets: 4 shared nodes;
 * - split/merge: one tet centroid lies inside the other tet;
 * - otherwise unmatched. Ambiguous N:M containment stays many-to-many and is
 *   never force-snapped.
 */
function matchElements(
  oldTopo: MeshTopology,
  newTopo: MeshTopology,
  tol: Tolerances
): ElementCandidate[] {
  const out: ElementCandidate[] = [];
  const matchedNew = new Set<string>();

  const oldTets = [...oldTopo.elements.values()].map((e) => ({
    e,
    coords: e.nodes.map((id) => oldTopo.nodeById.get(id)!.coord) as [
      Vec3,
      Vec3,
      Vec3,
      Vec3
    ]
  }));
  const newTets = [...newTopo.elements.values()].map((e) => {
    const coords = e.nodes.map((id) => newTopo.nodeById.get(id)!.coord) as [
      Vec3,
      Vec3,
      Vec3,
      Vec3
    ];
    return { e, coords, centroid: centroid(coords) };
  });

  for (const ot of oldTets) {
    for (const nt of newTets) {
      const sharedNodes = sharedNodeCount(ot.e.nodes, nt.e.nodes);
      let sharedFaces = 0;
      for (const f of ot.e.faces) if (nt.e.faces.includes(f)) sharedFaces++;

      let inside = false;
      if (sharedNodes === 4) {
        inside = true;
      } else {
        inside =
          pointInTet(nt.centroid, ot.coords, tol.zeroVolume) ||
          pointInTet(centroid(ot.coords), nt.coords, tol.zeroVolume);
      }

      if (sharedNodes === 4 || inside) {
        out.push({
          oldId: ot.e.id,
          newId: nt.e.id,
          centroidInside: inside,
          sharedFaces,
          sharedNodes
        });
        matchedNew.add(nt.e.id);
      }
    }
  }

  for (const nt of newTets) {
    if (!matchedNew.has(nt.e.id))
      out.push({
        oldId: null,
        newId: nt.e.id,
        centroidInside: false,
        sharedFaces: 0,
        sharedNodes: 0
      });
  }
  return out;
}

import { tetBarycentric } from './geometry.js';

function pointInTet(p: Vec3, t: [Vec3, Vec3, Vec3, Vec3], eps: number): boolean {
  const b = tetBarycentric(p, t);
  if (!b) return false;
  const slack = Math.max(eps, 1e-9);
  return b[0] >= -slack && b[1] >= -slack && b[2] >= -slack && b[3] >= -slack;
}

/** Cardinality for one old entity given forward rows and reverse row count. */
export function classifyForward(
  forwardCount: number,
  reverseCount: number
): MatchStatus {
  if (forwardCount === 0) return 'unmatched';
  if (forwardCount === 1 && reverseCount === 1) return 'complete';
  if (forwardCount > 1 && reverseCount === 1) return 'split';
  if (forwardCount === 1 && reverseCount > 1) return 'merged';
  return 'ambiguous';
}
