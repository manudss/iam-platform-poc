import { Component, inject } from '@angular/core';
import { Brand, Branding } from './branding';
import { Theme } from './theme';

/**
 * Console mock for the Customisation live preview: a static admin page (sidebar, cards, table, form) painted
 * only with the theme variables, so the palette under edit can be judged on a real console layout, in light and
 * dark and at mobile width. No API call, no session, no navigation. The parent frame (Customisation) posts the
 * draft theme; this page applies it like the sign-in preview does and never persists the theme choice.
 */
@Component({ selector: 'app-admin-preview', imports: [Brand], templateUrl: './admin-preview.html', styleUrl: './admin-preview.css' })
export class AdminPreviewPage {
  private readonly branding = inject(Branding);
  private readonly theme = inject(Theme);

  constructor() {
    addEventListener('message', (ev) => this.onMessage(ev));
    if (window.parent !== window) parent.postMessage({ type: 'iam-preview-ready' }, location.origin);
  }

  private onMessage(ev: MessageEvent) {
    if (ev.origin !== location.origin || ev.source !== parent) return;
    if (this.branding.preview(ev.data)) this.theme.mode.set((ev.data as { dark?: unknown }).dark === true ? 'dark' : 'light'); // not persisted: the admin choice is untouched
  }
}
