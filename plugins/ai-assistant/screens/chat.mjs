// AI assistant screen, packaged with the plugin. A signed, dependency-free custom element: the console's generic
// host imports it and hands it the session context { tenant, api, token, adminToken, branch }.
// Chat on the left, models (local + external, added by an administrator) below. Text from the model or from tool
// results is always inserted as text, never as HTML.

const css = `
.lead{font-size:1.02em}.hint{color:var(--muted);font-size:.85em}.msg{padding:.4em .6em;border-radius:.4rem}.bad{background:var(--bad-soft);color:var(--bad-ink)}
.ok{background:var(--ok-soft);color:var(--ok)}
.card{border:1px solid var(--line);border-radius:.6rem;padding:.8rem;margin:.8rem 0;background:var(--card)}
.layout{display:grid;grid-template-columns:minmax(14rem,18rem) 1fr;gap:1rem;align-items:start}
@media (max-width:900px){.layout{grid-template-columns:1fr}}
.convs{list-style:none;margin:.4rem 0;padding:0}.convs li{margin:.2rem 0}
.convs button{width:100%;text-align:left;margin:0}
.convs button.sel{background:var(--accent-soft);color:var(--ink);border-color:var(--accent)}
.thread{display:flex;flex-direction:column;gap:.6rem;max-height:60vh;overflow:auto;padding:.2rem}
.m{padding:.55rem .75rem;border-radius:.6rem;border:1px solid var(--line);white-space:pre-wrap;word-break:break-word}
.m.user{background:var(--accent-soft);align-self:flex-end;max-width:90%}.m.assistant{background:var(--panel);max-width:95%}
.m.tool{background:var(--code-bg);font-size:.8rem;max-height:9rem;overflow:auto;font-family:ui-monospace,monospace}
.call{font-size:.85rem;color:var(--muted)}
.pending{border:1px solid var(--warn-line);background:var(--warn-soft);color:var(--warn-ink);border-radius:.6rem;padding:.7rem;margin:.6rem 0}
.pending pre{white-space:pre-wrap;max-height:10rem;overflow:auto;margin:.4rem 0;background:var(--code-bg);color:var(--ink)}
select,input{max-width:100%;box-sizing:border-box}.row label{min-width:0;max-width:100%}
.row{display:flex;gap:.6rem;align-items:end;flex-wrap:wrap;margin:.5rem 0}.row label{display:flex;flex-direction:column;font-size:.85rem}
textarea{width:100%;min-height:4rem;box-sizing:border-box}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}
.scroll{overflow:auto}
`;

// Provider presets: the guidance lives here, in the plugin (where to get a key, what the endpoint is).
const PRESETS = [
  { id: 'ollama', label: 'Local model (Ollama, vLLM or another OpenAI-compatible server on this network)', kind: 'openai-compatible', baseUrl: 'http://ollama:11434/v1', model: 'llama3.1', keyNeeded: false,
    hint: 'No key and no data leaves your network. Use a model that supports tool calls. The operator must allow the server (host:port) in IAM_AI_LOCAL_ENDPOINTS (default: Ollama on localhost:11434).' },
  { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '', keyNeeded: true, link: 'https://platform.openai.com/api-keys', hint: 'Create an API key in the OpenAI platform and enter the model name you want to use.' },
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '', keyNeeded: true, link: 'https://console.anthropic.com/settings/keys', hint: 'Create an API key in the Anthropic console and enter the Claude model name.' },
  { id: 'mistral', label: 'Mistral', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', model: '', keyNeeded: true, link: 'https://console.mistral.ai/api-keys', hint: 'OpenAI-compatible endpoint. Choose a model that supports function calling.' },
  { id: 'gemini', label: 'Google Gemini (OpenAI-compatible endpoint)', kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', keyNeeded: true, link: 'https://aistudio.google.com/apikey', hint: 'The free tier may use your content to improve the provider products: prefer a paid key for real data.' },
  { id: 'custom', label: 'Other OpenAI-compatible endpoint (agent gateway, LiteLLM, OpenRouter, Azure...)', kind: 'openai-compatible', baseUrl: '', model: '', keyNeeded: true, hint: 'Any endpoint that answers /chat/completions with tool calls. https is required for a remote host.' },
];

class AiAssistantScreen extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', adminToken: '', branch: '' };
    this._models = []; this._convs = []; this._cur = null; this._thread = null; this._busy = false; this._confirmDelete = false; this._preset = 'ollama'; this._note = ''; this._problem = '';
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
    const r = await fetch(`${this._ctx.api}/ai${path}`, { method, headers: this.h(), body: body !== undefined ? JSON.stringify(body) : (method === 'GET' || method === 'DELETE' ? undefined : '{}') });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  fail(r) {
    if (r.status < 400) return false;
    this._problem = Array.isArray(r.data.message) ? r.data.message.join(' ') : (r.data.message ?? 'Refused'); this._note = '';
    return true;
  }
  esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  async load() {
    const m = await this.call('GET', '/models');
    if (this.fail(m)) { this.render(); return; }
    this._models = m.data.models ?? [];
    const c = await this.call('GET', '/conversations');
    this._convs = c.status < 400 ? (c.data.conversations ?? []) : [];
    this._problem = ''; this.render();
  }
  async open(id) {
    const r = await this.call('GET', `/conversations/${encodeURIComponent(id)}`);
    if (this.fail(r)) { this.render(); return; }
    this._cur = r.data.conversation; this._thread = { messages: r.data.messages ?? [], pending: r.data.pending ?? [], branch: r.data.branch, active: r.data.sessionActive };
    this._confirmDelete = false; this._problem = ''; this.render(); this.scrollDown();
  }
  scrollDown() { const t = this.querySelector('#ai-thread'); if (t) t.scrollTop = t.scrollHeight; }
  merge(reply) {
    this._thread.messages.push(...(reply.messages ?? []));
    this._thread.pending = reply.pending ?? [];
    if (reply.branch) this._thread.branch = reply.branch;
    this._note = reply.status === 'limit' ? 'The assistant stopped at its step limit. Send another message to continue.' : '';
  }
  async send() {
    const box = this.querySelector('[name=aimsg]'); const text = box?.value.trim();
    if (!text || this._busy || !this._cur) return;
    this._busy = true; this._thread.messages.push({ role: 'user', content: text }); box.value = ''; this.render(); this.scrollDown();
    const r = await this.call('POST', `/conversations/${encodeURIComponent(this._cur.id)}/messages`, { content: text });
    this._busy = false;
    if (this.fail(r)) { await this.open(this._cur.id); return; }
    this.merge(r.data); this.render(); this.scrollDown();
  }
  async decide(decisions) {
    this._busy = true; this.render();
    const r = await this.call('POST', `/conversations/${encodeURIComponent(this._cur.id)}/decisions`, { decisions });
    this._busy = false;
    if (this.fail(r)) { await this.open(this._cur.id); return; }
    this.merge(r.data); this.render(); this.scrollDown();
  }
  async newConversation() {
    const sel = this.querySelector('[name=aimodel]'); const title = this.querySelector('[name=aititle]')?.value.trim();
    if (!sel?.value) { this._problem = 'Choose a model first (add one below if the list is empty).'; this.render(); return; }
    const auto = this.querySelector('[name=aiauto]')?.checked === true;
    const r = await this.call('POST', '/conversations', { modelId: sel.value, title: title || undefined, autoApproveWrites: auto });
    if (this.fail(r)) { this.render(); return; }
    await this.load(); await this.open(r.data.conversation.id);
  }
  async removeConversation() {
    if (!this._confirmDelete) { this._confirmDelete = true; this.render(); return; }
    const r = await this.call('DELETE', `/conversations/${encodeURIComponent(this._cur.id)}`);
    if (this.fail(r)) { this.render(); return; }
    this._cur = null; this._thread = null; this._confirmDelete = false; this._note = 'Conversation deleted. Its working branch stays until a human cleans it up.'; await this.load();
  }
  async addModel() {
    const q = (n) => this.querySelector(`[name=${n}]`);
    const p = PRESETS.find((x) => x.id === this._preset);
    const body = { name: q('mname').value.trim(), kind: p.kind, model: q('mmodel').value.trim(), baseUrl: q('murl').value.trim(), maxTokens: Number(q('mtokens').value) || 2048, apiKey: q('mkey').value || undefined, acknowledgeDataSharing: q('mack').checked };
    const r = await this.call('POST', '/models', body);
    if (this.fail(r)) { this.render(); return; }
    this._note = `Model "${r.data.name}" added. Use Test to check the endpoint.`; await this.load();
  }
  async modelAction(id, action) {
    let r;
    if (action === 'test') { this._note = 'Testing...'; this.render(); r = await this.call('POST', `/models/${encodeURIComponent(id)}/test`, {}); if (!this.fail(r)) this._note = r.data.ok ? `Test passed: ${r.data.status}` : `Test failed: ${r.data.status}`; }
    else if (action === 'toggle') { const m = this._models.find((x) => x.id === id); r = await this.call('POST', `/models/${encodeURIComponent(id)}/enabled`, { enabled: !m.enabled }); this.fail(r); }
    else if (action === 'delete') { if (this._del !== id) { this._del = id; this.render(); return; } r = await this.call('DELETE', `/models/${encodeURIComponent(id)}`); this._del = null; if (!this.fail(r)) this._note = 'Model deleted.'; }
    await this.load();
  }
  renderMsg(m) {
    if (m.role === 'tool') return `<div class="m tool" data-role="tool"><b>${this.esc(m.toolName ?? 'tool')}</b>\n${this.esc(m.content)}</div>`;
    const calls = (m.toolCalls ?? []).map((c) => `<div class="call">uses <b>${this.esc(c.name)}</b> ${this.esc(JSON.stringify(c.args ?? {}).slice(0, 300))}</div>`).join('');
    const text = m.content ? `<div>${this.esc(m.content)}</div>` : '';
    return `<div class="m ${m.role}" data-role="${m.role}">${text}${calls}</div>`;
  }
  render() {
    const p = PRESETS.find((x) => x.id === this._preset);
    const enabled = this._models.filter((m) => m.enabled);
    const opts = enabled.map((m) => `<option value="${this.esc(m.id)}">${this.esc(m.name)}${m.local ? ' (local)' : ' (external)'}</option>`).join('');
    const convs = this._convs.map((c) => `<li><button class="secondary ${this._cur?.id === c.id ? 'sel' : ''}" data-open="${this.esc(c.id)}">${this.esc(c.title)}</button></li>`).join('');
    const t = this._thread;
    const pending = (t?.pending ?? []).map((c) => `<div class="pending" data-pending="${this.esc(c.id)}"><b>The assistant wants to run ${this.esc(c.name)}</b> <small>(${this.esc(c.kind)})</small>
      <pre>${this.esc(JSON.stringify(c.args ?? {}, null, 2))}</pre>${c.kind === 'write' ? '<div class="hint">Writes only to its own working branch. Nothing is live until a human merges and applies.</div>' : '<div class="hint">This action goes beyond a draft on its branch. Check the details.</div>'}
      ${(this._choices ?? {})[c.id] ? `<p class="hint">You chose: ${(this._choices)[c.id]}. The assistant continues once every action has an answer.</p>` : `<button data-approve="${this.esc(c.id)}">Approve</button><button class="secondary" data-deny="${this.esc(c.id)}">Decline</button>`}</div>`).join('');
    const chat = this._cur ? `
      <div class="card"><h3>${this.esc(this._cur.title)}</h3>
        <p class="hint">Working branch: <b>${this.esc(t?.branch ?? '?')}</b>${t?.active === false ? ' (session ended: start a new conversation)' : ''}. The assistant can read and prepare changes there. It cannot merge, approve or apply: a human publishes.${this._cur.autoApproveWrites ? ' Branch writes are approved automatically in this conversation; other actions still ask.' : ''}</p>
        <div class="thread" id="ai-thread" aria-live="polite">${(t?.messages ?? []).map((m) => this.renderMsg(m)).join('') || '<p class="hint">Ask a question about the platform, for example: who has the accountant role?</p>'}${this._busy ? '<p class="hint">Working...</p>' : ''}</div>
        ${pending}
        <textarea name="aimsg" maxlength="8000" aria-label="Message" placeholder="Message the assistant" ${this._busy || pending ? 'disabled' : ''}></textarea>
        <button id="ai-send" ${this._busy || pending || t?.active === false ? 'disabled' : ''}>Send</button>
        <button class="secondary" id="ai-delete">${this._confirmDelete ? 'Confirm: delete this conversation' : 'Delete conversation'}</button>
      </div>` : '<div class="card"><p class="hint">Open a conversation or start a new one.</p></div>';
    const modelRows = this._models.map((m) => `<tr><td>${this.esc(m.name)}${m.builtin ? ' <small>(built in)</small>' : ''}</td><td>${this.esc(m.kind)}</td><td>${this.esc(m.model)}</td><td>${m.local ? 'local' : 'external'}</td><td>${m.enabled ? 'enabled' : 'disabled'}</td><td>${this.esc(m.lastStatus)}</td>
      <td>${m.builtin ? '' : `<button class="secondary" data-test="${this.esc(m.id)}">Test</button><button class="secondary" data-toggle="${this.esc(m.id)}">${m.enabled ? 'Disable' : 'Enable'}</button><button class="secondary" data-delmodel="${this.esc(m.id)}">${this._del === m.id ? 'Confirm delete' : 'Delete'}</button>`}</td></tr>`).join('');
    const presets = PRESETS.map((x) => `<option value="${x.id}" ${x.id === this._preset ? 'selected' : ''}>${this.esc(x.label)}</option>`).join('');
    this.innerHTML = `<style>${css}</style>
    <p class="lead">AI assistant. Chat with a model that can use the platform tools. It works on its own branch and can only prepare changes: every change waits for your approval, and publishing stays human.</p>
    ${this._note ? `<p role="status" class="msg ok" id="ai-note">${this.esc(this._note)}</p>` : ''}${this._problem ? `<p role="alert" class="msg bad" id="ai-problem">${this.esc(this._problem)}</p>` : ''}
    <div class="layout"><div>
      <section class="card"><h3>New conversation</h3>
        <div class="row"><label>Model<select name="aimodel">${opts || '<option value="">No model yet</option>'}</select></label></div>
        <div class="row"><label>Title<input name="aititle" maxlength="100" placeholder="optional"></label></div>
        <label class="hint"><input type="checkbox" name="aiauto"> Approve writes on its branch automatically (other actions still ask)</label>
        <button id="ai-new">Start</button></section>
      <section class="card"><h3>Conversations</h3><ul class="convs">${convs || '<li class="hint">None yet.</li>'}</ul></section>
    </div><div>${chat}</div></div>
    <section class="card" id="ai-models"><h3>Models</h3>
      <p class="hint">A local model keeps everything on your network. An external model receives the data the tools return (users, roles, configuration): add it only if your data policy allows it. Keys are stored encrypted and never shown again.</p>
      <div class="scroll"><table id="ai-model-table"><thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Where</th><th>State</th><th>Last check</th><th></th></tr></thead><tbody>${modelRows || '<tr><td colspan="7">No model yet. The built-in local model appears when the server sets IAM_AI_LOCAL_URL and IAM_AI_LOCAL_MODEL.</td></tr>'}</tbody></table></div>
      <h4>Add a model</h4>
      <div class="row"><label>Provider<select name="mpreset">${presets}</select></label></div>
      <p class="hint">${this.esc(p.hint)}${p.link ? ` <a href="${this.esc(p.link)}" target="_blank" rel="noopener noreferrer">Open the provider console</a>.` : ''}</p>
      <div class="row"><label>Name<input name="mname" maxlength="40" placeholder="e.g. Claude"></label>
        <label>Model identifier<input name="mmodel" maxlength="100" value="${this.esc(p.model)}" placeholder="provider model name"></label>
        <label>Endpoint<input name="murl" size="36" value="${this.esc(p.baseUrl)}"></label>
        <label>${p.keyNeeded ? 'API key' : 'API key (optional)'}<input name="mkey" type="password" autocomplete="off" placeholder="stored encrypted, never shown again"></label>
        <label>Max answer tokens<input name="mtokens" type="number" min="256" max="16000" value="2048"></label></div>
      <label class="hint"><input type="checkbox" name="mack"> I understand data returned by tools is sent to this provider (not needed for a local model)</label>
      <button id="ai-addmodel">Add model</button>
    </section>`;
    this.wire();
  }
  wire() {
    const q = (s) => this.querySelector(s);
    q('#ai-new')?.addEventListener('click', () => void this.newConversation());
    q('#ai-send')?.addEventListener('click', () => void this.send());
    q('[name=aimsg]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void this.send(); });
    q('#ai-delete')?.addEventListener('click', () => void this.removeConversation());
    q('#ai-addmodel')?.addEventListener('click', () => void this.addModel());
    q('[name=mpreset]')?.addEventListener('change', (e) => { this._preset = e.target.value; this.render(); });
    for (const b of this.querySelectorAll('[data-open]')) b.addEventListener('click', () => void this.open(b.getAttribute('data-open')));
    const choose = (id, v) => {
      this._choices = { ...(this._choices ?? {}), [id]: v };
      const all = this._thread.pending.every((c) => this._choices[c.id]);
      if (all) { const d = this._choices; this._choices = {}; void this.decide(d); } else this.render();
    };
    for (const b of this.querySelectorAll('[data-approve]')) b.addEventListener('click', () => choose(b.getAttribute('data-approve'), 'approve'));
    for (const b of this.querySelectorAll('[data-deny]')) b.addEventListener('click', () => choose(b.getAttribute('data-deny'), 'deny'));
    for (const b of this.querySelectorAll('[data-test]')) b.addEventListener('click', () => void this.modelAction(b.getAttribute('data-test'), 'test'));
    for (const b of this.querySelectorAll('[data-toggle]')) b.addEventListener('click', () => void this.modelAction(b.getAttribute('data-toggle'), 'toggle'));
    for (const b of this.querySelectorAll('[data-delmodel]')) b.addEventListener('click', () => void this.modelAction(b.getAttribute('data-delmodel'), 'delete'));
  }
}
if (!customElements.get('plg-ai-assistant-chat')) customElements.define('plg-ai-assistant-chat', AiAssistantScreen);
export default 'plg-ai-assistant-chat';
