// Migration readiness is independent of HTTP health. Background writers must not race boot migrations.
let ready = process.env.IAM_DATA_MIGRATIONS !== '1';
let release: () => void;
const pending = new Promise<void>(r => { release = r; });
export const dataReady = () => ready;
export const awaitDataReady = () => ready ? Promise.resolve() : pending;
export function releaseDataReady() { ready = true; release(); }
