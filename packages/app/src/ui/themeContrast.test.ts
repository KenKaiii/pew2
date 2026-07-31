import { expect, test } from "bun:test";
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

test("the reject boundary and fallback glass rims remain distinguishable", () => {
  // #3c3c40 is a conservative bright sample of the adaptive dark glass panel.
  expect(contrast(approvalActionColors.rejectRim, "#3c3c40")).toBeGreaterThanOrEqual(3);
  for (const tier of [fallbackGlassTokens.control, fallbackGlassTokens.raised]) {
    const compositedRim = whiteOver(canvas, alpha(tier.rim));
    expect(contrast(compositedRim, canvas)).toBeGreaterThanOrEqual(3);
  }
});
