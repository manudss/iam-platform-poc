import { createRequire } from 'node:module';
const require = createRequire(new URL('./package.json', import.meta.url));
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
/** Stored artwork only, never remote URLs or HTML. SVG uses a small inert vocabulary and is rendered as img. */
export function validateLogo(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 90000) throw Error('Logo must be an image under 64 KB');
  const match = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw Error('Logo must be a PNG, JPEG, WebP or SVG image');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 65536 || bytes.toString('base64') !== match[2]) throw Error('Logo must be a valid image under 64 KB');
  const type = match[1];
  if (type === 'svg+xml') {
    const input = bytes.toString('utf8');
    if (input.length > 50000 || /<!|<\?|&/i.test(input)) throw Error('SVG must be under 50 KB without declarations or entities');
    let bad = false;
    const doc = new DOMParser({ onError: () => { bad = true; } }).parseFromString(input, 'image/svg+xml');
    if (bad || doc.documentElement?.nodeName !== 'svg') throw Error('Invalid SVG');
    const nodes = new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','title','desc']);
    const attrs = new Set(['xmlns','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','transform','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','fx','fy']);
    function walk(el) {
      if (!nodes.has(el.nodeName) || (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/2000/svg')) throw Error('Unsupported SVG element');
      for (const a of Array.from(el.attributes ?? [])) {
        if (!attrs.has(a.name)) throw Error('Unsupported SVG attribute: ' + a.name);
        if (a.name === 'xmlns') { if (a.value !== 'http://www.w3.org/2000/svg') throw Error('Invalid SVG namespace'); continue; }
        if (/url\(/i.test(a.value) && !/^url\(#[a-zA-Z][\w-]*\)$/.test(a.value)) throw Error('External SVG references are forbidden');
        if (/javascript:|data:|https?:|[<>]/i.test(a.value)) throw Error('Unsafe SVG value');
      }
      for (const c of Array.from(el.childNodes ?? [])) {
        if (c.nodeType === 1) walk(c);
        else if (c.nodeType !== 3 || (!['title','desc'].includes(el.nodeName) && c.textContent.trim())) throw Error('Unsupported SVG content');
      }
    }
    walk(doc.documentElement);
    return 'data:image/svg+xml;base64,' + Buffer.from(new XMLSerializer().serializeToString(doc.documentElement)).toString('base64');
  }
  if (type === 'png' && !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Invalid PNG');
  if (type === 'jpeg' && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw Error('Invalid JPEG');
  if (type === 'webp' && !(bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP')) throw Error('Invalid WebP');
  return value;
}
