import { describe, expect, it } from "bun:test";
import {
  gridForSize,
  MATRIX_MIN_SIZE,
  orbLoop,
  orbMatrix,
  sweepAt,
} from "./orbMatrix";

describe("gridForSize", () => {
  it("keeps the grid odd so the silhouette stays symmetric", () => {
    for (let size = MATRIX_MIN_SIZE; size <= 96; size += 1) {
      expect(gridForSize(size) % 2).toBe(1);
    }
  });

  it("grows with the mark so a logo is not as coarse as a chip", () => {
    expect(gridForSize(72)).toBeGreaterThan(gridForSize(32));
  });

  it("clamps both ends, so no size explodes the dot count", () => {
    expect(gridForSize(4)).toBe(5);
    expect(gridForSize(400)).toBe(13);
  });
});

describe("orbMatrix", () => {
  it("clips every dot to the sphere", () => {
    const grid = 11;
    for (const dot of orbMatrix(grid)) {
      const x = (dot.cx / grid) * 2 - 1;
      const y = (dot.cy / grid) * 2 - 1;
      expect(x * x + y * y).toBeLessThanOrEqual(1);
    }
  });

  it("drops the corners and keeps the centre", () => {
    const grid = 11;
    const dots = orbMatrix(grid);
    expect(dots.some((d) => d.column === 0 && d.row === 0)).toBe(false);
    expect(dots.some((d) => d.column === 5 && d.row === 5)).toBe(true);
  });

  it("lights the upper left brighter than the lower right", () => {
    const dots = orbMatrix(11);
    const lit = dots.find((d) => d.column === 3 && d.row === 3)!;
    const shadowed = dots.find((d) => d.column === 7 && d.row === 7)!;
    expect(lit.opacity).toBeGreaterThan(shadowed.opacity);
    expect(lit.fill).toBeGreaterThan(shadowed.fill);
  });

  it("keeps every dot renderable, so the far limb still reads", () => {
    for (const dot of orbMatrix(13)) {
      expect(dot.fill).toBeGreaterThan(0);
      expect(dot.opacity).toBeGreaterThan(0);
      expect(dot.fill).toBeLessThanOrEqual(1);
      expect(dot.opacity).toBeLessThanOrEqual(1);
    }
  });

  it("puts the specular hotspot on the lit side only", () => {
    const dots = orbMatrix(11);
    const brightest = dots.reduce((a, b) => (b.specular > a.specular ? b : a));
    expect(brightest.column).toBeLessThan(5);
    expect(brightest.row).toBeLessThan(5);
    const farLimb = dots.find((d) => d.column === 8 && d.row === 8)!;
    expect(farLimb.specular).toBeLessThan(0.01);
  });

  it("is deterministic, so one layout serves every provider colour", () => {
    expect(orbMatrix(9)).toEqual(orbMatrix(9));
  });
});

describe("orbLoop", () => {
  it("closes the loop, so the light never jumps on restart", () => {
    for (const track of orbLoop(9, 16)) {
      expect(track.fill.at(-1)).toBe(track.fill[0]!);
      expect(track.opacity.at(-1)).toBe(track.opacity[0]!);
      expect(track.specular.at(-1)).toBe(track.specular[0]!);
    }
  });

  it("gives every step to every dot, as an interpolation needs", () => {
    const steps = 16;
    for (const track of orbLoop(9, steps)) {
      expect(track.fill).toHaveLength(steps + 1);
      expect(track.opacity).toHaveLength(steps + 1);
      expect(track.specular).toHaveLength(steps + 1);
    }
  });

  it("holds one dot per cell, aligned with a single frame", () => {
    expect(orbLoop(9, 8)).toHaveLength(orbMatrix(9).length);
  });

  it("moves the light: a dot does not hold one value all loop", () => {
    const varying = orbLoop(11, 16).filter(
      (track) => Math.max(...track.opacity) - Math.min(...track.opacity) > 0.1,
    );
    expect(varying.length).toBeGreaterThan(0);
  });

  it("keeps every step renderable, so no frame of the orbit breaks", () => {
    for (const track of orbLoop(11, 16)) {
      for (let step = 0; step < track.fill.length; step += 1) {
        expect(track.fill[step]!).toBeGreaterThan(0);
        expect(track.fill[step]!).toBeLessThanOrEqual(1);
        expect(track.opacity[step]!).toBeGreaterThan(0);
        expect(track.opacity[step]!).toBeLessThanOrEqual(1);
      }
    }
  });

  it("travels with the light, and closes that loop too", () => {
    for (const track of orbLoop(11, 16)) {
      expect(track.dx.at(-1)).toBe(track.dx[0]!);
      expect(track.dy.at(-1)).toBe(track.dy[0]!);
    }
  });

  it("swings the limb and holds the centre still", () => {
    const tracks = orbLoop(11, 16);
    const travel = (t: (typeof tracks)[number]) =>
      Math.max(...t.dx) - Math.min(...t.dx);
    const centre = tracks.find((t) => t.cx === 5.5 && t.cy === 5.5)!;
    const limb = tracks.find((t) => t.cx === 0.5 && t.cy === 5.5)!;

    // The centre faces the viewer: it must be visibly pinned, not merely
    // smaller than the limb, or the whole mark would slide as one.
    expect(travel(centre)).toBeLessThan(0.05);
    // And the limb has to move enough to be seen at all: a third of a cell of
    // travel across the orbit, which at 56pt is a little over a point.
    expect(travel(limb)).toBeGreaterThan(0.33);
  });

  it("keeps every dot inside its own cell, so the grid still reads", () => {
    for (const track of orbLoop(13, 32)) {
      for (let step = 0; step < track.dx.length; step += 1) {
        expect(Math.hypot(track.dx[step]!, track.dy[step]!)).toBeLessThan(0.5);
      }
    }
  });

  it("reports the peak so a dot the highlight never reaches can skip it", () => {
    const tracks = orbLoop(11, 16);
    for (const track of tracks) {
      expect(track.peakSpecular).toBe(Math.max(...track.specular));
    }
    // The light keeps its elevation, so the hotspot travels a ring around the
    // centre rather than through it: the dots it lands on reach nearly full.
    expect(Math.max(...tracks.map((t) => t.peakSpecular))).toBeGreaterThan(0.9);
    // And that ring is off-centre, which is what makes the drift visible.
    const brightest = tracks.reduce((a, b) =>
      b.peakSpecular > a.peakSpecular ? b : a,
    );
    expect(Math.hypot(brightest.cx - 5.5, brightest.cy - 5.5)).toBeGreaterThan(1);
  });
});

describe("sweepAt", () => {
  it("lights nothing outside the band", () => {
    expect(sweepAt(0, 10, 11)).toBe(0);
  });

  it("peaks where the band head sits", () => {
    const grid = 11;
    // head = progress * grid * 2, so 0.25 puts it on column 5.5.
    const onHead = sweepAt(0.25, 5, grid);
    const beside = sweepAt(0.25, 8, grid);
    expect(onHead).toBeGreaterThan(beside);
  });

  it("stays within unit range across the whole loop", () => {
    for (let step = 0; step <= 100; step += 1) {
      for (let column = 0; column < 11; column += 1) {
        const value = sweepAt(step / 100, column, 11);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("leaves the panel dark at the loop seam, so it never jumps", () => {
    for (let column = 0; column < 11; column += 1) {
      expect(sweepAt(1, column, 11)).toBe(0);
    }
  });
});
