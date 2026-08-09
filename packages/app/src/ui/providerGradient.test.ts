import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_LABEL, contrastRatio, providerFill } from "./providerGradient";

/** Every brand colour the app actually ships, read from the manifests. */
function shippedColors(): { id: string; color: string }[] {
  const dir = join(import.meta.dir, "..", "..", "..", "..", "providers");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
    .map((manifest) => ({ id: manifest.id as string, color: manifest.pew?.color ?? "" }))
    .filter((entry) => entry.color !== "");
}

/** Largest channel gap: how far a colour sits from grey. */
function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Hue angle in degrees, 0-360. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const raw =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  const degrees = raw * 60;
  return degrees < 0 ? degrees + 360 : degrees;
}

/** True for a brand with no hue at all, which has nothing to make vivid. */
function achromatic(hex: string): boolean {
  return chroma(hex) === 0;
}

test("every shipped agent's pill is actually vivid", () => {
  // The regression this exists for: scaling each brand's own saturation left
  // muted colours muted, so `#d97757` rendered as salmon and the row looked
  // washed out. High chroma is the whole point of the treatment.
  //
  // Near-neutrals are excluded for the same reason the module leaves them
  // alone: a brand with almost no chroma has none to amplify, and forcing some
  // invents a colour it never declared.
  const providers = shippedColors().filter((entry) => chroma(entry.color) > 60);
  // Guards the guard: an empty glob would pass this loop silently.
  expect(providers.length).toBeGreaterThan(5);

  for (const { id, color } of providers) {
    for (const stop of providerFill(color).colors) {
      expect(chroma(stop), `${id} (${color}) rendered washed out as ${stop}`).toBeGreaterThan(120);
    }
  }
});

test("the label colour is white on every pill", () => {
  // Recorded rather than asserted-against-a-ratio, because these fills do not
  // meet WCAG contrast for white text and are not meant to — see the note on
  // `PROVIDER_LABEL`. The test exists so the decision is visible in the suite
  // instead of being an accident someone silently "fixes" by darkening the
  // fills, which is what produced the muddy pills this replaced.
  for (const { id, color } of shippedColors()) {
    expect(providerFill(color).label, id).toBe(PROVIDER_LABEL);
  }
});

test("every pill stands off the dark canvas", () => {
  // The failure this guards is the version where fills were darkened to earn
  // white contrast: they read as holes in the drawer rather than as colours.
  for (const { id, color } of shippedColors()) {
    for (const stop of providerFill(color).colors) {
      // 2.2 rather than 3: the deep stop of a dark-hued brand is genuinely
      // dark, and it is the *pair* that has to read, not each end alone.
      expect(contrastRatio(stop, "#111111"), `${id} vanishes into the canvas`).toBeGreaterThan(2.2);
    }
  }
});

/** Shortest way round the wheel, so 359 and 1 read as two degrees apart. */
function hueGap(left: string, right: string): number {
  return 180 - Math.abs(Math.abs(hue(left) - hue(right)) - 180);
}

test("the gradient starts on the hue the manifest declared", () => {
  // Only the first stop is pinned. The second is *supposed* to travel — these
  // are two-hue gradients, cyan into blue — so asserting both would forbid the
  // whole effect, which is what an earlier version of this test did.
  for (const { id, color } of shippedColors().filter((entry) => !achromatic(entry.color))) {
    const [from] = providerFill(color).colors;
    expect(hueGap(from, color), `${id} (${color}) starts at ${from}`).toBeLessThanOrEqual(6);
  }
});

test("the second stop travels far enough to be a second colour", () => {
  // The failure this guards is the version before it: a 10-degree sweep is a
  // shading of one colour, and the pills read as flat. The references measure
  // 45 to 65 degrees of travel.
  for (const { id, color } of shippedColors().filter((entry) => chroma(entry.color) > 60)) {
    const [from, to] = providerFill(color).colors;
    expect(hueGap(from, to), `${id} (${color}) barely moves`).toBeGreaterThan(20);
  }
});

test("a near-neutral brand is not dragged into a colour it never declared", () => {
  // At low chroma the hue angle is an artefact of which channel sits a few
  // points high. Saturated and swept, these came out vivid indigo and electric
  // blue — hue-preserving, and plainly wrong.
  //
  // The sweep is suppressed for them too, not merely the saturation: 52 degrees
  // across a grey would end the gradient on a hue nothing declared.
  for (const brand of ["#e4e4e7", "#94a3b8"]) {
    for (const stop of providerFill(brand).colors) {
      expect(chroma(stop), `${brand} neonised to ${stop}`).toBeLessThan(70);
    }
  }
});

test("a colourless brand stays neutral instead of inventing a hue", () => {
  const [from] = providerFill("#8b8b8b").colors;
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(from.slice(at, at + 2), 16));
  expect(r).toBe(g!);
  expect(g).toBe(b!);
});

test("the two stops differ enough to render as a gradient", () => {
  // Channel distance rather than hue: a near-neutral is exempt from the sweep,
  // so this is the check that still holds for *every* pill — grey ones included
  // — and it catches a fill that would draw as a flat block.
  for (const { id, color } of shippedColors()) {
    const [from, to] = providerFill(color).colors;
    const spread = Math.max(
      ...[1, 3, 5].map((at) =>
        Math.abs(
          Number.parseInt(from.slice(at, at + 2), 16) - Number.parseInt(to.slice(at, at + 2), 16),
        ),
      ),
    );
    expect(spread, `${id} (${color}) ${from} -> ${to} is flat`).toBeGreaterThan(24);
  }
});

test("the gradient runs bright to deep in lightness", () => {
  // HSL lightness, not luminance. Luminance was tried and it is the wrong
  // measure here: hues differ hugely in intrinsic brightness, so a violet that
  // has correctly stepped *down* in lightness still reads as brighter than the
  // blue it started from. Holding it to luminance forced the sweep toward
  // whichever hue was darkest, which walked Claude's terracotta into magenta.
  const lightness = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  };
  for (const { id, color } of shippedColors()) {
    const [from, to] = providerFill(color).colors;
    expect(
      lightness(from),
      `${id} (${color}) runs dark to light: ${from} -> ${to}`,
    ).toBeGreaterThan(lightness(to));
  }
});

test("a warm brand stays warm and a cool brand stays cool", () => {
  // The sweep must deepen a colour within its own family. Both failure modes
  // are recorded here: sweeping warm hues forward turned terracotta to mustard,
  // and picking the direction by darkness turned it magenta.
  const warmer = (hex: string) => {
    const [r, , b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
      number,
      number,
      number,
    ];
    return r > b;
  };
  for (const brand of ["#d97757", "#c2410c"]) {
    for (const stop of providerFill(brand).colors) {
      expect(warmer(stop), `${brand} went cool at ${stop}`).toBe(true);
    }
  }
  for (const brand of ["#4ade80", "#4285f4"]) {
    for (const stop of providerFill(brand).colors) {
      expect(warmer(stop), `${brand} went warm at ${stop}`).toBe(false);
    }
  }
});

test("shorthand and unprefixed hex are read the same as full notation", () => {
  expect(providerFill("#4285f4")).toEqual(providerFill("4285f4"));
  expect(providerFill("#ffffff")).toEqual(providerFill("#fff"));
});
