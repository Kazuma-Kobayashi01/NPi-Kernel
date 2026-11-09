import { getComposerStyle } from "../components/composer/registry";
import { Spacer } from "../components/spacer";
import type { StatusLineComponent } from "../status-line/component";
import { compositeLineAt } from "../render/composite";
import { type ExtensionLinkLabel, extensionLinkLabels, linkHintTags } from "../render/extension-links";
import type { StatusLineSession } from "../status-line/host";
import { createStartupStatusLine, type StatusLineStartupData } from "../status-line/startup";
import { isInsideTerminalMultiplexer } from "../terminal-multiplexer";
import { ProcessTerminal, type Terminal } from "../terminal";
import {
	type Component,
	Container,
	type RenderTimer,
	type ResizeScrollbackMode,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TUIOptions,
	type ViewportSize,
} from "../tui";
import { visibleWidth, wrapLiteralLine } from "../utils";
import type { NativeChild, NativeSurface, NativeSurfaceProvider } from "../native/node";
import { sameItems } from "../native/memo";
import { postmortem } from "@oh-my-pi/pi-utils";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { shortenPath } from "../render/render-utils";
import { truncateToWidth } from "../utils";
import { CustomEditor } from "./custom-editor";
import type { WordCompletionMethod } from "./word-completion";
import { type AnimationFrame, TranscriptContainer } from "../chrome/transcript-container";
import { terminalBackdrop, themeGradientStops, WelcomeComponent } from "./welcome";
import { HomeScene } from "./home-scene";
import { overlayTileRow } from "./tile-backdrop";
import { TERMINAL } from "../terminal-capabilities";
import { isNativeRendering } from "../native/state";
import type { SidePanelRows } from "../chrome/side-panel";
import { stripPromptZones } from "../chat/transcript-outline";
import { StatusNotice } from "../chrome/status-notice";
import { isComposerDockInput } from "./dock-input";
import { ensureThemeSync, getEditorTheme, theme } from "../theme/theme";

const DOUBLE_INTERRUPT_MS = 500;
// How long idle chrome must hold its height after a turn before it is treated as permanent.
const IDLE_CHROME_SETTLE_MS = 250;

/** Live settings that affect the composer before and after session adoption. */
export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly composerShape: string;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly resizeScrollback: ResizeScrollbackMode;
	/** Send rows a growing HUD or dialog pushes off screen straight to scrollback instead of holding them back until it shrinks. */
	readonly completeScrollback: boolean;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: WordCompletionMethod;
	readonly spellingAutocorrect: boolean;
	/** Paint the terminal with the theme's background while npi runs (OSC 11 and every drawn row). Off unless `true`; the app's setting turns it on. */
	readonly paintBackground?: boolean;
	/** Widest the conversation column gets, centred on a wider terminal; 0 or unset keeps the full width. */
	readonly contentWidth?: number;
	/** Dock the session side panel right of the conversation when the terminal has room. Off unless `true`. */
	readonly sidePanel?: boolean;
}

/** Settings-schema-compatible defaults used when constructing a dependency-free composer. */
export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	composerShape: "rail",
	showHardwareCursor: true,
	maxInlineImages: 8,
	resizeScrollback: "rebuild",
	completeScrollback: false,
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: "auto",
	spellingAutocorrect: false,
};

/** Welcome data that can be supplied initially or patched as startup resolves it. */
export interface ComposerWelcomeUpdate {
	readonly version?: string;
}

/**
 * Status-bar inputs persisted by the last session. The first frame renders
 * them through a startup {@link StatusLineComponent} at the live width until
 * the session-aware status line attaches.
 */
export interface ComposerStatusCache {
	/** ANSI wrapper of the editor border when persisted (session accent or thinking color). */
	readonly borderColor?: {
		readonly prefix: string;
		readonly suffix: string;
	};
	readonly statusLine: StatusLineStartupData;
}

/** Optional dependencies and initial state for a standalone composer. */
export interface ComposerOptions {
	readonly terminal?: Terminal;
	/** Extra TUI construction options (render scheduler injection for tests and `npi render`). */
	readonly tuiOptions?: TUIOptions;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	readonly status?: ComposerStatusCache;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}

/** How {@link Composer.setRuntimeChildren} lays out the roots below the transcript. */
export interface RuntimeChildrenOptions {
	/**
	 * Dock order on a TSP terminal (no status strip; the composer carries its
	 * facts): the native dock stacks HUD pills, the working row and queued messages over
	 * the composer in its own order, and may add describe-only roots. Defaults
	 * to the roots below the transcript in render order.
	 */
	readonly nativeDock?: readonly Component[];
	/**
	 * Below-transcript roots the user opens and closes (the editor surface that
	 * drafts and dialogs swap into, docked reports). Their rows never become
	 * part of the post-run chrome floor, so collapsing them refills the screen.
	 */
	readonly transientChrome?: readonly Component[];
	/**
	 * Transient roots that clear themselves (todo and subagent HUDs, progress).
	 * Their first paint can be their tallest, e.g. a restored todo list on a
	 * resumed session, so unlike {@link transientChrome} it is never treated as
	 * their resting height: all of their rows stay out of the floor. Roots listed
	 * here are transient and need not also appear in `transientChrome`.
	 */
	readonly selfClearingChrome?: readonly Component[];
}

/** Controls the first terminal paint for a composer that does not already own the terminal. */
export interface ComposerStartOptions {
	readonly clearScrollback?: boolean;
	readonly playWelcomeIntro?: boolean;
	/**
	 * Paint without owning stdin: the tty keeps cooked-mode echo/editing so
	 * typing stays visible while startup module loading blocks the event loop.
	 * {@link Composer.enableInput} later switches to raw input and replays the
	 * kernel-buffered keystrokes into the editor.
	 */
	readonly deferInput?: boolean;
}

/**
 * Mount slot below the editor: the startup status line, then the session-aware
 * one. ANSI only: a TSP terminal has no status strip, the composer carries the
 * status line's facts ({@link StatusLineComponent.describeComposerFacts}).
 */
class StatusHost implements Component {
	#component: Component | undefined;
	homeFooter?: (width: number) => string | undefined;

	setComponent(component: Component): void {
		this.#component = component;
	}

	render(width: number): readonly string[] {
		const home = this.homeFooter?.(width);
		if (home !== undefined) return ["", home];
		return this.#component?.render(width) ?? [];
	}
}

/** Widest the home screen's column gets, so the composer reads as a centred card. */
const HOME_COLUMN = 75;

/** Reveal positions at which the home chrome starts to appear and reaches full strength. */
const HOME_CHROME_FROM = 0.55;
const HOME_CHROME_FULL = 0.8;

/** Share of the spare rows above the home scene; a little above true centre, for optical balance. */
const HOME_TOP_SHARE = 0.45;

/** Cells of the docked side panel, its padding included, and the gap left of it. */
const SIDE_PANEL_COLUMNS = 34;
const SIDE_PANEL_PADDING = 2;
const SIDE_PANEL_GAP = 2;
/** The conversation keeps at least this many cells beside the panel. */
const SIDE_PANEL_MIN_CONVERSATION = 80;

/** Rows carrying kitty, sixel or iTerm images: their cells are the terminal's, so nothing is added to them. */
function hasTerminalGraphics(row: string): boolean {
	return row.includes("\x1b_G") || row.includes("\x1bP") || row.includes("\x1b]1337");
}

/** One click target's row span within the mutable viewport (half-open `[start, end)`). */
export interface ViewportClickSpan {
	start: number;
	end: number;
	/** Candidate subagent ids for a span-local row. */
	candidates: (local: number) => string[];
}

/**
 * Row-level click target: maps rendered rows to subagent ids. Implemented by
 * the subagent HUD, whose rows are fixed 1:1 with visible sessions.
 */
export interface ViewportClickRowTarget {
	getClickAgentAtRow(row: number): string | undefined;
}

/**
 * Candidates under a mutable-viewport line: the first span containing it.
 * Pure seam for tests; the caller intersects with the live registry, which
 * decides focusability and recency.
 */
export function routeViewportClick(spans: readonly ViewportClickSpan[], index: number): string[] {
	if (!Number.isInteger(index) || index < 0) return [];
	for (const span of spans) {
		if (index < span.start || index >= span.end) continue;
		return span.candidates(index - span.start);
	}
	return [];
}

/** An extension link label drawn on a mutable-viewport line: what a click or hint tag lands on. */
export interface ViewportLink {
	readonly url: string;
	/** Mutable-viewport line the label is drawn on. */
	readonly row: number;
	/** First cell of the label's part on that line. */
	readonly start: number;
}

/** An extension link label tagged for picking by keyboard in link-hint mode. */
interface ViewportLinkHint {
	readonly tag: string;
	readonly link: ViewportLink;
}

/**
 * Called once when link-hint mode ends; `reason` is `"crowded"` when a row held more links than
 * their tags could fit side by side, so no tags were drawn.
 */
export type LinkHintsEnd = (reason?: "crowded") => void;

/**
 * The extension link labels drawn on `rows`, top to bottom, a wrapped label once at its first row:
 * a row's first label continues the previous row's last label when that has the same marker id
 * and ends its row.
 */
function viewportLinkTargets(rows: readonly string[]): ViewportLink[] {
	const targets: ViewportLink[] = [];
	let previous: ExtensionLinkLabel | undefined;
	for (let row = 0; row < rows.length; row++) {
		const labels = extensionLinkLabels(rows[row]!);
		for (const [index, label] of labels.entries()) {
			if (index === 0 && previous?.endsRow && previous.id === label.id) continue;
			targets.push({ url: label.url, row, start: label.start });
		}
		previous = labels.at(-1);
	}
	return targets;
}

/**
 * Nested background opens inside a hovered row. The band wraps the line, so a
 * surviving nested open would paint over it for every cell it covers; the
 * matching closes stay and become band resumes via bgFill.
 */
const NESTED_BG_OPEN_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:4[0-7]|10[0-7]|48;[0-9;]*)m`, "g");

/**
 * Candidate resolver for a row-level click target, if the component is one.
 * Shared by root and nested-child hit-testing so both stay in lockstep.
 */
function rowTargetCandidates(target: Component): ((local: number) => string[]) | undefined {
	const rowTarget = target as Partial<ViewportClickRowTarget>;
	if (typeof rowTarget.getClickAgentAtRow !== "function") return undefined;
	return (local: number) => {
		const id = rowTarget.getClickAgentAtRow?.(local);
		return id === undefined ? [] : [id];
	};
}

/**
 * Canonical interactive composer, usable before session/settings exist and updatable in place.
 * It owns the terminal, welcome header, and editor; InteractiveMode later supplies authoritative
 * data and mounts the session-aware runtime children without replacing the visible header.
 */
export class Composer implements TerminalFrameProvider, NativeSurfaceProvider {
	readonly ui: TUI;
	#editor: CustomEditor;
	readonly #header = new Container();
	readonly #bootstrapInputGap = new Spacer(1);
	readonly #statusHost = new StatusHost();
	readonly #exit: (code: number) => void;
	readonly #now: () => number;
	#preferences: ComposerPreferences;
	#welcome: WelcomeComponent | undefined;
	#sidePanel: ((width: number) => SidePanelRows) | undefined;
	#onSidePanelShown: ((shown: boolean) => void) | undefined;
	#sidePanelShown = false;
	#homeStatus: string | undefined;
	#version = "";
	#headerBefore: readonly Component[] = [];
	#headerAfter: readonly Component[] = [];
	#runtimeChildren: readonly Component[] = [];
	#nativeDock: readonly Component[] | undefined;
	/** Cache-driven status line shown until {@link setStatusComponent} mounts the session's. */
	#startupStatus: StatusLineComponent | undefined;
	#runtimeMounted = false;
	// Composer-owned history id space. Transcript batch ids restart across
	// container clears/swaps; the composer translates them into one monotonic
	// sequence the terminal's accepted-id watermark can trust.
	#nextHistoryId = 1;
	#offeredHistory:
		| {
				id: number;
				rows: readonly string[];
				kind: "append" | "replay";
				source:
					| "header"
					| {
							transcript: TranscriptContainer;
							transcriptId?: number;
							header: "none" | "replay";
							/** Recomposed header rows to accept as the new retired-header bytes. */
							headerRows?: readonly string[];
					  };
		  }
		| undefined;
	#historyReplayRequested = false;
	#headerReplayPending = false;
	#historyFlush = false;
	// The welcome header retires to terminal history exactly once, after the
	// intro settles; until then it renders as mutable viewport chrome.
	#headerRetired = false;
	// The night-city backdrop behind the home screen; it plays while the
	// welcome's ambient loop runs and freezes with it.
	#homeScene = new HomeScene();
	// Exact hard rows accepted into native history. Transient resize-alt
	// paints reflow these rows to match the terminal's own rewrap of history
	// it still holds; a settled replay owns every byte it emits, so it
	// recomposes the header at the replay width and refreshes these rows.
	#retiredHeaderRows: readonly string[] | undefined;
	/** Click spans of the last `renderFrame` viewport, in viewport coordinates. */
	#lastClickSpans: ViewportClickSpan[] = [];
	/** Rows of the last `renderFrame` viewport, before the hover band; read to hit-test extension links. */
	#lastViewportRows: readonly string[] = [];
	/** Click-candidate id under the pointer, painted with the hover band. Id-anchored so it follows streaming rows. */
	#hoveredClickId: string | undefined;
	/**
	 * Keyboard link-hint mode: the tags drawn over the extension links on screen (`undefined` until
	 * the first frame after `startLinkHints` assigns them), the letters typed so far, and what to run
	 * when the mode ends for any reason.
	 */
	#linkHints: { hints: ViewportLinkHint[] | undefined; typed: string; onEnd: LinkHintsEnd } | undefined;
	/** Width of the last painted viewport, which `#lastViewportRows` was laid out for. */
	#lastViewportWidth = 0;
	// Hard-row prefix currently above the native viewport. The first resize
	// frame may pull part of it down before the normal buffer is borrowed.
	#retiredHeaderStart = 0;
	#resizeRetiredHeaderStart: number | undefined;
	#lastNormalRows = 0;
	// Retirement bills below-transcript chrome at this floor, not its current
	// height. It follows contractions immediately and promotes stable eligible
	// growth only while idle. Transient roots count at their minimum painted
	// height: a growing dialog or draft clips the live tail without committing
	// displaced rows, so those rows refill the screen when it shrinks (#11007).
	// Displaced rows reach history when newer output pushes them past the floor
	// or persistent idle chrome settles and raises it.
	// With `completeScrollback`, rows the chrome pushes off screen go straight
	// to scrollback, and when it shrinks the freed rows stay blank.
	// The floor is terminal-height independent — chrome heights do not scale
	// with rows — so it is retained across resizes rather than rediscovered
	// from whatever chrome is expanded when the height changes.
	#chromeFloor: number | undefined;
	// Settled idle chrome has retired rows; contraction must preserve native history.
	#chromeFloorPromoted = false;
	#runActive = false;
	#transientChrome: ReadonlySet<Component> = new Set();
	#selfClearingChrome: ReadonlySet<Component> = new Set();
	// Fewest rows the user-driven transient roots have painted since mount; only rows above it are excluded from the floor.
	#transientFloor: number | undefined;
	// Editor and shape the transient floor was measured under, plus the last frame's transient rows.
	// A shape swap (band → pi) changes the editor's resting height; a minimum carried over from the
	// shorter shape would exclude the taller shape's fixed rows forever and clip that many transcript rows.
	#transientEditor: Component | undefined;
	#transientEditorStyle: string | undefined;
	#lastTransientRows = 0;
	// Fewest rows the bare editor painted before the runtime mounted, and the shape it was painted in.
	// A draft replayed from the startup keystroke buffer can already be present on the first runtime
	// frame, so that frame is not the editor's resting height; this is, because the bootstrap frame
	// paints before replay. Only valid while the shape is unchanged.
	#bootstrapEditorRows: number | undefined;
	#bootstrapEditorStyle: string | undefined;
	// Idle chrome height awaiting the settle window, and whether it has elapsed.
	// Turn-scoped HUDs can close a few frames after the last block finalizes;
	// billing them first would commit rows they cover and strand a band.
	#idleChrome: number | undefined;
	#idleChromeSettled = false;
	#idleChromeTimer: RenderTimer | undefined;
	/** Rows the chrome below each below-transcript root took in the last frame (see {@link rowsBelow}). */
	#rowsBelow = new Map<Component, number>();
	#lastInterruptAt = 0;
	/** Last described surface; its arrays are reused while their children are unchanged. */
	#nativeSurface: NativeSurface = { main: [], dock: [] };
	#started = false;
	#stopped = false;
	#transferred = false;
	#terminal: Terminal;

	constructor(options: ComposerOptions = {}) {
		ensureThemeSync();
		// Host-owned hard exit: route through postmortem so a double-Ctrl-C during
		// an open extension-load guard window exits cleanly instead of throwing
		// ExtensionExitError through the guarded process.exit (#11789).
		this.#exit = options.exit ?? (code => postmortem.exitProcess(code));
		this.#now = options.now ?? Date.now;
		this.#preferences = { ...COMPOSER_DEFAULTS, ...options.preferences };
		this.#applyWelcomeUpdate(options.welcome ?? {});

		this.#terminal = options.terminal ?? new ProcessTerminal();
		this.ui = new TUI(this.#terminal, this.#preferences.showHardwareCursor, options.tuiOptions);
		this.ui.setFrameProvider(this);
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.ui.setResizeScrollback(this.#preferences.resizeScrollback);

		this.#editor = new CustomEditor(getEditorTheme());
		this.editor.disableSubmit = true;
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		if (options.status) {
			const { borderColor, statusLine } = options.status;
			if (borderColor) this.editor.borderColor = text => `${borderColor.prefix}${text}${borderColor.suffix}`;
			this.#startupStatus = createStartupStatusLine(statusLine);
			this.#statusHost.setComponent(this.#startupStatus);
			this.#startupStatus.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
		}
		// Emergency controls stay active until InteractiveMode installs configured bindings.
		// They deliberately mirror the interactive editor's contract so a stalled startup
		// never behaves differently from a healthy one: Ctrl+C clears the draft and a second
		// press exits 130 — the unconditional abort, draft or not; Ctrl+D exits 0 on an
		// empty draft and otherwise forward-deletes (see CustomEditor's app.exit handling),
		// so typing while the session loads cannot be lost to a mistyped delete.
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));

		if (!this.#preferences.quiet) this.#ensureWelcome();
		this.#rebuildHeader();
		this.#statusHost.homeFooter = width => {
			if (this.editor.getBorderStyle() !== "rail" || !this.#onHomeScreen()) return undefined;
			const version = this.#version ? `v${this.#version}` : "";
			const status = this.#homeStatus ? `  ${this.#homeStatus}` : "";
			const room = Math.max(0, width - version.length - visibleWidth(status) - 2);
			const path = truncateToWidth(shortenPath(getProjectDir()), room);
			const gap = " ".repeat(Math.max(0, width - visibleWidth(path) - visibleWidth(status) - version.length));
			return this.#revealHomeChrome(`${theme.fg("dim", path)}${status}${gap}${theme.fg("dim", version)}`);
		};
		this.editor.footerHintReveal = hint => this.#revealHomeChrome(hint);
		this.editor.tallComposer = () => this.#onHomeScreen();
		this.ui.addChild(this.#header);
		this.ui.addChild(this.#bootstrapInputGap);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.#statusHost);
		this.ui.setFocus(this.editor);
		// A settle timer that fires while the TUI is stopped (external editor, suspend) is dropped;
		// forget it on restart so the next frame re-arms instead of waiting on it forever.
		this.ui.addStartListener(() => this.#resetIdleChrome());
	}
	/**
	 * Rows the below-transcript chrome under `root` (editor, status line, …)
	 * took in the last frame, so a root that grows upward can cap itself to
	 * the screen rows left above them; `undefined` before `root` was laid out.
	 */
	rowsBelow(root: Component): number | undefined {
		return this.#rowsBelow.get(root);
	}

	/** The empty welcome scene: logo and composer, before anything has run. */
	#onHomeScreen(): boolean {
		if (
			this.#runtimeMounted &&
			!this.#runtimeChildren.some(
				root => root === this.editor || (root instanceof Container && root.children.includes(this.editor)),
			)
		)
			return false;
		const transcript = this.#runtimeChildren.find(child => child instanceof TranscriptContainer);
		return (
			this.#welcome !== undefined &&
			!this.#headerRetired &&
			!this.#runActive &&
			(!(transcript instanceof TranscriptContainer) ||
				transcript.children.every(child => child instanceof StatusNotice || child instanceof Spacer))
		);
	}

	/** Hidden, then faint, then whole as the welcome reveal plays; unchanged once it settles. */
	#revealHomeChrome(row: string): string {
		const progress = this.#welcome?.introProgress ?? 1;
		if (progress >= HOME_CHROME_FULL) return row;
		if (progress < HOME_CHROME_FROM) return "";
		return `\x1b[2m${row.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
	}

	/** Whether the empty welcome scene is on screen. */
	get onHomeScreen(): boolean {
		return this.#onHomeScreen();
	}

	/** Welcome reveal position in [0, 1]; 1 when settled or absent. */
	get welcomeProgress(): number {
		return this.#welcome?.introProgress ?? 1;
	}

	/** A short status for the home footer, such as connected MCP servers. */
	setHomeStatus(status: string | undefined): void {
		this.#homeStatus = status;
		this.ui.requestRender();
	}

	/**
	 * Supply the side panel's rows. `onShownChange` runs before the frame that
	 * first shows or hides it, so chrome repeating its facts can yield in step.
	 */
	setSidePanel(rows: (width: number) => SidePanelRows, onShownChange: (shown: boolean) => void): void {
		this.#sidePanel = rows;
		this.#onSidePanelShown = onShownChange;
	}

	/** Cells the side panel takes from a terminal `columns` wide; 0 when it stays out. */
	#sidePanelRoom(columns: number): number {
		if (!this.#sidePanel || this.#preferences.sidePanel !== true) return 0;
		const room = SIDE_PANEL_COLUMNS + SIDE_PANEL_GAP;
		return columns - room >= SIDE_PANEL_MIN_CONVERSATION ? room : 0;
	}

	/**
	 * The conversation column of a terminal `columns` wide: its width and the cells of margin on
	 * its left. A column cap of 0 (or a terminal narrower than the cap) is the full width. The side
	 * panel's room comes out of that width even on the home screen, so the first message moves the
	 * column without reflowing it.
	 */
	#column(columns: number): { width: number; margin: number; panel: boolean } {
		const cap = this.#preferences.contentWidth ?? 0;
		const room = this.#sidePanelRoom(columns);
		const available = Math.max(1, columns - room);
		const conversation = Number.isFinite(cap) && cap >= 40 ? Math.min(cap, available) : available;
		const home = this.#onHomeScreen();
		const width =
			home && this.editor.getBorderStyle() === "rail" ? Math.min(HOME_COLUMN, conversation) : conversation;
		const panel = room > 0 && !home;
		return { width, margin: Math.floor(((panel ? available : columns) - width) / 2), panel };
	}

	/** `rows` with the side panel docked on the terminal's right edge, for the mutable viewport only. */
	#dockSidePanel(rows: readonly string[], columns: number): readonly string[] {
		const inner = SIDE_PANEL_COLUMNS - SIDE_PANEL_PADDING * 2;
		const panel = this.#sidePanel?.(inner);
		if (!panel) return rows;
		const start = columns - SIDE_PANEL_COLUMNS;
		const bottomAt = rows.length - panel.bottom.length - 1;
		const side = " ".repeat(SIDE_PANEL_PADDING);
		return rows.map((row, index) => {
			if (hasTerminalGraphics(row)) return row;
			const line = (index >= bottomAt ? panel.bottom[index - bottomAt] : panel.top[index - 1]) ?? "";
			const cell = `${side}${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))}${side}`;
			return `${row}\x1b[0m${" ".repeat(Math.max(0, start - visibleWidth(row)))}${theme.bgFill("userMessageBg", cell)}`;
		});
	}

	/** Cells of margin left of the conversation column at the terminal's current width (0 when it is full width). */
	get contentMargin(): number {
		return this.#column(this.#terminal.columns).margin;
	}

	/** `rows` pushed `margin` cells to the right; empty rows stay empty. */
	static #indent(rows: readonly string[], margin: number): readonly string[] {
		if (margin <= 0) return rows;
		const lead = " ".repeat(margin);
		// Shell prompt zones let terminals rewrite these rows as an editable shell
		// prompt, losing the column margin. A centred application owns its layout.
		return stripPromptZones(rows).map(row => (row === "" ? row : lead + row));
	}

	/**
	 * `rows` on the theme's background edge to edge, so the screen is one surface even on a
	 * terminal that ignores OSC 11: each row sets the background, takes it back after every
	 * reset inside the row, and is padded to `columns`. Rows that carry terminal graphics
	 * (kitty, sixel, iTerm) are left as they are. Unchanged when painting is off.
	 */
	#paint(rows: readonly string[], columns: number): readonly string[] {
		if (this.#preferences.paintBackground !== true) return rows;
		const bg = theme.terminalBackgroundAnsi;
		return rows.map(row => {
			if (hasTerminalGraphics(row)) return row;
			const resumed = row
				.replaceAll("\x1b[0m", `\x1b[0m${bg}`)
				.replaceAll("\x1b[m", `\x1b[m${bg}`)
				.replaceAll("\x1b[49m", `\x1b[49m${bg}`);
			return `${bg}${resumed}${" ".repeat(Math.max(0, columns - visibleWidth(row)))}\x1b[0m`;
		});
	}

	/** `rows` followed by blank rows up to `height`. */
	static #fill(rows: readonly string[], height: number): readonly string[] {
		return rows.length >= height ? rows : [...rows, ...Array<string>(height - rows.length).fill("")];
	}

	/** Place the empty welcome scene in the upper middle, keeping short terminals usable. */
	#welcomeTopPadding(rows: number, contentRows: number): number {
		if (!this.#welcome || this.#headerRetired || isComposerDockInput()) return 0;
		return Math.max(0, Math.floor((rows - contentRows) * HOME_TOP_SHARE));
	}

	/** Compose the bounded mutable viewport and the next ordered history append, in the centred, painted column. */
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const plan = this.#renderPlacedFrame(viewport);
		const tiled = this.#tileBackdrop(plan.viewport, viewport.columns, viewport.rows);
		return tiled === plan.viewport ? plan : { ...plan, viewport: tiled };
	}

	/**
	 * The home screen's `rows` over the night-city backdrop ({@link HomeScene}),
	 * edge to edge: every cell without a background of its own shows the scene,
	 * and blank cells may carry faint signboard lettering or a star. Unchanged off the home screen, on a
	 * native surface, without truecolor, or when the theme reports no exact
	 * terminal background to tint from.
	 */
	#tileBackdrop(rows: readonly string[], columns: number, height: number): readonly string[] {
		const welcome = this.#welcome;
		if (!welcome?.ambientActive || !this.#onHomeScreen() || isNativeRendering() || !TERMINAL.trueColor) return rows;
		const backdrop = terminalBackdrop();
		if (!backdrop || rows.length === 0) return rows;
		const scene = this.#homeScene;
		const { width, margin } = this.#column(columns);
		scene.layout({ columns, rows: height, contentLeft: margin, contentRight: margin + width });
		scene.setTheme({ backdrop, stops: themeGradientStops(), reveal: welcome.introProgress });
		scene.step(performance.now());
		const restore = this.#preferences.paintBackground === true ? theme.terminalBackgroundAnsi : "\x1b[49m";
		const top = height - rows.length;
		return rows.map((row, index) => {
			if (hasTerminalGraphics(row)) return row;
			const y = top + index;
			const rowBlank = Bun.stripANSI(row).trim() === "";
			return overlayTileRow(row, columns, {
				bgAt: x => scene.bg(x, y),
				glyphAt: x => scene.glyph(x, y, rowBlank),
				restore,
				backdrop,
			});
		});
	}

	#renderPlacedFrame(viewport: ViewportSize): TerminalFramePlan {
		const { width, margin, panel } = this.#column(viewport.columns);
		if (panel !== this.#sidePanelShown) {
			this.#sidePanelShown = panel;
			this.#onSidePanelShown?.(panel);
		}
		const plan = this.#renderColumnFrame({ ...viewport, columns: width });
		const painting = this.#preferences.paintBackground === true;
		if (margin <= 0 && !painting && !panel) return plan;
		const lay = (rows: readonly string[]) => this.#paint(Composer.#indent(rows, margin), viewport.columns);
		const live = this.#composeViewport(plan.viewport, viewport.rows, painting);
		const indented = Composer.#indent(live, margin);
		return {
			...plan,
			viewport: this.#paint(panel ? this.#dockSidePanel(indented, viewport.columns) : indented, viewport.columns),
			...(plan.history ? { history: { ...plan.history, rows: lay(plan.history.rows) } } : {}),
		};
	}

	/** The painted viewport, screen tall; the home footer sits on the bottom of it, one row of air below. */
	#composeViewport(rows: readonly string[], height: number, painting: boolean): readonly string[] {
		if (!painting || rows.length === 0) return rows;
		const footerAt = rows.length - 1;
		if (this.editor.getBorderStyle() !== "rail" || !this.#onHomeScreen() || footerAt + 2 >= height) {
			return Composer.#fill(rows, height);
		}
		return [...Composer.#fill(rows.slice(0, footerAt), height - 2), rows[footerAt]!, ""];
	}

	#renderColumnFrame(viewport: ViewportSize): TerminalFramePlan {
		if (!this.#started || this.#stopped) return { viewport: [] };
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		if (this.#resizeRetiredHeaderStart !== undefined) {
			this.#retiredHeaderStart = this.#resizeRetiredHeaderStart;
			this.#resizeRetiredHeaderStart = undefined;
		}
		this.#lastNormalRows = rows;
		const roots = this.#runtimeMounted
			? [...this.#runtimeChildren, this.#statusHost]
			: [this.#header, this.#bootstrapInputGap, this.editor, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) {
			this.#lastClickSpans = [];
			this.#lastViewportRows = [];
			this.#syncLinkHints([], 0);
			const viewport: string[] = [];
			const parts: string[][] = [];
			for (const root of roots) {
				const rendered = root.render(width);
				if (!this.#runtimeMounted && root === this.editor) this.#recordBootstrapEditorRows(rendered.length);
				parts.push([...rendered]);
			}
			// The prompt sits on the bottom row from the first frame: the slack goes above the input.
			const total = parts.reduce((sum, part) => sum + part.length, 0);
			viewport.push(...Array<string>(this.#welcomeTopPadding(rows, total)).fill(""));
			const inputAt = Math.max(0, roots.indexOf(this.#runtimeMounted ? this.editor : this.#bootstrapInputGap));
			for (const [index, part] of parts.entries()) {
				if (isComposerDockInput() && index === inputAt && total < rows)
					viewport.push(...Array<string>(rows - total).fill(""));
				viewport.push(...part);
			}
			return { viewport: viewport.slice(-rows) };
		}
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const preRoots = this.#renderRoots(roots.slice(0, transcriptIndex), width);
		const afterRoots = roots.slice(transcriptIndex + 1);
		const after: string[] = [];
		const afterSpans: ViewportClickSpan[] = [];
		const ends: { root: Component; end: number }[] = [];
		let transientRows = 0;
		let selfClearingRows = 0;
		for (const root of afterRoots) {
			const start = after.length;
			this.#renderBelowRoot(root, width, after, afterSpans);
			if (this.#selfClearingChrome.has(root)) selfClearingRows += after.length - start;
			else if (this.#transientChrome.has(root)) transientRows += after.length - start;
			ends.push({ root, end: after.length });
		}
		this.#rowsBelow = new Map(ends.map(({ root, end }) => [root, after.length - end]));
		const transientFloor = this.#syncTransientFloor(transientRows);
		// Eligible chrome excludes user-driven transient rows above their resting height and every
		// self-clearing row; contraction, floor and rebaseline all use it.
		const eligibleChrome = after.length - (transientRows - transientFloor) - selfClearingRows;
		const promotedChromeContracted = this.#chromeFloorPromoted && eligibleChrome < (this.#chromeFloor ?? 0);
		this.#chromeFloor = Math.min(this.#chromeFloor ?? eligibleChrome, eligibleChrome);
		this.#rebaselineChromeFloor(this.#runActive || transcript.hasActiveBlock(), eligibleChrome);
		const belowFloor = this.#preferences.completeScrollback ? after.length : this.#chromeFloor;
		// Offer history under capacity pressure only: blocks stay live (and keep
		// reflowing to the current width) while the screen has room. A batch
		// leaves the mutable viewport in the same frame it is appended, so its
		// rows are never painted twice.
		const now = performance.now();
		const frame: AnimationFrame = { now, tick: Math.floor(now / 80) };
		// Retirement measures the same live blocks the viewport lays out below;
		// one open frame renders each of them once for both.
		transcript.beginFrame(frame);
		const history = this.#offerHistory(transcript, width, rows, preRoots.length + belowFloor);
		const headerVisible = !this.#headerRetired && this.#offeredHistory?.source !== "header";
		const headerRows = headerVisible ? this.#header.render(width) : [];
		const before = [...headerRows, ...preRoots];
		// The live tail is laid out against the same baseline retirement is
		// billed against, so its compaction allocator (one row per block, no
		// inter-block blanks) engages only when a block genuinely cannot retire.
		// Rows the chrome above its floor displaces are clipped from the top by
		// the `drop` slice below; they stay live until the chrome shrinks. With
		// `completeScrollback` none are held back.
		const active = transcript.renderViewport(width, Math.max(0, rows - before.length - belowFloor), frame);
		if (
			transcript.children.every(child => child instanceof StatusNotice || child instanceof Spacer) &&
			history === undefined &&
			!this.#runActive
		) {
			before.unshift(
				...Array<string>(this.#welcomeTopPadding(rows, before.length + active.length + after.length)).fill(""),
			);
		}
		const activeSpans: ViewportClickSpan[] = [];
		for (const span of transcript.getLastViewportSpans()) {
			const ids = (span.component as Partial<{ getClickFocusAgentIds(): string[] }>).getClickFocusAgentIds?.();
			if (!ids || ids.length === 0) continue;
			activeSpans.push({ start: span.start, end: span.end, candidates: () => ids });
		}
		const drop = Math.max(0, before.length + active.length + after.length - rows);
		const mutable = [...before, ...active, ...after].slice(drop);
		// Once a paint reaches the bottom row over committed history, rows above
		// it may already be in native scrollback, which no later frame can pull
		// back down. Keep the input on the bottom row whenever the frame shrinks
		// — a closing dialog, report or HUD, or a live block collapsing. The
		// slack that leaves has to sit somewhere: rows above the live area hold
		// committed history still on screen, so the live rows cannot move up into
		// them, and replaying those rows would duplicate them while clearing
		// history would lose them. Replays position themselves. Without native
		// history the live viewport is the whole document and shrinks in place.
		const filledHistoryRows =
			history?.kind === "replay" || !(history !== undefined || this.ui.hasProviderHistory())
				? undefined
				: this.ui.getFilledHistoryRows();
		// Once settled chrome has retired rows, shrinking it cannot pull those
		// rows back out of native scrollback. Let the editor move up instead of
		// inserting a seam band; subsequent frames retain that natural anchor
		// until new output fills the screen again. Shell history stays untouched.
		// NPi: the prompt always sits on the bottom row. With no native history yet the whole
		// document is the viewport, and the rows it does not fill go above the input (between the
		// transcript and the dock) instead of leaving the prompt floating under a short transcript.
		// Docked (NPi): whatever the history state, the live rows plus the slack fill the screen, so
		// the prompt stays on the last row, also after a dialog or menu closes.
		const slack = isComposerDockInput()
			? Math.max(0, rows - mutable.length)
			: filledHistoryRows === undefined || promotedChromeContracted
				? 0
				: Math.max(0, rows - Math.min(rows, filledHistoryRows + (history?.rows.length ?? 0)) - mutable.length);
		// Park the slack below the live rows rather than above them. Above, it
		// splits the on-screen history from the live tail and reads as a hole
		// punched into whatever was streaming — a table's rows included — and
		// each slack row is written with no cells, so no repaint, mark or
		// selection can cover it until something scrolls it away. Below, the
		// transcript stays contiguous with the history, the slack reads as the
		// empty tail of a short document, and growth consumes it before any row
		// can scroll.
		if (slack > 0) {
			const at = Math.max(0, Math.min(mutable.length, before.length + active.length - drop));
			mutable.splice(at, 0, ...Array<string>(slack).fill(""));
		}
		const viewportLength = mutable.length;
		const spans: ViewportClickSpan[] = [];
		const shift = (span: ViewportClickSpan, base: number): void => {
			const start = span.start + base;
			const end = Math.min(span.end + base, viewportLength);
			const clamped = Math.max(0, start);
			if (end > clamped) {
				// A clipped head must offset the callback: without the skew the
				// first visible row would hit-test as span-local row 0.
				const skew = clamped - start;
				spans.push({ start: clamped, end, candidates: (local: number) => span.candidates(local + skew) });
			}
		};
		for (const span of activeSpans) shift(span, before.length - drop);
		for (const span of afterSpans) shift(span, slack + before.length + active.length - drop);
		this.#lastClickSpans = spans;
		this.#lastViewportRows = mutable;
		this.#lastViewportWidth = width;
		this.#syncLinkHints(mutable, width);
		if (history !== undefined && this.#offeredHistory?.source === "header") {
			const visibleHeaderRows = Math.max(0, rows - (mutable.length + drop));
			this.#retiredHeaderStart = Math.max(0, history.rows.length - visibleHeaderRows);
		}
		return { history, viewport: this.#paintLinkHints(this.#paintHoverBand(mutable, spans), width) };
	}

	/**
	 * Keep link-hint tags on what `rows` show. The first frame after `startLinkHints` tags its
	 * labels; later frames keep the tags while the tagged labels are still drawn first, in the same
	 * order and columns (rows may scroll, links may be added below), and otherwise end the mode, so a
	 * tag never picks a label no longer drawn under it. Every frame ends the mode as `"crowded"` when
	 * some row has more tag cells than `width` (a resize can narrow it), since tags drawn side by
	 * side could not all be read.
	 */
	#syncLinkHints(rows: readonly string[], width: number): void {
		const state = this.#linkHints;
		if (state === undefined) return;
		const targets = viewportLinkTargets(rows);
		const hints = state.hints;
		if (hints === undefined) {
			state.hints = linkHintTags(targets.length).map((tag, index) => ({ tag, link: targets[index]! }));
			if (state.hints.length === 0) {
				this.#endLinkHints();
				return;
			}
		} else {
			const unchanged =
				targets.length >= hints.length &&
				hints.every(({ link }, index) => link.url === targets[index]!.url && link.start === targets[index]!.start);
			if (!unchanged) {
				this.#endLinkHints();
				return;
			}
			state.hints = hints.map(({ tag }, index) => ({ tag, link: targets[index]! }));
		}
		const cells = new Map<number, number>();
		for (const { tag, link } of state.hints) cells.set(link.row, (cells.get(link.row) ?? 0) + tag.length);
		if ([...cells.values()].some(count => count > width)) this.#endLinkHints("crowded");
	}

	#endLinkHints(reason?: "crowded"): void {
		const state = this.#linkHints;
		if (state === undefined) return;
		this.#linkHints = undefined;
		state.onEnd(reason);
	}

	/**
	 * Draw every tag the typed letters still lead to over the start of its label. Tags on one row
	 * never overlap: one that would land on an earlier tag moves right, and tags that would run past
	 * the right edge move left, so each stays readable as long as the row has room for them all.
	 */
	#paintLinkHints(viewport: string[], width: number): string[] {
		const state = this.#linkHints;
		if (state?.hints === undefined) return viewport;
		const rows = new Map<number, { tag: string; col: number }[]>();
		for (const { tag, link } of state.hints) {
			if (viewport[link.row] === undefined || !tag.startsWith(state.typed)) continue;
			let row = rows.get(link.row);
			if (!row) rows.set(link.row, (row = []));
			row.push({ tag, col: link.start });
		}
		const painted = [...viewport];
		for (const [index, tags] of rows) {
			tags.sort((a, b) => a.col - b.col);
			let free = 0;
			for (const placed of tags) {
				placed.col = Math.max(placed.col, free);
				free = placed.col + placed.tag.length;
			}
			let limit = width;
			for (let i = tags.length - 1; i >= 0; i--) {
				const placed = tags[i]!;
				placed.col = Math.max(0, Math.min(placed.col, limit - placed.tag.length));
				limit = placed.col;
			}
			let line = painted[index]!;
			for (const { tag, col } of tags) {
				// Raw SGR like the hover highlight: chalk's inverse/bold drop out when it detects no color.
				const styled = `\x1b[1;7m${theme.fg("accent", tag)}\x1b[22;27m`;
				line = compositeLineAt(line, styled, col, tag.length, width);
			}
			painted[index] = line;
		}
		return painted;
	}

	/**
	 * Describe the whole surface for a TSP terminal. `main` is the flowing
	 * document: the header (welcome, extras) and every transcript block as its
	 * own component child. `dock` is the live chrome below the transcript in
	 * render order: pending messages, HUDs, the working row, the editor and the
	 * status line. There is no history/viewport split: retirement, resize
	 * replay and hover bands are ANSI concerns.
	 */
	describeSurface(): NativeSurface {
		if (!this.#started || this.#stopped) return this.#nativeSurface;
		const main: NativeChild[] = [...this.#header.children];
		const dock: NativeChild[] = [];
		if (!this.#runtimeMounted) {
			// The bootstrap gap is row spacing; the terminal owns the dock layout.
			dock.push(this.editor);
		} else {
			const roots = this.#runtimeChildren;
			const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
			if (transcriptIndex < 0) {
				dock.push(...roots);
			} else {
				const transcript = roots[transcriptIndex] as TranscriptContainer;
				main.push(...roots.slice(0, transcriptIndex), ...transcript.nativeBlocks());
				dock.push(...(this.#nativeDock ?? roots.slice(transcriptIndex + 1)));
			}
		}
		const previous = this.#nativeSurface;
		const nextMain = sameItems(previous.main, main) ? previous.main : main;
		const nextDock = sameItems(previous.dock, dock) ? previous.dock : dock;
		if (nextMain !== previous.main || nextDock !== previous.dock) {
			this.#nativeSurface = { main: nextMain, dock: nextDock };
		}
		return this.#nativeSurface;
	}

	/**
	 * Append one below-transcript root's rows to `after`, recording click spans
	 * for its row targets in `after` coordinates.
	 *
	 * Row targets usually nest one level down: chrome roots are plain
	 * containers (the HUD lives inside `subagentContainer`), and
	 * `Container.render` is a pure concatenation, so child spans tile the root
	 * span exactly. Render those children once and share the rows for
	 * composition and measurement — a second render per frame would duplicate
	 * render-time side effects (image placement registration). Roots with a
	 * custom render keep the composed output as the source of truth and measure
	 * up to the last target.
	 */
	#renderBelowRoot(root: Component, width: number, after: string[], spans: ViewportClickSpan[]): void {
		const start = after.length;
		const plainContainer = root instanceof Container && root.render === Container.prototype.render;
		const targets = root instanceof Container ? root.children : [root];
		const resolves = targets.map(rowTargetCandidates);
		const lastTarget = resolves.findLastIndex(resolve => resolve !== undefined);
		if (plainContainer) {
			let offset = start;
			for (let index = 0; index < targets.length; index++) {
				const childLines = targets[index]!.render(width);
				after.push(...childLines);
				if (index > lastTarget) continue;
				const resolve = resolves[index];
				if (resolve !== undefined && childLines.length > 0) {
					spans.push({ start: offset, end: offset + childLines.length, candidates: resolve });
				}
				offset += childLines.length;
			}
			return;
		}
		after.push(...root.render(width));
		if (lastTarget === -1) return;
		let offset = start;
		for (let index = 0; index <= lastTarget; index++) {
			const childLines = targets[index] === root ? after.length - start : targets[index]!.render(width).length;
			const resolve = resolves[index];
			if (resolve !== undefined && childLines > 0) {
				spans.push({ start: offset, end: offset + childLines, candidates: resolve });
			}
			offset += childLines;
		}
	}

	/**
	 * Band the hovered click target's current rows. Id-anchored (not
	 * line-anchored) so the band follows an agent whose rows shift while it
	 * streams; a retired id matches no span and simply paints nothing. Only
	 * the viewport copy is banded — retirement reads unbanded component rows.
	 */
	#paintHoverBand(viewport: string[], spans: readonly ViewportClickSpan[]): string[] {
		const hovered = this.#hoveredClickId;
		if (hovered === undefined) return viewport;
		let banded = false;
		const painted = viewport.map((line, index) => {
			for (const span of spans) {
				if (index < span.start || index >= span.end) continue;
				if (!span.candidates(index - span.start).includes(hovered)) continue;
				banded = true;
				// A wrapping band loses to background opens nested inside the row
				// (live card rows carry the pending-tint bg, which would paint over
				// the band for every cell it covers), so drop nested bg opens
				// first; their closes stay and become band resumes via bgFill.
				return theme.bgFill("selectedBg", line.replace(NESTED_BG_OPEN_PATTERN, ""));
			}
			return line;
		});
		return banded ? painted : viewport;
	}

	/**
	 * Candidate subagent ids under a mutable-viewport line, for click-to-focus.
	 * Empty when the line has no click target (chrome, separators, retired rows
	 * are never in the viewport). Callers intersect with the live registry.
	 */
	viewportClickCandidates(index: number): string[] {
		return routeViewportClick(this.#lastClickSpans, index);
	}

	/**
	 * The extension-owned link label drawn at cell `col` of a mutable-viewport line, or `undefined`.
	 * Only links whose scheme an extension registered match; see `extensionLinkLabels`.
	 */
	viewportLinkAt(index: number, col: number): ViewportLink | undefined {
		const line = this.#lastViewportRows[index];
		if (line === undefined || col < 0) return undefined;
		const label = extensionLinkLabels(line).find(label => col >= label.start && col < label.end);
		return label && { url: label.url, row: index, start: label.start };
	}

	/**
	 * Point the hover band at a click-candidate id (or clear it). Takes effect
	 * on the next frame; callers repaint only when the target actually changes.
	 */
	setHoveredClickId(id: string | undefined): void {
		this.#hoveredClickId = id;
	}

	/** How many extension link labels the last frame drew; a label wrapped across rows counts once. */
	viewportLinkCount(): number {
		return viewportLinkTargets(this.#lastViewportRows).length;
	}

	/**
	 * Enter keyboard link-hint mode: the next frame draws a tag over each extension link label it
	 * shows. `onEnd` runs once when the mode ends: a pick, a cancel, a key no tag starts with, a
	 * repaint that no longer draws the tagged labels where they were, or (`"crowded"`) a row with
	 * too many links for their tags to fit side by side.
	 */
	startLinkHints(onEnd: LinkHintsEnd): void {
		this.#endLinkHints();
		this.#linkHints = { hints: undefined, typed: "", onEnd };
	}

	/** Whether link-hint mode is on. */
	get linkHintsActive(): boolean {
		return this.#linkHints !== undefined;
	}

	/**
	 * Type one letter of a tag. Returns the link whose whole tag is now typed, `true` while the
	 * letters still lead to several tags, and `false` when none starts with them. The mode ends on
	 * a pick or a miss.
	 */
	typeLinkHint(letter: string): ViewportLink | boolean {
		const state = this.#linkHints;
		if (state === undefined) return false;
		// A key typed before the tags were first painted picks among the labels last drawn.
		if (state.hints === undefined) this.#syncLinkHints(this.#lastViewportRows, this.#lastViewportWidth);
		const hints = this.#linkHints?.hints;
		if (hints === undefined) return false;
		const typed = state.typed + letter.toLowerCase();
		const matching = hints.filter(hint => hint.tag.startsWith(typed));
		const picked = matching.length === 1 && matching[0]!.tag === typed ? matching[0]!.link : undefined;
		if (matching.length === 0 || picked !== undefined) {
			this.#endLinkHints();
			return picked ?? false;
		}
		state.typed = typed;
		return true;
	}

	/** Leave link-hint mode without picking a link. */
	cancelLinkHints(): void {
		this.#endLinkHints();
	}

	/** Acknowledges one accepted header, replay, or transcript batch. */
	acknowledgeHistory(id: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined || offered.id !== id) return;
		if (offered.source === "header") {
			this.#headerRetired = true;
			this.#welcome?.stopAmbient();
			this.#retiredHeaderRows = offered.rows;
		} else {
			if (offered.source.transcriptId !== undefined) {
				offered.source.transcript.acknowledgeFinalizedBatch(offered.source.transcriptId);
			}
			if (offered.source.header === "replay") {
				this.#headerReplayPending = false;
				if (offered.source.headerRows !== undefined) this.#retiredHeaderRows = offered.source.headerRows;
			}
		}
		this.#offeredHistory = undefined;
		if (this.#historyReplayRequested) this.#startHistoryReplay();
		if (offered.kind === "replay") {
			this.ui.requestRender();
		}
	}

	/** Render the semantic transcript tail while the terminal borrows its resize buffer. */
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		const { width: columnWidth, margin } = this.#column(viewport.columns);
		return this.#paint(
			Composer.#indent(this.#renderColumnResizeFrame({ ...viewport, columns: columnWidth }), margin),
			viewport.columns,
		);
	}

	#renderColumnResizeFrame(viewport: ViewportSize): readonly string[] {
		if (!this.#started || this.#stopped) return [];
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		const tail = this.#runtimeMounted
			? this.#renderResizeTail(width, rows)
			: this.#renderRoots([this.#bootstrapInputGap, this.editor, this.#statusHost], width);
		let header: readonly string[];
		if (this.#headerRetired) {
			this.#resizeRetiredHeaderStart ??= Math.max(
				0,
				this.#retiredHeaderStart - Math.max(0, rows - this.#lastNormalRows),
			);
			header = this.#reflowRetiredHeader(width, this.#resizeRetiredHeaderStart);
		} else {
			header = this.#header.render(width);
		}
		const rendered = [...header, ...tail];
		return rendered.length <= rows ? rendered : rendered.slice(rendered.length - rows);
	}

	/** Replays committed presentation without changing logical retirement state. */
	beginHistoryReplay(): void {
		if (this.#offeredHistory !== undefined) {
			this.#historyReplayRequested = true;
			return;
		}
		this.#startHistoryReplay();
	}

	/** Forces every currently eligible finalized prefix to retire before stop. */
	beginHistoryFlush(): void {
		this.#historyFlush = true;
		// A pending replay would re-render and re-stream the entire committed
		// ledger during shutdown; the terminal already holds that history, so
		// flush emits only genuinely un-retired rows. An already offered batch
		// stays valid and is accepted by the flush loop.
		this.#historyReplayRequested = false;
		this.#headerReplayPending = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.cancelReplay();
		}
	}

	#startHistoryReplay(): void {
		this.#headerReplayPending = this.#headerRetired && (this.#retiredHeaderRows?.length ?? 0) > 0;
		this.#historyReplayRequested = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.beginReplay();
		}
	}

	/** Raise the floor to eligible idle chrome that survives the settle window, even if it appeared after the run. */
	#rebaselineChromeFloor(busy: boolean, chrome: number): void {
		if (busy || chrome <= (this.#chromeFloor ?? chrome)) {
			this.#resetIdleChrome();
			return;
		}
		if (this.#idleChromeSettled && this.#idleChrome === chrome) {
			this.#chromeFloorPromoted = true;
			this.#chromeFloor = chrome;
			this.#resetIdleChrome();
			return;
		}
		if (this.#idleChrome === chrome && this.#idleChromeTimer !== undefined) return;
		this.#resetIdleChrome();
		this.#idleChrome = chrome;
		this.#idleChromeTimer = this.ui.scheduleAfter(IDLE_CHROME_SETTLE_MS, () => {
			this.#idleChromeTimer = undefined;
			this.#idleChromeSettled = true;
			this.ui.requestRender();
		});
	}

	#resetIdleChrome(): void {
		this.#idleChromeTimer?.cancel();
		this.#idleChromeTimer = undefined;
		this.#idleChrome = undefined;
		this.#idleChromeSettled = false;
	}

	/** Track the empty editor's pre-mount height per shape; a shape change restarts the measurement. */
	#recordBootstrapEditorRows(rows: number): void {
		const style = this.editor.getBorderStyle();
		this.#bootstrapEditorRows =
			style === this.#bootstrapEditorStyle ? Math.min(this.#bootstrapEditorRows ?? rows, rows) : rows;
		this.#bootstrapEditorStyle = style;
	}

	/**
	 * Follow the transient roots' resting height. Normally a running minimum; when the editor or its
	 * shape changes, the floor shifts by that frame's height change instead, so draft growth stays
	 * excluded while the new shape's fixed rows are billed.
	 */
	#syncTransientFloor(transientRows: number): number {
		const editor = this.editor;
		const style = editor.getBorderStyle();
		let floor: number;
		if (this.#transientFloor === undefined) {
			// The first runtime frame may already carry a replayed startup draft; seed from the empty
			// editor's pre-mount height when it was painted in the same shape.
			const bootstrap = this.#bootstrapEditorStyle === style ? this.#bootstrapEditorRows : undefined;
			floor = bootstrap === undefined ? transientRows : Math.min(transientRows, bootstrap);
		} else if (editor !== this.#transientEditor || style !== this.#transientEditorStyle) {
			floor = Math.max(0, Math.min(transientRows, this.#transientFloor + transientRows - this.#lastTransientRows));
		} else {
			floor = Math.min(this.#transientFloor, transientRows);
		}
		this.#transientFloor = floor;
		this.#bootstrapEditorRows = undefined;
		this.#bootstrapEditorStyle = undefined;
		this.#transientEditor = editor;
		this.#transientEditorStyle = style;
		this.#lastTransientRows = transientRows;
		return floor;
	}

	/** Header retires first; replay coalesces it with the complete transcript ledger. */
	#offerHistory(
		transcript: TranscriptContainer,
		width: number,
		rows: number,
		chromeRows: number,
	): { id: number; rows: readonly string[]; kind: "append" | "replay" } | undefined {
		if (this.#offeredHistory !== undefined) {
			this.#rerenderOfferedHistory(width);
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (this.#headerReplayPending) {
			const transcriptReplay = transcript.peekReplayBatch(width);
			// A replay follows a scrollback clear, so the header recomposes at
			// the new width exactly like transcript entries do. An empty
			// recompose (welcome unmounted after retirement) falls back to the
			// committed rows, hard-wrapped the way the terminal would.
			const recomposed = this.#header.render(width);
			const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
			this.#offeredHistory = {
				id: this.#nextHistoryId++,
				rows: [...headerRows, ...(transcriptReplay?.rows ?? [])],
				kind: "replay",
				source: {
					transcript,
					transcriptId: transcriptReplay?.id,
					header: "replay",
					headerRows,
				},
			};
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (!this.#headerRetired) {
			const welcome = this.#welcome;
			if (welcome !== undefined && !welcome.isTranscriptBlockFinalized()) return undefined;
			// The header stays live viewport chrome until the screen fills; then it
			// retires first so transcript prefixes can follow in order.
			const renderedHeader = this.#header.render(width);
			if (renderedHeader.length > 0) {
				// Only the comparison below reads the height, so the walk stops at
				// the budget instead of rendering every replayed block (#12933).
				const liveRows = transcript.liveRowCount(width, Math.max(0, rows - renderedHeader.length - chromeRows));
				if (!this.#historyFlush && renderedHeader.length + chromeRows + liveRows <= rows) return undefined;
				this.#offeredHistory = {
					id: this.#nextHistoryId++,
					rows: [...renderedHeader, ""],
					kind: "append",
					source: "header",
				};
				return {
					id: this.#offeredHistory.id,
					rows: this.#offeredHistory.rows,
					kind: this.#offeredHistory.kind,
				};
			}
			this.#headerRetired = true;
			this.#retiredHeaderRows = [];
			this.#welcome?.stopAmbient();
		}
		const batch = this.#historyFlush
			? transcript.peekFlushBatch(width)
			: transcript.peekFinalizedBatch(width, Math.max(0, rows - chromeRows));
		if (batch === undefined) return undefined;
		this.#offeredHistory = {
			id: this.#nextHistoryId++,
			rows: batch.rows,
			kind: batch.kind ?? "append",
			source: { transcript, transcriptId: batch.id, header: "none" },
		};
		return {
			id: this.#offeredHistory.id,
			rows: this.#offeredHistory.rows,
			kind: this.#offeredHistory.kind,
		};
	}

	#rerenderOfferedHistory(width: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined) return;
		if (offered.source === "header") {
			const rows = this.#header.render(width);
			offered.rows = rows.length > 0 ? [...rows, ""] : [];
			return;
		}
		const transcript = offered.source.transcript.rerenderOfferedBatch(width);
		if (offered.source.header === "none") {
			if (transcript !== undefined) offered.rows = transcript.rows;
			return;
		}
		const recomposed = this.#header.render(width);
		const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
		offered.source.headerRows = headerRows;
		offered.rows = [...headerRows, ...(transcript?.rows ?? [])];
	}

	#renderRoots(roots: readonly Component[], width: number): string[] {
		const rows: string[] = [];
		for (const root of roots) rows.push(...root.render(width));
		return rows;
	}
	/**
	 * Mounted-runtime rows for the transient resize buffer. Only the trailing
	 * viewport can survive the caller's bottom slice, so the transcript renders
	 * a bounded tail instead of the full committed ledger, and the chrome above
	 * it renders only when that tail underfills the screen.
	 */
	#renderResizeTail(width: number, rows: number): string[] {
		const roots = [...this.#runtimeChildren, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) return this.#renderRoots(roots, width);
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const after = this.#renderRoots(roots.slice(transcriptIndex + 1), width);
		const transcriptRows = transcript.renderTail(width, Math.max(0, rows - after.length));
		const pre =
			transcriptRows.length + after.length >= rows ? [] : this.#renderRoots(roots.slice(0, transcriptIndex), width);
		return [...pre, ...transcriptRows, ...after];
	}

	/** Reflow accepted hard rows exactly as the restored terminal buffer will. */
	#reflowRetiredHeader(width: number, start: number): string[] {
		const lines = this.#retiredHeaderRows;
		if (!lines) return [];
		if (isInsideTerminalMultiplexer()) return lines.slice(start);
		const reflowed: string[] = [];
		for (let index = start; index < lines.length; index++) {
			reflowed.push(...wrapLiteralLine(lines[index]!, width));
		}
		return reflowed;
	}

	/** Live editor whose draft survives startup and session adoption. */
	get editor(): CustomEditor {
		return this.#editor;
	}

	/** The welcome component currently mounted in the header, if quiet mode is off. */
	get welcome(): WelcomeComponent | undefined {
		return this.#welcome;
	}

	/** Whether this composer already owns the terminal render/input loop. */
	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	/** Start terminal ownership and optionally begin the welcome intro. */
	start(options: ComposerStartOptions = {}): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		// A TSP terminal keeps (and draws) what is typed until startup releases
		// the held input, standing in for the kernel echo other terminals give.
		this.#editor.nativeTypeahead = options.deferInput === true;
		this.ui.start({ clearScrollback: options.clearScrollback === true, deferInput: options.deferInput === true });
		this.#applyBackgroundPaint();
		// The prepaint runs before module loading blocks the event loop: hold the
		// reveal's first frame until InteractiveMode can animate it.
		if (options.deferInput === true) this.#welcome?.holdIntro();
		else if (options.playWelcomeIntro !== false) this.playWelcomeIntro();
		else this.#startWelcomeAmbient();
		// Deferred input identifies the CLI prepaint handoff. Flush the queued
		// forced frame before returning so subsequent dynamic-import evaluation
		// cannot monopolize the event loop ahead of the speculative status chrome.
		if (options.deferInput === true) this.ui.renderNow({ clearScrollback: options.clearScrollback === true });
	}
	/** Take raw-input ownership after a deferred-input start. Idempotent. */
	enableInput(): void {
		if (this.#stopped) return;
		this.ui.enableInput();
	}

	/** Paint (or give back) the terminal's default background per the preference and the active theme. */
	#applyBackgroundPaint(): void {
		if (!this.#started || this.#stopped) return;
		this.#terminal.setDefaultBackground?.(
			this.#preferences.paintBackground === true ? theme.terminalBackground : undefined,
		);
	}

	/** Repaint the terminal's background after a theme change. */
	refreshBackgroundPaint(): void {
		this.#applyBackgroundPaint();
	}

	/** Apply settings changes without replacing the editor or welcome component. */
	setPreferences(update: Partial<ComposerPreferences>): void {
		if (this.#stopped) return;
		const wasQuiet = this.#preferences.quiet;
		this.#preferences = { ...this.#preferences, ...update };
		this.#applyBackgroundPaint();
		this.editor.setTheme(getEditorTheme());
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		this.ui.setShowHardwareCursor(this.#preferences.showHardwareCursor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		if (update.resizeScrollback !== undefined) this.ui.setResizeScrollback(update.resizeScrollback);
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		this.#startupStatus?.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
		if (this.#preferences.quiet) {
			this.#welcome?.stopIntro();
			this.#welcome?.stopAmbient();
			this.#welcome = undefined;
		} else {
			this.#ensureWelcome();
			this.#welcome?.invalidate();
			if (wasQuiet && this.#started) this.playWelcomeIntro();
		}
		if (wasQuiet !== this.#preferences.quiet) this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Patch welcome data in place as version, session, and project discovery complete. */
	updateWelcome(update: ComposerWelcomeUpdate): void {
		if (this.#stopped) return;
		this.#applyWelcomeUpdate(update);
		if (this.#preferences.quiet) return;
		this.#ensureWelcome();
		const welcome = this.#welcome;
		if (!welcome) return;
		if (update.version !== undefined) welcome.setVersion(this.#version);
		this.ui.requestRender();
	}

	/**
	 * Mark whether a host agent run is in flight. Mid-run gaps with no streaming
	 * block (tool arguments not yet parseable, between tool calls) then do not
	 * count as the run ending when the post-run chrome floor is decided.
	 */
	setRunActive(active: boolean): void {
		if (this.#runActive === active) return;
		this.#runActive = active;
		this.ui.requestRender();
	}

	/** Replace optional header content around the stable welcome scene. */
	setHeaderExtras(before: readonly Component[], after: readonly Component[]): void {
		if (this.#stopped) return;
		this.#headerBefore = before;
		this.#headerAfter = after;
		this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Update the canonical editor reference after InteractiveMode remounts a custom editor. */
	setEditor(editor: CustomEditor): void {
		this.ui.replaceHeldFocus(this.#editor, editor);
		editor.nativeTypeahead = this.#editor.nativeTypeahead;
		this.#editor = editor;
	}

	/**
	 * End the startup input hold once the app's handlers are wired: the TSP
	 * terminal sends the typing it kept, and the keys the TUI held replay
	 * ({@link TUI.releaseHeldInput}). Idempotent.
	 */
	releaseHeldInput(): void {
		if (this.#editor.nativeTypeahead) {
			this.#editor.nativeTypeahead = false;
			this.ui.requestRender();
		}
		this.ui.releaseHeldInput();
	}

	/**
	 * Mount the session-aware status component into the slot below the editor,
	 * retiring the startup status line; the caller installs the real top-border
	 * provider through its composer-shape sync.
	 */
	setStatusComponent<TSession extends StatusLineSession>(component: StatusLineComponent<TSession>): void {
		if (this.#startupStatus) component.adoptGitStatus(this.#startupStatus);
		this.#disposeStartupStatus();
		this.#statusHost.setComponent(component);
		this.editor.setTopBorderProvider(undefined);
		this.editor.composerFacts = component;
	}

	#disposeStartupStatus(): void {
		this.#startupStatus?.dispose();
		this.#startupStatus = undefined;
	}

	/** Mount or replace session-aware root children while preserving the header and status hosts. */
	setRuntimeChildren(children: readonly Component[], options: RuntimeChildrenOptions = {}): void {
		if (this.#stopped) return;
		this.#chromeFloor = undefined;
		this.#chromeFloorPromoted = false;
		this.#resetIdleChrome();
		this.#nativeDock = options.nativeDock;
		this.#transientChrome = new Set(options.transientChrome);
		this.#selfClearingChrome = new Set(options.selfClearingChrome);
		this.#transientFloor = undefined;
		this.ui.removeChild(this.#statusHost);
		if (this.#runtimeMounted) {
			for (const child of this.#runtimeChildren) this.ui.removeChild(child);
		} else {
			this.ui.removeChild(this.#bootstrapInputGap);
			this.ui.removeChild(this.editor);
			this.#runtimeMounted = true;
		}
		this.#runtimeChildren = children;
		for (const child of children) this.ui.addChild(child);
		this.ui.addChild(this.#statusHost);
		this.ui.requestRender();
	}

	/** Play or replay the welcome intro against the stable header render target. */
	playWelcomeIntro(): void {
		this.#welcome?.playIntro(() => {
			this.editor.invalidate();
			this.ui.requestRender();
		});
		this.#startWelcomeAmbient();
	}

	/** Drop any held or running reveal and show the resting welcome. */
	settleWelcome(): void {
		this.#welcome?.stopIntro();
		this.#startWelcomeAmbient();
		this.editor.invalidate();
		this.ui.requestRender();
	}

	/** Keep the arcade cabinet moving until the header retires to history. */
	#startWelcomeAmbient(): void {
		if (this.#headerRetired || this.#stopped) return;
		this.#welcome?.startAmbient(() => this.ui.requestRender());
	}

	/** Transfer terminal ownership to InteractiveMode without stopping the composer. */
	transfer(): void {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Composer is not available for transfer");
		}
		this.#transferred = true;
	}

	/** Stop a composer that has not transferred terminal ownership. */
	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.#welcome?.stopIntro();
		this.#welcome?.stopAmbient();
		this.#disposeStartupStatus();
		this.ui.stop();
		this.#stopped = true;
	}

	#applyWelcomeUpdate(update: ComposerWelcomeUpdate): void {
		if (update.version !== undefined) this.#version = update.version;
	}

	#ensureWelcome(): void {
		this.#welcome ??= new WelcomeComponent(this.#version);
		this.#welcome.setMinimal(this.#preferences.composerShape === "rail");
	}

	#rebuildHeader(): void {
		this.#header.clear();
		for (const component of this.#headerBefore) this.#header.addChild(component);
		if (this.#welcome) {
			this.#header.addChild(new Spacer(1));
			this.#header.addChild(this.#welcome);
			this.#header.addChild(new Spacer(1));
		}
		for (const component of this.#headerAfter) this.#header.addChild(component);
	}

	#handleInterrupt(): void {
		const now = this.#now();
		if (now - this.#lastInterruptAt < DOUBLE_INTERRUPT_MS) {
			this.#requestExit(130);
			return;
		}
		this.editor.setText("");
		this.#lastInterruptAt = now;
	}

	#requestExit(code: number): void {
		// Remains live after transfer until InteractiveMode installs its configured handlers.
		if (this.#stopped) return;
		this.#welcome?.stopIntro();
		this.#welcome?.stopAmbient();
		if (this.#started) this.ui.stop();
		this.#stopped = true;
		this.#exit(code);
	}
}
