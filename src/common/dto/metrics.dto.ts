export type ActiveUsersMetricsDto = {
  /** Average daily active users over the last `dauWindowDays` days (rounded to an integer). */
  dau: number;
  /** Rolling monthly active users over the last `mauWindowDays` days. */
  mau: number;
  dauWindowDays: number;
  mauWindowDays: number;
  /** ISO timestamp of when the metric was computed. */
  asOf: string;
};

