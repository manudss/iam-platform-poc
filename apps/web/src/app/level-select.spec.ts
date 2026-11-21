import { TestBed } from '@angular/core/testing';
import { REACHABLE_FIXTURE } from './reachable-fixture';
import { LevelChain, LevelSelect, levelChains, reachableLevel } from './level-select';

const tipEl = () => document.body.querySelector('[role=tooltip]') as HTMLElement | null;
const down = (el: Element, type: string) => { const e = new Event('pointerdown', { bubbles: true }); Object.defineProperty(e, 'pointerType', { value: type }); el.dispatchEvent(e); };
const CH: LevelChain[] = [
  { id: 'pw', name: 'Password', level: 3, steps: ['Password'], usable: true },
  { id: 'mfa', name: 'Password + code', level: 8, steps: ['Password', 'Code'], usable: true },
  { id: 'sim', name: 'Badge', level: 9, steps: ['Badge'], usable: false, why: 'simulated step' },
];

describe('LevelSelect', () => {
  it('renders a button with the current level and the gauge', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect);
    f.componentRef.setInput('value', 6); f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent).toContain('6');
    expect(el.querySelectorAll('.bar, .b, i, span').length).toBeGreaterThan(0);
  });
  it('with allowNone, 0 reads "No minimum", the list starts with it, and picking it emits 0', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect);
    f.componentRef.setInput('value', 0); f.componentRef.setInput('allowNone', true); f.detectChanges();
    const el: HTMLElement = f.nativeElement; const seen: number[] = []; f.componentInstance.valueChange.subscribe((n) => seen.push(n));
    expect(el.textContent).toContain('No minimum');
    (el.querySelector('button') as HTMLButtonElement).click(); f.detectChanges();
    const opts = Array.from(el.querySelectorAll('li[role=option]'));
    expect(opts.length).toBe(11); expect(opts[0].textContent).toContain('No minimum');
    (opts[0] as HTMLElement).click(); expect(seen).toEqual([0]);
  });
  it('without allowNone the list stays 1 to 10', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect);
    f.componentRef.setInput('value', 3); f.detectChanges();
    (f.nativeElement.querySelector('button') as HTMLButtonElement).click(); f.detectChanges();
    expect(f.nativeElement.querySelectorAll('li[role=option]').length).toBe(10);
  });
  it('reachableLevel ignores unusable chains; levelChains marks disabled and simulated ones', () => {
    expect(reachableLevel(CH, 8)).toBe(true); expect(reachableLevel(CH, 9)).toBe(false); expect(reachableLevel(CH, 0)).toBe(true);
    const out = levelChains({ methods: [{ id: 'a', name: 'A', enabled: true }, { id: 'b', name: 'B', enabled: false }], chains: [{ id: 'c1', name: 'C1', steps: ['a'], level: 4 }, { id: 'c2', name: 'C2', steps: ['b'], level: 9 }, { id: 'c3', name: 'C3', steps: ['a'], level: 7 }] },
      [{ id: 'c1', effectiveLevel: 4, simulatedSteps: [] }, { id: 'c2', effectiveLevel: 9, simulatedSteps: [] }, { id: 'c3', effectiveLevel: 7, simulatedSteps: ['a'] }]);
    expect(out.map((c) => [c.usable, c.why])).toEqual([[true, undefined], [false, 'disabled'], [false, 'simulated step']]);
  });
  function open(restrict: boolean, value = 5) {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect);
    f.componentRef.setInput('value', value); f.componentRef.setInput('chains', CH); f.componentRef.setInput('restrict', restrict); f.detectChanges();
    const seen: number[] = []; f.componentInstance.valueChange.subscribe((n) => seen.push(n));
    (f.nativeElement.querySelector('button') as HTMLButtonElement).click(); f.detectChanges();
    return { f, seen, el: f.nativeElement as HTMLElement };
  }
  it('consumer: unreachable levels are disabled and cannot be picked; reachable ones can', () => {
    const { f, seen, el } = open(true);
    const o = (n: number) => el.querySelector(`li[data-level="${n}"]`) as HTMLElement;
    expect(o(10).getAttribute('aria-disabled')).toBe('true'); expect(o(9).getAttribute('aria-disabled')).toBe('true'); expect(o(8).getAttribute('aria-disabled')).toBeNull();
    o(10).click(); f.detectChanges(); expect(seen).toEqual([]);
    o(8).click(); expect(seen).toEqual([8]);
  });
  it('declaring editor: nothing is disabled, the tooltip is informational', () => {
    const { f, seen, el } = open(false);
    expect(el.querySelectorAll('li[aria-disabled]').length).toBe(0);
    (el.querySelector('li[data-level="10"]') as HTMLElement).click(); expect(seen).toEqual([10]);
    f.detectChanges();
  });
  it('tooltip follows hover and the active option, lists chains, and the button points at it', () => {
    const { f, el } = open(true);
    (el.querySelector('li[data-level="8"]') as HTMLElement).dispatchEvent(new Event('mouseenter')); f.detectChanges();
    const tip = tipEl() as HTMLElement;
    expect(tip.getAttribute('data-for')).toBe('8'); expect(tip.textContent).toContain('Password + code'); expect(tip.textContent).toContain('declared level 8 of 10');
    expect(el.querySelector('button')!.getAttribute('aria-describedby')).toBe(tip.id);
    (el.querySelector('li[data-level="10"]') as HTMLElement).dispatchEvent(new Event('mouseenter')); f.detectChanges();
    expect(tipEl()!.textContent).toContain('No enabled chain');
  });
  it('closed: tooltip on hover of the button; keyboard focus too; gone otherwise', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect); f.componentRef.setInput('value', 3); f.componentRef.setInput('chains', CH); f.detectChanges();
    const b = f.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(tipEl()).toBeNull();
    b.dispatchEvent(new Event('mouseenter')); f.detectChanges(); expect(tipEl()).not.toBeNull();
    b.dispatchEvent(new Event('mouseleave')); f.detectChanges(); expect(tipEl()).toBeNull();
    (b as any).matches = () => true; b.dispatchEvent(new Event('focus')); f.detectChanges(); expect(tipEl()).not.toBeNull();
    b.dispatchEvent(new Event('blur')); f.detectChanges(); expect(tipEl()).toBeNull();
    (b as any).matches = () => false; b.dispatchEvent(new Event('focus')); f.detectChanges(); expect(tipEl()).toBeNull();
  });
  it('a saved unreachable level stays selected with a warning', () => {
    const { el } = open(true, 10);
    expect(el.querySelector('.ls-warn')!.textContent).toContain('Level 10 is saved'); expect(el.querySelector('button b')!.textContent).toContain('10');
  });
  it('touch: first tap on another option only shows its tooltip (emulated mouseenter included), a tap on the active option picks', () => {
    const { f, seen, el } = open(true);
    const o8 = el.querySelector('li[data-level="8"]') as HTMLElement;
    down(o8, 'touch'); o8.dispatchEvent(new Event('mouseenter')); o8.click(); f.detectChanges();
    expect(seen).toEqual([]); expect(tipEl()!.getAttribute('data-for')).toBe('8');
    down(o8, 'touch'); o8.dispatchEvent(new Event('mouseenter')); o8.click(); expect(seen).toEqual([8]);
  });
  it('touch: a cancelled gesture (scroll) never picks; the next tap starts again', () => {
    const { f, seen, el } = open(true);
    const o7 = el.querySelector('li[data-level="7"]') as HTMLElement;
    down(o7, 'touch'); o7.dispatchEvent(new Event('pointercancel')); o7.click(); f.detectChanges();
    expect(seen).toEqual([]);
  });
  it('mouse picks at once', () => {
    const { el, seen } = open(true); const o = el.querySelector('li[data-level="7"]') as HTMLElement; down(o, 'mouse'); o.click(); expect(seen).toEqual([7]);
  });
  it('Escape hides the tooltip even when the list is closed, and hovering again shows it', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect); f.componentRef.setInput('value', 3); f.componentRef.setInput('chains', CH); f.detectChanges();
    const b = f.nativeElement.querySelector('button') as HTMLButtonElement;
    b.dispatchEvent(new Event('mouseenter')); f.detectChanges(); expect(tipEl()).not.toBeNull();
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); f.detectChanges(); expect(tipEl()).toBeNull();
    b.dispatchEvent(new Event('mouseleave')); b.dispatchEvent(new Event('mouseenter')); f.detectChanges(); expect(tipEl()).not.toBeNull();
  });
  it('touch hover emulation on the closed button never shows a tooltip over the page', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect); f.componentRef.setInput('value', 3); f.componentRef.setInput('chains', CH); f.detectChanges();
    const b = f.nativeElement.querySelector('button') as HTMLButtonElement;
    down(b, 'touch'); b.dispatchEvent(new Event('mouseenter')); f.detectChanges(); expect(tipEl()).toBeNull();
  });
  it('the tooltip is an overlay placed inside the viewport (never past the right edge), and not in the component', async () => {
    const { f, el } = open(true);
    const rect = (l: number, r: number) => ({ left: l, right: r, top: 100, bottom: 400, width: r - l, height: 300, x: l, y: 100, toJSON() {} }) as DOMRect;
    (el.querySelector('.ls-list') as HTMLElement).getBoundingClientRect = () => rect(window.innerWidth - 400, window.innerWidth - 10);
    (el.querySelector('li[data-level="8"]') as HTMLElement).dispatchEvent(new Event('mouseenter')); f.detectChanges(); TestBed.flushEffects?.(); await Promise.resolve(); await Promise.resolve();
    const tip = tipEl()!; expect(el.contains(tip)).toBe(false);
    const left = parseFloat(tip.style.left), w = parseFloat(tip.style.width);
    expect(left).toBeGreaterThanOrEqual(8); expect(left + w).toBeLessThanOrEqual(window.innerWidth - 8);
  });
  it('unreachable chains are struck and dimmed in the tooltip', () => {
    const { f, el } = open(true);
    (el.querySelector('li[data-level="8"]') as HTMLElement).dispatchEvent(new Event('mouseenter')); f.detectChanges();
    const states = Array.from(tipEl()!.querySelectorAll('li.tc')).map((x) => [x.textContent!.includes('Badge'), x.getAttribute('data-state')]);
    expect(states.find((s) => s[0])![1]).toBe('dim'); expect(tipEl()!.querySelectorAll('li.tc[data-state=ok]').length).toBe(1);
  });
  it('same rule as the server on the shared fixture (chain flag, disabled method, simulated step)', () => {
    for (const [name, v] of Object.entries(REACHABLE_FIXTURE)) {
      const chains = levelChains(JSON.parse(JSON.stringify(v.cfg)), JSON.parse(JSON.stringify(v.analyses)));
      const got = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [String(n), reachableLevel(chains, n)]));
      expect(got, name).toEqual(v.reachable);
    }
  });
  it('chains that could not be loaded say so, which is not the same as no chain; nothing is disabled', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect); f.componentRef.setInput('value', 5); f.componentRef.setInput('restrict', true); f.componentRef.setInput('chainsError', true); f.detectChanges();
    (f.nativeElement.querySelector('button') as HTMLButtonElement).click(); f.detectChanges();
    expect(f.nativeElement.querySelectorAll('li[aria-disabled]').length).toBe(0); expect(tipEl()!.textContent).toContain('could not be loaded');
    f.componentRef.setInput('chainsError', false); f.detectChanges(); expect(tipEl()!.textContent).toContain('No sign-in chain is defined');
  });
  it('inside a wrapping <label>, a click on an option does not re-activate the button (the list stays open)', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect);
    f.componentRef.setInput('value', 3); f.detectChanges();
    const label = document.createElement('label'); document.body.appendChild(label); label.appendChild(f.nativeElement);
    (f.nativeElement.querySelector('button') as HTMLElement).click(); f.detectChanges();
    expect(f.nativeElement.querySelector('.ls-list')).toBeTruthy();
    // a label default action would have clicked the button again and toggled the list
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    (f.nativeElement.querySelector('li[data-level="5"]') as HTMLElement).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    label.remove();
  });
});
