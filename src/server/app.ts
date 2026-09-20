import express from 'express';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MigrationService, ValidationError } from './service.js';
import type { Mesh } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp(
  service: MigrationService,
  opts: { serveStaticBuild?: boolean } = { serveStaticBuild: true }
): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'fem-mesh-migration' });
  });

  app.get('/api/meshes', (_req, res) => {
    res.json(service.listMeshes());
  });

  app.get('/api/meshes/:hash', (req, res) => {
    const mesh = service.getMesh(req.params.hash!);
    if (!mesh) return res.status(404).json({ error: 'mesh not found' });
    res.json(mesh);
  });

  app.post('/api/meshes', (req, res) => {
    try {
      const result = service.ingestMesh(req.body as Mesh);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      if (err instanceof ValidationError)
        return res.status(422).json({ error: err.message, issues: err.issues });
      throw err;
    }
  });

  app.post('/api/plans', (req, res) => {
    try {
      const { oldHash, newHash, tolerances } = req.body as {
        oldHash: string;
        newHash: string;
        tolerances?: unknown;
      };
      const plan = service.createPreview(oldHash, newHash, tolerances as Partial<import('../core/tolerances.js').Tolerances> | undefined);
      res.status(201).json(plan);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/plans', (_req, res) => res.json(service.listPlans()));

  app.get('/api/plans/:id', (req, res) => {
    const plan = service.getPlan(req.params.id!);
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    res.json({ ...plan, decisions: service.listDecisions(req.params.id!) });
  });

  app.post('/api/plans/:id/decisions', (req, res) => {
    try {
      const plan = service.applyDecision(req.params.id!, req.body);
      res.json(plan);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/plans/:id/commit', (req, res) => {
    try {
      const result = service.commit(req.params.id!);
      if (!result.ok) return res.status(409).json({ error: 'acceptance failed', result: result.result });
      res.json(result.result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/plans/:id/export', (req, res) => {
    try {
      res.type('application/json').send(JSON.stringify(service.exportAccepted(req.params.id!), null, 2));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/regions', (_req, res) => res.json(service.listRegions()));

  app.put('/api/regions/:id', (req, res) => {
    const body = req.body as { name: string; members: string[] };
    const rec = service.replaceRegion({
      id: req.params.id!,
      name: body.name,
      members: body.members
    });
    res.json(rec);
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: (err as Error).message ?? String(err) });
  });

  // Production: serve the Vite build. In dev the Vite middleware owns routes.
  if (opts.serveStaticBuild !== false) {
    const dist = join(here, '..', '..', 'dist');
    if (existsSync(dist)) {
      app.use(express.static(dist));
      app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
    }
  }

  return app;
}

export function startService(
  service: MigrationService,
  port: number,
  host: string
): Server {
  const app = createApp(service);
  return app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`FEA migration service on http://${host}:${port}`);
  });
}
