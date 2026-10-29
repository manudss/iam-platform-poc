import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Session } from './session';

interface NavItem { path: string; label: string; icon: string }
interface NavGroup { title: string; items: NavItem[] }

/** Administration layout: grouped sidebar, top bar with the signed-in identity, status bar and the page outlet. */
@Component({ selector: 'app-shell', imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule], templateUrl: './shell.html', styleUrl: './shell.css' })
export class Shell {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
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
