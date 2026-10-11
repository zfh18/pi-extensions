/** Fullscreen prompt navigation needs OSC 133 at byte 0; Pi strips these prefixes before painting. */

export const OSC133_ZONE_START = "\x1b]133;A\x07";
export const OSC133_ZONE_END = "\x1b]133;B\x07";
export const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Leading run of zone sequences, mirroring pi-tui's paint-time prefix strip. */
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

/** True when the first row carries a prompt-start marker (BEL or ST terminated). */
export function hasPromptZoneStart(lines: readonly string[]): boolean {
  return lines.length > 0 && OSC133_PROMPT_START.test(lines[0] ?? "");
}

/**
 * Remove a leading zone-sequence run from the first and last row.
 * Returns a new array; the input is never mutated.
 */
export function stripPromptZone(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const stripped = [...lines];
  const last = stripped.length - 1;
  stripped[0] = (stripped[0] ?? "").replace(OSC133_ZONE_PREFIX, "");
  stripped[last] = (stripped[last] ?? "").replace(OSC133_ZONE_PREFIX, "");
  return stripped;
}

/**
 * Prefix pi core's zone markers: `A` on the first row, `B` + `C` on the last.
 * Returns a new array; the input is never mutated. An empty array stays empty,
 * and a single-row array still starts with the `A` marker (`A` is applied last).
 */
export function markPromptZone(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const marked = [...lines];
  const last = marked.length - 1;
  marked[last] = OSC133_ZONE_END + OSC133_ZONE_FINAL + (marked[last] ?? "");
  marked[0] = OSC133_ZONE_START + (marked[0] ?? "");
  return marked;
}
