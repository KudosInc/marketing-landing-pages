/**
 * Tests for public/robots.txt.
 *
 * These exist because a blanket "User-agent: * / Disallow: /" on this domain
 * blocked OAI-AdsBot, which meant ChatGPT ad landing pages failed validation and
 * the ads did not serve. The failure was invisible from the site itself. These
 * assertions encode the policy so an edit cannot quietly reintroduce it.
 *
 * Implements RFC 9309 plus Google's wildcard extensions: most-specific matching
 * user-agent group wins, '*' matches any sequence, a trailing '$' anchors the
 * end of the URL, the longest matching pattern wins, and Allow beats Disallow on
 * an equal-length tie.
 *
 * Deliberately NOT using anything like Python's urllib.robotparser, which drops
 * the query string from rule paths and percent-encodes '*' and '$'.
 *
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = readFileSync(path.join(ROOT, 'public/robots.txt'), 'utf8');

const VALID_TOKEN = /^(\*|[A-Za-z0-9_-]+)$/;

/** -> { groups: Map<token, Array<{kind, pattern}>>, malformed: Array<{line, value}> } */
function parse(text) {
  const groups = new Map();
  const malformed = [];
  let pending = [];
  let inRules = false;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.split('#')[0].trim();
    if (!line || !line.includes(':')) return;
    const idx = line.indexOf(':');
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (inRules) { pending = []; inRules = false; }
      if (!VALID_TOKEN.test(value)) malformed.push({ line: i + 1, value });
      const token = value.toLowerCase();
      pending.push(token);
      if (!groups.has(token)) groups.set(token, []);
    } else if (field === 'allow' || field === 'disallow') {
      inRules = true;
      for (const token of pending) groups.get(token).push({ kind: field, pattern: value });
    }
  });

  return { groups, malformed };
}

function patternToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '$' && i === pattern.length - 1) out += '$';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out);
}

/** Most specific group for a crawler's product token, else the '*' group. */
function groupFor(groups, productToken) {
  const token = productToken.split('/')[0].trim().toLowerCase();
  let best = null;
  for (const name of groups.keys()) {
    if (name === '*') continue;
    if (token === name || token.startsWith(name)) {
      if (best === null || name.length > best.length) best = name;
    }
  }
  return best ?? (groups.has('*') ? '*' : null);
}

function canFetch(groups, productToken, url) {
  const name = groupFor(groups, productToken);
  if (name === null) return true;
  const { pathname, search } = new URL(url);
  const target = (pathname || '/') + search;

  let winner = null;
  for (const { kind, pattern } of groups.get(name)) {
    if (!pattern) continue; // "Disallow:" with no value means allow everything
    if (!patternToRegex(pattern).test(target)) continue;
    if (
      winner === null ||
      pattern.length > winner.pattern.length ||
      (pattern.length === winner.pattern.length && kind === 'allow')
    ) {
      winner = { kind, pattern };
    }
  }
  return winner === null ? true : winner.kind === 'allow';
}

const { groups, malformed } = parse(TEXT);
const BASE = 'https://get.kudos.com';

// --- file hygiene -----------------------------------------------------------

test('every user-agent value is a bare product token', () => {
  // www.kudos.com shipped "User-agent: ; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  // a pasted user-agent string, which silently matched no crawler at all.
  assert.deepEqual(malformed, [], `malformed user-agent lines: ${JSON.stringify(malformed)}`);
});

// --- ad-network crawlers must be able to fetch -------------------------------

const AD_CRAWLERS = ['OAI-AdsBot/1.0', 'AdsBot-Google', 'AdsBot-Google-Mobile', 'adidxbot'];

for (const ua of AD_CRAWLERS) {
  test(`${ua} may fetch landing pages`, () => {
    for (const url of [
      `${BASE}/`,
      `${BASE}/employee-recognition`,
      `${BASE}/demo-video`,
      // Ad landing pages are reached with tracking parameters attached.
      `${BASE}/employee-recognition?utm_source=chatgpt&utm_medium=paid`,
      `${BASE}/employee-recognition?gclid=abc123`,
    ]) {
      assert.equal(canFetch(groups, ua, url), true, `${ua} must be allowed to fetch ${url}`);
    }
  });
}

test('OAI-AdsBot has its own named group, not just an effective allow', () => {
  // Guards against the group being deleted while some broader rule happens to
  // permit it: OpenAI's crawler needs an explicit, durable exemption.
  assert.ok(groups.has('oai-adsbot'), 'expected a named OAI-AdsBot group');
});

// --- everything else stays out ----------------------------------------------

test('organic search crawlers are kept off the paid pages', () => {
  for (const ua of ['Googlebot', 'bingbot', 'DuckDuckBot']) {
    assert.equal(canFetch(groups, ua, `${BASE}/employee-recognition`), false,
      `${ua} should not crawl paid landing pages`);
  }
});

test('AI training and AI search crawlers are kept out', () => {
  // Deliberate: these thin single-CTA pages should not represent the brand in
  // ChatGPT answers, and www.kudos.com is the organic surface.
  for (const ua of ['GPTBot', 'OAI-SearchBot/1.0', 'CCBot', 'ClaudeBot']) {
    assert.equal(canFetch(groups, ua, `${BASE}/employee-recognition`), false,
      `${ua} should be blocked`);
  }
});

test('an unrecognised crawler falls through to the wildcard disallow', () => {
  assert.equal(canFetch(groups, 'SomeRandomCrawler/2.0', `${BASE}/employee-recognition`), false);
});

test('the wildcard group still disallows everything', () => {
  const wildcard = groups.get('*');
  assert.ok(wildcard, 'expected a User-agent: * group');
  assert.ok(
    wildcard.some(r => r.kind === 'disallow' && r.pattern === '/'),
    'expected "Disallow: /" in the wildcard group'
  );
});
