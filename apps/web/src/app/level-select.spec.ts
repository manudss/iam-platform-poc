import { TestBed } from '@angular/core/testing';
import { LevelSelect } from './level-select';

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
});
