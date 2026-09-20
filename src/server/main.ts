import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { Repository } from './db/repo.js';
import { MigrationService } from './service.js';
import { startService } from './app.js';
import { seedFixtures } from './seed.js';

interface Args {
  host: string;
  port: number;
  strictPort: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { host: '127.0.0.1', port: 5325, strictPort: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a === '--') continue;
    if (a === '--host') { const v = argv[++i]; if (v) args.host = v; }
    else if (a.startsWith('--host=')) { const v = a.split('=')[1]; if (v) args.host = v; }
    else if (a === '--port') { const v = argv[++i]; if (v) args.port = Number(v); }
    else if (a.startsWith('--port=')) { const v = a.split('=')[1]; if (v) args.port = Number(v); }
    else if (a === '--strictPort') args.strictPort = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const repo = new Repository(join(dataDir, 'migration.db'));
  const service = new MigrationService(repo);

  try {
    const seeded = seedFixtures(service, join(root, 'fixtures'));
    console.log(`fixtures: ${seeded.ingested} ingested, ${seeded.rejected} rejected (expected: broken fixture)`);
  } catch (err) {
    console.warn('fixture seeding skipped:', (err as Error).message);
  }

  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    startWithExpress(service, args);
  } else {
    await startWithVite(service, args, root);
  }
}

function startWithExpress(service: MigrationService, args: Args): void {
  const server = startService(service, args.port, args.host);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && !args.strictPort) {
      // Express fallback only when strictPort was not requested.
      console.error(`port ${args.port} in use`);
    }
    process.exitCode = 1;
  });
}

async function startWithVite(
  service: MigrationService,
  args: Args,
  root: string
): Promise<void> {
  const { createServer } = await import('vite');
  const { createApp } = await import('./app.js');
  const expressApp = createApp(service, { serveStaticBuild: false });

  const vite = await createServer({
    root: join(root, 'src', 'web'),
    configFile: join(root, 'vite.config.ts'),
    server: {
      host: args.host,
      port: args.port,
      strictPort: args.strictPort,
      middlewareMode: true
    },
    appType: 'spa'
  });

  expressApp.use(vite.middlewares);

  const { createServer: createHttp } = await import('node:http');
  const httpServer = createHttp(expressApp);
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${args.port} already in use${args.strictPort ? ' (strictPort)' : ''}`);
      process.exit(1);
    }
    throw err;
  });
  httpServer.listen(args.port, args.host, () => {
    console.log(`Vite + API on http://${args.host}:${args.port}`);
  });

  const shutdown = (): void => {
    console.log('\nshutting down...');
    httpServer.close(() => process.exit(0));
    void vite.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
