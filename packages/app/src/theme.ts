/**
 * Dark-first tokens. Agent output is read for long stretches, often at night,
 * so the surface stays dark and text contrast is kept high.
 */
export const theme = {
  color: {
    bg: "#0b0d10",
    surface: "#14171c",
    surfaceRaised: "#1b1f26",
    border: "#252a33",
    text: "#e8eaed",
    textDim: "#9aa3af",
    textFaint: "#6b7280",
    accent: "#d97757",
    success: "#3fb950",
    danger: "#f85149",
    thought: "#8b5cf6",
  },
  space: (n: number) => n * 4,
  radius: { sm: 6, md: 10, lg: 14 },
  font: {
    body: 15,
    small: 13,
    tiny: 11,
    title: 17,
    mono: "Menlo",
  },
} as const;
