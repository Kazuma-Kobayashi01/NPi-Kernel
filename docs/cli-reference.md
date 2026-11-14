# CLI reference

`omp` is invoked as:

```sh
omp [command] [flags] [messages...]
```

When the first positional argument is **not** a registered subcommand, `omp`
normally routes to the default [`launch`](#launch-the-default-command) command.
So `omp "fix the build"` launches a session with that message, while `omp models`
runs the `models` subcommand. Bare plugin-management words such as `marketplace`,
`uninstall`, or `extensions` instead produce a hint to use `omp plugin …`;
use `omp launch <word>` when such a word is the intended prompt.

A recognized subcommand can follow leading launch flags. Those flags are
forwarded to `launch` and `acp`, but recognized launch-only flags before other
subcommands are stripped, not applied (for example, `omp --cwd dir update`).

`--profile` is applied before subcommand routing, so it also scopes commands
such as `config`, `models`, and `update`.

Runtime help is also available:

- `omp --help` lists user-facing subcommands and common launch flags.
- `omp <command> --help` prints that command's public flags and examples.

This page is the consolidated reference for the shared **launch surface** (the
flags accepted by `omp` / `omp launch`) and every top-level **subcommand**.
Per-subcommand flags (for example `omp auth-broker --json`) are documented by
each command's `--help`.

## Launch (the default command)

`omp` and `omp launch` start a coding session. Positional arguments become the
initial message(s):

```sh
# Interactive session
omp

# Interactive session with an initial prompt
omp "List all .ts files in src/"

# Attach files/images to the initial message (prefix with @)
omp @prompt.md @image.png "What color is the sky?"

# Non-interactive: process the prompt and exit (headless / print mode)
omp -p "List all .ts files in src/"

# Continue the previous session
omp --continue "What did we discuss?"
```

Argument handling:

- `@<path>` attaches a file or image to the initial message.
- Outside protocol modes, non-TTY stdin is read to EOF automatically as prompt
  text; do not add a `-` marker. Piped input or a non-TTY stdin selects print mode
  when `--mode` is omitted. Without stdin text, an argv prompt or attachment is
  required.
- Stdin text, text attachments, and the first positional message are combined
  into the initial prompt; remaining positional messages are sent as later turns.
- `--` ends flag parsing; everything after it is literal message text, even if it
  looks like a flag.

### Conversation width

In `/settings` → **Appearance** → **Composer** → **Content Width**, choose
**Common (100 columns)** or **Wide (140 columns)** for the main conversation and
input area. Common remains the default. Changes apply immediately; the right
side panel keeps its reserved space and narrower terminals shrink the column
to fit. The welcome screen keeps its compact centred card.

The underlying `tui.contentWidth` setting remains numeric: `100` for Common,
`140` for Wide, or `0` for Full width. The 80- and 120-column choices and existing
saved custom widths remain supported.

### Interactive usage dashboard

`/usage` opens a fullscreen dashboard without adding a report to the conversation. Every signed-in account has its own card, titled with the provider and the account's name (or its email); an account whose usage lookup failed gets a card saying so.
Overview shows provider quotas, account availability, balances and local activity.
Quota bars fill with **used** capacity, while the adjacent percentage shows
**free** capacity; reset countdowns sit in their own column. Warning and exhausted
quotas also carry status symbols. Narrow terminals use a single provider column;
wider terminals place providers side by side.

Press `Tab` to switch Overview and Details, or `Enter` to open Details. Details lists
each account's quota consumed per limit window over the last 7 and 30 days (100% =
one full window), derived from the recorded usage history; accounts whose usage
could not be fetched are named as unavailable. Press `r`
to refresh; a failed refresh keeps the last report visible. Use the arrow keys,
Page Up/Down or the mouse wheel to scroll. `Esc` returns from Details to Overview,
then closes the dashboard. Activity history is local; an unavailable history does
not hide provider quotas.

### Launch flags

#### Session and workspace

| Flag                  | Description                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `--cwd <dir>`         | Directory to start in (overrides the launch cwd).                                            |
| `--add-dir <dir>`     | Add a workspace directory beyond the working directory (repeatable).                         |
| `--allow-home`        | Stay in `~` instead of switching to the NPi workspace, `~/Documents/NPi/Code`.               |
| `--profile <name>`    | Use an isolated profile for auth, sessions, settings, and caches.                            |
| `--alias <name>`      | Create a shell shortcut for a named profile and exit; requires `--profile` or `OMP_PROFILE`. |
| `--config <file>`     | Load an extra `config.yml`-style overlay for this run (repeatable).                          |
| `--session-dir <dir>` | Directory for session storage and lookup.                                                    |
| `--no-session`        | Don't save the session (ephemeral).                                                          |

#### Session history

| Flag                                    | Description                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--continue`, `-c`                      | Continue the previous session.                                                                                                                                                                                                                                                                                |
| `--resume [id]`, `-r`, `--session [id]` | Resume a session by ID prefix or path, or open the picker when no value is given.                                                                                                                                                                                                                             |
| `--restore [id]`                        | Resume a session as `--resume` does, then go on with what its last process left unfinished when it crashed or was killed: the interrupted turn and the subagents it was running. Interactive only; takes no prompt. See [session operations](./session-operations-export-share-fork-resume.md#cli---restore). |
| `--fork <session>`                      | Fork a saved session (by ID prefix or path) into a new session. See [session operations](./session-operations-export-share-fork-resume.md).                                                                                                                                                                   |
| `--from-claude`                         | Import a Claude Code session into OMP.                                                                                                                                                                                                                                                                        |
| `--from-codex`                          | Import a Codex session into OMP.                                                                                                                                                                                                                                                                              |
| `--export <session>`                    | Export a session file to HTML and exit.                                                                                                                                                                                                                                                                       |
| `--no-title`                            | Disable title auto-generation (equivalent to the `PI_NO_TITLE` [environment variable](./environment-variables.md)).                                                                                                                                                                                           |

`--continue`, `--resume`, `--restore`, `--fork`, and foreign-session imports require
persistence and cannot use `--no-session`. `--from-claude` and `--from-codex`
are mutually exclusive and cannot be combined with `--continue`, `--resume`,
or `--fork`.

#### Model selection

| Flag                         | Description                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--model <id-or-role>` | Model or configured role to use (role: `slow` or `@slow`; fuzzy model match: `opus`, `gpt-5.2`; with a provider the id must be exact: `openai/gpt-5.2`). |
| `--smol <id>`                | Smol/fast model for lightweight tasks (or `PI_SMOL_MODEL`).                                                                |
| `--slow <id>`                | Slow/reasoning model for thorough analysis (or `PI_SLOW_MODEL`).                                                           |
| `--plan <id>`                | Plan model for architectural planning (or `PI_PLAN_MODEL`).                                                                |
| `--model <id-or-role>` | Model or configured role to use (role: `slow` or `@slow`; fuzzy model match: `opus`, `gpt-5.2`; with a provider the id must be exact: `openai/gpt-5.2`). |
| `--provider <name>`          | Provider to use (legacy; prefer `--model`).                                                                                |
| `--api-key <key>`            | API key (defaults to env vars).                                                                                            |
| `--provider-session-id <id>` | Reuse a specific provider-side session id for continuity and cache scoping.                                                |
| `--prompt-cache-key <key>`   | Override the provider prompt-cache key for this session.                                                                   |
| `--service-tier <tier>`      | OpenAI service tier: `none`, `auto`, `default`, `flex`, `scale`, `priority`, or `ultrafast` (`none` omits `service_tier`). |

See [providers](./providers.md) and [models](./models.md) for model resolution.

#### Thinking and reasoning

| Flag                  | Description                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--thinking <level>`  | Set the thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`.                                                             |
| `--hide-thinking`     | Hide thinking blocks in TUI output (display only; does not disable model thinking).                                                                       |
| `--print-thoughts`    | Include thinking blocks in print-mode text output.                                                                                                        |
| `--external-thinking` | Use a private scratchpad while disabling supported GPT/Claude/Gemini reasoning. Use at your own risk: providers have flagged this request shape as abuse. |

Gemini 4 Hydrogen supports `low`, `medium`, `high` (default), and `xhigh` on
both `google/gemini-4-hydrogen` (API key) and
`google-antigravity/gemini-4-hydrogen` (subscription OAuth). For example:

```sh
npi --model google/gemini-4-hydrogen --thinking xhigh
npi --model google-antigravity/gemini-4-hydrogen --thinking xhigh
```

Antigravity discovery combines its effort-specific SKUs into one Hydrogen
model; the selected effort chooses the upstream SKU. Availability still follows
the signed-in account's roster. `xhigh` sends the native `XHIGH` level, not a
thinking-token budget. Ordinary streaming output remains capped at 65,536 tokens;
this integration does not implement long-decode continuation.

#### Prewalk and plan modes

| Flag                            | Description                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--prewalk`                     | Arm a one-shot handoff at the first eligible edit/write turn, gated on a successful todo call when `todo` is active (default off). See [prewalk](./prewalk.md).                                                                                                                                                                                                       |
| `--no-prewalk`                  | Disable prewalk even if `prewalk.enabled` is set, and keep `prewalk.auto` out of the startup session; incompatible with `--prewalk`/`--prewalk-into`.                                                                                                                                                                                                                 |
| `--prewalk-into <id-or-role>`   | Arm prewalk with this target instead of the `smol` role.                                                                                                                                                                                                                                                                                                              |
| `--plan-yolo`                   | Start in read-only plan mode, auto-approve the model's plan proposal, then switch to the execution target to implement it.                                                                                                                                                                                                                                            |
| `--plan-yolo-into <id-or-role>` | Target model for plan-yolo execution (default the `smol` role); requires `--plan-yolo`.                                                                                                                                                                                                                                                                               |
| `--goal <objective>`            | Start a fresh interactive session in goal mode and begin working on the objective, without typing `/goal`. Requires `goal.enabled`; interactive only. Bypasses `autoResume`, and is rejected with a positional prompt, `@file` or stdin input, `--resume`/`--continue`/`--fork`/imports, `--plan-yolo`, `--no-tools`, or startup plan mode (`plan.defaultOnStartup`). |

#### Tools, approvals, and runtime

| Flag                       | Description                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tools <a,b,c>`          | Comma-separated list of tools to enable (default: all).                                                                                                                                              |
| `--no-tools`               | Disable all built-in tools.                                                                                                                                                                          |
| `--no-lsp`                 | Disable LSP tools, formatting, and diagnostics.                                                                                                                                                      |
| `--no-pty`                 | Disable PTY-based interactive bash execution.                                                                                                                                                        |
| `--approval-mode <mode>`   | Override `tools.approvalMode` for this session (`always-ask`, `always-ask-cached`, `write`, or `yolo`). See [approval mode](./approval-mode.md).                                                     |
| `--sandbox <mode>` | macOS: run this session under a Seatbelt sandbox that confines file writes (`off`, `workspace-write`, or `read-only`); overrides `sandbox.mode`. See [process sandbox](./sandbox.md). |
| `--auto-approve`, `--yolo` | Force yolo tier approval; explicit tool/user policies and provider safety checks still apply.                                                                                                        |
| `--advisor`                | Enable the advisor runtime (passively reviews each turn and injects notes). See [advisor / watchdog](./advisor-watchdog.md).                                                                         |
| `--wait-async`             | Print mode: before exiting, wait for this run's background jobs and start another turn in the same session with each result (`async.printWake`). See [Headless / print mode](#headless--print-mode). |
| `--max-time <duration>`    | Stop the session after this duration (e.g. `600`, `10m`, `1h`).                                                                                                                                      |
| `--warn-cost <usd>`        | Warn once when the session's spend, subagents included, reaches this many USD. Overrides `session.warnCost`.                                                                                         |
| `--max-cost <usd>`         | Stop sending model requests once the session's spend reaches this many USD; a request already in flight can carry spend past it. Overrides `session.maxCost`.                                        |

#### Extensions, hooks, skills, and rules

| Flag                              | Description                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--extension <path>`, `-e <path>` | Load an extension (repeatable). See [extensions](./extensions.md).                                                                                                                        |
| `--hook <path>`                   | Load a hook/extension file (repeatable). See [hooks](./hooks.md).                                                                                                                         |
| `--trusted-extension <abs-path>`  | Exact allowlist of existing absolute module files (repeatable); disables ambient extension discovery and package-root sub-discovery. Cannot be combined with `--extension`/`-e`/`--hook`. |
| `--plugin-dir <dir>`              | Add a local plugin directory to discovery (repeatable).                                                                                                                                   |
| `--no-extensions`                 | Disable extension discovery (explicit `-e` paths still work).                                                                                                                             |
| `--skills <globs>`                | Comma-separated glob patterns to filter [skills](./skills.md) (e.g. `git-*,docker`).                                                                                                      |
| `--no-skills`                     | Disable skills discovery and loading.                                                                                                                                                     |
| `--no-rules`                      | Disable rules discovery and loading. See [context files](./context-files.md).                                                                                                             |
| `--no-context-files`              | Disable [context files](./context-files.md) (`AGENTS.md`, `CLAUDE.md`, ...) for the working directory and every `--add-dir` root. Subagents inherit it.                                   |

#### System prompt

| Flag                                  | Description                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--system-prompt <text\|file>`        | Plain-text system prompt override (default: coding assistant prompt). See [system prompt customization](./system-prompt-customization.md).                                     |
| `--system-prompt-template <path>`     | Strictly read `<path>` as a Handlebars system-prompt template; mutually exclusive with `--system-prompt`. See [system prompt customization](./system-prompt-customization.md). |
| `--append-system-prompt <text\|file>` | Append plain text or file contents to the system prompt.                                                                                                                       |

#### Output mode

| Flag            | Description                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--mode <mode>` | Output/transport mode: `text` (default), `json`, `rpc`, `acp`, or `rpc-ui`. See [output modes](#output-modes---mode). |
| `--print`, `-p` | Process prompts non-interactively and exit.                                                                           |
| `--no-ui`       | With `rpc`/`rpc-ui`, make extensions headless without disabling rpc-ui tool UI.                                       |

#### Information

| Flag              | Description                                   |
| ----------------- | --------------------------------------------- |
| `--help`, `-h`    | Show help for `omp` or a subcommand and exit. |
| `--version`, `-v` | Print the installed version and exit.         |

### Headless / print mode

`--print` / `-p` runs `omp` non-interactively: it processes the prompts, writes
the last assistant response to stdout, and exits without entering the TUI. Text
output is emitted after the turn completes, not token-by-token; a `Working...`
indicator goes to stderr. This is the entry point for scripting and automation.

```sh
# Print the answer and exit
omp -p "Summarize the changes in the last commit"

# Include the model's thinking blocks in the printed text
omp -p --print-thoughts "Explain your reasoning for this refactor"

# Machine-readable output for pipelines
omp -p --mode json "List every TODO in src/" > todos.json

# Pipe a prompt via stdin
echo "review this diff" | omp -p
```

Related flags for headless runs:

- `--print-thoughts` — include thinking blocks in the printed text output.
- `--mode json` — emit structured events instead of rendered text.
- `--no-title` — skip title auto-generation (also `PI_NO_TITLE`).
- `--max-time <duration>` — bound the run.
- `--wait-async` — keep the run alive for its background jobs (below).
- `--warn-cost <usd>` / `--max-cost <usd>` — warn at, or stop sending model requests from, a spend.

Print mode is single-shot by default: once its prompts are answered it disposes
the session, which cancels background jobs the run started (`bash` or `task`
calls the model ran asynchronously). With `--wait-async` (or
`async.printWake: true`) it instead waits for them; each job's result is
delivered to the same session as it is in the TUI, starting another turn, and a
turn may start further jobs. The run exits once no owned job or undelivered
result remains, and text mode prints the answer of the last turn. Bound
unattended runs with `--max-time`.

```sh
# Start a long build in the background, then react to its result in the same session
omp -p --wait-async --max-time 2h "Run the integration suite in the background and fix what fails"
```

`--mode json` emits a session header followed by events as JSON lines.
Incremental `message_update` events omit full partial-message snapshots; completed
messages arrive in `message_end`, and opaque provider replay payloads are omitted.
Terminal turn failures produce a nonzero exit status in both text and JSON modes.
A run stopped by `--max-cost` exits with status `3`: the cap message goes to
stderr (a `cost-gate` notice in JSON mode) and no answer is printed.

`plan.defaultOnStartup` is ignored in print mode because there is no plan-review
UI. Use `--plan-yolo` for unattended planning and implementation.

The [advisor / watchdog](./advisor-watchdog.md#headless-runs) doc describes
print-mode disposal semantics when the advisor runtime is enabled.

### Output modes (`--mode`)

| Mode     | Description                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | Rendered text. Omitting `--mode` allows the TUI; explicit `--mode text` selects non-interactive text output.                                                      |
| `json`   | Newline-delimited JSON event stream for headless/machine consumption; `-p` is optional.                                                                           |
| `rpc`    | Line-delimited JSON command/response/event transport over stdio (not JSON-RPC 2.0). See [RPC](./rpc.md).                                                          |
| `rpc-ui` | RPC transport with UI extension events enabled.                                                                                                                   |
| `acp`    | Agent Client Protocol server over stdio. Equivalent to the [`acp`](#subcommands) subcommand; see [approval mode → ACP sessions](./approval-mode.md#acp-sessions). |

`--no-ui` (with `--mode rpc` or `--mode rpc-ui`) runs extensions headless: `ctx.hasUI` is `false`, extension dialogs resolve to defaults, and extension presentation updates are dropped. In `rpc-ui`, tool UI such as `ask` still sends `extension_ui_request` frames for the host to answer. Host-issued `login` UI is unaffected. See [RPC startup](./rpc.md#startup).

## Subcommands

Run `omp <command> --help` for each command's own flags and examples.

`npi login` and `/login` automatically open browser authorization pages for OAuth flows (including Codex, Claude, and Antigravity). API-key flows—including Alibaba Coding/Token Plan, Cloudflare, and Xiaomi—only display the provider's key-page link and prompt for credentials; open that link manually if needed. Setup follows the same rule. RPC hosts receive a notification with the manual link instead of an `open_url` request for these key pages, while retaining the input prompt.

Logging in to an OAuth provider again with another account keeps both: each account is stored on its own, and a session rotates between them by remaining quota. After a new account's login, `/login` offers to name it (for example `GPT-Plus-Kazuma` and `GPT-Plus-Hanyu` for two accounts of one provider), listing the names already taken and asking again if the name is used; `/login <provider> <name>` gives the name up front, and the provider list shows the accounts each provider already has; `/account` lists every signed-in OAuth account grouped by provider. Enter activates the selected account: from the next request it is the only account of its provider in use, and the provider's other accounts are marked idle and are not used (a session pinned to an account with `/session pin` keeps its pin). A provider with no activated account shows its accounts as rotating, and they share the load by remaining quota as before; logging out the active account returns its provider to rotating, and a new login starts idle while another account is active. `r` renames the selected account (an empty name clears it). The activation is kept across token refreshes and re-logins; `/session rename <account> <name>` does the same for the current provider from the command line (`-` clears it). `/logout` lists every stored account of every provider (OAuth logins and stored API keys) and logs out the one you pick; `/logout <provider>` lists only that provider's. Names show in `/session pin` and `/usage`, `/session pin <name>` pins that account to the session, and `auth.accountPolicies` can select an account by `label`. Names are unique per provider and survive token refreshes and re-logins of the same account. With a remote auth broker, names are only as durable as the broker's credential store.

| Command                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | See also                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`                    | Start a coding session (the default command).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [Launch flags](#launch-flags)                                                                                                                        |
| `acp`                       | Run omp as an ACP (Agent Client Protocol) server over stdio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | [approval mode](./approval-mode.md#acp-sessions)                                                                                                     |
| `auth-broker`               | Manage the omp auth-broker (credential vault).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [auth broker / gateway](./auth-broker-gateway.md)                                                                                                    |
| `auth-gateway`              | Run an auth-gateway: an HTTP forward proxy backed by the configured broker (`serve`), or JSON lines on stdin/stdout for a parent process with your own credentials (`stdio`).                                                                                                                                                                                                                                                                                                                                                                                                                                          | [auth broker / gateway](./auth-broker-gateway.md)                                                                                                    |
| `agents`                    | Manage bundled task agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [task agent discovery](./task-agent-discovery.md)                                                                                                    |
| `bench`                     | Benchmark models: TTFT/prefill vs decode throughput with p50/p95 across chat, prefill, generation, and prompt-cache workloads, rendered in a live dashboard (`--prefill-bytes` sizes the synthetic prefill input). `--detailed` runs single-user, `--par`-way parallel (aggregate tok/s and scaling), and prefill phases per model.                                                                                                                                                                                                                                                                                    |                                                                                                                                                      |
| `browser-relay`             | Run the local CDP relay used by Eval's browser API to drive your own Chrome tabs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [computer use](./computer-use.md)                                                                                                                    |
| `cleanse`                   | Detect and fix project diagnostics with weighted parallel subagents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                                                                      |
| `collab`                    | List active local Collab hosts without exposing URLs; `collab link <instanceId\|pid>` retrieves a control link (`--view` for view-only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [collab](./collab.md)                                                                                                                                |
| `clip`                      | Upload a `/record` recording to live.omp.sh as a public clip and print its URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                      |
| `commit`                    | Generate a commit message and update changelogs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                      |
| `completions`               | Print a shell completion script (bash, zsh, or fish).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                      |
| `compress`                  | Rewrite a text file into the dense prompt register, reporting what it drops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |                                                                                                                                                      |
| `config`                    | Manage configuration settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [config usage](./config-usage.md), [settings](./settings.md)                                                                                         |
| `dry-balance`               | Dry-run OAuth account balancing across random session ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                                                                                                                      |
| `find`                      | Semantic search for implementing files and line ranges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                                                                                                                      |
| `gc`                        | Run storage garbage collection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                      |
| `grep`                      | Test the grep tool from the CLI. (The [`grep` tool](./tools/grep.md) is a separate agent tool.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                      |
| `gallery`                   | Preview tool, composer, and status-line renderers in a deterministic gallery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                                      |
| `git`                       | Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                                                                                                                      |
| `grievances`                | View, clean, or push reported tool issues (auto-QA grievances).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                      |
| `if-bench`                  | Benchmark instruction following and working memory: one cached thread of glyph array actions with a cat-sound directive that moves through the prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                                                                                                                      |
| `images`, `img`             | Inspect, diagnose, probe, and purge image publication backends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                      |
| `install`                   | Install or link an extension package (alias of `plugin install` / `plugin link`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [extensions](./extensions.md)                                                                                                                        |
| `join`                      | Join a shared collab session (same as `/join`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [collab](./collab.md)                                                                                                                                |
| `login`                     | Log in to a model provider from the terminal (counterpart of `/login`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                                                                                                                      |
| `models`                    | List, search, and refresh available models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [models](./models.md)                                                                                                                                |
| `plugin`, `plugins`         | Manage plugins (install, uninstall, list, etc.).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [extensions](./extensions.md), [marketplace](./marketplace.md)                                                                                       |
| `play`                      | Replay a `/record` recording in the terminal; Space pauses and `q` quits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |                                                                                                                                                      |
| `predict`                   | Compare word-completion engines' live ghost text for a prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                      |
| `ps`                        | List and control daemon-supervised background processes (logs, stop, kill, restart).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                                                                      |
| `say`                       | Synthesize text with the local TTS engine and play it through the speakers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [tts tool](./tools/tts.md)                                                                                                                           |
| `share`                     | Share a saved session via an encrypted link (same as the `/share` slash command).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [session operations](./session-operations-export-share-fork-resume.md)                                                                               |
| `setup`                     | Run onboarding setup or install dependencies for optional features.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                                                                                                                      |
| `shell`                     | Interactive shell console.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                                                                                                                      |
| `remote`                    | Remote Connect host for a phone app: `remote pair --relay <url> \| --listen <host:port>` pairs a phone by QR code and a 6-digit code confirmed on both sides, `remote start` serves paired phones (end-to-end encrypted) through a Relay or directly, `remote devices`, `remote revoke <id>` and `remote status` manage them. In the TUI, `/rc [wss://relay \| --listen host:port]` lets paired phones drive the running session itself (dialogs show on both sides, first answer wins; `/rc off` stops). | [Remote Connect plan](./plan-android-remote-connect.md) |
| `read`                      | Show what the read tool will return for a path, URL, or internal URI. (The [`read` tool](./tools/read.md) is a separate agent tool.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                                                                      |
| `render`                    | Draw a session's entire thread through the production transcript pipeline (with repaint timing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                      |
| `skill`, `skills`           | Install, search, publish, and manage skills on skills.omp.sh.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [skills](./skills.md)                                                                                                                                |
| `ssh`                       | Manage SSH host configurations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                      |
| `stats`                     | View usage statistics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                                                                                                                      |
| `stream`                    | Broadcast local OMP session screens and chat to a public live channel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                                                                                                                      |
| `update`                    | Check for and install updates; `--canary`/`--stable` switch release channels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                                      |
| `account`                   | List signed-in OAuth accounts by provider with their state (`active`, `idle`, `rotating`); `account activate <provider> <id>` makes one account the only one used for its provider, `account rotate <provider>` returns the provider to rotation, `account rename <provider> <id> [name]` names an account (no name clears it). `--json` prints the list after any change; the desktop app's Settings → Accounts uses it. | |
| `usage`                     | Show provider usage limits for every authenticated account, flagging saved resets close to expiry; `usage clients` breaks token burn down per client (with `--days`), `usage invalidate` drops cached reports, `usage accounts` lists each OAuth account's provider and identity key (the key `task.agentAccountPools` and broker account pools take; no tokens, `--json` supported), and `usage reset` lists each Codex and Claude account's saved rate-limit resets by `<provider>/<credential id>` (`--json`, `--redact`) and `usage reset <provider>/<credential id>` spends one, also from an auth-broker client. | [Task agent discovery](./task-agent-discovery.md#model-and-structured-output-precedence), [saved resets](./settings.md#saved-reset-auto-consumption) |
| `tiny-models`               | Download tiny local models for session titles, memory, and word completion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [local models](./local-models.md)                                                                                                                    |
| `token`                     | Get the API key or OAuth token for a provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [secrets](./secrets.md)                                                                                                                              |
| `toks`                      | Count file or text tokens with the embedded offline tokenizers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                      |
| `ttsr`                      | Inspect and test Time-Traveling Stream Rules (TTSR). (Covers the CLI command; the [TTSR feature](./ttsr-injection-lifecycle.md) is documented separately.)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                                                                                                                      |
| `worktree`, `wt`            | Add, list, or clear git worktrees; uses clone-first behavior when enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                                                                                                                      |
| `search`, `q`, `web-search` | Test web search providers from the CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [web_search tool](./tools/web_search.md)                                                                                                             |

> `install`, `join`, `browser-relay`, `auth-gateway`, and `tiny-models` are also
> reachable through related mechanisms (the `plugin` command, the `/join` slash
> command, and so on). The table lists each as it is registered in
> `packages/coding-agent/src/cli-commands.ts`.

`__complete` is an internal, hidden subcommand used by shell completion scripts.

### Worktree clones

When `worktree.clone` is enabled, `omp worktree add` and other clone-first
worktree callers carry relocatable ignored caches such as `node_modules`.
Directories containing `pyvenv.cfg` or `CMakeCache.txt` are not carried, even
when they are nested or ignore themselves. Recreate Python environments and
CMake build trees in the new worktree so their absolute paths name the new
checkout. Tracked files inside excluded directories are restored from Git;
when keeping changes, their live source contents and staged state are preserved.

Clean clones also discard carried files that are untracked under the target
commit's own ignore rules, after its tree and index have been written. Caches
ignored by the target remain, even if the source did not ignore them. Nested
repositories are preserved and symlinks are not followed. This target-ignore
cleanup is skipped when keeping the source's uncommitted changes.
