import { assertPublishableText } from './content-filter';
describe('local preventive text filter', () => {
  it.each(['I will kill you', 'Ｉ will kill you', 'I will ki\u200bll you', 'CHILD pornography'])('blocks high-confidence abuse before publication: %s', text => {
    expect(() => assertPublishableText(text)).toThrow();
  });
  it.each(['We need to prevent violence against children.', 'Killed that workout today.', 'I will call you tomorrow.'])('allows ordinary discussion: %s', text => {
    expect(() => assertPublishableText(text)).not.toThrow();
  });
});
