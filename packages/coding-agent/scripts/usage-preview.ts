/**
 * Isolated preview of the fullscreen `/usage` dashboard on synthetic data.
 *
 *   bun packages/coding-agent/scripts/usage-preview.ts [--size 80x24] [--theme dark|light]
 *     [--scenario rich|empty|errors|long|all] [--keys "enter,down,r,esc"] [--ansi]
 *
 * Mounts the real UsageDashboardComponent with the real classic report renderer for the
 * details view, drives it with key sequences, and prints each frame. Frames are ANSI-stripped
 * unless `--ansi`; every frame is checked for horizontal overflow and the exact terminal height.
 * Never reads the real auth store, stats DB, or network.
 */
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { initTheme, setTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import {
	type DailyActivityPoint,
	type UnavailableUsageAccount,
	UsageDashboardComponent,
} from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { renderUsageReports } from "../src/modes/controllers/command-controller";

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function limit(
	provider: string,
	account: string,
	windowId: string,
	label: string,
	used: number,
	status: UsageLimit["status"],
	resetIn?: number,
	durationMs?: number,
): UsageLimit {
	return {
		id: `${provider}:${account}:${windowId}`,
		label,
		scope: { provider, accountId: account, windowId },
		window: {
			id: windowId,
			label: windowId,
			resetsAt: resetIn === undefined ? undefined : NOW + resetIn,
			durationMs,
		},
		amount: { usedFraction: used, unit: "percent" },
		status,
	};
}

function report(provider: string, email: string, limits: UsageLimit[]): UsageReport {
	return { provider, fetchedAt: NOW - 95_000, limits, metadata: { email } };
}

function heat(days: number): DailyActivityPoint[] {
	const points: DailyActivityPoint[] = [];
	for (let index = 0; index < days; index++) {
		const date = new Date(NOW - index * DAY);
		const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		const wave = (Math.sin(index * 0.7) + 1) / 2;
		if (index % 5 === 3) continue;
		points.push({ day, cost: wave * wave * 42, requests: Math.round(wave * 300) + 4 });
	}
	return points;
}

interface Scenario {
	reports: UsageReport[];
	unavailable: UnavailableUsageAccount[];
	activity: "ok" | "error" | "empty" | "never";
	refresh: "ok" | "error";
}

const SCENARIOS: Record<string, () => Scenario> = {
	rich: () => {
		const claude = report("anthropic", "ada@lab.example", [
			limit("anthropic", "ada", "5h", "Claude 5 Hour", 0.82, "warning", 1.2 * HOUR, 5 * HOUR),
			limit("anthropic", "ada", "7d", "Claude 7 Day", 0.46, "ok", 3.4 * DAY, 7 * DAY),
			limit("anthropic", "ada", "opus", "Claude 7 Day (Opus)", 1, "exhausted", 2.1 * DAY, 7 * DAY),
		]);
		claude.resetCredits = {
			availableCount: 3,
			redeemableCount: 1,
			credits: [{ id: "r", remainingCount: 3, expiresAt: new Date(NOW + 9 * DAY).toISOString() }],
		};
		return {
			reports: [
				claude,
				report("anthropic", "grace@lab.example", [
					limit("anthropic", "grace", "5h", "Claude 5 Hour", 0.1, "ok", 4 * HOUR, 5 * HOUR),
					limit("anthropic", "grace", "7d", "Claude 7 Day", 0.22, "ok", 5 * DAY, 7 * DAY),
				]),
				report("openai", "ada@lab.example", [
					limit("openai", "ada", "5h", "Codex 5h", 0.34, "ok", 2 * HOUR, 5 * HOUR),
					limit("openai", "ada", "7d", "Codex Weekly", 0.58, "ok", 4 * DAY, 7 * DAY),
				]),
				report("google-antigravity", "ada@lab.example", [
					limit("google-antigravity", "ada", "d", "Usage (Google)", 0.93, "warning", 6 * HOUR, DAY),
					limit("google-antigravity", "ada", "w", "Usage (Google)", 0.4, "ok", 2 * DAY, 7 * DAY),
				]),
				report("charm-hyper", "ada@lab.example", [
					{
						id: "charm-hyper:credits",
						label: "Credit balance",
						scope: { provider: "charm-hyper", windowId: "balance", shared: true },
						amount: { remaining: 1840, unit: "credits" },
					},
				]),
				report("openrouter", "ada@lab.example", [
					{
						id: "openrouter:spend",
						label: "Spend",
						scope: { provider: "openrouter", windowId: "spend" },
						amount: { used: 12.34, unit: "usd" },
					},
				]),
				report("kimi", "ada@lab.example", [limit("kimi", "ada", "5h", "Kimi 5h", 0, "ok", 5 * HOUR, 5 * HOUR)]),
				report("zai", "ada@lab.example", []),
			],
			unavailable: [{ provider: "github-copilot", label: "octo@lab.example" }],
			activity: "ok",
			refresh: "ok",
		};
	},
	empty: () => ({ reports: [], unavailable: [], activity: "empty", refresh: "ok" }),
	errors: () => ({
		reports: [
			report("anthropic", "ada@lab.example", [
				limit("anthropic", "ada", "5h", "Claude 5 Hour", 1, "exhausted", 40 * 60_000, 5 * HOUR),
				limit("anthropic", "ada", "7d", "Claude 7 Day", 0.97, "exhausted", 3 * DAY, 7 * DAY),
			]),
		],
		unavailable: [
			{ provider: "anthropic", label: "second-account@lab.example" },
			{ provider: "github-copilot", label: "octo@lab.example" },
		],
		activity: "error",
		refresh: "error",
	}),
	long: () => ({
		reports: [
			report("anthropic", "a-really-quite-long-account-name.with.many.parts@subdomain.example-company.test", [
				limit(
					"anthropic",
					"x",
					"opus-long",
					"Claude 7 Day (Opus Extended Thinking Experimental Preview Tier)",
					0.7,
					"warning",
					3 * DAY,
					7 * DAY,
				),
				limit("anthropic", "x", "7d", "Claude 7 Day", 0.3, "ok", 3 * DAY, 7 * DAY),
			]),
			report("a-provider-with-an-unreasonably-long-display-name-for-testing", "z@z.test", [
				limit(
					"a-provider-with-an-unreasonably-long-display-name-for-testing",
					"z",
					"5h",
					"5h",
					0.5,
					"ok",
					HOUR,
					5 * HOUR,
				),
			]),
			report("日本語プロバイダー", "ユーザー@例.test", [
				limit("日本語プロバイダー", "u", "5h", "5時間の上限（実験的）", 0.62, "ok", HOUR, 5 * HOUR),
			]),
		],
		unavailable: [],
		activity: "ok",
		refresh: "ok",
	}),
};

const ANSI_RE = /\x1b\[[0-9;:]*[A-Za-z]/g;
const KEY_MAP: Record<string, string> = {
	enter: "\r",
	esc: "\x1b",
	down: "\x1b[B",
	up: "\x1b[A",
	pgdn: "\x1b[6~",
	pgup: "\x1b[5~",
	home: "\x1b[H",
	end: "\x1b[F",
	tab: "\t",
	r: "r",
	q: "q",
	wheeldown: "\x1b[<65;10;10M",
};

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function runFrame(name: string, cols: number, rows: number, keys: string[], ansi: boolean): Promise<boolean> {
	const scenario = SCENARIOS[name]!();
	let closed = false;
	let renders = 0;
	let refreshCalls = 0;
	const dashboard = new UsageDashboardComponent({
		reports: scenario.reports,
		unavailableAccounts: scenario.unavailable,
		renderDetail: (width, reports) =>
			renderUsageReports(reports, theme, NOW, width, () => undefined, [], scenario.unavailable),
		loadActivity: async push => {
			if (scenario.activity === "never") return new Promise<void>(() => {});
			if (scenario.activity === "error") throw new Error("SQLITE_CANTOPEN: unable to open /Users/x/.omp/stats.db");
			push(scenario.activity === "empty" ? [] : heat(400));
		},
		refresh: async () => {
			refreshCalls++;
			await Bun.sleep(5);
			if (scenario.refresh === "error") throw new Error("429 Too Many Requests from usage endpoint");
			return scenario.reports;
		},
		requestRender: () => {
			renders++;
		},
		onClose: () => {
			closed = true;
		},
	});
	Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
	await Bun.sleep(10);
	let ok = true;
	const show = async (label: string): Promise<void> => {
		const lines = dashboard.render(cols);
		const bad = lines.filter(line => visibleWidth(line) > cols).length;
		const heightOk = lines.length === rows;
		if (bad > 0 || !heightOk) ok = false;
		console.log(
			`\n=== ${name} ${cols}x${rows} theme=${theme.name ?? "?"} after [${label}] — ${lines.length} rows, overflow rows: ${bad}${heightOk ? "" : ` HEIGHT MISMATCH (want ${rows})`} ===`,
		);
		for (const line of lines) console.log(ansi ? `${line}\x1b[0m|` : `${line.replace(ANSI_RE, "")}|`);
	};
	await show("initial");
	for (const key of keys) {
		dashboard.handleInput(KEY_MAP[key] ?? key);
		await Bun.sleep(20);
		await show(key);
		if (closed) {
			console.log("(closed)");
			break;
		}
	}
	console.log(`(renders requested: ${renders}, refresh calls: ${refreshCalls}, closed: ${closed})`);
	dashboard.dispose();
	return ok;
}

await initTheme(false);
const themeName = arg("theme", "dark");
await setTheme(themeName, false);
const [cols, rows] = arg("size", "80x24").split("x").map(Number) as [number, number];
const which = arg("scenario", "rich");
const keys = arg("keys", "").split(",").filter(Boolean);
const names = which === "all" ? Object.keys(SCENARIOS) : [which];
let allOk = true;
for (const name of names) allOk = (await runFrame(name, cols, rows, keys, process.argv.includes("--ansi"))) && allOk;
console.log(allOk ? "\nGEOMETRY OK" : "\nGEOMETRY FAILED");
process.exit(allOk ? 0 : 1);
