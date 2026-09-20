// 生产模式：仅 API + data 目录静态文件（UI 演示使用 dev）。
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { bootstrapApp } from './src/app.js';
import { seedFixtures } from './src/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dbPath = process.env.FEM_DB_PATH ?? resolve(root, 'data', 'app.db');

const { server, db } = await bootstrapApp({ dbPath });
await seedFixtures(db, resolve(root, 'fixtures', 'meshes'));

const port = Number(process.env.PORT ?? 5325);
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`API 服务: http://${host}:${port}`);
});
