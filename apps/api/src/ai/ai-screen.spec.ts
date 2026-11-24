// Runs the packaged chat screen in headless Chrome with the console theme (scripts/ai-assistant-screen-check.mjs):
// pending change card, approval, poisoned tool text shown as text, no merge/apply control. Skipped without Chrome.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = process.env.CHROME_BIN ?? spawnSync('sh', ['-c', 'command -v google-chrome || command -v chromium'], { encoding: 'utf8' }).stdout.trim();
describe('AI assistant screen (headless Chrome)', { skip: !chrome && 'no Chrome available' }, () => {
  it('renders the conversation, asks for approval, and never executes tool text', () => {
    const out = mkdtempSync(join(tmpdir(), 'ai-screen-'));
    const r = spawnSync('node', [resolve(process.cwd(), '../../scripts/ai-assistant-screen-check.mjs'), out], { encoding: 'utf8', env: { ...process.env, CHROME_BIN: chrome }, timeout: 90_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});
