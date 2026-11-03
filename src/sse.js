/** SSE 解析与响应聚合：上游统一按 stream=true 请求，这里负责读流与拼装。 */

import { newId } from './util.js';

export class UpstreamPayloadError extends Error {}

/** 解析单个 SSE 事件块，返回 { event, data }；无 data 返回 null。 */
export function parseEvent(raw) {
  let event = 'message';
  const data = [];
  for (const line of String(raw).split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/** 逐事件读取 SSE 流。onEvent 抛错会中止读取并向上传递。 */
export async function readSse(body, onEvent) {
  if (!body) throw new Error('empty upstream body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = async (raw) => {
    const evt = parseEvent(raw);
    if (evt) await onEvent(evt);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        await dispatch(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await dispatch(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已关闭
    }
  }
}

function mergeContent(target, content) {
  if (typeof content === 'string') return target + content;
  if (Array.isArray(content)) {
    return target + content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return target;
}

/** 把上游 SSE 流聚合成一个 OpenAI chat.completion 对象。 */
export async function collectCompletion(response, { model }) {
  let id = null;
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  const toolCalls = [];

  await readSse(response.body, ({ data }) => {
    if (!data || data === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (obj.error) {
      throw new UpstreamPayloadError(String(obj.error.message || obj.error));
    }
    if (obj.id) id = obj.id;
    if (obj.created) created = obj.created;
    if (obj.usage) usage = obj.usage;

    const choice = obj.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    content = mergeContent(content, delta.content);
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = call.index ?? 0;
        if (!toolCalls[index]) {
          toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        }
        const slot = toolCalls[index];
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.function.name += call.function.name;
        if (call.function?.arguments) slot.function.arguments += call.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  });

  const message = {
    role: 'assistant',
    content: toolCalls.length && !content ? null : content,
  };
  if (reasoning) message.reasoning_content = reasoning;
  const calls = toolCalls.filter(Boolean);
  if (calls.length) message.tool_calls = calls;

  const out = {
    id: id || newId(),
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish || (calls.length ? 'tool_calls' : 'stop') }],
  };
  if (usage) out.usage = usage;
  return out;
}
