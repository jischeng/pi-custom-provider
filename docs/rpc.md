# 通过 Pi 的 RPC 模式调用

本扩展不提供自己的 RPC。程序化调用就是 Pi 的 `--mode rpc`：JSONL over stdin/stdout，命令、事件、扩展 UI 子协议全部由 Pi 提供。这里只说明本扩展在这套协议上暴露了什么。

## 启动

```bash
pi --mode rpc -e ./src/index.ts
```

扩展注册一个命令 `model-config`，在 RPC 模式下有两种用法：

- **无参数**：输出操作目录（见下），不打开任何界面。
- **`<operation> <json>`**：执行一条操作。

## 发现操作

```jsonl
{"id":"c1","type":"get_commands"}
{"id":"c2","type":"prompt","message":"/model-config help"}
```

`get_commands` 里能看到 `model-config`。`help` 之后，本扩展向会话追加一条 entry：

```json
{"type":"custom","customType":"provider-manager/result","data":{"kind":"catalog","operations":[{"name":"provider.list","title":"List providers","description":"List providers","inputSchema":{...},"resultSchema":{...},"effects":["read"],"allowedCallers":["user_client","model_tool"],"cancellable":true}]}}
```

用 Pi 原生命令读回来：

```jsonl
{"id":"c3","type":"get_entries"}
```

目录里每条都带 `inputSchema`，客户端据此构造参数，不需要读本仓库源码。

## 执行操作

```jsonl
{"id":"i1","type":"prompt","message":"/model-config provider.list {\"limit\":50}"}
```

调用后：

1. 需要用户输入时，本扩展用 Pi 的扩展 UI 子协议发问：

```json
{"type":"extension_ui_request","id":"<ui-id>","method":"select","title":"Choose method","options":["Device method (device)"]}
```

客户端用 `extension_ui_response` 回应。`select` 的 `value` 接受界面上的整串（`设备登录 (device)` 形式）、裸 `id`（`device`）或 `label`；`input` 用 `value`；取消用 `cancelled: true`。带 `secret: true` 的输入会在标题里说明"输入可见"。

进度通过 `setStatus`（`extension_ui_request`，method `setStatus`，`statusKey: "model-config"`）推送，无需回应。

2. 结束时本扩展追加结果 entry，并发一条 `notify`：

```json
{"type":"extension_ui_request","id":"...","method":"notify","message":"provider.list: succeeded","notifyType":"info"}
```

```jsonl
{"id":"i2","type":"get_entries","since":"<调用前的 leafId>"}
```

拿到的 entry：

```json
{"type":"custom","customType":"provider-manager/result","data":{"kind":"result","operation":"provider.list","result":{"status":"succeeded","data":{"items":[],"total":0,"revision":"..."},"warnings":[],"effects":{"config":"unchanged","credentials":"unchanged","runtime":"unchanged"}}}}
```

`status` 为 `succeeded / failed / cancelled / requires_user_action`；失败带 `error.code`、`error.message`、`error.retryable` 和可选 `error.fields`（只有路径、错误码、说明，不回显输入值）。

注意顺序：`prompt` 的响应在命令**结束后**才发出（Pi 在 preflight 后立即回，命令本身可以在后台继续）。客户端应在等待响应的同时处理 `extension_ui_request`，并且用 `notify` 或 `get_entries` 判断结束，不要只等 `prompt` 响应。

## 已注册操作

| 操作组 | 用途 |
| --- | --- |
| `provider.list/get/create/update/delete/selectModels` | 配置查询和一次性写入 |
| `catalog.list/presets` | API、认证方法、完整 Pi 模型预设 |
| `draft.create/open/get/patch/validate/commit/discard` | 可选的编辑会话与明确保存 |
| `draft.selectModels/upsertModel/removeModel/applyPreset` | 草稿模型编辑 |
| `model.discover/recommend` | 发现或补充元数据；不会自动登录 |
| `auth.status/configure/import/begin/clear/file` | 认证状态及用户主动认证 |
| `headers.set` | 只写 Header 值；省略 value 删除 |
| `runtime.sync` | 重试 Pi 模型注册 |

`draft.*` 只是客户端可选的编辑方式，不是必经向导。草稿带独立 revision 和创建时的配置版本；保存时版本不一致会失败。草稿闲置 30 分钟过期，最多 100 个。

`provider.list` 和 `catalog.presets` 支持 limit（1–200）、filter 和 cursor；数据变化后旧 cursor 失效。发现结果有 `model`、`source` 和 `availability`，目录推荐不代表服务端实际可用。修改时保留未编辑字段；清除字段用 `unset`，或提交不含该可选字段的新模型。

## 认证

`auth.begin` 只在客户端主动调用时执行，复用 Pi 的 OAuth 实现。用户动作以扩展 UI 请求的形式出现（见上）。持久密钥、Token、Header 值和私有文件路径不出现在任何查询或结果里；设备码和授权 URL 只出现在用户主动发起的认证事件中。`auth.file.path` 是 Pi 服务端路径。

## 边界

- 取消由 Pi 管理。RPC 模式的命令没有 AbortSignal，`abort` 作用于 agent 而不是本扩展的操作。
- 结果是会话 entry，不进入 LLM 上下文；`get_entries` 的 `since` 支持增量读取。
- 这不是带身份认证的远程服务：能连上这个进程就等于拥有管理权限。要转成网络服务，由宿主自己定权限。
