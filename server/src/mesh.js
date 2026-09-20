// 网格模型：拓扑稳定标识、边界面推导、规范化哈希。
import { createHash } from 'node:crypto';

export function nodeKey(p) {
  return `n:${p[0].toFixed(12)},${p[1].toFixed(12)},${p[2].toFixed(12)}`;
}

function sorted(arr) {
  return [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// 拓扑标识不依赖数组下标：边/面/单元都用节点 id 的规范化序列。
export function edgeKey(nodes) {
  return `e:[${sorted(nodes).join(',')}]`;
}
export function faceKey(nodes) {
  return `f:[${sorted(nodes).join(',')}]`;
}
export function cellKey(nodes) {
  return `c:[${sorted(nodes).join(',')}]`;
}

export function nodePos(mesh, id) {
  const n = mesh.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`网格 ${mesh.name ?? mesh.series ?? ''} 中缺少节点 ${id}`);
  return n.coord;
}

export function cellById(mesh, id) {
  const c = mesh.cells.find((x) => x.id === id);
  if (!c) throw new Error(`缺少单元 ${id}`);
  return c;
}
export function faceById(mesh, id) {
  const f = mesh.faces.find((x) => x.id === id);
  if (!f) throw new Error(`缺少面 ${id}`);
  return f;
}
export function edgeById(mesh, id) {
  const e = mesh.edges.find((x) => x.id === id);
  if (!e) throw new Error(`缺少边 ${id}`);
  return e;
}

export function elementNodes(mesh, ref) {
  if (ref.kind === 'cell') return cellById(mesh, ref.id).nodes;
  if (ref.kind === 'face') return faceById(mesh, ref.id).nodes;
  if (ref.kind === 'edge') return edgeById(mesh, ref.id).nodes;
  if (ref.kind === 'node') return [ref.id];
  throw new Error(`未知拓扑种类 ${ref.kind}`);
}

export function elementKey(mesh, ref) {
  const nodes = elementNodes(mesh, ref);
  if (ref.kind === 'cell') return cellKey(nodes);
  if (ref.kind === 'face') return faceKey(nodes);
  if (ref.kind === 'edge') return edgeKey(nodes);
  return nodeKey(nodePos(mesh, ref.id));
}

export function refKey(ref) {
  return `${ref.kind}:${ref.id}`;
}

// 从 tet4 单元推导所有面；只出现一次的是边界面，两次以上说明存在悬挂内部重复面。
export function deriveBoundaryFaces(mesh) {
  const order = [];
  const seen = new Map(); // faceKey -> {nodes, count, firstCell, orientationSign}
  for (const cell of mesh.cells) {
    const n = cell.nodes;
    const local = [
      [n[0], n[2], n[1]],
      [n[0], n[1], n[3]],
      [n[0], n[3], n[2]],
      [n[1], n[2], n[3]],
    ];
    for (const fNodes of local) {
      const key = faceKey(fNodes);
      if (!seen.has(key)) {
        seen.set(key, { nodes: fNodes, count: 0, firstCell: cell.id });
        order.push(key);
      }
      seen.get(key).count += 1;
    }
  }
  const boundary = [];
  const interior = [];
  for (const key of order) {
    const rec = seen.get(key);
    (rec.count === 1 ? boundary : interior).push({ key, ...rec });
  }
  return { boundary, interior, all: order.map((k) => seen.get(k)) };
}

// 推导边（每条 cell 边去重），供边对应与拓扑差异使用。
export function deriveEdges(mesh) {
  const map = new Map();
  for (const cell of mesh.cells) {
    const n = cell.nodes;
    const pairs = [[n[0], n[1]], [n[0], n[2]], [n[0], n[3]], [n[1], n[2]], [n[1], n[3]], [n[2], n[3]]];
    for (const pair of pairs) {
      const key = edgeKey(pair);
      if (!map.has(key)) map.set(key, { id: key, nodes: sorted(pair) });
    }
  }
  return [...map.values()];
}

// 网格内容的不可变指纹：JSON 规范化（键排序、稳定浮点输出）后 SHA-256。
export function canonicalHash(value) {
  const text = canonicalStringify(value);
  return createHash('sha256').update(text).digest('hex');
}

export function canonicalStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}
