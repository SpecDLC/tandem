// Paused-card paint. The roll-off window is the caller's PAUSED_ROLL_OFF_MS.
// Decorative strength fades with age. Necessary colors are solid RGB against the card background.

export interface Rgb { r: number; g: number; b: number }

export interface PausedPalette {
  paper: Rgb;
  yellow: Rgb;
  ink: Rgb;
  onYellow: Rgb;
  red: Rgb;
  onRed: Rgb;
  /** Fill tints the card with yellow. Outline keeps the paper background. */
  fill: boolean;
}

export interface PausedPaint {
  strength: number;
  label: string;
  background: Rgb;
  border: Rgb;
  icon: Rgb;
  accent: Rgb;
  title: Rgb;
  time: Rgb;
  resume: Rgb;
  close: Rgb;
  closeText: Rgb;
  hitPx: number;
}

export const PAUSED_STRENGTH_FRESH = 0.75;
export const PAUSED_STRENGTH_FADED = 0.25;
export const PAUSED_HIT_PX = 44;
const DAY_MS = 86_400_000;

export function pausedStrength(ageMs: number, windowMs: number): number {
  if (!(windowMs > 0)) return PAUSED_STRENGTH_FADED;
  const t = Math.min(1, Math.max(0, ageMs / windowMs));
  return PAUSED_STRENGTH_FRESH + (PAUSED_STRENGTH_FADED - PAUSED_STRENGTH_FRESH) * t;
}

export function pausedAgeLabel(ageMs: number): string {
  const days = Math.floor(Math.max(0, ageMs) / DAY_MS);
  return `paused ${days}d`;
}

export function parseCssColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "transparent") return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1] ?? "";
    const n = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return { r: Number.parseInt(n.slice(0, 2), 16), g: Number.parseInt(n.slice(2, 4), 16), b: Number.parseInt(n.slice(4, 6), 16) };
  }
  const rgb = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/.exec(v);
  if (!rgb) return null;
  return { r: Math.round(Number(rgb[1])), g: Math.round(Number(rgb[2])), b: Math.round(Number(rgb[3])) };
}

export function cssRgb(c: Rgb): string {
  return `rgb(${c.r} ${c.g} ${c.b})`;
}

function channel(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function mix(a: Rgb, b: Rgb, amountOfA: number): Rgb {
  const t = amountOfA;
  return {
    r: Math.round(a.r * t + b.r * (1 - t)),
    g: Math.round(a.g * t + b.g * (1 - t)),
    b: Math.round(a.b * t + b.b * (1 - t)),
  };
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** A solid color. Starts from `preferred` and moves toward black or white until `min` contrast holds. */
export function solidAgainst(preferred: Rgb, background: Rgb, min: number): Rgb {
  if (contrastRatio(preferred, background) >= min) return { ...preferred };
  const toward = contrastRatio(WHITE, background) >= contrastRatio(BLACK, background) ? WHITE : BLACK;
  for (let step = 1; step <= 255; step++) {
    const t = step / 255;
    const candidate = {
      r: Math.round(preferred.r + (toward.r - preferred.r) * t),
      g: Math.round(preferred.g + (toward.g - preferred.g) * t),
      b: Math.round(preferred.b + (toward.b - preferred.b) * t),
    };
    if (contrastRatio(candidate, background) >= min) return candidate;
  }
  return contrastRatio(toward, background) >= min ? toward : (toward === WHITE ? BLACK : WHITE);
}

/** Same inputs, same paint. Does not read the clock. */
export function paintPausedCard(ageMs: number, windowMs: number, palette: PausedPalette): PausedPaint {
  const strength = pausedStrength(ageMs, windowMs);
  const background = palette.fill ? mix(palette.yellow, palette.paper, strength) : palette.paper;
  const border = mix(palette.ink, palette.paper, strength);
  const icon = mix(palette.ink, palette.paper, strength);
  const accent = palette.fill ? mix(palette.onYellow, palette.yellow, strength) : mix(palette.yellow, palette.paper, strength);
  const title = solidAgainst(palette.ink, background, 4.5);
  const close = solidAgainst(palette.red, background, 3);
  return {
    strength,
    label: pausedAgeLabel(ageMs),
    background,
    border,
    icon,
    accent,
    title,
    time: title,
    resume: solidAgainst(palette.ink, background, 3),
    close,
    closeText: solidAgainst(palette.onRed, close, 4.5),
    hitPx: PAUSED_HIT_PX,
  };
}
