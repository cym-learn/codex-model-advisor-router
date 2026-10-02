import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableConfig, disableConfig } from '../src/config.mjs';

test('enabling and disabling restores only managed settings while retaining later user edits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'router-config-'));
  const path = join(directory, 'config.toml');
  const original = 'model = "gpt-6-sol"\r\nmodel_provider = "existing"\r\n\r\n[windows]\r\nsandbox = "elevated"\r\n';
  writeFileSync(path, original, 'utf8');
  try {
    enableConfig(path, 'http://127.0.0.1:18765/v1', directory);
    const enabled = readFileSync(path, 'utf8');
    assert.match(enabled, /model_provider = "advisor_router"/);
    assert.match(enabled, /requires_openai_auth = true/);
    writeFileSync(path, enabled.replace('sandbox = "elevated"', 'sandbox = "workspace-write"'), 'utf8');
    disableConfig(path);
    const restored = readFileSync(path, 'utf8');
    assert.match(restored, /model_provider = "existing"/);
    assert.match(restored, /sandbox = "workspace-write"/);
    assert.doesNotMatch(restored, /advisor_router/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
