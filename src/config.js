/** 配置加载：channels.json + 环境变量覆盖。 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandEnv, trimBase } from './util.js';

export const DEFAULTS = {
  host: '0.0.0.0',
  port: 8792,
  apiKey: '',
  strategy: 'weighted',      // weighted | round-robin | priority
  maxAttempts: 3,            // 单次请求最多尝试几个渠道
  timeoutMs: 180_000,        // 等待上游响应头
  cooldownMs: 30_000,        // 失败后的冷却时间
  cooldownMaxMs: 15 * 60_000,
  healthIntervalMs: 60_000,
  modelRefreshMs: 300_000,
  taskTickMs: 30_000,
  stateFile: 'data/state.json',
  logRequests: true,
};

export class ConfigError extends Error {}

export function loadConfig(filePath = process.env.MYAPI_CONFIG || 'channels.json') {
  const abs = path.resolve(filePath);
  let raw = { channels: [] };
  if (existsSync(abs)) {
    try {
      raw = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      throw new ConfigError(`配置文件不是合法 JSON: ${abs} (${e.message})`);
    }
  }

  const cfg = { ...DEFAULTS, ...(raw.server || {}) };
  if (process.env.MYAPI_PORT) cfg.port = Number(process.env.MYAPI_PORT);
  if (process.env.MYAPI_HOST) cfg.host = process.env.MYAPI_HOST;
  if (process.env.MYAPI_API_KEY) cfg.apiKey = process.env.MYAPI_API_KEY;
  if (process.env.MYAPI_STRATEGY) cfg.strategy = process.env.MYAPI_STRATEGY;
  cfg.apiKey = expandEnv(cfg.apiKey || '');

  const seen = new Set();
  cfg.channels = (raw.channels || [])
    .filter((c) => c && c.id)
    .map((c) => {
      if (seen.has(c.id)) throw new ConfigError(`渠道 id 重复: ${c.id}`);
      seen.add(c.id);
      return {
        ...c,
        plugin: c.plugin || 'openai-compatible',
        enabled: c.enabled !== false,
        weight: Number.isFinite(Number(c.weight)) && Number(c.weight) > 0 ? Number(c.weight) : 1,
        priority: Number(c.priority) || 0,
        baseUrl: trimBase(expandEnv(c.baseUrl || '')),
        apiKey: c.apiKey ? expandEnv(c.apiKey) : expandEnv(process.env[c.apiKeyEnv] || ''),
        headers: c.headers || {},
        aliases: c.aliases || {},
        tasks: c.tasks || [],
      };
    });

  if (!cfg.channels.length) {
    throw new ConfigError('没有任何渠道，请在 channels.json 的 channels 数组里至少配置一个');
  }
  return { ...cfg, configPath: abs };
}
