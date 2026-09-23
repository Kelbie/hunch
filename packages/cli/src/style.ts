import { painter, type Painter } from "../../core/src/index.js";

/**
 * Whether this stream gets colour, and how wide it is. One answer for the whole CLI: a report,
 * the live region above it and a status line on stderr must not disagree, and `FORCE_COLOR` has
 * to reach all of them at once — that is how the documentation images are captured.
 */
export const colorFor = (stream: { isTTY?: boolean }) =>
  process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export const widthOf = (stream: { columns?: number }) => Math.min(stream.columns || 100, 120);

export interface Style { color: boolean; width: number }

export const styleFor = (stream: { isTTY?: boolean; columns?: number }): Style => ({ color: colorFor(stream), width: widthOf(stream) });

/** The painter for a stream's own colour setting, for the many one-line messages on stderr. */
export const paintFor = (stream: { isTTY?: boolean }): Painter => painter(colorFor(stream));
