Run Python code and inspect the NPi managed Python environment.

<actions>
`execute` — run `code` in the desktop-managed environment through the eval Python subprocess backend. Each call gets a fresh interpreter process (isolated mode `-I`, no bytecode writes `-B`), runs in `cwd` (default `<NPI_ENV_DIR>/workspaces/<session-id>`), and inherits only safe environment variables. `timeout` is in seconds (default 60; `0` disables the deadline). On timeout or abort the process tree is killed. `executionId` is generated when omitted.
`environment` — report the managed runtime's health, its Python and uv versions, and the interpreter, environment, runtime, cache, and workspace paths. This action never installs or rebuilds anything.
`packages` — `operation: "list"` returns installed distributions; `operation: "install"` installs `packages` into the managed environment. Installs change only the managed environment, never the immutable base runtime.
</actions>

<notes>
- The desktop app owns installation: the runtime host unpacks the bundled CPython once and versions each managed environment. There is no system-Python fallback and no project virtualenv is created.
- `interpreter` is honored only in Code mode, only when the session's `python.interpreter` setting names that same executable. Otherwise it is rejected.
- `packages` install requires approval; `environment` and `packages` list are read-only.
</notes>

<examples>
```json
{ "action": "execute", "code": "import sys; print(sys.version)" }
```
```json
{ "action": "packages", "operation": "install", "packages": ["numpy", "pandas"] }
```
</examples>
