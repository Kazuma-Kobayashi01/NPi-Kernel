import { type } from "@oh-my-pi/omptype";

const visibleWhen = { id: "string", equals: "string | number | boolean" } as const;
const component = type.or(
	{ type: "'text'", id: "string", text: "string", "label?": "string", "visibleWhen?": visibleWhen },
	{ type: "'card'", id: "string", "title?": "string", "subtitle?": "string", "content?": "string", "tag?": "string", "visibleWhen?": visibleWhen },
	{ type: "'stat'", id: "string", label: "string", value: "string", "diff?": "string", "trend?": "'up' | 'down' | 'neutral'", "unit?": "string", "visibleWhen?": visibleWhen },
	{ type: "'badge'", id: "string", text: "string", "variant?": "'default' | 'success' | 'warning' | 'danger' | 'info'", "visibleWhen?": visibleWhen },
	{ type: "'alert'", id: "string", message: "string", "title?": "string", "level?": "'info' | 'success' | 'warning' | 'danger'", "visibleWhen?": visibleWhen },
	{ type: "'progress'", id: "string", "label?": "string", value: "number", "max?": "number", "unit?": "string", "visibleWhen?": visibleWhen },
	{ type: "'table'", id: "string", "title?": "string", columns: type({ key: "string", label: "string", "align?": "'left' | 'center' | 'right'" }).array(), rows: type("Record<string, unknown>").array(), "visibleWhen?": visibleWhen },
	{ type: "'key-value'", id: "string", "title?": "string", items: type({ key: "string", label: "string", value: "string" }).array(), "visibleWhen?": visibleWhen },
	{ type: "'collapsible'", id: "string", title: "string", content: "string", "defaultExpanded?": "boolean", "visibleWhen?": visibleWhen },
	{ type: "'tabs'", id: "string", items: type({ id: "string", label: "string", content: "string" }).array(), "defaultTab?": "string", "visibleWhen?": visibleWhen },
	{ type: "'timeline'", id: "string", "title?": "string", items: type({ time: "string", title: "string", "description?": "string", "status?": "'pending' | 'current' | 'done' | 'failed'" }).array(), "visibleWhen?": visibleWhen },
	{ type: "'bar-chart' | 'line-chart' | 'pie-chart'", id: "string", "title?": "string", "unit?": "string", data: type({ label: "string", value: "number", "color?": "string" }).array(), "visibleWhen?": visibleWhen },
	{ type: "'divider'", id: "string", "label?": "string", "visibleWhen?": visibleWhen },
	{ type: "'image'", id: "string", src: "string", "thumbnail?": "string", "alt?": "string", "title?": "string", "sourceUrl?": "string", "attribution?": "string", "visibleWhen?": visibleWhen },
	{ type: "'button'", id: "string", label: "string" },
	{ type: "'input'", id: "string", label: "string", "default?": "string", "required?": "boolean", "minLength?": "number", "maxLength?": "number", "placeholder?": "string", "visibleWhen?": visibleWhen },
	{ type: "'textarea'", id: "string", label: "string", "default?": "string", "required?": "boolean", "minLength?": "number", "maxLength?": "number", "rows?": "number", "placeholder?": "string", "visibleWhen?": visibleWhen },
	{ type: "'date' | 'date-picker'", id: "string", label: "string", "default?": "string", "min?": "string", "max?": "string", "required?": "boolean", "visibleWhen?": visibleWhen },
	{ type: "'time-picker'", id: "string", label: "string", "default?": "string", "required?": "boolean", "visibleWhen?": visibleWhen },
	{ type: "'slider' | 'number' | 'number-input'", id: "string", label: "string", min: "number", max: "number", default: "number", "step?": "number", "unit?": "string", "visibleWhen?": visibleWhen },
	{ type: "'checkbox' | 'switch'", id: "string", label: "string", "default?": "boolean", "visibleWhen?": visibleWhen },
	{ type: "'select' | 'radio' | 'segmented-control' | 'searchable-select'", id: "string", label: "string", options: type({ label: "string", value: "string", "description?": "string" }).array(), "default?": "string", "required?": "boolean", "visibleWhen?": visibleWhen },
	{ type: "'multiselect' | 'checkbox-group'", id: "string", label: "string", options: type({ label: "string", value: "string", "description?": "string" }).array(), "default?": "string[]", "minItems?": "number", "maxItems?": "number", "visibleWhen?": visibleWhen },
	{ type: "'option-cards'", id: "string", label: "string", cards: type({ id: "string", title: "string", "description?": "string", "tag?": "string", "recommended?": "boolean" }).array(), "default?": "string", "required?": "boolean", "visibleWhen?": visibleWhen },
);

export const uiPresentParameters = type({
	schema: {
		version: "1",
		"mode?": "'display' | 'interactive'",
		"title?": "string",
		"layout?": "'stack' | 'row' | 'grid' | 'column'",
		components: component.array(),
	},
}).onDeepUndeclaredKey("reject");

export type UiMode = "display" | "interactive";
export type UiValue = string | number | boolean | string[];
export type UiVisibleWhen = { id: string; equals: string | number | boolean };
export type UiOption = { label: string; value: string; description?: string };
export type UiTableColumn = { key: string; label: string; align?: "left" | "center" | "right" };
export type UiKeyValueItem = { key: string; label: string; value: string };
export type UiTabItem = { id: string; label: string; content: string };
export type UiTimelineItem = { time: string; title: string; description?: string; status?: "pending" | "current" | "done" | "failed" };
export type UiChartDataPoint = { label: string; value: number; color?: string };
export type UiOptionCard = { id: string; title: string; description?: string; tag?: string; recommended?: boolean };

export type UiComponent =
	// Display components
	| { type: "text"; id: string; text: string; label?: string; visibleWhen?: UiVisibleWhen }
	| { type: "card"; id: string; title?: string; subtitle?: string; content?: string; tag?: string; visibleWhen?: UiVisibleWhen }
	| { type: "stat"; id: string; label: string; value: string; diff?: string; trend?: "up" | "down" | "neutral"; unit?: string; visibleWhen?: UiVisibleWhen }
	| { type: "badge"; id: string; text: string; variant?: "default" | "success" | "warning" | "danger" | "info"; visibleWhen?: UiVisibleWhen }
	| { type: "alert"; id: string; message: string; title?: string; level?: "info" | "success" | "warning" | "danger"; visibleWhen?: UiVisibleWhen }
	| { type: "progress"; id: string; label?: string; value: number; max: number; unit?: string; visibleWhen?: UiVisibleWhen }
	| { type: "table"; id: string; title?: string; columns: UiTableColumn[]; rows: Record<string, string | number>[]; visibleWhen?: UiVisibleWhen }
	| { type: "key-value"; id: string; title?: string; items: UiKeyValueItem[]; visibleWhen?: UiVisibleWhen }
	| { type: "collapsible"; id: string; title: string; content: string; defaultExpanded?: boolean; visibleWhen?: UiVisibleWhen }
	| { type: "tabs"; id: string; items: UiTabItem[]; defaultTab?: string; visibleWhen?: UiVisibleWhen }
	| { type: "timeline"; id: string; title?: string; items: UiTimelineItem[]; visibleWhen?: UiVisibleWhen }
	| { type: "bar-chart" | "line-chart" | "pie-chart"; id: string; title?: string; unit?: string; data: UiChartDataPoint[]; visibleWhen?: UiVisibleWhen }
	| { type: "divider"; id: string; label?: string; visibleWhen?: UiVisibleWhen }
	| { type: "image"; id: string; src: string; thumbnail?: string; alt?: string; title?: string; sourceUrl?: string; attribution?: string; visibleWhen?: UiVisibleWhen }
	// Interactive components
	| { type: "button"; id: string; label: string }
	| { type: "input" | "textarea"; id: string; label: string; default: string; required: boolean; minLength: number; maxLength: number; rows?: number; placeholder?: string; visibleWhen?: UiVisibleWhen }
	| { type: "number-input" | "slider" | "number"; id: string; label: string; min: number; max: number; step: number; default: number; unit?: string; visibleWhen?: UiVisibleWhen }
	| { type: "date" | "date-picker"; id: string; label: string; default: string; required: boolean; min?: string; max?: string; visibleWhen?: UiVisibleWhen }
	| { type: "time-picker"; id: string; label: string; default: string; required: boolean; visibleWhen?: UiVisibleWhen }
	| { type: "checkbox" | "switch"; id: string; label: string; default: boolean; visibleWhen?: UiVisibleWhen }
	| { type: "checkbox-group" | "multiselect"; id: string; label: string; options: UiOption[]; default: string[]; minItems: number; maxItems: number; visibleWhen?: UiVisibleWhen }
	| { type: "select" | "radio" | "segmented-control" | "searchable-select"; id: string; label: string; options: UiOption[]; default: string; required: boolean; visibleWhen?: UiVisibleWhen }
	| { type: "option-cards"; id: string; label: string; cards: UiOptionCard[]; default: string; required: boolean; visibleWhen?: UiVisibleWhen };

/** Components that collect or submit input; every non-button member carries a `default` for hidden values. */
export type UiInteractiveComponent = Extract<UiComponent, {
	type: "button" | "input" | "textarea" | "number-input" | "slider" | "number" |
	"date" | "date-picker" | "time-picker" | "checkbox" | "switch" |
	"checkbox-group" | "multiselect" | "select" | "radio" |
	"segmented-control" | "searchable-select" | "option-cards";
}>;

/** Interactive components that hold a value; `button` only submits the form. */
export type UiControl = Exclude<UiInteractiveComponent, { type: "button" }>;

export interface UiSchema {
	version: 1;
	mode: UiMode;
	title?: string;
	layout: "stack" | "row" | "grid" | "column";
	components: UiComponent[];
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown UI field: ${key}`);
}

function string(value: unknown, max: number, name: string): string {
	if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${name} (maximum ${max} characters)`);
	return value;
}

/** Image references stay compact: the host renders them, the model context only keeps the metadata. */
const MAX_IMAGE_REF = 2048;

/** Loopback, private, link-local and other non-public hosts that an image reference must never target. */
function localHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	const address = host.startsWith("[") ? host.slice(1, -1) : host;
	// IPv4-mapped IPv6 hides an arbitrary IPv4 address behind a hex suffix.
	if (address.startsWith("::ffff:")) return true;
	if (address === "::1" || address === "::") return true;
	if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	return a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
		(a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Public HTTPS reference; DNS, redirects and content are still validated by the trusted backend. */
function imageUrl(value: unknown, name: string): string {
	const s = string(value, MAX_IMAGE_REF, name);
	if (/\s/.test(s)) throw new Error(`Invalid ${name} (whitespace is not allowed)`);
	let url: URL;
	try {
		url = new URL(s);
	} catch {
		throw new Error(`Invalid ${name} (absolute https URL required)`);
	}
	if (url.protocol !== "https:") throw new Error(`${name} must use https`);
	if (url.username !== "" || url.password !== "") throw new Error(`${name} must not embed credentials`);
	if (localHostname(url.hostname)) throw new Error(`${name} must not target a local host`);
	// Persist the canonical spelling: the desktop loader classifies remotes by a literal `https://` prefix.
	// Percent-encoding can expand a raw ≤2048 reference, so the bound applies to the persisted form too.
	const canonical = url.toString();
	if (canonical.length > MAX_IMAGE_REF) throw new Error(`Invalid ${name} (canonical URL exceeds ${MAX_IMAGE_REF} characters)`);
	return canonical;
}

/** Image source: a project-contained relative path or a public HTTPS URL, never a data/blob URI. */
function imageSource(value: unknown): string {
	const s = string(value, MAX_IMAGE_REF, "image.src");
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return imageUrl(s, "image.src");
	if (s.startsWith("/") || s.startsWith("\\") || s.startsWith("~")) throw new Error("image.src must be project-relative");
	const segments = s.split(/[\\/]/);
	if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
		throw new Error("image.src must be a normalized project-relative path");
	}
	// The contract and the host's file reader are `/`-separated; a literal backslash is a filename on macOS.
	return segments.join("/");
}

function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error("Invalid UI number");
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("Invalid UI boolean");
	return value;
}

function integer(value: unknown, max: number): number {
	const n = number(value);
	if (!Number.isInteger(n) || n < 0 || n > max) throw new Error("Invalid UI integer limit");
	return n;
}

function numericValue(value: unknown, c: { min: number; max: number; step: number }): number {
	const n = number(value), steps = (n - c.min) / c.step;
	if (n < c.min || n > c.max || !Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-8) throw new Error("Numeric value is outside range or step");
	return n;
}

function selections(value: unknown, options: UiOption[], min: number, max: number): string[] {
	if (!Array.isArray(value) || value.length < min || value.length > max || new Set(value).size !== value.length || value.some(v => typeof v !== "string" || !options.some(o => o.value === v))) throw new Error("Invalid multiselect values or cardinality");
	return [...value];
}

function isoDate(value: unknown, name: string): string {
	const s = string(value, 10, name);
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (!m) throw new Error(`Invalid ${name}`);
	const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
	const dt = new Date(Date.UTC(y, mo - 1, d));
	if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`Invalid ${name}`);
	return s;
}

function timeString(value: unknown, name: string): string {
	const s = string(value, 8, name);
	const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
	if (!m) throw new Error(`Invalid ${name} (HH:MM or HH:MM:SS)`);
	return s;
}

/** Optional literal from untrusted input: absent stays absent, anything else must be one of `allowed`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`Invalid ${name}`);
	return value as T;
}

function parseVisibleWhen(value: unknown): UiVisibleWhen | undefined {
	if (value === undefined) return undefined;
	const raw = object(value);
	keys(raw, ["id", "equals"]);
	const id = string(raw.id, 64, "visibleWhen.id");
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid visibleWhen.id");
	const eq = raw.equals;
	if (typeof eq === "string") return { id, equals: string(eq, 128, "visibleWhen.equals") };
	if (typeof eq === "number") return { id, equals: number(eq) };
	if (typeof eq === "boolean") return { id, equals: eq };
	throw new Error("Invalid visibleWhen.equals");
}

export function isUiComponentVisible(component: UiComponent, values: Record<string, unknown>): boolean {
	if (component.type === "button" || !component.visibleWhen) return true;
	const target = values[component.visibleWhen.id];
	return Array.isArray(target) ? target.includes(component.visibleWhen.equals) : target === component.visibleWhen.equals;
}

export function isInteractiveComponent(c: UiComponent): c is UiInteractiveComponent {
	return [
		"button", "input", "textarea", "number-input", "slider", "number",
		"date", "date-picker", "time-picker", "checkbox", "switch",
		"checkbox-group", "multiselect", "select", "radio",
		"segmented-control", "searchable-select", "option-cards",
	].includes(c.type);
}

export function isUiControl(c: UiComponent): c is UiControl {
	return isInteractiveComponent(c) && c.type !== "button";
}

export function normalizeUiSchema(value: unknown): UiSchema {
	const schema = object(value);
	keys(schema, ["version", "mode", "title", "layout", "components"]);
	if (schema.version !== 1) throw new Error("Unsupported UI schema version");
	const layout = schema.layout === undefined ? "stack" : schema.layout;
	if (layout !== "stack" && layout !== "row" && layout !== "grid" && layout !== "column") throw new Error("Invalid UI layout");
	if (!Array.isArray(schema.components) || schema.components.length < 1 || schema.components.length > 24) {
		throw new Error("UI requires 1–24 components");
	}

	const ids = new Set<string>();
	let textLength = 0;
	const text = (v: unknown, max: number, name: string) => {
		const s = string(v, max, name);
		textLength += s.length;
		return s;
	};
	const title = schema.title === undefined ? undefined : text(schema.title, 160, "title");

	const components: UiComponent[] = schema.components.map(raw => {
		const c = object(raw);
		const id = string(c.id, 64, "id");
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || ids.has(id)) {
			throw new Error("Invalid or duplicate UI id");
		}
		ids.add(id);
		const cond = c.type === "button" ? undefined : parseVisibleWhen(c.visibleWhen);
		const condProp = cond === undefined ? {} : { visibleWhen: cond };
		// A validated string lets every case narrow `kind` to its exact component type.
		const kind = typeof c.type === "string" ? c.type : "";

		switch (kind) {
			case "text": {
				keys(c, ["type", "id", "text", "label", "visibleWhen"]);
				return { type: "text", id, text: text(c.text, 4096, "text"), ...(c.label === undefined ? {} : { label: text(c.label, 120, "label") }), ...condProp };
			}
			case "card": {
				keys(c, ["type", "id", "title", "subtitle", "content", "tag", "visibleWhen"]);
				return {
					type: "card", id,
					...(c.title === undefined ? {} : { title: text(c.title, 160, "card.title") }),
					...(c.subtitle === undefined ? {} : { subtitle: text(c.subtitle, 200, "card.subtitle") }),
					...(c.content === undefined ? {} : { content: text(c.content, 4096, "card.content") }),
					...(c.tag === undefined ? {} : { tag: text(c.tag, 60, "card.tag") }),
					...condProp,
				};
			}
			case "stat": {
				keys(c, ["type", "id", "label", "value", "diff", "trend", "unit", "visibleWhen"]);
				const trend = oneOf(c.trend, ["up", "down", "neutral"] as const, "stat trend");
				return {
					type: "stat", id,
					label: text(c.label, 120, "stat.label"),
					value: text(c.value, 60, "stat.value"),
					...(c.diff === undefined ? {} : { diff: text(c.diff, 60, "stat.diff") }),
					...(trend === undefined ? {} : { trend }),
					...(c.unit === undefined ? {} : { unit: text(c.unit, 30, "stat.unit") }),
					...condProp,
				};
			}
			case "badge": {
				keys(c, ["type", "id", "text", "variant", "visibleWhen"]);
				const variant = oneOf(c.variant, ["default", "success", "warning", "danger", "info"] as const, "badge variant");
				return { type: "badge", id, text: text(c.text, 60, "badge.text"), ...(variant === undefined ? {} : { variant }), ...condProp };
			}
			case "alert": {
				keys(c, ["type", "id", "message", "title", "level", "visibleWhen"]);
				const level = oneOf(c.level, ["info", "success", "warning", "danger"] as const, "alert level");
				return {
					type: "alert", id,
					message: text(c.message, 2048, "alert.message"),
					...(c.title === undefined ? {} : { title: text(c.title, 160, "alert.title") }),
					...(level === undefined ? {} : { level }),
					...condProp,
				};
			}
			case "progress": {
				keys(c, ["type", "id", "label", "value", "max", "unit", "visibleWhen"]);
				const max = c.max === undefined ? 100 : number(c.max);
				const val = number(c.value);
				if (max <= 0 || val < 0 || val > max) throw new Error("Invalid progress value or max");
				return {
					type: "progress", id,
					value: val, max,
					...(c.label === undefined ? {} : { label: text(c.label, 120, "progress.label") }),
					...(c.unit === undefined ? {} : { unit: text(c.unit, 30, "progress.unit") }),
					...condProp,
				};
			}
			case "table": {
				keys(c, ["type", "id", "title", "columns", "rows", "visibleWhen"]);
				if (!Array.isArray(c.columns) || c.columns.length < 1 || c.columns.length > 12) throw new Error("Table requires 1–12 columns");
				if (!Array.isArray(c.rows) || c.rows.length > 50) throw new Error("Table requires at most 50 rows");
				const cols = c.columns.map(rawCol => {
					const col = object(rawCol); keys(col, ["key", "label", "align"]);
					const align = oneOf(col.align, ["left", "center", "right"] as const, "table column align");
					return { key: text(col.key, 64, "col.key"), label: text(col.label, 120, "col.label"), ...(align === undefined ? {} : { align }) };
				});
				const rows = c.rows.map(rawRow => {
					const r = object(rawRow);
					const out: Record<string, string | number> = {};
					for (const col of cols) {
						const v = r[col.key];
						if (typeof v === "number") out[col.key] = number(v);
						else if (typeof v === "string") out[col.key] = text(v, 256, "table cell");
						else if (v === undefined || v === null) out[col.key] = "";
						else throw new Error("Table cell must be string or number");
					}
					return out;
				});
				return { type: "table", id, ...(c.title === undefined ? {} : { title: text(c.title, 160, "table.title") }), columns: cols, rows, ...condProp };
			}
			case "key-value": {
				keys(c, ["type", "id", "title", "items", "visibleWhen"]);
				if (!Array.isArray(c.items) || c.items.length < 1 || c.items.length > 30) throw new Error("key-value requires 1–30 items");
				const items = c.items.map(rawItem => {
					const item = object(rawItem); keys(item, ["key", "label", "value"]);
					return { key: text(item.key, 64, "item.key"), label: text(item.label, 120, "item.label"), value: text(item.value, 1024, "item.value") };
				});
				return { type: "key-value", id, ...(c.title === undefined ? {} : { title: text(c.title, 160, "key-value.title") }), items, ...condProp };
			}
			case "collapsible": {
				keys(c, ["type", "id", "title", "content", "defaultExpanded", "visibleWhen"]);
				return {
					type: "collapsible", id,
					title: text(c.title, 160, "collapsible.title"),
					content: text(c.content, 4096, "collapsible.content"),
					...(c.defaultExpanded === undefined ? {} : { defaultExpanded: boolean(c.defaultExpanded) }),
					...condProp,
				};
			}
			case "tabs": {
				keys(c, ["type", "id", "items", "defaultTab", "visibleWhen"]);
				if (!Array.isArray(c.items) || c.items.length < 1 || c.items.length > 8) throw new Error("Tabs require 1–8 items");
				const tabIds = new Set<string>();
				const items = c.items.map(rawTab => {
					const tab = object(rawTab); keys(tab, ["id", "label", "content"]);
					const tid = text(tab.id, 64, "tab.id");
					if (tabIds.has(tid)) throw new Error("Duplicate tab id");
					tabIds.add(tid);
					return { id: tid, label: text(tab.label, 80, "tab.label"), content: text(tab.content, 4096, "tab.content") };
				});
				const defaultTab = c.defaultTab === undefined ? items[0].id : text(c.defaultTab, 64, "defaultTab");
				if (!tabIds.has(defaultTab)) throw new Error("Invalid defaultTab");
				return { type: "tabs", id, items, defaultTab, ...condProp };
			}
			case "timeline": {
				keys(c, ["type", "id", "title", "items", "visibleWhen"]);
				if (!Array.isArray(c.items) || c.items.length < 1 || c.items.length > 20) throw new Error("Timeline requires 1–20 items");
				const items = c.items.map(rawItem => {
					const item = object(rawItem); keys(item, ["time", "title", "description", "status"]);
					const status = oneOf(item.status, ["pending", "current", "done", "failed"] as const, "timeline status");
					return {
						time: text(item.time, 60, "timeline.time"),
						title: text(item.title, 120, "timeline.title"),
						...(item.description === undefined ? {} : { description: text(item.description, 1024, "timeline.description") }),
						...(status === undefined ? {} : { status }),
					};
				});
				return { type: "timeline", id, ...(c.title === undefined ? {} : { title: text(c.title, 160, "timeline.title") }), items, ...condProp };
			}
			case "bar-chart":
			case "line-chart":
			case "pie-chart": {
				keys(c, ["type", "id", "title", "unit", "data", "visibleWhen"]);
				if (!Array.isArray(c.data) || c.data.length < 1 || c.data.length > 50) throw new Error("Chart requires 1–50 data points");
				const data = c.data.map(rawPt => {
					const pt = object(rawPt); keys(pt, ["label", "value", "color"]);
					const val = number(pt.value);
					if (c.type === "pie-chart" && val < 0) throw new Error("Pie chart values must be non-negative");
					return { label: text(pt.label, 80, "chart.label"), value: val, ...(pt.color === undefined ? {} : { color: text(pt.color, 40, "chart.color") }) };
				});
				return { type: kind, id, ...(c.title === undefined ? {} : { title: text(c.title, 160, "chart.title") }), ...(c.unit === undefined ? {} : { unit: text(c.unit, 30, "chart.unit") }), data, ...condProp };
			}
			case "divider": {
				keys(c, ["type", "id", "label", "visibleWhen"]);
				return { type: "divider", id, ...(c.label === undefined ? {} : { label: text(c.label, 120, "divider.label") }), ...condProp };
			}
			case "image": {
				keys(c, ["type", "id", "src", "thumbnail", "alt", "title", "sourceUrl", "attribution", "visibleWhen"]);
				const src = imageSource(c.src);
				const thumbnail = c.thumbnail === undefined ? undefined : imageUrl(c.thumbnail, "image.thumbnail");
				const sourceUrl = c.sourceUrl === undefined ? undefined : imageUrl(c.sourceUrl, "image.sourceUrl");
				// The frontend counts references in its own text budget; both sides must agree.
				textLength += src.length + (thumbnail?.length ?? 0) + (sourceUrl?.length ?? 0);
				return {
					type: "image", id,
					src,
					...(thumbnail === undefined ? {} : { thumbnail }),
					...(c.alt === undefined ? {} : { alt: text(c.alt, 300, "image.alt") }),
					...(c.title === undefined ? {} : { title: text(c.title, 160, "image.title") }),
					...(sourceUrl === undefined ? {} : { sourceUrl }),
					...(c.attribution === undefined ? {} : { attribution: text(c.attribution, 200, "image.attribution") }),
					...condProp,
				};
			}
			case "button": {
				keys(c, ["type", "id", "label"]);
				return { type: "button", id, label: text(c.label, 120, "button.label") };
			}
			case "input":
			case "textarea": {
				keys(c, ["type", "id", "label", "default", "required", "minLength", "maxLength", "placeholder", "visibleWhen", ...(c.type === "textarea" ? ["rows"] : [])]);
				const label = text(c.label, 120, "label");
				const minLength = c.minLength === undefined ? 0 : integer(c.minLength, 4096), maxLength = c.maxLength === undefined ? 1024 : integer(c.maxLength, 4096);
				const required = c.required === undefined ? false : boolean(c.required), initial = c.default === undefined ? "" : text(c.default, 4096, "default");
				if (minLength > maxLength || initial.length > maxLength || (initial !== "" && initial.length < minLength)) throw new Error("Invalid input default or limits");
				const rows = c.type === "textarea" ? c.rows === undefined ? 4 : integer(c.rows, 20) : undefined;
				if (rows === 0) throw new Error("Textarea requires 1–20 rows");
				return { type: kind, id, label, default: initial, required, minLength, maxLength, ...(rows === undefined ? {} : { rows }), ...(c.placeholder === undefined ? {} : { placeholder: text(c.placeholder, 120, "placeholder") }), ...condProp };
			}
			case "date":
			case "date-picker": {
				keys(c, ["type", "id", "label", "default", "min", "max", "required", "visibleWhen"]);
				const label = text(c.label, 120, "label");
				const required = c.required === undefined ? false : boolean(c.required);
				const min = c.min === undefined ? undefined : isoDate(c.min, "date min");
				const max = c.max === undefined ? undefined : isoDate(c.max, "date max");
				if (min !== undefined && max !== undefined && min > max) throw new Error("Invalid date range");
				const initial = c.default === undefined || c.default === "" ? "" : isoDate(c.default, "date default");
				if (initial !== "" && ((min !== undefined && initial < min) || (max !== undefined && initial > max))) throw new Error("Invalid date default");
				return { type: kind, id, label, default: initial, required, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), ...condProp };
			}
			case "time-picker": {
				keys(c, ["type", "id", "label", "default", "required", "visibleWhen"]);
				const label = text(c.label, 120, "label");
				const required = c.required === undefined ? false : boolean(c.required);
				const initial = c.default === undefined || c.default === "" ? "" : timeString(c.default, "time default");
				return { type: "time-picker", id, label, default: initial, required, ...condProp };
			}
			case "number":
			case "slider":
			case "number-input": {
				keys(c, ["type", "id", "label", "min", "max", "step", "default", "unit", "visibleWhen"]);
				const label = text(c.label, 120, "label");
				const min = number(c.min), max = number(c.max), step = c.step === undefined ? 1 : number(c.step);
				if (min >= max || step <= 0 || !Number.isFinite((max - min) / step)) throw new Error("Invalid numeric range or step");
				return { type: kind, id, label, min, max, step, default: numericValue(c.default, { min, max, step }), ...(c.unit === undefined ? {} : { unit: text(c.unit, 30, "unit") }), ...condProp };
			}
			case "checkbox":
			case "switch": {
				keys(c, ["type", "id", "label", "default", "visibleWhen"]);
				const label = text(c.label, 120, "label");
				return { type: kind, id, label, default: c.default === undefined ? false : boolean(c.default), ...condProp };
			}
			case "checkbox-group":
			case "multiselect": {
				keys(c, ["type", "id", "label", "options", "default", "minItems", "maxItems", "visibleWhen"]);
				const label = text(c.label, 120, "label");
				if (!Array.isArray(c.options) || c.options.length < 1 || c.options.length > 32) throw new Error("Invalid UI options");
				const seen = new Set<string>();
				const options = c.options.map(rawOption => {
					const option = object(rawOption); keys(option, ["label", "value", "description"]);
					const value = text(option.value, 128, "option value");
					if (!value || seen.has(value)) throw new Error("Empty or duplicate option value");
					seen.add(value);
					return { label: text(option.label, 120, "option label"), value, ...(option.description === undefined ? {} : { description: text(option.description, 200, "option description") }) };
				});
				const minItems = c.minItems === undefined ? 0 : integer(c.minItems, options.length), maxItems = c.maxItems === undefined ? options.length : integer(c.maxItems, options.length);
				if (minItems > maxItems) throw new Error("Invalid multiselect limits");
				return { type: kind, id, label, options, minItems, maxItems, default: selections(c.default === undefined ? [] : c.default, options, 0, maxItems), ...condProp };
			}
			case "select":
			case "radio":
			case "segmented-control":
			case "searchable-select": {
				keys(c, ["type", "id", "label", "options", "default", "required", "visibleWhen"]);
				const label = text(c.label, 120, "label");
				if (!Array.isArray(c.options) || c.options.length < 1 || c.options.length > 32) throw new Error("Invalid UI options");
				const seen = new Set<string>();
				const options = c.options.map(rawOption => {
					const option = object(rawOption); keys(option, ["label", "value", "description"]);
					const value = text(option.value, 128, "option value");
					if (!value || seen.has(value)) throw new Error("Empty or duplicate option value");
					seen.add(value);
					return { label: text(option.label, 120, "option label"), value, ...(option.description === undefined ? {} : { description: text(option.description, 200, "option description") }) };
				});
				const required = c.required === undefined ? false : boolean(c.required), initial = c.default === undefined ? options[0].value : text(c.default, 128, "default");
				if (!seen.has(initial) && !(initial === "" && !required)) throw new Error("Invalid option default");
				return { type: kind, id, label, options, default: initial, required, ...condProp };
			}
			case "option-cards": {
				keys(c, ["type", "id", "label", "cards", "default", "required", "visibleWhen"]);
				const label = text(c.label, 120, "label");
				if (!Array.isArray(c.cards) || c.cards.length < 1 || c.cards.length > 12) throw new Error("Option cards require 1–12 cards");
				const cardIds = new Set<string>();
				const cards = c.cards.map(rawCard => {
					const card = object(rawCard); keys(card, ["id", "title", "description", "tag", "recommended"]);
					const cid = text(card.id, 64, "card.id");
					if (cardIds.has(cid)) throw new Error("Duplicate option card id");
					cardIds.add(cid);
					return {
						id: cid,
						title: text(card.title, 120, "card.title"),
						...(card.description === undefined ? {} : { description: text(card.description, 512, "card.description") }),
						...(card.tag === undefined ? {} : { tag: text(card.tag, 60, "card.tag") }),
						...(card.recommended === undefined ? {} : { recommended: boolean(card.recommended) }),
					};
				});
				const required = c.required === undefined ? false : boolean(c.required);
				const initial = c.default === undefined ? cards[0].id : text(c.default, 64, "default");
				if (!cardIds.has(initial) && !(initial === "" && !required)) throw new Error("Invalid option-cards default");
				return { type: "option-cards", id, label, cards, default: initial, required, ...condProp };
			}
			default: throw new Error("Unsupported UI component");
		}
	});

	// Mode resolution: explicit mode or inferred from components.
	let mode: UiMode;
	const buttonCount = components.filter(c => c.type === "button").length;
	const hasInteractive = components.some(isInteractiveComponent);

	if (schema.mode !== undefined) {
		if (schema.mode !== "display" && schema.mode !== "interactive") throw new Error("Invalid UI mode");
		mode = schema.mode;
	} else {
		// Infer mode: if has button or interactive controls, default interactive, else display.
		mode = buttonCount > 0 || hasInteractive ? "interactive" : "display";
	}

	if (mode === "display") {
		if (buttonCount > 0) throw new Error("Display UI must not contain submit buttons");
		// Also ensure no purely input controls without submit
		const interactiveControls = components.filter(isUiControl);
		if (interactiveControls.length > 0) throw new Error("Display UI must not contain interactive input controls");
	} else {
		// Interactive mode requires exactly one submit button
		if (buttonCount !== 1) throw new Error("Interactive UI requires exactly one submit button");
	}

	const controlIds = new Set(components.filter(isUiControl).map(c => c.id));
	for (const c of components) {
		if (c.type !== "button" && c.visibleWhen && (c.visibleWhen.id === c.id || !controlIds.has(c.visibleWhen.id))) {
			throw new Error(`Invalid visibleWhen target: ${c.visibleWhen.id}`);
		}
	}

	if (textLength > 32768) throw new Error("UI text exceeds 32768 characters");
	return { version: 1, mode, ...(title === undefined ? {} : { title }), layout, components };
}

export function validateUiValues(schema: UiSchema, value: unknown): Record<string, UiValue> {
	const values = object(value), result: Record<string, UiValue> = {};
	const controls = schema.components.filter(isUiControl);
	keys(values, controls.map(c => c.id));
	for (const c of controls) {
		if (!isUiComponentVisible(c, values)) {
			result[c.id] = Array.isArray(c.default) ? [...c.default] : c.default;
			continue;
		}
		const val = values[c.id];
		if (c.type === "slider" || c.type === "number" || c.type === "number-input") {
			result[c.id] = numericValue(val, c);
		} else if (c.type === "checkbox" || c.type === "switch") {
			result[c.id] = boolean(val);
		} else if (c.type === "multiselect" || c.type === "checkbox-group") {
			result[c.id] = selections(val, c.options, c.minItems, c.maxItems);
		} else if (c.type === "date" || c.type === "date-picker") {
			const s = string(val, 10, c.id);
			if (s === "") {
				if (c.required) throw new Error(`Invalid date: ${c.id}`);
				result[c.id] = "";
			} else {
				const d = isoDate(s, c.id);
				if ((c.min !== undefined && d < c.min) || (c.max !== undefined && d > c.max)) throw new Error(`Invalid date: ${c.id}`);
				result[c.id] = d;
			}
		} else if (c.type === "time-picker") {
			const s = string(val, 8, c.id);
			if (s === "") {
				if (c.required) throw new Error(`Invalid time: ${c.id}`);
				result[c.id] = "";
			} else {
				result[c.id] = timeString(s, c.id);
			}
		} else if (c.type === "input" || c.type === "textarea") {
			const s = string(val, c.maxLength, c.id);
			if ((c.required && s.length === 0) || (s.length > 0 && s.length < c.minLength)) throw new Error(`Invalid input: ${c.id}`);
			result[c.id] = s;
		} else if (c.type === "select" || c.type === "radio" || c.type === "segmented-control" || c.type === "searchable-select") {
			const s = string(val, 128, c.id);
			if (!c.options.some(o => o.value === s) && !(s === "" && !c.required)) throw new Error(`Invalid selection: ${c.id}`);
			result[c.id] = s;
		} else if (c.type === "option-cards") {
			const s = string(val, 64, c.id);
			if (!c.cards.some(card => card.id === s) && !(s === "" && !c.required)) throw new Error(`Invalid option-card selection: ${c.id}`);
			result[c.id] = s;
		}
	}
	return result;
}
