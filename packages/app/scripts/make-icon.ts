/**
 * Draws the pew2 app icon.
 *
 * The icon is generated rather than drawn by hand because it is the same shape
 * as the rest of the brand and that relationship should be enforced, not
 * remembered. Every title in the app is set in Bitcount Prop Single, a
 * single-module dot-matrix face, and the agent mark is a sphere rendered as a
 * lit LED grid (`src/ui/orbMatrix.ts`). So the icon is the same panel showing
 * two characters instead of a ball.
 *
 * Run it with `bun packages/app/scripts/make-icon.ts`. Committing the output is
 * deliberate: an app icon must not depend on a build step that could fail on
 * someone else's machine and ship a blank square to a store.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const REPO = join(APP, "..", "..");

/** Straight from `src/theme.ts`. Duplicated because a PNG cannot import it. */
const ACCENT = "#d97757";
const BACKGROUND = "#111111";

/**
 * `P2` on a 7-row dot matrix.
 *
 * Seven rows is the classic LED character height, and both glyphs are drawn
 * seven-segment style: full-width bars and square corners, no diagonals. A
 * conventional 5x7 `P` leaves its top-right cell dark, which with round dots
 * this large reads as a broken bowl rather than as a letter.
 *
 * Written as strings because the shape has to be *readable in the source*. An
 * icon nobody can adjust without a design tool is one that never gets adjusted.
 */
const GLYPHS = [
  "#####",
  "#   #",
  "#   #",
  "#####",
  "#    ",
  "#    ",
  "#    ",
].map((row, index) =>
  [
    row,
    // The 2 beside it, drawn seven-segment style: two full bars and two half
    // stems. It carries the same weight as the P, which a curved numeral would
    // not, and it is what an LED panel would actually light.
    ["#####", "    #", "    #", "#####", "#    ", "#    ", "#####"][index]!,
    // Two dark columns between them, not one. Both glyphs carry a full-width
    // top bar, and a single gap lets those bars read as one continuous rule at
    // home-screen size instead of as two characters.
  ].join("  "),
);

const COLUMNS = GLYPHS[0]!.length;
const ROWS = GLYPHS.length;

/**
 * How much of a cell a lit dot fills.
 *
 * Under 1 so the grid reads as separate lamps rather than a solid block, which
 * is the entire point of a matrix panel.
 */
const DOT_FILL = 0.82;

/**
 * Unlit cells, drawn faintly.
 *
 * A real panel has all its lamps whether or not they are on, and showing them
 * is what makes this read as a *display* rather than as pixel art. Faint enough
 * to disappear at small sizes, where the icon should just be the letters.
 */
const OFF_OPACITY = 0.045;

/**
 * The iOS squircle, as the superellipse Apple actually uses.
 *
 * A rounded rectangle is visibly not this: the corners meet the sides at a
 * curvature discontinuity that the eye picks up as a slightly wrong icon,
 * especially beside real ones on a home screen.
 *
 * iOS masks the icon itself, so this shape is for the README and anywhere else
 * the icon appears unmasked. The store asset stays square.
 */
function squirclePath(size: number, n = 5): string {
  const half = size / 2;
  const steps = 720;
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    // |x|^n + |y|^n = 1, solved parametrically so the curve is exact rather
    // than an approximation stitched from arcs.
    const x = Math.sign(cos) * Math.abs(cos) ** (2 / n) * half + half;
    const y = Math.sign(sin) * Math.abs(sin) ** (2 / n) * half + half;
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(3)},${y.toFixed(3)}`);
  }
  return `${points.join(" ")} Z`;
}

/**
 * The matrix, as SVG.
 *
 * @param size      Canvas edge in pixels.
 * @param squircle  Clip to the superellipse. Off for store assets, which iOS
 *                  masks itself and which must be full-bleed square.
 * @param margin    Fraction of the canvas left clear around the glyphs.
 */
function icon(size: number, { squircle = true, margin = 0.11 } = {}): string {
  // The panel is sized to whichever axis is tighter, so the glyphs keep square
  // cells rather than stretching to fill a non-square grid.
  const usable = size * (1 - margin * 2);
  const pitch = Math.min(usable / COLUMNS, usable / ROWS);
  const panelWidth = pitch * COLUMNS;
  const panelHeight = pitch * ROWS;
  const originX = (size - panelWidth) / 2;
  const originY = (size - panelHeight) / 2;
  const radius = (pitch * DOT_FILL) / 2;

  const dots: string[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const lit = GLYPHS[row]![column] === "#";
      const cx = originX + (column + 0.5) * pitch;
      const cy = originY + (row + 0.5) * pitch;
      dots.push(
        `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" ` +
          `fill="${ACCENT}" opacity="${lit ? 1 : OFF_OPACITY}"/>`,
      );
    }
  }

  const clip = squircle
    ? `<clipPath id="s"><path d="${squirclePath(size)}"/></clipPath>`
    : "";
  const group = squircle ? `<g clip-path="url(#s)">` : "<g>";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    ${clip}
    <radialGradient id="glow" cx="50%" cy="42%" r="62%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  ${group}
    <rect width="${size}" height="${size}" fill="${BACKGROUND}"/>
    <rect width="${size}" height="${size}" fill="url(#glow)"/>
    ${dots.join("\n    ")}
  </g>
</svg>`;
}

/** Just the glyphs, for the Android adaptive foreground and the splash. */
function foreground(size: number): string {
  // Android crops adaptive icons hard: the outer third can be masked away on
  // some launchers, so the mark sits well inside its own canvas.
  return icon(size, { squircle: false, margin: 0.28 }).replace(
    /<rect width="\d+" height="\d+" fill="#111111"\/>/,
    "",
  );
}

async function png(svg: string, size: number, out: string, opaque: boolean) {
  const image = sharp(Buffer.from(svg)).resize(size, size);
  // App Store rejects an icon with an alpha channel, so the store asset is
  // flattened rather than left transparent.
  const buffer = await (opaque ? image.flatten({ background: BACKGROUND }) : image)
    .png()
    .toBuffer();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, buffer);
  console.log(`  ${out.replace(REPO + "/", "")}  ${(buffer.length / 1024).toFixed(0)}KB`);
}

console.log("Drawing the icon:");

// Store icon: square and opaque, because iOS applies its own mask and rejects
// alpha. Everything else can keep the squircle.
await png(icon(1024, { squircle: false }), 1024, join(APP, "assets/icon.png"), true);
await png(icon(1024), 1024, join(REPO, "docs/icon.png"), true);
await png(icon(512), 512, join(APP, "assets/favicon.png"), false);
await png(foreground(1024), 1024, join(APP, "assets/android-icon-foreground.png"), false);
await png(foreground(1024), 1024, join(APP, "assets/splash-icon.png"), false);

// Android's adaptive background is a flat plate; the foreground floats over it.
await png(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${BACKGROUND}"/></svg>`,
  1024,
  join(APP, "assets/android-icon-background.png"),
  true,
);

// Monochrome is used by Android as a mask and tinted by the system wallpaper,
// so it ships as a flat silhouette. The glow is dropped rather than recoloured:
// a soft-edged gradient in a mask becomes a smear once themed.
await png(
  foreground(1024)
    .replace(/<rect width="\d+" height="\d+" fill="url\(#glow\)"\/>/, "")
    .replaceAll(ACCENT, "#ffffff"),
  1024,
  join(APP, "assets/android-icon-monochrome.png"),
  false,
);

console.log("Done.");
