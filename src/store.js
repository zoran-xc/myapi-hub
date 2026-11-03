/** 轻量 JSON 状态存储：统计与任务状态落盘，写操作合并后原子替换。 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file) {
    this.file = path.resolve(file);
    this.data = {};
    this.timer = null;
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(key, fallback) {
    let cur = this.data;
    for (const part of String(key).split('.')) {
      if (!cur || typeof cur !== 'object') return fallback;
      cur = cur[part];
    }
    return cur === undefined ? fallback : cur;
  }

  set(key, value) {
    const parts = String(key).split('.');
    let cur = this.data;
    for (const part of parts.slice(0, -1)) {
      if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
      cur = cur[part];
    }
    cur[parts.at(-1)] = value;
    this.saveSoon();
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    this.timer.unref?.();
  }

  flush() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[store] 写入失败: ${e.message}`);
    }
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}
