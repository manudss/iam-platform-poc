import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, NotFoundException, Optional, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { MailTemplateDecl } from '../plugins/v1/manifest.js';
import { createHash } from 'node:crypto';
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

export interface OwnedMailTemplate { name: string; description: string; variables: {name:string; type:'text' | 'temporary-password'; required:boolean}[] }
export interface MailTemplateOverride { definition?: OwnedMailTemplate; subject: string; text: string; html?: string; vars?: Record<string, string> }
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
    return { subject: r.subject ?? '', text: r.body_text ?? '', ...(r.body_html != null ? { html: r.body_html } : {}), ...(extra && typeof extra === 'object' ? ((extra as any).format === 'workflow-template/v1' ? { definition:(extra as any).definition } : { vars:extra as Record<string,string> }) : {}) };
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
        [t, key, o.subject, o.text, o.html ?? null, o.definition ? JSON.stringify({format:'workflow-template/v1',definition:o.definition}) : o.vars ? JSON.stringify(o.vars) : null, new Date().toISOString()]);
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

  private async entry(t:string, key:string):Promise<{plugin:string;decl:MailTemplateDecl}|undefined> {
    const declared = mailTemplateDecl(key);
    if (declared) return declared;
    const saved = await this.store.get(t,key);
    if (!saved?.definition || !key.startsWith('custom.')) return undefined;
    const d = saved.definition;
    return {plugin:'mail-templates',decl:{key,name:d.name,description:d.description,variables:d.variables.map(v=>({name:v.name})),default:{subject:saved.subject,text:saved.text,...(saved.html!==undefined?{html:saved.html}:{})}} satisfies MailTemplateDecl};
  }
  private revision(o:unknown) { return createHash('sha256').update(JSON.stringify(o)).digest('hex'); }

  /** User-owned definitions share the existing versioned storage, in a tagged extra envelope.
   * Legacy layout rows keep their plain vars object unchanged. No runtime secret is ever stored here. */
  async create(t:string, actor:string, b:any) {
    if (typeof b?.key !== 'string' || !/^custom\.[a-z][a-z0-9-]{1,48}$/.test(b.key)) throw new BadRequestException('key must be custom.<name>, lowercase letters, digits and hyphens');
    if (await this.entry(t,b.key)) throw new BadRequestException('mail template already exists');
    return this.putOwned(t,actor,b.key,b);
  }
  private async putOwned(t:string,actor:string,key:string,b:any) {
    if (typeof b?.name !== 'string' || !b.name.trim() || b.name.length>80) throw new BadRequestException('name is required, maximum 80 characters');
    if (!Array.isArray(b.variables) || b.variables.length>30) throw new BadRequestException('variables must be an array, maximum 30');
    const seen = new Set<string>();
    const variables = b.variables.map((v:any) => {
      if (!v || typeof v.name!=='string' || !/^[a-z][a-zA-Z0-9_]{0,39}$/.test(v.name) || ['__proto__','constructor','prototype'].includes(v.name) || seen.has(v.name)) throw new BadRequestException('invalid or duplicate variable name');
      seen.add(v.name);
      if (!['text','temporary-password'].includes(v.type)) throw new BadRequestException('unknown variable type');
      return {name:v.name,type:v.type,required:v.required!==false};
    });
    if (variables.filter((v:any)=>v.type==='temporary-password').length>1) throw new BadRequestException('only one temporary password parameter is supported');
    if(variables.some((v:any)=>v.type==='temporary-password') && (!variables.some((v:any)=>v.name==='expiry'&&v.type==='text') || variables.some((v:any)=>v.type==='temporary-password'&&(['expiry','hours'].includes(v.name)||!v.required)))) throw new BadRequestException('secret templates require a mandatory password parameter and a text expiry parameter');
    const decl:MailTemplateDecl={key,name:b.name,variables:variables.map((v:any)=>({name:v.name})),default:{subject:'',text:''}};
    const o = MailTemplatesService.validate(key,b,decl);
    for (const v of variables.filter((v:any)=>v.type==='temporary-password')) if (usedVars(o.subject).includes(v.name)) throw new BadRequestException('secret parameters are forbidden in the subject');
    if ((o.html?.length??0)>20000 || o.text.length>8000 || o.subject.length>150) throw new BadRequestException('template content is too long');
    if (o.html && /<\s*(script|iframe|form)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(o.html)) throw new BadRequestException('active HTML is refused');
    for(const v of variables.filter((v:any)=>v.type==='temporary-password')) if(!usedVars(o.text).includes(v.name)||!usedVars(o.text).includes('expiry')) throw new BadRequestException('secret text must include password and expiry placeholders');
    if(variables.some((v:any)=>v.type==='temporary-password') && o.html) throw new BadRequestException('secret templates must use plain text only');
    const definition:OwnedMailTemplate={name:b.name.trim(),description:String(b.description??'').slice(0,500),variables};
    await this.store.put(t,actor,key,{...o,definition});
    return this.detail(t,key);
  }

  /** The catalogue merged with this branch's customizations, layout first. */
  async list(t: string) {
    const custom = await this.store.list(t);
    const entries = [...mailCatalogue()];
    const layout=custom.get('_layout') ?? mailTemplateDecl('_layout')?.decl;
    for (const [key,o] of custom) if (o.definition) { const entry=await this.entry(t,key); if(entry) entries.push(entry); }
    return entries.map(({ plugin, decl }) => {
      const o = custom.get(decl.key);
      return {
        key: decl.key, plugin, name: decl.name, description: decl.description ?? '', layout: decl.layout === true,
        variables: o?.definition?.variables ?? decl.variables, owned:!!o?.definition, revision:this.revision([o ?? decl,layout]), customized: !!o,
        effective: o ? { subject: o.subject, text: o.text, ...(o.html !== undefined ? { html: o.html } : {}), ...(o.vars ? { vars: o.vars } : {}) }
          : { subject: decl.default.subject, text: decl.default.text, ...(decl.default.html !== undefined ? { html: decl.default.html } : {}), ...(decl.vars ? { vars: decl.vars } : {}) },
      };
    });
  }

  async detail(t: string, key: string) {
    const entry = await this.entry(t,key);
    if (!entry) throw new NotFoundException(`unknown mail template ${key}`);
    const override = (await this.store.get(t, key)) ?? null;
    const decl = entry.decl;
    return {
      key, plugin: entry.plugin, name: decl.name, description: decl.description ?? '', layout: decl.layout === true,
      variables: override?.definition?.variables ?? decl.variables, owned:!!override?.definition, revision:this.revision([override ?? decl,(await this.store.get(t,'_layout')) ?? mailTemplateDecl('_layout')?.decl]), customized: !!override,
      default: { subject: decl.default.subject, text: decl.default.text, ...(decl.default.html !== undefined ? { html: decl.default.html } : {}), ...(decl.vars ? { vars: decl.vars } : {}) },
      override,
      effective: override ?? { subject: decl.default.subject, text: decl.default.text, ...(decl.default.html !== undefined ? { html: decl.default.html } : {}), ...(decl.vars ? { vars: decl.vars } : {}) },
    };
  }

  private static validate(key: string, b: { subject?: unknown; text?: unknown; html?: unknown; vars?: unknown }, ownedDecl?:MailTemplateDecl): MailTemplateOverride {
    const entry = ownedDecl ? {decl:ownedDecl} : mailTemplateDecl(key);
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
    const saved=await this.store.get(t,key);
    if(saved?.definition) return this.putOwned(t,actor,key,{...saved.definition,...b});
    const o = MailTemplatesService.validate(key, b);
    await this.store.put(t, actor, key, o);
    return this.detail(t, key);
  }

  async restore(t: string, actor: string, key: string) {
    if (!await this.entry(t,key)) throw new NotFoundException(`unknown mail template ${key}`);
    const owned=!!(await this.store.get(t,key))?.definition;
    await this.store.remove(t, actor, key);
    return owned ? {key,removed:true,customized:false} : this.detail(t, key);
  }

  /** Renders without saving: the editor's live preview. `override`/`layoutOverride` are unsaved drafts. */
  async preview(t: string, b: { key?: unknown; data?: unknown; override?: unknown; layoutOverride?: unknown }) {
    const key = typeof b.key === 'string' ? b.key : '';
    const entry = await this.entry(t,key);
    if (!entry || entry.decl.layout) throw new BadRequestException('preview needs a declared mail template key (not _layout)');
    let data = (b.data && typeof b.data === 'object' ? b.data : sampleData(entry.decl.variables.map((v) => v.name))) as Record<string, unknown>;
    const saved=await this.store.get(t,key);
    if(saved?.definition) { data={...data}; for(const v of saved.definition.variables) if(v.type==='temporary-password') data[v.name]='[secret parameter]'; }
    const override = b.override && typeof b.override === 'object' ? MailTemplatesService.validate(key, b.override as never,entry.decl) : ((await this.store.get(t, key)) ?? null);
    const lo = b.layoutOverride && typeof b.layoutOverride === 'object' ? b.layoutOverride as { html?: string; vars?: Record<string, string> } : null;
    const savedLayout = lo ? null : ((await this.store.get(t, '_layout')) ?? null);
    const r = await renderMail(await this.registry(), t, key, data, {
      override: override as MailOverride | null, declaration:entry.decl,
      layoutOverride: lo ?? (savedLayout ? { html: savedLayout.html, vars: savedLayout.vars } : null),
    });
    if (!r) throw new BadRequestException('nothing rendered');
    return { key, data, ...r };
  }

  async validateWorkflowConfig(t:string,c:Record<string,unknown>) {
    const d=await this.workflowTemplate(t,String(c.templateKey));
    if(c.templateRevision!==d.revision) throw new BadRequestException('template changed, review its revision');
    const hasSecret=d.variables.some(v=>'type' in v&&v.type==='temporary-password');
    const vars=new Set(d.variables.map(v=>'param_'+v.name));
    if(Object.keys(c).some(k=>k.startsWith('param_')&&!vars.has(k))) throw new BadRequestException('unknown template parameter');
    for(const v of d.variables) {
      if(hasSecret&&['expiry','hours'].includes(v.name))continue;
      const value=c['param_'+v.name];
      if(('required' in v?v.required:true) && (typeof value!=='string'||!value)) throw new BadRequestException('required template parameter missing');
      if('type' in v && v.type==='temporary-password' && (typeof value!=='string'||!/^\{\{steps\.[a-z0-9-]+\.passwordRef\}\}$/.test(value))) throw new BadRequestException('secret template config must use an upstream passwordRef placeholder, never a value');
    }
  }

  async workflowTemplate(t:string,key:string) {
    const detail=await this.detail(t,key);
    if (detail.layout) throw new BadRequestException('layout cannot be sent');
    return detail;
  }
  async renderWorkflow(t:string,key:string,revision:string,data:Record<string,unknown>) {
    const d=await this.detail(t,key);
    if(d.layout || revision!==d.revision) throw new BadRequestException('template changed, review parameters and revision');
    if(!data || Array.isArray(data) || typeof data!=='object' || Object.values(data).some(v=>typeof v!=='string'||v.length>4000)) throw new BadRequestException('template parameters must be bounded strings');
    const declared=new Set(d.variables.map(v=>v.name));
    if(Object.keys(data).some(k=>!declared.has(k))) throw new BadRequestException('unknown template parameter');
    for(const v of d.variables) if (('required' in v ? v.required : true) && (data[v.name]===undefined || data[v.name]===null || data[v.name]==='')) throw new BadRequestException('required template parameter missing');
    const entry=await this.entry(t,key); if(!entry) throw new BadRequestException('unknown template');
    const savedLayout=await this.store.get(t,'_layout');
    const r=await renderMail(await this.registry(),t,key,data,{declaration:entry.decl,override:d.effective,layoutOverride:savedLayout ? {html:savedLayout.html,vars:savedLayout.vars}:null});
    if(!r) throw new BadRequestException('template renderer unavailable');
    if((await this.detail(t,key)).revision!==revision) throw new BadRequestException('template changed during rendering');
    return r;
  }

  /** Renders (with the branch customization) and sends one test e-mail through the notify.default slot. */
  async sendTest(t: string, actor: string, key: string, b: { to?: unknown; data?: unknown }) {
    const entry = await this.entry(t,key);
    if ((await this.store.get(t,key))?.definition?.variables.some(v=>v.type==='temporary-password')) throw new BadRequestException('secret templates cannot use send-test');
    if (!entry || entry.decl.layout) throw new BadRequestException('send-test needs a declared mail template key (not _layout)');
    const to = typeof b.to === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.to) ? b.to : null;
    if (!to) throw new BadRequestException('a valid recipient e-mail (to) is required');
    const data = (b.data && typeof b.data === 'object' ? b.data : sampleData(entry.decl.variables.map((v) => v.name))) as Record<string, unknown>;
    const reg = await this.registry();
    const override = (await this.store.get(t, key)) ?? null;
    const savedLayout = (await this.store.get(t, '_layout')) ?? null;
    const r = await renderMail(reg, t, key, data, { declaration:entry.decl, override: override as MailOverride | null, layoutOverride: savedLayout ? { html: savedLayout.html, vars: savedLayout.vars } : null });
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
  @UseGuards(AdminGuard) @Post() create(@Param('tenant') t:string,@Body() b:any,@Req() r:{user:{sub:string}}) { return this.s.create(t,r.user.sub,b); }
  @Get() list(@Param('tenant') t: string) { return this.s.list(t); }
  @Get(':key') detail(@Param('tenant') t: string, @Param('key') key: string) { return this.s.detail(t, key); }
  @UseGuards(AdminGuard) @Put(':key') put(@Param('tenant') t: string, @Param('key') key: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.s.put(t, r.user.sub, key, b); }
  @UseGuards(AdminGuard) @Delete(':key') restore(@Param('tenant') t: string, @Param('key') key: string, @Req() r: { user: { sub: string } }) { return this.s.restore(t, r.user.sub, key); }
  @UseGuards(AdminGuard) @Post('preview') preview(@Param('tenant') t: string, @Body() b: any) { return this.s.preview(t, b); }
  @UseGuards(AdminGuard) @Post(':key/send-test') sendTest(@Param('tenant') t: string, @Param('key') key: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.s.sendTest(t, r.user.sub, key, b); }
}
