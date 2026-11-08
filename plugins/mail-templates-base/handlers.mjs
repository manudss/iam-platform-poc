/**
 * mail-templates-base: the one renderer of the notify.templates slot (docs/mail-templates.md).
 * PURE string interpolation - the bus-safe contract: the template declaration (from the owning plugin's
 * manifest), the branch customization and the layout all travel IN THE PAYLOAD (read core-side). This handler
 * reads nothing, stores nothing, and never promises delivery (that is notify.default's job).
 *
 * Contract (notify.render):
 *   payload: { tenant, key, lang, data, decl, override, layout, layoutOverride }
 *   result:  { subject, text, html? }
 * Rules:
 *   - override (customization on the branch) wins over decl (the plugin's built-in default);
 *   - {{variable}} interpolation: HTML-escaped in the HTML body, raw in subject and text;
 *     a variable absent from data renders as an empty string;
 *   - the layout wraps the HTML body at its {{body}} placeholder; layout vars (logo, colors, footer) are
 *     administrator-owned and interpolate RAW (the admin owns the shell, like a Cedar policy author owns rules);
 *   - vars.logoUrl set: the {{logo}} variable becomes an <img> of that URL;
 *   - the layout's footer is appended to the plain-text body after a dash line;
 *   - no html body on the template: the mail stays plain text, no layout shell.
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VAR = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const interpolate = (tpl, data, { html }) => String(tpl ?? '').replace(VAR, (_m, name) => {
  if (!(name in (data ?? {}))) return '';
  const v = data[name];
  return html ? esc(typeof v === 'string' ? v : JSON.stringify(v)) : (typeof v === 'string' ? v : JSON.stringify(v));
});

export default {
  'notify.render': (p) => {
    const tpl = p.override ?? p.decl ?? {};
    const subject = interpolate(tpl.subject ?? `[iam] ${p.key}`, p.data, { html: false });
    const text = interpolate(tpl.text ?? '', p.data, { html: false });
    let html = tpl.html !== undefined && tpl.html !== null ? interpolate(tpl.html, p.data, { html: true }) : undefined;
    // A layout override is PARTIAL: an absent html keeps the declared shell, vars merge over the declared vars.
    const layout = p.layout ?? p.layoutOverride;
    if (layout) {
      const vars = { ...(p.layout?.vars ?? {}), ...(p.layoutOverride?.vars ?? {}) };
      const shellHtml = p.layoutOverride?.html ?? p.layout?.html;
      if (vars.logoUrl && typeof vars.logoUrl === 'string') vars.logo = `<img src="${esc(vars.logoUrl)}" alt="" style="max-height:40px;display:block">`;
      if (html !== undefined && shellHtml) html = interpolate(shellHtml, { ...vars, body: html }, { html: false });
      if (vars.footer) {
        const footer = interpolate(vars.footer, {}, { html: false });
        return { subject, text: `${text}\n\n-- ${footer}`, ...(html !== undefined ? { html } : {}) };
      }
    }
    return { subject, text, ...(html !== undefined ? { html } : {}) };
  },
};
