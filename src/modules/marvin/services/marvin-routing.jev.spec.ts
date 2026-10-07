import { MarvinRoutingService } from './marvin-routing.service';
import type { JevRoutingSignals } from './marvin-jev.service';

const calm: JevRoutingSignals = {
  crisis: 0.01,
  sensitive: 0.05,
  explicitSearch: 0.02,
  liveInfo: 0.05,
  modelTrap: 0.02,
  pushback: 0.02,
  complexity: { level: 'simple', confidence: 0.95 },
};

function makeService(signals: Partial<JevRoutingSignals> | null, available = true) {
  const jev: any = {
    routingAvailable: jest.fn(() => available),
    routingSignals: jest.fn(async () => (signals ? { ...calm, ...signals } : null)),
  };
  return { svc: new MarvinRoutingService(jev), jev };
}

const base = {
  requested: 'auto' as const,
  source: 'public_thread' as const,
  estimatedInputTokens: 10,
  webSearchEnabled: true,
};

describe('MarvinRoutingService with Jev', () => {
  it('behaves exactly like the rules when Jev is not configured', async () => {
    const { svc, jev } = makeService(calm, false);
    const result = await svc.resolve({ ...base, text: 'what is the latest news today' });
    expect(result).toEqual(svc.resolveRules({ ...base, text: 'what is the latest news today' }));
    expect(result.engine).toBe('rules');
    expect(jev.routingSignals).not.toHaveBeenCalled();
  });

  it('falls back to the rules when Jev returns nothing (timeout or error)', async () => {
    const { svc } = makeService(null);
    const result = await svc.resolve({ ...base, text: 'my wife cheated on me' });
    expect(result.mode).toBe('smart');
    expect(result.reason).toBe('sensitive_topic');
    expect(result.engine).toBe('rules');
  });

  it('works with no Jev service at all, as in older wiring', async () => {
    const svc = new MarvinRoutingService();
    const result = await svc.resolve({ ...base, text: 'hello there' });
    expect(result).toMatchObject({ mode: 'fast', engine: 'rules' });
  });

  it('flags crisis from Jev when the keyword rules miss it, and elevates reasoning', async () => {
    const { svc } = makeService({ crisis: 0.6 });
    const text = 'I cannot keep doing this and nobody would notice if I vanished';
    expect(svc.resolveRules({ ...base, text }).crisisDetected).toBe(false);
    const result = await svc.resolve({ ...base, text });
    expect(result).toMatchObject({ mode: 'smart', crisisDetected: true, engine: 'jev' });
    expect(result.reason).toBe('crisis_keywords+jev');
    expect(MarvinRoutingService.shouldElevateReasoning(result)).toBe(true);
  });

  it('never drops a crisis keyword hit even when Jev says no', async () => {
    const { svc } = makeService({ crisis: 0 });
    const result = await svc.resolve({ ...base, text: 'sometimes I want to die' });
    expect(result).toMatchObject({ mode: 'smart', crisisDetected: true });
  });

  it('lets a confident Jev clear a keyword false positive for sensitive topics', async () => {
    const { svc } = makeService({ sensitive: 0.02 });
    const text = 'is it true that the trinity college choir sings tonight';
    expect(svc.resolveRules({ ...base, text }).mode).toBe('smart');
    const result = await svc.resolve({ ...base, text });
    expect(result.mode).toBe('fast');
    expect(result.reason).toBe('auto_routed+jev');
  });

  it('lets the keyword rule decide when Jev is unsure', async () => {
    const { svc } = makeService({ sensitive: 0.5 });
    const result = await svc.resolve({ ...base, text: 'thoughts on infant baptism?' });
    expect(result).toMatchObject({ mode: 'smart', reason: 'sensitive_topic' });
  });

  it('routes a sensitive topic the keywords cannot see to Smart', async () => {
    const { svc } = makeService({ sensitive: 0.93 });
    const result = await svc.resolve({ ...base, text: 'I have been hiding something from my family for years' });
    expect(result).toMatchObject({ mode: 'smart', reason: 'sensitive_topic+jev' });
  });

  it('upgrades to Regular with a must-search demand on an explicit request Jev recognizes', async () => {
    const { svc } = makeService({ explicitSearch: 0.95, liveInfo: 0.9 });
    const result = await svc.resolve({ ...base, text: 'could you dig up who won the game' });
    expect(result).toMatchObject({ mode: 'regular', reason: 'explicit_search_demand+jev', webSearchDemanded: true });
  });

  it('upgrades to Regular for live information without demanding a search', async () => {
    const { svc } = makeService({ liveInfo: 0.9 });
    const result = await svc.resolve({ ...base, text: 'how is the stock market doing' });
    expect(result).toMatchObject({ mode: 'regular', webSearchDemanded: false });
  });

  it('asks nothing about the web when search is off, so it cannot upgrade for it', async () => {
    const { svc } = makeService({ explicitSearch: null, liveInfo: null });
    const result = await svc.resolve({ ...base, webSearchEnabled: false, text: 'what is the weather today' });
    expect(result.mode).toBe('fast');
  });

  it('upgrades a moderate request to Regular only when Jev is confident', async () => {
    const confident = makeService({ complexity: { level: 'moderate', confidence: 0.85 } });
    expect((await confident.svc.resolve({ ...base, text: 'compare these two plans' })).reason).toBe('moderate_request+jev');
    const unsure = makeService({ complexity: { level: 'moderate', confidence: 0.5 } });
    expect((await unsure.svc.resolve({ ...base, text: 'compare these two plans' })).mode).toBe('fast');
  });

  it('steps a model trap up one tier even when Jev calls the question simple', async () => {
    const { svc } = makeService({ modelTrap: 0.92, complexity: { level: 'simple', confidence: 0.99 } });
    const text = 'which is larger, 9.11 or 9.9';
    expect(svc.resolveRules({ ...base, text }).mode).toBe('fast');
    const fromFast = await svc.resolve({ ...base, text });
    expect(fromFast).toMatchObject({ mode: 'regular', reason: 'ai_trick+jev' });
    const fromRegular = await svc.resolve({ ...base, requested: 'regular', text });
    expect(fromRegular).toMatchObject({ mode: 'smart', reason: 'ai_trick+jev' });
  });

  it('lets an unsure Jev defer a letter-count to the keyword rule', async () => {
    const { svc } = makeService({ modelTrap: 0.5 });
    const result = await svc.resolve({ ...base, text: "how many r's are in strawberry" });
    expect(result).toMatchObject({ mode: 'regular', reason: 'ai_trick' });
  });

  it('clears a keyword hit when Jev is sure it is not a model trap', async () => {
    const { svc } = makeService({ modelTrap: 0.05 });
    const result = await svc.resolve({ ...base, text: 'how many letters are in the mail I should send' });
    expect(svc.resolveRules({ ...base, text: 'how many letters are in the mail I should send' }).mode).toBe('regular');
    expect(result.mode).toBe('fast');
  });

  it('steps a confident correction up one tier, and climbs again from the model that just answered', async () => {
    const { svc } = makeService({ pushback: 0.9, complexity: { level: 'simple', confidence: 0.99 } });
    const text = 'that answer missed it';
    expect(svc.resolveRules({ ...base, text }).mode).toBe('fast');
    const first = await svc.resolve({ ...base, text });
    expect(first).toMatchObject({ mode: 'regular', reason: 'user_pushback+jev' });
    const again = await svc.resolve({ ...base, text, priorEffectiveMode: 'regular' });
    expect(again).toMatchObject({ mode: 'smart', reason: 'user_pushback+jev' });
  });

  it('lets an unsure Jev keep a keyword correction, and drops one it is sure is not pushback', async () => {
    const unsure = makeService({ pushback: 0.5 });
    const text = "actually there are 3 r's in strawberry";
    const replyingTo = { text: '2', fromMarv: true as const };
    expect((await unsure.svc.resolve({ ...base, text, replyingTo })).reason).toBe('user_pushback');
    const clear = makeService({ pushback: 0.05 });
    const cleared = await clear.svc.resolve({ ...base, text: "you're wrong about the meeting time" });
    expect(clear.svc.resolveRules({ ...base, text: "you're wrong about the meeting time" }).mode).toBe('regular');
    expect(cleared.mode).toBe('fast');
  });

  it('sends a clearly complex request to Smart, and never downgrades Smart', async () => {
    const complex = makeService({ complexity: { level: 'complex', confidence: 0.9 } });
    expect(await complex.svc.resolve({ ...base, text: 'help me think through leaving my job' })).toMatchObject({
      mode: 'smart',
      reason: 'complex_request+jev',
    });
    const simple = makeService({});
    expect((await simple.svc.resolve({ ...base, requested: 'smart', text: 'hi' })).mode).toBe('smart');
  });

  it('does not mark the reason when Jev agrees with the rules', async () => {
    const { svc } = makeService({});
    const result = await svc.resolve({ ...base, text: 'good morning' });
    expect(result).toMatchObject({ mode: 'fast', reason: 'auto_routed', engine: 'jev' });
  });
});
