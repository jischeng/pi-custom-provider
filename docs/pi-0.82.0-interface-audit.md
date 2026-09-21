# Pi 0.82.0 接口核对记录

日期：2026-09-20；2026-09-21 修正认证存储导出结论。对应 [重构需求与方案](refactor-requirements.md)。这是一份现状证据，不是未来重构功能的通过报告。此处演示的 UI 转发只用于核对 Pi 已有行为，不是面向客户端的管理 RPC 方案；后者须能直接调用业务操作，见主文档第 7 节。

## 1. 版本与公开来源

本仓库核对提交：`e8329fa80cb0d69fbb5478bda0ea50714fd330d0`。

从仓库锁文件确定 Pi 版本为 0.82.0，随后读取 npm 发布信息并下载发布包；没有以全局 Pi 版本或上游 main 推断。npm 包的 gitHead 是 `083e61621276bff9f6faefab87ce07fcd98734e2`，本记录的上游链接都固定到该提交。

| 核对对象 | 公开证据 | 结论 |
| --- | --- | --- |
| 扩展命令、UI、工具、供应商注册 | [extensions/types.ts][ext-types] | 标准 API 存在；UI select 仅 string[]；无 form、保密输入或任意 RPC handler 注册 |
| RPC 命令与 UI 数据 | [rpc-types.ts][rpc-types] | 存在四类交互请求和三种回复；没有 call_tool 或供应商 CRUD |
| RPC 桥的实际实现 | [rpc-mode.ts][rpc-mode] | custom 返回 undefined；signal/timeout 结束等待时不发关闭事件；editor 没有对应取消参数 |
| 扩展命令执行 | [agent-session.ts][session] 的 prompt、_tryExecuteExtensionCommand、abort | 命令优先处理，无需 LLM；命令错误转换成 extension_error；abort 操作 agent，不直接取消独立命令 |
| 认证类型 | [auth/types.ts][auth-types] | AuthPrompt 有 text、secret、select、manual_code；AuthEvent 有 info、auth_url、device_code、progress |
| 标准认证与模型集合 | [models.ts][models] | createModels、Provider、login、getAuth 和 CredentialStore 可复用 |
| 认证文件存储 | [auth-storage.ts][auth-storage] | 内部 AuthStorage 有 read/modify/delete/list，但包根不导出此类，扩展不能直接使用；公开接口是 pi-ai 的 CredentialStore |
| 扩展可见运行时 | [model-registry.ts][registry] | ctx.modelRegistry 可刷新、查询和注册；ctx 不暴露 ModelRuntime/AuthStorage |
| 工具结果语义 | [extensions.md][extensions] 的 Custom Tools | execute 返回 isError 不生效；抛错由 Pi 标错；标准 tool_result 钩子可修订 details/isError |
| 基础 UI 示例 | [rpc-demo.ts][demo] | 上游提供标准 input/editor/confirm 演示，可以无 LLM 复现 |

**后续更正：** 之前把源文件导出的 AuthStorage 当成包根公开导出，这是错误的。实现未使用该私有类。后续重构的测试记录见 [实现记录](implementation.md)。

核对时还查看了发布包 `dist/core/model-runtime.js`、`runtime-credentials.js` 与 `models.js`：分别创建的 AuthStorage 实例可能持有各自的内存快照，不能假定写入 auth.json 后运行时就自动看到新凭据。`modelRegistry.refresh()` 的公开用途是刷新模型配置，也不能当成凭据存储 reload 的保证。重构必须验证“首次认证 → 不重启 Pi → 发现/选模/请求”这一完整链路。

## 2. RPC 命令完整枚举

以下是 0.82.0 RpcCommand 联合类型中的命令。对本项目无关的命令不另造管理用途。

| 类别 | 命令 |
| --- | --- |
| 提示与中断 | prompt、steer、follow_up、abort |
| 状态与消息 | get_state、get_messages |
| 模型 | set_model、cycle_model、get_available_models |
| 思考等级 | set_thinking_level、cycle_thinking_level、get_available_thinking_levels |
| 队列 | set_steering_mode、set_follow_up_mode |
| 压缩 | compact、set_auto_compaction |
| 重试 | set_auto_retry、abort_retry |
| Shell | bash、abort_bash |
| 会话 | new_session、get_session_stats、export_html、switch_session、fork、clone、get_fork_messages、get_entries、get_tree、get_last_assistant_text、set_session_name |
| 命令发现 | get_commands |

`extension_ui_response` 是单独处理的 UI 子协议，不是上述命令之一。标准命令 response 通过可选 id 关联；UI request 的 id 是 Pi 另行生成的 ID，不等于 prompt id，也没有 workflowId 字段。

## 3. 本次实际执行与观察

环境：Node `24.12.0`；临时目录安装 `@earendil-works/pi-coding-agent@0.82.0`，npm ls 确认其 pi-ai/pi-agent-core/pi-tui 均为 0.82.0。禁用安装脚本。运行时使用空 HOME、PI_CODING_AGENT_DIR、工作目录和仅含 PATH/HOME/PI_CODING_AGENT_DIR/LANG/TERM 的环境。关闭自动资源发现和工具，显式加载当前插件与上游 rpc-demo。没有调用真实模型或认证服务，进程退出码 0，stderr 为空。

| 检查 | 观察结果 | 能证明什么 |
| --- | --- | --- |
| get_commands | 包含 provider-setup | 当前插件已被加载并注册命令 |
| prompt /provider-setup | 先 notify `TUI only`，后 prompt success true | RPC 入口被拒绝；成功响应不等于业务成功 |
| prompt /rpc-input | 得到标准 input 请求 | 上游标准输入可走真实 RPC |
| 等待 input 时发 abort | abort success true；随后原 input 仍接收 fixture-value 并完成 | abort 不自动取消这一独立命令等待 |
| prompt /rpc-editor 后 cancelled | editor 请求携带 prefill；返回取消通知及 prompt success | 多行编辑可传输，客户端取消路径可用 |
| new_session 后 confirmed false | confirm 请求；new_session 返回 data.cancelled true | 确认回复会影响对应的会话操作 |

实际 transcript 的关键部分如下，随机 UI UUID 仅在这里替换为短名，其他字段保留。IN 表示发给 Pi，OUT 表示从 stdout 读到。

```text
IN  {"id":"setup","type":"prompt","message":"/provider-setup"}
OUT {"type":"extension_ui_request","id":"u1","method":"notify","message":"TUI only","notifyType":"error"}
OUT {"id":"setup","type":"response","command":"prompt","success":true}

IN  {"id":"input","type":"prompt","message":"/rpc-input"}
OUT {"type":"extension_ui_request","id":"u2","method":"input","title":"Enter a value","placeholder":"type something..."}
IN  {"id":"abort","type":"abort"}
OUT {"id":"abort","type":"response","command":"abort","success":true}
IN  {"type":"extension_ui_response","id":"u2","value":"fixture-value"}
OUT {"type":"extension_ui_request","id":"u3","method":"notify","message":"You entered: fixture-value","notifyType":"info"}
OUT {"id":"input","type":"response","command":"prompt","success":true}

IN  {"id":"new","type":"new_session"}
OUT {"type":"extension_ui_request","id":"u4","method":"confirm","title":"Clear session?","message":"All messages will be lost."}
IN  {"type":"extension_ui_response","id":"u4","confirmed":false}
OUT {"type":"extension_ui_request","id":"u5","method":"notify","message":"Clear cancelled","notifyType":"info"}
OUT {"id":"new","type":"response","command":"new_session","success":true,"data":{"cancelled":true}}
```

没有把 select、custom、tool_result 或 OAuth 的静态源码核对写成已执行的运行测试。本次未运行重构后的功能，它们仍以需求文档验收项为准。

## 4. 复现方式

在本仓库根目录执行准备命令。此过程只在临时目录下载公开依赖，运行时不继承真实凭据环境变量。

```sh
export PI_AUDIT_REPO="$PWD"
export PI_AUDIT_DIR="$(mktemp -d /tmp/pi-provider-audit.XXXXXX)"
npm view @earendil-works/pi-coding-agent@0.82.0 dist.tarball gitHead repository --json
npm install --prefix "$PI_AUDIT_DIR/runtime" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.82.0
npm ls --prefix "$PI_AUDIT_DIR/runtime" @earendil-works/pi-ai @earendil-works/pi-agent-core @earendil-works/pi-tui
```

然后执行下面的标准输入/输出探测。Python 使用 LF 读取 JSONL；等待过程中继续处理 stdout，不将命令响应和 UI 请求串行堵塞。仅使用 fixture-value 假输入。

```sh
python3 - <<'PY'
import json, os, pathlib, selectors, subprocess, time

root = pathlib.Path(os.environ['PI_AUDIT_DIR'])
repo = pathlib.Path(os.environ['PI_AUDIT_REPO'])
pkg = root / 'runtime/node_modules/@earendil-works/pi-coding-agent'
for name in ('home', 'agent', 'cwd'):
    (root / name).mkdir(exist_ok=True)
env = {
    'PATH': os.environ['PATH'], 'HOME': str(root / 'home'),
    'PI_CODING_AGENT_DIR': str(root / 'agent'),
    'LANG': 'en_US.UTF-8', 'TERM': 'dumb',
}
args = [
    'node', str(pkg / 'dist/cli.js'), '--mode', 'rpc', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-themes', '--no-tools', '-e', str(repo / 'src/index.ts'),
    '-e', str(pkg / 'examples/extensions/rpc-demo.ts'),
]
p = subprocess.Popen(args, cwd=root / 'cwd', env=env,
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE)
sel = selectors.DefaultSelector()
sel.register(p.stdout, selectors.EVENT_READ)
buf = b''

def send(value):
    print('IN ', json.dumps(value))
    p.stdin.write((json.dumps(value) + '\n').encode())
    p.stdin.flush()

def until(predicate):
    global buf
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            if not line:
                continue
            value = json.loads(line)
            print('OUT', json.dumps(value))
            if predicate(value):
                return value
        elif sel.select(0.2):
            data = os.read(p.stdout.fileno(), 65536)
            if not data:
                raise RuntimeError('Pi closed stdout')
            buf += data
    raise TimeoutError('No matching event in 30 seconds')

def response(request_id):
    return until(lambda v: v.get('type') == 'response'
                 and v.get('id') == request_id)

try:
    send({'id': 'commands', 'type': 'get_commands'})
    result = response('commands')
    assert any(c['name'] == 'provider-setup'
               for c in result['data']['commands'])
    send({'id': 'setup', 'type': 'prompt', 'message': '/provider-setup'})
    response('setup')
    send({'id': 'input', 'type': 'prompt', 'message': '/rpc-input'})
    ui = until(lambda v: v.get('method') == 'input')
    send({'id': 'abort', 'type': 'abort'})
    response('abort')
    send({'type': 'extension_ui_response', 'id': ui['id'],
          'value': 'fixture-value'})
    response('input')
    send({'id': 'editor', 'type': 'prompt', 'message': '/rpc-editor'})
    ui = until(lambda v: v.get('method') == 'editor')
    send({'type': 'extension_ui_response', 'id': ui['id'],
          'cancelled': True})
    response('editor')
    send({'id': 'new', 'type': 'new_session'})
    ui = until(lambda v: v.get('method') == 'confirm')
    send({'type': 'extension_ui_response', 'id': ui['id'],
          'confirmed': False})
    assert response('new')['data']['cancelled'] is True
finally:
    p.stdin.close()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.terminate()
        p.wait(timeout=5)
    sel.close()
    print('exit:', p.returncode)
    print('stderr:', p.stderr.read().decode())
PY
```

若后续实现改变 `/provider-setup`，本记录的旧行为不再是通过条件；它只用于原始提交的基线复现。新的管理 RPC 测试必须按主文档直接调用通用业务操作，不能复用此处的命令加对话框流程来宣称管理 RPC 已实现。

[ext-types]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/extensions/types.ts
[rpc-types]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/modes/rpc/rpc-types.ts
[rpc-mode]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/modes/rpc/rpc-mode.ts
[session]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts
[auth-types]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/ai/src/auth/types.ts
[models]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/ai/src/models.ts
[auth-storage]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/auth-storage.ts
[registry]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/model-registry.ts
[extensions]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md
[demo]: https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/examples/extensions/rpc-demo.ts
