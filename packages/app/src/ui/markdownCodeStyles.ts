/** Keeps fenced code inside the message rail rather than creating horizontal scroll. */
export const fencedCodeContainerStyle = {
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  overflow: "hidden",
} as const;

/** Overrides the dependency's white default and wraps long code inside the rail. */
export const fencedCodeTextStyle = {
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  flexShrink: 1,
  backgroundColor: "transparent",
} as const;
