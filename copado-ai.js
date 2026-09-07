'use strict';

/*
 * Copado AI (CopadoGPT) — driving work by prompt rather than by writing records.
 *
 *   POST /organizations/{org}/workspaces            create a workspace
 *   POST /organizations/{org}/dialogues             start a chat session
 *   POST /organizations/{org}/dialogues/{id}/documents   attach a file
 *   POST /organizations/{org}/dialogues/{id}/messages    send a prompt
 *
 * Three things here are easy to get wrong and fail confusingly:
 *
 *   - The host is copadogpt-api.robotic.copado.com, not the robotic.copado.com
 *     app the key is created in.
 *   - The header is X-Authorization with the bare key. Not `Authorization`, and
 *     not prefixed with `Bearer` — either sends the request unauthenticated.
 *   - Every path is scoped to an organization id, so the key alone is not
 *     enough to make a call.
 */

const CopadoAI = (() => {

  const STORAGE_KEY = 'copadoAi';

  const DEFAULTS = {
    baseUrl: 'https://copadogpt-api.robotic.copado.com',
    organizationId: '',
    apiKey: '',
  };

  /*
   * Which assistant does which job. Not a setting.
   *
   * Copado routes work by assistant: planning a user story and releasing one
   * are different ones, and sending to the wrong assistant gets a polite answer
   * and no action. The names are fixed by Copado rather than chosen per
   * install, so there is nothing here for a user to decide — and a typo in a
   * settings box would break every run with an error that reads like a bug.
   *
   * Constants rather than defaults: a value stored by an earlier build, when
   * these were editable, is ignored rather than carried forward.
   */
  const ASSISTANTS = {
    plan: 'plan',
    release: 'release',
  };

  /* ------------------------------------------------------------- storage */

  /*
   * The key and the organization id are sealed before they are written; see
   * crypto.js for what that is and is not worth. Opening them needs nothing
   * from the user, so there is no locked state and no unlock step — the
   * difference from plaintext is what a profile on disk gives up, not what the
   * extension has to ask for.
   *
   * The base URL stays readable. It is not a secret, and a support question
   * about the wrong host should be answerable by looking.
   */
  const SECRET_FIELDS = ['apiKey', 'organizationId'];

  async function load() {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const secrets = {};

    for (const field of SECRET_FIELDS) {
      const held = stored[field];

      // Written by an older build. Read it as it is; the next save seals it.
      secrets[field] = SecretStore.isPlaintext(held)
        ? held
        : (await SecretStore.open(held)) || '';
    }

    return {
      ...DEFAULTS,
      ...stored,
      ...secrets,
      // Last, so neither a caller nor a value left in storage by an older build
      // can put the wrong assistant in front of a request.
      planAssistant: ASSISTANTS.plan,
      releaseAssistant: ASSISTANTS.release,
    };
  }

  async function save(settings) {
    const current = await load();

    // Never persisted: the assistants are constants, and the two secrets are
    // written back sealed rather than as they arrived.
    const {
      planAssistant, releaseAssistant, apiKey, organizationId, ...rest
    } = { ...current, ...settings };

    const plain = { apiKey, organizationId };
    const sealed = {};
    for (const field of SECRET_FIELDS) {
      sealed[field] = await SecretStore.seal(plain[field] || '');
    }

    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        ...rest,
        ...sealed,
        baseUrl: (settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
        savedAt: new Date().toISOString(),
      },
    });

    return load();
  }

  const clear = () => chrome.storage.local.remove(STORAGE_KEY);
  async function isConfigured() {
    const { apiKey, organizationId } = await load();
    return Boolean(apiKey && organizationId);
  }

  /* ------------------------------------------------------------- request */

  /*
   * fetch rejects with a bare TypeError — "Failed to fetch" — for everything
   * that never reached a server: a host the extension has no permission for, a
   * base URL pointing nowhere, DNS, a proxy. Those need completely different
   * fixes and the browser's own wording distinguishes none of them.
   *
   * The one worth naming is permission. An extension may only call hosts listed
   * in its manifest, so a Copado AI instance on a host that is not listed fails
   * exactly like an outage — and no amount of re-entering the key helps.
   */
  async function request(url, init) {
    try {
      return await fetch(url, init);
    } catch (err) {
      throw new Error(await unreachable(url, err));
    }
  }

  async function unreachable(url, err) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return `"${url}" is not a valid URL. Check the base URL in settings.`;
    }

    if (!(await hostAllowed(origin))) {
      const fix = await nearMiss(origin);
      return `This extension is not allowed to call ${origin}.\n`
        + (fix
          ? `Did you mean ${fix}? Correct the base URL in settings.`
          : 'Its manifest permits Copado hosts only. If your Copado AI instance is '
            + 'somewhere else, the base URL in settings and the extension\'s '
            + 'host_permissions both have to name it, and the extension reloaded after.');
    }

    return `Could not reach ${origin}.\n`
      + 'Nothing answered. Check the base URL in settings, and whether a VPN, '
      + `proxy or firewall is blocking it. (${err.message})`;
  }

  async function hostAllowed(origin) {
    try {
      return await chrome.permissions.contains({ origins: [`${origin}/*`] });
    } catch {
      // No answer is not an accusation.
      return true;
    }
  }

  /*
   * A URL one keystroke from a working one.
   *
   * "copado.co" is a permitted host minus its last letter, and the permission
   * error it produces reads like a policy decision rather than a typo. The
   * repairs below are the slips a hand-typed host actually makes; each is only
   * suggested once the extension confirms it could call it.
   */
  async function nearMiss(origin) {
    const candidates = [
      `${origin}m`,                                   // copado.co  -> copado.com
      origin.replace(/\.con$/, '.com'),               // copado.con -> copado.com
      origin.replace(/^http:/, 'https:'),             // wrong scheme
      origin.replace(/^https:\/\/(?!copadogpt-api\.)/, 'https://copadogpt-api.'),
    ];

    for (const candidate of candidates) {
      if (candidate === origin) continue;
      if (await hostAllowed(candidate)) return candidate;
    }
    return null;
  }

  /*
   * Checks a base URL before it is stored, so a typo is caught in the box it
   * was typed into rather than as a failed call some screens later.
   *
   * Returns the cleaned URL to save, or the reason it cannot be used.
   */
  async function checkBaseUrl(raw) {
    const value = (raw || '').trim();
    if (!value) return { ok: true, url: DEFAULTS.baseUrl };

    let url;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, reason: `"${value}" is not a valid URL. It should look like ${DEFAULTS.baseUrl}` };
    }

    if (url.protocol !== 'https:') {
      return { ok: false, reason: 'The base URL must start with https://' };
    }

    if (!(await hostAllowed(url.origin))) {
      const fix = await nearMiss(url.origin);
      return {
        ok: false,
        reason: fix
          ? `This extension cannot call ${url.origin}. Did you mean ${fix}?`
          : `This extension cannot call ${url.origin}. Its manifest permits Copado hosts only.`,
      };
    }

    return { ok: true, url: `${url.origin}${url.pathname}`.replace(/\/+$/, '') };
  }

  /* ---------------------------------------------------------------- xsrf */

  /*
   * The API key alone is the whole of the authentication — the same request
   * Postman makes with one X-Authorization header succeeds.
   *
   * What breaks it from a browser is the cookie jar. If the user is signed in
   * to Copado, the request carries that session, and the server then treats it
   * as a browser session rather than an API-key call — and browser sessions
   * must prove they are not cross-site, which is where "Required X-Xsrf-Token
   * header" comes from. The key was never the problem.
   *
   * So calls go out with credentials omitted, which is exactly what Postman
   * sends. The token path below stays only as a fallback for a server that
   * demands one anyway, and it is the only request that carries cookies —
   * a token without its cookie fails the check it exists to pass.
   */
  // XSRF-TOKEN, X-XSRF-TOKEN, xsrf_token, _csrf_token, csrftoken — the same
  // cookie under every spelling in circulation.
  const XSRF_COOKIE = /^_?(x[-_]?)?(xsrf|csrf)[-_]?token$/i;

  async function readXsrf(baseUrl) {
    try {
      const cookies = await chrome.cookies.getAll({ url: baseUrl });
      const hit = cookies.find((c) => XSRF_COOKIE.test(c.name))
        || cookies.find((c) => /xsrf|csrf/i.test(c.name));

      // Cookie values are URL-encoded often enough that sending the raw form
      // fails the comparison on the server.
      return hit ? decodeURIComponent(hit.value) : null;
    } catch {
      return null;
    }
  }

  async function xsrfToken(baseUrl, { fresh = false } = {}) {
    if (!fresh) {
      const existing = await readXsrf(baseUrl);
      if (existing) return existing;
    }

    // The answer does not matter; the Set-Cookie on it does.
    try {
      await fetch(baseUrl, { method: 'GET', credentials: 'include' });
    } catch { /* offline is reported by the real call, not this one */ }

    return readXsrf(baseUrl);
  }

  const needsXsrf = (body) => /xsrf|csrf/i.test(
    typeof body === 'string' ? body : JSON.stringify(body || '')
  );

  /* ------------------------------------------------------------- request */

  async function call(path, { method = 'GET', body, form } = {}) {
    const settings = await load();

    if (!settings.apiKey) throw new Error('No Copado AI API key saved. Add one in settings.');
    if (!settings.organizationId) {
      throw new Error('No Copado AI organization id saved. Every endpoint is scoped to one.');
    }

    const url = `${settings.baseUrl}/organizations/${settings.organizationId}${path}`;

    const send = async (token) => request(url, {
      method,
      credentials: token ? 'include' : 'omit',
      headers: {
        'X-Authorization': settings.apiKey,
        Accept: 'application/json',
        ...(token ? { 'X-Xsrf-Token': token } : {}),
        // FormData sets its own content type, boundary included.
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form || (body ? JSON.stringify(body) : undefined),
    });

    let res = await send(null);
    let parsed = await readBody(res);

    // A token can also be stale rather than absent, and the two are told apart
    // only by trying: one forced refresh, then the answer stands.
    if (!res.ok && needsXsrf(parsed)) {
      res = await send(await xsrfToken(settings.baseUrl, { fresh: true }));
      parsed = await readBody(res);
    }

    if (!res.ok) throw new Error(describeError(res, parsed, `${method} ${path}`));
    return parsed;
  }

  async function readBody(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }

  /*
   * What went wrong, in the words the service used, and what to do about it.
   *
   * The endpoint and status code are not part of the message. "POST
   * /dialogues/<uuid>/messages — 400" tells the person reading it nothing they
   * can act on, and a REST path on screen is an implementation detail leaking
   * into the product. Both go to the console instead, where they are still
   * there for a bug report.
   *
   * res.statusText is empty over HTTP/2, so it is never relied on alone.
   */
  function describeError(res, body, where) {
    const status = [res.status, res.statusText].filter(Boolean).join(' ');
    const detail = detailText(body);
    const hint = hintFor(res.status, detail);

    console.error(`Copado AI: ${where} — ${status}`, body);

    return [
      detail || `Copado rejected the request (${status}).`,
      hint,
    ].filter(Boolean).join('\n');
  }

  /*
   * A guess about the cause, offered only where it fits.
   *
   * The guesses for 400 and 404 are about one likely misconfiguration each, and
   * printing one under a detail that names a different cause is worse than
   * printing nothing — the reader ends up checking the wrong setting. So those
   * two are offered only when the service said nothing useful, or when what it
   * said points the same way.
   */
  function hintFor(status, detail) {
    // Three words on their own leave the reader with nothing to do. Said in
    // full, it is at least clear that the work never started and that waiting
    // or a plan change is the only way forward.
    if (/limit (exceeded|reached)|quota/i.test(detail)) {
      return 'This organization has used its allowance of Copado AI messages. ' +
        'Nothing was sent, so nothing has changed.';
    }

    // Reached only after the token was fetched and retried, so the cookie is
    // genuinely not arriving — nothing about the request body, whatever the
    // status code suggests.
    if (/xsrf|csrf/i.test(detail)) {
      return 'Copado\'s CSRF cookie could not be read. Open your Copado AI org in a '
        + 'browser tab, sign in, then try again — and check that the extension is '
        + 'not blocked from storing cookies for that site.';
    }

    if (status === 401 || status === 403) {
      return 'The API key was rejected. Check it is a Personal Access Key and still active.';
    }
    if (status === 422) {
      return 'The request body was rejected. The field named above is the one to fix.';
    }

    if (status === 404 && (!detail || /organi[sz]ation|not found/i.test(detail))) {
      return 'Check the organization id in settings — every path is scoped to one.';
    }

    // Not something the user can fix from here — the assistant names are fixed
    // — so the hint says who can rather than pointing at a setting that no
    // longer exists.
    if (status === 400 && /assistant/i.test(detail)) {
      return `This organization does not have the "${ASSISTANTS.plan}" and ` +
        `"${ASSISTANTS.release}" assistants this needs. Ask your Copado administrator ` +
        'to enable them.';
    }
    if (status === 400 && !detail) {
      return 'Copado gave no reason. Check the organization id and key in settings.';
    }
    return '';
  }

  // Error payloads come back in several shapes, and the one that matters most
  // — a validation failure — arrives as an array of objects under `detail`.
  // Concatenating that into a string yields "[object Object]" and hides the
  // only useful part, so every branch here ends at real text.
  function detailText(body) {
    if (!body) return '';
    if (typeof body === 'string') return body.slice(0, 500);

    const detail = body.detail ?? body.errors ?? body.message ?? body.error;

    if (Array.isArray(detail)) {
      return detail.map(oneDetail).filter(Boolean).join('\n');
    }
    if (typeof detail === 'string') return detail;

    // {"error": {"message": "..."}} is common enough that stringifying it would
    // hide the one readable field it has.
    if (detail && typeof detail === 'object') {
      const nested = detail.message || detail.detail || detail.msg;
      if (typeof nested === 'string') return nested;
      return JSON.stringify(detail, null, 2).slice(0, 500);
    }

    // Nothing recognisable: show the payload rather than an empty message.
    return JSON.stringify(body, null, 2).slice(0, 500);
  }

  function oneDetail(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return String(item);

    // FastAPI reports the offending field as a loc path; "body" is noise.
    const where = Array.isArray(item.loc)
      ? item.loc.filter((p) => p !== 'body').join('.')
      : item.field || item.param || '';

    const message = item.msg || item.message || item.detail || JSON.stringify(item);
    return where ? `${where}: ${message}` : message;
  }

  /* ------------------------------------------------------------ requests */

  // Path inferred from the POST route, not documented. If the agent answers
  // asynchronously this is where the reply turns up; a 404 here says the guess
  // was wrong, which the error text now makes plain.
  const listMessages = (dialogueId) => call(`/dialogues/${dialogueId}/messages`);

  const createWorkspace = (name, description = '') =>
    call('/workspaces', { method: 'POST', body: { name, description } });

  const listWorkspaces = () => call('/workspaces');

  // The published curl example posts a bare {}, but the API rejects that with
  // "name: Field required". The name is what identifies the session in the
  // Copado AI UI afterwards, so it is worth making descriptive.
  const createDialogue = (name) =>
    call('/dialogues', {
      method: 'POST',
      body: { name: (name || '').trim() || `Metadata Explorer ${new Date().toISOString().slice(0, 16)}` },
    });

  function uploadDocument(dialogueId, file) {
    const form = new FormData();
    form.append('file', file);
    return call(`/dialogues/${dialogueId}/documents`, { method: 'POST', form });
  }

  /*
   * The message endpoint answers with NDJSON — one JSON object per line,
   * streamed as the agent works, not a single document:
   *
   *   {"type":"status","content":"Crafting solution"}
   *   {"type":"token","content":"I'll start"}
   *   {"type":"model_usage","usage_summary":{...}}
   *
   * A single JSON.parse over the whole body fails, and treating the failure as
   * "the reply is a string" hands the caller a wall of JSON instead of the
   * answer. The reply is the token contents, joined in order.
   *
   * request_id is the caller's idempotency key, generated per message rather
   * than reused across a dialogue.
   */
  async function sendMessage(dialogueId, prompt, assistantId, onEvent) {
    const settings = await load();
    const assistant = assistantId || ASSISTANTS.release;

    const url = `${settings.baseUrl}/organizations/${settings.organizationId}`
      + `/dialogues/${dialogueId}/messages`;

    // request_id is the caller's idempotency key. It is generated once and
    // reused across the retry below, so a token refresh cannot turn one message
    // into two.
    const payload = JSON.stringify({
      request_id: crypto.randomUUID(),
      prompt,
      assistantId: assistant,
    });

    const send = async (token) => request(url, {
      method: 'POST',
      credentials: token ? 'include' : 'omit',
      headers: {
        'X-Authorization': settings.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, application/json',
        ...(token ? { 'X-Xsrf-Token': token } : {}),
      },
      body: payload,
    });

    let res = await send(null);

    if (!res.ok) {
      let parsed = await readBody(res);

      if (needsXsrf(parsed)) {
        res = await send(await xsrfToken(settings.baseUrl, { fresh: true }));
        if (!res.ok) parsed = await readBody(res);
      }

      if (!res.ok) {
        throw new Error(describeError(res, parsed, `POST /dialogues/${dialogueId}/messages`));
      }
    }

    return readStream(res, onEvent);
  }

  // Read as it arrives rather than awaiting the whole body: the agent takes
  // tens of seconds and emits status events throughout, which are the only
  // thing that makes the wait legible.
  async function readStream(res, onEvent) {
    const events = [];
    let raw = '';
    let buffer = '';

    const emit = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        events.push(event);
        onEvent?.(event);
      } catch { /* a line that is not JSON is not an event */ }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;

      // The last element is whatever came after the final newline: a partial
      // line that must wait for the next chunk before it can be parsed.
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(emit);
    }
    emit(buffer);

    return summarise(events, raw);
  }

  function summarise(events, raw) {
    const usage = events.filter((e) => e.type === 'model_usage').pop();

    return {
      reply: events.filter((e) => e.type === 'token').map((e) => e.content || '').join(''),
      statuses: events.filter((e) => e.type === 'status').map((e) => e.content),
      usage: usage?.usage_summary || null,
      events,
      raw,
    };
  }

  // Copado proposes before it acts, so a reply that ends in a question is
  // usually a plan awaiting a yes rather than a refusal. Worded broadly on
  // purpose: a missed question strands the user on a result screen that says
  // nothing happened, with no way to say go.
  /*
   * A reply that is genuinely waiting for a go-ahead.
   *
   * Worded tightly on purpose. A loose match here is expensive: every false
   * positive stops the run and puts a Yes/No question in front of the user, so
   * a reply merely offering to help — "would you like me to explain the
   * pipeline?" — turns a single commit into an interrogation.
   *
   * Two things must both hold. The reply has to actually end in a question,
   * which rules out an offer made in passing halfway through an explanation.
   * And that question has to be about proceeding, not about anything else.
   */
  function awaitsConfirmation(reply) {
    if (!reply) return false;

    const tail = reply.slice(-300).trim().toLowerCase();
    const explicit = /please confirm|confirm:/.test(tail);
    if (!explicit && !tail.endsWith('?')) return false;

    return explicit
      || /\b(confirm|proceed|go ahead|continue)\b/.test(tail)
      || /\b(shall|should) i\b/.test(tail)
      || /\b(do you want|would you like) me to\b/.test(tail);
  }

  /* -------------------------------------------------------------- verify */

  // Reports what the service said rather than a yes/no: 401 means the key is
  // wrong, 404 usually means the organization id is.
  /*
   * Tests the endpoint the extension actually depends on.
   *
   * Everything here runs through dialogues, so a key that can reach dialogues
   * is a working key. Workspaces was the wrong thing to test: a key without
   * access to it fails this check while the extension would have worked fine,
   * which is a connection reported as broken for no reason the user can act on.
   */
  async function verify() {
    const settings = await load();
    if (!settings.apiKey) return { ok: false, reason: 'No API key saved.' };
    if (!settings.organizationId) return { ok: false, reason: 'No organization id saved.' };

    try {
      const body = await call('/dialogues');

      // What came back is worth having when a connection misbehaves, and is
      // not worth putting on screen: the question the button asks is whether
      // the key works, and a dialogue count does not help answer it.
      const list = Array.isArray(body) ? body : body?.results || body?.dialogues || [];
      console.debug('Copado AI verify: %d dialogue(s) visible to this key', list.length);

      return { ok: true, reason: `Connected to organization ${settings.organizationId}.` };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /* -------------------------------------------------------------- replies */

  // The message response shape is not documented, so the reply is pulled from
  // whichever of the usual fields is present and the raw payload is kept as a
  // fallback rather than showing the user nothing.
  function replyText(response) {
    if (!response) return null;
    if (typeof response === 'string') return response;
    if (typeof response.reply === 'string' && response.reply) return response.reply;

    const direct = response.message || response.response || response.content
      || response.text || response.answer || response.completion;
    if (typeof direct === 'string') return direct;

    const messages = response.messages || response.results;
    if (Array.isArray(messages) && messages.length) {
      const last = messages[messages.length - 1];
      const nested = last?.message || last?.content || last?.text;
      if (typeof nested === 'string') return nested;
    }

    return null;
  }

  return {
    load, save, clear, isConfigured, verify,
    createWorkspace, listWorkspaces, createDialogue, uploadDocument, sendMessage, listMessages,
    replyText, awaitsConfirmation, checkBaseUrl, DEFAULTS, ASSISTANTS,
  };
})();
