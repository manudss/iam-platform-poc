import { TestBed } from '@angular/core/testing';
import { ApplyDialog } from './apply-dialog';

describe('HTML Apply confirmation', () => {
  function setup() {
    const f = TestBed.createComponent(ApplyDialog); f.detectChanges();
    const d = f.nativeElement.querySelector('dialog') as HTMLDialogElement;
    d.showModal = vi.fn(() => d.setAttribute('open', ''));
    d.close = vi.fn(() => d.removeAttribute('open'));
    return { f, d, c: f.componentInstance };
  }
  it('opens modally with the branch, defaults to Cancel and confirms only with Apply', async () => {
    const { f, d, c } = setup(); const result = c.confirm('personal/alice'); f.detectChanges();
    expect(d.showModal).toHaveBeenCalledOnce(); expect(d.textContent).toContain('personal/alice');
    expect(d.querySelector('[autofocus]')?.textContent).toContain('Cancel');
    (d.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(await result).toBe(true); expect(d.close).toHaveBeenCalledOnce();
  });
  it('Escape cancels and a second confirmation cannot replace the first', async () => {
    const { d, c } = setup(); const result = c.confirm('personal/alice');
    expect(await c.confirm('personal/bob')).toBe(false);
    d.dispatchEvent(new Event('cancel')); expect(await result).toBe(false);
  });
  it('closing or destroying the dialog cancels pending work', async () => {
    const { f, d, c } = setup(); const result = c.confirm('personal/alice');
    d.dispatchEvent(new Event('close')); expect(await result).toBe(false);
    const next = c.confirm('personal/alice'); f.destroy(); expect(await next).toBe(false);
  });
});
