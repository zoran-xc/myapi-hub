/** 渠道运行时：包装插件实现，维护模型缓存、健康状态、冷却与统计。 */

import { parseRetryAfter } from './util.js';

export class Channel {
  constructor({ def, impl, stats = {}, options }) {
    this.def = def;
    this.impl = impl;
    this.options = options;
    this.id = def.id;
    this.name = def.name || def.id;
    this.priority = Number(def.priority) || 0;
    this.tasks = def.tasks || [];
    this.enabled = def.enabled !== false;
    this.weight = Number(def.weight) > 0 ? Number(def.weight) : 1;

    this.models = [];
    this.modelsFetchedAt = 0;
    this.cooldownUntil = 0;
    this.consecutiveFailures = 0;
    this.lastOkAt = 0;
    this.lastError = null;
    this.latencyEwma = null;

    this.stats = {
      requests: 0,
      success: 0,
      failed: 0,
      lastRequestAt: 0,
      ...stats,
    };
  }

  /** 可参与负载均衡：已启用且不在冷却期。 */
  get available() {
    return this.enabled && Date.now() >= this.cooldownUntil;
  }

  async listModels({ force = false } = {}) {
    if (!force && this.models.length && Date.now() - this.modelsFetchedAt < this.options.modelRefreshMs) {
      return this.models;
    }
    const models = await this.impl.listModels({ timeoutMs: this.options.modelFetchTimeoutMs });
    this.models = [...new Set(models.map(String))];
    this.modelsFetchedAt = Date.now();
    return this.models;
  }

  chat(body, { signal } = {}) {
    return this.impl.chat(body, { signal, timeoutMs: this.options.timeoutMs });
  }

  markSuccess(latencyMs) {
    this.stats.requests += 1;
    this.stats.success += 1;
    this.stats.lastRequestAt = Date.now();
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.latencyEwma = this.latencyEwma == null
      ? latencyMs
      : Math.round(this.latencyEwma * 0.7 + latencyMs * 0.3);
  }

  markFailure(error, retryAfterHeader) {
    this.stats.requests += 1;
    this.stats.failed += 1;
    this.stats.lastRequestAt = Date.now();
    this.consecutiveFailures += 1;
    this.lastError = String(error?.message || error).slice(0, 300);

    const retryAfterMs = parseRetryAfter(retryAfterHeader);
    const backoff = this.options.cooldownMs * 2 ** Math.min(this.consecutiveFailures - 1, 5);
    const cooldown = retryAfterMs || Math.min(backoff, this.options.cooldownMaxMs);
    this.cooldownUntil = Date.now() + cooldown;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      plugin: this.def.plugin,
      enabled: this.enabled,
      available: this.available,
      weight: this.weight,
      priority: this.priority,
      baseUrl: this.def.baseUrl,
      models: this.models.length,
      modelsFetchedAt: this.modelsFetchedAt || null,
      cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
      lastOkAt: this.lastOkAt || null,
      lastError: this.lastError,
      latencyMs: this.latencyEwma,
      stats: this.stats,
    };
  }
}
