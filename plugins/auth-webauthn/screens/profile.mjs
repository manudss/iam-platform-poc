// Passkeys (WebAuthn / FIDO2) profile component, packaged with the auth-webauthn plugin. Surfaces:
//   self: the person registers a passkey (browser ceremony on their own session), names it, lists and removes theirs.
//   admin: status per user + revoke all (an administrator NEVER registers a passkey for someone else: the
//          private key is created by the person's authenticator, exactly like TOTP).
// Context: { tenant, api, token, adminToken, branch, surface, subject?, mode: 'manage' | 'readonly' }
// The ceremony uses the browser's native WebAuthn Level 3 JSON serialization when present, with a manual
// base64url fallback: no front dependency.

const css = `
:host{color:var(--ink,#0f172a)}
.wpf{font:inherit}.wpf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.wpf button{cursor:pointer;border:1px solid var(--field-line,#cbd5e1);background:transparent;color:inherit;border-radius:6px;padding:.5em 1em;font:inherit;min-height:44px;min-width:44px}
.wpf button.primary{background:var(--accent,#4f46e5);border-color:var(--accent,#4f46e5);color:#fff}
.wpf button.danger{border-color:var(--bad,#b91c1c);color:var(--bad,#b91c1c)}
.wpf button:disabled{opacity:.5;cursor:default}
.wpf input{font:inherit;padding:.5em;min-height:44px;box-sizing:border-box;background:var(--field-bg,#fff);color:inherit;border:1px solid var(--field-line,#cbd5e1);border-radius:6px}
.wpf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.wpf .bad{background:var(--bad-soft,#fee2e2);color:var(--bad-ink,#7f1d1d)}.wpf .ok{background:var(--ok-soft,#dcfce7);color:var(--ok,#15803d)}
.wpf .hint{color:var(--label,#475569);font-size:.85em;max-width:36em}
.wpf ul{list-style:none;margin:.4em 0;padding:0}
.wpf li{display:flex;gap:.6em;align-items:center;flex-wrap:wrap;padding:.5em .6em;border:1px solid var(--line,#e2e8f0);border-radius:8px;margin-bottom:.4em}
.wpf .pk-name{font-weight:600}
.wpf .pk-meta{color:var(--muted,#64748b);font-size:.85em}
.wpf .chip{border-radius:999px;padding:.1em .6em;font-size:.78em;background:var(--code-bg,#f1f5f9);color:var(--muted,#64748b)}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// base64url <-> bytes, and WebAuthn L3 JSON serialization with a manual fallback.
const b64u = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const enc = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const creationOptions = (o) => (window.PublicKeyCredential && PublicKeyCredential.parseCreationOptionsFromJSON)
  ? PublicKeyCredential.parseCreationOptionsFromJSON(o)
  : (() => { o.challenge = b64u(o.challenge); o.user.id = b64u(o.user.id); (o.excludeCredentials || []).forEach((c) => { c.id = b64u(c.id); }); return o; })();
const regJSON = (c) => c.toJSON ? c.toJSON() : {
  id: c.id, rawId: enc(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined,
  clientExtensionResults: c.getClientExtensionResults(),
  response: { attestationObject: enc(c.response.attestationObject), clientDataJSON: enc(c.response.clientDataJSON), transports: c.response.getTransports ? c.response.getTransports() : [] },
};

class PasskeysProfile extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', surface: 'self' };
    this._insts = []; this._status = {}; this._busy = false;
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
    this._loaded = true;
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
    this._insts = (r.data.methods ?? []).filter((m) => m.type === 'webauthn');
    if (admin && !this._insts.length) {
      const cfg = await this.call('GET', '/auth', undefined, true);
      if (!this.fail(cfg)) this._insts = (cfg.data.working?.config?.methods ?? cfg.data.live?.config?.methods ?? []).filter((m) => m.type === 'webauthn' && m.enabled).map((m) => ({ id: m.id, name: m.name }));
    }
    this._loaded = true; this.render();
  }
  async register(inst) {
    if (!window.PublicKeyCredential || !navigator.credentials) { this.say('', 'This browser has no passkey support (WebAuthn).'); return; }
    this._busy = true; this.say('Follow the instructions of your device...', '');
    const o = await this.call('POST', `/auth/me/enrollments/${encodeURIComponent(inst)}/passkey/options`);
    if (this.fail(o)) { this._busy = false; return; }
    let cred;
    try { cred = await navigator.credentials.create({ publicKey: creationOptions(o.data.options) }); }
    catch (e) { this._busy = false; this.say('', e && e.name === 'NotAllowedError' ? 'The ceremony was cancelled or timed out.' : 'The device refused to create a passkey.'); return; }
    const name = (this.getRootNode().querySelector?.('#pk-name')?.value ?? this.querySelector('#pk-name')?.value ?? '').trim();
    const f = await this.call('POST', `/auth/me/enrollments/${encodeURIComponent(inst)}/passkey`, { name: name || undefined, credential: regJSON(cred) });
    this._busy = false;
    if (this.fail(f)) return;
    this.say('Passkey registered. You can now sign in with it.', ''); await this.load();
  }
  async remove(inst, credId) {
    const admin = this._ctx.surface === 'admin';
    const r = admin ? await this.call('DELETE', `/auth/enrollments/${encodeURIComponent(this._ctx.subject)}/${encodeURIComponent(inst)}`, undefined, true)
                    : await this.call('DELETE', `/auth/me/enrollments/${encodeURIComponent(inst)}/passkey/${encodeURIComponent(credId)}`);
    if (this.fail(r)) return;
    this.say(admin ? 'All passkeys of this method revoked.' : 'Passkey removed.', ''); await this.load();
  }
  render() {
    const admin = this._ctx.surface === 'admin';
    const ro = this._ctx.mode === 'readonly';
    const rows = [];
    for (const m of this._insts) {
      const st = this._status[m.id], list = Array.isArray(st?.webauthn) ? st.webauthn : [];
      rows.push(`<h4 style="margin:.6em 0 .2em">${esc(m.name)}</h4>`);
      if (!list.length) rows.push(`<p class="hint">${admin ? 'No passkey enrolled.' : 'No passkey yet. Register one to sign in with this device.'}</p>`);
      else rows.push(`<ul>${list.map((c) => `<li><span class="pk-name">${esc(c.name ?? 'Passkey')}</span>
        <span class="pk-meta">added ${esc(String(c.createdAt ?? '').slice(0, 10))}</span>
        ${c.backedUp ? '<span class="chip">synced</span>' : '<span class="chip">this device</span>'}
        ${!ro && !admin ? `<button class="danger" data-del="${esc(m.id)}|${esc(c.id)}">Remove</button>` : ''}</li>`).join('')}</ul>`);
      if (!ro && !admin) rows.push(`<div class="row"><input id="pk-name" placeholder="Name (e.g. My phone)" maxlength="60"><button class="primary" data-add="${esc(m.id)}" ${this._busy ? 'disabled' : ''}>${this._busy ? 'Working...' : 'Add a passkey'}</button></div>`);
      if (!ro && admin && list.length) rows.push(`<div class="row"><button class="danger" data-delall="${esc(m.id)}">Revoke all passkeys</button></div>`);
    }
    this.innerHTML = `<style>${css}</style><div class="wpf">
      ${this._note ? `<p class="msg ok">${esc(this._note)}</p>` : ''}${this._problem ? `<p class="msg bad">${esc(this._problem)}</p>` : ''}
      ${!this._loaded ? '<p class="hint">Loading...</p>' : (this._insts.length ? rows.join('') : '<p class="hint">No passkey method is enabled.</p>')}
    </div>`;
    this.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => void this.register(b.getAttribute('data-add')); });
    this.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { const [i, c] = b.getAttribute('data-del').split('|'); void this.remove(i, c); }; });
    this.querySelectorAll('[data-delall]').forEach((b) => { b.onclick = () => void this.remove(b.getAttribute('data-delall'), ''); });
  }
}
if (!customElements.get('iam-passkeys-profile')) customElements.define('iam-passkeys-profile', PasskeysProfile);
export default 'iam-passkeys-profile';
