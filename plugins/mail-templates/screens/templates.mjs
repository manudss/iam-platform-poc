// Mail templates screen, packaged with the plugin (docs/mail-templates.md). The console host imports this
// module through the plugin assets route and hands it { tenant, api, token, adminToken, branch }. No framework:
// a signed, dependency-free custom element. Two views: the gallery (one card per mail type, the global layout
// first: live preview, badges, send-test, restore) and the full-page editor (subject, Text/HTML tabs, sample
// data per declared variable, live preview of the unsaved draft, save/restore; the layout gets its own editor).

const css = `
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1em;margin-top:.8em}
.card{border:1px solid #ddd;border-radius:8px;padding:.9em;display:flex;flex-direction:column;gap:.5em;cursor:pointer}
.card.layout{border-color:#94a3b8;background:#f8fafc}
h3{margin:0;font-size:1em}.meta{color:#666;font-size:.82em}
.badge{display:inline-block;font-size:.72em;padding:.15em .5em;border-radius:999px;background:#e2e8f0;color:#334155}
.badge.custom{background:#dbeafe;color:#1d4ed8}
iframe{width:100%;height:170px;border:1px solid #e2e8f0;border-radius:6px;background:#fff}
.subject{font-size:.88em;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap}
button{max-width:14em}button[disabled]{opacity:.5}
input[type=email]{max-width:16em}
.msg{padding:.4em .6em;border-radius:4px}.bad{background:#fdd;color:#900}
.hint{color:#666;font-size:.85em}.lead{font-size:1.02em}
/* editor */
.editor{display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1fr);gap:1em;margin-top:.8em}
@media(max-width:900px){.editor{grid-template-columns:1fr}}
label.fl{display:flex;flex-direction:column;font-size:.85em;gap:.2em;margin-bottom:.6em}
input[type=text],textarea{font:inherit;padding:.3em .45em;border:1px solid #cbd5e1;border-radius:6px}
textarea{min-height:12em;font-family:ui-monospace,monospace;font-size:.85em}
.tabs{display:flex;gap:.3em;margin-bottom:.5em}
.tabs button{border:1px solid #cbd5e1;background:#f1f5f9;border-radius:6px 6px 0 0;padding:.3em .9em}
.tabs button.on{background:#fff;border-bottom-color:#fff}
iframe.big{height:100%;min-height:26em}
.vars{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.4em .8em;margin:.6em 0}
.panel{border:1px solid #e2e8f0;border-radius:8px;padding:.8em}
`;

class MailTemplatesScreen extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', adminToken: '', branch: '' };
    this._items = []; this._previews = {};
    this._view = 'gallery'; this._detail = null; this._draft = null; this._tab = 'html'; this._data = {};
    this.render();
    void this.load();
  }
  h() {
    const c = this._ctx, r = { 'content-type': 'application/json', authorization: `Bearer ${c.token}` };
    if (c.adminToken) r['x-api-admin-token'] = c.adminToken;
    if (c.branch) r['x-iam-branch'] = c.branch;
    return r;
  }
  async call(method, path, body) {
    const r = await fetch(`${this._ctx.api}${path}`, { method, headers: this.h(), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  fail(r) {
    if (r.status < 400) return false;
    this.say('', Array.isArray(r.data.message) ? r.data.message.join(' ') : (r.data.message ?? 'Refused'));
    return true;
  }
  say(note, problem) {
    const n = this.querySelector('#mt-note'), p = this.querySelector('#mt-problem');
    if (n) { n.textContent = note ?? ''; n.hidden = !note; }
    if (p) { p.textContent = problem ?? ''; p.hidden = !problem; }
  }
  esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  async load() {
    try {
      const r = await this.call('GET', '/mail-templates');
      if (this.fail(r)) return;
      this._items = Array.isArray(r.data) ? r.data : (r.data.items ?? []);
      if (this._view === 'gallery') { this.render(); this.say('', ''); }
      // Live previews render one card at a time through the API (the real renderer + this branch's overrides).
      for (const it of this._items.filter((x) => !x.layout)) {
        if (this._view !== 'gallery') return;
        const p = await this.call('POST', '/mail-templates/preview', { key: it.key });
        if (p.status < 400 && p.data.html) { this._previews[it.key] = p.data.html; this.paintPreview(it.key); }
      }
    } catch (e) { this.say('', String(e?.message ?? e)); }
  }
  paintPreview(key) {
    const f = this.querySelector(`iframe[data-prev="${CSS.escape(key)}"]`);
    if (f) f.srcdoc = this._previews[key];
  }
  async sendTest(key, to) {
    if (!to) { this.say('', 'Enter a recipient e-mail first.'); return; }
    const r = await this.call('POST', `/mail-templates/${encodeURIComponent(key)}/send-test`, { to });
    if (this.fail(r)) return;
    this.say(r.data.real ? `Test e-mail sent to ${to} (real delivery).` : `Test e-mail rendered and handed to the notifier (simulated delivery; see the demo outbox / logs).`, '');
  }
  async restore(key) {
    const r = await this.call('DELETE', `/mail-templates/${encodeURIComponent(key)}`);
    if (this.fail(r)) return;
    this.say(`"${key}" restored to the plugin default. Saved on the working branch; live after Apply.`, '');
    this._view = 'gallery'; this._detail = null;
    await this.load();
  }

  // ---------- editor ----------
  async openEditor(key) {
    const r = await this.call('GET', `/mail-templates/${encodeURIComponent(key)}`);
    if (this.fail(r)) return;
    this._detail = r.data;
    const e = r.data.effective;
    this._draft = r.data.layout
      ? { html: e.html ?? '', vars: { ...(e.vars ?? {}) } }
      : { subject: e.subject ?? '', text: e.text ?? '', html: e.html ?? '' };
    this._data = Object.fromEntries((r.data.variables ?? []).map((v) => [v.name, v.sample ?? `sample-${v.name}`]));
    this._tab = 'html'; this._view = 'edit';
    this.render();
    void this.refreshPreview();
  }
  async refreshPreview() {
    const d = this._detail; if (!d) return;
    const body = d.layout
      ? { key: 'sign-in-code', layoutOverride: { html: this._draft.html, vars: this._draft.vars } }
      : { key: d.key, data: this._data, override: { subject: this._draft.subject, text: this._draft.text, ...(this._draft.html ? { html: this._draft.html } : {}) } };
    const r = await this.call('POST', '/mail-templates/preview', body);
    const f = this.querySelector('#mt-big');
    if (r.status < 400 && f) f.srcdoc = r.data.html ?? `<p>${this.esc(r.data.text ?? '')}</p>`;
    else if (r.status >= 400) this.say('', Array.isArray(r.data.message) ? r.data.message.join(' ') : (r.data.message ?? 'Preview refused'));
  }
  previewSoon() { clearTimeout(this._pt); this._pt = setTimeout(() => void this.refreshPreview(), 350); }
  async save() {
    const d = this._detail; if (!d) return;
    const body = d.layout
      ? { html: this._draft.html, vars: this._draft.vars }
      : { subject: this._draft.subject, text: this._draft.text, ...(this._draft.html ? { html: this._draft.html } : {}) };
    const r = await this.call('PUT', `/mail-templates/${encodeURIComponent(d.key)}`, body);
    if (this.fail(r)) return;
    this.say(`"${d.key}" saved on the working branch; live after Apply.`, '');
    this._detail = r.data;
    this.render(); void this.refreshPreview();
  }

  // ---------- rendering ----------
  render() {
    if (this._view === 'edit' && this._detail) return this.renderEditor();
    const main = this._ctx.branch === 'main';
    const cards = this._items.map((it) => `
    <section class="card ${it.layout ? 'layout' : ''}" data-open="${this.esc(it.key)}">
      <div class="row"><h3>${this.esc(it.name)}</h3>
        <span class="badge ${it.customized ? 'custom' : ''}">${it.customized ? 'Customized' : 'Default'}</span>
        ${it.layout ? '<span class="badge">Layout</span>' : ''}</div>
      <div class="meta">${this.esc(it.key)} · plugin ${this.esc(it.plugin)}${it.description ? ` · ${this.esc(it.description)}` : ''}</div>
      ${it.layout
        ? '<div class="subject">Shared page shell: logo, brand colors and footer wrapped around every e-mail body.</div>'
        : `<div class="subject" title="${this.esc(it.effective.subject)}">Subject: ${this.esc(it.effective.subject)}</div>
           <iframe data-prev="${this.esc(it.key)}" title="Preview of ${this.esc(it.name)}" sandbox=""></iframe>`}
      <div class="row">
        <button data-edit="${this.esc(it.key)}" ${main ? 'disabled' : ''}>Edit</button>
        ${it.customized ? `<button class="secondary" data-restore="${this.esc(it.key)}" ${main ? 'disabled' : ''}>Restore default</button>` : ''}
      </div>
    </section>`).join('');
    this.innerHTML = `<style>${css}</style>
  <p class="lead">Mail templates. Every e-mail the platform sends is listed here, plus the global layout each body is wrapped in. The wording ships with each plugin in English; customizing writes on the working branch and goes live on Apply.</p>
  <p role="status" class="msg" id="mt-note" hidden></p>
  <p role="alert" class="msg bad" id="mt-problem" hidden></p>
  ${main ? '<p class="hint">main is read only: choose a working branch to customize or restore a template.</p>' : ''}
  <div class="grid">${cards || '<p class="hint">Loading…</p>'}</div>`;
    for (const b of this.querySelectorAll('[data-edit]')) b.addEventListener('click', (ev) => { ev.stopPropagation(); void this.openEditor(b.getAttribute('data-edit')); });
    for (const b of this.querySelectorAll('[data-restore]')) b.addEventListener('click', (ev) => { ev.stopPropagation(); void this.restore(b.getAttribute('data-restore')); });
    for (const c of this.querySelectorAll('[data-open]')) c.addEventListener('click', () => { if (this._ctx.branch !== 'main') void this.openEditor(c.getAttribute('data-open')); });
    for (const k of Object.keys(this._previews)) this.paintPreview(k);
  }

  renderEditor() {
    const d = this._detail, main = this._ctx.branch === 'main';
    const layoutVars = ['logo', 'logoUrl', 'brandColor', 'pageBg', 'footer'];
    const left = d.layout ? `
      <label class="fl">Layout HTML (must keep {{body}})
        <textarea id="mt-html" spellcheck="false">${this.esc(this._draft.html)}</textarea></label>
      <div class="panel"><strong>Layout variables</strong>
        <div class="vars">${layoutVars.map((v) => `<label class="fl">{{${v}}}<input type="text" data-var="${v}" value="${this.esc(this._draft.vars[v] ?? '')}"></label>`).join('')}</div>
        <p class="hint">logoUrl set: {{logo}} becomes that image. footer also joins the plain-text body after a dash line.</p></div>`
    : `
      <label class="fl">Subject<input type="text" id="mt-subject" value="${this.esc(this._draft.subject)}"></label>
      <div class="tabs" role="tablist">
        <button role="tab" class="${this._tab === 'text' ? 'on' : ''}" data-tab="text">Text</button>
        <button role="tab" class="${this._tab === 'html' ? 'on' : ''}" data-tab="html">HTML</button></div>
      <textarea id="mt-body" spellcheck="false" ${this._tab === 'text' ? '' : ''}>${this.esc(this._tab === 'text' ? this._draft.text : this._draft.html)}</textarea>
      <div class="panel"><strong>Sample data (preview and tests)</strong>
        <div class="vars">${(d.variables ?? []).map((v) => `<label class="fl">{{${this.esc(v.name)}}}<input type="text" data-var="${this.esc(v.name)}" value="${this.esc(this._data[v.name] ?? '')}"></label>`).join('')}</div></div>`;
    this.innerHTML = `<style>${css}</style>
  <p><button class="secondary" id="mt-back">← All templates</button></p>
  <div class="row"><h3 style="font-size:1.2em">${this.esc(d.name)}</h3>
    <span class="badge ${d.customized ? 'custom' : ''}">${d.customized ? 'Customized' : 'Default'}</span>
    ${d.layout ? '<span class="badge">Layout</span>' : ''}</div>
  <p class="meta">${this.esc(d.key)} · plugin ${this.esc(d.plugin)}${d.description ? ` · ${this.esc(d.description)}` : ''}</p>
  <p role="status" class="msg" id="mt-note" hidden></p>
  <p role="alert" class="msg bad" id="mt-problem" hidden></p>
  <div class="editor">
    <section>${left}
      <div class="row" style="margin-top:.6em">
        <button id="mt-save" ${main ? 'disabled' : ''}>Save on this branch</button>
        ${d.customized ? `<button class="secondary" id="mt-restore" ${main ? 'disabled' : ''}>Restore default</button>` : ''}
        ${!d.layout ? '<input type="email" id="mt-to" placeholder="Send a test to…" aria-label="Test recipient"><button class="secondary" id="mt-test">Send test</button>' : ''}
      </div></section>
    <section><iframe class="big" id="mt-big" title="Live preview" sandbox=""></iframe></section>
  </div>
  ${main ? '<p class="hint">main is read only: choose a working branch to save.</p>' : ''}`;
    const q = (s) => this.querySelector(s);
    q('#mt-back')?.addEventListener('click', () => { this._view = 'gallery'; this._detail = null; this.render(); void this.load(); });
    q('#mt-save')?.addEventListener('click', () => void this.save());
    q('#mt-restore')?.addEventListener('click', () => void this.restore(d.key));
    q('#mt-test')?.addEventListener('click', () => void this.sendTest(d.key, q('#mt-to')?.value.trim()));
    q('#mt-subject')?.addEventListener('input', (e) => { this._draft.subject = e.target.value; this.previewSoon(); });
    q('#mt-html')?.addEventListener('input', (e) => { this._draft.html = e.target.value; this.previewSoon(); });
    q('#mt-body')?.addEventListener('input', (e) => { if (this._tab === 'text') this._draft.text = e.target.value; else this._draft.html = e.target.value; this.previewSoon(); });
    for (const t of this.querySelectorAll('[data-tab]')) t.addEventListener('click', () => {
      const cur = q('#mt-body'); if (cur) { if (this._tab === 'text') this._draft.text = cur.value; else this._draft.html = cur.value; }
      this._tab = t.getAttribute('data-tab'); this.renderEditor(); void this.refreshPreview();
    });
    for (const i of this.querySelectorAll('[data-var]')) i.addEventListener('input', () => {
      if (d.layout) this._draft.vars[i.getAttribute('data-var')] = i.value; else this._data[i.getAttribute('data-var')] = i.value;
      this.previewSoon();
    });
  }
}
customElements.define('plg-mail-templates', MailTemplatesScreen);
export default 'plg-mail-templates';
