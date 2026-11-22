import { createServer, AddressInfo } from 'node:net';
/** Ask the OS for a local test port. Callers must bind promptly and verify their child starts. */
export async function localTestPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
