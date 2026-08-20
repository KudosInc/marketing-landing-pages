# Fix: `www.kudos.com/robots.txt` blocks ad-network crawlers on tagged URLs

**Status:** proposed, not applied.
**Applies to:** the `www.kudos.com` property — **not** this repo.

This repo builds and deploys `get.kudos.com` only. Its `public/robots.txt` has no
effect on `www.kudos.com`, so this fix has to be applied wherever www's
`robots.txt` is served from. It is documented here because it was found while
fixing the equivalent problem on `get.kudos.com`.

## Verified findings

Checked against the live file fetched from `https://www.kudos.com/robots.txt`.

### 1. `OAI-AdsBot` is blocked on any URL carrying tracking parameters

This is the one that costs money. Ad landing pages almost always carry `utm_*` or
`gclid`, and www's wildcard group disallows exactly those:

```
Disallow: /?utm
Disallow: /*?utm
Disallow: /?
Disallow: /recognition?gclid=
```

`OAI-AdsBot` respects `robots.txt` and has no named group on www, so it falls
into `User-agent: *` and inherits all of the above:

| User-agent | URL | Verdict |
| --- | --- | --- |
| `OAI-AdsBot/1.0` | `/recognition` | allowed |
| `OAI-AdsBot/1.0` | `/recognition?utm_source=chatgpt&utm_medium=cpc` | **blocked** by `/*?utm` |
| `OAI-AdsBot/1.0` | `/?utm_source=chatgpt` | **blocked** by `/?` |

A blocked landing page fails ChatGPT Ads validation, so the ad does not serve.

Note `Disallow: /?` blocks the homepage with *any* query string at all, not just
tracking parameters.

### 2. Both named user-agent groups are malformed and match nothing

```
User-agent: 127.0.0.1
Allow: /*.ss$

User-agent: ; OAI-SearchBot/1.0; +https://openai.com/searchbot
Allow: /
```

A `User-agent` value must be a bare product token. The first is an IP address;
the second is a full user-agent string, complete with a leading `; ` and a
trailing URL. Neither matches any crawler, so both `Allow` lines are dead.

Impact is narrower than it looks: because the wildcard group has no blanket
`Disallow: /`, `OAI-SearchBot` can still reach plain paths. The dead group is not
causing active harm on untagged URLs — it simply is not doing anything, and it
does not exempt `OAI-SearchBot` from the query-string rules as intended.

### 3. Rules reference paths that no longer exist

`Disallow: /*.ss$`, `/silverstripe-cache`, `/composer.json`, `/composer-lock.json`,
`/vendor`, `/web.config` are artifacts of an earlier stack. `https://www.kudos.com/composer.json`
returns 404. They are dropped below; keep them if any origin still serves those
paths. (`robots.txt` is not an access control either way — it is advisory, and
listing a sensitive path there advertises it.)

### 4. Duplicated and redundant rules

`/?s` and `/?h=` each appear twice; `/?utm` is subsumed by `/*?utm`; `/?ref`
by `/*?ref=`.

### Not a finding: `AdsBot-Google`

Google's `AdsBot-Google` and `AdsBot-Google-Mobile` **ignore `User-agent: *` by
design** and must be named explicitly to be given rules. So despite
`Disallow: /recognition?gclid=` appearing to block Google's ad crawler, it does
not. Google Ads was never broken by this file. It is named explicitly in the
proposed file below so that remains true if the wildcard group is edited.

## Proposed replacement

```
# www.kudos.com

# --- Ad-network landing-page validation -------------------------------------
# These crawlers must reach ad landing pages, including URLs carrying tracking
# parameters, or the ads fail review and do not serve. Named groups take
# precedence over "User-agent: *", so the query-string rules below do not
# apply to them.
User-agent: OAI-AdsBot
Allow: /

User-agent: AdsBot-Google
Allow: /

User-agent: AdsBot-Google-Mobile
Allow: /

User-agent: adidxbot
Allow: /

# --- OpenAI search ----------------------------------------------------------
# Replaces the malformed group that pasted a full user-agent string into the
# User-agent field; that group matched nothing, so this Allow was never live.
User-agent: OAI-SearchBot
Allow: /

# --- Everything else --------------------------------------------------------
User-agent: *
Disallow: /search
Disallow: /subscribe
Disallow: /signup_
Disallow: /resources/thank-you/
Disallow: /*?*utm
Disallow: /*?*trk=
Disallow: /*?*ref=
Disallow: /*?*gclid=
Disallow: /*?*sub1=
Disallow: /*?*ClientSessionId=
Disallow: /*?s=
Disallow: /*?h=
Disallow: /*?from=
Disallow: /*?source=

Sitemap: https://www.kudos.com/sitemap.xml
```

Query-parameter rules are rewritten as `/*?*param` so they match the parameter
anywhere in the query string, not only as the first parameter. The originals
(`/?utm`, `/*?utm`) miss `/page?foo=1&utm_source=x`.

Organic crawl behaviour is deliberately unchanged: `Googlebot` is still kept off
`/search` and off tracking-tagged URLs, which is normal canonical hygiene.

## Verification

| User-agent | URL | Current | Proposed |
| --- | --- | --- | --- |
| `OAI-AdsBot/1.0` | `/recognition?utm_source=chatgpt&utm_medium=cpc` | **blocked** | allowed |
| `OAI-AdsBot/1.0` | `/recognition` | allowed | allowed |
| `OAI-SearchBot/1.0` | `/recognition` | allowed (via `*`, not the dead group) | allowed (named group) |
| `Googlebot` | `/recognition` | allowed | allowed |
| `Googlebot` | `/recognition?utm_source=x` | blocked | blocked |
| `Googlebot` | `/search` | blocked | blocked |
| Malformed-group warnings | | 2 | 0 |

Note that `urllib.robotparser` cannot be used to check this file: it runs rule
paths through `urlparse` and discards the query string, so `Disallow: /?`
degrades into `Disallow: /` — a blanket block — and it percent-encodes `*` and
`$` instead of treating them as wildcards. Verify with a parser that implements
RFC 9309 plus Google's wildcard extensions (for example `protego`), or with
Google Search Console's robots.txt tester.
