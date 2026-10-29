import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { VersioningClient, BranchInfo } from './api';
import { Session } from './session';

interface NavItem { path: string; label: string; icon: string }
interface NavGroup { title: string; items: NavItem[] }

/** Administration layout: grouped sidebar, top bar with the signed-in identity, status bar and the page outlet. */
@Component({ selector: 'app-shell', imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule], templateUrl: './shell.html', styleUrl: './shell.css' })
export class Shell {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  protected branches=signal<BranchInfo[]>([]);protected newBranch='';protected working='';protected review=signal<any>(null);protected workingBusy=signal(false);
  async ngOnInit(){await this.loadBranches();}
  private headers():Record<string,string>{return this.s.adminToken()?{'x-api-admin-token':this.s.adminToken()}:{};}
  protected async loadBranches(){try{const v=new VersioningClient(this.s.api);v.adminToken=this.s.adminToken();this.branches.set((await v.branches()).branches);}catch(e){this.s.say((e as Error).message,'error');}}
  protected async select(){this.s.selectBranch(this.working);this.review.set(null);this.s.say(this.working==='main'?'Viewing main (read only).':'Working on '+this.working+'. Changes stay here until Apply.');}
  protected async create(){try{const v=new VersioningClient(this.s.api);v.adminToken=this.s.adminToken();await v.createBranch(this.newBranch,'main');this.working=this.newBranch;this.newBranch='';await this.loadBranches();await this.select();}catch(e){this.s.say((e as Error).message,'error');}}
  protected async prepareApply(){this.workingBusy.set(true);try{await this.loadBranches();const r=await this.s.api.raw<any>('GET','/workspace',undefined,this.headers());this.review.set(r.data);}catch(e){this.s.say((e as Error).message,'error');}finally{this.workingBusy.set(false);}}
  protected async apply(){if(!confirm('Apply '+this.s.branch()+' into Dolt main? Its users, plugins and role permissions will become live.'))return;this.workingBusy.set(true);try{const head=this.branches().find(b=>b.name===this.s.branch())?.commit;const r=await this.s.api.raw<any>('POST','/workspace/apply',{confirm:true,expectedHead:head},this.headers());if(r.status>=400 || !r.data.applied)throw new Error(r.data.message??'Apply refused');this.review.set(null);this.s.branchEpoch.update(x=>x+1);this.s.say('Applied '+this.s.branch()+' into main: '+r.data.commit);await this.loadBranches();}catch(e){this.s.say((e as Error).message,'error');}finally{this.workingBusy.set(false);}}
  protected readonly menu = signal(false);
  protected readonly title = signal('');
  protected readonly nav: NavGroup[] = [
    { title: 'Overview', items: [{ path: '/overview', label: 'Dashboard', icon: '◧' }] },
    { title: 'Access (IAM)', items: [
      { path: '/users', label: 'Users', icon: '♙' },
      { path: '/assignments', label: 'Assignments & changes', icon: '⇄' },
      { path: '/activation', label: 'Activation', icon: '⏻' }] },
    { title: 'Extensions', items: [{ path: '/plugins', label: 'Plugins', icon: '⬡' }] },
    { title: 'Database (Dolt)', items: [
      { path: '/database/branches', label: 'Branches', icon: '⑂' },
      { path: '/database/history', label: 'History', icon: '◷' },
      { path: '/database/compare', label: 'Compare', icon: '⇋' },
      { path: '/database/data', label: 'Data', icon: '▦' },
      { path: '/database/sql', label: 'SQL', icon: '❯' },
      { path: '/database/pulls', label: 'Pull requests', icon: '⤴' }] },
  ];

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => { this.menu.set(false); this.title.set(this.leafTitle()); });
    this.title.set(this.leafTitle());
  }
  private leafTitle(): string {
    let r = this.router.routerState.snapshot.root; while (r.firstChild) r = r.firstChild;
    return (r.title as string | undefined) ?? '';
  }
  protected signOut() { this.s.signOut(); void this.router.navigateByUrl('/login'); }
}
