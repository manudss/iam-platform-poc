import { Component } from '@angular/core';
import { ThemeSwitch } from './theme-switch';

/** Public "about this demo" page (no sign-in): the explanations that used to sit on the sign-in page. English, like the rest of the console. */
@Component({
  selector: 'app-about',
  imports: [ThemeSwitch],
  styleUrl: './login.css',
  styles: [`
    .doc { width: min(46rem, 100%); padding: 2rem; }
    .doc h1 { margin: 0 0 .2rem; font-size: 1.4rem; }
    .doc h2 { margin: 1.4rem 0 .4rem; font-size: 1.02rem; }
    .doc p, .doc li { line-height: 1.55; }
    .doc ul { margin: .3rem 0; }
    .sub { color: var(--muted); font-size: .88rem; margin-top: 0; }
    .feat { display: flex; gap: .8rem; margin: .9rem 0; }
    .feat .fic { flex: none; width: 2.3rem; height: 2.3rem; border-radius: .65rem; display: grid; place-items: center; background: var(--chip-bg); color: var(--chip-ink); }
    .feat .fic svg { width: 1.15rem; height: 1.15rem; }
    .feat b { display: block; font-size: .95rem; }
    .feat span { color: var(--muted); font-size: .86rem; }
    a.back { display: inline-block; margin-top: 1.2rem; }
  `],
  template: `
  <div class="auth-bg" aria-hidden="true"><img src="https://picsum.photos/1920/1080" alt="" loading="eager"></div>
  <div class="auth-veil" aria-hidden="true"></div>
  <app-theme-switch class="auth-theme" />
  <main class="login">
    <article class="card doc" id="about-page">
      <div class="brand"><div class="brand-title"><picture class="brandlogo"><img class="for-light" src="/lyam-logo-horizontal-light.svg" alt="lyam"><img class="for-dark" src="/lyam-logo-horizontal-dark.svg" alt="" aria-hidden="true"></picture><span>Administration console</span></div></div>
      <h1 class="page-title">About this demo</h1>
      <p class="sub">iam.dss.name · Proof of concept</p>

      <p>This site is a proof of concept for a next-generation identity and access management (IAM) platform. It shows what sign-in, account management and access reviews look like when configuration and data are versioned, reviewed and applied like code.</p>

      <div class="feat"><span class="fic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8 7l7.5 4"/></svg></span>
        <div><b>Data branches</b><span>Every change lives on a Dolt data branch, reviewed and applied like code - nothing goes live silently.</span></div></div>
      <div class="feat"><span class="fic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg></span>
        <div><b>Event bus</b><span>Every module talks through a NATS event bus, with a live observer to watch the traffic.</span></div></div>
      <div class="feat"><span class="fic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span>
        <div><b>Plugins</b><span>Authentication methods, profiles, workflows: replaceable building blocks around a small trusted core.</span></div></div>

      <p>It also demonstrates chained multi-factor authentication with declared assurance levels, a shuffled PIN keypad, branch test sign-in, and AI access through a bounded MCP server.</p>

      <p><b>Fictional demonstration:</b> do not enter real personal data. Demo data resets on every restart. See the <a href="/privacy">privacy policy</a> for the details.</p>

      <a class="back" href="/login">&lsaquo; Back to sign in</a>
    </article>
  </main>`,
})
export class AboutPage {}
