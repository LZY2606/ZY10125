// 导出新网格：稳定标识保持、成员按集合语义去重、顺序按来源 ordinal 确定性排序。
import { canonicalStringify } from './mesh.js';

export function buildExport(oldMesh, newMesh, applied, meta) {
  const objects = [];

  for (const row of applied.objects) {
    const src = oldMesh.objects.find((o) => o.id === row.objectId);
    if (row.finalState === 'disabled' || row.finalState === 'rebuild') continue;
    const base = {
      id: src.id, ordinal: src.ordinal, type: src.type,
      value: src.value,
      migratedFrom: row.objectId,
    };
    if (src.type === 'probe') base.target = row.targets[0] ?? null;
    else base.targets = row.targets;
    if (row.loads?.length) {
      base.distribution = row.loads.map((l) => ({ face: l.faceId, areaWeight: l.weight, area: l.area }));
    }
    objects.push(base);
  }

  const sets = applied.sets
    .filter((s) => s.evidence?.action !== 'rebuild' && s.decision !== 'rejected')
    .map((s) => {
      const src = oldMesh.sets.find((x) => x.id === s.setId);
      return { id: src.id, ordinal: src.ordinal, kind: src.kind ?? 'boundary', members: sortMembers(s.members), migratedFrom: src.id };
    });

  const regions = applied.regions
    .filter((r) => r.evidence?.action !== 'rebuild' && r.decision !== 'rejected')
    .map((r) => {
      const src = oldMesh.regions.find((x) => x.id === r.regionId);
      return { id: src.id, ordinal: src.ordinal, material: r.material, cells: [...r.cells].sort(), migratedFrom: src.id };
    });

  const exportDoc = {
    migration: {
      planId: meta.planId,
      fromVersion: meta.fromVersionId,
      toVersion: meta.toVersionId,
      fromHash: meta.fromHash,
      toHash: meta.toHash,
      frozenTolerances: meta.tolerances,
      acceptedAt: meta.acceptedAt,
      appliedEvidence: meta.evidenceCount,
    },
    mesh: {
      ...newMesh,
      edges: undefined,
      objects: orderByOrdinal(objects),
      sets: orderByOrdinal(sets),
      regions: orderByOrdinal(regions),
    },
  };
  delete exportDoc.mesh.edges;
  return exportDoc;
}

function sortMembers(members) {
  const uniq = new Map();
  for (const m of members) uniq.set(`${m.kind}:${m.id}`, m);
  return [...uniq.values()].sort((a, b) => {
    const rank = { node: 0, edge: 1, face: 2, cell: 3 };
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
function orderByOrdinal(list) {
  return [...list].sort((a, b) => {
    const oa = a.ordinal ?? Number.MAX_SAFE_INTEGER;
    const ob = b.ordinal ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }).map(({ ordinal, ...rest }) => rest);
}

export function deterministicExport(doc) {
  return canonicalStringify(doc) + '\n';
}
