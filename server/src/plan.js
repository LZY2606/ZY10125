// 迁移计划：预览组装（冻结容差）、人工证据应用、接受判定。
import { matchNodes, matchFaces, matchEdges, matchCells } from './correspondence.js';
import { buildMigration } from './migration.js';
import { validateMesh } from './mesh-validate.js';
import { freezeTolerances } from './tolerance.js';
import { deriveEdges } from './mesh.js';

export function enrichMesh(mesh) {
  return { ...mesh, edges: deriveEdges(mesh) };
}

export function createPreview(oldMesh, newMesh, toleranceOverrides = {}) {
  const tolerances = freezeTolerances(toleranceOverrides);
  const oldValidation = validateMesh(oldMesh, tolerances);
  const newValidation = validateMesh(newMesh, tolerances);
  if (oldValidation.some((i) => i.severity === 'error') || newValidation.some((i) => i.severity === 'error')) {
    return {
      blocked: true,
      tolerances,
      oldValidation,
      newValidation,
      topology: null,
      distances: null,
      correspondence: null,
      migration: null,
    };
  }
  const nodes = matchNodes(oldMesh, newMesh, tolerances);
  const faceGroups = matchFaces(oldMesh, newMesh, nodes.pairs, tolerances);
  const edgeGroups = matchEdges(oldMesh, newMesh, nodes.pairs, tolerances);
  const cellGroups = matchCells(oldMesh, newMesh, tolerances);
  const migration = buildMigration(oldMesh, newMesh, { pairs: nodes.pairs, faceGroups, cellGroups }, tolerances);

  const topology = {
    nodes: countRelations(nodes.pairs, oldMesh.nodes.length, newMesh.nodes.length),
    edges: summarize(edgeGroups),
    faces: summarize(faceGroups),
    cells: summarize(cellGroups),
  };
  const matchedDistances = nodes.pairs.map((p) => p.distance);
  const distances = {
    node: {
      matched: matchedDistances.length,
      max: matchedDistances.length ? Math.max(...matchedDistances) : 0,
      mean: matchedDistances.length ? matchedDistances.reduce((a, b) => a + b, 0) / matchedDistances.length : 0,
      removed: nodes.removed.map((r) => r.oldId),
      added: nodes.added.map((r) => r.newId),
    },
    face: faceGroups.filter((g) => g.distance != null).map((g) => ({ oldIds: g.oldIds, newIds: g.newIds, relation: g.relation, hausdorff: g.distance })),
  };

  return {
    blocked: false,
    tolerances,
    oldValidation,
    newValidation,
    topology,
    distances,
    correspondence: { nodes, edgeGroups, faceGroups, cellGroups },
    migration,
  };
}

function countRelations(pairs, oldCount, newCount) {
  const oldMatched = new Set(pairs.map((p) => p.oldId)).size;
  const newMatched = new Set(pairs.map((p) => p.newId)).size;
  return { complete: pairs.length, removed: oldCount - oldMatched, added: newCount - newMatched, split: 0, merge: 0, ambiguous: 0 };
}
function summarize(groups) {
  const out = { complete: 0, split: 0, merge: 0, ambiguous: 0, removed: 0, added: 0 };
  for (const g of groups) {
    if (g.relation === 'new') out.added += 1;
    else out[g.relation] += 1;
  }
  return out;
}

// 应用人工证据，返回带状态的对象行与阻止接受的原因。
export function applyEvidence(preview, oldMesh, newMesh, evidenceList = []) {
  const objects = preview.migration.results.map((r) => applyObjectEvidence(r, evidenceList));
  const sets = preview.migration.setResults.map((r) => ({ ...r, evidence: findEvidence(evidenceList, 'set', r.setId) }));
  const regions = preview.migration.regionResults.map((r) => ({ ...r, evidence: findEvidence(evidenceList, 'region', r.regionId) }));

  const blocking = [];
  for (const row of objects) {
    if (row.finalState === 'rebuild') continue;
    if (row.finalState === 'disabled') continue;
    if (row.decision === 'rejected' && row.finalState !== 'confirmed') {
      blocking.push(`对象 ${row.objectId} 被拒绝迁移且未人工确认/重建`);
      continue;
    }
    for (const c of row.checks ?? []) {
      if (!c.passed && row.finalState !== 'confirmed') blocking.push(`对象 ${row.objectId} 保守量 ${c.code} 超差`);
    }
  }
  for (const row of sets) {
    if (row.evidence?.action === 'rebuild') continue;
    if (row.decision === 'rejected' && row.evidence?.action !== 'confirm') blocking.push(`边界集合 ${row.setId} 无有效成员，需要重建或确认`);
  }
  for (const row of regions) {
    if (row.evidence?.action === 'rebuild') continue;
    if (row.decision === 'rejected' && row.evidence?.action !== 'confirm') blocking.push(`材料分区 ${row.regionId} 迁移失败，需要重建或确认`);
  }
  return { objects, sets, regions, blocking };
}

function applyObjectEvidence(row, evidenceList) {
  const ev = findEvidence(evidenceList, row.objectType, row.objectId);
  if (!ev) return { ...row, evidence: null, finalState: row.decision === 'rejected' ? 'rejected' : 'auto' };
  if (ev.action === 'disable') {
    return { ...row, evidence: ev, finalState: 'disabled', targets: [], loads: [] };
  }
  if (ev.action === 'rebuild') {
    return { ...row, evidence: ev, finalState: 'rebuild', targets: [], loads: [] };
  }
  if (ev.action === 'confirm') {
    // 人工确认可以挽救拒绝项：必须给出明确目标（节点约束/面力），杜绝无依据复制。
    const checks = row.checks ?? [];
    return {
      ...row,
      evidence: ev,
      finalState: 'confirmed',
      decision: row.decision === 'rejected' ? 'manual' : row.decision,
      targets: ev.targets ?? row.targets,
      loads: ev.loads ?? row.loads,
      reason: `人工确认：${ev.note ?? '工程师确认该对应'}`,
    };
  }
  return { ...row, evidence: ev, finalState: 'auto' };
}

function findEvidence(list, objectType, objectId) {
  return [...list].reverse().find((e) => e.objectType === objectType && e.objectId === objectId) ?? null;
}
