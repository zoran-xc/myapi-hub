# MyAPI Hub

把多个「OpenAI 兼容网关」聚合成一个 `/v1` 入口的插件式小网关。

它不直接对接模型厂商，也不管理账号池——它管理的是**网关**：WorkBuddy、Trae、Qoder 这些各自已经有账号池和签到能力的项目，由 MyAPI Hub 在其之上再做一层跨平台的路由、负载均衡、健康检查与定时任务。

> 一句话：上游网关负责「一个平台里的多个账号」，MyAPI Hub 负责「多个平台之间的统一入口」。

## 特性

- **OpenAI 兼容**：`GET /v1/models`、`POST /v1/chat/completions`，支持流式与非流式，直接给各类客户端用。
- **插件式渠道**：`plugins/*.js` 注册渠道类型；内置 `openai-compatible`，任何暴露 `/v1` 的上游都能接入。
- **插件式负载均衡**：`weighted`（平滑加权轮询，默认）、`round-robin`、`priority`，也可自己注册策略。
- **插件式定时任务**：按渠道注册「每日签到 / Token 保活 / 活动领取」，内置通用 `http` 执行器。
- **自动容错**：429 读 `Retry-After`、失败指数退避冷却、单请求跨渠道换号重试。
- **模型归一**：不同渠道的同名模型（`GLM-5.2` 与 `traecn-glm-5.2`）用 `aliases` 合并成一个 canonical 名称，自动在这些渠道间分流。
- **统一看板**：内置零依赖 HTML 面板，看渠道状态、调权重、启用/停用、手动跑任务。
- **零依赖**：只用 Node 标准库，镜像小，启动快。

## 架构

```
                 ┌──────────────────────────────┐
  OpenAI 客户端 ─▶│        MyAPI Hub 8792        │
                 │  /v1/models  /v1/chat/...    │
                 │  ┌────────────┐ ┌──────────┐ │
                 │  │ 模型注册表 │ │ 策略插件 │ │  ← 第一级负载均衡（跨渠道）
                 │  └────────────┘ └──────────┘ │
                 │  ┌────────────────────────┐  │
                 │  │ 调度器（签到/保活）    │  │
                 │  └────────────────────────┘  │
                 └───┬───────────┬──────────┬───┘
                     │           │          │
        host.docker.internal（容器访问宿主机网关）
                     │           │          │
              ┌──────▼──┐  ┌─────▼─────┐  ┌─▼────────┐
              │ wb-proxy│  │trae2api-hub│ │ proxy-hub│
              │  8788   │  │   8791     │ │  8787    │
              │ 账号池  │  │  账号池    │ │ 单凭据   │
              └─────────┘  └────────────┘ └──────────┘
                     ↑ 第二级负载均衡（渠道网关内部按账号选号）
```

注意这是**两级负载均衡**：MyAPI Hub 选渠道，渠道网关选账号。等未来把渠道能力收编进本项目，第二级才会消失。

## 快速开始

```bash
cp channels.example.json channels.json   # 填入真实的 baseUrl / apiKey
docker compose up -d --build
curl -s http://127.0.0.1:8792/v1/models \
  -H "Authorization: Bearer $MYAPI_API_KEY" | head
```

本机直接跑（不经容器，需把 `host.docker.internal` 换成 `127.0.0.1`）：

```bash
npm start          # node src/index.js
npm test           # node --test test/
```

打开 <http://127.0.0.1:8792/> 是渠道看板，首次进入把 API Key 填进右上角输入框（存在 localStorage）。

## 配置

`channels.json`（已被 `.gitignore` 忽略）：

```json
{
  "server": {
    "port": 8792,
    "apiKey": "${MYAPI_API_KEY}",
    "strategy": "weighted",
    "maxAttempts": 3,
    "timeoutMs": 180000,
    "cooldownMs": 30000,
    "healthIntervalMs": 60000,
    "taskTickMs": 30000
  },
  "channels": [
    {
      "id": "workbuddy",
      "name": "WorkBuddy",
      "plugin": "openai-compatible",
      "baseUrl": "http://host.docker.internal:8788/v1",
      "apiKey": "…",
      "weight": 3,
      "priority": 0,
      "aliases": { "wb-glm-5.3": "glm-5.3" },
      "tasks": [
        {
          "id": "daily-checkin",
          "name": "每日签到",
          "at": "09:10",
          "method": "POST",
          "path": "/tasks/run",
          "json": {},
          "headers": { "X-Panel-Token": "${WB_PANEL_TOKEN}" }
        }
      ]
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `baseUrl` | 上游网关的 `/v1` 地址；容器里用 `host.docker.internal` |
| `apiKey` / `apiKeyEnv` | 上游网关的 Key，二选一；支持 `${ENV}` 展开 |
| `weight` | 加权轮询权重，越大越常被选中 |
| `priority` | 越小越优先；不同优先级不会互相抢占，只有同优先级才按权重轮询 |
| `aliases` | 上游模型名 → 跨渠道统一名，用于合并同名模型 |
| `tasks[].at` | 每天 `HH:MM`（本机时区）执行 |
| `tasks[].every` | 间隔执行，如 `6h`、`30m` |
| `tasks[].runner` | 任务执行器，默认 `http` |

## API

所有接口都要 `Authorization: Bearer <server.apiKey>`（看板除外）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/models` | 聚合后的模型列表，含 `x_myapi.channels` |
| POST | `/v1/chat/completions` | 对话，支持 `stream` |
| GET | `/admin/status` | 渠道、模型、任务全量状态 |
| POST | `/admin/reload` | 重载 `channels.json`（不用重启容器） |
| POST | `/admin/channels/:id/weight` | `{"weight": 3}` |
| POST | `/admin/channels/:id/toggle` | `{"enabled": false}` |
| GET | `/admin/tasks` | 任务列表 |
| POST | `/admin/tasks/:channel/:task/run` | 立即执行 |

响应头会带回本次实际命中的渠道：`X-MyAPI-Channel`、`X-MyAPI-Upstream-Model`、`X-MyAPI-Attempts`。

强制走某个渠道：模型名写成 `渠道/模型`，例如 `proxy/traecn-kimi-k2.6`。

## 插件协议

`plugins/xxx.js` 默认导出：

```js
export default {
  id: 'my-plugin',
  name: '说明',
  // 渠道类型：返回一个渠道实现
  create(def, ctx) {
    return {
      async listModels({ timeoutMs }) { /* -> string[] */ },
      chat(body, { signal, timeoutMs }) { /* -> Promise<Response> */ },
    };
  },
  // 可选：注册负载均衡策略 (candidates, { state, key }) => 重排后的数组
  strategies: { myStrategy(candidates) { return candidates; } },
  // 可选：注册任务执行器 (task, channel, ctx) => { ok, status, body }
  taskRunners: { myRunner(task, channel) { /* ... */ } },
};
```

渠道实现只需要两个方法：列出模型、发出上游请求。SSE 解析、非流式聚合、重试与冷却由核心统一处理。

## 设计取舍

- **只做网关层**：不去重复实现登录、抓凭据、账号池——那是上游项目已经做得更深的领域。
- **不做持久化数据库**：`data/state.json` 只存统计与任务时间，删掉即重置。
- **失败即换渠道**：流式请求一旦开始输出就不再切渠道，避免客户端收到拼接的半个回答。

## Roadmap

- [ ] 把 wb-proxy / trae2api-hub 的渠道实现下沉为原生插件（去掉一层 HTTP 转发）
- [ ] 渠道级配额账本与按模型维度的用量统计
- [ ] OpenAI `/v1/embeddings`、`/v1/responses` 透传
- [ ] Web 面板增加历史曲线
- [ ] 多实例与配置热同步

## 免责声明

本项目用于聚合**你自己拥有或已获授权**的账号与网关，不提供任何模型服务，也不绕过任何平台的额度限制。使用第三方网关可能违反其服务条款，风险由使用者自行承担。

## License

MIT
