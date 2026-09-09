# How this extension works

Select metadata in a source org, then send it one of two ways — chosen per
deployment, on the confirm screen:

```
Direct        retrieve from source, deploy into a target org
Copado        create a user story with the components attached
```

```
Connect orgs            session capture, saved, tagged by role
Browse source org       active browser tab, auto-detected
Select components       objects, fields, recently modified
Deploy →  confirm       method, destination, and its own options
Confirm  →  direct      retrieve → deploy → component and test results
         →  copado      user story created, commit message to clipboard
```

## Connections

Every org is reached the same way: **the browser's own Salesforce session**.
The user logs in normally, and the extension reads the `sid` cookie that login
produced. Nothing is created, installed or configured in any of them.

- **Source org** — the active browser tab, auto-detected. No saved credential.
- **Saved orgs** — max 8, each tagged `target` or `copado`. **One connected per
  role**, not one overall: a direct deployment needs its target and a Copado
  deployment needs the Copado org, and the route is chosen at deploy time, so
  both have to be able to hold a session at once.

## Direct deployment

The two halves deliberately use different APIs:

| Step | API | Why |
|---|---|---|
| Retrieve from source | SOAP `/services/Soap/m/{v}` | No REST retrieve resource exists |
| Deploy to target | REST `/services/data/v{v}/metadata/deployRequest` | multipart, faster than SOAP |

Both are asynchronous and polled. Progress is reported as it goes, because a
deployment running tests can take many minutes and a silent popup looks hung.

**Validate only is on by default.** Deploying into another org is the one
genuinely destructive thing this extension does, so it has to be turned off
deliberately. The confirm button reads `Validate` or `Deploy` to match.

Failures are shown per component with Salesforce's own `problem` text, and
Apex test failures alongside them. Note that `componentFailures` comes back as
a bare object rather than an array when there is exactly one, which is the
common case and easy to drop.

### The multipart body is hand-built, deliberately

`deployRequest` rejects `FormData` with **"The request body has an invalid
multipart format."** `FormData` stamps `filename="blob"` onto any Blob part,
and the `json` part must not carry a filename — only the `file` part may.
There is no way to suppress that through the `FormData` API, so `multipart()`
writes the envelope directly and sets the boundary on the request itself.

Two things to preserve if this is ever touched:

- **CRLF, not LF**, between every header and part delimiter.
- The zip goes into the `Blob` as a **`Uint8Array`, never a string**. Zip data
  is binary and contains bytes above `0x7f`; concatenating it as text UTF-8
  encodes those and ships a corrupt archive that fails much later and much
  more confusingly.

Every OAuth route to a second org is closed as of Spring '26 (connected app
creation blocked; a `Local` external client app is refused cross-org; a
`Packaged` one needs its managed package installed in the target). All of them
put work in the other org, which is what this design avoids. `oauth.js` holds a
complete PKCE flow, unloaded, in case that ever changes.

The tradeoff: a session is not a refresh token. It dies on logout and on the
org's session timeout. `SfSession.renew()` picks up a rotated `sid` silently;
past that, the user reconnects.

## Copado schema is discovered, not assumed

Copado is a managed package, so its field API names cannot be verified from
outside the org. `copado.js` describes `copado__User_Story__c` and
`copado__User_Story_Metadata__c` at runtime and resolves each field from a
candidate list. An org that names things differently produces a named problem
on the confirm screen instead of a rejected insert.

If `copado__User_Story_Metadata__c` is absent or unreadable, the story is still
created — components just aren't attached, and the screen says so.

The story and all its components go in **one composite request with
`allOrNone`**, so a validation failure part way through cannot leave an orphan
story behind. Copado's own validation messages are shown verbatim, including
row-level errors returned inside an HTTP 200 sObject Collections response.

## The Copado route: pick a story, then prompt the agent

Three steps, because the destination and the instruction are separate decisions:

```
review   which method, and are both connections live
stories  an existing story, or the form for a new one
prompt   the generated instruction, editable, before it is sent
```

The Copado org connection is **read-only** — it lists user stories so one can be
picked. The work itself is done by the Copado AI agent, which is asked in plain
language rather than by writing records.

Two prompt shapes, generated from the choice made on the previous step:

```
Commit the following components to user story US-0000123:

- Account.Region__c (CustomField)
- Widget__c (CustomObject)

Use this commit message: …
```

```
Create a new user story titled "Region field on Account" in project Q3 Platform,
sprint Sprint 14, environment DEV1.

Then commit the following components to it:
…
```

Project, sprint and environment go in as **names, not record ids** — the agent
reads language. Optional parts are omitted rather than left as empty phrases.

The prompt is regenerated whenever the pane is revisited, so going back and
picking a different story does not leave a stale instruction — but only until
the user edits it, after which it is theirs and never overwritten.

`copado.js` still exports `create` and `attach`, which write user story records
directly. Nothing calls them. They are kept because they are correct and tested,
and are the fallback if prompting turns out not to fit.

Story fields are resolved from the describe, and so are the **relationship
names** used to query project and sprint. Swapping `__c` for `__r` happens to
work for custom lookups but breaks on anything standard or renamed, so the
describe is the only safe source.

Status colouring matches on intent words (`complete|done|closed`,
`progress|review|testing`) rather than an exact value list, because Copado
status picklists are configured per org and any fixed list would go stale.

### Why a story may refuse a commit

A story belongs to an environment. Committing to it from a *different* source
org is what Copado rejects — and after a story has been promoted, its
environment is often not the one you expect any more.

Rather than letting that surface as an error ten seconds after sending, the
browsed org is matched to a Copado credential by **Salesforce org id** (stored
15- or 18-character depending on how the credential was made, so the match is a
`LIKE` on the 15-character prefix), and its environment compared against each
story's. A difference marks the row `⚠ other source` and repeats the reason on
the prompt pane, which is the last point before the instruction goes out.

**It warns, it does not block.** If the check is wrong a block would stop
legitimate work, while a warning costs a glance — the same reasoning as
verifying a created story rather than trusting the agent.

An unresolvable source org claims no mismatch at all. Not knowing which
environment you are in is not evidence of being in the wrong one.

### What each row can show

Each row carries a **Details** disclosure with attached metadata and promotion
history — where the story has already gone, source → destination, with status
and date. That is the direct answer to "why is this story's environment not what
I expect any more".

Promotion objects are resolved by describe like everything else, and the two
sections load independently: a missing `copado__Promotion__c` costs the history
and leaves the metadata list working. It loads on expand and is cached, rather than being fetched for the
whole list up front: the list runs to 200 stories, and an `IN` clause over that
many ids builds a query string long enough to be refused.

Expansion state and the cache live outside `renderStories()`, so typing in the
search box neither collapses open rows nor re-queries the org.

The row is a `<div>`, not a `<button>`. It has to contain the disclosure
control, and a button inside a button is invalid markup that swallows the inner
click; the toggle stops propagation so expanding does not also select.

## Still open: does Copado read those records back?

**Unverified, and it decides how useful the attach step is.**

Copado's docs describe a **Recommit Files** operation where "all the components
that have been previously selected and committed in the user story (User Story
Selections) are automatically selected in the metadata grid" — so Copado does
read selection records to pre-populate the commit grid. Whether records *we*
create are honoured the same way as records Copado created is untested.

To settle it: create a user story through this extension, open Commit Changes
in Copado, and see whether the grid arrives pre-selected. If it doesn't, the
attach step is annotation only and we would need to match whatever a real
Copado commit writes — which means doing one by hand and inspecting the result.

## Copado AI (CopadoGPT)

Work driven by prompt rather than by writing records:

```
POST /organizations/{org}/workspaces                 create a workspace
POST /organizations/{org}/dialogues                  start a chat session
POST /organizations/{org}/dialogues/{id}/documents   attach a file
POST /organizations/{org}/dialogues/{id}/messages    send a prompt
```

Three details that fail confusingly if got wrong:

- **The host is `copadogpt-api.robotic.copado.com`**, not the
  `robotic.copado.com` app where the key is created.
- **The header is `X-Authorization` carrying the bare key.** Not
  `Authorization`, and no `Bearer` prefix — either sends the request
  unauthenticated and returns a 401 that says nothing about why.
- **Every path is scoped to an organization id.** The key alone cannot make a
  call, so the id is a required setting rather than an optional one.

The key lives in `chrome.storage.local` — the browser profile, not a vault. It
is never logged, never rendered back into the settings input, and never leaves
`copado-ai.js`. Saving with the key box empty keeps the stored key rather than
wiping it, so the org id or assistant can be edited on their own.

`request_id` is an idempotency key, generated per message rather than reused
across a dialogue. A dialogue is created once per opening of the deploy modal,
so follow-up prompts keep the agent's context.

### The message endpoint streams NDJSON

Not a JSON document — one object per line, emitted as the agent works:

```
{"type":"status","content":"Crafting solution"}
{"type":"token","content":"I'll start"}
{"type":"model_usage","usage_summary":{...}}
```

A single `JSON.parse` over the body fails, and treating that failure as "the
reply must be a string" hands the user a wall of JSON instead of the answer.
The reply is the `token` contents joined in order. `status` events are shown
live during the wait, which is what makes a twenty-second pause legible.

The body is read incrementally with `res.body.getReader()`, buffering the tail
of each chunk: a chunk boundary lands mid-line often enough that dropping the
partial line loses events at random.

The raw NDJSON is kept verbatim rather than re-serialised — it is the record of
what the agent actually did, and re-stringifying loses the per-event framing.

### Work is split across agents

Copado routes by agent, and sending to the wrong one gets a helpful answer and
no action:

| Agent | Job |
|---|---|
| `plan` | creates the user story |
| `release` | commits components to it |

Both are configurable in settings. The prompt pane picks the right one from the
action, so it is not a per-send decision.

This is why creating and committing are two exchanges rather than one prompt.
The create prompt carries **no component list** — components belong to the
commit, which the release agent handles afterwards using the selection already
made in the popup.

### Two ways in, because they are two different jobs

**Deploy…** starts from a metadata selection and is disabled without one.
**User stories** is never gated: browsing stories, and promoting one, have
nothing to do with which components are ticked. It skips the review pane —
which exists only to describe a set of components — and opens the picker
directly, falling back to the review pane when a connection is not usable so
the reason is visible.

### Commit, deploy, or both

The prompt pane carries an action selector, so the same story can be committed,
promoted and deployed, or both in one instruction:

```
Commit           Commit the following components to user story US-0000125: …
Deploy           Promote user story US-0000125 and deploy it to UAT.
Commit & deploy  both, in that order
```

Deploy exposes an environment picker filled from the Copado org. Leaving it
unset is deliberate rather than an error — the prompt then says "the next
environment in the pipeline", which is usually what is wanted and lets Copado's
own routing decide.

**The gate is per action, not per screen.** With nothing selected, Commit and
Commit & deploy are disabled with a reason on hover, the action falls back to
Deploy, and a note explains why. Promoting a story needs no components;
committing to one is meaningless without them. The same applies after creating
a story with nothing selected — the story is real, so it is reported, but no
Commit button appears.

A **Deploy** button also appears after any commit exchange, so the usual
sequence — create, commit, deploy — is three clicks without returning to the
picker. It works for a story picked from the list as well as one just created.

`runAgentTask()` holds the dialogue creation, threading and error handling that
commit and deploy share; they differ only in wording.

### Nothing is committed against an unverified story

After the plan agent claims to have created a story, its name is taken from the
reply if it gave one and then **confirmed against the Copado org** by query.
Only then does the Commit button appear. The agent's prose is a claim; the query
is the evidence, and without a match the button stays hidden.

Commit opens a fresh dialogue — different agent, different job — named for the
story so it is findable in Copado AI afterwards.

### The agent proposes before it acts

It plans, states the plan, and asks **"Do you want to proceed?"** — so a first
prompt creating nothing is the normal path, not a failure. `awaitsConfirmation()`
detects that ending and the UI says so outright, with the follow-up box prefilled
with "Yes, proceed."

This is worth remembering before hunting for a bug: the agent had found the
project and environment, resolved their ids, and was simply waiting.

## Automating the commit — worth revisiting

Earlier notes here said no public API existed for triggering a Copado commit.
**That was wrong.** Copado's Developer Hub documents three APIs:

- **Actions REST API** — commit, promote and deploy on 2nd generation pipelines
- **Webhooks REST API** — the same actions on 1st generation pipelines
- **Copado Global API** — global Apex methods callable from flows and Apex

So a supported path very likely exists, and reverse-engineering internal records
is not the only option. Which one applies depends on whether the pipeline is 1st
or 2nd generation — worth establishing before building anything on it.

Until then the extension links to the story and puts the commit message on the
clipboard, and the user presses Commit in Copado.

## Two things that will silently break this again

**`/services/data/` is a public endpoint.** It lists API versions to anyone,
token or no token. Using it as a liveness probe means every check passes on a
dead session, the connection shows a green CONNECTED dot, and the failure
surfaces much later as an unrelated-looking `INVALID_SESSION_ID`. `authProbe()`
uses it only to pick a version, then hits the **versioned** resource root
`/services/data/v66.0/`, which does require authentication. Never probe the
unversioned path.

**A sid cookie belongs to one host.** Matching cookies on the first label alone
looks harmless and is not: `acme.my.salesforce.com` and
`acme.sandbox.my.salesforce.com` are different orgs, and pairing one org's sid
with another's instance URL fails on the first real call. `findSidCookie()`
accepts an exact host, or a host that `apiHostFor()` maps to the same My Domain
— which covers the Lightning and Setup hosts and nothing else.

## Implementation notes

- The `sid` cookie scoped to `lightning.force.com` is **rejected by the REST
  API**. Only the My Domain one works; `apiHostFor()` maps it.
- Capture ignores `login.salesforce.com` and `test.salesforce.com` — a `sid`
  there belongs to whichever org the browser last authenticated.
- Capture polls rather than using `tabs.onUpdated`, because the cookie is
  written slightly after the navigation reports complete.
- The popup banner and settings card verify against the org on open, so a green
  dot means the session answered just now.
- `buildPackageXml()` is kept behind the **package.xml** button on the confirm
  screen. Nothing in the Copado flow uses it.
