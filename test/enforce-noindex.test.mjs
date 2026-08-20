/**
 * Tests for scripts/enforce-noindex.mjs.
 *
 * This script runs as part of `npm run build` and rewrites every HTML file in
 * dist/ to carry noindex, which is what keeps paid landing pages out of organic
 * search results. It is the only thing enforcing that, it edits build output in
 * place, and a silent failure would not be visible until pages started ranking.
 *
 * The script resolves dist/ relative to cwd and runs on import, so it is
 * exercised as a subprocess against a temporary dist tree rather than imported.
 *
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/enforce-noindex.mjs');

/**
 * Write `files` into a temp dist/, run the script there, return the results.
 * @param files { [relativePath]: contents }
 */
function run(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noindex-'));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = path.join(dir, 'dist', rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    }
    execFileSync(process.execPath, [SCRIPT], { cwd: dir, stdio: 'pipe' });
    const out = {};
    for (const rel of Object.keys(files)) {
      out[rel] = readFileSync(path.join(dir, 'dist', rel), 'utf8');
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('injects both robots and googlebot noindex into a bare page', () => {
  const out = run({ 'index.html': '<html><head><title>x</title></head><body>hi</body></html>' });
  assert.match(out['index.html'], /<meta name="robots" content="noindex, nofollow">/);
  assert.match(out['index.html'], /<meta name="googlebot" content="noindex, nofollow">/);
});

test('inserts the tags inside head, not before it', () => {
  const out = run({ 'index.html': '<html><head><title>x</title></head><body></body></html>' });
  const html = out['index.html'];
  assert.ok(html.indexOf('<head>') < html.indexOf('name="robots"'), 'must be after <head>');
  assert.ok(html.indexOf('name="robots"') < html.indexOf('</head>'), 'must be before </head>');
});

test('handles a head tag carrying attributes', () => {
  const out = run({ 'index.html': '<html><head lang="en" data-x="1"><title>x</title></head><body></body></html>' });
  assert.match(out['index.html'], /name="robots"/);
  assert.ok(out['index.html'].indexOf('name="robots"') > out['index.html'].indexOf('data-x="1"'),
    'must insert after the full opening head tag, not inside it');
});

test('is idempotent — a second run does not duplicate the tags', () => {
  const once = run({ 'index.html': '<html><head></head><body></body></html>' })['index.html'];
  const twice = run({ 'index.html': once })['index.html'];
  assert.equal(count(twice, 'name="robots"'), 1);
  assert.equal(count(twice, 'name="googlebot"'), 1);
});

test('adds only the missing tag when a page already declares robots', () => {
  const out = run({
    'index.html': '<html><head><meta name="robots" content="noindex, nofollow"></head><body></body></html>',
  });
  assert.equal(count(out['index.html'], 'name="robots"'), 1);
  assert.equal(count(out['index.html'], 'name="googlebot"'), 1);
});

test('preserves an existing non-default robots directive rather than adding a second', () => {
  const out = run({
    'index.html': '<html><head><meta name="robots" content="noindex, follow"></head><body></body></html>',
  });
  assert.match(out['index.html'], /content="noindex, follow"/);
  assert.equal(count(out['index.html'], 'name="robots"'), 1);
});

test('processes pages in nested directories', () => {
  const out = run({
    'index.html': '<html><head></head><body></body></html>',
    'employee-recognition/index.html': '<html><head></head><body></body></html>',
    'a/b/c/deep.html': '<html><head></head><body></body></html>',
  });
  for (const key of Object.keys(out)) {
    assert.match(out[key], /name="robots"/, `${key} should have been processed`);
  }
});

test('leaves non-HTML files untouched', () => {
  const out = run({
    'index.html': '<html><head></head><body></body></html>',
    'robots.txt': 'User-agent: *\nDisallow: /\n',
    'script.js': '// name="robots" appears here but this is not HTML\n',
  });
  assert.equal(out['robots.txt'], 'User-agent: *\nDisallow: /\n');
  assert.equal(out['script.js'], '// name="robots" appears here but this is not HTML\n');
});

test('leaves a document with no head unchanged rather than corrupting it', () => {
  const input = '<html><body>no head here</body></html>';
  const out = run({ 'index.html': input });
  assert.equal(out['index.html'], input);
});

test('does not disturb surrounding head content', () => {
  const out = run({
    'index.html': '<html><head><title>Keep me</title><link rel="canonical" href="/x"></head><body></body></html>',
  });
  assert.match(out['index.html'], /<title>Keep me<\/title>/);
  assert.match(out['index.html'], /rel="canonical" href="\/x"/);
});
