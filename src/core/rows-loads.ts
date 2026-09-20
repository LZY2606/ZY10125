import type {
  FacePressureLoad,
  Mesh,
  NodalForceLoad,
  Vec3
} from './types.js';
import { buildTopology, type MeshTopology } from './topology.js';
import { pressureResultant, nodalResultant, vecClose } from './mechanics.js';
import type {
  FacePressureRow,
  NodalForceRow,
  ProposedChildFace
} from './plan-types.js';
import type { CorrespondenceTable, FaceCandidate } from './correspondence.js';
import type { Tolerances } from './tolerances.js';

/**
 * Face-pressure migration.
 *
 * Each old face is covered by the overlapping new faces whose union contains
 * it. A single pressure scalar is assigned to every child face; the resultant
 * force and moment must be conserved within the frozen tolerances. A child
 * whose normal is reversed relative to the old face is rejected (it would
 * pull the resultant the wrong way).
 */
export function buildFacePressureRow(
  load: FacePressureLoad,
  oldMesh: Mesh,
  newTopo: MeshTopology,
  corr: CorrespondenceTable,
  tol: Tolerances
): FacePressureRow {
  const oldTopo = buildTopology(oldMesh);
  const proposed: ProposedChildFace[] = [];
  const proposedKeys = new Set<string>();
  const uncoveredOldFaces: string[] = [];
  const reasons: string[] = [];

  let coveredOldArea = 0;
  let oldAreaTotal = 0;

  for (const oldKey of load.faces) {
    const oldFace = oldTopo.faces.get(oldKey);
    if (!oldFace) {
      uncoveredOldFaces.push(oldKey);
      reasons.push(`old face ${oldKey.slice(0, 18)} is missing on the mesh`);
      continue;
    }
    oldAreaTotal += oldFace.area;
    const candidates = (corr.faceMap.get(oldKey) ?? []).filter(
      (c) => c.newKey != null
    );

    let faceCovered = 0;
    for (const c of candidates) {
      if (!isUsableChild(c, tol)) continue;
      faceCovered += c.overlapArea;
      if (!proposedKeys.has(c.newKey!)) {
        proposedKeys.add(c.newKey!);
        const nf = newTopo.faces.get(c.newKey!)!;
        proposed.push({
          faceKey: c.newKey!,
          area: nf.area,
          pressure: load.pressure,
          overlapArea: c.overlapArea
        });
      }
    }

    const coverage = oldFace.area > 0 ? Math.min(1, faceCovered / oldFace.area) : 1;
    coveredOldArea += Math.min(faceCovered, oldFace.area);
    if (coverage < tol.faceCoverage) {
      uncoveredOldFaces.push(oldKey);
      reasons.push(
        `old face ${oldKey.slice(0, 18)} only ${(coverage * 100).toFixed(2)}% covered by ${candidates.length} candidate(s)`
      );
    }
  }

  const candidatesView = load.faces.flatMap((k) =>
    (corr.faceMap.get(k) ?? [])
      .filter((c) => c.newKey)
      .map((c) => ({
        target: c.newKey!,
        detail: `overlap ${(c.overlapArea * 1e6).toFixed(1)} mm²-equivalent, normal dot ${c.normalDot.toFixed(6)}`,
        metric: c.overlapArea,
        metricLabel: 'overlapArea'
      }))
  );

  const conservation = conservationCheck(
    load,
    oldTopo,
    newTopo,
    proposed,
    tol
  );

  const coverage = oldAreaTotal > 0 ? coveredOldArea / oldAreaTotal : 1;
  const uniqueOld = new Set(load.faces).size;
  let status: FacePressureRow['status'];
  if (proposed.length === 0) {
    status = 'unmatched';
    reasons.push('no geometrically overlapping new face');
  } else if (uncoveredOldFaces.length > 0 || !conservation.forceOk || !conservation.momentOk) {
    status = 'ambiguous';
    if (!conservation.forceOk)
      reasons.push(`resultant force error ${conservation.forceError.toExponential(3)} exceeds tolerance`);
    if (!conservation.momentOk)
      reasons.push(`resultant moment error ${conservation.momentError.toExponential(3)} exceeds tolerance`);
  } else if (proposed.length === 1 && uniqueOld === 1) {
    status = 'complete';
  } else if (proposed.length > uniqueOld) {
    status = 'split';
    reasons.push(`distributed over ${proposed.length} new faces with conserved resultant`);
  } else if (proposed.length < uniqueOld) {
    status = 'merged';
    reasons.push(`${uniqueOld} old faces collapse onto ${proposed.length} new faces with conserved resultant`);
  } else {
    status = 'complete';
  }

  return {
    kind: 'facePressure',
    id: load.id,
    label: `pressure ${load.pressure} on ${uniqueOld} face(s)`,
    status,
    reasons,
    candidates: dedupeCandidates(candidatesView),
    oldFaces: load.faces,
    proposed,
    coverage,
    uncoveredOldFaces,
    conservation
  };
}

function isUsableChild(c: FaceCandidate, tol: Tolerances): boolean {
  // normals must point the same way (dot near +1); a flipped child is rejected
  if (c.normalDot < 1 - tol.normalAngle) return false;
  return c.overlapArea > tol.zeroVolume;
}

function dedupeCandidates(
  rows: { target: string; detail: string; metric: number; metricLabel: string }[]
) {
  const seen = new Set<string>();
  const out: typeof rows = [];
  for (const r of rows) {
    if (seen.has(r.target)) continue;
    seen.add(r.target);
    out.push(r);
  }
  return out;
}

function conservationCheck(
  load: FacePressureLoad,
  oldTopo: MeshTopology,
  newTopo: MeshTopology,
  proposed: ProposedChildFace[],
  tol: Tolerances
) {
  const oldFaceData = load.faces
    .map((k) => oldTopo.faces.get(k))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f) => ({
      coords: f.wound.map((id) => oldTopo.nodeById.get(id)!.coord) as [
        Vec3,
        Vec3,
        Vec3
      ],
      area: f.area,
      normal: f.normal
    }));
  const oldRes = pressureResultant(oldFaceData, load.pressure);

  const newFaceData = proposed.map((p) => {
    const f = newTopo.faces.get(p.faceKey)!;
    return {
      coords: f.wound.map((id) => newTopo.nodeById.get(id)!.coord) as [
        Vec3,
        Vec3,
        Vec3
      ],
      area: f.area,
      normal: f.normal
    };
  });
  const newRes = pressureResultant(newFaceData, load.pressure);

  const fcheck = vecClose(oldRes.force, newRes.force, tol.forceRelTol, tol.forceAbsTol);
  const mcheck = vecClose(oldRes.moment, newRes.moment, tol.momentRelTol, tol.momentAbsTol);

  return {
    oldForce: oldRes.force,
    newForce: newRes.force,
    forceError: fcheck.error,
    forceScale: fcheck.scale,
    forceOk: fcheck.ok,
    oldMoment: oldRes.moment,
    newMoment: newRes.moment,
    momentError: mcheck.error,
    momentScale: mcheck.scale,
    momentOk: mcheck.ok
  };
}

/**
 * Nodal-force migration. A nodal force is a vector pinned to one point. It is
 * complete only when that node is geometrically unique on the new mesh;
 * multiple coincident targets or only a "nearest" target are rejected.
 */
export function buildNodalForceRow(
  load: NodalForceLoad,
  oldMesh: Mesh,
  corr: CorrespondenceTable,
  tol: Tolerances
): NodalForceRow {
  const oldNode = oldMesh.nodes.find((n) => n.id === load.node);
  const candidates = (corr.nodeMap.get(load.node) ?? []).filter(
    (c) => c.newId
  );
  const snapped = candidates.filter((c) => c.snapped);
  const reasons: string[] = [];

  let status: NodalForceRow['status'] = 'unmatched';
  let newNode: string | null = null;

  if (snapped.length === 1) {
    status = 'complete';
    newNode = snapped[0]!.newId;
  } else if (snapped.length > 1) {
    status = 'ambiguous';
    reasons.push(`node coincides with ${snapped.length} new nodes; engineer must choose`);
  } else if (candidates.length === 1) {
    status = 'ambiguous';
    reasons.push(
      `no coincident node; nearest is ${candidates[0]!.newId} at distance ${candidates[0]!.distance.toExponential(3)} (> nodeSnap ${tol.nodeSnap})`
    );
  } else {
    reasons.push('node disappeared from the new mesh');
  }

  const oldCoord = oldNode!.coord;
  const oldRes = nodalResultant([{ coord: oldCoord, vector: load.vector }]);
  const newRes = newNode
    ? nodalResultant([{ coord: oldCoord, vector: load.vector }])
    : { force: [0, 0, 0] as Vec3, moment: [0, 0, 0] as Vec3 };
  const fc = vecClose(oldRes.force, newRes.force, tol.forceRelTol, tol.forceAbsTol);
  const mc = vecClose(oldRes.moment, newRes.moment, tol.momentRelTol, tol.momentAbsTol);

  return {
    kind: 'nodalForce',
    id: load.id,
    label: `force (${load.vector.join(', ')}) @ ${load.node}`,
    status,
    reasons,
    candidates: candidates.map((c) => ({
      target: c.newId!,
      detail: c.snapped ? 'coincident node' : `nearest only, d=${c.distance.toExponential(3)}`,
      metric: c.distance,
      metricLabel: 'distance'
    })),
    oldNode: load.node,
    newNode,
    vector: load.vector,
    conservation: {
      oldForce: oldRes.force,
      newForce: newRes.force,
      forceError: fc.error,
      forceScale: fc.scale,
      forceOk: fc.ok && newNode != null,
      oldMoment: oldRes.moment,
      newMoment: newRes.moment,
      momentError: mc.error,
      momentScale: mc.scale,
      momentOk: mc.ok && newNode != null
    }
  };
}
