import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { fitMarvinPost, marvinFailureReason } from './marvin-failure';

describe('Marv delivery diagnostics', () => {
  it('preserves actionable validation codes without copying arbitrary error text', () => {
    expect(marvinFailureReason(new BadRequestException('Posts are limited to 500 characters.'))).toBe('post_too_long_500');
    expect(marvinFailureReason(new ForbiddenException({ error: 'ai_consent_required', message: 'Consent' }))).toBe('ai_consent_required');
    expect(marvinFailureReason(new Error('secret prompt or API key'))).toBe('unexpected_error');
    expect(marvinFailureReason({ status: 429, message: 'private request' })).toBe('upstream_429');
    expect(marvinFailureReason({ code: 'P2022', message: 'private query' })).toBe('database_P2022');
  });
  it('keeps short answers and caps long ones at whole words', () => {
    expect(fitMarvinPost('  Answer.  ')).toBe('Answer.');
    const result = fitMarvinPost('Word '.repeat(240));
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result).toMatch(/Word…$/);
    expect(fitMarvinPost('😀'.repeat(600))).not.toMatch(/[\uD800-\uDBFF]…$/u);
  });
});
