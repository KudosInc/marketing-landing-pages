/**
 * Emits dataLayer events when a HubSpot form on the page is submitted, so GTM
 * can fire ad-network conversion tags (OpenAI Ads, Google Ads, ...) without any
 * vendor snippet living in this repo.
 *
 * Two events, deliberately separate:
 *
 *   kudos_form_conversion  ONE per person, deduped, for ad tags. A person who
 *                          submits the main form and later the exit-intent form
 *                          is one lead in HubSpot and must be one conversion
 *                          here, or reported cost-per-lead is inflated.
 *   kudos_form_submit      EVERY submission, not deduped, for site analytics.
 *                          Do NOT bind an ad conversion tag to this one.
 *
 * Why a postMessage listener rather than a submit handler: HubSpot's v2 embed
 * ("hs-form-frame") renders each form inside an iframe, so the parent document
 * never sees a submit event. Posting a message to the parent is the only
 * supported completion hook.
 *
 * Why form roles are snapshotted at load rather than looked up on submit: if
 * HubSpot replaces or tears down the .hs-form-frame element as part of showing
 * its thank-you state, a lookup at submit time would find nothing and every
 * event would collapse to 'unknown'. The map is built while the frames are
 * definitely present.
 *
 * Why the role is derived from the DOM at all, rather than from a form-id table:
 * the same HubSpot form id is used in different roles across these pages.
 * b72aaabd-... is the exit-intent form on four pages but is the only, primary
 * form on demo-video, where there is no modal. It is also reused on the organic
 * www.kudos.com/demo/video page, so keying off the id would book organic
 * visitors as ad conversions.
 */
(() => {
  'use strict';

  var CONVERSION_EVENT = 'kudos_form_conversion';
  var SUBMIT_EVENT = 'kudos_form_submit';

  // One key for the whole conversion, not one per form role.
  var STORAGE_KEY = 'kudos:conv:lead';

  // Bounds how far the pixel can drift below the CRM over time: a visitor who
  // converted more than this long ago and converts again counts as a new lead.
  var TTL_DAYS = 90;
  var TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

  var HUBSPOT_ORIGIN = /(^|\.)(hsforms\.(com|net)|hubspot\.com)$/;

  // Fallback when localStorage is unavailable (private mode, disabled storage).
  // Only dedupes within the pageview, which still stops repeated postMessages
  // from double-firing.
  var memoryStore = {};

  // formId -> 'main' | 'exit_intent', captured while the frames exist.
  var roleByFormId = {};

  function isHubSpotOrigin(origin) {
    try {
      return HUBSPOT_ORIGIN.test(new URL(origin).hostname);
    } catch (err) {
      return false;
    }
  }

  function newEventId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        hex += (bytes[i] + 0x100).toString(16).slice(1);
        if (i === 3 || i === 5 || i === 7 || i === 9) hex += '-';
      }
      return hex;
    }
    return 'kudos-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function readRaw(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
    }
  }

  function writeRaw(key, value) {
    memoryStore[key] = value;
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* storage unavailable; the in-memory copy above still applies */
    }
  }

  /** True if this browser already has a conversion recorded and it has not aged out. */
  function alreadyConverted() {
    var raw = readRaw(STORAGE_KEY);
    if (!raw) return false;
    var ts = null;
    try {
      var parsed = JSON.parse(raw);
      ts = parsed && typeof parsed.ts === 'number' ? parsed.ts : null;
    } catch (err) {
      ts = null;
    }
    // No readable timestamp means the record can never age out, so trusting it
    // would silence this browser's conversions permanently. Fail open and let
    // the caller overwrite it with a well-formed record: a rare double-count is
    // recoverable, a lead lost forever is not.
    if (ts === null) return false;
    return Date.now() - ts < TTL_MS;
  }

  /** Record every .hs-form-frame currently in the DOM and the role it plays. */
  function snapshotRoles() {
    var frames;
    try {
      frames = document.querySelectorAll('.hs-form-frame[data-form-id]');
    } catch (err) {
      return;
    }
    for (var i = 0; i < frames.length; i++) {
      var id = frames[i].getAttribute('data-form-id');
      if (!id || Object.prototype.hasOwnProperty.call(roleByFormId, id)) continue;
      roleByFormId[id] = frames[i].closest('.exit-intent-modal') ? 'exit_intent' : 'main';
    }
  }

  function roleFor(formId) {
    if (!formId) return 'unknown';
    if (Object.prototype.hasOwnProperty.call(roleByFormId, formId)) return roleByFormId[formId];
    // Re-scan in case the form was added after the last snapshot.
    snapshotRoles();
    return Object.prototype.hasOwnProperty.call(roleByFormId, formId)
      ? roleByFormId[formId]
      : 'unknown';
  }

  function push(payload) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
  }

  snapshotRoles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', snapshotRoles);
  }

  window.addEventListener('message', function (event) {
    if (!isHubSpotOrigin(event.origin)) return;

    var payload = event.data;
    if (!payload || typeof payload !== 'object') return;
    if (payload.type !== 'hsFormCallback') return;
    if (payload.eventName !== 'onFormSubmitted') return;

    var formId = payload.id || (payload.data && payload.data.formGuid) || '';
    var formLocation = roleFor(formId);

    // Always emitted, never deduped — site analytics only.
    push({
      event: SUBMIT_EVENT,
      form_location: formLocation,
      hubspot_form_id: formId,
      page_path: window.location.pathname
    });

    if (alreadyConverted()) return;

    var eventId = newEventId();
    writeRaw(STORAGE_KEY, JSON.stringify({ id: eventId, ts: Date.now() }));

    push({
      event: CONVERSION_EVENT,
      form_location: formLocation, // 'main' | 'exit_intent' | 'unknown'
      hubspot_form_id: formId,
      // Pass to the ad network as its deduplication key so a retry, a second
      // device, or a later Conversions API call does not double-count.
      conversion_event_id: eventId,
      page_path: window.location.pathname
    });
  });
})();
