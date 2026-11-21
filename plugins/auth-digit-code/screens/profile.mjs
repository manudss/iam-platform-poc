// PIN (digit code) profile component, packaged with the plugin. Surfaces:
//   self: set or change the PIN (changing requires the current one).
//   admin: set a PIN for someone (provisioning, never shown again) or revoke it.
// Context: { tenant, api, token, adminToken, branch, surface, subject?, mode: 'manage' | 'readonly' }
// mode 'readonly' (the administrator demoted the component in the profile configuration): status only,
// no mutating control. The server checks every call again; this is the display side of the contract.

/** Show/hide control for the password and PIN inputs of this screen. It only flips the input's own type (what is being typed now);
 *  nothing stored is ever prefilled or revealed. Hidden by default and again when focus leaves the field and its button. */
function withReveal(root) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.closest('.reveal-wrap')) return;
    const wrap = document.createElement('span'); wrap.className = 'reveal-wrap';
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'reveal-btn'; wrap.appendChild(btn);
    const paint = (show) => { input.type = show ? 'text' : 'password'; btn.textContent = show ? 'Hide' : 'Show'; btn.setAttribute('aria-pressed', String(show)); const l = show ? 'Hide what you typed' : 'Show what you typed'; btn.setAttribute('aria-label', l); btn.title = l; };
    paint(false);
    btn.addEventListener('mousedown', (e) => e.preventDefault());   // a click keeps focus in the field: no blur before the toggle
    btn.addEventListener('click', () => paint(input.type === 'password'));
    wrap.addEventListener('focusout', (e) => { if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) paint(false); });
  });
}

const css = `
  .reveal-wrap { display: inline-flex; align-items: stretch; gap: .35rem; max-width: 100%; }
  .reveal-wrap > input { flex: 1 1 auto; min-width: 0; }
  .reveal-btn { flex: none; min-width: 3.6rem; padding: 0 .6rem; border: 1px solid var(--line); border-radius: 8px; background: var(--field-bg); color: inherit; font: inherit; font-size: .85rem; cursor: pointer; }
  .reveal-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

:host{color:var(--ink)}
.ppf{font:inherit}.ppf .row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin:.4em 0}
.ppf button{cursor:pointer;border:1px solid var(--field-line);background:transparent;color:inherit;border-radius:6px;padding:.5em 1em;font:inherit;min-height:44px;min-width:44px}
.ppf button.danger{border-color:var(--bad);color:var(--bad)}
.ppf input{font:inherit;padding:.5em;max-width:10em;min-height:44px;box-sizing:border-box;background:var(--field-bg);color:inherit;border:1px solid var(--field-line);border-radius:6px}
.ppf .msg{font-size:.9em;padding:.3em .6em;border-radius:4px}.ppf .bad{background:var(--bad-soft);color:var(--bad-ink)}.ppf .ok{background:var(--ok-soft);color:var(--ok)}
.ppf .hint{color:var(--label);font-size:.85em;max-width:36em}
.ppf .status{display:inline-block;border-radius:999px;padding:.15em .7em;font-size:.85em}
.ppf .on{background:var(--ok-soft);color:var(--ok)}.ppf .off{background:var(--code-bg);color:var(--muted)}
.ppf .immediate{color:var(--warn-ink);background:var(--warn-soft);border:1px solid var(--warn-line);border-radius:6px;padding:.4em .7em;font-size:.85em;margin:.5em 0}
`;

/** Text/attribute escaping: instance names and server messages land in innerHTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** "3 Nov 2026" / "never": enrolment dates come back as ISO strings (null on older records). */
const fmtDate = (iso) => { if (!iso) return 'never'; const d = new Date(iso); return Number.isNaN(+d) ? 'never' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

class PinProfile extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', surface: 'self' };
    this._insts = []; this._status = {}; this._edit = null; this._confirm = null; this._loaded = false;
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
    this._loaded = true; // an answer came back: stop showing Loading
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
      if (!this.fail(cfg)) this._insts = (cfg.data.working?.config?.methods ?? cfg.data.live?.config?.methods ?? []).filter((m) => m.type === 'digit-code' && m.enabled).map((m) => ({ id: m.id, name: m.name, length: m.config?.length ?? 6 }));
    }
    this._loaded = true; this.render();
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
    this._confirm = null; this.say(admin ? 'PIN revoked.' : 'PIN removed.', ''); await this.load();
  }
  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const admin = this._ctx.surface === 'admin';
    const ro = this._ctx.mode === 'readonly';
    const root = this.shadowRoot;
    const rows = this._insts.map((m) => {
      const st = this._status[m.id]?.pin;
      const on = !!st;
      const edit = !ro && this._edit === m.id;
      const confirming = !ro && this._confirm === m.id;
      return `<div class="row" data-inst="${esc(m.id)}" data-len="${esc(m.length ?? '')}">
        <b>${esc(m.name ?? m.id)}</b> <span class="status ${on ? 'on' : 'off'}">${on ? `Set (${st.length} digits)` : 'Not set'}</span>
        ${on ? `<span class="hint">set on ${esc(fmtDate(st.enrolledAt))}${st.lastUsedAt ? ` · last used ${esc(fmtDate(st.lastUsedAt))}` : ''}</span>` : ''}
        ${!ro && !edit && !confirming ? `<button class="change">${on ? (admin ? 'Set a new PIN…' : 'Change…') : 'Set a PIN…'}</button>` : ''}
        ${!ro && on && !edit && !confirming ? `<button class="remove danger">${admin ? 'Revoke' : 'Remove'}</button>` : ''}
        ${confirming ? `<span class="hint">Really ${admin ? 'revoke this PIN' : 'remove this PIN'}? This takes effect immediately.</span>
          <button class="confirm-remove danger">Confirm</button><button class="cancel-remove">Cancel</button>` : ''}
        ${edit ? `${!admin && on ? '<input class="cur" type="password" inputmode="numeric" placeholder="Current PIN" aria-label="Current PIN">' : ''}
                  <input class="pin" type="password" inputmode="numeric" placeholder="New PIN" aria-label="New PIN">
                  <button class="save">Save</button><button class="cancel">Cancel</button>` : ''}
      </div>`;
    }).join('');
    root.innerHTML = `<style>${css}</style><div class="ppf">
      ${!this._loaded ? '<p class="hint">Loading...</p>' : rows || '<p class="hint">No PIN method is enabled in the sign-in configuration.</p>'}
      <p class="hint">A PIN is stored hashed and never shown anywhere${admin ? '; setting one for someone provisions the demo method' : ''}.</p>
      ${admin && !ro ? '<p class="immediate">Changes here take effect immediately. Save user and Cancel do not undo them.</p>' : ''}
      ${this._note ? `<p class="msg ok">${esc(this._note)}</p>` : ''}
      ${this._problem ? `<p class="msg bad">${esc(this._problem)}</p>` : ''}
    </div>`;
    withReveal(root);
    root.querySelectorAll('.row[data-inst]').forEach((row) => {
      const inst = row.getAttribute('data-inst');
      row.querySelector('.change')?.addEventListener('click', () => { this._edit = inst; this._confirm = null; this.render(); });
      row.querySelector('.cancel')?.addEventListener('click', () => { this._edit = null; this.render(); });
      row.querySelector('.remove')?.addEventListener('click', () => { this._confirm = inst; this._edit = null; this.render(); });
      row.querySelector('.cancel-remove')?.addEventListener('click', () => { this._confirm = null; this.render(); });
      row.querySelector('.confirm-remove')?.addEventListener('click', () => void this.remove(inst, admin));
      row.querySelector('.save')?.addEventListener('click', () => void this.set(inst, row.querySelector('.pin')?.value ?? '', row.querySelector('.cur')?.value, admin));
    });
  }
}
if (!customElements.get('iam-pin-profile')) customElements.define('iam-pin-profile', PinProfile);
export default 'iam-pin-profile';
