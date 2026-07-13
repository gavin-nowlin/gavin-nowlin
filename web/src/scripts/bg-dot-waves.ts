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

type CornerCell = { gx: number; gy: number; ch: string };

const WAVES: readonly Wave[] = [
	{ kx: 0.13, ky: 0.065, speed: 0.55, phase: 0.2 },
	{ kx: 0.055, ky: 0.15, speed: -0.42, phase: 1.4 },
	{ kx: -0.1, ky: 0.085, speed: 0.68, phase: 2.7 },
	{ kx: 0.085, ky: -0.12, speed: -0.5, phase: 4.1 },
	{ kx: -0.048, ky: -0.095, speed: 0.38, phase: 5.5 },
];

/** Light → heavy glyph density by wave intensity */
const CHAR_RAMP = ['·', '.', ':', ';', '+', '*', '#', '%', '@'] as const;

const ALPHA_MIN = 0.14;
const ALPHA_MAX = 0.55;
const BORDER_GRIDS = 5;
/** How far wave peaks/valleys push the focus border (in grid cells) */
const EDGE_WAVE_GRIDS = 2.25;
/** Hide dots below this wave intensity near focused sections (scaled by proximity) */
const LOW_INTENSITY_CUTOFF = 0.34;
/** Seconds to fully focus/unfocus a section */
const CLEARANCE_FADE_SEC = 0.38;
/** First half of eased progress: damp wave intensity to minimum; second half: fade opacity */
const SUPPRESS_END = 0.5;
/** Extra cells drawn past the viewport edge */
const OVERSCAN = 1;
/** Unfocused / focused opacity for frame corner ASCII */
const CORNER_ALPHA_MIN = 0.4;
const CORNER_ALPHA_MAX = 0.95;

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

/**
 * + at the corner, then `-` / `|` arms.
 * arm = number of line cells extending from the plus (scales with --corner-arm).
 */
function cornerCellsForMask(
	mask: FrameMask,
	grid: number,
	arm: number,
): CornerCell[] {
	const tlGx = Math.round(mask.left / grid);
	const tlGy = Math.round(mask.top / grid);
	const brGx = Math.round(mask.right / grid);
	const brGy = Math.round(mask.bottom / grid);
	const cells: CornerCell[] = [
		{ gx: tlGx, gy: tlGy, ch: '+' },
		{ gx: brGx, gy: brGy, ch: '+' },
	];

	for (let i = 1; i <= arm; i++) {
		cells.push({ gx: tlGx + i, gy: tlGy, ch: '─' });
		cells.push({ gx: tlGx, gy: tlGy + i, ch: '〡' });
		cells.push({ gx: brGx - i, gy: brGy, ch: '─' });
		cells.push({ gx: brGx, gy: brGy - i, ch: '〡' });
	}

	return cells;
}

function buildCornerKeySet(masks: FrameMask[], grid: number, arm: number) {
	const keys = new Set<string>();
	for (const mask of masks) {
		for (const cell of cornerCellsForMask(mask, grid, arm)) {
			keys.add(`${cell.gx},${cell.gy}`);
		}
	}
	return keys;
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
	let docW = 0;
	let docH = 0;
	let viewW = 0;
	let viewH = 0;
	let dpr = 1;
	let cornerArm = 2;
	let rafId = 0;
	let startTs = 0;
	let lastTs = 0;
	let monoFont = readMonoFont();
	let base = readCssColor('--color-dot', 'rgba(40, 40, 40, 0.2)');
	let accent = readCssColor('--color-accent', 'oklch(0.6171 0.1825 145.59)');
	let white = readCssColor('--color-dot-wave-white', 'oklch(1 0 0)');
	let border = readCssColor('--color-border', 'rgba(180, 180, 180, 0.8)');
	let glow = readCssColor('--color-glow', 'rgba(80, 200, 100, 0.2)');
	let alphaMin = ALPHA_MIN;
	let alphaMax = ALPHA_MAX;
	let running = false;
	let cornerKeys = new Set<string>();
	/** Previous viewport origin in document space (for clearing stale ink while scrolling) */
	let prevScrollX = 0;
	let prevScrollY = 0;
	let hasPrevViewport = false;

	function refreshColors() {
		base = readCssColor('--color-dot', 'rgba(40, 40, 40, 0.2)');
		accent = readCssColor('--color-accent', 'oklch(0.6171 0.1825 145.59)');
		white = readCssColor('--color-dot-wave-white', 'oklch(1 0 0)');
		border = readCssColor('--color-border', 'rgba(180, 180, 180, 0.8)');
		glow = readCssColor('--color-glow', 'rgba(80, 200, 100, 0.2)');
		monoFont = readMonoFont();
		alphaMin = readCssNumber('--ascii-alpha-min', ALPHA_MIN);
		alphaMax = readCssNumber('--ascii-alpha-max', ALPHA_MAX);
		cornerArm = Math.max(1, Math.round(readCssNumber('--corner-arm', 2)));
	}

	function waveT(now = performance.now()) {
		if (!startTs) return 0;
		return (now - startTs) / 1000;
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

		cornerKeys = buildCornerKeySet(masks, grid, cornerArm);
	}

	function resizeCanvas() {
		grid = getDotGridPx();
		cornerArm = Math.max(1, Math.round(readCssNumber('--corner-arm', 2)));
		// Cap DPR — document-sized backing store; viewport-only draws keep CPU down
		dpr = Math.min(window.devicePixelRatio || 1, 1.5);
		docW = document.documentElement.scrollWidth;
		docH = Math.max(
			document.documentElement.scrollHeight,
			document.body.scrollHeight,
		);
		viewW = window.innerWidth;
		viewH = window.innerHeight;
		canvas.width = Math.floor(docW * dpr);
		canvas.height = Math.floor(docH * dpr);
		canvas.style.width = `${docW}px`;
		canvas.style.height = `${docH}px`;
		ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		hasPrevViewport = false;
	}

	function clearViewportRegion(x: number, y: number) {
		const pad = grid * (OVERSCAN + 2);
		ctx!.clearRect(x - pad, y - pad, viewW + pad * 2, viewH + pad * 2);
	}

	function drawCorners(scrollX: number, scrollY: number) {
		ctx!.font = `${grid * 0.95}px ${monoFont}`;
		ctx!.textAlign = 'center';
		ctx!.textBaseline = 'middle';

		const minX = scrollX - grid;
		const minY = scrollY - grid;
		const maxX = scrollX + viewW + grid;
		const maxY = scrollY + viewH + grid;

		for (const mask of masks) {
			const eased = easeInOut(mask.progress);
			const color = mixRgba(border, accent, eased);
			const alpha = CORNER_ALPHA_MIN + (CORNER_ALPHA_MAX - CORNER_ALPHA_MIN) * eased;
			const cells = cornerCellsForMask(mask, grid, cornerArm);

			ctx!.shadowColor = rgbaString({
				...glow,
				a: glow.a * eased,
			});
			ctx!.shadowBlur = eased > 0.01 ? 10 * eased : 0;
			ctx!.fillStyle = rgbaString({ ...color, a: alpha });

			for (const cell of cells) {
				const docX = cell.gx * grid;
				const docY = cell.gy * grid;
				if (docX < minX || docY < minY || docX > maxX || docY > maxY) continue;
				ctx!.fillText(cell.ch, docX, docY);
			}
		}

		ctx!.shadowBlur = 0;
		ctx!.shadowColor = 'transparent';
	}

	function drawFrame(t: number, animate: boolean) {
		const scrollX = window.scrollX;
		const scrollY = window.scrollY;

		// Canvas lives in document space and scrolls with content (compositor-synced).
		// Only clear/paint the visible region (+ previous region to erase stale waves).
		if (hasPrevViewport) {
			clearViewportRegion(prevScrollX, prevScrollY);
		}
		clearViewportRegion(scrollX, scrollY);
		prevScrollX = scrollX;
		prevScrollY = scrollY;
		hasPrevViewport = true;

		ctx!.font = `${grid * 0.85}px ${monoFont}`;
		ctx!.textAlign = 'center';
		ctx!.textBaseline = 'middle';
		ctx!.shadowBlur = 0;

		const borderPx = grid * BORDER_GRIDS;
		const startGx = Math.floor(scrollX / grid) - OVERSCAN;
		const startGy = Math.floor(scrollY / grid) - OVERSCAN;
		const endGx = Math.ceil((scrollX + viewW) / grid) + OVERSCAN;
		const endGy = Math.ceil((scrollY + viewH) / grid) + OVERSCAN;

		let lastFill = '';

		for (let gy = startGy; gy <= endGy; gy++) {
			for (let gx = startGx; gx <= endGx; gx++) {
				if (cornerKeys.has(`${gx},${gy}`)) continue;

				const docX = gx * grid;
				const docY = gy * grid;
				const rawIntensity = animate ? sampleIntensity(gx, gy, t) : 0;
				const { suppress, opacityFade, focusInfluence } = focusEffectAt(
					docX,
					docY,
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

				const intensity = rawIntensity * (1 - suppress);

				const color = animate
					? waveColor(base, accent, white, intensity)
					: base;
				const alpha =
					(animate ? alphaForIntensity(intensity, alphaMin, alphaMax) : alphaMin) *
					(1 - opacityFade);

				if (alpha <= 0.001) continue;

				const fill = rgbaString({ ...color, a: alpha });
				if (fill !== lastFill) {
					ctx!.fillStyle = fill;
					lastFill = fill;
				}
				ctx!.fillText(charForIntensity(intensity), docX, docY);
			}
		}

		drawCorners(scrollX, scrollY);
	}

	function tick(ts: number) {
		rafId = requestAnimationFrame(tick);
		if (!startTs) startTs = ts;
		const drawDt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
		lastTs = ts;
		syncMasks(drawDt);
		drawFrame(waveT(ts), true);
	}

	function stopLoop() {
		cancelAnimationFrame(rafId);
		rafId = 0;
		running = false;
	}

	function startLoop() {
		if (running || reduceMotion.matches || document.hidden) return;
		running = true;
		startTs = 0;
		lastTs = 0;
		rafId = requestAnimationFrame(tick);
	}

	function paintStatic() {
		syncMasks(CLEARANCE_FADE_SEC);
		drawFrame(0, false);
	}

	function start() {
		stopLoop();
		resizeCanvas();
		refreshColors();

		if (reduceMotion.matches) {
			paintStatic();
			return;
		}

		syncMasks(CLEARANCE_FADE_SEC);
		startLoop();
	}

	function stop() {
		stopLoop();
		ctx!.clearRect(0, 0, docW, docH);
	}

	start();

	const onResize = () => {
		resizeCanvas();
		if (reduceMotion.matches) {
			paintStatic();
		}
	};
	window.addEventListener('resize', onResize);

	const ro = new ResizeObserver(() => {
		const nextW = document.documentElement.scrollWidth;
		const nextH = Math.max(
			document.documentElement.scrollHeight,
			document.body.scrollHeight,
		);
		if (nextW !== docW || nextH !== docH) {
			onResize();
		}
	});
	ro.observe(document.body);

	const themeObserver = new MutationObserver(() => {
		refreshColors();
		if (reduceMotion.matches) {
			paintStatic();
		}
	});
	themeObserver.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});

	const onSchemeChange = () => {
		refreshColors();
		if (reduceMotion.matches) {
			paintStatic();
		}
	};
	const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
	schemeQuery.addEventListener('change', onSchemeChange);

	const onMotionChange = (e: MediaQueryListEvent) => {
		if (e.matches) {
			stopLoop();
			refreshColors();
			paintStatic();
		} else {
			start();
		}
	};
	reduceMotion.addEventListener('change', onMotionChange);

	// Document-space canvas scrolls with content; reduced-motion still needs focus redraws
	const onScroll = () => {
		if (!reduceMotion.matches) return;
		paintStatic();
	};
	window.addEventListener('scroll', onScroll, { passive: true });

	const onVisibility = () => {
		if (document.hidden) {
			stopLoop();
			return;
		}
		if (reduceMotion.matches) {
			paintStatic();
			return;
		}
		startLoop();
	};
	document.addEventListener('visibilitychange', onVisibility);

	return () => {
		stop();
		ro.disconnect();
		themeObserver.disconnect();
		schemeQuery.removeEventListener('change', onSchemeChange);
		reduceMotion.removeEventListener('change', onMotionChange);
		window.removeEventListener('resize', onResize);
		window.removeEventListener('scroll', onScroll);
		document.removeEventListener('visibilitychange', onVisibility);
	};
}
