// Bey 全细化：每条边加中点，一个 tet 剖分为 8 个方向为正的子 tet。
// 参考拓扑：K Bey (1995) 四面体细化模式；节点顺序在本脚本中经有符号体积逐个验证。
import { signedTetVolume } from '../server/src/geometry.js';
import { edgeKey } from '../server/src/mesh.js';

export function refineTets(tets, coordOf, makeCoord) {
  const coordOfOuter = coordOf;
  const edgeMid = new Map();
  const midCoord = new Map();
  const newNodes = new Map();

  function mid(a, b) {
    const key = edgeKey([a, b]);
    if (!edgeMid.has(key)) {
      const pa = coordOf(a);
      const pb = coordOf(b);
      const id = `m_${key.replace(/[^A-Za-z0-9]+/g, '_')}`;
      edgeMid.set(key, id);
      midCoord.set(id, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
    }
    return edgeMid.get(key);
  }

  const outTets = [];
  let subIndex = 0;
  for (const tet of tets) {
    const [v0, v1, v2, v3] = tet.nodes;
    const e01 = mid(v0, v1), e02 = mid(v0, v2), e03 = mid(v0, v3);
    const e12 = mid(v1, v2), e13 = mid(v1, v3), e23 = mid(v2, v3);
    const patterns = [
      [v0, e01, e02, e03],
      [v1, e12, e01, e13],
      [v2, e02, e12, e23],
      [v3, e03, e13, e23],
      [e01, e02, e03, e13],
      [e01, e12, e02, e13],
      [e02, e12, e23, e13],
      [e02, e03, e13, e23],
    ];
    for (let nodes of patterns) {
      subIndex += 1;
      const pts = nodes.map((id) => midCoord.get(id) ?? coordOfOuter(id));
      let v = signedTetVolume(pts[0], pts[1], pts[2], pts[3]);
      if (Math.abs(v) < 1e-30) throw new Error(`子单元 ${tet.id}_s${subIndex + 1} 退化`);
      if (v < 0) nodes = [nodes[1], nodes[0], nodes[2], nodes[3]];
      outTets.push({ id: `${tet.id}_s${subIndex}`, type: 'tet4', parent: tet.id, nodes });
    }
  }
  for (const [id, c] of midCoord) newNodes.set(id, { id, coord: c });
  return { tets: outTets, newNodes: [...newNodes.values()] };
}

export function assertPositive(tets, coordOf) {
  for (const t of tets) {
    const p = t.nodes.map(coordOf);
    const v = signedTetVolume(p[0], p[1], p[2], p[3]);
    if (!(v > 0)) throw new Error(`子单元 ${t.id} 非正体积 ${v}`);
  }
}
