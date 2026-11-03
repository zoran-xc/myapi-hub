/**
 * 负载均衡策略插件。
 *
 * 策略是一个纯函数：(candidates, ctx) => 重排后的数组
 *   candidates: [{ id, weight, priority, ... }]
 *   ctx: { state: Map, key: string }
 * 通过 registerStrategy 注册即可被 channels.json 的 server.strategy 选用。
 */

/** 平滑加权轮询（nginx 算法）：同一 key 下按权重轮流，避免长权重连击。 */
export function weighted(candidates, { state, key }) {
  if (!candidates.length) return candidates;
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return candidates;
  const rounds = state.get(key) || new Map();
  for (const c of candidates) rounds.set(c.id, (rounds.get(c.id) || 0) + c.weight);
  let best = candidates[0];
  for (const c of candidates) {
    if (rounds.get(c.id) > rounds.get(best.id)) best = c;
  }
  rounds.set(best.id, rounds.get(best.id) - total);
  state.set(key, rounds);
  const rest = candidates.filter((c) => c.id !== best.id);
  return [best, ...rest];
}

/** 简单轮询：按 key 记住上一轮的下标。 */
export function roundRobin(candidates, { state, key }) {
  if (!candidates.length) return candidates;
  const idx = (state.get(key) || 0) % candidates.length;
  state.set(key, idx + 1);
  return [...candidates.slice(idx), ...candidates.slice(0, idx)];
}

/** 优先级：priority 小的先用，同优先级按权重降序。 */
export function priority(candidates) {
  return [...candidates].sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

export default {
  id: 'strategies',
  name: 'Built-in load balancing strategies',
  strategies: { weighted, roundRobin, priority },
};
