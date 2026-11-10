import { createRequire } from 'node:module';
/**
 * Activepieces adapter (SPIKE): runs ONE action of a real @activepieces/piece-* npm package outside the
 * Activepieces engine. A piece action is a plain async function `run(context)`; the engine-side context
 * (store, files, connections, server token) is replaced by explicit local stand-ins:
 *  - store: an in-memory key/value scoped to the call (pieces use it for trigger state, our actions do not);
 *  - files/connections: REFUSED with a clear error (a piece needing them says so instead of failing weirdly);
 *  - auth: built here from the plugin's console-typed settings, in the shape each piece expects
 *    (Jira custom auth -> { props: { instanceUrl, email, apiToken } }; Google service account ->
 *    { props: { serviceAccount, userEmail? } }).
 * Known limits of this spike (checked by hand on piece-http 0.13.2, piece-text-helper 0.6.7,
 * piece-jira-cloud 0.6.4, piece-google-sheets 0.19.5): no file outputs, no connection store, no
 * dynamic-property resolution UI (the dropdown props are filled directly with values), and pieces are
 * loaded with require() from the repo-root controlled install (scripts/plugin-deps.mjs).
 */
const require = createRequire(new URL('./package.json', import.meta.url));

// Static requires (one per piece package): scripts/plugin-deps.mjs scans for them and the controlled
// shared install only provides packages that are declared AND statically imported.
const PIECES = {
  '@activepieces/piece-http': () => require('@activepieces/piece-http'),
  '@activepieces/piece-text-helper': () => require('@activepieces/piece-text-helper'),
  '@activepieces/piece-jira-cloud': () => require('@activepieces/piece-jira-cloud'),
  '@activepieces/piece-google-sheets': () => require('@activepieces/piece-google-sheets'),
};

const loaded = new Map();
function piece(pkg) {
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
export async function runPieceAction(pkg, actionName, { auth, propsValue }) {
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
  return action.run(context);
}
