// 所有数值容差在此集中定义；预览创建时冻结进计划，之后改动默认值不影响已接受结果。
export const DEFAULT_TOLERANCES = Object.freeze({
  nodeDistance: 1e-6,      // 节点坐标重合判定，m
  pointOnEntity: 1e-9,     // 点落在边/面上的绝对容差，m
  volume: 1e-12,           // 单元体积下限，m^3；低于视为零体积
  force: 1e-8,             // 总合力差，N
  moment: 1e-8,            // 总力矩差，N·m
  area: 1e-8,              // 面/区域面积或体积差，m^2 或 m^3
  orientation: 1e-12,      // 有符号体积判定阈值，m^3
});

export function freezeTolerances(overrides = {}) {
  const out = { ...DEFAULT_TOLERANCES };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in DEFAULT_TOLERANCES)) throw new Error(`未知容差项 ${k}`);
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) throw new Error(`容差 ${k} 必须是非负有限数`);
    out[k] = num;
  }
  return Object.freeze(out);
}
