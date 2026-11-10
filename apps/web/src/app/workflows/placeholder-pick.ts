// ---- Placeholder picker helpers (pure, unit-tested): the editor's drawer offers autocompletion of the
// {{event.*}} / {{steps.*.value}} placeholders while a field is being typed, and one-click insertion into
// the last focused field. ----

/** An unfinished placeholder at the caret: `start` is the index of its `{{`, `text` what was typed after it. */
export interface PhToken { start: number; text: string }

/** Finds the unfinished `{{...` token ending at the caret, or null when the caret is not inside one
 * (already closed, a second `{` opened, or a newline since). */
export function phTokenAt(value: string, caret: number): PhToken | null {
  const upto = value.slice(0, Math.max(0, caret));
  const open = upto.lastIndexOf('{{');
  if (open < 0) return null;
  const text = upto.slice(open + 2);
  if (text.includes('}') || text.includes('{') || text.includes('\n') || text.includes('<')) return null;
  return { start: open, text };
}

/** Placeholders (full `{{...}}` strings) matching the typed token, best (prefix after the braces) first, max 8. */
export function filterPlaceholders(list: string[], token: string): string[] {
  const t = token.trim().toLowerCase();
  if (!t) return list.slice(0, 8);
  const prefix: string[] = [], rest: string[] = [];
  for (const p of list) {
    const inner = p.replace(/^\{\{/, '').toLowerCase();
    if (inner.startsWith(t)) prefix.push(p);
    else if (p.toLowerCase().includes(t)) rest.push(p);
  }
  return [...prefix, ...rest].slice(0, 8);
}

/** Replaces the token [start, caret) by the full placeholder and returns the new caret position. */
export function insertPlaceholder(value: string, caret: number, start: number, ph: string): { value: string; caret: number } {
  return { value: value.slice(0, start) + ph + value.slice(caret), caret: start + ph.length };
}
