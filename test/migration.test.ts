import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mesh } from '../src/core/types.js';
import { validateMesh } from '../src/core/validator.js';
import { buildPlan } from '../src/core/plan.js';
import { acceptPlan } from '../src/core/acceptance.js';
import { buildTopology } from '../src/core/topology.js';
import { buildRefinedMesh } from '../src/core/refine.js';
import { assembleCube } from '../src/core/tet-cube.js';
import { faceKey } from '../src/core/types.js';
import type { FacePressureRow } from '../src/core/plan-types.js';

const fixtures = join(process.cwd(), 'fixtures');
function load(name: string): Mesh {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as Mesh;
}

describe('fixture meshes', () => {
  it('validates the three healthy cubes', () => {
    for (const name of ['cube-coarse-v1.json', 'cube-refined-v2.json', 'cube-coarse-v3.json']) {
      expect(validateMesh(load(name)).ok).toBe(true);
    }
  });

  it('flags inverted, zero-volume, dangling and duplicate issues', () => {
    const v = validateMesh(load('cube-broken-v4.json'));
    expect(v.ok).toBe(false);
    const codes = v.issues.map((i) => i.code);
    expect(codes).toContain('inverted-element');
    expect(codes).toContain('zero-volume-element');
    expect(codes).toContain('dangling-load-node');
    expect(codes).toContain('duplicate-constraint');
  });

  it('refinement conserves total volume', () => {
    const coarse = assembleCube({ id: 'c', name: 'c', prefix: 'n' });
    const fine = buildRefinedMesh(coarse, { id: 'f', name: 'f' }, 'r');
    expect(buildTopology(fine).totalVolume).toBeCloseTo(buildTopology(coarse).totalVolume, 10);
  });
});

describe('split migration v1 -> v2', () => {
  const oldMesh = load('cube-coarse-v1.json');
  const newMesh = load('cube-refined-v2.json');

  it('subdivides each face pressure with full coverage and conserved F and M', () => {
    const plan = buildPlan(oldMesh, newMesh);
    const pressures = plan.rows.filter(
      (r): r is FacePressureRow => r.kind === 'facePressure'
    );
    expect(pressures).toHaveLength(2);
    for (const row of pressures) {
      expect(row.status).toBe('split');
      expect(row.coverage).toBeCloseTo(1, 8);
      expect(row.proposed.length).toBeGreaterThan(1);
      expect(row.conservation?.forceOk).toBe(true);
      expect(row.conservation?.momentOk).toBe(true);
      expect(row.conservation?.forceError).toBeLessThan(1e-8);
      expect(row.conservation?.momentError).toBeLessThan(1e-6);
    }
  });

  it('maps corner constraints uniquely and migrates them', () => {
    const plan = buildPlan(oldMesh, newMesh);
    const fix0 = plan.rows.find((r) => r.id === 'fix-corner-0')!;
    expect(fix0.status).toBe('complete');
    expect(fix0.kind === 'constraint' && fix0.newNode).toBe('rnn0');
  });

  it('does not force a nearest node onto the center probe', () => {
    const plan = buildPlan(oldMesh, newMesh);
    const probe = plan.rows.find((r) => r.id === 'probe-center')!;
    expect(probe.status).toBe('unmatched');
  });

  it('accepts and reports the blocked probe but migrates the rest', () => {
    const plan = buildPlan(oldMesh, newMesh);
    const result = acceptPlan(plan, oldMesh, newMesh);
    expect(result.ok).toBe(true);
    expect(result.migratedCount).toBeGreaterThan(0);
    expect(result.blockedCount).toBe(1);
  });
});

describe('merge migration v2 -> v3', () => {
  const oldMesh = load('cube-refined-v2.json');
  const newMesh = load('cube-coarse-v3.json');

  it('reports merged face pressure with conserved resultant', () => {
    const plan = buildPlan(oldMesh, newMesh);
    const top = plan.rows.find((r) => r.id === 'load-top-pressure') as FacePressureRow;
    expect(top.status).toBe('merged');
    expect(top.conservation?.forceOk).toBe(true);
    expect(top.conservation?.momentOk).toBe(true);
  });

  it('rejects the refined-midpoint fixity instead of duplicating it to a coarse node', () => {
    const plan = buildPlan(oldMesh, newMesh);
    const mid = plan.rows.find((r) => r.id === 'fix-refined-midpoint')!;
    expect(mid.status).toBe('unmatched');
    expect(mid.reasons.join(' ')).toMatch(/not copied/);
  });

  it('classifies the zone as merged', () => {
    const plan = buildPlan(oldMesh, newMesh);
    const zone = plan.rows.find((r) => r.kind === 'zone')!;
    expect(zone.status).toBe('merged');
  });
});

describe('manual evidence and frozen tolerances', () => {
  it('a disable decision blocks the object and a reset restores machine status', () => {
    const oldMesh = load('cube-coarse-v1.json');
    const newMesh = load('cube-refined-v2.json');
    const plan0 = buildPlan(oldMesh, newMesh);
    const before = plan0.rows.find((r) => r.id === 'load-top-pressure')!.status;
    const plan1 = buildPlan(oldMesh, newMesh, {
      decisions: [
        {
          id: 'd1',
          entityKind: 'load',
          entityId: 'load-top-pressure',
          action: 'disable',
          author: 'eng',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    });
    expect(plan1.rows.find((r) => r.id === 'load-top-pressure')!.status).toBe('disabled');
    const plan2 = buildPlan(oldMesh, newMesh, {
      decisions: [
        { id: 'd1', entityKind: 'load', entityId: 'load-top-pressure', action: 'disable', author: 'eng', createdAt: 'x' },
        { id: 'd2', entityKind: 'load', entityId: 'load-top-pressure', action: 'reset', author: 'eng', createdAt: 'y' }
      ]
    });
    expect(plan2.rows.find((r) => r.id === 'load-top-pressure')!.status).toBe(before);
  });

  it('changing default tolerances does not alter an accepted frozen plan', () => {
    const oldMesh = load('cube-coarse-v1.json');
    const newMesh = load('cube-refined-v2.json');
    const plan = buildPlan(oldMesh, newMesh, {
      tolerances: { ...planTolerances(), forceRelTol: 1e-3 }
    });
    expect(plan.tolerances.forceRelTol).toBe(1e-3);
    const result = acceptPlan(plan, oldMesh, newMesh);
    expect(result.ok).toBe(true);
    expect(plan.tolerances.forceRelTol).toBe(1e-3);
  });
});

function planTolerances() {
  return buildPlan(load('cube-coarse-v1.json'), load('cube-refined-v2.json')).tolerances;
}

describe('ambiguous N:M is never force-snapped', () => {
  it('leaves an unmapped pressure with no proposed faces as ambiguous/unmatched', () => {
    const a = assembleCube({ id: 'a', name: 'a', prefix: 'a' });
    const b = assembleCube({
      id: 'b',
      name: 'b',
      prefix: 'b',
      corners: [
        [9, 9, 9],
        [10, 9, 9],
        [10, 10, 9],
        [9, 10, 9],
        [9, 9, 10],
        [10, 9, 10],
        [10, 10, 10],
        [9, 10, 10]
      ]
    });
    a.loads.push({
      id: 'lonely',
      kind: 'facePressure',
      faces: a.faces.filter((f) => f.region === 'top').map((f) => faceKey(f.nodes)),
      pressure: 1
    });
    const plan = buildPlan(a, b);
    const row = plan.rows.find((r) => r.id === 'lonely') as FacePressureRow;
    expect(['unmatched', 'ambiguous']).toContain(row.status);
    expect(row.proposed).toHaveLength(0);
  });
});
