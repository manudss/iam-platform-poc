import { formatMapping, parseList, parseMapping, spMetadataFormValues, scopeChecksFromList, scopeListFromChecks } from './applications';

describe('applications form helpers', () => {
  it('round-trips the attribute mapping', () => {
    const m = { sub: 'id', email: 'email', NameID: 'email' };
    expect(parseMapping(formatMapping(m))).toEqual(m);
  });
  it('parses mapping lines, ignoring blanks and trimming', () => {
    expect(parseMapping(' sub = id \n\nname=display_name\n')).toEqual({ sub: 'id', name: 'display_name' });
  });
  it('parses lists by line or comma, without blanks or duplicates', () => {
    expect(parseList('a, b\nb\n\n c ')).toEqual(['a', 'b', 'c']);
    expect(parseList('')).toEqual([]);
  });
});

describe('SP metadata import into the application form', () => {
  it('fills the fields the document carries and keeps the rest', () => {
    const v = spMetadataFormValues({ entity_id: 'https://sp.example/saml', acs_url: null, sp_certificate: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----' }, { entity: '', acs: 'https://kept.example/acs', cert: '' });
    expect(v).toEqual({ entity: 'https://sp.example/saml', acs: 'https://kept.example/acs', cert: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----' });
  });
});

describe('OIDC scope checkboxes', () => {
  it('round-trips the scope list, keeping the display order', () => {
    expect(scopeListFromChecks(scopeChecksFromList(['roles', 'profile']))).toEqual(['profile', 'roles']);
    expect(scopeListFromChecks(scopeChecksFromList([]))).toEqual([]);
    expect(scopeChecksFromList(['profile', 'email', 'roles', 'offline_access'])).toEqual({ profile: true, email: true, roles: true, offline_access: true });
  });
});
