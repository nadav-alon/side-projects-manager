# Can a static PWA create Google Calendar events for free, and under what OAuth limits?

Research for #914 (map #911). The catalogue exports one Google Calendar event per Shop, the item
list in the description, on a date picked at export. The client is a static PWA with no backend of
its own (the only backend is the DB layer), free tier required, single user.

Every claim cites a Google primary source (Identity Services, Calendar/Tasks API reference, Google
Cloud / Calendar help centre), read 2026-09-26. Nothing was run against a live Google project.

## Answer

- **Yes, it works, and it is free.** A static page can get a Calendar access token with the Google
  Identity Services (GIS) *token model* and call `events.insert` straight from the browser. No
  server, no client secret, no billing account at this volume.
- **Scope: `calendar.app.created`**, the narrowest scope `events.insert` accepts. The app creates
  its own secondary calendar ("Shopping") and writes events only there.
- **Publishing status: "In production", unverified.** Google exempts personal use (fewer than 100
  users) from verification; the owner clicks through the "unverified app" warning. Staying in
  **Testing** also works, but the authorization expires 7 days after each consent.
- **Token cost of being client-side:** no refresh tokens at all. Each access token lives about an
  hour; a new one needs a user gesture (button press). Fits an export button: one click per export,
  no consent screen after the first.
- **Cheapest fallback without OAuth:** a Calendar "TEMPLATE" deep link per Shop (zero setup, one
  tap to save each event, but undocumented by Google). ICS download is standard but Google imports it
  only on a computer; an ICS subscription feed needs a public URL and refreshes slowly; Google Tasks
  drops the time and still needs OAuth.

## 1. Client-side OAuth from a static site: GIS token model

- GIS offers two models. The **token model** (`google.accounts.oauth2.initTokenClient()` then
  `requestAccessToken()`) returns an access token directly to the browser; "there is no need to store
  per-user refresh tokens on your backend server."
  ([Use the token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model))
- The **code model** is what yields refresh tokens, and it needs a backend endpoint to exchange the
  code and store the refresh token. Google recommends it as more secure, but it "demands backend
  infrastructure" — ruled out by the static-client constraint.
  ([Choose an authorization model](https://developers.google.com/identity/oauth2/web/guides/choose-authorization-model))
- Setup: one *Web application* OAuth client ID with the PWA's origin under *Authorized JavaScript
  origins*. The client ID is public by design; no secret ships to the browser.

### Token and refresh consequences for a pure client-side app

- **No refresh token, ever.** The token model issues access tokens only. "Access tokens have a
  short lifetime. If the access token expires prior to the end of the user's session, obtain a new
  token by calling `requestAccessToken()` from a user-driven event."
  ([Use the token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model))
  `TokenResponse.expires_in` gives the lifetime in seconds (in practice 3600).
  ([JS reference](https://developers.google.com/identity/oauth2/web/reference/js-reference))
- **A user gesture per new token.** "A user gesture such as button press or clicking on a link is
  required to request and obtain a new, valid access token."
  ([Choose an authorization model](https://developers.google.com/identity/oauth2/web/guides/choose-authorization-model))
  So no background or scheduled writes — Calendar is writable only while the user is present and
  clicks. For an export button this costs nothing: the export click is the gesture.
- **Consent is not re-asked each time.** With `prompt: ''`, "the user will be prompted only the
  first time your app requests access"; later requests open and close a popup without a consent
  screen while the grant stands. `login_hint` pre-selects the account.
  ([JS reference](https://developers.google.com/identity/oauth2/web/reference/js-reference))
  The model-comparison page words it as consent "for every token request"; the reference's `prompt`
  semantics are the precise statement — expect a brief popup, not a consent screen.
- Nothing persists server-side; keep the token in memory. Storing it buys at most an hour.

## 2. Scope: `calendar.events` vs narrower

`events.insert` accepts exactly four scopes: `calendar`, `calendar.events`, `calendar.app.created`,
`calendar.events.owned`.
([events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert))

| Scope | Grants ([Choose Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)) | Fit |
|---|---|---|
| `calendar.events` | "View and edit events on all your calendars." | Works; broader than needed (reads every calendar). |
| `calendar.events.owned` | "See, create, change, and delete events on Google calendars you own." | Works on the primary calendar; still reads all owned calendars. |
| `calendar.app.created` | "Make secondary Google calendars, and see, create, change, and delete events on them." | **Narrowest.** App creates a "Shopping" calendar (`calendars.insert` accepts this scope — [calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert)) and writes only there. Events still show in the user's Calendar views. |

Trade-off of `calendar.app.created`: events land on a separate secondary calendar, not the primary.
The app must keep that calendar's ID (or find it again via the calendars it created).

Sensitivity class: the Calendar scopes page prints no sensitive/restricted label per scope; the
Cloud console's Data Access page shows it when the scope is added. Plan as if it is at least
*sensitive* — the conclusions below hold either way, since the 7-day Testing expiry applies to any
non-basic scope and the personal-use exemption covers sensitive scopes.

## 3. Testing vs In production, verification, personal use

### Testing publishing status

- "Projects configured with a publishing status of **Testing** are limited to up to 100 test users
  listed in the OAuth consent screen." "Authorizations by a test user will expire seven days from the
  time of consent." The expiry is waived only for basic scopes (name, email, profile / Sign in with
  Google) — not Calendar.
  ([Manage app audience](https://support.google.com/cloud/answer/15549945))
- Same rule for refresh tokens: an external-user-type project in Testing "is issued a refresh token
  expiring in 7 days" unless only basic scopes are requested.
  ([Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2))
- The token model has no refresh token to expire, but the *grant* lapses: 7 days after consent the
  next `requestAccessToken()` shows the consent screen again. Survivable (one extra consent a week)
  but needless — production-unverified avoids it.
- The owner must list their own Google account as a test user.

### In production, unverified — the personal-use path

- Google's "When is verification not needed": "If the app is for your personal use (**fewer than 100
  users**), you and your limited number of users can continue using the app without going through
  verification"; "users will be allowed to click through 'unverified app' warning screens during
  sign-in."
  ([When is verification not needed](https://support.google.com/cloud/answer/13464323))
- Unverified apps using sensitive/restricted scopes show the unverified-app screen and are capped at
  "100 new users in total, after the app presents the unverified app screen."
  ([Unverified apps](https://support.google.com/cloud/answer/7454865))
- **So yes: a single-user personal app can run indefinitely unverified.** Set publishing status to
  *In production*, don't submit for verification, click through the warning at consent. No 7-day
  expiry, no test-user list. A forking sibling brings their own Cloud project and client ID, so each
  household instance stays at a handful of users, far under the 100 cap.
- *Internal* user type (no warning, no cap) needs a Workspace / Cloud Identity organisation — not
  available to personal Gmail accounts.
  ([When is verification not needed](https://support.google.com/cloud/answer/13464323))

### Refresh-token limits (only relevant if a backend is ever added)

- 100 refresh tokens per Google Account per client ID; creating another silently invalidates the
  oldest. Refresh tokens also die on revocation, six months unused, password changes, admin policy.
  ([Using OAuth 2.0 — refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration))

## 4. Cost

- "All standard use of the Google Calendar API is available at no additional cost." Quotas: 10,000
  requests/min/project, 600 requests/min/user/project.
- New since 2026-05-01: a **daily billing threshold of 1,000,000 requests per project**; "Usage under
  this threshold doesn't incur extra charges and your Google Cloud account isn't billed." Exceeding
  quota "is planned to incur charges to your Google Cloud billing account later in 2026", with at
  least 90 days' notice.
  ([Calendar usage limits](https://developers.google.com/workspace/calendar/api/guides/quota))
- An export is about one request per Shop, plus one `calendars.insert` ever. Cost is zero with orders
  of magnitude to spare; GIS itself is free and needs no billing account.

## 5. Alternatives

| Option | How | Pros | Cons |
|---|---|---|---|
| **Calendar TEMPLATE deep link** | `https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=YYYYMMDD/YYYYMMDD&details=…`, one per Shop | No OAuth, no Cloud project, no scope. User sees a pre-filled event and taps Save. Works on mobile. | **Not documented** on any current Google developer or help page (community threads only) — can change without notice. One tab + one Save per Shop. URL length caps a long item list. |
| **ICS download** | PWA builds a `.ics` Blob (RFC 5545), one `VEVENT` per Shop; user imports it | Standard, offline, no OAuth, any calendar app. | Google imports ICS "on a computer" ([Import events](https://support.google.com/calendar/answer/37118)); on a phone it depends on whatever app opens `.ics`. Duplicate handling on re-import is undocumented. |
| **ICS subscription feed** | Calendar subscribes "From URL" | Hands-off after setup; updates flow in. | Needs a public, always-up URL — a static PWA can't serve its client-side data, so the DB layer would render it, and the feed is effectively public. Subscribing "must use a computer web browser" ([Add a calendar by URL](https://support.google.com/calendar/answer/37100)). Refresh interval undocumented (hours in practice) — bad for a date picked at export. |
| **Google Tasks API** | `tasks.insert` with `due` + `notes` | Checklist-shaped (notes up to 8192 chars); tasks show on the Calendar grid. | Same GIS OAuth and verification story, so no lighter. `due`: "Only date information is recorded; the time portion of the timestamp is discarded" ([Tasks resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)). |

## Recommendation for the export decision

1. **Primary: Calendar API via GIS token model**, scope `calendar.app.created`, consent screen *In
   production* unverified, one Cloud project per household instance. One click per export; free.
2. **Zero-setup fallback: TEMPLATE deep links**, for a fork that won't create a Cloud project —
   accepting that it is undocumented.
3. ICS download as a portable extra if non-Google calendars ever matter. Skip subscription feeds and
   Tasks.

For the auth-model ticket: the Calendar grant is independent of the DB layer's auth. If that layer
ever signs in with Google, request the Calendar scope incrementally at export time
(`include_granted_scopes`, default true) rather than at login.
