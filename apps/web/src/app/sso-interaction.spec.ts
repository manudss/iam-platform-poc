import { describeScopes } from './sso-interaction';

describe('sso consent wording', () => {
  it('describes each known scope in plain words, in the order asked', () => {
    expect(describeScopes(['openid', 'email', 'roles'])).toEqual(['recognise you (your account identifier)', 'your email address', 'your roles in the company']);
  });
  it('never lists a scope it does not know', () => {
    expect(describeScopes(['openid', 'admin', 'x'])).toEqual(['recognise you (your account identifier)']);
  });
});
