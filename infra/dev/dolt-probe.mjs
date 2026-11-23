// Read-only diagnostic for the dev stack: which root credential does the RUNNING Dolt server
// actually accept, and which accounts does it hold? Run inside the app container:
//   docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml run --rm app node infra/dev/dolt-probe.mjs
// Never prints any password. Connects, lists mysql.user (User, Host only) when a credential works.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { createConnection } = require('mysql2/promise');

const host = process.env.DOLT_HOST ?? 'dolt';
const port = Number(process.env.DOLT_PORT ?? 3306);
const user = process.env.DOLT_USER ?? 'root';

const candidates = [
  { label: 'the password from your .env (DOLT_ROOT_PASSWORD)', password: process.env.DOLT_PASSWORD ?? '' },
  { label: 'an EMPTY password (pre-.env initialization)', password: '' },
];

let connected = false;
for (const c of candidates) {
  try {
    const conn = await createConnection({ host, port, user, password: c.password, connectTimeout: 5000 });
    console.log(`ACCEPTED: ${c.label}`);
    const [rows] = await conn.query('SELECT User, Host FROM mysql.user');
    for (const r of rows) console.log(`  account: '${r.User}'@'${r.Host}'`);
    await conn.end();
    connected = true;
    break;
  } catch (e) {
    console.log(`REFUSED: ${c.label}\n  server said: ${e.message}`);
  }
}
if (!connected) {
  console.log('No candidate credential was accepted. Next read-only step: stop the dolt service and read the stored accounts directly (docker compose ... stop dolt, then docker compose ... run --rm --entrypoint dolt dolt sql -q "SELECT User, Host FROM mysql.user").');
}
