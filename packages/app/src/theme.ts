/**
 * Design tokens.
 *
 * True-black canvas with two raised greys. Agent output is read for long
 * stretches, often one-handed and at night, so the canvas recedes completely
 * and every control is a soft-grey pill floating on it.
 *
 * Muted values clear WCAG AA (4.5:1) against the canvas, measured on #000:
 * text 18.8:1, textDim 7.5:1, textFaint 5.8:1, accent 6.7:1, danger 6.3:1.
 */
export const theme = {
  color: {
    /** Canvas. True black, so on OLED the bezel and the app become one surface. */
    bg: "#000000",
    /** Resting control: chips, composer. */
    surface: "#1b1b1e",
    /** Raised control: top bar pills, sheets. */
    surfaceRaised: "#26262a",
    /** Pressed feedback for any surface. */
    surfacePressed: "#323238",
    border: "#2e2e33",

    text: "#f2f2f3",
    textDim: "#9a9aa0",
    textFaint: "#86868c",

    accent: "#d97757",
    success: "#3fb950",
    danger: "#f85149",
    thought: "#8b5cf6",
    /** Neutral orb base, used when a provider declares no colour. */
    orb: "#3d9bf5",
  },

  /** 4pt base grid. */
  space: (n: number) => n * 4,

  radius: { sm: 8, md: 12, lg: 18, pill: 999 },

  /** Control heights. Anything below 44 pairs with hitSlop to stay tappable. */
  size: {
    control: 38,
    chip: 40,
    composer: 48,
    composerButton: 34,
    orb: 44,
    /** Apple HIG minimum touch target. */
    touch: 44,
  },

  font: {
    tiny: 11,
    small: 13,
    body: 15,
    title: 17,
    greeting: 20,
  },

  line: {
    body: 22,
    greeting: 28,
  },

  /** Named so transitions never use `all` and share one curve. */
  motion: {
    fast: 120,
    base: 200,
  },
} as const;

/**
 * Lighten (ratio > 0) or darken (ratio < 0) a hex colour.
 * Used to build the orb's gloss from a single provider colour, so adding a
 * provider never requires hand-picking a gradient.
 */
export function shade(hex: string, ratio: number): string {
  const value = hex.replace("#", "");
  const normalised =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const num = Number.parseInt(normalised, 16);
  if (Number.isNaN(num)) return hex;

  const channel = (shift: number) => {
    const base = (num >> shift) & 0xff;
    const next = ratio >= 0 ? base + (255 - base) * ratio : base * (1 + ratio);
    return Math.round(Math.min(255, Math.max(0, next)));
  };

  return `#${[channel(16), channel(8), channel(0)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}
