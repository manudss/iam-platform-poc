import { signal } from '@angular/core';
import { Shell } from './shell';

// Exercise the user menu without mounting the unrelated navigation and branding effects.
function harness(profile: any = {}, health: any = { version: 'dev', commit: '' }) {
  const raw = vi.fn(async (method: string, path: string) => {
    if (path === '/me/profile') return { status: 200, data: { values: profile } };
    if (path === '@/health') return { status: 200, data: health };
    return { status: 404, data: {} };
  });
  const shell: any = Object.create(Shell.prototype);
  Object.assign(shell, {
    s: { user: () => 'demo-alice', api: { raw } },
    headers: () => ({}),
    userMenu: signal(false), mePhoto: signal(''), meName: signal(''),
    appVersion: signal(''), appCommit: signal(''),
  });
  return { shell, raw };
}

describe('shell user menu', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the profile picture only when it is a data image URL', async () => {
    const { shell } = harness({ 'profile-picture.picture': 'data:image/png;base64,AAAA' });
    await shell.loadMe();
    expect(shell.mePhoto()).toBe('data:image/png;base64,AAAA');
  });

  it('rejects a remote or plain-text picture value and falls back to initials', async () => {
    for (const picture of ['https://evil.example/x.png', 'not-an-image', 42, null]) {
      const { shell } = harness({ 'profile-picture.picture': picture });
      await shell.loadMe();
      expect(shell.mePhoto()).toBe('');
    }
  });

  it('derives the avatar initials from the display name, else from the identity', async () => {
    const named = harness({ 'base.display_name': 'Alice Martin' }).shell;
    await named.loadMe();
    expect(named.meName()).toBe('Alice Martin');
    expect(named.meInitials()).toBe('AM');
    const plain = harness().shell;
    await plain.loadMe();
    expect(plain.meName()).toBe('');
    expect(plain.meInitials()).toBe('D'); // demo-alice: one word, one letter
  });

  it('keeps the initials on a profile read failure', async () => {
    const shell: any = Object.create(Shell.prototype);
    Object.assign(shell, { s: { user: () => 'demo-alice', api: { raw: vi.fn(async () => { throw new Error('network'); }) } }, headers: () => ({}),
      userMenu: signal(false), mePhoto: signal(''), meName: signal(''), appVersion: signal(''), appCommit: signal('') });
    await shell.loadMe();
    expect(shell.mePhoto()).toBe('');
    expect(shell.meInitials()).toBe('D');
  });

  it('reads the deployed build from the health endpoint', async () => {
    const { shell } = harness({}, { version: '437', commit: 'abcdef123456' });
    await shell.loadVersion();
    expect(shell.appVersion()).toBe('437');
    expect(shell.appCommit().slice(0, 7)).toBe('abcdef1');
  });

  it('leaves the build empty when health cannot be read', async () => {
    const { shell, raw } = harness();
    raw.mockImplementation(async () => ({ status: 500, data: {} }));
    await shell.loadVersion();
    expect(shell.appVersion()).toBe('');
  });

  it('opens, closes and closes on Escape', () => {
    const { shell } = harness();
    expect(shell.userMenu()).toBe(false);
    shell.toggleUserMenu(); expect(shell.userMenu()).toBe(true);
    shell.toggleUserMenu(); expect(shell.userMenu()).toBe(false);
    shell.toggleUserMenu(); shell.onUserMenuEsc(); expect(shell.userMenu()).toBe(false);
  });
});
