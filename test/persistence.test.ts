import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/server/db/repo.js';
import { MigrationService, ValidationError } from '../src/server/service.js';
import type { Mesh } from '../src/core/types.js';
import { readFileSync } from 'node:fs';
import { meshHash } from '../src/core/hash.js';
import { acceptPlan } from '../src/core/acceptance.js';
import type { FrozenPlan } from '../src/core/plan-types.js';

let dir: string;
let repo: Repository;
let service: MigrationService;

function fixture(name: string): Mesh {
  return JSON.parse(readFileSync(join(process.cwd(), 'fixtures', name), 'utf8')) as Mesh;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gsb-'));
  repo = new Repository(join(dir, 'migration.db'));
  service = new MigrationService(repo);
});

afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('content-addressed immutable meshes', () => {
  it('ingests once and is idempotent', () => {
    const m = fixture('cube-coarse-v1.json');
    const a = service.ingestMesh(m);
    const b = service.ingestMesh(m);
    expect(a.hash).toBe(b.hash);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  it('rejects a structurally broken mesh', () => {
    expect(() => service.ingestMesh(fixture('cube-broken-v4.json'))).toThrow(ValidationError);
  });
});

describe('optimistic concurrency', () => {
  it('rejects commit when the stored source mesh hash differs from the plan', () => {
    const oldMesh = fixture('cube-coarse-v1.json');
    const newMesh = fixture('cube-refined-v2.json');
    service.ingestMesh(oldMesh);
    service.ingestMesh(newMesh);
    const plan = service.createPreview(meshHash(oldMesh), meshHash(newMesh));

    // Tamper with the stored mesh row by inserting a modified grid under the
    // same logical mesh id: build a plan then replace repo content behind the
    // hash using a mutated payload with a different hash key is impossible;
    // instead call accept with a mutated mesh argument to model staleness.
    const mutated: Mesh = { ...oldMesh, name: 'mutated' };
    const staleResult = acceptPlan(plan, mutated, newMesh);
    expect(staleResult.ok).toBe(false);
    expect(staleResult.issues.some((i) => i.message.includes('hash changed'))).toBe(true);
  });
});

describe('acceptance transaction atomicity', () => {
  it('never flips plan to accepted when validation fails', () => {
    const oldMesh = fixture('cube-coarse-v1.json');
    const newMesh = fixture('cube-refined-v2.json');
    service.ingestMesh(oldMesh);
    service.ingestMesh(newMesh);
    const plan = service.createPreview(meshHash(oldMesh), meshHash(newMesh));

    // Force a failing acceptance by replacing the stored plan payload with a
    // plan whose newHash is correct but whose rows reference missing faces.
    const sabotaged: FrozenPlan = {
      ...plan,
      rows: plan.rows.map((r) =>
        r.kind === 'facePressure'
          ? {
              ...(r as object),
              status: 'complete',
              proposed: [{ faceKey: 'nn0,nn1,nn99', area: 1, pressure: 1, overlapArea: 0 }]
            }
          : r
      )
    } as FrozenPlan;
    repo.db.prepare('UPDATE plans SET payload = ? WHERE id = ?').run(JSON.stringify(sabotaged), plan.planId);

    const stored = repo.getPlan(plan.planId)!;
    const outcome = repo.acceptPlan(
      plan.planId,
      (p, o, n) => acceptPlan(p, o, n),
      (hash) => service.getMesh(hash)!
    );
    void stored;
    expect(outcome.ok).toBe(false);
    const after = repo.getPlan(plan.planId)!;
    expect(after.status).toBe('preview');
  });
});

describe('boundary regions use set semantics', () => {
  it('delete-and-rebuild with same members keeps the same sorted export', () => {
    service.replaceRegion({ id: 'top', name: 'Top', members: ['z', 'a', 'm', 'a'] });
    const first = service.listRegions().find((r) => r.id === 'top')!;
    expect(first.members).toEqual(['a', 'm', 'z']);

    service.replaceRegion({ id: 'top', name: 'Top renamed', members: ['m', 'z', 'a'] });
    const second = service.listRegions().find((r) => r.id === 'top')!;
    expect(second.members).toEqual(['a', 'm', 'z']);
  });
});
