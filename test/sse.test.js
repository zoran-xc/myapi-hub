import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCompletion, parseEvent } from '../src/sse.js';

test('解析 SSE 事件，支持多行 data', () => {
  assert.deepEqual(parseEvent('event: delta\ndata: {"a":1}\ndata: tail'), {
    event: 'delta',
    data: '{"a":1}\ntail',
  });
  assert.equal(parseEvent(': ping'), null);
});

test('聚合流式分片为完整 completion', async () => {
  const payload = [
    'data: {"id":"x","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"你"}}]}',
    '',
    'data: {"id":"x","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });

  const result = await collectCompletion({ body: stream }, { model: 'glm-5.2' });
  assert.equal(result.id, 'x');
  assert.equal(result.choices[0].message.content, '你好');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 3);
  assert.equal(result.model, 'glm-5.2');
});
