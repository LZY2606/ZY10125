import { describe, it, expect } from 'vitest';
import { preview } from './helpers.js';
import { validateMesh } from '../server/src/mesh-validate.js';
import { enrichMesh } from '../server/src/plan.js';
import { freezeTolerances, DEFAULT_TOLERANCES } from '../server/src/tolerance.js';
import { loadFixture } from './helpers.js';

describe('网格验证器', () => {
  it('翻转单元报 INVERTED_CELL 并阻止预览', () => {
    const pv = preview('cube-flipped', 'cube-coarse');
    expect(pv.blocked).toBe(true);
    expect(pv.oldValidation.some((i) => i.code === 'INVERTED_CELL' && i.severity === 'error')).toBe(true);
  });
  it('退化/悬空/冲突约束全部检出', () => {
    const broken = preview('cube-broken', 'cube-coarse');
    expect(broken.blocked).toBe(true);
    const codes = broken.oldValidation.filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes).toContain('ZERO_VOLUME');
    expect(codes).toContain('DANGLING_REF');
    expect(codes).toContain('CONFLICTING_CONSTRAINT');
  });
  it('正常网格无错误项', () => {
    const issues = validateMesh(enrichMesh(loadFixture('cube-coarse')), freezeTolerances());
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('容差冻结', () => {
  it('计划冻结创建时的容差，与默认值独立', () => {
    const pv = preview('cube-coarse', 'cube-fine', { force: 0.002 });
    expect(Object.isFrozen(pv.tolerances)).toBe(true);
    expect(pv.tolerances.force).toBe(0.002);
    expect(DEFAULT_TOLERANCES.force).toBe(1e-8);
    expect(() => preview('cube-coarse', 'cube-fine', { unknownKey: 1 })).toThrow(/未知容差项/);
  });
});
