// Unit tests for demo/public-redirect-uris.mjs (run: node --test demo/public-redirect-uris.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redirectUris } from './public-redirect-uris.mjs';

const SCRIPT = fileURLToPath(new URL('./public-redirect-uris.mjs', import.meta.url));

test('canonical origin plus the local console, nothing else', () => {
  assert.equal(
    redirectUris({ publicOrigin: 'https://lyam.dss.name' }),
    'https://lyam.dss.name/callback,http://localhost:4200/callback',
  );
});

test('Render external URL adds the onrender origin next to a custom domain', () => {
  assert.equal(
    redirectUris({ publicOrigin: 'https://lyam.dss.name', renderExternalUrl: 'https://iam-poc-demo.onrender.com' }),
    'https://lyam.dss.name/callback,http://localhost:4200/callback,https://iam-poc-demo.onrender.com/callback',
  );
});

test('a Render external URL equal to the canonical origin is not duplicated', () => {
  assert.equal(
    redirectUris({ publicOrigin: 'https://iam-poc-demo.onrender.com', renderExternalUrl: 'https://iam-poc-demo.onrender.com/' }),
    'https://iam-poc-demo.onrender.com/callback,http://localhost:4200/callback',
  );
});

test('extra origins are normalized (spaces, trailing slashes) and deduplicated', () => {
  assert.equal(
    redirectUris({ publicOrigin: 'https://lyam.dss.name', extraOrigins: ' https://iam.dss.name/ ,https://lyam.dss.name,,https://old.example.com' }),
    'https://lyam.dss.name/callback,http://localhost:4200/callback,https://iam.dss.name/callback,https://old.example.com/callback',
  );
});

test('origins that are not bare http(s) origins are ignored', () => {
  assert.equal(
    redirectUris({ publicOrigin: '', renderExternalUrl: 'ftp://x', extraOrigins: 'https://ok.example.com/path' }),
    'http://localhost:4200/callback',
  );
});

test('CLI reads PUBLIC_ORIGIN, RENDER_EXTERNAL_URL and IAM_PUBLIC_ORIGIN_EXTRA from the environment', () => {
  const out = execFileSync(process.execPath, [SCRIPT], {
    env: { PUBLIC_ORIGIN: 'https://lyam.dss.name', RENDER_EXTERNAL_URL: 'https://iam-poc-demo.onrender.com', IAM_PUBLIC_ORIGIN_EXTRA: 'https://iam.dss.name' },
    encoding: 'utf8',
  });
  assert.equal(out, 'https://lyam.dss.name/callback,http://localhost:4200/callback,https://iam-poc-demo.onrender.com/callback,https://iam.dss.name/callback');
});
