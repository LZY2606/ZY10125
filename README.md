# FEA 网格版本迁移台（Pair-wise Mesh Migration）

仿真工程师反复**细化、合并或局部替换**有限元网格。本项目管理两个网格版本之间的
节点、边、面、单元对应，并把老网格上的**约束、载荷、材料分区和探针**迁移到新网格，
对每个工程对象给出“**完全 / 拆分 / 合并 / 歧义 / 无对应（拒绝）/ 禁用 / 需重建**”的
明确理由。所有网格都是小型 JSON，不读取任何商业求解器格式。

* Node.js 服务（Express + TypeScript）
* Vite 图形界面（原生 TS，无重型前端框架）
* SQLite 持久化（`better-sqlite3`，内容寻址、事务提交）
* 覆盖细分、合并、翻转与退化单元的 fixture 与自动化测试

---

## 1. 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run
corepack pnpm dev -- --host 127.0.0.1 --port 5325 --strictPort
```

浏览器打开 <http://127.0.0.1:5325>。

首次启动会把 `fixtures/*.json` 中**结构合法**的网格自动入库（内容寻址，重复启动幂等）；
故意损坏的 `cube-broken-v4.json` 会被校验器拒绝（这是预期行为，用于演示校验）。
也可以在界面右上角上传任意符合 schema 的 JSON 网格。

其它命令：

```bash
corepack pnpm gen:fixtures   # 用确定性脚本重新生成 fixtures/*.json
corepack pnpm build          # 仅构建前端到 dist/
corepack pnpm typecheck      # 全仓 TypeScript 严格类型检查
```

生产模式（存在 `dist/` 或 `NODE_ENV=production`）下 Express 直接托管构建产物。

---

## 2. 网格 JSON 与坐标约定

Schema 为 `fem-json/1`（见 `fixtures/cube-coarse-v1.json`）：

```jsonc
{
  "schema": "fem-json/1",
  "id": "cube-coarse-v1",
  "name": "Cube coarse (5 tets) v1",
  "nodes":     [{ "id": "n0", "coord": [0, 0, 0] }],
  "elements":  [{ "id": "e0", "nodes": ["n0","n1","n2","n5"], "zone": "solid" }],
  "faces":     [{ "id": "f0", "nodes": ["n1","n0","n2"], "region": "bottom" }],
  "zones":     [{ "id": "solid", "name": "bulk", "material": { "E": 210000, "nu": 0.3 } }],
  "loads":     [
    { "id": "load-top", "kind": "facePressure", "faces": ["…面拓扑键…"], "pressure": 100 },
    { "id": "load-f",   "kind": "nodalForce", "node": "n7", "vector": [10,-5,20] }
  ],
  "constraints": [{ "id": "fix0", "node": "n0", "fixed": ["ux","uy","uz"] }],
  "probes":      [{ "id": "probe1", "label": "corner", "coord": [1,1,1] }],
  "boundaryRegions": [{ "id": "top", "name": "top", "members": ["…面拓扑键…"] }]
}
```

* **坐标系**：右手直角坐标系，长度单位任意，但同一次迁移的两个网格必须一致。
  fixture 使用单位立方体（边长 1）。
* **单元**：线性四面体 tet4，节点缠绕遵循右手定则，**正有向体积**为单元朝外。
  校验器报告负体积（`inverted-element`，警告）和零体积
  （`zero-volume-element`，错误）。
* **边界面**：三角形，缠绕方向定义外法向。面是否“朝外”由其所属四面体的对顶点
  判定——对顶点必须位于面的背面。

### Fixture 场景

| 文件 | 拓扑 | 作用 |
| --- | --- | --- |
| `cube-coarse-v1.json` | 单位立方体，5 个正体积 tet，12 个边界面 | 源网格：面压力、节点力、两个固定、两个探针 |
| `cube-refined-v2.json` | 均匀 1→8 细分，40 tet / 48 面 / 26 节点 | 演示面载荷**拆分**、合力合力矩守恒；额外带一个细分引入的边中点固定 |
| `cube-coarse-v3.json` | 另一份粗网格 | 作为 v2 的**合并**目标；中点固定此时**无对应** |
| `cube-broken-v4.json` | 含翻转 tet、零体积 tet、悬空节点力、重复约束 | 触发校验器全部错误类 |

细分器（`src/core/refine.ts`）对每个 tet 取 6 条边中点，剖分为 8 个子 tet；
边中点通过粗边表全局共享，保证相邻 tet 之间协调。立方体体积在细分下数值守恒
（5 个 tet 体积之和为 1，细分后仍为 1，误差 ~1e-16）。

---

## 3. 拓扑标识（为什么换网格后还能认得出同一个面）

* **节点**：跨版本身份完全由坐标判定。两个节点坐标距离 ≤ `nodeSnap`（默认 1e-8）
  即视为同一点；不依赖节点 id。
* **边键**：`min(a,b) + "|" + max(a,b)`，方向不敏感。
* **面键**：三个节点 id **升序排列后逗号连接**（`src/core/types.ts` 的 `faceKey`）。
  面的**工程方向**（外法向缠绕）单独保存，绝不编码进拓扑键，所以“同一组节点、
  正反缠绕”仍是同一个面。
* **单元对应**（`src/core/correspondence.ts`）不做最近邻强配：
  * 4 个节点完全相同 → 同一单元；
  * 否则用重心包含：新 tet 重心落在旧 tet 内（或反之）才是候选；
  * 同时被多个旧/新实体多向覆盖的关系保留为 N:M，供工程师判定，**绝不强行最近邻
    凑成功**。
* **面对应**：两面共面（`facePlane`）、法向平行（`normalAngle`，允许反向缠绕）且
  三角形在公共平面内**真正有交叠面积**。交叠面积用 Sutherland–Hodgman 多边形裁剪
  计算（`src/core/overlap.ts`），因此细分后的 4/8 个子面能正确匹配它们共同细分的
  粗面，即使没有任何节点 id 相同。

对每个旧实体统计候选数（正向）与被多少新实体引用（反向）：

| 正向 | 反向 | 判定 |
| --- | --- | --- |
| 1 | 1 | `complete` 完全 |
| >1 | 1 | `split` 拆分 |
| 1 | >1 | `merged` |
| >1 | >1 | `ambiguous` 歧义 |
| 0 | — | `unmatched` 无对应 |

`ambiguous` 与 `unmatched` 都是**正常结果**。

---

## 4. 工程对象的迁移规则

* **面压力（facePressure）**：旧面由所有与它交叠、法向同向的新面覆盖。每个子面
  继承**同一个压力标量**；法向反向的子面被拒绝（否则合力方向会反）。当
  `新面数 > 旧面数` 为拆分，`新面数 < 旧面数` 为合并。覆盖率（交叠面积/旧面积）
  必须达到 `faceCoverage`，否则判为歧义并列出未覆盖面。
* **节点固定（constraint）**：只有当节点在新网格上有且仅有一个重合节点时才迁移。
  若只是“最近的点另有所属”，判 `unmatched` 并注明“**not copied to avoid
  duplication**”——固定条件永远不会被复制成几份。v2→v3 的 `fix-refined-midpoint`
  固定在细分边中点上，合并回粗网格时即被拒绝。
* **节点力（nodalForce）**：向量钉在唯一点上；多个重合计主或仅最近邻都不自动迁移。
* **探针（probe）**：自由测量点，在 `probeSnap` 内吸附最近节点；细分后落在新插入
  节点上是合法重定位，落得太远则判需重建。当前细分方案不含立方体几何中心，因此
  `probe-center` 正确地保持 `unmatched`。
* **材料分区（zone）**：每个新单元按重心落入/同一关系继承旧分区；任一旧单元无子单元
  或新单元被两个分区同时主张时判歧义；新单元数少于旧单元数判合并。

---

## 5. 保守量口径

均匀压力下（`src/core/mechanics.ts`）：

```
F = Σ_i p · A_i · n_i
M = Σ_i r_i × (p · A_i · n_i)        # 对全局原点的力矩
```

压力标量在细分前后相同，因此合力只取决于面积与方向、与表面如何切分无关。判定采用

```
|ΔF| ≤ forceAbsTol + forceRelTol · max(|F_old|, |F_new|)
|ΔM| ≤ momentAbsTol + momentRelTol · max(|M_old|, |M_new|)
```

拆分一个粗面为 8 个子面时，`F = p·A·n` 与 `M = Σ r×dF` 都在容差内保持（测试断言
`forceError < 1e-8`、`momentError < 1e-6`）。**注意口径**：力矩是对全局原点取的；
各子面在其面心施加微元力后求和，等价于在粗面心施加合力。提交时会用冻结容差从存储
网格**重新核算**一遍，不仅采信预览数值。

---

## 6. 容差冻结与版本过期

* 预览时容差（`src/core/tolerances.ts` 的 `Tolerances`）整体复制进计划 JSON。
* 之后修改默认容差**不会**重算或重写已接受的计划；提交始终用计划内的冻结快照。
* 计划同时冻结两个网格的 **SHA-256 内容哈希**（`meshHash`，覆盖节点、单元、面和
  全部工程对象，键顺序归一化）。
* 提交时重新对存储网格求哈希；任一哈希不匹配即返回 409“版本已过期”，计划保持
  `preview`，请工程师刷新。

## 7. 人工证据模型

机器候选只是**几何证据**。工程师可对任意对象（`src/core/evidence.ts`）：

* **confirm**：确认某个候选（即使机器判为歧义）；
* **disable**：禁用该对象，不产生任何迁移结果；
* **rebuild**：标记需要手工重建；
* **reset**：恢复到机器判定（本身也是一条新证据，不删历史）。

决策是 `decisions` 表中的**只追加**记录（作者、时间、备注、被确认的候选引用），
随后用全部证据重建计划。已 `accepted` 的计划禁止再改。

## 8. 事务原子性与边界区域集合语义

* 提交在单个 SQLite 事务内完成：版本检查 → 接受校验 → 写状态与迁移结果。任何一步
  失败都整体回滚，**不会留下只迁移了一部分载荷**的方案
  （`Repository.acceptPlan`，`test/persistence.test.ts` 用被破坏的计划验证状态停留
  在 `preview`）。
* 边界区域以**集合**保存（`boundary_regions` 表，主键 `(region_id, member)`）：
  先删除再重建相同成员得到相同行；导出顺序恒为成员键升序，与插入历史无关，
  往返字节稳定。重复成员自动去重。

---

## 9. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meshes` | 列出已入库版本 |
| GET/POST | `/api/meshes/:hash` | 读取 / 校验并内容寻址入库 |
| POST | `/api/plans` | `{oldHash,newHash,tolerances?}` 生成冻结预览 |
| GET | `/api/plans/:id` | 计划、状态与决策证据 |
| POST | `/api/plans/:id/decisions` | 追加 confirm/disable/rebuild/reset |
| POST | `/api/plans/:id/commit` | 原子提交（失败 409，计划保留） |
| GET | `/api/plans/:id/export` | 导出已接受结果（含冻结容差与被阻塞对象） |
| GET/PUT | `/api/regions/:id` | 边界区域集合读取 / 删除重建 |

---

## 10. 代码地图

```
src/core/
  types.ts         网格/对象类型，边/面拓扑键
  geometry.ts      向量、tet 有向体积、重心坐标
  overlap.ts       共面三角形裁剪求交面积
  topology.ts      节点/面/单元拓扑，面-单元挂载方向
  correspondence.ts 节点/面/单元候选与基数分类
  refine.ts        tet 1→8 均匀细分
  tet-cube.ts      确定性 5-tet 立方体（算法派生边界）
  rows-loads.ts    面压力/节点力迁移与保守量
  rows-entities.ts 约束/探针/材料分区迁移
  plan.ts          构建冻结计划、应用人工证据
  acceptance.ts    版本检查 + 提交校验 + 接受对象
  tolerances.ts    容差定义与默认值
  validator.ts     方向/零体积/悬空引用/重复约束
  hash.ts          内容哈希
src/server/        Express、SQLite repository、服务编排、fixture 播种
src/web/           Vite 界面：双版本选择、拓扑差异、候选、迁移预览、人工操作
test/              几何、迁移语义、持久化与事务测试
fixtures/          四个承诺的 JSON 网格
```
