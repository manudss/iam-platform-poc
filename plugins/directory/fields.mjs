import { createRequire } from 'node:module';
// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');
/**
 * Profile fields (see docs/profile-fields.md). Three separate things:
 *  1. the DEFINITION of a field (what a plugin or the base declares: type, constraints, security class),
 *  2. the admin CONFIGURATION of each field (versioned like other settings, live only after Apply),
 *  3. the VALUES people enter (runtime data, written by the server under the LIVE configuration).
 * Permissions (roles, organizations, assignments) are not profile fields: no configuration here can write them.
 */
export const FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'date', 'select', 'email', 'phone', 'url'];
export const SAFE_DEFAULTS = { enabled: true, signup: 'off', selfView: true, selfEdit: false, adminEdit: true };
export const EMPTY_PROFILE_CONFIG = { fields: {} };
export const CORE_PROFILE_SETTINGS_ID = 'core-profile-fields';
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const bad = (m) => { throw new BadRequestException(m); };
/** The base fields. They live in the identities table (UsersService); a plugin can never add a column to it. */
export const BASE_FIELDS = [
    { plugin: 'base', key: 'display_name', fullKey: 'base.display_name', type: 'string', label: 'Display name', max: 80, klass: 'profile', pii: 'personal', storage: 'identities', defaults: { signup: 'required', selfEdit: true } },
    { plugin: 'base', key: 'email', fullKey: 'base.email', type: 'email', label: 'E-mail', max: 254, klass: 'profile', pii: 'personal', storage: 'identities', defaults: { signup: 'required' }, help: 'Also receives sign-in codes: changing it later needs a new confirmation.' },
    { plugin: 'base', key: 'department', fullKey: 'base.department', type: 'string', label: 'Department', max: 40, klass: 'authority', pii: 'none', storage: 'identities', help: 'Treated as authority until the access engine is confirmed not to read it.' },
    { plugin: 'base', key: 'manager_id', fullKey: 'base.manager_id', type: 'string', label: 'Manager', max: 32, klass: 'authority', pii: 'none', storage: 'identities' },
];
/** Validates the declarations of ONE plugin (manifest time). Returns problems. */
export function validateFieldDecls(plugin, fields) {
    const errs = [];
    const seen = new Set();
    for (const f of fields ?? []) {
        if (!KEY.test(f?.key ?? '')) {
            errs.push(`profile field key ${f?.key} is invalid`);
            continue;
        }
        if (seen.has(f.key))
            errs.push(`profile field ${f.key} declared twice`);
        seen.add(f.key);
        if (!FIELD_TYPES.includes(f.type))
            errs.push(`profile field ${f.key}: unknown type ${f.type}`);
        if (!f.label)
            errs.push(`profile field ${f.key}: label required`);
        if (f.type === 'select' && !f.options?.length)
            errs.push(`profile field ${f.key}: options required`);
        if (f.klass !== undefined && f.klass !== 'profile' && f.klass !== 'authority')
            errs.push(`profile field ${f.key}: unknown class`);
        if (f.pii !== undefined && !['none', 'personal', 'sensitive'].includes(f.pii))
            errs.push(`profile field ${f.key}: unknown pii level`);
        if (f.pattern) {
            try {
                new RegExp(f.pattern);
            }
            catch {
                errs.push(`profile field ${f.key}: invalid pattern`);
            }
        }
        if (plugin === 'base')
            errs.push('the base plugin id is reserved for profile fields');
        const d = f.defaults;
        if (d && (f.klass === 'authority') && (d.selfEdit || (d.signup && d.signup !== 'off')))
            errs.push(`profile field ${f.key}: an authority field cannot default to user-editable or sign-up`);
    }
    return errs;
}
export function toCatalog(plugin, fields) {
    return fields.map((f) => ({ ...f, plugin, fullKey: `${plugin}.${f.key}`, klass: f.klass ?? 'profile', pii: f.pii ?? 'personal', storage: 'values' }));
}
export function settingFor(f, cfg) {
    const s = { ...SAFE_DEFAULTS, ...(f.defaults ?? {}), ...(cfg.fields[f.fullKey] ?? {}) };
    return f.klass === 'authority' ? { ...s, selfEdit: false, signup: 'off' } : s; // defense in depth: validation already refuses a stored config that says otherwise
}
export function parseProfileConfig(v) {
    const f = v?.fields;
    const su = v?.signup;
    const pol = v?.selfEditPolicy;
    return { fields: f && typeof f === 'object' && !Array.isArray(f) ? f : {}, ...(su && su.open === true ? { signup: { open: true } } : {}), ...(pol === 'review' ? { selfEditPolicy: 'review' } : {}) };
}
/** Validates a whole configuration against the catalogue. The security rules are enforced here, not in the screen. */
export function validateProfileConfig(input, catalogue) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return bad('configuration object required');
    const i = input;
    if (Object.keys(i).some((k) => k !== 'fields' && k !== 'signup' && k !== 'selfEditPolicy'))
        bad('unknown configuration field');
    if (i.selfEditPolicy !== undefined && i.selfEditPolicy !== 'immediate' && i.selfEditPolicy !== 'review')
        bad('selfEditPolicy: immediate or review');
    const su = i.signup;
    if (su !== undefined && (!su || typeof su !== 'object' || Array.isArray(su) || Object.keys(su).some((k) => k !== 'open') || typeof su.open !== 'boolean'))
        bad('signup: { open: boolean }');
    const fields = i.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields))
        return bad('fields: object required');
    const out = {};
    for (const [k, raw] of Object.entries(fields)) {
        const f = catalogue.find((c) => c.fullKey === k);
        if (!f) {
            bad(`unknown profile field ${k}`);
            continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            bad(`${k}: settings object required`);
        const r = raw;
        const allowed = ['enabled', 'signup', 'selfView', 'selfEdit', 'adminEdit', 'label', 'group', 'order'];
        if (Object.keys(r).some((x) => !allowed.includes(x)))
            bad(`${k}: unknown setting`);
        for (const b of ['enabled', 'selfView', 'selfEdit', 'adminEdit'])
            if (r[b] !== undefined && typeof r[b] !== 'boolean')
                bad(`${k}.${b}: boolean required`);
        if (r.signup !== undefined && !['off', 'optional', 'required'].includes(String(r.signup)))
            bad(`${k}.signup: off, optional or required`);
        for (const t of ['label', 'group'])
            if (r[t] !== undefined && (typeof r[t] !== 'string' || r[t].length > 80))
                bad(`${k}.${t}: text of at most 80 characters`);
        if (r.order !== undefined && (!Number.isInteger(r.order) || r.order < 0 || r.order > 999))
            bad(`${k}.order: integer 0..999`);
        const s = { ...SAFE_DEFAULTS, ...(f.defaults ?? {}), ...r };
        if (f.klass === 'authority' && (s.selfEdit || s.signup !== 'off'))
            bad(`${k}: an authority field can never be edited by the user or asked at sign-up`);
        if (!s.enabled && (s.signup !== 'off' || s.selfEdit))
            bad(`${k}: a disabled field cannot be asked at sign-up or edited by the user`);
        if (s.selfEdit && !s.selfView)
            bad(`${k}: selfEdit needs selfView`);
        out[k] = { ...r };
    }
    return { fields: out, ...(su?.open ? { signup: { open: true } } : {}), ...(i.selfEditPolicy === 'review' ? { selfEditPolicy: 'review' } : {}) };
}
/** The one schema the screens and the server rules both use, per context. */
export function effectiveSchema(catalogue, cfg, ctx) {
    const out = [];
    for (const f of catalogue) {
        const s = settingFor(f, cfg);
        if (!s.enabled)
            continue;
        const e = { key: f.fullKey, plugin: f.plugin, label: s.label ?? f.label, type: f.type, help: f.help, options: f.options, klass: f.klass, pii: f.pii, group: s.group, order: s.order ?? 500, visible: false, editable: false, required: false };
        if (ctx === 'signup') {
            if (s.signup === 'off' || f.klass === 'authority')
                continue;
            e.visible = e.editable = true;
            e.required = s.signup === 'required';
        }
        else if (ctx === 'self') {
            if (!s.selfView)
                continue;
            e.visible = true;
            e.editable = s.selfEdit && f.klass === 'profile' && f.storage === 'values';
        }
        else {
            e.visible = true;
            e.editable = s.adminEdit && f.storage === 'values';
        }
        out.push(e);
    }
    return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}
/** Checks one value against its declaration and returns the normalized value. Throws 400. */
export function checkValue(f, v) {
    if (v === null || v === '')
        return null;
    const k = f.fullKey;
    switch (f.type) {
        case 'boolean':
            if (typeof v !== 'boolean')
                bad(`${k}: boolean required`);
            return v;
        case 'number':
            if (typeof v !== 'number' || !Number.isFinite(v))
                bad(`${k}: number required`);
            if (f.min !== undefined && v < f.min || f.max !== undefined && v > f.max)
                bad(`${k}: out of range`);
            return v;
        default: {
            if (typeof v !== 'string')
                return bad(`${k}: text required`);
            const s = v.trim();
            const max = f.max ?? (f.type === 'text' ? 2000 : 200);
            if (s.length > max || (f.min !== undefined && s.length < f.min))
                bad(`${k}: length out of range`);
            if (f.type === 'select' && !f.options?.some((o) => o.value === s))
                bad(`${k}: not one of the options`);
            if (f.type === 'email' && !/^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/.test(s))
                bad(`${k}: invalid e-mail address`);
            if (f.type === 'phone' && !/^\+?[0-9 ().-]{6,20}$/.test(s))
                bad(`${k}: invalid phone number`);
            if (f.type === 'url' && !/^https:\/\/[^\s]{1,200}$/.test(s))
                bad(`${k}: https URL required`);
            if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s))
                bad(`${k}: date as YYYY-MM-DD`);
            if (f.pattern && !new RegExp(f.pattern).test(s))
                bad(`${k}: does not match the expected format`);
            return s;
        }
    }
}
