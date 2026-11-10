import {TestBed} from '@angular/core/testing';
import {describe,it,expect} from 'vitest';
import {Branding} from './branding';

describe('whole-console branding',()=>{
 it('updates root tokens and brand assets without changing the admin theme choice',()=>{
  const branding=TestBed.inject(Branding);
  document.documentElement.dataset['theme']='dark';
  const bundle={theme:{light:{'--sidebar-bg':'#00201c','--accent':'#006b5f'},dark:{'--sidebar-bg':'#00201c','--accent':'#80d5c5'}},config:{productName:'Forest',baseline:'Identity',footer:'Demo'},logos:{'logo-horizontal-light.svg':'<svg/>','logo-horizontal-dark.svg':'<svg/>'}};
  expect(branding.applyBundle(bundle)).toBe(true);
  expect(document.documentElement.dataset['theme']).toBe('dark');
  expect(document.getElementById('iam-branding-preview')?.textContent).toContain('--sidebar-bg:#00201c');
  expect(document.getElementById('iam-branding-preview')?.textContent).toContain('--accent:#80d5c5');
  expect(branding.profile().productName).toBe('Forest');
  expect(branding.logo('dark')).toMatch(/^data:image\/svg\+xml,/);
  document.getElementById('iam-branding-preview')?.remove();
 });
 it('refuses CSS injection before modifying the console',()=>{
  const branding=TestBed.inject(Branding);
  expect(branding.applyBundle({theme:{light:{'--accent':'red;display:none'},dark:{}},config:{productName:'x',baseline:'',footer:''}})).toBe(false);
  expect(document.getElementById('iam-branding-preview')).toBeNull();
 });
});
