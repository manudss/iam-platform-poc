import { BadRequestException } from '@nestjs/common';

export interface ImportRow { identity: string; displayName: string; manager: string | null; department: string; role: string }
const ID = /^[a-z0-9-]{1,32}$/;
const HEADER = ['identity_id', 'display_name', 'manager_id', 'department', 'role_id'];

/** Minimal RFC 4180 parser (quotes, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x !== '')) out.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some((x) => x !== '')) out.push(row);
  return out;
}

/** HR-style CSV connector: header identity_id,display_name,manager_id,department,role_id. Strict validation, fictional data only. */
export function csvToRows(text: string): ImportRow[] {
  if (typeof text !== 'string' || text.length > 100_000) throw new BadRequestException('csv missing or larger than 100 KB');
  const [head, ...body] = parseCsv(text);
  if (!head || head.join(',') !== HEADER.join(',')) throw new BadRequestException(`header must be: ${HEADER.join(',')}`);
  return body.map((c, i) => {
    const line = i + 2;
    if (c.length !== 5) throw new BadRequestException(`line ${line}: 5 columns expected`);
    const [identity, displayName, manager, department, role] = c.map((x) => x.trim());
    if (!ID.test(identity) || !ID.test(role) || (manager && !ID.test(manager))) throw new BadRequestException(`line ${line}: invalid id`);
    if (!displayName || displayName.length > 80 || department.length > 40) throw new BadRequestException(`line ${line}: invalid name or department`);
    return { identity, displayName, manager: manager || null, department, role };
  });
}
