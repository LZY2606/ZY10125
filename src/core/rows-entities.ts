import type { Constraint, Mesh, Probe, Vec3 } from './types.js';
import { buildTopology, type MeshTopology } from './topology.js';
import { distance } from './geometry.js';
import type { ConstraintRow, ProbeRow, ZoneRow } from './plan-types.js';
import type { CorrespondenceTable } from './correspondence.js';
import type { Tolerances } from './tolerances.js';

/**
 * Nodal constraint migration.
 *
 * A fixed-DOF condition must NEVER be duplicated: it transfers only when the
 * node coincides with exactly one new node. If it merely has a nearest
 * neighbour that belongs elsewhere, the row is rejected (unmatched/ambiguous)
 * instead of being copied onto that neighbour.
 */
export function buildConstraintRow(
  con: Constraint,
  oldMesh: Mesh,
  corr: CorrespondenceTable
): ConstraintRow {
  void oldMesh;
  const candidates = (corr.nodeMap.get(con.node) ?? []).filter((c) => c.newId);
  const snapped = candidates.filter((c) => c.snapped);
  const reasons: string[] = [];
  let status: ConstraintRow['status'];
  let newNode: string | null = null;

  if (snapped.length === 1) {
    status = 'complete';
    newNode = snapped[0]!.newId;
  } else if (snapped.length > 1) {
    status = 'ambiguous';
    reasons.push(`${snapped.length} coincident new nodes claim this fixed node`);
  } else if (candidates.length >= 1) {
    status = 'unmatched';
    reasons.push(
      `only a nearest neighbour exists (d=${candidates[0]!.distance.toExponential(3)}); fixity is not copied to avoid duplication`
    );
  } else {
    status = 'unmatched';
    reasons.push('node disappeared from the new mesh');
  }

  return {
    kind: 'constraint',
    id: con.id,
    label: `fix ${con.fixed.join('+')} @ ${con.node}`,
    status,
    reasons,
    candidates: candidates.map((c) => ({
      target: c.newId!,
      detail: c.snapped ? 'coincident node' : 'nearest only (not eligible)',
      metric: c.distance,
      metricLabel: 'distance'
    })),
    oldNode: con.node,
    newNode,
    fixed: con.fixed
  };
}

/**
 * Probe migration. A probe is a free measurement point, so it is snapped to
 * the nearest new node when within probeSnap. A point that lands on a newly
 * inserted node is a legitimate relocation; one that stays far away is
 * rejected and must be rebuilt.
 */
export function buildProbeRow(
  probe: Probe,
  newMesh: Mesh,
  tol: Tolerances
): ProbeRow {
  let best: { id: string; d: number } | null = null;
  for (const n of newMesh.nodes) {
    const d = distance(probe.coord, n.coord);
    if (!best || d < best.d) best = { id: n.id, d };
  }
  const reasons: string[] = [];
  let status: ProbeRow['status'];
  let newNode: string | null = null;
  if (best && best.d <= tol.probeSnap) {
    status = 'complete';
    newNode = best.id;
  } else {
    status = 'unmatched';
    reasons.push(
      `no new node within probeSnap ${tol.probeSnap} (best ${best?.d.toExponential(3)})`
    );
  }
  return {
    kind: 'probe',
    id: probe.id,
    label: probe.label,
    status,
    reasons,
    candidates: best ? [{ target: best.id, detail: 'nearest node', metric: best.d, metricLabel: 'distance' }] : [],
    coord: probe.coord as Vec3,
    newNode,
    distance: best?.d ?? Number.POSITIVE_INFINITY
  };
}

/**
 * Material-zone migration.
 *
 * Every new element is assigned to the zone whose old element fully contains
 * its centroid (or which is identical). The zone migrates completely only when
 * every old element has at least one new child AND no new element is claimed
 * by two zones. A genuine merge (coarse mesh collapses the partition) is
 * reported as merged, not hidden.
 */
export function buildZoneRow(
  zoneId: string,
  oldMesh: Mesh,
  newMesh: Mesh,
  corr: CorrespondenceTable,
  tol: Tolerances
): ZoneRow {
  const oldElementIds = oldMesh.elements
    .filter((e) => e.zone === zoneId)
    .map((e) => e.id);
  const newElementIds: string[] = [];
  const uncoveredElements: string[] = [];
  const reasons: string[] = [];

  const claimedByZone = new Map<string, Set<string>>();
  for (const el of newMesh.elements) {
    const zones = elementCandidateZones(el.id, oldMesh, corr);
    for (const z of zones) {
      const set = claimedByZone.get(z) ?? new Set<string>();
      set.add(el.id);
      claimedByZone.set(z, set);
    }
  }

  const claimed = claimedByZone.get(zoneId) ?? new Set<string>();
  for (const id of claimed) newElementIds.push(id);
  newElementIds.sort();

  for (const oldId of oldElementIds) {
    const hasChild = (corr.elementMap.get(oldId) ?? []).some((c) => c.newId);
    if (!hasChild) uncoveredElements.push(oldId);
  }

  // Detect a new element claimed by this zone and another zone.
  for (const elId of newElementIds) {
    const others = elementCandidateZones(elId, oldMesh, corr);
    if (others.length > 1)
      reasons.push(`new element ${elId} is claimed by zones ${others.join(', ')}`);
  }

  const candidateCount = oldElementIds.reduce(
    (n, id) => n + (corr.elementMap.get(id) ?? []).filter((c) => c.newId).length,
    0
  );

  let status: ZoneRow['status'];
  if (newElementIds.length === 0) {
    status = 'unmatched';
    reasons.push('no new element falls inside this zone');
  } else if (reasons.some((r) => r.includes('claimed by zones'))) {
    status = 'ambiguous';
  } else if (uncoveredElements.length > 0) {
    status = tol.zoneFullCoverage ? 'ambiguous' : 'split';
    reasons.push(`${uncoveredElements.length} old element(s) have no child`);
  } else if (
    newElementIds.length === oldElementIds.length &&
    candidateCount === oldElementIds.length
  ) {
    status = 'complete';
  } else if (newElementIds.length < oldElementIds.length) {
    status = 'merged';
  } else {
    status = 'split';
  }

  return {
    kind: 'zone',
    id: `zone:${zoneId}`,
    label: `zone ${zoneId}`,
    status,
    reasons,
    candidates: newElementIds.map((id) => ({
      target: id,
      detail: 'centroid inside / identical element',
      metric: 1,
      metricLabel: 'containment'
    })),
    zoneId,
    oldElementCount: oldElementIds.length,
    newElementIds,
    uncoveredElements
  };
}

function elementCandidateZones(
  newElementId: string,
  oldMesh: Mesh,
  corr: CorrespondenceTable
): string[] {
  const rows = (corr.newElementMap.get(newElementId) ?? []).filter((c) => c.oldId);
  const zones = new Set<string>();
  for (const r of rows) {
    const el = oldMesh.elements.find((e) => e.id === r.oldId);
    if (el) zones.add(el.zone);
  }
  return [...zones];
}

export function buildAllZoneRows(
  oldMesh: Mesh,
  newMesh: Mesh,
  corr: CorrespondenceTable,
  tol: Tolerances
): ZoneRow[] {
  const oldTopo: MeshTopology = buildTopology(oldMesh);
  void oldTopo;
  return oldMesh.zones.map((z) =>
    buildZoneRow(z.id, oldMesh, newMesh, corr, tol)
  );
}
