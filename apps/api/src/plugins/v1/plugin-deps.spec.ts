import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { defaultPluginsDir } from './loader.js';

/** Step 4 acceptance: a plugin owns its dependencies.
 *  - its folder declares every external package its code imports (its own package.json), and plugin code
 *    anchors `createRequire` there - never at the API's package.json;
 *  - the repo-root package.json is the GENERATED union of those declarations (the controlled shared
 *    install); scripts/plugin-deps.mjs --check enforces the whole invariant in CI;
 *  - the declaration is part of the signed plugin: signature.json covers package.json. */
const root = resolve(defaultPluginsDir(), '..');

describe('plugins own their dependencies (step 4 acceptance)', () => {
  it('1. declarations, code scan and the generated root package.json all agree', () => {
    execFileSync(process.execPath, [resolve(root, 'scripts/plugin-deps.mjs'), '--check'], { stdio: 'pipe' });
  });

  it('2. plugin code resolves its dependencies from its own package.json (the shared root install)', () => {
    for (const [id, dep] of [['mcp-gateway', 'zod'], ['oidc-provider', 'oidc-provider'], ['saml-idp', 'samlify'], ['notify-resend', 'resend']]) {
      const req = createRequire(join(defaultPluginsDir(), id, 'package.json'));
      const resolved = req.resolve(dep);
      assert.ok(resolved.startsWith(join(root, 'node_modules')), `${id}: ${dep} resolves from the controlled root install, got ${resolved}`);
    }
  });

  it('2b. host-provided packages stay the API\'s single instance (no dual @nestjs/common)', () => {
    const req = createRequire(join(defaultPluginsDir(), 'oidc-provider', 'package.json'));
    const resolved = req.resolve('@nestjs/common');
    assert.ok(resolved.startsWith(join(root, 'apps', 'api', 'node_modules')), `@nestjs/common must be the API copy (exception identity), got ${resolved}`);
  });

  it('3. no plugin anchors its imports at the API package.json anymore', () => {
    const walk = function* (d: string): Generator<string> {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (e.name.endsWith('.mjs')) yield p;
      }
    };
    for (const f of walk(defaultPluginsDir())) {
      assert.ok(!readFileSync(f, 'utf8').includes('IAM_API_PACKAGE_JSON'), `${f}: still anchored at the API`);
    }
  });

  it('4. the dependency declaration is signed with the plugin', () => {
    for (const id of readdirSync(defaultPluginsDir())) {
      const dir = join(defaultPluginsDir(), id);
      if (!existsSync(join(dir, 'manifest.json'))) continue;
      assert.ok(existsSync(join(dir, 'package.json')), `${id}: every plugin declares its dependencies (even zero)`);
      const sig = JSON.parse(readFileSync(join(dir, 'signature.json'), 'utf8')) as { files: Record<string, string> };
      assert.ok(sig.files['package.json'], `${id}: package.json is covered by the signature`);
    }
  });
});
