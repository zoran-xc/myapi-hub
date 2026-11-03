import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../src/router.js';

const fakeHost = {
  createChannel: () => ({ listModels: async () => [], chat: async () => ({ ok: true }) }),
  strategy: (name) => ({ weighted: (c) => c })[name] || ((c) => c),
};

const options = {
  strategy: 'weighted',
  maxAttempts: 3,
  timeoutMs: 1000,
  cooldownMs: 1000,
  cooldownMaxMs: 5000,
  modelRefreshMs: 1000,
  modelFetchTimeoutMs: 1000,
};

function makeRouter() {
  const router = new ModelRouter({
    channelDefs: [
      { id: 'trae', plugin: 'openai-compatible', baseUrl: 'http://t', weight: 2, priority: 0, aliases: {}, headers: {} },
      {
        id: 'proxy',
        plugin: 'openai-compatible',
        baseUrl: 'http://p',
        weight: 1,
        priority: 0,
        headers: {},
        aliases: { 'traecn-glm-5.2': 'glm-5.2', 'traecn-kimi-k2.6': 'kimi-k2.6' },
      },
    ],
    pluginHost: fakeHost,
    options,
  });
  router.channels[0].models = ['GLM-5.2', 'kimi-k2.6'];
  router.channels[1].models = ['traecn-glm-5.2', 'traecn-kimi-k2.6'];
  router.rebuildCatalog();
  return router;
}

test('大小写与别名归一到同一个 canonical 模型', () => {
  const router = makeRouter();
  const resolved = router.resolve('glm-5.2');
  assert.equal(resolved.canonical, 'glm-5.2');
  assert.equal(resolved.entries.length, 2);
  assert.deepEqual(resolved.entries.map((e) => e.upstreamId), ['GLM-5.2', 'traecn-glm-5.2']);
  assert.ok(router.resolve('GLM-5.2'));
});

test('"渠道/模型" 强制路由并保留上游模型原名', () => {
  const router = makeRouter();
  const forced = router.resolve('proxy/traecn-kimi-k2.6');
  assert.equal(forced.forced, true);
  assert.equal(forced.entries[0].channel.id, 'proxy');
  assert.equal(forced.entries[0].upstreamId, 'traecn-kimi-k2.6');
});

test('未知模型返回 null，可用列表只包含 canonical 名称', () => {
  const router = makeRouter();
  assert.equal(router.resolve('not-exist'), null);
  assert.deepEqual(router.modelIds(), ['glm-5.2', 'kimi-k2.6']);
});

test('冷却中的渠道排在可用渠道之后', () => {
  const router = makeRouter();
  const [trae, proxy] = router.channels;
  proxy.cooldownUntil = Date.now() + 10_000;
  const ordered = router.order(router.resolve('glm-5.2').entries, 'glm-5.2');
  assert.deepEqual(ordered.map((e) => e.channel.id), ['trae', 'proxy']);
  assert.equal(trae.available, true);
});
