#!/usr/bin/env node
/** 入口：装载插件与渠道，启动调度器、健康巡检和 HTTP 服务。 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { PluginHost } from './plugin-host.js';
import { ModelRouter } from './router.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';
import { createServer } from './server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.1.0';

const logger = {
  info: (msg) => console.log(`[myapi] ${msg}`),
  error: (msg) => console.error(`[myapi] ${msg}`),
};

async function main() {
  const pluginHost = new PluginHost();
  await pluginHost.loadDir(path.join(ROOT, 'plugins'));
  logger.info(`插件已加载: ${[...pluginHost.types.keys()].join(', ')}；策略: ${[...pluginHost.strategies.keys()].join(', ')}`);

  const app = await createApp(pluginHost);
  const server = createServer({ app, version: VERSION });

  server.listen(app.config.port, app.config.host, () => {
    logger.info(`MyAPI Hub ${VERSION} 监听 http://${app.config.host}:${app.config.port}`);
    logger.info(`渠道 ${app.router.channels.length} 个，模型 ${app.router.catalog.size} 个；策略 ${app.config.strategy}`);
    if (!app.config.apiKey) logger.info('警告: 未设置 API Key，接口无鉴权');
  });

  let healthTimer = setInterval(async () => {
    const errors = await app.router.refreshModels({ force: true });
    if (errors.length) logger.error(`模型/健康刷新失败: ${errors.map((e) => e.channel).join(', ')}`);
  }, app.config.healthIntervalMs);
  healthTimer.unref?.();

  let statsTimer = setInterval(() => persistStats(app), 60_000);
  statsTimer.unref?.();

  const shutdown = (signal) => {
    logger.info(`收到 ${signal}，正在退出`);
    clearInterval(healthTimer);
    clearInterval(statsTimer);
    app.scheduler.stop();
    persistStats(app);
    app.store.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 热重载：重建渠道与调度器，配置改动无需重启容器
  app.reload = async () => {
    logger.info('重载配置…');
    app.scheduler.stop();
    persistStats(app);
    const next = await createApp(pluginHost);
    app.config = next.config;
    app.store = next.store;
    app.router = next.router;
    app.scheduler = next.scheduler;
    logger.info(`重载完成: 渠道 ${app.router.channels.length}，模型 ${app.router.catalog.size}`);
    return { channels: app.router.channels.length, models: app.router.catalog.size };
  };
}

async function createApp(pluginHost) {
  const config = loadConfig();
  const store = new Store(path.resolve(ROOT, config.stateFile));
  const options = {
    strategy: config.strategy,
    maxAttempts: config.maxAttempts,
    timeoutMs: config.timeoutMs,
    cooldownMs: config.cooldownMs,
    cooldownMaxMs: config.cooldownMaxMs,
    modelRefreshMs: config.modelRefreshMs,
    modelFetchTimeoutMs: Math.min(config.timeoutMs, 20_000),
  };

  const channelDefs = config.channels.map((def) => ({
    ...def,
    stats: store.get(`channels.${def.id}.stats`, {}),
  }));

  const router = new ModelRouter({ channelDefs, pluginHost, options });
  await router.refreshModels({ force: true });

  const scheduler = new Scheduler({
    channels: router.channels,
    runners: pluginHost.taskRunners,
    store,
    logger,
    tickMs: config.taskTickMs,
  });
  scheduler.start();

  return { config, store, router, scheduler, reload: async () => ({}) };
}

function persistStats(app) {
  for (const channel of app.router.channels) {
    app.store.set(`channels.${channel.id}.stats`, channel.stats);
  }
}

main().catch((e) => {
  logger.error(`启动失败: ${e.stack || e.message}`);
  process.exit(1);
});
