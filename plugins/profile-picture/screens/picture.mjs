// Profile picture component, packaged with the plugin. The profile surfaces (My profile, the admin user sheet)
// import this module through the plugin assets route and hand it the session context:
//   { tenant, api, token, adminToken, branch, surface: 'self'|'admin', subject? (admin surface), mode: 'manage'|'readonly' }
// The value itself is an ordinary profile field (profile-picture.picture, type image): it flows through the
// generic profile API, so an administrator's profile configuration (enabled / selfView / selfEdit) applies here.
// mode 'readonly' forces the read-only rendering whatever the field configuration says (the server checks again).

const css = `
:host{color:var(--ink,#0f172a)}
.ppf{display:flex;gap:1em;align-items:flex-start;flex-wrap:wrap}
.ppf img{width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid var(--field-line,#cbd5e1)}
.ppf .empty{width:96px;height:96px;border-radius:50%;border:2px dashed var(--field-line,#cbd5e1);display:flex;align-items:center;justify-content:center;color:var(--muted,#64748b);font-size:.8em;text-align:center}
.ppf .col{display:flex;flex-direction:column;gap:.4em}
.ppf button,.ppf label.up{cursor:pointer;border:1px solid var(--field-line,#cbd5e1);background:transparent;color:inherit;border-radius:6px;padding:.5em 1em;font:inherit;min-height:44px}
.ppf label.up{display:inline-flex;align-items:center}
.ppf input[type=file]{display:none}
.ppf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}
.ppf .bad{background:var(--bad-soft,#fee2e2);color:var(--bad-ink,#7f1d1d)}
.ppf .ok{background:var(--ok-soft,#dcfce7);color:var(--ok,#15803d)}
.ppf .hint{color:var(--label,#475569);font-size:.85em;max-width:32em}
`;

const FIELD = 'profile-picture.picture';
/** Server messages land in innerHTML: escape them. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class ProfilePicture extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', adminToken: '', branch: '', surface: 'self' };
    this._value = null; this._editable = false; this._loaded = false;
    this.render();
    void this.load();
  }
  h(admin) {
    const c = this._ctx, r = { 'content-type': 'application/json', authorization: `Bearer ${c.token}` };
    if (admin && c.adminToken) r['x-api-admin-token'] = c.adminToken;
    if (c.branch) r['x-iam-branch'] = c.branch;
    return r;
  }
  async load() {
    const admin = this._ctx.surface === 'admin';
    const url = admin ? `${this._ctx.api}/users/${encodeURIComponent(this._ctx.subject)}/profile` : `${this._ctx.api}/me/profile`;
    try {
      const r = await fetch(url, { headers: this.h(admin) });
      const d = await r.json().catch(() => ({}));
      if (r.status >= 400) throw new Error(d.message ?? `HTTP ${r.status}`);
      this._value = d.values?.[FIELD] ?? null;
      const f = (d.fields ?? []).find((x) => x.key === FIELD);
      this._editable = !admin && this._ctx.mode !== 'readonly' && !!f?.editable;
      this._visible = !!f; // the field is in the effective schema (enabled + visible for this surface)
    } catch (e) { this._error = e.message; }
    this._loaded = true;
    this.render();
  }
  async save(value) {
    try {
      const r = await fetch(`${this._ctx.api}/me/profile`, { method: 'PATCH', headers: this.h(false), body: JSON.stringify({ values: { [FIELD]: value } }) });
      const d = await r.json().catch(() => ({}));
      if (r.status >= 400) throw new Error(Array.isArray(d.message) ? d.message.join(' ') : d.message ?? 'Refused');
      this._value = d.values?.[FIELD] ?? value;
      this.say(value ? 'Picture saved.' : 'Picture removed.', '');
    } catch (e) { this.say('', e.message); }
    this.render();
  }
  say(note, problem) { this._note = note; this._problem = problem; }
  pick(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { this.say('', 'A png, jpeg or webp image is required.'); this.render(); return; }
    const img = new Image();
    img.onload = () => {
      const size = 256, canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const g = canvas.getContext('2d');
      const side = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      void this.save(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { this.say('', 'This file is not a readable image.'); this.render(); };
    img.src = URL.createObjectURL(file);
  }
  render() {
    const admin = this._ctx.surface === 'admin';
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const root = this.shadowRoot;
    if (this._error) { root.innerHTML = `<style>${css}</style><p class="msg bad">${esc(this._error)}</p>`; return; }
    if (!this._loaded) { root.innerHTML = `<style>${css}</style><p class="hint">Loading…</p>`; return; }
    if (this._visible === false) { root.innerHTML = `<style>${css}</style><p class="hint">The picture field is not shown on this surface (profile configuration).</p>`; return; }
    root.innerHTML = `<style>${css}</style>
      <div class="ppf">
        ${this._value ? `<img alt="Profile picture" src="${esc(this._value)}">` : `<span class="empty">No picture</span>`}
        <span class="col">
          ${this._editable ? `
            <label class="up">Choose a picture…<input type="file" accept="image/png,image/jpeg,image/webp"></label>
            ${this._value ? `<button type="button" class="rm">Remove</button>` : ''}
            <span class="hint">Squared and resized to 256 px on your device before upload (png, jpeg or webp, 256 KB max). Fictional demo: do not use a real photo.</span>`
          : `<span class="hint">${admin ? 'Administrators see the picture but cannot change it: it belongs to the person.' : 'This field is read only here.'}</span>`}
          ${this._note ? `<span class="msg ok">${esc(this._note)}</span>` : ''}
          ${this._problem ? `<span class="msg bad">${esc(this._problem)}</span>` : ''}
        </span>
      </div>`;
    const input = root.querySelector('input[type=file]');
    if (input) input.onchange = () => this.pick(input.files?.[0]);
    const rm = root.querySelector('.rm');
    if (rm) rm.onclick = () => void this.save(null);
  }
}
if (!customElements.get('iam-profile-picture')) customElements.define('iam-profile-picture', ProfilePicture);
export default 'iam-profile-picture';
