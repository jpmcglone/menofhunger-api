import { crewStreakBrokenPushBody, formatNameList } from './crew-streak-broken-copy';

describe('formatNameList', () => {
  it('joins two and three names in English', () => {
    expect(formatNameList(['Ada'])).toBe('Ada');
    expect(formatNameList(['Ada', 'Bob'])).toBe('Ada and Bob');
    expect(formatNameList(['Ada', 'Bob', 'Cal'])).toBe('Ada, Bob, and Cal');
  });
});

describe('crewStreakBrokenPushBody', () => {
  const unnamed = { id: 'u0', displayName: null, username: null };
  const ada = { id: 'u1', displayName: 'Ada', username: 'ada' };
  const bob = { id: 'u2', displayName: 'Bob', username: 'bob' };

  it('does not attach the next name to a nameless missed member', () => {
    const missedMembers = [unnamed, ada];
    expect(
      crewStreakBrokenPushBody({ crewLabel: 'The Lodge', recipientUserId: 'u3', missedMembers }),
    ).toBe("Ada didn't check in yesterday. The Lodge lost the streak.");
    expect(
      crewStreakBrokenPushBody({ crewLabel: 'The Lodge', recipientUserId: 'u1', missedMembers }),
    ).toBe("The Lodge broke the streak yesterday. You didn't check in.");
  });

  it('names the recipient plus others who missed', () => {
    expect(
      crewStreakBrokenPushBody({
        crewLabel: 'The Lodge',
        recipientUserId: 'u1',
        missedMembers: [ada, bob],
      }),
    ).toBe("The Lodge broke the streak yesterday. You and Bob didn't check in.");
  });
});
