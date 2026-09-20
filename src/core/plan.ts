import { randomUUID } from 'node:crypto';
import type { Mesh } from './types.js';
import { DEFAULT_TOLERANCES, cloneTolerances, type Tolerances } from './tolerances.js';
import { buildCorrespondence } from './correspondence.js';
import { meshHash } from './hash.js';
import { buildFacePressureRow, buildNodalForceRow } from './rows-loads.js';
import {
  buildAllZoneRows,
  buildConstraintRow,
  buildProbeRow
} from './rows-entities.js';
import {
  buildTopology
} from './topology.js';
import type {
  FacePressureRow,
  FrozenPlan,
  NodalForceRow,
  PlanRow
} from './plan-types.js';
import type { Decision } from './evidence.js';
import type { ConstraintRow, ProbeRow, ZoneRow } from './plan-types.js';

/**
 * Build a frozen migration plan between two immutable mesh versions.
 *
 * The plan embeds the two content hashes and a snapshot of all tolerances at
 * build time. Acceptance later re-hashes the stored meshes and rejects the
 * commit if either version changed (optimistic concurrency).
 */
export function buildPlan(
  oldMesh: Mesh,
  newMesh: Mesh,
  options: {
    tolerances?: Tolerances;
    decisions?: Decision[];
    planId?: string;
    createdAt?: string;
  } = {}
): FrozenPlan {
  const tol = cloneTolerances(options.tolerances ?? DEFAULT_TOLERANCES);
  const corr = buildCorrespondence(oldMesh, newMesh, tol);
  const newTopo = buildTopology(newMesh);

  const rows: PlanRow[] = [];

  for (const load of oldMesh.loads) {
    if (load.kind === 'facePressure')
      rows.push(buildFacePressureRow(load, oldMesh, newTopo, corr, tol));
    else rows.push(buildNodalForceRow(load, oldMesh, corr, tol));
  }
  for (const c of oldMesh.constraints) rows.push(buildConstraintRow(c, oldMesh, corr));
  for (const p of oldMesh.probes) rows.push(buildProbeRow(p, newMesh, tol));
  rows.push(...buildAllZoneRows(oldMesh, newMesh, corr, tol));

  const decisions = options.decisions ?? [];
  for (const d of decisions) applyDecision(rows, d, oldMesh, newMesh, tol);

  return {
    schema: 'migration-plan/1',
    planId: options.planId ?? randomUUID(),
    oldMeshId: oldMesh.id,
    newMeshId: newMesh.id,
    oldHash: meshHash(oldMesh),
    newHash: meshHash(newMesh),
    createdAt: options.createdAt ?? new Date().toISOString(),
    tolerances: tol,
    rows,
    topologyDiff: corr.counts
  };
}

/**
 * Apply an engineer decision as new evidence. Machine rows are never mutated
 * destructively beyond status; the decision id is recorded on the row.
 */
function applyDecision(
  rows: PlanRow[],
  d: Decision,
  oldMesh: Mesh,
  newMesh: Mesh,
  tol: Tolerances
): void {
  const row = rows.find((r) => rowMatches(r, d));
  if (!row) return;

  if (d.action === 'disable') {
    row.status = 'disabled';
    row.decisionId = d.id;
    row.reasons = [`disabled by ${d.author}`, ...(d.note ? [d.note] : []), ...row.reasons];
    return;
  }
  if (d.action === 'rebuild') {
    row.status = 'rebuild';
    row.decisionId = d.id;
    row.reasons = [`marked for rebuild by ${d.author}`, ...(d.note ? [d.note] : []), ...row.reasons];
    return;
  }
  if (d.action === 'reset') {
    // Rebuild the single row from scratch without this decision.
    const fresh = rebuildRow(row, oldMesh, newMesh, tol);
    const idx = rows.indexOf(row);
    if (fresh) rows[idx] = fresh;
    return;
  }
  if (d.action === 'confirm' && d.candidate) {
    confirmCandidate(row, d, newMesh);
  }
}

function stripZone(id: string): string {
  return id.startsWith('zone:') ? id.slice(5) : id;
}

function rowMatches(row: PlanRow, d: Decision): boolean {
  if (d.entityKind === 'zone')
    return row.kind === 'zone' && (row as ZoneRow).zoneId === stripZone(d.entityId);
  if (d.entityKind === 'load')
    return (row.kind === 'facePressure' || row.kind === 'nodalForce') && row.id === d.entityId;
  return row.kind === d.entityKind && row.id === d.entityId;
}

function confirmCandidate(
  row: PlanRow,
  d: Decision,
  newMesh: Mesh
): void {
  void newMesh;
  if (!d.candidate) return;
  const cand = d.candidate;

  if (row.kind === 'facePressure' && cand.type === 'face') {
    const fr = row as FacePressureRow;
    const target = cand.newKey;
    if (!target) return;
    const chosen = fr.candidates.find((c) => c.target === target);
    if (!chosen) return;
    // Restrict the proposal to the confirmed child set; conservation is
    // recomputed at acceptance, not silently fudged here.
    fr.proposed = fr.proposed.filter((p) => p.faceKey === target);
    fr.status = fr.proposed.length > 1 ? 'split' : fr.oldFaces.length > 1 ? 'merged' : 'complete';
    fr.decisionId = d.id;
    fr.reasons = [`confirmed child face by ${d.author}`, ...fr.reasons];
    return;
  }

  if (
    (row.kind === 'nodalForce' || row.kind === 'constraint' || row.kind === 'probe') &&
    cand.type === 'node' &&
    cand.newId
  ) {
    if (row.kind === 'nodalForce') (row as NodalForceRow).newNode = cand.newId;
    if (row.kind === 'constraint') (row as ConstraintRow).newNode = cand.newId;
    if (row.kind === 'probe') (row as ProbeRow).newNode = cand.newId;
    row.status = 'complete';
    row.decisionId = d.id;
    row.reasons = [`confirmed target ${cand.newId} by ${d.author}`, ...row.reasons];
    return;
  }

  if (row.kind === 'zone' && cand.type === 'element' && cand.newId) {
    const zr = row as ZoneRow;
    if (!zr.newElementIds.includes(cand.newId)) zr.newElementIds.push(cand.newId);
    zr.status = 'split';
    zr.decisionId = d.id;
    zr.reasons = [`confirmed element ${cand.newId} by ${d.author}`, ...zr.reasons];
  }
}

function rebuildRow(
  row: PlanRow,
  oldMesh: Mesh,
  newMesh: Mesh,
  tol: Tolerances
): PlanRow | null {
  const corr = buildCorrespondence(oldMesh, newMesh, tol);
  const newTopo = buildTopology(newMesh);
  if (row.kind === 'facePressure') {
    const load = oldMesh.loads.find((l) => l.id === row.id);
    if (load && load.kind === 'facePressure')
      return buildFacePressureRow(load, oldMesh, newTopo, corr, tol);
  }
  if (row.kind === 'nodalForce') {
    const load = oldMesh.loads.find((l) => l.id === row.id);
    if (load && load.kind === 'nodalForce')
      return buildNodalForceRow(load, oldMesh, corr, tol);
  }
  if (row.kind === 'constraint') {
    const con = oldMesh.constraints.find((c) => c.id === row.id);
    if (con) return buildConstraintRow(con, oldMesh, corr);
  }
  if (row.kind === 'probe') {
    const probe = oldMesh.probes.find((p) => p.id === row.id);
    if (probe) return buildProbeRow(probe, newMesh, tol);
  }
  if (row.kind === 'zone') {
    return buildAllZoneRows(oldMesh, newMesh, corr, tol).find(
      (z) => z.id === row.id
    ) ?? null;
  }
  return null;
}
