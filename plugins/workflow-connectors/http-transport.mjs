import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function publicAddress(ip) {
  try { return ipaddr.parse(ip).range() === 'unicast'; } catch { return false; }
}
/** Exact path or slash-delimited child, never a lexical prefix or encoded path separator. */
export function withinConnection(baseRaw, targetRaw) {
  const base = new URL(baseRaw), target = new URL(targetRaw);
  if (target.origin !== base.origin || /%(?:2f|5c|25)/i.test(target.pathname)) return false;
  const path = base.pathname.replace(/\/+$/, '');
  return target.pathname === path || target.pathname.startsWith(path + '/');
}
/** HTTPS only, public resolved addresses pinned into TLS socket lookup; redirects never followed. */
export async function safeHttp(raw, { method = 'GET', headers = {}, body = '', timeout = 10000 } = {}) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('HTTPS URL without credentials, custom port or fragment required');
  let dnsTimer;
  const addresses = await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }), new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('destination lookup timed out')), timeout); })]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('non-public destination refused');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, lookup: (_host, options, callback) => { const a = addresses[0]; callback(null, options?.all ? [a] : a.address, a.family); } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 128000) { res.destroy(); reject(new Error('response exceeds limit')); } else chunks.push(chunk); });
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let data = text; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode ?? 0, body: data }); });
      res.on('error', () => reject(new Error('external response interrupted')));
    });
    const deadline = setTimeout(() => req.destroy(new Error('external request timed out')), timeout);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', () => reject(new Error('external request failed')));
    if (body && method !== 'HEAD') req.write(body); req.end();
  });
}
