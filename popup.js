'use strict';

const FALLBACK_API_VERSION = 'v66.0';

/*
 * Every type the browser lists, in the order it lists them.
 *
 * Each is queried on its own, so an org that blocks or lacks one still gets the
 * rest — a single combined query would lose everything to one bad type.
 *
 * `name` builds the Metadata API full name, which is what a Copado commit
 * needs; it is not always the record's Name field.
 * `custom` marks what the "custom only" filter keeps, and is assumed true where
 * a type has no standard members at all.
 */
const METADATA_TYPES = [
  // Loaded from the describe list, not a Tooling query: only that has the label
  // and the custom flag, and objects open a third level for their fields.
  // Custom metadata types and custom settings have sections of their own
  // below, so this one stays what its label says it is.
  { key: 'CustomObject', primary: true, label: 'Objects', objects: true,
    match: (o) => !MDT_SUFFIX.test(o.name) && o.customSetting !== true },

  { key: 'ApexClass', primary: true, label: 'Apex Classes',
    soql: 'SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM ApexClass',
    name: (r) => r.Name,
    custom: (r) => !r.NamespacePrefix },

  { key: 'ApexTrigger', primary: true, label: 'Apex Triggers',
    soql: 'SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM ApexTrigger',
    name: (r) => r.Name,
    custom: (r) => !r.NamespacePrefix },

  { key: 'Flow', primary: true, label: 'Flows',
    soql: 'SELECT Id, DeveloperName, LastModifiedDate FROM FlowDefinition',
    name: (r) => r.DeveloperName },

  { key: 'LightningComponentBundle', primary: true, label: 'Lightning Web Components',
    soql: 'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle',
    fallbackSoql: 'SELECT Id, DeveloperName, LastModifiedDate FROM LightningComponentBundle',
    name: (r) => r.DeveloperName,
    custom: (r) => !r.NamespacePrefix },

  { key: 'AuraDefinitionBundle', primary: true, label: 'Aura Components',
    soql: 'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM AuraDefinitionBundle',
    fallbackSoql: 'SELECT Id, DeveloperName, LastModifiedDate FROM AuraDefinitionBundle',
    name: (r) => r.DeveloperName,
    custom: (r) => !r.NamespacePrefix },

  { key: 'ApexPage', primary: true, label: 'Visualforce Pages',
    soql: 'SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM ApexPage',
    name: (r) => r.Name,
    custom: (r) => !r.NamespacePrefix },

  { key: 'ApexComponent', label: 'Visualforce Components',
    soql: 'SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM ApexComponent',
    name: (r) => r.Name,
    custom: (r) => !r.NamespacePrefix },

  // A layout's full name is Object-Layout Name. The entity relationship gives
  // the API name; TableEnumOrId is a raw id for custom objects, so it is only
  // the fallback.
  { key: 'Layout', primary: true, label: 'Page Layouts',
    soql: 'SELECT Id, Name, TableEnumOrId, EntityDefinition.QualifiedApiName, LastModifiedDate FROM Layout',
    fallbackSoql: 'SELECT Id, Name, TableEnumOrId, LastModifiedDate FROM Layout',
    name: (r) => `${r.EntityDefinition?.QualifiedApiName || r.TableEnumOrId}-${r.Name}` },

  { key: 'ValidationRule', primary: true, label: 'Validation Rules',
    soql: 'SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, LastModifiedDate FROM ValidationRule',
    name: (r) => `${r.EntityDefinition?.QualifiedApiName || '?'}.${r.ValidationName}` },

  { key: 'PermissionSet', primary: true, label: 'Permission Sets',
    soql: 'SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM PermissionSet',
    name: (r) => r.Name,
    custom: (r) => !r.NamespacePrefix },

  { key: 'CustomLabel', label: 'Custom Labels',
    soql: 'SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM ExternalString',
    fallbackSoql: 'SELECT Id, Name, LastModifiedDate FROM ExternalString',
    name: (r) => r.Name,
    custom: (r) => !r.NamespacePrefix },

  { key: 'StaticResource', label: 'Static Resources',
    soql: 'SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM StaticResource',
    name: (r) => r.Name,
    custom: (r) => !r.NamespacePrefix },

  // CustomTab has no Name column — a tab is identified by its DeveloperName,
  // which is also the name it deploys under. The narrower forms follow in case
  // an org answers to neither NamespacePrefix nor DeveloperName, so the org
  // settles it rather than this list guessing.
  { key: 'CustomTab', label: 'Custom Tabs',
    soql: 'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM CustomTab',
    fallbackSoql: [
      'SELECT Id, DeveloperName, LastModifiedDate FROM CustomTab',
      'SELECT Id, MasterLabel, LastModifiedDate FROM CustomTab',
    ],
    name: (r) => r.DeveloperName || r.MasterLabel,
    custom: (r) => !r.NamespacePrefix },

  // Record, app and home pages are all FlexiPage and all deploy under that
  // one name, so they are one section rather than three near-identical ones.
  { key: 'FlexiPage', label: 'Lightning Pages',
    soql: 'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM FlexiPage',
    fallbackSoql: 'SELECT Id, DeveloperName, LastModifiedDate FROM FlexiPage',
    name: (r) => r.DeveloperName,
    custom: (r) => !r.NamespacePrefix },

  // Custom metadata types and custom settings are objects with fields, and
  // the Metadata API calls both CustomObject — which is what the object rows
  // already commit as. So they reuse that listing rather than a query, and
  // are split out of Objects so each section means one thing.
  { key: 'CustomMetadata', label: 'Custom Metadata Types', objects: true,
    match: (o) => MDT_SUFFIX.test(o.name) },

  { key: 'CustomSetting', label: 'Custom Settings', objects: true,
    match: (o) => o.customSetting === true },

  // A template deploys as Folder/Name. Templates left unfiled have no folder,
  // and then the bare developer name is the whole of it.
  { key: 'EmailTemplate', label: 'Email Templates',
    soql: 'SELECT Id, DeveloperName, NamespacePrefix, FolderName, LastModifiedDate FROM EmailTemplate',
    fallbackSoql: [
      'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM EmailTemplate',
      'SELECT Id, Name, LastModifiedDate FROM EmailTemplate',
    ],
    name: (r) => foldered(r.FolderName, r.DeveloperName || r.Name),
    custom: (r) => !r.NamespacePrefix },

  // Tooling's RecordType has no DeveloperName; the data API's does, and that
  // is the name a record type deploys under. Name is deliberately not a
  // fallback here — it holds the label, and committing "Account.Business
  // Account" would fail at deploy time for a reason nothing on screen explains.
  { key: 'RecordType', label: 'Record Types',
    soql: 'SELECT Id, DeveloperName, SobjectType, NamespacePrefix, LastModifiedDate FROM RecordType',
    fallbackSoql: 'SELECT Id, DeveloperName, SobjectType, LastModifiedDate FROM RecordType',
    name: (r) => `${r.SobjectType}.${r.DeveloperName}`,
    custom: (r) => !r.NamespacePrefix },

  // Object-specific actions deploy as Object.Action; global ones as the bare
  // name, which is why SobjectType decides the shape rather than being assumed.
  { key: 'QuickAction', label: 'Quick Actions',
    soql: 'SELECT Id, DeveloperName, SobjectType, NamespacePrefix, LastModifiedDate FROM QuickActionDefinition',
    fallbackSoql: 'SELECT Id, DeveloperName, LastModifiedDate FROM QuickActionDefinition',
    name: (r) => (r.SobjectType ? `${r.SobjectType}.${r.DeveloperName}` : r.DeveloperName),
    custom: (r) => !r.NamespacePrefix },

  { key: 'CustomPermission', label: 'Custom Permissions',
    soql: 'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM CustomPermission',
    fallbackSoql: 'SELECT Id, DeveloperName, LastModifiedDate FROM CustomPermission',
    name: (r) => r.DeveloperName,
    custom: (r) => !r.NamespacePrefix },

  { key: 'GlobalValueSet', label: 'Global Value Sets',
    soql: 'SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM GlobalValueSet',
    fallbackSoql: 'SELECT Id, DeveloperName, LastModifiedDate FROM GlobalValueSet',
    name: (r) => r.DeveloperName,
    custom: (r) => !r.NamespacePrefix },

  { key: 'Profile', label: 'Profiles',
    soql: 'SELECT Id, Name, LastModifiedDate FROM Profile',
    name: (r) => r.Name },

  { key: 'Report', label: 'Reports',
    soql: 'SELECT Id, DeveloperName, FolderName, NamespacePrefix, LastModifiedDate FROM Report',
    fallbackSoql: [
      'SELECT Id, DeveloperName, FolderName, LastModifiedDate FROM Report',
      'SELECT Id, Name, LastModifiedDate FROM Report',
    ],
    name: (r) => foldered(r.FolderName, r.DeveloperName || r.Name),
    custom: (r) => !r.NamespacePrefix },

  { key: 'Dashboard', label: 'Dashboards',
    soql: 'SELECT Id, DeveloperName, FolderName, LastModifiedDate FROM Dashboard',
    fallbackSoql: 'SELECT Id, Title, LastModifiedDate FROM Dashboard',
    name: (r) => foldered(r.FolderName, r.DeveloperName || r.Title) },
];

// Reports, dashboards and email templates live in folders, and the folder is
// part of the name they deploy under.
const foldered = (folder, name) => (folder ? `${folder}/${name}` : name);

const MDT_SUFFIX = /__mdt$/i;

// Auto-generated companions that clutter the object list but are never deployed.
const NOISE_SUFFIX = /(__Share|__History|__Feed|__ChangeEvent|__Tag|__ViewStat|__VoteStat)$/;

const session = { instanceUrl: null, token: null, orgId: null, apiVersion: FALLBACK_API_VERSION };

const state = {
  search: '',
  // Empty dates mean no date bound at all, which is the default: a first-time
  // list should show what is there, not what changed this week.
  filter: { from: '', to: '', customOnly: false },
  expanded: new Set(),   // type keys currently open, plus '__others'
  searchCollapsed: new Set(),  // sections closed by hand while a search is on
  members: new Map(),    // type key -> member array, or { error }
  loadingAll: false,     // a search or filter is loading every type at once
  trayPinnedClosed: false,
  // Why the browser has nothing to show, when the source org could not be
  // reached at all. Held here rather than only in the DOM: see setBrowseError.
  browseError: null,
};

const describeCache = new Map();      // object api name -> field array
const selectedObjects = new Set();    // object api names
const selectedFields = new Map();     // object api name -> Set<field api name>
const selectedMeta = new Map();       // "Type:FullName" -> { type, fullName }

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ boot */

document.addEventListener('DOMContentLoaded', () => {
  wireBrowser();
  wireSelectedSection();
  wireModal();

  $('settings-btn').addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('settings.html'),
      type: 'popup',
      width: 520,
      height: 680,
    });
  });

  refreshCopadoBanner();
  refreshAiBanner();

  // Settings runs in its own window, so a connection made there reaches this
  // popup only through storage.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.orgs) refreshCopadoBanner();
    if (changes.copadoAi) refreshAiBanner();
  });

  start();
});

async function start() {
  try {
    await resolveSession();
    setSourceBanner(null);
    await loadCurrentUser();
  } catch (err) {
    //console.error(err);
    $('user-name').textContent = 'Not connected';
    $('user-sub').textContent = 'Open a Salesforce tab, then reopen this popup';

    // The source org is where every component on this screen comes from, so
    // there is nothing to browse without it.
    setSourceBanner(err.message);
    setBrowseError(err.message);
  }
}

/*
 * Why the component browser is empty, and the controls that act on it.
 *
 * Kept in state rather than written straight into #type-list. Every re-render
 * clears that element, so an error living only in the DOM survives until the
 * first search or filter and then vanishes — leaving a full list of types that
 * cannot open, above a filter button that cannot filter, with nothing left on
 * screen saying why.
 *
 * The controls are disabled alongside it: a search box over a list that cannot
 * load is a control that does nothing, and offering it invites exactly the
 * keystroke that used to wipe the message.
 */
function setBrowseError(message) {
  state.browseError = message || null;

  const blocked = Boolean(message);

  $('member-search').disabled = blocked;
  $('filter-btn').disabled = blocked;
  $('member-search').title = blocked ? message : '';
  $('filter-btn').title = blocked ? message : 'Filter';

  // Settings closes with the rest of the screen. Worth knowing: the Copado org
  // and Copado AI are configured in there and neither needs a source session,
  // so this also withholds the setup a first-time user would come here to do.
  // The tooltip says which tab to open rather than leaving a dead icon.
  $('settings-btn').disabled = blocked;
  $('settings-btn').title = blocked
    ? 'Open a Salesforce tab first — settings opens with the source org.'
    : 'Copado org settings';

  if (blocked) {
    // A panel left open over a dead list outlives the thing it acts on.
    $('filter-panel').hidden = true;
    $('filter-btn').setAttribute('aria-expanded', 'false');
  }

  renderTypes();
}

/* --------------------------------------------------------------- session */

// Host mapping and cookie lookup live in session.js, which target orgs use too.
const { apiHostFor, findSidCookie } = SfSession;

async function resolveSession() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) throw new Error('No active tab found.');

  const host = new URL(tab.url).hostname;
  if (!/(salesforce\.com|force\.com)$/.test(host)) {
    throw new Error('Open a Salesforce tab first, then reopen this extension.');
  }

  const apiHost = apiHostFor(host);
  const cookie = await findSidCookie(apiHost);
  if (!cookie) {
    throw new Error('Salesforce session cookie not found. Log in to the org and try again.');
  }

  session.instanceUrl = `https://${apiHost}`;
  session.token = cookie.value;
  session.apiVersion = await latestApiVersion();
}

async function latestApiVersion() {
  try {
    const versions = await sfFetch('/services/data/');
    const last = versions[versions.length - 1];
    return last?.version ? `v${last.version}` : FALLBACK_API_VERSION;
  } catch {
    return FALLBACK_API_VERSION;
  }
}

async function sfFetch(path) {
  const res = await fetch(`${session.instanceUrl}${path}`, {
    headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/json' },
  });

  if (res.status === 401) {
    throw new Error('Session expired. Refresh your Salesforce tab and reopen this popup.');
  }
  if (res.status === 403) {
    throw new Error('Access denied. Check that "API Enabled" is on your profile or permission set.');
  }
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed[0]?.message || parsed.message || body;
    } catch { /* keep raw text */ }

    // What Salesforce said, not the status code it said it with. The request
    // goes to the console for a bug report; the message is for reading.
    //console.error(`Salesforce: ${path} — ${res.status} ${res.statusText}`, body);
    throw new Error((detail || `The org refused the request (${res.status}).`).slice(0, 400));
  }
  return res.json();
}

const api = (path) => sfFetch(`/services/data/${session.apiVersion}${path}`);

/* ------------------------------------------------------------ 1. user */

async function loadCurrentUser() {
  let name = null;
  let sub = null;
  let photo = null;

  try {
    const info = await sfFetch('/services/oauth2/userinfo');
    session.orgId = info.organization_id || null;
    name = info.name;
    sub = info.preferred_username || info.email;
    photo = info.photos?.thumbnail;
  } catch {
    try {
      const me = await api('/chatter/users/me');
      name = me.displayName || me.name;
      sub = me.username || me.email;
      photo = me.photo?.smallPhotoUrl;
    } catch { /* handled below */ }
  }

  if (!name) {
    $('user-name').textContent = 'Signed in';
    $('user-sub').textContent = new URL(session.instanceUrl).hostname;
    return;
  }

  $('user-name').textContent = name;
  $('user-sub').textContent = sub || new URL(session.instanceUrl).hostname;

  const avatar = $('user-avatar');
  if (photo) {
    const img = new Image();
    img.src = photo;
    img.alt = '';
    img.addEventListener('load', () => { avatar.textContent = ''; avatar.appendChild(img); });
  } else {
    avatar.textContent = initials(name);
  }
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

/* ------------------------------------------------- metadata browser */

/*
 * One list of every type, each opening to its own members.
 *
 * Members are fetched on expand rather than up front: a dozen Tooling queries
 * on open would make the popup slow to appear and most of them would be for
 * types the user never looks at. Each type's query is independent, so an org
 * that blocks or lacks one still gets the rest — the failure is reported on
 * that row alone.
 */

function wireBrowser() {
  renderTypes();

  // Debounced: narrowing loads every type that is not cached yet, and firing
  // that on each keystroke would put a dozen queries in flight per word.
  let typing = null;
  $('member-search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    // A new term is a new set of results; what was collapsed against the old
    // one says nothing about these.
    state.searchCollapsed.clear();
    clearTimeout(typing);
    typing = setTimeout(narrowOrRender, 250);
  });

  $('filter-btn').addEventListener('click', () => {
    const open = $('filter-panel').hidden;
    $('filter-panel').hidden = !open;
    $('filter-btn').setAttribute('aria-expanded', String(open));
  });

  $('date-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $('date-presets').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    applyPreset(Number(btn.dataset.days));
  });

  // Typing a date is choosing a range of its own, so the preset that no longer
  // describes it stops claiming to.
  for (const id of ['date-from', 'date-to']) {
    $(id).addEventListener('input', () => {
      $('date-presets').querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    });
  }

  $('filter-apply').addEventListener('click', applyFilter);
  $('filter-reset').addEventListener('click', resetFilter);
}

function applyPreset(days) {
  if (!days) {
    $('date-from').value = '';
    $('date-to').value = '';
    return;
  }
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  $('date-from').value = isoDate(from);
  $('date-to').value = isoDate(new Date());
}

const isoDate = (d) => d.toISOString().slice(0, 10);

/*
 * A changed filter invalidates every list that was fetched under the old one,
 * so the caches are dropped and whatever is open is fetched again. Selections
 * are left alone: they live in the basket below and have their own Clear.
 */
function applyFilter() {
  state.filter = {
    from: $('date-from').value,
    to: $('date-to').value,
    customOnly: $('filter-custom').checked,
  };

  state.members.clear();
  $('filter-dot').hidden = !filterIsActive();
  $('filter-panel').hidden = true;
  $('filter-btn').setAttribute('aria-expanded', 'false');

  narrowOrRender();
}

/*
 * Hiding a section for having nothing in it means knowing what is in it, so a
 * search or a filter loads every type rather than only the ones already open.
 * That is a dozen Tooling queries, which is why it happens once per change
 * rather than per keystroke, and why the results are cached until the filter
 * moves again.
 */
async function narrowOrRender() {
  // Without a source org there is nothing to narrow, and every query below
  // would fail one at a time.
  if (state.browseError) return;

  if (!narrowing()) {
    state.loadingAll = false;
    renderTypes();
    return;
  }

  const pending = METADATA_TYPES.filter((t) => !state.members.has(t.key));
  if (!pending.length) {
    renderTypes();
    return;
  }

  state.loadingAll = true;
  renderTypes();

  await Promise.all(pending.map(async (type) => {
    const result = type.objects ? await fetchObjects(type) : await fetchType(type);
    state.members.set(type.key, result);
  }));

  state.loadingAll = false;
  renderTypes();
}

// Searching or filtering both narrow the list to what matches. Neither one
// active means the full set of types, closed, as the screen first loads.
const narrowing = () => Boolean(state.search) || filterIsActive();

function resetFilter() {
  $('date-from').value = '';
  $('date-to').value = '';
  $('filter-custom').checked = false;
  $('date-presets').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.days === '0');
  });
  applyFilter();
}

const filterIsActive = () =>
  Boolean(state.filter.from || state.filter.to || state.filter.customOnly);

/* ------------------------------------------------------------- render */

/*
 * Ten types at the top, the rest under "Others".
 *
 * Fourteen rows is a wall to scroll past to reach the one that matters, and the
 * last four are types most orgs touch rarely. They are one click away rather
 * than gone.
 */
function renderTypes() {
  const host = $('type-list');
  host.innerHTML = '';

  // The one thing worth saying when the org behind every list is unreachable.
  if (state.browseError) {
    host.appendChild(errorBox(state.browseError));
    return;
  }

  if (state.loadingAll) {
    host.innerHTML = '<div class="msg"><span class="spinner"></span>Searching every type&hellip;</div>';
    return;
  }

  const rows = [];
  for (const type of METADATA_TYPES.filter((t) => t.primary)) {
    const row = typeRow(type);
    if (row) rows.push(row);
  }

  const others = [];
  for (const type of METADATA_TYPES.filter((t) => !t.primary)) {
    const row = typeRow(type);
    if (row) others.push(row);
  }
  if (others.length) rows.push(othersGroup(others));

  if (!rows.length) {
    host.appendChild(msg(state.search
      ? 'Nothing matches that search.'
      : 'Nothing matches this filter.'));
    return;
  }

  for (const row of rows) host.appendChild(row);
}

// The rarely-used types, behind one row. It carries no checkbox of its own:
// selecting is still per type, which is where the counts are.
function othersGroup(rows) {
  const wrap = el('div', 'type others');
  const open = state.expanded.has(OTHERS_KEY) || narrowing();
  if (open) wrap.classList.add('open');

  const head = el('div', 'type-head');
  head.append(
    el('span', 'caret', '▶'),
    el('div', 'type-label', 'Others'),
    el('span', 'badge count', String(rows.length))
  );
  head.addEventListener('click', () => {
    if (state.expanded.has(OTHERS_KEY)) state.expanded.delete(OTHERS_KEY);
    else state.expanded.add(OTHERS_KEY);
    renderTypes();
  });

  wrap.appendChild(head);

  if (open) {
    const box = el('div', 'others-body');
    for (const row of rows) box.appendChild(row);
    wrap.appendChild(box);
  }
  return wrap;
}

const OTHERS_KEY = '__others';

/*
 * Returns null when the type has nothing to show under the current search or
 * filter, which is how a section disappears rather than sitting there empty.
 *
 * Only while narrowing: with nothing typed and no filter set, an unopened type
 * has no loaded members and hiding it would empty the screen.
 */
function typeRow(type) {
  const loaded = state.members.get(type.key);
  const rows = Array.isArray(loaded) ? filterMembers(loaded) : null;

  if (narrowing() && (!rows || !rows.length)) return null;

  const wrap = el('div', 'type');
  wrap.dataset.type = type.key;

  // A search opens what it matched: the point of the search is the members, and
  // leaving them one click away is a click for nothing. Collapsing one is still
  // possible — that is what searchCollapsed records — and the user's own
  // expansions are held separately, so clearing the box restores them.
  const open = state.search
    ? !state.searchCollapsed.has(type.key)
    : state.expanded.has(type.key);
  if (open) wrap.classList.add('open');

  const head = el('div', 'type-head');
  head.append(el('span', 'caret', '▶'), el('div', 'type-label', type.label));
  if (rows) head.appendChild(el('span', 'badge count', String(rows.length)));

  head.addEventListener('click', () => toggleType(type));
  wrap.appendChild(head);

  if (open) wrap.appendChild(memberBox(type, loaded, rows));
  return wrap;
}

function memberBox(type, loaded, rows) {
  const box = el('div', 'members');

  if (loaded === undefined) {
    box.innerHTML = '<div class="msg"><span class="spinner"></span>Loading&hellip;</div>';
    return box;
  }
  if (loaded && loaded.error) {
    box.appendChild(errorBox(loaded.error));
    return box;
  }
  if (!rows.length) {
    box.appendChild(msg(loaded.length
      ? 'Nothing here matches the search or filter.'
      : 'Nothing of this type in the org.'));
    return box;
  }

  // Standard objects have no CustomObject record to carry a modified date, so
  // a date range can only ever answer for custom ones. Said rather than left to
  // be noticed.
  if (type.objects && (state.filter.from || state.filter.to)) {
    box.appendChild(warn('Only custom objects can be filtered by date — standard ones carry no modified date.'));
  }

  // Selecting a whole type is one click at the top of its own list rather than
  // a button elsewhere on the screen that has to explain what it applies to.
  box.appendChild(selectAllRow(type, rows));

  const CAP = 400;
  const shown = rows.slice(0, CAP);
  if (rows.length > CAP) {
    box.appendChild(warn(`Showing the first ${CAP} of ${rows.length}. Search to narrow it down.`));
  }

  const frag = document.createDocumentFragment();
  for (const item of shown) {
    frag.appendChild(type.objects ? objectRow(item) : memberRow(type, item));
  }
  box.appendChild(frag);
  return box;
}

function selectAllRow(type, rows) {
  const row = el('div', 'select-all');
  const box = checkbox(rows.every((item) => isPicked(type, item)));

  box.addEventListener('change', () => {
    for (const item of rows) pick(type, item, box.checked);
    updateSelection();
    renderTypes();
  });

  row.append(box, el('span', 'select-all-label',
    box.checked ? `All ${rows.length} selected` : `Select all ${rows.length}`));
  return row;
}

function memberRow(type, item) {
  const row = el('div', 'member');
  row.dataset.metaKey = metaKey(type.key, item.fullName);

  const box = checkbox(isPicked(type, item));
  box.addEventListener('change', () => {
    pick(type, item, box.checked);
    updateSelection();
  });

  const name = el('div', 'member-name', item.fullName);
  name.title = item.fullName;

  row.append(box, name);
  if (item.modified) row.appendChild(el('span', 'member-date', relativeTime(item.modified)));
  return row;
}

/* ---------------------------------------------------------- selection */

const metaKey = (type, fullName) => `${type}:${fullName}`;

// Objects carry their own selection stores, because a field pick has to survive
// alongside the object it belongs to.
function isPicked(type, item) {
  if (type.objects) return selectedObjects.has(item.name);
  return selectedMeta.has(metaKey(type.key, item.fullName));
}

function pick(type, item, on) {
  if (type.objects) {
    // The object and its fields are separate selections and stay that way. A
    // CustomObject and a CustomField are separate entries in a commit, and
    // wanting both — the object plus the specific fields that changed — is the
    // normal case, not a contradiction to resolve.
    if (on) selectedObjects.add(item.name);
    else selectedObjects.delete(item.name);
    return;
  }

  const key = metaKey(type.key, item.fullName);
  if (on) selectedMeta.set(key, { type: type.key, fullName: item.fullName });
  else selectedMeta.delete(key);
}

/* ------------------------------------------------------------ loading */

async function toggleType(type) {
  // While a search is on, sections are open by default, so the caret records a
  // deliberate collapse rather than a deliberate expansion.
  if (state.search) {
    if (state.searchCollapsed.has(type.key)) state.searchCollapsed.delete(type.key);
    else state.searchCollapsed.add(type.key);
    renderTypes();
    return;
  }

  if (state.expanded.has(type.key)) {
    state.expanded.delete(type.key);
    renderTypes();
    return;
  }

  state.expanded.add(type.key);
  renderTypes();

  if (!state.members.has(type.key)) await loadMembers(type.key);
}

async function loadMembers(key) {
  const type = METADATA_TYPES.find((t) => t.key === key);
  if (!type) return;

  state.members.delete(key);
  renderTypes();

  const result = type.objects ? await fetchObjects(type) : await fetchType(type);
  state.members.set(key, result);
  renderTypes();
}

/*
 * Objects come from the describe list, which is the only source with the label
 * and the custom flag — and which carries no LastModifiedDate.
 *
 * So a date filter is answered by a second query against Tooling's
 * CustomObject, and the describe list is cut down to what it returns. Standard
 * objects drop out under a date filter, which is right: a standard object is
 * not itself modified, its fields and layouts are, and those have their own
 * sections.
 */
async function fetchObjects(type) {
  try {
    const data = await api('/sobjects');
    let objects = (data.sobjects || [])
      .filter((o) => !o.deprecatedAndHidden && !NOISE_SUFFIX.test(o.name))
      .filter((o) => (type.match ? type.match(o) : true))
      .map((o) => ({ name: o.name, label: o.label, custom: o.custom, fullName: o.name }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const where = whereClause();
    if (where) {
      const q = `SELECT Id, DeveloperName, LastModifiedDate FROM CustomObject WHERE ${where}`;
      const recent = await api(`/tooling/query/?q=${encodeURIComponent(q)}`);

      // CustomObject reports the developer name without its suffix, and the
      // suffix differs by kind — __c for objects and settings, __mdt for
      // custom metadata — so the suffix comes off rather than being added on.
      const modified = new Map();
      for (const r of recent.records || []) {
        modified.set(r.DeveloperName.toLowerCase(), r.LastModifiedDate);
      }

      const stem = (name) => name.replace(/__(c|mdt)$/i, '').toLowerCase();

      objects = objects
        .filter((o) => modified.has(stem(o.name)))
        .map((o) => ({ ...o, modified: modified.get(stem(o.name)) }));
    }

    return objects;
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchType(type) {
  const where = [type.where, whereClause()].filter(Boolean).join(' AND ');

  const run = async (soql, endpoint) => {
    const q = `${soql}${where ? ` WHERE ${where}` : ''} ORDER BY LastModifiedDate DESC LIMIT 500`;
    const data = await api(`${endpoint}?q=${encodeURIComponent(q)}`);
    return (data.records || []).map((r) => ({
      fullName: type.name(r),
      modified: r.LastModifiedDate,
      custom: type.custom ? type.custom(r) : true,
    }));
  };

  // A query naming a column the entity does not have fails wholesale, so
  // simpler forms are tried before the type is written off.
  //
  // Both endpoints get the full set, because the two APIs disagree about more
  // than which entities exist: RecordType is present in both and only the
  // data API gives it a DeveloperName. So a column complaint from Tooling is
  // not evidence the query is wrong — only that it was asked in the wrong
  // place. This costs one extra round trip per type that fails outright.
  const attempts = [type.soql, ...[].concat(type.fallbackSoql || [])];
  let first = null;

  for (const endpoint of ['/tooling/query/', '/query/']) {
    for (const soql of attempts) {
      try {
        return await run(soql, endpoint);
      } catch (err) {
        first = first || err;
      }
    }
  }

  // The first failure is the one to show: later attempts drop columns to get a
  // result at all, so their errors describe a query the user never asked for.
  return { error: first.message };
}

// The date range is pushed into the query; "custom only" is applied in
// filterMembers because not every type exposes a flag for it.
function whereClause() {
  const { from, to } = state.filter;
  const parts = [];

  if (from) parts.push(`LastModifiedDate >= ${from}T00:00:00Z`);
  if (to) {
    // "To" covers the whole day, so the comparison is against the next midnight.
    const next = new Date(`${to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    parts.push(`LastModifiedDate < ${isoDate(next)}T00:00:00Z`);
  }
  return parts.join(' AND ');
}

// Search and the custom-only flag are applied here rather than in the query, so
// typing does not re-hit the org on every keystroke.
function filterMembers(rows) {
  const term = state.search.toLowerCase();

  return rows.filter((item) => {
    if (state.filter.customOnly && item.custom === false) return false;
    if (!term) return true;
    return `${item.fullName} ${item.label || ''}`.toLowerCase().includes(term);
  });
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ------------------------------------------------- objects and fields */

// Objects keep a third level: the fields inside them. Committing one field
// rather than a whole object is the reason this extension exists, so that
// depth is worth the extra row.
function objectRow(obj) {
  const wrap = el('div', 'obj');
  wrap.dataset.object = obj.name;

  const head = el('div', 'obj-head');

  const box = checkbox(selectedObjects.has(obj.name));
  box.title = 'Select the object itself — fields are picked separately below';
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    if (box.checked) selectedObjects.add(obj.name);
    else selectedObjects.delete(obj.name);
    syncFieldBoxes(wrap, obj.name);
    updateSelection();
  });

  const namePart = el('div', 'obj-name');
  namePart.appendChild(el('div', 'obj-label', obj.label));
  namePart.appendChild(el('div', 'obj-api', obj.name));

  head.append(
    el('span', 'caret', '▶'), box, namePart,
    el('span', `badge ${obj.custom ? '' : 'std'}`, obj.custom ? 'CUSTOM' : 'STD')
  );
  head.addEventListener('click', () => toggleObject(wrap, obj));

  wrap.appendChild(head);
  return wrap;
}

async function toggleObject(wrap, obj) {
  if (wrap.classList.contains('open')) {
    wrap.classList.remove('open');
    wrap.querySelector('.fields')?.remove();
    return;
  }

  wrap.classList.add('open');
  const box = el('div', 'fields');
  box.innerHTML = '<div class="msg"><span class="spinner"></span>Loading fields&hellip;</div>';
  wrap.appendChild(box);

  try {
    const fields = await describeFields(obj.name);
    box.innerHTML = '';
    if (!fields.length) {
      box.appendChild(msg('This object exposes no fields to your user.'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of fields) frag.appendChild(fieldRow(obj.name, f));
    box.appendChild(frag);
    syncFieldBoxes(wrap, obj.name);
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(errorBox(`Could not describe ${obj.name}\n${err.message}`));
  }
}

async function describeFields(objName) {
  if (describeCache.has(objName)) return describeCache.get(objName);

  const describe = await api(`/sobjects/${objName}/describe`);
  const fields = (describe.fields || []).map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    custom: f.custom,
    required: !f.nillable && !f.defaultedOnCreate && f.createable,
  }));

  describeCache.set(objName, fields);
  return fields;
}

function fieldRow(objName, field) {
  const row = el('div', 'field');

  const box = checkbox(selectedFields.get(objName)?.has(field.name) || false);
  box.dataset.field = field.name;
  box.addEventListener('change', () => {
    let set = selectedFields.get(objName);
    if (!set) { set = new Set(); selectedFields.set(objName, set); }
    if (box.checked) set.add(field.name);
    else set.delete(field.name);
    if (!set.size) selectedFields.delete(objName);
    updateSelection();
  });

  const name = el('div', 'field-name', field.name);
  name.title = `${field.label} — ${field.type}${field.required ? ' (required)' : ''}`;

  // The asterisk goes inside the name element: .field-name grows to fill the
  // row, so a sibling span would be pushed to the far edge away from the field.
  if (field.required) name.appendChild(el('span', 'req', ' *'));

  row.append(box, name, el('span', 'field-type', field.type));
  if (field.custom) row.appendChild(el('span', 'badge', 'C'));
  return row;
}

// Field boxes reflect only the field selection. The object's own checkbox is
// a separate choice and does not tick or lock them.
function syncFieldBoxes(wrap, objName) {
  const picked = selectedFields.get(objName);
  wrap.querySelectorAll('.field input[type="checkbox"]').forEach((box) => {
    box.checked = picked?.has(box.dataset.field) ?? false;
  });
}

/* ------------------------------ 3. selected components and deploy */

function wireSelectedSection() {
  $('selected-bar').addEventListener('click', () => {
    const open = $('selected-section').classList.toggle('open');
    // Remember a deliberate collapse so the tray stops springing back open.
    state.trayPinnedClosed = !open;
    $('selected-bar').setAttribute('aria-expanded', String(open));
  });

  $('clear-selection').addEventListener('click', () => {
    selectedObjects.clear();
    selectedFields.clear();
    selectedMeta.clear();
    refreshCheckboxes();
    updateSelection();
  });

  $('deploy-btn').addEventListener('click', showDeployReview);
  $('stories-btn').addEventListener('click', openStoryWorkspace);
  updateSelection();
}

// Standard objects deploy under the CustomObject type too, so the raw Metadata
// API name reads as wrong next to "Account". Show plain words and keep the real
// type in the tooltip.
const KIND_LABELS = { CustomObject: 'Object', CustomField: 'Field' };
const kindLabel = (type) => KIND_LABELS[type] || type;

// Flattens the three selection stores into one reviewable list. `kind` stays the
// real Metadata API type name, which is how Copado records it against a story.
function selectedItems() {
  const items = [];

  for (const objName of selectedObjects) {
    items.push({ kind: 'CustomObject', name: objName, remove: () => selectedObjects.delete(objName) });
  }

  for (const [objName, fields] of selectedFields) {
    for (const field of fields) {
      items.push({
        kind: 'CustomField',
        name: `${objName}.${field}`,
        remove: () => {
          const set = selectedFields.get(objName);
          set?.delete(field);
          if (set && !set.size) selectedFields.delete(objName);
        },
      });
    }
  }

  for (const [key, meta] of selectedMeta) {
    items.push({ kind: meta.type, name: meta.fullName, remove: () => selectedMeta.delete(key) });
  }

  return items;
}

function updateSelection() {
  const items = selectedItems();
  const n = items.length;

  $('selection-count').textContent = String(n);
  $('selection-hint').textContent = n
    ? `${n} component${n === 1 ? '' : 's'} ready to deploy`
    : 'Nothing selected yet';
  $('clear-selection').disabled = n === 0;
  $('deploy-btn').disabled = n === 0;

  const section = $('selected-section');
  if (n && !state.trayPinnedClosed && !section.classList.contains('open')) {
    section.classList.add('open');
    $('selected-bar').setAttribute('aria-expanded', 'true');
  }

  renderSelectedList(items);
}

function renderSelectedList(items) {
  const host = $('selected-list');
  host.innerHTML = '';

  if (!items.length) {
    host.appendChild(msg('Tick objects, fields or metadata above to build a deployment set.'));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const row = el('div', 'sel-row');

    const name = el('div', 'sel-name', item.name);
    name.title = item.name;

    const remove = el('button', 'remove-btn', '×');
    remove.type = 'button';
    remove.title = `Remove ${item.name}`;
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => {
      item.remove();
      refreshCheckboxes();
      updateSelection();
    });

    const kind = el('span', 'sel-kind', kindLabel(item.kind));
    kind.title = `Committed as ${item.kind}`;

    row.append(name, kind, remove);
    frag.appendChild(row);
  }
  host.appendChild(frag);
}

// Re-points every rendered checkbox at the selection model. Removing an item in
// section 3 has to untick it wherever it is also shown in sections 1 and 2.
function refreshCheckboxes() {
  document.querySelectorAll('#type-list .obj').forEach((wrap) => {
    const objName = wrap.dataset.object;
    const head = wrap.querySelector('.obj-head input[type="checkbox"]');
    if (head) head.checked = selectedObjects.has(objName);
    syncFieldBoxes(wrap, objName);
  });

  document.querySelectorAll('#type-list .member').forEach((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    if (box) box.checked = selectedMeta.has(row.dataset.metaKey);
  });

  // The per-type "select all" reflects its own list, which the loop above does
  // not touch.
  document.querySelectorAll('#type-list .select-all input').forEach((box) => {
    box.checked = false;
  });
}

/* ------------------------------------------------- 5b. user story flow */

// Everything picked in sections 1 and 2, flattened into the {type, fullName}
// pairs Copado stores against a user story.
function selectedComponents() {
  const out = [];

  for (const obj of selectedObjects) out.push({ type: 'CustomObject', fullName: obj });
  for (const [obj, fields] of selectedFields) {
    for (const f of fields) out.push({ type: 'CustomField', fullName: `${obj}.${f}` });
  }
  for (const { type, fullName } of selectedMeta.values()) out.push({ type, fullName });

  return out.sort((a, b) => a.type.localeCompare(b.type) || a.fullName.localeCompare(b.fullName));
}

// Copado's schema and lookups, fetched once per dialog.
let copadoContext = null;

// Browsing stories, and promoting one, have nothing to do with the metadata
// selection — so this way in is never gated on it. It skips the review pane,
// which only exists to describe a set of components.
async function openStoryWorkspace() {
  resetDeployState();

  $('deploy-source').textContent = session.instanceUrl
    ? `${$('user-name').textContent} · ${new URL(session.instanceUrl).hostname}`
    : 'No source session.';

  renderComponents();
  showProblems([]);
  showPane('review');
  $('modal').classList.add('show');

  await loadConnections();

  // Straight to the list once the Copado org can answer for it. Copado AI is
  // not consulted here: this way in exists to look at stories, and looking does
  // not need it.
  if (copadoContext && copadoContext.resolved.canCreate) await showStoryPicker();
}

function resetDeployState() {
  stopWatching();
  stopEarlyWatch();
  copadoContext = null;
  aiDialogueId = null;
  createdStory = null;
  deployableStory = null;
  lastStory = null;
  commitBaseline = null;
  deployBaseline = null;
  storyBaseline = null;
  promptAction = 'commit';
  lastTask = 'commit';
  creatingStory = false;
  autoConfirms = 0;
  questionsAsked = 0;
  $('ai-prompt').value = '';
}

async function showDeployReview() {
  resetDeployState();

  $('deploy-source').textContent = session.instanceUrl
    ? `${$('user-name').textContent} · ${new URL(session.instanceUrl).hostname}`
    : 'No source session.';

  renderComponents();
  showProblems([]);
  showPane('review');
  $('modal').classList.add('show');

  await loadConnections();
}

async function loadConnections() {
  showProblems([]);
  await Promise.all([loadCopadoOrg(), loadCopadoAi()]);
  updateConfirmButton();
}

/* ----------------------------------------------------------- copado ai */

// Reused across prompts within one dialog session so follow-up messages keep
// the agent's context, and reset when the modal reopens.
let aiDialogueId = null;

/*
 * Whether Copado AI can be asked to do anything.
 *
 * A flag rather than a reading of the label below it: what gates a button
 * should not depend on the wording of a sentence on screen.
 */
let aiReady = false;

async function loadCopadoAi() {
  const settings = await CopadoAI.load();
  aiReady = Boolean(settings.apiKey && settings.organizationId);
}

// Which assistant the exchange in progress belongs to. Fixed values, but which
// of the two applies depends on the job — and a Yes must go back to the same
// assistant that asked the question.
let currentAssistant = CopadoAI.ASSISTANTS.release;

/* -------------------------------------------------------------- prompt */

// One shape per job. Built from the selection and never editable, so what runs
// is always what the screen above it describes.
//
// 'commit' or 'deploy', never both in one instruction: the commit has to be
// checked against the org before a promotion goes out, and a combined message
// leaves no point at which to check. Creating a story is a separate step.
let promptAction = 'commit';

function buildPrompt() {
  if (!$('story-form').hidden) return createPrompt();

  const name = chosenStory?.name;
  return promptAction === 'deploy' ? deployPrompt(name) : commitPrompt(name);
}

// The destination is the pipeline's to decide. Naming one here would override
// the route the story was set up to take, which is not this extension's call.
function deployPrompt(storyName) {
  return `Promote user story ${storyName || '<user story>'} and deploy it to the next ` +
    'environment in the pipeline.';
}

// No component list. Creating is the plan agent's job; committing is a separate
// step for the release agent, using the selection already made here.
function createPrompt() {
  const title = $('story-title').value.trim() || '<title>';
  const context = [
    selectedLabel('story-project') && `project ${selectedLabel('story-project')}`,
    selectedLabel('story-sprint') && `sprint ${selectedLabel('story-sprint')}`,
    selectedLabel('story-environment') && `environment ${selectedLabel('story-environment')}`,
  ].filter(Boolean).join(', ');

  return `Create a new user story titled "${title}"${context ? ` in ${context}` : ''}.`;
}

// No commit message: Copado writes its own from the story, and one typed here
// would have to be carried across from a screen two steps earlier.
function commitPrompt(storyName) {
  const list = selectedComponents().map((c) => `- ${c.fullName} (${c.type})`).join('\n');

  return [
    `Commit the following components to user story ${storyName || '<user story>'}:`,
    '', list,
  ].join('\n');
}

// Doubles as the dialogue name, so a session is identifiable in the Copado AI
// UI later rather than being one of a row of timestamps.
function actionSummary() {
  const count = selectedComponents().length;

  if (!$('story-form').hidden) {
    return `Create "${$('story-title').value.trim()}" for ${count} component(s)`;
  }

  const name = chosenStory?.name || 'a user story';

  if (promptAction === 'deploy') return `Deploy ${name} to the next environment`;
  return `Commit ${count} component(s) to ${name}`;
}

// The visible label, not the record id — Copado matches on names, not keys.
function selectedLabel(id) {
  const select = $(id);
  if (!select.value) return '';
  return select.selectedOptions[0]?.text || '';
}

// Set once the plan agent's story is confirmed to exist in the Copado org, and
// what the Commit button then acts on.
let createdStory = null;

async function showPromptPane() {
  // The button that leads here is disabled without it, but this is the last
  // point before work is sent and it is worth being certain.
  if (!aiReady) {
    showPickerProblems(['Copado AI is not configured. Add the key and organization id in settings.']);
    return;
  }

  const creating = !$('story-form').hidden;
  createdStory = null;
  creatingStory = creating;
  autoConfirms = 0;

  // Planning a story and releasing one are different Copado assistants, and
  // sending a create to the release one gets a polite answer and no story.
  currentAssistant = creating ? CopadoAI.ASSISTANTS.plan : CopadoAI.ASSISTANTS.release;

  if (creating && !$('story-title').value.trim()) {
    showPickerProblems(['Enter a user story title.']);
    $('story-title').focus();
    return;
  }
  if (!creating && !chosenStory) {
    showPickerProblems(['Pick a story, or open a new one.']);
    return;
  }

  // Creating a story is a job on its own — commit and deploy come after it, as
  // separate steps.
  $('prompt-action-wrap').hidden = creating;
  if (creating) promptAction = 'commit';

  refreshPromptAction();

  // Said again here, not only on the row: this is the last point before the
  // work starts, and the row may be scrolled out of sight.
  const clash = !creating && chosenStory && mismatched(chosenStory);
  $('prompt-warn').hidden = !clash;
  if (clash) {
    $('prompt-warn').textContent =
      `${chosenStory.name} belongs to ${chosenStory.environment || 'another environment'}, ` +
      `but you are browsing ${sourceEnv.environmentName || sourceEnv.credentialName}. ` +
      'Committing from a different source than the story expects is what Copado rejects.';
  }

  showPromptProblems([]);
  showPane('prompt');
}

function refreshPromptAction() {
  // Promoting a story needs no components; committing to one is meaningless
  // without them. So the gate is per action, not on the whole screen.
  const hasComponents = selectedComponents().length > 0;
  if (!hasComponents && promptAction !== 'deploy' && !creatingStory) promptAction = 'deploy';

  $('prompt-action').querySelectorAll('button').forEach((b) => {
    const needsComponents = b.dataset.action !== 'deploy';
    b.disabled = needsComponents && !hasComponents;
    b.title = b.disabled ? 'Select components first — a commit needs something to commit.' : '';
    b.classList.toggle('active', b.dataset.action === promptAction);
  });

  // Only explains the commit/deploy choice; creating a story has no such choice.
  $('prompt-no-components').hidden = hasComponents || creatingStory;

  $('prompt-summary').textContent = actionSummary();

  // Always regenerated: the instruction is derived, never typed, so it cannot
  // drift from the action and selection shown above it.
  $('ai-prompt').value = buildPrompt();
}

function showPromptProblems(problems) {
  const box = $('prompt-problems');
  box.innerHTML = '';
  box.hidden = problems.length === 0;
  for (const p of problems) box.appendChild(el('div', 'problem', p));
}

/* ------------------------------------------------------------- running */

// Which job the last instruction asked for: 'create', 'commit' or 'deploy'.
// The result screen reports on this rather than paraphrasing the reply.
let lastTask = 'commit';

// True while the exchange in progress is a story creation. Only that flow
// answers a confirmation by itself.
let creatingStory = false;

// The story the last exchange was about, whatever came of it. Distinct from
// deployableStory: for finding the record again, not for deciding anything is
// safe to promote.
let lastStory = null;

async function runAiPrompt() {
  const prompt = $('ai-prompt').value.trim();
  if (!prompt) {
    showPromptProblems(['Nothing to run — the instruction is empty.']);
    return;
  }

  // A new job supersedes whatever the last one left running.
  stopWatching();
  questionsAsked = 0;
  lastTask = creatingStory ? 'create' : (promptAction === 'deploy' ? 'deploy' : 'commit');

  showProgress(TASK_TITLES[lastTask], 'Starting…');

  try {
    // Taken before the work runs, so what it produces can be told apart from
    // what was already there.
    if (lastTask === 'commit') await captureCommitBaseline(chosenStory);
    if (lastTask === 'create') await captureStoryBaseline();
    if (lastTask === 'deploy') await captureDeployBaseline(chosenStory);

    if (!aiDialogueId) {
      const dialogue = await CopadoAI.createDialogue(actionSummary());
      aiDialogueId = dialogue?.id || dialogue?.dialogue_id || dialogue?.dialogueId;
      if (!aiDialogueId) throw new Error('Could not start the session with Copado.');
    }

    $('progress-text').textContent = 'Working in Copado…';

    // Started before the reply is awaited, so the record shows while the work
    // is running rather than after it has finished.
    if (lastTask !== 'create') watchWhileWorking(chosenStory, lastTask);

    const response = await CopadoAI.sendMessage(
      aiDialogueId, prompt, currentAssistant, onProgressEvent
    );

    stopEarlyWatch();
    await handleResponse(response);
  } catch (err) {
    // Back to the confirm screen, not the review: the action is the thing most
    // likely to need changing.
    showPane('prompt');
    showPromptProblems([shortError(err.message)]);
  }
}

// Copado streams its progress; showing it turns a twenty-second freeze into
// something legible.
function onProgressEvent(event) {
  if (event.type === 'status') $('progress-text').textContent = event.content;
}

/* -------------------------------------------------------- confirmation */

/*
 * Copado proposes before it acts, and something has to answer.
 *
 * Creating a user story answers itself: every detail was filled in on the form
 * and pressing Create story is the yes, so a second question adds nothing.
 * Everything else — committing, deploying — is a write to a pipeline, and gets
 * an explicit Yes or No from the user instead. There is nowhere to type a
 * reply, so the only possible answers are the two buttons.
 */
const AUTO_CONFIRM_LIMIT = 2;
let autoConfirms = 0;

// What a Yes would send. Set only while the confirm pane is up.
let pendingConfirm = null;

async function handleResponse(response) {
  const reply = CopadoAI.replyText(response) || '';
  const asking = CopadoAI.awaitsConfirmation(reply);

  if (asking && lastTask === 'create') {
    // For a create, existence settles it. A story already in the org needs no
    // confirmation whatever the reply ends with, and the wording of the reply
    // is not a reliable guide to whether one was made.
    $('progress-text').textContent = 'Checking the org…';
    const made = await verifyStory(reply, { retry: false });
    if (made) return finish(reply, made);

    // Past the limit the question goes to the user rather than round again.
    if (autoConfirms < AUTO_CONFIRM_LIMIT) return autoConfirmCreate();
    return askUser(reply);
  }

  /*
   * A commit that has already started needs no permission to continue.
   *
   * Copado writes the commit record the moment it accepts the job, so once one
   * appears the work is underway and any further question is about something
   * already decided. Checking here is what stops a run turning into a string of
   * prompts — and it is also what gets the user to the progress and the commit
   * link, which only the report shows.
   */
  if (asking && lastTask !== 'create') {
    $('progress-text').textContent = 'Checking the org…';
    const story = await verifyStory(reply);

    if (story && copadoContext && await workStarted(story)) return finish(reply, story);
  }

  // Committing and deploying write to a pipeline, so the user says yes or no —
  // but only so many times. Past that the questions are going in circles, and
  // what the org holds is a better answer than another prompt.
  if (asking && questionsAsked < QUESTION_LIMIT) return askUser(reply);

  if (asking) {
    $('progress-text').textContent = 'Checking the org…';
    const story = await verifyStory(reply);
    await finish(reply, story);
    showResultProblems([`Copado is still asking: ${questionOf(reply) || 'see the reply.'}`]);
    return undefined;
  }

  $('progress-text').textContent = 'Checking the org…';
  return finish(reply, await verifyStory(reply));
}

/*
 * Whether the org shows this run's work already underway.
 *
 * Copado writes its record the moment it accepts a job — a commit record for a
 * commit, a promotion for a deploy — so once one appears that was not there
 * before, the work is started and any further question is about something
 * already decided. Relaying it keeps the user off the screen that shows the
 * record, its status and its link.
 */
async function workStarted(story) {
  const read = lastTask === 'deploy'
    ? Copado.activityOf(copadoContext, story.id).then(freshActivity)
    : Copado.commitsOf(copadoContext, story.id).then(freshCommits);

  return read.then((rows) => rows.length > 0).catch(() => false);
}

async function finish(reply, story) {
  showResultProblems([]);
  showPane('result');
  await renderOutcome(reply, story);
}

async function autoConfirmCreate() {
  autoConfirms += 1;
  showProgress(TASK_TITLES.create, 'Working in Copado…');

  try {
    const response = await CopadoAI.sendMessage(
      aiDialogueId, 'Yes, proceed.', currentAssistant, onProgressEvent
    );
    await handleResponse(response);
  } catch (err) {
    showPane('result');
    resetResult();
    setOutcome('fail', 'The user story could not be created.');
    showResultProblems([shortError(err.message)]);
  }
}

// The question, put to the user as two buttons. Trimmed to the question itself
// — the reasoning behind it is not something to read here.
// How many go-ahead questions one exchange may put to the user before the
// screen stops relaying them. Past this they are not progress, they are a loop.
const QUESTION_LIMIT = 2;
let questionsAsked = 0;

function askUser(reply) {
  questionsAsked += 1;
  pendingConfirm = { text: 'Yes, proceed.' };

  $('confirm-text').textContent = questionOf(reply)
    || `Copado needs confirmation before it ${TASK_VERBS[lastTask]}. Continue?`;

  // A question about "the components" cannot be answered without seeing which
  // ones, so the list Yes acts on is shown with it.
  const components = lastTask === 'commit' ? selectedComponents() : [];
  renderComponentTable(components, () => ({ text: 'To commit', tone: 'wait' }), 'confirm');

  showPane('confirm');
}

const TASK_VERBS = {
  create: 'creates the user story',
  commit: 'commits the components',
  deploy: 'deploys the story',
};

// The last question in the reply, and nothing else. Copado's answers run to
// paragraphs of plan; the only part that needs answering is the question.
function questionOf(reply) {
  const questions = (reply || '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('?') && line.length < 200);

  return questions.length ? questions[questions.length - 1] : '';
}

async function answerYes() {
  const answer = pendingConfirm?.text || 'Yes, proceed.';
  pendingConfirm = null;

  showProgress(TASK_TITLES[lastTask], 'Working in Copado…');

  try {
    if (lastTask !== 'create') watchWhileWorking(lastStory || chosenStory, lastTask);

    const response = await CopadoAI.sendMessage(
      aiDialogueId, answer, currentAssistant, onProgressEvent
    );

    stopEarlyWatch();
    await handleResponse(response);
  } catch (err) {
    showPane('result');
    resetResult();
    setOutcome('fail', 'The work could not be completed.');
    showResultProblems([shortError(err.message)]);
  }
}

// No is answered here rather than in Copado. Nothing has been written at this
// point, so there is nothing to undo and no reason to spend another round trip
// being told so.
function answerNo() {
  pendingConfirm = null;

  showPane('result');
  showResultProblems([]);
  resetResult();
  setOutcome('warn', 'Cancelled. Nothing was changed in Copado.');
}

/* -------------------------------------------------------- the outcome */

// The verdict of the last report, which decides whether re-reading the org is
// worth offering.
let lastTone = 'working';

// Kept so the report can be rebuilt against the org without running anything
// again.
let lastReply = '';

/*
 * Everything shown here is read back out of the Copado org. A reply claiming a
 * story was created is not the same as one existing, and only the org can tell
 * the difference — so the report never quotes it. Success or failure, the
 * records that prove it, and the components. Nothing else.
 */
async function renderOutcome(reply, story) {
  lastReply = reply;
  resetResult();
  setOutcome('working', 'Checking the org…');

  const components = selectedComponents();

  // Both reads go out together: they answer the same question from different
  // objects, and a commit is confirmed by either.
  const [attached, commits] = await Promise.all([
    attachedNames(story),
    commitRecords(story),
  ]);

  if (story) {
    const label = `${story.name}${story.title ? ` · ${story.title}` : ''}`;
    const host = $('result-story');
    host.innerHTML = '';
    host.appendChild(recordLink(story.id, label));
    host.hidden = false;
  }

  if (lastTask === 'create') reportCreate(story, components, reply);
  else if (lastTask === 'deploy') reportDeploy(story, reply);
  else reportCommit(story, components, attached, commits, reply);

  // A Copado record can trail the reply, so anything short of a clean result is
  // worth re-reading before starting over.
  $('modal-recheck').hidden = lastTone === 'ok';
}

function resetResult() {
  $('result-story').hidden = true;
  $('result-records').hidden = true;
  $('result-records').innerHTML = '';
  $('result-failure').hidden = true;
  $('result-table-wrap').hidden = true;
  $('modal-commit').hidden = true;
  $('modal-deploy').hidden = true;
  $('modal-recheck').hidden = true;
}

function reportCreate(story, components, reply) {
  if (!story) {
    // Said as a fact about the org, not a doubt about the reply: no story exists
    // that was not already there before this ran.
    setOutcome('fail', 'No new user story was created in the Copado org.');
    showResultProblems([shortError(reply)]);
    return;
  }

  createdStory = story;

  setOutcome('ok', components.length
    ? `User story created. ${components.length} component(s) ready to commit.`
    : 'User story created. Nothing is selected to commit to it.');

  renderComponentTable(components, () => ({ text: 'Ready', tone: 'wait' }));
  $('modal-commit').hidden = components.length === 0;
}

/*
 * A commit is reported from two independent records, because neither is
 * present on every Copado version: the commit record itself, which newer
 * Copado writes when the selection reaches git, and the attached-metadata
 * rows, which older versions write. Either one existing is a real commit.
 *
 * Deploy is offered only when one of them says so. Promoting a story whose
 * commit never landed is how an empty deployment goes out.
 */
function reportCommit(story, components, attached, commits, reply) {
  if (!story) {
    setOutcome('fail', 'Nothing was committed — the story could not be read back from the org.');
    showResultProblems([shortError(reply)]);
    return;
  }

  const landed = attached ? components.filter((c) => isAttached(attached, c.fullName)) : [];

  // An empty metadata list is not a failed commit: newer Copado sends the
  // selection to git and leaves that object unused. It is only the
  // per-component answer when it actually holds something.
  const perComponent = landed.length > 0;
  const latest = commits && commits.length ? commits[0] : null;

  if (latest) renderCommitRows(commits);

  /*
   * A commit record existing means Copado accepted the job, not that it ran it.
   * Reporting components as committed and offering Deploy while the record
   * still says In progress is a claim about work that has not happened — and
   * Deploy on a half-written commit is exactly the empty promotion this screen
   * exists to prevent. So an unsettled record reports progress and nothing else,
   * and the watcher fills in the verdict when there is one.
   */
  if (latest && !isSettled(latest.status)) {
    setOutcome('working', `Committing ${components.length} component(s) to ${story.name}…`);
    renderComponentTable(components, () => ({ text: 'Committing', tone: 'wait' }));
    watchCommit(story, components);
    return;
  }

  if (latest && isNeutral(latest.status)) {
    setOutcome('warn',
      `Copado found no changes to commit to ${story.name}. These components already `
      + 'match the branch, so nothing was added.');
    renderComponentTable(components, () => ({ text: 'Already there', tone: 'wait' }));
    deployableStory = story;
    $('modal-deploy').hidden = false;
    return;
  }

  if (latest && isFailed(latest.status)) {
    setOutcome('fail', `The commit to ${story.name} failed in Copado.`);
    renderComponentTable(components, () => ({ text: 'Not committed', tone: 'fail' }));
    showFailure(story);
    return;
  }

  if (!latest && !perComponent) {
    // One is a failed commit; the other is an org this extension cannot see
    // the answer in. They need different responses.
    const blind = attached === null && commits === null;

    setOutcome(blind ? 'warn' : 'fail', blind
      ? 'Sent, but this org exposes no commit records, so it could not be confirmed. ' +
        'Check the story in Copado before deploying.'
      : `Nothing was committed to ${story.name}. Deploy stays off — promoting now ` +
        'would push an empty story.');

    renderComponentTable(components, () => blind
      ? { text: 'Sent', tone: 'wait' }
      : { text: 'Not committed', tone: 'fail' });
    return;
  }

  if (perComponent) {
    setOutcome(landed.length === components.length ? 'ok' : 'warn',
      `${landed.length} of ${components.length} component(s) committed to ${story.name}.`);

    renderComponentTable(components, (c) => isAttached(attached, c.fullName)
      ? { text: 'Committed', tone: 'ok' }
      : { text: 'Not committed', tone: 'fail' });
  } else {
    setOutcome('ok',
      `${components.length} component(s) committed to ${story.name}. Ready to deploy.`);
    renderComponentTable(components, () => ({ text: 'Committed', tone: 'ok' }));
  }

  deployableStory = story;
  $('modal-deploy').hidden = false;
}

// Rows first, so the record is on screen before the first poll comes back.
function renderCommitRows(commits) {
  renderRecords(commits.map((c) => ({
    id: c.id,
    label: `Commit ${c.name}`,
    status: c.status,
    when: c.when,
  })));
}

// Deploy is turned on here and nowhere earlier: this is the first point at
// which the commit is known to have finished.
async function watchCommit(story, components) {
  const rows = await watchRecords(
    () => Copado.commitsOf(copadoContext, story.id).then((all) => freshCommits(all).slice(0, 1)),
    (items) => {
      renderCommitRows(items);
      setOutcome('working', `Committing ${components.length} component(s) to ${story.name}…`);
    }
  );
  if (!rows || !rows.length) return;

  const status = rows[0].status;

  if (isFailed(status)) {
    settleOutcome('fail', `The commit to ${story.name} failed in Copado. Deploy stays off.`);
    renderComponentTable(components, () => ({ text: 'Not committed', tone: 'fail' }));
    showFailure(story);
    deployableStory = null;
    $('modal-deploy').hidden = true;
    return;
  }

  /*
   * The commit ran and found nothing to record.
   *
   * Checked before success, because a status can say both — "Completed, no
   * changes" is one job, not two — and the more specific reading is the true
   * one. Deploy stays available: the story may carry earlier commits, and
   * whether it is worth promoting is not this screen's call to make.
   */
  if (isNeutral(status)) {
    settleOutcome('warn',
      `Copado found no changes to commit to ${story.name}. These components already `
      + 'match the branch, so nothing was added.');
    renderComponentTable(components, () => ({ text: 'Already there', tone: 'wait' }));
    deployableStory = story;
    $('modal-deploy').hidden = false;
    return;
  }

  if (isDone(status)) {
    settleOutcome('ok',
      `${components.length} component(s) committed to ${story.name}. Ready to deploy.`);
    renderComponentTable(components, () => ({ text: 'Committed', tone: 'ok' }));
    deployableStory = story;
    $('modal-deploy').hidden = false;
    return;
  }

  // Ran out of patience rather than out of job. Nothing is claimed either way,
  // and the commit record is on screen to follow.
  settleOutcome('warn',
    `The commit to ${story.name} is still running in Copado. Open the record to follow it.`);
}

function reportDeploy(story, reply) {
  if (!story) {
    setOutcome('warn', 'Sent to the pipeline, but the story could not be read back from the org.');
    showResultProblems([shortError(reply)]);
    return;
  }

  setOutcome('working', `Promoting ${story.name}…`);
  if (!copadoContext) return;

  watchDeploy(story, reply);
}

/*
 * Records the story already carried before this deploy.
 *
 * A story promoted last week still has that record, and reading the newest one
 * without checking reports an old, completed promotion as the result of this
 * run — a deployment reported as done that never started.
 */
// id -> the status it had before this deploy. A Map rather than a Set of ids,
// because Copado does not always make a new record: promoting a story that
// already has a promotion re-runs that one, and the only sign it is running
// again is its status changing.
let deployBaseline = null;

async function captureDeployBaseline(story) {
  deployBaseline = null;
  if (!copadoContext || !story) return;

  const activity = await Copado.activityOf(copadoContext, story.id).catch(() => null);
  if (activity?.readable) {
    deployBaseline = new Map(activity.items.map((i) => [i.id, i.status || '']));
  }
}

/*
 * The records belonging to this run.
 *
 * Three ways a record qualifies, and only the first is obvious:
 *
 *   - it did not exist before, so Copado made it for this run;
 *   - it existed but its status has changed, so Copado re-ran it;
 *   - it existed, its status has not changed yet, but it is not finished —
 *     a promotion sitting "In progress" seconds after a deploy was asked for
 *     is this deploy, whatever the baseline says.
 *
 * Requiring only the first is what hid the promotion on a retry: the record
 * was already there, so nothing ever looked new and the screen waited out the
 * clock while Copado deployed.
 */
function freshActivity(activity) {
  if (!activity) return [];
  if (!deployBaseline) return activity.items;

  return activity.items.filter((item) => {
    if (!deployBaseline.has(item.id)) return true;
    if (deployBaseline.get(item.id) !== (item.status || '')) return true;
    return !isSettled(item.status);
  });
}

// How long to wait for the org to show the deployment at all. Copado writes
// its record almost immediately or not at all, so a minute is generous — and
// six minutes of "deploying…" before admitting nothing happened is not an
// answer, it is a hang.
const DEPLOY_APPEAR_MS = 60000;

/*
 * Waits for the org to show the deployment at all.
 *
 * Answers three different things, because they need three different messages:
 * a record appeared, nothing appeared, or none of these objects can be read
 * here. Reporting the second when the truth is the third is how a successful
 * deploy looks like a failure.
 */
/*
 * Watches the org while the instruction is still being answered.
 *
 * Copado begins the promotion as soon as it accepts the instruction, but the
 * assistant's reply does not arrive until it has finished talking — routinely
 * after the deployment itself has finished. Watching only from the reply means
 * the running state is over before anything has looked at it, which is why a
 * deploy appeared to jump straight to its verdict.
 *
 * This writes to the progress screen only. The reply, when it comes, still
 * decides what actually happened.
 */
let earlyToken = 0;

const stopEarlyWatch = () => { earlyToken += 1; };

async function watchWhileWorking(story, task) {
  if (!copadoContext || !story) return;

  const token = ++earlyToken;
  const read = task === 'deploy'
    ? () => Copado.activityOf(copadoContext, story.id).then(freshActivity)
    : () => Copado.commitsOf(copadoContext, story.id).then(freshCommits);

  for (;;) {
    await new Promise((r) => setTimeout(r, COMMIT_POLL_MS));
    if (token !== earlyToken) return;

    const rows = await read().catch(() => []);
    if (token !== earlyToken) return;
    if (!rows.length) continue;

    renderProgressRecords(rows.slice(0, 2));
  }
}

// The same row the result screen uses, so the record does not change shape when
// the reply lands and the screen behind it changes.
function renderProgressRecords(rows) {
  const host = $('progress-record');
  host.innerHTML = '';

  for (const row of rows) {
    const line = el('div', 'record-row');
    line.appendChild(recordLink(row.id, row.label || row.name || 'Record'));

    const tone = statusTone(row.status);
    const pill = el('span', `record-status ${tone}`);
    if (tone === 'wait') pill.appendChild(el('span', 'spinner tiny'));
    pill.appendChild(el('span', 'record-status-text', row.status || 'In progress'));

    line.appendChild(pill);
    host.appendChild(line);
  }
  host.hidden = rows.length === 0;
}

async function waitForDeployRecord(story) {
  const deadline = Date.now() + DEPLOY_APPEAR_MS;
  let readable = false;

  for (;;) {
    const activity = await Copado.activityOf(copadoContext, story.id).catch(() => null);
    readable = readable || Boolean(activity?.readable);

    const fresh = freshActivity(activity);
    if (fresh.length) {
      renderRecords(fresh.slice(0, 3));
      return 'found';
    }
    if (Date.now() >= deadline) return readable ? 'none' : 'unreadable';

    setOutcome('working', `Waiting for Copado to create the promotion for ${story.name}…`);
    await new Promise((r) => setTimeout(r, COMMIT_POLL_MS));
  }
}

async function watchDeploy(story, reply) {
  const appeared = await waitForDeployRecord(story);

  if (appeared === 'unreadable') {
    settleOutcome('warn',
      `${story.name} was sent to the pipeline. This org exposes no promotion or `
      + 'deployment records, so its progress cannot be followed here.');
    return;
  }

  if (appeared === 'none') {
    settleOutcome('fail',
      `Copado recorded no deployment for ${story.name}. Nothing has been deployed.`);
    showResultProblems([shortError(reply)]);
    return;
  }

  // The record exists now, so the line above it stops saying it is waiting for
  // one. Restated on every poll: a status frozen while the rows underneath keep
  // changing is the more confusing of the two.
  const rows = await watchRecords(
    () => Copado.activityOf(copadoContext, story.id)
      .then((a) => freshActivity(a).slice(0, 3)),
    (items) => {
      renderRecords(items);
      setOutcome('working', `Deploying ${story.name}…`);
    }
  );

  if (!rows || !rows.length) {
    settleOutcome('warn',
      `${story.name} was sent to the pipeline, but its records could not be read back.`);
    return;
  }

  // Every record has to finish, not just the first: a promotion completing
  // while its job is still running is not a finished deployment.
  if (rows.some((r) => isFailed(r.status))) {
    settleOutcome('fail', `The deployment of ${story.name} failed in Copado.`);
    showFailure(story);
    return;
  }

  if (rows.every((r) => isDone(r.status))) {
    settleOutcome('ok', `${story.name} deployed.`);
    return;
  }

  settleOutcome('warn',
    `${story.name} is still deploying in Copado. Open the record to follow it.`);
}

/* --------------------------------------------------- outcome plumbing */

async function recheckOutcome() {
  // The report is about to be rebuilt from scratch; a watcher from the previous
  // one would keep writing its own status over the new rows.
  stopWatching();

  const button = $('modal-recheck');
  button.disabled = true;
  button.textContent = 'Checking…';

  try {
    const story = await verifyStory(lastReply);
    await renderOutcome(lastReply, story);
  } catch (err) {
    showResultProblems([shortError(err.message)]);
  } finally {
    button.disabled = false;
    button.textContent = 'Check again';
  }
}

/*
 * Copado's failure text, shown as it was written.
 *
 * "Completed with error" is a status; the text names the component, the field
 * and the reason, and that is the only part anyone can act on. It is preformatted
 * because Copado separates each failure with a newline, and collapsing those
 * turns a list of problems into one unreadable sentence.
 */
async function showFailure(story) {
  if (!copadoContext || !story) return;

  const failure = await Copado.failureOf(copadoContext, story.id).catch(() => null);
  if (!failure?.message) return;

  $('result-failure-text').textContent = failure.message;
  $('result-failure').hidden = false;
}

function setOutcome(tone, text) {
  lastTone = tone;

  const box = $('result-status');
  box.className = `result-status ${tone}`;
  box.innerHTML = '';

  // Without it, a line that will change on its own looks exactly like a
  // verdict that will not, and waiting reads as a hang.
  if (tone === 'working') box.appendChild(el('span', 'spinner tiny'));
  box.appendChild(el('span', null, text));

  box.hidden = false;
}

// Called once a job has stopped moving. Separate from setOutcome because that
// one also reports progress, and offering "Check again" against a job that is
// still running invites a click that changes nothing.
function settleOutcome(tone, text) {
  setOutcome(tone, text);
  $('modal-recheck').hidden = tone === 'ok';
}

function showResultProblems(problems) {
  const box = $('result-problems');
  box.innerHTML = '';

  const lines = problems.filter(Boolean);
  box.hidden = lines.length === 0;
  for (const p of lines) box.appendChild(el('div', 'problem', p));
}

/*
 * The reason, the fix, and where it happened — and nothing past that.
 *
 * A single line is too few: an API error leads with what was wrong and follows
 * with what to do about it, and keeping only the first sentence throws away
 * the actionable half. A whole reply is too many. Three lines is the shape
 * these errors actually come in.
 */
function shortError(text) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';

  const kept = lines.slice(0, 3).join('\n');
  return kept.length > 400 ? `${kept.slice(0, 397)}…` : kept;
}

// `target` picks which pane's table to fill: the result screen reports what
// happened, the confirm screen shows what a Yes would act on. Same table.
function renderComponentTable(components, statusOf, target = 'result') {
  renderRows('Components', components.map((c) => ({
    name: c.fullName,
    type: kindLabel(c.type),
    status: statusOf(c),
  })), target);
}

function renderRows(heading, rows, target = 'result') {
  $(`${target}-table-head`).textContent = `${heading} (${rows.length})`;

  const host = $(`${target}-table`);
  host.innerHTML = '';

  for (const r of rows) {
    const line = el('div', 'outcome-row');
    line.append(
      el('span', 'outcome-name', r.name),
      el('span', 'outcome-type', r.type || ''),
      el('span', `outcome-status ${r.status.tone}`, r.status.text)
    );
    host.appendChild(line);
  }

  $(`${target}-table-wrap`).hidden = rows.length === 0;
}

/* ------------------------------------------------- records and progress */

/*
 * Copado's commit and promotion both run as asynchronous jobs, and the record
 * they write carries the answer. Watching it here is the whole point of this
 * screen: without it the only way to find out whether the thing just asked for
 * actually worked is to open Copado and go looking.
 *
 * So each record is shown as a row that updates in place until its status
 * stops changing, and the row is a link to the record itself for everything
 * this screen cannot show.
 */
const WATCH_POLL_MS = 4000;
const WATCH_TIMEOUT_MS = 6 * 60 * 1000;

// Copado status values differ by version and by org, so the terminal states are
// matched on intent rather than an exact list that would go stale and leave the
// screen spinning on a job that finished.
const DONE_STATUS = /(complete|success|succeed|done|deployed|promoted)/i;
const FAILED_STATUS = /(fail|error|cancel|abort|reject)/i;

/*
 * Finished, but neither succeeded nor failed.
 *
 * "No changes" is a real Copado outcome: the commit ran, compared the selection
 * against the branch, and found nothing different. It is the end of the job.
 *
 * Missing it costs twice. The watcher never sees the job settle, so it polls to
 * its timeout and then reports work that finished minutes ago as still running;
 * and the row keeps a spinner beside a status that will never change again.
 */
const NEUTRAL_STATUS = /(no changes|nothing to|up to date|not required|skipped)/i;

const isDone = (s) => DONE_STATUS.test(s || '');
const isFailed = (s) => FAILED_STATUS.test(s || '');
const isNeutral = (s) => NEUTRAL_STATUS.test(s || '');
const isSettled = (s) => isDone(s) || isFailed(s) || isNeutral(s);

function statusTone(status) {
  if (isFailed(status)) return 'fail';
  if (isNeutral(status)) return 'idle';
  if (isDone(status)) return 'ok';
  return 'wait';
}

// Bumped whenever a new job starts or the dialog is reset, so a watcher left
// running from a previous run stops rather than writing its stale status over
// the current one.
let watchToken = 0;

const stopWatching = () => { watchToken += 1; };

/*
 * Polls until every record has settled, rendering each pass.
 *
 * `read` returns the rows to show. Rendering happens on every pass, not only
 * on change, because a row that appears mid-run has to reach the screen too.
 */
async function watchRecords(read, render) {
  const token = watchToken;
  const deadline = Date.now() + WATCH_TIMEOUT_MS;

  for (;;) {
    const rows = await read().catch(() => null);
    if (token !== watchToken) return null;

    if (rows && rows.length) render(rows);

    const settled = rows && rows.length && rows.every((r) => isSettled(r.status));
    if (settled || Date.now() >= deadline) return rows;

    await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
    if (token !== watchToken) return null;
  }
}

/* ------------------------------------------------------------- rendering */

function renderRecords(rows) {
  const host = $('result-records');
  host.innerHTML = '';

  for (const row of rows) {
    const line = el('div', 'record-row');

    line.appendChild(recordLink(row.id, row.label));

    const status = row.status || 'In progress';
    const tone = statusTone(row.status);

    // A spinner rather than a word for the unsettled case: the row is going to
    // change on its own, and saying so is the difference between "working" and
    // "stuck".
    const pill = el('span', `record-status ${tone}`);
    if (tone === 'wait') pill.appendChild(el('span', 'spinner tiny'));
    pill.appendChild(el('span', 'record-status-text', status));
    line.appendChild(pill);

    if (row.when) line.appendChild(el('span', 'record-when', shortDate(row.when)));

    host.appendChild(line);
  }

  host.hidden = rows.length === 0;
}

/*
 * A Salesforce record id resolves from the instance root, so /<id> is enough —
 * no object name, no Lightning path to get wrong across releases.
 *
 * chrome.tabs.create rather than a plain href: a popup closes the moment focus
 * leaves it, which would take the running watcher with it. Opening the tab
 * explicitly keeps the popup alive.
 */
function recordLink(id, label) {
  const instanceUrl = copadoContext?.org?.instanceUrl;
  if (!id || !instanceUrl) return el('span', 'record-name', label);

  const link = el('a', 'record-name link', label);
  link.href = `${instanceUrl}/${id}`;
  link.title = 'Open in Copado';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: link.href });
  });
  return link;
}

/* ------------------------------------------------- reading it back */

// Copado names the story it worked on; that name is looked up rather than
// trusted, and the title is the fallback when it named nothing.
async function verifyStory(reply, { retry = true } = {}) {
  if (!copadoContext) return chosenStory;

  // A create is answered only by a story that was not there beforehand. Every
  // other task is already about a known story, so a name in the reply is worth
  // resolving directly.
  if (lastTask === 'create') return findNewStory(reply, retry);

  const named = (reply || '').match(/\bUS-\d+\b/);
  if (named) {
    const found = await Copado.byName(copadoContext, named[0]).catch(() => null);
    if (found) return found;
  }

  return lastStory || createdStory || deployableStory || chosenStory;
}

/*
 * Story ids that existed before the create was asked for.
 *
 * Without this, "did it create the story" is answered by looking for the title,
 * and any story already carrying that title — or a title the new one merely
 * contains — answers yes. The result is a success message pointing at somebody
 * else's story while nothing was created at all.
 *
 * An id absent from this set is the only thing that proves a story is new, and
 * unlike a timestamp it does not depend on the org's clock agreeing with ours.
 */
let storyBaseline = null;

async function captureStoryBaseline() {
  storyBaseline = null;
  if (!copadoContext) return;

  const stories = await Copado.recent(copadoContext, 200).catch(() => null);
  if (stories) storyBaseline = new Set(stories.map((s) => s.id));
}

async function findNewStory(reply, retry) {
  const found = await newStoryOnce(reply);
  if (found || !retry) return found;

  // The reply lands as soon as the insert is issued, which can be a second or
  // so ahead of the record being queryable.
  await new Promise((r) => setTimeout(r, 1500));
  return newStoryOnce(reply);
}

async function newStoryOnce(reply) {
  const recent = await Copado.recent(copadoContext, 25).catch(() => null);
  if (!recent) return null;

  // No baseline means no way to tell new from old, and guessing is what caused
  // the wrong story to be reported in the first place.
  if (!storyBaseline) return null;

  const fresh = recent.filter((s) => !storyBaseline.has(s.id));
  if (!fresh.length) return null;

  const named = (reply || '').match(/\bUS-\d+\b/);
  if (named) {
    const hit = fresh.find((s) => s.name === named[0]);
    if (hit) return hit;
  }

  // Among stories that are all definitely new, a looser title match is safe —
  // the worst case is picking the wrong one of several created at once, not
  // resurrecting an old one. A single new story needs no match at all.
  const want = flattenTitle($('story-title').value.trim());
  return fresh.find((s) => flattenTitle(s.title) === want)
    || fresh.find((s) => flattenTitle(s.title).includes(want))
    || (fresh.length === 1 ? fresh[0] : null);
}

const flattenTitle = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// What Copado holds against the story, lower-cased: names come back in whatever
// casing Copado stored, and a case difference is not a missing commit.
async function attachedNames(story) {
  if (!copadoContext || !story || lastTask !== 'commit') return null;

  const items = await Copado.metadataFor(copadoContext, story.id).catch(() => null);
  if (!items) return null;

  return new Set(items.map((i) => (i.name || '').toLowerCase()));
}

/*
 * Commit records that were not on the story before this run.
 *
 * Two things make the naive check wrong. A story committed to last week
 * already has records, so finding one afterwards proves nothing — hence the
 * baseline. And Copado's commit is asynchronous: the reply arrives as soon as
 * the job is queued and the record can be most a minute behind it, so a single
 * read taken the instant the reply lands reports a good commit as nothing at
 * all. It is polled instead.
 */
const COMMIT_WAIT_MS = 45000;
const COMMIT_POLL_MS = 3000;

let commitBaseline = null;

async function captureCommitBaseline(story) {
  commitBaseline = null;
  if (!copadoContext || !story) return;

  const commits = await Copado.commitsOf(copadoContext, story.id).catch(() => null);
  if (commits) commitBaseline = new Set(commits.map((c) => c.id));
}

// Without a baseline every record looks new. That is the best that can be said,
// and still better than ignoring them.
function freshCommits(commits) {
  if (!commits) return [];
  return commitBaseline ? commits.filter((c) => !commitBaseline.has(c.id)) : commits;
}

async function commitRecords(story) {
  if (!copadoContext || !story || lastTask !== 'commit') return null;

  const deadline = Date.now() + COMMIT_WAIT_MS;

  for (;;) {
    const commits = await Copado.commitsOf(copadoContext, story.id).catch(() => null);
    if (commits === null) return null;

    const fresh = freshCommits(commits);
    if (fresh.length || Date.now() >= deadline) return fresh;

    setOutcome('working', 'Waiting for Copado to write the commit record…');
    await new Promise((r) => setTimeout(r, COMMIT_POLL_MS));
  }
}

// Fields are selected as Object.Field__c but stored by Copado under either that
// or the bare field name, so both spellings count as attached.
function isAttached(attached, fullName) {
  const name = fullName.toLowerCase();
  return attached.has(name) || attached.has(name.split('.').pop());
}

/* ------------------------------------------------ commit and deploy */

// Set once a commit has been confirmed against a known story, so Deploy can
// follow without going back through the picker. Never set on the strength of
// the work having been asked for — only on the org having answered.
let deployableStory = null;

// One click: the components were chosen long before this point, so there is
// nothing left to ask.
function commitCreatedStory() {
  return runTask({
    story: createdStory,
    task: 'commit',
    prompt: commitPrompt(createdStory?.name),
    label: `Commit ${selectedComponents().length} component(s) to ${createdStory?.name}`,
  });
}

function deployStory() {
  // Only ever the story a commit was confirmed against. The button is not shown
  // otherwise, and falling back to whatever was last selected is how a deploy
  // goes out against a story that was never committed to.
  const story = deployableStory;
  if (!story) return;

  return runTask({
    story,
    task: 'deploy',
    prompt: deployPrompt(story?.name),
    label: `Deploy ${story?.name}`,
  });
}

// Commit and deploy differ only in wording, so the session handling and error
// handling live in one place. What happened afterwards is not asserted here —
// the result screen reads it back out of the org.
async function runTask({ story, task, prompt, label }) {
  if (!story) return;

  stopWatching();
  questionsAsked = 0;
  lastTask = task;
  creatingStory = false;
  createdStory = task === 'commit' ? null : createdStory;

  // Committing and deploying are both the release assistant's work.
  currentAssistant = CopadoAI.ASSISTANTS.release;

  showProgress(TASK_TITLES[task], 'Starting…');

  try {
    if (task === 'commit') await captureCommitBaseline(story);
    if (task === 'deploy') await captureDeployBaseline(story);

    const dialogue = await CopadoAI.createDialogue(label);
    aiDialogueId = dialogue?.id || dialogue?.dialogue_id || dialogue?.dialogueId;
    if (!aiDialogueId) throw new Error('Could not start the session with Copado.');

    $('progress-text').textContent = 'Working in Copado…';

    // Started before the reply is awaited, so the record shows while the work is
    // running rather than after it has finished.
    watchWhileWorking(story, task);

    const response = await CopadoAI.sendMessage(
      aiDialogueId, prompt, currentAssistant, onProgressEvent
    );

    stopEarlyWatch();
    lastStory = story;
    await handleResponse(response);
  } catch (err) {
    showPane('result');
    resetResult();
    setOutcome('fail', 'The work could not be completed.');
    showResultProblems([shortError(err.message)]);
  }
}

async function loadCopadoOrg() {
  $('modal-next').disabled = true;

  if (copadoContext) {
    showProblems(copadoContext.resolved.problems);
    return;
  }

  try {
    copadoContext = await Copado.prepare();
  } catch (err) {
    // Nowhere else to say it now that the org line is gone, and a failure to
    // reach the Copado org is exactly what this box is for.
    showProblems([err.message]);
    return;
  }

  const { resolved, lists } = copadoContext;

  fillSelect('story-project', lists.projects);
  fillSelect('story-sprint', lists.sprints);
  fillSelect('story-environment', lists.environments);

  showProblems(resolved.problems);
}

// The review screen only ever advances to the story picker; the work itself is
// two screens further on.
function updateConfirmButton() {
  const next = $('modal-next');

  next.hidden = false;
  next.textContent = 'Next';

  // Reading the story list is a query against the Copado org and needs nothing
  // else. Copado AI is only asked for when work is actually run, so it is not
  // a condition of getting this far.
  next.disabled = !copadoContext || !copadoContext.resolved.canCreate;
}

/* ------------------------------------------------------- story picker */

// Either an existing story from the list, or null while the new-story form is
// open. Never both: the two are alternatives, not a form with a default.
let chosenStory = null;
let allStories = [];

// Which rows are open, and what their metadata query returned. Kept outside the
// render so a search keystroke does not collapse everything or refetch.
const expandedStories = new Set();
const storyMetaCache = new Map();
const storyPromoCache = new Map();

// story id -> its newest commit record, so a row can show what is happening to
// it without a query of its own.
let storyCommits = new Map();

// story id -> the failure text Copado recorded, fetched only when a story is
// expanded and only when its deployment actually failed.
const storyFailureCache = new Map();

async function showStoryPicker() {
  chosenStory = null;
  sourceEnv = null;
  expandedStories.clear();
  storyMetaCache.clear();
  storyPromoCache.clear();
  $('story-form').hidden = true;
  $('story-search').value = '';
  showPickerProblems([]);

  // Said once, at the top, rather than left to be inferred from a dead button:
  // the list works, the step after it does not.
  $('picker-note').hidden = aiReady;

  showPane('stories');

  $('story-list').innerHTML = '';
  $('story-list').appendChild(el('div', 'msg', 'Loading user stories…'));

  try {
    // Not fatal: without it no mismatch is claimed, which is the safe default.
    Copado.sourceEnvOf(copadoContext, session.orgId)
      .then((env) => { sourceEnv = env; renderStories(); })
      .catch(() => {});

    allStories = await Copado.stories(copadoContext);

    // What is happening to each story, fetched after the list is on screen
    // rather than before it: the rows are useful without this, and a commit
    // that is still running is the kind of thing worth seeing here instead of
    // having to open Copado to find it.
    storyCommits = new Map();
    Copado.commitsOfStories(copadoContext, allStories.map((s) => s.id))
      .then((map) => { if (map) { storyCommits = map; renderStories(); } })
      .catch(() => {});
  } catch (err) {
    $('story-list').innerHTML = '';
    showPickerProblems([err.message]);
    return;
  }

  renderStories();
}

function renderStories() {
  const term = $('story-search').value.trim().toLowerCase();
  const host = $('story-list');
  host.innerHTML = '';

  const matches = term
    ? allStories.filter((s) =>
        `${s.name} ${s.title} ${s.project} ${s.sprint}`.toLowerCase().includes(term))
    : allStories;

  if (!matches.length) {
    host.appendChild(el('div', 'msg',
      allStories.length ? 'No story matches that search.' : 'No user stories in this org yet.'));
    return;
  }

  for (const story of matches) host.appendChild(storyRow(story));
}

// A div rather than a button: the row carries its own disclosure control, and a
// button inside a button is invalid and swallows the inner click.
function storyRow(story) {
  const row = el('div', `story-row${chosenStory?.id === story.id ? ' chosen' : ''}`);

  const head = el('div', 'story-head');

  // The number opens the story in Copado. It sits inside a row that also
  // selects the story, so the click has to stop there.
  const number = recordLink(story.id, story.name || '—');
  number.classList.add('story-number');
  number.addEventListener('click', (e) => e.stopPropagation());
  head.appendChild(number);

  // No workflow status chip: that is Copado's own state field, it changes
  // underneath this list, and it says nothing about whether a commit is
  // running. The commit record does, so that is what is shown.
  const commit = storyCommits.get(story.id);
  if (commit) {
    const chip = el('span', `story-commit ${statusTone(commit.status)}`);
    if (statusTone(commit.status) === 'wait') chip.appendChild(el('span', 'spinner tiny'));
    // A separator, because "Commit No changes" reads as an instruction rather
    // than as a state.
    chip.appendChild(el('span', null, `Commit · ${commit.status || 'pending'}`));
    chip.title = `${commit.name}${commit.when ? ` · ${shortDate(commit.when)}` : ''}`;
    head.appendChild(chip);
  }

  // A failed deployment is the one thing about a story worth seeing without
  // expanding it: it is the story that needs attention, and scanning a list for
  // it by opening each row in turn is not scanning.
  const promos = storyPromoCache.get(story.id);
  const failed = Array.isArray(promos) && promos.length && isFailed(promos[0].status);
  if (failed) {
    const chip = el('span', 'story-commit fail', 'Deploy failed');
    chip.title = promos[0].status;
    head.appendChild(chip);
  }

  if (story.environment) head.appendChild(el('span', 'story-env', story.environment));
  if (mismatched(story)) {
    const warn = el('span', 'story-warn', '⚠ other source');
    warn.title = `This story belongs to ${story.environment || 'another environment'}, ` +
      `not ${sourceEnv.environmentName || sourceEnv.credentialName}.`;
    head.appendChild(warn);
  }

  const open = expandedStories.has(story.id);
  const toggle = el('button', 'story-toggle', open ? 'Details ▾' : 'Details ▸');
  toggle.type = 'button';
  toggle.addEventListener('click', (e) => {
    // Without this the row's own handler also fires and selects the story,
    // which is not what expanding a disclosure should mean.
    e.stopPropagation();
    toggleStoryMetadata(story);
  });
  head.appendChild(toggle);

  const context = [story.project, story.sprint, modifiedAgo(story.lastModified)]
    .filter(Boolean).join(' · ');

  row.append(head, el('div', 'story-title', story.title || '(no title)'));
  if (context) row.appendChild(el('div', 'story-context', context));

  if (open) row.appendChild(storyDetails(story));

  row.addEventListener('click', () => {
    chosenStory = story;
    $('story-form').hidden = true;
    renderStories();
    updateStoryButton();
  });

  return row;
}

// The Copado environment matching the org currently being browsed, resolved
// once per picker. Null when it cannot be determined, in which case no mismatch
// is claimed — an unknown source is not evidence of a wrong one.
let sourceEnv = null;

function mismatched(story) {
  if (!sourceEnv || !story.environmentId) return false;
  if (story.credentialId && sourceEnv.credentialId) {
    return story.credentialId !== sourceEnv.credentialId;
  }
  return Boolean(sourceEnv.environmentId) && story.environmentId !== sourceEnv.environmentId;
}

function modifiedAgo(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'modified today';
  if (days === 1) return 'modified yesterday';
  return `modified ${days} days ago`;
}

function storyDetails(story) {
  const box = el('div', 'story-meta');
  box.append(metadataSection(story), promotionSection(story));
  return box;
}

function metadataSection(story) {
  const box = el('div', 'story-section');
  const items = storyMetaCache.get(story.id);

  box.appendChild(el('div', 'story-section-head', 'Attached metadata'));

  if (items === undefined) {
    box.appendChild(el('div', 'story-meta-msg', 'Loading…'));
  } else if (items === null) {
    box.appendChild(el('div', 'story-meta-msg', 'Not readable in this org.'));
  } else if (typeof items === 'string') {
    box.appendChild(el('div', 'story-meta-msg', items));
  } else if (!items.length) {
    box.appendChild(el('div', 'story-meta-msg', 'Nothing attached yet.'));
  } else {
    box.appendChild(el('div', 'story-meta-msg', `${items.length} component(s)`));
    for (const item of items) {
      const line = el('div', 'story-meta-row');
      line.append(
        el('span', 'story-meta-name', item.name || '—'),
        el('span', 'story-meta-type', item.type || '')
      );
      box.appendChild(line);
    }
  }
  return box;
}

// Where the story has already been. This is the direct answer to "why is this
// story's environment not what I expect any more".
function promotionSection(story) {
  const box = el('div', 'story-section');
  const items = storyPromoCache.get(story.id);

  box.appendChild(el('div', 'story-section-head', 'Promotions'));

  if (items === undefined) {
    box.appendChild(el('div', 'story-meta-msg', 'Loading…'));
  } else if (items === null) {
    box.appendChild(el('div', 'story-meta-msg', 'Promotion records are not available in this org.'));
  } else if (typeof items === 'string') {
    box.appendChild(el('div', 'story-meta-msg', items));
  } else if (!items.length) {
    box.appendChild(el('div', 'story-meta-msg', 'Never promoted.'));
  } else {
    for (const p of items) {
      const line = el('div', 'story-meta-row');

      // The auto number, as a link. "DEV → UAT" does not identify which
      // promotion it was, and the record is where the rest of the story is.
      const name = recordLink(p.id, p.name || `${p.from || '?'} → ${p.to || '?'}`);
      name.classList.add('story-meta-name');
      name.title = `${p.from || '?'} → ${p.to || '?'}`;

      line.append(
        name,
        el('span', `story-meta-type ${isFailed(p.status) ? 'fail' : ''}`,
          [p.status, shortDate(p.when)].filter(Boolean).join(' · '))
      );
      box.appendChild(line);

      if (isFailed(p.status)) box.appendChild(failureBlock(story, p));
    }
  }
  return box;
}

/*
 * What went wrong, and the one thing worth doing about it.
 *
 * The status says "Completed with error"; the job execution says which
 * component and which field, which is the only part anyone can act on. Retry
 * goes back through Copado AI naming the promotion, the same way every other
 * action here does — this extension does not write to Copado records.
 */
function failureBlock(story, promotion) {
  const box = el('div', 'story-failure');
  const failure = storyFailureCache.get(story.id);

  if (failure === undefined) {
    box.appendChild(el('div', 'story-meta-msg', 'Loading the error…'));
  } else if (failure?.message) {
    box.appendChild(el('pre', 'story-failure-text', failure.message));
  } else {
    // What was searched belongs in the console, not on the screen. It is a
    // debugging aid for whoever wrote this, and it was never the user's problem.
    box.appendChild(el('div', 'story-meta-msg',
      'No error text was recorded. Open the promotion above to read it in Copado.'));
  }

  const retry = el('button', 'btn small', `Retry ${promotion.name || 'deployment'}`);
  retry.type = 'button';
  retry.title = 'Asks Copado to run this promotion again';
  retry.addEventListener('click', (e) => {
    // The row underneath selects the story; a retry is not that.
    e.stopPropagation();
    retryPromotion(story, promotion);
  });

  const actions = el('div', 'story-failure-actions');
  actions.appendChild(retry);
  box.appendChild(actions);

  return box;
}

// Named by its auto number so Copado acts on the promotion that failed rather
// than starting a new one, which is what "deploy the story again" would do.
function retryPromotion(story, promotion) {
  return runTask({
    story,
    task: 'deploy',
    prompt: `Retry the deployment of promotion ${promotion.name} for user story `
      + `${story.name}. Do not create a new promotion.`,
    label: `Retry ${promotion.name}`,
  });
}

const shortDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

// Loaded on expand and cached, so collapsing and reopening — or re-rendering
// after a search keystroke — does not re-query the org.
async function toggleStoryMetadata(story) {
  if (expandedStories.has(story.id)) {
    expandedStories.delete(story.id);
    renderStories();
    return;
  }

  expandedStories.add(story.id);
  renderStories();

  if (storyMetaCache.has(story.id)) return;

  // Independent so a missing promotion object does not also hide the metadata.
  await Promise.all([
    Copado.metadataFor(copadoContext, story.id)
      .then((r) => storyMetaCache.set(story.id, r), (e) => storyMetaCache.set(story.id, e.message)),
    Copado.promotionsOf(copadoContext, story.id)
      .then((r) => storyPromoCache.set(story.id, r), (e) => storyPromoCache.set(story.id, e.message)),
  ]);

  renderStories();

  // Only for a story that actually failed, and only once. The job execution
  // query is the expensive one, and every other story has nothing to show.
  const promos = storyPromoCache.get(story.id);
  if (Array.isArray(promos) && promos.length && isFailed(promos[0].status)
      && !storyFailureCache.has(story.id)) {
    const failure = await Copado.failureOf(copadoContext, story.id).catch(() => null);
    storyFailureCache.set(story.id, failure);
    renderStories();
  }
}

function showPickerProblems(problems) {
  const box = $('picker-problems');
  box.innerHTML = '';
  box.hidden = problems.length === 0;
  for (const p of problems) box.appendChild(el('div', 'problem', p));
}

function toggleNewStoryForm() {
  const opening = $('story-form').hidden;
  $('story-form').hidden = !opening;

  if (opening) {
    chosenStory = null;
    renderStories();
    $('story-title').focus();
  }
  updateStoryButton();
}

/*
 * The list is browsable either way. What Copado AI gates is the step after it —
 * committing, deploying, opening a new story — because those are the parts it
 * carries out. So the button explains itself rather than the whole screen being
 * withheld.
 */
function updateStoryButton() {
  const button = $('modal-next');
  const creating = !$('story-form').hidden;

  button.textContent = 'Next';
  button.disabled = !aiReady || (!creating && !chosenStory);
  button.title = aiReady ? '' : 'Copado AI is not configured — add the key and organization id in settings.';

  $('story-new').disabled = !aiReady;
  $('story-new').title = aiReady ? '' : 'Creating a story needs Copado AI. Add it in settings.';
}

function renderComponents() {
  const components = selectedComponents();
  const host = $('deploy-components');
  host.innerHTML = '';

  $('deploy-summary').textContent = `Components (${components.length})`;

  for (const c of components) {
    const row = el('div', 'component-row');
    row.append(el('span', 'component-name', c.fullName), el('span', 'component-type', c.type));
    host.appendChild(row);
  }
}

function fillSelect(id, items) {
  const select = $(id);
  select.innerHTML = '';
  select.appendChild(new Option(items.length ? '— None —' : '— Not available —', ''));
  for (const item of items) select.appendChild(new Option(item.name, item.id));
  select.disabled = items.length === 0;
}

function showProblems(problems) {
  const box = $('deploy-problems');
  box.innerHTML = '';
  box.hidden = problems.length === 0;
  for (const p of problems) box.appendChild(el('div', 'problem', p));
}

function onConfirm() {
  return runAiPrompt();
}

const PANES = {
  review:   { title: 'Review',              show: ['modal-next'] },
  stories:  { title: 'Choose a user story', show: ['modal-back', 'modal-next'] },
  prompt:   { title: 'Review the action',   show: ['modal-back', 'modal-create'] },
  result:   { title: 'Result',              show: ['modal-recheck', 'modal-commit', 'modal-deploy'] },
  confirm:  { title: 'Confirm',             show: ['modal-no', 'modal-yes'] },
  // Nothing to press while the work runs, and no Cancel either: Copado is
  // already working and closing the popup would not stop it. The title is set
  // per job by showProgress — one label for three jobs reads as a lie.
  progress: { title: 'Working…',            show: [] },
};

const PANE_BUTTONS = ['modal-back', 'modal-next', 'modal-create', 'modal-recheck',
  'modal-yes', 'modal-no', 'modal-commit', 'modal-deploy'];

let currentPane = 'review';

function showPane(name) {
  const pane = PANES[name];
  currentPane = name;
  $('modal-title').textContent = pane.title;

  $('deploy-review').hidden = name !== 'review';
  $('story-picker').hidden = name !== 'stories';
  $('prompt-pane').hidden = name !== 'prompt';
  $('result-pane').hidden = name !== 'result';
  $('confirm-pane').hidden = name !== 'confirm';
  $('deploy-progress').hidden = name !== 'progress';

  for (const id of PANE_BUTTONS) $(id).hidden = !pane.show.includes(id);
  $('modal-close').hidden = name === 'progress';
  $('modal-close').textContent = name === 'result' ? 'Close' : 'Cancel';

  if (name === 'review') updateConfirmButton();
  if (name === 'stories') updateStoryButton();
  if (name === 'prompt') {
    $('modal-create').textContent = creatingStory ? 'Create story' : 'Run';
    $('modal-create').disabled = false;
  }
  // The report turns these on once it knows what the org actually holds.
  if (name === 'result') {
    $('modal-recheck').hidden = true;
    $('modal-commit').hidden = true;
    $('modal-deploy').hidden = true;
  }
}

// The progress screen names the job it is running. Creating a story,
// committing and deploying share this pane and take very different amounts of
// time; calling all three "Deploying" is how a slow create reads as a stuck
// deployment.
function showProgress(title, text) {
  showPane('progress');
  $('progress-record').hidden = true;
  $('progress-record').innerHTML = '';
  $('modal-title').textContent = title;
  $('progress-text').textContent = text;
}

const TASK_TITLES = {
  create: 'Creating user story',
  commit: 'Committing components',
  deploy: 'Deploying',
};

function wireModal() {
  // Closing stops any running watcher: its polling has nowhere to render, and
  // reopening starts a fresh one.
  const close = () => {
    stopWatching();
    stopEarlyWatch();
    $('modal').classList.remove('show');
  };

  $('modal-close').addEventListener('click', close);
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) close();
  });

  $('modal-back').addEventListener('click', () => {
    showPane(currentPane === 'prompt' ? 'stories' : 'review');
  });
  $('modal-create').addEventListener('click', onConfirm);
  $('modal-recheck').addEventListener('click', recheckOutcome);
  $('modal-commit').addEventListener('click', commitCreatedStory);
  $('modal-deploy').addEventListener('click', deployStory);
  $('modal-yes').addEventListener('click', answerYes);
  $('modal-no').addEventListener('click', answerNo);

  $('prompt-action').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    promptAction = btn.dataset.action;
    refreshPromptAction();
  });

  $('modal-next').addEventListener('click', () => {
    if (currentPane === 'stories') return showPromptPane();
    return showStoryPicker();
  });

  $('story-new').addEventListener('click', toggleNewStoryForm);
  $('story-search').addEventListener('input', renderStories);
}

/* ------------------------------------------------- connection banners */

/*
 * Two connections, both required, both stated at the top.
 *
 * The source org is the Salesforce tab being browsed; the Copado org is where
 * user stories live. Without either one nothing downstream works, and finding
 * that out three screens later — in a modal, next to a component list that took
 * a minute to assemble — is the failure worth avoiding. So a missing connection
 * is red, at the top, before anything is picked.
 */
/*
 * The word, not just the colour. A green dot alone asks the reader to know the
 * convention; CONNECTED next to it does not, and it is what a screenshot of a
 * problem needs to carry.
 */
const CONN_TONES = { connected: 'ok', checking: 'wait' };

function setConnState(id, state) {
  const node = $(id);
  node.textContent = state.toUpperCase();
  node.className = `conn-state ${CONN_TONES[state] || 'bad'}`;
}

function setSourceBanner(error) {
  const row = $('conn-source');
  const dot = $('source-dot');
  const text = $('source-text');

  row.classList.toggle('bad', Boolean(error));
  dot.classList.toggle('live', !error);

  if (error) {
    setConnState('source-state', 'disconnected');
    text.textContent = `Source org: ${error}`;
    return;
  }

  setConnState('source-state', 'connected');
  text.textContent = `Source org: ${new URL(session.instanceUrl).hostname}`;
}

/*
 * The story picker reads its list out of the Copado org, so without a live
 * session there is nothing for this button to open.
 *
 * Still not gated on the metadata selection: browsing stories, and promoting
 * one, have nothing to do with which components are ticked. This gates on the
 * one connection it cannot work without.
 *
 * The reason goes in the title rather than being left to the banner above,
 * because a button that does nothing on click explains itself to nobody.
 */
function setStoriesEnabled(reason) {
  const btn = $('stories-btn');
  btn.disabled = Boolean(reason);
  btn.title = reason || 'Browse Copado user stories';
}

async function refreshCopadoBanner() {
  const row = $('conn-copado');
  const dot = $('target-dot');
  const text = $('target-text');

  const orgs = await SfOrgs.all();
  const connected = orgs.find((o) => o.accessToken);

  dot.classList.remove('live');

  if (!connected) {
    row.classList.add('bad');
    setConnState('target-state', 'disconnected');
    text.textContent = orgs.length
      ? `Copado org: ${orgs[0].alias} — not connected, connect it in settings`
      : 'Copado org: not connected — connect one in settings';
    setStoriesEnabled('Connect the Copado org in settings to browse user stories.');
    return;
  }

  // The green dot has to mean the org answered just now, not that a token
  // string survived in storage. Committing into an expired session otherwise
  // fails at the worst moment.
  row.classList.remove('bad');
  setConnState('target-state', 'checking');
  text.textContent = `Copado org: checking ${connected.alias}…`;

  // Held shut for the length of the check. Opening the picker against a session
  // that has not answered yet is how a story list arrives empty for a reason
  // the screen cannot state.
  setStoriesEnabled('Checking the Copado org…');

  const result = await SfSession.verify(connected);
  if (result.renewed) await SfOrgs.update(connected.id, result.renewed);

  if (result.ok) {
    dot.classList.add('live');
    setConnState('target-state', 'connected');
    // Only a real org name earns the suffix. Salesforce hands back a
    // placeholder for an unset one, and a bare alias reads better than a
    // dash trailing into a URL or a login address.
    const who = result.details?.Name;
    text.textContent = who
      ? `Copado org: ${connected.alias} — ${who}`
      : `Copado org: ${connected.alias}`;
    setStoriesEnabled(null);
  } else {
    row.classList.add('bad');
    setConnState('target-state', 'disconnected');
    text.textContent = `Copado org: ${connected.alias} — session expired, reconnect in settings`;
    setStoriesEnabled('The Copado org session expired — reconnect it in settings.');
  }
}

/*
 * Copado AI is the third connection, and the one that actually does the work.
 * A missing key is not discovered until the story picker refuses to advance,
 * two screens in, so it is said here with the other two.
 *
 * The key is checked against the service rather than merely being present: a
 * revoked or mistyped key looks identical in storage, and the difference only
 * shows on a call. Listing workspaces is that call — it reads nothing and
 * spends no message allowance.
 */
async function refreshAiBanner() {
  const row = $('conn-ai');
  const dot = $('ai-dot');
  const text = $('ai-text');

  dot.classList.remove('live');

  const settings = await CopadoAI.load();

  if (!settings.apiKey || !settings.organizationId) {
    row.classList.add('bad');
    setConnState('ai-state', 'disconnected');
    text.textContent = settings.apiKey
      ? 'Copado AI: no organization id — add one in settings'
      : 'Copado AI: not configured — add the key and organization id in settings';
    return;
  }

  row.classList.remove('bad');
  setConnState('ai-state', 'checking');
  text.textContent = `Copado AI: checking org ${settings.organizationId}…`;

  const result = await CopadoAI.verify();

  if (result.ok) {
    dot.classList.add('live');
    setConnState('ai-state', 'connected');
    text.textContent = `Copado AI: org ${settings.organizationId}`;
    text.title = '';
    return;
  }

  row.classList.add('bad');
  setConnState('ai-state', 'disconnected');

  // One line in a one-line row. The rest of what the service said is worth
  // keeping, so it goes in the tooltip rather than being thrown away.
  const reason = (result.reason || '').split('\n').map((l) => l.trim()).filter(Boolean);
  text.textContent = `Copado AI: ${reason[0] || 'not reachable'}`;
  text.title = reason.join('\n');
}

/* ----------------------------------------------------------- helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function checkbox(checked) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  return box;
}

const msg = (text) => el('div', 'msg', text);
const warn = (text) => el('div', 'warn', text);
const errorBox = (text) => el('div', 'msg error', text);
