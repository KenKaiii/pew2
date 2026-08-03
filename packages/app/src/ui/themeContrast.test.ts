import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalActionColors, fallbackGlassTokens } from "../materialTokens";

const canvas = "#111111";

function rgb(hex: string): [number, number, number] {
  const value = hex.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(left: string, right: string): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright! + 0.05) / (dark! + 0.05);
}

function whiteOver(background: string, alpha: number): string {
  const channels = rgb(background).map((channel) =>
    Math.round(255 * alpha + channel * (1 - alpha)),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function alpha(color: string): number {
  const match = color.match(/rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)/);
  if (!match) throw new Error(`Expected rgba color, got ${color}`);
  return Number(match[1]);
}

test("approval button labels meet WCAG AA contrast", () => {
  expect(contrast(approvalActionColors.allowText, approvalActionColors.allowFill)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(approvalActionColors.rejectText, approvalActionColors.rejectFill)).toBeGreaterThanOrEqual(4.5);
});

test("the connected-apps count is legible on its badge", () => {
  // Read out of theme.ts as text rather than imported: that module pulls in
  // react-native, which does not load under this runner. Parsing the source
  // keeps the check honest — hardcoded copies would go on passing against
  // values the app no longer uses, which is worse than having no test.
  const source = readFileSync(join(import.meta.dir, "..", "theme.ts"), "utf8");
  const token = (name: string) => {
    const match = source.match(new RegExp(`\\b${name}:\\s*"(#[0-9a-fA-F]{6})"`));
    if (!match) throw new Error(`theme.ts no longer defines a hex '${name}'`);
    return match[1]!;
  };

  const textDim = token("textDim");
  const surfaceRaised = token("surfaceRaised");
  const drawer = token("drawer");

  // Small dim text is the easy thing to get wrong: it reads fine on a desk
  // monitor and vanishes on a phone outdoors. At 11px it is not large text, so
  // full AA applies rather than the 3:1 allowed for headings.
  //
  // Checked against the drawer as well as the badge, because the badge fill is
  // only ~1.1:1 against the drawer — a deliberately quiet container rather than
  // a semantic surface. The number therefore has to stand on its own wherever it
  // happens to be read, and asserting the fill were prominent would encode an
  // intent the design does not have.
  expect(contrast(textDim, surfaceRaised)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(textDim, drawer)).toBeGreaterThanOrEqual(4.5);
});

test("the reject boundary and fallback glass rims remain distinguishable", () => {
  // #3c3c40 is a conservative bright sample of the adaptive dark glass panel.
  expect(contrast(approvalActionColors.rejectRim, "#3c3c40")).toBeGreaterThanOrEqual(3);
  for (const tier of [fallbackGlassTokens.control, fallbackGlassTokens.raised]) {
    const compositedRim = whiteOver(canvas, alpha(tier.rim));
    expect(contrast(compositedRim, canvas)).toBeGreaterThanOrEqual(3);
  }
});
