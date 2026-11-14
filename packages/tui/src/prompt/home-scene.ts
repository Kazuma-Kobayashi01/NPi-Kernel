import type { BackdropGlyph } from "./tile-backdrop";

/**
 * The home screen's backdrop: a Japanese night street drawn only a shade off
 * the terminal background, in the theme's own colours, scrolling past as if
 * seen from a moving train. Back to front: stars and a crescent moon; a faint
 * far skyline drifting slowly; a lattice tower with its observation decks and
 * blinking beacon; the near city hung with flickering neon signboards, its
 * windows lighting and going dark; street lamps on poles strung with sagging
 * power lines; and the street itself, its wet asphalt mirroring the neon, lane
 * markings rushing past, pools of lamplight, and cars with their headlights on.
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
const GLITCH = 0.04;
const SIGN_FILL = 0.06;
const SIGN_FRAME = 0.12;
const SIGN_TEXT = 0.4;
const STAR = 0.16;
const MOON = 0.16;
const MOON_HALO = 0.035;
const POLE = 0.22;
const WIRE = 0.17;
const LAMP = 0.5;
const LAMP_HALO = 0.1;
const LAMP_POOL = 0.085;
const CURB = 0.07;
const ASPHALT = 0.018;
const LANE_MARK = 0.11;
const REFLECTION = 0.5;
const CAR_BODY = 0.1;
const HEADLIGHT = 0.4;
const TAILLIGHT = 0.3;
const HEADLIGHT_BEAM = 0.06;

/** Scroll speeds in columns per second. */
const FAR_SPEED = 2.2;
const TOWER_SPEED = 3.8;
const NEAR_SPEED = 6;
const STAR_SPEED = 0.7;
/** The road is nearest of all, so its markings rush past fastest. */
const ROAD_SPEED = 14;

/** Columns between street lamps, in near-strip columns. */
const POLE_SPACING = 34;
/** Lane markings: a dash of this many columns every period. */
const DASH = 4;
const DASH_PERIOD = 9;
/** Most cars on one lane at once. */
const CARS_PER_LANE = 3;
const CAR_LENGTH = 7;

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

/** A tint over one cell. */
interface Tint {
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

/** Where the street furniture and the road sit, from the layout. */
interface Street {
	/** Row of the lamp heads and the upper wire. */
	poleTop: number;
	/** Sag of the wires midway between poles, in rows. */
	sag: number;
	/** Rows of the road's two lanes (`far` drives right, `near` drives left), and the lane marking between. */
	farLane: number;
	nearLane: number;
	marking: number;
}

interface Car {
	/** Column of the rear (far lane) or front (near lane) end. */
	x: number;
	/** Columns per second; positive drives right. */
	speed: number;
	lane: "far" | "near";
	tone: number;
}

interface Moon {
	x: number;
	y: number;
	/** Radius in rows; a cell is about twice as tall as it is wide. */
	radius: number;
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

export class HomeScene {
	#random = rng(Math.floor(Math.random() * 2 ** 31));
	#layout: SceneLayout = { columns: 0, rows: 0, contentLeft: 0, contentRight: 0 };
	#horizon = 0;
	#far: Strip = { length: 1, buildings: [], byColumn: new Int16Array(1).fill(-1) };
	#near: Strip = { length: POLE_SPACING, buildings: [], byColumn: new Int16Array(POLE_SPACING).fill(-1) };
	#tower: Tower = { length: 1, axis: 0, top: 0, base: 0 };
	#signs: Sign[] = [];
	/** Sign index per near-strip cell (-1: none). */
	#signByCell = new Int16Array(0);
	#street: Street | undefined;
	#moon: Moon | undefined;
	#cars: Car[] = [];
	/** Car tints of this frame, keyed `y * columns + x`. */
	#carCells = new Map<number, Tint>();
	#spawnIn = { far: 0, near: 0 };
	#now = 0;
	#last: number | undefined;
	/** Scroll offsets this frame, in columns. */
	#farShift = 0;
	#towerShift = 0;
	#nearShift = 0;
	#starShift = 0;
	#roadShift = 0;
	#theme: SceneTheme = {
		backdrop: [0, 0, 0],
		stops: [
			[0, 0, 0],
			[0, 0, 0],
		],
		reveal: 1,
	};
	#lit = 1;

	/** Match the screen; a change rebuilds the city and clears the road. */
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
		const { columns, rows, contentRight } = layout;
		this.#horizon = rows - Math.max(4, Math.floor(rows * 0.26));
		const horizon = this.#horizon;
		this.#far = this.#buildStrip(Math.max(columns * 2, 240), 0.85, 12, 22);
		// A whole number of lamp spacings, so the poles stay evenly spaced across the wrap.
		const nearLength = Math.ceil(Math.max(columns * 2, 240) / POLE_SPACING) * POLE_SPACING;
		this.#near = this.#buildStrip(nearLength, 0.7, 8, 12);
		this.#tower = {
			length: Math.max(columns + 60, 200),
			axis: Math.floor(columns * 0.7),
			top: Math.max(1, Math.floor(horizon * 0.08)),
			base: Math.max(6, Math.floor(horizon * 0.22)),
		};
		this.#hangSigns();
		const ground = rows - horizon;
		this.#street = {
			poleTop: horizon - Math.max(5, Math.floor(horizon * 0.3)),
			sag: horizon > 14 ? 2 : 1,
			farLane: horizon + 1,
			nearLane: rows - Math.max(1, Math.floor(ground / 3)),
			marking: horizon + 1 + Math.floor((ground - 1) / 2),
		};
		// The moon hangs over the free space right of the content when there is some.
		const radius = horizon > 18 ? 2 : 1.5;
		const room = columns - contentRight;
		this.#moon = {
			x: room > 16 ? contentRight + Math.floor(room * 0.55) : Math.floor(columns * 0.86),
			y: Math.max(Math.ceil(radius) + 1, Math.floor(horizon * 0.16)),
			radius,
		};
		this.#cars = [];
		this.#carCells.clear();
		this.#spawnIn = { far: 0.3, near: 1.4 };
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
		this.#roadShift = Math.floor(seconds * ROAD_SPEED);
		if (dt > 0) this.#stepTraffic(dt);
		this.#paintCars();
	}

	/** Background of the cell at column `x`, row `y`; `undefined` leaves the terminal's own. */
	bg(x: number, y: number): Rgb | undefined {
		return this.#cityBg(x, y);
	}

	/**
	 * Decoration glyph for the blank cell at column `x`, row `y`: lamp heads,
	 * poles and power lines, signboard lettering, and stars. Inside the content
	 * column only on rows that carry no text (`rowBlank`), so nothing lands
	 * between words.
	 */
	glyph(x: number, y: number, rowBlank: boolean): BackdropGlyph | undefined {
		const { contentLeft, contentRight } = this.#layout;
		if (!rowBlank && x >= contentLeft - 1 && x < contentRight + 1) return undefined;
		const { stops, backdrop } = this.#theme;
		const lit = this.#lit;

		const furniture = this.#streetGlyph(x, y);
		if (furniture) return furniture;

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
		if (
			y < this.#horizon - 1 &&
			!this.#inBuilding(this.#far, x, y, this.#farShift) &&
			!this.#towerCell(x, y) &&
			!this.#moonCell(x, y)
		) {
			const sx = x + this.#starShift;
			if (hash(sx, y, 11) < 0.006) {
				const twinkle = 0.5 + 0.5 * Math.sin(this.#now / 600 + hash(sx, y, 12) * 40);
				return { char: twinkle > 0.7 ? "+" : ".", width: 1, fg: mix(backdrop, stops[0]!, STAR * twinkle * lit) };
			}
		}
		return undefined;
	}

	/** Foreground colour of a tint over the backdrop. */
	#ink(tint: Tint): Rgb {
		return mix(this.#theme.backdrop, gradientAt(this.#theme.stops, tint.tone), tint.strength * this.#lit);
	}

	/** Near-strip column of screen column `x`, and the column of the lamp pole that owns it. */
	#poleOf(x: number): { sx: number; pole: number; offset: number } {
		const sx = wrap(x + this.#nearShift, this.#near.length);
		const offset = sx % POLE_SPACING;
		return { sx, pole: sx - offset, offset };
	}

	/** Row of a power line `offset` columns past a pole: hung at `top`, sagging midway. */
	#wireRow(top: number, offset: number): number {
		const t = offset / POLE_SPACING;
		return top + Math.round((this.#street?.sag ?? 1) * 4 * t * (1 - t));
	}

	/** Lamp heads, poles and the two power lines strung between them. */
	#streetGlyph(x: number, y: number): BackdropGlyph | undefined {
		const street = this.#street;
		if (!street || y < street.poleTop || y >= this.#horizon) return undefined;
		const { offset } = this.#poleOf(x);
		const warm = 0.32;
		if (offset === 0) {
			if (y === street.poleTop) return { char: "┬", width: 1, fg: this.#ink({ tone: warm, strength: POLE }) };
			return { char: "│", width: 1, fg: this.#ink({ tone: warm, strength: POLE }) };
		}
		// The lamp hangs from a short arm right of the pole.
		if (offset === 1 && y === street.poleTop)
			return { char: "╮", width: 1, fg: this.#ink({ tone: warm, strength: POLE }) };
		if (offset === 1 && y === street.poleTop + 1) {
			return { char: "▾", width: 1, fg: this.#ink({ tone: 0.18, strength: LAMP * this.#lampBuzz(x) }) };
		}
		if (offset > 1 && y === this.#wireRow(street.poleTop, offset)) {
			return { char: "─", width: 1, fg: this.#ink({ tone: warm, strength: WIRE }) };
		}
		if (offset > 2 && y === this.#wireRow(street.poleTop + 2, offset)) {
			return { char: "─", width: 1, fg: this.#ink({ tone: warm, strength: WIRE * 0.8 }) };
		}
		return undefined;
	}

	/** A lamp is steady; now and then one stutters for a moment. */
	#lampBuzz(x: number): number {
		const { pole } = this.#poleOf(x);
		return hash(Math.floor(this.#now / 90), pole, 31) < 0.02 ? 0.4 : 1;
	}

	/** Moon tint at the cell: a crescent with a faint halo. */
	#moonCell(x: number, y: number): Tint | undefined {
		const moon = this.#moon;
		if (!moon) return undefined;
		const dx = (x - moon.x) / 2;
		const dy = y - moon.y;
		const dist = Math.hypot(dx, dy);
		if (dist > moon.radius + 1.6) return undefined;
		if (dist <= moon.radius) {
			// The dark part of the crescent: a disc shifted toward the lower left.
			const shadow = Math.hypot(dx + moon.radius * 0.55, dy - moon.radius * 0.2) < moon.radius * 0.95;
			return shadow ? { tone: 0, strength: MOON * 0.18 } : { tone: 0, strength: MOON };
		}
		return { tone: 0, strength: MOON_HALO * (1 - (dist - moon.radius) / 1.6) };
	}

	/** The lit part of the near city at the cell: a lit window or a signboard. */
	#neonAt(x: number, y: number): Tint | undefined {
		const horizon = this.#horizon;
		if (y < 0 || y >= horizon) return undefined;
		const sign = this.#signAt(x, y);
		if (sign) return { tone: sign.tone, strength: SIGN_FRAME * this.#flicker(sign) };
		const nx = wrap(x + this.#nearShift, this.#near.length);
		const near = this.#near.buildings[this.#near.byColumn[nx]!];
		if (!near || y <= near.top) return undefined;
		const wx = nx - near.x0;
		const wy = horizon - 1 - y;
		if (wx % 3 !== 1 || wx >= near.x1 - near.x0 - 1 || wy % 2 !== 1) return undefined;
		const seed = hash(nx, y, 7);
		const period = Math.floor((this.#now + seed * 6000) / 6000);
		return hash(nx, y, period) < 0.32 ? { tone: 0.35 + seed * 0.3, strength: WINDOW } : undefined;
	}

	/** The city, tower, moon, lamps, signboards and street under the cell. */
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
		const street = this.#street;

		if (y < horizon) {
			const moon = this.#moonCell(x, y);
			if (moon) over(moon.tone, moon.strength);
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
			if (near && y >= near.top) over(0.85, SKYLINE);
			const window = this.#neonAt(x, y);
			if (window && !this.#signAt(x, y)) over(window.tone, window.strength);
			if (street) {
				// A soft halo around each lamp head.
				const { offset } = this.#poleOf(x);
				const lampDx = (offset - 1) / 2;
				const lampDy = y - (street.poleTop + 1);
				const reach = Math.hypot(lampDx, lampDy);
				if (reach < 2.2) over(0.18, LAMP_HALO * (1 - reach / 2.2) * this.#lampBuzz(x));
			}
		} else if (street) {
			const depth = (y - horizon) / Math.max(1, this.#layout.rows - horizon);
			if (y === horizon) {
				// The kerb: a pale line where the pavement meets the road.
				over(0.6, CURB);
			} else {
				over(0.8, ASPHALT);
				// Wet asphalt mirrors the neon above, wavering, fading toward the viewer.
				const ripple = Math.round(Math.sin(y * 1.9 + now / 380) * 1.4);
				const mirror = horizon - 1 - (y - horizon) * 2;
				const glow = this.#neonAt(x + ripple, mirror) ?? this.#neonAt(x + ripple, mirror + 1);
				if (glow) over(glow.tone, glow.strength * REFLECTION * (1 - depth * 0.6));
				if (y === street.marking && wrap(x + this.#roadShift, DASH_PERIOD) < DASH) over(0.95, LANE_MARK);
			}
			// A pool of lamplight spreading on the road under each lamp.
			const { offset } = this.#poleOf(x);
			const spread = 1.5 + (y - horizon) * 1.6;
			const from = Math.abs(offset - 1);
			const distance = Math.min(from, POLE_SPACING - from);
			if (distance < spread) over(0.18, LAMP_POOL * (1 - distance / spread) * (1 - depth * 0.5) * this.#lampBuzz(x));
			const car = this.#carCells.get(y * this.#layout.columns + x);
			if (car) over(car.tone, car.strength);
		}

		const glitchSlot = Math.floor(now / 9000);
		if (now % 9000 < 160 && Math.floor(hash(glitchSlot, 3) * horizon) === y) over(0.5, GLITCH);

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
	#towerCell(x: number, y: number): Tint | undefined {
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

	/** Cars come in from the edges, the far lane driving right and the near lane left. */
	#stepTraffic(dt: number): void {
		const { columns } = this.#layout;
		if (!this.#street || this.#layout.rows - this.#horizon < 4) return;
		for (const lane of ["far", "near"] as const) {
			this.#spawnIn[lane] -= dt;
			const count = this.#cars.filter(car => car.lane === lane).length;
			if (this.#spawnIn[lane] > 0 || count >= CARS_PER_LANE) continue;
			// The near lane is closer, so its cars pass faster.
			const speed = (lane === "far" ? 1 : -1) * ((lane === "far" ? 10 : 16) + this.#random() * 8);
			this.#cars.push({
				x: speed > 0 ? -CAR_LENGTH - 2 : columns + 2,
				speed,
				lane,
				tone: this.#random(),
			});
			this.#spawnIn[lane] = 1.6 + this.#random() * 3.5;
		}
		for (const car of this.#cars) car.x += car.speed * dt;
		this.#cars = this.#cars.filter(car => car.x > -CAR_LENGTH - 12 && car.x < columns + CAR_LENGTH + 12);
	}

	/** This frame's car bodies, lights and headlight beams, keyed by cell. */
	#paintCars(): void {
		const cells = this.#carCells;
		cells.clear();
		const street = this.#street;
		if (!street) return;
		const { columns } = this.#layout;
		const put = (x: number, y: number, tint: Tint): void => {
			if (x < 0 || x >= columns) return;
			const key = y * columns + x;
			const was = cells.get(key);
			if (!was || was.strength < tint.strength) cells.set(key, tint);
		};
		for (const car of this.#cars) {
			const y = car.lane === "far" ? street.farLane : street.nearLane;
			const rear = Math.round(car.x);
			const dir = car.speed > 0 ? 1 : -1;
			// Cells from the back of the car to its nose, in driving direction.
			for (let i = 0; i < CAR_LENGTH; i++) {
				const cx = rear + dir * i;
				if (i === 0) put(cx, y, { tone: 0.42, strength: TAILLIGHT });
				else if (i === CAR_LENGTH - 1) put(cx, y, { tone: 0.05, strength: HEADLIGHT });
				else put(cx, y, { tone: car.tone, strength: CAR_BODY });
			}
			// The cabin rises a row above the near-lane cars.
			if (car.lane === "near" && y - 1 > street.marking) {
				for (let i = 2; i < CAR_LENGTH - 2; i++)
					put(rear + dir * i, y - 1, { tone: car.tone, strength: CAR_BODY * 0.7 });
			}
			// The headlight beam reaches ahead, fading.
			for (let i = 1; i <= 8; i++) {
				put(rear + dir * (CAR_LENGTH - 1 + i), y, { tone: 0.05, strength: HEADLIGHT_BEAM * (1 - i / 9) });
			}
		}
	}
}
