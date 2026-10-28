const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** S256 code challenge for a PKCE verifier (RFC 7636). */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

export async function newPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  return { verifier, challenge: await challengeFor(verifier) };
}
