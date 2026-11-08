Inspect and manage the NPi managed Python environment. To run Python code, use `eval`: its Python backend already runs in this environment.

<actions>
`environment` — report the managed runtime's health, its Python and uv versions, and the interpreter, environment, runtime, cache, and workspace paths. This action never installs or rebuilds anything.
`packages` — `operation: "list"` returns installed distributions; `operation: "install"` installs `packages` into the managed environment. Installs change only the managed environment, never the immutable base runtime.
</actions>

<notes>
- The runtime host owns installation: it unpacks the bundled CPython once and versions each managed environment. There is no system-Python fallback and no project virtualenv is created.
- `packages` install requires approval; `environment` and `packages` list are read-only.
</notes>

<examples>
```json
{ "action": "environment" }
```
```json
{ "action": "packages", "operation": "install", "packages": ["numpy", "pandas"] }
```
</examples>
