export interface PickerInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface PickerLayoutInput {
  viewportWidth: number;
  viewportHeight: number;
  anchorX?: number;
  menuTop: number;
  insets: PickerInsets;
  margin: number;
  preferredWidth: number;
  maximumHeight: number;
}

export interface PickerLayout {
  left: number;
  width: number;
  maxHeight: number;
  origin: "top left" | "top right";
}

/** Keep an anchored menu wholly inside the safe viewport on every screen shape. */
export function fitPickerToViewport({
  viewportWidth,
  viewportHeight,
  anchorX,
  menuTop,
  insets,
  margin,
  preferredWidth,
  maximumHeight,
}: PickerLayoutInput): PickerLayout {
  const minimumLeft = insets.left + margin;
  const availableWidth = Math.max(
    0,
    viewportWidth - insets.left - insets.right - margin * 2,
  );
  const width = Math.min(preferredWidth, availableWidth);
  const maximumLeft = Math.max(
    minimumLeft,
    viewportWidth - insets.right - margin - width,
  );
  const desiredLeft =
    typeof anchorX === "number" && Number.isFinite(anchorX) ? anchorX : minimumLeft;
  const left = Math.min(Math.max(desiredLeft, minimumLeft), maximumLeft);
  const maxHeight = Math.max(
    0,
    Math.min(maximumHeight, viewportHeight - menuTop - insets.bottom - margin),
  );

  return {
    left,
    width,
    maxHeight,
    origin: desiredLeft > maximumLeft ? "top right" : "top left",
  };
}
