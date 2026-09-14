# Skybook AI Website Audit

An internal tool for Skybook salespeople. You give it a prospect's website
address; it crawls the site, measures what is actually there, grades those
measurements against fixed rules, and produces a PDF audit report you can send
to the prospect.

It is a local prototype. It runs on one machine, holds nothing in a database,
and serves one signed-in salesperson at a time.

## What it does, in order

1. **Sign in.** One account, set from the environment. Every API route refuses
   a request without a session.
2. **Enter a website.** A bare domain is fine; the address is normalised first.
3. **Audit.** The site is crawled and measured: certificate, DNS and mail
   records, robots.txt, sitemaps, headers, redirects, titles, headings, meta
   descriptions, links, and more. The audit runs as a background job; the page
   polls it and shows progress as counts, never as a percentage.
4. **Results.** Findings appear grouped by severity, each naming the pages it
   was found on, alongside the raw measurements it came from.
5. **Speed** is measured separately, through Google PageSpeed Insights, because
   it is slow and can fail on its own without spoiling the rest of the audit.
6. **AI explanation.** Gemini writes plain-English commentary on findings that
   already exist. This is a separate request, and a results page is complete
   and correct without it.
7. **PDF.** The report is typeset from the results already on screen. Nothing
   is measured again.
8. **Preview and confirm.** Before anything can be sent, a person reads the
   exact email and ticks an attestation.
9. **Send.** One email, one attachment, to one client.

## The architecture principle

> Deterministic code measures facts. Deterministic rules grade those facts.
> Aggregation turns them into findings. Only then does Gemini explain them.

The model never measures anything, never crawls, never counts, never assigns or
changes a severity, and never invents a finding. It receives a structured
contract built from measurements that already happened and writes prose about
them. If the model is unavailable, the audit and the report are unaffected —
they simply carry no commentary.

This is enforced structurally, not by convention:

- Every decision lives in a pure module under `lib/`, tested in Node with no
  browser and no server. Components under `app/` hold state and render it.
- The AI input is an explicit whitelist projection. A field it is not given is
  a field it cannot discuss.
- The model's output is validated before it reaches a page or a PDF.
- Tests assert against the source text of modules that must *not* be able to do
  something — a comment explaining an absence is not the same as the absence.

A related discipline runs through the measurement layer: every check has three
outcomes, not two — **found**, **absent**, and **unavailable**. "We looked and
there is no SPF record" and "we could not check" are different facts and are
never collapsed into one.

## Technology

| Piece | Choice |
|---|---|
| Framework | Next.js 16.3.4 (App Router, Turbopack) |
| UI | React 19.2.8, CSS modules |
| Language | TypeScript, `strict` |
| Runtime | Node 24 |
| HTML parsing | `cheerio` |
| PDF | `puppeteer` — headless Chromium printing our own HTML |
| AI | `@google/genai`, model `gemini-3.6-flash` |
| Email | Resend, over plain HTTPS — no SDK |
| Tests | `node --test`, `.mts` files beside the code |
| Storage | none |

### Implementation choices worth knowing

- **The crawler is our own code.** Crawlee was considered and not adopted; the
  frontier, URL normalisation, de-duplication, politeness pacing and worker
  pool are written here, with no crawling dependency.
- **No email SDK.** Sending one transactional message is a single POST with a
  bearer token. A client library would be a dependency to keep current in
  exchange for a function, and everything else such a library offers — batching,
  retries, queues, contact lists — is what this application deliberately
  refuses to have.
- **Jobs are in memory**, with a 30-minute TTL. Restarting the server forgets
  every audit. That is a deliberate scope decision, not an oversight.
- **`middleware.js` is not used.** In Next 16 it is deprecated in favour of
  `proxy.js`, and authentication here is enforced in each route rather than at
  the edge, so there is nothing for it to do.

### Limits and budgets

These are the values the code actually uses:

| Setting | Value |
|---|---|
| Pages per crawl | 150 |
| Crawl time budget | 5 minutes |
| Queue ceiling | 2,000 URLs |
| Response size ceiling | 5 MB |
| Crawl concurrency / pacing | 3 workers sharing one 200 ms interval |
| Audit budget | 30 s (site checks 10 s) |
| PageSpeed budget | 95 s |
| AI explanation budget | 45 s |
| Concurrent audits | 2 |
| Job retention | 30 minutes |
| Findings sent to the model | 20 at most |

### Rules

30 compiled rules, each with a fixed severity assigned in code:

- 23 run during the audit — 12 security, 10 SEO, 1 technical
- 7 run after the speed measurement returns

By severity: 6 critical, 7 high, 17 medium. Every rule declares whether it is
**page-scoped** or **site-scoped**, which is what stops a single certificate
problem being reported 128 times on a 128-page crawl.

## Local setup

Requires Node 24 and a Chromium that `puppeteer` can download on install.

```bash
npm install
```

Create `.env.local` in the project root (it is git-ignored — never commit it)
and set the variables below. Then:

```bash
npm run dev
```

The application is at <http://localhost:3000> and will redirect you to
`/login`.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build, including a TypeScript pass |
| `npm start` | Serve the production build |
| `npm test` | The whole unit suite (`lib/**/*.test.mts`) |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Type-check without emitting |

## Environment variables

All seven are read on the server only. None is prefixed `NEXT_PUBLIC_`, so none
is ever sent to a browser. Real values go in `.env.local` and nowhere else —
this file contains no credentials and no example values that could be mistaken
for one.

| Variable | Required for | Purpose |
|---|---|---|
| `SKYBOOK_EMAIL` | Signing in | The one address allowed to sign in. |
| `SKYBOOK_PASSWORD_HASH` | Signing in | The scrypt hash of that account's password. **Never the password itself.** |
| `SESSION_SECRET` | Signing in | Signs the session cookie. Must be at least 32 characters; generate random bytes, do not invent a phrase. |
| `GEMINI_API_KEY` | AI commentary | Google AI Studio key. Without it, audits and reports work and carry no commentary. |
| `PAGESPEED_API_KEY` | Speed checks | Google PageSpeed Insights key. Required, not optional — unkeyed requests are refused by Google. Without it the speed panel says so plainly and the rest of the audit is unaffected. |
| `RESEND_API_KEY` | Sending | Resend API key. Without it, sending fails closed (see below). |
| `SKYBOOK_MAIL_FROM` | Sending | The sender address mail is sent from: an address on a domain verified in Resend to reach clients, or Resend's testing sender for sends to the account owner only. Read from the environment only — a browser can never supply it. |

### The password hash

`SKYBOOK_PASSWORD_HASH` holds a value of the shape
`scrypt:<hex salt>:<hex key>` — produced by `hashPassword()` in
[`lib/auth/credentials.ts`](lib/auth/credentials.ts), using scrypt with
N=32768, r=8, p=1, a 16-byte random salt and a 32-byte derived key.

The separator is a colon for a specific reason: Next's environment loader
expands `$name` inside `.env` values as a variable reference, so a hash written
in scrypt's conventional `$`-delimited format is silently mangled before the
application ever sees it. That was diagnosed the hard way.

## Authentication and security

- **One account, no sign-up, no password reset, no roles.** A session carries an
  email address and an expiry and nothing else — no role, no permission, no
  flag. Moving to Google Workspace later is a change to one module.
- **The session cookie is signed, not encrypted** — HMAC-SHA256 over a
  base64url payload, compared in constant time. It is `httpOnly`, `sameSite=lax`,
  `secure` in production, and expires after 8 hours.
- **Every API route calls the guard itself.** A test walks `app/api/` and fails
  if a route exists that does not, so a new endpoint cannot be quietly
  unprotected. The two sign-in routes are exempt by design: requiring a session
  to obtain one is a locked door with the key inside.
- **A wrong password and an unknown address are refused identically**, so
  probing tells an attacker nothing.
- **Sign-in attempts are limited** to 10 failures per 15 minutes per caller, in
  a bucket of its own.
- **Nothing is logged that should not be.** No secret, credential, session
  cookie, provider response body, request id or raw HTML appears in any error,
  UI string, PDF or log. Tests assert this against the source.

### Separate rate limits

Three buckets that never share state, because exhausting one must not lock
anyone out of another:

| Bucket | Allowance |
|---|---|
| Audits | 10 per minute per caller (60 max, 30 global) |
| Sign-in attempts | 10 failures per 15 minutes |
| Report sends | 5 per 10 minutes |

## Reports and the confirmation gate

The PDF is typeset by headless Chromium from HTML this project writes, with IBM
Plex fonts embedded so a report looks the same wherever it is opened. It is
built from the audit result that already exists — no crawl, no speed check, no
model call. Nothing is stored: bytes go to the caller and are forgotten.

Raw `Server` and `X-Powered-By` header values are deliberately withheld from the
client-facing PDF and from the AI contract that feeds it. A report handed to a
prospect should not hand over a version number an attacker could use.

**Before anything can be sent, a person must confirm.** The confirmation is not
a flag saying somebody clicked once — it is a fingerprint of the exact content:
the job, the recipient, the audited address, the three optional client fields,
and the composed subject and body. Change any of it — correct a typo in the
address, add the company name — and the agreement no longer describes what
would be sent, so it no longer stands.

The server recomputes that fingerprint from the document it built and refuses
if it does not match. The audited address comes from the document rather than
from the request, so a caller cannot supply one that makes their own
fingerprint fit.

## Sending

- **Provider: Resend**, called directly over HTTPS. The key travels in an
  `Authorization` header and appears in no return value, error, log or UI.
- **Sending to clients requires a verified domain.** `SKYBOOK_MAIL_FROM` must be
  an address on a domain verified in Resend to reach an arbitrary recipient.
  Resend's testing sender on the `resend.dev` domain needs no verification, but
  delivers **only** to the email address the Resend account was opened with, and
  refuses anyone else with a 403.
- **One request, no retry, no queue, no background send.** There is no unsend,
  and a second attempt is how one report becomes two in a client's inbox. The
  browser, the route and the provider adapter each contain exactly one call
  site, asserted by tests.
- **Failure vocabulary.** The service's own error bodies — codes, messages,
  request ids — are never shown or logged. They are mapped into five failures,
  and every sentence a salesperson can see says in as many words that nothing
  was sent.
- **The send allowance is spent only after the provider accepts**, so a refused
  or failed attempt does not consume one.
- **The browser supplies nothing about mail.** Its request carries the job, the
  typed address, the confirmation and the three report fields. Sender, key and
  provider configuration exist only on the server.

### When Resend is not configured

The send route checks for a key **before** it renders anything, so a server that
cannot send costs nothing to ask and never drives a headless browser for a
client who could not have received the report. It answers `503` with
*"Email sending is not configured on this server, so nothing was sent."*

It fails closed at every layer: the adapter with no key opens no connection at
all, and a route that quietly did nothing while reporting success would be the
worst possible version of this feature.

### Live sending: what has and has not been proven

The first live send was made on 14 September 2026, with a local configuration
using **Resend's testing sender**. A real website audit was completed and its
report sent to the Resend account owner's own address. It arrived in the inbox
rather than spam, the PDF attachment opened, and the subject and body matched
the preview that had been confirmed. No sending error occurred.

That proves the whole chain against the real service: sign-in, audit, preview,
confirmation fingerprint, render and provider. It does **not** prove:

- **A company sending domain.** None has been verified in Resend yet.
- **Delivery to a client.** No report has been sent to any address other than
  the account owner's — the testing sender cannot reach one.
- **Other mailbox providers.** One Gmail inbox accepted the message; no other
  provider has been tried.

The server log for that send was not captured, so the one-request guarantee
rests on the code and its tests rather than on an observation.

## Testing and verification

Unit tests only — no browser test runner, no end-to-end harness.

| | |
|---|---|
| Test files | 71 |
| Tests | 2,547 |
| Result | all passing |

Verified at the current commit: `npm test` (2,547 passing), `npx tsc --noEmit`,
`npm run lint`, `git diff --check` and `npm run build` all exit 0. The suite has
passed on every run during recent work; no test is currently known to be flaky.

What the suite is built on:

- **Decisions are tested, not components.** Anything a button decides lives in a
  module a test can import without a browser.
- **No test reaches the network or an email service.** Every outbound call goes
  through an injected seam. The send-route tests additionally install a tripwire
  over the global `fetch` so that a test which built a real provider — on a
  developer's machine that happened to have a key — would fail loudly instead of
  costing money and delivering mail to somebody.
- **Audits in tests run the real pipeline** against a fixture that replaces only
  the socket, because a projection reading twenty measurement blocks needs
  twenty measurement blocks.
- **Absences are asserted against source text**, with comments stripped first —
  a file explaining at length why it does not retry contains the word "retry".

## Current limitations

- **Single user, single machine.** One account, in-memory jobs, no deployment.
- **Restarting the server forgets every audit**, including finished ones a
  report has not yet been exported from.
- **No report is stored.** Once a PDF is downloaded or sent, this application
  has no copy and no record that it happened.
- **No address book.** The client's address is typed each time, used once, and
  forgotten with the page. Nothing is keyed on a recipient anywhere.
- **Speed depends on Google.** PageSpeed can be slow or refuse; the audit
  reports that as a measurement state rather than failing.
- **Reports can only reach the Resend account owner** while the testing sender
  is configured. See *Live sending* above.
- **A refused testing-sender recipient is misreported.** Resend returns 403 when
  the testing sender is asked to deliver to anyone but the account owner, and
  this application reads every 403 as a key problem — so the screen says
  *"Email sending is not configured on this server"* when the real cause is the
  recipient. Nothing is sent. It disappears once a domain is verified, and is
  deliberately not changed yet: telling the two 403s apart would mean reading
  the service's response body, which the adapter was designed not to depend on.

### Deferred work

- **Verify a company sending domain.** Add it in Resend, publish its SPF and DKIM
  records, confirm verification, and change `SKYBOOK_MAIL_FROM` to an address
  on it. No code change is needed; the sender is read from the environment.
- **A first report to a real client address.** Untested, and blocked by the
  step above. It deserves the same care as the first live send: a real audit,
  an internal recipient on a different mailbox provider before any prospect,
  and the server log open.
- **Redirect chains are recorded but not graded for a downgrade.** A site is
  graded on the scheme it finally serves, so a chain that ends on plain HTTP is
  caught by `security.https`; one that dips through HTTP and returns to HTTPS
  is not flagged. The chain is measured, so a rule could read it.
- **An undocumented Gemini schema boundary.** Certain schema shapes cause the
  model to refuse a request. It was isolated to two schema properties and then
  parked: the product fix — capping commentary at 20 findings — is deliberate
  design rather than a workaround, and Google documents no such limit.
- **A Gemini model-comparison harness** exists locally and is deliberately not
  committed.

### On PostgreSQL and monitoring

Neither is used, and neither is needed for what this prototype does.

An audit is produced, read, exported and sent within a single session, and this
phase is deliberately database-free — there is no persistence layer, no schema,
no migration and no stored report. Adding PostgreSQL now would mean storing
audits about other people's businesses with no decision made about retention,
and monitoring a tool with one user on one laptop.

Both belong to a later phase, alongside deployment and multi-user access. The
current architecture does not block them: jobs already sit behind a store
interface, so persistence would be a new implementation of an existing seam
rather than a rewrite.
