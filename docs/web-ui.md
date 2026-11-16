# Web UI (`/web`)

`/web` lets a browser on the LAN drive the session a terminal is running. It is for a session on a headless Linux server that someone wants to follow and steer from a laptop or phone. It works like `/rc`, but it needs no pairing or phone app, and it serves exactly one session.

It turns on only when someone types `/web` in an interactive session. No setting, flag or Desktop toggle starts it.

## Usage

| Command                           | Effect                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/web`                            | Serve on `0.0.0.0:8787` over plain HTTP, or on a free port if 8787 is taken. Prints one link per LAN IPv4 address. |
| `/web --listen <host:port>`       | Bind elsewhere, e.g. `--listen 127.0.0.1:9000` for SSH tunnels only (`:0` picks a free port).    |
| `/web --tls`                      | Serve HTTPS with a self-signed certificate (see below). Can be combined with `--listen`.        |
| `/web status` (or `/web` while on) | Print the links again and the number of open pages.                                             |
| `/web stop`                       | Stop the server and disconnect every page.                                                      |

While it is on, a green `/web` shows at the right end of the home footer and the status line (next to `/rc` if that is on too). The server stops when the session ends (`/exit`, Ctrl+C, closing the terminal).

## What the page can do

The page has only the Code view of the session:

- the transcript, rebuilt from history when the page opens and then streamed live (assistant text, thinking, tool calls with their arguments and output);
- send a prompt, or while a turn runs, **Steer** it or **Queue** a follow-up; **Stop** aborts the turn;
- answer tool approvals and other dialogs (`select`, `confirm`, `input`, `editor`, and `ask` forms). Dialogs show in the terminal and on every open page; the first answer wins and withdraws the rest.

The page is locked to this one session. It has no session list, cannot start, open, switch, fork or branch sessions, and cannot change the model, thinking level, profile or settings. It cannot run shell commands or read files on the host. The server enforces this with an allow-list (`prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `remove_queued_message`, `get_state`, `get_messages`, plus dialog answers) and refuses everything else. Commands carry text only; images are not accepted from the page.

Anything the terminal does to the session, such as `/new` or `/model`, the page follows, because it is attached to the terminal's session.

## Access

Each `/web` start makes a new random 128-bit token. The printed link carries it (`http://host:8787/?t=<token>`). Opening the link swaps the token for an HttpOnly, `SameSite=Strict` cookie and redirects to `/`, so the token leaves the address bar. Requests for the page, its assets and the WebSocket without that cookie get `401`. The WebSocket also requires an `Origin` that matches the `Host`, so another site open in the same browser cannot use the cookie. Anyone with the link can drive the session until `/web stop`, so share it like a password.

The page is served with a strict Content-Security-Policy (no inline scripts, same-origin connections only), `no-referrer`, and `no-store`. At most 16 pages can be open at once. Inbound frames are capped at 256 KB and prompts at 100,000 characters. Outbound frames drop image data and cut strings over 32 KB, and streamed message updates are coalesced to one every 80 ms per page.

## TLS

Plain HTTP is the default: it needs no setup, and the token still guards access, but traffic on the LAN is readable. `/web --tls` serves HTTPS instead. The first time, it makes a self-signed certificate with the system `openssl` (subject alternative names: `localhost`, `127.0.0.1` and the current LAN addresses). It keeps the certificate as `web/cert.pem` and `web/key.pem` (mode 0600) under the agent dir and reuses it afterwards. Browsers warn about a self-signed certificate once per device. Delete the two files to make a new certificate, for example after the server's addresses change. If `openssl` is missing, `/web --tls` reports that and does not start.

## How it works

- `src/web-ui/web-ui.ts`: the `/web` lifecycle. It runs an RPC server inside this process over the live session (`embeddedRpcProcess`, the same one `/rc` uses) and drives it with an `RpcClient`. It also registers as a guest dialog peer next to collab guests and `/rc`.
- `src/web-ui/web-server.ts`: `Bun.serve` for HTTP(S) and the WebSocket, cookie auth, the command allow-list, bounded frames and pending-dialog tracking (`PendingDialogTracker`, shared with `/rc`).
- `src/web-ui/assets/`: `index.html`, `app.js` and `app.css`, plain files with no build step. They are imported as text and embedded in the compiled `npi` binary, so a single binary on a Linux server is enough.

WebSocket protocol (JSON text frames):

- server → page: `hello` (cwd, trimmed state, message history, pending dialogs), `event` (session events, `prompt_result`, `session_settled`), `ui` (dialog requests), `ui_resolved`, `result` (reply to a request carrying `reqId`), `error`.
- page → server: `{ kind: "rpc", reqId, command }`, where `command` is one of the allow-listed commands, and `{ kind: "ui_response", reqId, response }`.
