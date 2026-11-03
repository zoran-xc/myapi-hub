/** HTTP 服务：OpenAI 兼容入口 + 管理接口 + 状态看板。 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { collectCompletion, UpstreamPayloadError } from './sse.js';
import { UnknownModelError, UpstreamError } from './router.js';
import { safeEqual } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_FILE = path.join(ROOT, 'public', 'index.html');
const MAX_BODY = 32 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key',
};

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(config, req) {
  if (!config.apiKey) return true;
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.headers['x-api-key'] || '').trim();
  return (bearer && safeEqual(bearer, config.apiKey)) || (alt && safeEqual(alt, config.apiKey));
}

export function createServer({ app, version = '0.1.0' }) {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', service: 'myapi-hub', uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
        try {
          const html = readFileSync(DASHBOARD_FILE);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        } catch {
          return sendJson(res, 200, { service: 'myapi-hub', version, hint: 'dashboard/public 未找到，使用 /admin/status' });
        }
      }

      if (!authorized(app.config, req)) {
        return sendJson(res, 401, { error: { message: '缺少或错误的 API Key', type: 'invalid_request_error' } }, CORS);
      }

      if (req.method === 'GET' && pathname === '/v1/models') {
        return sendJson(res, 200, { object: 'list', data: app.router.listModels() }, CORS);
      }

      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        return await handleChat(req, res, app);
      }

      if (req.method === 'GET' && pathname === '/admin/status') {
        return sendJson(res, 200, {
          ok: true,
          service: 'myapi-hub',
          version,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          config: {
            strategy: app.config.strategy,
            maxAttempts: app.config.maxAttempts,
            apiKeyRequired: Boolean(app.config.apiKey),
            configPath: app.config.configPath,
          },
          router: app.router.snapshot(),
          tasks: app.scheduler.list(),
        });
      }

      if (req.method === 'POST' && pathname === '/admin/reload') {
        const result = await app.reload();
        return sendJson(res, 200, { ok: true, ...result });
      }

      const weightMatch = /^\/admin\/channels\/([^/]+)\/weight$/.exec(pathname);
      if (req.method === 'POST' && weightMatch) {
        const channel = app.router.channel(decodeURIComponent(weightMatch[1]));
        if (!channel) return sendJson(res, 404, { error: { message: '渠道不存在' } });
        const body = await readBody(req);
        const weight = Number(body.weight);
        if (!Number.isFinite(weight) || weight <= 0) {
          return sendJson(res, 400, { error: { message: 'weight 必须是大于 0 的数字' } });
        }
        channel.weight = weight;
        channel.def.weight = weight;
        return sendJson(res, 200, { ok: true, channel: channel.snapshot() });
      }

      const toggleMatch = /^\/admin\/channels\/([^/]+)\/toggle$/.exec(pathname);
      if (req.method === 'POST' && toggleMatch) {
        const channel = app.router.channel(decodeURIComponent(toggleMatch[1]));
        if (!channel) return sendJson(res, 404, { error: { message: '渠道不存在' } });
        const body = await readBody(req);
        channel.enabled = body.enabled === undefined ? !channel.enabled : Boolean(body.enabled);
        channel.def.enabled = channel.enabled;
        return sendJson(res, 200, { ok: true, channel: channel.snapshot() });
      }

      const taskMatch = /^\/admin\/tasks\/([^/]+)\/([^/]+)\/run$/.exec(pathname);
      if (req.method === 'POST' && taskMatch) {
        const channelId = decodeURIComponent(taskMatch[1]);
        const taskId = decodeURIComponent(taskMatch[2]);
        const result = await app.scheduler.runManual(channelId, taskId);
        if (!result) return sendJson(res, 404, { error: { message: '任务不存在' } });
        return sendJson(res, 200, { ok: true, result });
      }

      if (req.method === 'GET' && pathname === '/admin/tasks') {
        return sendJson(res, 200, { ok: true, tasks: app.scheduler.list() });
      }

      return sendJson(res, 404, { error: { message: `Not Found: ${pathname}` } });
    } catch (e) {
      if (res.headersSent) return res.destroy();
      return sendJson(res, 500, { error: { message: String(e.message || e), type: 'server_error' } });
    }
  });

  server.timeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

async function handleChat(req, res, app) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: { message: e.message, type: 'invalid_request_error' } }, CORS);
  }

  const model = String(body.model || '');
  const wantsStream = body.stream === true;
  const controller = new AbortController();
  let streaming = false;
  const onClose = () => controller.abort();
  res.on('close', onClose);

  try {
    const result = await app.router.chat({ body, model, signal: controller.signal });
    const headers = {
      ...CORS,
      'X-MyAPI-Channel': result.entry.channel.id,
      'X-MyAPI-Upstream-Model': result.entry.upstreamId,
      'X-MyAPI-Attempts': String(result.attempts),
    };

    if (wantsStream) {
      streaming = true;
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      if (!result.response.body) return res.end();
      Readable.fromWeb(result.response.body)
        .on('error', () => res.destroy())
        .pipe(res);
      return;
    }

    const completion = await collectCompletion(result.response, { model: result.entry.upstreamId });
    completion.model = model;
    return sendJson(res, 200, completion, headers);
  } catch (e) {
    if (res.headersSent || res.destroyed) return res.destroy();
    if (e instanceof UnknownModelError) {
      return sendJson(res, 404, {
        error: {
          message: `未知模型: ${e.model}`,
          type: 'invalid_request_error',
          code: 'model_not_found',
          available_models: e.available.slice(0, 100),
        },
      }, CORS);
    }
    if (e instanceof UpstreamError) {
      const status = e.status === 429 || e.status === 503 ? e.status : 502;
      const headers = status === 429 && e.retryAfter ? { ...CORS, 'Retry-After': e.retryAfter } : CORS;
      return sendJson(res, status, { error: { message: e.message, type: 'upstream_error' } }, headers);
    }
    if (e instanceof UpstreamPayloadError) {
      return sendJson(res, 502, { error: { message: e.message, type: 'upstream_error' } }, CORS);
    }
    return sendJson(res, 500, { error: { message: String(e.message || e), type: 'server_error' } }, CORS);
  } finally {
    // 流式响应要保留 close 监听，客户端断开时才能取消上游
    if (!streaming) res.removeListener('close', onClose);
  }
}
