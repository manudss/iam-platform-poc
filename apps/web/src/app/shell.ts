import { ApplyDialog } from './apply-dialog';
import { Brand, Branding } from './branding';
import { canOpen, screenOf } from './access';
import { Component, computed, effect, ElementRef, HostListener, inject, signal, untracked, ViewChild } from '@angular/core';
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
@Component({ selector: 'app-shell', imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule, SessionTimer, ThemeSwitch, Brand, ApplyDialog], templateUrl: './shell.html', styleUrl: './shell.css' })
export class Shell {
  @ViewChild(ApplyDialog) protected applyDialog!: ApplyDialog;
  private readonly branding = inject(Branding);
  private brandingRequest = 0;
  private async loadBranding(){
    const request=++this.brandingRequest;
    try{const r=await this.s.api.raw<any>('GET','/branding/draft',undefined,this.headers());
      if(request===this.brandingRequest&&r.status<400)this.branding.applyBundle(r.data);
    }catch{/* keep last readable palette while a branch is loading */}
  }
  ngOnDestroy(){++this.brandingRequest;this.branding.clearDraft();clearTimeout(this.flashTimer);clearTimeout(this.flyTimer);}

  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  protected workflowEditor() { return this.router.url.startsWith('/workflows/edit/'); }
  protected branches=signal<BranchInfo[]>([]);protected newBranch='';protected working='';protected review=signal<any>(null);protected workingBusy=signal(false);
  /** Compact bar state: the ⋯ menu, the "Manage branches" panel, and the number of changed ROWS on the working branch (the badge). */
  protected readonly rebaseAsk=signal(false);protected readonly manage=signal(false);protected readonly changes=signal<number|null>(null);
  /** Branch picker (the rich dropdown), the transient pending-merge flash and the fly-to-chip animation. */
  protected readonly picker=signal(false);protected branchFilter='';protected readonly pickerNew=signal(false);
  protected readonly branchesAt=signal<number|null>(null);
  protected readonly flash=signal<string|null>(null);protected readonly flashHiding=signal(false);
  protected readonly fly=signal<{x:number;y:number}|null>(null);protected readonly pulse=signal(false);
  private seenWrites=0;private flashTimer?:ReturnType<typeof setTimeout>;private flyTimer?:ReturnType<typeof setTimeout>;
  protected dotFor(name:string){return !name||name==='main'?'grey':name===this.personal()?'green':'orange';}
  protected pickerBranches(){const q=this.branchFilter.trim().toLowerCase();const list=this.branches()??[];return q?list.filter((b)=>b.name.toLowerCase().includes(q)):list;}
  protected pickerLabel(){return this.branchState()==='creating'?'Opening your branch…':this.branchState()==='error'?'Branch unavailable':this.s.branch()||'Choose a branch';}
  /** Opening the picker always reloads the branch list: branches created elsewhere must be there without a detour. */
  protected async togglePicker(){const open=!this.picker();this.picker.set(open);this.rebaseAsk.set(false);if(!open)return;this.pickerNew.set(false);this.branchFilter='';await this.loadBranches();this.branchesAt.set(Date.now());}
  protected async refreshPicker(){await this.loadBranches();this.branchesAt.set(Date.now());}
  protected branchesAgo(){const t=this.branchesAt();if(t===null)return 'never';const m=Math.floor((Date.now()-t)/60000);return m<1?'just now':m===1?'1 minute ago':`${m} minutes ago`;}
  protected pickBranch(name:string){this.picker.set(false);if(name===this.working)return;this.working=name;void this.select();}
  protected cur(){return this.branches().find((b)=>b.name===this.s.branch());}
  protected canRebase(){const b=this.cur();return !!b&&!b.default&&!b.protected&&!this.workingBusy()&&b.behindDefault>0;}
  protected rebaseTip(){const b=this.cur();return !b||b.default?'Main is read only: nothing to rebase.':b.behindDefault>0?`Replays ${b.aheadOfDefault} commit(s) of this branch on top of the latest main (${b.behindDefault} newer on main).`:'This branch already contains the latest main.';}
  /** Real rebase of the picked branch on main (POST /workspace/rebase). The API refuses stale heads, uncommitted work and conflicts, and then changes nothing. */
  protected async rebase(){const b=this.cur();if(!b||this.workingBusy())return;this.workingBusy.set(true);try{const r=await this.s.api.raw<any>('POST','/workspace/rebase',{confirm:true,expectedHead:b.commit},this.headers());if(r.status>=400)throw new Error(r.data?.message??'Rebase refused');this.rebaseAsk.set(false);this.picker.set(false);this.review.set(null);this.s.branchEpoch.update(x=>x+1);this.s.say(r.data?.rebased===false?'Already up to date with main.':'Rebased '+b.name+' on main.');await this.loadBranches();void this.loadChanges();void this.loadPluginMenu();}catch(e){this.s.say((e as Error).message,'error');}finally{this.workingBusy.set(false);}}
  protected pickerManage(){this.picker.set(false);this.openManage();}
  protected async pickerCreate(){if(!this.newBranch)return;await this.create();this.picker.set(false);this.pickerNew.set(false);}
  /** The same button opens and closes the review panel (a toggle), which floats above the page. */
  protected toggleReview(){if(this.review()){this.review.set(null);return;}void this.prepareApply();}
  /** Writes that can leave rows pending on the working branch. Checked against the API: users, roles, profile fields, staged
   *  assignments, plugin enable/disable/settings/install, application connectors, workflows and explorer SQL all write through the
   *  branch registries. Simulations, probes, sessions, tokens, enrollments, profile reviews, activations and branch bookkeeping
   *  (apply, personal branch, test links, branches/pulls/tags) never flash. */
  private isBranchDataWrite(p:string){
    if(/^\/workspace\/(un)?assignments?$/.test(p))return true; // staged assignments live on the branch
    if(/^\/plugins\/[^/]+\/(enable|disable|settings|install)$/.test(p))return true;
    const base=p.split('/')[1]??'';
    if(['users','roles','profile-fields','workflow-templates','sql'].includes(base))return true;
    if(base==='app-connectors'&&!p.startsWith('/app-connectors/parse-sp-metadata'))return true;
    if(base==='workflows'&&!p.startsWith('/workflows/test-run'))return true;
    if(base==='workflow-connections'&&!p.startsWith('/workflow-connections/probe'))return true;
    return false;
  }
  /** An accepted write on the working branch: refresh the counter (the REAL branch diff, not a write count: an edit that cancels
   *  another brings it back to 0), then flash the pending-merge hint and fly a dot to the chip — only while the diff truly has
   *  something pending. A failed write never reaches this point (the API hook fires on success only). */
  private async onBranchWrite(){const b=this.s.branch();
    if(!b||b==='main')return;
    if(!this.isBranchDataWrite(this.s.lastWritePath())){void this.loadChanges();return;} // bookkeeping and other writes still refresh the counter
    await this.loadChanges();
    if(b!==this.s.branch())return; // the branch changed while the diff was re-read: nothing to announce here
    if(!(this.changes()??0))return; // nothing truly pending (e.g. an edit undone): no false "merge me" claim
    this.flash.set(`Added to ${b} - it is available once the branch is merged into main.`);this.flashHiding.set(false);
    clearTimeout(this.flashTimer);this.flashTimer=setTimeout(()=>{this.flashHiding.set(true);this.flashTimer=setTimeout(()=>{this.flash.set(null);this.flashHiding.set(false);},450);},4600);
    const chip=typeof document==='undefined'?null:document.getElementById('review-apply');const r=chip?.getBoundingClientRect();
    this.fly.set({x:r?r.left+r.width/2:(globalThis.innerWidth??800)-140,y:r?r.top+r.height/2:28});this.pulse.set(true);
    clearTimeout(this.flyTimer);this.flyTimer=setTimeout(()=>{this.fly.set(null);this.pulse.set(false);},950);
  }
  @HostListener('document:keydown.escape') onEsc(){this.picker.set(false);if(this.review())this.review.set(null);}
  @HostListener('document:click',['$event']) onDocClick(ev:MouseEvent){const t=ev.target as HTMLElement|null;
    if(this.picker()&&!t?.closest('#branch-picker')&&!t?.closest('#branch-picker-button'))this.picker.set(false);
    if(this.review()&&!t?.closest('#review-panel')&&!t?.closest('#review-apply'))this.review.set(null);
  }
  /** Coming back to the tab re-reads the counter: changes made in another tab or by someone else show up too. */
  @HostListener('window:focus') onFocus(){void this.loadChanges();}
  protected dot(){if(this.branchState()==='error')return 'red';const b=this.s.branch();return !b||b==='main'?'grey':b===this.personal()?'green':'orange';}
  protected async loadChanges(){const b=this.s.branch();if(!b||b==='main'||!this.isAdmin()){this.changes.set(null);return;}try{const r=await this.s.api.raw<any>('GET','/workspace',undefined,this.headers());if(r.status<400)this.changes.set(r.data?.diff?.rows?.total??r.data?.diff?.tables?.length??0);}catch{/* the badge is a hint; Review & Apply still reads the diff itself */}}
  /** Menu entries declared by the tenant's active plugins (GET /plugins/menu): a screen joins the sidebar with its plugin and leaves with it. */
  protected readonly pluginMenu=signal<{plugin:string;id:string;title:string;area:string;group:string;icon?:string;order?:number;path:string}[]>([]);
  protected async loadPluginMenu(){try{const r=await this.s.api.raw<{entries:{plugin:string;id:string;title:string;area:string;group:string;icon?:string;order?:number;path:string}[]}>('GET','/plugins/menu',undefined,this.headers());if(r.status<400&&Array.isArray(r.data?.entries))this.pluginMenu.set(r.data.entries);}catch{/* the static console still works without it */}}
  protected openManage(){this.manage.set(!this.manage());}
  protected personal=signal('');protected renameTo='';
  /** Opens (or reuses) the signed-in user's own working branch so the console is ready to use on arrival. */
  /** State of opening the personal branch, shown in the branch selector pill (never as a banner): idle, creating, ready, error. */
  protected readonly branchState=signal<'idle'|'creating'|'ready'|'error'>('idle');
  /** Plain-language detail for the pill tooltip (also announced to screen readers). */
  protected readonly branchTip=signal('');
  protected async ensurePersonal(){
    this.branchState.set('creating');this.branchTip.set('Opening your personal branch…');
    try{
      const r={data:await this.s.ensurePersonalBranch()};
      this.personal.set(r.data.branch);this.working=r.data.branch;this.renameTo=r.data.branch;if(this.s.branch()!==r.data.branch)this.s.selectBranch(r.data.branch);
      this.branchState.set('ready');
      this.s.message.set(''); // success used to replace whatever the bar showed (e.g. an earlier "admin capability required"); now it simply clears it, the state is in the pill
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
    void this.loadMe(); void this.loadVersion();
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
  protected async stableLink(){if(!this.working||this.working==='main')return;this.picker.set(false);this.manage.set(true);this.testing.set(true);try{const r=await this.s.api.raw<{ticket:string;branch:string;id:string}>('POST','/workspace/branch-test',{branch:this.working,stable:true,label:this.working},this.headers());if(r.status>=400)throw new Error((r.data as {message?:string})?.message??'Refused');this.stableUrl.set(`${location.origin}/login?branch=${encodeURIComponent(r.data.branch)}&ticket=${encodeURIComponent(r.data.ticket)}`);this.s.say('Stable test link created for '+r.data.branch+': it stays valid until revoked. Copy it from the field next to the button.');await this.loadStableLinks();}catch(e){this.s.say((e as Error).message,'error');}finally{this.testing.set(false);}}
  protected async revokeLink(id:string){try{const r=await this.s.api.raw<{revoked:boolean}>('DELETE','/workspace/branch-test/'+encodeURIComponent(id),undefined,this.headers());if(r.status>=400)throw new Error('Refused');this.stableLinks.update((xs)=>xs.filter((x)=>x.id!==id));this.s.say('Stable test link revoked.');}catch(e){this.s.say((e as Error).message,'error');}}
  protected async testSignIn(){if(!this.working||this.working==='main')return;this.picker.set(false);this.testing.set(true);try{const r=await this.s.api.raw<{ticket:string;branch:string}>('POST','/workspace/branch-test',{branch:this.working},this.headers());const u=`${location.origin}/login?branch=${encodeURIComponent(r.data.branch)}&ticket=${encodeURIComponent(r.data.ticket)}`;if(!globalThis.open(u,'_blank','noopener'))this.s.say('Allow pop-ups or open this test link: '+u,'error');else this.s.say('Sign-in test of '+r.data.branch+' opened in a new tab. It stays valid for a few minutes.');}catch(e){this.s.say((e as Error).message,'error');}finally{this.testing.set(false);}}
  protected exitTest(){this.s.signOut();void this.router.navigateByUrl('/login');}
  private headers():Record<string,string>{return this.s.adminToken()?{'x-api-admin-token':this.s.adminToken()}:{};}
  protected async loadBranches(){void this.loadStableLinks();try{const v=new VersioningClient(this.s.api);v.adminToken=this.s.adminToken();this.branches.set((await v.branches()).branches);this.branchesAt.set(Date.now());if(this.s.branch()&&this.s.branch()===this.personal()&&!this.branches().some(b=>b.name===this.personal())){await this.ensurePersonal();this.branches.set((await v.branches()).branches);}}catch(e){this.s.say((e as Error).message,'error');}}
  protected async select(){this.s.selectBranch(this.working);this.review.set(null);void this.loadChanges();this.s.say(this.working==='main'?'Viewing main (read only).':'Working on '+this.working+'. Changes stay here until Apply.');}
  protected async create(){try{const v=new VersioningClient(this.s.api);v.adminToken=this.s.adminToken();await v.createBranch(this.newBranch,'main');this.working=this.newBranch;this.newBranch='';await this.loadBranches();await this.select();this.manage.set(false);}catch(e){this.s.say((e as Error).message,'error');}}
  protected async prepareApply(){this.workingBusy.set(true);try{await this.loadBranches();const r=await this.s.api.raw<any>('GET','/workspace',undefined,this.headers());this.review.set({...r.data,expectedHead:this.branches().find(b=>b.name===r.data.branch)?.commit});}catch(e){this.s.say((e as Error).message,'error');}finally{this.workingBusy.set(false);}}
  /** Confirm the reviewed change with an HTML dialog, without blocking browser clients.
   * Bind the action to the reviewed branch/head; the server still checks permission, conflicts and SoD. */
  protected async apply(){const review=this.review();if(this.workingBusy()||!review||review.branch!==this.s.branch()||review.branch==='main'||!review.expectedHead)return;this.workingBusy.set(true);try{if(!await this.applyDialog.confirm(review.branch)||this.s.branch()!==review.branch)return;const head=review.expectedHead;const r=await this.s.api.raw<any>('POST','/workspace/apply',{confirm:true,expectedHead:head},this.headers());if(r.status>=400 || !r.data.applied)throw new Error(r.data.message??'Apply refused');this.review.set(null);this.s.branchEpoch.update(x=>x+1);this.s.say('Applied '+this.s.branch()+' into main: '+r.data.commit);await this.loadBranches();void this.loadChanges();void this.loadPluginMenu();}catch(e){this.s.say((e as Error).message,'error');}finally{this.workingBusy.set(false);}}
  protected readonly menu = signal(false);

  /** User menu (top right): the person's photo when the profile-picture plugin is enabled and a picture exists, initials otherwise. */
  protected readonly userMenu = signal(false);
  protected readonly mePhoto = signal('');
  protected readonly meName = signal('');
  private meDirty = false;
  protected toggleUserMenu() { this.userMenu.update((x) => !x); }
  protected closeUserMenu() { this.userMenu.set(false); }
  @HostListener('document:keydown.escape') protected onUserMenuEsc() { this.closeUserMenu(); }
  protected meInitials() { const p = (this.meName() || this.s.user() || '?').trim().split(/\s+/); return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  /** The signed-in person's own profile, for the avatar: picture (data URL) and display name. Best effort: the identity's
   *  initials remain. A DISABLED profile-picture plugin needs no check here: its field leaves the profile schema, so
   *  GET /me/profile simply omits profile-picture.picture while the stored value survives a re-enable. */
  protected async loadMe() {
    try {
      const r = await this.s.api.raw<any>('GET', '/me/profile', undefined, this.headers());
      if (r.status >= 400) return;
      const v = r.data?.values ?? {};
      const pic = v['profile-picture.picture'];
      this.mePhoto.set(typeof pic === 'string' && pic.startsWith('data:image/') ? pic : '');
      const name = v['base.display_name'];
      this.meName.set(typeof name === 'string' && name ? name : '');
    } catch { /* initials of the identity remain */ }
  }
  /** Deployed build shown in the user menu: baked into the image at build time (demo/Dockerfile), served by GET /health. */
  protected readonly appVersion = signal('');
  protected readonly appCommit = signal('');
  protected async loadVersion() {
    try {
      const r = await this.s.api.raw<{ version?: string; commit?: string }>('GET', '@/health', undefined, this.headers());
      if (r.status < 400) { this.appVersion.set(r.data?.version ?? ''); this.appCommit.set(r.data?.commit ?? ''); }
    } catch { /* the version line is informational */ }
  }
  /** Ordinary accounts see only their own space. Administration items need the administrator, plugin items need the plugin live. */
  protected visibleNav(): NavGroup[] {
    // Branch test shows the ordinary experience only: administration stays in the normal console.
    if (this.s.testBranch()) return this.nav().map((g: NavGroup) => ({ title: g.title, items: g.items.filter((i: NavItem) => i.path === '/overview') })).filter((g: NavGroup) => g.items.length);
    const a = this.s.access(); const adminOk = !a || a.admin || !a.restricted;
    const groups = this.nav().map((g: NavGroup) => ({ title: g.title, items: g.items.filter((i: NavItem) => i.path === '/my-applications' || canOpen(a, screenOf(i.path))).map((i: NavItem, n: number) => ({ ...i, order: i.order ?? (n + 1) * 10 })) }));
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
      { path: '/auth-methods', label: 'Authentication', icon: '⚿' },
      { path: '/account-protection', label: 'Account protection', icon: '⛨' },
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
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd),takeUntilDestroyed()).subscribe(() => { this.menu.set(false); this.closeUserMenu(); this.title.set(this.leafTitle()); void this.loadChanges(); void this.loadBranding();
      if (this.router.url.startsWith('/my-profile')) this.meDirty = true; else if (this.meDirty) { this.meDirty = false; void this.loadMe(); } });
    // A plugin enable/disable/install anywhere bumps pluginsVersion: the sidebar follows the registry without a reload.
    effect(() => { this.s.pluginsVersion(); this.s.branch(); this.s.branchEpoch(); void this.loadPluginMenu(); });
    // The first loadMe() starts before the working branch is selected, and api.call() drops a result whose branch changed in flight: the header kept the initials. Reload whenever the branch settles or changes.
    effect(() => { this.s.branch(); untracked(() => { void this.loadMe(); }); });
    effect(()=>{this.s.branch();this.s.branchEpoch();this.s.adminToken();void this.loadBranding();});
    effect(()=>{const n=this.s.branchWrites();const fresh=n>this.seenWrites;this.seenWrites=n;if(fresh)void this.onBranchWrite();});
    this.title.set(this.leafTitle());
  }
  private leafTitle(): string {
    let r = this.router.routerState.snapshot.root; while (r.firstChild) r = r.firstChild;
    return (r.title as string | undefined) ?? '';
  }
  protected async signOut() { try { await this.s.api.raw('POST','/workspace/personal/release',undefined,this.headers()); } catch { /* best effort: idle empty branches are swept later */ } this.s.signOut(); void this.router.navigateByUrl('/login'); }
}
