import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { AdminPreviewPage, previewLayout } from './admin-preview';
import { Theme } from './theme';

describe('admin console preview layout', () => {
  it('stacks the console only when the width toggle asks for mobile, never from the iframe viewport', () => {
    expect(previewLayout('?preview=1')).toBe('desktop');
    expect(previewLayout('?preview=1&width=mobile')).toBe('mobile');
    const fixture = TestBed.createComponent(AdminPreviewPage);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.layout').classList.contains('mobile')).toBe(false);
    (fixture.componentInstance as any).mobile.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.layout').classList.contains('mobile')).toBe(true);
  });
  it('opens the mobile navigation as an overlay drawer, like the real shell', () => {
    const fixture = TestBed.createComponent(AdminPreviewPage);
    fixture.detectChanges();
    (fixture.componentInstance as any).mobile.set(true);
    fixture.detectChanges();
    const layout = fixture.nativeElement.querySelector('.layout');
    expect(layout.classList.contains('open')).toBe(false);
    fixture.nativeElement.querySelector('.burger').click();
    fixture.detectChanges();
    expect(layout.classList.contains('open')).toBe(true);
    fixture.nativeElement.querySelector('.scrim').click();
    fixture.detectChanges();
    expect(layout.classList.contains('open')).toBe(false);
  });
});
describe('admin console preview', () => {
  it('applies a preview message from the parent frame and follows its mode without persisting', () => {
    localStorage.removeItem('iam.theme');
    const fixture = TestBed.createComponent(AdminPreviewPage);
    const bundle = { type: 'iam-branding-preview', dark: true, theme: { light: { '--accent': '#006b5f' }, dark: { '--accent': '#80d5c5' } }, config: { productName: 'Forest', baseline: 'Identity', footer: 'Demo' } };
    (fixture.componentInstance as unknown as { onMessage(ev: unknown): void }).onMessage({ origin: location.origin, source: window.parent, data: bundle });
    expect(document.getElementById('iam-branding-preview')?.textContent).toContain('--accent:#80d5c5');
    expect(TestBed.inject(Theme).mode()).toBe('dark');
    expect(localStorage.getItem('iam.theme')).toBeNull();
    document.getElementById('iam-branding-preview')?.remove();
  });
  it('ignores messages from another origin', () => {
    const fixture = TestBed.createComponent(AdminPreviewPage);
    (fixture.componentInstance as unknown as { onMessage(ev: unknown): void }).onMessage({ origin: 'https://evil.example', source: window.parent, data: { type: 'iam-branding-preview', dark: false, theme: { light: { '--accent': '#006b5f' }, dark: { '--accent': '#80d5c5' } }, config: { productName: 'x', baseline: '', footer: '' } } });
    expect(document.getElementById('iam-branding-preview')).toBeNull();
  });
});
