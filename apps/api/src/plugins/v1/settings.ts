import type { SettingField } from './manifest.js';

export interface SettingsResult { ok: boolean; errors: string[]; values: Record<string, unknown>; }

/** Validates a settings object against a manifest schema. Unknown keys are rejected, defaults are applied. */
export function validateSettings(fields: SettingField[], input: Record<string, unknown>): SettingsResult {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const k of Object.keys(input)) if (!byKey.has(k)) errors.push(`unknown setting ${k}`);
  for (const f of fields) {
    let v = input[f.key];
    if (v === undefined || v === '') v = f.default;
    if (v === undefined || v === null) {
      if (f.required) errors.push(`${f.key} is required`);
      continue;
    }
    const bad = (m: string) => errors.push(`${f.key}: ${m}`);
    switch (f.type) {
      case 'string': case 'text': case 'url': case 'secret':
        if (typeof v !== 'string') { bad('must be a string'); break; }
        if (f.pattern && !new RegExp(f.pattern).test(v)) bad('does not match the expected format');
        if (f.type === 'url' && !/^https?:\/\//.test(v)) bad('must be an http(s) URL');
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) { bad('must be a number'); break; }
        if (f.min !== undefined && v < f.min) bad(`must be at least ${f.min}`);
        if (f.max !== undefined && v > f.max) bad(`must be at most ${f.max}`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') bad('must be true or false');
        break;
      case 'select':
        if (!f.options?.some((o) => o.value === v)) bad('not an allowed option');
        break;
      case 'multiselect':
        if (!Array.isArray(v) || v.some((x) => !f.options?.some((o) => o.value === x))) bad('contains a value that is not allowed');
        break;
      case 'list':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad('must be a list of strings');
        break;
    }
    values[f.key] = v;
  }
  return { ok: errors.length === 0, errors, values };
}

/** What the admin console receives: a form description plus current values, secrets masked. */
export interface FormModel {
  groups: { name: string; fields: (SettingField & { value: unknown })[] }[];
}
export function toFormModel(fields: SettingField[], current: Record<string, unknown>): FormModel {
  const groups = new Map<string, (SettingField & { value: unknown })[]>();
  for (const f of fields) {
    const g = f.group ?? 'General';
    const raw = current[f.key] ?? f.default;
    const value = f.type === 'secret' ? (raw ? '********' : '') : raw;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ ...f, value });
  }
  return { groups: [...groups].map(([name, fs]) => ({ name, fields: fs })) };
}

/**
 * Replacement rule. A replacement may add settings, but for every base setting it must be at least as strict as the base, so that any value
 * the replacement accepts is also valid for the base: same type, required stays required, ranges and lists cannot be wider, patterns and
 * select options cannot be looser. Secrets stay secrets. Enabling is refused until new required settings are configured.
 */
export function settingsExtend(base: SettingField[], child: SettingField[]): string[] {
  const errs: string[] = [];
  const c = new Map(child.map((f) => [f.key, f]));
  for (const b of base) {
    const f = c.get(b.key);
    if (!f) { errs.push(`missing base setting ${b.key}`); continue; }
    const e = (m: string) => errs.push(`setting ${b.key}: ${m}`);
    if (f.type !== b.type) e(`type ${f.type} differs from base ${b.type}`);
    if (b.required && !f.required && f.default === undefined) e('required in the base, must stay required');
    if (b.min !== undefined && (f.min === undefined || f.min < b.min)) e(`minimum must be at least ${b.min}`);
    if (b.max !== undefined && (f.max === undefined || f.max > b.max)) e(`maximum must be at most ${b.max}`);
    if (b.pattern !== undefined && f.pattern !== b.pattern) e('pattern must equal the base pattern');
    if (b.options && (!f.options || f.options.some((o) => !b.options!.some((x) => x.value === o.value)))) e('options must be a subset of the base options');
    if (b.default !== undefined && f.default !== undefined && JSON.stringify(b.default) !== JSON.stringify(f.default) && f.type !== 'secret') {
      const v = validateSettings([b], { [b.key]: f.default });
      if (!v.ok) e('default is not valid for the base');
    }
  }
  return errs;
}
