import { ApiError } from './api.mjs';

export async function publishingAccounts(api) {
  const administrator = await api.identity();
  const result = await api.get('auth/accounts');
  return { ...result, administrator, data: result.data.filter((account) =>
    account.id === administrator.id || account.accountKind === 'page') };
}

export async function publishPost({ api, store, authorUsername, body }) {
  return store.withPublishingLock(api.baseUrl, async () => {
    const accounts = await publishingAccounts(api);
    const author = accounts.data.find((account) =>
      account.username?.toLowerCase() === authorUsername.toLowerCase());
    if (!author) throw new ApiError('Choose your own account or a page you operate from publishing_accounts.', 403);
    const administrator = accounts.administrator;
    const switching = author.id !== administrator.id;
    let result;
    let failure;
    let restorationError;
    let publishAttempted = false;
    try {
      if (switching) await api.switchAccount(author.id);
      // Verify the effective identity after cookie rotation. Never fall back to
      // publishing under the personal account when a requested page fails.
      const { data: current } = await api.get('auth/me');
      if (current?.id !== author.id || current.impersonation ||
          (switching && (current.accountKind !== 'page' ||
            current.accountSwitch?.operatorUserId !== administrator.id)) ||
          (!switching && (!current.siteAdmin || current.accountSwitch)))
        throw new ApiError('The active account does not match the requested publishing identity.', 403);
      publishAttempted = true;
      result = await api.publish({ body, visibility: 'public' });
      if (!result.data?.post?.id || result.data.post.author?.id !== author.id)
        throw new ApiError('The API did not confirm the requested post author. Check the feed before retrying.');
    } catch (error) {
      failure = error;
    } finally {
      if (switching) {
        try {
          const { data: current } = await api.get('auth/me');
          if (current?.id !== administrator.id) {
            if (current?.accountSwitch?.operatorUserId !== administrator.id || current.impersonation)
              throw new Error('Unexpected session identity.');
            await api.switchAccount(administrator.id);
          }
          const restored = await api.identity();
          if (restored.id !== administrator.id) throw new Error('Unexpected administrator.');
        } catch {
          restorationError = 'The personal administrator session could not be restored. Run moh login before further admin work.';
        }
      }
    }
    if (failure) throw new ApiError(`${failure.message}${publishAttempted ? ' Publication may have occurred; inspect the author’s feed before retrying. No publish request was retried.' : ''}${restorationError ? ` ${restorationError}` : ''}`);
    return { ...result, published: true, author: { id: author.id, username: author.username },
      administratorRestored: !restorationError, ...(restorationError ? { warning: restorationError } : {}) };
  });
}
