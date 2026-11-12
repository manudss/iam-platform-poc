import { Brand, Branding } from './branding';
import { canOpen, screenOf } from './access';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { VersioningClient, BranchInfo } from './api';
import { Session } from './session';
import { SessionTimer } from './session-timer';
import { ThemeSwitch } from './theme-switch';

interface NavItem { path: string; label: string; icon: string; order?: number }
interface NavGroup { title: string; items: NavItem[] }

/** Administration layout: grouped sidebar, top bar with the signed-in identity, status bar and the page outlet. */
@Component({ selector: 'app-shell', imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule, SessionTimer, ThemeSwitch, Brand], templateUrl: './shell.html', styleUrl: './shell.css' })
export class Shell {
  private readonly branding = inject(Branding);
  private brandingRequest = 0;
  private async loadBranding(){
    const request=++this.brandingRequest;
    try{const r=await this.s.api.raw<any>('GET','/branding/draft',undefined,this.headers());
      if(request===this.brandingRequest&&r.status<400)this.branding.applyBundle(r.data);
    }catch{/* keep last readable palette while a branch is loading */}
  }
  ngOnDestroy(){++this.brandingRequest;this.branding.clearDraft();}

  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  protected workflowEditor() { return this.router.url.startsWith('/workflows/edit/'); }
  protected branches=signal<BranchInfo[]>([]);protected newBranch='';protected working='';protected review=signal<any>(null);protected workingBusy=signal(false);
  /** Compact bar state: the ⋯ menu, the "Manage branches" panel, and the number of changed ROWS on the working branch (the badge). */
  protected readonly more=signal(false);protected readonly manage=signal(false);protected readonly changes=signal<number|null>(null);
  protected dot(){if(this.branchState()==='error')return 'red';const b=this.s.branch();return !b||b==='main'?'grey':b===this.personal()?'green':'orange';}
  protected async loadChanges(){const b=this.s.branch();if(!b||b==='main'||!this.isAdmin()){this.changes.set(null);return;}try{const r=await this.s.api.raw<any>('GET','/workspace',undefined,this.headers());if(r.status<400)this.changes.set(r.data?.diff?.rows?.total??r.data?.diff?.tables?.length??0);}catch{/* the badge is a hint; Review & Apply still reads the diff itself */}}
  /** Menu entries declared by the tenant's active plugins (GET /plugins/menu): a screen joins the sidebar with its plugin and leaves with it. */
  protected readonly pluginMenu=signal<{plugin:string;id:string;title:string;area:string;group:string;icon?:string;order?:number;path:string}[]>([]);
  protected async loadPluginMenu(){try{const r=await this.s.api.raw<{entries:{plugin:string;id:string;title:string;area:string;group:string;icon?:string;order?:number;path:string}[]}>('GET','/plugins/menu',undefined,this.headers());if(r.status<400&&Array.isArray(r.data?.entries))this.pluginMenu.set(r.data.entries);}catch{/* the static console still works without it */}}
  protected openManage(){this.more.set(false);this.manage.set(!this.manage());}
  protected personal=signal('');protected renameTo='';
  /** Opens (or reuses) the signed-in user's own working branch so the console is ready to use on arrival. */
  /** State of opening the personal branch, shown in the branch selector pill (never as a banner): idle, creating, ready, error. */
  protected readonly branchState=signal<'idle'|'creating'|'ready'|'error'>('idle');
  /** Plain-language detail for the pill tooltip (also announced to screen readers). */
  protected readonly branchTip=signal('');
  protected async ensurePersonal(){
    this.branchState.set('creating');this.branchTip.set('Opening your personal branch…');
    try{
      const r=await this.s.api.raw<{branch:string;status:string}>('POST','/workspace/personal',undefined,this.headers());
      this.personal.set(r.data.branch);this.working=r.data.branch;this.renameTo=r.data.branch;if(this.s.branch()!==r.data.branch)this.s.selectBranch(r.data.branch);
      this.branchState.set('ready');
      this.branchTip.set(r.data.status==='reused'?'Back on your personal branch '+r.data.branch+'. Your work in progress is kept.':'Your personal branch '+r.data.branch+' is ready. Changes stay on it until Apply.');
    }catch(e){
      const m=(e as Error).message;const token=/admin capability|disabled/.test(m);
      const text=token?'Enter the admin capability token, then press Refresh branches to open your personal branch.':m;
      this.branchState.set('error');this.branchTip.set(text);
      this.s.say(text,token?'info':'error');
    }
  }
  protected async refresh(){if(!this.personal())await this.ensurePersonal();await this.loadBranches();}
  protected async rename(){try{const r=await this.s.api.raw<{branch:string}>('POST','/workspace/personal/rename',{name:this.renameTo},this.headers());this.personal.set(r.data.branch);this.working=r.data.branch;this.renameTo=r.data.branch;this.s.selectBranch(r.data.branch);await this.loadBranches();this.manage.set(false);this.s.say('Personal branch renamed to '+r.data.branch+'.');}catch(e){this.s.say((e as Error).message,'error');}}
  async ngOnInit(){
    await this.s.loadAccess();
    // Branch test: no personal branch, no workspace bar, no admin init; the app simply runs on the tested branch.
    if(this.s.testBranch()){if(!this.router.url.startsWith('/my-profile')&&!this.router.url.startsWith('/overview'))void this.router.navigateByUrl('/my-profile');return;}
    if(this.isAdmin()){await this.ensurePersonal();await this.loadBranches();void this.loadChanges();await this.s.refreshWorkflowsEnabled();}else if(!this.router.url.startsWith('/my-profile')&&this.router.url!=='/my-applications')void this.router.navigateByUrl('/my-applications');
    void this.loadPluginMenu();
  }
  /** Opens a sign-in test of the selected data branch in a new tab (docs/branch-test.md). The API issues the short-lived ticket. */
  protected testing=signal(false);
  protected readonly stableUrl=signal('');protected readonly stableLinks=signal<{id:string;branch:string;label:string;createdBy:string;createdAt:string}[]>([]);
  protected branchLinks(){return this.stableLinks().filter((l)=>l.branch===this.working);}
  protected async loadStableLinks(){try{const r=await this.s.api.raw<{id:string;branch:string;label:string;createdBy:string;createdAt:string}[]>('GET','/workspace/branch-test',undefined,this.headers());if(r.status<400)this.stableLinks.set(Array.isArray(r.data)?r.data:[]);}catch{/* listed on demand only */}}
  protected async stableLink(){if(!this.working||this.working==='main')return;this.more.set(false);this.manage.set(true);this.testing.set(true);try{const r=await this.s.api.raw<{ticket:string;branch:string;id:string}>('POST','/workspace/branch-test',{branch:this.working,stable:true,label:this.working},this.headers());if(r.status>=400)throw new Error((r.data as {message?:string})?.message??'Refused');this.stableUrl.set(`${location.origin}/login?branch=${encodeURIComponent(r.data.branch)}&ticket=${encodeURIComponent(r.data.ticket)}`);this.s.say('Stable test link created for '+r.data.branch+': it stays valid until revoked. Copy it from the field next to the button.');await this.loadStableLinks();}catch(e){this.s.say((e as Error).message,'error');}finally{this.testing.set(false);}}
  protected async revokeLink(id:string){try{const r=await this.s.api.raw<{revoked:boolean}>('DELETE','/workspace/branch-test/'+encodeURIComponent(id),undefined,this.headers());if(r.status>=400)throw new Error('Refused');this.stableLinks.update((xs)=>xs.filter((x)=>x.id!==id));this.s.say('Stable test link revoked.');}catch(e){this.s.say((e as Error).message,'error');}}
  protected async testSignIn(){if(!this.working||this.working==='main')return;this.more.set(false);this.testing.set(true);try{const r=await this.s.api.raw<{ticket:string;branch:string}>('POST','/workspace/branch-test',{branch:this.working},this.headers());const u=`${location.origin}/login?branch=${encodeURIComponent(r.data.branch)}&ticket=${encodeURIComponent(r.data.ticket)}`;if(!globalThis.open(u,'_blank','noopener'))this.s.say('Allow pop-ups or open this test link: '+u,'error');else this.s.say('Sign-in test of '+r.data.branch+' opened in a new tab. It stays valid for a few minutes.');}catch(e){this.s.say((e as Error).message,'error');}finally{this.testing.set(false);}}
  protected exitTest(){this.s.signOut();void this.router.navigateByUrl('/login');}
  private headers():Record<string,string>{return this.s.adminToken()?{'x-api-admin-token':this.s.adminToken()}:{};}
  protected async loadBranches(){void this.loadStableLinks();try{const v=new VersioningClient(this.s.api);v.adminToken=this.s.adminToken();this.branches.set((await v.branches()).branches);if(this.s.branch()&&this.s.branch()===this.personal()&&!this.branches().some(b=>b.name===this.personal())){await this.ensurePersonal();this.branches.set((await v.branches()).branches);}}catch(e){this.s.say((e as Error).message,'error');}}
  protected async select(){this.s.selectBranch(this.working);this.review.set(null);this.more.set(false);void this.loadChanges();this.s.say(this.working==='main'?'Viewing main (read only).':'Working on '+this.working+'. Changes stay here until Apply.');}
  protected async create(){try{const v=new VersioningClient(this.s.api);v.adminToken=this.s.adminToken();await v.createBranch(this.newBranch,'main');this.working=this.newBranch;this.newBranch='';await this.loadBranches();await this.select();this.manage.set(false);}catch(e){this.s.say((e as Error).message,'error');}}
  protected async prepareApply(){this.workingBusy.set(true);try{await this.loadBranches();const r=await this.s.api.raw<any>('GET','/workspace',undefined,this.headers());this.review.set(r.data);}catch(e){this.s.say((e as Error).message,'error');}finally{this.workingBusy.set(false);}}
  protected async apply(){if(!confirm('Apply '+this.s.branch()+' into Dolt main? Its users, plugins and role permissions will become live.'))return;this.workingBusy.set(true);try{const head=this.branches().find(b=>b.name===this.s.branch())?.commit;const r=await this.s.api.raw<any>('POST','/workspace/apply',{confirm:true,expectedHead:head},this.headers());if(r.status>=400 || !r.data.applied)throw new Error(r.data.message??'Apply refused');this.review.set(null);this.s.branchEpoch.update(x=>x+1);this.s.say('Applied '+this.s.branch()+' into main: '+r.data.commit);await this.loadBranches();void this.loadChanges();void this.loadPluginMenu();}catch(e){this.s.say((e as Error).message,'error');}finally{this.workingBusy.set(false);}}
  protected readonly menu = signal(false);
  /** Ordinary accounts see only their own space. Administration items need the administrator, plugin items need the plugin live. */
  protected visibleNav(): NavGroup[] {
    // Branch test shows the ordinary experience only: administration stays in the normal console.
    if (this.s.testBranch()) return this.nav().map((g: NavGroup) => ({ title: g.title, items: g.items.filter((i: NavItem) => i.path === '/overview' || i.path === '/my-profile') })).filter((g: NavGroup) => g.items.length);
    const a = this.s.access(); const adminOk = !a || a.admin || !a.restricted;
    const groups = this.nav().map((g: NavGroup) => ({ title: g.title, items: g.items.filter((i: NavItem) => i.path === '/my-applications' || i.path === '/my-profile' || canOpen(a, screenOf(i.path))).map((i: NavItem, n: number) => ({ ...i, order: i.order ?? (n + 1) * 10 })) }));
    // Plugin menu entries (step 2): declared in the plugin's manifest, present only while the plugin is active.
    const pluginEntries = this.pluginMenu?.(); // test harnesses can render before the field settles: no entries = static console
    if (Array.isArray(pluginEntries)) for (const m of pluginEntries) {
      if (m.area === 'admin' && (!adminOk || (a?.screenAccess && !(a.screens ?? []).includes('plugins')))) continue;
      let g = groups.find((x) => x.title === m.group);
      if (!g) { g = { title: m.group, items: [] }; groups.push(g); }
      if (!g.items.some((i) => i.path === m.path)) g.items.push({ path: m.path, label: m.title, icon: m.icon ?? '⬡', order: m.order ?? 50 });
    }
    for (const g of groups) g.items.sort((x, y) => (x.order ?? 50) - (y.order ?? 50) || x.label.localeCompare(y.label));
    // Plugin groups keep the position the static menu had before step 2 (the menu must stay identical for the
    // user): known groups take their historical slot, unknown plugin groups append after the core ones.
    const GROUP_ORDER = ['Overview', 'Access (IAM)', 'Automation (IGA)', 'Extensions', 'Database (Dolt)'];
    groups.sort((a, b) => (GROUP_ORDER.indexOf(a.title) < 0 ? 99 : GROUP_ORDER.indexOf(a.title)) - (GROUP_ORDER.indexOf(b.title) < 0 ? 99 : GROUP_ORDER.indexOf(b.title)));
    return groups.filter((g: NavGroup) => g.items.length);
  }
  /** The branch selector and Manage branches: only where a screen:open policy gives branch-manage (the super admin). Everyone else works on their own personal branch, opened for them. */
  protected canBranches() { const a = this.s.access(); return this.isAdmin() && (!a || !a.screenAccess || !a.screens || a.screens.includes('branch-manage')); }
  /** My applications is everyone's home and edits nothing: it renders without a chosen data branch (this is
   *  also what lets the server render it from the session cookie, docs/session.md). */
  protected launchpadRoute() { return this.router.url.split('?')[0] === '/my-applications'; }
  protected isAdmin() { const a = this.s.access(); return !a || a.admin || !a.restricted; }
  protected readonly title = signal('');
  protected readonly nav = computed<NavGroup[]>(() => {
    const groups: NavGroup[] = [
    { title: 'Overview', items: [{ path: '/my-applications', label: 'My applications', icon: '▦' }, { path: '/overview', label: 'Dashboard', icon: '◧' }] },
    // Plugin screens (organizations, applications, policies, workflows, ...) are NOT here: they come from the
    // tenant's active plugins through GET /plugins/menu (step 2), grouped and ordered by their manifests.
    { title: 'Access (IAM)', items: [
      { path: '/users', label: 'Users', icon: '♙' },
      { path: '/profile-fields', label: 'Profile fields', icon: '☰' },
      { path: '/roles', label: 'Roles', icon: '⚖' },
      { path: '/profile-reviews', label: 'Profile reviews', icon: '✓' },
      { path: '/my-profile', label: 'My profile', icon: '☺' },
      { path: '/auth-methods', label: 'Authentication', icon: '⚿' },
      { path: '/assignments', label: 'Assignments & changes', icon: '⇄' },
      { path: '/activation', label: 'Activation', icon: '⏻' }] },
    { title: 'Extensions', items: [{ path: '/plugins', label: 'Plugins', icon: '⬡' }, { path: '/event-bus', label: 'Event bus', icon: '≋' }, { path: '/mcp', label: 'MCP (AI)', icon: '⚡' }] },
    { title: 'Database (Dolt)', items: [
      { path: '/database/home', label: 'Home', icon: '⌂' },
      { path: '/database/branches', label: 'Branches', icon: '⑂' },
      { path: '/database/history', label: 'History', icon: '◷' },
      { path: '/database/compare', label: 'Compare', icon: '⇋' },
      { path: '/database/data', label: 'Data', icon: '▦' },
      { path: '/database/sql', label: 'SQL', icon: '❯' },
      { path: '/database/pulls', label: 'Pull requests', icon: '⤴' }] },
  ]
    return groups;
  });


  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd),takeUntilDestroyed()).subscribe(() => { this.menu.set(false); this.title.set(this.leafTitle()); void this.loadChanges(); void this.loadBranding(); });
    // A plugin enable/disable/install anywhere bumps pluginsVersion: the sidebar follows the registry without a reload.
    effect(() => { this.s.pluginsVersion(); this.s.branch(); this.s.branchEpoch(); void this.loadPluginMenu(); });
    effect(()=>{this.s.branch();this.s.branchEpoch();this.s.adminToken();void this.loadBranding();});
    this.title.set(this.leafTitle());
  }
  private leafTitle(): string {
    let r = this.router.routerState.snapshot.root; while (r.firstChild) r = r.firstChild;
    return (r.title as string | undefined) ?? '';
  }
  protected async signOut() { try { await this.s.api.raw('POST','/workspace/personal/release',undefined,this.headers()); } catch { /* best effort: idle empty branches are swept later */ } this.s.signOut(); void this.router.navigateByUrl('/login'); }
}
