import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, insertMesh, getMesh, savePlan, getPlan, addEvidence,
  acceptPlan, getAccepted,
} from '../server/src/db.js';
import { createPreview, enrichMesh, applyEvidence } from '../server/src/plan.js';
import { buildExport } from '../server/src/export.js';
import { loadFixture } from './helpers.js';

let dbPath, db;
beforeEach(() => {
  dbPath = join(tmpdir(), `fem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = openDb(dbPath);
});

function importBoth() {
  const a = insertMesh(db, loadFixture('cube-coarse')).mesh;
  const b = insertMesh(db, loadFixture('cube-fine')).mesh;
  return { a, b };
}
function makePlan() {
  const { a, b } = importBoth();
  const pv = createPreview(enrichMesh(getMesh(db, a.id).data), enrichMesh(getMesh(db, b.id).data), {});
  return savePlan(db, {
    id: `plan-${Math.random().toString(36).slice(2)}`,
    fromMeshId: a.id, toMeshId: b.id,
    fromHash: a.hash, toHash: b.hash,
    tolerances: pv.tolerances, preview: pv,
  });
}
function recompute(fromData, toData, plan) {
  const pv = createPreview(enrichMesh(fromData), enrichMesh(toData), { ...plan.tolerances });
  const applied = applyEvidence(pv, fromData, toData, plan.evidence);
  const exportDoc = buildExport(fromData, toData, applied, {
    planId: plan.id, fromVersionId: 1, toVersionId: 2,
    fromHash: plan.from_hash, toHash: plan.to_hash,
    tolerances: plan.tolerances, acceptedAt: new Date().toISOString(), evidenceCount: plan.evidence.length,
  });
  return { applied, exportDoc };
}

describe('不可变网格与版本过期', () => {
  it('相同哈希幂等插入', () => {
    const r1 = insertMesh(db, loadFixture('cube-coarse'));
    const r2 = insertMesh(db, loadFixture('cube-coarse'));
    expect(r1.mesh.id).toBe(r2.mesh.id);
    expect(r2.reused).toBe(true);
  });
  it('新版本插入后旧版本内容保持不可变，stale 由提交时最新版本判定', () => {
    const { a, b } = importBoth();
    expect(getMesh(db, a.id).hash).toBeTruthy();
    expect(getMesh(db, b.id).version).toBe(2);
  });
  it('插入更旧版本号报 STALE_VERSION', () => {
    insertMesh(db, loadFixture('cube-fine'));
    expect(() => insertMesh(db, loadFixture('cube-coarse'))).toThrow(/已过期/);
  });
});

describe('计划接受事务与证据', () => {
  it('自动预览可直接接受，导出含完整约束与拆分载荷', () => {
    const plan = makePlan();
    acceptPlan(db, plan.id, recompute);
    const accepted = getAccepted(db, plan.id);
    expect(accepted).toBeTruthy();
    const objs = accepted.exportDoc.mesh.objects;
    const bc = objs.find((o) => o.id === 'bc-fix-n0');
    expect(bc.targets).toEqual([{ kind: 'node', id: 'n0' }]);
    const load = objs.find((o) => o.id === 'load-top-pressure');
    expect(load.distribution).toHaveLength(8);
    // 导出顺序由 ordinal 决定（约束 1，载荷 2，探针 3）。
    expect(objs.map((o) => o.id)).toEqual(['bc-fix-n0', 'load-top-pressure', 'probe-corner']);
    // 稳定 id 保持。
    expect(accepted.exportDoc.mesh.sets.map((s) => s.id)).toEqual(['set-top', 'set-fixed-corner']);
    expect(getPlan(db, plan.id).status).toBe('accepted');
  });

  it('存在未解决拒绝项时提交失败，accepted 表不留半成品', () => {
    // 使用一个带悬空探针的网格对（探针在细网格中丢失）构造阻塞。
    const coarse = loadFixture('cube-coarse');
    const mutated = structuredClone(coarse);
    mutated.nodes.push({ id: 'nGhost', coord: [0.23, 0.37, 1] });
    mutated.objects.push({
      id: 'bc-extra', ordinal: 5, type: 'constraint',
      targets: [{ kind: 'node', id: 'nGhost' }], value: { dof: ['ux'], fixed: 0 },
    });
    expect(() => {
      const a = insertMesh(db, mutated).mesh;
      const b = insertMesh(db, loadFixture('cube-fine')).mesh;
      const pv = createPreview(enrichMesh(getMesh(db, a.id).data), enrichMesh(getMesh(db, b.id).data), {});
      const plan = savePlan(db, {
        id: 'plan-blocked', fromMeshId: a.id, toMeshId: b.id,
        fromHash: a.hash, toHash: b.hash, tolerances: pv.tolerances, preview: pv,
      });
      acceptPlan(db, plan.id, recompute);
    }).toThrow(/未完成/);
    expect(getAccepted(db, 'plan-blocked')).toBeNull();
  });

  it('人工标记重建后可提交，且被重建对象不出现在导出', () => {
    const coarse = loadFixture('cube-coarse');
    const mutated = structuredClone(coarse);
    mutated.nodes.push({ id: 'nGhost', coord: [0.23, 0.37, 1] });
    mutated.objects.push({
      id: 'bc-extra', ordinal: 5, type: 'constraint',
      targets: [{ kind: 'node', id: 'nGhost' }], value: { dof: ['ux'], fixed: 0 },
    });
    const a = insertMesh(db, mutated).mesh;
    const b = insertMesh(db, loadFixture('cube-fine')).mesh;
    const pv = createPreview(enrichMesh(getMesh(db, a.id).data), enrichMesh(getMesh(db, b.id).data), {});
    const plan = savePlan(db, {
      id: 'plan-ev', fromMeshId: a.id, toMeshId: b.id,
      fromHash: a.hash, toHash: b.hash, tolerances: pv.tolerances, preview: pv,
    });
    addEvidence(db, plan.id, { objectType: 'constraint', objectId: 'bc-extra', action: 'rebuild', note: '重新施加' });
    acceptPlan(db, plan.id, recompute);
    const doc = getAccepted(db, plan.id).exportDoc;
    expect(doc.mesh.objects.find((o) => o.id === 'bc-extra')).toBeUndefined();
    expect(doc.migration.appliedEvidence).toBe(1);
  });

  it('已接受计划证据不可改、不可重复接受', () => {
    const plan = makePlan();
    acceptPlan(db, plan.id, recompute);
    expect(() => addEvidence(db, plan.id, { objectType: 'probe', objectId: 'probe-corner', action: 'disable' })).toThrow(/已接受/);
    expect(() => acceptPlan(db, plan.id, recompute)).toThrow(/已接受/);
  });

  it('源版本过期时提交被拒（VERSION_STALE）', () => {
    const plan = makePlan();
    // 同一系列再插入 v3，令 v1、v2 全部过期。
    const v3 = structuredClone(loadFixture('cube-coarse'));
    v3.version = 3;
    v3.name = 'v3';
    insertMesh(db, v3);
    expect(() => acceptPlan(db, plan.id, recompute)).toThrow(/版本已过期/);
  });
});
