import { Easing } from "react-native";
import { approvalActionColors, fallbackGlassTokens } from "./materialTokens";

/**
 * Design tokens.
 *
 * Near-black canvas with two raised greys. Agent output is read for long
 * stretches, often one-handed and at night, so the canvas recedes and every
 * control is a soft-grey pill floating on it.
 *
 * The drawer sits one step lighter than the conversation. Because the drawer is
 * revealed by sliding the conversation aside rather than covering it, that
 * difference is what separates the planes: the darker surface reads as on top.
 *
 * Muted values clear WCAG AA (4.5:1) against the canvas, measured on #0a0a0b:
 * text 18.2:1, textDim 7.3:1, textFaint 5.7:1, accent 6.5:1, danger 6.1:1.
 */
export const theme = {
  color: {
    /** Conversation canvas. The upper plane, and the darker of the two. */
    bg: "#111111",
    /** Drawer canvas. The lower plane, revealed as the conversation slides. */
    drawer: "#1c1c1e",
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
    /** Icon glyphs on a glass control. Sampled from the reference. */
    glyph: "#e0e0e0",
    /** Placeholder text inside the composer. */
    placeholder: "#828282",

    accent: "#d97757",
    success: "#3fb950",
    danger: "#f85149",
    thought: "#8b5cf6",
    /** Neutral orb base, used when a provider declares no colour. */
    orb: "#3d9bf5",
  },

  /** 4pt base grid. */
  space: (n: number) => n * 4,

  /**
   * Single horizontal gutter for every top-level surface. The drawer header,
   * its chips and list, and the conversation's top bar and composer all sit on
   * this one rail, so controls stay aligned as the drawer slides.
   */
  gutter: 20,

  /**
   * Vertical inset from the safe area to the first row of controls. The drawer
   * header and the conversation's top bar must both use this, or the title and
   * the hamburger it sits beside land on different lines as the drawer opens.
   */
  headerInset: 8,

  /**
   * Non-Apple fallback only. iOS 26/27 uses the native adaptive Liquid Glass
   * material, including the user's Clear/Tinted and accessibility preferences.
   * These values preserve the same hierarchy on web and Android: controls are
   * lighter than content, while composer/approval surfaces use regular-material
   * opacity for text legibility over a moving transcript.
   */
  glass: fallbackGlassTokens,

  /** Approval actions keep explicit contrast even over adaptive glass. */
  approval: approvalActionColors,

  radius: { sm: 8, md: 12, lg: 18, composer: 26, pane: 34, pill: 999 },

  /** Control heights. Anything below 44 pairs with hitSlop to stay tappable. */
  size: {
    control: 38,
    chip: 40,
    /**
     * Resting composer: one row, text inline between the two buttons.
     * 58 = button (36) + inset (11) top and bottom, so the buttons sit
     * centred when collapsed and in the corners once it grows.
     */
    composerCollapsed: 58,
    /** Focused composer: one text line above the action row. */
    composer: 96,
    composerButton: 36,
    /** Inset from the pill's edge to each action button. */
    composerInset: 11,
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

  /**
   * Display family, for main titles only.
   *
   * Bitcount Prop Single is a dot-matrix face: it carries the brand at heading
   * size but is unreadable in a paragraph, so body copy, agent output and
   * controls stay on the system font. Named here so the family string is
   * written once and every title changes together.
   *
   * Only applied once `useFonts` reports loaded. Naming an unloaded family on
   * iOS silently falls back with different metrics, which shifts layout after
   * the font arrives.
   */
  display: {
    regular: "BitcountPropSingle_400Regular",
    semibold: "BitcountPropSingle_600SemiBold",
    bold: "BitcountPropSingle_700Bold",
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

  /**
   * One shared curve. Decelerating, so a control arrives and settles rather
   * than stopping dead — which is what makes a resize read as smooth.
   */
  easing: Easing.bezier(0.22, 1, 0.36, 1),
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
