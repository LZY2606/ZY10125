// 演示模式：Vite 中间件 + API 同源服务（端口被占用且 --strictPort 时直接失败退出）。
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { bootstrapApp } from './src/app.js';
import { seedFixtures } from './src/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
const host = arg('host', '127.0.0.1');
const port = Number(arg('port', '5325'));
const strictPort = argv.includes('--strictPort');

const vite = await createViteServer({
  root: resolve(root, 'web'),
  server: { middlewareMode: true },
  appType: 'spa',
});

const dbPath = process.env.FEM_DB_PATH ?? resolve(root, 'data', 'app.db');
const { server, db } = await bootstrapApp({ dbPath, vite });
await seedFixtures(db, resolve(root, 'fixtures', 'meshes'));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用（--strictPort），退出。`);
    process.exit(1);
  }
  throw err;
});
server.listen({ port, host, exclusive: strictPort }, () => {
  console.log(`\n  有限元网格迁移演示: http://${host}:${port}\n`);
});
