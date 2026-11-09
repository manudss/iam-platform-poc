// Password profile component, packaged with the plugin. Self surface only by default: the person changes their
// password with the current one as re-authentication. (An administrator resets passwords from the user sheet's
// Security section - the surface default here is hidden, the admin can show a reminder from the profile config.)
// Context: { tenant, api, token, branch, surface, mode: 'manage' | 'readonly' }
// mode 'readonly': the form is replaced by a note (the server checks every call again).

const css = `
:host{color:var(--ink)}
.pwf{font:inherit}.pwf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.pwf button{cursor:pointer;border:1px solid var(--field-line);background:transparent;color:inherit;border-radius:6px;padding:.5em 1em;font:inherit;min-height:44px;min-width:44px}
.pwf input{font:inherit;padding:.5em;min-width:16em;min-height:44px;box-sizing:border-box;background:var(--field-bg);color:inherit;border:1px solid var(--field-line);border-radius:6px}
.pwf label{display:flex;flex-direction:column;font-size:.9em;gap:.15em;color:var(--label)}
.pwf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.pwf .bad{background:var(--bad-soft);color:var(--bad-ink)}.pwf .ok{background:var(--ok-soft);color:var(--ok)}
.pwf .hint{color:var(--label);font-size:.85em;max-width:36em}
`;

/** Server messages land in innerHTML: escape them. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class PasswordProfile extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', surface: 'self' };
    this.render();
  }
  h() {
    const c = this._ctx, r = { 'content-type': 'application/json', authorization: `Bearer ${c.token}` };
    if (c.branch) r['x-iam-branch'] = c.branch;
    return r;
  }
  say(note, problem) { this._note = note; this._problem = problem; this.render(); }
  async change(current, next) {
    const r = await fetch(`${this._ctx.api}/auth/me/password`, { method: 'POST', headers: this.h(), body: JSON.stringify({ current, next }) });
    const d = await r.json().catch(() => ({}));
    if (r.status >= 400) { this.say('', Array.isArray(d.message) ? d.message.join(' ') : (d.message ?? 'Refused')); return; }
    this.say('Password changed. Your other sessions stay open until they expire.', '');
  }
  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const root = this.shadowRoot;
    if (this._ctx.surface === 'admin') {
      root.innerHTML = `<style>${css}</style><div class="pwf"><h4>Password lock status</h4><p class="hint">Unavailable: the password plugin does not expose a per-user lock-status query. This is not an unlocked status.</p><p class="hint">Passwords are reset from the Security section of this sheet: a reset needs no old password and the person changes it back here afterwards.</p></div>`;
      return;
    }
    if (this._ctx.mode === 'readonly') {
      root.innerHTML = `<style>${css}</style><div class="pwf"><p class="hint">Your administrator made this section read only.</p></div>`;
      return;
    }
    root.innerHTML = `<style>${css}</style><div class="pwf">
      <div class="row">
        <label>Current password<input class="cur" type="password" autocomplete="current-password"></label>
        <label>New password (12 to 128 characters)<input class="next" type="password" autocomplete="new-password"></label>
        <button class="go">Change my password</button>
      </div>
      ${this._note ? `<p class="msg ok">${esc(this._note)}</p>` : ''}
      ${this._problem ? `<p class="msg bad">${esc(this._problem)}</p>` : ''}
    </div>`;
    root.querySelector('.go')?.addEventListener('click', () => void this.change(root.querySelector('.cur')?.value ?? '', root.querySelector('.next')?.value ?? ''));
  }
}
if (!customElements.get('iam-password-profile')) customElements.define('iam-password-profile', PasswordProfile);
export default 'iam-password-profile';
