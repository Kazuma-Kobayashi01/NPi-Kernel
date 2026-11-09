import type { BackdropGlyph } from "./tile-backdrop";

/**
 * The home screen's backdrop: a Japanese night city drawn only a shade off the
 * terminal background, in the theme's own colours, scrolling past as if seen
 * from a moving train. Back to front: a faint far skyline drifting slowly; a
 * lattice tower with its observation decks and blinking beacon; the near city
 * hung with flickering neon signboards, its windows lighting and going dark; a
 * perspective grid floor rolling toward the viewer; occasional glitch
 * scanlines; and on top a self-playing side-scrolling bullet-hell shooter drawn
 * in half-block pixels: a ship at the left weaves through aimed bursts, rings,
 * fans and spirals while it shoots down the waves flying in from the right.
 */

type Rgb = readonly [number, number, number];

export interface SceneLayout {
	columns: number;
	rows: number;
	/** First column of the content (logo, composer, footer). */
	contentLeft: number;
	/** First column right of the content. */
	contentRight: number;
}

export interface SceneTheme {
	backdrop: Rgb;
	/** Theme gradient stops (text → accent → border accent). */
	stops: readonly Rgb[];
	/** Reveal progress in [0, 1]; everything fades in with it. */
	reveal: number;
}

/** Strengths: how far each layer moves a cell from the background toward its colour. */
const FAR_SKYLINE = 0.022;
const FAR_WINDOW = 0.035;
const TOWER_FRAME = 0.1;
const TOWER_LATTICE = 0.055;
const TOWER_DECK = 0.13;
const TOWER_BEACON = 0.32;
const SKYLINE = 0.045;
const WINDOW = 0.075;
const GRID = 0.06;
const GLITCH = 0.05;
const SIGN_FILL = 0.06;
const SIGN_FRAME = 0.12;
const SIGN_TEXT = 0.4;
const STAR = 0.16;

/** Scroll speeds in columns per second. */
const FAR_SPEED = 2.2;
const TOWER_SPEED = 3.8;
const NEAR_SPEED = 6;
const STAR_SPEED = 0.7;
/** Grid rays slide by this much per second in perspective units. */
const RAY_SPEED = 12;
const RAY_SPACING = 14;

/** Most bullets alive at once, so a long spiral cannot pile up without bound. */
const MAX_SHOTS = 260;

const SIGN_WORDS = [
	"電脳街",
	"ゲーム",
	"ネオン",
	"カラオケ",
	"遊技場",
	"夜市",
	"二十四時",
	"サイバー",
	"居酒屋",
	"未来都市",
	"ラーメン",
	"パチンコ",
	"喫茶店",
	"秋葉原",
	"新宿",
	"営業中",
	"酒場",
	"ホテル",
	"寿司",
	"漫画喫茶",
];

/**
 * Original sprites in half-block pixels: one column wide and half a row tall,
 * so each terminal cell holds two stacked pixels and the grid is about square.
 * Shade codes: `#` hull, `=` plating, `o` cockpit / lights, `>` engine flame.
 */
const PLAYER: readonly string[] = [
	"....##............",
	"....###=..........",
	"....####==........",
	">>=######====oo...",
	">>>##########=####",
	">>>##########=####",
	">>=######====.....",
	"....####==........",
	"....###=..........",
	"....##............",
];

type Pattern = "aimed" | "ring" | "fan" | "spiral" | "laser";

interface EnemyKind {
	art: readonly string[];
	pattern: Pattern;
	hp: number;
	speed: number;
}

const ENEMY_KINDS: readonly EnemyKind[] = [
	{
		art: ["......##...", "....####=..", "..oo######=", "###########", "..oo######=", "....####=..", "......##..."],
		pattern: "aimed",
		hp: 3,
		speed: 14,
	},
	{
		art: ["...####...", ".##====##.", "##=oooo=##", "##=oooo=##", ".##====##.", "...####..."],
		pattern: "ring",
		hp: 5,
		speed: 9,
	},
	{
		art: ["#........#", "##......##", ".###oo###.", "..######..", ".##....##.", "#........#"],
		pattern: "fan",
		hp: 3,
		speed: 12,
	},
	{
		art: ["....####....", "..##====##..", "oo#########=", "oo#########=", "..##====##..", "....####...."],
		pattern: "laser",
		hp: 7,
		speed: 9,
	},
];
const BOSS: EnemyKind = {
	art: [
		".....######.....",
		"...##oooooo##...",
		"..############..",
		"################",
		"#=#=#=#=#=#=#=#=",
		"..############..",
		"....##....##....",
	],
	pattern: "spiral",
	hp: 24,
	speed: 6,
};

/** One shaded pixel of a sprite, shot or blast. */
interface Pixel {
	tone: number;
	strength: number;
}

interface Building {
	x0: number;
	x1: number;
	top: number;
}

/** A skyline strip that wraps around, so it can scroll forever. */
interface Strip {
	length: number;
	buildings: Building[];
	/** Building index per strip column (-1: gap). */
	byColumn: Int16Array;
}

interface Tower {
	/** Strip length of the tower's own parallax layer. */
	length: number;
	/** Column of the tower's axis in that strip. */
	axis: number;
	/** Row of the antenna tip. */
	top: number;
	/** Half-width of the legs at the ground. */
	base: number;
}

interface Sign {
	x0: number;
	y0: number;
	w: number;
	h: number;
	vertical: boolean;
	word: readonly string[];
	tone: number;
	seed: number;
}

interface Ship {
	art: readonly string[];
	/** Column of the left edge. */
	x: number;
	/** Half-row of the top edge. */
	y: number;
	tone: number;
}

interface Enemy extends Ship {
	kind: EnemyKind;
	vx: number;
	baseY: number;
	amp: number;
	freq: number;
	phase: number;
	hp: number;
	fireIn: number;
	/** Shots left in the current burst, and the spiral's turning angle. */
	burst: number;
	angle: number;
	flash: number;
	/** Holding still while its beam is out. */
	lasing: boolean;
}

interface Shot {
	x: number;
	/** Half-row. */
	y: number;
	/** Columns / half-rows per second. */
	vx: number;
	vy: number;
	friendly: boolean;
	tone: number;
}

/** A laser: enemy beams aim, then sweep; the ship's scatter beams fan open. */
interface Beam {
	friendly: boolean;
	owner: Enemy | undefined;
	/** Origin column / half-row, following the shooter. */
	ox: number;
	oy: number;
	/** Start angle (enemy) or fan offset (friendly), radians. */
	angle: number;
	/** Sweep in radians per second once live. */
	omega: number;
	age: number;
	/** Seconds of faint aiming line before an enemy beam goes live. */
	charge: number;
	life: number;
	tone: number;
	/** Seconds to the next damage tick (friendly). */
	tick: number;
}

interface Blast {
	x: number;
	/** Half-row. */
	y: number;
	age: number;
	tone: number;
	size: number;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function gradientAt(stops: readonly Rgb[], t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	const seg = clamped * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(seg));
	return mix(stops[i]!, stops[i + 1]!, seg - i);
}

/** Stable pseudo-random value in [0, 1) for integer coordinates. */
function hash(x: number, y: number, z = 0): number {
	let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function wrap(value: number, length: number): number {
	return ((value % length) + length) % length;
}

function artWidth(art: readonly string[]): number {
	return art[0]!.length;
}

export class HomeScene {
	#random = rng(Math.floor(Math.random() * 2 ** 31));
	#layout: SceneLayout = { columns: 0, rows: 0, contentLeft: 0, contentRight: 0 };
	#horizon = 0;
	#far: Strip = { length: 1, buildings: [], byColumn: new Int16Array(1).fill(-1) };
	#near: Strip = { length: 1, buildings: [], byColumn: new Int16Array(1).fill(-1) };
	#tower: Tower = { length: 1, axis: 0, top: 0, base: 0 };
	#signs: Sign[] = [];
	/** Sign index per near-strip cell (-1: none). */
	#signByCell = new Int16Array(0);
	#player: Ship & { targetY: number; cooldown: number; spreadIn: number; laserIn: number; hit: number } = {
		art: PLAYER,
		x: 0,
		y: 0,
		tone: 0.15,
		targetY: 0,
		cooldown: 0,
		spreadIn: 1,
		laserIn: 2,
		hit: 0,
	};
	#enemies: Enemy[] = [];
	#shots: Shot[] = [];
	#blasts: Blast[] = [];
	#beams: Beam[] = [];
	/** Sprite, shot and blast pixels of this frame, keyed `py * columns + x`. */
	#pixels = new Map<number, Pixel>();
	#spawnIn = 0;
	#now = 0;
	#last: number | undefined;
	/** Scroll offsets this frame, in columns. */
	#farShift = 0;
	#towerShift = 0;
	#nearShift = 0;
	#starShift = 0;
	#theme: SceneTheme = {
		backdrop: [0, 0, 0],
		stops: [
			[0, 0, 0],
			[0, 0, 0],
		],
		reveal: 1,
	};
	#lit = 1;

	/** Match the screen; a change rebuilds the city and restarts the battle. */
	layout(layout: SceneLayout): void {
		const prev = this.#layout;
		if (
			prev.columns === layout.columns &&
			prev.rows === layout.rows &&
			prev.contentLeft === layout.contentLeft &&
			prev.contentRight === layout.contentRight
		)
			return;
		this.#layout = layout;
		const { columns, rows } = layout;
		this.#horizon = rows - Math.max(4, Math.floor(rows * 0.26));
		const length = Math.max(columns * 2, 240);
		this.#far = this.#buildStrip(length, 0.85, 12, 22);
		this.#near = this.#buildStrip(length, 0.7, 8, 12);
		this.#tower = {
			length: Math.max(columns + 60, 200),
			axis: Math.floor(columns * 0.7),
			top: Math.max(1, Math.floor(this.#horizon * 0.08)),
			base: Math.max(6, Math.floor(this.#horizon * 0.22)),
		};
		this.#hangSigns();
		const player = this.#player;
		player.x = Math.max(2, Math.floor(columns * 0.04));
		player.y = rows - player.art.length / 2;
		player.targetY = player.y;
		this.#enemies = [];
		this.#shots = [];
		this.#blasts = [];
		this.#beams = [];
		this.#pixels.clear();
		this.#spawnIn = 0.5;
	}

	setTheme(theme: SceneTheme): void {
		this.#theme = theme;
		const x = Math.max(0, Math.min(1, theme.reveal));
		this.#lit = x * x * (3 - 2 * x);
	}

	/** Advance every moving layer to wall-clock `now` (ms). */
	step(now: number): void {
		const dt = this.#last === undefined ? 0 : Math.min(250, now - this.#last) / 1000;
		this.#last = now;
		this.#now = now;
		const seconds = now / 1000;
		this.#farShift = Math.floor(seconds * FAR_SPEED);
		this.#towerShift = Math.floor(seconds * TOWER_SPEED);
		this.#nearShift = Math.floor(seconds * NEAR_SPEED);
		this.#starShift = Math.floor(seconds * STAR_SPEED);
		if (dt > 0) this.#stepBattle(dt);
		this.#rasterize();
	}

	/**
	 * Background of the cell at column `x`, row `y`; `undefined` leaves the
	 * terminal's own. A cell only half covered by a sprite gets it at half
	 * strength here; {@link glyph} draws it crisply where it may.
	 */
	bg(x: number, y: number): Rgb | undefined {
		const city = this.#cityBg(x, y);
		const top = this.#pixel(x, y * 2);
		const bottom = this.#pixel(x, y * 2 + 1);
		if (!top && !bottom) return city;
		const base = city ?? this.#theme.backdrop;
		if (top && bottom) return mix(this.#pixelColor(base, top), this.#pixelColor(base, bottom), 0.5);
		const only = (top ?? bottom)!;
		return this.#pixelColor(base, { tone: only.tone, strength: only.strength / 2 });
	}

	/**
	 * Decoration glyph for the blank cell at column `x`, row `y`: half-block
	 * sprite pixels, signboard lettering, and stars. Inside the content column
	 * only on rows that carry no text (`rowBlank`), so nothing lands between words.
	 */
	glyph(x: number, y: number, rowBlank: boolean): BackdropGlyph | undefined {
		const { contentLeft, contentRight } = this.#layout;
		if (!rowBlank && x >= contentLeft - 1 && x < contentRight + 1) return undefined;
		const { stops, backdrop } = this.#theme;
		const lit = this.#lit;

		const top = this.#pixel(x, y * 2);
		const bottom = this.#pixel(x, y * 2 + 1);
		if (top || bottom) {
			const base = this.#cityBg(x, y) ?? backdrop;
			if (top && bottom) {
				if (top.tone === bottom.tone && top.strength === bottom.strength) return undefined;
				return { char: "▀", width: 1, fg: this.#pixelColor(base, top), bg: this.#pixelColor(base, bottom) };
			}
			return top
				? { char: "▀", width: 1, fg: this.#pixelColor(base, top), bg: base }
				: { char: "▄", width: 1, fg: this.#pixelColor(base, bottom!), bg: base };
		}

		const sign = this.#signAt(x, y);
		if (sign) {
			const sx = wrap(x + this.#nearShift, this.#near.length);
			let index = -1;
			if (sign.vertical) {
				const i = (y - sign.y0 - 1) / 2;
				if (sx === sign.x0 + 2 && Number.isInteger(i)) index = i;
			} else {
				const i = (sx - sign.x0 - 2) / 2;
				if (y === sign.y0 + 1 && Number.isInteger(i)) index = i;
			}
			if (index < 0 || index >= sign.word.length) return undefined;
			const fg = mix(backdrop, gradientAt(stops, sign.tone), SIGN_TEXT * this.#flicker(sign) * lit);
			return { char: sign.word[index]!, width: 2, fg };
		}
		if (y < this.#horizon - 1 && !this.#inBuilding(this.#far, x, y, this.#farShift) && !this.#towerCell(x, y)) {
			const sx = x + this.#starShift;
			if (hash(sx, y, 11) < 0.006) {
				const twinkle = 0.5 + 0.5 * Math.sin(this.#now / 600 + hash(sx, y, 12) * 40);
				return { char: twinkle > 0.7 ? "+" : ".", width: 1, fg: mix(backdrop, stops[0]!, STAR * twinkle * lit) };
			}
		}
		return undefined;
	}

	#pixelColor(base: Rgb, pixel: Pixel): Rgb {
		return mix(base, gradientAt(this.#theme.stops, pixel.tone), pixel.strength * this.#lit);
	}

	#pixel(x: number, py: number): Pixel | undefined {
		if (x < 0 || x >= this.#layout.columns) return undefined;
		return this.#pixels.get(py * this.#layout.columns + x);
	}

	/** The city, tower, grid, glitch and signboards under the cell, without sprites. */
	#cityBg(x: number, y: number): Rgb | undefined {
		const { stops, backdrop } = this.#theme;
		const lit = this.#lit;
		let color = backdrop;
		let touched = false;
		const over = (tone: number, strength: number): void => {
			color = mix(color, gradientAt(stops, tone), strength * lit);
			touched = true;
		};
		const horizon = this.#horizon;
		const now = this.#now;

		if (y < horizon) {
			const fx = wrap(x + this.#farShift, this.#far.length);
			const far = this.#far.buildings[this.#far.byColumn[fx]!];
			if (far && y >= far.top) {
				over(0.7, FAR_SKYLINE);
				if ((fx - far.x0) % 4 === 2 && (horizon - y) % 3 === 1 && hash(fx, y, 21) < 0.25) over(0.6, FAR_WINDOW);
			}
			const tower = this.#towerCell(x, y);
			if (tower) over(tower.tone, tower.strength);
			const nx = wrap(x + this.#nearShift, this.#near.length);
			const near = this.#near.buildings[this.#near.byColumn[nx]!];
			if (near && y >= near.top) {
				over(0.85, SKYLINE);
				const wx = nx - near.x0;
				const wy = horizon - 1 - y;
				if (wx % 3 === 1 && wx < near.x1 - near.x0 - 1 && wy % 2 === 1 && y > near.top) {
					const seed = hash(nx, y, 7);
					const period = Math.floor((now + seed * 6000) / 6000);
					if (hash(nx, y, period) < 0.32) over(0.35 + seed * 0.3, WINDOW);
				}
			}
		} else {
			// Perspective floor: rows crowd toward the horizon and roll toward the
			// viewer, rays slide sideways with the city.
			const depth = (y - horizon) / Math.max(1, this.#layout.rows - horizon);
			const lines = 6;
			const roll = (now / 2200) % 1;
			let onRow = false;
			for (let k = 0; k < lines && !onRow; k++) {
				const d = (k + roll) / lines;
				if (Math.round(horizon + d * d * (this.#layout.rows - horizon)) === y) onRow = true;
			}
			const center = this.#layout.columns / 2;
			const spread = (x - center) / Math.max(0.15, depth) + (now / 1000) * RAY_SPEED;
			const onRay =
				Math.abs(spread - Math.round(spread / RAY_SPACING) * RAY_SPACING) < 0.5 / Math.max(0.15, depth) + 0.4;
			if (onRow || onRay) over(0.55, GRID * (0.5 + 0.5 * depth));
		}

		const glitchSlot = Math.floor(now / 6500);
		if (now % 6500 < 220 && Math.floor(hash(glitchSlot, 3) * this.#layout.rows) === y) over(0.5, GLITCH);

		const sign = this.#signAt(x, y);
		if (sign) {
			const sx = wrap(x + this.#nearShift, this.#near.length);
			const frame = sx === sign.x0 || sx === sign.x0 + sign.w - 1 || y === sign.y0 || y === sign.y0 + sign.h - 1;
			over(sign.tone, (frame ? SIGN_FRAME : SIGN_FILL) * this.#flicker(sign));
		}
		return touched ? color : undefined;
	}

	/**
	 * The lattice tower at screen cell (`x`, `y`): splayed legs over an arch,
	 * a cross-braced body tapering up, a main and a top observation deck, an
	 * antenna, and a beacon blinking at the tip.
	 */
	#towerCell(x: number, y: number): Pixel | undefined {
		const tower = this.#tower;
		const horizon = this.#horizon;
		if (y < tower.top || y >= horizon) return undefined;
		const tx = wrap(x + this.#towerShift, tower.length);
		const dx = tx - tower.axis;
		const height = horizon - tower.top;
		const f = (horizon - 1 - y) / height; // 0 at the ground, 1 at the tip
		const warm = 0.35;
		if (f > 0.84) {
			if (dx !== 0) return undefined;
			if (y === tower.top) {
				const on = this.#now % 1400 < 500;
				return { tone: warm, strength: on ? TOWER_BEACON : TOWER_FRAME };
			}
			return { tone: warm, strength: TOWER_FRAME };
		}
		const half = Math.max(0.5, tower.base * (1 - f / 0.84) ** 1.7);
		const ad = Math.abs(dx);
		const mainDeck = Math.abs(f - 0.36) < 0.025;
		const topDeck = Math.abs(f - 0.62) < 0.015;
		if (mainDeck && ad <= half + 2) return { tone: 0.9, strength: TOWER_DECK };
		if (topDeck && ad <= half + 1) return { tone: 0.9, strength: TOWER_DECK };
		if (ad > half) return undefined;
		// The arch between the legs.
		const archTop = 0.13;
		if (f < archTop && ad < half * (1 - f / archTop) * 0.75) return undefined;
		if (ad > half - 1) return { tone: warm, strength: TOWER_FRAME };
		const brace = (tx + y) % 3 === 0 || (tx - y + 300) % 3 === 0;
		return brace ? { tone: warm, strength: TOWER_LATTICE } : undefined;
	}

	#inBuilding(strip: Strip, x: number, y: number, shift: number): boolean {
		const b = strip.buildings[strip.byColumn[wrap(x + shift, strip.length)]!];
		return b !== undefined && y >= b.top;
	}

	#signAt(x: number, y: number): Sign | undefined {
		const { rows } = this.#layout;
		if (y < 0 || y >= rows) return undefined;
		const length = this.#near.length;
		return this.#signs[this.#signByCell[y * length + wrap(x + this.#nearShift, length)]!];
	}

	/** Neon buzz: mostly steady, with the odd quick dropout. */
	#flicker(sign: Sign): number {
		const slot = Math.floor(this.#now / 110);
		return hash(slot, Math.floor(sign.seed * 1e6)) < 0.035 ? 0.35 : 1;
	}

	#buildStrip(length: number, heightShare: number, minWidth: number, widthRange: number): Strip {
		const tallest = Math.max(4, Math.floor(this.#horizon * heightShare));
		const buildings: Building[] = [];
		let x = 0;
		while (x < length) {
			const width = minWidth + Math.floor(this.#random() * widthRange);
			const height = 4 + Math.floor(this.#random() ** 1.4 * tallest);
			buildings.push({ x0: x, x1: Math.min(length, x + width), top: Math.max(1, this.#horizon - height) });
			x += width + Math.floor(this.#random() * 3);
		}
		const byColumn = new Int16Array(length).fill(-1);
		for (const [index, b] of buildings.entries()) byColumn.fill(index, b.x0, b.x1);
		return { length, buildings, byColumn };
	}

	/** Hang signboards on the near buildings: vertical ones down a facade, horizontal ones across it. */
	#hangSigns(): void {
		const { rows } = this.#layout;
		const length = this.#near.length;
		this.#signs = [];
		let words = [...SIGN_WORDS].sort(() => this.#random() - 0.5);
		const fits = (s: Sign): boolean =>
			this.#signs.every(
				o => s.x0 + s.w + 1 <= o.x0 || o.x0 + o.w + 1 <= s.x0 || s.y0 + s.h + 1 <= o.y0 || o.y0 + o.h + 1 <= s.y0,
			);
		for (const b of this.#near.buildings) {
			for (let t = 0; t < 2; t++) {
				const word = [...words[words.length - 1]!];
				const vertical = this.#random() < 0.55;
				const w = vertical ? 6 : word.length * 2 + 4;
				const h = vertical ? word.length * 2 + 1 : 3;
				// Signs may stick out of the facade a little, as real ones do.
				const x0 = b.x0 - 1 + Math.floor(this.#random() * Math.max(1, b.x1 - b.x0 - w + 3));
				const room = this.#horizon - 1 - h - b.top;
				if (room < 0 || x0 < 0 || x0 + w > length) continue;
				const y0 = b.top + Math.floor(this.#random() * (room + 1));
				const sign: Sign = { x0, y0, w, h, vertical, word, tone: this.#random(), seed: this.#random() };
				if (!fits(sign)) continue;
				this.#signs.push(sign);
				words.pop();
				if (words.length === 0) words = [...SIGN_WORDS].sort(() => this.#random() - 0.5);
			}
		}
		this.#signByCell = new Int16Array(length * rows).fill(-1);
		for (const [index, sign] of this.#signs.entries()) {
			for (let y = sign.y0; y < Math.min(rows, sign.y0 + sign.h); y++)
				this.#signByCell.fill(index, y * length + sign.x0, y * length + sign.x0 + sign.w);
		}
	}

	/** Paint this frame's enemies, ship, shots and blasts into the pixel table, back to front. */
	#rasterize(): void {
		const { columns, rows } = this.#layout;
		const pixels = this.#pixels;
		pixels.clear();
		const height = rows * 2;
		const put = (x: number, py: number, pixel: Pixel): void => {
			if (x >= 0 && x < columns && py >= 0 && py < height) pixels.set(py * columns + x, pixel);
		};
		const drawShip = (ship: Ship, hit: number, flame: boolean): void => {
			const left = Math.round(ship.x);
			const top = Math.round(ship.y);
			const cut = Math.floor(this.#now / 70) % 3;
			for (const [ay, line] of ship.art.entries()) {
				for (let ax = 0; ax < line.length; ax++) {
					const shade = line[ax]!;
					if (shade === ".") continue;
					if (shade === ">") {
						// The flame flickers: its tail pixels come and go.
						if (flame && ax >= cut) put(left + ax, top + ay, { tone: 0.35, strength: 0.3 });
						continue;
					}
					put(left + ax, top + ay, this.#shade(shade, ship.tone, hit));
				}
			}
		};
		for (const enemy of this.#enemies) drawShip(enemy, enemy.flash, false);
		drawShip(this.#player, this.#player.hit, true);
		for (const shot of this.#shots) {
			const sx = Math.round(shot.x);
			const sy = Math.round(shot.y);
			if (shot.friendly) {
				for (let i = 0; i < 4; i++) put(sx + i, sy, { tone: 0.05, strength: i === 3 ? 0.36 : 0.26 });
			} else {
				// A round bullet: bright core, softer rim.
				const pixel = { tone: shot.tone, strength: 0.3 };
				const rim = { tone: shot.tone, strength: 0.18 };
				put(sx, sy, pixel);
				put(sx + 1, sy, pixel);
				put(sx, sy + 1, rim);
				put(sx + 1, sy + 1, rim);
			}
		}
		for (const beam of this.#beams) {
			const live = beam.friendly || beam.age >= beam.charge;
			const fade = beam.friendly ? 1 - beam.age / beam.life : 1;
			let i = 0;
			for (const [x, y] of this.#beamPoints(beam)) {
				i++;
				if (!live) {
					// The aiming line: faint and dashed.
					if (i % 3 !== 0) put(x, y, { tone: beam.tone, strength: 0.08 });
					continue;
				}
				put(x, y, { tone: beam.tone, strength: (beam.friendly ? 0.3 : 0.34) * fade + 0.04 });
				put(x, y - 1, { tone: beam.tone, strength: 0.13 * fade });
				put(x, y + 1, { tone: beam.tone, strength: 0.13 * fade });
			}
		}
		for (const blast of this.#blasts) {
			const radius = (1.5 + blast.age * 9) * blast.size;
			const reach = Math.ceil(radius + 1);
			const fade = 1 - blast.age;
			for (let dy = -reach; dy <= reach; dy++) {
				for (let dx = -reach; dx <= reach; dx++) {
					const dist = Math.hypot(dx, dy);
					const core = dist < fade * 2.5 * blast.size;
					const ring = Math.abs(dist - radius) < 0.9;
					const spark = !ring && dist < radius && hash(dx, dy, Math.floor(blast.age * 12)) < 0.08 * fade;
					if (core || ring || spark) {
						put(Math.round(blast.x) + dx, Math.round(blast.y) + dy, {
							tone: core ? 0.35 : blast.tone,
							strength: (core ? 0.36 : 0.26) * fade,
						});
					}
				}
			}
		}
	}

	#beamAngle(beam: Beam): number {
		if (beam.friendly) return beam.angle * (0.55 + 0.45 * Math.min(1, beam.age / (beam.life * 0.5)));
		return beam.angle + beam.omega * Math.max(0, beam.age - beam.charge);
	}

	/** Pixels along a beam from its origin to the screen edge. */
	*#beamPoints(beam: Beam, angle = this.#beamAngle(beam)): Generator<[number, number]> {
		const { columns, rows } = this.#layout;
		const dx = Math.cos(angle);
		const dy = Math.sin(angle);
		let lastX = Number.NaN;
		let lastY = Number.NaN;
		for (let d = 0; d < 400; d++) {
			const x = Math.round(beam.ox + dx * d);
			const y = Math.round(beam.oy + dy * d);
			if (x < -2 || x > columns + 2 || y < -2 || y > rows * 2 + 2) return;
			if (x === lastX && y === lastY) continue;
			lastX = x;
			lastY = y;
			yield [x, y];
		}
	}

	#hits(ship: Ship, x: number, y: number, inset = 0): boolean {
		const left = Math.round(ship.x) + inset;
		const top = Math.round(ship.y) + inset;
		return (
			x >= left &&
			x < Math.round(ship.x) + artWidth(ship.art) - inset &&
			y >= top &&
			y < Math.round(ship.y) + ship.art.length - inset
		);
	}

	#damage(enemy: Enemy): void {
		if (enemy.hp <= 0) return;
		enemy.hp--;
		enemy.flash = 1;
		if (enemy.hp > 0) return;
		this.#blasts.push({
			x: Math.round(enemy.x) + artWidth(enemy.art) / 2,
			y: Math.round(enemy.y) + enemy.art.length / 2,
			age: 0,
			tone: enemy.tone,
			size: enemy.kind === BOSS ? 1.8 : 1,
		});
	}

	#shade(shade: string, tone: number, hit: number): Pixel {
		switch (shade) {
			case "o":
				return { tone: 0.95, strength: 0.3 };
			case "=":
				return { tone, strength: 0.09 + 0.12 * hit };
			default:
				return { tone, strength: 0.16 + 0.14 * hit };
		}
	}

	#fire(x: number, y: number, angle: number, speed: number, tone: number): void {
		if (this.#shots.length >= MAX_SHOTS) return;
		this.#shots.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, friendly: false, tone });
	}

	/** Open fire with the enemy's pattern; returns seconds until it may fire again. */
	#enemyVolley(enemy: Enemy): number {
		const player = this.#player;
		const cx = Math.round(enemy.x) - 1;
		const cy = Math.round(enemy.y) + Math.floor(enemy.art.length / 2);
		const px = player.x + artWidth(player.art) / 2;
		const py = player.y + player.art.length / 2;
		const toPlayer = Math.atan2(py - cy, px - cx);
		const tone = enemy.tone;
		switch (enemy.kind.pattern) {
			case "aimed":
				// A three-round burst, each round re-aimed.
				enemy.burst = 3;
				this.#fire(cx, cy, toPlayer, 30, tone);
				return 0.16;
			case "ring": {
				const count = 14;
				const offset = this.#random() * Math.PI;
				for (let i = 0; i < count; i++) this.#fire(cx + 4, cy, offset + (i / count) * Math.PI * 2, 16, tone);
				return 2.6 + this.#random();
			}
			case "fan": {
				for (let i = -3; i <= 3; i++) this.#fire(cx, cy, Math.PI + i * 0.17, 24, tone);
				return 2 + this.#random();
			}
			case "spiral":
				enemy.burst = 26;
				return 0.08;
			case "laser": {
				// Aim at the ship, then sweep past it.
				const dir = this.#random() < 0.5 ? -1 : 1;
				enemy.lasing = true;
				this.#beams.push({
					friendly: false,
					owner: enemy,
					ox: cx - 1,
					oy: cy,
					angle: toPlayer - dir * 0.6,
					omega: dir * 0.66,
					age: 0,
					charge: 0.7,
					life: 2.5,
					tone,
					tick: 0,
				});
				return 3.6 + this.#random() * 1.5;
			}
		}
	}

	#stepBattle(dt: number): void {
		const { columns, rows } = this.#layout;
		const player = this.#player;
		const playerHeight = player.art.length;
		const top = 2;
		const bottom = rows * 2 - playerHeight - 2;
		const t = this.#now / 1000;

		this.#spawnIn -= dt;
		const wanted = Math.max(4, Math.floor(columns / 18));
		if (this.#spawnIn <= 0 && this.#enemies.length < wanted) {
			const bossAlive = this.#enemies.some(enemy => enemy.kind === BOSS);
			const kind =
				!bossAlive && this.#random() < 0.14 ? BOSS : ENEMY_KINDS[Math.floor(this.#random() * ENEMY_KINDS.length)]!;
			const baseY = top + this.#random() * Math.max(1, bottom - top - kind.art.length);
			this.#enemies.push({
				art: kind.art,
				kind,
				x: columns + 2,
				y: baseY,
				vx: -(kind.speed + this.#random() * 6),
				baseY,
				amp: kind === BOSS ? 6 : this.#random() * 10,
				freq: 0.8 + this.#random() * 1.4,
				phase: this.#random() * 6,
				tone: this.#random(),
				hp: kind.hp,
				fireIn: 0.8 + this.#random() * 2,
				burst: 0,
				angle: 0,
				flash: 0,
				lasing: false,
			});
			this.#spawnIn = 0.35 + this.#random() * 0.7;
		}

		for (const enemy of this.#enemies) {
			// The boss slows to hold the middle of the screen for its spirals.
			const holding = (enemy.kind === BOSS && enemy.x < columns * 0.62 && enemy.burst > 0) || enemy.lasing;
			enemy.x += (holding ? enemy.vx * 0.15 : enemy.vx) * dt;
			enemy.y = Math.max(top, Math.min(bottom, enemy.baseY + enemy.amp * Math.sin(enemy.phase + t * enemy.freq)));
			enemy.flash = Math.max(0, enemy.flash - dt * 5);
			enemy.fireIn -= dt;
			const inRange = enemy.x < columns - 4 && enemy.x > player.x + 26;
			if (enemy.fireIn > 0 || !inRange) continue;
			const cx = Math.round(enemy.x) - 1;
			const cy = Math.round(enemy.y) + Math.floor(enemy.art.length / 2);
			if (enemy.burst > 0) {
				enemy.burst--;
				if (enemy.kind.pattern === "spiral") {
					// Two counter-rotating arms.
					enemy.angle += 0.38;
					this.#fire(cx + 8, cy, enemy.angle, 18, enemy.tone);
					this.#fire(cx + 8, cy, -enemy.angle + Math.PI, 18, (enemy.tone + 0.5) % 1);
					enemy.fireIn = enemy.burst > 0 ? 0.08 : 2.4;
				} else {
					const px = player.x + artWidth(player.art) / 2;
					const py = player.y + playerHeight / 2;
					this.#fire(cx, cy, Math.atan2(py - cy, px - cx), 30, enemy.tone);
					enemy.fireIn = enemy.burst > 0 ? 0.16 : 1.8 + this.#random() * 1.5;
				}
				continue;
			}
			enemy.fireIn = this.#enemyVolley(enemy);
		}
		this.#enemies = this.#enemies.filter(enemy => enemy.x > -artWidth(enemy.art) - 2);

		// Autopilot: hold the line of the nearest enemy ahead, but pick the lane
		// the fewest incoming bullets will cross over the next moment.
		const nose = Math.round(player.x) + artWidth(player.art);
		const gun = Math.floor(playerHeight / 2);
		const ahead = this.#enemies.filter(enemy => enemy.x > nose).sort((a, b) => a.x - b.x)[0];
		const aim = ahead ? ahead.y + Math.floor(ahead.art.length / 2) - gun : player.y;
		let best = player.y;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let lane = top; lane <= bottom; lane += 2) {
			if (Math.abs(lane - player.y) > 24) continue;
			let danger = 0;
			for (const shot of this.#shots) {
				if (shot.friendly) continue;
				const lead = (shot.x - nose) / Math.max(1, -shot.vx);
				if (shot.vx >= 0 || lead < -0.2 || lead > 0.9) {
					// Not heading through the ship's columns soon: only count it if it is already alongside.
					if (shot.x < player.x || shot.x > nose) continue;
				}
				const at = shot.y + shot.vy * Math.max(0, lead);
				if (at >= lane - 2 && at <= lane + playerHeight + 1) danger += 1 / (0.3 + Math.max(0, lead));
			}
			const middle = player.x + artWidth(player.art) / 2;
			for (const beam of this.#beams) {
				if (beam.friendly) continue;
				for (const ahead of [0, 0.25, 0.5]) {
					const angle = beam.angle + beam.omega * Math.max(0, beam.age + ahead - beam.charge);
					if (Math.cos(angle) > -0.2) continue;
					const at = beam.oy + Math.tan(angle) * (middle - beam.ox);
					if (at >= lane - 3 && at <= lane + playerHeight + 3) danger += beam.age + ahead >= beam.charge ? 4 : 2;
				}
			}
			const score = danger * 10 + Math.abs(lane - aim) * 0.15 + Math.abs(lane - player.y) * 0.05;
			if (score < bestScore) {
				bestScore = score;
				best = lane;
			}
		}
		player.targetY = best;
		const delta = player.targetY - player.y;
		player.y += Math.sign(delta) * Math.min(Math.abs(delta), 34 * dt);
		player.hit = Math.max(0, player.hit - dt * 3);

		player.cooldown -= dt;
		player.spreadIn -= dt;
		player.laserIn -= dt;
		if (player.laserIn <= 0 && ahead) {
			// Scatter laser: five beams that fan open from the nose.
			for (const offset of [-0.5, -0.25, 0, 0.25, 0.5]) {
				this.#beams.push({
					friendly: true,
					owner: undefined,
					ox: nose,
					oy: Math.round(player.y) + gun,
					angle: offset,
					omega: 0,
					age: 0,
					charge: 0,
					life: 0.45,
					tone: 0.05,
					tick: 0,
				});
			}
			player.laserIn = 2.6;
		}
		if (player.cooldown <= 0 && ahead) {
			const gy = Math.round(player.y) + gun;
			// Twin main guns.
			this.#shots.push({ x: nose, y: gy - 1, vx: 85, vy: 0, friendly: true, tone: 0.05 });
			this.#shots.push({ x: nose, y: gy + 1, vx: 85, vy: 0, friendly: true, tone: 0.05 });
			player.cooldown = 0.16;
			if (player.spreadIn <= 0) {
				for (const a of [-0.32, -0.16, 0.16, 0.32])
					this.#shots.push({
						x: nose - 2,
						y: gy,
						vx: 80 * Math.cos(a),
						vy: 80 * Math.sin(a),
						friendly: true,
						tone: 0.05,
					});
				player.spreadIn = 0.9;
			}
		}

		for (const shot of this.#shots) {
			shot.x += shot.vx * dt;
			shot.y += shot.vy * dt;
		}
		const spent = new Set<Shot>();
		const height = rows * 2;
		for (const shot of this.#shots) {
			if (shot.friendly) {
				for (const enemy of this.#enemies) {
					const left = Math.round(enemy.x);
					const ey = Math.round(enemy.y);
					if (shot.y < ey || shot.y >= ey + enemy.art.length) continue;
					if (shot.x + 4 < left || shot.x > left + artWidth(enemy.art)) continue;
					spent.add(shot);
					this.#damage(enemy);
					break;
				}
			} else {
				const py = Math.round(player.y);
				const left = Math.round(player.x) + 3;
				if (shot.y + 1 >= py + 2 && shot.y < py + playerHeight - 2 && shot.x <= nose - 2 && shot.x + 1 >= left) {
					spent.add(shot);
					player.hit = 1;
				}
			}
		}
		for (const beam of this.#beams) {
			beam.age += dt;
			if (beam.friendly) {
				beam.ox = nose;
				beam.oy = Math.round(player.y) + gun;
				beam.tick -= dt;
				if (beam.tick > 0) continue;
				beam.tick = 0.15;
				const struck = new Set<Enemy>();
				for (const [x, y] of this.#beamPoints(beam)) {
					for (const enemy of this.#enemies) if (!struck.has(enemy) && this.#hits(enemy, x, y)) struck.add(enemy);
				}
				for (const enemy of struck) this.#damage(enemy);
				continue;
			}
			const owner = beam.owner;
			if (owner) {
				beam.ox = Math.round(owner.x) - 2;
				beam.oy = Math.round(owner.y) + Math.floor(owner.art.length / 2);
			}
			if (beam.age < beam.charge) continue;
			for (const [x, y] of this.#beamPoints(beam)) {
				if (x > nose + 1) continue;
				if (this.#hits(player, x, y, 2)) {
					player.hit = 1;
					break;
				}
			}
		}
		this.#beams = this.#beams.filter(beam => {
			const alive =
				beam.age < beam.life &&
				(beam.friendly || (beam.owner !== undefined && beam.owner.hp > 0 && beam.owner.x > -20));
			if (!alive && beam.owner) beam.owner.lasing = false;
			return alive;
		});
		this.#enemies = this.#enemies.filter(enemy => enemy.hp > 0);
		this.#shots = this.#shots.filter(
			shot => !spent.has(shot) && shot.x > -5 && shot.x < columns + 5 && shot.y > -3 && shot.y < height + 3,
		);
		for (const blast of this.#blasts) blast.age += dt / (blast.size > 1 ? 0.9 : 0.6);
		this.#blasts = this.#blasts.filter(blast => blast.age < 1);
	}
}
