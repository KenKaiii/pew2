/**
 * The vibrant fill behind an agent's name in the drawer.
 *
 * These pills used to be grey glass with an 18pt orb beside the label, and the
 * drawer read as a row of near-identical chips. Here the pill *is* the colour,
 * so an agent is recognised before its name is read.
 *
 * The fill is derived from the manifest's own `pew.color`, so adding a provider
 * stays a matter of dropping in a JSON file. The brand supplies the hue; this
 * module supplies the vividness, taking each hue to full chroma in a narrow
 * bright band. That band is the register of `rgb(161,255,20)` — the colour is
 * meant to look lit, not tinted.
 *
 * Pure and React-free so the derivation is testable; `Sidebar.tsx` only renders
 * what this returns.
 */

/**
 * White, on every pill.
 *
 * Worth stating plainly, because it is the one place this file knowingly sits
 * under WCAG AA: white on a full-chroma fill does not reach 4.5:1, and it
 * cannot — no colour light enough to read as vivid is dark enough to carry
 * white text. Darkening the fills to earn that ratio was tried twice, and both
 * times produced a row of mud, which is the failure this treatment exists to
 * fix.
 *
 * So the fills stay vivid and the label leans on weight instead: one or two
 * short words at 13pt bold on a solid ground, which is the most forgiving case
 * text has. It reads least well on the lightest hues — the greens and cyans —
 * and that is a known cost of the choice, not an oversight. Every one of these
 * controls also carries an accessibility label, so nothing here is the only
 * route to the information.
 */
export const PROVIDER_LABEL = "#ffffff";

/** Straight sRGB channels, 0-255. */
function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** WCAG contrast ratio between two opaque colours. */
export function contrastRatio(left: string, right: string): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (bright + 0.05) / (dark + 0.05);
}

function toHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = channels(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/**
 * Saturation floor — a floor, never a multiplier.
 *
 * Scaling each brand by a factor was an earlier attempt and it is why those
 * pills looked washed out: a muted manifest colour stayed muted in proportion,
 * so `#d97757` rendered as salmon. Vivid is not "more of whatever chroma the
 * brand had"; it is high chroma, with the brand contributing only the hue.
 *
 * 0.9 rather than 1.0, measured off the reference swatches, which sit at 85-95%
 * and not at the top. Full saturation is where a colour starts to look like a
 * test pattern; a couple of points back is where it looks designed.
 */
const NEON_SATURATION = 0.9;

/**
 * Below this saturation a brand is treated as a neutral and left alone.
 *
 * At low chroma the hue angle stops being a colour anyone chose and becomes an
 * artefact of which channel happens to sit a few points high. Saturated and
 * swept, OpenCode's near-white `#e4e4e7` came out vivid indigo and Cursor's
 * slate `#94a3b8` came out electric blue — both technically hue-preserving and
 * both plainly the wrong colour. A declared grey stays grey.
 */
const NEUTRAL_MAX = 0.3;

/**
 * Where the gradient starts and ends in lightness.
 *
 * Measured off the reference swatches, which run bright-to-deep: roughly L 68%
 * down to L 55%. Every brand is pulled onto this same ramp regardless of the
 * lightness it declared — manifest colours arrive anywhere from `#c2410c` to
 * near-white `#e4e4e7`, and it is the shared ramp that makes the row read as
 * one set rather than as twelve unrelated colours.
 */
const LIGHT_FROM = 0.68;
const LIGHT_TO = 0.55;

/**
 * How far around the wheel the second stop travels, and which way.
 *
 * This is the thing every earlier version got wrong. A 10-degree sweep is a
 * shading of one colour; the references are unmistakably *two* colours meeting
 * — cyan into blue, green into teal, yellow into orange — and measuring them
 * gives 45 to 65 degrees of travel.
 *
 * Direction is not uniform, and cannot be. Cool hues sweep forward, deeper into
 * blue and violet. Warm hues sweep backward, toward red. Sweeping a warm hue
 * forward instead drags orange through yellow-green, the dead part of the
 * wheel, and is exactly how an earlier attempt turned terracotta into mustard;
 * choosing the direction by measured darkness instead sent it to magenta, which
 * is deeper but is no longer the agent's colour. Both fixed directions run
 * toward richer, denser colour within the family the brand belongs to.
 */
const COOL_SWEEP = 52;
const WARM_SWEEP = -30;

/**
 * The arc treated as cool: yellow-green round through cyan to violet.
 *
 * Outside it lie the yellows, oranges, reds and pinks, all of which have red
 * rather than blue as their natural deep end.
 */
const COOL_START = 60;
const COOL_END = 300;

export interface ProviderFill {
  /** Top-left to bottom-right stops. */
  colors: readonly [string, string];
  /** Always `PROVIDER_LABEL`, carried here so callers need not import it. */
  label: string;
}

/**
 * Derived fills, kept by brand colour.
 *
 * The drawer re-renders often and asks for every agent's fill each time, while
 * the answer depends only on the hex and never changes. Bounded by the number
 * of distinct manifest colours — twelve today, one per provider file after that
 * — so this cannot grow with use.
 */
const cache = new Map<string, ProviderFill>();

/**
 * Derive an agent's pill from its brand colour.
 *
 * The first stop is the brand's own hue at high chroma; the second is that hue
 * swept round the wheel and stepped down in lightness. Two colours meeting, not
 * one colour shaded — which is the difference between these and every earlier
 * version of this file.
 */
export function providerFill(brand: string): ProviderFill {
  const hit = cache.get(brand);
  if (hit) return hit;

  const { h, s } = toHsl(brand);
  const neutral = s <= NEUTRAL_MAX;
  const saturation = neutral ? s : Math.max(s, NEON_SATURATION);
  // A near-neutral has no hue worth travelling: sweeping it would announce a
  // colour the manifest never picked, and 52 degrees announces it loudly.
  const sweep = neutral ? 0 : h >= COOL_START && h < COOL_END ? COOL_SWEEP : WARM_SWEEP;

  const fill: ProviderFill = {
    colors: [
      fromHsl(h, saturation, LIGHT_FROM),
      // `+ 360` before the modulo: the warm sweep is negative, and a bare `%`
      // in JS keeps the sign, which would hand `fromHsl` a hue below zero.
      fromHsl((h + sweep + 360) % 360, saturation, LIGHT_TO),
    ],
    label: PROVIDER_LABEL,
  };
  cache.set(brand, fill);
  return fill;
}
