import { ChangeDetectorRef, Component, ElementRef, inject, input, signal } from '@angular/core';
import { Session } from './session';
import { PluginScreenLoader } from './plugin-screen';

/** One profile component contributed by an active plugin (GET /profile-components). */
export interface ProfileComponentInv { key: string; plugin: string; id: string; title: string; component: string; mode: 'manage' | 'readonly'; order: number }

/**
 * Mounts every profile component the active plugins contribute to one surface (`self`: My profile, `admin`: the
 * user sheet). The component code ships in the plugin's signed package and is imported through the assets route,
 * exactly like the packaged console screens; the context adds the surface and, on the admin surface, the subject.
 */
@Component({
  selector: 'app-profile-components',
  // Scoped here (Angular encapsulation): these nodes are this component's template, no outer sheet reaches them.
  styles: [`
  .profile-plugin-section { margin: 0 0 .75rem; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 8px; }
  .profile-plugin-section-title { margin: 0 0 .3rem; font-size: .95rem; }
  .profile-plugin-origin { color: var(--muted); font-weight: normal; margin-left: .35rem; }
  .msg.bad { background: var(--bad-soft); color: var(--bad-ink); border-left: 4px solid var(--bad); padding: .6rem .9rem; border-radius: .5rem; }
  `],
  template: `
  @if (problem()) { <p role="alert" class="msg bad" id="profile-components-problem">{{problem()}}</p> }
  @for (c of comps(); track c.key) {
    <section class="profile-plugin-section" [attr.data-component]="c.key">
      <h4 class="profile-plugin-section-title">{{c.title}} <small class="profile-plugin-origin">{{c.plugin}}</small></h4>
      <div class="profile-plugin-mount" [attr.data-mount]="c.key"></div>
    </section>
  }`,
})
export class ProfileComponents {
  readonly surface = input.required<'self' | 'admin'>();
  readonly subject = input<string>('');
  /** Component keys rendered elsewhere (e.g. the picture lives in the My profile header): skip them here. */
  readonly exclude = input<string[]>([]);
  private readonly s = inject(Session);
  private readonly cd = inject(ChangeDetectorRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly loader = inject(PluginScreenLoader);
  protected comps = signal<ProfileComponentInv[]>([]);
  protected problem = signal('');
  private request = 0;

  ngOnInit() { void this.load(); }
  ngOnChanges() { void this.load(); }

  private assetHeaders(): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.s.api.bearerToken}` };
    if (this.s.branch()) h['x-iam-branch'] = this.s.branch();
    return h;
  }

  private async load() {
    const req = ++this.request;
    this.problem.set('');
    try {
      // The admin surface answers 403 without the capability: send it, like the other administration calls do.
      const cap: Record<string, string> = this.surface() === 'admin' && this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {};
      const r = await this.s.api.raw<{ components: ProfileComponentInv[]; message?: string }>('GET', `/profile-components?surface=${this.surface()}${this.surface() === 'admin' ? '&ref=work' : ''}`, undefined, cap);
      if (req !== this.request) return;
      if (r.status >= 400) throw new Error(r.data.message ?? 'Cannot load');
      this.comps.set((r.data.components ?? []).filter((c) => !this.exclude().includes(c.key)));
      this.cd.detectChanges(); // mount containers must exist before the async module loop starts
      void this.mountAll(req);
    } catch (e) { if (req === this.request) { this.comps.set([]); this.problem.set((e as Error).message); } }
  }

  private async mountAll(req: number) {
    for (const c of this.comps()) {
      const mount = this.host.nativeElement.querySelector(`[data-mount="${c.key}"]`);
      if (!mount) continue;
      try {
        const url = `/api/tenants/${encodeURIComponent(this.s.api.tenant)}/plugins/${encodeURIComponent(c.plugin)}/assets/${c.component.split('/').map(encodeURIComponent).join('/')}`;
        const mod = await this.loader.load(url, this.assetHeaders());
        if (req !== this.request) return;
        const tag = mod?.default;
        if (typeof tag !== 'string' || !tag) throw new Error('the module must default-export its custom-element tag');
        const el = document.createElement(tag) as HTMLElement & { context?: unknown };
        el.context = { tenant: this.s.api.tenant, api: `/api/tenants/${this.s.api.tenant}`, token: this.s.api.bearerToken, adminToken: this.s.adminToken(), branch: this.s.branch(), surface: this.surface(), subject: this.subject(), mode: c.mode };
        mount.replaceChildren(el);
      } catch (e) { mount.replaceChildren(Object.assign(document.createElement('p'), { className: 'msg bad', textContent: `The ${c.title} component failed to load: ${(e as Error).message ?? e}` })); }
    }
  }
}
