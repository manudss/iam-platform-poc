// Authenticator (TOTP) profile component, packaged with the plugin. Surfaces:
//   self: the person enrolls (secret shown once), confirms with a code, or removes their authenticator.
//   admin: status per user + revoke. An administrator NEVER enrolls a TOTP for someone else (the secret must
//          only ever be seen by the person): there is no enroll button on this surface.
// Context: { tenant, api, token, adminToken, branch, surface, subject? }

const css = `
.tpf{font:inherit}.tpf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.tpf button{cursor:pointer;border:1px solid #c9d4e3;background:transparent;border-radius:6px;padding:.35em .8em;font:inherit}
.tpf input{font:inherit;padding:.35em;max-width:10em}
.tpf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.tpf .bad{background:#fdd;color:#900}.tpf .ok{background:#e7f6e7;color:#175c17}
.tpf .hint{color:#666;font-size:.85em;max-width:36em}
.tpf code.secret{display:inline-block;font-size:1.05em;letter-spacing:.08em;background:#f1f4f9;border:1px solid #d7e0ec;border-radius:6px;padding:.4em .7em;margin:.3em 0;user-select:all}
.tpf .status{display:inline-block;border-radius:999px;padding:.15em .7em;font-size:.85em}
.tpf .on{background:#e7f6e7;color:#175c17}.tpf .off{background:#f1f4f9;color:#5a6a80}
`;

class TotpProfile extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', surface: 'self' };
    this._insts = []; this._status = {}; this._fresh = null;
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
    this._insts = (r.data.methods ?? []).filter((m) => m.type === 'totp');
    if (admin && !this._insts.length) {
      // The admin status endpoint does not list methods: fetch them from the shared auth configuration.
      const cfg = await this.call('GET', '/auth', undefined, true);
      if (!this.fail(cfg)) this._insts = (cfg.data.live?.config?.methods ?? []).filter((m) => m.type === 'totp' && m.enabled).map((m) => ({ id: m.id, name: m.name }));
    }
    this.render();
  }
  async enroll(inst) {
    const r = await this.call('POST', `/auth/me/enrollments/${encodeURIComponent(inst)}/totp`);
    if (this.fail(r)) return;
    this._fresh = { inst, secret: r.data.shownOnce.secret, uri: r.data.shownOnce.otpauthUri };
    this.say('', ''); await this.load();
  }
  async confirm(inst, code) {
    const r = await this.call('POST', `/auth/me/enrollments/${encodeURIComponent(inst)}/totp/confirm`, { code });
    if (this.fail(r)) return;
    this._fresh = null; this.say('Authenticator confirmed.', '');
  }
  async remove(inst, admin) {
    const r = admin ? await this.call('DELETE', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}/${encodeURIComponent(inst)}`, undefined, true)
                    : await this.call('DELETE', `/auth/me/enrollments/${encodeURIComponent(inst)}`);
    if (this.fail(r)) return;
    this._fresh = null; this.say(admin ? 'Enrollment revoked.' : 'Authenticator removed.', ''); await this.load();
  }
  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const admin = this._ctx.surface === 'admin';
    const root = this.shadowRoot;
    const rows = this._insts.map((m) => {
      const on = !!this._status[m.id]?.totp;
      return `<div class="row" data-inst="${m.id}">
        <b>${m.name ?? m.id}</b> <span class="status ${on ? 'on' : 'off'}">${on ? 'Enrolled' : 'Not enrolled'}</span>
        ${!admin && !on ? `<button class="enroll">Set up an authenticator…</button>` : ''}
        ${!admin && on ? `<button class="remove">Remove</button>` : ''}
        ${admin && on ? `<button class="remove-admin">Revoke</button>` : ''}
      </div>`;
    }).join('');
    root.innerHTML = `<style>${css}</style><div class="tpf">
      ${rows || '<p class="hint">No authenticator method is enabled in the sign-in configuration.</p>'}
      ${admin ? '<p class="hint">An administrator can see and revoke an enrollment, never create one: the secret must only ever be seen by the person.</p>' : ''}
      ${this._fresh ? `<div class="row" style="flex-direction:column;align-items:flex-start">
          <span class="hint">Add this key to the authenticator app of <b>${this._fresh.inst}</b> (shown once):</span>
          <code class="secret">${this._fresh.secret}</code>
          <span class="hint">or URI: <code>${this._fresh.uri}</code></span>
          <span class="row"><input id="code" inputmode="numeric" placeholder="Code from the app" aria-label="Code from the app"><button class="confirm">Confirm</button></span>
        </div>` : ''}
      ${this._note ? `<p class="msg ok">${this._note}</p>` : ''}
      ${this._problem ? `<p class="msg bad">${this._problem}</p>` : ''}
    </div>`;
    root.querySelectorAll('.row[data-inst]').forEach((row) => {
      const inst = row.getAttribute('data-inst');
      row.querySelector('.enroll')?.addEventListener('click', () => void this.enroll(inst));
      row.querySelector('.remove')?.addEventListener('click', () => void this.remove(inst, false));
      row.querySelector('.remove-admin')?.addEventListener('click', () => void this.remove(inst, true));
    });
    const cf = root.querySelector('.confirm');
    if (cf) cf.onclick = () => void this.confirm(this._fresh.inst, root.querySelector('#code')?.value ?? '');
  }
}
customElements.define('iam-totp-profile', TotpProfile);
export default 'iam-totp-profile';
