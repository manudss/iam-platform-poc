import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { RevealPassword } from './reveal-password';

@Component({ imports: [FormsModule, RevealPassword], template: `
  <input id="a" type="password" name="a" [(ngModel)]="v" />
  <input id="b" type="password" name="b" disabled placeholder="preview" />
  <input id="c" type="text" name="c" />` })
class Host { v = 'typed-secret'; }

describe('RevealPassword', () => {
  const mount = () => { TestBed.configureTestingModule({ imports: [Host] }); const f = TestBed.createComponent(Host); f.detectChanges(); return f; };
  it('is hidden by default and gives a labelled, focusable button', () => {
    const f = mount(); const el: HTMLElement = f.nativeElement;
    const a = el.querySelector('#a') as HTMLInputElement; const btn = el.querySelector('.reveal-btn') as HTMLButtonElement;
    expect(a.type).toBe('password'); expect(btn).toBeTruthy();
    expect(btn.getAttribute('type')).toBe('button'); expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Show what you typed');
  });
  it('toggles only the input type, then hides again on blur and on destroy', () => {
    const f = mount(); const el: HTMLElement = f.nativeElement;
    const a = el.querySelector('#a') as HTMLInputElement; const btn = el.querySelector('.reveal-btn') as HTMLButtonElement;
    btn.click(); expect(a.type).toBe('text'); expect(btn.getAttribute('aria-pressed')).toBe('true'); expect(btn.getAttribute('aria-label')).toBe('Hide what you typed');
    const wrap = a.closest('.reveal-wrap')!;
    wrap.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: btn })); expect(a.type).toBe('text');   // moving to the button keeps it
    wrap.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })); expect(a.type).toBe('password');
    btn.click(); expect(a.type).toBe('text'); f.destroy(); expect(a.type).toBe('password');
  });
  it('a mouse press on the button does not take focus from the field (no blur before the click)', () => {
    const f = mount(); const btn = (f.nativeElement as HTMLElement).querySelector('.reveal-btn') as HTMLButtonElement;
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); btn.dispatchEvent(ev); expect(ev.defaultPrevented).toBe(true);
  });
  it('adds no control to disabled previews or to text inputs', () => {
    const f = mount(); const el: HTMLElement = f.nativeElement;
    expect(el.querySelectorAll('.reveal-btn').length).toBe(1);
    expect(el.querySelector('#b')!.closest('.reveal-wrap')).toBeNull(); expect(el.querySelector('#c')!.closest('.reveal-wrap')).toBeNull();
  });
});
