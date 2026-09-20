import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { enrichMesh, createPreview, applyEvidence } from '../server/src/plan.js';

const here = dirname(fileURLToPath(import.meta.url));
export const fixtureDir = resolve(here, '..', 'fixtures', 'meshes');

export function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(fixtureDir, `${name}.json`), 'utf8'));
}
export function preview(oldName, newName, tol = {}) {
  return createPreview(enrichMesh(loadFixture(oldName)), enrichMesh(loadFixture(newName)), tol);
}
export function objectRow(pv, id, evidence = []) {
  const applied = applyEvidence(pv, null, null, evidence);
  return applied.objects.find((o) => o.objectId === id);
}
