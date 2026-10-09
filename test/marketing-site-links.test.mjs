import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('conversion-page logos do not link visitors to the main marketing site', () => {
  const sharedPage = read('src/components/EmployeeRecognitionPage.astro');
  assert.match(sharedPage, /\) : \(\s*<span class="logo">/);
  assert.match(sharedPage, /<a href=\{thankYouLogoHref\} class="logo"/);

  for (const file of [
    'src/pages/demo-video.astro',
    'src/pages/employee-rewards.astro',
    'src/pages/leading-employee-rewards-platform.astro',
    'src/pages/leading-peer-recognition-software.astro',
  ]) {
    const page = read(file);
    assert.match(page, /<span class="logo">/, `${file}: visible logo missing`);
    assert.doesNotMatch(page, /<a[^>]+class="logo"/, `${file}: logo is still a link`);
  }
});

test('healthcare trust badges are display-only, while the thank-you CTA remains', () => {
  const sharedPage = read('src/components/EmployeeRecognitionPage.astro');
  assert.match(sharedPage, /<div class="healthcare-security-badges"/);
  assert.doesNotMatch(sharedPage, /<a class="healthcare-security-badges"/);
  assert.match(sharedPage, /Go to Kudos\.com<\/a>/);
});
