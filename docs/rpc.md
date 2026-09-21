# 通用扩展操作 RPC v1

实现基线：Pi 0.82.0、Node ≥22.19、TypeBox 1.3.8。此协议由本仓库的 `pi-extension-rpc` 提供，不是原版 Pi 已有的接口。

## 启动和边界

```bash
node bin/pi-extension-rpc.mjs -e ./src/index.ts --no-session
```

父进程启动真正的 Pi CLI，添加通用注册扩展，通过 Node IPC 调用同一 Pi 进程中的业务操作。普通 Pi 命令仍由原生 RPC 处理。stdin/stdout 为 UTF-8 JSONL；stdout 只输出协议记录，stderr 为诊断信息。单个输入记录最大 1 MiB，命令 ID 与 requestId 最长 128 字符。启动超时为 30 秒。

这是本机进程接口，调用者拥有管理权限；它不是带身份认证的远程 HTTP 服务。转成网络服务的宿主需要自行确定调用者权限。客户端不读取 `models.json`、`auth.json` 或插件内部状态，不解析终端文本，不需要在传输代码中识别插件名称。

EOF 会关闭 Pi，任务和草稿不会跨进程保留。任务查询只能在当前进程仍存活时使用，不提供网络重连或持久任务恢复。

## 五个通用命令

| type | 字段 | 成功响应 data |
| --- | --- | --- |
| `get_extension_operations` | 无 | `protocolVersion`, `transport`, `capabilities`, `operations` |
| `invoke_extension_operation` | `operation`, `arguments`, 必填 `requestId` | 任务快照 |
| `get_extension_operation` | `operationId` | 任务快照及可选 `result` |
| `cancel_extension_operation` | `operationId` | `accepted` 和任务快照 |
| `respond_extension_interaction` | `operationId`, `interactionId`, `revision`, `response` | `{accepted:true}` |

每个命令可带字符串 `id`，用于关联单次响应。响应为 `{type:"response",id,command,success,data?}`。传输或操作查找错误返回 `success:false,error,errorDetails`。`errorDetails` 包含稳定的 `code`、`message`、`retryable` 及可选字段错误。

`requestId` 用于当前进程内去重：相同 ID 和相同参数返回同一任务；不同参数返回 `CONFLICT`。任务结果从完成时起保留 30 分钟，最多 1000 个任务。不要把命令 `id`、去重 `requestId`、任务 `operationId` 和认证 `interactionId` 混用。重启后先重读配置再决定是否重试写入。

## 操作描述与结果

每条操作描述有 `name,title,description,inputSchema,resultSchema,effects,allowedCallers,cancellable`。`resultSchema` **描述成功结果的 `data`**。输入和输出都会校验。秘密字段带 `writeOnly:true` 和 `x-secret:true`；客户端应隐藏输入，禁止记录原值。`effects` 描述可能发生的读、网络、配置写入和凭据写入。

调用后首次返回 `{operationId,state:"queued",sequence:0}`。事件携带 operationId 和递增的 sequence：

- `extension_operation_update`：`state`、`stage`。
- `extension_operation_result`：最终 `result`。
- `extension_interaction_request`：必要的认证输入或提示。
- `extension_interaction_end`：某个认证输入已经结束。

最终结果为：

```json
{
  "operationId":"<task-id>",
  "status":"succeeded",
  "data":{},
  "warnings":[],
  "effects":{"config":"unchanged","credentials":"unchanged","runtime":"unchanged"}
}
```

`status` 为 `succeeded/failed/cancelled/requires_user_action`。失败含 `error`；校验错误的 `fields` 只包含路径、错误码、说明，不回显输入值。

需要区分两个场景：认证任务正在等待输入时，快照的 state 为 `requires_user_action`，没有最终 result；普通发现操作缺少凭据时，返回 status 为 `requires_user_action` 的最终结果，错误码为 `AUTH_REQUIRED`，客户端随后可主动发起认证。是否存在 result 才是判断任务结束的依据。

最终 effects 是已发生的事实：config 为 `unchanged/committed`，credentials 为 `unchanged/updated`，runtime 为 `unchanged/synced/failed`。取消不能撤销已提交配置或远端授权。保存后同步失败会返回 `RUNTIME_SYNC_FAILED` 和 config committed，不能据此盲目重复新增。

## 直接调用示例

```jsonl
{"id":"q1","type":"get_extension_operations"}
{"id":"q2","type":"invoke_extension_operation","operation":"provider-manager/provider.create","requestId":"create-1","arguments":{"id":"example","api":"openai-completions","baseUrl":"http://127.0.0.1:18080/v1","auth":{"mode":"none"},"models":[{"id":"model-a","contextWindow":128000,"maxTokens":4096}]}}
```

等到最终结果后，从 `data.revision` 取得配置版本，再更新：

```jsonl
{"id":"q3","type":"invoke_extension_operation","operation":"provider-manager/provider.update","requestId":"update-1","arguments":{"providerId":"example","expectedRevision":"<revision>","set":{"name":"Example"}}}
```

可以直接执行 `provider.create/update/delete/selectModels`。`draft.*` 只是客户端自行选择的编辑方式，不是必经向导。草稿带独立 revision 和创建时的配置版本；保存时版本不一致会失败。草稿闲置 30 分钟过期，最多 100 个。

`catalog.list` 的 `authMethods` 按 API 过滤，每项的 `value` 可直接作为供应商的 `auth` 字段提交。更改草稿的目标地址、API 或 OAuth 提供方会清除旧候选列表，需重新发现或明确添加模型。认证操作在登录完成后、保存凭据前重新检查配置版本；配置已变化时返回冲突，不写入迟到的凭据。

已注册的操作组：

| 操作组 | 用途 |
| --- | --- |
| `provider.list/get/create/update/delete/selectModels` | 配置查询和一次性写入 |
| `catalog.list/presets` | API、认证方法、完整 Pi 模型预设 |
| `draft.create/open/get/patch/validate/commit/discard` | 可选的编辑与明确保存 |
| `draft.selectModels/upsertModel/removeModel/applyPreset` | 草稿模型编辑 |
| `model.discover/recommend` | 发现或补充元数据；不会自动登录 |
| `auth.status/configure/import/begin/clear/file` | 认证状态及用户主动认证 |
| `headers.set` | 只写 Header 值；省略 value 删除 |
| `runtime.sync` | 重试 Pi 模型注册 |

具体字段和必填条件以返回的 schema 为准。`provider.list` 和 `catalog.presets` 支持 limit（1–200）、filter 和 cursor；数据变化后旧 cursor 失效。发现结果有 model、source 和 availability，目录推荐不代表服务端实际可用。草稿返回字段 schema、候选、选择和 availableActions。修改时保留未编辑字段，清除字段使用 unset 或提交不含该可选字段的新模型。

## 认证

`auth.begin` 只在客户端主动调用时执行，复用 Pi 的 OAuth 实现。用户动作事件示例：

```json
{"type":"extension_interaction_request","operationId":"<task>","sequence":2,"interactionId":"<interaction>","revision":1,"requiresResponse":true,"kind":"select","message":"选择登录方式","options":[{"id":"device","label":"设备登录"}]}
```

必须提交稳定的选项 ID：

```json
{"id":"auth-response","type":"respond_extension_interaction","operationId":"<task>","interactionId":"<interaction>","revision":1,"response":{"value":"device"}}
```

取消可提交 `response:{"cancelled":true}`，或调用 cancel_extension_operation。过期交互或错误 revision 返回 STALE_REVISION。`kind` 还包括 `text/secret/manual_code`；提示包括 `open_url`（url）和 `device_code`（verificationUri、userCode），提示的 requiresResponse 为 false。原生宿主自行决定如何显示提示、打开链接、收集输入。

持久密钥、Token、Header 值和私有文件路径不出现在查询/结果中。临时设备码和授权 URL 只出现在用户主动发起的认证事件中。`auth.file.path` 是 Pi 服务端路径。需要本地浏览器回调的 OAuth 是否适用于远程宿主，取决于该 Pi OAuth 提供方；协议不会伪造已完成的授权。

## 其他扩展注册操作

扩展在工厂执行时，通过 Pi 的公开 EventBus 注册。通用 host 扩展先加载，再加载业务扩展。

```ts
import { Type } from "typebox";
import { registrationChannel } from "@d4rw1nz/pi-custom-provider/operations";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.events.emit(registrationChannel, {
    namespace: "notes",
    operations: [{
      name: "length", title: "字符数量", description: "计算输入长度",
      inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      resultSchema: Type.Object({ length: Type.Number() }, { additionalProperties: false }),
      effects: ["read"], allowedCallers: ["user_client"], cancellable: true,
      execute: async ({ text }, context) => {
        context.signal.throwIfAborted();
        return { length: text.length };
      },
    }],
  });
}
```

`execute` 返回 data；通用注册器生成最终结果。执行函数应遵守 signal，在提交后更新 context.effects，并只发布安全信息。需要明确业务错误时抛出公开的 OperationError。进度使用 context.progress，认证输入使用 context.prompt；这些都不依赖 TUI。扩展本身与 Pi 一样是受信任代码，桥不是扩展沙箱。
