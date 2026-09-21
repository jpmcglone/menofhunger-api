import { MARV_ADMIN_INSTRUCTIONS, MARV_SYSTEM_PROMPT, MARV_SYSTEM_PROMPT_VERSION } from './marvin-system-prompt';

describe('MARV_SYSTEM_PROMPT', () => {
  it('pins a version and the exported persona', () => {
    expect(MARV_SYSTEM_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(MARV_SYSTEM_PROMPT).toContain("You are M.A.R.V. — Men's Assistant for Reason and Virtue");
    expect(MARV_SYSTEM_PROMPT).toContain('Second London Baptist Confession (1689)');
    expect(MARV_SYSTEM_PROMPT).toContain('Postmillennial. Partial preterist.');
    expect(MARV_SYSTEM_PROMPT).toContain('General-equity theonomy');
    expect(MARV_SYSTEM_PROMPT).toContain('Maximum length: 80 words.');
    expect(MARV_SYSTEM_PROMPT).toContain('Never steel-man a false religion');
    expect(MARV_SYSTEM_PROMPT).toContain('get_user_context_card');
    expect(MARV_SYSTEM_PROMPT).toContain('get_post_thread_summary');
    expect(MARV_ADMIN_INSTRUCTIONS).not.toContain('80 words');
  });
});
