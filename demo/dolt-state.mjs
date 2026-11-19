// Decides whether the Dolt data directory is EMPTY, POPULATED or UNREADABLE before start.sh
// touches it. This distinction is what protects a persistent deployment: a read ERROR (Dolt
// binary failure, corrupted repo, locked files) must never be treated as an empty database,
// because "empty" is what triggers the schema/seed import - importing over existing data would
// silently fork or clobber a real dataset. The hosted free-tier demo wipes its filesystem on
// every restart, so an honestly empty directory remains a normal case there.
//
// Usage: node dolt-state.mjs [--dir <dolt-repo-dir>] [--dolt <binary>]
// Prints exactly one word on stdout: "empty" or "populated". Any doubt exits 2 with the
// reason on stderr and prints nothing: callers must fail closed.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Messages Dolt emits when the database or table genuinely does not exist yet. Anything else is an error. */
const ABSENT = /not found|does not exist|doesn't exist|unknown database|no such table/i;

/** Pure classification, exported for tests. Returns 'empty', 'populated' or throws (=> unreadable). */
export function classify({ status, error, stdout, stderr }) {
  if (error) throw new Error(`dolt could not run: ${error.message}`);
  const out = `${stdout ?? ''}\n${stderr ?? ''}`;
  if (status === 0) return 'populated';
  if (ABSENT.test(out)) return 'empty';
  throw new Error(`dolt answered with an error, not an empty database: ${out.trim().slice(0, 300)}`);
}

export function probe({ dir = process.cwd(), dolt = 'dolt' } = {}) {
  // COUNT(*) on a table every dataset has: 0 rows still means the schema was imported (populated).
  const r = spawnSync(dolt, ['sql', '-q', 'SELECT COUNT(*) AS n FROM iam.assignments'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  return classify({ status: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    process.stdout.write(`${probe({ dir: opt('--dir'), dolt: opt('--dolt') })}\n`);
  } catch (e) {
    console.error(`[demo] dolt state check failed: ${e.message}`);
    process.exit(2);
  }
}
