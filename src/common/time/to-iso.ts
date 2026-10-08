/** ISO string for a Date, or null for null/undefined/non-Date input. */
export function toIsoOrNull(d: Date | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : null;
}
