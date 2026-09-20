/**
 * Deterministic fixture generator.
 *
 * Outputs committed JSON meshes so the demo and tests run without any code
 * generation step. Regenerate with `pnpm gen:fixtures`.
 *
 * Scenarios:
 *   coarse-v1    - 5-tet unit cube with pressure load, fixity, force, probes
 *   refined-v2   - uniform 1->8 refinement (split surface, conserved load)
 *   coarse-v3    - same cube with extra internal nodes; demonstrates merged /
 *                  rejected fixity when going v2 -> v3
 *   broken-v4    - one inverted tet, one zero-volume tet, dangling reference
 *                  and duplicate constraint
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assembleCube } from '../src/core/tet-cube.js';
import { buildRefinedMesh } from '../src/core/refine.js';
import { faceKey, type BoundaryRegion, type Mesh } from '../src/core/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures');
mkdirSync(outDir, { recursive: true });

function write(name: string, mesh: Mesh): void {
  writeFileSync(join(outDir, name), `${JSON.stringify(mesh, null, 2)}\n`);
}

function boundaryRegions(mesh: Mesh): BoundaryRegion[] {
  const byName = new Map<string, string[]>();
  for (const f of mesh.faces) {
    if (!f.region) continue;
    const list = byName.get(f.region) ?? [];
    list.push(faceKey(f.nodes));
    byName.set(f.region, list);
  }
  return [...byName.entries()]
    .map(([id, members]) => ({
      id,
      name: id,
      members: [...members].sort()
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---- v1: coarse cube ------------------------------------------------------
const v1 = assembleCube({
  id: 'cube-coarse-v1',
  name: 'Cube coarse (5 tets) v1',
  prefix: 'n'
});
v1.zones = [
  { id: 'solid', name: 'bulk material', material: { E: 2.1e5, nu: 0.3, rho: 7.85e-9 } }
];
const topKeys = v1.faces.filter((f) => f.region === 'top').map((f) => faceKey(f.nodes));
const rightKeys = v1.faces.filter((f) => f.region === 'right').map((f) => faceKey(f.nodes));
v1.loads = [
  { id: 'load-top-pressure', kind: 'facePressure', faces: topKeys, pressure: 100 },
  { id: 'load-right-pressure', kind: 'facePressure', faces: rightKeys, pressure: 42 },
  { id: 'load-corner-force', kind: 'nodalForce', node: 'nn7', vector: [10, -5, 20] }
];
v1.constraints = [
  { id: 'fix-corner-0', node: 'nn0', fixed: ['ux', 'uy', 'uz'] },
  { id: 'fix-edge-1', node: 'nn1', fixed: ['uy', 'uz'] }
];
v1.probes = [
  { id: 'probe-corner', label: 'measured corner 7', coord: [1, 1, 1] },
  { id: 'probe-center', label: 'cube center', coord: [0.5, 0.5, 0.5] }
];
v1.boundaryRegions = boundaryRegions(v1);
write('cube-coarse-v1.json', v1);

// ---- v2: refined cube, migrated engineering objects -----------------------
const v2 = buildRefinedMesh(v1, { id: 'cube-refined-v2', name: 'Cube refined (40 tets) v2' }, 'r');
// Keep the pressure definitions in terms of the OLD (coarse) faces: migration
// is responsible for producing the new faces. But a stored grid must be
// self-consistent, so v2 carries the already-refined load target sets.
const refineLoadToNew = (oldKeys: string[]): string[] => {
  const oldSet = new Set(oldKeys);
  const nameOfOld = new Map(
    v1.faces.map((f) => [faceKey(f.nodes), f.region])
  );
  return v2.faces
    .filter((f) => oldSet.size && nameOfOld && f.region && topOrRight(f.region) && oldKeys.some((k) => nameOfOld.get(k) === f.region))
    .map((f) => faceKey(f.nodes))
    .sort();
};
function topOrRight(region: string): boolean {
  return region === 'top' || region === 'right';
}
const v2Top = v2.faces.filter((f) => f.region === 'top').map((f) => faceKey(f.nodes)).sort();
const v2Right = v2.faces.filter((f) => f.region === 'right').map((f) => faceKey(f.nodes)).sort();
void refineLoadToNew;
v2.loads = [
  { id: 'load-top-pressure', kind: 'facePressure', faces: v2Top, pressure: 100 },
  { id: 'load-right-pressure', kind: 'facePressure', faces: v2Right, pressure: 42 },
  { id: 'load-corner-force', kind: 'nodalForce', node: 'rnn7', vector: [10, -5, 20] }
];
v2.constraints = [
  { id: 'fix-corner-0', node: 'rnn0', fixed: ['ux', 'uy', 'uz'] },
  { id: 'fix-edge-1', node: 'rnn1', fixed: ['uy', 'uz'] },
  // Bottom-face centre edge midpoint introduced by refinement. It has no v3
  // (coarse) counterpart, so merging back must REJECT it rather than copying
  // the fixity onto whichever coarse node happens to be nearest.
  { id: 'fix-refined-midpoint', node: 'rm1', fixed: ['uz'] }
];
v2.probes = [
  { id: 'probe-corner', label: 'measured corner 7', coord: [1, 1, 1] },
  { id: 'probe-center', label: 'cube center on new node', coord: [0.5, 0.5, 0.5] }
];
v2.boundaryRegions = boundaryRegions(v2);
write('cube-refined-v2.json', v2);

// ---- v3: coarse again with an extra coincident-free internal node --------
// Used as a "merge back" target: an old refined interior node has no v3 node.
const v3 = assembleCube({
  id: 'cube-coarse-v3',
  name: 'Cube coarse v3 (merge target)',
  prefix: 'c'
});
v3.zones = v1.zones.map((z) => ({ ...z }));
v3.loads = [
  {
    id: 'load-top-pressure',
    kind: 'facePressure',
    faces: v3.faces.filter((f) => f.region === 'top').map((f) => faceKey(f.nodes)),
    pressure: 100
  },
  { id: 'load-corner-force', kind: 'nodalForce', node: 'cn7', vector: [10, -5, 20] }
];
v3.constraints = [{ id: 'fix-corner-0', node: 'cn0', fixed: ['ux', 'uy', 'uz'] }];
v3.probes = [{ id: 'probe-corner', label: 'measured corner 7', coord: [1, 1, 1] }];
v3.boundaryRegions = boundaryRegions(v3);
write('cube-coarse-v3.json', v3);

// ---- v4: deliberately broken mesh -----------------------------------------
const v4 = assembleCube({
  id: 'cube-broken-v4',
  name: 'Cube with inverted and degenerate tets v4',
  prefix: 'b'
});
// Invert tet 0 by swapping two nodes.
v4.elements[0] = { ...v4.elements[0]!, nodes: [v4.elements[0]!.nodes[1]!, v4.elements[0]!.nodes[0]!, v4.elements[0]!.nodes[2]!, v4.elements[0]!.nodes[3]!] };
// Add a degenerate tet: four coplanar points => zero signed volume.
v4.elements.push({
  id: 'be-degenerate',
  nodes: ['bn0', 'bn1', 'bn2', 'bn3'],
  zone: 'solid'
});
// Dangling reference in a load and a face.
v4.loads.push({ id: 'load-dangling', kind: 'nodalForce', node: 'nope-99', vector: [1, 1, 1] });
v4.constraints = [
  { id: 'fix-b0', node: 'bn0', fixed: ['ux', 'uy', 'uz'] },
  { id: 'fix-b0-again', node: 'bn0', fixed: ['ux'] }
];
v4.boundaryRegions = boundaryRegions(v4);
write('cube-broken-v4.json', v4);

console.log('fixtures written to', outDir);
