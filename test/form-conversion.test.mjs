/**
 * Tests for public/scripts/form-conversion.js.
 *
 * The script is a browser IIFE with no module boundary, so it is evaluated in a
 * vm context against a minimal fake window/document rather than imported. That
 * keeps the shipped file free of test scaffolding.
 *
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(ROOT, 'public/scripts/form-conversion.js'), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const HS_ORIGIN = 'https://forms-na1.hsforms.com';

/** A Date stand-in pinned to a fixed now, so TTL boundaries are testable. */
function pinnedDate(now) {
  const D = function (...args) { return args.length ? new Date(...args) : new Date(now); };
  D.now = () => now;
  D.prototype = Date.prototype;
  return D;
}

/**
 * Build a fake page and evaluate the script against it.
 *
 * @param frames  { [formId]: isInsideExitIntentModal }
 * @param opts    { storageWorks, seedStorage, now }
 */
function makeEnv(frames, opts = {}) {
  const { storageWorks = true, seedStorage = null, now = null } = opts;
  const store = new Map();
  if (seedStorage !== null) store.set('kudos:conv:lead', seedStorage);

  const messageHandlers = [];
  let liveFrames = { ...frames }; // mutable, so a test can simulate teardown

  const win = {
    crypto: globalThis.crypto,
    location: { pathname: '/employee-recognition', search: '' },
    addEventListener(type, fn) { if (type === 'message') messageHandlers.push(fn); },
    localStorage: storageWorks
      ? {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
      }
      : {
        getItem() { throw new Error('storage denied'); },
        setItem() { throw new Error('storage denied'); },
      },
  };
  win.window = win;

  const doc = {
    readyState: 'complete',
    addEventListener() {},
    querySelectorAll: () =>
      Object.entries(liveFrames).map(([id, inModal]) => ({
        getAttribute: name => (name === 'data-form-id' ? id : null),
        closest: sel => (sel === '.exit-intent-modal' && inModal ? {} : null),
      })),
    querySelector: () => null,
  };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    URL,
    console,
    Date: now === null ? Date : pinnedDate(now),
  });
  vm.runInContext(SRC, ctx);

  return {
    win,
    store,
    /** Deliver a postMessage to the script's listener. */
    fire(msg) { messageHandlers.forEach(h => h(msg)); },
    /** Simulate HubSpot replacing the form frame on submit. */
    removeFrames() { liveFrames = {}; },
    // Spread into a host-realm array first: dataLayer is constructed inside the
    // vm context, so its prototype differs and deepStrictEqual would reject
    // structurally identical values.
    conversions: () => [...(win.dataLayer || [])].filter(e => e.event === 'kudos_form_conversion'),
    submits: () => [...(win.dataLayer || [])].filter(e => e.event === 'kudos_form_submit'),
  };
}

const submitted = (id, origin = HS_ORIGIN) => ({
  origin,
  data: { type: 'hsFormCallback', eventName: 'onFormSubmitted', id },
});

// --- form role labelling ----------------------------------------------------

test('labels the exit-intent modal form', () => {
  const env = makeEnv({ b72aaabd: true, '752783ec': false });
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 1);
  assert.equal(env.conversions()[0].form_location, 'exit_intent');
  assert.match(env.conversions()[0].conversion_event_id, /^[0-9a-f-]{36}$/);
});

test('labels the in-page form', () => {
  const env = makeEnv({ b72aaabd: true, '752783ec': false });
  env.fire(submitted('752783ec'));
  assert.equal(env.conversions()[0].form_location, 'main');
});

test('same form id on a page with no modal is main, not exit_intent', () => {
  // demo-video reuses the modal form id as its only, primary form.
  const env = makeEnv({ b72aaabd: false });
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions()[0].form_location, 'main');
});

test('role survives HubSpot removing the frame before the callback arrives', () => {
  const env = makeEnv({ b72aaabd: true });
  env.removeFrames();
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions()[0].form_location, 'exit_intent');
});

test('a form id never present in the DOM is reported as unknown', () => {
  const env = makeEnv({});
  env.fire(submitted('late-form'));
  assert.equal(env.conversions()[0].form_location, 'unknown');
});

// --- one conversion per person ----------------------------------------------

test('main then modal counts ONE conversion, not two', () => {
  const env = makeEnv({ b72aaabd: true, '752783ec': false });
  env.fire(submitted('752783ec'));
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 1);
  assert.equal(env.conversions()[0].form_location, 'main', 'keeps whichever fired first');
});

test('both submissions still appear on the analytics event', () => {
  const env = makeEnv({ b72aaabd: true, '752783ec': false });
  env.fire(submitted('752783ec'));
  env.fire(submitted('b72aaabd'));
  assert.deepEqual(env.submits().map(e => e.form_location), ['main', 'exit_intent']);
});

test('the analytics event carries no conversion_event_id', () => {
  const env = makeEnv({ b72aaabd: true });
  env.fire(submitted('b72aaabd'));
  assert.equal(env.submits()[0].conversion_event_id, undefined);
});

test('resubmitting the same form does not double-count', () => {
  const env = makeEnv({ b72aaabd: true });
  env.fire(submitted('b72aaabd'));
  env.fire(submitted('b72aaabd'));
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 1);
});

test('unknown does not get its own dedupe bucket', () => {
  const env = makeEnv({ '752783ec': false });
  env.fire(submitted('752783ec'));
  env.fire(submitted('some-form-not-in-dom'));
  assert.equal(env.conversions().length, 1);
});

// --- 90-day TTL -------------------------------------------------------------

test('a conversion inside the TTL is suppressed', () => {
  const now = 1_800_000_000_000;
  const env = makeEnv({ b72aaabd: true }, {
    now,
    seedStorage: JSON.stringify({ id: 'previous', ts: now - 30 * DAY }),
  });
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 0);
});

test('a conversion past the TTL counts again as a new lead', () => {
  const now = 1_800_000_000_000;
  const env = makeEnv({ b72aaabd: true }, {
    now,
    seedStorage: JSON.stringify({ id: 'previous', ts: now - 120 * DAY }),
  });
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 1);
});

test('the stored record holds the event id and a timestamp', () => {
  const now = 1_800_000_000_000;
  const env = makeEnv({ b72aaabd: true }, { now });
  env.fire(submitted('b72aaabd'));
  const saved = JSON.parse(env.store.get('kudos:conv:lead'));
  assert.equal(saved.ts, now);
  assert.equal(saved.id, env.conversions()[0].conversion_event_id);
});

test('a corrupt stored record fails open and self-heals', () => {
  // A record with no readable timestamp can never age out, so trusting it would
  // silence this browser permanently. Count the conversion and replace the bad
  // record with a well-formed one.
  const now = 1_800_000_000_000;
  const env = makeEnv({ b72aaabd: true }, { now, seedStorage: 'not json' });
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 1);
  const healed = JSON.parse(env.store.get('kudos:conv:lead'));
  assert.equal(healed.ts, now);
  assert.equal(healed.id, env.conversions()[0].conversion_event_id);
});

test('a record missing only the timestamp also fails open', () => {
  const env = makeEnv({ b72aaabd: true }, { seedStorage: JSON.stringify({ id: 'x' }) });
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 1);
});

test('a healed record then dedupes normally', () => {
  const now = 1_800_000_000_000;
  const env = makeEnv({ b72aaabd: true, '752783ec': false }, { now, seedStorage: 'not json' });
  env.fire(submitted('b72aaabd'));
  env.fire(submitted('752783ec'));
  assert.equal(env.conversions().length, 1, 'the rewritten record must suppress the next one');
});

// --- origin trust -----------------------------------------------------------

test('ignores a message from a non-HubSpot origin', () => {
  const env = makeEnv({ b72aaabd: true });
  env.fire(submitted('b72aaabd', 'https://evil.example.com'));
  assert.equal(env.win.dataLayer, undefined);
});

test('ignores a lookalike origin such as hsforms.com.evil.com', () => {
  const env = makeEnv({ b72aaabd: true });
  env.fire(submitted('b72aaabd', 'https://hsforms.com.evil.com'));
  assert.equal(env.win.dataLayer, undefined);
});

// --- message filtering ------------------------------------------------------

test('the pre-submit onFormSubmit event does not convert', () => {
  const env = makeEnv({ b72aaabd: true });
  env.fire({
    origin: HS_ORIGIN,
    data: { type: 'hsFormCallback', eventName: 'onFormSubmit', id: 'b72aaabd' },
  });
  assert.equal(env.win.dataLayer, undefined);
});

test('ignores unrelated postMessage traffic', () => {
  const env = makeEnv({ b72aaabd: true });
  env.fire({ origin: HS_ORIGIN, data: 'just a string' });
  env.fire({ origin: HS_ORIGIN, data: null });
  env.fire({ origin: HS_ORIGIN, data: { type: 'somethingElse' } });
  assert.equal(env.win.dataLayer, undefined);
});

// --- environment resilience -------------------------------------------------

test('falls back to per-pageview dedupe when localStorage throws', () => {
  const env = makeEnv({ b72aaabd: true, '752783ec': false }, { storageWorks: false });
  env.fire(submitted('752783ec'));
  env.fire(submitted('b72aaabd'));
  assert.equal(env.conversions().length, 1);
});

test('appends to an existing dataLayer rather than replacing it', () => {
  const env = makeEnv({ b72aaabd: true });
  env.win.dataLayer = [{ event: 'gtm.js' }];
  env.fire(submitted('b72aaabd'));
  assert.equal(env.win.dataLayer[0].event, 'gtm.js');
  assert.equal(env.conversions().length, 1);
});
