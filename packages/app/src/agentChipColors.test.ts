import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentChipColors } from "./agentChipColors";
import { contrastRatio } from "./ui/providerGradient";
const source = readFileSync(join(import.meta.dir, "theme.ts"), "utf8");
function token(name: string): string {
  const match = source.match(new RegExp(`\\b${name}:\\s*"(#[0-9a-fA-F]{6})"`));
  if (!match) throw new Error(`Missing theme color ${name}`);
  return match[1]!;
}
const palette = { surface: token("surface"), surfaceRaised: token("surfaceRaised"), surfacePressed: token("surfacePressed"), text: token("text"), textDim: token("textDim"), orb: token("orb") };
test("actual normal, selected and disabled chip surfaces pair readable labels and markers", () => {
  for (const color of [undefined, "#000", "#fff", "#d97757", "#4285f4", "#00ff00", "invalid"]) {
    for (const selected of [false, true]) for (const enabled of [false, true]) {
      const style = agentChipColors(color, selected, enabled, palette);
      expect(contrastRatio(style.text, style.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(style.marker, style.background)).toBeGreaterThanOrEqual(3);
    }
  }
});
test("selection changes the neutral fill; disabled does not dim a whole control", () => {
  expect(agentChipColors("#d97757", false, true, palette).background).not.toBe(agentChipColors("#d97757", true, true, palette).background);
  expect(agentChipColors("#d97757", false, false, palette).text).toBe(palette.textDim);
});
