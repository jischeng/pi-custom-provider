# 实现和验证记录

2026-09-21。基线为 Pi 0.82.0 / TypeBox 1.3.8，包中的 peer dependencies 已固定。原始设计见 [需求](refactor-requirements.md)，可供客户端使用的实际协议见 [RPC v1](rpc.md)。

## 已实现

- `src/domain`：共享配置、模型、草稿和认证操作；严格输入/输出校验；配置版本与草稿版本；文件锁和原子替换；保存与运行时同步分别报告结果。
- `src/ui.ts` 和 `src/ui/`：页面依赖操作接口，原生 SettingsList 负责搜索、滚动、当前值和模型勾选，ExtensionEditorComponent 负责预填编辑，BorderedLoader 负责进度。ctx.ui.custom 仅用于挂载原生组件；没有自绘或按键解析。
- `src/operations`：通用操作注册、描述、去重、任务状态、进度、取消、认证输入和安全错误。每个操作声明成功 data 的 JSON Schema。
- `bin/pi-extension-rpc.mjs` 和 `src/rpc/extension.ts`：启动真实 Pi RPC，通过通用注册器执行扩展操作。原生 RPC 命令仍由 Pi 处理。通用传输代码没有供应商插件导入或插件名称分支。
- `src/tools.ts`：模型可调用的管理子集，修改前使用原生用户确认，错误通过 Pi 的 tool_result 标记。
- `src/oauth.ts` 和 `src/provider-registry.ts`：复用 Pi 公开 OAuth 和 Provider 接口。每次请求读取最新认证，凭据只在请求阶段解析，不进入可枚举的 Model 元数据。

已删除旧 wizard.ts、provider-flow.ts、models-config.ts 及对应旧状态机测试。保留并复用模型发现、元数据匹配和完整 Pi 预设逻辑。

## 与初稿的明确差异

1. 采用仓库内的通用桥，没有修改 Pi 上游。原版 Pi 的 RPC 不会因此增加接口；客户端需要启动桥或实现同等通用宿主。
2. Pi 0.82.0 包根不导出 AuthStorage / FileAuthStorageBackend。使用公开 CredentialStore 接口配合集中式文件适配器，未从私有路径导入认证存储。
3. 供应商改名保留稳定的内部凭据绑定，不复制凭据。改变供应商或模型的目标地址/API 时解除旧绑定和 Header，避免无意沿用旧认证。
4. resultSchema 描述成功 data，execute 返回 data；通用层产生统一结果。认证缺失可成为 requires_user_action 的最终结果，认证输入等待则是没有 result 的中间状态。
5. JSONL 桥不提供网络重连。关闭 stdin 会终止会话，状态不会跨进程恢复；当前进程内支持任务查询及去重。
6. 新增供应商可先保存空模型配置，再配置认证并重新进入发现。Pi 原生 input 不支持密码遮罩；终端明确提示输入可见。未为此实现自定义输入框。
7. 完整 Pi 模型目录测试发现 `thinkingLevelMap.off` 和 OpenRouter Auto Router 的特殊价格值 `-1000000`。schema 原样保留这些 Pi 元数据，未静默改成零。

## 可重复运行的验证

最终复审说明见 [复审记录](deep-review.md)。类型检查、完整测试和 npm 打包内容检查均通过。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack:check
```

测试进程使用临时 HOME、agentDir 和工作目录，并关闭默认扩展、技能、主题等加载；HTTP 服务仅监听本机，OAuth 使用假凭据。测试不会读取个人认证、访问真实模型服务或产生模型费用。终端测试依赖 Python 3 和 PTY。

| 测试 | 已覆盖 |
| --- | --- |
| `tests/service.test.ts` | 增改删和改名、未保存草稿、明确保存、版本冲突、并发写入、坏文件不覆盖、活动模型保护、完整 Pi 预设输出校验、秘密过滤、目标地址变化解除绑定、旧凭据清除、发现取消及迟到结果、请求去重、已保存但同步失败、假 OAuth |
| `tests/rpc.test.ts` | 真实 Pi 子进程、直接管理、发现、保存后模型枚举、set_model、活动模型删除拒绝、任务查询和取消、错误、另一种无关插件；原版 Pi 明确不支持新命令；新认证不重启即用于发现和本地模型推理，RPC 中没有秘密 |
| `tests/auth-rpc.test.ts` | 真实 RPC 上的认证选项 ID、设备码、手动输入、取消、过期响应拒绝和秘密过滤 |
| `tests/tools.test.ts` | 真实 Pi agent 调度工具、错误 isError、拒绝写入、用户确认后写入；使用本地假模型 |
| `tests/tui.test.ts` | 真实 Pi PTY 中使用原生控件完成搜索设置、预填和重复编辑、原地切换、模型勾选、JSON 校验失败、保存、改名、丢弃及确认删除 |

打包检查包含运行所需的新子目录、通用 CLI、协议文档和公开操作类型；不包含旧向导或测试夹具。

## 验证边界

没有修改或运行 Pixle，没有进行 iOS/macOS 原生页面验收，也没有对真实第三方账号执行 OAuth 登录。通用协议已通过真实 Pi 和无关插件验证，但这不等同于原始需求表全部 B/T/R/G/N 用例已经执行。远程 OAuth 浏览器回调是否可用仍取决于 Pi 对应提供方。Pi 原生 editor 没有 AbortSignal 参数，用户可用原生取消键关闭；未添加私有按键或自绘实现。
