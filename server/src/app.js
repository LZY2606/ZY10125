// HTTP 服务：网格版本、计划预览、人工证据、提交、导出 API。
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDb, insertMesh, listMeshes, getMesh, savePlan, getPlan, listPlans, addEvidence, acceptPlan, getAccepted } from './db.js';
import { enrichMesh, createPreview, applyEvidence } from './plan.js';
import { buildExport } from './export.js';

export async function createApp({ dbPath, vite } = {}) {
  const db = openDb(dbPath);

  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/api/')) return await handleApi(req, res);
      if (vite) {
        // Vite 处理静态资源与模块转换；以 res 结束为准，next 仅在它决定放行时触发。
        return await new Promise((resolve, reject) => {
          res.once('finish', resolve);
          res.once('error', reject);
          vite.middlewares(req, res, (err) => {
            if (err) reject(err);
            else send(res, 404, { error: 'not found' });
          });
        });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.code === 'STALE_VERSION' || err.code === 'VERSION_STALE' || err.code === 'HASH_MISMATCH' ? 409
        : err.code === 'NOT_FOUND' ? 404
        : err.code === 'BLOCKING_ITEMS' ? 422 : 400;
      send(res, status, { error: err.message, code: err.code, ...(err.blocking ? { blocking: err.blocking } : {}) });
    }
  });
  return { server, db };
}

async function handleApi(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  const route = `${req.method} ${pathname}`;

  if (route === 'GET /api/meshes') return send(res, 200, { meshes: listMeshes(dbRef) });
  if (route === 'POST /api/meshes') {
    const body = await readJson(req);
    const { mesh, reused } = insertMesh(dbRef, body.mesh);
    return send(res, reused ? 200 : 201, { id: mesh.id, hash: mesh.hash, reused, stale: mesh.superseded_by != null });
  }
  if (pathname.startsWith('/api/meshes/') && req.method === 'GET') {
    const id = Number(pathname.split('/').pop());
    const mesh = getMesh(dbRef, id);
    if (!mesh) return send(res, 404, { error: '网格不存在' });
    return send(res, 200, { mesh: mesh.data, hash: mesh.hash, stale: mesh.superseded_by != null });
  }

  if (route === 'GET /api/plans') return send(res, 200, { plans: listPlans(dbRef) });
  if (route === 'POST /api/plans') {
    const body = await readJson(req);
    const from = getMesh(dbRef, Number(body.fromMeshId));
    const to = getMesh(dbRef, Number(body.toMeshId));
    if (!from || !to) return send(res, 404, { error: '网格版本不存在' });
    // 允许选择任意两个版本对比；跨系列时预览会因拓扑/校验问题自然给出拒绝结论。
    const preview = createPreview(enrichMesh(from.data), enrichMesh(to.data), body.tolerances ?? {});
    const plan = savePlan(dbRef, {
      id: randomUUID(),
      fromMeshId: from.id,
      toMeshId: to.id,
      fromHash: from.hash,
      toHash: to.hash,
      tolerances: preview.tolerances,
      preview,
    });
    return send(res, 201, { planId: plan.id, preview });
  }
  if (/^\/api\/plans\/[^/]+$/.test(pathname) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const plan = getPlan(dbRef, id);
    if (!plan) return send(res, 404, { error: '计划不存在' });
    return send(res, 200, planView(plan));
  }
  if (pathname.match(/^\/api\/plans\/[^/]+\/evidence$/) && req.method === 'POST') {
    const id = pathname.split('/')[3];
    const body = await readJson(req);
    const required = ['objectType', 'objectId', 'action'];
    for (const k of required) if (!body[k]) return send(res, 400, { error: `缺少字段 ${k}` });
    if (!['confirm', 'disable', 'rebuild'].includes(body.action)) return send(res, 400, { error: '非法证据动作' });
    const evidence = addEvidence(dbRef, id, body);
    const plan = getPlan(dbRef, id);
    return send(res, 201, { evidence, applied: planView(plan).applied });
  }
  if (pathname.match(/^\/api\/plans\/[^/]+\/accept$/) && req.method === 'POST') {
    const id = pathname.split('/')[3];
    acceptPlan(dbRef, id, (fromData, toData, plan) => {
      // 用计划冻结的容差重建（之后修改默认值不影响接受结果）。
      const frozenPreview = createPreviewWith(enrichMesh(fromData), enrichMesh(toData), plan.tolerances);
      const applied = applyEvidence(frozenPreview, fromData, toData, plan.evidence);
      const exportDoc = buildExport(fromData, toData, applied, {
        planId: plan.id,
        fromVersionId: plan.from_mesh_id,
        toVersionId: plan.to_mesh_id,
        fromHash: plan.from_hash,
        toHash: plan.to_hash,
        tolerances: plan.tolerances,
        acceptedAt: new Date().toISOString(),
        evidenceCount: plan.evidence.length,
      });
      return { applied, exportDoc };
    }, null);
    const plan = getPlan(dbRef, id);
    return send(res, 200, planView(plan));
  }
  if (pathname.match(/^\/api\/plans\/[^/]+\/export$/) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const accepted = getAccepted(dbRef, id);
    if (!accepted) return send(res, 404, { error: '计划尚未接受，无导出' });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="migrated-${id}.json"`);
    return res.end(JSON.stringify(accepted.exportDoc, null, 2));
  }

  return send(res, 404, { error: 'unknown route' });
}

function createPreviewWith(a, b, tol) {
  // 直接以冻结容差构造预览（键固定，绕过覆盖校验差异）。
  return createPreview(a, b, { ...tol });
}

function planView(plan) {
  const applied = applyEvidence(plan.preview, null, null, plan.evidence);
  return {
    id: plan.id,
    fromMeshId: plan.from_mesh_id,
    toMeshId: plan.to_mesh_id,
    fromHash: plan.from_hash,
    toHash: plan.to_hash,
    status: plan.status,
    tolerances: plan.tolerances,
    preview: plan.preview,
    evidence: plan.evidence,
    applied,
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 32 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('非法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 模块级 db 句柄（bootstrap 内赋值），保持路由函数签名简洁。
let dbRef;
export async function bootstrapApp(options) {
  const app = await createApp(options);
  dbRef = app.db;
  return app;
}
