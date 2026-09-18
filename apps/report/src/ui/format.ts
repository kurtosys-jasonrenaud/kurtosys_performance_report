/** Formatting helpers. Presentation only — no value is computed here. */

export function bytes(value: number): string {
  if (value < 1024) return value + " B";
  const kb = value / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB";
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(2) + " MB";
  return (mb / 1024).toFixed(2) + " GB";
}

export function ms(value: number): string {
  if (value < 1000) return Math.round(value) + " ms";
  const seconds = value / 1000;
  if (seconds < 60) return seconds.toFixed(1) + " s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + (seconds - minutes * 60).toFixed(0) + "s";
}

export function count(value: number): string {
  return value.toLocaleString("en-GB");
}

/** An em dash, used wherever a value is genuinely unknown rather than zero. */
export const UNKNOWN = "—";

export function optionalMs(value: number | null): string {
  return value === null ? UNKNOWN : ms(value);
}

export function statusSummary(distribution: Record<string, number>): string {
  return Object.entries(distribution)
    .map(([status, calls]) => (status === "0" ? "no response" : status) + " × " + calls)
    .join(", ");
}
