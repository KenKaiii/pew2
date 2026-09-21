import { contrastRatio } from "./ui/providerGradient";

interface Palette {
  surface: string; surfaceRaised: string; surfacePressed: string;
  text: string; textDim: string; orb: string;
}
/** Paired opaque fill/ink; never dim the entire label-bearing control. */
export function agentChipColors(color: string | undefined, selected: boolean, enabled: boolean, palette: Palette) {
  const background = !enabled ? palette.surface : selected ? palette.surfacePressed : palette.surfaceRaised;
  const text = enabled ? palette.text : palette.textDim;
  const brand = color && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color) ? color : palette.orb;
  const marker = enabled && contrastRatio(brand, background) >= 3 ? brand : palette.textDim;
  return { background, text, marker };
}
