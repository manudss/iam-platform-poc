import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

/** Rebuild a small inert SVG vocabulary. No scripts, CSS, URLs, entities, foreign content or event handlers.
 * Custom artwork is served as an image under a restrictive CSP, never injected into an HTML document. */
export function sanitizeSvg(input: string): string {
  if (!input || input.length > 50000 || /<!|<\?|&/i.test(input)) throw new Error('SVG must be under 50KB and contain no declarations or entities');
  let bad = false;
  const doc = new DOMParser({ onError: () => { bad = true; } }).parseFromString(input, 'image/svg+xml');
  if (bad || doc.documentElement?.nodeName !== 'svg') throw new Error('Invalid SVG');
  const nodes = new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','title','desc']);
  const attrs = new Set(['xmlns','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','transform','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','fx','fy']);
  const walk = (el: any) => {
    if (!nodes.has(el.nodeName) || (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/2000/svg')) throw new Error('Unsupported SVG element');
    for (const a of Array.from(el.attributes ?? []) as any[]) {
      if (!attrs.has(a.name)) throw new Error('Unsupported SVG attribute: ' + a.name);
      if (a.name === 'xmlns') { if (a.value !== 'http://www.w3.org/2000/svg') throw new Error('Invalid SVG namespace'); continue; }
      if (/url\(/i.test(a.value) && !/^url\(#[a-zA-Z][\w-]*\)$/.test(a.value)) throw new Error('External SVG references are forbidden');
      if (/javascript:|data:|https?:|[<>]/i.test(a.value)) throw new Error('Unsafe SVG value');
    }
    for (const c of Array.from(el.childNodes ?? []) as any[]) {
      if (c.nodeType === 1) walk(c);
      else if (c.nodeType !== 3 || (!['title','desc'].includes(el.nodeName) && c.textContent.trim())) throw new Error('Unsupported SVG content');
    }
  };
  walk(doc.documentElement);
  return new XMLSerializer().serializeToString(doc.documentElement);
}
