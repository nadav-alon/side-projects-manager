# Which backend-as-a-service fits static PWAs sharing one store?

Research for #912 (map #911). It surfaces facts only. The choice belongs to the data-platform-shape
grilling (#917).

Every claim cites the vendor's own docs, pricing page, changelog or blog. Figures were read on
2026-09-26 and pricing pages change, so recheck them before committing. Nothing was built or run.

## Criteria (from the ticket)

1. **Static client**: works from a static PWA with no app backend.
2. **Free POC**: free tier is enough for a single-user proof of concept.
3. **Household path**: cheap path from one user to a household (2–5 people).
4. **Forkable**: one instance per household; a fork brings its own project, config comes from the
   repo.
5. **History**: append-only record of every item State change, timestamped.
6. **Shared schema**: one entity schema or library across apps (catalogue now, recipes/nutrition
   later) without the apps drifting apart.
7. **Offline**: offline PWA support.
8. **Rules**: a security model safe for a public client.

## Firebase (Cloud Firestore + Auth)

- **Static client.** Yes. Web SDK talks to Firestore directly. "Every database request from a Cloud
  Firestore mobile/web client library is evaluated against your security rules"
  ([rules](https://firebase.google.com/docs/firestore/security/get-started)).
- **Free POC.** Spark plan, no cost: Firestore 1 GiB stored, 50K reads/day, 20K writes/day, 20K
  deletes/day, 10 GiB egress/month; Auth 50K MAU; Hosting 10 GB stored, 360 MB/day transfer
  ([pricing](https://firebase.google.com/pricing)). One free database per project
  ([Firestore billing](https://firebase.google.com/docs/firestore/pricing)).
  - **No pausing.** Neither pricing page mentions inactivity pausing.
- **Household path.** A household sits well inside the free daily quotas. Quotas are per project and
  reset daily, so going over means Blaze (pay as you go) at Google Cloud rates
  ([pricing](https://firebase.google.com/pricing)). No per-seat or base fee.
- **Forkable.** A fork creates its own Firebase project. `firestore.rules`, indexes and hosting config
  live in the repo and are deployed by the CLI, which overwrites console-edited rules
  ([rules](https://firebase.google.com/docs/firestore/security/get-started)).
- **History.** Not built in. Model it as an append-only subcollection of State events. Rules can
  allow `create` and deny `update`/`delete`, and can validate the payload via `request.resource.data`
  ([rules](https://firebase.google.com/docs/firestore/security/get-started)).
- **Shared schema.** Schemaless. Nothing server-side stops two apps writing incompatible shapes.
  - **Guards.** A shared TypeScript types/validator package, plus rules that validate fields.
  - **Several apps.** Several web apps can register in one project.
- **Offline.** Best of the hosted options. The web SDK persists to IndexedDB, with single- or
  multi-tab mode; offline writes sync on reconnect; "last write wins" per document. Web persistence
  is limited to Chrome, Safari and Firefox
  ([offline](https://firebase.google.com/docs/firestore/manage-data/enable-offline)).
- **Rules.** Security Rules plus `request.auth`. Server SDKs bypass the rules
  ([rules](https://firebase.google.com/docs/firestore/security/get-started)).

## Supabase (Postgres + PostgREST)

- **Static client.** Yes. The publishable/anon key is safe in the browser once RLS is on. "Enable RLS
  on every table in an exposed schema"
  ([RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)).
- **Free POC.** Free plan: 500 MB database, 50,000 MAU, 5 GB egress, 1 GB file storage, 2 active
  projects ([pricing](https://supabase.com/pricing)).
  - **Pausing.** "Free projects are paused after 1 week of inactivity"
    ([pricing](https://supabase.com/pricing)).
  - **Restore.** A paused free project can be restored for 90 days. After that you only get a backup
    download
    ([pausing](https://supabase.com/docs/guides/platform/free-project-pausing),
    [changelog](https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days)).
  - **Occasional use.** A household app used only occasionally can get paused.
- **Household path.** The data fits the free plan, but the pause risk remains. The next step is Pro
  at $25/month, which includes $10 compute credit covering one Micro instance
  ([pricing](https://supabase.com/pricing)). That is a big jump for a household.
- **Forkable.** A fork creates its own project. The schema, RLS policies and triggers are SQL
  migrations in the repo, applied with the Supabase CLI
  ([local dev/CLI](https://supabase.com/docs/guides/local-development)).
- **History.** Strongest fit. Use an insert-only `state_changes` table: RLS grants `insert`/`select`
  and no `update`/`delete` policy exists. A Postgres trigger can also write history
  server-side, and a `now()` default gives a server timestamp the client cannot forge
  ([RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)).
- **Shared schema.** Strongest fit. There is one relational schema with constraints and foreign
  keys, enforced by the database for every app. TypeScript types are generated from it
  ([generating types](https://supabase.com/docs/guides/api/rest/generating-types)). Recipes and
  nutrition can reference catalogue items by foreign key.
- **Offline.** Not native. Supabase points to partner sync layers:
  - **Partners.** PowerSync, ElectricSQL, Replicache
    ([PowerSync](https://supabase.com/partners/powersync),
    [ElectricSQL](https://supabase.com/partners/catalog/electricsql),
    [Replicache](https://supabase.com/partners/replicache)).
  - **PowerSync free plan.** 2 GB synced/month, 50 peak concurrent clients, and it is "deactivated
    after 1 week of inactivity". Pro starts at $49/month
    ([PowerSync pricing](https://www.powersync.com/pricing)).
  - **Otherwise.** A hand-rolled IndexedDB outbox plus a service worker.
- **Rules.** Postgres RLS with `auth.uid()`. Watch for silent `null` on anonymous requests
  ([RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)).

## PocketBase

- **Static client.** Yes, with a JS SDK and REST API. But it is a Go binary you must host yourself.
  There is no official hosted offering ([docs](https://pocketbase.io/docs/)).
- **Free POC.** Only on hardware you already run, such as a home server or local machine. PocketHost,
  a third-party host that is not official, has no free tier. It costs $9.99/month, $59.99/year or
  $149.99 lifetime per instance, with 250 MB of database each
  ([PocketHost](https://pockethost.io/pricing)).
- **Household path.** Cheap and flat: one small instance per household, not metered.
- **Forkable.** Yes. The binary plus `pb_migrations` are in the repo, but each household must run a
  server.
- **History.** Possible with API rules: `createRule` open to authenticated users, `updateRule` and
  `deleteRule` = `null` (superuser only) ([API rules](https://pocketbase.io/docs/api-rules-and-filters/)).
- **Shared schema.** Collections have typed fields enforced by the server, and migrations are code.
- **Offline.** None built in.
- **Rules.** Per-collection list/view/create/update/delete rule expressions. The default is `null`,
  meaning locked ([API rules](https://pocketbase.io/docs/api-rules-and-filters/)).
- **Maturity.** "full backward compatibility is not guaranteed before reaching v1.0.0. PocketBase is
  NOT recommended for production critical applications yet" ([docs](https://pocketbase.io/docs/)).

## Appwrite Cloud

- **Static client.** Yes, with a web SDK plus permissions on tables and rows.
- **Free POC.**
  - **Account limits.** One organization and 2 projects per account
    ([Free](https://appwrite.io/docs/advanced/platform/free)).
  - **Operation quotas.** 500,000 reads and 250,000 writes per month, throttled at the limit
    ([reads/writes](https://appwrite.io/docs/advanced/platform/database-reads-and-writes)).
    Reads count per row returned, not per call.
  - **Bandwidth.** 5 GB
    ([changelog](https://appwrite.io/changelog/entry/2024-12-01)).
  - **Per-project caps.** 1 database per project
    ([Free](https://appwrite.io/docs/advanced/platform/free)).
  - **Pausing.** Since 2026-02-20, Free projects "with no development activity for 7 consecutive
    days will be automatically paused". Activity means Console activity. They can be reactivated
    from the Console ([changelog](https://appwrite.io/changelog/entry/2026-02-20-1)). Free projects
    paused for 90 days are deleted
    ([changelog](https://appwrite.io/changelog/entry/2026-06-29)).
  - **Effect on a live app.** App traffic alone may not count as activity. A working household app
    would pause weekly unless someone opens the Console.
- **Household path.** Pro at $25/month. Each extra project costs more
  ([pricing update](https://appwrite.io/blog/post/appwrite-pricing-update)). Pro includes 1.75M
  reads and 750K writes per month
  ([reads/writes](https://appwrite.io/docs/advanced/platform/database-reads-and-writes)).
- **Forkable.** Yes. A fork creates its own project. Config via `appwrite.json` and the CLI, or
  self-host with Docker.
- **History.** Row permissions can allow create and withhold update/delete.
- **Shared schema.** Tables have typed columns enforced by the server.
- **Offline.** Not native. Appwrite's own blog uses RxDB replication for offline-first
  ([blog](https://appwrite.io/blog/post/offline-first-journal)).
- **Rules.** Role-based permissions on tables and rows.

## InstantDB

- **Status: sunsetting.** The team joined OpenAI. "New signups are closed." Existing users must
  migrate off within 12 months. "On August 31st, 2027, all cloud apps will shut down." The code stays
  open source and self-hostable ([instantdb.com](https://www.instantdb.com/pricing),
  [docs banner](https://www.instantdb.com/docs)).
- **Self-hosting.** Runs on the JVM. The guides quote about $30/month on a VPS for side projects
  ([self-hosting](https://www.instantdb.com/docs/self-hosting)).
- **Otherwise attractive.**
  - **Schema.** `instant.schema.ts` is pushed from the repo.
  - **Permissions.** `instant.perms.ts` holds CEL rules per namespace for view/create/update/delete.
    But "If a rule is not set then by default it evaluates to true"
    ([permissions](https://www.instantdb.com/docs/permissions)).
  - **Offline.** Offline behaviour was not verified, since the service is out of the running anyway.

## Other candidates

### Dexie Cloud (strong candidate)

- **Static client.** Designed for it: "no backend needed … Your app can be hosted on any static web
  server or CDN" ([Dexie Cloud](https://dexie.org/cloud/)).
- **Offline.** Offline-first by design. Data lives in IndexedDB via Dexie.js, changes queue offline
  and sync in the background, and conflicts resolve via CRDTs. Built-in email OTP auth. Set up with
  `npx dexie-cloud create` ([Dexie Cloud](https://dexie.org/cloud/)).
- **Free tier.** 3 production users, 10 databases, 100 MB storage, 20 requests/second
  ([pricing](https://dexie.org/cloud/pricing)). No pausing is mentioned.
- **Household path.** Pro is €0.12 per user per month. A 4-person household is about €0.50/month
  ([pricing](https://dexie.org/cloud/pricing)).
- **Self-hosting.** Is not free: €3,495 one-time for Business
  ([pricing](https://dexie.org/cloud/pricing)).
- **Rules.** Realms, members and roles, with add, update and manage permissions. "the server endpoint
  of Dexie Cloud controls access to data for every sync request"
  ([access control](https://dexie.org/cloud/docs/access-control)).
  - **Append-only history.** Add permission without update permission on a history table.
- **Shared schema.** Weak. The schema is declared in each client (`db.version().stores()`) and only
  indexed fields are declared. Stopping drift needs a shared package. Being a single vendor adds
  lock-in risk.

### Jazz

- **Current version.** v2 is a "local-first relational database" with row-level security and "a full
  git-like branching history" on every row. That would give history natively
  ([jazz.tools](https://jazz.tools/)).
- **v2 status.** Alpha ([jazz.tools](https://jazz.tools/)).
- **v2 pricing.** Usage-based with free allowances ([jazz.tools](https://jazz.tools/)).
- **Classic Jazz.** The Starter tier is free with 100 MAU and 10 GB storage; Indie is $4/month
  ([classic pricing](https://classic.jazz.tools/pricing)).
- **Self-hosting.** A sync server via `npx jazz-run sync`
  ([sync & storage](https://jazz.tools/docs/react-native/core-concepts/sync-and-storage)).
- **Risk.** Alpha, rewritten recently.

### Convex (weak fit)

- **Free tier.** 1M function calls, 0.5 GB storage, 1 GB egress. Pro is $25 per developer per month
  ([pricing](https://www.convex.dev/pricing)).
- **Why weak.** Access goes through server functions you write and deploy. That is an app backend in
  all but name, and there is no offline cache for the web.

## Comparison

✓ = meets it natively. ~ = meets it with work or a caveat. ✗ = does not meet it.

| Criterion | Firebase | Supabase | PocketBase | Appwrite | InstantDB | Dexie Cloud | Jazz v2 |
|---|---|---|---|---|---|---|---|
| Static client, no backend | ✓ | ✓ | ~ must host server | ✓ | ✓ | ✓ | ✓ |
| Free POC | ✓ no pause | ~ pauses after 1 wk idle | ✗ unless own hardware | ~ pauses after 7 d without Console activity | ✗ signups closed | ✓ 3 users | ~ alpha |
| Household cost | $0 (daily quota) | $0 with pause risk, else $25/mo | ~$5–10/mo host | $0 with pause risk, else $25/mo | — | ≈€0.50/mo | usage-based |
| Forkable, config in repo | ✓ CLI | ✓ migrations | ✓ migrations | ✓ CLI | — | ✓ CLI | ✓ |
| Append-only history | ~ rules | ✓ RLS + triggers | ~ rules | ~ permissions | — | ~ permissions | ✓ built-in |
| Shared schema, no drift | ✗ schemaless | ✓ DB-enforced + generated types | ✓ typed collections | ✓ typed tables | — | ✗ client-declared | ✓ relational |
| Offline PWA | ✓ IndexedDB cache | ✗ needs sync partner | ✗ | ✗ needs RxDB | — | ✓ offline-first | ✓ local-first |
| Public-client rules | ✓ Security Rules | ✓ RLS | ✓ API rules | ✓ permissions | allow-by-default | ✓ realms | ✓ RLS |
| Maturity | GA | GA | pre-1.0 | GA | shutting down | GA | alpha |

## Clearly disqualified

- **InstantDB.** Cloud signups are closed and it shuts down on 2027-08-31. Self-hosting means running
  a JVM service, which is no longer "BaaS, free tier".
- **Convex.** Needs server functions, so it is effectively an app backend, and it has no web offline.
- **PocketBase.** Fails "free tier is a hard requirement" unless a household already runs a server.
  It is also pre-1.0 by its own warning.
- **Appwrite Cloud (free).** Close to disqualified. Pausing is based on Console activity, so a
  finished, used-but-untouched household app pauses, and is deleted after 90 days paused.

## Facts the decision hinges on

1. **Offline vs schema enforcement trade off.** No GA option has both native offline and a
   DB-enforced shared schema:
   - **Firebase and Dexie Cloud** give offline but are schemaless or client-declared.
   - **Supabase** gives enforced schema and history but no offline without a sync layer. PowerSync
     brings its own inactivity deactivation.
   - **Jazz v2** claims all three but is alpha.
2. **How much offline is needed.** Does the catalogue need offline writes (in a shop with no signal)
   or only offline reads? Offline reads are cheap anywhere: a service worker plus a cached snapshot.
   Offline writes favour Firebase or Dexie Cloud.
3. **Pause policies decide the free tier in practice.**
   - **No pausing:** Firebase Spark and Dexie Cloud free.
   - **Pausing:** Supabase pauses after 1 week of no activity. Appwrite pauses after 7 days of no
     *Console* activity and deletes after 90 days paused.
   - **Mitigation:** a scheduled keep-alive ping (for example a GitHub Actions cron) would be needed
     for Supabase. Whether that is acceptable use was not verified.
4. **How drift is prevented.** Either the DB enforces the schema (Supabase, Appwrite, PocketBase), or
   a shared npm package of types and validators is the contract (Firebase, Dexie). Choosing the latter
   adds a platform-owned library as the anti-drift mechanism, plus rules that validate writes.
5. **History.** Every option can express append-only history through its rules. Only Supabase
   (triggers, server `now()`) and Jazz (built-in) record it without trusting the client's
   timestamp. Firebase rules can enforce `request.time` equality to get the same guarantee.
6. **Household scaling.** Every GA hosted option charges $0 for a household at POC volume. Past the
   free tier the costs differ:
   - **Supabase and Appwrite.** Jump straight to $25/month.
   - **Firebase.** Stays metered at cents.
   - **Dexie Cloud.** About €0.12 per user.
