# OpenAI Ads conversion tracking

The repo emits a `dataLayer` event on HubSpot form submission. The `oaiq` pixel
itself lives in GTM (`GTM-5TVQWJXG`), so the pixel ID is not in this repo and
changing it does not need a deploy.

Repo side: `public/scripts/form-conversion.js`, loaded by the six pages that
have a form. GTM side: one variable set, one trigger, one tag — described below,
still to be configured.

## Current state

The **base pixel is already installed** in GTM and working. Verified in a browser
on `get.kudos.com/employee-recognition`: the real SDK has replaced the bootstrap
stub, `__oaiqInitialized` is set, `oaiq.measure` exists, the pixel config for
`MsAB1QbnRbM5VdNGc4wpTZ` is fetched, and `bzr.openai.com/v1/sdk/events` is
already being hit (the SDK's automatic `page_viewed`). Nothing in this repo
references `oaiq`, so GTM is injecting it.

What is missing is only the **conversion** event — nothing anywhere calls
`oaiq("measure", …)`. That is what the work below adds.

Note when diagnosing this: an empty `window.oaiq.q` is what a *drained* queue
looks like after the SDK loads, not proof that `init` never ran. Check for
`__oaiqInitialized` and the real methods (`measure`, `consent`) instead.

## What the page sends

Two events, deliberately separate. **Bind ad conversion tags to
`kudos_form_conversion` only.**

```js
// ONE per person, deduped. For ad tags.
window.dataLayer.push({
  event: 'kudos_form_conversion',
  form_location: 'main',            // 'main' | 'exit_intent' | 'unknown'
  hubspot_form_id: '752783ec-...',
  conversion_event_id: '9f8c...',   // UUID, use as the pixel's event_id
  page_path: '/employee-recognition'
});

// EVERY submission, not deduped. Site analytics only — no ad tag on this one.
window.dataLayer.push({
  event: 'kudos_form_submit',
  form_location: 'exit_intent',
  hubspot_form_id: 'b72aaabd-...',
  page_path: '/employee-recognition'
});
```

The split exists because the two consumers want different things. Ad platforms
need one conversion per lead or cost-per-lead is understated; site analytics
wants every submission so per-form counts stay accurate. Sending one event for
both would force a choice between an inflated conversion count and a lossy
analytics count.

### `form_location`

`main` is the in-page form, `exit_intent` is the form in the exit-intent modal.

The label is derived from the DOM rather than from a form-id lookup table,
because **the same HubSpot form id is used in different roles across these
pages**: `b72aaabd-...` is the exit-intent form on four pages but is the only,
primary form on `demo-video`, which has no modal. It is also reused on the
organic `www.kudos.com/demo/video` page. A lookup table would report
demo-video's main conversion as `exit_intent`, and matching on the id alone
would book organic visitors as ad conversions.

The map is **snapshotted at page load**, not looked up when the callback
arrives. If HubSpot replaces or removes the `.hs-form-frame` element as part of
rendering its thank-you state, a lookup at submit time would find nothing and
every event would collapse to `unknown`. Snapshotting sidesteps that ordering
question entirely.

`unknown` means a callback arrived for a form id that was never in the DOM. It
is reported rather than dropped so it surfaces in reporting instead of silently
vanishing. Seeing it in production means a form was added without the frame
markup this script looks for.

### `conversion_event_id`

A fresh UUID per counted conversion, on the conversion event only. Pass it as
the pixel's `event_id` so a retry, a second device, or a later Conversions API
call for the same submission dedupes instead of double-counting.

### Deduplication behaviour

**One conversion per person**, not one per form. A single `localStorage` key,
`kudos:conv:lead`, holds the event id and a timestamp. Someone who submits the
main form and later the exit-intent form is one contact in HubSpot, so they are
one conversion here; `form_location` records whichever fired first. Counting per
form role would have produced a 2× overcount on exactly the metric spend
decisions are gated on.

The key carries a **90-day TTL**. Without one, a visitor who converted once
never counts again and the pixel drifts progressively below the CRM over
quarters with no way to explain the gap. With it, the divergence is bounded and
a visitor returning after 90 days is treated as a new lead. Change `TTL_DAYS` in
the script to adjust.

If `localStorage` is unavailable (private mode), dedupe falls back to
per-pageview, which still stops HubSpot's repeated messages from double-firing.

### Known undercount: consent gating

Cookiebot is live on these pages. If the GTM conversion tag is gated on the
marketing consent category, conversions will not fire for visitors who choose
"necessary only", and the pixel will sit below HubSpot's count by that share of
traffic. That is expected behaviour, not a broken tag — check the tag's consent
settings in GTM before investigating a gap.

## GTM configuration (to do)

**1. Data Layer Variables** — create one for each field you want on the tag:

| Variable name | Data layer variable name |
| --- | --- |
| `DLV - form_location` | `form_location` |
| `DLV - conversion_event_id` | `conversion_event_id` |
| `DLV - hubspot_form_id` | `hubspot_form_id` |

**2. Trigger** — Custom Event, event name `kudos_form_conversion`, fires on all
occurrences. Do **not** add a `form_location` condition: both form roles should
count, because a lead is a lead whichever form produced it, and restricting to
`exit_intent` would make platform conversions systematically lower than
HubSpot's. `form_location` rides along as metadata for segmentation instead.

Do not build a trigger on the HubSpot form GUID. `b72aaabd-…` is the modal form
on four pages, the *only* form on `demo-video`, and is also reused on the organic
`www.kudos.com/demo/video` page — matching on it would book organic visitors as
ad conversions.

**3. Base pixel tag** — already installed and firing; nothing to do. See
"Current state" above.

**4. Conversion tag** — Custom HTML, trigger `kudos_form_conversion`. The `oaiq`
command queue buffers calls made before the SDK finishes loading, so no tag
sequencing is needed:

```html
<script>
  oaiq("measure", "lead_created", {
    type: "lead",
    form_location: {{DLV - form_location}}
  }, {
    event_id: {{DLV - conversion_event_id}}
  });
</script>
```

`lead_created` is the standard OpenAI event matching a demo-request form. The
full standard list is `page_viewed`, `contents_viewed`, `items_added`,
`checkout_started`, `order_created`, `lead_created`, `registration_completed`,
`appointment_scheduled`, `subscription_created`, `trial_started`, plus `custom`.

## Verifying

1. GTM Preview mode, load a landing page, submit the form.
2. `kudos_form_conversion` should appear in the event stream with all four
   fields populated and `form_location` matching where you submitted.
3. Submit the same form again in the same browser — no second event. Clear
   `localStorage` (keys `kudos:conv:*`) to reset while testing.
4. In Ads Manager: **Event Stream → Start polling**, then submit the form. Expect
   a `lead_created` row within about a minute.

Campaign-level reporting lags 24–48h, so don't judge whether this works from the
campaign view on day one — use Event Stream for the immediate signal.

## Related

`get.kudos.com/robots.txt` must allow `OAI-AdsBot` or the landing page fails ad
review before any of this can fire. See `public/robots.txt`, and
`docs/www-robots-txt-fix.md` for the equivalent problem on `www.kudos.com`.

Reference: <https://developers.openai.com/ads/measurement-pixel>
