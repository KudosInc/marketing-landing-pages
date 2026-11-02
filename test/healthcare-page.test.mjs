import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const route = readFileSync(path.join(root, 'src/pages/OA/healthcare-recognition.astro'), 'utf8');
const component = readFileSync(path.join(root, 'src/components/EmployeeRecognitionPage.astro'), 'utf8');
const chart = readFileSync(path.join(root, 'src/components/AnalyticsChart.astro'), 'utf8');
const integrations = readFileSync(path.join(root, 'src/components/IntegrationsSection.astro'), 'utf8');

test('healthcare OA route shares the OA form, GTM, and consent-managed page', () => {
  assert.match(route, /EmployeeRecognitionPage isHealthcare mainFormId="431c296a-48d1-4dbe-b8d2-968b1c3c6f9a" hideHeaderActions/);
  assert.match(component, /GTM-5TVQWJXG/);
  assert.match(component, /data-form-role="main"/);
  assert.match(component, /js\.hsforms\.net\/forms\/embed\/21201461\.js/);
});

test('healthcare ad promises have matching sections and outstanding approvals are visible', () => {
  for (const phrase of [
    'Recognition That Reaches Every Shift',
    'Recognition built for care teams',
    'Peer-to-peer, manager-to-employee, nomination-based, eCards and milestone recognition in one platform. Kudos provides everything you need to run an effective recognition program in your healthcare facilities.',
    'Rewards that fit a hospital budget',
    'Secure by design',
    'Kudos is SOC 2 Type II and ISO27001:2022 certified to give your IT and compliance teams peace-of-mind.',
    'Discover the power of Kudos – and why healthcare organizations',
    'Results across Kudos customers',
  ]) assert.ok(component.includes(phrase), `missing: ${phrase}`);
  assert.doesNotMatch(component, /\[TODO:/);
});

test('first healthcare testimonial uses the supplied quote in the existing card style', () => {
  assert.match(component, /<div class="testimonial-card">[\s\S]*?\{isHealthcare \? \(/);
  assert.match(component, /<p class="testimonial-text">Kudos is game-changer for recognition and engaging new workforce entrants\.<\/p>/);
  assert.match(component, /<p class="testimonial-author">Charla Garcia<\/p>/);
  assert.match(component, /<p class="testimonial-role">Chief Human Resource Officer,<br>Uvalde Memorial Health<\/p>/);
  assert.match(component, /<p class="testimonial-author">Kenneth C\. Euverman<\/p>/);
  assert.doesNotMatch(component, /\[TODO: Supply and approve a named healthcare client testimonial/);
});

test('second healthcare testimonial uses Jessica Thompson while other pages keep their quote', () => {
  assert.match(component, /<p class="testimonial-text">Kudos makes it easy to show recognition in such a way that over time, we have built a culture of appreciation and recognition that, at the end of the day, makes everyone feel a little better and a little happier<\/p>/);
  assert.match(component, /<p class="testimonial-author">Jessica Thompson<\/p>/);
  assert.match(component, /<p class="testimonial-role">Manager, Recruitment &amp; Engagement,<br>NeoGenomics<\/p>/);
  assert.match(component, /<p class="testimonial-author">Marina Fontan<\/p>/);
});

test('healthcare logos include the supplied organizations once, after MU Health Care', () => {
  const logoSection = component.slice(component.indexOf('<div class="logos-row healthcare-logos-row">'), component.indexOf('</div>\n        </>', component.indexOf('<div class="logos-row healthcare-logos-row">')));
  const names = ['MU Health Care', 'Uvalde Memorial Hospital', 'Rocky Mountain Health Care Services', 'NEO Genomics', 'Blood Cancer United'];
  let lastPosition = -1;
  for (const name of names) {
    const position = logoSection.indexOf(`alt="${name}"`);
    assert.ok(position > lastPosition, `${name} is missing or out of order`);
    lastPosition = position;
  }
  assert.equal((logoSection.match(/alt="Rocky Mountain Health Care Services"/g) || []).length, 1);
  assert.match(logoSection, /src="\/images\/neogenomics-colour\.svg"/);
  assert.doesNotMatch(component, /\[TODO: Confirm MU Health Care logo-use approval/);
});

test('healthcare page reuses the analytics, integrations, and testimonial treatments', () => {
  assert.match(component, /<AnalyticsChart healthcare \/>/);
  assert.match(chart, /Safety Huddle Rollout/);
  assert.match(chart, /Unit Staffing Shortage/);
  assert.doesNotMatch(chart, /Shift Schedule Change/);
  assert.match(chart, /width=\{healthcare \? "176" : "138"\}/);
  assert.doesNotMatch(component, /Illustrative chart showing how workplace events can affect team measures\./);
  assert.match(component, /<IntegrationsSection \/>/);
  assert.match(integrations, /Recognition that works where your team already works/);
  assert.match(component, /<IntegrationsSection \/>\s*<section class="feature-row">[\s\S]*?<div class="healthcare-security-badges"[\s\S]*?<h3>Secure by design<\/h3>/);
  assert.equal((component.match(/class="testimonial-card"/g) || []).length, 2);
  assert.ok(component.indexOf('Discover the power of Kudos – and why healthcare organizations') < component.indexOf('<!-- Testimonials -->'));
  assert.equal((component.match(/cdn\.prod\.website-files\.com\/61832088cc97eb7451c81c32\/[^" ]+\.webp" alt=/g) || []).length, 4);
});

test('healthcare copy avoids restricted topics', () => {
  const healthcareCopy = component.slice(component.indexOf('{isHealthcare ? (', component.indexOf('<!-- By The Numbers -->')),
    component.indexOf(') : !isThankYou && ('));
  for (const word of ['burnout', 'mental health', 'wellbeing crisis', 'HIPAA']) {
    assert.equal(healthcareCopy.toLowerCase().includes(word.toLowerCase()), false, `restricted term: ${word}`);
  }
});
