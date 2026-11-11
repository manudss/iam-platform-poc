import { isPlatformBrowser } from '@angular/common';
import { Component, PLATFORM_ID, PendingTasks, TransferState, computed, effect, inject, makeStateKey, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface LaunchpadApp { id: string; name: string; description: string; protocol: 'oidc' | 'saml'; url: string; logo?: string | null }
export interface LaunchpadPreferences { favourites: string[]; order: string[] }
export function orderedApps(apps: LaunchpadApp[], order: string[]): LaunchpadApp[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...apps].sort((a,b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.name.localeCompare(b.name));
}
/** Move within a displayed section without changing the relative order of the other section. */
export function moveApplication(order: string[], section: string[], id: string, target: string): string[] {
  const from = section.indexOf(id), to = section.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const moved = [...section]; moved.splice(from, 1); moved.splice(to, 0, id);
  let i = 0; return order.map(x => section.includes(x) ? moved[i++] : x);
}

/** Hydration handoff: the applications and preferences the server fetched to render this page, so the browser does not refetch them (and flash "Loading...") on startup. */
const LAUNCHPAD_KEY = makeStateKey<{ user?: { name?: string }; apps?: LaunchpadApp[]; preferences?: LaunchpadPreferences }>('iam-launchpad');

/** Home of the signed-in console: the applications this person's roles open, one click away through single
 *  sign-on. SAML applications launch IdP-initiated (the IdP posts the assertion to the application); OIDC
 *  applications launch on their own URL and their sign-in flow rides the session already open here. */
@Component({
  selector: 'app-launchpad', imports: [FormsModule], styleUrl: './launchpad.css',
  template: `
  <div class="lp-intro"><p class="lp-eyebrow">YOUR WORKSPACE</p><h1>My applications</h1><p class="lp-lead">Your apps, in your order.</p></div>
  <div class="lp-toolbar">
    <label class="lp-search">Search applications<input type="search" name="applicationSearch" [(ngModel)]="query" [disabled]="editing()" placeholder="Search applications" /></label>
    @if (editing()) {
      <button class="secondary" id="lp-cancel" (click)="cancel()" [disabled]="busy()">Cancel</button>
      <button id="lp-save" (click)="save()" [disabled]="busy()">{{busy() ? 'Saving…' : 'Save order'}}</button>
    } @else { <button class="secondary" id="lp-organise" (click)="organise()" [disabled]="!apps().length || busy()">Organise</button> }
  </div>
  @if (editing()) { <p class="lp-edit-hint">Drag a handle to reorder, or use the move up and move down buttons. Save order confirms your changes; Cancel discards them.</p> }
  @if (problem()) { <p role="alert" class="lp-error" id="lp-problem">{{problem()}}</p> }
  <p class="lp-sr" role="status" aria-live="polite" aria-atomic="true">{{announcement()}}</p>
  @for (section of sections(); track section.name) {
    <section class="lp-section" [attr.aria-label]="section.name">
      <h2>{{section.name}} <span>· {{section.apps.length}}</span></h2>
      @if (!section.apps.length && section.name === 'Favourites') { <p class="lp-empty">Select the star on an application to keep it here.</p> }
      <div class="lp-grid" [class.lp-editing]="editing()">
      @for (a of section.apps; track a.id; let first = $first; let last = $last) {
        <article class="lp-card" [attr.data-app]="a.id" [class.lp-dragging]="dragging()===a.id">
          @if (!editing()) { <a class="lp-launch" [href]="a.url" target="_blank" rel="noopener noreferrer" [attr.aria-label]="'Open ' + a.name + ' (opens in a new tab)'"><span class="lp-sr">Open {{a.name}} (opens in a new tab)</span></a> }
          <button class="lp-star secondary" [attr.aria-label]="(favourite(a.id) ? 'Remove ' : 'Add ') + a.name + (favourite(a.id) ? ' from favourites' : ' to favourites')" [attr.aria-pressed]="favourite(a.id)" [disabled]="busy()" (click)="toggle(a)">{{favourite(a.id) ? '★' : '☆'}}</button>
          <div class="lp-head">
            @if (a.logo && !failedImages().includes(a.id)) { <img class="lp-logo" [src]="a.logo" alt="" (error)="imageFailed(a.id)" /> }
            @else { <span class="lp-logo lp-initials" aria-hidden="true">{{initials(a.name)}}</span> }
            <h3>@for (part of nameParts(a.name); track $index; let last = $last) {{{part}}@if (!last) {<wbr>} }</h3>
          </div>
          <p class="lp-desc">{{a.description}}</p>
          @if (editing()) {
            <div class="lp-move">
              <button class="secondary lp-handle" [attr.aria-label]="'Drag to reorder ' + a.name" [disabled]="busy()" (pointerdown)="startDrag($event,a.id)" (pointermove)="dragMove($event)" (pointerup)="drop($event,section.apps)" (pointercancel)="stopDrag()" (keydown.escape)="stopDrag()">⠿</button>
              <button class="secondary" [attr.data-move]="a.id+'-up'" [attr.aria-label]="'Move ' + a.name + ' up'" [disabled]="first || busy()" (click)="move(a.id,-1,section.apps)">↑</button>
              <button class="secondary" [attr.data-move]="a.id+'-down'" [attr.aria-label]="'Move ' + a.name + ' down'" [disabled]="last || busy()" (click)="move(a.id,1,section.apps)">↓</button>
            </div>
          }
        </article>
      }
      </div>
    </section>
  }
  @if (!loaded()) { <p class="lp-empty">Loading applications…</p> }
  @if (loaded() && !problem() && !apps().length) { <p class="lp-empty" id="lp-empty">No application is open to your roles yet. An administrator grants access from the Applications page.</p> }
  @if (apps().length && !sections().some(hasApps)) { <p class="lp-empty">No applications match your search.</p> }
  <p class="lp-demo">Fictional demo applications.</p>`,
})
export class LaunchpadPage {
  protected readonly s = inject(Session);
  protected apps = signal<LaunchpadApp[]>([]);
  protected preferences = signal<LaunchpadPreferences>({ favourites: [], order: [] });
  protected editing = signal(false); protected busy = signal(false);
  protected problem = signal(''); protected loaded = signal(false); protected announcement = signal('');
  protected failedImages = signal<string[]>([]); protected dragging = signal('');
  protected query = signal('');
  private beforeEdit: LaunchpadPreferences | null = null;
  private loadEpoch = 0;
  private pointer?: { id: number; x: number; y: number; moved: boolean };
  protected hasApps = (s: { apps: LaunchpadApp[] }) => s.apps.length > 0;
  /** SSR: the launchpad renders on the server (docs/session.md, the session cookie). The tracked load lets the
   *  server render wait for the applications, so the first HTML already carries them. */
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly pending = inject(PendingTasks);
  private readonly transfer = inject(TransferState);
  protected editing = signal(false); protected busy = signal(false);
  protected problem = signal(''); protected loaded = signal(false); protected announcement = signal('');
  protected failedImages = signal<string[]>([]); protected dragging = signal('');
  protected query = signal('');
  private beforeEdit: LaunchpadPreferences | null = null;
  private loadEpoch = 0;
  private pointer?: { id: number; x: number; y: number; moved: boolean };
  protected hasApps = (s: { apps: LaunchpadApp[] }) => s.apps.length > 0;
  protected sections = computed(() => {
    const p = this.preferences(), q = this.query().trim().toLocaleLowerCase();
    const apps = orderedApps(this.apps(), p.order).filter(a => !q || (a.name+' '+a.description).toLocaleLowerCase().includes(q));
    return [{ name: 'Favourites', apps: apps.filter(a => p.favourites.includes(a.id)) }, { name: 'Other applications', apps: apps.filter(a => !p.favourites.includes(a.id)) }];
  });
  constructor() { effect(() => { this.s.branchEpoch(); void this.pending.run(() => this.load()); }); }
  protected favourite(id: string) { return this.preferences().favourites.includes(id); }
  protected nameParts(name: string) { return name.split(/(?<=[a-z])(?=[A-Z])/); }
  protected initials(name: string) { return name.split(/[\s:-]+/).filter(Boolean).slice(0,2).map(x => x[0]).join('').toUpperCase(); }
  protected imageFailed(id: string) { this.failedImages.update(xs => [...xs,id]); }
  private async load() {
    const epoch = ++this.loadEpoch; this.editing.set(false); this.beforeEdit = null; this.stopDrag();
    // Hydration: reuse what the server fetched to render this very page instead of refetching it.
    if (this.isBrowser && this.transfer.hasKey(LAUNCHPAD_KEY)) {
      const d = this.transfer.get(LAUNCHPAD_KEY, {});
      this.apps.set(Array.isArray(d.apps) ? d.apps : []);
      this.preferences.set(d.preferences ?? { favourites: [], order: [] });
      this.problem.set(''); this.failedImages.set([]);
      this.transfer.remove(LAUNCHPAD_KEY);
      this.loaded.set(true);
      return;
    }
    try {
      const r = await this.s.api.raw<{ apps?: LaunchpadApp[]; preferences?: LaunchpadPreferences; message?: string }>('GET', '@/sso/{t}/launchpad');
      if (epoch !== this.loadEpoch) return;
      if (r.status >= 400) throw Error(r.data?.message || 'Could not load applications');
      this.apps.set(Array.isArray(r.data?.apps) ? r.data.apps : []);
      this.preferences.set(r.data?.preferences ?? { favourites: [], order: [] }); this.problem.set(''); this.failedImages.set([]);
      if (!this.isBrowser) this.transfer.set(LAUNCHPAD_KEY, r.data ?? {});
    } catch (e) { if (epoch === this.loadEpoch) this.problem.set((e as Error).message); }
    finally { if (epoch === this.loadEpoch) this.loaded.set(true); }
  }
  protected organise() {
    this.beforeEdit = structuredClone(this.preferences()); this.query.set('');
    this.preferences.update(p => ({ ...p, order: orderedApps(this.apps(),p.order).map(a => a.id) }));
    this.editing.set(true); this.announcement.set('Organisation mode. Use drag handles or move buttons.');
  }
  protected cancel() { if (this.beforeEdit) this.preferences.set(this.beforeEdit); this.beforeEdit = null; this.editing.set(false); this.stopDrag(); this.problem.set(''); this.announcement.set('Changes cancelled.'); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#lp-organise')?.focus()); }
  protected async toggle(a: LaunchpadApp) {
    const before = this.preferences(), added = !this.favourite(a.id);
    this.preferences.set({ ...before, favourites: added ? [...before.favourites,a.id] : before.favourites.filter(id => id !== a.id) });
    if (!this.editing() && !(await this.persist())) { this.preferences.set(before); return; }
    this.announcement.set(a.name + (added ? ' added to favourites.' : ' removed from favourites.'));
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-app="'+a.id+'"] .lp-star')?.focus());
  }
  private async persist(): Promise<boolean> {
    this.busy.set(true); this.problem.set('');
    try {
      const r = await this.s.api.raw<{ message?: string }>('PUT','@/sso/{t}/launchpad/preferences',this.preferences());
      if (r.status >= 400) throw Error(r.data?.message || 'Could not save your preferences');
      return true;
    } catch (e) { this.problem.set((e as Error).message); return false; }
    finally { this.busy.set(false); }
  }
  protected async save() { if (await this.persist()) { this.editing.set(false); this.beforeEdit = null; this.stopDrag(); this.announcement.set('Application order saved.'); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#lp-organise')?.focus()); } }
  protected move(id: string, delta: number, apps: LaunchpadApp[]) {
    const i = apps.findIndex(a => a.id === id), target = apps[i+delta]; if (!target) return;
    this.reorder(id,target.id,apps);
    requestAnimationFrame(() => { const direction = delta < 0 ? 'up' : 'down'; const button = document.querySelector<HTMLButtonElement>('[data-move="'+id+'-'+direction+'"]'); if (button && !button.disabled) button.focus(); else document.querySelector<HTMLButtonElement>('[data-move="'+id+'-'+(direction==='up'?'down':'up')+'"]')?.focus(); });
  }
  private reorder(id: string, target: string, apps: LaunchpadApp[]) {
    this.preferences.update(p => ({ ...p, order: moveApplication(p.order,apps.map(a=>a.id),id,target) }));
    const ordered = orderedApps(apps,this.preferences().order);
    this.announcement.set((apps.find(a=>a.id===id)?.name ?? id)+' moved to position '+(ordered.findIndex(a=>a.id===id)+1)+' of '+apps.length+'.');
  }
  protected startDrag(e: PointerEvent, id: string) {
    if (e.button !== 0 || this.busy()) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.pointer = { id: e.pointerId, x:e.clientX,y:e.clientY,moved:false }; this.dragging.set(id);
  }
  protected dragMove(e: PointerEvent) {
    const p = this.pointer; if (!p || p.id !== e.pointerId) return;
    p.moved ||= Math.hypot(e.clientX-p.x,e.clientY-p.y)>8;
    if (p.moved) { if (e.clientY < 80) window.scrollBy(0,-18); else if (e.clientY > window.innerHeight-80) window.scrollBy(0,18); }
  }
  protected drop(e: PointerEvent, apps: LaunchpadApp[]) {
    const p = this.pointer, id = this.dragging();
    const target = document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-app]')?.dataset['app'];
    if (p?.id === e.pointerId && p.moved && target && apps.some(a=>a.id===target)) this.reorder(id,target,apps);
    this.stopDrag();
  }
  protected stopDrag() { this.pointer = undefined; this.dragging.set(''); }
}
