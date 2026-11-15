# NPi 插件化开发方案

> 状态：2026-11-15。S1 已实现并验证（`kernel.2.1.3-universal` 与 Desktop `3.1.0.105` 工作区）；S2–S4、官方插件目录与 Desktop 插件面板未实施。适用于 `kernel.2.1.3-universal` 之后的新功能。

## 1. 目标与边界

- **现有代码不动。** 已经写进内核和 Desktop 的 NPi 功能（Remote Connect、`/rc`、SideAgent、Office、Generative UI、按块审批、用量减负、账号管理等）保持原样，不做迁移。
- **之后的新功能默认写成插件。** 只有插件确实做不到的部分才改内核，而且改法是「加一个通用扩展点」，不是把功能本身写进内核。
- **为什么这样做：** NPi 内核与上游 oh-my-pi 没有共同的 git 历史，上游更新只能逐个提交挑选移植。按 2026-11-15 的统计，NPi 相对上游基线 `6a86df8539` 改了 541 个上游源码文件（+10.5k / −2.5k 行），新增 80 个源码文件（+15.6k 行）。新功能如果继续改上游文件，每次移植的冲突面都会继续扩大；写成插件则只新增文件。

## 2. 现有能力（不改内核即可使用）

| 能力 | 位置 | 说明 |
|---|---|---|
| Extension API | `docs/extensions.md`、`src/extensibility/extensions/types.ts` | 一个导出工厂函数的 TS/JS 模块。可注册：模型可调用的工具、斜杠命令、快捷键、命令行参数（`registerFlag`）、消息/思考/正文渲染器、模型提供方（`registerProvider`）、链接协议、输入框形态；可订阅约 50 个事件（会话、轮次、消息、工具调用前后可拦截与改写、审批、provider 请求前后、子 Agent、目标、模式切换等）；可执行动作（发消息、换模型、切换启用工具、`exec`、临时对话 `runEphemeralTurn`、后台定时器） |
| 插件包 | `src/extensibility/plugins/`、`docs/plugin-manager-installer-plumbing.md` | 普通 npm 包，`package.json` 的 `omp` 字段（或旧的 `pi`）声明 `extensions`、`tools`、`hooks`、`commands`、可单独开关的 `features`、插件设置项 `settings`；包内还可带 skills、rules、prompts、`.mcp.json`；`npi plugin install` 安装，支持 git、本地目录、市场 |
| 编译后的二进制加载外部插件 | `src/extensibility/plugins/legacy-pi-compat.ts` | 编译版内核在运行时加载外部扩展时，`@oh-my-pi/*` 由二进制内置的虚拟模块提供，插件可直接 `import` 内核 API |
| 指定插件路径 | `-e <插件包目录或其父目录>`（父目录会向下扫描一层，读子目录 `package.json#omp.extensions`）；`--plugin-dir` 只认 Claude 插件格式 | Desktop 用 `-e Resources/plugins` 加载官方插件 |
| 扩展 → Desktop 界面 | RPC `extension_ui_request`：`select` / `confirm` / `input` / `editor` / `notify` / `setStatus` / `setWidget` / `setTitle` | Desktop 已把 `setStatus` / `setWidget` 渲染成侧栏卡片（`desktop/docs/architecture/extension-widgets.md`） |
| Desktop → 内核工具 | RPC `set_host_tools` | Desktop 提供的工具由模型调用、在 Desktop 执行 |
| 富界面 | Generative UI（`ui.present`） | 卡片、表单、表格、建议，原地更新 |

**现有能力的边界：** Extension API 的作用范围是单个会话，扩展在创建会话时才加载。以下几类它够不着，需要第 3 节的扩展点：

1. 命令行子命令（如 `npi remote`）——在 `src/cli-commands.ts` 的静态表里；
2. 在创建会话之前接管进程的运行模式（如 `--side-agent`）；
3. Desktop / 手机端需要的新 RPC 命令和事件；
4. 认证、provider 内部和 TUI 布局——这类改动不做成插件（见第 7 节）。

## 3. 需要新增的扩展点

每个扩展点都写成与 NPi 业务无关的通用形式，尽量小，必要时可提交给上游。

### S1. RPC 命令与事件（已实现）

**用法（插件作者）：**

```ts
export default function (pi: ExtensionAPI) {
	pi.registerRpcCommand("my-plugin/greet", {
		handler: (params, ctx) => {
			ctx.ui.emitEvent?.("my-plugin/greeted", { at: Date.now() }); // 推给 RPC 宿主；TUI 下不存在
			return { message: "hi" };                                   // 作为 response.data.result
		},
	});
}
```

宿主发 `{ id, type: "extension_command", name: "my-plugin/greet", params }`；处理函数抛错回 `success: false` 和错误信息；没有插件提供的名字回 `code: "unsupported"`；名字不符合 `<plugin>/<command>` 时注册直接抛错。同名时后加载的插件生效（与斜杠命令一致）。Desktop 前端：`OMP_BRIDGE.extensionCommand(name, params)` 返回 `result`，`OMP_BRIDGE.onExtensionEvent(cb)` 订阅当前标签页的事件（后台标签页的事件不转发）。

**实现：** `extensions/types.ts`（`registerRpcCommand`、`RegisteredRpcCommand`、`ExtensionUIContext.emitEvent?`，`Extension.rpcCommands` 为可选以免改动手工构造扩展记录的上游测试）、`loader.ts`、`runner.ts`（`getRpcCommand`）、`rpc-mode.ts`、`rpc-types.ts`、wire（`gen:rpc` 同步重新生成 TS/JSON schema 与 Python/Rust/Go SDK）；Desktop `agent/mod.rs` 白名单、`live.js`。测试 `test/rpc-extension-command.test.ts`。

**验证（2026-11-15）：** 临时 hello-world 插件（npm 包形式，`package.json#omp.extensions`，放在插件父目录下用 `-e <父目录>` 加载；运行时 `import` 了 `@oh-my-pi/pi-utils`）分别用源码和**编译后的二进制**运行：RPC 就绪（二进制 391ms）、命令返回结果、事件先于应答送达、插件注册的 `/hello` 斜杠命令可用且不调用模型；插件位于仓库之外仍能解析内核包。验证后已删除。

---

以下为原设计草案：

**用途：** 新功能需要 Desktop 或手机端发命令、收数据时，由插件提供，不再改 `rpc-mode.ts` 和 RPC 协议定义。

**接口草案（Extension API 新增）：**

```ts
pi.registerRpcCommand("office.report", {
	params: schema,                       // 入参校验
	handler: async (params, ctx) => result, // 返回值作为 response.data
});
pi.emitRpcEvent("office.progress", data); // 推给 RPC 客户端
```

**线上格式：**

- 命令：`{ id, type: "extension_command", name: "<plugin>/<command>", params }` → `{ id, type: "response", command: "extension_command", success, data | error }`
- 事件：`{ type: "extension_event", name: "<plugin>/<event>", data }`
- 名字强制带插件前缀，避免冲突；未注册的命令回 `unsupported`。

**改动位置：** `extensions/types.ts`（API）、`extensions/runner.ts`（注册表）、`rpc-mode.ts`（新增两种帧的分发，约几十行）、`rpc-types.ts` 与 wire 定义（`gen:rpc` 重新生成）。Desktop：`agent/mod.rs` 的 `ALLOWED_COMMAND_TYPES` 放行 `extension_command`；前端按 `name` 分发给对应插件界面。估计内核 400–600 行（含测试），Desktop 100–200 行。

**`/rc` 与手机端：** 守护进程的会话指令白名单（`REMOTE_ALLOWED_SESSION_COMMANDS`）默认不放行 `extension_command`；插件需在清单中声明哪些命令允许远程调用。

### S2. 命令行子命令

**用途：** 插件提供 `npi <子命令>`。

**接口草案：** 清单字段 `omp.cli: [{ name, entry, help }]`，`entry` 默认导出与 `CommandEntry.load` 相同的命令对象。

**改动位置：** `cli-commands.ts` 在匹配内置命令失败、转交 `launch` 之前，读取已安装插件的清单（只解析 `package.json`，不执行插件代码）查找子命令，命中则懒加载。内置命令名不可被覆盖。估计 150–250 行。

### S3. 启动模式

**用途：** 在创建会话之前接管进程（例如另一种 RPC 后端，SideAgent 就属于这一类）。

**接口草案：** 清单字段 `omp.modes: [{ flag: "--side-agent", entry }]`；`entry` 导出 `run({ argv, cwd, approvalMode, rpcInput, stdout })`。

**改动位置：** `main.ts` 在认领 RPC stdin 之后（现在 `--side-agent` 分流的位置）检查参数是否命中插件声明的模式；`flag-tables.ts` 需要允许插件声明的参数。只读清单，命中后才加载代码。估计 150–250 行。

### S4. TUI 区块（暂缓）

侧边面板区块、状态栏片段等。现有 `registerMessageRenderer`、`registerComposerShape` 已覆盖一部分；等到确有需求再设计。

## 4. 官方插件的组织与分发

- **源码位置：** NPi-Kernel 仓库新建顶层目录 `npi-plugins/<name>/`，与上游的 `packages/` 分开，移植上游时不会冲突。每个插件是一个独立的包，`package.json` 带 `omp` 清单（注意：不是 `npi`，插件管理器读的是 `omp`/`pi`），包名 `@npi/plugin-<name>`。
- **依赖内核：** 只通过 `@oh-my-pi/*` 的公开导出与 Extension API 使用内核；不 import 内核的内部文件路径。清单用 `engines.npi` 声明兼容的内核版本范围，加载时校验，不兼容就跳过并给出提示。
- **随 Desktop 分发：** 打包时把官方插件放进 App 资源目录 `Resources/plugins/`，Desktop 启动内核时加 `-e <Resources/plugins>`。插件随 App 版本走，不需要用户安装。
- **命令行用户：** `npi plugin install <git 或路径>` 安装；以后可提供 NPi 自己的插件市场。
- **开关：** 复用插件管理器的启用/禁用与 `features`；Desktop 在设置里列出官方插件并允许关闭。

### `.npix` 安装包（已实现，2026-11-15）

类似 VS Code 的 `.vsix`：一个文件就是一个可离线安装的插件。

- **格式：** 与 `npm pack` 一致的 tar.gz，所有条目在 `package/` 下；`package/package.json` 带 `omp` 清单（`extensions` / `tools` / `hooks` / `commands` / `features` 至少一项，且声明的入口必须存在）；`package/developer.json` 写明开发者（**必填**）：`{ "name": "…", "email"?: "…", "url"?: "https://…", "organization"?: "…" }`，`name` 必填，`url` 只接受 http(s)，各字段不超过 200 字符、不含控制字符。**依赖必须打包在里面**（`node_modules` 或 `bun build` 打成单文件），安装时不联网。
- **命令：** `npi plugin list --json` 的每个 npm 插件额外带 `npix`（是否来自 `.npix`）与 `developer`（插件目录有 `developer.json` 时）；`npi plugin pack [目录] [-o 输出]` 校验并打包（跳过 `.git`、`.DS_Store`、`node_modules/.bin`、已有的 `.npix`，符号链接取实际内容）；`npi plugin inspect <文件>.npix [--json]` 只读查看；`npi plugin install <文件>.npix` 安装；卸载、列表、启用/停用、子功能沿用原有命令。
- **安装位置：** 解压到 `<插件目录>/npix/<包名，/ 换成 __>/<版本>/`（同名旧版本先删除），再用 `PluginManager.link` 链接进 `<插件目录>/node_modules`，所以和本地链接的插件一样被加载。插件目录随 profile 而定。
- **安全检查：** 解压前逐条检查不能有绝对路径或 `..`，所有条目必须在 `package/` 下；解压后发现任何符号链接即拒绝；包名用插件管理器原有的 `validatePackageName` 校验。
- **实现：** `extensibility/plugins/npix.ts`；`cli/plugin-cli.ts` 增加 `pack` / `inspect` 与 `.npix` 安装分支，卸载后删除解压目录；`manager.ts` 仅导出了 `validatePackageName`。测试 `test/plugin-npix.test.ts`。
- **Desktop：** 设置 → Agent → Plugins：列出当前 profile 已安装的插件（名称、版本、来源、开发者、是否停用，`plugins_list` → `npi plugin list --json`），可卸载（两次点击确认，`plugin_uninstall` → `npi plugin uninstall`）；「选择 .npix 文件…」→ `npix_inspect` 显示名称、版本、开发者、说明、声明的能力与大小，并提示插件拥有与 NPi 相同的权限 → 确认后 `npix_install`。均在 `npix.rs` 调用随包内核、按当前标签页的 profile；之后新开的标签页才应用变更。开发者主页只显示为文字，不做成可点击链接。
- **未做：** 双击 `.npix` 用 NPi 打开（macOS 文件关联）；Desktop 里启用/停用与子功能开关；签名与来源校验（`developer.json` 是插件自述，未经验证）；`engines` 版本兼容检查。

## 5. Desktop 侧

Rust 部分无法动态加载，插件的 Desktop 能力按以下优先级实现：

1. **能用数据表达的界面**：扩展状态/小组件（侧栏卡片）、`notify`、Generative UI 卡片——不写任何 Desktop 代码。
2. **需要专门界面的功能**：插件自带一个界面模块，由 Desktop 在沙箱 iframe 中加载，通过 `postMessage` 与宿主通信；宿主只开放一组受控能力（发送 `extension_command`、接收 `extension_event`、主题、语言）。这部分 Desktop 需要一次性做出通用框架（插件面板容器 + 消息桥 + CSP 配置），之后新插件不改 Desktop。
3. **需要原生能力的功能**：插件启动自己的辅助进程完成，不改 Tauri。
4. 确实需要新的 Tauri 命令时，才改 Desktop，并写成通用能力（例如「打开外部终端执行命令」），不写插件专用逻辑。

现有的侧栏小组件插件（`widgets.json`，`docs/widgets.md`）继续保留，适合不需要内核参与的展示类功能。

## 6. 开发规范

- **命名：** 插件 `@npi/plugin-<name>`；工具、命令、RPC 名、设置项都以插件名为前缀。
- **代码约定：** 沿用内核的 `AGENTS.md`（`#private`、`Promise.withResolvers`、`logger`、Bun API、禁止 `ReturnType<>`）。
- **测试：** 每个插件自带 `bun test`，用进程内的扩展运行器或 `npi --mode rpc-ui -e <插件>` 驱动；不依赖真实账号或付费模型。
- **文案：** 插件界面的四语言文案随插件一起维护；不写进 Desktop 的词典。
- **安全：** 扩展与内核同进程、拥有全部权限。官方插件视为可信；第三方插件安装时需要用户确认，并显示它声明的能力（工具、RPC 命令、启动模式、远程可调用的命令）。
- **文档：** 每个插件有自己的 `README.md` 和 `CHANGELOG.md`；进度仍记在根仓库 `docs/PROGRESS.md`。

## 7. 什么时候仍然改内核

- 修内核自身的 bug，或补第 3 节的扩展点；
- Agent 主循环、RPC 协议核心、认证与 provider 内部、TUI 核心布局的改动——这些写成独立的小补丁，适合的就整理后提交给上游；
- 品牌名（`omp` → `npi`）：现有改名保持不动。注意 `APP_NAME`（`packages/utils/src/dirs.ts`）的值仍是 `"omp"`，还用于配置目录等处，不能当作产品名使用；插件里面向用户的产品名写在插件自己的文案中，不再为改名去动上游文件。

## 8. 实施顺序

1. **S1 RPC 命令与事件**：大多数带界面的新功能都依赖它。同时做一个最小示例插件，覆盖注册命令、推事件、Desktop 收发。
2. **官方插件目录与分发**：`npi-plugins/`、`engines.npi` 校验、Desktop 打包时复制并传 `--plugin-dir`。
3. **Desktop 插件面板框架**（第 5 节第 2 点）。
4. **S2 / S3**：等第一个需要命令行子命令或启动模式的新功能出现时再做。
5. 第一个真实的新功能按插件实现，用它检验整套流程。

## 9. 待验证

- ~~编译版内核加载外部插件~~：已验证（`-e` 加载仓库外的插件包，运行时 `import @oh-my-pi/pi-utils` 正常）。插件自带的第三方 npm 依赖如何解析仍未验证；
- 插件数量对启动时间和子 Agent（会重新绑定扩展）的影响；
- 上游 Extension API 变化的频率，以及我们新增的扩展点能否被上游接受；
- Desktop 沙箱 iframe 在现有 CSP 下的可行做法。

## 10. 可插件化功能调研（2026-11-15）

依据：上游 Extension API（第 2 节）、已实现的 S1 与 `.npix`，以及 NPi 现有功能在内核里的落点（相对上游基线 `6a86df8539` 的新增/改动文件）。现有功能不迁移；这张表用来判断**同类的新功能**应该怎么做。

### A 类：现在就能做成插件

| 功能形态 | 用到的能力 | NPi 里的同类功能（参照） |
|---|---|---|
| 模型可调用的新工具、斜杠命令、提示词、skills、MCP 服务 | `registerTool` / `registerCommand`；插件包内 `skills/`、`.mcp.json` | Office 的工具与提示词（22 个新文件里的大部分） |
| 接入新的模型厂商或网关 | `registerProvider`（含命令式 provider） | — （注意：模型策略仍须写在 KDL，见 C 类） |
| 事件驱动的自动化：工具调用前拦截/改写/审计、上下文注入、provider 请求前改写、会话结束后处理、审批事件记录 | `pi.on("tool_call" / "context" / "before_provider_request" / "agent_end" / "tool_approval_*")` | 用量减负里「轮次结束后的处理」部分 |
| 需要 Desktop 或手机端界面、但界面能用卡片表达的功能 | S1（`registerRpcCommand` / `emitEvent`）+ 侧栏状态卡片 / Generative UI | Office 状态与报告（现为核心 RPC 命令）、Spend 估算 |
| 后台周期任务 | `ctx.setInterval` / `setTimeout`（会话结束自动清理） | 用量刷新 |
| 自定义消息、思考、正文渲染 | `registerMessageRenderer` / `registerAssistant*Renderer` | — |

### B 类：补一个扩展点后可以做成插件

| 缺口 | 需要的扩展点 | NPi 里的同类功能 | 规模估计 |
|---|---|---|---|
| 手机端（`/rc`、Remote）调用插件命令 | 插件清单声明「允许远程调用的命令」，守护进程白名单读取它 | Remote / `/rc` 的会话命令 | 小（约 100 行） |
| 专门的 Desktop 界面（表格、编辑器、看板等） | Desktop 插件面板框架：沙箱 iframe + 消息桥（只开放 `extensionCommand` / `onExtensionEvent` / 主题 / 语言） | Office 窗口、PR 自动化卡片 | 中（一次性 Desktop 框架） |
| `npi <子命令>` | S2 命令行子命令 | `npi remote`、`npi account` | 小–中 |
| 在创建会话前接管进程 | S3 启动模式 | SideAgent（`--side-agent`） | 小–中 |
| TUI 面板、状态栏片段、欢迎画面 | S4 TUI 区块 | Spend 侧栏卡片、用量面板卡片、欢迎场景 | 中 |
| 插件附带主题 | 主题加载器在用户主题目录之外再读取插件声明的主题文件 | dark-tokyo-* 三款主题 | 小 |
| 长期运行的服务（监听端口、守护进程） | 受管理的服务生命周期（随会话或随进程启动/停止） | Remote 守护进程、Relay 客户端 | 中 |

### C 类：不适合插件化（留在内核，或整理后提交上游）

- **RPC 协议与 Agent 主循环**：Generative UI 的 wire 与重放、按块审批（审批门、写入工具内部）、提示结果与会话状态帧。
- **认证、凭据池与用量查询**：账号激活与轮换、401/403 冷却、凭据软删除。
- **Provider 实现与模型策略**：Gemini 4 分段续写、Antigravity 暂停（KDL）、模型目录与 `rules.json`。
- **会话存储与修复**：会话名乱码、会话迁移等。
- **品牌改名**。
- **Desktop 原生能力**：终端、内置 Chromium、Computer Use、Librarian / Research 数据库、远程访问服务器、更新器——涉及 Rust、原生权限或安全边界，插件只能通过已开放的 Tauri 能力间接使用。

### 建议的下一步（按收益排序）

1. 远程可调用的插件命令（B 类第 1 项）：小改动，让插件能被手机端调用。
2. Desktop 插件面板框架：解锁「带专门界面的功能」，是 Desktop 侧插件化的主要瓶颈。
3. 插件附带主题：小改动，适合作为第二个验证用插件。
4. S2 / S3 / S4：等第一个需要它们的新功能出现时再做。

### 新功能的判断流程

1. 能否只用 A 类能力实现？能 → 写成插件。
2. 只差 B 类中的某个扩展点？→ 先补这个扩展点（通用、尽量小），再把功能写成插件。
3. 必须改 C 类核心？→ 把核心改动缩到最小的通用补丁，功能本体仍放插件；无法分离的才直接改内核，并在 PROGRESS 里注明原因。

