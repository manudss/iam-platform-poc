import { signal } from '@angular/core';
import { Shell } from './shell';

// Exercise the toolbar protocol without mounting the unrelated navigation and branding effects.
function harness() {
  const raw = vi.fn(async () => ({ status: 200, data: { applied: true, commit: 'applied' } }));
  const shell: any = Object.create(Shell.prototype);
  Object.assign(shell, {
    s: { branch: () => 'personal/alice', api: { raw }, adminToken: () => '',
      branchEpoch: { update: vi.fn() }, say: vi.fn() },
    applyDialog: { confirm: vi.fn(async () => true) }, review: signal<any>(null), workingBusy: signal(false),
    loadBranches: vi.fn(async () => {}), loadChanges: vi.fn(async () => {}), loadPluginMenu: vi.fn(async () => {}),
    branches: signal([{ name: 'personal/alice', commit: 'reviewed-head' }]),
  });
  return { shell, raw };
}

describe('toolbar Review and Apply', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires a review for the current non-main branch and its exact head', async () => {
    const { shell, raw } = harness();
    for (const review of [null, { branch: 'personal/bob', expectedHead: 'x' }, { branch: 'personal/alice' }, { branch: 'main', expectedHead: 'x' }]) {
      shell.review.set(review); await shell.apply();
    }
    expect(raw).not.toHaveBeenCalled();
  });

  it('uses the displayed review as confirmation, preserving the server guard', async () => {
    const { shell, raw } = harness();
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('native dialog must not open'); });
    shell.review.set({ branch: 'personal/alice', expectedHead: 'reviewed-head' });
    // A later list refresh must not silently change which head was reviewed.
    shell.branches.set([{ name: 'personal/alice', commit: 'later-head' }]);
    await shell.apply();
    expect(confirm).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledWith('POST', '/workspace/apply', { confirm: true, expectedHead: 'reviewed-head' }, {});
    expect(shell.review()).toBeNull(); expect(shell.workingBusy()).toBe(false);
    expect(shell.s.branchEpoch.update).toHaveBeenCalledOnce();
  });

  it('does not submit twice and leaves a rejected review visible', async () => {
    const { shell, raw } = harness();
    let resolve!: (v: any) => void;
    raw.mockImplementation(() => new Promise(r => { resolve = r; }));
    shell.review.set({ branch: 'personal/alice', expectedHead: 'reviewed-head' });
    const pending = shell.apply(); await Promise.resolve(); await shell.apply();
    expect(raw).toHaveBeenCalledOnce();
    resolve({ status: 409, data: { applied: false, message: 'Branch changed; review again' } }); await pending;
    expect(shell.review()).not.toBeNull(); expect(shell.workingBusy()).toBe(false);
    expect(shell.s.say).toHaveBeenCalledWith('Branch changed; review again', 'error');
  });

  it('cancel leaves the review untouched and sends nothing', async () => {
    const { shell, raw } = harness(); shell.applyDialog.confirm.mockResolvedValue(false);
    shell.review.set({ branch: 'personal/alice', expectedHead: 'reviewed-head' });
    await shell.apply(); expect(raw).not.toHaveBeenCalled(); expect(shell.review()).not.toBeNull(); expect(shell.workingBusy()).toBe(false);
  });

  it('captures the reviewed branch head when preparing the panel', async () => {
    const { shell, raw } = harness();
    raw.mockResolvedValue({ status: 200, data: { branch: 'personal/alice', diff: { rows: { total: 1 } } } } as any);
    await shell.prepareApply();
    expect(shell.review()).toMatchObject({ branch: 'personal/alice', expectedHead: 'reviewed-head' });
    expect(shell.workingBusy()).toBe(false);
  });
});
