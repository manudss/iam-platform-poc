import { Component, ElementRef, HostListener, effect, inject, signal, viewChild } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { isPersonalArea } from './route-scope';
import { canOpen } from './access';
import { Session } from './session';
import { PluginScreenLoader } from './plugin-screen';

/** Shell-owned window. Its packaged content and API guards remain the enabled plugin's. */
@Component({
  selector: 'app-floating-assistant',
  template: `@if(available()) {
    <button id="ai-launcher" type="button" aria-label="Open AI assistant. Drag to an edge or use arrow keys to move."
      [attr.aria-expanded]="opened()" aria-controls="ai-floating-window" [style.left.px]="launcher.x" [style.top.px]="launcher.y"
      (pointerdown)="begin($event, 'launcher')" (click)="toggle()" (keydown)="key($event, 'launcher')">✦<span>AI</span></button>
    <section id="ai-floating-window" role="dialog" aria-label="AI assistant" [hidden]="!opened()"
      [style.left.px]="panel.x" [style.top.px]="panel.y">
      <header (pointerdown)="begin($event, 'panel')">
        <span tabindex="0" role="button" aria-label="Move chat window with arrow keys" (keydown)="key($event, 'panel')">⠿ AI assistant</span>
        <button type="button" aria-label="Minimize AI assistant" (click)="minimize()">−</button>
      </header>
      <div class="body"><p role="alert">{{problem()}}</p><div #mount></div></div>
    </section>
  }`,
  styleUrl: './floating-assistant.css',
})
export class FloatingAssistant {
  private readonly s = inject(Session);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly router = inject(Router);
  private readonly loader = inject(PluginScreenLoader);
  private readonly mount = viewChild<ElementRef<HTMLElement>>('mount');
  readonly available = signal(false);
  readonly opened = signal(false);
  readonly problem = signal('');
  launcher = { x: Math.max(8, (typeof window === 'undefined' ? 1024 : window.innerWidth) - 76), y: Math.max(8, (typeof window === 'undefined' ? 768 : window.innerHeight) - 84) };
  panel = { x: Math.max(8, (typeof window === 'undefined' ? 1024 : window.innerWidth) - 438), y: Math.max(8, (typeof window === 'undefined' ? 768 : window.innerHeight) - 664) };
  private request = 0;
  private component = '';
  private loading = 0;
  private element?: HTMLElement & { context?: unknown };
  private drag?: { kind: 'launcher' | 'panel'; x: number; y: number; startX: number; startY: number; moved: boolean };
  private suppressClick = false;
  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem('iam-chat-positions') ?? 'null');
      for (const kind of ['launcher', 'panel'] as const) if (Number.isFinite(saved?.[kind]?.x) && Number.isFinite(saved?.[kind]?.y)) this[kind] = saved[kind];
    } catch { /* geometry is optional */ }
    this.resize();
    if (typeof window !== 'undefined') {
      window.visualViewport?.addEventListener('resize', this.viewportChanged);
      window.visualViewport?.addEventListener('scroll', this.viewportChanged);
    }
    this.router.events.pipe(takeUntilDestroyed()).subscribe(e => {
      if (e instanceof NavigationEnd && !isPersonalArea(e.urlAfterRedirects) && !this.available()) void this.discover(this.request);
    });
    effect(() => {
      this.s.pluginsVersion(); this.s.branchEpoch(); this.s.adminToken(); this.s.access(); this.s.loggedIn();
      const req = ++this.request;
      this.dispose(); this.available.set(false); this.opened.set(false); this.component = '';
      if (this.s.loggedIn() && this.s.access()?.admin && canOpen(this.s.access(), 'mcp') && this.s.branch()) void this.discover(req);
    });
    effect(() => { const mount = this.mount(); if (mount && this.opened() && !this.element) void this.show(mount.nativeElement, this.request); });
  }
  private async discover(req: number) {
    if (isPersonalArea(this.router.url) || !this.s.loggedIn() || !this.s.access()?.admin || !canOpen(this.s.access(), 'mcp') || !this.s.branch()) return;
    try {
      const r = await this.s.api.raw<{ screens: { plugin: string; id: string; render: string; component?: string }[] }>('GET', '/plugins/screens', undefined, this.headers());
      if (req !== this.request || r.status >= 400) return;
      const sc = r.data.screens?.find(x => x.plugin === 'ai-assistant' && x.id === 'chat' && x.render === 'component');
      if (sc?.component) { this.component = sc.component; this.available.set(true); }
    } catch { /* fail closed when disabled or rights cannot be read */ }
  }
  private headers(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  private async show(mount: HTMLElement, req: number) {
    if (this.loading === req) return;
    this.loading = req; this.problem.set('');
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.s.api.bearerToken}`, 'x-iam-branch': this.s.branch() };
      const mod = await this.loader.load(`/api/tenants/${encodeURIComponent(this.s.api.tenant)}/plugins/ai-assistant/assets/${this.component.split('/').map(encodeURIComponent).join('/')}`, headers);
      if (req !== this.request || !this.available()) return;
      if (!mod.default || !mod.default.includes('-')) throw new Error('Invalid screen module');
      const el = document.createElement(mod.default) as HTMLElement & { context?: unknown };
      el.setAttribute('compact', '');
      el.context = { tenant: this.s.api.tenant, api: `/api/tenants/${this.s.api.tenant}`, token: this.s.api.bearerToken, adminToken: this.s.adminToken(), branch: this.s.branch() };
      this.element = el; mount.replaceChildren(el);
    } catch { if (req === this.request) this.problem.set('Chat could not be loaded. Minimize and reopen to retry.'); }
    finally { if (this.loading === req) this.loading = 0; }
  }
  toggle() { if (this.suppressClick) { this.suppressClick = false; return; } this.opened.update(v => !v); }
  minimize() { this.opened.set(false); document.getElementById('ai-launcher')?.focus(); }
  begin(e: PointerEvent, kind: 'launcher' | 'panel') {
    if (e.button !== 0 || (kind === 'panel' && (e.target as HTMLElement).closest('button'))) return;
    this.drag = { kind, x: e.clientX, y: e.clientY, startX: this[kind].x, startY: this[kind].y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  @HostListener('document:pointermove', ['$event']) move(e: PointerEvent) {
    const d = this.drag; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) > 5) d.moved = true;
    if (d.moved) { this[d.kind] = { x: d.startX + dx, y: d.startY + dy }; this.clamp(d.kind); }
  }
  @HostListener('document:pointerup') end() {
    const d = this.drag; this.drag = undefined;
    if (!d?.moved) return;
    this.snap(d.kind); if (d.kind === 'launcher') { this.suppressClick = true; setTimeout(() => this.suppressClick = false, 0); }
    this.save();
  }
  @HostListener('document:pointercancel') cancel() { this.drag = undefined; }
  key(e: KeyboardEvent, kind: 'launcher' | 'panel') {
    const delta: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
    if (!delta[e.key]) return; e.preventDefault();
    const [x, y] = delta[e.key]; this[kind] = { x: this[kind].x + x, y: this[kind].y + y }; this.clamp(kind); this.save();
  }
  private viewportChanged = () => this.resize();
  private bounds(kind: 'launcher' | 'panel') {
    return { x: Math.max(8, (typeof innerWidth === 'undefined' ? 1024 : innerWidth) - (kind === 'launcher' ? 60 : Math.min(420, (typeof innerWidth === 'undefined' ? 1024 : innerWidth) - 16)) - 8), y: Math.max(8, (typeof window === 'undefined' ? 768 : (window.visualViewport?.height ?? innerHeight)) - (kind === 'launcher' ? 60 : Math.min(640, (typeof window === 'undefined' ? 768 : (window.visualViewport?.height ?? innerHeight)) - 16)) - 8) };
  }
  private clamp(kind: 'launcher' | 'panel') { const b = this.bounds(kind), p = this[kind]; this[kind] = { x: Math.min(b.x, Math.max(8, p.x)), y: Math.min(b.y, Math.max(8, p.y)) }; }
  private snap(kind: 'launcher' | 'panel') {
    this.clamp(kind); const p = this[kind], b = this.bounds(kind);
    const ds = [p.x - 8, b.x - p.x, p.y - 8, b.y - p.y];
    const side = ds.indexOf(Math.min(...ds));
    this[kind] = { x: side === 0 ? 8 : side === 1 ? b.x : p.x, y: side === 2 ? 8 : side === 3 ? b.y : p.y };
  }
  private save() { try { localStorage.setItem('iam-chat-positions', JSON.stringify({ launcher: this.launcher, panel: this.panel })); } catch { /* no persistence required */ } }
  @HostListener('window:resize') resize() { if (typeof window !== 'undefined' && typeof document !== 'undefined') this.host.nativeElement.style.setProperty('--ai-viewport-height', `${window.visualViewport?.height ?? innerHeight}px`); this.clamp('launcher'); this.clamp('panel'); }
  @HostListener('document:keydown.escape') escape() { if (this.opened()) this.minimize(); }
  private dispose() { this.element?.remove(); this.element = undefined;  }
  ngOnDestroy() { if (typeof window !== 'undefined') { window.visualViewport?.removeEventListener('resize', this.viewportChanged); window.visualViewport?.removeEventListener('scroll', this.viewportChanged); } ++this.request; this.dispose(); }
}
