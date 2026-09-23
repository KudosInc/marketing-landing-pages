import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(path.join(root, 'public/scripts/mobile-form-cta.js'), 'utf8');

function makePage() {
  const inlineCta = {};
  const form = {};
  const classes = new Set();
  const observed = [];
  let onIntersection;

  const stickyCta = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };

  class IntersectionObserver {
    constructor(callback) { onIntersection = callback; }
    observe(element) { observed.push(element); }
  }

  const document = {
    querySelector(selector) {
      if (selector === '[data-mobile-form-cta]') return inlineCta;
      if (selector === '[data-mobile-form-sticky]') return stickyCta;
      return null;
    },
    getElementById(id) { return id === 'top-form' ? form : null; },
  };

  vm.runInNewContext(script, { document, window: { IntersectionObserver }, IntersectionObserver });

  return {
    inlineCta,
    form,
    observed,
    isStickyVisible: () => classes.has('is-visible'),
    intersect(target, isIntersecting) { onIntersection([{ target, isIntersecting }]); },
  };
}

test('sticky CTA appears after the hero CTA leaves the viewport', () => {
  const page = makePage();
  assert.deepEqual(page.observed, [page.inlineCta, page.form]);
  assert.equal(page.isStickyVisible(), false);

  page.intersect(page.inlineCta, false);
  assert.equal(page.isStickyVisible(), true);
});

test('sticky CTA hides while the form or hero CTA is visible', () => {
  const page = makePage();
  page.intersect(page.inlineCta, false);
  page.intersect(page.form, true);
  assert.equal(page.isStickyVisible(), false);

  page.intersect(page.form, false);
  assert.equal(page.isStickyVisible(), true);

  page.intersect(page.inlineCta, true);
  assert.equal(page.isStickyVisible(), false);
});
