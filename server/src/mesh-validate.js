// 网格级验证器。error 阻止迁移预览；warn 仅提示。
import { signedTetVolume, triArea } from './geometry.js';
import { nodePos, deriveBoundaryFaces, elementNodes } from './mesh.js';

export function validateMesh(mesh, tol) {
  const issues = [];
  const nodeIds = new Set();
  const dupNodes = new Set();
  for (const n of mesh.nodes ?? []) {
    if (nodeIds.has(n.id)) dupNodes.add(n.id);
    nodeIds.add(n.id);
    if (!Array.isArray(n.coord) || n.coord.length !== 3 || n.coord.some((x) => !Number.isFinite(x))) {
      issues.push(issue('error', 'INVALID_NODE', `节点 ${n.id} 坐标非法`));
    }
  }
  for (const id of dupNodes) issues.push(issue('error', 'DUPLICATE_NODE', `节点 id 重复: ${id}`));

  const cellIds = new Set();
  for (const cell of mesh.cells ?? []) {
    if (cellIds.has(cell.id)) issues.push(issue('error', 'DUPLICATE_CELL', `单元 id 重复: ${cell.id}`));
    cellIds.add(cell.id);
    if (cell.type !== 'tet4') {
      issues.push(issue('error', 'UNSUPPORTED_TYPE', `单元 ${cell.id} 类型 ${cell.type} 不受支持（仅 tet4）`));
      continue;
    }
    if (cell.nodes.length !== 4) {
      issues.push(issue('error', 'INVALID_CELL', `单元 ${cell.id} 必须有 4 个节点`));
      continue;
    }
    for (const nid of cell.nodes) {
      if (!nodeIds.has(nid)) issues.push(issue('error', 'DANGLING_REF', `单元 ${cell.id} 引用不存在的节点 ${nid}`));
    }
    if (cell.nodes.some((nid) => !nodeIds.has(nid))) continue;
    const pts = cell.nodes.map((id) => nodePos(mesh, id));
    const v = signedTetVolume(...pts);
    if (Math.abs(v) < tol.orientation) {
      issues.push(issue('error', 'ZERO_VOLUME', `单元 ${cell.id} 零体积（|V|=${Math.abs(v).toExponential(2)}）`, { cellId: cell.id, volume: v }));
    } else if (v < 0) {
      issues.push(issue('error', 'INVERTED_CELL', `单元 ${cell.id} 方向翻转（有符号体积 ${v.toExponential(3)}）`, { cellId: cell.id, volume: v }));
    }
  }

  const faceIds = new Set();
  for (const f of mesh.faces ?? []) {
    if (faceIds.has(f.id)) issues.push(issue('error', 'DUPLICATE_FACE', `面 id 重复: ${f.id}`));
    faceIds.add(f.id);
    if (f.type !== 'tri3') issues.push(issue('error', 'UNSUPPORTED_TYPE', `面 ${f.id} 类型 ${f.type} 不受支持（仅 tri3）`));
    for (const nid of f.nodes) {
      if (!nodeIds.has(nid)) issues.push(issue('error', 'DANGLING_REF', `面 ${f.id} 引用不存在的节点 ${nid}`));
    }
    if (f.nodes.length === 3 && f.nodes.every((id) => nodeIds.has(id))) {
      const pts = f.nodes.map((id) => nodePos(mesh, id));
      if (triArea(...pts) === 0) issues.push(issue('error', 'ZERO_AREA', `面 ${f.id} 面积为零`, { faceId: f.id }));
    }
  }

  // 边界面必须恰好邻接一个单元；出现 2 次以上意味着重复面/裂缝。
  if ((mesh.cells ?? []).length && (mesh.cells ?? []).every((c) => c.type === 'tet4')) {
    const { all } = deriveBoundaryFaces(mesh);
    for (const rec of all) {
      if (rec.count > 2) {
        issues.push(issue('error', 'NON_MANIFOLD', `拓扑面 ${rec.key} 邻接 ${rec.count} 个单元`));
      }
    }
  }

  for (const s of mesh.sets ?? []) {
    for (const ref of s.members ?? []) {
      if (!refExists(mesh, ref)) {
        issues.push(issue('error', 'DANGLING_REF', `边界集合 ${s.id} 引用不存在的 ${ref.kind} ${ref.id}`));
      }
    }
  }

  // 重复约束：作用于相同拓扑目标。同值仅警告，冲突为错误（需要重建）。
  const constraints = (mesh.objects ?? []).filter((o) => o.type === 'constraint');
  const byTarget = new Map();
  for (const o of constraints) {
    const key = JSON.stringify(o.targets ?? []);
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(o);
  }
  for (const group of byTarget.values()) {
    if (group.length < 2) continue;
    const values = new Set(group.map((g) => JSON.stringify(g.value ?? null)));
    const ids = group.map((g) => g.id).join(', ');
    if (values.size === 1) {
      issues.push(issue('warn', 'DUPLICATE_CONSTRAINT', `重复（同值）约束: ${ids}，迁移时自动合并`, { objectIds: group.map((g) => g.id) }));
    } else {
      issues.push(issue('error', 'CONFLICTING_CONSTRAINT', `冲突约束: ${ids}，值不一致，必须人工重建`, { objectIds: group.map((g) => g.id) }));
    }
  }

  for (const o of mesh.objects ?? []) {
    if (o.type === 'probe') {
      if (o.target?.kind === 'node' && !nodeIds.has(o.target.id)) {
        issues.push(issue('warn', 'DANGLING_REF', `探针 ${o.id} 引用不存在节点 ${o.target.id}`));
      }
    }
    if (o.type === 'traction' || o.type === 'constraint') {
      for (const t of o.targets ?? []) {
        if (!refExists(mesh, t)) issues.push(issue('error', 'DANGLING_REF', `${o.type} ${o.id} 引用不存在的 ${t.kind} ${t.id}`));
      }
    }
  }

  return issues;
}

function refExists(mesh, ref) {
  if (ref.kind === 'node') return (mesh.nodes ?? []).some((n) => n.id === ref.id);
  if (ref.kind === 'cell') return (mesh.cells ?? []).some((c) => c.id === ref.id);
  if (ref.kind === 'face') return (mesh.faces ?? []).some((f) => f.id === ref.id);
  if (ref.kind === 'edge') return (mesh.edges ?? []).some((e) => e.id === ref.id);
  return false;
}

function issue(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}
