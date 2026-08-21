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
 * Why both 'onFormSubmit' and 'onFormSubmitted' are accepted: both HubSpot forms
 * used on these pages are configured to redirect off-site on submit rather than
 * to show an inline thank-you, so the parent document is torn down by a
 * top-level navigation and the completion callback never runs — a live test
 * measured zero conversions from the main form. 'onFormSubmit' fires on the submit action, before the navigation, so it
 * beats the race. A form with an inline thank-you posts both; the per-person
 * dedupe below suppresses the second, so either configuration yields exactly one
 * conversion without this file needing to know which is which.
 *
 * The accepted cost: 'onFormSubmit' fires on submit *attempt*, so submissions
 * rejected downstream (server-side validation, reCAPTCHA) are counted. Spend is
 * gated on CRM counts, and the reconciliation makes that gap visible.
 *
 * Why the role comes from an explicit data-form-role attribute rather than from
 * a form-id table or from the DOM shape:
 *
 *   - A form-id table would be wrong. The same HubSpot form id serves different
 *     roles: b72aaabd-... is the exit-intent form on four pages, the primary
 *     form on demo-video, and is also reused on the organic
 *     www.kudos.com/demo/video page, so keying off the id would book organic
 *     visitors as ad conversions.
 *   - Inferring it from the DOM was also wrong, and shipped briefly. Checking
 *     whether the frame sits inside .exit-intent-modal looks right but that is a
 *     *styling* class: demo-video reuses it for a modal opened by clicking the
 *     hero CTA, which is an intentional primary conversion, not an abandonment
 *     rescue. The other four pages open theirs on mouseout. Same markup, oppo-
 *     site meaning, so the label has to be declared rather than deduced.
 *
 * Why roles are snapshotted at load rather than read on submit: if HubSpot
 * replaces or tears down the .hs-form-frame element while rendering its
 * thank-you state, a lookup at submit time would find nothing and every event
 * would collapse to 'unknown'. The map is built while the frames are present.
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

  // formId -> true once an 'onFormSubmit' has been seen for it in this pageview.
  // The conversion event is deduped per person, but SUBMIT_EVENT deliberately is
  // not, so without this an inline-thank-you form (which posts both callbacks for
  // one submission) would report two submissions while a redirect form reports
  // one. Suppression only runs in the submit -> submitted direction, so a form
  // that posts only 'onFormSubmitted' is unaffected.
  var submitSeenByFormId = {};

  // Temporary diagnostic. Every live payload verified so far has been
  // 'onFormSubmitted'; where 'onFormSubmit' carries the form id is unconfirmed,
  // and if it carries it somewhere unexpected the conversion still fires but
  // form_location collapses to 'unknown'. Logged once per pageview.
  var loggedSubmitPayload = false;

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

  /** Record every .hs-form-frame currently in the DOM and the role it declares. */
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
      var role = frames[i].getAttribute('data-form-role');
      // Only trust roles the markup declares. An unannotated form reports as
      // 'unknown' rather than being guessed at, so it shows up in reporting
      // instead of quietly landing in the wrong bucket.
      roleByFormId[id] = (role === 'main' || role === 'exit_intent') ? role : 'unknown';
    }
  }

  /**
   * The form id, across callback payload shapes. 'onFormSubmitted' carries it as
   * `id` with `data.formGuid` as a backup. The 'onFormSubmit' payload is less
   * documented and its `data` is a field-value array rather than an object, so
   * the extra top-level fallbacks are cheap insurance. A miss degrades
   * gracefully: the conversion still fires, only the main/exit_intent split is
   * lost.
   */
  function formIdFrom(payload) {
    var data = payload.data;
    var fromData = (data && typeof data === 'object' && !Array.isArray(data))
      ? (data.formGuid || data.formId || data.id)
      : null;
    return payload.id || payload.formGuid || payload.formId || fromData || '';
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

    var eventName = payload.eventName;
    if (eventName !== 'onFormSubmitted' && eventName !== 'onFormSubmit') return;

    if (eventName === 'onFormSubmit' && !loggedSubmitPayload) {
      loggedSubmitPayload = true;
      try {
        console.log('[kudos] raw onFormSubmit payload', payload);
      } catch (err) {
        /* no console available; the diagnostic is optional */
      }
    }

    var formId = formIdFrom(payload);

    if (formId) {
      if (eventName === 'onFormSubmit') {
        submitSeenByFormId[formId] = true;
      } else if (Object.prototype.hasOwnProperty.call(submitSeenByFormId, formId)) {
        // The 'onFormSubmit' half of this submission already reported it, and
        // already ran (or was suppressed by) the conversion path.
        return;
      }
    }

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
