import { Component, ElementRef, ViewChild, signal } from '@angular/core';

/** Browser-rendered confirmation: keyboard focus, Escape and focus restoration use native dialog semantics. */
@Component({ selector: 'app-apply-dialog', template: `
  <dialog #dialog aria-labelledby="apply-dialog-title" (cancel)="finish(false)" (close)="finish(false)">
    <h3 id="apply-dialog-title">Apply {{ branch() }} to main?</h3>
    <p>Its users, plugins and role permissions will become live.</p>
    <form method="dialog" (submit)="$event.preventDefault()">
      <button type="button" class="secondary" autofocus (click)="finish(false)">Cancel</button>
      <button type="button" (click)="finish(true)">Apply to main</button>
    </form>
  </dialog>
`, styles: [`
  dialog { color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: .7rem; padding: 1.25rem; max-width: min(32rem, calc(100vw - 2rem)); }
  dialog::backdrop { background: var(--scrim); }
  h3 { margin-top: 0; overflow-wrap: anywhere; }
  form { display: flex; justify-content: flex-end; gap: .5rem; }
`] })
export class ApplyDialog {
  @ViewChild('dialog', { static: true }) private dialog!: ElementRef<HTMLDialogElement>;
  readonly branch = signal('');
  private resolve: ((confirmed: boolean) => void) | null = null;
  confirm(branch: string): Promise<boolean> {
    if (this.resolve) return Promise.resolve(false);
    this.branch.set(branch);
    return new Promise(resolve => { this.resolve = resolve; this.dialog.nativeElement.showModal(); });
  }
  finish(confirmed: boolean) {
    const resolve = this.resolve; this.resolve = null;
    if (this.dialog.nativeElement.open) this.dialog.nativeElement.close();
    resolve?.(confirmed);
  }
  ngOnDestroy() { this.finish(false); }
}
