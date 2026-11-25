// SOURCE of plugins/ai-assistant/screens/chat.mjs (built by build.mjs: the AI SDK chat classes from `ai` are bundled in, because a
// plugin screen is one self-contained .mjs). Do not edit the built file by hand.
// AI assistant screen, packaged with the plugin. A signed, self-contained custom element: the console's generic
// host imports it and hands it the session context { tenant, api, token, adminToken, branch }.
// Chat on the left, models (local + external, added by an administrator) below. Text from the model or from tool
// results is always inserted as text, never as HTML.

import { AbstractChat, DefaultChatTransport } from 'ai';

/** The minimal (framework-free) ChatState the SDK's AbstractChat asks for: the screen re-renders on every change. */
class ScreenChatState {
  constructor(messages, onChange) { this.messages = messages; this.status = 'ready'; this.error = undefined; this.onChange = onChange; }
  pushMessage = (m) => { this.messages = [...this.messages, m]; this.onChange(); };
  popMessage = () => { this.messages = this.messages.slice(0, -1); this.onChange(); };
  replaceMessage = (i, m) => { this.messages = this.messages.map((x, j) => (j === i ? m : x)); this.onChange(); };
  snapshot = (v) => JSON.parse(JSON.stringify(v));
  setStatus(status, error) { this.status = status; this.error = error; this.onChange(); }
}
class ScreenChat extends AbstractChat {
  constructor(init, onChange) {
    const state = new ScreenChatState(init.messages ?? [], onChange);
    super({ ...init, state });
    this.screenState = state;
  }
}

const css = `
:scope[compact]{display:block;container-type:inline-size}
:scope[compact] .lead,:scope[compact] #ai-models{display:none}
:scope[compact] .layout{display:flex;flex-direction:column;gap:0}
:scope[compact] .layout>div{width:100%;min-width:0}
:scope[compact] .card{margin:.35rem 0;padding:.6rem}
:scope[compact] .thread{max-height:28vh}
:scope[compact] .convs{max-height:6rem;overflow:auto}
:scope[compact] .row{margin:.3rem 0}
:scope[compact] textarea{min-height:3rem}
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
.call pre{white-space:pre-wrap;max-height:6rem;overflow:auto;margin:.2rem 0;background:var(--code-bg);color:var(--ink);font-size:.8rem}
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
  { id: 'gemini', label: 'Google Gemini', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '', keyNeeded: true, link: 'https://aistudio.google.com/apikey', hint: 'The free tier may use your content to improve the provider products: prefer a paid key for real data.' },
  { id: 'custom', label: 'Other OpenAI-compatible endpoint (agent gateway, LiteLLM, OpenRouter, Azure...)', kind: 'openai-compatible', baseUrl: '', model: '', keyNeeded: true, hint: 'Any endpoint that answers /chat/completions with tool calls. https is required for a remote host.' },
];

class AiAssistantScreen extends HTMLElement {
  connectedCallback() {
    this._ctx = this.context ?? { api: '', token: '', adminToken: '', branch: '' };
    this._models = []; this._convs = []; this._cur = null; this._thread = null; this._chat = null; this._busy = false; this._confirmDelete = false; this._preset = 'ollama'; this._note = ''; this._problem = '';
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
    this._cur = r.data.conversation; this._thread = { branch: r.data.branch, active: r.data.sessionActive };
    const convId = this._cur.id;
    // The AI SDK chat client: the server streams UI messages; only the LAST message is sent, the server keeps the history.
    this._chat = new ScreenChat({
      id: convId, messages: r.data.messages ?? [],
      transport: new DefaultChatTransport({ api: `${this._ctx.api}/ai/conversations/${encodeURIComponent(convId)}/chat`, headers: () => this.h(), prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages[messages.length - 1] } }) }),
    }, () => { this.renderChat(); });
    this._confirmDelete = false; this._problem = ''; this.render(); this.scrollDown();
  }
  scrollDown() { const t = this.querySelector('#ai-thread'); if (t) t.scrollTop = t.scrollHeight; }
  renderChat() {
    // Re-render only the conversation card while streaming (keeps the typed text and the rest of the page untouched).
    const host = this.querySelector('#ai-chatcard'); if (!host) { this.render(); return; }
    host.outerHTML = this.chatCard();
    this.wireChat(); this.scrollDown();
  }
  async send() {
    const box = this.querySelector('[name=aimsg]'); const text = box?.value.trim();
    if (!text || !this._chat || this.busy()) return;
    box.value = '';
    await this._chat.sendMessage({ text });
  }
  busy() { const s = this._chat?.status; return s === 'submitted' || s === 'streaming'; }
  isTool(p) { return p.type === 'dynamic-tool' || String(p.type).startsWith('tool-'); }
  toolName(p) { return p.type === 'dynamic-tool' ? p.toolName : String(p.type).slice(5); }
  async newConversation() {
    const sel = this.querySelector('[name=aimodel]'); const title = this.querySelector('[name=aititle]')?.value.trim();
    if (!sel?.value) { this._problem = 'Choose a model first (add one below if the list is empty).'; this.render(); return; }
    const r = await this.call('POST', '/conversations', { modelId: sel.value, title: title || undefined });
    if (this.fail(r)) { this.render(); return; }
    await this.load(); await this.open(r.data.conversation.id);
  }
  async removeConversation() {
    if (!this._confirmDelete) { this._confirmDelete = true; this.render(); return; }
    const r = await this.call('DELETE', `/conversations/${encodeURIComponent(this._cur.id)}`);
    if (this.fail(r)) { this.render(); return; }
    this._cur = null; this._thread = null; this._chat = null; this._confirmDelete = false; this._note = 'Conversation deleted. Its working branch stays until a human cleans it up.'; await this.load();
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
  renderPart(p) {
    if (p.type === 'text') return `<div>${this.esc(p.text)}</div>`;
    if (!this.isTool(p)) return '';
    const state = { 'input-streaming': 'preparing', 'input-available': 'running', 'output-available': 'done', 'output-error': 'failed' }[p.state] ?? p.state;
    const out = p.state === 'output-available' ? `<pre>${this.esc(this.outputText(p.output))}</pre>` : p.state === 'output-error' ? `<pre>${this.esc(p.errorText ?? '')}</pre>` : '';
    return `<div class="call" data-tool="${this.esc(this.toolName(p))}">uses <b>${this.esc(this.toolName(p))}</b> ${this.esc(JSON.stringify(p.input ?? {}).slice(0, 300))} <small>(${this.esc(state)})</small>${out}</div>`;
  }
  outputText(o) { const parts = Array.isArray(o?.content) ? o.content : null; const t = parts ? parts.map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n') : typeof o === 'string' ? o : JSON.stringify(o ?? ''); return String(t).slice(0, 1500); }
  renderMsg(m) { return `<div class="m ${m.role}" data-role="${m.role}">${m.parts.map((p) => this.renderPart(p)).join('')}</div>`; }
  chatCard() {
    const t = this._thread; const chat = this._chat;
    if (!this._cur || !chat) return '<div class="card" id="ai-chatcard"><p class="hint">Open a conversation or start a new one.</p></div>';
    const busy = this.busy();
    const err = chat.error ? `<p role="alert" class="msg bad" id="ai-problem">${this.esc(String(chat.error.message ?? chat.error).slice(0, 300))}</p>` : '';
    const compact = this.hasAttribute('compact');
    return `<div class="card" id="ai-chatcard"><h3>${this.esc(this._cur.title)}</h3>
        ${compact ? '<details class="rights"><summary>Working branch and tool rights</summary>' : ''}<p class="hint">Working branch: <b>${this.esc(t?.branch ?? '?')}</b>${t?.active === false ? ' (session ended: start a new conversation)' : ''}. It works with the same rights as your MCP session. Platform changes stay on the branch until a human publishes; relayed external tools (named server__tool) act on their own servers and are not isolated by the branch.</p>${compact ? '</details>' : ''}
        <div class="thread" id="ai-thread" aria-live="polite">${chat.messages.map((m) => this.renderMsg(m)).join('') || '<p class="hint">Ask a question about the platform, for example: who has the accountant role?</p>'}${busy ? '<p class="hint">Working...</p>' : ''}</div>
        ${err}
        <textarea name="aimsg" maxlength="8000" aria-label="Message" placeholder="Message the assistant" ${busy ? 'disabled' : ''}></textarea>
        <button id="ai-send" ${busy || t?.active === false ? 'disabled' : ''}>Send</button>
        <button class="secondary" id="ai-delete">${this._confirmDelete ? 'Confirm: delete this conversation' : 'Delete conversation'}</button>
      </div>`;
  }
  render() {
    const p = PRESETS.find((x) => x.id === this._preset);
    const enabled = this._models.filter((m) => m.enabled);
    const opts = enabled.map((m) => `<option value="${this.esc(m.id)}">${this.esc(m.name)}${m.local ? ' (local)' : ' (external)'}</option>`).join('');
    const convs = this._convs.map((c) => `<li><button class="secondary ${this._cur?.id === c.id ? 'sel' : ''}" data-open="${this.esc(c.id)}">${this.esc(c.title)}</button></li>`).join('');
    const chat = this.chatCard();
    const modelRows = this._models.map((m) => `<tr><td>${this.esc(m.name)}${m.builtin ? ' <small>(built in)</small>' : ''}</td><td>${this.esc(m.kind)}</td><td>${this.esc(m.model)}</td><td>${m.local ? 'local' : 'external'}</td><td>${m.enabled ? 'enabled' : 'disabled'}</td><td>${this.esc(m.lastStatus)}</td>
      <td>${m.builtin ? '' : `<button class="secondary" data-test="${this.esc(m.id)}">Test</button><button class="secondary" data-toggle="${this.esc(m.id)}">${m.enabled ? 'Disable' : 'Enable'}</button><button class="secondary" data-delmodel="${this.esc(m.id)}">${this._del === m.id ? 'Confirm delete' : 'Delete'}</button>`}</td></tr>`).join('');
    const presets = PRESETS.map((x) => `<option value="${x.id}" ${x.id === this._preset ? 'selected' : ''}>${this.esc(x.label)}</option>`).join('');
    const compact = this.hasAttribute('compact');
    this.innerHTML = `<style>@scope (plg-ai-assistant-chat) { ${css} }</style>
    <p class="lead">AI assistant. Chat with a model that can use the platform tools. It works on its own branch and can only prepare changes: it acts with your MCP session rights. Platform changes go to its own working branch and a human publishes; tools relayed from external servers act on those servers under the MCP rights, the branch does not isolate them.</p>
    ${this._note ? `<p role="status" class="msg ok" id="ai-note">${this.esc(this._note)}</p>` : ''}${this._problem ? `<p role="alert" class="msg bad" id="ai-problem">${this.esc(this._problem)}</p>` : ''}
    <div class="layout"><div>${compact ? '<details><summary>Conversations and model</summary>' : ''}
      <section class="card"><h3>New conversation</h3>
        <div class="row"><label>Model<select name="aimodel">${opts || '<option value="">No model yet</option>'}</select></label></div>
        <div class="row"><label>Title<input name="aititle" maxlength="100" placeholder="optional"></label></div>
        <button id="ai-new">Start</button></section>
      <section class="card"><h3>Conversations</h3><ul class="convs">${convs || '<li class="hint">None yet.</li>'}</ul></section>
    ${compact ? '</details>' : ''}</div><div>${chat}</div></div>
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
  disconnectedCallback() { this._chat?.stop(); }
  wireChat() {
    const q = (s) => this.querySelector(s);
    q('#ai-send')?.addEventListener('click', () => void this.send());
    q('[name=aimsg]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void this.send(); });
    q('#ai-delete')?.addEventListener('click', () => void this.removeConversation());
  }
  wire() {
    const q = (s) => this.querySelector(s);
    q('#ai-new')?.addEventListener('click', () => void this.newConversation());
    q('#ai-addmodel')?.addEventListener('click', () => void this.addModel());
    q('[name=mpreset]')?.addEventListener('change', (e) => { this._preset = e.target.value; this.render(); });
    for (const b of this.querySelectorAll('[data-open]')) b.addEventListener('click', () => void this.open(b.getAttribute('data-open')));
    this.wireChat();
    for (const b of this.querySelectorAll('[data-test]')) b.addEventListener('click', () => void this.modelAction(b.getAttribute('data-test'), 'test'));
    for (const b of this.querySelectorAll('[data-toggle]')) b.addEventListener('click', () => void this.modelAction(b.getAttribute('data-toggle'), 'toggle'));
    for (const b of this.querySelectorAll('[data-delmodel]')) b.addEventListener('click', () => void this.modelAction(b.getAttribute('data-delmodel'), 'delete'));
  }
}
if (!customElements.get('plg-ai-assistant-chat')) customElements.define('plg-ai-assistant-chat', AiAssistantScreen);
export default 'plg-ai-assistant-chat';
