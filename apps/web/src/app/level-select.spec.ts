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
});
