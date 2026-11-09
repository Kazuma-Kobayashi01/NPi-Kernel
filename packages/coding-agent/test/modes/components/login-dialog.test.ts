import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import type { TUI } from "@oh-my-pi/pi-tui";
import { createApiKeyLogin } from "../../../../ai/src/registry/engine/api-key";

import { cfgTuiHyperlinks } from "@oh-my-pi/pi-coding-agent/modes/settings";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	cfgTuiHyperlinks.clearOverride(settings);
});

afterAll(() => {
	resetSettingsForTest();
});

describe("LoginDialogComponent", () => {
	it("keeps the API key page visible without opening a browser and accepts the key", async () => {
		const opened: string[] = [];
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "deepseek", () => {}, url => opened.push(url));
		const url = "https://platform.deepseek.com/api_keys";
		const login = createApiKeyLogin(
			{ kind: "api-key", authUrl: url, instructions: "Copy your API key", prompt: "Paste API key" },
			"DeepSeek",
		);
		const result = login({
			onAuth: info => dialog.showAuth(info.url, info.instructions, info.launchUrl, info.autoOpen),
			onPrompt: prompt => dialog.showPrompt(prompt),
		});
		expect(dialog.renderContent(100).map(line => Bun.stripANSI(line)).join("\n")).toContain(url);
		dialog.handleInput("test-key");
		dialog.handleInput("\r");
		expect(await result).toBe("test-key");
		expect(opened).toEqual([]);
	});

	it("links every wrapped authorization URL row to the complete URL", () => {
		cfgTuiHyperlinks.override(settings, "always");
		const openSpy = spyOn(openModule, "openPath").mockImplementation(() => {});
		try {
			const tui = { requestRender() {} } as unknown as TUI;
			const dialog = new LoginDialogComponent(tui, "google-antigravity", () => {}, openModule.openPath);
			const authorizationUrl =
				"https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth-callback&scope=cloud-platform&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

			dialog.showAuth(authorizationUrl);
			const linkTarget = `${authorizationUrl}\x07`;
			const urlRows = dialog
				.renderContent(40)
				.filter(line => line.includes(linkTarget) && !Bun.stripANSI(line).includes("click to open"));

			expect(urlRows.length).toBeGreaterThan(1);
			expect(urlRows.map(line => Bun.stripANSI(line).trim()).join("")).toBe(authorizationUrl);
			expect(urlRows.every(line => line.includes(linkTarget))).toBe(true);
			expect(openSpy).toHaveBeenCalledWith(authorizationUrl);
		} finally {
			openSpy.mockRestore();
		}
	});
});
