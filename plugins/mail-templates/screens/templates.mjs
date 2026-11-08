// Mail templates screen, packaged with the plugin (docs/mail-templates.md). The console host imports this
// module through the plugin assets route and hands it { tenant, api, token, adminToken, branch }. No framework:
// a signed, dependency-free custom element. Gallery of cards (one per mail type, the global layout first):
// live preview rendered by the API, default/customized badge, send-test; editing lands in the next step.

const css = `
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1em;margin-top:.8em}
.card{border:1px solid #ddd;border-radius:8px;padding:.9em;display:flex;flex-direction:column;gap:.5em}
.card.layout{border-color:#94a3b8;background:#f8fafc}
h3{margin:0;font-size:1em}.meta{color:#666;font-size:.82em}
.badge{display:inline-block;font-size:.72em;padding:.15em .5em;border-radius:999px;background:#e2e8f0;color:#334155}
.badge.custom{background:#dbeafe;color:#1d4ed8}
iframe{width:100%;height:170px;border:1px solid #e2e8f0;border-radius:6px;background:#fff}
.subject{font-size:.88em;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap}
button{max-width:12em}button[disabled]{opacity:.5}
input[type=email]{max-width:16em}
.msg{padding:.4em .6em;border-radius:4px}.bad{background:#fdd;color:#900}
.hint{color:#666;font-size:.85em}.lead{font-size:1.02em}
`;

class MailTemplatesScreen extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', adminToken: '', branch: '' };
    this._items = []; this._previews = {}; this._testFor = '';
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
      this.render(); this.say('', '');
      // Live previews render one card at a time through the API (the real renderer + this branch's overrides).
      for (const it of this._items.filter((x) => !x.layout)) {
        const p = await this.call('POST', '/mail-templates/preview', { key: it.key });
        if (p.status < 400 && p.data.html) { this._previews[it.key] = p.data.html; this.paintPreview(it.key); }
      }
    } catch (e) { this.say('', String(e?.message ?? e)); }
  }
  paintPreview(key) {
    const f = this.querySelector(`iframe[data-prev="${CSS.escape(key)}"]`);
    if (f) f.srcdoc = this._previews[key];
  }
  async sendTest(key) {
    const input = this.querySelector(`input[data-to="${CSS.escape(key)}"]`);
    const to = (input?.value ?? '').trim();
    if (!to) { this.say('', 'Enter a recipient e-mail first.'); return; }
    const r = await this.call('POST', `/mail-templates/${encodeURIComponent(key)}/send-test`, { to });
    if (this.fail(r)) return;
    this.say(r.data.real ? `Test e-mail sent to ${to} (real delivery).` : `Test e-mail rendered and handed to the notifier (simulated delivery; see the demo outbox / logs).`, '');
  }
  async restore(key) {
    const r = await this.call('DELETE', `/mail-templates/${encodeURIComponent(key)}`);
    if (this.fail(r)) return;
    this.say(`"${key}" restored to the plugin default. Saved on the working branch; live after Apply.`, '');
    await this.load();
  }

  render() {
    const main = this._ctx.branch === 'main';
    const cards = this._items.map((it) => `
    <section class="card ${it.layout ? 'layout' : ''}">
      <div class="row"><h3>${this.esc(it.name)}</h3>
        <span class="badge ${it.customized ? 'custom' : ''}">${it.customized ? 'Customized' : 'Default'}</span>
        ${it.layout ? '<span class="badge">Layout</span>' : ''}</div>
      <div class="meta">${this.esc(it.key)} · plugin ${this.esc(it.plugin)}${it.description ? ` · ${this.esc(it.description)}` : ''}</div>
      ${it.layout
        ? '<div class="subject">Shared page shell: logo, brand colors and footer wrapped around every e-mail body.</div>'
        : `<div class="subject" title="${this.esc(it.effective.subject)}">Subject: ${this.esc(it.effective.subject)}</div>
           <iframe data-prev="${this.esc(it.key)}" title="Preview of ${this.esc(it.name)}" sandbox=""></iframe>`}
      <div class="row">
        <input type="email" placeholder="Send a test to…" data-to="${this.esc(it.key)}" aria-label="Test recipient for ${this.esc(it.name)}">
        <button class="secondary" data-test="${this.esc(it.key)}">Send test</button>
        ${it.customized ? `<button class="secondary" data-restore="${this.esc(it.key)}" ${main ? 'disabled' : ''}>Restore default</button>` : ''}
      </div>
    </section>`).join('');
    this.innerHTML = `<style>${css}</style>
  <p class="lead">Mail templates. Every e-mail the platform sends is listed here, plus the global layout each body is wrapped in. The wording ships with each plugin in English; customizing writes on the working branch and goes live on Apply.</p>
  <p role="status" class="msg" id="mt-note" hidden></p>
  <p role="alert" class="msg bad" id="mt-problem" hidden></p>
  ${main ? '<p class="hint">main is read only: choose a working branch to customize or restore a template.</p>' : ''}
  <div class="grid">${cards || '<p class="hint">Loading…</p>'}</div>`;
    this.wire();
    for (const k of Object.keys(this._previews)) this.paintPreview(k);
  }
  wire() {
    for (const b of this.querySelectorAll('[data-test]')) b.addEventListener('click', () => void this.sendTest(b.getAttribute('data-test')));
    for (const b of this.querySelectorAll('[data-restore]')) b.addEventListener('click', () => void this.restore(b.getAttribute('data-restore')));
  }
}
customElements.define('plg-mail-templates', MailTemplatesScreen);
export default 'plg-mail-templates';
