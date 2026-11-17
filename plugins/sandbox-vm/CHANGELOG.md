# Changelog

## [Unreleased]

### Fixed

- A failed VM start no longer leaves every later command failing with "the VM is error" until the idle stop: the next command starts a fresh VM.
- The idle stop no longer shuts the VM down under an open terminal, and a VM started only for a terminal (or by hand) now stops after its idle time too.
- A program in the terminal that does not read its input (pasting into `sleep`, say) or a terminal client that reads slowly no longer stalls the agent's commands, cancels and `/vm stop`.
- `/vm stop` now answers when the guest cannot be asked to power off (it did not come up, or ignored the request) instead of hanging.
- Terminal connections close their socket exactly once, and a terminal that went away can no longer take the helper (and the VM) down with it.
- A variable passed with a command now wins over the value an earlier command of the session saved; commands of one session that end together no longer write into each other's saved state or working directory.
- A command killed by a signal nobody sent (the OOM killer, say) reports exit code 128 + signal instead of "cancelled".
- Background jobs and commands without a session no longer leave state folders behind in the guest's memory.
- Moving the session to another folder remounts the project at the next command when nothing else uses the VM.
- The guest agent must be rebuilt into the images (`scripts/build-image.sh`) for the fixes it carries: the terminal input, the variables, the exit codes and the state folders.

## [1.0.2] - 2026-11-16

- `/vm clean` (asks first) and RPC `sandbox-vm/clean`: for removing the VM. Stops it, unsets a global `exec.backend` that names it (so bash keeps working after the plugin is uninstalled), deletes every image built on this machine, `sandbox-vm.json` and the terminal routes of dead processes, and reports the size of the images the package ships (they go with `npi plugin uninstall`). NPi Desktop's Settings → Approvals → Remove Sandbox VM calls it and uninstalls the plugin.

## [1.0.1] - 2026-11-16

- The permissions panel: `/vm permissions` in the TUI and Settings → Approvals → Sandbox VM permissions in NPi Desktop (network, project folder read-write or read-only, extra read-only folders, cores, memory ceiling, idle stop), RPC `sandbox-vm/permissions` and `sandbox-vm/set-permissions`, and the setting `projectAccess`. Changes are validated, saved, and apply at the next VM start.
- Stale route files of dead processes are removed when a VM publishes its own.

## [1.0.0] - 2026-11-16

- The VM defaults to 8 cores and up to 8 GiB (was 2 and 2 GiB). The host commits guest memory only as it is used (about 480 MB right after boot) and gets it back when the VM stops; a balloon was measured and does not return memory with Virtualization.framework, so there is none. The helper caps memory at the framework's maximum.

- The package ships both guest images (`images/alpine`, `images/ubuntu`), made by `scripts/pack.sh`: install it and the VM boots, nothing to build or download. An image built on this machine, or the settings' `image`, takes precedence over the packaged one; `/vm reclaim` deletes only what was built here. `status` reports `bundled` per base.

### Added

- A terminal in the VM: `sandbox-vm/terminal`, the helper's terminal socket and `attach` mode, and `pty-*` ops in the guest agent (an interactive bash on a pty, resize and exit code carried). NPi Desktop's terminal panel uses it for a tab whose commands run in the VM. The helper config has `terminalSocket`; the plugin publishes `<tmp>/npi-vm-routes/<omp pid>.json` while the VM runs. Images need a rebuild to get it.

- A choice of Linux base, `alpine` (default) or `ubuntu` (24.04 LTS, glibc and apt): `base` in `sandbox-vm.json`, `/vm base`, RPC `sandbox-vm/set-base`, and `scripts/build-image.sh [alpine|ubuntu]` (the Ubuntu root comes from the pinned ubuntu-base plus `apt` in a chroot of the build VM, packages in `guest/packages-ubuntu.txt`). One image folder per base; `status` and the state event carry `base`, and `/vm reclaim` takes `alpine|ubuntu|all`.
- The guest init finds `tini` and the DHCP script wherever the root keeps them, and the agent powers the guest off with `reboot(2)`, so one init serves both roots.
- `/vm reclaim` and the RPC commands `sandbox-vm/reclaim` and `sandbox-vm/image`: stop the VM, send `bash` back to this machine and delete the guest image (only the files `build-image.sh` wrote; empty folders go too), warning when `exec.backend` is still persisted as the VM.
- The VM helper (`helper/`, Swift, Virtualization.framework) and the guest: Alpine aarch64 with bash, git, python3, curl, ripgrep and make in a RAM root, started in about 1.5 s; its command agent (`guest/agent.py`) runs commands over a virtio console port, keeps exported variables and functions per session, kills a cancelled or timed-out command's whole process group, and mounts the project at the host's own path. `scripts/build-image.sh` builds the image from Alpine's own files (hash-pinned) and packages.
- The network is off by default (no network device) and `nat` gives the guest the host's connection; the VM stops itself after `idleStopMinutes` (default 15) without commands and starts again on the next one.
- The `sandbox-vm/default` exec backend: `bash` commands run in a local Linux VM with the project folder mounted at the same path. `/vm` (status, start, stop, on, off) and the RPC commands `sandbox-vm/status|start|stop|set-backend` with `sandbox-vm/state` events.
- While the VM is the backend, `eval`, `python` and `debug` are switched off, since they would run the same code on the host; they come back when it stops being the backend.
- The VM helper protocol (`src/protocol.ts`), a line-delimited JSON protocol for the process that owns the machine; settings in `<agent dir>/sandbox-vm.json` (memory, CPUs, network, image, read-only mounts).
