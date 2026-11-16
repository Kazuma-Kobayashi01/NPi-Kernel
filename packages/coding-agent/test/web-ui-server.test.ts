import { afterEach, describe, expect, it } from "bun:test";
import type { RpcCommand, RpcResponse, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { WEB_COOKIE, WebSessionServer, type WebSessionLink } from "@oh-my-pi/pi-coding-agent/web-ui/web-server";

const TOKEN = "test-token-0123456789";

/** An RPC link over no real session: records the commands the server forwards. */
function fakeLink() {
	const sent: RpcCommand[] = [];
	const link = {
		onSessionEvent: () => () => {},
		onExtensionUIRequest: () => () => {},
		onPromptResult: () => () => {},
		onSessionSettled: () => () => {},
		sendExtensionUIResponse: () => {},
		sendCommand: async (command: RpcCommand): Promise<RpcResponse> => {
			sent.push(command);
			return { type: "response", command: command.type, success: true } as RpcResponse;
		},
		getState: async () =>
			({
				isStreaming: false,
				queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
			}) as unknown as RpcSessionState,
		getMessages: async () => [],
	} as unknown as WebSessionLink;
	return { link, sent };
}

let server: WebSessionServer | undefined;

afterEach(() => {
	server?.stop();
	server = undefined;
});

function start() {
	const fake = fakeLink();
	server = new WebSessionServer({ link: fake.link, hostname: "127.0.0.1", port: 0, cwd: "/work", token: TOKEN });
	server.start();
	return { ...fake, base: `http://127.0.0.1:${server.port}` };
}

async function login(base: string): Promise<string> {
	const res = await fetch(`${base}/?t=${TOKEN}`, { redirect: "manual" });
	expect(res.status).toBe(303);
	const cookie = res.headers.get("set-cookie") ?? "";
	expect(cookie).toContain("HttpOnly");
	return cookie.split(";")[0]!;
}

function openSocket(base: string, headers: Record<string, string>) {
	const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers } as unknown as string[]);
	const frames: Array<Record<string, unknown>> = [];
	const waiters: Array<() => void> = [];
	ws.addEventListener("message", event => {
		frames.push(JSON.parse(String(event.data)));
		for (const wake of waiters.splice(0)) wake();
	});
	const next = async (kind: string): Promise<Record<string, unknown>> => {
		for (;;) {
			const index = frames.findIndex(frame => frame.kind === kind);
			if (index >= 0) return frames.splice(index, 1)[0]!;
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			await promise;
		}
	};
	return { ws, next };
}

describe("/web server auth", () => {
	it("refuses the page, assets and socket without the token's cookie, and serves them with it", async () => {
		const { base } = start();
		for (const path of ["/", "/app.js", "/ws", `/?t=wrong-${TOKEN}`]) {
			expect((await fetch(`${base}${path}`, { redirect: "manual" })).status).toBe(401);
		}
		const cookie = await login(base);
		const page = await fetch(`${base}/`, { headers: { cookie } });
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('src="/app.js"');
		expect((await fetch(`${base}/app.js`, { headers: { cookie: `${WEB_COOKIE}=forged` } })).status).toBe(401);
	});

	it("refuses a WebSocket from another origin even with the cookie", async () => {
		const { base } = start();
		const cookie = await login(base);
		const res = await fetch(`${base}/ws`, {
			headers: { cookie, origin: "http://evil.example", connection: "Upgrade", upgrade: "websocket" },
		});
		expect(res.status).toBe(403);
	});
});

describe("/web single-session restriction", () => {
	it("forwards prompts but refuses commands that leave or reconfigure the session", async () => {
		const { base, sent } = start();
		const cookie = await login(base);
		const { ws, next } = openSocket(base, { cookie, origin: base });
		await next("hello");

		for (const type of ["new_session", "switch_session", "fork", "set_model", "bash", "export_html"]) {
			ws.send(JSON.stringify({ kind: "rpc", reqId: type, command: { type, sessionPath: "/other", command: "id" } }));
			const result = await next("result");
			expect(result).toMatchObject({ reqId: type, ok: false });
		}
		expect(sent).toEqual([]);

		ws.send(
			JSON.stringify({
				kind: "rpc",
				reqId: "p",
				command: { type: "prompt", message: "hi", images: [{ type: "image", data: "x" }], sessionPath: "/other" },
			}),
		);
		expect(await next("result")).toMatchObject({ reqId: "p", ok: true });
		expect(sent).toEqual([{ type: "prompt", message: "hi" }]);
		ws.close();
	});
});
