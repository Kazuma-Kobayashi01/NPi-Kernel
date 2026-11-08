# Process sandbox (macOS)

Approval mode decides when you are asked; it does not contain what an approved
command does. The process sandbox does: on macOS, `npi` relaunches itself under
a Seatbelt profile (`/usr/bin/sandbox-exec`) that denies file writes outside a
list of writable folders. Seatbelt rules are inherited by every child, so the
embedded shell's external programs, `eval` kernels, the file tools (`write`,
`edit`, …), MCP servers and anything they start are all covered.

Code: `packages/coding-agent/src/sandbox/` (`settings.ts`, `seatbelt.ts`); the
relaunch runs in `main.ts` right after the project directory is resolved,
before stdin is read or any storage is opened.

## Turning it on

| Where | Value |
|---|---|
| `sandbox.mode` setting | `off` (default), `workspace-write`, `read-only` |
| `--sandbox <mode>` flag | same values; wins over the setting for this launch |
| `sandbox.writableRoots` setting | extra folders the sandbox may write (`~/…` or absolute) |

The mode applies to agent runs (interactive, `-p`, RPC, ACP), not to
subcommands such as `npi update`. Inside the sandbox `NPI_SANDBOX_ACTIVE` names
the mode, which also stops a second relaunch.

## What may be written

| Folder | `workspace-write` | `read-only` |
|---|---|---|
| The project directory and its git repository (for a linked worktree also its private and shared git directories) | yes | no |
| npi's own folders: config/data root, agent dir, logs, `~/.cache/npi`, managed Python (`NPI_ENV_DIR`), daemon runtime, XDG overrides | yes | yes |
| `/private/tmp`, `/private/var/folders`, `$TMPDIR`, `/dev` | yes | yes |
| `sandbox.writableRoots` | yes | yes |
| Everything else | no | no |

Reads and network access are not restricted: the agent needs the model API,
and the sandbox exists to contain writes. A denied write fails with
`Operation not permitted` (shell) or `EPERM` (file tools), which the model sees
as the tool result. Package managers that write their caches under the home
folder (`~/.bun`, `~/.cargo`, `~/.npm`) need those caches in
`sandbox.writableRoots`.

All roots are resolved through `realpath` (Seatbelt matches real paths:
`/tmp` is `/private/tmp`) and passed to `sandbox-exec` as `-D` parameters, so a
folder name never needs escaping inside the profile.

## Platforms

Only macOS has the Seatbelt sandbox. An explicit `--sandbox` on another
platform exits with an error instead of running unsandboxed; a `sandbox.mode`
setting there is logged and skipped, since config files are shared between
machines.

## Limits

- `sandbox-exec` is deprecated by Apple but still shipped and used by other
  coding agents; a future macOS could remove it.
- Programs that apply their own Seatbelt profile (Chromium's renderer sandbox)
  may refuse to start inside another one.
- The sandbox does not isolate processes or the network. For that, a virtual
  machine is the next step.
