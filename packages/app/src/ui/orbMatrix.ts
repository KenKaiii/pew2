/**
 * Geometry for the agent mark: a sphere rendered as a dot-matrix display.
 *
 * The app sets every title in Bitcount Prop Single, a single-module dot-matrix
 * face — the wordmark is literally an LED grid. So the mark beside it is drawn
 * the same way: a lit grid that resolves into a sphere, rather than a gradient
 * disc that shares nothing with the type.
 *
 * Tone comes from dot *area* and opacity, which is how a real matrix panel
 * renders a shade: it cannot draw a gradient, only decide how much of each cell
 * to light. That constraint is the entire look.
 *
 * React-Native-free so it can be unit tested; `Orb.tsx` binds it to views.
 */

/** Direction the key light arrives from, in screen space (y grows downward). */
const LIGHT: Vector = normalise({ x: -0.38, y: -0.5, z: 0.78 });

/**
 * The key light rotated about the viewing axis.
 *
 * Elevation is untouched, so the sphere stays lit from the front and only the
 * *direction* travels: the terminator drifts around the ball instead of the
 * whole mark changing brightness. This is the mark's idle motion — a lit object
 * being looked at, not a widget throbbing for attention.
 */
function lightAt(phase: number): { key: Vector; half: Vector } {
  const cos = Math.cos(phase);
  const sin = Math.sin(phase);
  const key = {
    x: LIGHT.x * cos - LIGHT.y * sin,
    y: LIGHT.x * sin + LIGHT.y * cos,
    z: LIGHT.z,
  };
  // Viewer sits straight on, so the specular half-vector leans toward them.
  return { key, half: normalise({ x: key.x, y: key.y, z: key.z + 1 }) };
}

/**
 * Floor brightness on the unlit side. High enough that the far limb still holds
 * the outline: switching those cells off entirely leaves a crescent, and the
 * mark stops reading as a ball at all.
 */
const AMBIENT = 0.3;

/**
 * Cool light wrapping the shaded edge, as a fraction of the key.
 *
 * This is what separates the mark from a near-black canvas. Without it the
 * unlit limb and the background are the same value and the sphere has no back.
 */
const RIM = 0.55;

/** Tightness of the specular hotspot. Higher is glossier. */
const SHININESS = 12;

/** How much of the cell the dimmest dot fills, as a fraction of the brightest. */
const MIN_FILL = 0.34;

/**
 * How far a cell drifts with the light, in fractions of the cell pitch.
 *
 * The dots are the sphere's surface, so they should travel when it is lit from
 * a new side — shading alone is a slow value change, which reads as almost
 * nothing at small sizes. Kept well under half a pitch: the grid must still
 * scan as a grid, never as dots wandering out of formation.
 */
const PARALLAX = 0.42;

interface Vector {
  x: number;
  y: number;
  z: number;
}

export interface MatrixDot {
  /** Grid column, left to right. */
  column: number;
  /** Grid row, top to bottom. */
  row: number;
  /** Centre offset from the mark's top-left corner, in units of cell pitch. */
  cx: number;
  cy: number;
  /** Drift from that centre with the light, in units of cell pitch. */
  dx: number;
  dy: number;
  /** Diameter as a fraction of the cell pitch, in [0, 1]. */
  fill: number;
  /** Opacity in [0, 1]. */
  opacity: number;
  /** Share of white mixed into the base colour for the specular hit, [0, 1]. */
  specular: number;
}

function normalise(v: Vector): Vector {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * Cells across the mark.
 *
 * Odd, so one column and one row land on the centre line and the silhouette
 * stays symmetric. Denser as the mark grows, because a fixed count would give a
 * 72pt logo the same coarse resolution as an 18pt chip.
 */
export function gridForSize(size: number): number {
  const cells = Math.round(size / 5);
  const clamped = Math.min(13, Math.max(5, cells));
  return clamped % 2 === 0 ? clamped + 1 : clamped;
}

/**
 * Below this the cells are smaller than a rendered pixel cluster and the matrix
 * reads as mud, so the mark falls back to the silhouette it describes: the same
 * circle, lit from the same corner, without the grid.
 */
export const MATRIX_MIN_SIZE = 28;

/**
 * Lays out the grid of dots clipped to the sphere, each carrying its own shade.
 *
 * Deterministic and dependency-free: same grid and phase in, same dots out, so
 * a whole loop can be precomputed once and handed to the native driver.
 *
 * Cell membership does not depend on the phase, only shading does — so the same
 * index refers to the same dot in every phase, and a caller can read one dot's
 * value across the loop by index.
 *
 * @param phase Light rotation in radians about the viewing axis.
 */
export function orbMatrix(grid: number, phase = 0): MatrixDot[] {
  const dots: MatrixDot[] = [];
  const { key: LIGHT_AT, half: HALF } = lightAt(phase);

  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) {
      // Cell centre in [-1, 1], so the grid spans the unit sphere exactly.
      const x = ((column + 0.5) / grid) * 2 - 1;
      const y = ((row + 0.5) / grid) * 2 - 1;
      const radius = x * x + y * y;

      // Outside the silhouette. A partially covered edge cell is dropped rather
      // than dimmed: a matrix panel lights whole cells or none.
      if (radius > 1) continue;

      // On a unit sphere the surface normal *is* the position.
      const z = Math.sqrt(1 - radius);
      const lambert = Math.max(
        0,
        x * LIGHT_AT.x + y * LIGHT_AT.y + z * LIGHT_AT.z,
      );
      const intensity = AMBIENT + (1 - AMBIENT) * lambert;

      const highlight = Math.max(0, x * HALF.x + y * HALF.y + z * HALF.z);
      const specular = Math.pow(highlight, SHININESS);

      // Grazing cells only, and only where the key light is not already on
      // them, so the rim traces the shaded edge instead of ringing the whole
      // circle and flattening it back into a disc.
      const grazing = Math.pow(1 - z, 2.5);
      const rim = RIM * grazing * (1 - lambert);
      const shaded = Math.min(1, intensity + rim);

      // Parallax of a turning ball: the surface slides across the silhouette,
      // so a cell shifts along the light's own direction and does it hardest
      // where the sphere curves away. Dead centre faces the viewer and barely
      // moves; the limb swings. That gradient across the grid is what the eye
      // actually reads as rotation.
      const swing = PARALLAX * radius;

      dots.push({
        column,
        row,
        cx: column + 0.5,
        cy: row + 0.5,
        dx: -LIGHT_AT.x * swing,
        dy: -LIGHT_AT.y * swing,
        fill: MIN_FILL + (1 - MIN_FILL) * shaded,
        opacity: shaded,
        specular,
      });
    }
  }

  return dots;
}

/** One dot's shading and travel across a full rotation of the light. */
export interface DotTrack {
  cx: number;
  cy: number;
  column: number;
  /** Drift per step, in units of cell pitch. */
  dx: number[];
  dy: number[];
  /** Diameter fraction per step. */
  fill: number[];
  /** Opacity per step. */
  opacity: number[];
  /** Specular share per step. */
  specular: number[];
  /** Brightest specular the dot ever reaches, so a flat dot can skip its gloss. */
  peakSpecular: number;
}

/**
 * Samples a whole rotation, transposed so each dot owns its own timeline.
 *
 * This is the shape an animation driver wants: one value per dot per step, so
 * the loop can be handed to the native side once and run without JS. Computing
 * it per frame instead would put a full relighting of the sphere on the
 * JavaScript thread, which is exactly what a streaming transcript cannot spare.
 *
 * The first step is repeated as the last so the loop closes on itself and the
 * light never jumps when it restarts.
 */
export function orbLoop(grid: number, steps: number): DotTrack[] {
  const frames = Array.from({ length: steps }, (_, step) =>
    orbMatrix(grid, (step / steps) * Math.PI * 2),
  );

  return frames[0]!.map((dot, index) => {
    const track = (read: (frame: MatrixDot) => number) => {
      const values = frames.map((frame) => read(frame[index]!));
      // Close the loop on itself so the light never jumps when it restarts.
      values.push(values[0]!);
      return values;
    };

    const specular = track((d) => d.specular);

    return {
      cx: dot.cx,
      cy: dot.cy,
      column: dot.column,
      dx: track((d) => d.dx),
      dy: track((d) => d.dy),
      fill: track((d) => d.fill),
      opacity: track((d) => d.opacity),
      specular,
      peakSpecular: Math.max(...specular),
    };
  });
}

/**
 * Brightness added to a column by the working sweep.
 *
 * A band of light crossing the panel column by column, the way a display
 * refreshes — the mark is a readout of a machine you are not sitting at, so it
 * reports work as a scan rather than by throbbing.
 *
 * @param progress Loop position in [0, 1].
 * @param column Grid column being lit.
 * @param grid Total columns.
 */
export function sweepAt(progress: number, column: number, grid: number): number {
  // Travels one full width beyond the panel so the band leaves cleanly before
  // it re-enters, instead of jumping from the right edge back to the left.
  const head = progress * (grid * 2);
  const distance = Math.abs(head - column);
  const width = grid / 3;
  if (distance > width) return 0;
  // Cosine falloff: the band has no edges, which a linear ramp would show as a
  // visible seam sliding across the grid.
  return (Math.cos((distance / width) * Math.PI) + 1) / 2;
}
