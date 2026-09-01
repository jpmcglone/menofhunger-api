import { buildFollowedSpaceEmail } from './email-content-space';

const base = {
  greeting: 'Hey Fan,',
  hostName: 'ocaptain',
  spaceTitle: 'The Great Debate',
  whenLabel: 'Tue, Sep 15, 4:00 PM EDT',
  spaceUrl: 'https://menofhunger.com/s/ocaptain',
  settingsUrl: 'https://menofhunger.com/settings/notifications',
};

describe('buildFollowedSpaceEmail', () => {
  it('leads the announce with the event title and time', () => {
    const rendered = buildFollowedSpaceEmail(base);
    expect(rendered.subject).toBe('The Great Debate · Tue, Sep 15, 4:00 PM EDT');
    expect(rendered.text).toContain('ocaptain scheduled The Great Debate.');
    expect(rendered.text).toContain('Tune in Tue, Sep 15, 4:00 PM EDT.');
    expect(rendered.html).toContain('Open the space');
  });

  it('writes a 30-minute heads-up', () => {
    const rendered = buildFollowedSpaceEmail({ ...base, kind: 'soon' });
    expect(rendered.subject).toBe('The Great Debate starts in 30 minutes');
    expect(rendered.text).toContain('starts in about 30 minutes.');
  });

  it('writes a cancel notice', () => {
    const rendered = buildFollowedSpaceEmail({ ...base, kind: 'cancelled' });
    expect(rendered.subject).toBe('The Great Debate was cancelled');
    expect(rendered.text).toContain('ocaptain cancelled The Great Debate.');
    expect(rendered.html).toContain('Open spaces');
  });
});
