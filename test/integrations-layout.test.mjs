import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'src/styles/global.css'), 'utf8');

test('the shared integrations visual keeps a definite width on stacked layouts', () => {
  const tabletRules = css.slice(css.indexOf('@media (max-width: 991px)'), css.indexOf('@media (max-width: 767px)'));
  const phoneRules = css.slice(css.indexOf('@media (max-width: 767px)'), css.indexOf('@media (max-width: 380px)'));

  assert.match(tabletRules, /\.integrations-visual\s*\{[^}]*width:\s*min\(100%, 300px\)/);
  assert.match(phoneRules, /\.integrations-visual\s*\{[^}]*width:\s*min\(100%, 280px\)/);
  assert.doesNotMatch(phoneRules, /\.integrations-visual\s*\{[^}]*overflow-x:\s*clip/);
});
