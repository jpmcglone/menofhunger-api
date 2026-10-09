import type { Prisma } from '@prisma/client';

/** Value written to a Prisma `Json` column. Callers pass DTOs/records that are already JSON-safe. */
export function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Typed read of a Prisma `Json` column whose shape this module wrote. */
export function fromJsonValue<T>(value: Prisma.JsonValue | null | undefined): T {
  return value as T;
}
