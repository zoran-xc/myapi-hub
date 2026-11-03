/**
 * 通用 OpenAI 兼容渠道插件。
 *
 * 一个渠道 = 任意暴露 /v1/models 与 /v1/chat/completions 的上游，
 * 例如 trae2api-hub、wb-proxy、proxy-hub、qoder2api-hub。
 */

import { apiRoot, expandEnv, trimBase } from '../src/util.js';

async function fetchUntilHeaders(url, options, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`上游 ${timeoutMs}ms 未响应`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function buildHeaders(def, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...def.headers, ...extra };
  if (def.apiKey && !headers.Authorization) headers.Authorization = `Bearer ${def.apiKey}`;
  return headers;
}

export default {
  id: 'openai-compatible',
  name: 'OpenAI-compatible upstream',

  create(def, ctx = {}) {
    const baseUrl = trimBase(def.baseUrl);
    if (!baseUrl) throw new Error(`渠道 ${def.id} 缺少 baseUrl`);

    return {
      baseUrl,
      rootUrl: apiRoot(baseUrl),

      async listModels({ timeoutMs = 10_000 } = {}) {
        const res = await fetchUntilHeaders(`${baseUrl}/models`, { headers: buildHeaders(def) }, timeoutMs);
        if (!res.ok) throw new Error(`GET /models -> HTTP ${res.status}`);
        const payload = await res.json();
        return (payload.data || payload.models || [])
          .map((m) => (typeof m === 'string' ? m : m?.id))
          .filter(Boolean);
      },

      chat(body, { signal, timeoutMs = ctx.timeoutMs || 180_000 } = {}) {
        return fetchUntilHeaders(
          `${baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: buildHeaders(def),
            body: JSON.stringify(body),
            signal,
          },
          timeoutMs,
        );
      },
    };
  },

  taskRunners: {
    /** 通用 HTTP 任务：按配置调用上游的管理端点（签到/保活/活动领取）。 */
    async http(task, channel) {
      const base = trimBase(task.baseUrl || channel.impl.rootUrl || channel.def.baseUrl);
      const url = `${base}${task.path.startsWith('/') ? '' : '/'}${task.path}`;
      const headers = {
        'Content-Type': 'application/json',
        ...Object.fromEntries(
          Object.entries(task.headers || {}).map(([k, v]) => [k, expandEnv(String(v))]),
        ),
      };
      if (task.useChannelAuth !== false && channel.def.apiKey && !headers.Authorization) {
        headers.Authorization = `Bearer ${channel.def.apiKey}`;
      }
      const res = await fetch(url, {
        method: task.method || 'POST',
        headers,
        body: task.json === undefined ? undefined : JSON.stringify(task.json),
        signal: AbortSignal.timeout(task.timeoutMs || 60_000),
      });
      const text = await res.text();
      let body = text.slice(0, 2000);
      try {
        body = JSON.parse(text);
      } catch {
        // 非 JSON 响应原样返回
      }
      return { ok: res.ok, status: res.status, body };
    },
  },
};
