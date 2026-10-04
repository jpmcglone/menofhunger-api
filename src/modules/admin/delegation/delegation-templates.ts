export const delegationTemplates = [
  {
    id: "founder",
    title: "Morning founder brief",
    workflow: "operations",
    instruction:
      "Check attention, activation, operational health and integration spending. Compare with the saved baseline and recent runs. Tell me what changed, what is stuck, and the three most useful actions I can take, with evidence links. Prepare a concise report. Do not change member accounts or send messages.",
    schedule: {
      frequency: "daily" as const,
      time: "08:00",
      timeZone: "America/New_York",
      weekday: 1,
      weekdays: [1, 2, 3, 4, 5],
      notification: "digest" as const,
    },
  },
  {
    id: "members",
    title: "Member follow-through",
    workflow: "community",
    instruction:
      "Find public first contributions without a human reply. Investigate beyond the preview when needed. Prepare at most three thoughtful public replies for review. Exclude subjects already handled by earlier runs. Report the sample coverage. Never send private messages.",
    schedule: {
      frequency: "daily" as const,
      time: "09:00",
      timeZone: "America/New_York",
      weekday: 1,
      notification: "actionable" as const,
    },
  },
  {
    id: "weekly",
    title: "Weekly operating review",
    workflow: "operations",
    instruction:
      "Compare activation, returning contributors, pending support and integration spending with the baseline and last week. Report sample sizes and dates, recommend one measurable intervention, and track it next week. Do not claim causality from observational changes. Prepare a report with evidence links.",
    schedule: {
      frequency: "weekly" as const,
      time: "08:00",
      timeZone: "America/New_York",
      weekday: 1,
      notification: "digest" as const,
    },
  },
];
