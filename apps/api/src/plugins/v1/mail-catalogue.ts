import { pluginCatalogue } from './loader.js';
import type { MailTemplateDecl } from './manifest.js';
import type { PluginRegistry } from './registry.js';
import type { NotifyRenderResult } from './hooks.js';

/**
 * The e-mail template catalogue (docs/mail-templates.md): every mail type the installed plugins declare in
 * their manifest `mailTemplates`, plus the one global `_layout`. Pure declarations, no state: the branch
 * customization lives in Dolt (step 2, MailTemplateStore) and the rendering behind the notify.templates slot.
 */
export interface MailCatalogueEntry { plugin: string; decl: MailTemplateDecl }

export function mailCatalogue(): MailCatalogueEntry[] {
  const out: MailCatalogueEntry[] = [];
  for (const i of pluginCatalogue().impls()) for (const decl of i.manifest.mailTemplates ?? []) out.push({ plugin: i.manifest.id, decl });
  return out.sort((a, b) => (a.decl.layout ? 0 : 1) - (b.decl.layout ? 0 : 1) || a.decl.key.localeCompare(b.decl.key));
}
export function mailTemplateDecl(key: string): MailCatalogueEntry | undefined { return mailCatalogue().find((x) => x.decl.key === key); }
export function mailLayoutDecl(): MailCatalogueEntry | undefined { return mailCatalogue().find((x) => x.decl.layout); }

export interface MailOverride { subject: string; text: string; html?: string }
export interface MailLayoutOverride { html?: string; vars?: Record<string, string> }

/**
 * Renders one mail through the notify.templates slot (base plugin mail-templates-base, replaceable).
 * Returns undefined when the key is not declared; THROWS when the slot refuses (bus down, faulted replacement):
 * the callers decide their degradation (the send paths fall back to the legacy raw send, explicitly logged).
 */
export async function renderMail(reg: PluginRegistry, tenant: string, key: string, data: Record<string, unknown>, opts: { lang?: string; override?: MailOverride | null; layoutOverride?: MailLayoutOverride | null } = {}): Promise<NotifyRenderResult | undefined> {
  const entry = mailTemplateDecl(key);
  if (!entry || entry.decl.layout) return undefined;
  const layout = mailLayoutDecl()?.decl;
  const r = await reg.callSlot<NotifyRenderResult>(tenant, 'notify.templates', 'notify.render', {
    tenant, key, lang: opts.lang ?? 'en', data,
    decl: entry.decl.default, override: opts.override ?? null,
    layout: layout ? { subject: layout.default.subject, text: layout.default.text, html: layout.default.html, vars: layout.vars } : null,
    layoutOverride: opts.layoutOverride ?? null,
  });
  return r.result;
}

/** renderMail with the send paths' degradation: a renderer problem never blocks a send, it degrades to the
 * legacy raw payload and says so in the logs (the notifier's raw dump is the pre-templates behaviour). */
export async function renderMailOrLegacy(reg: PluginRegistry, tenant: string, key: string, data: Record<string, unknown>, opts: { lang?: string; override?: MailOverride | null; layoutOverride?: MailLayoutOverride | null } = {}): Promise<NotifyRenderResult | undefined> {
  try { return await renderMail(reg, tenant, key, data, opts); }
  catch (e) { console.warn(`[mail] notify.render failed for ${key} (${(e as Error).message}): sending the legacy raw payload`); return undefined; }
}
