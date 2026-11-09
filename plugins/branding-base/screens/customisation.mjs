/** Packaged Customisation page. All effects stay on the selected Dolt branch; preview does not save. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
class Customisation extends HTMLElement {
  set context(c) { this.ctx=c; }
  connectedCallback() { this.render(); void this.load(); }
  disconnectedCallback() { clearTimeout(this.timer); window.removeEventListener('message',this.ready); }
  async call(path,method='GET',data) {
    const h={authorization:`Bearer ${this.ctx.token}`,'content-type':'application/json','x-iam-branch':this.ctx.branch || 'main'};
    if(this.ctx.adminToken)h['x-api-admin-token']=this.ctx.adminToken;
    const r=await fetch(this.ctx.api+path,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});
    const b=await r.json(); if(!r.ok)throw Error(b.message||`HTTP ${r.status}`); return b;
  }
  render() {
    this.innerHTML=`<style>
      .brand-editor{display:grid;grid-template-columns:minmax(270px,380px) minmax(0,1fr);gap:24px;align-items:start}
      .brand-editor section{padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--card)}
      .brand-editor h2{font-size:1rem;margin:0 0 16px}.brand-editor h3{font-size:.85rem;margin:24px 0 10px}
      .brand-editor label{margin:12px 0;display:grid;gap:6px}.brand-editor input:not([type=color]),.brand-editor textarea,.brand-editor select{width:100%;box-sizing:border-box}
      .brand-editor input,.brand-editor select{min-height:44px}.brand-editor textarea{resize:vertical;min-height:64px}
      .brand-editor .colors{display:grid;grid-template-columns:1fr 1fr;gap:12px}.brand-editor input[type=color]{width:100%;padding:4px;background:var(--field-bg);border:1px solid var(--field-line);height:48px}
      .brand-editor .presets,.brand-editor .tools{display:flex;flex-wrap:wrap;gap:8px}.brand-editor button{margin:0;min-height:44px}
      .brand-editor .hint{font-size:.8rem;color:var(--muted)}.brand-editor .status{min-height:24px;color:var(--muted);margin:12px 0}
      .brand-editor .preview{position:sticky;top:24px;overflow:hidden}.brand-editor iframe{width:100%;height:640px;border:1px solid var(--line);border-radius:12px;background:var(--bg);margin-top:16px}
      .brand-editor .swatches{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.brand-editor .swatches span{padding:8px;border-radius:8px;font-size:.75rem}
      .brand-editor .svg{font:12px monospace}.brand-editor .error{color:var(--bad)}
      @media(max-width:950px){.brand-editor{grid-template-columns:1fr}.brand-editor .preview{position:static}}
    </style><div class="brand-editor">
    <section><h2>Your product, your identity</h2><p class="hint">Draft on <strong>${esc(this.ctx?.branch||'main')}</strong>. Save here, then Review &amp; Apply to publish.</p>
    <form>
      <label>Product name<input name="productName" maxlength="80" required></label>
      <label>Baseline<input name="baseline" maxlength="160"></label>
      <label>Footer<textarea name="footer" maxlength="400"></textarea></label>
      <h3>Material You palette</h3><p class="hint">Two seed colors generate surfaces, text, states and gradients for both themes. Text tones keep WCAG AA contrast.</p>
      <div class="colors">${['primaryColor','accentColor'].map((k,i)=>`<label>${i?'Accent':'Primary'}<input type="color" data-picker="${k}"><input name="${k}" pattern="#[0-9a-fA-F]{6}" maxlength="7" aria-label="${i?'Accent':'Primary'} hex color" required></label>`).join('')}</div>
      <div class="presets"><button type="button" class="secondary" data-preset="0">Indigo</button><button type="button" class="secondary" data-preset="1">Forest</button><button type="button" class="secondary" data-preset="2">Copper</button></div>
      <h3>Logo &amp; favicon</h3><label>Logo<select name="logoMode"><option value="default">Themed lyam SVG</option><option value="custom">Custom SVG artwork</option></select></label>
      <label>Logo SVG<textarea name="logoSvg" class="svg" maxlength="50000" placeholder="Paste an inert SVG (paths, shapes, gradients)"></textarea></label>
      <label>Favicon SVG (optional)<textarea name="faviconSvg" class="svg" maxlength="50000" placeholder="Leave empty for the themed shield"></textarea></label>
      <p class="hint">SVG only, 50KB maximum. Scripts, external URLs, CSS and embedded HTML are refused. Custom artwork keeps its own colors.</p>
      <div class="tools"><button type="submit" data-save>Save to branch</button><button type="button" class="secondary" data-reset>Discard edits</button></div>
    </form><div class="status" role="status" aria-live="polite"></div></section>
    <section class="preview"><h2>Live preview</h2><div class="tools"><button type="button" class="secondary" data-mode="light">Light</button><button type="button" class="secondary" data-mode="dark">Dark</button><button type="button" class="secondary" data-width>Mobile width</button></div>
    <div class="swatches" aria-label="Computed theme roles"></div><p class="hint">The actual sign-in interface. Preview never signs in or publishes.</p><iframe title="Live branding preview" src="/login?preview=1"></iframe></section></div>`;
    this.form=this.querySelector('form');this.dark=false;
    this.form.addEventListener('input',e=>{ if(e.target.dataset.picker)this.form.elements.namedItem(e.target.dataset.picker).value=e.target.value; this.schedule(); });
    this.form.addEventListener('submit',e=>{e.preventDefault();void this.save();});
    this.querySelector('[data-reset]').onclick=()=>this.load();
    this.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{this.dark=b.dataset.mode==='dark';this.push();});
    this.querySelector('[data-width]').onclick=()=>{const f=this.querySelector('iframe');this.mobile=!this.mobile;f.style.maxWidth=this.mobile?'390px':'';};
    this.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{const p=[['#4f46e5','#818cf8'],['#00695c','#d6a33a'],['#9c4221','#507b9c']][b.dataset.preset];this.form.elements.primaryColor.value=p[0];this.form.elements.accentColor.value=p[1];this.schedule();});
    this.ready=e=>{if(e.origin===location.origin&&e.source===this.querySelector('iframe').contentWindow&&e.data?.type==='iam-preview-ready')this.push();};window.addEventListener('message',this.ready);
  }
  values() { return Object.fromEntries(new FormData(this.form)); }
  status(text,error=false) {const s=this.querySelector('.status');s.textContent=text;s.classList.toggle('error',error);}
  async load() {try{const f=await this.call('/plugins/branding-base/form');for(const group of f.groups)for(const field of group.fields){const el=this.form.elements.namedItem(field.key);if(el)el.value=field.value??'';}await this.update();this.status('Draft loaded. Changes are not live until Apply.');}catch(e){this.status(e.message,true);}}
  schedule() {clearTimeout(this.timer);this.timer=setTimeout(()=>this.update(),200);}
  async update() {
    if(!this.form.checkValidity())return;
    const seq=this.seq=(this.seq||0)+1;
    try{const b=await this.call('/branding/preview','POST',this.values());if(seq!==this.seq||!this.isConnected)return;this.bundle=b;this.push();for(const p of this.querySelectorAll('[data-picker]'))p.value=this.form.elements.namedItem(p.dataset.picker).value;this.status('Preview updated. Unsaved changes stay in this editor.');}catch(e){if(seq===this.seq)this.status(e.message,true);}
  }
  push() {
    if(!this.bundle)return;const b=this.bundle;const mode=this.dark?'dark':'light';
    const msg={type:'iam-branding-preview',dark:this.dark,theme:b.theme,config:{productName:b.config.productName,baseline:b.config.baseline,footer:b.config.footer},logos:b.logos};
    this.querySelector('iframe').contentWindow?.postMessage(msg,location.origin);
    const wrap=this.querySelector('.swatches');wrap.replaceChildren();for(const [label,ink,bg] of [['Primary','--accent-ink','--accent'],['Accent','--chip-ink','--chip-bg'],['Surface','--ink','--card'],['Success','--ok','--ok-soft'],['Error','--bad','--bad-soft']]){const s=document.createElement('span');s.textContent=label;s.style.color=b.theme[mode][ink];s.style.background=b.theme[mode][bg];wrap.append(s);}
  }
  async save() {const button=this.querySelector('[data-save]');button.disabled=true;try{await this.update();await this.call('/plugins/branding-base/settings','PUT',{values:this.values()});this.status('Saved to this branch. Use Review & Apply to publish.');}catch(e){this.status(e.message,true);}finally{button.disabled=false;}}
}
if(!customElements.get('iam-customisation'))customElements.define('iam-customisation',Customisation);
export default 'iam-customisation';
