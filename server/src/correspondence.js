// 版本间拓扑对应：节点、面、边、单元。
// 原则：一对多 / 多对一 / 无对应都是一等结果，绝不为“全部成功”而强配最近邻。
import { dist, pointInTet, pointOnTriangle, pointOnSegment, hausdorff } from './geometry.js';
import { nodePos, faceById, edgeById, cellById, faceKey } from './mesh.js';

// 节点对应：枚举容差内候选，按距离升序贪心配对，保证一对一。
export function matchNodes(oldMesh, newMesh, tol) {
  const candidates = [];
  for (const o of oldMesh.nodes) {
    for (const n of newMesh.nodes) {
      const d = dist(o.coord, n.coord);
      if (d <= tol.nodeDistance) candidates.push({ oldId: o.id, newId: n.id, distance: d });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || (a.oldId < b.oldId ? -1 : 1) || (a.newId < b.newId ? -1 : 1));
  const pairs = [];
  const usedOld = new Set();
  const usedNew = new Set();
  for (const cand of candidates) {
    if (usedOld.has(cand.oldId) || usedNew.has(cand.newId)) continue;
    usedOld.add(cand.oldId);
    usedNew.add(cand.newId);
    pairs.push(cand);
  }
  const removed = oldMesh.nodes.filter((n) => !usedOld.has(n.id)).map((n) => ({ oldId: n.id }));
  const added = newMesh.nodes.filter((n) => !usedNew.has(n.id)).map((n) => ({ newId: n.id }));
  return { pairs, removed, added };
}

// 通用分组：用包含谓词建立新旧实体间的二部连通分量。
function groupEntities(oldItems, newItems, overlaps) {
  const groups = [];
  const oldToGroup = new Map();
  const newToGroup = new Map();
  for (const { oldIndex, newIndex } of overlaps) {
    let gi = oldToGroup.get(oldIndex);
    const gj = newToGroup.get(newIndex);
    if (gi == null && gj == null) {
      gi = groups.length;
      groups.push({ old: [oldIndex], new: [newIndex] });
    } else if (gi != null && gj == null) {
      groups[gi].new.push(newIndex);
    } else if (gi == null && gj != null) {
      gi = gj;
      groups[gi].old.push(oldIndex);
    } else if (gi !== gj) {
      const a = groups[gi];
      const b = groups[gj];
      a.old.push(...b.old, oldIndex);
      a.new.push(...b.new);
      for (const oi of b.old) oldToGroup.set(oi, gi);
      for (const ni of b.new) newToGroup.set(ni, gi);
      b.old = [];
      b.new = [];
    }
    oldToGroup.set(oldIndex, gi);
    newToGroup.set(newIndex, gi);
  }
  // 完全孤立的实体单独成组（无对应）。
  oldItems.forEach((_, i) => {
    if (!oldToGroup.has(i)) {
      oldToGroup.set(i, groups.length);
      groups.push({ old: [i], new: [] });
    }
  });
  newItems.forEach((_, i) => {
    if (!newToGroup.has(i)) {
      const gi = newToGroup.get(i);
      if (gi != null) return;
      newToGroup.set(i, groups.length);
      groups.push({ old: [], new: [i] });
    }
  });
  return { groups: groups.filter((g) => g.old.length + g.new.length > 0), oldToGroup, newToGroup };
}

function classify(no, nn) {
  if (no === 1 && nn === 1) return 'complete';
  if (no === 1 && nn > 1) return 'split';
  if (no > 1 && nn === 1) return 'merge';
  if (no === 0) return 'new';
  if (nn === 0) return 'removed';
  return 'ambiguous';
}

// 面是否空间重叠：节点映射能说明问题时用节点，否则用“每个新面角点落在旧面上”。
function facesOverlap(meshA, faceA, meshB, faceB, nodePairMap, tol) {
  const aNodes = new Set(faceA.nodes);
  const mappedAllIn = faceB.nodes.every((id) => nodePairMap.has(id) && aNodes.has(nodePairMap.get(id)));
  if (mappedAllIn) {
    const mapped = faceKey(faceB.nodes.map((id) => nodePairMap.get(id)));
    if (mapped === faceKey(faceA.nodes)) return false; // 同一张面，complete 由相同节点组处理
  }
  const ptsA = faceA.nodes.map((id) => nodePos(meshA, id));
  if (faceB.nodes.every((id) => {
    const p = nodePos(meshB, id);
    return ptsA.some((q) => dist(p, q) <= tol.nodeDistance) || pointOnTriangle(p, ptsA, tol.pointOnEntity);
  })) return true;
  const ptsB = faceB.nodes.map((id) => nodePos(meshB, id));
  return faceA.nodes.every((id) => {
    const p = nodePos(meshA, id);
    return pointOnTriangle(p, ptsB, tol.pointOnEntity);
  });
}

// 面分组；faceSets: [{id, nodes}]（边界面与显式面的并集）。
export function matchFaces(oldMesh, newMesh, nodePairs, tol) {
  const oldFaces = oldMesh.faces;
  const newFaces = newMesh.faces;
  const newToOld = new Map(nodePairs.map((p) => [p.newId, p.oldId]));
  const overlaps = [];
  // 相同节点组（经节点映射）= 完全对应。
  const oldByKey = new Map();
  for (let i = 0; i < oldFaces.length; i++) oldByKey.set(faceKey(oldFaces[i].nodes), i);
  for (let j = 0; j < newFaces.length; j++) {
    const mappedNodes = newFaces[j].nodes.map((id) => newToOld.get(id)).filter(Boolean);
    if (mappedNodes.length === newFaces[j].nodes.length) {
      const oi = oldByKey.get(faceKey(mappedNodes));
      if (oi != null) overlaps.push({ oldIndex: oi, newIndex: j });
    }
  }
  for (let i = 0; i < oldFaces.length; i++) {
    for (let j = 0; j < newFaces.length; j++) {
      if (facesOverlap(oldMesh, oldFaces[i], newMesh, newFaces[j], newToOld, tol)) {
        overlaps.push({ oldIndex: i, newIndex: j });
      }
    }
  }
  const { groups } = groupEntities(oldFaces, newFaces, dedupe(overlaps));
  return groups.map((g) => {
    const oldIds = g.old.map((i) => oldFaces[i].id);
    const newIds = g.new.map((j) => newFaces[j].id);
    const oldPts = g.old.flatMap((i) => oldFaces[i].nodes).map((id) => nodePos(oldMesh, id));
    const newPts = g.new.flatMap((j) => newFaces[j].nodes).map((id) => nodePos(newMesh, id));
    return {
      kind: 'face',
      relation: classify(oldIds.length, newIds.length),
      oldIds,
      newIds,
      distance: oldIds.length && newIds.length ? hausdorff(oldPts, newPts) : null,
    };
  });
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = `${x.oldIndex}:${x.newIndex}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

// 边分组：新边两端落在旧边上（拆分），或反之（合并）。
export function matchEdges(oldMesh, newMesh, nodePairs, tol) {
  const oldEdges = oldMesh.edges ?? [];
  const newEdges = newMesh.edges ?? [];
  const overlaps = [];
  for (let i = 0; i < oldEdges.length; i++) {
    for (let j = 0; j < newEdges.length; j++) {
      const aPts = oldEdges[i].nodes.map((id) => nodePos(oldMesh, id));
      const bPts = newEdges[j].nodes.map((id) => nodePos(newMesh, id));
      const bInA = bPts.every((p) => pointOnSegment(p, aPts[0], aPts[1], tol.pointOnEntity));
      const aInB = aPts.every((p) => pointOnSegment(p, bPts[0], bPts[1], tol.pointOnEntity));
      if (bInA || aInB) overlaps.push({ oldIndex: i, newIndex: j });
    }
  }
  const { groups } = groupEntities(oldEdges, newEdges, dedupe(overlaps));
  return groups.map((g) => ({
    kind: 'edge',
    relation: classify(g.old.length, g.new.length),
    oldIds: g.old.map((i) => oldEdges[i].id),
    newIds: g.new.map((j) => newEdges[j].id),
  }));
}

// 单元分组：按重心坐标点包含（四面体四分坐标）。
export function matchCells(oldMesh, newMesh, tol) {
  const oldCells = oldMesh.cells;
  const newCells = newMesh.cells;
  const overlaps = [];
  for (let i = 0; i < oldCells.length; i++) {
    const oldTet = oldCells[i].nodes.map((id) => nodePos(oldMesh, id));
    for (let j = 0; j < newCells.length; j++) {
      const newTet = newCells[j].nodes.map((id) => nodePos(newMesh, id));
      const newInOld = newTet.every((p) => pointInTet(p, oldTet, tol.pointOnEntity));
      const oldInNew = oldTet.every((p) => pointInTet(p, newTet, tol.pointOnEntity));
      if (newInOld || oldInNew) overlaps.push({ oldIndex: i, newIndex: j });
    }
  }
  const { groups } = groupEntities(oldCells, newCells, dedupe(overlaps));
  return groups.map((g) => ({
    kind: 'cell',
    relation: classify(g.old.length, g.new.length),
    oldIds: g.old.map((i) => oldCells[i].id),
    newIds: g.new.map((j) => newCells[j].id),
  }));
}
