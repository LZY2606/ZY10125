# 有限元网格版本迁移（Pair-wise FEM Mesh Migration）

工程师在反复细化、合并或局部替换有限元网格时，旧网格上的**约束、载荷、材料分区、探针位置和边界集合**必须迁移到新网格。本项目用小型 JSON 网格（而非商业求解器格式）演示一套可审计的版本间迁移系统：

- 管理节点、边、面、单元在两个**不可变网格版本**之间的对应；
- 对每个工程对象给出**完整 / 拆分 / 合并 / 拒绝 / 重建**结论，并说明理由；
- 对拆分载荷核算**总合力、总力矩、面积**守恒，节点固定条件绝不因“最近点”被复制；
- 人工**确认 / 禁用 / 标记重建**作为只追加的证据保存；
- 验证器检查单元方向、零体积、悬空引用、重复约束、保守量；
- 一对多、多对一、无对应都是正常结果，系统不会为了“全部成功”强配最近邻。

## 技术栈

- Node.js（要求 ≥ 22.9，开发环境 Node 26），SQLite 使用内置 `node:sqlite`，**无原生编译依赖**；
- Vite 7 图形界面（无前端框架，原生 ES Module）；
- Vitest 3 测试；
- 数据库文件默认 `data/app.db`（WAL 模式）。

## 安装

```bash
corepack pnpm install --frozen-lockfile
```

> pnpm 12 对 esbuild 的构建脚本采用显式批准，已在 `pnpm-workspace.yaml` 的
> `onlyBuiltDependencies` 中声明。

## 测试与演示

```bash
corepack pnpm test -- --run
corepack pnpm dev -- --host 127.0.0.1 --port 5325 --strictPort
```

浏览器打开 <http://127.0.0.1:5325>。

界面工作流：

1. 在两个下拉框选择旧、新网格版本（fixture 启动时自动注册）；
2. 查看**拓扑差异**（完整/拆分/合并/歧义/无对应/新增计数）；
3. 查看**几何距离**（配对节点最大/平均距离、面对对称 Hausdorff 距离）；
4. 查看**候选对应**（面、单元、边分组，歧义/无对应分组默认展开）；
5. 查看**迁移预览**：每个对象的结论、理由、载荷面积权重、合力/力矩/面积检查；
6. 对任一行点击**确认 / 禁用 / 重建**，证据写入第 8 区；
7. 无阻塞项后**事务提交**，已接受计划可下载导出 JSON。

仅 API 模式：`corepack pnpm start`（默认 `127.0.0.1:5325`，可用 `PORT`/`HOST` 覆盖）。

## 网格 JSON 格式

```json
{
  "series": "bracket",
  "version": 1,
  "name": "支架粗网格 v1",
  "nodes": [{ "id": "n0", "coord": [0.0, 0.0, 0.0] }],
  "cells": [{ "id": "c1", "type": "tet4", "nodes": ["n0", "n1", "n2", "n6"] }],
  "faces": [{ "id": "fb1", "type": "tri3", "nodes": ["n0", "n2", "n1"] }],
  "regions": [{ "id": "reg-steel", "ordinal": 1, "material": "steel-S355", "cells": ["c1"] }],
  "sets":   [{ "id": "set-top", "ordinal": 1, "kind": "boundary",
               "members": [{ "kind": "face", "id": "fb1" }] }],
  "objects": [
    { "id": "bc-fix-n0", "ordinal": 1, "type": "constraint",
      "targets": [{ "kind": "node", "id": "n0" }],
      "value": { "dof": ["ux", "uy", "uz"], "fixed": 0 } },
    { "id": "load-top-pressure", "ordinal": 2, "type": "traction",
      "targets": [{ "kind": "face", "id": "fb1" }],
      "value": { "pressure": 1000.0 } },
    { "id": "probe-corner", "ordinal": 3, "type": "probe",
      "target": { "kind": "node", "id": "n6" }, "quantity": "displacement" }
  ]
}
```

- 仅支持 `tet4` 体单元与 `tri3` 面；边由体单元自动推导，不要求在 JSON 中给出。
- `faces` 由 `corepack pnpm fixtures` 从体单元邻接关系推导（恰好邻接 1 个单元的面为边界面）。

## 坐标约定

- 右手笛卡尔坐标系，长度单位 m，力 N，压力/矢量面力 Pa（N/m²），力矩 N·m。
- **tet4 方向**：`det(b−a, c−a, d−a) > 0` 为方向正确，有符号体积 `V = det/6`。
  负号 = `INVERTED_CELL`，绝对值低于 `orientation` 容差 = `ZERO_VOLUME`。
- tri3 面积为两棱叉积模长的一半；面积为零报 `ZERO_AREA`。

## 拓扑稳定标识

节点、边、面、单元的身份**不依赖数组下标**：

| 实体 | 稳定 key |
| --- | --- |
| 节点 | `n:x,y,z`（坐标保留 12 位小数） |
| 边 | `e:[排序后的两个节点 id]` |
| 面 | `f:[排序后的三个节点 id]` |
| 单元 | `c:[排序后的四个节点 id]` |

边界面 = 在全部 tet 局部面中只出现一次的面（出现 2 次是内部面；>2 报 `NON_MANIFOLD`）。

**跨版本身份不靠 id，而靠几何**：

- 节点：坐标距离在 `nodeDistance` 内互为候选，按距离升序贪心配对，保证一对一；
- 面：经节点映射得到相同节点组 → 完整；否则用“新面角点落在旧面平面三角形上”判定空间重叠；
- 边：端点落在另一线段上（共线 + 投影在段内）；
- 单元：四角点都在另一四面体中（线性方程组解重心坐标，允许 −tol 误差）。

将新旧实体间的重叠关系视为二部图，取**连通分量**为一个对应分组，按成员数分类：

- 1↔1 `complete`，1↔N `split`，N↔1 `merge`，N↔M `ambiguous`；
- 只在一侧 = `removed` / `new`（无对应），同样展示给用户，不做最近邻填充。

## 工程对象迁移规则

- **单节点约束**：节点有唯一对应 → 完整迁移，目标只有一个节点；无对应 → **拒绝**，
  并在结果里给出最近节点与距离作为参考，但**绝不自动复制**固定条件。
- **探针**：跟随唯一对应节点；节点消失则拒绝并建议重建。
- **面载荷（traction）**：取支撑面所属分组的并集；
  - `complete`：载荷整体迁移；
  - `split`：按每个新面面积占总面积的比例给出 `distribution`（面积权重）；
  - `merge`：合并到新面施加；
  - `ambiguous`（多对多）/无对应：拒绝，可人工选定或标记重建。
- **边界集合（set）**：纯集合语义。成员按节点/面/单元对应重建并去重；
  部分成员无对应时结论为 `partial` 并列出 dropped。先删除再重建**保持稳定 id**，
  导出成员按 `node < edge < face < cell` 及 id 排序，对象按来源 `ordinal` 排序，
  因而删除-重建不改变稳定标识与导出顺序。
- **材料分区（region）**：按单元分组映射；若一个新单元被多个旧分区主张，
  报材料归属冲突并要求重建；另核算分区体积守恒。

## 保守量口径

对每个三角形取面积与形心：

- **总合力**：
  - 矢量面力 `value.vector`（N/m²）：`F = vector · ΣAᵢ`；
  - 压力 `value.pressure`（Pa）：`F = pressure · Σ(n̂ᵢ Aᵢ)`，
    其中 `n̂ᵢ` 是各面**面积加权平均**的单位外法线。
- **合力作用点**：各面形心按面积加权 `r = Σ cᵢAᵢ / ΣAᵢ`。
- **总力矩**：绕坐标原点 `M = r × F`（单位 N·m）。
- 面积差 `|ΣA_new − ΣA_old|` 也单独校验。

拆分/合并后三项差值（FORCE、MOMENT、AREA）必须同时在冻结容差内才算通过；
任何一项失败，自动结论为拒绝，需人工确认并给出明确目标或标记重建。
单位立方体 fixture 顶面 `pressure = 1000 Pa` 时，总合力为 `[0, 0, 1000] N`。

## 容差冻结

容差在 `server/src/tolerance.js` 集中声明，随**每个迁移计划**冻结：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `nodeDistance` | `1e-6` | 节点重合距离，m |
| `pointOnEntity` | `1e-9` | 点落在线/面上的绝对距离，m |
| `volume` | `1e-12` | 单元零体积下限，m³ |
| `force` | `1e-8` | 总合力差，N |
| `moment` | `1e-8` | 总力矩差，N·m |
| `area` | `1e-8` | 面积/体积差 |
| `orientation` | `1e-12` | 方向判定体积阈值，m³ |

创建预览时容差写入 `plans.tolerances`；**提交时用计划内冻结值重新计算**，
之后修改代码默认值不会重写任何已存在或已接受的计划。

## 人工证据模型

证据表只追加（每行含对象、动作、目标、备注、作者、时间）：

- `confirm`：工程师确认该对应（可挽救自动拒绝项，需在 API 中给出明确 `targets`/`loads`）；
- `disable`：该对象不迁移，也不进入导出，不阻塞提交；
- `rebuild`：标记“在新网格上重建”，从导出中剔除，不阻塞提交。

同一对象以**最新一条**证据为准，历史全部保留。接受条件：每个对象要么
（自动或人工确认后）通过全部保守量检查，要么被禁用/标记重建；否则提交返回
422 并给出阻塞清单。

## 不可变版本、过期检查与事务

- 网格内容规范化 JSON（键排序）后取 SHA-256 存于 `meshes.hash`，`UNIQUE(hash)` 保证幂等；
- 同一系列插入更小版本号返回 `STALE_VERSION`；
- **提交时检查版本未过期**：计划目标必须仍是该系列 `MAX(version)`；
  预览后若出现 v3，v2 计划提交返回 409 `VERSION_STALE`；
- 提交前还会复检两端网格哈希与预览哈希一致（`HASH_MISMATCH`）；
- 接受动作在 `BEGIN IMMEDIATE … COMMIT` 单事务内更新 `plans.status` 并写 `accepted`；
  任一步失败即 `ROLLBACK`，不会留下“只迁移了一部分载荷”的方案。
- 已接受计划证据不可改、不可重复接受。

## Fixture

`corepack pnpm fixtures` 生成 `fixtures/meshes/`（单位立方体）：

| 文件 | 内容 |
| --- | --- |
| `cube-coarse.json` | 8 节点、6 个正向 tet（共享主对角线）、12 边界面；顶面压力、n0 固定、角点探针 |
| `cube-fine.json` | Bey 全细化：每 tet → 8 个正向子 tet（27 节点、48 tet、48 边界面、8 顶面），用于细分与（反向）合并演示 |
| `cube-flipped.json` | 一个单元前两节点交换，制造 `INVERTED_CELL` |
| `cube-broken.json` | 零体积单元（重复节点）、悬空单元/集合引用、与既有固定冲突的重复约束 |

## HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/meshes` | 版本列表（含 stale 标记） |
| `POST /api/meshes` | 上传网格版本 `{mesh}` |
| `GET /api/meshes/:id` | 取不可变网格内容与哈希 |
| `POST /api/plans` | `{fromMeshId,toMeshId,tolerances?}` 创建冻结预览 |
| `GET /api/plans/:id` | 计划、预览、证据、应用后状态与阻塞项 |
| `POST /api/plans/:id/evidence` | 追加人工证据 |
| `POST /api/plans/:id/accept` | 过期/哈希检查后事务提交 |
| `GET /api/plans/:id/export` | 下载接受后的导出 JSON |

## 目录结构

```
server/src/  geometry.js 坐标/体积/包含关系；mesh.js 拓扑 key/边界面/哈希
             correspondence.js 节点/边/面/单元对应分组
             mesh-validate.js 网格级验证器；migration.js 对象迁移与保守量
             plan.js 预览组装与证据应用；export.js 稳定导出
             tolerance.js 容差默认与冻结；db.js SQLite；app.js HTTP
web/         Vite 界面（index.html + src/）
scripts/     fixture 生成器（6-tet 粗网格 + Bey 细化）
fixtures/    生成的 JSON 网格
test/        Vitest 测试（几何、细分/合并、拒绝、证据、验证器、事务/过期）
```
