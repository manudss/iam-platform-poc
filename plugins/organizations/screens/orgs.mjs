// Organizations screen, packaged with the plugin (constat 4). The console's generic host imports this module
// through the plugin assets route, reads the default-exported tag, mounts the element and hands it the session
// context { tenant, api, token, adminToken, branch }. No framework: a signed, dependency-free custom element.

const css = `
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}
input,select{max-width:22em}.msg{padding:.4em .6em;border-radius:4px}.bad{background:#fdd;color:#900}
.row{display:flex;gap:.6em;align-items:end;flex-wrap:wrap;margin:.6em 0}.row label{display:flex;flex-direction:column;font-size:.85em}
.inline{margin-right:1em}.hint{color:#666;font-size:.85em}.lead{font-size:1.02em}
button[disabled]{opacity:.5}.card{border:1px solid #ddd;border-radius:6px;padding:.8em;margin:.8em 0}.scroll{overflow:auto}
`;

class OrganizationsScreen extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', adminToken: '', branch: '' };
    this._orgs = []; this._members = []; this._users = []; this._user = ''; this._chosen = [];
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
    const n = this.querySelector('#org-note'), p = this.querySelector('#org-problem');
    if (n) { n.textContent = note ?? ''; n.hidden = !note; }
    if (p) { p.textContent = problem ?? ''; p.hidden = !problem; }
  }
  async load() {
    try {
      const r = await this.call('GET', '/organizations');
      if (this.fail(r)) return;
      this._orgs = r.data.orgs ?? []; this._members = r.data.members ?? [];
      const u = await this.call('GET', '/users');
      this._users = u.status < 400 ? (u.data.users ?? []) : [];
      this.render(); this.say('', '');
    } catch (e) { this.say('', String(e?.message ?? e)); }
  }
  async run(method, path, body, ok) {
    const r = await this.call(method, path, body);
    if (this.fail(r)) return;
    this.say(ok + ' Saved on the working branch; live after Apply.', '');
    await this.load();
  }
  count(id) { return this._members.filter((m) => m.org_id === id).length; }
  esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  render() {
    const main = this._ctx.branch === 'main';
    const dis = main ? 'disabled' : '';
    const rows = this._orgs.map((o) => `<tr>
      <td><input name="on${this.esc(o.id)}" value="${this.esc(o.name)}" maxlength="80" aria-label="Name of ${this.esc(o.id)}" data-rename="${this.esc(o.id)}"><br><small>${this.esc(o.id)}</small></td>
      <td>${this.esc(o.parent_id || '-')}</td><td>${this.count(o.id)}</td>
      <td><button class="secondary" data-save="${this.esc(o.id)}" ${dis}>Save name</button>
          <button class="secondary" data-del="${this.esc(o.id)}" ${dis}>Delete</button></td></tr>`).join('');
    const options = this._orgs.map((o) => `<option value="${this.esc(o.id)}">${this.esc(o.name)}</option>`).join('');
    const users = this._users.map((u) => `<option value="${this.esc(u.id)}" ${u.id === this._user ? 'selected' : ''}>${this.esc(u.display_name)} (${this.esc(u.id)})</option>`).join('');
    const boxes = this._user ? this._orgs.map((o) => `<label class="inline"><input type="checkbox" name="m${this.esc(o.id)}" data-member="${this.esc(o.id)}" ${this._chosen.includes(o.id) ? 'checked' : ''}> ${this.esc(o.name)}</label>`).join('') : '';
    this.innerHTML = `<style>${css}</style>
  <p class="lead">Organizations (plugin). Create organizations, nest them, and assign people. A person sees their organizations on their profile, read only.</p>
  <p class="hint">Membership is an assignment made by an administrator. It is never asked at sign-up and no profile setting lets a person change it. Fictional demo only.</p>
  <p role="status" class="msg" id="org-note" hidden></p>
  <p role="alert" class="msg bad" id="org-problem" hidden></p>
  <section class="card"><div class="scroll"><table id="org-table"><thead><tr><th>Organization</th><th>Parent</th><th>Members</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">No organization yet.</td></tr>'}</tbody></table></div>
  <div class="row"><label>ID<input name="nid" pattern="[a-z0-9-]{1,32}"></label><label>Name<input name="nname" maxlength="80"></label>
  <label>Parent<select name="npar"><option value="">None</option>${options}</select></label>
  <button id="org-add" ${dis}>Add organization</button></div>
  ${main ? '<p class="hint">Choose a working branch (not main) to make changes.</p>' : ''}</section>
  <section class="card" id="org-assign"><h3>Assign a person</h3>
  <div class="row"><label>Person<select name="auser"><option value="">Choose...</option>${users}</select></label></div>
  ${this._user ? `<div class="row">${boxes}</div><button id="org-assign-save" ${dis}>Save assignment</button>` : ''}</section>`;
    this.wire();
  }
  wire() {
    const q = (s) => this.querySelector(s);
    q('#org-add')?.addEventListener('click', () => {
      const id = q('[name=nid]').value.trim(), name = q('[name=nname]').value.trim(), par = q('[name=npar]').value;
      void this.run('POST', '/organizations', { id, name, parent_id: par || null }, 'Organization added.');
    });
    for (const b of this.querySelectorAll('[data-save]')) b.addEventListener('click', () => {
      const id = b.getAttribute('data-save');
      void this.run('PATCH', `/organizations/${encodeURIComponent(id)}`, { name: this.querySelector(`[data-rename="${CSS.escape(id)}"]`).value }, 'Name saved.');
    });
    for (const b of this.querySelectorAll('[data-del]')) b.addEventListener('click', () => {
      void this.run('DELETE', `/organizations/${encodeURIComponent(b.getAttribute('data-del'))}`, undefined, 'Organization deleted.');
    });
    q('[name=auser]')?.addEventListener('change', (e) => {
      this._user = e.target.value;
      this._chosen = this._members.filter((m) => m.subject === this._user).map((m) => m.org_id);
      this.render();
    });
    for (const c of this.querySelectorAll('[data-member]')) c.addEventListener('change', () => {
      const id = c.getAttribute('data-member');
      this._chosen = c.checked ? [...new Set([...this._chosen, id])] : this._chosen.filter((x) => x !== id);
    });
    q('#org-assign-save')?.addEventListener('click', () => {
      void this.run('PUT', `/organizations/memberships/${encodeURIComponent(this._user)}`, { orgIds: this._chosen }, 'Assignment saved.');
    });
  }
}
customElements.define('plg-organizations-orgs', OrganizationsScreen);
export default 'plg-organizations-orgs';
