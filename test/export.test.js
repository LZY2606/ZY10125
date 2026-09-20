import { describe, it, expect } from 'vitest';
import { preview, loadFixture } from './helpers.js';
import { applyEvidence } from '../server/src/plan.js';
import { buildExport, deterministicExport } from '../server/src/export.js';

const meta = {
  planId: 'p1', fromVersionId: 1, toVersionId: 2,
  fromHash: 'a', toHash: 'b',
  tolerances: { x: 1 }, acceptedAt: '2026-01-01T00:00:00Z', evidenceCount: 0,
};

describe('稳定标识与导出顺序', () => {
  it('先删除再重建：稳定 id、ordinal 顺序与成员确定性保持', () => {
    const coarse = loadFixture('cube-coarse');
    const fine = loadFixture('cube-fine');
    const pv = preview('cube-coarse', 'cube-fine');
    const applied = applyEvidence(pv, coarse, fine, []);

    // 打乱旧集合数组顺序模拟“先删除”，导出仍按 ordinal。
    const shuffled = structuredClone(coarse);
    shuffled.sets = [...coarse.sets].reverse();
    shuffled.objects = [...coarse.objects].reverse();
    const doc1 = buildExport(shuffled, fine, applied, meta);
    expect(doc1.mesh.sets.map((s) => s.id)).toEqual(['set-top', 'set-fixed-corner']);
    expect(doc1.mesh.objects.map((o) => o.id)).toEqual(['bc-fix-n0', 'load-top-pressure', 'probe-corner']);

    // 同一输入两次导出字节一致。
    const doc2 = buildExport(shuffled, fine, applied, meta);
    expect(deterministicExport(doc1)).toBe(deterministicExport(doc2));

    // 成员排序确定：node 类成员在集合中排在 face 之前。
    const fixed = doc1.mesh.sets.find((s) => s.id === 'set-fixed-corner');
    expect(fixed.members).toEqual([{ kind: 'node', id: 'n0' }]);
  });

  it('被禁用对象不进导出；被重建对象也不进导出', () => {
    const coarse = loadFixture('cube-coarse');
    const fine = loadFixture('cube-fine');
    const pv = preview('cube-coarse', 'cube-fine');
    const applied = applyEvidence(pv, coarse, fine, [
      { objectType: 'probe', objectId: 'probe-corner', action: 'disable' },
    ]);
    const doc = buildExport(coarse, fine, applied, meta);
    expect(doc.mesh.objects.find((o) => o.id === 'probe-corner')).toBeUndefined();
    expect(doc.mesh.objects.map((o) => o.id)).toEqual(['bc-fix-n0', 'load-top-pressure']);
  });
});
