import { Component, Injectable, computed, inject, input, signal } from '@angular/core';
import { Session } from './session';

/**
 * Pictures of the people shown in administrator lists and sheets. One shared source for every screen: the live profile picture
 * (the person saves it on main), returned by GET /users-pictures only for the people this administrator may read and only while the
 * profile-picture plugin is active. Without a picture, for any reason, the avatar falls back to initials.
 */
@Injectable({ providedIn: 'root' })
export class UserPictures {
  private readonly s = inject(Session);
  readonly map = signal<Record<string, string>>({});
  private loadedFor: string | null = null;
  /** Loads once per branch; `force` reloads (a list refresh). Best effort: a failure keeps the initials. */
  async ensure(force = false): Promise<void> {
    const key = String(this.s.branch() ?? '');
    if (!force && this.loadedFor === key) return;
    this.loadedFor = key;
    try {
      const r = await this.s.api.raw<{ pictures?: Record<string, string> }>('GET', '/users-pictures', undefined, this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {});
      this.map.set(r.status < 400 && r.data?.pictures ? r.data.pictures : {});
    } catch { this.map.set({}); }
  }
  get(id: string): string { const v = this.map()[id]; return typeof v === 'string' && v.startsWith('data:image/') ? v : ''; }
}

export const initialsOf = (name: string): string => {
  const p = (name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
};

/** Round avatar of a person: the picture when there is one, coloured initials otherwise. Size comes from --av-size (default 2.2rem). */
@Component({
  selector: 'app-avatar',
  template: `@if (photo()) {<img class="av" [src]="photo()" alt="" />} @else {<span class="av" aria-hidden="true" [style.background]="'color-mix(in srgb, ' + color() + ' 13%, transparent)'" [style.color]="color()" [style.border]="'1px solid ' + color()">{{ text() }}</span>}`,
  styles: [`
    :host { display: inline-flex; flex: none; }
    .av { width: var(--av-size, 2.2rem); height: var(--av-size, 2.2rem); border-radius: 50%; display: inline-grid; place-items: center; font-weight: 700; font-size: calc(var(--av-size, 2.2rem) * .4); box-sizing: border-box; object-fit: cover; flex: none; }
    img.av { border: 1px solid var(--line); }
  `],
})
export class UserAvatar {
  private readonly pics = inject(UserPictures);
  readonly userId = input.required<string>();
  readonly name = input<string>('');
  /** CSS colour (a variable is fine) for the initials; the callers pass the department colour. */
  readonly color = input<string>('var(--accent)');
  protected readonly photo = computed(() => this.pics.map()[this.userId()] && this.pics.get(this.userId()));
  protected readonly text = computed(() => initialsOf(this.name() || this.userId()));
  constructor() { void this.pics.ensure(); }
}
