# Eval Tool Python Backend

This document describes the Python execution stack in `packages/coding-agent`.
It covers tool behavior, runner lifecycle, environment handling, execution semantics, output rendering, supported magics, and operational failure modes.

## Scope and Key Files

- Eval tool surface: `src/tools/eval.ts`
- Managed `python` tool: `src/tools/python.ts`
- Session/per-call kernel orchestration: `src/eval/py/executor.ts`
- Subprocess kernel client: `src/eval/py/kernel.ts`
- Shared IPC/cancellation client: `src/eval/kernel-base.ts`
- Shared session/reset ownership: `src/eval/kernel-session-registry.ts`
- Standalone `%load` preparation: `src/eval/input.ts`
- Python wrapper / NDJSON server: `src/eval/py/runner.py`
- Prelude helpers loaded into every kernel: `src/eval/py/prelude.py`
- Host-side subagent helper bridge: `src/eval/agent-bridge.ts`
- Tool output renderer and view splitting: `packages/tui/src/tools/eval.ts`
- Shared output capture: `packages/tui/src/tools/streaming-output.ts`
- Interactive-mode renderer for user-triggered Python runs: `packages/tui/src/chat/eval-execution.ts`
- Runtime/env filtering and Python resolution: `src/eval/py/runtime.ts`
- NPi Desktop runtime host (archive, install, environment): `desktop/docs/architecture/python-runtime.md` in the NPi root repository

## Managed Python runtime and the desktop host

Two surfaces share one managed environment:

- the `python` tool runs one program per call in a fresh supervised subprocess;
- the `eval` tool with `language: "py"` keeps a kernel per session for stateful
  cells.

The NPi Desktop app owns that environment. It sets
`NPI_PYTHON_HOST=<absolute app executable>` on every `omp` it spawns.
`ensureNpiPythonEnv()` then runs

```text
$NPI_PYTHON_HOST --npi-python-host
```

with exactly one JSON request on stdin and reads exactly one JSON value from
stdout:

```json
{"action": "ensure"}
{"action": "ensure", "resourceDir": "/abs/path/to/Resources"}
{"action": "environment"}
{"action": "packages", "operation": "list"}
{"action": "packages", "operation": "install", "packages": ["numpy>=2"]}
```

`ensure` installs the bundled runtime and default environment if needed and
returns health. `environment` is read-only and still exits 0 when health is
`false`. `packages` lists or installs distributions; `operation` defaults to
`list`, and there is no separate `install` action. Unknown fields are rejected.
Health returns the absolute managed interpreter:

```json
{
  "ok": true,
  "pythonVersion": "3.12.16",
  "uvVersion": "0.13.6",
  "pythonPath": "<base>/environments/default/versions/py.../bin/python",
  "envPath": "<base>/environments/default",
  "runtimePath": "<base>/runtimes/python/3.12.16-aarch64-apple-darwin-<sha12>",
  "message": null
}
```

Errors exit 1 with empty stdout and one `npi-python-error: <message>` line on
stderr. `npi-python-progress {json}` lines on stderr are informational only.

The `python` tool exposes `execute`, `environment` and `packages` actions.
`execute` delegates to the eval Python backend with `kernelMode: "per-call"`:
a fresh `<python> -I -B -u runner.py` process per call, a per-session working
directory (`<base>/workspaces/<sanitized-session-id>`) unless `cwd` is
supplied, a filtered environment, bounded/truncated output, and the normal
SIGINT → SIGTERM → SIGKILL cancellation ladder. `packages install` delegates
to the host and may require approval; the base runtime is never modified.

`<base>` is `NPI_ENV_DIR` when set, otherwise `~/.local/share/npi/env` in the
desktop app. The host creates a content-addressed runtime under `runtimes/`,
an offline `venv` under `environments/default/versions/`, and atomically points
`environments/default/current` at the active version. Both install and
environment creation serialize on `<base>/state/install.lock`. Old runtime
versions are not deleted while sessions may still use them.

When `NPI_PYTHON_HOST` is configured, `omp` does not unpack the archive, does
not create the virtualenv and does not fall back to a system, Homebrew, pyenv,
Conda or project `.venv` interpreter. The default interpreter is the absolute
`pythonPath` returned by the host; an explicit `interpreter` (or
`python.interpreter`) is honored only in Code mode. Chat and Academic
sessions stay on the managed interpreter. Without a host (standalone
CLI/source checkout), `ensureNpiPythonEnv()` returns `undefined`; the managed
environment is simply unavailable, and a discovered system interpreter is not
presented as managed.

## What eval's Python backend is

The `eval` tool executes one Python cell per call inside a retained Python subprocess that speaks NDJSON over stdin/stdout. No Jupyter gateway and no extra pip dependencies are required for the runner itself; install optional libraries (pandas, polars, matplotlib, PIL) separately. The availability probe runs `python -c "import sys;sys.exit(0)"`; it checks that the interpreter starts, not its version or every runner feature. There is no `display()`: `print` and the trailing-expression echo are the output APIs (see [Rich print](#rich-print)).

Current tool input:

```ts
{
  language: "py";
  code: string;    // inline source or a standalone %load / %pip install
  title?: string;
  timeout?: number; // seconds; default 30, 0 disables, otherwise clamped to 1..3600
  reset?: boolean;  // wipe the Python kernel before this call
}
```

The session-scoped wire schema advertises only enabled runtimes ("py" and "js"). Python and JavaScript default on. The tool is `concurrency = "exclusive"` for foreground scheduling. Auto-backgrounding can return while a cell is still running, and kernel-defined tool requests have their own dispatch path; exclusive tool scheduling is not a global kernel lock. State persists across calls in `session` mode.

## Kernel lifecycle

Each Python kernel is a single subprocess: `<resolved-python> -u <runner.py>`. The runner is bundled with the host binary (Bun text import), written to a per-user `omp-python-runner-<uid>` cache under the OS temp directory once per script hash, and reused by subsequent spawns.

Kernel startup sequence:

1. Availability check (`checkPythonKernelAvailability`) — verifies that a Python interpreter resolves and runs.
2. Spawn `python -u runner.py` with filtered env and `cwd`.
3. Send an init request that runs `os.chdir(cwd)`, injects env entries, and adds `cwd` to `sys.path`.
4. Execute `PYTHON_PRELUDE` (idempotent — only initializes once per process).

Kernel shutdown:

- Send `{"type": "exit"}` over stdin.
- Wait for process exit with `SHUTDOWN_GRACE_MS` budget.
- Escalate to `SIGTERM` and finally `SIGKILL` if the process does not exit in time.

## Wire protocol (NDJSON, host ↔ runner)

One JSON object per line, UTF-8, `\n` terminated.

Host → runner:

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "filename": "<optional source path>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

Runner → host:

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "view",     "id": "<reqId>", "text": "...", "view": {"kind": "table"|"json"|"markdown", ...}}
{"type": "image",    "id": "<reqId>", "image": {"mimeType": "...", "data": "<base64>", "detail"?: "...", "url"?: "...", "providerFile"?: {...}}}
{"type": "status",   "id": "<reqId>", "event": {"op": "...", ...}}
{"type": "reply",    "id": "<reqId>", "value": {"ok": true, ...}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

- `view` carries a pretty rendering of `text`, which the cell already printed through `stdout`; the host never adds `text` to the output stream again. The runner flushes buffered stdout before a `view` or `image`, so the text precedes it.
- `image` reaches both the model and the user.
- `status` carries the structured events prelude helpers and magics emit (`_emit_status("find", count=…)`) for the TUI status renderer.
- `reply` answers a tool request (see [Tool availability and mode selection](#tool-availability-and-mode-selection)); `kernel-base.ts` returns it as `KernelExecuteResult.reply`.

## Magics

The runner's source transformer rewrites IPython-style magics to plain Python calls before parsing. Supported set:

| Magic                             | Effect                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `%pip <args>`                     | `python -m pip <args>` with live streaming output; pauses the cell watchdog. In an interpreter without pip (a `uv venv` env), first installs pip with `ensurepip`, or with `uv` (when on `PATH`) if that fails. Newly installed packages are evicted from `sys.modules` so the next `import` picks up the fresh install. |
| `%cd <path>`                      | `os.chdir(path)` (with `~` expansion); emits status event.                                                                                                                                                                                                                                                               |
| `%pwd`                            | Returns `os.getcwd()`.                                                                                                                                                                                                                                                                                                   |
| `%ls [path]`                      | Returns `sorted(os.listdir(path))`.                                                                                                                                                                                                                                                                                      |
| `%env [KEY[=VAL]]`                | List, read, or set env vars (matches prelude `env()` semantics).                                                                                                                                                                                                                                                         |
| `%set_env KEY VALUE`              | Set `os.environ[KEY]`.                                                                                                                                                                                                                                                                                                   |
| `%time <expr>` / `%timeit <stmt>` | `%time` evaluates once; `%timeit` uses `timeit.Timer.autorange()` and reports per-loop timing. Both emit status events.                                                                                                                                                                                                  |
| `%who` / `%whos`                  | List user-namespace names.                                                                                                                                                                                                                                                                                               |
| `%reset`                          | Clear user globals and restore the runner's magic builtins, not the host prelude. Prefer tool input `reset: true` for a fully initialized fresh kernel.                                                                                                                                                                  |
| `%load <path>`                    | Execute a quoted file path in the retained namespace with top-level await and filename-aware tracebacks; does not echo source. A standalone `%load` cell is read by the host instead (supports `local://`).                                                                                                              |
| `%run <path>`                     | `runpy.run_path` and merge globals back.                                                                                                                                                                                                                                                                                 |
| `%%bash`                          | Run the cell body via `bash`. The only registered shell cell magic — `%%sh` does not exist, and unregistered names raise `Cell magic function '%%<name>' not found`.                                                                                                                                                     |
| `%%capture [name]`                | Run body with stdout/stderr captured into `name`.                                                                                                                                                                                                                                                                        |
| `%%timeit`                        | Time the cell body.                                                                                                                                                                                                                                                                                                      |
| `%%writefile <path>`              | Write body to file.                                                                                                                                                                                                                                                                                                      |
| `!cmd` / `var = !cmd`             | Run command via subprocess shell; returns an SList-style result with `.n` / `.s` helpers.                                                                                                                                                                                                                                |
| `var = %name args`                | Assignment forms work for line magics and `!cmd`.                                                                                                                                                                                                                                                                        |

Unknown magic names raise `NameError: UsageError: ...` inside the cell.

## Session persistence semantics

`python.kernelMode` controls retained kernel reuse:

- `session` (default)
   - Reuses kernel sessions keyed by namespaced eval session id plus normalized cwd and interpreter.
   - Multiple owners can share the same retained kernel for that key.
   - Foreground calls through the tool use exclusive scheduling; background cells and kernel-defined tool requests are separate.
   - A dead retained subprocess is replaced before execution.
   - If the subprocess dies during execution, the cell is not replayed because completion is uncertain. The next call starts a fresh kernel.
- `per-call`
   - Spawns a fresh subprocess for each call.
   - Shuts the subprocess down after the call.
   - No cross-call state persistence.

### State across eval calls

Each tool call contains one cell, and later calls reuse the selected retained kernel in `session` mode. Await an auto-backgrounded cell's completion before depending on its mutations. Concurrent resets for the same retained-session key coalesce; calls behind a reset wait for it.

If a cell fails, definitions and mutations completed before the error can remain in kernel memory. `reset: true` resets only the selected language runtime before that call; other language runtimes are untouched.

The host reapplies the session cwd before each cell and puts it first on `sys.path`. `%cd` or `os.chdir()` affects the rest of that cell, not the starting cwd of the next tool call. File-backed `%load` also sets `__file__` and adds the script directory to `sys.path`.

Cells support top-level `await`, `async for`, and `async with` on a persistent asyncio event loop. Use top-level `await` rather than `asyncio.run()`, which cannot start a second loop in that thread. The last non-`None` expression is echoed like printing its `repr`, with the same images and views as `print`.

## Environment filtering and runtime resolution

Environment is filtered before launching the runner:

- Allowlist includes core vars like `PATH`, `HOME`, locale vars, `VIRTUAL_ENV`, `PYTHONPATH`, etc.
- Allow-prefixes: `LC_`, `XDG_`
- Denylist strips common API keys (OpenAI/Anthropic/Gemini/etc.)
- Eval injects its own `PI_SESSION_FILE`/bridge variables explicitly after
  filtering; ambient `PI_*` values are not forwarded

When `NPI_PYTHON_HOST` is configured, the desktop host is the default runtime
for Python execution. The availability probe stays cheap: it considers only
the managed interpreter and never runs the host, unpacks the archive or builds
an environment at session startup. `PythonKernel.start` calls
`ensureNpiPythonEnv()` on the first actual invocation, and the absolute
`pythonPath` it returns is used directly. The host's managed environment wins
over any local venv or `PATH` interpreter; a system/project interpreter is not
substituted when the host fails. `python.interpreter` is an explicit override
only in Code mode.

For a standalone CLI or source checkout without a host, runtime selection order
is (skipped entirely when the `python.interpreter` setting names an explicit
executable):

1. Active/located venv (`VIRTUAL_ENV`, then `CONDA_PREFIX`, then `<cwd>/.venv`, `<cwd>/venv`)
2. Managed venv at `~/.omp/python-env`
3. `python` or `python3` on PATH

Candidates are probed in order until one runs; a broken venv does not automatically shadow a working later candidate. The selected working runtime is cached for that cwd/interpreter key. An explicit interpreter is a path (with `~` expansion and relative paths resolved against session cwd), not a PATH-search command name.

When a venv is selected, its bin/Scripts path is prepended to `PATH`. The managed venv path follows the configured OMP data root; `~/.omp/python-env` is the standalone default. Under the desktop host, the environment instead comes from the host's `<base>/environments/default/versions/` path.

The runner additionally receives `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` so streamed output reaches the host promptly.

Session/bridge context is patched before each cell through `PI_SESSION_FILE`, `PI_ARTIFACTS_DIR`, `PI_TOOL_BRIDGE_URL`, `PI_TOOL_BRIDGE_TOKEN`, `PI_TOOL_BRIDGE_SESSION`, and `PI_EVAL_LOCAL_ROOTS`. Missing managed entries are removed from `os.environ`; unrelated environment mutations remain.

## Tool availability and mode selection

The backend settings `eval.py` / `eval.js` default to `true`. Optional boolean environment flags `PI_PY` and `PI_JS` override their corresponding setting independently. `eval.tools.enabled` also defaults to `true`; turning it off removes the `tools` spawn fields and kernel-defined-tool guidance.

The tool's session-scoped schema lists only enabled runtimes. If Python preflight fails while another runtime is enabled, `eval` remains available for that runtime and a `py` call reports a Python-backend availability error with enabled alternatives.

Python prelude helpers include `agent(prompt, *, agent=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, tools=None)`, which registers a background subagent job and returns an `AgentHandle` (`.id`, `.handle` = `agent://<id>`, `.status`, `.done()`, `.wait(timeout=None)`, `.send()`, `.cancel()`, `.output()`, awaitable). `completion(...)` likewise returns a `CompletionHandle`. `wait(handles, timeout=None, raise_errors=True)` barriers over handles in input order. `workpool(...)` returns a `WorkPool` (`push`, `status`, `peek`, `close`); its name is the aggregate async-job id; results auto-deliver, and the zero-argument `wait` tool blocks only when nothing else remains to do. `tool.<name>(args)` is a coroutine (`await tool.read({...})`); `@tool` registers a kernel-local function as a tool for subagents (schema inferred from type hints) when `eval.tools.enabled` is on.

The runner accepts a `{"type": "tool", "id", "op": "describe"|"call", ...}` request alongside cell requests. It is served on a dedicated daemon thread (POSIX; between cells on Windows) against the kernel's `__omp_tools__` registry, replies with a `reply` frame (`{ok, tools, missing}` or `{ok, value}`), and reports a raising tool as an `error` frame without touching the running cell. See [Eval tool](./tools/eval.md) for the caller-facing contract.

## Execution flow and cancellation/timeout

### Cell timeout

`timeout` is in seconds and defaults to 30. `0` disables the cell timeout; nonzero values are clamped to `1..3600` seconds and by a positive `tools.maxTimeout` ceiling before being passed to `IdleTimeout`. The timeout is suspended while a host-side `wait()` on `agent()` / `completion()` handles is in flight: those calls emit reference-counted pause/resume events through `withBridgeTimeoutPause`, and a fresh timeout window begins when control returns.

The pause/resume events are the sole mechanism that suspends the budget; `%pip` emits them while pip runs too. Compute, `stdout`/`stderr`, `log()`/`phase()`, and ordinary tool calls count against it. The tool combines caller, session, and watchdog abort signals with `AbortSignal.any(...)`; the backend does not arm a competing deadline. Backend availability discovery is also bounded by the cell's resolved timeout and cancellation signal.

### Auto-backgrounding

`eval.autoBackground.enabled` (default `false`) allows a cell to become a managed eval job after `eval.autoBackground.thresholdMs` (default 60,000 ms), or earlier when a steering message arrives. A cell that finishes within the foreground wait returns normally. At job-manager capacity, execution stays foreground. Backgrounding does not extend or disable the cell watchdog.

### Kernel execution cancellation

On abort/timeout:

- The host sends `kill("SIGINT")` to the runner subprocess.
- The runner's exec-time signal handler raises `KeyboardInterrupt` inside the user code.
- Result includes `cancelled=true`; a kernel timeout is annotated as `eval cell timed out after <n>s; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`
- Between requests the runner installs `SIG_IGN` for SIGINT so a stray cancel does not tear down the kernel.

If the runner does not emit `done` within 5s of the interrupt (`INTERRUPT_ESCALATION_MS` — e.g. stuck in C code holding the GIL), the host shuts the subprocess down (escalating `exit` → `SIGTERM` → `SIGKILL`), the cell is annotated as kernel-killed, and the kernel is recreated on the next call.

### stdin behavior

Interactive stdin is not supported: the host's NDJSON control channel arrives on the runner's original stdin, which the runner moves to a private descriptor at startup before pointing fd 0 at the null device. `input()` and `sys.stdin` reads in user code see immediate EOF, as does every process started without an explicit stdin, so none of them can consume control frames. Built-in pip and shell magics also pass `DEVNULL` explicitly.

## Output capture and rendering

### Captured output classes

From runner frames:

- `stdout` / `stderr` → plain text chunks (all the model sees as text)
- `view` → a user-facing rendering of text already in the stream
- `image` → image payloads for the model and the user
- `error` → traceback text
- `status` → structured status events

### Rich print

The runner replaces `builtins.print`. When it prints to the cell's stdout, each argument is classified; any other `file` (for example `sys.stderr`, or a redirected `sys.stdout`) gets the stock `print`. The trailing-expression echo applies the same classification to `repr(value)`.

| Value                                                                                                          | Text in the output  | Extra frame     |
| -------------------------------------------------------------------------------------------------------------- | ------------------- | --------------- |
| `{"type": "image", "mimeType", "data": str\|bytes, "detail"?, "url"?, "providerFile"?}`                        | `<image MIME>`      | `image`         |
| matplotlib `Figure` (PNG, `bbox_inches="tight"`), `PIL.Image.Image`, objects with `_repr_png_` / `_repr_jpeg_` | `str` / `repr`      | `image`         |
| objects (not classes) with `_repr_markdown_`                                                                   | the Markdown source | `markdown` view |
| pandas `DataFrame` / `Series`, polars `DataFrame` / `Series`                                                   | `str` / `repr`      | `table` view    |
| `dict` / `list` / `tuple` whose text exceeds 80 chars or spans lines                                           | `str` / `repr`      | `json` view     |

- Table views follow the library's own truncation (`display.max_rows` / `min_rows` / `max_columns`, including pandas' terminal-width fitting; polars `tbl_rows` / `tbl_cols`), so the view shows the rows and columns the text shows. Elided rows and columns become `…` cells. Index levels are leading columns; MultiIndex column labels are joined with `/`. Columns are marked `numeric` by dtype (bool is not numeric). pandas and polars are detected through `sys.modules`, never imported.
- JSON views turn integers beyond ±2^53 into decimal strings and other non-JSON leaves into `str()`. Subclasses that customise their text (namedtuple, `OrderedDict`) get no view.
- A probe that raises never breaks the print; the value just prints as text.

### Matplotlib

The runner sets `MPLBACKEND=Agg` as an environ default so figures render off-screen. After every cell, remaining figures are emitted as PNG `image` frames (with no text) and closed. Figures already printed or echoed in that cell are closed without a duplicate image.

### Storage and truncation

Output is streamed through `OutputSink` in `packages/tui/src/tools/streaming-output.ts`. The default inline body budget is 50 KiB shared by retained head and tail, with middle elision and a per-line byte cap (`tools.outputMaxColumns`). Full sanitized text can spill to an uncapped artifact. Tool results include truncation metadata and `artifact://<id>` when persistence succeeds; an artifact I/O failure is reported separately and suppresses that ID.

### Renderer behavior

- Tool renderer (`packages/tui/src/tools/eval.ts`):
   - shows code-cell blocks with per-cell status
   - collapsed preview defaults to 10 lines
   - supports expanded mode for all output retained in the tool result
- Interactive renderer (`eval-execution.ts`):
   - used for user-triggered Python execution in TUI
   - collapsed preview defaults to 20 lines
   - clamps very long individual lines to 4000 visible columns for display safety
   - shows cancellation/error/truncation notices

## Operational troubleshooting

- **Python backend not available** — In the desktop app, check that `NPI_PYTHON_HOST` points at the app executable and that the first `ensure` succeeded. In a standalone CLI, check `eval.py`, `PI_PY`, and that `python`/`python3` is on PATH. If another backend is enabled, use its advertised language token.
- **No working Python** — In the desktop app the runtime is installed by the host on the first action; a configured host that cannot provision exits it with `npi-python-error` and no system interpreter is substituted. In a standalone CLI, install a modern Python 3, configure `python.interpreter`, or place a compatible venv at the managed Python path (default `~/.omp/python-env`). `omp setup python --check` reports the resolved interpreter.
- **Host provisioning fails** — Read the `npi-python-error` message. In a source checkout set `NPI_PYTHON_RESOURCE_DIR` to the directory holding `python-runtime-manifest.json` and the archive; the default resource directory is the app's `../Resources`. Digest mismatch or an unsupported platform requires rebuilding the bundle, not forcing an interpreter.
- **Execution hangs then times out** — Increase `timeout` for legitimate work or set it to `0` to disable the watchdog. For stuck native code, cancellation sends `SIGINT` first and then escalates; session mode recreates the kernel on the next request if it had to be killed.
- **stdin/input prompts in Python code** — `input()` is not supported; pass data programmatically.
- **Working directory errors** — Python starts each cell in the session cwd. Use `%cd` or `os.chdir()` within the cell when needed; the next call starts back in the host session cwd.

## Relevant environment variables

- `NPI_PYTHON_HOST` — absolute NPi Desktop executable; set by the app for every spawned `omp`, enables the managed runtime host
- `NPI_PYTHON_RESOURCE_DIR` — directory holding the bundled manifest/archive for a host launched from a source checkout
- `NPI_ENV_DIR` — overrides the host runtime/environment base (default `~/.local/share/npi/env`)
- `PI_PY` / `PI_JS` — per-backend exposure overrides
- `PI_PYTHON_SKIP_CHECK=1` — bypass Python preflight/warm checks
- `PI_PYTHON_INTEGRATION=1` — enable gated integration tests that spawn a real Python
- `PI_PYTHON_IPC_TRACE=1` — log NDJSON frames exchanged with the runner subprocess
