import { validateUsername } from './users.utils';

describe('reserved usernames', () => {
  it.each(['everyone', 'Everyone', 'here', 'HERE', 'channel', 'all'])('refuses the mention keyword %s for everyone, administrators included', name => {
    expect(validateUsername(name, { minLen: 2 }).ok).toBe(false);
    expect(validateUsername(name, { minLen: 2, allowReserved: true }).ok).toBe(false);
  });
  it('refuses company-looking names for members but lets administrators assign them', () => {
    expect(validateUsername('moderator').ok).toBe(false);
    expect(validateUsername('moderator', { allowReserved: true }).ok).toBe(true);
  });
  it('accepts ordinary names', () => expect(validateUsername('hereford_joe').ok).toBe(true));
});
