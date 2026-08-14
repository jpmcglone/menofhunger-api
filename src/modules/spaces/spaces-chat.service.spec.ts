import { SpacesChatService } from './spaces-chat.service';

const SPACE_ID = 'space-1';
const USER_ID = 'user-ocaptain';

describe('SpacesChatService.appendSystemMessage', () => {
  let svc: SpacesChatService;

  beforeEach(() => {
    svc = new SpacesChatService();
  });

  function join() {
    return svc.appendSystemMessage({
      spaceId: SPACE_ID,
      event: 'join',
      userId: USER_ID,
      username: 'ocaptain',
    });
  }

  function leave() {
    return svc.appendSystemMessage({
      spaceId: SPACE_ID,
      event: 'leave',
      userId: USER_ID,
      username: 'ocaptain',
    });
  }

  it('says joined on first enter', () => {
    const msg = join();
    expect(msg?.body).toBe('@ocaptain has joined the chat');
    expect(msg?.kind === 'system' && msg.system).toMatchObject({
      firstEvent: 'join',
      lastEvent: 'join',
    });
  });

  it('collapses join then leave to joined and left', () => {
    join();
    const msg = leave();
    expect(msg?.body).toBe('@ocaptain has joined and left the chat');
    expect(msg?.kind === 'system' && msg.system).toMatchObject({
      firstEvent: 'join',
      lastEvent: 'leave',
    });
  });

  it('collapses leave then join to left and joined', () => {
    join();
    leave();
    const msg = join();
    expect(msg?.body).toBe('@ocaptain has left and joined the chat');
    expect(msg?.kind === 'system' && msg.system).toMatchObject({
      firstEvent: 'leave',
      lastEvent: 'join',
    });
  });

  it('does not rewind copy on a duplicate leave', () => {
    join();
    leave();
    const msg = leave();
    expect(msg?.body).toBe('@ocaptain has joined and left the chat');
    expect(msg?.kind === 'system' && msg.system).toMatchObject({
      firstEvent: 'join',
      lastEvent: 'leave',
    });
  });

  it('starts a new system line after a user message', () => {
    join();
    svc.appendMessage({
      spaceId: SPACE_ID,
      sender: {
        id: USER_ID,
        username: 'ocaptain',
        premium: false,
        premiumPlus: false,
        isOrganization: false,
        verifiedStatus: 'none',
        stewardBadgeEnabled: true,
      },
      body: 'hello',
    });
    const msg = leave();
    expect(msg?.body).toBe('@ocaptain has left the chat');
    const snap = (svc as any).bySpace.get(SPACE_ID).messages as Array<{ kind: string; body: string }>;
    const systemBodies = snap.filter((m) => m.kind === 'system').map((m) => m.body);
    expect(systemBodies).toEqual([
      '@ocaptain has joined the chat',
      '@ocaptain has left the chat',
    ]);
  });
});

describe('SpacesChatService.appendMessage replyToId', () => {
  it('forwards a parent id without requiring the parent to exist', () => {
    const svc = new SpacesChatService();
    const msg = svc.appendMessage({
      spaceId: SPACE_ID,
      sender: {
        id: USER_ID,
        username: 'ocaptain',
        premium: false,
        premiumPlus: false,
        isOrganization: false,
        verifiedStatus: 'none',
        stewardBadgeEnabled: true,
      },
      body: 'later',
      replyToId: 'missing-parent',
    });
    expect(msg?.kind).toBe('user');
    expect(msg && msg.kind === 'user' ? msg.replyToId : null).toBe('missing-parent');
  });
});
