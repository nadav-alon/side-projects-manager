# How can a static PWA alert me that a shopping trip is due?

Research for #915, part of map #911. The home catalogue is a static PWA whose only backend is the
data platform's DB layer, on free tiers, single user. **Necessity** drives alerts: an essential item
reaching "almost gone" or "need" should tell the user a trip is due soon. This note asks which alert
channels work with no custom backend, what each needs server-side, where each works on iOS and
Android as of September 2026, and what the free tiers allow.

Every claim cites the source that owns it. Nothing was built or run. Compatibility figures come from
MDN's browser-compat-data (`@mdn/browser-compat-data` 8.1.3, published 2026-09-24).

## Bottom line

- **No channel can fire a timed alert while the app is closed without some server sending
  something.** Either a push message comes from an application server, or an external service (a
  calendar, or a mail server) holds the reminder. The browser has no API that schedules a local
  notification for later: Chrome dropped Notification Triggers, and Periodic Background Sync runs
  only in Chromium, at times the browser chooses.
- **Web Push is the only channel that works on both platforms and reacts to State changes.** It
  needs a sender. On this stack that sender is a Supabase Edge Function, run by Supabase Cron or a
  database webhook, with no extra service. FCM is optional; with it, sending needs Firebase's Blaze
  plan unless Supabase does the sending.
- **iOS works only as a Home Screen web app** (iOS/iPadOS 16.4+). In a Safari tab, iOS has no push.
- **Calendar reminders are the simplest fallback, and they come almost free**: the catalogue already
  exports one Google Calendar event per Shop, and a reminder override on that event costs no new
  infrastructure. The reminder is fixed when the event is exported, so it cannot react to State
  changes that happen later.
- **Email needs a server-side sender too.** It is no simpler than push on this stack, since both
  need the same Edge Function plus cron. Its advantage is that it works everywhere without
  installing the app.

## Channel by channel

### 1. Web Push (Push API + service worker)

**How it works.** The service worker subscribes through `PushManager.subscribe()` and gets a
`PushSubscription`, which holds an endpoint URL and encryption keys. The subscription is sent to an
*application server*. That server sends messages to the push service at the endpoint, and the
service worker receives them in its `push` event, even when the page is closed. The endpoint must be
kept secret, because anyone who knows it can push to the app.
([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API))

**Who sends it when the app is closed?** An application server that you run or rent. It signs each
request with VAPID (RFC 8292) and encrypts the payload (RFC 8291). The push services themselves are
free and run by the browser vendor: FCM for Chrome, and APNs for Safari at `*.push.apple.com`. An
Apple Developer Program membership is **not** required.
([WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/))

**Every push must show a notification.** Subscriptions require `userVisibleOnly: true`, which is an
agreement to show a notification for every push. Silent pushes that wake the service worker to do
background work are not allowed for web pages.
([web.dev: Subscribe a user](https://web.dev/articles/push-notifications-subscribing-a-user)) So
the *server* must decide that a trip is due. The push cannot just wake the client to check.

**Platform support (MDN BCD, `api.PushManager`):**

| Platform | Support |
|---|---|
| Chrome / Chrome Android | 42+ — works in a normal tab; no install needed |
| Samsung Internet | 4.0+ |
| Firefox / Firefox Android | 44+ / 48+ |
| Safari macOS | 16+ |
| Safari iOS / iPadOS | 16.4+ — "Notifications are supported in web apps saved to the home screen" (BCD note) |
| Android WebView, iOS WebView | no |

iOS details ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)):

- The app must be added to the Home Screen through the Share menu.
- The permission prompt must follow a direct user gesture, such as tapping a "subscribe" button.
- The Badging API (`setAppBadge`) is also available, so an app icon badge such as "3 needed" is an
  extra cheap signal.
- Since iOS 26, every site added to the Home Screen opens as a web app by default, even without a
  manifest ([WebKit: WWDC25](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)).
  Installing takes fewer steps, but the step is still manual.

**Declarative Web Push** (iOS/iPadOS 18.4, macOS Safari 18.5). The push payload is a standard JSON
notification that the browser displays without running any JavaScript. A service worker becomes
optional, and `window.pushManager` can manage subscriptions. On iOS it applies to Home Screen web
apps. It still needs the same server-side sender.
([WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)) It
makes the iOS side more reliable, because a notification is shown even if the service worker was
evicted. It does not remove the backend.

#### 1a. Sender on Supabase (Edge Function + Cron). Fits the stack.

- **Supabase Cron** (`pg_cron` + `pg_net`) runs SQL or makes HTTP calls, including invoking an Edge
  Function, "anywhere from every second to once a year". Guidance: no more than 8 concurrent jobs,
  each under 10 minutes. ([Supabase Cron](https://supabase.com/docs/guides/cron),
  [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)) Neither
  page restricts cron to paid plans.
- **Trigger shape.** There are two options.
  - A daily cron job calls an Edge Function. The function queries items where State × Necessity
    means a trip is due, and pushes to the stored subscriptions.
  - A database webhook on the State-history insert calls the function right away. This is the
    pattern Supabase's own push example uses: a table insert fires a webhook, which invokes an Edge
    Function that sends the push.
    ([Supabase push example](https://supabase.com/docs/guides/functions/examples/push-notifications))
    That example targets Expo and FCM for native apps, not browser Web Push.
- **Library.** Edge Functions run Deno. `npm:web-push` or `jsr:@negrel/webpush` do the VAPID
  signing and payload encryption ([negrel/webpush](https://github.com/negrel/webpush)). The VAPID
  key pair is stored with `supabase secrets set`, and subscriptions go in a table.
- **Free-tier limits** ([Supabase pricing](https://supabase.com/pricing)): 500,000 Edge Function
  invocations/month, a 500 MB database, 5 GB egress, and 2 active projects. A single user's daily
  cron uses about 30 invocations/month.
- **Risk: pausing.** "Free projects are paused after 1 week of inactivity". A project is inactive
  when it "does not receive sufficient user database activity over the past week"
  ([Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)). A household
  that uses the catalogue weekly keeps the project alive. If the project pauses, the alerts stop too.
  **Unverified:** whether queries from the project's own `pg_cron` count as "user" activity. Do not
  rely on cron to keep the project awake.

#### 1b. Sender on Firebase (FCM + Cloud Functions)

- FCM is "No-cost" on both Spark and Blaze ([Firebase pricing](https://firebase.google.com/pricing)).
  The web SDK needs `firebase-messaging-sw.js` at the domain root, a VAPID key pair, and HTTPS
  ([FCM JS client](https://firebase.google.com/docs/cloud-messaging/js/client)).
- Sending through FCM still needs a trusted server that holds the service-account credential. On
  Firebase that server is Cloud Functions, and "to deploy functions, your project must be on the Blaze
  pricing plan" ([Get started](https://firebase.google.com/docs/functions/get-started)). Blaze needs
  a billing account.
- Scheduled functions use Cloud Scheduler: "$0.10 (USD) per month" per job, with "three jobs per
  Google account, at no charge"
  ([Schedule functions](https://firebase.google.com/docs/functions/schedule-functions)).
- Verdict: FCM adds nothing on a Supabase stack, because browser Web Push already routes through
  each vendor's push service. It only makes sense if the data platform is Firebase, and even then it
  forces Blaze.

#### 1c. Sender on GitHub Actions (free cron for a public repo)

A scheduled workflow can run a script that queries the DB and sends pushes, with no BaaS functions
at all. The limits: an interval of at least 5 minutes, runs can be delayed or dropped under load,
and "In a public repository, scheduled workflows are automatically disabled when no repository
activity has occurred in 60 days."
([GitHub Actions: schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows))
The silent 60-day disable makes it a poor fit for a household app whose repo goes quiet. It could
serve as a backup sender.

### 2. Periodic Background Sync

The service worker registers a `periodicsync` task with a `minInterval`. The browser wakes the task
"at periodic intervals" when the device is online
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API)).
The task could read the DB and show a local notification, with no server-side sender at all.

- **Support (BCD `api.PeriodicSyncManager`):** Chrome / Chrome Android 80+, Edge 80+, Samsung
  Internet 13+, Opera. **Safari (macOS and iOS): no. Firefox: no.**
- The app must be installed and launched as its own window. Frequency follows the site engagement
  score, and syncs stop when the user stops using the app. "The timing of synchronizations are not
  controlled by developers."
  ([Chrome: Periodic Background Sync](https://developer.chrome.com/docs/capabilities/periodic-background-sync))
- Verdict: an Android-only best-effort bonus. It fails for iOS and is least reliable when the user
  is least engaged, which is exactly when a reminder is needed. One-off Background Sync fires when
  connectivity returns, not on a schedule, so it does not help either.

### 3. Local scheduled notifications (Notification Triggers)

Abandoned: "The development of Notification Triggers API … has ended. It wasn't clear that we could
provide consistent and reliable experiences across platforms." It never shipped past an origin trial.
([Chrome: Notification Triggers](https://developer.chrome.com/docs/web-platform/notification-triggers))
No other API lets a PWA schedule its own notification for later.

### 4. Calendar reminders

The catalogue already exports one Google Calendar event per Shop, with the date picked at export
(#911). An event can carry up to **5** reminder overrides, each a `popup` or `email`, from 0 to
40,320 minutes (4 weeks) before the event
([Events reference](https://developers.google.com/workspace/calendar/api/v3/reference/events),
[Reminders](https://developers.google.com/workspace/calendar/api/concepts/reminders)). "Reminders
are private information, specific to an authenticated user", so the reminder fires only for the
user whose calendar holds the event.

- **Server-side:** none. The client writes the event with the user's OAuth token. Google's servers
  then deliver the popup or email on every device where the user has Google Calendar, iOS included,
  with no PWA install.
- **Free tier:** the Calendar API is free within per-project quotas.
- **Limitation:** the reminder is fixed when the export happens. It cannot fire *because* an item
  just became "almost gone". It works as "remind me on the trip date I picked", not as a
  necessity-triggered alert. An alternative client-only design: on each State change, the client
  upserts a "Trip due" event with a popup reminder. That still only reacts while the app is open.

### 5. Email

- It needs a server-side sender, the same Edge Function + cron as push, plus a mail API. Resend's
  free plan allows 3,000 emails/month, capped at 100/day, with 3 domains
  ([Resend pricing](https://resend.com/pricing)). A single user needs about 30 emails a month.
- Advantages: no install, no permission prompt, and it works the same on every platform.
  Disadvantages: a second vendor and key, a sending domain to verify, and emails are easy to miss.
- It is no simpler than Web Push on Supabase, because the trigger and function are the same and only
  the final HTTP call differs. It is the fallback for users who will not install the PWA on iOS.

## Comparison

| Channel | Who sends when app closed | iOS | Android | Reacts to State change | Free-tier fit |
|---|---|---|---|---|---|
| Web Push via Supabase Edge Fn + Cron/webhook | Edge Function | Home Screen app, 16.4+ | Chrome, even in a tab | yes | 500k invocations/mo; pause risk after 7 idle days |
| Web Push via FCM + Cloud Functions | Cloud Function | same | same | yes | FCM free; **functions need Blaze** |
| Web Push via GitHub Actions cron | Workflow | same | same | on schedule | free; disabled after 60 idle days |
| Periodic Background Sync | none (browser wakes SW) | **no** | Chromium, installed, engagement-gated | best-effort | free |
| Notification Triggers | — | no | no (abandoned) | — | — |
| Google Calendar reminder | Google | yes (Calendar app) | yes | no, fixed at export | free |
| Email (Edge Fn + Resend) | Edge Function + Resend | yes | yes | yes | 3,000/mo, 100/day |

## Suggested direction (input for the alert-channel decision, not the decision)

1. **Primary:** Web Push sent from a Supabase Edge Function. Use a database webhook on State-history
   inserts to alert right away, a daily cron as a "still due" nudge, or both. Use the Declarative Web
   Push payload format so iOS shows a notification without relying on the service worker.
2. **Free fallback:** add a popup reminder override to the Shop events the catalogue already exports.
3. **Optional:** set an app badge (`setAppBadge`) with the count of needed items, for both platforms.
4. **Skip:** FCM (Blaze needed, no gain), Periodic Background Sync (no iOS support), and Notification
   Triggers (abandoned). Add email only if an iOS user will not install the app.

## Open questions

- Does `pg_cron` or webhook activity count toward Supabase's "user database activity"? It decides
  whether a quiet week silently turns alerts off.
- Which State × Necessity combination fires an alert, and how often it repeats. #911 lists this as
  not yet specified.
