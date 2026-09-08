import type { DelegationSchedule } from "./delegation.schemas";

/** Scan UTC instants so DST gaps skip safely and repeated wall-clock minutes run once. */
export function nextDelegationRun(
  schedule: DelegationSchedule,
  after: Date,
): Date | null {
  if (schedule.frequency === "once")
    return schedule.at
      ? new Date(Math.max(Date.parse(schedule.at), after.getTime()))
      : new Date(after);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const parts = (d: Date) =>
    Object.fromEntries(format.formatToParts(d).map((p) => [p.type, p.value]));
  const prior = parts(after);
  for (
    let ms = Math.floor(after.getTime() / 60000) * 60000 + 60000,
      end = ms + 9 * 86400000;
    ms < end;
    ms += 60000
  ) {
    const d = new Date(ms);
    const p = parts(d);
    if (
      `${p.hour}:${p.minute}` !== schedule.time ||
      (schedule.frequency === "weekly" && p.weekday !== days[schedule.weekday])
    )
      continue;
    // Suppress the second copy of a repeated time on the same local date.
    if (
      `${prior.hour}:${prior.minute}` === schedule.time &&
      p.year === prior.year &&
      p.month === prior.month &&
      p.day === prior.day
    )
      continue;
    return d;
  }
  return null;
}
