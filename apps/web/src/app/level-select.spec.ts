import { TestBed } from '@angular/core/testing';
import { LevelChain, LevelSelect, levelChains, reachableLevel } from './level-select';

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
    const tip = el.querySelector('[role=tooltip]') as HTMLElement;
    expect(tip.getAttribute('data-for')).toBe('8'); expect(tip.textContent).toContain('Password + code'); expect(tip.textContent).toContain('declared level 8 of 10');
    expect(el.querySelector('button')!.getAttribute('aria-describedby')).toBe(tip.id);
    (el.querySelector('li[data-level="10"]') as HTMLElement).dispatchEvent(new Event('mouseenter')); f.detectChanges();
    expect(el.querySelector('[role=tooltip]')!.textContent).toContain('No enabled chain');
  });
  it('closed: tooltip on hover of the button; keyboard focus too; gone otherwise', () => {
    TestBed.configureTestingModule({ imports: [LevelSelect] });
    const f = TestBed.createComponent(LevelSelect); f.componentRef.setInput('value', 3); f.componentRef.setInput('chains', CH); f.detectChanges();
    const b = f.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(f.nativeElement.querySelector('[role=tooltip]')).toBeNull();
    b.dispatchEvent(new Event('mouseenter')); f.detectChanges(); expect(f.nativeElement.querySelector('[role=tooltip]')).not.toBeNull();
    b.dispatchEvent(new Event('mouseleave')); f.detectChanges(); expect(f.nativeElement.querySelector('[role=tooltip]')).toBeNull();
    b.dispatchEvent(new Event('focus')); f.detectChanges(); expect(f.nativeElement.querySelector('[role=tooltip]')).not.toBeNull();
  });
  it('a saved unreachable level stays selected with a warning', () => {
    const { el } = open(true, 10);
    expect(el.querySelector('.ls-warn')!.textContent).toContain('Level 10 is saved'); expect(el.querySelector('button b')!.textContent).toContain('10');
  });
  it('touch: first tap shows the tooltip, second tap picks', () => {
    const { f, seen, el } = open(true);
    const o8 = el.querySelector('li[data-level="8"]') as HTMLElement;
    o8.dispatchEvent(new Event('touchstart')); o8.click(); f.detectChanges();
    expect(seen).toEqual([]); expect(el.querySelector('[role=tooltip]')!.getAttribute('data-for')).toBe('8');
    o8.dispatchEvent(new Event('touchstart')); o8.click(); expect(seen).toEqual([8]);
  });
});
