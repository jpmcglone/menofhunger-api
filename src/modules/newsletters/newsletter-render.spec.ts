import { renderNewsletterEmail } from './newsletter-render';

describe('newsletter render', () => {
  const rendered = renderNewsletterEmail({
    subject: 'Hello {{firstName}}',
    preheader: '',
    bodyJson: JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hey {{firstName}}, welcome.' }] }],
    }),
    ctaLabel: 'Open the lodge',
    ctaHref: 'https://menofhunger.com/home',
    vars: { firstName: 'James', name: 'James Hall', username: 'james' },
    unsubscribeUrl: 'https://menofhunger.com/email/unsubscribe?token=abc',
    settingsUrl: 'https://menofhunger.com/settings/notifications',
    postalAddress: '123 Main St, Roanoke, VA',
  });

  it('interpolates the subject and wraps the MOH email shell', () => {
    expect(rendered.subject).toBe('Hello James');
    expect(rendered.html).toContain('Men of Hunger');
    expect(rendered.html).toContain('Hey James, welcome.');
    expect(rendered.html).toContain('Open the lodge');
    expect(rendered.html).toContain('Unsubscribe from newsletters');
    expect(rendered.html).toContain('123 Main St, Roanoke, VA');
    expect(rendered.html).toContain('color-scheme');
    expect(rendered.html).toContain('light dark');
    expect(rendered.html).toContain('#FBFAF7');
    expect(rendered.html).toContain('#0F1113');
    expect(rendered.html).toContain('prefers-color-scheme:dark');
    expect(rendered.html).toContain('[data-ogsc]');
    expect(rendered.html).toContain('[data-ogsb]');
    expect(rendered.html).toContain('Inter');
  });

  it('includes a plain-text unsubscribe path', () => {
    expect(rendered.text).toContain(
      'Unsubscribe from newsletters: https://menofhunger.com/email/unsubscribe?token=abc',
    );
  });

  it('autolinks usernames and scripture in the body', () => {
    const linked = renderNewsletterEmail({
      subject: 'Look',
      preheader: '',
      bodyJson: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Ask @james about John 3:16 and #lodge.' }],
          },
        ],
      }),
      vars: { firstName: 'James', name: 'James Hall', username: 'james' },
      unsubscribeUrl: 'https://menofhunger.com/email/unsubscribe?token=abc',
      settingsUrl: 'https://menofhunger.com/settings/notifications',
      postalAddress: '123 Main St, Roanoke, VA',
      siteUrl: 'https://menofhunger.com',
    });
    expect(linked.html).toContain('https://menofhunger.com/u/james');
    expect(linked.html).toContain('https://menofhunger.com/explore?q=John%203%3A16');
    expect(linked.html).toContain('https://menofhunger.com/explore?q=%23lodge');
  });

  it('renders hero and inline body images', () => {
    const withImages = renderNewsletterEmail({
      subject: 'Look',
      preheader: '',
      bodyJson: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'A photo:' }] },
          { type: 'image', attrs: { src: 'https://cdn.example.com/inline.jpg', alt: 'Lodge' } },
        ],
      }),
      heroImageUrl: 'https://cdn.example.com/hero.jpg',
      vars: { firstName: 'James', name: 'James Hall', username: 'james' },
      unsubscribeUrl: 'https://menofhunger.com/email/unsubscribe?token=abc',
      settingsUrl: 'https://menofhunger.com/settings/notifications',
      postalAddress: '123 Main St, Roanoke, VA',
    });
    expect(withImages.html).toContain('https://cdn.example.com/hero.jpg');
    expect(withImages.html).toContain('https://cdn.example.com/inline.jpg');
    expect(withImages.html).toContain('alt="Lodge"');
  });
});
