import {
  ARTICLE_NOTIFICATION_CLICK_KINDS,
  articleNotificationClickPath,
} from './notification-article-path';

describe('articleNotificationClickPath', () => {
  it('opens the article for a new published piece', () => {
    expect(articleNotificationClickPath('article-1')).toBe('/a/article-1');
  });

  it('opens the exact comment for an article reply', () => {
    expect(articleNotificationClickPath('article-1', 'c9')).toBe(
      '/a/article-1#comment-c9',
    );
  });

  it('ignores blank comment ids', () => {
    expect(articleNotificationClickPath('article-1', '  ')).toBe('/a/article-1');
  });

  it('returns null without an article id', () => {
    expect(articleNotificationClickPath(null, 'c9')).toBeNull();
  });

  it('covers the kinds that carry subjectArticleId', () => {
    for (const kind of ['comment', 'mention', 'followed_article', 'boost', 'generic'] as const) {
      expect(ARTICLE_NOTIFICATION_CLICK_KINDS.has(kind)).toBe(true);
    }
  });
});
