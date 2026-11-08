import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, NotFoundException, Optional, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { mailCatalogue, mailTemplateDecl, renderMail, MailOverride } from '../plugins/v1/mail-catalogue.js';

/**
 * Mail template management (docs/mail-templates.md): the per-tenant, per-branch customization of the mail
 * templates every plugin declares in its manifest. Storage is core (like the organizations store), the rules
 * here are the ones the Templates screen drives; the rendering itself stays in the mail-templates-base plugin.
 * A customization lives on the working data branch and goes live on Apply, like every other admin change.
 */

export interface MailTemplateOverride { subject: string; text: string; html?: string; vars?: Record<string, string> }
export interface MailTemplateStore {
  list(tenant: string): Promise<Map<string, MailTemplateOverride>>;
  get(tenant: string, key: string): Promise<MailTemplateOverride | undefined>;
  put(tenant: string, actor: string, key: string, o: MailTemplateOverride): Promise<void>;
  remove(tenant: string, actor: string, key: string): Promise<void>;
}
export const MAIL_TEMPLATE_STORE = 'MAIL_TEMPLATE_STORE';

/** Tests and quick local demo. */
export class MemoryMailTemplateStore implements MailTemplateStore {
  private readonly rows = new Map<string, MailTemplateOverride>(); // `${tenant}/${branch}/${key}`
  private k(t: string, key: string) { return `${t}/${currentBranch(false)}/${key}`; }
  async list(t: string) { const p = `${t}/${currentBranch(false)}/`; return new Map([...this.rows].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), structuredClone(v)])); }
  async get(t: string, key: string) { const v = this.rows.get(this.k(t, key)); return v ? structuredClone(v) : undefined; }
  async put(t: string, _a: string, key: string, o: MailTemplateOverride) { this.rows.set(this.k(t, key), structuredClone(o)); }
  async remove(t: string, _a: string, key: string) { this.rows.delete(this.k(t, key)); }
}

const TABLE = 'plg_mail_templates_custom';
/** Dolt: one row per customized template (`extra` carries the _layout variables as JSON), written on the
 * working branch, live after Apply. Fictional data only. */
export class DoltMailTemplateStore implements MailTemplateStore {
  constructor(private readonly v: VersioningService, private readonly workBranch: (write: boolean) => string) {}
  private async ensure(c: Connection) {
    await c.query(`create table if not exists ${TABLE} (tenant varchar(32) not null, tpl_key varchar(64) not null, lang varchar(8) not null default 'en', subject text null, body_text mediumtext null, body_html mediumtext null, extra json null, updated_at varchar(32) not null, primary key (tenant, tpl_key, lang))`);
  }
  private row(r: { subject: string | null; body_text: string | null; body_html: string | null; extra: unknown }): MailTemplateOverride {
    const extra = typeof r.extra === 'string' ? JSON.parse(r.extra) : r.extra;
    return { subject: r.subject ?? '', text: r.body_text ?? '', ...(r.body_html != null ? { html: r.body_html } : {}), ...(extra && typeof extra === 'object' ? { vars: extra as Record<string, string> } : {}) };
  }
  async list(t: string) {
    return this.v.at(this.workBranch(false), async (c) => {
      const [ex] = await c.query('select count(*) n from information_schema.tables where table_schema=database() and table_name=?', [TABLE]);
      if (!Number((ex as { n: number }[])[0].n)) return new Map<string, MailTemplateOverride>();
      const [rows] = await c.query(`select tpl_key, subject, body_text, body_html, extra from ${TABLE} where tenant=? and lang='en'`, [t]);
      return new Map((rows as { tpl_key: string; subject: string | null; body_text: string | null; body_html: string | null; extra: unknown }[]).map((r) => [r.tpl_key, this.row(r)]));
    });
  }
  async get(t: string, key: string) {
    return this.v.at(this.workBranch(false), async (c) => {
      const [ex] = await c.query('select count(*) n from information_schema.tables where table_schema=database() and table_name=?', [TABLE]);
      if (!Number((ex as { n: number }[])[0].n)) return undefined;
      const [rows] = await c.query(`select subject, body_text, body_html, extra from ${TABLE} where tenant=? and tpl_key=? and lang='en'`, [t, key]);
      const r = (rows as { subject: string | null; body_text: string | null; body_html: string | null; extra: unknown }[])[0];
      return r ? this.row(r) : undefined;
    });
  }
  async put(t: string, actor: string, key: string, o: MailTemplateOverride) {
    await this.v.writeOn(this.workBranch(true), async (c) => {
      await this.ensure(c);
      await c.query(`insert into ${TABLE} (tenant, tpl_key, lang, subject, body_text, body_html, extra, updated_at) values (?,?, 'en', ?,?,?,?,?) on duplicate key update subject=values(subject), body_text=values(body_text), body_html=values(body_html), extra=values(extra), updated_at=values(updated_at)`,
        [t, key, o.subject, o.text, o.html ?? null, o.vars ? JSON.stringify(o.vars) : null, new Date().toISOString()]);
      await this.commit(c, actor, key);
    });
  }
  async remove(t: string, actor: string, key: string) {
    await this.v.writeOn(this.workBranch(true), async (c) => {
      await this.ensure(c);
      await c.query(`delete from ${TABLE} where tenant=? and tpl_key=? and lang='en'`, [t, key]);
      await this.commit(c, actor, key);
    });
  }
  private async commit(c: Connection, actor: string, key: string) {
    const [d] = await c.query('select table_name from dolt_status where table_name=?', [TABLE]);
    if ((d as unknown[]).length) { await c.query(`call dolt_add('${TABLE}')`); await c.query("call dolt_commit('-m', ?)", [`mail-templates: ${actor} changed ${key}`]); }
  }
}

const VAR = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const usedVars = (s: string | undefined) => [...String(s ?? '').matchAll(VAR)].map((m) => m[1]);

@Injectable()
export class MailTemplatesService {
  constructor(@Inject(MAIL_TEMPLATE_STORE) private readonly store: MailTemplateStore, private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries) {}
  private async registry() { return workspaceMode() && this.branches ? this.branches.get(currentBranch(false)) : this.reg; }

  /** The catalogue merged with this branch's customizations, layout first. */
  async list(t: string) {
    const custom = await this.store.list(t);
    return mailCatalogue().map(({ plugin, decl }) => {
      const o = custom.get(decl.key);
      return {
        key: decl.key, plugin, name: decl.name, description: decl.description ?? '', layout: decl.layout === true,
        variables: decl.variables, customized: !!o,
        effective: o ? { subject: o.subject, text: o.text, ...(o.html !== undefined ? { html: o.html } : {}), ...(o.vars ? { vars: o.vars } : {}) }
          : { subject: decl.default.subject, text: decl.default.text, ...(decl.default.html !== undefined ? { html: decl.default.html } : {}), ...(decl.vars ? { vars: decl.vars } : {}) },
      };
    });
  }

  async detail(t: string, key: string) {
    const entry = mailTemplateDecl(key);
    if (!entry) throw new NotFoundException(`unknown mail template ${key}`);
    const override = (await this.store.get(t, key)) ?? null;
    const decl = entry.decl;
    return {
      key, plugin: entry.plugin, name: decl.name, description: decl.description ?? '', layout: decl.layout === true,
      variables: decl.variables, customized: !!override,
      default: { subject: decl.default.subject, text: decl.default.text, ...(decl.default.html !== undefined ? { html: decl.default.html } : {}), ...(decl.vars ? { vars: decl.vars } : {}) },
      override,
      effective: override ?? { subject: decl.default.subject, text: decl.default.text, ...(decl.default.html !== undefined ? { html: decl.default.html } : {}), ...(decl.vars ? { vars: decl.vars } : {}) },
    };
  }

  private static validate(key: string, b: { subject?: unknown; text?: unknown; html?: unknown; vars?: unknown }): MailTemplateOverride {
    const entry = mailTemplateDecl(key);
    if (!entry) throw new NotFoundException(`unknown mail template ${key}`);
    const decl = entry.decl;
    const layout = decl.layout === true;
    if (typeof b.html !== 'undefined' && b.html !== null && typeof b.html !== 'string') throw new BadRequestException('html must be a string');
    if (typeof b.vars !== 'undefined' && (typeof b.vars !== 'object' || b.vars === null || Array.isArray(b.vars))) throw new BadRequestException('vars must be an object');
    if (layout) {
      const html = typeof b.html === 'string' ? b.html : (mailTemplateDecl(key)?.decl.default.html ?? '');
      if (!usedVars(html).includes('body')) throw new BadRequestException('the layout html must keep the {{body}} placeholder');
      return { subject: '', text: '', html, vars: (b.vars ?? {}) as Record<string, string> };
    }
    if (typeof b.subject !== 'string' || !b.subject.trim()) throw new BadRequestException('subject is required');
    if (typeof b.text !== 'string' || !b.text.trim()) throw new BadRequestException('text is required');
    const declared = new Set(decl.variables.map((v) => v.name));
    const unknown = [...usedVars(b.subject), ...usedVars(b.text), ...usedVars(typeof b.html === 'string' ? b.html : '')].filter((v) => !declared.has(v));
    if (unknown.length) throw new BadRequestException(`unknown variable(s): ${[...new Set(unknown)].join(', ')} (declared: ${decl.variables.map((v) => v.name).join(', ') || 'none'})`);
    return { subject: b.subject, text: b.text, ...(typeof b.html === 'string' ? { html: b.html } : {}) };
  }

  async put(t: string, actor: string, key: string, b: { subject?: unknown; text?: unknown; html?: unknown; vars?: unknown }) {
    const o = MailTemplatesService.validate(key, b);
    await this.store.put(t, actor, key, o);
    return this.detail(t, key);
  }

  async restore(t: string, actor: string, key: string) {
    if (!mailTemplateDecl(key)) throw new NotFoundException(`unknown mail template ${key}`);
    await this.store.remove(t, actor, key);
    return this.detail(t, key);
  }

  /** Renders without saving: the editor's live preview. `override`/`layoutOverride` are unsaved drafts. */
  async preview(t: string, b: { key?: unknown; data?: unknown; override?: unknown; layoutOverride?: unknown }) {
    const key = typeof b.key === 'string' ? b.key : '';
    const entry = mailTemplateDecl(key);
    if (!entry || entry.decl.layout) throw new BadRequestException('preview needs a declared mail template key (not _layout)');
    const data = (b.data && typeof b.data === 'object' ? b.data : sampleData(entry.decl.variables.map((v) => v.name))) as Record<string, unknown>;
    const override = b.override && typeof b.override === 'object' ? MailTemplatesService.validate(key, b.override as never) : ((await this.store.get(t, key)) ?? null);
    const lo = b.layoutOverride && typeof b.layoutOverride === 'object' ? b.layoutOverride as { html?: string; vars?: Record<string, string> } : null;
    const savedLayout = lo ? null : ((await this.store.get(t, '_layout')) ?? null);
    const r = await renderMail(await this.registry(), t, key, data, {
      override: override as MailOverride | null,
      layoutOverride: lo ?? (savedLayout ? { html: savedLayout.html, vars: savedLayout.vars } : null),
    });
    if (!r) throw new BadRequestException('nothing rendered');
    return { key, data, ...r };
  }

  /** Renders (with the branch customization) and sends one test e-mail through the notify.default slot. */
  async sendTest(t: string, actor: string, key: string, b: { to?: unknown; data?: unknown }) {
    const entry = mailTemplateDecl(key);
    if (!entry || entry.decl.layout) throw new BadRequestException('send-test needs a declared mail template key (not _layout)');
    const to = typeof b.to === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.to) ? b.to : null;
    if (!to) throw new BadRequestException('a valid recipient e-mail (to) is required');
    const data = (b.data && typeof b.data === 'object' ? b.data : sampleData(entry.decl.variables.map((v) => v.name))) as Record<string, unknown>;
    const reg = await this.registry();
    const override = (await this.store.get(t, key)) ?? null;
    const savedLayout = (await this.store.get(t, '_layout')) ?? null;
    const r = await renderMail(reg, t, key, data, { override: override as MailOverride | null, layoutOverride: savedLayout ? { html: savedLayout.html, vars: savedLayout.vars } : null });
    if (!r) throw new BadRequestException('nothing rendered');
    let real = false;
    try { real = !!(await reg.callSlot<{ real: boolean }>(t, 'notify.default', 'notify.capability', {})).result.real; } catch { /* simulated path */ }
    await reg.emit(t, 'notify.send', { effectKey: `mail-test:${key}:${actor}:${Date.now()}`, tenant: t, to, template: key, data, subject: r.subject, text: r.text, ...(r.html ? { html: r.html } : {}) } as { effectKey: string });
    return { sent: true, real, to, subject: r.subject };
  }
}

/** Placeholder sample data for previews: each declared variable rendered as its own name. */
function sampleData(variables: string[]): Record<string, unknown> { return Object.fromEntries(variables.map((v) => [v, `sample-${v}`])); }

/** Admin console API for mail templates, one tenant at a time (token tenant must equal :tenant), same guard
 * shape as the plugins console: reading needs a sign-in, changing anything needs the admin capability. */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant/mail-templates')
export class MailTemplatesController {
  constructor(private readonly s: MailTemplatesService) {}
  @Get() list(@Param('tenant') t: string) { return this.s.list(t); }
  @Get(':key') detail(@Param('tenant') t: string, @Param('key') key: string) { return this.s.detail(t, key); }
  @UseGuards(AdminGuard) @Put(':key') put(@Param('tenant') t: string, @Param('key') key: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.s.put(t, r.user.sub, key, b); }
  @UseGuards(AdminGuard) @Delete(':key') restore(@Param('tenant') t: string, @Param('key') key: string, @Req() r: { user: { sub: string } }) { return this.s.restore(t, r.user.sub, key); }
  @UseGuards(AdminGuard) @Post('preview') preview(@Param('tenant') t: string, @Body() b: any) { return this.s.preview(t, b); }
  @UseGuards(AdminGuard) @Post(':key/send-test') sendTest(@Param('tenant') t: string, @Param('key') key: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.s.sendTest(t, r.user.sub, key, b); }
}
