'use strict';

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  $('environment').addEventListener('change', (e) => {
    const custom = e.target.value === 'custom';
    $('custom-url-wrap').hidden = !custom;
    // Only a My Domain URL lets connect() verify it landed on the right org.
    $('generic-warning').hidden = custom;
  });

  $('org-form').addEventListener('submit', onSave);
  $('reset-btn').addEventListener('click', () => {
    $('org-form').reset();
    $('custom-url-wrap').hidden = false;
    $('generic-warning').hidden = true;
    hideMessage();
  });

  wireCopadoAi();
  renderOrgs();
});

/* ------------------------------------------------------------ copado ai */

/*
 * The reveal password guards showing the credentials, not using them.
 *
 * Copado AI keeps working whether one is set or not — the extension reads the
 * stored values on every call without asking anybody. What the password stops
 * is the two fields appearing on screen: a shoulder, a screen share, a
 * screenshot pasted into a ticket.
 *
 * Required, not optional: without one there is no way to show the values at
 * all. Changing it needs the current one — and because it is only a screen
 * guard, a forgotten one is not a lockout: the fields still accept new values
 * while masked, and Clear starts over.
 *
 * The password is not stored. crypto.js keeps a PBKDF2 verifier, which can
 * answer whether a password is right and cannot produce one — so a forgotten
 * password is removed rather than recovered: Clear takes the key, the
 * organization id and the password together, and a new password is set
 * against the new key.
 */
const GUARD_KEY = 'revealGuard';

// Survives until the settings page is closed. Entering the password once to
// read a value and again to read the one beside it would teach only annoyance.
let revealAllowed = false;

const guardOf = async () => (await chrome.storage.local.get(GUARD_KEY))[GUARD_KEY] || null;

// "key", "key and organization id", "key, organization id and reveal password"
const listOf = (parts) => (parts.length < 3
  ? parts.join(' and ')
  : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

async function wireCopadoAi() {
  await renderAiState();

  for (const button of document.querySelectorAll('.reveal')) {
    button.addEventListener('click', () => onReveal(button));
  }

  $('guard-ok').addEventListener('click', onUnlockReveal);
  $('guard-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') onUnlockReveal(); });

  $('guard-cancel').addEventListener('click', () => {
    $('guard-ask').hidden = true;
    $('guard-input').value = '';
  });

  $('guard-set').addEventListener('click', openGuardForm);
  $('guard-new-cancel').addEventListener('click', closeGuardForm);
  $('guard-new-ok').addEventListener('click', onSetGuard);

  /*
   * The base URL is the one field a typo silently breaks: a wrong host fails
   * later as a network error that reads nothing like a mistyped address. It is
   * checked here, in the box it was typed into.
   */
  async function storeSettings() {
    const base = await CopadoAI.checkBaseUrl($('ai-base').value);
    if (!base.ok) return base;

    const current = await CopadoAI.load();
    const key = $('ai-key').value.trim();
    const org = $('ai-org').value.trim();

    // A blank box keeps what is already stored rather than erasing it, so
    // changing only the organization id does not silently drop the key.
    const apiKey = key || current.apiKey;
    const organizationId = org || current.organizationId;

    /*
     * Both are required, and a blank box can only stand in for a value that
     * was stored — never for one that was never set. Without this the card
     * writes two empty strings and reports "Saved." for settings that cannot
     * make a single call, which is then discovered two screens into a deploy.
     */
    const missing = [
      !organizationId && 'organization id',
      !apiKey && 'personal access key',
    ].filter(Boolean);

    if (missing.length) {
      return {
        ok: false,
        reason: `Enter the ${listOf(missing)}. Copado AI needs both — every `
          + 'endpoint is scoped to an organization, and the key authenticates it.',
      };
    }

    await CopadoAI.save({ baseUrl: base.url, apiKey, organizationId });

    await renderAiState();
    return { ok: true };
  }

  $('ai-save').addEventListener('click', async () => {
    const result = await storeSettings();
    showAiMessage(result.ok ? 'Saved.' : result.reason, result.ok ? 'ok' : 'err');
  });

  $('ai-verify').addEventListener('click', async () => {
    const button = $('ai-verify');
    button.disabled = true;
    button.textContent = 'Testing…';

    // Save first, so Test checks what is on screen rather than what was stored
    // on the last visit. A base URL that cannot be saved is not worth testing.
    const stored = await storeSettings();
    if (!stored.ok) {
      showAiMessage(stored.reason, 'err');
      button.disabled = false;
      button.textContent = 'Test connection';
      return;
    }

    const result = await CopadoAI.verify();
    showAiMessage(result.reason, result.ok ? 'ok' : 'err');

    button.disabled = false;
    button.textContent = 'Test connection';
  });

  // The reveal password goes with the values it guards. It cannot be
  // recovered, so without this a forgotten one would outlive the key it was
  // set for and guard the next key too — with no way back short of
  // reinstalling. Destroying both is safe in a way that showing either is
  // not: whoever can click this could already clear the settings.
  $('ai-clear').addEventListener('click', async () => {
    // What is actually stored, asked before anything is promised. Naming all
    // three regardless reports removing values the user never set, which reads
    // as the extension having held something it did not.
    const settings = await CopadoAI.load();
    const held = [
      settings.apiKey && 'key',
      settings.organizationId && 'organization id',
      (await guardOf()) && 'reveal password',
    ].filter(Boolean);

    if (!held.length) {
      showAiMessage('Nothing to clear — no key, organization id or reveal '
        + 'password is saved.', 'ok');
      return;
    }

    if (!confirm(`Remove the Copado AI ${listOf(held)}?`)) return;

    await CopadoAI.clear();
    await chrome.storage.local.remove(GUARD_KEY);

    // Any reveal already granted dies with the password that granted it.
    revealAllowed = false;
    pendingReveal = null;
    closeGuardForm();

    $('ai-base').value = CopadoAI.DEFAULTS.baseUrl;
    await renderAiState();
    showAiMessage(`${sentence(listOf(held))} removed.`, 'ok');
  });
}

/* ------------------------------------------------------- reveal gate */

// Which field was being revealed when the password was asked for, so the
// right one opens once it is given.
let pendingReveal = null;

async function onReveal(button) {
  const input = $(button.dataset.for);

  // Hiding never needs permission.
  if (input.type === 'text') { mask(input, button); return; }

  if (revealAllowed) { unmask(input, button); return; }

  // Nothing is shown without a password, so the first reveal sets one rather
  // than refusing and leaving the user to work out why.
  const guard = await guardOf();
  if (!guard) {
    await openGuardForm();
    showAiMessage('Set a reveal password first — it is needed to show these values.', 'err');
    return;
  }

  pendingReveal = button;
  $('guard-ask').hidden = false;
  $('guard-input').value = '';
  $('guard-input').focus();
}

async function openGuardForm() {
  const guard = await guardOf();

  // Asked for only when there is one to change. Requiring it protects a set
  // password from anyone who walks up to an open settings page.
  $('guard-old-wrap').hidden = !guard;
  $('guard-new').hidden = false;
  $(guard ? 'guard-old' : 'guard-a').focus();
}

async function onUnlockReveal() {
  const guard = await guardOf();
  const ok = await SecretStore.checkVerifier($('guard-input').value, guard);

  if (!ok) {
    showAiMessage('That is not the reveal password.', 'err');
    return;
  }

  revealAllowed = true;
  $('guard-ask').hidden = true;
  $('guard-input').value = '';

  if (pendingReveal) {
    unmask($(pendingReveal.dataset.for), pendingReveal);
    pendingReveal = null;
  }
}

async function onSetGuard() {
  const guard = await guardOf();
  const first = $('guard-a').value;
  const again = $('guard-b').value;

  if (guard && !(await SecretStore.checkVerifier($('guard-old').value, guard))) {
    showAiMessage('The current reveal password is not right.', 'err');
    return;
  }

  if (first.length < 4) {
    showAiMessage('Use at least four characters.', 'err');
    return;
  }
  if (first !== again) {
    showAiMessage('Those two do not match.', 'err');
    return;
  }

  await chrome.storage.local.set({ [GUARD_KEY]: await SecretStore.makeVerifier(first) });

  // Set it, and the fields close behind it — otherwise the first thing the
  // password does is nothing.
  revealAllowed = false;
  closeGuardForm();
  await renderAiState();
  showAiMessage('Reveal password set. It is needed to show these values.', 'ok');
}

// Cleared as it closes: the characters typed here should not sit in the DOM
// waiting for the next person to open devtools.
function closeGuardForm() {
  $('guard-new').hidden = true;
  $('guard-old').value = '';
  $('guard-a').value = '';
  $('guard-b').value = '';
}

function unmask(input, button) {
  input.type = 'text';
  button.textContent = 'Hide';
  button.setAttribute('aria-label', 'Hide');
}

function mask(input, button) {
  input.type = 'password';
  button.textContent = 'Show';
  button.setAttribute('aria-label', 'Show');
}

// Reads the stored values back into the form. They arrive readable — the
// masking is a screen decision, not a storage one.
async function renderAiState() {
  const settings = await CopadoAI.load();
  const guard = await guardOf();

  $('ai-base').value = settings.baseUrl;
  $('ai-org').value = settings.organizationId;
  $('ai-key').value = settings.apiKey;

  // Re-masked on every render, so a reveal does not survive a save.
  for (const button of document.querySelectorAll('.reveal')) {
    mask($(button.dataset.for), button);
  }

  $('guard-set').textContent = guard ? 'Change reveal password' : 'Set reveal password';
  $('guard-ask').hidden = true;

  // Nothing stored is nothing to remove. Shut rather than clickable with a
  // message reporting that it did nothing.
  const holds = Boolean(settings.apiKey || settings.organizationId || guard);
  $('ai-clear').disabled = !holds;
  $('ai-clear').title = holds
    ? 'Remove what is stored for Copado AI'
    : 'Nothing is saved to clear';

  $('guard-note').textContent = guard
    ? 'A password is needed to show these two values. Copado AI keeps working '
      + 'without it — this hides them on screen, it does not lock the extension.'
    : 'No reveal password is set, so these values cannot be shown. Set one to '
      + 'read them back; the extension works either way.';
}
function showAiMessage(text, kind) {
  const box = $('ai-msg');
  box.textContent = text;
  box.className = `show ${kind}`;
}

/* ---------------------------------------------------------------- save */

async function onSave(event) {
  event.preventDefault();

  const environment = $('environment').value;
  const loginUrl = environment === 'custom' ? $('login-url').value.trim() : environment;

  if (!loginUrl) {
    showMessage('Enter the My Domain URL for this org.', 'err');
    return;
  }
  if (!/^https:\/\//i.test(loginUrl)) {
    showMessage('The login URL must start with https://.', 'err');
    return;
  }

  const org = {
    id: crypto.randomUUID(),
    alias: $('alias').value.trim(),
    loginUrl: loginUrl.replace(/\/+$/, ''),
    username: null,
    orgId: null,
    userId: null,
    accessToken: null,
    instanceUrl: null,
    connectedAt: null,
  };

  // There is one Copado org, so saving replaces it rather than adding to a
  // list. The id carries over when the name is unchanged, so the entry stays
  // recognisably the same connection after an edit to its URL.
  const [current] = await SfOrgs.all();
  if (current && current.alias.toLowerCase() === org.alias.toLowerCase()) org.id = current.id;

  // Any session belonged to what was saved before and does not carry over —
  // org is built with its token fields already null.
  await SfOrgs.save([org]);
  $('org-form').reset();
  // reset() restores My Domain as the selected option, so the URL box stays.
  $('custom-url-wrap').hidden = false;
  $('generic-warning').hidden = true;
  showMessage(`Saved "${org.alias}". Choose Connect below to log in.`, 'ok');
  renderOrgs();
}

/* ------------------------------------------------------------ org list */

async function renderOrgs() {
  const host = $('org-list');
  const orgs = await SfOrgs.all();
  host.innerHTML = '';

  if (!orgs.length) {
    host.appendChild(el('div', 'empty', 'No Copado org saved yet.'));
    return;
  }

  host.appendChild(orgCard(orgs[0]));
}

function orgCard(org) {
  const card = el('div', 'org');

  const badge = el('span', 'status', org.accessToken ? 'CHECKING…' : 'NOT CONNECTED');

  const top = el('div', 'org-top');
  top.append(
    el('div', 'org-name', org.alias),
    badge
  );

  const sub = el('div', 'org-sub', org.accessToken
    ? `${org.username || org.userId} · ${org.instanceUrl}`
    : org.loginUrl);

  const actions = el('div', 'org-actions');

  /*
   * Which actions the card offers, decided by whether the session actually
   * answers rather than by whether a token string survived in storage.
   *
   * An expired session is not a connection. Offering Disconnect there asks the
   * user to end something already over, and withholds the one action the badge
   * has just told them to take — so the button becomes Connect, and Fresh login
   * returns alongside it for the case where the browser is still holding a dead
   * session for this org.
   */
  const setActions = (live, checking = false) => {
    actions.innerHTML = '';

    if (!live && !checking) {
      const freshBtn = el('button', 'btn small', 'Fresh login');
      freshBtn.type = 'button';
      freshBtn.title = 'Sign out of this org first, so the login is not skipped';
      freshBtn.addEventListener('click', () => onConnect(org, freshBtn, true));
      actions.append(freshBtn);
    }

    const deleteBtn = el('button', 'btn danger small', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => onDelete(org));

    const mainBtn = el('button', 'btn primary small', live ? 'Disconnect' : 'Connect');
    mainBtn.type = 'button';
    mainBtn.disabled = checking;
    if (checking) mainBtn.title = 'Checking the session…';
    mainBtn.addEventListener('click', () => {
      if (live) onDisconnect(org);
      else onConnect(org, mainBtn);
    });

    actions.append(deleteBtn, mainBtn);
  };

  // A stored token is all there is to go on until the org answers, so the
  // button it implies is shown but held shut until the check settles.
  setActions(Boolean(org.accessToken), Boolean(org.accessToken));

  // Verified on render: a badge that reads CONNECTED because a string sits in
  // storage is the thing worth avoiding.
  if (org.accessToken) runVerify(org, badge, sub, setActions);

  card.append(top, sub, actions);
  return card;
}

/* -------------------------------------------------------------- verify */

async function runVerify(org, badge, sub, setActions) {
  badge.textContent = 'CHECKING…';
  badge.className = 'status';

  const result = await SfSession.verify(org);

  // A rotated sid is a successful check, not a new connection, so it is saved
  // without disturbing which org is the active target.
  if (result.renewed) await SfOrgs.update(org.id, result.renewed);

  if (result.ok) {
    badge.textContent = 'CONNECTED';
    badge.className = 'status live';
    sub.textContent = describeSession(org, result);
    setActions(true);
  } else {
    badge.textContent = 'SESSION EXPIRED';
    badge.className = 'status stale';
    sub.textContent = result.reason;
    // The session is gone whatever storage still holds, so the card stops
    // offering to end it and offers to rebuild it instead.
    setActions(false);
  }
}

// Names the org that actually answered, so a session captured from the wrong
// browser login is visible rather than merely "connected".
function describeSession(org, result) {
  const d = result.details;
  const identity = [d?.Name, result.username].filter(Boolean).join(' · ');
  const meta = [
    d && (d.IsSandbox ? 'Sandbox' : d.OrganizationType),
    result.orgId,
    result.apiVersion && `api ${result.apiVersion}`,
  ].filter(Boolean).join(' · ');

  return [identity || result.username, org.instanceUrl, meta].filter(Boolean).join('\n');
}

async function onDelete(org) {
  if (!confirm(`Delete the Copado org "${org.alias}"?`)) return;
  await SfOrgs.remove(org.id);
  showMessage(`Deleted "${org.alias}".`, 'ok');
  renderOrgs();
}

/* ------------------------------------------------------------- connect */

// Opens the org's login page in a tab and adopts the session that login
// creates. Nothing is registered in the target org, which is the whole point:
// every OAuth route needs an app or a package installed there.
async function onConnect(org, button, forceLogin = false) {
  button.disabled = true;
  button.textContent = 'Waiting for login…';
  showMessage(`Log in to "${org.alias}" in the tab that just opened. This window keeps waiting.`, 'ok');

  try {
    const session = await SfSession.connect(org.loginUrl, { forceLogin });
    await SfOrgs.setConnected(org.id, session);

    showMessage([
      `Connected to "${org.alias}" as ${session.username || session.userId}`,
      session.instanceUrl,
    ].join('\n'), 'ok');
  } catch (err) {
    showMessage(`Could not connect to "${org.alias}".\n${err.message}`, 'err');
  } finally {
    renderOrgs();
  }
}

// Only the extension's copy of the session is dropped. Revoking it server-side
// would log the user out of the org in their own browser, which is not what
// disconnecting a connection here should do.
async function onDisconnect(org) {
  await SfOrgs.update(org.id, {
    accessToken: null,
    instanceUrl: null,
    connectedAt: null,
  });

  showMessage(`Disconnected from "${org.alias}". Your browser login is untouched.`, 'ok');
  renderOrgs();
}

/* ----------------------------------------------------------- helpers */

function showMessage(text, kind) {
  const box = $('form-msg');
  box.textContent = text;
  box.className = `show ${kind}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideMessage() {
  $('form-msg').className = '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
