/**
 * 模型注册表与两级路由：
 *   第一级 = 本网关按策略在多个渠道之间选一条；
 *   第二级 = 渠道网关内部按账号池再选一个账号（由上游负责）。
 */

import { Channel } from './channel.js';

export class UnknownModelError extends Error {
  constructor(model, available) {
    super(`未知模型: ${model}`);
    this.model = model;
    this.available = available;
  }
}

export class UpstreamError extends Error {
  constructor(message, attempts) {
    super(message);
    this.attempts = attempts;
  }
}

function aliasFor(aliases, id) {
  if (!aliases) return null;
  if (aliases[id]) return aliases[id];
  const lower = String(id).toLowerCase();
  for (const [key, value] of Object.entries(aliases)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

export class ModelRouter {
  constructor({ channelDefs, pluginHost, options }) {
    this.options = options;
    this.pluginHost = pluginHost;
    this.channels = channelDefs.map((def) => new Channel({
      def,
      impl: pluginHost.createChannel(def, { timeoutMs: options.timeoutMs }),
      options,
    }));
    this.catalog = new Map(); // canonicalId -> [{ channel, upstreamId }]
    this.state = new Map();   // 策略状态
    this.lastRefreshAt = 0;
    this.refreshErrors = [];
  }

  channel(id) {
    return this.channels.find((c) => c.id === id);
  }

  async refreshModels({ force = false } = {}) {
    this.refreshErrors = [];
    await Promise.all(
      this.channels.map(async (ch) => {
        if (!ch.enabled) return;
        try {
          await ch.listModels({ force });
        } catch (e) {
          this.refreshErrors.push({ channel: ch.id, error: String(e.message || e) });
          ch.markFailure(e);
        }
      }),
    );
    this.rebuildCatalog();
    this.lastRefreshAt = Date.now();
    return this.refreshErrors;
  }

  rebuildCatalog() {
    this.catalog = new Map();
    for (const channel of this.channels) {
      for (const upstreamId of channel.models) {
        const canonical = String(aliasFor(channel.def.aliases, upstreamId) || upstreamId).toLowerCase();
        const entries = this.catalog.get(canonical) || [];
        entries.push({ channel, upstreamId });
        this.catalog.set(canonical, entries);
      }
    }
  }

  modelIds() {
    return [...this.catalog.keys()].sort();
  }

  listModels() {
    return this.modelIds().map((id) => {
      const entries = this.catalog.get(id);
      return {
        id,
        object: 'model',
        owned_by: 'myapi-hub',
        x_myapi: {
          channels: entries.map((e) => e.channel.id),
          upstream_ids: entries.map((e) => e.upstreamId),
        },
      };
    });
  }

  /** 解析请求模型：支持 "渠道/模型" 强制路由，或按 canonical 名称跨渠道。 */
  resolve(requested) {
    const raw = String(requested || '').trim();
    if (!raw) return null;

    const slash = raw.indexOf('/');
    if (slash > 0) {
      const channelId = raw.slice(0, slash);
      const channel = this.channel(channelId);
      if (channel) {
        const wanted = raw.slice(slash + 1);
        const upstreamId = this.findUpstreamId(channel, wanted);
        return {
          forced: true,
          canonical: wanted.toLowerCase(),
          entries: [{ channel, upstreamId }],
        };
      }
    }

    const canonical = raw.toLowerCase();
    const entries = (this.catalog.get(canonical) || []).filter((e) => e.channel.enabled);
    if (!entries.length) return null;
    return { forced: false, canonical, entries };
  }

  findUpstreamId(channel, wanted) {
    if (channel.models.includes(wanted)) return wanted;
    const lower = wanted.toLowerCase();
    const exact = channel.models.find((m) => m.toLowerCase() === lower);
    if (exact) return exact;
    const aliased = Object.entries(channel.def.aliases || {})
      .find(([local, canonical]) => String(canonical).toLowerCase() === lower);
    return aliased ? aliased[0] : wanted;
  }

  /** 排序候选：可用渠道先按策略排，冷却中的按剩余冷却时间排到最后。 */
  order(entries, key) {
    const usable = entries.filter((e) => e.channel.available);
    const cooling = entries
      .filter((e) => !e.channel.available)
      .sort((a, b) => a.channel.cooldownUntil - b.channel.cooldownUntil);

    const strategy = this.pluginHost.strategy(this.options.strategy);
    let ordered = usable;
    if (strategy && usable.length > 1) {
      const wrapped = usable.map((e) => ({
        id: e.channel.id,
        weight: e.channel.weight,
        priority: e.channel.priority,
        entry: e,
      }));
      ordered = strategy(wrapped, { state: this.state, key }).map((x) => x.entry || x);
    } else if (usable.length > 1) {
      ordered = [...usable].sort((a, b) => b.channel.weight - a.channel.weight);
    }
    return [...ordered, ...cooling];
  }

  /**
   * 发起一次对话：按顺序尝试候选渠道，失败自动换号（换渠道）。
   * 返回 { response, entry, attempts, canonical }。
   */
  async chat({ body, model, signal }) {
    const resolved = this.resolve(model);
    if (!resolved) throw new UnknownModelError(model, this.modelIds());

    const ordered = resolved.forced
      ? resolved.entries
      : this.order(resolved.entries, resolved.canonical);
    const limit = Math.min(ordered.length, Math.max(1, this.options.maxAttempts));

    let lastError = null;
    let lastStatus = null;
    let lastRetryAfter = null;
    for (let i = 0; i < limit; i += 1) {
      const entry = ordered[i];
      const started = Date.now();
      const upstreamBody = { ...body, model: entry.upstreamId, stream: true };
      try {
        const response = await entry.channel.chat(upstreamBody, { signal });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const error = new Error(`HTTP ${response.status} ${detail.slice(0, 300)}`);
          entry.channel.markFailure(error, response.headers.get('retry-after'));
          lastError = error;
          lastStatus = response.status;
          lastRetryAfter = response.headers.get('retry-after');
          continue;
        }
        entry.channel.markSuccess(Date.now() - started);
        return { response, entry, attempts: i + 1, canonical: resolved.canonical };
      } catch (e) {
        if (signal?.aborted) throw e;
        entry.channel.markFailure(e);
        lastError = e;
      }
    }
    const error = new UpstreamError(
      `所有渠道均失败（尝试 ${limit} 个）: ${lastError?.message || 'unknown'}`,
      limit,
    );
    error.status = lastStatus;
    error.retryAfter = lastRetryAfter;
    throw error;
  }

  snapshot() {
    return {
      strategy: this.options.strategy,
      lastRefreshAt: this.lastRefreshAt || null,
      modelCount: this.catalog.size,
      refreshErrors: this.refreshErrors,
      channels: this.channels.map((c) => c.snapshot()),
    };
  }
}
