import { Directive, ElementRef, OnDestroy, OnInit, Renderer2, inject } from '@angular/core';

let nextId = 0;

/**
 * Show/hide control for every password or secret input. Attribute selector on `input[type=password]` (a static type), so one import
 * covers a template. It only flips the input's own `type` between `password` and `text`: it reveals what is being typed right now and
 * nothing else. Stored secrets are write-only and never prefilled, so there is nothing stored to reveal. Hidden by default, and hidden
 * again when the field is left or the page is hidden. The button is a real, focusable button with an accessible name and `aria-pressed`.
 * Disabled preview inputs (the login screen preview) get no control.
 */
@Directive({ selector: 'input[type=password]:not([disabled])' })
export class RevealPassword implements OnInit, OnDestroy {
  private readonly el = inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
  private readonly r = inject(Renderer2);
  private wrap?: HTMLElement;
  private btn?: HTMLButtonElement;
  private off: Array<() => void> = [];

  ngOnInit() {
    const parent = this.el.parentNode as HTMLElement | null;
    if (!parent) return;
    const wrap = this.r.createElement('span') as HTMLElement;
    this.r.addClass(wrap, 'reveal-wrap');
    this.r.insertBefore(parent, wrap, this.el);
    this.r.appendChild(wrap, this.el);
    const btn = this.r.createElement('button') as HTMLButtonElement;
    this.r.setAttribute(btn, 'type', 'button');
    this.r.addClass(btn, 'reveal-btn');
    this.r.setAttribute(btn, 'id', `reveal-${++nextId}`);
    this.r.appendChild(wrap, btn);
    this.wrap = wrap; this.btn = btn;
    this.paint(false);
    // A click keeps focus in the field (no blur before the toggle, Safari included). Focus leaving the field AND its button hides again.
    this.off.push(this.r.listen(btn, 'mousedown', (e: Event) => e.preventDefault()));
    this.off.push(this.r.listen(btn, 'click', () => this.paint(this.el.type === 'password')));
    this.off.push(this.r.listen(wrap, 'focusout', (e: FocusEvent) => { const to = e.relatedTarget as Node | null; if (!to || !wrap.contains(to)) this.paint(false); }));
    this.off.push(this.r.listen('document', 'visibilitychange', () => { if (document.hidden) this.paint(false); }));
  }

  private paint(show: boolean) {
    if (!this.btn) return;
    this.el.type = show ? 'text' : 'password';
    this.r.setAttribute(this.btn, 'aria-pressed', String(show));
    this.r.setAttribute(this.btn, 'aria-label', show ? 'Hide what you typed' : 'Show what you typed');
    this.r.setAttribute(this.btn, 'title', show ? 'Hide what you typed' : 'Show what you typed');
    this.btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>' + (show ? '<path d="m3 3 18 18"/>' : '') + '</svg>';
  }

  ngOnDestroy() { for (const f of this.off) f(); this.off = []; if (this.el.type !== 'password') this.el.type = 'password'; void this.wrap; }
}
