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

/** Replacement rule: `child` must declare every field of `base` with the same type. New required fields are allowed: enabling is refused until they are configured. */
export function settingsExtend(base: SettingField[], child: SettingField[]): string[] {
  const errs: string[] = [];
  const c = new Map(child.map((f) => [f.key, f]));
  for (const b of base) {
    const f = c.get(b.key);
    if (!f) { errs.push(`missing base setting ${b.key}`); continue; }
    if (f.type !== b.type) errs.push(`setting ${b.key}: type ${f.type} differs from base ${b.type}`);
  }
  return errs;
}
