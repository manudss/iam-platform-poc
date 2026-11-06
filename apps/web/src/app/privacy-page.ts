import { Component } from '@angular/core';

/** Public privacy policy (no sign-in), required by the e-mail sending configuration. French first, English summary below. */
@Component({
  selector: 'app-privacy',
  styleUrl: './login.css',
  styles: [`
    .doc { width: min(46rem, 100%); padding: 2rem; }
    .doc h1 { margin: 0 0 .2rem; font-size: 1.4rem; }
    .doc h2 { margin: 1.4rem 0 .4rem; font-size: 1.02rem; }
    .doc p, .doc li { line-height: 1.55; }
    .doc ul { margin: .3rem 0; }
    .updated { color: var(--muted); font-size: .82rem; margin-top: 0; }
    a.back { display: inline-block; margin-top: 1.2rem; }
  `],
  templateUrl: './privacy-page.html',
})
export class PrivacyPage {}
