import { BadRequestException } from '@nestjs/common';

/** Names and refs reach SQL as parameters or as quoted identifiers, but every one is validated first: defense in depth. */
export const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
export const NEW_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/; // branches created here: no slash, one path segment
export const HASH = /^[0-9a-v]{32}$/;
export const TABLE = /^[A-Za-z0-9_]{1,64}$/;
export const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function branchName(v: unknown, what = 'branch'): string {
  if (typeof v !== 'string' || !BRANCH.test(v) || v.includes('..') || v.endsWith('/') || v.endsWith('.lock')) throw new BadRequestException(`invalid ${what} name`);
  return v;
}
export function newBranchName(v: unknown): string {
  if (typeof v !== 'string' || !NEW_BRANCH.test(v) || v.includes('..') || v.endsWith('.lock')) throw new BadRequestException('invalid branch name (letters, digits, . _ - ; max 63)');
  return v;
}
export function tableName(v: unknown): string {
  if (typeof v !== 'string' || !TABLE.test(v)) throw new BadRequestException('invalid table name');
  return v;
}
export function commitMessage(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim() : '';
  return (s || fallback).slice(0, 200);
}
/** Commit author shown in the history: the signed-in user's subject, restricted to a harmless charset. */
export function authorOf(sub: unknown): string {
  const s = typeof sub === 'string' ? sub.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) : '';
  const n = s || 'unknown';
  return `${n} <${n}@iam-poc.invalid>`;
}

// ---------------------------------------------------------------------------------------------
// SQL console guard. The console is an operator tool, so it accepts arbitrary SQL on a branch, but never
// anything that could escape the branch model: version-control procedures/functions, files, sessions.
// Dolt operations (commit, merge, reset, branch...) exist ONLY as dedicated endpoints with their own rules.
// ---------------------------------------------------------------------------------------------

/** Read-only Dolt system tables and table functions the console may query. Everything else named dolt_* is refused. */
const DOLT_READ_ALLOWED = /^dolt_(log|branches|status|tags|commits|commit_ancestors|diff|diff_summary|diff_stat|schema_diff|patch|column_diff|schemas|docs|ignore|remotes|merge_status|query_summary|statistics|(commit_diff|history|blame|workspace|diff|constraint_violations)_[a-z0-9_]+|conflicts(?!_resolve)(_[a-z0-9_]+)?)$/i;
const OTHER_FUNCTIONS_ALLOWED = new Set(['hashof', 'active_branch', 'database', 'version']);

export interface ScannedSql { statements: string[]; skeletons: string[] }

/** Splits on top-level `;`, strips comments, and builds a skeleton (string literals emptied, backticks removed) used for keyword checks. */
export function scanSql(sql: string): ScannedSql {
  if (typeof sql !== 'string' || !sql.trim()) throw new BadRequestException('empty SQL');
  if (sql.length > 20000) throw new BadRequestException('SQL too long (max 20000 characters)');
  const statements: string[] = [], skeletons: string[] = [];
  let cur = '', skel = '';
  const flush = () => { if (cur.trim()) { statements.push(cur.trim()); skeletons.push(skel.replace(/\s+/g, ' ').trim()); } cur = ''; skel = ''; };
  for (let i = 0; i < sql.length;) {
    const ch = sql[i], two = sql.slice(i, i + 2);
    if (two === '/*') {
      if (sql[i + 2] === '!' || sql[i + 2] === '+') throw new BadRequestException('executable comments are not allowed');
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new BadRequestException('unterminated comment');
      cur += ' '; skel += ' '; i = end + 2; continue;
    }
    if (ch === '#' || (two === '--' && /[\s]|$/.test(sql[i + 2] ?? ' '))) {
      const end = sql.indexOf('\n', i); cur += ' '; skel += ' '; i = end < 0 ? sql.length : end; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1, closed = false;
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') { j += 2; continue; }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } closed = true; break; }
        j++;
      }
      if (!closed) throw new BadRequestException('unterminated quoted text');
      const lit = sql.slice(i, j + 1);
      cur += lit; skel += ch === '`' ? sql.slice(i + 1, j) : "''";
      i = j + 1; continue;
    }
    if (ch === ';') { flush(); i++; continue; }
    cur += ch; skel += ch; i++;
  }
  flush();
  if (!statements.length) throw new BadRequestException('empty SQL');
  return { statements, skeletons };
}

const READ_FIRST = /^(select|show|describe|desc|explain|with)\b/i;
const WRITE_FIRST = /^(insert|update|delete|replace)\b|^(create|alter|drop)\s+(unique\s+)?(table|index|view)\b|^rename\s+table\b|^truncate\b/i;
const FORBIDDEN_ANYWHERE = /\bsleep\s*\(|\bbenchmark\s*\(|\bload_file\s*\(|\bget_lock\s*\(|@@/i;
const DESTRUCTIVE = /^(drop|truncate)\b|^alter\s+table\s+\S+\s+drop\b/i;

function doltNames(skeleton: string): string[] {
  return [...skeleton.matchAll(/\b(dolt_[a-z0-9_]+|hashof|active_branch)\b/gi)].map((m) => m[1]);
}

export interface CheckedSql { statements: string[]; destructive: boolean }

/** Throws BadRequestException when the SQL is not allowed in the requested mode. */
export function checkSql(sql: string, mode: 'read' | 'write'): CheckedSql {
  const { statements, skeletons } = scanSql(sql);
  if (mode === 'read' && statements.length !== 1) throw new BadRequestException('read mode runs exactly one statement');
  if (statements.length > 50) throw new BadRequestException('at most 50 statements per run');
  let destructive = false;
  skeletons.forEach((s) => {
    if (FORBIDDEN_ANYWHERE.test(s)) throw new BadRequestException('this statement uses a feature the console does not allow (SLEEP, BENCHMARK, LOAD_FILE, GET_LOCK, @@variables)');
    if (mode === 'read') {
      if (/\binto\b/i.test(s)) throw new BadRequestException('SELECT ... INTO is not allowed');
      if (!READ_FIRST.test(s)) throw new BadRequestException('read mode accepts SELECT, SHOW, DESCRIBE, EXPLAIN or WITH only');
      for (const n of doltNames(s)) {
        if (n.toLowerCase().startsWith('dolt_') ? !DOLT_READ_ALLOWED.test(n) : !OTHER_FUNCTIONS_ALLOWED.has(n.toLowerCase())) throw new BadRequestException(`"${n}" is not available in the console (version-control actions have dedicated screens)`);
      }
    } else {
      if (!WRITE_FIRST.test(s)) throw new BadRequestException('write mode accepts INSERT, UPDATE, DELETE, REPLACE, CREATE/ALTER/DROP TABLE|INDEX|VIEW, RENAME TABLE, TRUNCATE');
      if (/\bdolt_|\bhashof\b|\bactive_branch\b/i.test(s)) throw new BadRequestException('write statements cannot touch Dolt system objects');
      if (DESTRUCTIVE.test(s) || (/^(update|delete)\b/i.test(s) && !/\bwhere\b/i.test(s))) destructive = true;
    }
  });
  return { statements, destructive };
}
