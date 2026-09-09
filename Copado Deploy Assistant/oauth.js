'use strict';

/*
 * NOT LOADED. No page includes this file; target orgs connect through
 * session.js instead. It is kept because the flow below is correct and becomes
 * usable the day target orgs are willing to install the managed package —
 * reviving it means adding the "identity" permission back to manifest.json and
 * a <script> tag to settings.html.
 *
 * OAuth 2.0 authorization code flow with PKCE, run against any Salesforce org.
 *
 * The consumer key below belongs to one app in this extension's publisher org
 * and is used to authenticate against every target org, so target-org admins
 * never create an app of their own.
 *
 * That app must be an External Client App with distribution state "Packaged",
 * distributed in a 2GP managed package. Salesforce blocked new connected app
 * creation in Spring '26, and an external client app left in the default
 * "Local" state is refused cross-org with "Cross-org OAuth flows are not
 * supported for this external client app". SETUP.md has the full procedure.
 *
 * The extension ships its source in the clear, which makes this a public
 * client: no consumer secret exists anywhere in here, and PKCE takes its place.
 * The app's global OAuth settings must therefore set isConsumerSecretOptional
 * to true and isPkceRequired to true.
 */

const SfOAuth = (() => {

  // Consumer Key of the connected app in the publisher org. Not a secret.
  const CLIENT_ID = '3MVG9HtWXcDGV.nEVikUiHCrKhRdotlZa9vpsHpj1n.uLBd9uaUBJS29mzcWnSB6BWamI2_7aeAmrjhKrANhA';

  // "id" backs the userinfo lookup, "refresh_token" keeps the connection alive
  // past the access token's lifetime. Both must also be selected on the app.
  const SCOPES = 'id api refresh_token';

  const isConfigured = () => CLIENT_ID.length > 0;

  // https://<extension-id>.chromiumapp.org/ — must be listed verbatim as a
  // Callback URL on the connected app. The id is stable once the extension is
  // published; while loading unpacked it is derived from the folder path, so
  // moving the folder changes it and the app needs the new URL added.
  const redirectUri = () => chrome.identity.getRedirectURL();

  /* -------------------------------------------------------------- pkce */

  const b64url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const randomUrlSafe = (byteLength) => b64url(crypto.getRandomValues(new Uint8Array(byteLength)));

  async function challengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }

  /* ------------------------------------------------------------- hints */

  // Salesforce reports config problems through OAuth error codes that say
  // nothing about the cause. These map the ones this flow actually provokes
  // back to the setting that has to change.
  const HINTS = [
    [/cross-org oauth flows are not supported/i,
      'That is an External Client App with distribution state "Local", which only works inside the org that defines it. ' +
      'Create a classic Connected App instead (Setup -> App Manager -> New Connected App -> Connected App), ' +
      'or package the external client app for distribution.'],
    [/invalid_client_id|client identifier invalid/i,
      'The consumer key in oauth.js does not match an app in the publisher org, or the app was saved less than ten minutes ago.'],
    // A thunk, because redirectUri() must not run while this module body is
    // still being evaluated.
    [/redirect_uri_mismatch|invalid redirect_uri/i,
      () => `The app's callback URL must be listed verbatim as ${redirectUri()}`],
    [/client secret|invalid_client\b/i,
      'The app still requires a secret. Turn off "Require Secret for Web Server Flow" and "Require Secret for Refresh Token Flow".'],
    [/inactive|not enabled for user|failed: not approved/i,
      "The target org restricts this app. An admin there must approve it under Setup -> Connected Apps OAuth Usage."],
    [/authorization page could not be loaded/i,
      'Salesforce rejected the request before showing a login page, so it returned an error page rather than a redirect. ' +
      'That is usually an app that is unusable cross-org, a wrong consumer key, or an app saved less than ten minutes ago.'],
  ];

  function explain(message) {
    const hint = HINTS.find(([pattern]) => pattern.test(message));
    if (!hint) return message;
    const text = typeof hint[1] === 'function' ? hint[1]() : hint[1];
    return `${message}\n\n${text}`;
  }

  /* ------------------------------------------------------------- token */

  async function postToken(host, params) {
    const res = await fetch(`${host}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(explain(data.error_description || data.error || `${res.status} ${res.statusText}`));
    }
    return data;
  }

  /* ----------------------------------------------------------- connect */

  async function connect(loginUrl) {
    if (!isConfigured()) {
      throw new Error('No consumer key compiled into oauth.js. See the setup notes in that file.');
    }

    const host = loginUrl.replace(/\/+$/, '');
    const verifier = randomUrlSafe(64);
    const state = randomUrlSafe(16);

    const authUrl = `${host}/services/oauth2/authorize?` + new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      scope: SCOPES,
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
      // Without this, an existing browser session is reused silently, which
      // quietly connects the wrong org when several are already logged in.
      prompt: 'login',
    });

    // Salesforce renders an HTML error page instead of redirecting when it
    // rejects the client itself, and chrome.identity can only report that as a
    // failed page load — so these rejections need explaining too.
    let responseUrl;
    try {
      responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    } catch (err) {
      throw new Error(explain(err.message));
    }
    if (!responseUrl) throw new Error('Authorization window closed before it finished.');

    const params = new URL(responseUrl).searchParams;
    if (params.get('error')) {
      throw new Error(explain(params.get('error_description') || params.get('error')));
    }
    if (params.get('state') !== state) {
      throw new Error('State mismatch on the OAuth callback; the response was discarded.');
    }

    const code = params.get('code');
    if (!code) throw new Error('Authorization callback carried no code.');

    const token = await postToken(host, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    });

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      instanceUrl: token.instance_url,
      connectedAt: new Date().toISOString(),
      ...identityFrom(token),
      ...(await userinfo(token).catch(() => ({}))),
    };
  }

  /* ----------------------------------------------------------- refresh */

  // Access tokens expire on the org's session timeout; the refresh token is
  // what makes a saved connection outlive it.
  async function refresh(org) {
    if (!org.refreshToken) throw new Error('No refresh token saved; reconnect the org.');

    const token = await postToken(org.instanceUrl || org.loginUrl, {
      grant_type: 'refresh_token',
      refresh_token: org.refreshToken,
    });

    return {
      accessToken: token.access_token,
      instanceUrl: token.instance_url || org.instanceUrl,
      // A refresh response omits refresh_token; the existing one stays valid.
      refreshToken: token.refresh_token || org.refreshToken,
      connectedAt: new Date().toISOString(),
    };
  }

  /* ------------------------------------------------------------ revoke */

  async function revoke(org) {
    const token = org.refreshToken || org.accessToken;
    if (!token) return;

    // Best effort: a token the org already expired returns 400, which is not
    // a reason to keep it in local storage.
    await fetch(`${org.instanceUrl || org.loginUrl}/services/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }

  /* ---------------------------------------------------------- identity */

  // The token response carries the identity URL, which encodes both ids even
  // when the userinfo call is unavailable.
  function identityFrom(token) {
    const parts = String(token.id || '').split('/');
    return { orgId: parts[parts.length - 2] || null, userId: parts[parts.length - 1] || null };
  }

  async function userinfo(token) {
    const res = await fetch(`${token.instance_url}/services/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) return {};
    const info = await res.json();
    return { username: info.preferred_username || info.email || null };
  }

  return { CLIENT_ID, SCOPES, isConfigured, redirectUri, connect, refresh, revoke };
})();

/*
 * Saved target orgs. Kept next to the OAuth code so the popup can reach a live
 * access token by loading this one file.
 */
const SfOrgs = (() => {

  // Fields written by the old username-password flow. They held a plaintext
  // password and security token, which the OAuth flow has no use for.
  const LEGACY_FIELDS = ['password', 'securityToken', 'clientId', 'clientSecret'];

  async function all() {
    const { orgs = [] } = await chrome.storage.local.get('orgs');

    let stripped = false;
    for (const org of orgs) {
      for (const field of LEGACY_FIELDS) {
        if (field in org) { delete org[field]; stripped = true; }
      }
    }
    if (stripped) await chrome.storage.local.set({ orgs });

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

  // Returns a token that is good right now, renewing it first if the org
  // expired the old one. Callers get null when no org is connected.
  async function activeToken() {
    const org = await active();
    if (!org) return null;

    const probe = await fetch(`${org.instanceUrl}/services/data/`, {
      headers: { Authorization: `Bearer ${org.accessToken}` },
    }).catch(() => null);

    if (probe && probe.ok) return org;

    const renewed = await SfOAuth.refresh(org);
    return update(org.id, renewed);
  }

  return { all, save, update, remove, active, activeToken };
})();
