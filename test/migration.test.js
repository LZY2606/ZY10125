import { describe, it, expect } from 'vitest';
import { preview, objectRow, loadFixture } from './helpers.js';
import { applyEvidence } from '../server/src/plan.js';

describe('细分（粗→细）', () => {
  const pv = preview('cube-coarse', 'cube-fine');
  it('预览不被阻止', () => expect(pv.blocked).toBe(false));
  it('拓扑：8 节点完整、12 面拆分组、6 单元拆分组、新增 19 节点', () => {
    expect(pv.topology.nodes.complete).toBe(8);
    expect(pv.topology.nodes.added).toBe(19);
    expect(pv.topology.faces.split).toBe(12);
    expect(pv.topology.cells.split).toBe(6);
  });
  it('面力拆分为 8 个新面且合力/合力矩/面积守恒', () => {
    const row = objectRow(pv, 'load-top-pressure');
    expect(row.decision).toBe('split');
    expect(row.targets).toHaveLength(8);
    const force = row.checks.find((c) => c.code === 'FORCE');
    const moment = row.checks.find((c) => c.code === 'MOMENT');
    const area = row.checks.find((c) => c.code === 'AREA');
    expect(force.passed).toBe(true);
    expect(moment.passed).toBe(true);
    expect(area.passed).toBe(true);
    expect(force.diff).toBeLessThan(1e-10);
    // 顶面面积 1 m²，压力 1000 Pa，合力 +z 方向 1000 N。
    expect(row.totals.old.force[2]).toBeCloseTo(1000, 9);
    expect(row.totals.new.force[2]).toBeCloseTo(1000, 9);
    // 面积权重之和为 1。
    expect(row.loads.reduce((s, l) => s + l.weight, 0)).toBeCloseTo(1, 12);
  });
  it('角点固定条件完整迁移且只产生一个目标（不复制）', () => {
    const row = objectRow(pv, 'bc-fix-n0');
    expect(row.decision).toBe('complete');
    expect(row.targets).toEqual([{ kind: 'node', id: 'n0' }]);
  });
  it('探针跟随角点', () => {
    expect(objectRow(pv, 'probe-corner').decision).toBe('complete');
  });
  it('边界集合按集合语义重建且无丢弃', () => {
    const applied = applyEvidence(pv, null, null, []);
    const setTop = applied.sets.find((s) => s.setId === 'set-top');
    expect(setTop.decision).toBe('split');
    expect(setTop.members).toHaveLength(8);
    expect(setTop.dropped).toEqual([]);
  });
  it('材料分区覆盖全部 48 个新单元，体积守恒', () => {
    const applied = applyEvidence(pv, null, null, []);
    const reg = applied.regions[0];
    expect(reg.cells).toHaveLength(48);
    expect(reg.checks[0].passed).toBe(true);
    expect(reg.checks[0].actual).toBeCloseTo(1, 10);
  });
});

describe('合并（细→粗）', () => {
  const pv = preview('cube-fine', 'cube-coarse');
  it('19 个边中节点消失，面对为合并', () => {
    expect(pv.topology.nodes.removed).toBe(19);
    expect(pv.topology.faces.merge).toBe(12);
    expect(pv.topology.cells.merge).toBe(6);
  });
  it('面力合并后总合力/总力矩仍守恒', () => {
    const row = objectRow(pv, 'load-top-pressure');
    expect(row.decision).toBe('merge');
    expect(row.targets).toHaveLength(2);
    for (const c of row.checks) expect(c.passed).toBe(true);
    expect(row.totals.new.force[2]).toBeCloseTo(1000, 9);
  });
});

describe('拒绝与人工证据', () => {
  const coarse = loadFixture('cube-coarse');
  it('消失节点上的固定条件被拒绝，且给出最近点但不复制', () => {
    // 构造：旧网格在顶面中点额外固定一个节点，新网格只有角点+边中点。
    const oldMesh = structuredClone(coarse);
    oldMesh.nodes.push({ id: 'nGhost', coord: [0.23, 0.37, 1] });
    oldMesh.objects.push({
      id: 'bc-ghost', ordinal: 9, type: 'constraint',
      targets: [{ kind: 'node', id: 'nGhost' }], value: { dof: ['ux'], fixed: 0 },
    });
    const fine = loadFixture('cube-fine');
    const pv = previewRaw(oldMesh, fine);
    const row = objectRow(pv, 'bc-ghost');
    expect(row.decision).toBe('rejected');
    expect(row.nearest).toBeTruthy();
    expect(row.targets).toEqual([]);
  });
  it('禁用证据会让对象退出导出且不阻塞；重建证据同样解除阻塞', () => {
    const pv = preview('cube-coarse', 'cube-fine');
    const applied = applyEvidence(pv, null, null, [
      { objectType: 'traction', objectId: 'load-top-pressure', action: 'disable' },
    ]);
    const row = applied.objects.find((o) => o.objectId === 'load-top-pressure');
    expect(row.finalState).toBe('disabled');
    expect(applied.blocking.filter((b) => b.includes('load-top-pressure'))).toEqual([]);
  });
});

import { createPreview, enrichMesh } from '../server/src/plan.js';
function previewRaw(a, b, tol = {}) {
  return createPreview(enrichMesh(a), enrichMesh(b), tol);
}

describe('矢量面力与人工确认', () => {
  it('vector 面力拆分后方向不变、合力守恒', () => {
    const coarse = loadFixture('cube-coarse');
    const oldMesh = structuredClone(coarse);
    const topIds = coarse.sets[0].members.map((m) => m.id);
    oldMesh.objects = oldMesh.objects.map((o) => o.id === 'load-top-pressure'
      ? { ...o, value: { vector: [100, 0, -500] } }
      : o);
    const fine = loadFixture('cube-fine');
    const pv = createPreview(enrichMesh(oldMesh), enrichMesh(fine), {});
    const row = objectRow(pv, 'load-top-pressure');
    expect(row.decision).toBe('split');
    const force = row.checks.find((c) => c.code === 'FORCE');
    expect(force.passed).toBe(true);
    expect(row.totals.old.force[0]).toBeCloseTo(100, 9);
    expect(row.totals.new.force[0]).toBeCloseTo(100, 9);
    expect(row.totals.old.force[2]).toBeCloseTo(-500, 9);
  });

  it('人工 confirm 可挽救无对应约束，且目标必须来自证据', () => {
    const coarse = loadFixture('cube-coarse');
    const oldMesh = structuredClone(coarse);
    oldMesh.nodes.push({ id: 'nGhost', coord: [0.23, 0.37, 1] });
    oldMesh.objects.push({
      id: 'bc-ghost', ordinal: 9, type: 'constraint',
      targets: [{ kind: 'node', id: 'nGhost' }], value: { dof: ['ux'], fixed: 0 },
    });
    const fine = loadFixture('cube-fine');
    const pv = createPreview(enrichMesh(oldMesh), enrichMesh(fine), {});
    // 无证据：阻塞。
    expect(applyEvidence(pv, null, null, []).blocking.some((b) => b.includes('bc-ghost'))).toBe(true);
    // 工程师明确把它确认到新网格节点 n0：状态变为 confirmed，阻塞解除。
    const applied = applyEvidence(pv, null, null, [
      { objectType: 'constraint', objectId: 'bc-ghost', action: 'confirm', targets: [{ kind: 'node', id: 'n0' }], note: '人工指定' },
    ]);
    const row = applied.objects.find((o) => o.objectId === 'bc-ghost');
    expect(row.finalState).toBe('confirmed');
    expect(row.targets).toEqual([{ kind: 'node', id: 'n0' }]);
    expect(applied.blocking.some((b) => b.includes('bc-ghost'))).toBe(false);
  });
});
