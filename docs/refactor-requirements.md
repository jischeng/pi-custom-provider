# 供应商管理重构需求与方案

状态：2026-09-20 的原始需求和设计基线，随后已获准实施。当前实现、与初稿的差异和验证范围见 [实现记录](implementation.md)；客户端应以 [已实现的 RPC v1 协议](rpc.md) 为准。本文保留原始验收目标，不代表每一条都已经验收。

## 1. 目标与结论

把供应商管理从字符向导中分离成共享业务操作。终端命令、标准交互界面、RPC 客户端和模型工具调用同一套校验、发现、认证与保存逻辑。Pixle 或其他原生宿主只实现通用 Pi 接口，不读取插件内部状态，不解析 ANSI、标题或按键，也不按插件名称编写页面。

**RPC 的目标是给其他客户端直接适配的程序接口。** 客户端能够独立查询、提交操作、获得结构化结果、订阅状态和取消任务；界面由客户端决定。RPC 不执行终端向导，不要求客户端依次回答 select/input，不依赖模型生成工具调用，也不把弹窗转发当成程序接口。

当前 Pi 0.82.0 已有标准终端交互与工具注册，但**没有可供扩展注册的通用业务 RPC 接口**。因此本方案包含三项相互独立的交付：

1. 标准终端入口：通过 Pi 公开控件调用共享业务操作。
2. RPC 程序接口：通过通用扩展操作注册与传输能力，对客户端公开 schema、字段、选项、操作、结果、状态与取消。这部分需要 Pi 上游或通用宿主桥补充，不能声称原生 0.82.0 已支持。
3. 模型工具入口：通过 Pi `registerTool` 调用同一操作的适合模型使用的子集。

认证等必须由用户完成的步骤返回 `requires_user_action` 和明确的数据，由客户端决定如何让用户完成；这只是认证流程的一个状态，不意味着普通 RPC 操作要变成交互式向导。通用原生宿主根据操作描述和数据结构适配，不能为本插件写专用协议。

初次设计阶段只交付需求、设计和验收要求。后续已实现本仓库代码与通用桥；没有修改 Pixle 或 Pi 上游，也不表示上游已接受提案。不保留旧向导状态、按键协议或旧私有格式的兼容层。

## 2. 核对基线与证据

| 项目 | 本次核对结果 |
| --- | --- |
| 本仓库 | `e8329fa80cb0d69fbb5478bda0ea50714fd330d0`，包版本 `1.0.8` |
| 声明的依赖 | `package.json` 中 Pi 三个 peer dependency 都是 `*`，不能据此保证任意版本可用 |
| 锁文件 | `pnpm-lock.yaml` 锁定 `pi-coding-agent/pi-ai/pi-tui` 为 `0.82.0`，TypeBox 为 `1.3.8` |
| 上游版本 | 下载并核对 npm 发布包 `0.82.0` 的声明文件、实现和随包文档；npm `gitHead` 为 `083e61621276bff9f6faefab87ce07fcd98734e2` |
| 运行核对 | 在临时空 HOME、空 Pi 配置目录、空工作目录中运行真实 Pi 0.82.0 RPC；未使用模型服务、真实凭据或用户配置 |
| 文档约定 | 仓库原先只有中英文 README，没有 `docs/` 或额外仓库 AGENTS.md；新增此文档及核对记录，并在两份 README 中索引 |

公开接口以固定提交的 [扩展类型][pi-ext-types]、[RPC 类型][pi-rpc-types]、[RPC 实现][pi-rpc-mode]、[认证类型][pi-auth-types]、[Models 接口][pi-models] 为依据；不把当前 `main` 当作 0.82.0 的证据。运行记录与复现步骤见 [Pi 0.82.0 核对记录](pi-0.82.0-interface-audit.md)。此处描述的是设计时的核对；后续真实终端、工具及 RPC 测试见实现记录。没有进行 Pixle 实机验收。

## 3. 当前功能与重构对应入口

设计时的源码基线为上表提交中的 index.ts、wizard.ts、provider-flow.ts、models-config.ts（后三者已在实现中删除），其余模块为 [discovery.ts](../src/discovery.ts)、[oauth.ts](../src/oauth.ts)、[provider-registry.ts](../src/provider-registry.ts)、[pi-catalog.ts](../src/pi-catalog.ts)。

下表操作名是**拟新增的共享业务接口**，不是现有 Pi API 或 RPC 命令。终端从 `/provider-setup` 进入；RPC 客户端通过第 7 节通用操作接口直接调用，不经过该命令。

| 当前能力与实际限制 | 重构后的共享操作 | 入口与保留要求 |
| --- | --- | --- |
| 新增供应商：API 类型、Base URL、ID、认证、发现、选模、保存 | `draft.create / draft.patch / draft.commit` | 标准界面、RPC、工具；允许先保存无模型草稿配置，明确其不可用于对话 |
| 查看供应商、显示名称和模型数 | `provider.list / provider.get` | 三类入口均提供脱敏数据 |
| 修改名称、ID、URL、API、认证方式、headers、authHeader；当前部分修改自动保存 | `draft.open / draft.patch / draft.validate / draft.commit` | 保留字段和改名能力；统一显式保存，取消不再暗中保留本次配置修改 |
| 删除供应商并注销运行时注册；当前不删除认证记录 | `provider.delete` | 界面确认、工具用户确认；默认保留凭据，单独提供用户认证清除操作 |
| OpenAI 兼容、Anthropic、Gemini、Vertex、Ollama 模型发现；Codex OAuth 有专门发现路径 | `model.discover` | 复用 API 分派及 Codex 规则；不是所有 Catalog API 都有发现端点；不支持时允许手动添加 |
| Pi Catalog、models.dev 元数据与 URL/模型 ID 候选补充 | `catalog.list / model.recommend` | 保留来源和优先顺序；远端失败可带警告降级，不把推荐当作接口已经支持该模型 |
| 过滤、全选、勾选、取消选择、删除、手动模型 ID | `draft.selectModels / draft.upsertModel / draft.removeModel` | 稳定模型 ID，不暴露光标位置；候选只有选中才保存；过滤不改变隐藏项的选择 |
| 模型 reasoning、图片输入、contextWindow、maxTokens、价格、thinkingLevelMap、compat；完整预设 | `draft.patchModel / catalog.presets / draft.applyPreset` | 保留预设的完整元数据，包括缓存和分层价格；应用预设不改可调用模型 ID |
| 模型 api、baseUrl、headers 以及供应商 compat 在数据层已有支持，界面不都能独立编辑 | 同上及 `draft.patch` | 标准字段或带结构校验的高级编辑入口；明确这是补齐现有数据能力的界面 |
| API Key，包括已有 auth.json 中的 key；无 key 的本地服务 | `auth.status / auth.configure` | 仅用户界面提交新秘密；工具可查看状态或选用服务端已有引用；无认证必须显式选择 |
| 按安装的 Pi Catalog 筛选 OAuth；Radius 动态 API 有额外分支 | `catalog.authMethods / auth.begin` | 保留安装版本驱动的列表与必要 Radius 分支，不由 Base URL 猜认证提供方 |
| OAuth 登录、外部 JSON 路径、粘贴 JSON、刷新；当前会打开服务端 macOS 浏览器 | `auth.begin / auth.import / auth.status / auth.cancel` | 终端保留；RPC 浏览器在客户端打开，按认证实现判断设备码/手动回填是否可行 |
| 保存 models.json 后立即注册供应商，删除时注销 | `config.commit / runtime.sync` | 保留立即可用目标，增加写入与注册分别失败的状态；不要求 `/reload` 才生效 |
| `exportConfig/importConfig`、健康检查、聊天测试有导出函数，但没有当前命令向导入口 | 不列入首期必需操作 | 不把未接入函数算作现有用户流程；首期删除无调用代码或另案接入，不增加可能计费的自动聊天探测 |
| Escape/错误提示；网络函数只有自己的超时，没有向导整体取消信号 | `operation.cancel`、统一错误结构 | 补齐全链路取消与过期结果隔离，不能只关界面 |

当前实现需要改掉的行为：

- `index.ts` 明确拒绝 `ctx.mode !== "tui"`；主入口 `ctx.ui.custom` 只返回 `render/handleInput/invalidate`。`WizardState` 的字段不构成宿主公开接口。
- OAuth 辅助函数有标准 `select/input`，但主向导传入 `autoSelectFirst: true` 和自绘手动授权输入，不能据此认为整个向导已标准化。
- `repairConfig()` 在扩展加载时可能重写配置；读取出错会被折成空配置。改成只读加载、明确报错，修复必须是显式操作，防止错误状态下覆盖有效配置。
- 发现失败可能被 Catalog 推荐掩盖，HTTP 非成功也可能变成空列表。新结果必须同时表达来源、网络状态和降级警告。
- 当前 `src/e2e.ts` 直接构造向导状态并模拟保存，没有启动真实 Pi；现有测试不能证明 RPC、实际终端或工具调用通过。

## 4. 支持矩阵

RPC 列表示重构目标，需要第 7 节通用扩展操作协议落地；未经修改的 Pi 0.82.0 不具备这些管理 RPC。其现有模型选择、agent 控制和 UI 转发能力单独记录在第 6 节，不能冒充目标已经实现。

| 能力 | 标准终端界面 | RPC 程序接口（拟新增通用能力） | 标准注册工具 | 通用原生宿主 |
| --- | --- | --- | --- | --- |
| 供应商增查改删 | 分步输入、摘要、保存 | 直接 list/get/create/patch/commit/delete，返回结构化结果 | 非秘密字段；模型发起写入须用户确认 | 从操作描述生成界面，直接调用 RPC |
| 模型发现、筛选和选择 | 选择循环、多选、手动添加 | discover 返回任务 ID；查询/事件返回候选，selectModels 提交 ID 数组 | 支持，复用业务规则 | 按 ID 显示列表、多选和来源 |
| 普通配置和元数据 | 标准输入与选择 | 有 schema 的 patch；字段错误、revision 和保存结果 | 支持安全字段子集 | 根据字段类型呈现，不解析文字标签 |
| compat、thinkingLevelMap、价格 | 标准 JSON editor | 有结构校验的对象参数与结果 | 仅声明的 schema，禁任意配置透传 | 通用对象/数组编辑 |
| 新 API Key、OAuth JSON | 用户输入，不预填旧值 | 用户专用、writeOnly 的秘密提交操作；不要求服务端弹框 | 禁止秘密参数和返回值 | 自己收集并提交，宿主日志必须按元数据排除 |
| 已存凭据状态 | 状态/已有引用 | auth.status 返回状态和引用 | 支持脱敏状态 | 同一结构直接展示 |
| OAuth | 调用 Pi 认证实现 | auth.begin/status/respond/cancel；需用户操作时返回有类型的请求 | 仅报告需用户完成，不返回授权资料 | 自己决定浏览器、设备码和回填界面 |
| 外部 OAuth JSON 文件 | 服务端路径导入/引用 | 路径是 Pi 服务端路径；无通用上传就不支持客户端文件上传 | 禁止任意文件读取 | 明确服务端与客户端文件差别 |
| 取消与进度 | 控件取消传入业务 signal | 按 operationId 取消，收到确定的终态；不依赖 agent abort | 执行 signal；同一取消实现 | 可独立做进度页、后台任务或取消按钮 |
| 当前对话模型切换 | 使用 Pi 已有模型选择 | 复用现有 get_available_models/set_model | 管理工具不自动切换当前模型 | 使用宿主已有模型选择功能 |
| 非交互自动化 | 不适用 | 普通查询、发现、校验、写入均可；遇需用户认证时结构化返回 | 需要模型调用，不用来替代 RPC | 不必启动终端、弹窗或 LLM |

标准 Pi TUI 组件如 Input/SelectList 即使放入 custom()，仍然是终端组件，不会自动变成 RPC 接口。`hasUI` 在 RPC 中为 true 也不能证明客户端具备供应商管理能力。

## 5. 共享业务层

### 5.1 模块边界

拟拆分为 `domain/`（数据、校验、草稿和业务操作）、`adapters/pi/`（注册与认证接入）、`adapters/storage/`、`adapters/discovery/`、`entrypoints/`（命令、通用 RPC 操作注册和工具）、`ui/`（终端标准控件适配）。最终文件数量以实现需要为准。

- 业务层不导入 pi-tui，不读取按键，不引用 `WizardState` 或 `ExtensionContext`。
- 通过依赖传入 Catalog、认证存储、配置存储、HTTP 客户端、时钟、Pi 注册器和取消信号；禁止工具、RPC、界面各自实现保存规则。
- 终端适配器将操作结果转换成标准控件；RPC 直接传递数据，客户端决定是否及如何呈现。业务操作接受有类型的数据，不接受显示标签。
- `index.ts` 只负责装配、注册、加载时只读初始化及生命周期清理。所有入口依赖同一个服务实例和同一写入锁。
- 内部数据有类型并不等于宿主能访问；跨进程支持必须有实际传输与宿主能力协商。

### 5.2 数据契约（拟新增）

```ts
type AuthSummary = {
  mode: "none" | "api_key" | "oauth";
  methodId?: string;
  status: "missing" | "configured" | "expired" | "needs_login" | "unknown";
  credentialRef?: string; // 服务分配的不透明引用，不是 token 或原始文件路径
};

type ProviderView = {
  id: string;
  name?: string;
  api: string;
  baseUrl: string;        // 拒绝含账号、密码或凭据查询参数的 URL
  auth: AuthSummary;
  authHeader: "auto" | "on" | "off";
  headers: HeaderView[];  // 键名、hasValue、引用；无已有秘密值
  compat?: ValidatedCompat;
  modelCount: number;
  revision: string;
  runtimeStatus: "ready" | "pending" | "failed";
};

type ModelView = {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  headers?: HeaderView[];
  cost?: ModelCost;       // 以固定版本 Pi 的结构为准，保留 tiers 和缓存价格
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: ValidatedCompat;
};

type Candidate = {
  model: ModelView;
  source: "api" | "pi_catalog" | "models_dev" | "manual";
  match?: "model_id" | "base_url";
  availability: "listed" | "suggested" | "unknown";
  selected: boolean;
};

type DraftView = {
  draftId: string;
  revision: number;
  baseConfigRevision: string;
  originalProviderId?: string;
  provider: ProviderView;
  models: ModelView[];
  selectedModelIds: string[];
  dirty: boolean;
  errors: FieldError[];
};

type FieldError = { path: string; code: string; message: string };
type OperationResult<T> = {
  operationId: string;
  status: "succeeded" | "failed" | "cancelled" | "requires_user_action";
  data?: T;
  error?: {
    code: string;
    message: string;
    fields?: FieldError[];
    retryable: boolean;
  };
  warnings: { code: string; message: string }[];
  effects: {
    config: "unchanged" | "committed";
    credentials: "unchanged" | "updated";
    runtime: "unchanged" | "synced" | "failed";
  };
};
```

这些是传输视图，不得直接序列化存储对象。headers 在普通视图中只给键名、是否已设置及不透明引用；已存值无论位于供应商、模型、compat、自定义配置或认证对象中，都要经过统一字段白名单检查。`HeaderView/ModelCost/ThinkingLevelMap/ValidatedCompat` 实现时须有 JSON schema，不能只用 TypeScript 断言。

补充契约：

- 候选分页输入 `{cursor?, limit, filter?}`，`limit` 默认 50、最大 200；输出 `{items,nextCursor?,total}`。分页游标绑定候选集版本，过期返回 `STALE_REVISION`。
- 更新采用明确的 `set` 和 `unset` 字段列表，省略表示保留；空字符串不是“保持旧 key”。认证单独支持 `keep/replace/clear`，模型工具只允许 `keep` 或已授权引用。
- 操作上下文包含调用来源、服务端拥有的用户交互能力、`AbortSignal` 和 requestId；调用方不能提交 `trusted: true` 冒充用户。请求 ID 不包含秘密。
- 每个草稿归属当前工作流/会话。终端退出、Pi 会话销毁或 RPC 进程输入关闭时取消未提交操作并清理秘密；通用桥若保持进程存活，可按第 7 节任务保留期提供状态查询。不从聊天历史重建含秘密的草稿。

### 5.3 操作与校验

| 操作族 | 参数与结果要点 |
| --- | --- |
| `provider.list/get` | ID、分页 → ProviderView、ModelView、AuthSummary；不得触发凭据命令或 OAuth 刷新 |
| `provider.create/update` | 完整安全配置、expectedRevision（更新必需）、requestId → 提交结果；内部组合草稿/校验/提交，客户端无需逐步调用 |
| `draft.create/open/get` | 新建意图或现有 ID → 草稿、版本、安全值、字段 schema 与 availableActions |
| `draft.patch/patchModel` | draftId、草稿 revision、允许的字段 → 新草稿及逐字段错误 |
| `model.discover/recommend` | 草稿引用、查询条件、signal → 候选、来源、警告；不自动选择或保存 |
| `draft.selectModels` | draftId、候选版本、完整 selectedModelIds → 新选择；校验 ID 属于当前候选/手动模型集合 |
| `draft.applyPreset` | draftId、目标 modelId、稳定 presetId → 保留目标 ID 的模型草稿 |
| `draft.validate/commit` | 草稿版本、原配置 revision、requestId → 脱敏变更摘要或提交结果 |
| `provider.delete` | ID、配置 revision、可信来源的显式删除请求 → 结果；工具入口另需用户确认，默认不清凭据 |
| `auth.status/begin/import/respond/cancel/clear` | provider/draft、认证实现 ID、可信用户动作通道 → 状态；绝不将 Credential 放进 OperationResult |
| `operation.cancel/get` | operationId → 取消结果或状态；归属检查，不跨用户/会话操作 |

校验至少包括：

1. Provider ID 非空、限定字符、禁止原型属性名；新增/改名时检查配置、注册器及凭据目标冲突，不覆盖内置供应商或其他扩展注册。模型 ID 在供应商内唯一，允许服务实际需要的 `/` 等字符。
2. API 与 OAuth methodId 必须来自当前安装 Pi 支持列表。切换 API 后不静默改用另一种认证；要求用户重新确认兼容选项。Catalog 不支持某项时显示原因。
3. URL 只允许 http/https，无内嵌账号密码；HTTP 留给明确配置的本地服务。工具不得更改带现有凭据的目标 URL、认证提供方或敏感 header 引用而省略用户对新目的地的确认。
4. contextWindow/maxTokens 为正安全整数，价格非负且有限；输入模态、thinkingLevelMap、compat 按实际 API schema 校验。非法 JSON 和非法字段都返回精确路径，不沿用旧值伪装保存成功。
5. headers 是受大小限制的字符串映射，禁止换行；任意可能含密钥的值只走用户秘密提交通道。模型工具不接受任意 JSON、任意文件路径、`!command` 或环境变量读取指令作为配置捷径。
6. 请求大小、嵌套层数、模型数量设上限；配置写入前按 Pi 可注册结构再校验一次。旧数据无法识别时明确报错，不“修复”为默认配置。

### 5.4 保存、一致性和错误

终端界面统一“修改草稿 → 校验和摘要 → 保存”；移除现有逐项自动保存。RPC 可以一次提交完整配置，内部仍通过同一校验与提交实现；模型工具也复用它们，不直接写文件。

- 配置采用文件锁内的读取、revision 比较、合并、临时文件写入和原子替换；必须保留其他供应商及不属于本插件的根字段。对话过期或外部文件被修改时返回 `CONFLICT`，不覆盖。
- 保存结果区分配置已落盘、凭据已更新、运行时注册是否成功。注册失败不能回报完整成功；提供重试同步操作，重启后能只读加载并重试注册。
- 配置文件、凭据存储、Pi 注册器不是单一事务。首次认证为发现模型而保存凭据后，取消配置草稿不会自动撤销登录；结果明确 `credentials: updated, config: unchanged`，允许用户独立清除认证。
- 改名时先检查目标凭据冲突，再受控复制旧凭据到新 ID、提交配置并同步、最后清理旧绑定。各阶段记录不含秘密的状态；中途失败保留旧凭据并报告待恢复状态，不承诺跨文件原子性。外部文件引用不擅自改写第三方键名，必要时通过明确的存储映射处理。
- 当前会话正在使用的供应商/模型禁止删除或改名，返回 `ACTIVE_MODEL_IN_USE`，用户先用 Pi 自身模型选择切换。其他写操作在流式请求使用相关供应商时返回 `BUSY`，不在请求中途改认证/端点。
- 相同 requestId 在进程内短期去重，版本冲突作为重试边界。断线后先查询状态和配置 revision；不承诺进程重启后的 exactly-once，不盲目重发写入。

统一错误码至少包含 `VALIDATION_ERROR/NOT_FOUND/CONFLICT/STALE_REVISION/BUSY/ACTIVE_MODEL_IN_USE/AUTH_REQUIRED/AUTH_FAILED/USER_ACTION_REQUIRED/UNSUPPORTED_CAPABILITY/DISCOVERY_UNSUPPORTED/NETWORK_ERROR/TIMEOUT/CONFIG_READ_FAILED/CONFIG_WRITE_FAILED/RUNTIME_SYNC_FAILED/CANCELLED`。HTTP 401、403、429、5xx 保留安全的状态码和可重试信息；错误不包含 token、完整请求 header、认证 URL 查询串或原始服务端响应体。

取消贯穿发现、元数据查询、OAuth、排队和保存前检查。每次工作流有独立 controller，合并工具 signal、OAuth 单步 signal 和超时。新请求使旧结果失效；取消后的网络晚到结果不得写入草稿或文件。进入不可中断的本地提交阶段后，返回真实提交结果，不能把已经生效的写入标作 `cancelled`。

## 6. 标准终端与当前 Pi RPC 的边界

### 6.1 标准终端流程

`/provider-setup` → 选择供应商或新增 → 选择操作 → 输入/选择字段 → 认证 → 发现或手动模型 → 模型选择与编辑 → 查看摘要 → 确认保存。

- 用 `ctx.ui.select` 选择供应商、API、认证方式、字段、模型、预设和操作；`input` 收集单行文本；`editor` 编辑复杂非秘密 JSON；`confirm` 确认保存、删除和取消任务；`notify` 给安全提示。
- 0.82.0 没有标准多选接口。终端采用“选择模型切换勾选 / 全选当前过滤结果 / 清除当前过滤结果 / 完成”的循环。标签到 ID 的映射仅属于终端适配器，业务层及 RPC 不使用这套字符串协议。
- 原有快捷键、字符表格、光标位置和布局不保留。保留终端操作能力，不要求原向导原样复用。
- 标准 input/editor 没有保密参数，不能保证隐藏新输入。不得回填已有秘密；用户可选服务端已有引用。是否强制所有终端秘密输入都隐藏，见待决定事项。
- 长操作使用业务 controller，终端取消控件只负责触发 controller。RPC 使用独立的 operationId 取消接口，不调用这些控件。

### 6.2 当前 Pi RPC 能力核对

Pi 0.82.0 RPC 是 stdin/stdout 上的 LF 分隔 JSON。它已有模型、会话、agent 控制等程序接口；扩展 UI 转发只是其中一部分，不等于本项目所需的业务 RPC。[类型依据][pi-rpc-types]

| 命令或接口 | 已有能力与本项目边界 |
| --- | --- |
| get_commands | 枚举命令名称、说明和来源，没有操作参数、结果或字段 schema |
| prompt | 可执行 `/provider-setup` 这样的扩展命令，但只接受命令文本，不提供类型化业务参数/结果；不是本方案 RPC 入口 |
| steer/follow_up | 不能执行扩展命令；与管理接口无关 |
| get_available_models/set_model/cycle_model | 已注册可用模型及当前模型选择；可复用，不能替代远程模型发现或供应商 CRUD |
| get_state | 会话状态，不包含插件业务任务和草稿 |
| abort | 中止 agent 工作和重试，不保证中止独立业务命令；不能当作 operation.cancel |
| abort_retry/abort_bash | 针对各自工作，不是业务任务取消 |
| get_messages/get_entries/get_tree 等 | 会话内容；不是操作结果存储和查询 API |
| new_session/switch_session/fork/clone | 会话管理；需处理相应生命周期清理 |
| bash | 通用命令执行；不以 shell、脚本或读私有文件替代管理 RPC |
| registerTool | 是扩展侧模型工具注册；现有 RPC 没有 call_tool，也没有工具 schema 枚举命令 |
| 缺少的能力 | 扩展业务操作的公开注册、schema 枚举、结构化调用、任务状态、按任务取消 |

完整命令枚举见 [核对记录](pi-0.82.0-interface-audit.md)。其他 thinking、队列、压缩、重试、导出和统计命令不承担供应商业务。

### 6.3 现有 UI 子协议及事件：仅记录事实，不作为 RPC 设计主体

`extension_ui_request` 有 select、confirm、input、editor 四种需回复方法。回复为 value、confirmed 或 cancelled，按 UI request id 关联；select 的 options 只有 string[]。notify/setStatus/setWidget/setTitle/set_editor_text 无需回复，widget 仅传字符串数组。custom 返回 undefined；原始终端输入、自定义编辑器、页眉页脚不跨 RPC。[实现依据][pi-rpc-mode]

select/confirm/input 支持 signal/timeout，editor 没有这两个参数。服务端自行取消或超时时没有对应关闭事件，UI request 也不带原 prompt 的 id。这些都说明 UI 转发不能用来表达可独立调用、查询、恢复和取消的管理任务。

现有 agent/turn/message/tool_execution 事件以及 queue、compaction、retry、extension_error 事件属于相应 Pi 工作。tool_execution 用 toolCallId 关联，但普通管理操作不会自动获得这套事件。

本次实测当前插件返回 `TUI only`，随后 prompt 仍 success true；上游命令执行逻辑也会捕获异常后发 extension_error。因此，RPC 验收必须检查**管理操作自己的结构化结果**，不能断言 prompt success 后认为管理成功。

### 6.4 明确的现状判断

未经修改的 Pi 0.82.0 **无法完整实现用户要求的管理 RPC**。仅将命令允许在 rpc 模式执行、改用标准 select/input，或让模型调用工具，都不算这个要求通过。

业务服务和标准终端/工具可以先实现；RPC 必须完成下一节的通用操作注册与传输补充。该依赖须纳入实施任务，不能对客户端谎报已支持，也不把不能适配的问题交给 Pixle 写专用分支。

## 7. 面向客户端适配的 RPC 设计（通用补充提案）

本节 API 名称、命令和事件是**拟新增规范**，不存在于 Pi 0.82.0。本次只制定需求，不修改上游或宿主。建议在 Pi 上游增加通用扩展操作机制；如果由通用桥先实现，也必须让任何扩展按同样方式注册，不读取本插件私有文件或状态。

### 7.1 调用关系与职责

客户端 → 通用 Pi RPC 操作注册器 → 本插件公开注册的 operation → 共享业务服务。

终端命令与模型工具也调用该服务。RPC 操作 handler 中禁止调用 ctx.ui、prompt、终端渲染或 LLM。客户端可以是 UIKit 应用、桌面应用、网页或无界面程序；普通读写请求都能独立完成，不必维持一段向导对话。

工具写入的用户确认属于**模型工具入口策略**。RPC 客户端代表已授权用户显式提交 commit/delete 时，不再要求服务端弹出第二个确认框；权限由运行时/桥的可信连接上下文判定，不能从请求中的 `trusted/confirmed` 字段获取。

### 7.2 通用操作注册与描述

拟增加 `pi.registerOperation(definition)`，操作命名空间由扩展注册器分配，避免插件冲突。它与 registerTool 独立：不是所有用户管理操作都适合开放给模型。命令、RPC 与工具复用同一业务函数和 schema，不重写校验。

```ts
// 提案类型，不是现有 ExtensionAPI
interface OperationDefinition {
  name: string;                  // 扩展命名空间内稳定的操作 ID
  title: string;
  description: string;
  inputSchema: JsonSchema;
  resultSchema: JsonSchema;
  effects: ("read" | "network" | "config_write" | "credential_write")[];
  allowedCallers: ("user_client" | "model_tool")[];
  cancellable: boolean;
  execute(params: unknown, context: OperationContext): Promise<OperationResult<unknown>>;
}
```

OperationContext 提供 operationId、signal、可信调用来源、事件发布和用户动作请求接口，不包含必须使用的 UI。注册时输出 schema 必须可 JSON 序列化；秘密输入用 writeOnly 和明确的 secret 字段元数据，日志在解析入口就据此排除，不能等 handler 收到后才清理。

`provider.list/get/create/update`、`catalog.list/authMethods/presets`、`draft.create/open/get/patch/validate/selectModels/applyPreset/commit/discard`、`model.discover/recommend`、`provider.delete`、`auth.status/configure/begin/import/respond/cancel/clear` 按统一机制注册。operation.get/cancel 是通用任务注册器能力，不由插件各写一份 RPC 协议。

客户端可以一次调用 provider.create/update 提交完整配置；draft.* 是可选的编辑、预览与分阶段提交能力，不是必须照着执行的向导步骤。客户端通过操作描述获知输入、结果、字段类型、必填约束及副作用。动态选项由 Catalog 操作或草稿的最新 schema 返回；选项包含稳定 id、label、description、disabledReason，不依赖中文/英文标签。DraftView 补充 safe schema、fieldErrors 和 availableActions；availableActions 引用公开操作 ID 及预绑定的 draftId/revision，宿主可通用生成操作入口。

### 7.3 最小传输命令与事件

继续使用 Pi 的 JSONL 传输方式，增加以下**通用命令**；具体命名由上游评审决定。

| 拟新增命令 | 参数/返回 | 用途 |
| --- | --- | --- |
| get_extension_operations | 可选命名空间；返回协议版本、能力及 OperationDefinition 的可序列化描述 | 发现操作和 schema，无需插件名单 |
| invoke_extension_operation | operation、arguments、requestId | 调用操作；返回 operationId 和状态快照；快捷操作可直接附结果 |
| get_extension_operation | operationId、可选 afterSequence | 查询状态和最终结果；断线后恢复显示，不解析日志 |
| cancel_extension_operation | operationId | 请求取消；返回是否接受及当前状态，最终以终态结果为准 |
| respond_extension_interaction | operationId、interactionId、revision、response | 仅当业务确实需要用户完成认证等动作时提交，普通操作不用 |

事件为 `extension_operation_update`、`extension_operation_result`、`extension_interaction_request` 和 `extension_interaction_end`，都带 operationId 和递增 sequence。结果数据采用第 5 节 OperationResult。只有认证等业务需要外部输入时才出现 interaction 事件，不发送通用字段逐题询问。

- command id 关联一次请求响应，requestId 用于写入重试去重，operationId 标识任务，interactionId 标识一次认证输入；不能互相替代。
- 状态为 queued/running/requires_user_action/succeeded/failed/cancelled；状态快照携带 revision/sequence，客户端忽略重复事件并可主动查询最终结果。
- requires_user_action 对认证任务是可恢复的非终态快照，客户端当前等待可结束；只有 succeeded/failed/cancelled 发布最终 result 事件。支持多个任务并发，写入由共享锁与配置 revision 控制。一个草稿版本的操作不能覆盖另一个版本。
- 已接受的业务调用即使校验或执行失败，也返回有 operationId 的结构化 failed 结果。无法解析的传输命令、未知操作等属于协议错误，给稳定错误码，不暴露内部异常。
- 客户端在同一 Pi 进程仍存活时可重连查询；建议已完成任务保留 30 分钟、草稿闲置 30 分钟过期，均不持久化秘密。进程重启后未知 operationId 明确返回 NOT_FOUND，客户端重新读配置，不能盲目重放写入。
- stdin 关闭/会话销毁时取消未提交工作；提交临界区已经完成的返回事实，不虚报回滚。取消不能撤销已经完成的外部 OAuth 授权。
- 纯查询、发现及正常校验不会要求用户输入。发现缺少认证时立即返回 AUTH_REQUIRED/requires_user_action，由客户端自行决定是否发起 auth.begin，不能隐式启动登录。

旧 Pi 对新能力查询返回未知命令时，客户端明确显示管理 RPC 不受支持。**不自动退回 prompt + 弹窗，也不退回模型工具调用。**

### 7.4 直接调用示例

以下记录全部是**拟新增协议示例**，不能发给未经修改的 Pi 0.82.0 后宣称应该成功。操作名由 get_extension_operations 发现；示例以 `provider-manager/` 表示注册器分配的命名空间，宿主不能硬编码它。

```jsonl
{"id":"r1","type":"invoke_extension_operation","operation":"provider-manager/provider.list","arguments":{"limit":50},"requestId":"req-list-1"}
{"id":"r1","type":"response","command":"invoke_extension_operation","success":true,"data":{"operationId":"op1","state":"succeeded","sequence":1,"result":{"operationId":"op1","status":"succeeded","data":{"items":[],"total":0},"warnings":[],"effects":{"config":"unchanged","credentials":"unchanged","runtime":"unchanged"}}}}
{"id":"r2","type":"invoke_extension_operation","operation":"provider-manager/draft.create","arguments":{"id":"fixture-provider","api":"openai-completions","baseUrl":"http://127.0.0.1:18080/v1","auth":{"mode":"none"}},"requestId":"req-create-1"}
```

r2 返回 draftId/revision 后，客户端可以自行编辑整张表单，一次提交多个字段，不需要按终端步骤顺序提交。下面展示长任务：

```jsonl
{"id":"r3","type":"invoke_extension_operation","operation":"provider-manager/model.discover","arguments":{"draftId":"d1","revision":1},"requestId":"req-discover-1"}
{"id":"r3","type":"response","command":"invoke_extension_operation","success":true,"data":{"operationId":"op3","state":"running","sequence":0}}
{"type":"extension_operation_update","operationId":"op3","sequence":1,"state":"running","stage":"fetch_models"}
{"id":"r4","type":"cancel_extension_operation","operationId":"op3"}
{"id":"r4","type":"response","command":"cancel_extension_operation","success":true,"data":{"accepted":true,"operationId":"op3","state":"running"}}
{"type":"extension_operation_result","operationId":"op3","sequence":2,"result":{"operationId":"op3","status":"cancelled","warnings":[],"effects":{"config":"unchanged","credentials":"unchanged","runtime":"unchanged"}}}
```

成功发现时相同终态事件返回 `{items,nextCursor?,warnings}` 中的结构化候选。客户端再直接调用 draft.selectModels、draft.patch、draft.validate、draft.commit；任何业务错误都在结果中表示。最后通过 provider.get 读取持久化 revision，并用已有 get_available_models/set_model 验证注册和当前模型选择。整个流程没有 `/provider-setup`、select/input 弹窗或模型参与。

### 7.5 认证：客户端主动发起的独立操作

auth.begin 只在客户端明确请求认证时执行，复用 Pi AuthInteraction/AuthPrompt/AuthEvent；这些公开类型已有 secret、稳定选项 ID、auth_url、device_code 和 manual_code，可投影为通用认证任务数据。[认证类型依据][pi-auth-types]

需要用户动作时，返回/发布 `{operationId,interactionId,revision,kind,payload,expiresAt?}`：kind 为 choose_method、open_url、device_code、text、secret 或 manual_code；payload 按 kind 定义 schema。客户端决定怎样显示和收集，或让调用方稍后继续。自动化调用方收到 requires_user_action 就正常结束本次等待，不被隐藏的 UI Promise 卡住。

- 用户提交用 respond_extension_interaction；重复、过期或不匹配 revision 的提交不能写认证数据。OAuth 回调先完成时发送 interaction_end，迟到回填忽略并报告已结束。
- 授权链接、设备码和回填内容只对可信用户客户端开放，不写普通日志，不出现在工具结果、聊天或普通 operation 查询中；认证状态查询仅给安全摘要。
- 设备码轮询运行在服务端，可按 operationId 取消。服务端不调用 macOS open；客户端决定是否打开浏览器。
- 手机浏览器无法自动访问服务器的 localhost 回调。只有具体 Pi OAuth 实现支持设备码/手动回填时才可远程完成，否则返回 UNSUPPORTED_CAPABILITY，使用服务端已完成的认证；不能虚构 redirect_uri 或手机回调支持。
- 外部文件路径属于 Pi 服务端。没有通用文件上传能力时，不支持直接上传手机 JSON 文件；用户可走明确的秘密提交操作或已有服务端引用，不能让模型读取文件。

### 7.6 通用原生宿主需要的数据

客户端至少能得到：操作目录及输入/结果 schema、ProviderView、ModelView、AuthSummary、DraftView 的安全值与字段 schema、动态选项、字段错误、availableActions、任务状态/结果、按 ID 取消与独立认证动作。

这足以让宿主自行组织页面，也足以让通用 schema 编辑器呈现操作。无需增加由插件控制页面顺序的 form 工作流协议；如将来上游提供通用表单，可作为额外便利，不能取代程序接口。

同一宿主必须用相同操作目录/schema 适配代码支持另一个无关扩展。宿主不得导入 WizardState、解析 ANSI 或标签、探测按键、读取插件配置文件，或根据 provider-manager/custom-provider 名称启用专用行为。

## 8. 标准工具注册

使用 Pi `registerTool`、TypeBox 参数 schema 和标准 `execute(toolCallId, params, signal, onUpdate, ctx)`，优先使用默认工具渲染。`renderCall/renderResult` 是可选 TUI 展示，不承载业务结果。[扩展接口依据][pi-ext-types]

首期工具范围：

| 工具名（拟定） | 参数概要 | 行为 |
| --- | --- | --- |
| `provider_list` | cursor、limit、filter | 脱敏供应商列表 |
| `provider_get` | providerId | 配置安全视图、模型和认证状态 |
| `provider_catalog` | api?、kind、filter、cursor、limit | API、认证方式或预设列表，稳定 ID |
| `provider_discover_models` | providerId 或受校验的草稿引用 | 返回候选、来源和警告；认证不足返回需用户操作 |
| `provider_create` | 非秘密供应商字段、模型、可选已有 credentialRef、requestId | 草稿、校验、用户确认、提交 |
| `provider_update` | providerId、expectedRevision、明确 patch、requestId | 支持名称/ID/配置与模型元数据修改；敏感变更须展示目的地 |
| `provider_select_models` | providerId、expectedRevision、候选版本、modelIds、requestId | 用户确认后保存完整选择，不把其他入口的草稿覆盖掉 |
| `provider_delete` | providerId、expectedRevision、requestId | 用户确认后删除配置与注册；不清凭据 |
| `provider_auth_status` | providerId | 仅 AuthSummary |

不注册返回凭据、设置明文 key、粘贴 OAuth JSON、代填授权码、读取任意路径或任意导入导出工具。认证不足时返回 `requires_user_action`、安全原因和用户命令 `/provider-setup`；模型最多说明需要用户登录，不接收 URL 中的 state、设备码、token 或 callback 内容。

工具写入策略：

- 首期所有持久化写入展示脱敏摘要，通过终端 `ctx.ui.confirm` 或通用用户动作能力得到用户确认。确认记录由服务端绑定操作内容和 revision；参数中的 `confirmed: true` 不被当作用户授权。这个限制针对模型工具，已授权客户端直接提交业务 RPC 不需要额外服务端弹窗。
- `ctx.hasUI === false` 或客户端无法确认时返回 `requires_user_action`，不悄悄保存。用户完成认证后模型重新执行原操作，无需第二套认证/保存规则。
- 注册写工具为 `executionMode: "sequential"`，业务层仍做锁与冲突检查，因为命令、其他会话和外部编辑并不受这个标记约束。
- `onUpdate` 只给经过白名单过滤的进度，最终 `details` 给 OperationResult，`content` 给简短文字；两者都可能被宿主、会话或其他扩展看到，都按可公开数据处理。
- Pi 0.82.0 的 execute 返回对象里直接写 `isError` 不会产生错误标记。预期业务失败可返回结构化 details，再通过本插件注册的标准 `tool_result` 钩子仅对自身工具设置 `isError: true`；`requires_user_action/cancelled` 明确标为非成功业务状态。意外异常清理后抛出脱敏 Error，由 Pi 标为错误，不要求这条异常路径必有 details。不得修改其他工具结果。[工具错误语义][pi-extensions]
- 在真实工具事件中验收 `tool_execution_start/update/end` 的关联、错误标记和 `get_messages` 中的结果；只直接调用 execute 的单测不够。

注册工具不等于 RPC 能直接调用工具。0.82.0 只能通过 prompt 让模型产生工具调用；确定性的自动测试应使用固定响应的本地假模型，通过真实 Pi agent 调度工具。

## 9. 认证与秘密存储

更正：`CredentialStore` 是 pi-ai 的公开接口，但 Pi 0.82.0 包根 **不导出 AuthStorage 或 FileAuthStorageBackend**。不能从私有路径导入它们。实现采用集中管理的 CredentialStore 适配器、共享文件锁和原子替换。**ExtensionContext 没有 authStorage 或 modelRuntime 属性**，不能虚构 `ctx.authStorage.login`。

实际接入使用公开 `pi-ai.createModels({credentials})` 和 Provider OAuth 接口。注册到 Pi 的 Provider 每次通过共享认证服务读取最新凭据，不依赖另一份旧快照；通过 `pi.registerProvider/unregisterProvider` 和 `ctx.modelRegistry.refresh()` 同步模型。首次认证后不重启即可发现、枚举并发起本地模型请求已单独测试。状态查询不执行凭据命令、不输出凭据原值。[Models][pi-models]

配置持久化继续兼容 Pi 所需的 models.json 结构；插件附加的 OAuth 选择/文件引用属于存储适配器的数据，宿主不会读取。新秘密统一放认证存储或受控秘密存储；不把完整 ProviderConfig 作为工具结果或 RPC 数据输出。现存配置的转换须作为显式、可预览的一次操作，禁止启动自动改写。无需维护旧私有格式的长期双读逻辑。

认证适配器还需满足：

- 用 Pi 自带 OAuth 实现的 login、refresh、toAuth，不复制供应商认证协议；文件型 OAuth 使用受控 CredentialStore 适配器，刷新时串行写入，保留同文件其他对象。
- 外部文件刷新会写回该文件，界面须在选择此模式时说明；无写权限时报告失败，不偷偷转存或继续用过期凭据。
- 模型工具只使用已授权且与目的地绑定的凭据引用。改名、端点/API/OAuth 切换不能把已有 token 发送给未获用户确认的服务。
- 注销供应商与清除认证是两件独立操作；默认保留已有行为，用户清除认证时使用公开存储删除接口。
- 不输出原始认证错误、环境变量内容、绝对凭据文件路径、请求 header 或授权响应；测试用哨兵字符串覆盖普通日志、RPC、工具结果、会话和导出文件。
- Pi 已有 RPC 的 `get_available_models/get_state` 可能带 Model 数据，因此注册到 Pi 的 Model 也不能内嵌秘密 headers 或含秘密 URL。敏感请求信息必须在服务端认证解析时注入，不能只在插件自己的 DTO 中脱敏。

## 10. 实施顺序与交付边界

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 0：评审 | 确认程序接口边界、通用协议补充路径及第 12 节事项 | 需求冻结；尚不改业务代码 |
| 1：操作与服务 | 数据 schema、草稿、校验、存储、认证、发现、取消；建立公开操作定义 | 服务测试通过，无 TUI/ctx.ui/LLM 依赖 |
| 2：标准终端 | 重写 `/provider-setup`，删除 WizardState 业务依赖和自动保存 | 真实终端完成操作、取消与错误流程 |
| 3：通用 RPC 能力 | 在 Pi 上游或通用桥加入操作注册/枚举/调用/状态/取消；本插件按通用规范注册 | 客户端直接调用全部必需管理操作，无终端命令和弹窗驱动 |
| 4：模型工具 | 注册适合模型的操作子集、工具侧确认、结果过滤和错误标记 | 假模型通过真实 agent 调度，业务结果与 RPC/终端一致 |
| 5：通用宿主验证 | 用操作目录、schema 和任务接口接一个通用原生测试宿主及第二个无关扩展 | 不写插件名称分支；字段、选项、状态、操作和认证可适配 |
| 6：清理与发布准备 | 删除旧向导/无调用代码；更新 README、peer 范围和包文件清单 | 文档准确描述程序接口及实际支持版本，包包含全部运行模块 |

阶段 1–2 和 4 可以独立改善终端和工具，但**没有阶段 3 就没有完成管理 RPC**。UI 请求转发不另算“基础 RPC 管理支持”。没有上游/通用桥支持时明确标记 RPC 尚未实现，不能用 prompt、弹窗或模型调用降级充数。完整目标还需阶段 5 验证可被通用宿主适配。

## 11. 可复现验收

以下测试命令名与 fixture 目录是**实施交付要求，目前尚不存在**。必须与实现一起提供，不能把本次文档核对算作这些测试已经通过。

### 11.1 统一环境

- CI 使用固定 Pi 0.82.0 作为当前能力基线、与锁文件一致的依赖和 Node >=22.19；通用 RPC 实现还须固定其上游补充提交或通用桥版本；升级 Pi 时重新核对类型、行为和 RPC 记录，并更新版本矩阵。当前 peer `*` 改为实际验收范围。
- 每个测试进程都使用临时 HOME、PI_CODING_AGENT_DIR、工作目录和最小环境变量集合。关闭自动发现 extensions/skills/prompts/themes，显式 `-e` 加载本插件；不能读取开发者真实 auth.json、models.json 或凭据环境变量。
- 提供 HTTP fixture：成功返回两个模型、重复 ID、无模型、401/403/429/500、无效 JSON、延迟及连接失败；models.dev 使用 fixture，不依赖实时数据。
- 提供假 OAuth Provider：选择登录方式、secret、auth_url、device_code、manual_code、自动回调赢/手动输入赢、refresh 成功/失败/取消。全部使用假值；真实各 OAuth 实现的远程可行性另记兼容表，不把假流程通过当作所有供应商通过。
- 提供含完整预设、模型 api/baseUrl/headers/compat、tiers 价格、无认证、认证引用及其他供应商/根字段的配置 fixture。记录文件前后散列、运行时模型结果与脱敏事件。

### 11.2 验收用例与失败判据

| 编号 | 用例 | 必须观察到的结果 |
| --- | --- | --- |
| B01 | 新建、修改、改名、删除供应商；目标 ID/凭据冲突 | 仅目标记录变化；冲突不写入；注销后旧自定义模型不再可选 |
| B02 | 发现、元数据补齐、过滤、全选、手动添加、取消选择、预设 | 来源正确；建议不被当作实际可用；过滤不丢隐藏选择；未选候选不落盘；预设保留模型 ID 与完整字段 |
| B03 | 数字/枚举/JSON/header 校验失败，修正后保存 | 精确字段错误；错误期间文件不变；修正后跨入口读取一致 |
| B04 | 读取损坏文件、写权限不足、并发保存、运行时注册失败 | 不覆盖空配置、不损失其他字段；分别报告配置和注册结果，可重试同步 |
| B05 | 操作超时、关闭界面、会话切换、进程 stdin 关闭、迟到响应 | 网络/轮询停止；取消前未提交则文件不变；迟到结果不覆盖新草稿；所有等待能结束 |
| B06 | 提交过程中取消、认证已存后取消草稿、改名中途失败 | effects 与真实文件一致；不虚报撤销；保留可恢复的认证绑定 |
| T01 | 在真实 PTY 启动 Pi，走新增→发现→编辑→保存→重新进入→改名→删除 | 使用公开命令及标准 UI 完成；断言文件、Pi 注册模型和用户可见结果，不直接改 WizardState |
| T02 | 终端取消输入/发现/OAuth，JSON 编辑错误后修正 | 所有返回路径可用、无晚到写入；原有必要字段均可编辑 |
| R01 | 分别启动原生 0.82.0 和实现通用操作协议的真实 Pi RPC/通用桥 | 原生版本明确报告缺少能力；新版本用操作枚举→直接调用→结果完成无认证供应商全流程，捕获 JSONL |
| R02 | 直接 RPC 创建/修改/改名/删除、发现/选模/配置提交，再调用 get_available_models/set_model | 每项请求有结构化结果；文件和注册一致；先切走再删当前模型；整个流程无 prompt、ctx.ui 或 LLM 请求 |
| R03 | 查询任务、订阅事件、并发操作、重复请求、过期 revision、断线重连 | requestId/operationId/sequence 各自正确；结果可查询；不重复写入，不覆盖另一草稿 |
| R04 | 对发现、认证和排队写入发 cancel_extension_operation；另测已有 abort | 按 operationId 停止对应工作并返回确定终态，不借助取消对话框；提交临界区结果如实报告 |
| R05 | 客户端主动 auth.begin，收到有类型的用户动作，再 respond/query/cancel | 普通查询/发现不隐式弹出登录；设备码/回填按实现支持；仅 localhost 回调明确不支持；服务端不调用 open |
| G01 | 假模型按固定次序产生读、发现、创建、修改、选模、删除工具调用 | 真实 agent 发 tool_execution 事件，参数通过 Pi schema 校验；结果与标准命令一致 |
| G02 | 工具写入确认取消、无 UI、认证不足、执行 signal 取消、业务错误 | 不授权不写入；给结构化状态；失败有正确 isError；并发工具不覆盖配置 |
| G03 | 将哨兵秘密放在 key、OAuth、headers、URL、错误响应中 | 工具 content/details/update、普通日志、会话、RPC 模型枚举和导出均不出现秘密；用户主动提交秘密的保密通道单独排除并验证不记录 |
| N01 | 仅消费操作目录、输入/结果 schema、草稿安全值、选项和 availableActions 的通用原生测试宿主 | 客户端自行组织界面；不读私有状态、不解析标签、不发送按键；按操作 ID 完成管理 |
| N02 | 数字/多选/对象/secret/字段错误/任务状态/取消/认证结束/重复响应 | 所有数据有类型；客户端自行展示；秘密无预填；认证结束使旧 interaction 失效 |
| N03 | 同宿主加载第二个不同业务扩展，另测不支持新协议的 Pi | 同一操作适配代码可用，无插件名称分支；旧 Pi 明确不支持，不退回终端向导 |

### 11.3 实施时必须提供的运行入口和证据

拟新增 `test:service`、`test:tui`、`test:rpc`、`test:tools`、`test:host-contract` 脚本，分别运行 B、T、R、G、N 组。现有 `test/typecheck/pack:check` 继续作为基础检查；包检查要断言新增运行模块被包含，不能仅看到 npm pack 退出 0。

RPC 测试须启动真实子进程、使用 LF JSONL、同时收发，按 id/operationId 分开处理调用响应、状态事件与认证动作；不得用模拟服务、ctx.ui、命令文本或模型工具替代 R 组。工具测试须走 Pi agent 和本地假模型；可以用 SDK 注入模型或本地固定 LLM 响应服务，不访问真实付费模型。

每次验收输出版本、用例、预期/实际、脱敏 transcript、配置差异和运行时模型快照。R 组的新协议用例和 N 组未有上游/通用桥时标 `blocked: upstream capability missing`，不得写 passed。完整交付要求 B/T/R/G/N 全部满足对应范围。

## 12. 评审待决定事项

RPC 作为客户端直接调用的程序接口已经确定，不再作为待选方向。需要决定的是实现依赖与入口策略：

| 问题 | 建议选择 | 对范围的影响 |
| --- | --- | --- |
| 通用操作注册与 RPC 在哪里实现 | 优先 Pi 上游；若需要先落地，由独立通用桥提供同一扩展注册规范 | 必须安排这项实现，单改插件无法让原生 0.82.0 获得管理 RPC；不修改 Pixle 专用逻辑 |
| 是否分阶段交付 | 可以先交付共享服务、终端和工具；RPC 以程序接口验收独立完成 | 前几项通过时仍明确 RPC 未完成，不能以交互转发替代 |
| 自动保存是否移除 | 统一显式保存 | 改变当前终端习惯，但令取消、冲突和 RPC 提交行为一致 |
| 模型工具的写入权限 | 首期用户确认，模型参数不能自授予；可信用户客户端直接 RPC 提交不额外弹框 | 工具与 RPC 来源不同，业务校验和持久化仍共用 |
| 终端新秘密是否强制隐藏 | 已有秘密绝不回填；新输入优先已有引用，普通输入的可见性明确告知 | 若强制隐藏，需补标准秘密输入能力；RPC 用用户专用 writeOnly 参数，不依赖终端输入 |
| 删除是否清凭据 | 默认保留，独立 auth.clear 用户操作 | 保留当前删除语义 |
| 外部文件与无入口代码 | 保留服务端 OAuth JSON 模式；健康检查/聊天测试/原始导入导出不进首期工具 | 不扩大首期用户流程和可能计费的操作范围 |

[pi-ext-types]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/extensions/types.ts
[pi-rpc-types]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/modes/rpc/rpc-types.ts
[pi-rpc-mode]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/modes/rpc/rpc-mode.ts
[pi-auth-types]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/ai/src/auth/types.ts
[pi-models]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/ai/src/models.ts
[pi-auth-storage]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/auth-storage.ts
[pi-extensions]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md
