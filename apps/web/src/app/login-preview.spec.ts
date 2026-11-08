import { isPreview, previewMessage } from './login';

describe('sign-in preview mode', () => {
  it('is off outside a frame, even with ?preview=1', () => {
    history.replaceState({}, '', '/login?preview=1');
    expect(window.parent === window).toBe(true);
    expect(isPreview()).toBe(false);
    history.replaceState({}, '', '/');
  });
  it('accepts only well-formed preview messages', () => {
    expect(previewMessage(null)).toBeNull();
    expect(previewMessage({ type: 'other', chains: [] })).toBeNull();
    expect(previewMessage({ type: 'iam-preview', chains: 'x' })).toBeNull();
    const m = previewMessage({ type: 'iam-preview', chains: [{ id: 'a', name: 'A', steps: [] }, { bad: 1 }], highlight: 'a', view: 'step', step: 2, dark: true });
    expect(m?.chains.length).toBe(1); expect(m?.view).toBe('step'); expect(m?.step).toBe(2); expect(m?.dark).toBe(true);
    expect(previewMessage({ type: 'iam-preview', chains: [], view: 'weird' })?.view).toBe('list');
  });
});
