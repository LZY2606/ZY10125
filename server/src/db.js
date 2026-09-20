// SQLite 持久化。mesh 内容按哈希不可变；同一系列新版本令旧版本过期。
// 接受迁移在单个事务内完成，中断不会留下“只迁了一部分”的方案。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalHash } from './mesh.js';

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meshes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      hash TEXT NOT NULL,
      content TEXT NOT NULL,
      superseded_by INTEGER REFERENCES meshes(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hash)
    );
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      from_mesh_id INTEGER NOT NULL REFERENCES meshes(id),
      to_mesh_id INTEGER NOT NULL REFERENCES meshes(id),
      from_hash TEXT NOT NULL,
      to_hash TEXT NOT NULL,
      tolerances TEXT NOT NULL,
      preview TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('confirm','disable','rebuild')),
      targets TEXT,
      loads TEXT,
      note TEXT,
      author TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS accepted (
      plan_id TEXT PRIMARY KEY REFERENCES plans(id),
      export_doc TEXT NOT NULL,
      accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// 插入网格版本。同 series+version 且哈希相同即幂等；
// 同 series 出现更高 version 后，旧版本标记 superseded_by（过期）。
export function insertMesh(db, meshObj) {
  const content = JSON.stringify(meshObj);
  const hash = canonicalHash(meshObj);
  const existing = db.prepare('SELECT * FROM meshes WHERE hash = ?').get(hash);
  if (existing) return { mesh: existing, reused: true };
  const series = meshObj.series;
  const version = meshObj.version;
  const tx = db.prepare('SELECT MAX(version) AS v FROM meshes WHERE series = ?').get(series);
  if (tx.v != null && version <= tx.v) {
    throw Object.assign(new Error(`版本 ${version} 已过期：系列 ${series} 已存在版本 ${tx.v}`), { code: 'STALE_VERSION', latest: tx.v });
  }
  const info = db.prepare('INSERT INTO meshes (series, version, name, hash, content) VALUES (?, ?, ?, ?, ?)')
    .run(series, version, meshObj.name ?? `${series} v${version}`, hash, content);
  const id = Number(info.lastInsertRowid);
  // 插入新版本本身不把旧版本置为“过期”；是否过期取决于提交时计划目标是否仍是系列最新。
  return { mesh: db.prepare('SELECT * FROM meshes WHERE id = ?').get(id), reused: false };
}

export function listMeshes(db) {
  return db.prepare('SELECT id, series, version, name, hash, superseded_by, created_at FROM meshes ORDER BY series, version').all()
    .map((m) => ({ ...m, stale: m.superseded_by != null }));
}

export function getMesh(db, id) {
  const row = db.prepare('SELECT * FROM meshes WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.content) };
}

export function savePlan(db, plan) {
  db.prepare(`INSERT INTO plans (id, from_mesh_id, to_mesh_id, from_hash, to_hash, tolerances, preview, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`)
    .run(plan.id, plan.fromMeshId, plan.toMeshId, plan.fromHash, plan.toHash,
      JSON.stringify(plan.tolerances), JSON.stringify(plan.preview));
  return getPlan(db, plan.id);
}
export function getPlan(db, id) {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!row) return null;
  return hydratePlan(row, listEvidence(db, id));
}
export function listPlans(db) {
  return db.prepare('SELECT id, from_mesh_id, to_mesh_id, from_hash, to_hash, status, created_at FROM plans ORDER BY created_at DESC').all();
}
function hydratePlan(row, evidence) {
  return { ...row, tolerances: JSON.parse(row.tolerances), preview: JSON.parse(row.preview), evidence };
}

export function listEvidence(db, planId) {
  return db.prepare('SELECT * FROM evidence WHERE plan_id = ? ORDER BY id').all(planId)
    .map((e) => ({
      id: e.id,
      planId: e.plan_id,
      objectType: e.object_type,
      objectId: e.object_id,
      action: e.action,
      targets: e.targets ? JSON.parse(e.targets) : null,
      loads: e.loads ? JSON.parse(e.loads) : null,
      note: e.note,
      author: e.author,
      createdAt: e.created_at,
    }));
}

// 追加人工证据（新证据，不覆盖历史；解释时取同对象最新一条）。
export function addEvidence(db, planId, ev) {
  const plan = db.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
  if (!plan) throw Object.assign(new Error('计划不存在'), { code: 'NOT_FOUND' });
  if (plan.status === 'accepted') throw Object.assign(new Error('计划已接受，证据不可更改'), { code: 'IMMUTABLE_PLAN' });
  db.prepare(`INSERT INTO evidence (plan_id, object_type, object_id, action, targets, loads, note, author)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(planId, ev.objectType, ev.objectId, ev.action,
      ev.targets ? JSON.stringify(ev.targets) : null,
      ev.loads ? JSON.stringify(ev.loads) : null,
      ev.note ?? null, ev.author ?? 'engineer');
  return listEvidence(db, planId);
}

// 提交：版本未过期检查 + 哈希复检 + 单一事务接受。
export function acceptPlan(db, planId, recompute, exporter) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) throw Object.assign(new Error('计划不存在'), { code: 'NOT_FOUND' });
  if (plan.status === 'accepted') throw Object.assign(new Error('计划已接受，不可重复提交'), { code: 'IMMUTABLE_PLAN' });
  const from = getMesh(db, plan.from_mesh_id);
  const to = getMesh(db, plan.to_mesh_id);
  // 提交时检查版本未过期：计划目标必须仍是该系列最新版本；之后出现 v3 即令 v2 计划过期。
  const latest = db.prepare('SELECT MAX(version) AS v, id FROM meshes WHERE series = ?').get(to.series);
  if (latest.id !== plan.to_mesh_id) {
    throw Object.assign(new Error('提交失败：目标网格版本已过期（该系列存在更新版本）'), { code: 'VERSION_STALE', latestVersion: latest.v });
  }
  if (canonicalHash(from.data) !== plan.from_hash || canonicalHash(to.data) !== plan.to_hash) {
    throw Object.assign(new Error('提交失败：网格哈希与预览不一致'), { code: 'HASH_MISMATCH' });
  }

  const { applied, exportDoc } = recompute(from.data, to.data, hydratePlan(plan, listEvidence(db, planId)));
  if (applied.blocking.length) throw Object.assign(new Error('仍有对象未完成迁移，拒绝提交'), { code: 'BLOCKING_ITEMS', blocking: applied.blocking });

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE plans SET status = 'accepted' WHERE id = ?").run(planId);
    db.prepare('INSERT INTO accepted (plan_id, export_doc) VALUES (?, ?)').run(planId, JSON.stringify(exportDoc));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getPlan(db, planId);
}

export function getAccepted(db, planId) {
  const row = db.prepare('SELECT * FROM accepted WHERE plan_id = ?').get(planId);
  return row ? { ...row, exportDoc: JSON.parse(row.export_doc) } : null;
}
