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

On a successful HubSpot form submission:

```js
window.dataLayer.push({
  event: 'kudos_form_conversion',
  form_location: 'main',            // 'main' | 'exit_intent' | 'unknown'
  hubspot_form_id: '752783ec-...',
  conversion_event_id: '9f8c...',   // UUID, use as the dedupe key
  page_path: '/employee-recognition'
});
```

### `form_location`

`main` is the in-page form, `exit_intent` is the form in the exit-intent modal.
The label is derived from the DOM at submit time — the script checks whether the
form's frame sits inside `.exit-intent-modal` — rather than from a form-id lookup
table, because **the same HubSpot form id is used in different roles across
these pages**: `b72aaabd-...` is the exit-intent form on four pages but is the
only, primary form on `demo-video`, which has no modal. A lookup table would
report demo-video's main conversion as `exit_intent`.

`unknown` means a `hsFormCallback` arrived for a form id with no matching frame
in the DOM. It is reported rather than dropped so it shows up in reporting
instead of silently vanishing. If you see `unknown` in production, a form was
added without the frame markup this script looks for.

### `conversion_event_id`

A fresh UUID per counted conversion. Pass it as `event_id` so the pixel and any
future Conversions API call for the same submission are deduplicated rather than
double-counted.

### Deduplication behaviour

The script counts **one conversion per person per form role**, keyed in
`localStorage` under `kudos:conv:<form_location>`. A returning visitor who
submits the same form again does not produce a second event; `main` and
`exit_intent` are tracked independently, so one person can produce at most one
of each. If `localStorage` is unavailable (private mode), dedupe falls back to
per-pageview, which still prevents HubSpot's repeated messages from
double-firing.

## GTM configuration (to do)

**1. Data Layer Variables** — create one for each field you want on the tag:

| Variable name | Data layer variable name |
| --- | --- |
| `DLV - form_location` | `form_location` |
| `DLV - conversion_event_id` | `conversion_event_id` |
| `DLV - hubspot_form_id` | `hubspot_form_id` |

**2. Trigger** — Custom Event, event name `kudos_form_conversion`, fires on all
occurrences.

To count only exit-intent submissions, add the condition `DLV - form_location`
equals `exit_intent`. The page always emits both form roles; restricting to one
is a trigger condition, not a code change. Deciding here rather than in the page
also means it never depends on matching a HubSpot form GUID — which matters,
because GUID `b72aaabd-…` is the modal form on four pages but the *only* form on
`demo-video`, and is also reused on the organic `www.kudos.com/demo/video` page.
Matching on the GUID would book organic visitors as ad conversions.

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
