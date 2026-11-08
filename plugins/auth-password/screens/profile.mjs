// Password profile component, packaged with the plugin. Self surface only by default: the person changes their
// password with the current one as re-authentication. (An administrator resets passwords from the user sheet's
// Security section - the surface default here is hidden, the admin can show a reminder from the profile config.)
// Context: { tenant, api, token, branch, surface }

const css = `
.pwf{font:inherit}.pwf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.pwf button{cursor:pointer;border:1px solid #c9d4e3;background:transparent;border-radius:6px;padding:.35em .8em;font:inherit}
.pwf input{font:inherit;padding:.35em;min-width:16em}
.pwf label{display:flex;flex-direction:column;font-size:.9em;gap:.15em}
.pwf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.pwf .bad{background:#fdd;color:#900}.pwf .ok{background:#e7f6e7;color:#175c17}
.pwf .hint{color:#666;font-size:.85em;max-width:36em}
`;

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
      root.innerHTML = `<style>${css}</style><div class="pwf"><p class="hint">Passwords are reset from the Security section of this sheet: a reset needs no old password and the person changes it back here afterwards.</p></div>`;
      return;
    }
    root.innerHTML = `<style>${css}</style><div class="pwf">
      <div class="row">
        <label>Current password<input class="cur" type="password" autocomplete="current-password"></label>
        <label>New password (12 to 128 characters)<input class="next" type="password" autocomplete="new-password"></label>
        <button class="go">Change my password</button>
      </div>
      ${this._note ? `<p class="msg ok">${this._note}</p>` : ''}
      ${this._problem ? `<p class="msg bad">${this._problem}</p>` : ''}
    </div>`;
    root.querySelector('.go')?.addEventListener('click', () => void this.change(root.querySelector('.cur')?.value ?? '', root.querySelector('.next')?.value ?? ''));
  }
}
customElements.define('iam-password-profile', PasswordProfile);
export default 'iam-password-profile';
