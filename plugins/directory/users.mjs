/**
 * directory plugin: identity (user) validation rules.
 * The rules live in this folder; the core UsersService owns the storage (Dolt identities table,
 * credential file) and calls these pure checks before writing.
 */
import { createRequire } from 'node:module';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');

export const USER_ID = /^[a-z0-9-]{1,32}$/;
export const USER_EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/;
export const USER_FIELDS = ['id', 'display_name', 'department', 'manager_id', 'email', 'login_enabled', 'password'];

/** Validates an administrator's create/update body. `create` requires a valid id; a password (or a pre-hashed credential, checked by the caller) is required at creation. */
export function validateUserInput(b, create) {
  if (create && (typeof b.id !== 'string' || !USER_ID.test(b.id))) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
  for (const [k, max] of [['display_name', 80], ['department', 40], ['manager_id', 32], ['email', 254]]) if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || b[k].length > max)) throw new BadRequestException(`invalid ${k}`);
  if (typeof b.email === 'string' && b.email !== '' && !USER_EMAIL.test(b.email)) throw new BadRequestException('invalid email address');
  if (b.login_enabled !== undefined && typeof b.login_enabled !== 'boolean') throw new BadRequestException('login_enabled must be boolean');
  if ((create || b.password !== undefined) && (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128)) throw new BadRequestException('password: 12 to 128 characters');
  if (Object.keys(b).some((k) => !USER_FIELDS.includes(k))) throw new BadRequestException('unknown user field');
}
