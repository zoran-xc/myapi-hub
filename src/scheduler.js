/** 插件式定时任务：按渠道注册「每日签到 / Token 保活 / 活动领取」等动作。 */

import { nextAt, parseDuration } from './util.js';

const CATCH_UP_AFTER_MS = 20 * 3_600_000;

function summarize(body) {
  if (body === undefined || body === null) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

export class Scheduler {
  constructor({ channels, runners, store, logger = console, tickMs = 30_000 }) {
    this.channels = channels;
    this.runners = runners;
    this.store = store;
    this.logger = logger;
    this.tickMs = tickMs;
    this.tasks = [];
    this.timer = null;
  }

  /** 从渠道定义装载任务；带 at 的任务在停机超 20h 后回到服务时补跑一次。 */
  init() {
    this.tasks = [];
    for (const channel of this.channels) {
      if (!channel.enabled) continue; // 停用的渠道不跑任务
      for (const def of channel.tasks || []) {
        if (!def || !def.id || def.enabled === false) continue;
        const key = `${channel.id}:${def.id}`;
        const saved = this.store.get(`tasks.${key}`, {}) || {};
        let nextRunAt = saved.nextRunAt || this.computeNext(def, saved.lastRunAt, Date.now());
        if (def.at && (!saved.lastRunAt || Date.now() - saved.lastRunAt > CATCH_UP_AFTER_MS)) {
          nextRunAt = Date.now() + 3_000;
        }
        this.tasks.push({
          key,
          channel,
          def,
          running: false,
          state: { ...saved, nextRunAt },
        });
      }
    }
  }

  computeNext(def, lastRunAt, now = Date.now()) {
    if (def.at) return nextAt(def.at, lastRunAt ? Math.max(lastRunAt, now) : now);
    const interval = parseDuration(def.every, 0);
    if (interval > 0) return (lastRunAt || now) + interval;
    return null;
  }

  start() {
    this.init();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    for (const task of this.tasks) {
      if (task.running || !task.state.nextRunAt) continue;
      if (Date.now() >= task.state.nextRunAt) {
        this.run(task).catch((e) => this.logger.error?.(`[task] ${task.key} ${e.message}`));
      }
    }
  }

  async run(task) {
    if (task.running) return { skipped: true };
    task.running = true;
    const started = Date.now();
    const runner = this.runners.get(task.def.runner || 'http');
    try {
      if (!runner) throw new Error(`未知任务执行器: ${task.def.runner}`);
      const result = await runner(task.def, task.channel, { logger: this.logger });
      task.state = {
        lastRunAt: Date.now(),
        lastStatus: result?.ok ? 'ok' : 'fail',
        lastHttpStatus: result?.status ?? null,
        lastResult: summarize(result?.body),
        lastDurationMs: Date.now() - started,
        nextRunAt: this.computeNext(task.def, Date.now(), Date.now()),
      };
      this.store.set(`tasks.${task.key}`, task.state);
      this.logger.info?.(`[task] ${task.key} -> ${task.state.lastStatus} (${task.state.lastDurationMs}ms)`);
      return task.state;
    } catch (e) {
      task.state = {
        lastRunAt: Date.now(),
        lastStatus: 'error',
        lastHttpStatus: null,
        lastResult: String(e.message || e).slice(0, 500),
        lastDurationMs: Date.now() - started,
        nextRunAt: this.computeNext(task.def, Date.now(), Date.now()),
      };
      this.store.set(`tasks.${task.key}`, task.state);
      this.logger.error?.(`[task] ${task.key} -> error: ${e.message}`);
      return task.state;
    } finally {
      task.running = false;
    }
  }

  find(channelId, taskId) {
    return this.tasks.find((t) => t.channel.id === channelId && t.def.id === taskId);
  }

  async runManual(channelId, taskId) {
    const task = this.find(channelId, taskId);
    if (!task) return null;
    return this.run(task);
  }

  list() {
    return this.tasks.map((t) => ({
      key: t.key,
      channel: t.channel.id,
      id: t.def.id,
      name: t.def.name || t.def.id,
      runner: t.def.runner || 'http',
      at: t.def.at || null,
      every: t.def.every || null,
      running: t.running,
      nextRunAt: t.state.nextRunAt || null,
      lastRunAt: t.state.lastRunAt || null,
      lastStatus: t.state.lastStatus || null,
      lastHttpStatus: t.state.lastHttpStatus ?? null,
      lastResult: t.state.lastResult || null,
    }));
  }
}
