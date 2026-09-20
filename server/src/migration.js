// 迁移引擎：逐工程对象给出 完整 / 拆分 / 合并 / 拒绝 / 重建 结论与理由、
// 预览载荷（含面积权重），并核算总合力、总力矩与面积守恒。
import { add, scale, cross, triArea, centroid, dist, signedTetVolume } from './geometry.js';
import { nodePos, faceById, cellById, refKey } from './mesh.js';

export function buildMigration(oldMesh, newMesh, corr, tol) {
  const { pairs, faceGroups, cellGroups } = corr;
  const oldToNewNode = new Map(pairs.map((p) => [p.oldId, p.newId]));
  const newToOldNode = new Map(pairs.map((p) => [p.newId, p.oldId]));
  const faceIndex = indexGroups(faceGroups);
  const cellIndex = indexGroups(cellGroups);

  const results = (oldMesh.objects ?? []).map((obj) => {
    if (obj.type === 'constraint') return migrateConstraint(obj, oldMesh, newMesh, oldToNewNode);
    if (obj.type === 'traction') return migrateTraction(obj, oldMesh, newMesh, faceIndex, tol);
    if (obj.type === 'probe') return migrateProbe(obj, oldToNewNode, newMesh);
    return { objectId: obj.id, objectType: obj.type, decision: 'rejected', reason: `未知对象类型 ${obj.type}`, targets: [], checks: [] };
  });

  const setResults = (oldMesh.sets ?? []).map((s) => migrateSet(s, oldMesh, newMesh, oldToNewNode, faceIndex, cellIndex));
  const regionResults = (oldMesh.regions ?? []).map((r) => migrateRegion(r, oldMesh, newMesh, cellIndex));

  return { results, setResults, regionResults };
}

function indexGroups(groups) {
  const byOld = new Map();
  const byNew = new Map();
  groups.forEach((g, gi) => {
    for (const id of g.oldIds) byOld.set(id, gi);
    for (const id of g.newIds) byNew.set(id, gi);
  });
  return { groups, byOld, byNew };
}

// ---- 约束：节点固定条件只能一一迁移，不允许复制。 ----
function migrateConstraint(obj, oldMesh, newMesh, oldToNewNode) {
  if (obj.targets.length !== 1 || obj.targets[0].kind !== 'node') {
    return {
      objectId: obj.id, objectType: 'constraint', decision: 'rejected',
      reason: '仅支持单节点约束的自动迁移；多目标约束请重建', targets: [], checks: [],
    };
  }
  const oldId = obj.targets[0].id;
  const newId = oldToNewNode.get(oldId);
  if (newId) {
    return {
      objectId: obj.id, objectType: 'constraint', decision: 'complete',
      reason: `节点 ${oldId} 在新网格中有唯一对应节点 ${newId}，固定条件整体迁移`,
      targets: [{ kind: 'node', id: newId }], checks: [],
    };
  }
  const nearest = nearestNode(oldMesh, newMesh, oldId);
  return {
    objectId: obj.id, objectType: 'constraint', decision: 'rejected',
    reason: nearest
      ? `节点 ${oldId} 在容差内无对应节点；最近点为 ${nearest.id}（距离 ${nearest.distance.toExponential(3)}），另有所属，不复制固定条件`
      : `节点 ${oldId} 在新网格中无候选`,
    targets: [], nearest: nearest ? { nodeId: nearest.id, distance: nearest.distance } : null, checks: [],
  };
}

function nearestNode(oldMesh, newMesh, oldId) {
  const p = nodePos(oldMesh, oldId);
  let best = null;
  for (const n of newMesh.nodes) {
    const d = dist(p, n.coord);
    if (!best || d < best.distance) best = { id: n.id, distance: d };
  }
  return best;
}

// ---- 探针：跟随唯一对应节点；最近点只作为拒绝时的参考，不自动归属。 ----
function migrateProbe(obj, oldToNewNode, newMesh) {
  if (obj.target?.kind !== 'node') {
    return { objectId: obj.id, objectType: 'probe', decision: 'rejected', reason: '探针必须挂在节点上', targets: [], checks: [] };
  }
  const newId = oldToNewNode.get(obj.target.id);
  if (newId) {
    return {
      objectId: obj.id, objectType: 'probe', decision: 'complete',
      reason: `探针节点 ${obj.target.id} 唯一对应 ${newId}`,
      targets: [{ kind: 'node', id: newId }], checks: [],
    };
  }
  const p = obj.coord ?? null;
  return {
    objectId: obj.id, objectType: 'probe', decision: 'rejected',
    reason: `探针节点 ${obj.target.id} 在新网格中不存在，探针需要重建`,
    targets: [], checks: [],
  };
}

// ---- 面力：按面分组（完整/拆分/合并）迁移，保持总合力与总力矩。 ----
function migrateTraction(obj, oldMesh, newMesh, faceIndex, tol) {
  const oldFaceIds = obj.targets.filter((t) => t.kind === 'face').map((t) => t.id);
  if (oldFaceIds.length !== obj.targets.length || oldFaceIds.length === 0) {
    return { objectId: obj.id, objectType: 'traction', decision: 'rejected', reason: '仅支持作用于面的分布力自动迁移', targets: [], checks: [] };
  }
  // 一个载荷可同时作用在多张相邻面上：取这些面所属分组的并集作为支撑面。
  const groups = [];
  const groupIdSet = new Set();
  for (const id of oldFaceIds) {
    const gi = faceIndex.byOld.get(id);
    if (gi == null) continue;
    if (!groupIdSet.has(gi)) {
      groupIdSet.add(gi);
      groups.push(faceIndex.groups[gi]);
    }
  }
  if (groups.length === 0) {
    return { objectId: obj.id, objectType: 'traction', decision: 'rejected', reason: '载荷面在新网格中没有任何对应面', targets: [], checks: [] };
  }
  const ambiguousGroup = groups.find((g) => g.relation === 'ambiguous');
  if (ambiguousGroup) {
    return {
      objectId: obj.id, objectType: 'traction', decision: 'rejected',
      reason: `对应 ${ambiguousGroup.oldIds.length} 旧面 ↔ ${ambiguousGroup.newIds.length} 新面，多对多关系有歧义；可人工选定新面确认或标记重建`,
      targets: [], candidateFaceIds: ambiguousGroup.newIds, checks: [],
    };
  }
  const coveredOld = new Set(groups.flatMap((g) => g.oldIds));
  if (!oldFaceIds.every((id) => coveredOld.has(id))) {
    return { objectId: obj.id, objectType: 'traction', decision: 'rejected', reason: '部分载荷面在新网格中无对应', targets: [], checks: [] };
  }
  const newFaceIds = [...new Set(groups.flatMap((g) => g.newIds))];
  const relations = new Set(groups.map((g) => g.relation));
  const relation = relations.has('split') ? 'split' : relations.has('merge') ? 'merge' : 'complete';

  const traction = obj.value; // {pressure: 标量} 或 {vector: [fx,fy,fz] N/m2}
  const oldAreas = oldFaceIds.map((id) => areaOf(oldMesh.faces.find((f) => f.id === id), oldMesh));
  const newAreas = newFaceIds.map((id) => areaOf(newMesh.faces.find((f) => f.id === id), newMesh));
  const oldAreaSum = sum(oldAreas);
  const newAreaSum = sum(newAreas);

  // 总合力、总力矩口径：对每个三角形取面积与形心；
  // pressure 取旧面平均外法线方向，vector 则方向恒定。
  const oldNormal = meanNormal(oldMesh, oldFaceIds);
  const oldForce = isPressure(traction)
    ? scale(oldNormal, traction.pressure * oldAreaSum)
    : scale(traction.vector, oldAreaSum);
  const oldMoment = momentOf(oldMesh, oldFaceIds, traction, oldAreaSum);

  const loads = newFaceIds.map((id, i) => {
    const weight = newAreaSum > 0 ? newAreas[i] / newAreaSum : 1 / group.newIds.length;
    return {
      faceId: id,
      area: newAreas[i],
      weight,
      // 预览载荷：保持矢量面力方向不变；压力仍按局部外法线方向施加。
      value: isPressure(traction)
        ? { pressure: traction.pressure }
        : { vector: traction.vector },
    };
  });

  const newForce = isPressure(traction)
    ? loads.reduce((acc, l) => add(acc, scale(meanNormal(newMesh, [l.faceId]), traction.pressure * l.area)), [0, 0, 0])
    : scale(traction.vector, newAreaSum);
  const newMoment = momentOf(newMesh, newFaceIds, traction, newAreaSum, loads);

  const forceDiff = norm3(add(newForce, scale(oldForce, -1)));
  const momentDiff = norm3(add(newMoment, scale(oldMoment, -1)));
  const areaDiff = Math.abs(newAreaSum - oldAreaSum);
  const checks = [
    { code: 'AREA', passed: areaDiff <= tol.area, expected: oldAreaSum, actual: newAreaSum, tolerance: tol.area, diff: areaDiff },
    { code: 'FORCE', passed: forceDiff <= tol.force, expected: oldForce, actual: newForce, tolerance: tol.force, diff: forceDiff },
    { code: 'MOMENT', passed: momentDiff <= tol.moment, expected: oldMoment, actual: newMoment, tolerance: tol.moment, diff: momentDiff },
  ];
  const allPass = checks.every((c) => c.passed);
  const decision = !allPass ? 'rejected' : relation;

  return {
    objectId: obj.id, objectType: 'traction', decision,
    relation,
    reason: tractionReason(relation, allPass, oldFaceIds, newFaceIds),
    targets: loads.map((l) => ({ kind: 'face', id: l.faceId })),
    loads,
    totals: { old: { force: oldForce, moment: oldMoment, area: oldAreaSum }, new: { force: newForce, moment: newMoment, area: newAreaSum } },
    checks,
  };
}

function tractionReason(relation, allPass, oldFaceIds, newFaceIds) {
  if (!allPass) return '存在对应面但保守量检查未通过，拒绝自动迁移';
  if (relation === 'complete') return `${oldFaceIds.length} 张载荷面与 ${newFaceIds.length} 张新面一一对应，载荷整体迁移`;
  if (relation === 'split') return `${oldFaceIds.length} 张旧面被细分为 ${newFaceIds.length} 个新面，按面积权重分摊，总合力/总力矩守恒`;
  return `${oldFaceIds.length} 个旧面合并为 ${newFaceIds.length} 张新面，载荷合并施加，总合力/总力矩守恒`;
}

function isPressure(t) {
  return typeof t?.pressure === 'number';
}
function sum(a) {
  return a.reduce((x, y) => x + y, 0);
}
function norm3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function areaOf(face, mesh) {
  const p = face.nodes.map((id) => nodePos(mesh, id));
  return triArea(p[0], p[1], p[2]);
}
function faceNormal(face, mesh) {
  const [a, b, c] = face.nodes.map((id) => nodePos(mesh, id));
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return scale(n, 1 / l);
}
function meanNormal(mesh, faceIds) {
  const n = [0, 0, 0];
  let area = 0;
  for (const id of faceIds) {
    const f = mesh.faces.find((x) => x.id === id);
    const a = areaOf(f, mesh);
    const nn = faceNormal(f, mesh);
    n[0] += nn[0] * a; n[1] += nn[1] * a; n[2] += nn[2] * a;
    area += a;
  }
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return scale(n, 1 / l);
}
// 力矩口径：合力作用点为各面形心按面积加权的点，绕坐标原点取矩 M = r × F。
function momentOf(mesh, faceIds, traction, areaSum, loads = null) {
  let r = [0, 0, 0];
  faceIds.forEach((id, i) => {
    const f = mesh.faces.find((x) => x.id === id);
    const c = centroid(f.nodes.map((nid) => nodePos(mesh, nid)));
    const a = loads ? loads[i].area : areaOf(f, mesh);
    r = add(r, scale(c, a));
  });
  if (areaSum > 0) r = scale(r, 1 / areaSum);
  const f = isPressure(traction)
    ? scale(meanNormal(mesh, faceIds), traction.pressure * areaSum)
    : scale(traction.vector, areaSum);
  return cross(r, f);
}

// ---- 边界集合：集合语义；先删除再重建不改变稳定 id 与导出顺序（顺序在导出层处理）。 ----
function migrateSet(setObj, oldMesh, newMesh, oldToNewNode, faceIndex, cellIndex) {
  const mapped = [];
  const dropped = [];
  const relations = [];
  for (const ref of setObj.members ?? []) {
    const mappedRefs = mapMember(ref, oldMesh, newMesh, oldToNewNode, faceIndex, cellIndex, dropped);
    if (mappedRefs) {
      mapped.push(...mappedRefs);
      if (mappedRefs.length) relations.push(mappedRefs.length > 1 ? 'split' : 'complete');
    }
  }
  // 去重（多个旧成员合并到同一新成员）。
  const uniq = new Map();
  for (const r of mapped) uniq.set(refKey(r), r);
  const members = [...uniq.values()];
  let decision;
  if (dropped.length === 0 && members.length > 0) decision = members.length >= (setObj.members?.length ?? 0) ? 'split' : 'complete';
  else if (members.length === 0) decision = 'rejected';
  else decision = 'partial';
  if (members.length > 0 && dropped.length === 0 && members.length === (setObj.members?.length ?? 0)) decision = 'complete';
  return {
    setId: setObj.id, decision,
    reason: decision === 'rejected'
      ? '集合所有成员在新网格中均无对应，需要重建'
      : dropped.length
        ? `部分成员无对应（${dropped.length} 个被丢弃），其余 ${members.length} 个按集合语义重建`
        : `集合按成员对应重建，稳定 id 与导出顺序保持（${members.length} 个成员）`,
    members, dropped, checks: [],
  };
}

function mapMember(ref, oldMesh, newMesh, oldToNewNode, faceIndex, cellIndex, dropped) {
  if (ref.kind === 'node') {
    const nid = oldToNewNode.get(ref.id);
    if (nid) return [{ kind: 'node', id: nid }];
    dropped.push(ref);
    return null;
  }
  const index = ref.kind === 'face' ? faceIndex : ref.kind === 'cell' ? cellIndex : null;
  if (!index) {
    dropped.push(ref);
    return null;
  }
  const gi = index.byOld.get(ref.id);
  if (gi == null) {
    dropped.push(ref);
    return null;
  }
  const group = index.groups[gi];
  if (group.relation === 'ambiguous') {
    dropped.push({ ...ref, reason: '多对多归属歧义' });
    return null;
  }
  return group.newIds.map((id) => ({ kind: ref.kind, id }));
}

// ---- 材料分区：按单元分组迁移，并核算体积守恒。 ----
function migrateRegion(region, oldMesh, newMesh, cellIndex) {
  const oldIds = region.cells ?? [];
  const groupIds = new Set();
  for (const id of oldIds) if (cellIndex.byOld.has(id)) groupIds.add(cellIndex.byOld.get(id));
  const newCells = [];
  const relations = new Set();
  for (const gi of groupIds) {
    const g = cellIndex.groups[gi];
    for (const id of g.newIds) newCells.push(id);
    relations.add(g.relation);
  }
  const uniqNew = [...new Set(newCells)];
  const missing = oldIds.filter((id) => !cellIndex.byOld.has(id));

  // 不同材料分区合并到同一个新单元属于冲突。
  const conflicts = [];
  const allRegions = oldMesh.regions ?? [];
  for (const nid of uniqNew) {
    const gi = cellIndex.byNew.get(nid);
    const g = cellIndex.groups[gi];
    const owners = new Set();
    for (const oid of g.oldIds) {
      const owner = allRegions.find((r) => (r.cells ?? []).includes(oid));
      if (owner) owners.add(owner.id);
    }
    if (owners.size > 1) conflicts.push(nid);
  }

  const oldVol = sum(oldIds.map((id) => tetVolume(oldMesh.cells.find((c) => c.id === id), oldMesh)));
  const newVol = sum(uniqNew.map((id) => tetVolume(newMesh.cells.find((c) => c.id === id), newMesh)));
  const volDiff = Math.abs(oldVol - newVol);
  const checks = [{ code: 'VOLUME', passed: volDiff <= 1e-8, expected: oldVol, actual: newVol, diff: volDiff, tolerance: 1e-8 }];

  let decision;
  if (conflicts.length) decision = 'rejected';
  else if (uniqNew.length === 0) decision = 'rejected';
  else if (missing.length) decision = 'partial';
  else decision = relations.has('split') || relations.has('merge') || relations.has('ambiguous') ? ([...relations].includes('split') ? 'split' : 'merge') : 'complete';

  return {
    regionId: region.id, material: region.material, decision,
    reason: conflicts.length
      ? `新单元 ${conflicts.join(', ')} 同时属于多个旧材料分区，材料归属冲突，需要人工重建`
      : uniqNew.length === 0
        ? '分区内单元在新网格中均无对应'
        : missing.length
          ? `${missing.length} 个旧单元无对应，其余单元按体积守恒迁移`
          : `分区 ${uniqNew.length} 个单元迁移完成（${[...relations].join('/')}），体积差 ${volDiff.toExponential(2)}`,
    cells: uniqNew, missing, conflicts, checks,
  };
}

function tetVolume(cell, mesh) {
  if (!cell) return 0;
  const p = cell.nodes.map((id) => nodePos(mesh, id));
  return Math.abs(signedTetVolume(p[0], p[1], p[2], p[3]));
}
