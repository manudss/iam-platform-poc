// PIN (digit code) profile component, packaged with the plugin. Surfaces:
//   self: set or change the PIN (changing requires the current one).
//   admin: set a PIN for someone (provisioning, never shown again) or revoke it.
// Context: { tenant, api, token, adminToken, branch, surface, subject? }

const css = `
.ppf{font:inherit}.ppf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.ppf button{cursor:pointer;border:1px solid #c9d4e3;background:transparent;border-radius:6px;padding:.35em .8em;font:inherit}
.ppf input{font:inherit;padding:.35em;max-width:10em}
.ppf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.ppf .bad{background:#fdd;color:#900}.ppf .ok{background:#e7f6e7;color:#175c17}
.ppf .hint{color:#666;font-size:.85em;max-width:36em}
.ppf .status{display:inline-block;border-radius:999px;padding:.15em .7em;font-size:.85em}
.ppf .on{background:#e7f6e7;color:#175c17}.ppf .off{background:#f1f4f9;color:#5a6a80}
`;

class PinProfile extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', surface: 'self' };
    this._insts = []; this._status = {}; this._edit = null;
    this.render(); void this.load();
  }
  h(admin) {
    const c = this._ctx, r = { 'content-type': 'application/json', authorization: `Bearer ${c.token}` };
    if (admin && c.adminToken) r['x-api-admin-token'] = c.adminToken;
    if (c.branch) r['x-iam-branch'] = c.branch;
    return r;
  }
  async call(method, path, body, admin) {
    const r = await fetch(`${this._ctx.api}${path}`, { method, headers: this.h(admin), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  fail(r) {
    if (r.status < 400) return false;
    this.say('', Array.isArray(r.data.message) ? r.data.message.join(' ') : (r.data.message ?? 'Refused'));
    return true;
  }
  say(note, problem) { this._note = note; this._problem = problem; this.render(); }
  async load() {
    const admin = this._ctx.surface === 'admin';
    const r = admin ? await this.call('GET', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}`, undefined, true)
                    : await this.call('GET', '/auth/me/enrollments');
    if (this.fail(r)) return;
    this._status = r.data.enrollments ?? {};
    this._insts = (r.data.methods ?? []).filter((m) => m.type === 'digit-code');
    if (admin && !this._insts.length) {
      const cfg = await this.call('GET', '/auth', undefined, true);
      if (!this.fail(cfg)) this._insts = (cfg.data.live?.config?.methods ?? []).filter((m) => m.type === 'digit-code' && m.enabled).map((m) => ({ id: m.id, name: m.name, length: m.config?.length ?? 6 }));
    }
    this.render();
  }
  async set(inst, pin, current, admin) {
    const r = admin ? await this.call('POST', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}/${encodeURIComponent(inst)}`, { pin }, true)
                    : await this.call('PUT', `/auth/me/enrollments/${encodeURIComponent(inst)}/pin`, { pin, current });
    if (this.fail(r)) return;
    this._edit = null; this.say(admin ? 'PIN set (never shown again).' : 'PIN saved.', ''); await this.load();
  }
  async remove(inst, admin) {
    const r = admin ? await this.call('DELETE', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}/${encodeURIComponent(inst)}`, undefined, true)
                    : await this.call('DELETE', `/auth/me/enrollments/${encodeURIComponent(inst)}`);
    if (this.fail(r)) return;
    this.say(admin ? 'PIN revoked.' : 'PIN removed.', ''); await this.load();
  }
  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const admin = this._ctx.surface === 'admin';
    const root = this.shadowRoot;
    const rows = this._insts.map((m) => {
      const st = this._status[m.id]?.pin;
      const on = !!st;
      const edit = this._edit === m.id;
      return `<div class="row" data-inst="${m.id}" data-len="${m.length ?? ''}">
        <b>${m.name ?? m.id}</b> <span class="status ${on ? 'on' : 'off'}">${on ? `Set (${st.length} digits)` : 'Not set'}</span>
        ${!edit ? `<button class="change">${on ? (admin ? 'Set a new PIN…' : 'Change…') : 'Set a PIN…'}</button>` : ''}
        ${on && !edit ? `<button class="remove">${admin ? 'Revoke' : 'Remove'}</button>` : ''}
        ${edit ? `<input class="cur" type="password" inputmode="numeric" placeholder="Current PIN" aria-label="Current PIN">
                  <input class="pin" type="password" inputmode="numeric" placeholder="New PIN" aria-label="New PIN">
                  <button class="save">Save</button><button class="cancel">Cancel</button>` : ''}
      </div>`;
    }).join('');
    root.innerHTML = `<style>${css}</style><div class="ppf">
      ${rows || '<p class="hint">No PIN method is enabled in the sign-in configuration.</p>'}
      <p class="hint">A PIN is stored hashed and never shown anywhere${admin ? '; setting one for someone provisions the demo method' : ''}.</p>
      ${this._note ? `<p class="msg ok">${this._note}</p>` : ''}
      ${this._problem ? `<p class="msg bad">${this._problem}</p>` : ''}
    </div>`;
    root.querySelectorAll('.row[data-inst]').forEach((row) => {
      const inst = row.getAttribute('data-inst');
      row.querySelector('.change')?.addEventListener('click', () => { this._edit = inst; this.render(); });
      row.querySelector('.cancel')?.addEventListener('click', () => { this._edit = null; this.render(); });
      row.querySelector('.save')?.addEventListener('click', () => void this.set(inst, row.querySelector('.pin')?.value ?? '', row.querySelector('.cur')?.value, admin));
      row.querySelector('.remove')?.addEventListener('click', () => void this.remove(inst, admin));
    });
  }
}
customElements.define('iam-pin-profile', PinProfile);
export default 'iam-pin-profile';
