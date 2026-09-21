/** Render a small list of names as natural English: "A", "A and B", "A, B, and C". */
export function formatNameList(names: string[]): string {
  const list = names.filter((n) => n && n.trim().length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  const head = list.slice(0, -1).join(', ');
  return `${head}, and ${list[list.length - 1]}`;
}

export type CrewStreakBrokenMember = {
  id: string;
  displayName: string | null;
  username: string | null;
};

/**
 * Lock-screen copy for a crew streak break. Names are paired to member ids before
 * filtering, so a missed member with no display name cannot steal someone else's slot.
 */
export function crewStreakBrokenPushBody(params: {
  crewLabel: string;
  recipientUserId: string;
  missedMembers: CrewStreakBrokenMember[];
}): string {
  const crewLabel = (params.crewLabel ?? '').trim() || 'Your crew';
  const named = params.missedMembers
    .map((m) => ({
      id: m.id,
      name: (m.displayName ?? m.username ?? '').trim(),
    }))
    .filter((m) => m.name.length > 0);
  const others = named.filter((m) => m.id !== params.recipientUserId).map((m) => m.name);
  const recipientMissed = params.missedMembers.some((m) => m.id === params.recipientUserId);

  if (recipientMissed && others.length === 0) {
    return `${crewLabel} broke the streak yesterday. You didn't check in.`;
  }
  if (recipientMissed && others.length > 0) {
    return `${crewLabel} broke the streak yesterday. You and ${formatNameList(others)} didn't check in.`;
  }
  if (others.length === 0) {
    return `${crewLabel} broke the streak yesterday.`;
  }
  if (others.length === 1) {
    return `${others[0]} didn't check in yesterday. ${crewLabel} lost the streak.`;
  }
  return `${formatNameList(others)} didn't check in yesterday. ${crewLabel} lost the streak.`;
}
