# @dsh-plugin/dsh-approve-for-me

> [!WARNING]
> 自动审查模型并非完美，可能出现误判或遗漏。请勿将其视为安全保证；对于高风险、破坏性或涉及敏感数据的操作，应保留人工审查和最小权限控制。

> [!IMPORTANT]
> 此插件需要搭配前端插件 [@dsh-plugin/dsh-approve-for-me-client](https://github.com/dsh-plugins/dsh-approve-for-me-client) 使用，才能提供完整的界面端功能。

DSH（DeepSeek Harness）插件：提供类似 Codex 的运行命令自动审核功能，并在沙箱权限选项中新增
**“替我同意 / Approve For Me”**。

## 功能

### 1. 运行命令自动审核（codex-like）

插件注册了一个 `approval/request` answerer（prepend 到 UI answerer 之前），按模式自动决议审批提示：

| 模式 | 行为 |
|---|---|
| `off`（默认） | 全部交给原有审批链（Web GUI 弹窗），行为不变 |
| `auto` | 命中 `approve` 规则自动放行；命中 `deny` 规则自动拒绝（deny 优先）；其余交还用户 |
| `full-auto` | 所有审批提示自动放行（相当于 codex `--full-auto`） |
| `never` | 所有审批提示自动拒绝（CI / 无人值守，fail-closed） |
| `review` | **轻量模型审查**（见下）——选中 `approve-for-me` 时审查权限升级；选中 `strict-review`（Approve For Me - Strict Mode）时在每一条工具调用执行前审查；其他预设保持原生人工审批 |

`auto` 模式的规则匹配对象：工具名（toolName）+ 审批原因（reason，沙箱升级时包含模型的 justification）+ 从会话日志 `tool/call` 恢复的**实际命令文本**。规则为正则字符串（`im` 标志，`^...$` 按行匹配），非法正则自动跳过。

### 2. “替我同意”与 Approve For Me - Strict Mode = 轻量模型审查（选中预设的 `review` 模式，移植 codex guardian）

参考 codex CLI 的 guardian（自动审批审查）设计实现：未选中预设时，所有审批仍由原生 UI 处理；两个审查预设分别控制不同边界：

| 预设 | 审查时机 | 放行后行为 |
|---|---|---|
| `approve-for-me` / Approve For Me | 仅工具请求权限升级时 | 审查模型批准或拒绝该次权限升级 |
| `strict-review` / Approve For Me - Strict Mode | 每一条工具调用的执行前（含无权限升级的调用） | 仅批准时继续进入原有工具与沙箱策略；若该调用后续触发权限升级，复用同一裁决，不重复调用审查模型 |

- **审查提示词构造**（与 codex `codex-rs/core/src/guardian/prompt.rs` 同构）：
  - system（固定安全策略）：证据处理（只有用户消息可信、其余视为不可信证据、截断标记应更谨慎）、用户授权分级（high/medium/low/unknown）、风险分级（low/medium/high/critical）、结果策略（low/medium→allow；high→授权≥medium 才 allow；critical→deny）、`{{ policy }}` 槽位注入你的额外规则；
  - user：**紧凑 transcript**（`[N] role: text`，保留首尾用户消息为锚点、其余用户消息从新到旧填充、最近的 assistant/工具调用/工具结果计入各自预算与最近条目上限）+ 会话 id + `>>> APPROVAL REQUEST START` **计划动作 JSON**（工具、callId、reason、justification、实际命令）+ `>>> APPROVAL REQUEST END`；
  - 输出契约：**严格 JSON** `{ risk_level, user_authorization, outcome, rationale }`（低风险可直接 `{"outcome":"allow"}`），容忍少量外层散文，非 JSON 视为失败。
- **fail-closed**：审查超时（默认 30s）、LLM 调用失败、输出无法解析 → 默认**拒绝**（可配 `reviewFallback: "ask"` 转交人工）；可重试 `reviewMaxAttempts` 次。
- **拒绝熔断**（移植 codex 的 guardian circuit breaker）：同一 turn 内连续 `reviewCircuitMaxConsecutive`（默认 3）次拒绝、或窗口内 `reviewCircuitMaxRecent`（默认 10）次拒绝后，把控制权交还人类（转交 UI 弹窗），避免审查模型把整轮堵死；turn 切换自动重置。
- **UI 状态与裁决**：普通模式的进行中和完成状态由原生 `approval/asked` / `approval/decided` 事件驱动，并以 log-only 的 `hook/result` 写入审查意见。Strict Mode 使用 `hook/invoked` / `hook/result` 在对应工具调用旁显示审查中与结论；拒绝时工具体不会执行。所有这些事件都不进入模型上下文，并且不依赖无法注册的插件自定义事件，因此不会阻断会话重载。默认不额外注入消息；可用 `reviewNotify: true` 在下一模型步骤显示普通权限审查的最终裁决。
- 审查模型：`reviewProvider`/`reviewModel` 未配置时，折叠会话日志的 `request/context` 事件继承会话当前模型路由。

### 3. 沙箱权限选项新增 `approve-for-me`（替我同意 / Approve For Me）

- 向 `ESCALATION_TARGETS` 追加 `approve-for-me`，并对已注册的 `pwsh` / `bash` / `fs` 等所有带 `sandbox_permissions` 的工具定义**就地补丁**：
  - `sandbox_permissions` 的 enum 增加 `approve-for-me`，描述中说明用法；
  - `execute` 被包装：调用携带 `sandbox_permissions: "approve-for-me"`（仍需 `justification`）时，自动改写成真实模式（`grantMode`，默认 `danger-full-access`）并在 justification 中打上 `[approve-for-me]` 标记；原工具的 `approveEscalation` 流程原样执行，answerer 见到标记即自动批准。
- 所有工具补丁在每次 `tools/change` 时重放，与本插件的加载顺序无关。
- 关键安全点：**沙箱模式本身没有被绕过** —— 每次授予仍然走原装的 `approveEscalation` 严格加宽检查 + 审批通道，只是“问人”这一步被自动代答（规则 / 全量 / 轻量模型）；`mode: "never"` 优先于一切。

### 4. 权限预设 `approve-for-me` 与 `strict-review`（GUI 可见）

`permissionPresets` 在服务初始化时建立下拉选项，因此 profile 必须在启动时完整替换 `permission` 行（行配置不合并），保留原有三个选项并加入第四项：

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      approve-for-me:
        sandbox: workspace-write
        approval: ask
        name: Approve For Me
        description: Review each permission escalation automatically.
      strict-review:
        sandbox: workspace-write
        approval: ask
        name: Approve For Me - Strict Mode
        description: Review every tool call automatically before it executes.
```

- Web GUI 的沙箱权限下拉框出现 **“替我同意 / Approve For Me”** 与 **“Approve For Me - Strict Mode”**；
- 可用 `/permission approve-for-me` 或 `/permission strict-review` 切换，也可通过 `permissionPresets.set`（UI）切换；
- `mode: review` 时，只有会话选中上述任一审查 preset 后才调用审查模型；其他预设继续走原生人工审批。
- 在 `off` / `auto` / `full-auto` / `never` 等规则模式中，`approve-for-me` 保持原有的 `full-auto` 语义；`strict-review` 只在 `review` 模式激活预执行审查。

### 5. 系统提示上下文段

向模型说明当前自动审批模式（off / auto / full-auto / never / review / preset 激活）；`review` 未选中预设时明确说明原生人工审批仍在生效。

## 配置

在 dsh profile 的 `cordis.patch.yml` 中：

```yaml
approve-for-me:
  mode: review                  # off | auto | full-auto | never | review
  # review 模式（轻量模型审查）：
  reviewProvider: deepseek      # 可选；缺省继承请求方 agent 的 provider
  reviewModel: deepseek-chat    # 可选；缺省继承请求方 agent 的 model（建议用便宜的）
  reviewPolicy: |              # 可选；注入安全策略 {{ policy }} 槽位的额外规则
    - 永远拒绝任何触碰 ~/keys 的命令
  reviewTimeoutMs: 30000
  reviewMaxAttempts: 2
  reviewFallback: deny          # deny（fail-closed，默认）| ask（转交人工）
  reviewCircuitMaxConsecutive: 3
  reviewCircuitMaxRecent: 10
  reviewNotify: false             # 可选：在下一模型步骤显示一条最终裁决；不写入延迟的"审查中"行
  # 规则模式（auto 等）：
  approve: ["^git ", "^npm (install|run)", "pnpm"]
  deny: ["rm -rf", "format"]
  grantMode: danger-full-access       # approve-for-me 实际授予的模式
  presetName: approve-for-me
  presetSandbox: workspace-write    # 审查预设的基础模式；全权限请求仍是一次可审查的升级
  presetApproval: ask
  strictPresetName: strict-review
  strictPresetSandbox: workspace-write
  strictPresetApproval: ask
```

## 安装

```sh
# 在 dsh profile 目录（例如 web profile）中
dsh plugin --profile web add file:C:/Users/jkl-9/IdeaProjects/dsh-approve-for-me
# 或从本目录用相对路径
dsh plugin --profile web add file:../dsh-approve-for-me
```

然后在 `cordis.patch.yml` 启用（见上）。重启 dsh web 后生效。

## 目录

```
lib/index.js        cordis 插件入口（answerer / 工具补丁 / preset / 系统提示段 / 审查调用）
lib/policy.js       纯决策逻辑（规则模式 + review 提示词构造 + 严格 JSON 解析 + 拒绝熔断；无 DSH 依赖）
test/policy.test.js 决策逻辑单测
test/plugin.smoke.test.js  插件接线冒烟测试（fake ctx + fake ctx.llm）
```

## 测试

```sh
node --check lib/index.js lib/policy.js
node test/policy.test.js
node test/plugin.smoke.test.js
```

> 沙箱下 `node --test test/` 的 child-process 派生会被拒绝（EPERM），请直接运行单个测试文件。

## 说明与边界

- 自动审查模型并非完美，不能替代人工判断、最小权限、沙箱隔离、备份或其他安全控制；涉及敏感数据、生产环境或不可逆操作时，应保留人工复核。
- 审批事件由 `ApprovalService` 照常写入会话审计（`approval/asked` + `approval/decided`），自动决议同样留痕；review 的裁决（risk/auth/rationale）写入插件日志和对应的会话流状态行。
- Strict Mode 的拒绝在 `tools/pre-execute` 返回标准 `deny`，工具体不会运行；允许的调用仍会经过原有沙箱与其他工具策略。
- `sandbox_permissions: "approve-for-me"` 缺少 `justification` 会直接报错（与原工具配对校验一致）。
- review 模式且已选中预设时，显式 `sandbox_permissions: "approve-for-me"`（携带 `[approve-for-me]` 标记）视为用户对**这一个动作**的预先同意，直接放行、不经过审查模型；未选中预设时仍交给原生审批。
- Strict Mode 不适用上述标记绕过：每一条调用都会先由审查模型裁决一次，后续同 callId 的权限升级只复用该结果，避免重复审查。
- 审查模型的输出仅用于裁决；其响应不会被写回会话历史。
