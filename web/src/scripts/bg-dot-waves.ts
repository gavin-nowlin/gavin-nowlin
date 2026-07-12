type Rgba = { r: number; g: number; b: number; a: number };

type Wave = {
	kx: number;
	ky: number;
	speed: number;
	phase: number;
};

type FrameMask = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	/** Linear timeline 0–1; eased when applied to focus phases */
	progress: number;
	target: number;
};

const WAVES: readonly Wave[] = [
	{ kx: 0.13, ky: 0.065, speed: 0.55, phase: 0.2 },
	{ kx: 0.055, ky: 0.15, speed: -0.42, phase: 1.4 },
	{ kx: -0.1, ky: 0.085, speed: 0.68, phase: 2.7 },
	{ kx: 0.085, ky: -0.12, speed: -0.5, phase: 4.1 },
	{ kx: -0.048, ky: -0.095, speed: 0.38, phase: 5.5 },
];

/** Light → heavy glyph density by wave intensity */
const CHAR_RAMP = ['·', '.', ':', ';', '+', '*', '#', '%', '@'] as const;

const ALPHA_MIN = 0.05;
const ALPHA_MAX = 0.3;
const BORDER_GRIDS = 5;
/** How far wave peaks/valleys push the focus border (in grid cells) */
const EDGE_WAVE_GRIDS = 2.25;
/** Hide dots below this wave intensity near focused sections (scaled by proximity) */
const LOW_INTENSITY_CUTOFF = 0.34;
/** Seconds to fully focus/unfocus a section */
const CLEARANCE_FADE_SEC = 0.38;
/** First half of eased progress: damp wave intensity to minimum; second half: fade opacity */
const SUPPRESS_END = 0.5;

function clamp01(value: number) {
	return Math.min(1, Math.max(0, value));
}

function easeInOut(t: number) {
	const u = clamp01(t);
	return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

function smoothstep(t: number) {
	const u = clamp01(t);
	return u * u * (3 - 2 * u);
}

function parseCssColor(value: string): Rgba {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return { r: 40, g: 40, b: 40, a: 0.2 };
	ctx.clearRect(0, 0, 1, 1);
	ctx.fillStyle = '#000';
	ctx.fillStyle = value;
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
	return { r, g, b, a: a / 255 };
}

function readCssColor(varName: string, fallback: string): Rgba {
	const probe = document.createElement('div');
	probe.style.cssText = `position:absolute;visibility:hidden;color:var(${varName})`;
	document.body.appendChild(probe);
	const color = getComputedStyle(probe).color || fallback;
	probe.remove();
	return parseCssColor(color);
}

function readMonoFont() {
	const family = getComputedStyle(document.body).getPropertyValue('--font-mono').trim();
	return family || "'IBM Plex Mono', ui-monospace, monospace";
}

function readCssNumber(varName: string, fallback: number) {
	const raw = getComputedStyle(document.documentElement)
		.getPropertyValue(varName)
		.trim();
	const value = parseFloat(raw);
	return Number.isFinite(value) ? value : fallback;
}

function mixRgba(a: Rgba, b: Rgba, t: number): Rgba {
	const u = clamp01(t);
	return {
		r: a.r + (b.r - a.r) * u,
		g: a.g + (b.g - a.g) * u,
		b: a.b + (b.b - a.b) * u,
		a: a.a + (b.a - a.a) * u,
	};
}

function waveColor(base: Rgba, accent: Rgba, white: Rgba, intensity: number): Rgba {
	if (intensity < 0.5) {
		return mixRgba(base, accent, intensity * 2);
	}
	return mixRgba(accent, white, (intensity - 0.5) * 2);
}

function rgbaString(c: Rgba) {
	return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`;
}

function sampleIntensity(gx: number, gy: number, t: number) {
	let sum = 0;
	for (const wave of WAVES) {
		sum += Math.sin(wave.kx * gx + wave.ky * gy + wave.speed * t + wave.phase);
	}
	return clamp01((sum / WAVES.length + 1) / 2);
}

function charForIntensity(intensity: number) {
	const index = Math.min(
		CHAR_RAMP.length - 1,
		Math.floor(intensity * CHAR_RAMP.length),
	);
	return CHAR_RAMP[index];
}

/** Opacity rises slightly faster than linear as wave intensity peaks */
function alphaForIntensity(intensity: number, alphaMin: number, alphaMax: number) {
	const t = clamp01(intensity);
	const curved = t * (0.55 + 0.45 * t);
	return alphaMin + (alphaMax - alphaMin) * curved;
}

function suppressPhase(clearance: number) {
	return clamp01(clearance / SUPPRESS_END);
}

function opacityPhase(clearance: number) {
	return clamp01((clearance - SUPPRESS_END) / (1 - SUPPRESS_END));
}

/** 1 inside the frame; wave-undulated ramp to 0 across the outer border band */
function rectProximity(
	x: number,
	y: number,
	left: number,
	top: number,
	right: number,
	bottom: number,
	borderPx: number,
	waveIntensity: number,
	focusStrength: number,
	grid: number,
) {
	const dx = x < left ? left - x : x > right ? x - right : 0;
	const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
	const inside = dx === 0 && dy === 0;

	const wavePush =
		(waveIntensity - 0.5) * 2 * grid * EDGE_WAVE_GRIDS * focusStrength;
	const animatedBorder = borderPx * (1 + 0.2 * focusStrength);

	if (inside) return 1;

	const dist = Math.hypot(dx, dy);
	const effectiveDist = Math.max(0, dist - wavePush);
	if (effectiveDist >= animatedBorder) return 0;

	return smoothstep(1 - effectiveDist / animatedBorder);
}

type FocusEffect = {
	suppress: number;
	opacityFade: number;
	proximity: number;
	focusInfluence: number;
};

function focusEffectAt(
	x: number,
	y: number,
	waveIntensity: number,
	masks: FrameMask[],
	borderPx: number,
	grid: number,
): FocusEffect {
	let suppress = 0;
	let opacityFade = 0;
	let proximity = 0;
	let focusInfluence = 0;

	for (const mask of masks) {
		if (mask.progress <= 0) continue;

		const eased = easeInOut(mask.progress);
		const prox = rectProximity(
			x,
			y,
			mask.left,
			mask.top,
			mask.right,
			mask.bottom,
			borderPx,
			waveIntensity,
			eased,
			grid,
		);
		if (prox <= 0) continue;

		const damp = prox * suppressPhase(eased);
		const fade = prox * opacityPhase(eased);
		suppress = Math.max(suppress, damp);
		opacityFade = Math.max(opacityFade, fade);
		proximity = Math.max(proximity, prox);
		focusInfluence = Math.max(focusInfluence, prox * eased);
	}

	return { suppress, opacityFade, proximity, focusInfluence };
}

export function initBgDotWaves(
	canvas: HTMLCanvasElement,
	getDotGridPx: () => number,
) {
	const ctx = canvas.getContext('2d');
	if (!ctx) return () => {};

	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const frameEls = Array.from(document.querySelectorAll<HTMLElement>('.frame'));
	const masks: FrameMask[] = frameEls.map(() => ({
		left: 0,
		top: 0,
		right: 0,
		bottom: 0,
		progress: 0,
		target: 0,
	}));

	let grid = getDotGridPx();
	let cols = 0;
	let rows = 0;
	let dpr = 1;
	let rafId = 0;
	let startTs = 0;
	let lastTs = 0;
	let monoFont = readMonoFont();
	let base = readCssColor('--color-dot', 'rgba(40, 40, 40, 0.2)');
	let accent = readCssColor('--color-accent', 'oklch(0.6171 0.1825 145.59)');
	let white = readCssColor('--color-dot-wave-white', 'oklch(1 0 0)');
	let alphaMin = ALPHA_MIN;
	let alphaMax = ALPHA_MAX;

	function refreshColors() {
		base = readCssColor('--color-dot', 'rgba(40, 40, 40, 0.2)');
		accent = readCssColor('--color-accent', 'oklch(0.6171 0.1825 145.59)');
		white = readCssColor('--color-dot-wave-white', 'oklch(1 0 0)');
		monoFont = readMonoFont();
		alphaMin = readCssNumber('--ascii-alpha-min', ALPHA_MIN);
		alphaMax = readCssNumber('--ascii-alpha-max', ALPHA_MAX);
	}

	function syncMasks(dt: number) {
		const scrollX = window.scrollX;
		const scrollY = window.scrollY;
		const rate = dt / CLEARANCE_FADE_SEC;

		for (let i = 0; i < frameEls.length; i++) {
			const el = frameEls[i];
			const mask = masks[i];
			const rect = el.getBoundingClientRect();
			mask.left = rect.left + scrollX;
			mask.top = rect.top + scrollY;
			mask.right = rect.right + scrollX;
			mask.bottom = rect.bottom + scrollY;
			mask.target = el.classList.contains('is-active') ? 1 : 0;

			if (reduceMotion.matches) {
				mask.progress = mask.target;
				continue;
			}

			if (mask.progress < mask.target) {
				mask.progress = Math.min(mask.target, mask.progress + rate);
			} else if (mask.progress > mask.target) {
				mask.progress = Math.max(mask.target, mask.progress - rate);
			}
		}
	}

	function resizeCanvas() {
		grid = getDotGridPx();
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = document.documentElement.scrollWidth;
		const h = Math.max(
			document.documentElement.scrollHeight,
			document.body.scrollHeight,
		);
		canvas.width = Math.floor(w * dpr);
		canvas.height = Math.floor(h * dpr);
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		cols = Math.max(2, Math.ceil(w / grid) + 1);
		rows = Math.max(2, Math.ceil(h / grid) + 1);
	}

	function drawFrame(t: number, animate: boolean) {
		ctx!.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
		ctx!.font = `${grid * 0.85}px ${monoFont}`;
		ctx!.textAlign = 'center';
		ctx!.textBaseline = 'middle';

		const borderPx = grid * BORDER_GRIDS;

		for (let gy = 0; gy < rows; gy++) {
			for (let gx = 0; gx < cols; gx++) {
				const x = gx * grid;
				const y = gy * grid;
				const rawIntensity = animate ? sampleIntensity(gx, gy, t) : 0;
				const { suppress, opacityFade, focusInfluence } = focusEffectAt(
					x,
					y,
					rawIntensity,
					masks,
					borderPx,
					grid,
				);

				// Near focused sections, cull very low wave intensity so gaps track the animation
				if (focusInfluence > 0.03) {
					const cutoff = focusInfluence * LOW_INTENSITY_CUTOFF;
					if (rawIntensity < cutoff) continue;
				}

				let intensity = rawIntensity * (1 - suppress);

				const color = animate
					? waveColor(base, accent, white, intensity)
					: base;
				const alpha =
					(animate ? alphaForIntensity(intensity, alphaMin, alphaMax) : alphaMin) *
					(1 - opacityFade);

				if (alpha <= 0.001) continue;

				ctx!.fillStyle = rgbaString({ ...color, a: alpha });
				ctx!.fillText(charForIntensity(intensity), x, y);
			}
		}
	}

	function tick(ts: number) {
		if (!startTs) startTs = ts;
		const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
		lastTs = ts;
		syncMasks(dt);
		drawFrame((ts - startTs) / 1000, true);
		rafId = requestAnimationFrame(tick);
	}

	function start() {
		cancelAnimationFrame(rafId);
		resizeCanvas();
		refreshColors();
		startTs = 0;
		lastTs = 0;
		syncMasks(CLEARANCE_FADE_SEC);

		if (reduceMotion.matches) {
			drawFrame(0, false);
			return;
		}

		rafId = requestAnimationFrame(tick);
	}

	function stop() {
		cancelAnimationFrame(rafId);
		rafId = 0;
		ctx!.clearRect(0, 0, canvas.width, canvas.height);
	}

	start();

	const ro = new ResizeObserver(() => {
		resizeCanvas();
		syncMasks(CLEARANCE_FADE_SEC);
		if (reduceMotion.matches) {
			drawFrame(0, false);
		}
	});
	ro.observe(document.body);

	const themeObserver = new MutationObserver(() => {
		refreshColors();
		if (reduceMotion.matches) {
			syncMasks(CLEARANCE_FADE_SEC);
			drawFrame(0, false);
		}
	});
	themeObserver.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});

	const onSchemeChange = () => {
		refreshColors();
		if (reduceMotion.matches) {
			syncMasks(CLEARANCE_FADE_SEC);
			drawFrame(0, false);
		}
	};
	const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
	schemeQuery.addEventListener('change', onSchemeChange);

	const onMotionChange = (e: MediaQueryListEvent) => {
		if (e.matches) {
			cancelAnimationFrame(rafId);
			rafId = 0;
			refreshColors();
			syncMasks(CLEARANCE_FADE_SEC);
			drawFrame(0, false);
		} else {
			start();
		}
	};
	reduceMotion.addEventListener('change', onMotionChange);

	// Keep reduced-motion static frames in sync when focus changes via scroll
	const onScrollOrResize = () => {
		if (!reduceMotion.matches) return;
		syncMasks(CLEARANCE_FADE_SEC);
		drawFrame(0, false);
	};
	window.addEventListener('scroll', onScrollOrResize, { passive: true });
	window.addEventListener('resize', onScrollOrResize);

	return () => {
		stop();
		ro.disconnect();
		themeObserver.disconnect();
		schemeQuery.removeEventListener('change', onSchemeChange);
		reduceMotion.removeEventListener('change', onMotionChange);
		window.removeEventListener('scroll', onScrollOrResize);
		window.removeEventListener('resize', onScrollOrResize);
	};
}
