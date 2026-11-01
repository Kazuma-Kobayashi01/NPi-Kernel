# NPi Kernel

<p align="center">
  <strong>The open-source, high-performance agent engine powering NPi Desktop and the npi CLI.</strong><br>
  <sub>Forked and evolved from <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> · Dedicated to humanist, craftsman-grade AI tooling.</sub>
</p>

---

> [!NOTE]
> **Upstream Documentation**: For the original upstream documentation, installation instructions for generic platforms, and historical background, please refer to [README.upstream.md](README.upstream.md).

---

## What is NPi Kernel?

**NPi Kernel** (binary: `npi`) is a modern agent execution engine written in TypeScript on [Bun](https://bun.sh) with a high-performance native Rust core. It orchestrates language models, local tools (filesystem, shell, LSP, DAP, web search), subagent task graphs, and persistent conversation sessions.

It operates in two primary modes:
1. **Interactive CLI**: A terminal-native coding and research agent with tiered settings and non-destructive session control.
2. **`rpc-ui` Stdio Daemon**: A line-delimited JSON RPC backend spawned per-tab by [NPi Desktop](https://github.com/Kazuma-Kobayashi01/NPi) (Tauri 2 + React 19).

---

## What's Changed from Upstream?

NPi Kernel maintains compatibility with the core agent architecture while introducing crucial bug fixes, protocol extensions, new provider catalogs, and architectural refinements tailored for desktop bootstrapping and robust subagent workflows:

### 1. Dynamic Subagent Model Dispatch (`task` tool)
- **The Problem in Upstream**: In the upstream engine, subagent invocations (`task` tool) attempted to filter out custom `model` arguments in schema validators, silently stripping or rejecting subagent requests that specified dedicated models.
- **NPi Kernel Fix**:
  - Elevated `model` to a first-class citizen across all static, dynamic, flat-string, and batch-array schemas in `packages/coding-agent/src/task/types.ts`.
  - Enables subagent tasks to dynamically dispatch to specialized models (e.g., delegating exploratory scans to `gemini-3.8-flash` or code audits to `gpt-6.1-terra`) while defaulting to session-level models when unspecified.

### 2. Alibaba Cloud (China) Integration & Thinking Policy Overhaul
- **Dedicated Provider Descriptor**:
  - Integrated native `alibaba-cn` provider endpoint (`https://dashscope.aliyuncs.com/compatible-mode/v1`) with full credential resolution (`DASHSCOPE_API_KEY` and `QIANWEN_API_KEY`), separate from third-party proxy tokens.
- **Thinking / Reasoning Contracts**:
  - Overhauled compatibility rules for Qwen/Qianwen models in `packages/catalog/src/compat/rules/classes/qwen.kdl` and `rules.json`.
  - Added support for explicit `thinking_budget`, mandatory thinking models, and automatic invalidation of stale model policy caches (`materialization_policy`), ensuring correct reasoning serialization without client crashes.

### 3. Non-Destructive Session Interruption (Ctrl+C Hotfix)
- **The Problem in Upstream**: Pressing `Ctrl+C` during an active turn in the CLI would often clear the current input line while leaving in-flight background jobs running, or inadvertently arm double-tap exit timers that terminated the session.
- **NPi Kernel Fix**:
  - Implemented graceful cooperative cancellation: `Ctrl+C` immediately aborts active foreground tool calls and turn execution, restores terminal state, and leaves the session connected and ready for the next command without exiting the process.

### 4. Full Branch History Recovery for Desktop (`rpc-ui`)
- **Full Historical Replay**:
  - Extended the `get_messages` RPC method with `fullHistory: true`.
  - Allows desktop clients to traverse the complete, uncompressed message history of the active conversation branch across tab switches or restarts, eliminating upstream's aggressive minimap-based message truncation.
- **Rich Output Hints**:
  - Informs models of desktop-native visual capabilities: standard LaTeX math (`$` and `$$`), Mermaid workflow diagrams, and declarative SVG charts (`percentage-bar`, `donut`, `pie`, `bar`, `line`).

### 5. Frugal Verification & Direct Action Engineering
- **Prompt & Philosophy Refinement**:
  - System prompts and coding agent directives have been updated to adhere to direct-action engineering: zero speculative guards, no unrequested defensive wrappers, fail-fast contracts, and targeted high-signal verification over repetitive acceptance loops.

---

## Building from Source

### Prerequisites
- [Bun](https://bun.sh) (v1.4+)
- Node.js (v22+)
- Rust toolchain (Apple Silicon: macOS 14+, Linux x86_64/aarch64)

### Compile the Standalone Binary

```bash
# 1. Install dependencies and compile native addons
bun install
bun run build:native

# 2. Build the self-contained npi binary
cd packages/coding-agent
bun run build

# Output binary will be located at:
# packages/coding-agent/dist/npi
```

To run the test suite:

```bash
bun test
```

---

## Relationship with NPi Desktop

NPi Kernel serves as the official engine submodule of [NPi Desktop](https://github.com/Kazuma-Kobayashi01/NPi):
- Version numbering is kept synchronized across releases (`packages/utils/src/dirs.ts` $\leftrightarrow$ `desktop/src-tauri/tauri.conf.json`).
- Pre-compiled release binaries are embedded into `desktop/src-tauri/binaries/` during desktop package bundling.

---

## License

This project is licensed under the [MIT License](LICENSE), carrying forward all notices and copyrights from the upstream `oh-my-pi` project and its contributors.
