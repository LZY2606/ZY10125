PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Immutable, content-addressed mesh versions. The same JSON content always
-- maps to the same hash; an existing row can never be overwritten.
CREATE TABLE IF NOT EXISTS meshes (
  hash        TEXT PRIMARY KEY,
  mesh_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meshes_mesh_id ON meshes(mesh_id);

-- Frozen migration plans. Tolerances are embedded in the JSON so later
-- changes to defaults never rewrite an accepted result.
CREATE TABLE IF NOT EXISTS plans (
  id              TEXT PRIMARY KEY,
  old_hash        TEXT NOT NULL REFERENCES meshes(hash),
  new_hash        TEXT NOT NULL REFERENCES meshes(hash),
  status          TEXT NOT NULL CHECK (status IN ('preview', 'accepted', 'rejected')),
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  accepted_at     TEXT,
  accepted_result TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at);

-- Manual evidence. Append-only: a reset is a new row, never an in-place
-- mutation of prior evidence.
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  candidate    TEXT,
  note         TEXT,
  author       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_plan ON decisions(plan_id, created_at);

-- Boundary regions with set semantics. (region_id, member) is a primary key,
-- so delete-and-rebuild with an identical set produces identical rows, and
-- export order is always members sorted ascending (see repository code).
CREATE TABLE IF NOT EXISTS boundary_regions (
  region_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  member     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (region_id, member)
);
CREATE INDEX IF NOT EXISTS idx_regions_member ON boundary_regions(member);
