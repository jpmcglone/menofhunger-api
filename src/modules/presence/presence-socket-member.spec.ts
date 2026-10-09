import { memberForSocket, parseSocketMember, socketTtlSeconds } from './presence-socket-member';

describe('presence socket membership strings', () => {
  it('round-trips an instance and socket id', () => {
    expect(parseSocketMember(memberForSocket('inst-1', ' sock-9 '))).toEqual({ instanceId: 'inst-1', socketId: 'sock-9' });
  });

  it('keeps colons that belong to the socket id', () => {
    expect(parseSocketMember('inst:ns:abc')).toEqual({ instanceId: 'inst', socketId: 'ns:abc' });
  });

  it.each(['', ':sock', 'inst:', 'no-separator', '  '])('rejects malformed member %j', (member) => {
    expect(parseSocketMember(member)).toBeNull();
  });
});

describe('socketTtlSeconds', () => {
  it('outlives the idle-disconnect window by a minute', () => {
    expect(socketTtlSeconds(15)).toBe(15 * 60 + 60);
  });

  it('never drops below a minute', () => {
    expect(socketTtlSeconds(0)).toBe(60);
  });
});
