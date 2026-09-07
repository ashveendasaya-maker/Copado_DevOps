'use strict';

/*
 * Target org connections backed by the browser's own Salesforce session.
 *
 * Every OAuth route to a target org is closed as of Spring '26: connected apps
 * can no longer be created, a Local external client app is refused cross-org,
 * and a Packaged one fails with "External client app is not installed in this
 * org" until its managed package is installed there. All of them put work in
 * the target org, which is what this design exists to avoid.
 *
 * So the extension does what Salesforce Inspector and ORGanizer do instead: the
 * user logs into the target org in a normal tab, and the extension reads the
 * session cookie that login produced. Nothing is registered in the target org
 * at all, and SSO and MFA keep working because Salesforce handles the login.
 *
 * The tradeoff is that a session is not a refresh token. It dies on logout and
 * on the org's session timeout, and the user reconnects when it does.
 */

const SfSession = (() => {

  const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_MS = 800;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* -------------------------------------------------------------- hosts */

  // A sid cookie scoped to lightning.force.com is not accepted by the REST API;
  // the SOAP/REST endpoints only honour the one issued for the My Domain host.
  function apiHostFor(hostname) {
    return hostname
      .replace(/\.lightning\.force\.com$/, '.my.salesforce.com')
      .replace(/\.my\.salesforce-setup\.com$/, '.my.salesforce.com');
  }

  const isSalesforceHost = (host) => /(salesforce\.com|force\.com)$/.test(host);

  // login/test are the generic front doors. A sid there belongs to whichever
  // org the browser last authenticated, not necessarily the one being
  // connected, so capture waits until the redirect lands on a real org host.
  const isGenericLoginHost = (host) => /^(login|test)\.salesforce\.com$/.test(host);

  async function findSidCookie(apiHost) {
    const all = await chrome.cookies.getAll({ name: 'sid' });
    const bare = (c) => c.domain.replace(/^\./, '');

    const exact = all.find((c) => bare(c) === apiHost);
    if (exact) return exact;

    // Salesforce also writes the sid on the Lightning and Setup hosts of the
    // same org, and those map back to this My Domain, so they are safe to use.
    //
    // Matching on the first label alone is not. "acme.my.salesforce.com" and
    // "acme.sandbox.my.salesforce.com" are different orgs, and pairing one
    // org's sid with another's instance URL yields INVALID_SESSION_ID on the
    // first real call — long after the connection claimed to succeed.
    return all.find((c) => apiHostFor(bare(c)) === apiHost) || null;
  }

  /* ------------------------------------------------------------ identity */

  // /services/data/ is PUBLIC. It lists API versions to anyone, token or not,
  // so hitting it proves the host is a Salesforce instance and nothing at all
  // about the session. The versioned resource root does require authentication,
  // which is what actually tests the token.
  //
  // Getting this wrong means every check passes on a dead session and the
  // failure surfaces much later, as an unrelated-looking error.
  async function authProbe(instanceUrl, token) {
    const versions = await fetch(`${instanceUrl}/services/data/`, {
      headers: { Accept: 'application/json' },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    if (!versions || !versions.length) return { ok: false, apiVersion: null, status: null };

    const apiVersion = `v${versions[versions.length - 1].version}`;

    const res = await fetch(`${instanceUrl}/services/data/${apiVersion}/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }).catch(() => null);

    return { ok: Boolean(res && res.ok), apiVersion, status: res ? res.status : null };
  }

  // Confirms the session is usable against the API rather than merely present,
  // and names the org it belongs to so a mis-targeted login is visible.
  async function describe(instanceUrl, token) {
    const probe = await authProbe(instanceUrl, token);
    if (!probe.ok) return null;

    const info = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

    return {
      accessToken: token,
      instanceUrl,
      username: info.preferred_username || info.email || null,
      orgId: info.organization_id || null,
      userId: info.user_id || null,
      connectedAt: new Date().toISOString(),
    };
  }

  // A My Domain login URL names the org being connected. Anything else the tab
  // lands on is the browser reusing a session for a different org — which is
  // how a source org silently gets stored as the Copado org — so it is refused
  // rather than captured.
  function expectedHostFor(loginUrl) {
    try {
      const host = new URL(loginUrl).hostname;
      return isGenericLoginHost(host) ? null : apiHostFor(host);
    } catch {
      return null;
    }
  }

  async function captureFrom(url, expectedHost, seen) {
    if (!url) return null;

    let host;
    try { host = new URL(url).hostname; } catch { return null; }

    if (!isSalesforceHost(host) || isGenericLoginHost(host)) return null;

    const apiHost = apiHostFor(host);

    if (expectedHost && apiHost !== expectedHost) {
      seen?.add(apiHost);
      return null;
    }

    const cookie = await findSidCookie(apiHost);
    if (!cookie) return null;

    return describe(`https://${apiHost}`, cookie.value);
  }

  /* ------------------------------------------------------------- connect */

  // Opens the org's login page and watches that tab until a usable session
  // appears. Polling rather than tabs.onUpdated because the cookie is often
  // written slightly after the navigation that produced it reports complete.
  async function connect(loginUrl, { forceLogin = false } = {}) {
    const expectedHost = expectedHostFor(loginUrl);
    const seen = new Set();

    // The settings page itself runs in a popup-type window, which cannot host
    // extra tabs, so the login tab is aimed at a normal browser window.
    const [normal] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const tab = await chrome.tabs.create({
      // Logging out first is the only way to force a real login prompt when the
      // browser already holds a session. It ends that org's session only, so a
      // My Domain URL leaves every other org signed in.
      url: forceLogin && expectedHost ? `https://${expectedHost}/secur/logout.jsp` : loginUrl,
      active: true,
      ...(normal ? { windowId: normal.id } : {}),
    });

    if (forceLogin && expectedHost) {
      await delay(1500);
      await chrome.tabs.update(tab.id, { url: loginUrl }).catch(() => {});
    }

    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;

    try {
      while (Date.now() < deadline) {
        const live = await chrome.tabs.get(tab.id).catch(() => null);
        if (!live) throw new Error('Login tab closed before a session appeared.');

        const captured = await captureFrom(live.url, expectedHost, seen);
        if (captured) return captured;

        await delay(POLL_MS);
      }
      throw new Error(timeoutReason(expectedHost, seen));
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  function timeoutReason(expectedHost, seen) {
    if (expectedHost && seen.size) {
      return `Ended up in ${[...seen].join(', ')}, but this connection is for ` +
        `${expectedHost}. The browser reused an existing session — use Fresh login ` +
        'to sign out of that org first.';
    }
    if (!expectedHost) {
      return 'Timed out waiting for the login to finish. Saving the org\'s My Domain ' +
        'URL instead of the generic login page lets the extension check it landed ' +
        'on the right org.';
    }
    return 'Timed out waiting for the login to finish.';
  }

  /* --------------------------------------------------------------- renew */

  // Salesforce rotates the sid within a live browser session, so a token that
  // stopped working is often replaceable without sending the user back through
  // a login. Returns null when the browser has no live session for the org.
  async function renew(org) {
    if (!org.instanceUrl) return null;
    const cookie = await findSidCookie(new URL(org.instanceUrl).hostname);
    if (!cookie || cookie.value === org.accessToken) return null;
    return describe(org.instanceUrl, cookie.value);
  }

  /* -------------------------------------------------------------- verify */

  // A stored token only proves that a connect once succeeded. This asks the org
  // itself, and reports which org answered — a session captured from the wrong
  // browser login is otherwise indistinguishable from the right one.
  //
  // Never throws: the caller renders whatever came back.
  async function verify(org) {
    if (!org || !org.accessToken || !org.instanceUrl) {
      return { ok: false, reason: 'Not connected.' };
    }

    let token = org.accessToken;
    let probe = await authProbe(org.instanceUrl, token);

    // A dead token is usually just a rotated one; try the cookie before
    // declaring the connection lost.
    let renewed = null;
    if (!probe.ok) {
      renewed = await renew(org);
      if (!renewed) {
        return { ok: false, reason: 'Session expired. Log in to the org again and reconnect.' };
      }
      token = renewed.accessToken;
      probe = await authProbe(org.instanceUrl, token);
      if (!probe.ok) {
        return { ok: false, reason: 'Session expired. Log in to the org again and reconnect.' };
      }
    }

    const apiVersion = probe.apiVersion;

    const info = await fetch(`${org.instanceUrl}/services/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

    return {
      ok: true,
      renewed,
      apiVersion,
      username: info.preferred_username || info.email || null,
      orgId: info.organization_id || null,
      // Optional: the Organization record needs read access the running user
      // may not have, and its absence says nothing about the session.
      details: apiVersion ? await organization(org.instanceUrl, token, apiVersion) : null,
    };
  }

  async function organization(instanceUrl, token, apiVersion) {
    const soql = 'SELECT Name, OrganizationType, IsSandbox, InstanceName FROM Organization';
    const res = await fetch(
      `${instanceUrl}/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);

    if (!res || !res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const record = body.records?.[0];
    if (!record) return null;

    return { ...record, Name: realName(record.Name) };
  }

  /*
   * Salesforce fills an unset Organization Name with the literal string
   * "Not Provided" rather than leaving it null — scratch orgs arrive that way
   * by default. Passed along, it reads as the org's actual name and puts
   * "Copado Prod — Not Provided" in front of the user.
   *
   * Dropped here rather than at each place that shows it, so nothing downstream
   * has to know the placeholder exists.
   */
  const PLACEHOLDER_NAME = /^(not provided|not specified|unknown|n\/?a)$/i;

  const realName = (name) => {
    const trimmed = (name || '').trim();
    return trimmed && !PLACEHOLDER_NAME.test(trimmed) ? trimmed : null;
  };

  return { connect, renew, verify, authProbe, apiHostFor, findSidCookie };
})();

/*
 * Saved target orgs. Kept next to the session code so the popup can reach a
 * live token by loading this one file.
 */
const SfOrgs = (() => {

  // Fields written by flows this extension no longer uses: the old
  // username-password login, and the abandoned OAuth attempt.
  const LEGACY_FIELDS = ['password', 'securityToken', 'clientId', 'clientSecret', 'refreshToken'];

  // One Copado org, held in a one-element array so nothing downstream has to
  // change shape. Extra entries can only be left over from the old saved-org
  // list, and all() trims them on read using this: among live sessions the
  // newest wins, so the org last actually worked in is the one that survives.
  const only = (orgs) => orgs
    .filter((o) => o.accessToken)
    .sort((a, b) => (b.connectedAt || '').localeCompare(a.connectedAt || ''))[0]
    || orgs[0] || null;

  async function all() {
    const { orgs = [] } = await chrome.storage.local.get('orgs');

    let changed = false;
    for (const org of orgs) {
      for (const field of LEGACY_FIELDS) {
        if (field in org) { delete org[field]; changed = true; }
      }
    }

    // Roles are gone: there is one kind of connection, the Copado org. Orgs
    // saved under the old deployment-target role keep their entry and their
    // login URL, so nothing the user set up disappears — but the field itself
    // no longer decides anything.
    for (const org of orgs) {
      if (org.role) { delete org.role; changed = true; }
    }

    // Anyone upgrading from the saved-org list arrives with up to eight
    // entries. The connected one is the org they are actually working in, so
    // it survives and the rest are dropped; with none connected, the first.
    if (orgs.length > 1) {
      const keep = only(orgs);
      orgs.length = 0;
      if (keep) orgs.push(keep);
      changed = true;
    }

    if (changed) await chrome.storage.local.set({ orgs });

    return orgs;
  }

  const save = (orgs) => chrome.storage.local.set({ orgs });

  async function update(id, changes) {
    const orgs = await all();
    const org = orgs.find((o) => o.id === id);
    if (!org) return null;
    Object.assign(org, changes);
    await save(orgs);
    return org;
  }

  const remove = async (id) => save((await all()).filter((o) => o.id !== id));

  const active = async () => (await all()).find((o) => o.accessToken) || null;

  // Written only once the new session is in hand, so a failed connect leaves
  // the org exactly as it was.
  async function setConnected(id, session) {
    const orgs = await all();
    const target = orgs.find((o) => o.id === id);
    if (!target) return { org: null };

    Object.assign(target, session);
    await save(orgs);
    return { org: target };
  }

  // Returns an org whose token works right now, picking up a rotated sid on the
  // way. Callers get null when nothing is connected, and a throw when the
  // session is gone for good and the user has to log in again.
  async function activeToken() {
    const org = await active();
    if (!org) return null;

    const probe = await SfSession.authProbe(org.instanceUrl, org.accessToken);
    if (probe.ok) return org;

    const renewed = await SfSession.renew(org);
    if (!renewed) {
      throw new Error(
        `The session for "${org.alias}" is no longer valid. Open that org in a tab, ` +
        'log in, then reconnect it in settings.'
      );
    }
    return update(org.id, renewed);
  }

  return { all, save, update, remove, active, activeToken, setConnected };
})();
