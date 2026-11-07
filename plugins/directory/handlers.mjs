// Directory base plugin: the pure management RULES behind the directory.default slot (phase 2 step 1).
// Identity storage and data plumbing stay in the core adapters; these handlers only decide and validate,
// delegating to the plugin's own library modules. A replacement extends directory and must handle every hook.
import * as fields from './fields.mjs';
import * as users from './users.mjs';
import * as effects from './effects.mjs';

export default {
  'directory.user.validate': ({ body, create }) => {
    try { users.validateUserInput(body ?? {}, !!create); return { valid: true }; }
    catch (e) { return { valid: false, errors: [String(e?.message ?? e)] }; }
  },
  'directory.fields.validateDecls': ({ plugin, fields: decls }) => ({ errors: fields.validateFieldDecls(plugin, decls) }),
  'directory.fields.catalogue': ({ plugin, fields: decls }) => ({ catalogue: fields.toCatalog(plugin, decls) }),
  'directory.fields.parseConfig': ({ value }) => ({ config: fields.parseProfileConfig(value) }),
  'directory.fields.validateConfig': ({ input, catalogue }) => {
    try { return { valid: true, config: fields.validateProfileConfig(input, catalogue) }; }
    catch (e) { return { valid: false, errors: [String(e?.message ?? e)] }; }
  },
  'directory.fields.effectiveSchema': ({ catalogue, config, context }) => ({ fields: fields.effectiveSchema(catalogue, config, context) }),
  'directory.fields.checkValue': ({ field, value }) => {
    try { return { valid: true, value: fields.checkValue(field, value) }; }
    catch (e) { return { valid: false, error: String(e?.message ?? e) }; }
  },
  'directory.effects.compute': ({ prev, cur }) => ({ changes: effects.diff(prev, cur) }),
};
