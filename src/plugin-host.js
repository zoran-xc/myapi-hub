/** 插件宿主：扫描 plugins/*.js，注册渠道类型、负载均衡策略与任务执行器。 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class PluginError extends Error {}

export class PluginHost {
  constructor() {
    this.types = new Map();
    this.strategies = new Map();
    this.taskRunners = new Map();
  }

  register(mod, source = '?') {
    const def = mod?.default || mod;
    if (!def || !def.id) throw new PluginError(`${source}: 插件缺少 id`);
    if (typeof def.create !== 'function' && !def.strategies && !def.taskRunners) {
      throw new PluginError(`${source}: 插件需要 create()，或至少提供 strategies / taskRunners`);
    }
    this.types.set(def.id, def);
    for (const [name, fn] of Object.entries(def.strategies || {})) {
      if (typeof fn !== 'function') throw new PluginError(`${source}: 策略 ${name} 不是函数`);
      this.strategies.set(name, fn);
    }
    for (const [name, fn] of Object.entries(def.taskRunners || {})) {
      if (typeof fn !== 'function') throw new PluginError(`${source}: 任务执行器 ${name} 不是函数`);
      this.taskRunners.set(name, fn);
    }
    return def;
  }

  async loadDir(dir) {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    for (const file of files) {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      this.register(mod, file);
    }
  }

  createChannel(def, ctx) {
    const type = this.types.get(def.plugin);
    if (!type || typeof type.create !== 'function') {
      throw new PluginError(`未知渠道插件: ${def.plugin}（渠道 ${def.id}）`);
    }
    return type.create(def, ctx);
  }

  strategy(name) {
    return this.strategies.get(name) || this.strategies.get('weighted');
  }
}
