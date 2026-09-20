// 启动时注册 fixtures 中同哈希网格（幂等，不覆盖已有不可变版本）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertMesh } from './db.js';

export async function seedFixtures(db, fixturesDir) {
  let files = [];
  try {
    files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return;
  }
  for (const file of files) {
    const mesh = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
    try {
      insertMesh(db, mesh);
    } catch (err) {
      if (err.code !== 'STALE_VERSION') throw err;
    }
  }
}
