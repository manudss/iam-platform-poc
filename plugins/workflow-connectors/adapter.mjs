import{loadSafePiece,assertNativeTls}from'./safe-piece-loader.mjs';
import { createRequire } from 'node:module';
/** Executes installed Activepieces action functions with host-supplied services.
 * Legacy callers retain isolated in-memory state and explicit unsupported-service errors.
 * Full catalogue callers supply durable state and private file output via runtime.
 * Static imports below are also the controlled-install dependency inventory. */
const require = createRequire(new URL('./package.json', import.meta.url));

// Static requires (one per piece package): scripts/plugin-deps.mjs scans for them and the controlled
// shared install only provides packages that are declared AND statically imported.
// Statically declared dependencies, never invoked: loading routes through reviewed bytes below.
const dependencyInventory = [()=>require('@activepieces/piece-http'),()=>require('@activepieces/piece-text-helper'),()=>require('@activepieces/piece-jira-cloud'),()=>require('@activepieces/piece-google-sheets')];
const PIECES = {
  '@activepieces/piece-http': () => loadSafePiece(require,'@activepieces/piece-http'),
  '@activepieces/piece-text-helper': () => loadSafePiece(require,'@activepieces/piece-text-helper'),
  '@activepieces/piece-jira-cloud': () => loadSafePiece(require,'@activepieces/piece-jira-cloud'),
  '@activepieces/piece-google-sheets': () => loadSafePiece(require,'@activepieces/piece-google-sheets'),
};

assertNativeTls();
const loaded = new Map();
export function piece(pkg) {
  if (!PIECES[pkg]) throw new Error(`${pkg}: not one of the adapter's declared pieces (${Object.keys(PIECES).join(', ')})`);
  if (!loaded.has(pkg)) {
    const mod = PIECES[pkg]();
    const found = Object.values(mod).find((v) => v && v.constructor?.name === 'Piece');
    if (!found) throw new Error(`${pkg}: no piece export found`);
    loaded.set(pkg, found);
  }
  return loaded.get(pkg);
}

/** The named action of a piece, or an error naming the available ones. */
export function pieceAction(pkg, actionName) {
  const p = piece(pkg);
  const action = p._actions?.[actionName];
  if (!action) throw new Error(`${pkg}: unknown action "${actionName}" (available: ${Object.keys(p._actions ?? {}).slice(0, 12).join(', ')}...)`);
  return action;
}

/** Runs the action with a minimal engine context. `auth` is passed verbatim (shape is per piece). */
export async function runPieceAction(pkg, actionName, { auth, propsValue, runtime = {} }) {
  assertNativeTls();
  const action = pieceAction(pkg, actionName);
  const memory = new Map();
  const context = {
    propsValue,
    auth,
    store: { get: async (k) => memory.get(k), put: async (k, v) => void memory.set(k, v), delete: async (k) => void memory.delete(k) },
    files: { write: async () => { throw new Error('file outputs are not supported by the lyam adapter (spike limit)'); } },
    connections: { get: async () => { throw new Error('external connection store is not available in the lyam adapter (spike limit)'); } },
    server: { apiUrl: '', publicUrl: '', token: '' },
    run: { id: 'lyam-workflow' },
    project: { id: 'lyam' },
    agent: {},
    flow: { id: 'lyam', version: { id: '1' } },
    step: { name: actionName },
  };
  return action.run({ ...context, ...runtime, auth, propsValue });
}
