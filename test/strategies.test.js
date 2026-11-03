import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority, roundRobin, weighted } from '../plugins/strategies.js';

const candidates = [
  { id: 'a', weight: 3, priority: 0 },
  { id: 'b', weight: 1, priority: 0 },
];

test('平滑加权轮询按 3:1 分布，且不会连续压死低权重渠道', () => {
  const state = new Map();
  const picks = [];
  for (let i = 0; i < 8; i += 1) {
    picks.push(weighted(candidates, { state, key: 'glm-5.2' })[0].id);
  }
  assert.deepEqual(picks.slice(0, 4), ['a', 'a', 'b', 'a']);
  assert.equal(picks.filter((id) => id === 'a').length, 6);
  assert.equal(picks.filter((id) => id === 'b').length, 2);
});

test('轮询在所有渠道之间循环', () => {
  const state = new Map();
  const three = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
  const picks = [];
  for (let i = 0; i < 6; i += 1) picks.push(roundRobin(three, { state, key: 'k' })[0].id);
  assert.deepEqual(picks, ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('优先级策略先小后大，同级按权重降序', () => {
  const ordered = priority([
    { id: 'a', weight: 1, priority: 2 },
    { id: 'b', weight: 3, priority: 0 },
    { id: 'c', weight: 1, priority: 0 },
  ]);
  assert.deepEqual(ordered.map((x) => x.id), ['b', 'c', 'a']);
});
