/**
 * Emits a dataLayer event when a HubSpot form on the page is submitted, so GTM
 * can fire ad-network conversion tags (OpenAI Ads, Google Ads, ...) without any
 * vendor snippet living in this repo.
 *
 * Why a postMessage listener rather than a submit handler: HubSpot's v2 embed
 * ("hs-form-frame") renders each form inside an iframe, so the parent document
 * never sees a submit event. Posting a message to the parent is the only
 * supported completion hook.
 *
 * Why the form label is derived from the DOM rather than a form-id lookup table:
 * the same HubSpot form id is reused in different roles across these pages.
 * b72aaabd-... is the exit-intent form on four pages but is the only, primary
 * form on demo-video, where there is no modal at all. Asking the DOM whether the
 * frame sits inside .exit-intent-modal gets that right on every page and needs
 * no maintenance when forms are added.
 */
(() => {
  'use strict';

  var EVENT_NAME = 'kudos_form_conversion';
  var STORAGE_PREFIX = 'kudos:conv:';
  var HUBSPOT_ORIGIN = /(^|\.)(hsforms\.(com|net)|hubspot\.com)$/;

  // Fallback when localStorage is unavailable (private mode, disabled storage).
  // Only dedupes within the pageview, which is still better than double-firing.
  var firedThisPageview = {};

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

  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return firedThisPageview[key] || null;
    }
  }

  function writeStored(key, value) {
    firedThisPageview[key] = value;
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* storage unavailable; in-memory dedupe above still applies */
    }
  }

  /** 'exit_intent' if the form's frame is inside the exit-intent modal, else 'main'. */
  function locationForForm(formId) {
    if (!formId) return 'unknown';
    var frame = null;
    try {
      frame = document.querySelector('.hs-form-frame[data-form-id="' + String(formId).replace(/"/g, '\\"') + '"]');
    } catch (err) {
      frame = null;
    }
    if (!frame) return 'unknown';
    return frame.closest('.exit-intent-modal') ? 'exit_intent' : 'main';
  }

  window.addEventListener('message', function (event) {
    if (!isHubSpotOrigin(event.origin)) return;

    var payload = event.data;
    if (!payload || typeof payload !== 'object') return;
    if (payload.type !== 'hsFormCallback') return;
    if (payload.eventName !== 'onFormSubmitted') return;

    var formId = payload.id || (payload.data && payload.data.formGuid) || '';
    var formLocation = locationForForm(formId);

    // One conversion per person per form role. A returning visitor who submits
    // again is the same lead, so it should not be counted twice.
    var storageKey = STORAGE_PREFIX + formLocation;
    var existing = readStored(storageKey);
    if (existing) return;

    var eventId = newEventId();
    writeStored(storageKey, eventId);

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: EVENT_NAME,
      form_location: formLocation, // 'main' | 'exit_intent' | 'unknown'
      hubspot_form_id: formId,
      // Pass to the ad network as its deduplication key so a retry or a second
      // device does not create a duplicate conversion.
      conversion_event_id: eventId,
      page_path: window.location.pathname
    });
  });
})();
