import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { AdminPreviewPage } from './admin-preview';
import { Theme } from './theme';

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
