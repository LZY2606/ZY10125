// 生成全部演示/测试网格 JSON 到 fixtures/meshes。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CORNERS, coarseCells, allBoundaryFaces, facesByNormal, verifyPositive } from './cube-mesh.mjs';
import { refineTets, assertPositive } from './refine.mjs';
import { deriveBoundaryFaces } from '../server/src/mesh.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'fixtures', 'meshes');

const cornerNodes = Object.entries(CORNERS).map(([id, coord]) => ({ id, coord }));
const coordOfFactory = (nodes) => {
  const map = new Map(nodes.map((n) => [n.id, n.coord]));
  return (id) => map.get(id);
};

// ---- 粗网格 v1 ----
const coarseCellsList = coarseCells();
verifyPositive(coarseCellsList, coordOfFactory(cornerNodes));
const coarseFaces = allBoundaryFaces(coarseCellsList);
const topFaces = facesByNormal(coarseFaces, coordOfFactory(cornerNodes), 2, 1);

const coarse = {
  series: 'bracket',
  version: 1,
  name: '支架粗网格 v1（6 tet）',
  nodes: cornerNodes,
  cells: coarseCellsList,
  faces: coarseFaces,
  regions: [
    { id: 'reg-steel', ordinal: 1, material: 'steel-S355', cells: coarseCellsList.map((c) => c.id) },
  ],
  sets: [
    { id: 'set-top', ordinal: 1, kind: 'boundary', members: topFaces.map((f) => ({ kind: 'face', id: f.id })) },
    { id: 'set-fixed-corner', ordinal: 2, kind: 'boundary', members: [{ kind: 'node', id: 'n0' }] },
  ],
  objects: [
    {
      id: 'bc-fix-n0', ordinal: 1, type: 'constraint',
      targets: [{ kind: 'node', id: 'n0' }],
      value: { dof: ['ux', 'uy', 'uz'], fixed: 0 },
    },
    {
      id: 'load-top-pressure', ordinal: 2, type: 'traction',
      targets: topFaces.map((f) => ({ kind: 'face', id: f.id })),
      value: { pressure: 1000.0 },
    },
    { id: 'probe-corner', ordinal: 3, type: 'probe', target: { kind: 'node', id: 'n6' }, quantity: 'displacement' },
  ],
};
writeFileSync(resolve(outDir, 'cube-coarse.json'), JSON.stringify(coarse, null, 2) + '\n');

// ---- 细网格 v2：每个 tet 全细化为 8 个子 tet ----
const { tets: fineTets, newNodes } = refineTets(coarseCellsList, coordOfFactory(cornerNodes), null);
const fineNodes = [...cornerNodes, ...newNodes];
const fineCoordOf = coordOfFactory(fineNodes);
assertPositive(fineTets, fineCoordOf);
const fineFacesAll = allBoundaryFaces(fineTets);
const fineTopFaces = facesByNormal(fineFacesAll, fineCoordOf, 2, 1);

const fine = {
  series: 'bracket',
  version: 2,
  name: '支架细网格 v2（48 tet，细分）',
  nodes: fineNodes,
  cells: fineTets,
  faces: fineFacesAll,
  regions: [
    { id: 'reg-steel', ordinal: 1, material: 'steel-S355', cells: fineTets.map((c) => c.id) },
  ],
  sets: [
    { id: 'set-top', ordinal: 1, kind: 'boundary', members: fineTopFaces.map((f) => ({ kind: 'face', id: f.id })) },
    { id: 'set-fixed-corner', ordinal: 2, kind: 'boundary', members: [{ kind: 'node', id: 'n0' }] },
  ],
  objects: [
    {
      id: 'bc-fix-n0', ordinal: 1, type: 'constraint',
      targets: [{ kind: 'node', id: 'n0' }],
      value: { dof: ['ux', 'uy', 'uz'], fixed: 0 },
    },
    {
      id: 'load-top-pressure', ordinal: 2, type: 'traction',
      targets: fineTopFaces.map((f) => ({ kind: 'face', id: f.id })),
      value: { pressure: 1000.0 },
    },
    { id: 'probe-corner', ordinal: 3, type: 'probe', target: { kind: 'node', id: 'n6' }, quantity: 'displacement' },
  ],
};
writeFileSync(resolve(outDir, 'cube-fine.json'), JSON.stringify(fine, null, 2) + '\n');

// ---- 翻转网格：c1 的前两个节点交换，制造方向翻转 ----
const flipped = JSON.parse(JSON.stringify(coarse));
flipped.series = 'bracket-inverted';
flipped.version = 1;
flipped.name = '含翻转单元的网格';
{
  const c1 = flipped.cells[0];
  [c1.nodes[0], c1.nodes[1]] = [c1.nodes[1], c1.nodes[0]];
  // 面列表保持原来的正确边界面，翻转只体现在体单元方向。
}
writeFileSync(resolve(outDir, 'cube-flipped.json'), JSON.stringify(flipped, null, 2) + '\n');

// ---- 退化网格：零体积单元 + 悬空引用 + 冲突约束 ----
const broken = JSON.parse(JSON.stringify(coarse));
broken.series = 'bracket-broken';
broken.version = 1;
broken.name = '含零体积/悬空引用/冲突约束的网格';
{
  const c = broken.cells[0];
  c.id = 'c-bad-zero';
  c.nodes = ['n0', 'n1', 'n2', 'n2']; // 重复节点 -> 零体积
  broken.cells.push({ id: 'c-dangling', type: 'tet4', nodes: ['n0', 'n1', 'n999', 'n3'] });
  broken.sets[0].members.push({ kind: 'face', id: 'fb-ghost' });
  broken.objects.push({
    id: 'bc-fix-n0-dup', ordinal: 4, type: 'constraint',
    targets: [{ kind: 'node', id: 'n0' }],
    value: { dof: ['ux'], fixed: 1 }, // 与 bc-fix-n0 冲突
  });
}
writeFileSync(resolve(outDir, 'cube-broken.json'), JSON.stringify(broken, null, 2) + '\n');

console.log('fixtures 已生成:', {
  coarse: { nodes: coarse.nodes.length, cells: coarse.cells.length, faces: coarse.faces.length, top: topFaces.length },
  fine: { nodes: fine.nodes.length, cells: fine.cells.length, faces: fine.faces.length, top: fineTopFaces.length },
});
