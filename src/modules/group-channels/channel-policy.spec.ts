import { channelCapabilities, assertChannelSend, assertChannelUpdate, normalizeChannelIcon, normalizeChannelName, normalizeChannelDisplayName, slugifyChannelName } from './channel-policy';

describe('channel permissions', () => {
  const discussion = { archivedAt: null, defaultPurpose: null, privacy: 'normal', name: 'general' };
  it('lets members react to announcements but only leaders post or reply', () => {
    const announcements = { ...discussion, defaultPurpose: 'announcements' };
    expect(channelCapabilities(announcements, 'member')).toMatchObject({ canSend: false, canReact: true });
    expect(() => assertChannelSend(announcements, 'member')).toThrow();
    expect(() => assertChannelSend(announcements, 'moderator')).not.toThrow();
  });
  it('makes archived conversation mutations unavailable', () => {
    expect(channelCapabilities({ ...discussion, privacy: 'private', archivedAt: new Date() }, 'owner')).toMatchObject({ canSend: false, canReact: false, canInvite: false, canModerate: false, canManage: true });
  });
  it('protects defaults but permits topic edits and custom channel lifecycle', () => {
    const channel = { ...discussion, defaultPurpose: 'general' };
    expect(() => assertChannelUpdate(channel, { name: 'different' })).toThrow();
    expect(() => assertChannelUpdate(channel, { archived: true })).toThrow();
    expect(() => assertChannelUpdate(channel, { name: 'general' })).not.toThrow();
    expect(() => assertChannelUpdate(discussion, { archived: true })).not.toThrow();
  });
  it('canonicalizes channel names and rejects paths or markup', () => {
    expect(normalizeChannelName(' #Trail-Walks ')).toBe('trail-walks');
    for (const name of ['../general', '<script>', ' ', 'a'.repeat(81)]) expect(() => normalizeChannelName(name)).toThrow();
  });
});

describe('channel icons', () => {
  it('accepts exactly one emoji, including sequences and flags, and clears with blank or null', () => {
    for (const icon of ['🔥', '🏔️', '🙏🏽', '👨‍👩‍👧', '🇺🇸', '❤️']) expect(normalizeChannelIcon(icon)).toBe(icon);
    expect(normalizeChannelIcon(' 🔥 ')).toBe('🔥');
    for (const empty of ['', '  ', null, undefined]) expect(normalizeChannelIcon(empty)).toBeNull();
  });
  it('rejects text, several emoji and markup', () => {
    for (const bad of ['a', '#', '12', '🔥🔥', '🔥a', '<b>', 'hi 🔥']) expect(() => normalizeChannelIcon(bad)).toThrow('single emoji');
  });
});

describe('channel display names', () => {
  it('lets the title differ from the handle and falls back when blank', () => {
    expect(normalizeChannelDisplayName('  Morning   Workout 💪 ')).toBe('Morning Workout 💪');
    expect(normalizeChannelDisplayName('   ')).toBeNull();
    expect(normalizeChannelDisplayName(null)).toBeNull();
    expect(() => normalizeChannelDisplayName('x'.repeat(81))).toThrow();
    expect(() => normalizeChannelDisplayName('bad\u0000name')).toThrow();
  });
  it('suggests a valid handle from any title', () => {
    expect(slugifyChannelName('Morning Workout 💪')).toBe('morning-workout');
    expect(normalizeChannelName(slugifyChannelName('Café & Prayer!'))).toBe('cafe-prayer');
  });
  it('blocks default channels from being retitled', () => {
    const general = { defaultPurpose: 'general', name: 'general', displayName: null };
    expect(() => assertChannelUpdate(general, { displayName: 'Lobby' })).toThrow();
    expect(() => assertChannelUpdate(general, { displayName: null })).not.toThrow();
  });
});
