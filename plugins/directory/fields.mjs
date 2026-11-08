import { createRequire } from 'node:module';
// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');
/**
 * Profile fields (see docs/profile-fields.md). Three separate things:
 *  1. the DEFINITION of a field (what a plugin or the base declares: type, constraints, security class, storage),
 *  2. the admin CONFIGURATION of each field (versioned like other settings, live only after Apply),
 *  3. the VALUES people enter (runtime data, written by the server under the LIVE configuration).
 * Permissions (roles, organizations, assignments) are not profile fields: no configuration here can write them.
 *
 * Storage: a plugin field lives in a table the plugin owns (`storage: { table: 'plg_<pluginId>_…', column }`,
 * created by its install migrations and dropped by their inverse on uninstall). A declaration without `storage`
 * keeps the legacy generic row store (profile_field_values) and must be treated as a declaration to migrate.
 */
export const FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'date', 'select', 'email', 'phone', 'url', 'image'];
/** An image value is a data URL (`data:image/png;base64,…`), resized client-side, capped at 256 KB decoded. */
export const IMAGE_MAX_BYTES = 256 * 1024;
export const IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const SAFE_DEFAULTS = { enabled: true, signup: 'off', selfView: true, selfEdit: false, adminView: true, adminEdit: true };
export const EMPTY_PROFILE_CONFIG = { fields: {} };
export const CORE_PROFILE_SETTINGS_ID = 'core-profile-fields';
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const TABLE = /^plg_[a-z0-9_]{1,57}$/;
const COLUMN = /^[a-z][a-z0-9_]{0,63}$/;
const SQL_TYPES = ['text', 'mediumtext', 'longtext', 'double', 'tinyint(1)'];
export const COMPONENT_SURFACES = ['manage', 'readonly', 'hidden'];
const COMPONENT_KEY = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,31}$/;
const bad = (m) => { throw new BadRequestException(m); };
/** The base fields. They live in the identities table (UsersService); a plugin can never add a column to it. */
export const BASE_FIELDS = [
    { plugin: 'base', key: 'display_name', fullKey: 'base.display_name', type: 'string', label: 'Display name', max: 80, klass: 'profile', pii: 'personal', storage: 'identities', section: 'Identity', order: 10, defaults: { signup: 'required', selfEdit: true } },
    { plugin: 'base', key: 'email', fullKey: 'base.email', type: 'email', label: 'E-mail', max: 254, klass: 'profile', pii: 'personal', storage: 'identities', section: 'Identity', order: 20, defaults: { signup: 'required' }, help: 'Also receives sign-in codes: changing it later needs a new confirmation.' },
    { plugin: 'base', key: 'department', fullKey: 'base.department', type: 'string', label: 'Department', max: 40, klass: 'authority', pii: 'none', storage: 'identities', section: 'Organization', order: 30, help: 'Treated as authority until the access engine is confirmed not to read it.' },
    { plugin: 'base', key: 'manager_id', fullKey: 'base.manager_id', type: 'string', label: 'Manager', max: 32, klass: 'authority', pii: 'none', storage: 'identities', section: 'Organization', order: 40 },
];
/** The directory core fields can be tuned but never removed from every surface or asked nowhere: they ARE the account. */
const CORE_ALWAYS_ENABLED = ['base.display_name', 'base.email'];
const CORE_ALWAYS_ADMIN_VIEW = ['base.display_name'];
/** The default storage column type for a field type. */
export function defaultSqlType(type) {
    if (type === 'number') return 'double';
    if (type === 'boolean') return 'tinyint(1)';
    if (type === 'image' || type === 'text') return 'mediumtext';
    return 'text';
}
/** Validates the declarations of ONE plugin (manifest time). Returns problems. */
export function validateFieldDecls(plugin, fields) {
    const errs = [];
    const seen = new Set();
    const tablePrefix = `plg_${String(plugin).replace(/-/g, '_')}`;
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
        if (f.section !== undefined && (typeof f.section !== 'string' || !f.section.trim() || f.section.length > 80))
            errs.push(`profile field ${f.key}: section is a non-empty text of at most 80 characters`);
        if (f.order !== undefined && (!Number.isInteger(f.order) || f.order < 0 || f.order > 999))
            errs.push(`profile field ${f.key}: order is an integer 0..999`);
        if (f.pattern) {
            try {
                new RegExp(f.pattern);
            }
            catch {
                errs.push(`profile field ${f.key}: invalid pattern`);
            }
        }
        if (f.storage !== undefined) {
            const st = f.storage;
            if (!st || typeof st !== 'object' || Array.isArray(st)) {
                errs.push(`profile field ${f.key}: storage must be { table, column, sqlType? }`);
            }
            else {
                if (!TABLE.test(st.table ?? '') || !st.table.startsWith(tablePrefix + '_'))
                    errs.push(`profile field ${f.key}: storage table must start with ${tablePrefix}_`);
                if (!COLUMN.test(st.column ?? ''))
                    errs.push(`profile field ${f.key}: storage column is invalid`);
                if (st.sqlType !== undefined && !SQL_TYPES.includes(String(st.sqlType).toLowerCase()))
                    errs.push(`profile field ${f.key}: storage sqlType must be one of ${SQL_TYPES.join(', ')}`);
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
    return fields.map((f) => ({ ...f, plugin, fullKey: `${plugin}.${f.key}`, klass: f.klass ?? 'profile', pii: f.pii ?? 'personal',
        storage: f.storage ? 'table' : 'values', table: f.storage?.table, column: f.storage?.column }));
}
export function settingFor(f, cfg) {
    const s = { ...SAFE_DEFAULTS, ...(f.defaults ?? {}), ...(cfg.fields[f.fullKey] ?? {}) };
    return f.klass === 'authority' ? { ...s, selfEdit: false, signup: 'off' } : s; // defense in depth: validation already refuses a stored config that says otherwise
}
export function parseProfileConfig(v) {
    const f = v?.fields;
    const su = v?.signup;
    const pol = v?.selfEditPolicy;
    const comps = v?.components;
    return { fields: f && typeof f === 'object' && !Array.isArray(f) ? f : {},
        ...(su && su.open === true ? { signup: { open: true } } : {}),
        ...(pol === 'review' ? { selfEditPolicy: 'review' } : {}),
        ...(comps && typeof comps === 'object' && !Array.isArray(comps) ? { components: comps } : {}) };
}
/** Shape-checks one component override entry (`<plugin>:<component>` -> surfaces/order). Returns problems. */
export function validateComponentOverrides(components) {
    const errs = [];
    for (const [k, raw] of Object.entries(components ?? {})) {
        if (!COMPONENT_KEY.test(k)) { errs.push(`component key ${k} must be <plugin>:<component>`); continue; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errs.push(`${k}: settings object required`); continue; }
        for (const s of ['self', 'admin'])
            if (raw[s] !== undefined && !COMPONENT_SURFACES.includes(raw[s]))
                errs.push(`${k}.${s}: ${COMPONENT_SURFACES.join(', ')}`);
        if (raw.order !== undefined && (!Number.isInteger(raw.order) || raw.order < 0 || raw.order > 999))
            errs.push(`${k}.order: integer 0..999`);
        if (Object.keys(raw).some((x) => !['self', 'admin', 'order'].includes(x)))
            errs.push(`${k}: unknown setting`);
    }
    return errs;
}
/** Validates a whole configuration against the catalogue. The security rules are enforced here, not in the screen. */
export function validateProfileConfig(input, catalogue) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return bad('configuration object required');
    const i = input;
    if (Object.keys(i).some((k) => k !== 'fields' && k !== 'signup' && k !== 'selfEditPolicy' && k !== 'components'))
        bad('unknown configuration field');
    if (i.selfEditPolicy !== undefined && i.selfEditPolicy !== 'immediate' && i.selfEditPolicy !== 'review')
        bad('selfEditPolicy: immediate or review');
    const su = i.signup;
    if (su !== undefined && (!su || typeof su !== 'object' || Array.isArray(su) || Object.keys(su).some((k) => k !== 'open') || typeof su.open !== 'boolean'))
        bad('signup: { open: boolean }');
    if (i.components !== undefined) {
        if (!i.components || typeof i.components !== 'object' || Array.isArray(i.components))
            bad('components: object required');
        const cerrs = validateComponentOverrides(i.components);
        if (cerrs.length)
            bad(cerrs.join('; '));
    }
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
        const allowed = ['enabled', 'signup', 'selfView', 'selfEdit', 'adminView', 'adminEdit', 'label', 'group', 'section', 'order'];
        if (Object.keys(r).some((x) => !allowed.includes(x)))
            bad(`${k}: unknown setting`);
        for (const b of ['enabled', 'selfView', 'selfEdit', 'adminView', 'adminEdit'])
            if (r[b] !== undefined && typeof r[b] !== 'boolean')
                bad(`${k}.${b}: boolean required`);
        if (r.signup !== undefined && !['off', 'optional', 'required'].includes(String(r.signup)))
            bad(`${k}.signup: off, optional or required`);
        for (const t of ['label', 'group', 'section'])
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
        if (CORE_ALWAYS_ENABLED.includes(k) && !s.enabled)
            bad(`${k}: the directory core fields can be tuned but never disabled`);
        if (CORE_ALWAYS_ADMIN_VIEW.includes(k) && !s.adminView)
            bad(`${k}: the directory core fields always stay visible to an administrator`);
        out[k] = { ...r };
    }
    return { fields: out, ...(su?.open ? { signup: { open: true } } : {}), ...(i.selfEditPolicy === 'review' ? { selfEditPolicy: 'review' } : {}), ...(i.components ? { components: i.components } : {}) };
}
/** The one schema the screens and the server rules both use, per context. */
export function effectiveSchema(catalogue, cfg, ctx) {
    const out = [];
    for (const f of catalogue) {
        const s = settingFor(f, cfg);
        if (!s.enabled)
            continue;
        const e = { key: f.fullKey, plugin: f.plugin, label: s.label ?? f.label, type: f.type, help: f.help, options: f.options, klass: f.klass, pii: f.pii,
            group: s.group, section: s.section ?? f.section ?? s.group, order: s.order ?? f.order ?? 500, visible: false, editable: false, required: false };
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
            e.editable = s.selfEdit && f.klass === 'profile' && f.storage !== 'identities';
        }
        else {
            if (!s.adminView)
                continue;
            e.visible = true;
            e.editable = s.adminEdit && f.storage !== 'identities';
        }
        out.push(e);
    }
    return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}
/** Decoded byte length of a data-URL payload. */
function dataUrlBytes(v) {
    const i = v.indexOf('base64,');
    return Math.floor((v.length - i - 7) * 3 / 4);
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
        case 'image': {
            if (typeof v !== 'string')
                return bad(`${k}: an image is a data URL`);
            if (!IMAGE_PATTERN.test(v))
                bad(`${k}: a png, jpeg or webp data URL is required`);
            if (dataUrlBytes(v) > IMAGE_MAX_BYTES)
                bad(`${k}: image over ${Math.floor(IMAGE_MAX_BYTES / 1024)} KB`);
            return v;
        }
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
