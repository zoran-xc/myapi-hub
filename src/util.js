/** 通用工具：时长解析、环境变量展开、URL 规整、常量时间比较。 */

import { timingSafeEqual } from 'node:crypto';

/** "6h" / "30m" / "1d" / 毫秒数字 -> 毫秒。无法解析时返回 fallback。 */
export function parseDuration(input, fallback = 0) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (!input) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(input).trim());
  if (!m) return fallback;
  const unit = (m[2] || 'ms').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.round(Number(m[1]) * mult);
}

/** 展开字符串里的 ${VAR}；未定义的变量替换为空串。 */
export function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

/** 去掉末尾斜杠。 */
export function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** 去掉末尾的 /v1，用于访问网关的管理端点。 */
export function apiRoot(url) {
  return trimBase(url).replace(/\/v1$/i, '');
}

/** 定长比较，避免密钥比较泄露时序。 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** 解析 Retry-After：秒数或 HTTP 日期，返回毫秒。 */
export function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function newId(prefix = 'chatcmpl') {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

/** 本地时区 "HH:MM" -> 今天该时刻的时间戳（已过则取明天）。 */
export function nextAt(hhmm, from = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(Number(m[1]), Number(m[2]));
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
