---
name: npi-plugin-development
description: "Build NPi plugins and the plugin system itself, kernel (omp / NPi-Kernel, Bun/TS) and Desktop (Tauri) sides. Covers deciding whether a new feature can be a plugin, the package layout (`package.json#omp` manifest + required `developer.json`), the Extension API (tools, slash commands, events, providers), plugin RPC commands/events (`registerRpcCommand`, `ctx.ui.emitEvent`, `extension_command` / `extension_event`), Desktop calls (`OMP_BRIDGE.extensionCommand` / `onExtensionEvent`, status/widget cards), local dev with `-e`, testing over `--mode rpc-ui`, `.npix` packaging (`npi plugin pack|inspect|install`), and Settings → Agent → Plugins. Use for: 写 NPi 插件、插件化新功能、.npix 打包/安装、插件 RPC 命令、Desktop 插件界面、修改插件系统本身。"
---

# NPi 插件开发

NPi 的规则：**现有功能不迁移，新功能默认写成插件。** 只有插件做不到的部分才改内核，而且改法是加一个通用扩展点，不把功能本体写进内核。原因：NPi 内核与上游 oh-my-pi 没有共同 git 历史，改上游文件会扩大每次移植的冲突面；插件只新增文件。

完整设计与调研：`omp/docs/npi-plugin-development.md`（NPi Desktop 仓库里内核在 `omp/`，是独立 Git 仓库）。动手前先确认两个仓库各自的分支。

## 1. 先判断归哪一类

1. **只用现有能力能做？** → 写成插件（A 类）：
   - 模型可调用的工具、斜杠命令、提示词、skills、MCP 服务；
   - 新模型厂商（`registerProvider`）；
   - 事件驱动的自动化：拦截或改写工具调用、注入上下文、改写 provider 请求、会话结束后处理；
   - 界面能用卡片表达的 Desktop 功能（S1 + 侧栏状态卡片 / Generative UI）；
   - 后台周期任务（`ctx.setInterval`）。
2. **只差一个扩展点？**（B 类）→ 先补一个通用、尽量小的扩展点，再把功能写成插件。尚未实现的扩展点：
   - 手机端 `/rc` 调用插件命令（守护进程白名单 `REMOTE_ALLOWED_SESSION_COMMANDS` 读取插件声明）；
   - Desktop 插件面板（沙箱 iframe + 消息桥）；
   - S2 `npi <子命令>`；
   - S3 会话前接管进程的启动模式；
   - S4 TUI 区块；
   - 插件附带主题；
   - 受管理的长期服务。
3. **必须改核心？**（C 类）→ 把核心改动缩成最小的通用补丁，功能本体仍放插件。无法分离的才直接改内核，并在根仓库 `docs/PROGRESS.md` 注明原因。C 类包括：
   - RPC 协议核心与 Agent 主循环；
   - 认证、凭据池与用量查询；
   - provider 实现，以及 KDL 里的模型策略；
   - 会话存储；
   - 品牌改名；
   - Desktop 原生能力：终端、内置 Chromium、Computer Use、Librarian、远程服务器、更新器。

拿不准时先问用户，不要默认改内核。

## 2. 插件包结构

插件就是一个 npm 包：

```
my-plugin/
├── package.json        # 必须有 "omp" 清单（不是 "npi"；旧名 "pi" 也认）
├── developer.json      # .npix 必填：开发者信息
├── index.ts            # 扩展入口：默认导出工厂函数
├── skills/<name>/SKILL.md   # 可选：随插件提供的 skills
├── .mcp.json           # 可选：MCP 服务
├── node_modules/       # 打 .npix 时依赖必须在包内（或 bun build 成单文件）
├── README.md
└── CHANGELOG.md
```

`package.json`：

```json
{
  "name": "@npi/plugin-hello",
  "version": "0.1.0",
  "description": "Says hello",
  "type": "module",
  "omp": {
    "extensions": ["./index.ts"],
    "features": { "extra": { "description": "Optional part", "default": false } },
    "settings": { "greeting": { "type": "string", "description": "Greeting word" } }
  }
}
```

- 清单字段：`extensions: string[]`、`commands: string[]`、`tools: string`、`hooks: string`（后两个是单个入口）、`features`、`settings`。`extensions`、`tools`、`hooks`、`commands`、`features` 至少要声明一项，声明的入口文件必须存在。
- 命名：
  - 包名用 `@npi/plugin-<name>`；
  - 工具、斜杠命令、RPC 名、设置项都以插件名为前缀；
  - RPC 名必须匹配 `^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9._-]*$`，即 `<plugin>/<command>`。
- 只通过 `@oh-my-pi/*` 的公开导出和 Extension API 使用内核，不 import 内核内部文件路径。编译版内核会以虚拟模块提供 `@oh-my-pi/*`。

`developer.json`：

```json
{ "name": "Ada Lovelace", "email": "ada@example.com", "url": "https://example.com", "organization": "Analytical Engines" }
```

- `name` 必填，其余字段可选。
- `email` 必须形如 `x@y`；`url` 只接受 http(s)。
- 每个字段不超过 200 字符，不能有控制字符。
- 这些信息是插件自述，没有校验来源，界面上只当文字显示。

## 3. 扩展入口（Extension API）

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("Hello");

	// 模型可调用的工具
	pi.registerTool({
		name: "hello_greet",
		label: "Hello",
		description: "Return a greeting",
		parameters: z.object({ name: z.string() }),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			return { content: [{ type: "text", text: `Hello, ${params.name}` }], details: {} };
		},
	});

	// 斜杠命令（不调用模型）
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (_args, ctx) => ctx.ui.notify("Hello!", "info"),
	});

	// 事件：tool_call 可返回 { block, reason } 拦截
	pi.on("tool_call", async event => {
		if (event.toolName === "bash" && String(event.input.command).includes("rm -rf")) {
			return { block: true, reason: "Blocked by hello plugin" };
		}
	});

	// 侧栏卡片（Desktop 渲染 setStatus / setWidget 的字符串数组）
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("hello", "ready");
		ctx.ui.setWidget("hello", ["line 1", "line 2"]);
	});
}
```

- API 全貌在 `omp/docs/extensions.md`，类型定义在 `omp/packages/coding-agent/src/extensibility/extensions/types.ts`。有约 50 个事件，覆盖会话、轮次、消息、工具前后、审批、provider 请求、子 Agent、模式切换等；可用的动作包括 `sendMessage`、`setModel`、`setActiveTools`、`exec`、`runEphemeralTurn`、`ctx.setInterval` 等。
- 扩展的作用范围是单个会话，创建会话时加载；子 Agent 会重新绑定扩展。
- RPC 模式（Desktop）下的 `ctx.ui`：
  - `select`、`confirm`、`input`、`editor` 会往返到 Desktop；
  - `notify`、`setStatus`、`setWidget`（字符串数组）是单向推送；
  - `custom`、`setFooter`、`setHeader`、主题切换和 `onTerminalInput` 在 RPC 下无效。
- 代码约定沿用 `omp/AGENTS.md`：
  - 用 `#private`、`Promise.withResolvers()`、Bun API；
  - 禁止 `ReturnType<>`，禁止 inline import；
  - 在 TUI/RPC 里运行的代码不许用 `console.*`，改用 `logger`（`@oh-my-pi/pi-utils`）；
  - 提示词放 `.md` 文件，不在代码里拼接。

## 4. 插件 RPC 命令与事件（S1，Desktop / 宿主 ↔ 插件）

插件端：

```ts
pi.registerRpcCommand("hello/greet", {
	description: "Greet someone",
	handler: async (params, ctx) => {
		// 插件自己校验 params：宿主原样转发
		const name = params && typeof params.name === "string" ? params.name : "world";
		ctx.ui.emitEvent?.("hello/greeted", { name }); // 只有 RPC 宿主存在；TUI 下为 undefined
		return { message: `Hello, ${name}!` };           // 成为 response.data.result；undefined → null
	},
});
```

线上格式（JSONL，stdin/stdout）：

- 请求：`{ "id": "1", "type": "extension_command", "name": "hello/greet", "params": { "name": "NPi" } }`
- 成功：`{ "id": "1", "type": "response", "command": "extension_command", "success": true, "data": { "result": … } }`
- 处理函数抛错：`success: false`，`error` 是抛出的消息。
- 没有插件提供这个名字：`success: false`，`code: "unsupported"`。
- 事件：`{ "type": "extension_event", "name": "hello/greeted", "data": … }`，会先于对应的应答送达。
- 同名命令时，后加载的插件生效。

Desktop 前端（`desktop/src/live.js` 的 `OMP_BRIDGE`）：

```js
const result = await window.OMP_BRIDGE.extensionCommand("hello/greet", { name: "NPi" }); // 失败或 unsupported 时 reject
const off = window.OMP_BRIDGE.onExtensionEvent(({ sessionId, name, data }) => { /* … */ });
off();
```

- 命令发给**当前标签页**的会话。后台标签页的事件不转发，激活时也不会重放。
- `extension_command` 已在 `desktop/src-tauri/src/agent/mod.rs` 的 `ALLOWED_COMMAND_TYPES` 放行，Desktop 端不做参数校验。
- 手机端 `/rc` 目前**不能**调用 `extension_command`，这是 B 类扩展点。
- Desktop 还没有插件面板框架（B 类）。目前插件的界面只能用这三种：侧栏状态/小组件卡片（`desktop/docs/architecture/extension-widgets.md`）、`notify`、Generative UI 卡片。在框架做出来之前，不要为单个插件往 Desktop 里写专用界面；确实需要时先问用户，并写成通用能力。
- Desktop 自己的 `widgets.json` 侧栏插件（`desktop/docs/widgets.md`）是另一套机制，适合不需要内核参与的展示类功能。

## 5. 本地开发与测试

- 加载未安装的插件：`npi -e <插件目录>`，或 `npi -e <父目录>`（会向下扫描一层，读子目录的 `package.json#omp.extensions`）。`--plugin-dir` 只认 Claude 插件格式，不要用它。
- 本地链接安装：`npi plugin link <目录>`。也可以先打成 `.npix` 再安装，见第 6 节。
- **隔离环境**：任何试跑都不能碰用户真实的配置和会话。用临时 `HOME`、`PI_CODING_AGENT_DIR`、`XDG_*_HOME`，必要时加 `--no-session`。
- RPC 端到端测试：参照 `omp/packages/coding-agent/test/rpc-extension-command.test.ts`。
  - 用 `Bun.spawn` 启动 `src/cli.ts --trusted-extension <file> --mode rpc-ui --no-session`，环境变量全部指向临时目录；
  - 往 stdin 写 JSONL，用 `readJsonl` 读 stdout；
  - 需要模型时，在扩展里 `registerProvider` 一个脚本化的假 provider，不调用真实账号或付费模型。
- 插件自带 `bun test`；测试只覆盖插件对外的契约（见 `omp/AGENTS.md` 的 Testing Guidance）。
- 编译版内核也能加载仓库之外的插件，插件里可以直接 `import "@oh-my-pi/pi-utils"`。插件自带的第三方 npm 依赖在编译版下如何解析**还没验证**，用到时先验证。

## 6. `.npix` 安装包

`.npix` 是可离线安装的单文件插件，相当于 VS Code 的 `.vsix`。格式与 `npm pack` 一致：一个 tar.gz，所有条目都在 `package/` 下。

```sh
npi plugin pack [目录] [-o out.npix]      # 校验后打包，默认输出 <name>-<version>.npix
npi plugin inspect file.npix [--json]     # 只读查看：名称、版本、开发者、能力、文件数、大小
npi plugin install file.npix [--json]     # 解压并链接，不联网
npi plugin list --json                    # npm 条目额外带 npix: bool、developer
npi plugin uninstall <name>               # 同时删除解压目录
npi plugin enable|disable|features|config # 与普通插件相同
```

- `pack` 会跳过 `.git`、`.DS_Store`、`node_modules/.bin` 和已有的 `.npix`；符号链接会被替换成实际内容。
- 安装位置：`<插件目录>/npix/<包名，/ 换成 __>/<版本>/`，同名旧版本先删除，再用 `PluginManager.link` 链接进 `<插件目录>/node_modules`。插件目录随 profile 而定。
- 安全检查：
  - 解压前：不许有绝对路径或 `..`，所有条目必须在 `package/` 下；
  - 解压后：发现任何符号链接就拒绝；
  - 包名用 `validatePackageName` 校验。
- 插件与内核同进程，拥有全部权限。第三方插件安装前要让用户看到它声明的能力和开发者。
- Desktop 入口：设置 → Agent → Plugins。
  - 列出当前标签页 profile 的已安装插件，显示来源与开发者；
  - 卸载需要点两次确认；
  - 选择 `.npix` 后先显示 `inspect` 的结果，用户确认后才安装；
  - 变更只对之后新开的标签页生效。
  - Desktop 调用的是**随包内核**。改了内核里的插件功能后，要重新编译内核并打包 App，Desktop 才能用上。

尚未实现：

- 双击 `.npix` 打开 NPi；
- Desktop 里的启用/停用与子功能开关；
- 签名与来源校验；
- `engines.npi` 内核版本兼容检查；
- 官方插件目录 `npi-plugins/` 和随 App 分发的 `-e Resources/plugins`。

## 7. 修改插件系统本身

| 部分 | 文件 |
|---|---|
| Extension API、RPC 命令注册 | `omp/packages/coding-agent/src/extensibility/extensions/{types,loader,runner}.ts` |
| RPC 分发 | `src/modes/rpc/rpc-mode.ts`、`rpc-types.ts`；wire 定义改动后运行 `bun run gen:rpc`，会重新生成 TS、JSON schema 和 Python/Rust/Go SDK |
| 插件管理器 | `src/extensibility/plugins/{manager,loader,types}.ts`、`src/cli/plugin-cli.ts`、`src/commands/plugin.ts` |
| `.npix` | `src/extensibility/plugins/npix.ts`；测试 `test/plugin-npix.test.ts` |
| Desktop Rust | `desktop/src-tauri/src/npix.rs`（通过 `omp_cli::run` 调用内核 CLI，插件名和文件路径都先校验）、`lib.rs`（命令 `npix_pick` / `npix_inspect` / `npix_install` / `plugins_list` / `plugin_uninstall`）、`agent/mod.rs`（`ALLOWED_COMMAND_TYPES`） |
| Desktop 前端 | `desktop/src/live.js`（`OMP_BRIDGE`）、`src/design/settings/rows-plugins.jsx`、`src/app/settings-schema.js`；四语言文案在 `src/app/i18n/*.js`，每行 `[en, zh-CN, zh-TW, ja-JP]` |

规则：

- 扩展点写成与 NPi 业务无关的通用形式，尽量小，以便将来提交给上游。
- 新加的字段设为可选，不要为此改上游测试。例如 `Extension.rpcCommands` 是可选的，因为上游测试会手工构造扩展记录。
- 内核检查用 `bun check`（不用 `tsc`），加上 oxlint/oxfmt，并且只格式化自己改的部分。
- Desktop 的 Rust 操作一律通过 DevStore：`devstore run rust/current -- …`。rustfmt 只跑改过的文件，不要用 `cargo fmt` 格式化整个 crate。clippy 开 pedantic + nursery。
- Desktop 前端用 `npm test`，其中包括词典与设置 schema 的检查。
- 文档同步更新：
  - `omp/docs/npi-plugin-development.md`；
  - `desktop/docs/architecture/{settings,extension-widgets}.md`；
  - 两边的 `CHANGELOG.md`（`## [Unreleased]` 下）；
  - 根仓库 `docs/PROGRESS.md`。
- 不要主动提交。内核只推送到 `origin`（NPi-Kernel），不推 `upstream`。
- 不替换用户正在使用的 App 或内核。打包流程见根仓库 `docs/RELEASES.md`。

## 8. 交付检查清单

- [ ] 判断过类别（A/B/C），B/C 类先和用户确认扩展点
- [ ] 包名、工具、命令、RPC 名都带插件前缀
- [ ] `package.json#omp` 的入口存在；`developer.json` 合法
- [ ] 依赖在包内，安装时不联网
- [ ] 在隔离环境里用 `-e` 跑通，RPC 功能用 `--mode rpc-ui` 测试覆盖
- [ ] `npi plugin pack` → `inspect` → `install` → 新会话里生效 → `uninstall` 后干净
- [ ] 插件的 README、CHANGELOG 和四语言文案都随插件维护，不写进 Desktop 的词典
