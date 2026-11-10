import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { WbTab, WbTabs, filterPlaceholders, insertPlaceholder, phTokenAt } from './workflows';

describe('placeholder picker helpers', () => {
  it('finds the unfinished {{ token at the caret, and only then', () => {
    expect(phTokenAt('hello ', 6)).toBeNull();
    expect(phTokenAt('a {{', 4)).toEqual({ start: 2, text: '' });
    expect(phTokenAt('a {{event.su', 12)).toEqual({ start: 2, text: 'event.su' });
    expect(phTokenAt('{{event.subject}} done', 17)).toBeNull(); // already closed
    expect(phTokenAt('x {{a\nb', 7)).toBeNull(); // a newline ends the token
    expect(phTokenAt('{{a {{b', 7)).toEqual({ start: 4, text: 'b' }); // the last open wins
  });
  it('filters placeholders by the typed token, prefix matches first, capped at 8', () => {
    const list = ['{{event.subject}}', '{{event.email}}', '{{steps.grant.role}}', '{{steps.grant.subjectKey}}'];
    expect(filterPlaceholders(list, '')).toEqual(list);
    expect(filterPlaceholders(list, 'event.su')).toEqual(['{{event.subject}}']);
    expect(filterPlaceholders(list, 'subject')).toEqual(['{{event.subject}}', '{{steps.grant.subjectKey}}']);
    expect(filterPlaceholders(list, 'zzz')).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `{{event.k${i}}}`);
    expect(filterPlaceholders(many, '').length).toBe(8);
  });
  it('inserts the full placeholder over the token and places the caret after it', () => {
    expect(insertPlaceholder('say {{ev now', 8, 4, '{{event.subject}}')).toEqual({ value: 'say {{event.subject}} now', caret: 21 });
    expect(insertPlaceholder('ab', 2, 2, '{{x}}')).toEqual({ value: 'ab{{x}}', caret: 7 }); // append at caret
  });
});

describe('workbench tabs', () => {
  const nav: string[] = [];
  let router: { url: string; navigateByUrl: (u: string) => Promise<boolean> };
  let tabs: WbTabs;
  const wf = (id: string, label = id): WbTab => ({ kind: 'workflow', id, label });

  beforeEach(() => {
    localStorage.clear();
    nav.length = 0;
    router = { url: '/workflows/edit/a', navigateByUrl: (u: string) => { nav.push(u); router.url = u; return Promise.resolve(true); } };
    TestBed.configureTestingModule({ providers: [{ provide: Router, useValue: router }] });
    tabs = TestBed.inject(WbTabs);
  });

  it('registers open objects once, most recently opened last', () => {
    tabs.open('workflow', 'a', 'Joiner');
    tabs.open('run', 'r1', 'Joiner #3');
    tabs.open('workflow', 'a', 'Joiner');
    expect(tabs.tabs()).toEqual([{ kind: 'run', id: 'r1', label: 'Joiner #3' }, wf('a', 'Joiner')]);
    expect(tabs.urlOf(wf('a'))).toBe('/workflows/edit/a');
    expect(tabs.urlOf({ kind: 'run', id: 'r1', label: '' })).toBe('/workflows/run/r1');
  });

  it('persists to localStorage and survives a reload', () => {
    tabs.open('workflow', 'a', 'Joiner');
    const raw = JSON.parse(localStorage.getItem('wf-workbench-tabs') ?? '[]') as WbTab[];
    expect(raw).toEqual([wf('a', 'Joiner')]);
  });

  it('renames a tab and replaces the new-workflow tab after the first save', () => {
    tabs.open('workflow', 'new', 'New workflow');
    tabs.replace(wf('new'), wf('wf-1', 'Joiner'));
    expect(tabs.tabs()).toEqual([wf('wf-1', 'Joiner')]);
    tabs.rename('workflow', 'wf-1', 'Joiner v2');
    expect(tabs.tabs()[0].label).toBe('Joiner v2');
  });

  it('closing the current tab navigates to the previous one, or to the list when none remains', () => {
    tabs.open('workflow', 'a', 'A'); tabs.open('workflow', 'b', 'B');
    router.url = '/workflows/edit/b';
    tabs.close(wf('b'));
    expect(nav).toEqual(['/workflows/edit/a']);
    tabs.close(wf('a'));
    expect(nav).toEqual(['/workflows/edit/a', '/workflows']);
  });

  it('closing a background tab does not navigate', () => {
    tabs.open('workflow', 'a', 'A'); tabs.open('workflow', 'b', 'B');
    router.url = '/workflows/edit/b';
    tabs.close(wf('a'));
    expect(nav).toEqual([]);
    expect(tabs.tabs()).toEqual([wf('b', 'B')]);
  });
});
