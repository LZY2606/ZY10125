import type { Mesh, Vec3 } from './types.js';
import { buildTopology } from './topology.js';
import { meshHash } from './hash.js';
import { pressureResultant, vecClose } from './mechanics.js';
import type { FrozenPlan, PlanRow } from './plan-types.js';

/**
 * Acceptance validation. Runs at commit time against the frozen plan:
 *
 *  - optimistic concurrency: stored meshes must still hash to the frozen
 *    hashes, otherwise the plan is stale and rejected;
 *  - blocking: split face pressures must conserve resultant force AND moment;
 *  - blocking: complete rows must reference entities that exist;
 *  - blocked rows: ambiguous/unmatched/disabled/rebuild never produce a
 *    migrated object (that is a valid engineering outcome, not a failure).
 */

export type AcceptanceSeverity = 'blocking' | 'info';

export interface AcceptanceIssue {
  rowId: string;
  kind: string;
  severity: AcceptanceSeverity;
  message: string;
}

export interface AcceptedObject {
  sourceRowId: string;
  kind: PlanRow['kind'] | 'regionMembership';
  payload: unknown;
}

export interface AcceptedResult {
  ok: boolean;
  issues: AcceptanceIssue[];
  migratedCount: number;
  blockedCount: number;
  objects: AcceptedObject[];
}

export function acceptPlan(
  plan: FrozenPlan,
  oldMesh: Mesh,
  newMesh: Mesh
): AcceptedResult {
  const issues: AcceptanceIssue[] = [];
  const objects: AcceptedObject[] = [];

  // --- Optimistic concurrency: the two grids are immutable content --------
  if (meshHash(oldMesh) !== plan.oldHash)
    issues.push({
      rowId: '*',
      kind: 'version',
      severity: 'blocking',
      message: 'source mesh hash changed after plan preview; refresh required'
    });
  if (meshHash(newMesh) !== plan.newHash)
    issues.push({
      rowId: '*',
      kind: 'version',
      severity: 'blocking',
      message: 'target mesh hash changed after plan preview; refresh required'
    });

  const tol = plan.tolerances;
  const oldTopo = buildTopology(oldMesh);
  const newTopo = buildTopology(newMesh);

  for (const row of plan.rows) {
    if (row.status === 'disabled' || row.status === 'rebuild' || row.status === 'unmatched' || row.status === 'ambiguous') {
      issues.push({
        rowId: row.id,
        kind: row.kind,
        severity: 'info',
        message: `row not migrated (${row.status}): ${row.reasons.join('; ')}`
      });
      continue;
    }
    validateRow(row, issues, objects, newMesh);
  }

  // Cross-check every migrated face-pressure against conservative quantities
  // recomputed directly from the frozen tolerances (not the preview numbers).
  for (const row of plan.rows) {
    if (row.kind !== 'facePressure') continue;
    if (row.status !== 'complete' && row.status !== 'split' && row.status !== 'merged') continue;
    const load = oldMesh.loads.find((l) => l.id === row.id);
    if (!load || load.kind !== 'facePressure') continue;

    const oldFaces = load.faces
      .map((k) => oldTopo.faces.get(k))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .map((f) => ({
        coords: f.wound.map((id) => oldTopo.nodeById.get(id)!.coord) as [Vec3, Vec3, Vec3],
        area: f.area,
        normal: f.normal
      }));
    const newFaces = row.proposed
      .map((p) => newTopo.faces.get(p.faceKey))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .map((f) => ({
        coords: f.wound.map((id) => newTopo.nodeById.get(id)!.coord) as [Vec3, Vec3, Vec3],
        area: f.area,
        normal: f.normal
      }));

    const oldRes = pressureResultant(oldFaces, load.pressure);
    const newRes = pressureResultant(newFaces, load.pressure);
    const fc = vecClose(oldRes.force, newRes.force, tol.forceRelTol, tol.forceAbsTol);
    const mc = vecClose(oldRes.moment, newRes.moment, tol.momentRelTol, tol.momentAbsTol);
    if (!fc.ok)
      issues.push({
        rowId: row.id,
        kind: 'facePressure',
        severity: 'blocking',
        message: `resultant force not conserved: |dF|=${fc.error.toExponential(3)} scale=${fc.scale.toExponential(3)}`
      });
    if (!mc.ok)
      issues.push({
        rowId: row.id,
        kind: 'facePressure',
        severity: 'blocking',
        message: `resultant moment not conserved: |dM|=${mc.error.toExponential(3)} scale=${mc.scale.toExponential(3)}`
      });
  }

  const migratedCount = objects.length;
  const blockedCount = plan.rows.filter(
    (r) =>
      r.status === 'ambiguous' ||
      r.status === 'unmatched' ||
      r.status === 'disabled' ||
      r.status === 'rebuild'
  ).length;
  const blocking = issues.filter((i) => i.severity === 'blocking');

  return {
    ok: blocking.length === 0,
    issues,
    migratedCount,
    blockedCount,
    objects
  };
}

function validateRow(
  row: PlanRow,
  issues: AcceptanceIssue[],
  objects: AcceptedObject[],
  newMesh: Mesh
): void {
  if (row.kind === 'facePressure') {
    if (row.proposed.length === 0) {
      issues.push({ rowId: row.id, kind: row.kind, severity: 'blocking', message: 'accepted row has no target faces' });
      return;
    }
    objects.push({
      sourceRowId: row.id,
      kind: 'facePressure',
      payload: {
        faces: row.proposed.map((p) => p.faceKey),
        pressures: row.proposed.map((p) => p.pressure)
      }
    });
    return;
  }

  if (row.kind === 'nodalForce') {
    if (!row.newNode || !newMesh.nodes.some((n) => n.id === row.newNode)) {
      issues.push({ rowId: row.id, kind: row.kind, severity: 'blocking', message: 'target node missing' });
      return;
    }
    objects.push({ sourceRowId: row.id, kind: 'nodalForce', payload: { node: row.newNode, vector: row.vector } });
    return;
  }

  if (row.kind === 'constraint') {
    if (!row.newNode || !newMesh.nodes.some((n) => n.id === row.newNode)) {
      issues.push({ rowId: row.id, kind: row.kind, severity: 'blocking', message: 'target node missing' });
      return;
    }
    objects.push({ sourceRowId: row.id, kind: 'constraint', payload: { node: row.newNode, fixed: row.fixed } });
    return;
  }

  if (row.kind === 'probe') {
    if (!row.newNode) {
      issues.push({ rowId: row.id, kind: row.kind, severity: 'blocking', message: 'probe target missing' });
      return;
    }
    objects.push({ sourceRowId: row.id, kind: 'probe', payload: { label: row.label, node: row.newNode, coord: row.coord } });
    return;
  }

  if (row.kind === 'zone') {
    if (row.newElementIds.length === 0) {
      issues.push({ rowId: row.id, kind: row.kind, severity: 'blocking', message: 'zone has no target elements' });
      return;
    }
    objects.push({
      sourceRowId: row.id,
      kind: 'zone',
      payload: { zoneId: row.zoneId, elementIds: row.newElementIds }
    });
  }
}
