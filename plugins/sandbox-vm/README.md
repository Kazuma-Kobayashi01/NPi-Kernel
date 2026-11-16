# Sandbox VM

Runs the `bash` tool's commands in a local Linux virtual machine instead of on this machine. An NPi plugin: it uses `pi.registerExecBackend` (see `omp/docs/extensions.md`, "Exec backends"); nothing here is built into the kernel.

## Use

```sh
# the package (.npix) ships the helper and both guest images: install it and go
npi plugin install npi-plugin-sandbox-vm-1.0.1.npix                                        # or Settings → Extensions → Plugins

# to make the package (from the omp checkout; NPi Desktop keeps packages in ../dist/extension)
plugins/sandbox-vm/helper/build.sh                  # the helper, signed with the virtualization entitlement
plugins/sandbox-vm/scripts/build-image.sh           # Alpine -> ~/.local/share/npi/sandbox-vm/image (downloads roughly 60 MB)
plugins/sandbox-vm/scripts/build-image.sh ubuntu    # Ubuntu 24.04 -> .../image-ubuntu (about 200 MB of downloads)
plugins/sandbox-vm/scripts/pack.sh                  # -> ../dist/extension/npi-plugin-sandbox-vm-<version>.npix, images inside (about 110 MB)

/vm on                             # bash now runs in the VM; eval, python and debug are off
/vm status | start | stop | off
/vm permissions                    # the permissions panel: network, project access, read-only folders, cores, memory, idle stop
/vm base [alpine|ubuntu]           # show or select the Linux the VM boots (stops the VM; the next command boots the new one)
/vm reclaim [alpine|ubuntu|all]    # stop the VM and delete the images built on this machine (the selected base by default); the plugin and its packaged images stay
```

In NPi Desktop the same switch is Settings → Approvals → Command backend; it sets `exec.backend` for new tabs.

`/vm on` sets `exec.backend` for this run only. Persist it with `npi config set exec.backend sandbox-vm/default`. If that is set and the plugin is not loaded, `bash` refuses to run instead of falling back to this machine.

## Bases

The VM boots Alpine (default, about 70 MB, musl) or Ubuntu 24.04 LTS (about 110 MB on disk, glibc, apt packages). `base` in `sandbox-vm.json`, `/vm base`, RPC `sandbox-vm/set-base` and Desktop's Settings → Approvals → Sandbox VM system select it; switching stops the VM and the next command boots the new root. Each base has its own image folder, so both can be built side by side; a base whose image is missing fails with the `build-image.sh` call to make. Both boot the same Alpine kernel (its modules are copied into the root): the userland is the distribution's, the kernel is not. The Ubuntu root drops `/usr/share/{doc,man,info,locale}`, since it lives in RAM; measured after boot with a 2 GiB guest: 336 MB used, 257 MB of root files.

## Images

The package carries both images (`images/alpine`, `images/ubuntu`, put there by `scripts/pack.sh`), so nothing has to be built or downloaded after installing it. The VM boots, in this order: the settings' `image` folder, an image built on this machine (`~/.local/share/npi/sandbox-vm/image[-ubuntu]`, what `scripts/build-image.sh` writes), then the packaged one. Building your own therefore overrides the package without touching it. `npi plugin uninstall` removes the packaged images with the plugin.

## Reclaiming

`/vm reclaim [alpine|ubuntu|all]` (RPC `sandbox-vm/reclaim` with `{ base }`; `sandbox-vm/image` reports each base's size first) stops the VM, sends `bash` back to this machine for the run, and deletes the guest image built on this machine for that base (the selected one by default; a packaged image is part of the plugin and stays until it is uninstalled): only `Image`, `rootfs.cpio.gz` and `manifest.json`, so a custom `image` folder keeps any other file, and empty folders are removed. The VM has no persistent disk, so nothing else is left behind. If `exec.backend` is persisted as `sandbox-vm/default`, the command warns: set it back with `npi config set exec.backend ""`, or `bash` refuses to run. Rebuild the image with `scripts/build-image.sh` to use the VM again; to remove the plugin as well, `npi plugin uninstall @npi/plugin-sandbox-vm`.

## Terminal

`sandbox-vm/terminal` starts the VM and returns `ready: true`; NPi Desktop's terminal panel calls it for a tab whose commands run in the VM and then attaches to an interactive bash in the guest. The helper listens on a unix socket (`terminalSocket` in its start config, `<tmp>/npi-vm-routes/<omp pid>.sock`, owner only, peer uid checked) and publishes `<omp pid>.json` with its own path next to it (`src/terminal-route.ts`); `npi-vm-helper attach <socket> [--cwd DIR]` puts its terminal in raw mode, relays it to a pty in the guest (`pty-open|input|resize|close` ops of `guest/agent.py`, answered with `pty` and `pty-exit` lines) and exits with the shell's exit code. The shell is `bash -i` as root in the project folder; like everything else in the guest it is gone at the next stop. Images built before the terminal existed say so in the terminal: rebuild them.

## Permissions

What the VM may do is a short list, edited in the TUI with `/vm permissions` (a selector per permission) and in NPi Desktop under Settings → Approvals → Sandbox VM permissions; both write `<agent dir>/sandbox-vm.json` through the same checks (`src/permissions.ts`): **network** (`off` | `nat`), **project folder** (`projectAccess`: `read-write` | `read-only`, which only changes what commands in the VM can do: the file tools run on this machine either way), **extra read-only folders** (`readOnlyMounts`; each must be an existing folder), **cores** (`cpus`, 1 to this machine's count), **memory ceiling** (`memoryMiB`, 512 MiB to 64 GiB) and **idle stop** (`idleStopMinutes`). RPC: `sandbox-vm/permissions` reads them (with this machine's limits and whether the VM runs), `sandbox-vm/set-permissions` with `{ changes, restart? }` changes them. They apply when the VM starts: a running VM keeps its old ones until it restarts, which the panels offer (`restart: true` stops it; the next command boots it with the new ones). Turning the network on asks for confirmation in the TUI.

## CPU and memory

The VM gets up to 8 cores and 8 GiB by default (`cpus`, `memoryMiB`; the helper caps them at what the host allows). The memory is elastic in the one way macOS offers: Virtualization.framework commits guest memory on the host only as the guest touches it, so a freshly booted VM holds about 480 MB of the host (measured, 8 GiB configured) and grows with what commands use, up to the ceiling. It does not shrink while the VM runs: a memory balloon was tried and, with this framework, neither takes the pages back (host footprint unchanged after inflating the balloon over all free memory) nor reports free pages, so none is configured. Memory is returned when the VM stops, which `idleStopMinutes` (15) does after the last command; lower it, or `/vm stop`, to give memory back sooner. Setting both values high on a small Mac lets a runaway command squeeze the host: lower `memoryMiB` there.

## What runs where

| In the VM | Still on this machine |
|---|---|
| `bash` commands (each agent session keeps its own shell; background jobs get their own) | the file tools (they act on the mounted project folder), MCP servers, the browser and computer-use tools, user `!` commands |

The project folder is mounted read-write at the **same absolute path** in the guest, so cwd and the paths in output agree. Extra folders can be mounted read-only. The guest has no network until `network` is `nat`. Only the call's own environment variables reach the guest, never this machine's environment.

## Settings

`<agent dir>/sandbox-vm.json`, all optional: `memoryMiB` (8192), `cpus` (8), `network` (`off` | `nat`, default `off`), `base` (`alpine` | `ubuntu`, default `alpine`), `image` (the folder `build-image.sh` wrote for the selected base), `helper`, `readOnlyMounts` (absolute paths), `idleStopMinutes` (15; 0 keeps the VM up). `NPI_VM_HELPER` overrides `helper`.

## The VM helper and the guest

The plugin does not touch the hypervisor. `bin/npi-vm-helper` (built from `helper/main.swift` by `helper/build.sh`, signed with the `com.apple.security.virtualization` entitlement; `NPI_VM_SIGN_IDENTITY` picks another signing identity than ad hoc) owns the machine and speaks the protocol in `src/protocol.ts` (JSON lines on stdin/stdout). Keeping it a separate signed process is what leaves the NPi Desktop signing untouched.

The guest is the Alpine aarch64 kernel with a root filesystem (Alpine, or Ubuntu 24.04) held in RAM (an initramfs), so it starts in about 1.5 s and nothing in it survives a stop: packages installed at run time are gone next boot. Add packages to `guest/packages.txt` (Alpine) or `guest/packages-ubuntu.txt` and rebuild the image instead. A command agent (`guest/agent.py`) answers the helper over a second virtio console port; the project is mounted by virtio-fs at the same absolute path as on the host (read-write), extra folders read-only. The kernel and the packages come from Alpine's own mirrors; the kernel files and the minirootfs are pinned by SHA-256 in `scripts/build-image.sh`, the packages are verified by `apk`'s signatures.

`test/fake-helper.ts` is a reference implementation of the helper protocol that runs commands with `sh` on the host, used by the unit tests. `test/real-vm.test.ts` runs the real helper and image (skipped without them), `test/installed.test.ts` packs, installs and starts the VM from the installed copy with a compiled kernel (`NPI_BIN=…/dist/npi`).

## Limits

- macOS on Apple silicon only (Virtualization.framework, aarch64 guest).
- The root is RAM: a guest has the memory you give it (8 GiB default, a ceiling, see Memory) minus about 180 MB for the system and the root files (measured right after boot: 77 MB used, 100 MB of root files); what a command writes outside the mounted folders is held in memory too, and is gone at the next stop.
- File metadata over virtio-fs is slower than on the host (about 3x for a walk of 56,000 files, one rough run).
- Not routed to the VM, as for any exec backend: the file tools, MCP servers, the browser and computer-use tools, user `!` commands, loop conditions and autoresearch. `eval`, `python` and `debug` are switched off while the VM is the backend.
- Not done: an on-demand image download (the image is built locally), a persistent disk, cleaning up `:async:` job state in the guest before the session ends.
