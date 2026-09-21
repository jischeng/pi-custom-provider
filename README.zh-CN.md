# pi-custom-provider

[English](README.md) · 中文

为 Pi 0.85.1 管理自定义供应商、模型和认证。终端、RPC 客户端和模型工具共用同一套业务逻辑。

## 终端使用

在仓库中运行：

```bash
pnpm install --frozen-lockfile
pnpm exec pi -e ./src/index.ts
```

进入 Pi 后执行 `/provider-setup`。界面使用英文。设置和模型选择复用 Pi 的 `SettingsList`，可直接搜索、查看当前值和切换选项；预填编辑使用 `ExtensionEditorComponent`，进度使用 `BorderedLoader`。`ctx.ui.custom` 仅挂载这些原生组件，没有自绘或自定义按键处理。

进入已有供应商会直接列出模型，选中模型即可编辑。页头显示当前供应商，列表按模型 ID 区分同名模型。模型页只保留模型、`Add model…` 和 `Provider actions…`；发现模型、选择模型、供应商设置、认证、保存、丢弃和删除都在单独的操作菜单里。导航项不再附带 context、候选数或认证状态摘要。

1. 新增供应商，填写 API 类型、接口地址、ID 和认证方式。
2. 添加模型，或先保存供应商，再从 `Credentials`设置 API Key、登录 OAuth 或导入 OAuth JSON。
3. 编辑配置并发现模型。候选区支持原生搜索、滚动和逐项勾选，模型 ID 始终可见。
4. 编辑模型字段、应用 Pi 模型预设，然后明确选择 `Save changes`。丢弃草稿不会保存修改。
5. 在 Pi 的模型选择器中选择模型。

支持显示名称、改名、模型增删、价格及价格分档、思考等级、兼容配置，以及供应商和模型的请求 Header。可清除可选字段。保存后立即同步到 Pi；当前对话正在使用的供应商不能改名、删除或移除当前模型。

认证输入使用 Pi 原生输入框，输入内容可见，界面会明确提示。已存凭据不会回填。服务端 OAuth 文件引用的自动刷新会写回该文件；重新登录、导入或清除后会移除旧引用。更换接口地址、API 或认证方式会解除旧凭据和 Header 的关联，需要重新配置。

## 给客户端适配的 RPC

仓库中启动：

```bash
pnpm rpc --no-session
```

也可直接运行，参数不需要额外的 `--`：

```bash
node bin/pi-extension-rpc.mjs -e ./src/index.ts --no-session
```

包中的通用可执行文件名为 `pi-extension-rpc`。它启动真正的 Pi RPC 子进程，保留原有命令，并增加通用扩展操作接口。**原版 `pi --mode rpc` 不包含这些新增命令。**

客户端先发送：

```json
{"id":"catalog","type":"get_extension_operations"}
```

再根据返回的操作名及 JSON Schema 直接调用，例如：

```json
{"id":"list","type":"invoke_extension_operation","operation":"provider-manager/provider.list","arguments":{"limit":50},"requestId":"list-1"}
```

调用返回任务 ID，后续事件返回结构化结果；也可查询、取消和提交必要的认证输入。普通管理操作不执行终端向导，不发送 select/input 弹窗，也不调用模型。其他插件可通过同一注册机制公开操作，传输代码不识别供应商插件名称。

完整请求、响应、注册示例及客户端约定见 [RPC 协议](docs/rpc.md)。

## 模型工具

模型可查询供应商、查看目录、发现和推荐模型。新增、修改、删除、保存模型需要用户通过 Pi 原生确认框确认；无 UI 时返回 `requires_user_action`。工具不提供密钥写入、OAuth 登录、Header 写入或用户草稿修改。

所有入口都有版本校验、明确错误和取消状态。配置通过文件锁与原子替换保存；运行时同步失败会如实返回“配置已保存、同步失败”，可调用 `runtime.sync` 重试。删除供应商默认保留凭据。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm pack:check
```

测试使用临时目录、真实 Pi 0.85.1 子进程、本地 HTTP 服务和假 OAuth，不读取个人配置。终端测试需要 Python 3 和支持 PTY 的系统。

- [实现及验证记录](docs/implementation.md)
- [原始需求与设计](docs/refactor-requirements.md)
- [Pi 0.85.1 接口核对及更正](docs/pi-0.85.1-interface-audit.md)

未修改 Pi 上游或 Pixle，尚未对接实际原生客户端；客户端可以按公开协议独立适配。

界面只依赖操作描述和结果，不引用业务服务或配置存储；RPC、TUI 和模型工具复用同一组业务操作。详见[重构说明](docs/tui-refactor.md)。
