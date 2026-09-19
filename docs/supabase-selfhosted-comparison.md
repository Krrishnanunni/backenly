# Supabase self-hosted vs Backenly self-hosted

**Status (2026-09-17):** evidence gathered, gap register open. This is a gate,
not notes — the classification in Part 3 decides what gets built, and the
"will not build" register is as binding as the build list.

Where the work actually stands, so nobody reads "main is green" as "finished":

| | state |
|---|---|
| Self-host core correctness and security | **largely closed and verified.** Restore no longer destroys data, corrupt archives are rejected before the live schema is touched, failures roll back, `ON_ERROR_STOP` prevents false success, the backup role has a proven minimal privilege contract, and the edition boundary is regression-locked. |
| Self-host parity and operator UX | **See the derived capability register below.** This row was hand-maintained and said "not started" while the one-command install, FK/constraint controls, logs explorer, read-only SQL workspace and migration history had all landed. It is no longer the source of truth. |
| Cloud production validation | **pending.** Staging with the private overlay and production-style credentials, then build once and promote that exact digest. |

Sequence: **CI-01 closed 2026-09-18** (there was no flake; see the record
below). The self-host parity tranche now runs in the order given below,
verified against deterministic production-like fixtures. Cloud staging
validation remains required before Cloud production, and gates Cloud only.

**Supabase pinned at:** `8dc9206f569e823e715cbc391f25cb53f9938782`
(committed 2026-09-16, recorded by `setup.sh` in `.supabase-version`).
**Captured:** 2026-09-16 / 2026-09-17.
**Backenly side:** this working tree, `main` at `ea547aa1`.

Every claim below cites either a Supabase path at that SHA, an observed HTTP
call, or a Backenly repo path. A claim with no locator does not belong here.


<!-- BEGIN DERIVED REGISTER -->

## Capability register

**Derived from `496f2faf` on 2026-09-19 by `scripts/derive-selfhost-register.ts`.**
Do not hand-edit this section: it is regenerated, and a capability
cannot be marked done by editing prose. The previous hand-maintained
matrix listed five shipped capabilities as "not started".

DONE 18 · INTENTIONAL 2 · PARTIAL 1 · REAL_GAP 2

| Area | Capability | Verdict | Evidence |
|---|---|---|---|
| Install | One-command install | **DONE** | scripts/selfhost.ts, README.md |
| Install | Non-superuser application role | **DONE** | scripts/setup-app-role.ts, README.md |
| Install | First-owner claim token | **DONE** | lib/auth/setup-token.ts, README.md |
| Database | Table editor | **DONE** | app/api/database/tables/route.ts, app/app/projects/[id]/database/page.tsx |
| Database | Foreign keys and constraints | **DONE** | app/api/database/schema/constraints/route.ts, lib/db/fk-shape.ts, app/app/projects/[id]/database/page.tsx |
| Database | Read-only SQL workspace | **DONE** | app/api/database/query/route.ts, lib/mcp/read-query.ts, components/database/SqlWorkspace.tsx |
| Database | Migration / schema history | **DONE** | app/api/projects/[id]/schema-versions/route.ts, components/database/SchemaHistory.tsx |
| Database | Schema graph | **DONE** | app/api/database/relationships/route.ts, components/database/EnhancedSchemaVisualizer.tsx |
| Database | Dashboard SQL writes / DDL | **INTENTIONAL** | AGENTS.md: mutations go through typed governed actions so they can be planned, approved, verified and reversed. A SQL parser must never be the tenant boundary. |
| Observability | Logs explorer | **DONE** | app/api/logs/route.ts, components/monitoring/LogsExplorer.tsx |
| Observability | Monitoring workbench | **DONE** | app/api/monitoring/request-logs/route.ts, components/monitoring/MonitoringWorkbench.tsx |
| Data protection | Project database snapshot | **DONE** | lib/services/workspace-backup.ts, app/api/projects/[id]/backup/route.ts, components/database/DatabaseSnapshots.tsx |
| Data protection | Deployment recovery | **DONE** | lib/recovery/export.ts, lib/recovery/restore.ts, scripts/recovery.ts, components/app/DeploymentRecoverySection.tsx |
| Integrations | Webhooks | **DONE** | app/api/projects/[id]/webhooks/route.ts, lib/webhooks/index.ts, components/integrations/WebhooksPanel.tsx |
| Auth | End-user auth runtime | **DONE** | app/api/v1/[projectId]/auth/signin/route.ts, app/app/projects/[id]/auth/page.tsx |
| Auth | SMTP configuration | **DONE** | lib/email/project-smtp.ts, app/api/projects/[id]/email/smtp/route.ts, components/auth/EmailSettingsPanel.tsx |
| Auth | Email template editing | **DONE** | lib/email/template-kinds.ts, app/api/projects/[id]/email/templates/[kind]/route.ts, components/auth/EmailSettingsPanel.tsx |
| Storage | Buckets and objects | **DONE** | app/api/v1/[projectId]/storage/upload/route.ts, lib/services/storage.ts, components/storage/StorageWorkbench.tsx |
| Storage | Per-bucket access policies | **PARTIAL** | Buckets carry a public/private flag and nothing finer. There is no per-bucket policy model, so access cannot be expressed per role, per path or per operation the way RLS expresses it for tables. Present: lib/services/storage.ts. |
| Postgres admin | Index management | **DONE** | app/api/database/indexes/route.ts, app/app/projects/[id]/database/page.tsx |
| Postgres admin | Extension allowlist provisioning | **REAL_GAP** | absent: backend lib/services/extensions.ts, ui components/database/ExtensionsPanel.tsx |
| Postgres admin | Enums and domains | **REAL_GAP** | absent: backend lib/services/enums.ts, ui components/database/EnumsPanel.tsx |
| Postgres admin | Arbitrary roles and grants | **INTENTIONAL** | Deliberate. Roles are cluster-global and the platform issues scoped credentials through governed actions; hand-editing grants would let a dashboard user dismantle the tenant boundary the platform relies on. |

`BACKEND_ONLY` is the class this program exists to find: a working
backend nothing calls. Both cross-tenant defects found so far lived
in routes with no UI, because nothing ever exercised them.

<!-- END DERIVED REGISTER -->
## Recovery: two products, and what each does not cover

**Contract frozen 2026-09-19, before implementation.** `lib/recovery/contract.ts`
is the source; `tests/unit/recovery-contract.spec.ts` pins it.

This is where a platform accidentally promises more than it restores. An
operator who clicks something called "Backup" and concludes their server is safe
has been misled by the product, not by their own carelessness. So there are
exactly two things, they are never conflated, and the UI never says a bare
"Backup".

| | **Database snapshot** | **Deployment recovery** |
|---|---|---|
| Scope | one workspace schema | the whole self-hosted installation |
| Contains | tables, rows, indexes, constraints, RLS, in-schema triggers/functions | platform DB, every workspace schema, storage objects, function definitions, project secrets, operator ownership, deployment metadata |
| Does NOT contain | storage files, platform accounts, API keys, project config/env, function source, deployment config | — |
| Honest description | schema/data rollback and portability | **disaster recovery** |

### Three decisions worth recording

**The component list is machine-readable, and absence is meaningful.** A bundle
written before storage support existed would otherwise be indistinguishable from
one whose storage was empty, and a restore would silently produce a deployment
missing files nobody knew were gone. A present-but-empty component records zero
items; an unsupported one is absent. Only the second is ambiguous, and the
manifest removes the ambiguity.

**The recovery credential never enters the bundle.** A bundle holding both the
encrypted secrets and the key that opens them is not encrypted; it is a tarball
with a lock painted on it. Sensitive sections use a per-bundle data key, wrapped
by an operator-held credential kept outside the archive. Losing the bundle alone
discloses nothing.

**Validation completes before anything is touched.** The restore order is
dependency-ordered and every validation step precedes every mutating one — a
property the tests assert rather than describe. The workspace backup path
learned this the expensive way: it dropped a schema and then discovered the dump
was unreadable, which is terminal however loudly it fails afterwards.

`verify-health-and-integrity` is deliberately last, so "recovery succeeded" is a
claim about the restored system rather than about a command exiting 0.

### Two semantics locked with the format

**Durable credentials survive; ephemeral ones must not.** The line is not
"secret vs not secret" — it is whether something outside the deployment depends
on the value continuing to exist.

Project signing secrets, anon keys, API keys, OAuth configuration and project
env are embedded in client bundles, CI pipelines and other people's code. A
recovery that issued fresh ones would be technically "restored" and would break
every caller, which is not recovery in any sense the operator meant.

Sessions, password-reset tokens, magic links, email verifications, the token
blacklist and the setup token are the opposite: one-time or time-bounded proofs
of a moment. Restoring a week-old bundle must not resurrect a session somebody
revoked or a reset link already used. **Identity is durable; having been logged
in is not** — a user's account and password hash come back, and they sign in
again.

The setup token is worth naming: its whole purpose is to claim an *unclaimed*
deployment, so restoring it into a claimed one would reintroduce exactly the
credential the claim consumed.

**Restore runs quiesced.** A half-restored deployment describes a state that was
true in the past, and anything acting on state autonomously will act on that
description — where the actions reach the outside world and cannot be taken
back. Webhook delivery would re-send events recipients already processed; email
would re-send verifications; cron and background jobs would re-run completed
work; function invocation would bill and mutate; and autonomy would observe a
deliberately partial schema, diagnose it as broken, and *repair* it — fighting
the restore step by step.

All six stay off until `verify-health-and-integrity` has **completed**, not
until the last write finishes. The tests assert that a subsystem may not start
after some earlier step merely completed, because that is the shape that lets
autonomy loose on a partial deployment.

### Built and proven, 2026-09-19

Export and restore both run against a real database. 118 assertions across six
suites, four of which need Postgres.

| Property | How it is proven |
|---|---|
| The bundle discloses nothing without the credential | A canary is planted in the database and must appear nowhere in the bundle's bytes as utf8, base64 or hex, across every file including the manifest — **and must appear once opened**, so the search is known to work |
| Ephemeral credentials do not come back | A live session and a magic link are planted, then their tables come back present and empty. Each has a paired assertion that the source really held the row |
| Durable credentials come back intact | The project signing secret is compared byte-for-byte on the restored machine |
| Revocation survives | A revoked JTI is still in the denylist after recovery |
| A bad archive cannot damage a live deployment | A marker row is written into a running target; a corrupted bundle and a wrong credential are both refused, both report the target untouched, and the marker is still there |
| A good archive replaces rather than merges | Rows written after the bundle are gone from both the platform and workspace schemas; restoring twice lands in the same place |
| The data plane still works afterwards | PostgREST roles exist and the workspace grants survived, with a paired assertion that the source had them to lose |

**Recovery is onto a database created empty seconds earlier.** A restore test
run against the source machine can silently borrow roles, extensions and schema
from the environment, and proves nothing.

Three corrections came out of building it, each recorded in the commit that made
them:

1. **The denylist was on the drop list.** End-user JWTs are stateless and signed
   with the project secret, which recovery carries, so a token revoked before
   the bundle was written still verifies afterwards. `_token_blacklist` is the
   only thing that refuses it, and the middleware reads a missing table as "not
   blacklisted" — it fails **open**. Now carried.
2. **Encrypting only `project-secrets` was theatre.** The platform dump beside
   it holds `Project.jwtSecret`, every password hash and every provider
   credential in the clear. Everything is sealed now except
   `deployment-metadata`, which stays readable so a bundle can be identified
   before anyone fetches the credential.
3. **The privileges asymmetry.** Platform dumps drop privileges; workspace dumps
   keep them. `--no-privileges` on a workspace would give a restore that looks
   complete and whose data plane returns nothing — and whose DEFAULT PRIVILEGES
   are gone, so tables created later are invisible to PostgREST too. That
   surfaces days later, attached to nothing.

### Bad paths, all seven covered

| Path | Behaviour |
|---|---|
| Corrupt manifest | Refused; target untouched |
| Missing component file | Refused, naming the component; target untouched |
| Failed checksum or truncation | Refused before the credential is used at all |
| Wrong recovery credential | Refused; message names both possible causes, since GCM cannot distinguish them |
| Unsupported (newer) format version | Refused rather than partially restored |
| Interrupted restore | Idempotent — restoring the same bundle twice lands in the same place |
| Insufficient privileges | Fails, names the step, and honestly reports the target as possibly touched |

A component **re-encrypted under a different key** is also refused. Checksums
alone would accept it — the file is intact, it is simply not the file that
belongs there — so the GCM tag is what catches substitution.

Corruption is reported ahead of a wrong credential deliberately: an operator
should learn a bundle is damaged without first having to go and find their
credential.

### Extraction is the one step the archive controls

Everywhere else in a restore this code decides what happens. In a tar, the entry
names the destination, and an extractor that trusts the name writes wherever it
is told. So the reader is written in-repo rather than taken from a library,
absolute names are **refused rather than stripped** (this exporter only writes
relative names, so an absolute one means the archive did not come from it), and
an archive with one bad entry is refused whole rather than partially trusted.

The traversal test forges tar headers byte by byte, because `archiver`
sanitises the names that make an archive dangerous — an archive it produced
could never carry the attack, so a test built with it would assert nothing.

### Shipped, and named apart

Both products are un-gated and reachable.

| | Project database snapshot | Deployment recovery |
|---|---|---|
| Covers | one project's tables, rows, indexes, constraints, RLS policies | the whole machine: platform database, every workspace schema, storage, functions, secrets, ownership |
| Excludes | stored files, platform accounts, API keys, project config, function source | nothing needed to rebuild on clean hardware |
| Lives in | Database → Snapshots | Settings → Recovery |
| Restore | in the dashboard, behind a dialog naming the snapshot's timestamp | **`npm run recovery -- restore`** |

There is no control anywhere labelled just "Backup". The word is the problem:
an operator who sees it and concludes their server is safe has been misled by
the product, not by their own carelessness.

**Restore of a deployment is a command, not a button, and that is the design.**
On the day you restore, this dashboard is part of what you lost — there is a new
machine, a checkout, a bundle and a credential. A restore that can only be
started from the thing you no longer have is not a recovery product. Export
stays in the dashboard because export happens while the deployment is healthy,
which is when somebody is looking at it.

**Deployment recovery is refused in Cloud by edition, not by permission.** It
reads every tenant's projects, users and secrets. Self-hosted that is right —
the single account is the operator of the machine. In Cloud it would be one
tenant exporting everybody, and no role makes that acceptable, so the check is
one nobody can satisfy by being granted more. It runs *before* authentication
and answers 404, since a 401 would tell an unauthenticated caller the capability
exists.

**Scheduled snapshots stay opt-in off Cloud** (`BACKENLY_SCHEDULED_SNAPSHOTS`).
Not because they are a Cloud feature, but because enabling them would start
writing a dump of every project to `BACKUP_DIR` daily, on every existing install,
at upgrade.

### Still to build

Nothing in this tranche. Storage objects are carried and restored; the remaining
gap is off-box copies, which the product states rather than solves — the panel
prints the bundle path next to the fact that a backup living only on the machine
it protects is not a backup.

## Webhooks: the backend that nothing called

The register said BACKENLY_ONLY. The truth was worse, and only visible by
looking for the caller: `triggerWebhooks()` had **no call site anywhere in the
tree**. HMAC signing, a five-attempt retry ladder, dead-lettering, notification
on exhaustion and a cron pass that processed retries were all real, all correct,
and unreachable. The event strings `row.inserted`, `row.updated`, `row.deleted`
and `auth.user.created` appeared in exactly two places: the type union that
declared them and the route validator that rejected one of them.

So this tranche is not a UI over a working feature. Most of it is the event.

### Capture belongs in the database

PostgREST is the only data plane. An end user's INSERT reaches Postgres over
:3002 and the Next process never sees it, so an inline `triggerWebhooks()` call
in a route handler would fire for the dashboard's own table editor and stay
silent for every write the product exists to serve — working in a demo and not
in production. The only component that observes every writer is Postgres.

### An outbox, not the realtime NOTIFY

Reusing realtime's `pg_notify` capture was the first instinct and is wrong here,
for the reason realtime's own header states: *events during the outage are lost
— clients needing gapless data must re-fetch via REST.* That is the right trade
for a live view a human is watching and the wrong one for a webhook, because a
receiver cannot re-fetch, it can only never be told. pg_notify also truncates
past ~8000 bytes.

The trigger therefore writes a row into `_backenly_webhook_outbox` in the
workspace schema. It commits with the transaction that caused it — a rolled-back
INSERT produces no event, which NOTIFY cannot promise — and survives restarts. A
drain in `runSystemTasks` turns outbox rows into `WebhookLog` rows and hands them
to the delivery ladder that already existed.

Triggers are installed only while the project has an active row webhook, and
come off when the last one is disabled or deleted. A feature nobody enabled
costs nothing. The outbox **table** is deliberately left behind on delete,
because it may still hold undelivered events.

Delivery is **at-least-once** and says so: every request carries
`X-Webhook-Delivery` and an `outboxId`, because a crash between claiming and
logging is put back by the reclaim window. Claiming uses `FOR UPDATE SKIP
LOCKED`, so two web processes draining one project take disjoint work.

### `auth.user.created` is emitted by the signup route, on purpose

The `users` table carries no capture trigger. It holds the bcrypt hash, and
realtime shipped exactly that leak for months by broadcasting `row_to_json(NEW)`
from it. The same `isAuthManagedTable` predicate excludes it here, imported
rather than restated. The signup route builds the payload field by field from a
fixed list, so a future migration that adds a credential column cannot widen it.

### A HIGH: webhook delivery was an SSRF with a persistence layer

`deliverSingleAttempt` called bare `fetch(targetUrl)` from the unsandboxed web
process on a URL the caller supplies, and stored up to 1 KB of the reply in
`WebhookLog.responseBody`. The reachable set was the PostgREST data plane on
loopback:3002, the runtime on :3001, the whole VPC, and 169.254.169.254.

`lib/security/outbound-guard.ts` already covered every part of this for the
function runtime — scheme, literal address, connect-time DNS so a rebind cannot
win the race, each redirect hop re-validated, response size cap — and webhooks
simply did not use it. They do now.

Webhooks get their own opt-in, `BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE`, rather
than sharing the function one. "My webhook may post to the container beside me"
is the operator's decision about a destination they typed; "generated function
code may reach my LAN" is a different decision about untrusted code, and a
self-hoster who wants the first should not have to grant the second. Link-local
stays blocked under both, because no deployment has a reason to let either read
the instance credentials.

Validation runs at write time *and* at delivery. Neither is redundant: the first
tells an operator their URL is unusable while they are looking at the form, and
the second is the boundary, because a hostname that is public today can point
somewhere else tomorrow and nothing re-validates a stored row. A destination the
guard refuses fails **terminally** rather than burning five retries on an answer
that cannot change.

### Smaller defects fixed in passing

- `row.updated` was in the type and rejected by the only route that could create
  one. Both now read `lib/webhooks/events.ts`, so the surfaces cannot drift.
- `getWebhookLogs(webhookId)` took a child id with no tenant context. Every
  service function now takes `(projectId, webhookId)` and there is no overload
  that does not.
- `/api/webhooks/[id]/logs` had no project in its path and hand-wrote its own
  ownership predicate, which in Cloud answered differently from
  `canAccessProject`: an organization ADMIN could administer the project and not
  read its webhook logs. Replaced by `/api/projects/[id]/webhooks/[webhookId]/logs`.
- `parseInt(searchParams.get('limit'))` reached Prisma as `take: NaN` for
  `?limit=abc` and as an unbounded read for `?limit=9999999`. Clamped.
- Per-webhook operations moved from `?webhookId=` to the path, so the id being
  authorized and the id being acted on are the same string.

### What is proven, and by which suite

`tests/integration/webhook-delivery.spec.ts` (17 assertions, real Postgres, real
HTTP receiver on loopback): capture installed and removed with subscription
state; `users` never captured while a sibling table is; INSERT/UPDATE/DELETE each
recorded with the operation that fired and the previous values; a write made on
a **separate connection that never touches application code** captured, which is
the PostgREST case; end-to-end delivery whose HMAC is verified **over the bytes
that arrived** and which fails under a different key; a 503 receiver recorded as
RETRYING with its status code; a disabled endpoint silent while an enabled one
beside it receives; a real test delivery reporting the receiver's real answer for
both 200 and 500; `auth.user.created` carrying no credential material; and every
egress refusal stated beside a delivery that succeeds under the same setup.

The suite fails on all 17 without a database and passes on all 17 with one,
which is the entry requirement for `.github/database-backed-suites.txt`.

`tests/e2e/selfhost/webhooks.spec.ts` proves the surface rather than delivery:
that the form writes through the real API, that the write survives a reload,
that the signing secret is shown once and is then absent from the page, that a
refused destination surfaces the guard's real reason and stores nothing, and
that an endpoint which has never fired says so instead of rendering an invented
history.

## Auth: the limiter's store, and mail nobody could configure

Three rows, one area. Each was real and unreachable in a different way.

### The limiter's counters were per-process

`assertRateLimitStoreSupportsTopology` already refused to boot a deployment that
declared more than one instance on the in-memory store. That closed the gap and
offered no way across it. A shared Redis store now exists, so horizontal scaling
is possible without the effective limit silently becoming (limit x instances).

**Self-host is unchanged and needs no Redis.** It is single-tenant and runs one
web process, where per-process counters are not a degraded substitute but the
correct shared state, because there is only one process. The default is still
`memory`, Redis stays out of the golden compose, and the invariant is enforced
rather than documented:

    memory store        =>  exactly one application instance
    more than one       =>  shared Redis store required

**An unreachable store DENIES.** Never a fallback to per-process counters. Code
only reaches that path having declared several instances, so the fallback would
hand out (limit x instances) at exactly the moment the store is most likely to
be struggling because an attack is underway.

**429 and 503 are different answers**, because they are facts about different
systems. "You have made too many attempts" and "we cannot currently tell how
many attempts you have made" collapsed into one 429 accuses an innocent caller,
hands a well-behaved client a `Retry-After` describing a window nobody counted,
and hides an outage inside a metric operators read as users hitting limits. A
store outage answers 503 `RATE_LIMITER_UNAVAILABLE` with a short retry, and does
not name the backing service to an unauthenticated caller.

**Readiness is explicit** and **recovery is automatic**: the limiter waits for
`ready` within the same bounded budget as the round trip, and latches no failed
state, so it resumes when Redis does with no restart. `/api/health` reports the
store, its readiness and the last error message — deliberately *alongside*
`checks` rather than inside it, because a limiter outage is not a reason to pull
every instance out of the load balancer and turn an auth outage into a total one.

Startup proves the store rather than trusting the setting: it connects, pings and
**writes** a probe key, because a read-only replica answers PING and silently
drops every INCR, leaving a limiter that never denies.

A defect found while wiring it: `enableOfflineQueue: false` rejects every command
issued before the connection is ready, including ioredis's own HELLO. Combined
with failing closed that is an auth outage on every deploy and every reconnect,
reported as a rate-limit denial.

### Two enumeration oracles in end-user sign-in

Both exploitable with no credentials.

`is_blocked` was checked BEFORE the password was verified, so anyone could submit
any address with a junk password and learn from the 403 both that the account
exists and that it is suspended. And an unknown address returned immediately
while a real one first paid for a bcrypt comparison: the messages matched, the
timing did not, and bcrypt is slow enough that the gap is measurable in a handful
of samples.

The decoy hash is derived from `BCRYPT_ROUNDS` rather than pasted in, because a
hard-coded cost-10 digest beside a cost-12 product is four times cheaper and
leaves the oracle open behind a mitigation that looks present.

Pinned by tests verified to catch the regression: reintroducing the defect turns
the blocked-account case from 401 to 403 and the suite red.

### SMTP and templates: real, and unconfigurable

A transport read `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` from deployment-wide env, so
an operator could not change mail settings without editing `.env` and restarting,
and a Cloud tenant could not send from their own domain at all. Subjects and
bodies were string literals in TypeScript.

Both are now **overrides, not replacements**. An enabled project SMTP config
wins; anything else falls through to the environment. A template row replaces one
built-in; absence means the built-in. An install that upgrades and configures
nothing behaves exactly as it did.

`enabled` exists so settings survive being switched off, rather than forcing an
operator to retype a password they cannot read in order to switch back.

**The password is write-only.** AES-256-GCM through the scheme
`database_credentials` already uses. No route returns it, and the view type has no
field that *could* carry one — not a field that is usually empty. A row that
cannot be decrypted, which is what a rotated `MASTER_ENCRYPTION_KEY` looks like,
**refuses to fall back** to the deployment environment: sending a project's mail
from an identity the operator did not choose is worse than not sending it, and
falling through would hide the rotation.

**"Configured" is never reported as "works".** Every field can be right and the
credentials still wrong, the port blocked, the sender unverified. So the row
records the last REAL send attempt, saving clears it, and the panel shows
"never tested" rather than a tick.

**A malformed template cannot break an auth flow.** Placeholders are an
allowlist checked at save, `{{ctaUrl}}` is required, and a `<script>` tag is
refused outright — no mail client would run it, so its only possible audience is
the dashboard preview. At send time a template that renders empty, or produces no
action link, falls back to the built-in and **says so in the log**, because a
quiet fallback is how a project sends default wording for months while the
dashboard shows a template nobody is using.

The preview is the dangerous surface, not the email: it is returned as data and
rendered in an iframe with an empty `sandbox` attribute, so operator HTML cannot
run against an authenticated session even if the `<script>` refusal were later
relaxed. Substituted values are escaped in the body and newline-stripped in the
subject, where a newline is header injection.

### What is proven, and by which suite

`tests/integration/rate-limit-shared-store.spec.ts` (17, real Redis 7): two
independently constructed limiters spend ONE budget; 20 concurrent attempts
across both admit exactly 8 of 8; per-key isolation; the window expires; an
unreachable store reports `store_unavailable` and a limit of 1 denies the FIRST
call, which a fresh local bucket would have allowed; recovery through a real TCP
proxy closed and reopened, resuming on the same counter; 503 for an outage and
429 for a limit. It FAILS without `REDIS_URL` rather than skipping.

`tests/integration/signin-enumeration.spec.ts` (8, real database, real bcrypt,
the actual route handler): matched status and body across unknown, wrong-password
and suspended accounts; suspension disclosed only after the password is proven;
a floor on the work the route spends for an address that does not exist.

`tests/integration/project-smtp-and-templates.spec.ts` (28, real database and a
real SMTP server over a real STARTTLS handshake): mail that actually left, with
the project's own AUTH credentials and envelope sender read off the wire;
precedence and fallback; the ciphertext is not the plaintext in any encoding;
the decryption refusal; a rejecting server reported as a failure; template
override delivered; broken templates falling back with a reason; value escaping
and subject header injection.

The SMTP sink generates a throwaway certificate with `openssl` per run rather
than committing a PEM key, which the OSS preflight would rightly fail the build
over, and the suite TRUSTS that one certificate rather than setting
`NODE_TLS_REJECT_UNAUTHORIZED=0` — which would disable verification for every
suite sharing the process and could hide a genuine TLS fault elsewhere in the
same job.

### Still PARTIAL in Auth

Nothing. The remaining PARTIAL row is Storage's per-bucket policies.

## Surface integrity, verified 2026-09-19

Every surface self-host shows was walked in a browser against the deployment
`npm run selfhost` builds, with the API calls each page made recorded and
checked. Source review cannot settle this: a page can import the right module,
call the right route, and still render an error boundary or paint a success
message over a failed request.

**Result: zero DEAD/RETIRED, PLACEHOLDER/MOCK, Cloud-only-as-visible or BROKEN
surfaces.** All twelve navigable surfaces load, no page calls a removed
endpoint, none receives a server error.

| Class | Finding |
|---|---|
| WORKING | all 12 nav destinations, backends answering |
| HONEST_EMPTY | logs and schema history on a fresh install state they are empty rather than inventing rows |
| CLOUD_GATED | branches, absent from sidebar AND command palette, with page-level `notFound()` behind them |
| DEAD/RETIRED | none remain — `connect/handshake`, `example-protected`, `test-services` and `app/connect/[provider]` were deleted |
| PLACEHOLDER/MOCK | none found; the only `hardcoded` references in the tree are comments recording its removal |
| BROKEN | none |

Two things worth recording, because both were nearly missed:

`app/connect/[provider]` called a handshake endpoint that had been retired to a
410, so the page could only ever display "Connection failed". A UI control
pointing at a deliberately dead backend is the exact shape this sweep exists to
find, and it had survived because nothing linked to it.

The realtime surface initially "passed" while proving less than its siblings.
It holds an EventSource open, so waiting for network quiet timed out, the catch
swallowed it, and the assertion never ran. It now asserts the stream opened.

**The PARTIAL rows do not over-promise.** Storage offers no per-bucket policy
editor and the auth page offers no SMTP or template editing, so those remain
product gaps rather than surface-integrity defects — the UI does not claim what
the backend cannot do.



---

## What was actually run

Supabase self-hosted was installed and driven, not read about.

| Step | What happened |
|---|---|
| Install | `sh supabase/docker/setup.sh -y --skip-deps --head --project-dir supabase-project`. One command: generated every secret and both key pairs, pulled all images, wrote `.env`, stamped `.supabase-version`. |
| Run | `docker compose up -d` in three deliberate passes (core → data plane → edge), so service-to-feature dependencies could be observed rather than assumed. |
| Fixture | 7 base tables across two schemas, an enum, a domain, a view, a materialized view, a **self-referencing FK**, a **deliberate cyclic FK pair**, composite PK, GIN indexes, a trigger, and 6 RLS policies of differing shapes (`auth.uid()`, `EXISTS` subquery, role-targeted `anon` / `service_role`). |
| Drive | 111 concrete Studio routes swept for HTTP status; 70 routes rendered in a real headless browser with network interception and screenshots. |

Environment: Docker 29.1.3 inside WSL2 (`backenly-builder`), 4 vCPU, 5 GB cap.

### Measured resource cost

Supabase documents **4 GB RAM minimum, 8 GB recommended**
(`apps/docs/content/guides/self-hosting/docker.mdx`). Measured reality was far
lower, because analytics is off by default:

Their compose defines **11 services**; 10 were run. The one never started is
`supavisor`, the connection pooler, which nothing in this comparison needed.
(`db-config` and `deno-cache` look like services in a casual read of the compose
file but are named *volumes*.)

| Pass | Services | Measured RSS |
|---|---|---|
| A — core | db, api-gw, studio, meta, rest, auth (6) | **526 MB** |
| B+C — full | \+ storage, imgproxy, realtime, functions (10) | **1.26 GB** |

Heaviest single container: `studio` at 397 MB. This matters for the comparison:
the documented figure overstates what self-hosting actually costs, and Backenly
has no equivalent published figure at all.

---

## Admissibility rules

Four independent methods. **A claim is only listed as confirmed when two of them
agree.** Single-source claims are marked `SUSPECTED` and are not used downstream.
This is the discipline `docs/structural-probe-inventory.md` already applies to
autonomy probes — a probe existing is not the same as a probe being evidence.

1. **`IS_PLATFORM` source gating.** Self-hosted mode is `NEXT_PUBLIC_IS_PLATFORM`
   unset (`apps/studio/lib/constants/index.ts`). 719 references across 305 files.
   Mechanically complete, but over-reports cosmetic gates.
2. **Feature-flag manifest.** `packages/common/enabled-features/enabled-features.json`
   (~90 flags) plus `ENABLED_FEATURES_*` runtime overrides.
3. **Platform API calls.** Any Studio request to an endpoint the self-hosted
   stack does not serve. Strongest signal, because it is behavioural.
4. **Hands-on rendering.** Headless Chromium against the running stack.

**A methodological finding worth keeping:** HTTP status alone proves nothing
here. 109 of 111 Studio routes return **200** when curled, because Studio is a
client-rendered SPA and all gating happens in the browser. Anyone comparing
dashboards by curling routes will conclude every feature is present. Method 4
is not optional.

---

## Part 1 — Supabase Cloud vs Supabase self-hosted

This is the founder's first question, and it is mostly a **subtraction list**:
it defines what must be struck from Part 2's scope, not what Backenly should build.

### Cloud-only (confirmed, ≥2 methods)

| Capability | Method 1 (source gate) | Method 3/4 (observed) |
|---|---|---|
| **Database Backups** (scheduled) | `IS_PLATFORM && { name: 'Backups' }` in `components/layouts/DatabaseLayout/DatabaseMenu.utils.tsx` | `404 /api/platform/database/default/backups` |
| **PITR** | same "Platform" menu group | `404 …/backups`; page renders, stays empty |
| **Restore to new project** | same | `404 …/clone`, `404 …/projects/default/disk` + markers "not available", "upgrade" |
| **Replication / read replicas** | `IS_PLATFORM && showPgReplicate && { name: 'Replication' }` | `404` × 3 on `/api/platform/replication/default/{sources,pipelines,destinations}` |
| **Compute & Disk** | `computeEnabled` false ⇒ nav item absent (`NavigationBar.utils.tsx`) | `404 /api/platform/projects/default/databases-statuses` |
| **Billing / Usage / Subscription** | Billing group only in the platform branch of `SettingsMenu.utils.tsx` | `404 /api/platform/organizations/default-org-slug/…`; redirects to `/org/default-org-slug/usage` |
| **Storage settings** | — | verbatim in-page: *"Storage settings are not available for self-hosted projects."* |
| **Third-party auth config** | — | `404 /api/v1/projects/default/config/auth/third-party-auth` |
| **Log Drains** | `project_settings:log_drains` flag | `500 /api/platform/projects/default/analytics/log-drains` |
| **Organizations / members / multiple projects** | single hard-coded ref | Studio redirects `/` → **`/project/default`**; org slug is the literal `default-org-slug` and 404s |
| **Branching** | needs `project.is_branch_enabled` from the platform API | page renders with *"GitHub connection — Not connected"*; no way to enable |
| **Realtime Settings** | `showRealtimeSettings = IS_PLATFORM` (`RealtimeMenu.utils.ts`) | nav item absent |
| **Health Advisor** | `IS_PLATFORM` in `AdvisorsMenu.utils.tsx` | absent; Security/Performance advisors remain |
| **Observability (full)** | self-hosted link rewritten to `/query-performance`; "API Gateway", "Storage" reports and the whole `PRODUCT` section are `IS_PLATFORM` | degraded menu |

The cleanest single artifact is `SettingsMenu.utils.tsx`, which contains a literal
`if (!IS_PLATFORM) { return [...] }` early return. Self-hosted Project Settings =
**General, API Keys, JWT Keys, Data API, Vault**. Cloud additionally gets Code
configuration, Infrastructure, Integrations, Webhooks, Add-ons, Dashboard, Billing.

### Requires an opt-in override

**Logs / Log Explorer / Reports.** Logflare + Vector are *not* in the base
compose; they live in `docker-compose.logs.yml`, enabled by `sh run.sh config add logs`.
The shipped compose sets `ENABLED_FEATURES_LOGS_ALL: "false"`, which removes the
entire Logs section from the nav (`logsEnabled` in `NavigationBar.utils.tsx`).
Corroborated by `500` on
`/api/platform/projects/{ref}/analytics/endpoints/logs.all` when visiting
`/logs/postgres-logs`.

This is a **three-method agreement** (flag + source + observed) and is the single
largest out-of-the-box difference in day-to-day use.

### A genuine self-hosted bug

`/project/default/settings/webhooks` redirects to
**`/project/undefined/settings/general`** — a broken ref. Worth knowing before
anyone cites Supabase self-hosted as flawless.

### Present and fully working self-hosted

Important, because these are the real bar for Part 2 — not the Cloud feature list:

SQL Editor (+ templates, file-backed snippets) · Table editor · **RLS policy
editor** · Roles · Column privileges · Extensions · Indexes · **Publications** ·
**Enumerated types** · Triggers · Database Functions (PL/pgSQL) · Schema
Visualizer · **Migrations** · Auth (users, providers, email templates, SMTP, MFA,
hooks, rate limits, sessions, audit logs, passkeys, OAuth server) · Storage
(file browser, **per-bucket policy editor**, **S3 protocol config**, vectors) ·
Realtime (inspector, **channel policies**) · Security & Performance Advisors ·
API docs (now at `/integrations/data_api/docs`) · **Vault**.

### Architecture notes that matter for comparison

- **Only two containers publish ports**: Envoy (`8000`) and Supavisor
  (`POSTGRES_PORT`, `6543`). The `db` container publishes **nothing** — direct
  Postgres access goes through the pooler. Backenly publishes Postgres directly
  and hands out `psql` strings via `DirectDatabasePanel`.
- **The gateway is Envoy**, not Kong. Kong is now an optional override. Envoy's
  RBAC filter blocks the PostgREST OpenAPI root (`GET /rest/v1/` → 403
  `RBAC: access denied`) even with a valid key.
- **Studio is behind HTTP Basic auth** at the gateway, with one shared
  `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`. There are no user accounts, no
  roles, no 2FA in self-hosted Studio. Backenly has real platform accounts with
  TOTP 2FA (`app/api/auth/2fa/**`).
- **Two key models coexist**: legacy HS256 `ANON_KEY`/`SERVICE_ROLE_KEY` and new
  opaque `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY` backed by ES256
  `JWT_KEYS`/`JWT_JWKS`. Both authenticated successfully against `/auth/v1/health`.
- Data plane verified against the fixture: RLS enforced (anon got `[]` on
  `profiles`, rows on `memberships`), FK embedding works, and a schema outside
  `PGRST_DB_SCHEMAS` is invisible (`PGRST205`). Backenly reaches the same outcome
  through a registry table rather than an env var.

---

## Part 2 — Supabase self-hosted vs Backenly self-hosted

Scope: everything in the Part 1 subtraction list is **excluded**. Comparing
Backenly against Supabase Cloud would measure it against features Supabase
itself withholds from self-hosters.

State vocabulary: `full` · `degraded` · `absent` · **`backend-present-ui-absent`**
(Backenly only — route and service layer exist, nothing in the dashboard calls them).

| Capability | Supabase SH | Backenly SH | Backenly evidence | Δ |
|---|---|---|---|---|
| Table browser / row CRUD | full | full | `app/app/projects/[id]/database/page.tsx` | — |
| Create table | full (columns, types, FKs at creation) | degraded (name + description only; id/timestamps auto) | `database/page.tsx:2245` | gap |
| Add column: default / unique / check | full | absent in UI (name + 8 types + nullable) | `database/page.tsx:2124` | **ui-absent** |
| **Foreign-key picker** | full | **backend-present-ui-absent** | `addConstraint` `lib/api/database.ts:531`; route `app/api/database/schema/constraints/route.ts`; **0 callers** | **ui-absent** |
| Relationships data | full | full (ERD) | `components/database/EnhancedSchemaVisualizer.tsx:250` fetches the route directly | — |
| Schema visualizer / ERD | full | full | `EnhancedSchemaVisualizer.tsx` | — |
| **SQL editor (read)** | full | absent (`@monaco-editor/react` declared, **0 imports**) | CLI `backenly query` + `lib/mcp/read-query.ts` only | gap |
| SQL editor (DDL/writes) | full | absent **by policy** | `AGENTS.md` | **class (b)** |
| Saved snippets / query history | full | absent | — | gap |
| **RLS policy editor** | full | absent (agent-only `set_rls`/`add_rls`) | `lib/ai/brain/tools.ts:1216` | **class (b)** |
| Roles & grants | full | 2 fixed roles only | `lib/services/direct-access.ts` | partial |
| Extensions UI | full | absent | — | gap |
| Publications / logical replication | full | absent (uses `pg_notify`) | `lib/services/realtimeTriggers.ts` | gap |
| Enumerated types / domains | full | absent | — | gap |
| Triggers (raw `CREATE TRIGGER`) | full | app-level triggers only | `lib/services/trigger-service.ts` | partial |
| DB functions (PL/pgSQL) | full | absent | — | **class (b)** |
| Indexes | full | read-only badge; creation agent-only | `database/page.tsx:648` | partial |
| Migrations UI | full | absent (ledger APIs, no page) | `app/api/projects/[id]/schema-versions/route.ts` | **ui-absent** |
| Auth: users list | full | read-only | `components/auth/AuthWorkbench.tsx` | partial |
| Auth: providers | many | **2** (Google, GitHub) | `components/auth/AuthConfiguration.tsx:62` | gap |
| Auth: email templates | full editor | hardcoded HTML | `lib/services/end-user-auth-email.ts` | gap |
| Auth: SMTP / rate limits / MFA / hooks / sessions / audit | full | absent | — | gap |
| Storage: buckets + browser | full | full | `components/storage/StorageWorkbench.tsx` | — |
| **Storage: per-bucket policies** | full | absent (binary `isPublic`) | — | gap |
| Storage: S3 protocol | full | absent | — | gap |
| Image transformation | on-the-fly (imgproxy) | fixed 200×200 thumbnail at upload | `lib/storage/image-processor.ts` | gap |
| Edge functions: list | full | full | `components/functions/FunctionsWorkbench.tsx` | — |
| Edge functions: view code | full (read-only) | **absent** | no source ever displayed | gap |
| Edge functions: create/deploy from UI | **absent** (drop file + restart) | absent (routes to `/connect`) | `FunctionsWorkbench.tsx:621` | — (parity) |
| Edge functions: invoke/test in UI | absent | **full** | test runner + invocation history | **Backenly ahead** |
| Realtime: inspector | full | full | `components/realtime/RealtimeWorkbench.tsx` | — |
| Realtime: channel policies | full | absent | — | gap |
| **Logs explorer** | requires override | **backend-present-ui-absent** | `app/api/logs/route.ts`, 8 filters, **0 callers** | **ui-absent** |
| Metrics / latency charts | needs Logflare | full, no extra service | `components/monitoring/MonitoringWorkbench.tsx` | **Backenly ahead** |
| Advisors | security + performance | findings queue + auto-fix | `components/workspace/AdvisorBlock.tsx` | different shape |
| **Backups / restore UI** | **cloud-only** | **backend-present-ui-absent** | `app/api/projects/[id]/backup/route.ts` GET/POST/PUT, **0 callers** | **cloud-only** since Part 7; restore still broken (Part 6) |
| PITR | cloud-only | absent | — | — (parity) |
| Branching | cloud-only | **cloud-only** (removed from self-host 2026-09-17, Part 7) | `lib/branches/engine.ts` | — (parity, by decision) |
| **Webhooks UI** | cloud-only | **backend-present-ui-absent** | `app/api/projects/[id]/webhooks/route.ts`, **0 callers** | **ui-absent** |
| Cron jobs UI | via pg_cron | agent-only | `lib/services/cron-runner.ts` | gap |
| API docs per table | full | OpenAPI + types download only | `app/app/projects/[id]/connect/page.tsx:186` | gap |
| Vault | full | absent as a surface | — | gap |
| Dashboard auth | shared basic auth | real accounts + TOTP 2FA | `app/api/auth/2fa/**` | **Backenly ahead** |
| Autonomy / self-healing | absent | full | `lib/autonomy/**` | **Backenly ahead** |
| MCP / agent surface | MCP interface folder | 20-tool catalog, primary door | `lib/ai/brain/tools.ts` | **Backenly ahead** |
| **One-command install** | `setup.sh` → `docker compose up -d` | 5-step multi-pass reconciler, 2 host Node processes | `README.md`, `scripts/bootstrap.ts` | **largest gap** |

### The Backenly column is derived, not typed

`scripts/audit-ui-coverage.ts` (added by this work) computes the
`backend-present-ui-absent` set by static analysis — no network, no DB, no build.
Reachability is resolved **per exported function**, not per module, because
`lib/api/database.ts` is imported by the table editor while `addConstraint`
inside it is called by nothing; module granularity would have hidden exactly the
class of gap this audit exists to find.

Current output: **322 API routes, 235 dashboard-facing, 139 with no dashboard caller.**

It was validated against seven hand-checked cases before being trusted. One of
those checks corrected me: I had listed `getRelationships` as proof that
relationships were unused, but `EnhancedSchemaVisualizer.tsx:250` fetches that
route **directly**, bypassing the helper. The helper is dead; the route is live.
The FK gap is `addConstraint`, not relationships.

---

## Part 3 — Gap register

Evaluated in order, first match wins. **(b) is tested first**, so a
governance-violating gap cannot be mis-sorted as cheap UI work.

### Class (b) — deliberate, will not build

These are not gaps. Each entry is the answer to "why doesn't Backenly have what
Studio has", and that answer is the deliverable for the accelerator conversation.

- **SQL editor with DDL/writes.** `AGENTS.md`: *"Never expose SQL writes or DDL —
  mutations go through typed actions so they stay planned, verified and
  reversible."* Studio's SQL editor is an arbitrary-string executor against the
  database. Adopting it would delete the audit trail, the approval path and the
  rollback guarantee that the autonomy loop depends on — and would remove the
  one thing the comparison page currently sells. **The user need behind it is
  real**, so the governed answer is a read-only SQL editor (below), not this.
- **RLS policy editor.** Same rule: policies are DDL. Backenly's equivalent is
  `set_rls`/`add_rls` as typed actions plus missing-RLS detection that proposes
  a fix. A visual editor that emits raw policy SQL re-opens the same hole.
- **Database functions (PL/pgSQL authoring).** Arbitrary server-side code as a
  SQL string. Backenly's functions run in a sandboxed worker with static
  analysis (`lib/services/ai-functions/executor.ts`).
- **Arbitrary roles & grants.** Would make the tenant boundary editable from the
  dashboard. Backenly's two managed roles exist precisely so the boundary is not
  user-authored.
- **Organizations / members / billing UI.** Out of OSS scope by construction —
  `overlay-allowlist.json`, asserted by `__tests__/edition/oss-surface.test.ts`.
  Supabase self-hosted has none of these either, so this is parity, not a gap.
- **Multiple projects per deployment.** Architectural
  (`lib/edition/types.ts`), test-pinned, and **Supabase self-hosted is also one
  project per stack**. Not a gap against the stated target.

### Class (c) — UI only, backend already built

Route + service layer exist, zero dashboard callers, no new Prisma model, and the
route is already a typed action rather than a SQL passthrough.

| Gap | Route | Service |
|---|---|---|
| FK picker + unique/check/default in add-column | `app/api/database/schema/constraints/route.ts` | `addWorkspaceConstraint`, `lib/services/tableLifecycle.ts` |
| Backups & restore panel | `app/api/projects/[id]/backup/route.ts` (GET/POST/PUT) | `lib/services/workspace-backup.ts` |
| Logs explorer | `app/api/logs/route.ts` (8 filters, tenant-isolated) | — |
| Webhooks UI | `app/api/projects/[id]/webhooks/route.ts` | `lib/webhooks/index.ts` |
| Migrations / schema history page | `app/api/projects/[id]/schema-versions/route.ts` | — |

### Class (a0) — defects surfaced by verification, fix before any feature work

> **Closed 2026-09-17:** items 1, 2 and 6-9. **Still open:** 3, 4, 5 and 10.
>
> The dangerous class is done — restore no longer destroys data, and the backup
> privilege contract is documented and proven. What remains open here is
> operator friction and CI hygiene, not data loss.

These were not on any list before the two verification runs. They outrank the
whole tranche because each one makes an existing, shipped promise untrue.

1. ~~**Restore silently destroys the schema it was asked to recover.**~~
   **FIXED 2026-09-17**, see Part 6. The schema is now moved aside rather than
   dropped, psql runs with `ON_ERROR_STOP=1`, an empty result counts as failure,
   and a failed restore rolls the project back. Regression-locked, and the test
   was verified to fail against the old implementation.
2. ~~**Default self-host configuration makes backups unsafe off the Compose path.**~~
   **FIXED 2026-09-17.** `BACKUP_DATABASE_URL` is now documented in `README.md`
   under "Backups" and in `.env.example`, with the minimal DDL. The privilege
   contract is proven rather than asserted by
   `__tests__/services/backup-restore-privileges.test.ts`, which builds a
   `NOSUPERUSER NOBYPASSRLS` application role and a backup role holding
   `CONNECT`, `USAGE`, `SELECT` and `BYPASSRLS` and nothing else. **No SUPERUSER
   is required.** That work also found and fixed a second defect: restore ran
   over the backup connection, so `--no-owner` left the backup role owning the
   restored schema and every table in it — and `FORCE ROW LEVEL SECURITY` keys
   on the owner. The dump now reads on that connection and the restore writes
   on the application's.
3. **`MASTER_ENCRYPTION_KEY` is an undocumented required secret.** A self-hoster
   following the README runs with a zero encryption key and only a log line says so.
   **Lands in tranche 01:** the installer should generate it, or require it and
   refuse to proceed. A zero key must not be a silent default outside development.
4. **The application connects to Postgres as a superuser** on the default Compose
   path. Needs an explicit decision, not a default. **Lands in tranche 01:** the
   installer is where the role model gets decided — elevated bootstrap
   credentials separated from the application credential, with the intended role
   properties regression-tested. The backup work already proved the
   non-superuser path works, so this is a decision, not a capability to build.
5. **Bootstrap's expected path prints four raw Prisma errors before its summary.**
   Cosmetic, but it is the first thing a new self-hoster sees and it reads as a crash.
   **Lands in tranche 01**, which is the only item that rewrites the install path.
6. **A self-hosted deployment serves the cloud marketing site at `/`.** Part 5,
   item 7. Root should resolve to the dashboard (or to login when signed out),
   the way Supabase self-hosted does; the marketing routes should not be built
   or served in a self-host edition at all. This is the first thing anyone sees
   when they open their own install, so it sets the impression of the whole
   product.
7. **The account Usage page is permanently broken on every self-hosted install.**
   `app/app/usage/page.tsx:127` fetches `/api/billing/usage`, but `app/api/billing/**`
   is an overlay-private path (`overlay-allowlist.json:43`) that does not exist in
   the OSS build, so the page always renders "Could not load usage data."
   Meanwhile `app/api/usage/route.ts` **does** exist and returns correct data
   (`"plan":"SELF_HOSTED"`, real storage figures). The page calls the wrong endpoint.
8. **The plan badge is hardcoded to "Free".** `components/shell/OrgShell.tsx:111`
   renders the literal string, not the resolved entitlement. A self-hosted install
   has `SELF_HOSTED` entitlements with every limit `null` (unlimited), yet the shell
   tells the operator they are on a free tier.
9. **An "Upgrade" button ships in the self-host build** (`app/app/usage/page.tsx:162`),
   routing to `/app/billing` — also overlay-private, so it is a 404 by construction.
   There is nothing to upgrade to on a self-hosted deployment.

10. **`probe fixtures` is intermittently flaky.** Observed 2026-09-17: the job
   failed twice on one PR and once on a bisect branch, then passed on re-run
   with byte-identical code, while `main` passed six consecutive times. It cost
   a wrong diagnosis before the re-run disproved it. A flaky job defeats the
   same property a known-red job does — a genuinely new failure can hide in it
   — so it belongs in this class rather than in the parity tranche.

   Items 6-9 are one defect class: **the self-host edition presents itself as a
   metered SaaS trial.** The edition seam (`CLOUD_CONTROL_PLANE`) already exists and
   is used for nav items; these surfaces simply do not use it.

### Revised tranche (post-verification)

Reordered twice. Verification moved backups ahead of logs, because a backups
panel is a capability Supabase self-hosted does not ship at all, whereas a logs
explorer closes a parity gap against a feature Supabase itself puts behind an
opt-in override. Then the surviving class (a0) items were folded into the work
that already touches the install path, rather than left as isolated cleanup.

| # | Work | Class |
|---|---|---|
| CI-01 | ~~Stabilize `probe fixtures`~~ (a0 item 10) — **closed 2026-09-18, no flake existed** | (a0) |
| — | **Cloud staging restore validation** — private overlay, production-style credentials, the full backup/restore sequence. Build the image once, test that digest, promote **the same** digest. Gates **Cloud production only**. | gate |
| 01 | **One-command self-host**, carrying a0 items 3, 4 and 5 | (a) + (a0) |
| 02 | FK picker + column constraints | (c) |
| 03 | Backup / restore UI | (c) |
| 04 | Logs explorer | (c) |
| 05 | Read-only SQL workspace | (a) |
| 06 | Migration-history UI | (c) |
| 07 | Webhooks UI | (c) |

### The Cloud staging gate

> **No Cloud production promotion before Cloud staging restore validation
> passes.** The gate is scoped to Cloud, because that is where the restore path
> meets real credentials on real infrastructure.
>
> **Superseded 2026-09-18:** this gate previously blocked the self-host parity
> tranche too. It no longer does. Self-host correctness is provable on
> deterministic production-like fixtures — a NOSUPERUSER/NOBYPASSRLS role owning
> FORCE RLS tables reproduces the failure mode that mattered, and did in fact
> surface the ownership defect. Holding OSS work behind a Cloud-infrastructure
> gate would have blocked it on something it does not depend on.

Backups are Cloud-only now, so staging is the only place the restore path meets
real credentials on real infrastructure.

The exemption is not a loophole, it is the point: the gate exists to stop
unvalidated product work, and a gate cannot be trusted while the instrument
reading it is unreliable. A flaky probe can make a genuine staging regression
look transient, or make unrelated work look broken — which is exactly what
happened during the backup-role work, where it cost a wrong diagnosis. So
CI-01 sits *before* the gate rather than inside the numbered sequence.

**CI-01 acceptance:** identify and remove the source of nondeterminism, then
demonstrate stability by running the suite repeatedly. Retries are not a fix —
they hide the exact signal the gate depends on — and are acceptable only if the
nondeterminism proves external and unavoidable, which must then be stated.

**CI-01 CLOSED, 2026-09-18. There was no flake.**

The premise was wrong, and it was wrong in a way worth recording, because the
mistake was mine and it survived 38 test runs without being caught.

Reading the job logs instead of my own notes:

| what I recorded | what the logs say |
|---|---|
| `probe fixtures` failed 3x on 2026-09-17 | `probe fixtures` **did not fail at all** that day. The failing job was `integration suites` |
| the failures were intermittent | all four were the **same single test**, failing **every** time |
| a bisect "proved" a change broke it, then the same commit passed | the two bisect branches held **different code**; the bisect was correct |

The actual defect: `fe080cef` added `carry_constraints` as a new rung between
`add_structure` and `dual_write`, and
`tests/integration/maintenance-resolve-db.spec.ts:235` still asserted the old
six-rung ladder. Deterministic red from that commit until `5386616c` renumbered
the bindings. The older `probe fixtures` reds (2026-09-14/15) were likewise one
deterministic test on two feature branches, never on `main`.

So the 38 consecutive clean runs were not a failure to reproduce a rare defect.
They were correctly reporting that the defect was already fixed. The stability
measurement was sound; the label on it was not.

**Against the acceptance criterion:** "identify and remove the source of
nondeterminism" is satisfied vacuously — there was none to remove, and that is
now demonstrated rather than assumed. No retry was added, which would have been
the wrong fix for a deterministic failure and would have masked a real one.

**What the misdiagnosis cost, and what guards it now.** Two job names were
conflated for a day, and a correct bisect was publicly retracted on the strength
of that. The root cause of the *misdiagnosis* was reasoning from a remembered
job name instead of from the failing assertion. Kept as guards:

- `.github/workflows/flake-hunt.yml`, dispatch-only, which measures a suite's
  failure rate in the `probe fixtures` environment and records every run, pass
  or fail. It offers no retry option, deliberately. Its value is unchanged: the
  next time a job looks intermittent, this answers the question with a rate
  instead of an anecdote.
- `tools/jest/seeded-sequencer.cjs`, which permutes **inter-file** order under a
  recorded seed. Order was the one dimension never varied, and it is now varied:
  6 random orderings of `tests/probes`, 221 tests each, all green, with the same
  seed reproducing the same order. That converts "we never tested ordering" into
  a measured negative result.

Both are opt-in. Normal CI keeps the default sequencer, because a suite that
fails only under one arrangement must surface as a real defect rather than as
noise on an unrelated PR.

**Not built:** concurrency and stress modes for the harness. They were scoped
against a flake that does not exist, and `probe fixtures` and `integration
suites` both run `--runInBand` in CI by design, since those suites share one
database. Adding a parallel mode would measure a configuration CI never uses.

**Tranche 01 landed, 2026-09-18.** `npm run selfhost` is one command from a
fresh clone to a deployment bootstrap reports ready, proved by a CI job that
runs it on a clean runner with no `.env`. a0 items 3 and 5 are closed. Four
further defects were found by building it, three of them by the CI assertions
rather than by reading code:

1. **`prisma db push` is destructive against an installed deployment.** The
   PostgREST support objects are created by SQL, not Prisma — a registry table
   and two DDL event triggers — so push treats them as objects to drop, which
   `--accept-data-loss` authorises. The rerun failed with P1014; had it
   succeeded it would have removed the registry the data plane reads to decide
   which schemas PostgREST serves. The installer now pushes only when the
   platform tables are absent, and README.md warns against rerunning `db:push`.
   Found by the idempotence assertion, not by inspection.
2. **The root `docker-compose.yml` was dead.** It built from `./worker`, which
   has no tracked files, so `docker compose up -d` at the repo root — the first
   thing a Supabase user tries — failed on a missing build context. `AGENTS.md`
   called it "the whole stack" and "the supported way to run it". Removed, both
   documents corrected.
3. **Bootstrap discarded its advisories on the exit-3 path.** It printed
   "skipped (see warning)" for each optional step and then printed no warning,
   on the one run an operator reads carefully.
4. **The OSS preflight caught a key-shaped literal in a new test.** Working as
   intended, and worth recording given it once reported clean with live JWTs.

**Tranche 02 landed, 2026-09-18.** Foreign keys, unique and check constraints
in the table editor, through `addWorkspaceConstraint` — the same typed-action
path the brain uses. One defect found:

- **An operator's chosen FK target was being discarded.** The executor infers a
  target from the column name when none is supplied, which is right for the AI
  path. Passing the choice through `expression` looked correct but the executor
  parses that with a regex expecting `table(column)`, so a bare table name never
  matched and inference ran anyway — picking `organizations` for `owner_id`
  silently produced `owners`. `referencedTable` is now explicit end to end. The
  regression fixture makes inference and the choice disagree with both targets
  present, and asserts on the catalog; 2 of its 6 tests fail without the fix.

**Found by the browser suite, 2026-09-18, not yet fixed.** A freshly installed
deployment repeatedly logs `relation "workspace_<id>.users" does not exist`,
along with `_magic_links`, `_password_resets` and `_email_verifications`.
Something queries the end-user auth tables on a loop before anything has
created them, so the server log of a brand-new install fills with raw Prisma
errors. Same class as a0 5 — an expected state reported as a crash — and found
the same way, by running the thing rather than reading it. The browser suite
saw it because it is the first harness that starts a real app against a real
fresh install.

**FIXED 2026-09-18 — first-owner claim.** A freshly installed deployment's
dashboard was not usable by the account that had just signed up. Bootstrap
creates THE project before any account exists, so it was owner-less, and it
adopted the first operator only on a **rerun**; until then opening the project
answered `PROJECT_FORBIDDEN`. `npm run selfhost` claiming to produce a ready
deployment while a second hidden command was still required did not hold.

Signup now binds the administrator to the project **in the same transaction**
that creates them, so there is no second command. It is gated on a one-time
setup token the installer generates and prints, because "first signup wins"
would be wrong in the other direction: a deployment is frequently reachable
before its operator reaches it, and the single administrator slot would go to
whoever loaded the page first. Possession of the machine grants the claim.
Single-use comes from the account slot, not the secret — the token sits in
`.env` and a file cannot be un-read, so once claimed it is refused whatever it
is set to. Covered by `__tests__/auth/deployment-claim.test.ts`, and the
browser suite now asserts ownership immediately after signup with the CI
bootstrap rerun removed.

**FIXED 2026-09-18 — a0 4, the runtime superuser.** The application connected
as `POSTGRES_USER`, the role `initdb` creates, which is a SUPERUSER. Superusers
bypass row-level security **including `FORCE ROW LEVEL SECURITY`**, so every
policy the platform wrote was advisory for the application itself: tenant
isolation held because the code scoped its own queries, not because the
database would have refused one that did not.

Four roles now, one job each: `backenly_user` (SUPERUSER, install scripts only,
never in `DATABASE_URL`), `backenly_app` (**NOSUPERUSER NOBYPASSRLS**, owns the
platform tables and workspace schemas so governed typed actions keep their DDL
rights), `backenly_authenticator` (unchanged, NOINHERIT), and `backenly_backup`
(NOSUPERUSER BYPASSRLS, `pg_dump` only; restore still runs over the application
connection so ownership is preserved).

Ownership plus `FORCE` is what makes that combination work — without FORCE an
owner is exempt from its own policies and ownership would re-open the hole.
`public.backenly_app_role()` was already the seam every privileged statement
read, so one `ALTER DATABASE ... SET backenly.app_role` moves the whole system.
`__tests__/database/app-role-separation.test.ts` connects **as the role** and
watches the database refuse, with a contrast test showing the superuser still
sees every row so the assertion cannot pass vacuously.

**Open.** There is no working browser coverage. `tests/e2e/` assumes an
authenticated session and is not wired into CI, so it is not evidence for any
UI item. That harness is worth building once, before the remaining UI tranches.

**Why 3, 4 and 5 belong inside 01.** All three are install-path decisions, and
01 is the only tranche item that rewrites the install path:

- **a0 3 — `MASTER_ENCRYPTION_KEY`.** The installer should generate it, or
  require it explicitly and refuse to proceed. A zero key must not be a silent
  default outside development.
- **a0 4 — the application connects as a Postgres superuser.** The installer is
  where the role model gets decided: elevated bootstrap credentials separated
  from the normal application credential, with the intended role properties
  regression-tested. The backup work already proved the non-superuser path
  works, so this is a decision to make rather than a capability to build.
- **a0 5 — bootstrap prints raw Prisma errors on its expected path.** Pure
  install-path UX; it is the first thing a new self-hoster sees.

**Why CI-01 sits before the gate.** An intermittent job makes every later
diagnosis slower and less trustworthy, including the staging diagnosis the gate
depends on. It already produced one wrong conclusion during this audit.

### Class (a) — genuine, needs backend work

Ranked by (a1) blocks the Supabase importer, (a2) already publicly conceded in
`app/comparisons/data.ts`.

1. **One-command self-host.** Supabase: one script, then `docker compose up -d`.
   Backenly: five steps, a reconciler whose first run is *expected* to exit 3,
   superuser SQL, a rerun, and two Node processes with no compose coverage.
   Confirmed by the Part 5 install: `docker-compose.dev.yml` starts three infrastructure
   containers and no application, and `docker/compose.stack.yml` — the only file
   that does define `web` and `runtime` — is referenced by **nothing in the repo
   except its own usage comment** (`docker/compose.stack.yml:9`), is pinned to
   `BACKENLY_EDITION: cloud`, and disclaims itself in its header as "NOT the
   development stack ... and NOT a production deployment". So there is no compose
   file a self-hoster can run to get the product up.
2. **Read-only SQL editor** with snippets and history — the governed answer to
   class (b)'s first entry, on the existing SELECT-only `bkn_ro_` path.
3. Auth depth: providers beyond Google/GitHub, email-template editor, SMTP config.
4. Storage: per-bucket policy editor, on-the-fly image transformation, S3 protocol.
5. Extensions / enum types / publications surfaces.
6. Per-table API docs with client snippets.

---

## Part 4 — Cloud-parity appendix (deferred)

Per the staged decision, these are costed separately and are **not** in scope for
self-hosted parity: multi-tenancy and multiple projects per deployment,
organizations/members/RBAC, automated backups + PITR, read replicas, compute &
disk management, log drains, branching-as-a-service with GitHub integration.

Backenly still ships **real dashboard accounts with 2FA**, which Supabase gives
only to Cloud customers. Branching and backups were *also* in this category
until 2026-09-17, when they were moved to Cloud-only by founder decision
(Part 7, where the dissent is recorded).

---

## Corrections to the original framing

Preserved deliberately, following the precedent in
`docs/managed-db-migration-findings.md`.

1. **"Supabase self-hosted has multi-tenancy / multiple projects, Backenly
   doesn't"** — false. Self-hosted Supabase is one project per stack
   (`/project/default`), no orgs, no members, no billing. Parity.
2. **"…and database backups"** — false. Backups, PITR and restore-to-new-project
   are all `IS_PLATFORM`-gated and 404 self-hosted. Backenly actually has a
   *working backup backend* that Supabase self-hosted lacks; it just has no UI.
3. **"…and branching"** — false, and inverted. Branching is Cloud-only for
   Supabase; Backenly ships it self-hosted.
4. **"Partial only edge functions UI"** — **correct**, with the mechanism now
   pinned: the compose mounts `./volumes/functions:/app/edge-functions:ro`, and
   Studio's self-hosted empty state reads *"Place each function at
   `volumes/functions/<function-name>/index.ts` and restart the `functions`
   service to pick up changes."*
5. The real gaps are elsewhere, and are mostly **UI over existing backends**.

---

## Reproducing this

```sh
# Supabase, pinned
git clone --depth 1 https://github.com/supabase/supabase.git
sh supabase/docker/setup.sh -y --skip-deps --head --project-dir supabase-project
# remap POSTGRES_PORT to 54322 if 5432 is taken, then:
cd supabase-project && docker compose up -d
# Studio: http://localhost:8000  (DASHBOARD_USERNAME / DASHBOARD_PASSWORD from .env)

# Backenly's side of the matrix
npx tsx scripts/audit-ui-coverage.ts          # human-readable
npx tsx scripts/audit-ui-coverage.ts --json   # machine-readable
```

Raw captures (resolved compose, endpoint probes, route sweeps, per-route network
traces, 70 screenshots) are kept **outside this repo** — `evidence/` is
gitignored, and Supabase Studio screenshots are deliberately not committed to an
Apache-2.0 public repo carrying `TRADEMARK.md`.

**Both sides have now been installed and driven.** Part 5 records the cold
Backenly install (2026-09-17, fresh clone, `BACKENLY_EDITION` unset) and Part 6
the backup/restore test. The Backenly feature column is still derived from
source plus `audit-ui-coverage`; the install and backup rows are now observed.

---

## Part 5 — Cold Backenly self-host install (observed)

Performed 2026-09-17 against a **fresh clone** of `github.com/backenly/backenly`
at `19df489f`, in a clean Ubuntu 24.04 WSL2 environment (Node 20.20.1, Docker
29.1.3), following `README.md` §Self-hosted literally. `BACKENLY_EDITION` was
**commented out**, to test the documented claim that an unset edition resolves to
single-tenant. It does.

**Result: the documented path works, end to end, exactly as written.** Bootstrap
exited 3 on the first run and 0 on the second, as the README predicts.

### Measured

| Step | Command | Time |
|---|---|---|
| Clone | `git clone` | **14 s** (39 MB) |
| Dependencies | `npm install` (runs `prisma generate` as postinstall) | **116 s** (1.3 GB `node_modules`, 15 npm advisories incl. 1 critical) |
| Infrastructure | `docker compose -f docker-compose.dev.yml up -d` | **61 s** (first pull) |
| Schema | `npm run db:generate && npm run db:push` | **10 s** |
| Bootstrap #1 | `npm run bootstrap` | 2 s → **exit 3**, as documented |
| Prereqs | `postgrest-install.sh`, `setup-postgrest-roles.ts --apply`, `up -d postgrest`, `install-sql.sh` | **~4 s total** |
| Bootstrap #2 | `npm run bootstrap` | <1 s → **exit 0, "Backenly is ready"** |
| Run | `npm run dev` | ~15 s to first 200 |
| Bootstrap #3 | after dashboard signup | <1 s → **anon key created** |

Roughly **3.5 minutes of command time**; ~13 minutes wall clock including the
manual steps. Supabase, for comparison, was one `setup.sh` invocation (which also
pulled every image) followed by `docker compose up -d`.

### Surfaces verified working

| Surface | Result |
|---|---|
| Dashboard `:3000/`, `/auth/login` | 200 |
| Runtime `:3001/health` | 200 |
| Platform signup (first account) | user created, session issued |
| Anon key issuance | created on bootstrap #3 |
| Typed table creation (`/api/database/create-table`) | 2 tables created, "REST API generated" |
| Row insert (`/api/database/rows`) | 5 rows written |
| **`/db/*` data plane** | **200 with rows — no `PGRST106`** |
| RLS enforcement on the data plane | `orders` (FORCE RLS) returned `[]` with an explicit diagnostic naming the missing end-user token |
| Autonomy | `[CronScheduler] Started — … autonomy reconciler tick every minute` |
| Storage / env vars | bucket + encrypted env var endpoints responded |

### Manual interventions the README requires, and friction found

Seven things a first-time self-hoster must do or tolerate:

1. Generate a UUID and three 32-byte secrets by hand.
2. **`BACKENLY_PROJECT_ID` is not in `.env.example`** — you must add the line. The
   README says so; the template does not carry it.
3. **`POSTGREST_AUTHENTICATOR_PASSWORD` is not in `.env.example` either.** The
   install had to *append* it. It is printed once by `setup-postgrest-roles.ts`
   and is explicitly not recoverable.
4. You must know that **exit 3 is success**, not failure.
5. Bootstrap #1 prints **four raw Prisma `42883` errors** (`function
   public.backenly_pgrst_register_schema(text) does not exist`) before its clean
   summary. The expected path *looks* like a crash. The summary underneath it is
   genuinely good — a status table plus the exact next commands with the real
   project id filled in — but a newcomer reads the stack traces first.
6. **`MASTER_ENCRYPTION_KEY` is an undocumented sixth secret.** Bootstrap warns
   `MASTER_ENCRYPTION_KEY unset (dev only) — using zero key. Set the env var.`
   It is absent from the README's required-values list and from `.env.example`.
   A self-hoster following the README ships with a zero encryption key.
7. **The root URL serves the public marketing site, not the product.** Visiting a
   self-hosted deployment gives `Backenly | The Autonomous Backend Platform` —
   the cloud website. Supabase self-hosted puts the dashboard at its root behind
   HTTP basic auth and never shows marketing. Verified: `/`, `/pricing`,
   `/comparisons`, `/comparisons/backenly-vs-supabase`, `/alternatives`,
   `/use-cases`, `/features`, `/resources`, `/contact`, `/terms`, `/privacy`,
   `/refund-policy` all return **200** from a self-hosted install. An operator
   running Backenly internally is publishing Backenly's pricing page and its
   competitor comparisons on their own infrastructure.
8. First boot logs an Edge Runtime error — `Ecmascript file had an error … A
   Node.js module is loaded ('crypto') which is not supported in the Edge
   Runtime`, tracing to `lib/auth/jwt.ts` via `middleware.ts`. The app serves 200
   regardless, but it reads as a failure.

### Confirmed: no compose file starts the product

`docker-compose.dev.yml` brought up postgres, redis and postgrest only.
`npm run dev` on the host is required for the dashboard and runtime. This
matches the structural finding in class (a) item 1 — now observed, not inferred.

### New finding: the application connects to Postgres as a SUPERUSER

On the default Compose path `POSTGRES_USER` defaults to `backenly_user`, which
makes it the cluster bootstrap superuser. Verified on the fresh install:

```
rolname                | rolsuper | rolbypassrls
backenly_user          | t        | t
backenly_authenticator | f        | f
```

`DATABASE_URL` — the credential the whole platform layer uses — is
`backenly_user`. The data-plane boundary is unaffected (PostgREST authenticates
as `backenly_authenticator`, which is neither superuser nor `BYPASSRLS`), but
every `FORCE ROW LEVEL SECURITY` table in the workspace is unenforced against the
application role itself. This deserves an explicit decision rather than a default.

---

## Part 6 — What Backenly's backup actually is (observed)

The instruction was to prove the semantics before claiming an advantage over
Supabase self-hosted. Tested end to end on the Part 5 install.

### What it is

`pg_dump --schema workspace_<projectId> --no-privileges --no-owner`, gzipped to
`BACKUP_DIR/<projectId>/<timestamp>.sql.gz`, with a row in `WorkspaceBackup`
(`lib/services/workspace-backup.ts:195`). It is a **logical, single-schema
export**. It is **not** PITR, not WAL-based, and not disaster recovery for the
deployment.

### What a backup contains — verified by decompressing and parsing the dump

| Captured | Evidence in the dump |
|---|---|
| Table definitions | 3 × `CREATE TABLE` (`customers`, `orders`, and the end-user `users` table) |
| Row data | 3 × `COPY … FROM stdin` |
| Indexes | 9 × `CREATE INDEX` |
| Constraints | 8 × `ALTER TABLE ONLY` |
| **RLS policies** | 9 × `CREATE POLICY`, plus `FORCE ROW LEVEL SECURITY` |
| Triggers / functions | 2 × `CREATE TRIGGER`, 2 × `CREATE FUNCTION` |
| **End-user auth state** | yes — `workspace_*.users` (emails, password hashes) sits inside the dumped schema |

| Not captured | Why |
|---|---|
| GRANTs | `--no-privileges`. In practice the DDL event trigger re-applies them on restore — grants returned to 39/39 — so this is not a defect, but the dump alone is not sufficient. |
| Project row, API keys, JWT secrets | live in the platform `public` schema |
| **Project secrets / env vars** | `ProjectEnvVar` is platform-side; `STRIPE_SECRET` was absent from the dump and survived the restore untouched |
| Storage objects and their metadata | files live on `STORAGE_DIR`; nothing in the backup path touches them |
| Serverless function definitions | platform-side |

So one backup restores **one project's data and its data-plane rules**. It does
not restore a deployment.

### The RLS caveat is real, but conditional

`lib/services/workspace-backup.ts:78-95` documents a production incident: pg_dump
running as the application role against `FORCE ROW LEVEL SECURITY` tables aborts,
and *"every nightly backup failed for at least four days … ending at zero backups
on disk."* The fix is `BACKUP_DATABASE_URL` pointing at a `BYPASSRLS` role.

**`BACKUP_DATABASE_URL` is referenced in exactly one source file and appears in
no document a self-hoster reads** — not `README.md`, not `.env.example`, not
`docs/`. The backup succeeded on this install only because, as Part 5 found,
`backenly_user` happens to be a superuser on the Compose path. On any deployment
where the app role is not superuser — managed Postgres, or a hardened BYO
database — the default configuration reproduces the incident.

### The restore path is broken: silent, total data loss

This is the most serious finding in either verification, and it is reproducible.

After destroying part of the fixture (deleted 3 rows, dropped `orders`, dropped
an index), calling `PUT /api/projects/<id>/backup` returned:

```
{"success":true,"data":{"success":true,"restoredFrom":"…sql.gz"}}
```

Observed state **after** that "successful" restore:

| | before | after destruction | after "successful" restore |
|---|---|---|---|
| tables | 3 | 2 | **0** |
| customers rows | 5 | 2 | **relation does not exist** |
| indexes | 14 | 7 | **0** |
| policies | 9 | 4 | **0** |
| `/db/customers` | 200 | 200 | **404** |

**Mechanism**, confirmed by reproducing the exact invocation by hand:

1. `restoreWorkspace` runs `DROP SCHEMA … CASCADE` then `CREATE SCHEMA`
   (`lib/services/workspace-backup.ts:328-330`) — the live data is now gone.
2. The dump's own line 25 is `CREATE SCHEMA "workspace_…"`, which now fails:
   `ERROR: schema "workspace_…" already exists`.
3. `--single-transaction` aborts the transaction; every later statement returns
   `current transaction is aborted, commands ignored`.
4. **psql exits 0** — `ON_ERROR_STOP` is not set — so `execFileAsync` never throws.
5. `restoreWorkspace` returns `{ success: true }` over an empty schema.

**FIXED 2026-09-17.** The one-line diagnosis was right, but the fix went
further than restoring the error, because "DROP then fail" is terminal however
loud the failure is. `restoreWorkspace` now:

1. decompresses **before** touching the live schema, so a corrupt archive fails
   while the data is still there;
2. **renames** the live schema aside instead of dropping it, so the pre-restore
   copy exists for the whole operation;
3. runs psql with `-v ON_ERROR_STOP=1`, which is what makes its exit code mean
   anything;
4. counts the relations the restore produced and treats zero as a failure, because
   psql exiting 0 is necessary and not sufficient — that is precisely how the
   original defect reported success;
5. drops the aside only after that check passes, and on any failure drops the
   half-restored schema and renames the aside back.

If the rollback itself fails, the error names the retained schema so an operator
can recover by hand rather than discovering the loss later.

Locked by `__tests__/services/backup-restore-integrity.test.ts` (real database,
real pg_dump, real psql). **Verified to catch the original defect: 3 of its 4
tests fail against the pre-fix implementation.**

That the restore path has never run end to end is consistent with
`audit-ui-coverage`: the backup API has **zero dashboard callers**.

### How this must be phrased

Not *"we have backups and Supabase self-hosted doesn't."* The supportable claim is:

> Backenly ships a per-project logical backup service — schema, rows, indexes,
> constraints, RLS policies and end-user auth rows — which Supabase self-hosted
> does not ship at all. It is not PITR and not deployment-level disaster
> recovery, its restore path is currently broken, and its default configuration
> is unsafe on any database where the application role is not a superuser.

Until the restore bug is fixed, **backups must not be described as a Backenly
advantage in any external material.**

---

## Part 7 — Self-host edition cleanup (implemented 2026-09-17)

Founder decision, taken after seeing the cold install: a self-hosted deployment
should stop presenting itself as a hosted SaaS, and should not carry capabilities
Supabase self-hosted does not ship. Implemented and verified on the Part 5 install.

**A dissent is recorded here deliberately.** Removing branching and backups from
self-host was argued against before implementing: Supabase gates *both* behind
Cloud, so shipping them self-hosted was a differentiator rather than a gap, and
the mentor's own tranche moved the backup UI *earlier* for exactly that reason.
The founder reaffirmed the decision. It is implemented in full, and this
paragraph exists so the reasoning is recoverable if the call is revisited.

### What changed

| Surface | Before (self-host) | After |
|---|---|---|
| `/`, `/pricing`, `/comparisons`, `/alternatives`, `/features`, `/use-cases`, `/resources`, `/contact`, `/terms`, `/privacy`, `/refund-policy` | served the cloud marketing site | **307 → `/app`** (`middleware.ts`) |
| Plan chip in the shells | hardcoded `Free` | absent (`lib/edition/oss/org-switcher.tsx`, `components/shell/OrgShell.tsx`) |
| Account **Usage** page + nav item | broken — fetched overlay-only `/api/billing/usage` | absent; page 404s |
| 404 page | offered "Pricing", "Use cases", "Get started free" | "Back to your dashboard" only |
| **Branches** nav, ⌘K entry, page | present | absent; page 404s |
| `GET/POST /api/projects/:id/branches`, `…/[branchId]` | 200 | **404** `CLOUD_ONLY_FEATURE` |
| `GET/POST/PUT /api/projects/:id/backup` | 200 | **404** `CLOUD_ONLY_FEATURE` |
| daily backup scheduler tick | ran | returns `{ran:0,…}` |

Unchanged and verified still working: the `/db/*` data plane, `/api/usage`,
auth, storage, functions, realtime, autonomy, monitoring, deploy, MCP/Connect.

### How it is gated

Two seams, deliberately not one:

- **`assertCloudEdition()` / `isCloudEdition()`** — new, `lib/edition/cloud-only.ts`.
  Server-side, reads `currentEdition()`. Applied at the **service layer**
  (`lib/branches/engine.ts`, `lib/services/workspace-backup.ts`) so the HTTP
  route, the agent tool in `lib/ai/brain/tools.ts` and the scheduler all inherit
  one refusal and a new caller cannot miss it. This is the authorization half.
- **`CLOUD_CONTROL_PLANE`** — the existing build-time constant, for presentation
  only. It stops the dashboard offering a control for work the service will
  refuse. Its own header documents that it must never be an access check, so it
  is not used as one here.

Read paths (`listBranches`, `listBackups`) return `[]` rather than throwing:
"what exists here" has a correct answer off Cloud, and it is *none*. Throwing
would force every caller that merely lists to handle an exception.

Routes answer **404, not 403** — off Cloud the capability does not exist, and 403
would imply it is present and withheld.

### Verified on the running install

Marketing routes all 307 → `/app`; `/auth/login` still 200; branch and backup
routes all 404 with `CLOUD_ONLY_FEATURE`; `/api/usage` and `/db/customers` still
200. Rendered in headless Chromium: org nav is now `Projects | Settings`, project
sidebar is `Overview · BUILD(Database, Auth & Users, Storage, Functions,
Realtime, Integrations) · OPERATE(Autonomy, Monitoring, Deploy) · CONNECT ·
Settings` — **no Branches**, **no Free chip** — and both removed pages render the
404. Gates run: `npx tsc --noEmit` clean, `eslint` clean on every changed file,
`__tests__/edition` **177/177 pass**, branch/backup suites **34/34 pass**.

### Consequence that must not be lost

**The restore bug in Part 6 became a Cloud-only bug, which raised its severity
rather than lowering it.** Once backups were Cloud-only it could no longer be
found by a self-hoster; only a paying customer restoring real data would hit it.
That is why it was fixed first, before any parity work and before Cloud
promotion. Fixed 2026-09-17.
