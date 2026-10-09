import type { Prisma } from '@prisma/client';
import { canonicalChannelBody, channelReferenceCatalog, channelReferencePreview, presentChannelBody } from './channel-references';

function setup() {
  const publicChannel = { id: 'bugs', name: 'bugs', displayName: 'Bug reports', privacy: 'normal', access: [] };
  const privateChannel = { id: 'secret', name: 'leadership', displayName: 'Leaders only', privacy: 'private', access: [{ userId: 'member' }] };
  const findMany = jest.fn().mockResolvedValue([publicChannel, privateChannel]);
  const db = { groupChannel: { findMany } } as unknown as Prisma.TransactionClient;
  return { db, findMany, publicChannel, privateChannel };
}

describe('group-scoped channel references', () => {
  it('canonicalizes typed handles to stable identity without persisting names', async () => {
    const h = setup();
    const body = await canonicalChannelBody(h.db, 'member', 'group', 'See #bugs and #leadership, thanks.');
    expect(body).toBe('See <#bugs> and <#secret>, thanks.');
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ groupId: 'group' }) }));
    h.publicChannel.name = 'fixes';
    const catalog = await channelReferenceCatalog(h.db, 'group', [body], ['member']);
    expect(presentChannelBody(body, 'member', catalog).channelReferences[0]).toMatchObject({ channelId: 'bugs', name: 'fixes' });
  });
  it('does not interpret URL fragments, embedded hashes, or unknown names as channel references', async () => {
    const h = setup();
    const text = 'https://example.com/#bugs word#bugs #unknown';
    expect(await canonicalChannelBody(h.db, 'member', 'group', text)).toBe(text);
  });
  it('rejects new inaccessible or foreign explicit identities without disclosing metadata', async () => {
    const h = setup();
    await expect(canonicalChannelBody(h.db, 'outsider', 'group', '<#secret>')).rejects.toThrow('That channel reference is unavailable.');
    await expect(canonicalChannelBody(h.db, 'member', 'group', '<#other-group>')).rejects.toThrow('That channel reference is unavailable.');
    expect(h.findMany.mock.calls[1][0].where.groupId).toBe('group');
  });
  it('leaves malformed tokens inert and never partially resolves their label', async () => {
    const h = setup();
    const text = '<#secret|leadership> <#secret <#secret.> <#>';
    expect(await canonicalChannelBody(h.db, 'outsider', 'group', text)).toBe(text);
    expect(h.findMany).not.toHaveBeenCalled();
    expect(presentChannelBody(text, 'outsider', new Map()).channelReferences).toEqual([]);
  });
  it('allows editing other text while retaining an existing reference after revocation', async () => {
    const h = setup();
    expect(await canonicalChannelBody(h.db, 'outsider', 'group', 'Changed <#secret>', 'Original <#secret>')).toBe('Changed <#secret>');
    await expect(canonicalChannelBody(h.db, 'outsider', 'group', 'Added <#secret>', 'Original')).rejects.toThrow('unavailable');
  });
  it('filters private labels per recipient, including leaders without explicit membership', async () => {
    const h = setup();
    const body = 'See #leadership and <#bugs> and <#missing>.';
    const catalog = await channelReferenceCatalog(h.db, 'group', [body], ['member', 'owner']);
    const allowed = presentChannelBody(body, 'member', catalog);
    expect(allowed.body).toBe('See <#secret> and <#bugs> and <#missing>.');
    expect(allowed.channelReferences[0]).toEqual({ token: '<#secret>', channelId: 'secret', name: 'leadership', displayName: 'Leaders only', privacy: 'private', accessible: true });
    const restricted = presentChannelBody(body, 'owner', catalog);
    expect(restricted.channelReferences[0]).toEqual({ token: '<#secret>', channelId: null, name: null, displayName: null, privacy: 'private', accessible: false });
    expect(restricted.channelReferences[2]).toMatchObject({ accessible: false, name: null, channelId: null });
    expect(JSON.stringify(restricted)).not.toMatch(/leadership|Leaders only/);
  });
  it('redacts all private reference labels and IDs from quoted and lock-screen previews', async () => {
    const h = setup();
    const catalog = await channelReferenceCatalog(h.db, 'group', ['See #leadership and <#bugs> <#missing>'], []);
    const preview = channelReferencePreview('See #leadership and <#bugs> <#missing>', catalog);
    expect(preview).toBe('See Private and #Bug reports Private');
    expect(preview).not.toMatch(/leadership|secret|Leaders only|<#/);
  });
  it('avoids a database query when there are no channel references', async () => {
    const h = setup();
    expect(await canonicalChannelBody(h.db, 'member', 'group', 'Hello @Thomas')).toBe('Hello @Thomas');
    expect(h.findMany).not.toHaveBeenCalled();
  });
});
