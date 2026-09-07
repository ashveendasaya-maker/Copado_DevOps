'use strict';

/*
 * Writing user stories into a connected Copado org.
 *
 * Copado is a managed package, so its object and field API names cannot be
 * verified from outside the org. Rather than hardcoding names from memory, this
 * describes the objects at runtime and resolves each field from a candidate
 * list. A Copado org that names things differently degrades to a clear message
 * instead of a confusing write failure.
 *
 * Scope stops at the record. Triggering Copado's commit engine means creating
 * the internal records its async jobs watch, which is undocumented and writes
 * to a real git repository; the extension links to the story instead and lets
 * the user press Commit in Copado.
 */

const Copado = (() => {

  const USER_STORY = 'copado__User_Story__c';
  const STORY_METADATA = 'copado__User_Story_Metadata__c';

  // What a commit actually produces. Newer Copado writes the selection to git
  // and records it here; User_Story_Metadata__c is the older "selected
  // metadata" object and stays empty on those versions. Checking only the
  // latter reports a real commit as having done nothing.
  const STORY_COMMIT = 'copado__User_Story_Commit__c';

  // Where Copado records a job it ran, and the error it stopped on.
  const JOB_EXECUTION = 'copado__JobExecution__c';

  // Used to explain where a story has already been. All optional: an org
  // without them loses the promotion history and keeps everything else.
  const ORG_CREDENTIAL = 'copado__Org__c';
  const PROMOTION = 'copado__Promotion__c';
  const PROMOTED_STORY = 'copado__Promoted_User_Story__c';

  // sObject Collections takes 200 records per subrequest, and a composite
  // request takes 25 subrequests. One is spent on the story itself.
  const RECORDS_PER_SUBREQUEST = 200;
  const MAX_METADATA_SUBREQUESTS = 24;

  // First name that exists in the org's describe wins. Ordered most to least
  // likely so a match is usually the first probe.
  const FIELDS = {
    title:       ['copado__User_Story_Title__c', 'copado__Title__c'],
    project:     ['copado__Project__c'],
    sprint:      ['copado__Sprint__c'],
    environment: ['copado__Environment__c'],
    status:      ['copado__Status__c'],
    metaName:    ['copado__Metadata_API_Name__c', 'copado__API_Name__c', 'Name'],
    metaType:    ['copado__Type__c', 'copado__Metadata_Type__c'],
    metaStory:   ['copado__User_Story__c'],
    credential:  ['copado__Org_Credential__c'],
  };

  // Resolved on demand rather than in schema(): nothing needs a commit record
  // until a commit has been asked for.
  const COMMIT_FIELDS = {
    story:   ['copado__User_Story__c'],
    commit:  ['copado__Commit_Id__c', 'copado__Commit__c', 'copado__Snapshot_Commit__c'],
    status:  ['copado__Status__c'],
    message: ['copado__Commit_Message__c', 'copado__Message__c', 'copado__Description__c'],
    when:    ['copado__Commit_Date__c', 'copado__Date__c'],
  };

  // The Salesforce org id lives under different names across Copado versions,
  // and it is the only thing that reliably ties a browsed org to a credential.
  const PIPELINE_FIELDS = {
    credOrgId:   ['copado__Org_ID__c', 'copado__SFDC_Org_ID__c', 'copado__Organization_ID__c'],
    credEnv:     ['copado__Environment__c'],
    promStory:   ['copado__User_Story__c'],
    promLink:    ['copado__Promotion__c'],
    promSource:  ['copado__Source_Environment__c'],
    promDest:    ['copado__Destination_Environment__c'],
    promStatus:  ['copado__Status__c'],
  };

  const LOOKUPS = [
    { key: 'projects',     sobject: 'copado__Project__c' },
    { key: 'sprints',      sobject: 'copado__Sprint__c' },
    { key: 'environments', sobject: 'copado__Environment__c' },
  ];

  const describeCache = new Map();

  /* --------------------------------------------------------------- fetch */

  // Every call resolves the connection first, so a session that expired
  // between opening the popup and pressing Create is renewed rather than
  // failing the write.
  async function connection() {
    const org = await SfOrgs.activeToken();
    if (!org) throw new Error('No Copado org connected. Connect one in settings.');
    return org;
  }

  async function call(org, path, init = {}) {
    const res = await fetch(`${org.instanceUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${org.accessToken}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      // Salesforce's own wording, not the status line. The request goes to the
      // console for a bug report; what reaches the screen is readable.
      console.error(`Copado org: ${path} — ${res.status} ${res.statusText}`, body);
      throw new Error(salesforceError(body)
        || `The Copado org refused the request (${res.status}).`);
    }
    return body;
  }

  // Salesforce returns errors as an array of {message, errorCode} often enough
  // that the raw JSON is worth unwrapping before it reaches a user.
  function salesforceError(body) {
    if (!body) return null;
    const list = Array.isArray(body) ? body : [body];
    return list.map((e) => e.message).filter(Boolean).join('\n') || null;
  }

  async function version(org) {
    const versions = await call(org, '/services/data/').catch(() => null);
    const last = versions?.[versions.length - 1];
    return last?.version ? `v${last.version}` : 'v66.0';
  }

  const data = (org, v, path) => call(org, `/services/data/${v}${path}`);

  // Returns why it failed, not just that it did. A missing object, a profile
  // without read access and an expired session all produce an empty describe,
  // and they need entirely different fixes.
  async function describe(org, v, sobject) {
    const key = `${org.instanceUrl}:${sobject}`;
    if (describeCache.has(key)) return describeCache.get(key);

    let result;
    try {
      const body = await data(org, v, `/sobjects/${sobject}/describe`);

      // childRelationships is the org telling us exactly which objects point at
      // this one and through which field. It removes the guessing from every
      // "what is related to this record" question below.
      result = { ok: true, fields: body.fields, children: body.childRelationships || [] };
    } catch (err) {
      result = { ok: false, reason: err.message };
    }

    describeCache.set(key, result);
    return result;
  }

  // Everything in the org whose name looks Copado-ish. When the expected object
  // is missing this is the difference between a dead end and an answer: it
  // shows whether the package is absent, differently namespaced, or whether the
  // wrong org is connected.
  async function relatedObjects(org, v) {
    const body = await data(org, v, '/sobjects').catch(() => null);
    if (!body) return null;

    return (body.sobjects || [])
      .map((s) => s.name)
      .filter((n) => /copado|user_?story/i.test(n))
      .sort();
  }

  /* -------------------------------------------------------------- schema */

  // Resolves the field names this org actually uses before anything is written,
  // so a mismatch surfaces as a named problem rather than a rejected insert.
  async function schema(org, v) {
    const [story, meta] = await Promise.all([
      describe(org, v, USER_STORY),
      describe(org, v, STORY_METADATA),
    ]);

    const problems = [];
    if (!story.ok) problems.push(`${USER_STORY} — ${story.reason}`);

    const resolved = { story: {}, meta: {} };

    if (story.ok) {
      const names = new Set(story.fields.map((f) => f.name));
      for (const key of ['title', 'project', 'sprint', 'environment', 'status', 'credential']) {
        resolved.story[key] = FIELDS[key].find((n) => names.has(n)) || null;
      }
      if (!resolved.story.title) {
        problems.push(`No user story title field found on ${USER_STORY}.`);
      }
      // Kept for createUserStory, which still writes a status when one is
      // passed. Nothing in the UI offers the choice any more: a new story takes
      // Copado's own default, which the pipeline would set regardless.
      resolved.statusValues = pickPicklist(story, resolved.story.status);
      resolved.required = story.fields
        .filter((f) => f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean')
        .map((f) => f.name);

      // Taken from the describe rather than swapping __c for __r: the guess
      // holds for custom lookups but breaks on anything standard or renamed.
      resolved.rel = {};
      for (const key of ['project', 'sprint', 'environment']) {
        const name = resolved.story[key];
        resolved.rel[key] = name
          ? story.fields.find((f) => f.name === name)?.relationshipName || null
          : null;
      }
    }

    // Attaching components is optional: the story is still worth creating in an
    // org where this object is absent or unreadable.
    if (meta.ok) {
      const names = new Set(meta.fields.map((f) => f.name));
      for (const key of ['metaName', 'metaType', 'metaStory']) {
        resolved.meta[key] = FIELDS[key].find((n) => names.has(n)) || null;
      }
      if (!resolved.meta.metaStory) {
        problems.push(`No user story lookup found on ${STORY_METADATA}; components cannot be attached.`);
      }
    } else {
      problems.push(`${STORY_METADATA} — ${meta.reason}`);
    }

    // Only worth the extra round trip when something is already wrong.
    if (!story.ok || !meta.ok) {
      const found = await relatedObjects(org, v);
      if (found === null) {
        problems.push('Could not list the objects in this org to check what is installed.');
      } else if (!found.length) {
        problems.push(
          'No Copado objects exist in this org at all. The connection is probably ' +
          'pointing at the wrong org — check which one is connected as the Copado org in settings.'
        );
      } else {
        problems.push(`Copado-like objects that do exist here: ${found.slice(0, 12).join(', ')}` +
          (found.length > 12 ? `, and ${found.length - 12} more.` : ''));
      }
    }

    return {
      ...resolved,
      // Flags rather than string-matching the problem list: the diagnostics
      // above mention object names too, and a caller grepping for one would
      // read its own hint as a failure.
      canCreate: Boolean(story.ok && resolved.story.title),
      canAttach: Boolean(meta.ok && resolved.meta.metaStory),
      problems,
    };
  }

  function pickPicklist(describeResult, fieldName) {
    if (!fieldName) return [];
    const field = describeResult.fields.find((f) => f.name === fieldName);
    return (field?.picklistValues || []).filter((v) => v.active).map((v) => v.value);
  }

  /* ------------------------------------------------------------- options */

  // Lookup targets for the confirm screen. Each is fetched independently so an
  // org without sprints, or a user without read access to one object, still
  // gets the others.
  async function options(org, v) {
    const result = {};

    await Promise.all(LOOKUPS.map(async ({ key, sobject }) => {
      const soql = `SELECT Id, Name FROM ${sobject} ORDER BY Name LIMIT 200`;
      const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);
      result[key] = body?.records?.map((r) => ({ id: r.Id, name: r.Name })) || [];
    }));

    return result;
  }

  /* ------------------------------------------------------------- stories */

  // Existing stories, newest first, so components can be attached to work
  // already in flight instead of always opening a new one.
  async function listStories(org, v, resolved, limit = 200) {
    if (!resolved.story.title) return [];

    const { title, status } = resolved.story;
    const rel = resolved.rel || {};

    const columns = ['Id', 'Name', title, 'LastModifiedDate'];
    if (status) columns.push(status);
    if (resolved.story.environment) columns.push(resolved.story.environment);
    if (resolved.story.credential) columns.push(resolved.story.credential);
    if (rel.project) columns.push(`${rel.project}.Name`);
    if (rel.sprint) columns.push(`${rel.sprint}.Name`);
    if (rel.environment) columns.push(`${rel.environment}.Name`);

    const soql =
      `SELECT ${columns.join(', ')} FROM ${USER_STORY} ` +
      `ORDER BY LastModifiedDate DESC LIMIT ${limit}`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`);

    return (body.records || []).map((r) => ({
      id: r.Id,
      name: r.Name,
      title: r[title] || '',
      status: status ? r[status] || '' : '',
      project: rel.project ? r[rel.project]?.Name || '' : '',
      sprint: rel.sprint ? r[rel.sprint]?.Name || '' : '',
      // The environment a story belongs to is what decides whether the org
      // currently being browsed is a valid source for it.
      environmentId: resolved.story.environment ? r[resolved.story.environment] || null : null,
      environment: rel.environment ? r[rel.environment]?.Name || '' : '',
      credentialId: resolved.story.credential ? r[resolved.story.credential] || null : null,
      lastModified: r.LastModifiedDate,
    }));
  }

  /* ------------------------------------------------------------ pipeline */

  // Resolved once, lazily, and only when a row is expanded — nothing in the
  // main flow needs it, and it is three describes.
  let pipelineCache = null;

  async function pipelineSchema(org, v) {
    if (pipelineCache) return pipelineCache;

    const [cred, junction, promotion] = await Promise.all([
      describe(org, v, ORG_CREDENTIAL),
      describe(org, v, PROMOTED_STORY),
      describe(org, v, PROMOTION),
    ]);

    const pick = (result, key) => {
      if (!result.ok) return null;
      const names = new Set(result.fields.map((f) => f.name));
      return PIPELINE_FIELDS[key].find((n) => names.has(n)) || null;
    };

    const relOf = (result, fieldName) => {
      if (!result.ok || !fieldName) return null;
      return result.fields.find((f) => f.name === fieldName)?.relationshipName || null;
    };

    const promSource = pick(promotion, 'promSource');
    const promDest = pick(promotion, 'promDest');
    const promLink = pick(junction, 'promLink');

    pipelineCache = {
      credentials: cred.ok,
      credOrgId: pick(cred, 'credOrgId'),
      credEnv: pick(cred, 'credEnv'),
      credEnvRel: relOf(cred, pick(cred, 'credEnv')),

      promotions: junction.ok && promotion.ok,
      promStory: pick(junction, 'promStory'),
      promLink,
      promLinkRel: relOf(junction, promLink),
      promSource,
      promDest,
      promStatus: pick(promotion, 'promStatus'),
      promSourceRel: relOf(promotion, promSource),
      promDestRel: relOf(promotion, promDest),
    };

    return pipelineCache;
  }

  // Which Copado credential and environment correspond to the Salesforce org
  // being browsed. Without this there is no way to tell that a story belongs
  // somewhere else until Copado rejects the request.
  async function sourceEnvironment(org, v, salesforceOrgId) {
    if (!salesforceOrgId) return null;

    const p = await pipelineSchema(org, v);
    if (!p.credentials || !p.credOrgId) return null;

    // Copado stores 15- or 18-character ids depending on how the credential was
    // created, so both forms are matched.
    const short = salesforceOrgId.slice(0, 15);
    const columns = ['Id', 'Name', p.credEnv, p.credEnvRel && `${p.credEnvRel}.Name`].filter(Boolean);

    const soql =
      `SELECT ${columns.join(', ')} FROM ${ORG_CREDENTIAL} ` +
      `WHERE ${p.credOrgId} LIKE '${short}%' LIMIT 1`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);
    const record = body?.records?.[0];
    if (!record) return null;

    return {
      credentialId: record.Id,
      credentialName: record.Name,
      environmentId: p.credEnv ? record[p.credEnv] : null,
      environmentName: p.credEnvRel ? record[p.credEnvRel]?.Name || null : null,
    };
  }

  // Where a story has already been promoted. Returns null when the objects are
  // absent, which is reported as unavailable rather than as "never promoted".
  async function promotionsFor(org, v, storyId) {
    const p = await pipelineSchema(org, v);
    if (!p.promotions || !p.promStory || !p.promLinkRel) return null;

    // The lookup itself, not just the relationship: it holds the promotion's
    // own id, which is what a link to the record needs. The junction's Id
    // points at the junction, which is not a record anyone wants to open.
    const columns = ['Id', 'CreatedDate', p.promLink];
    if (p.promSourceRel) columns.push(`${p.promLinkRel}.${p.promSourceRel}.Name`);
    if (p.promDestRel) columns.push(`${p.promLinkRel}.${p.promDestRel}.Name`);
    if (p.promStatus) columns.push(`${p.promLinkRel}.${p.promStatus}`);
    columns.push(`${p.promLinkRel}.Name`);

    const soql =
      `SELECT ${columns.join(', ')} FROM ${PROMOTED_STORY} ` +
      `WHERE ${p.promStory} = '${storyId}' ORDER BY CreatedDate DESC LIMIT 50`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`);

    return (body.records || []).map((r) => {
      const promotion = r[p.promLinkRel] || {};
      return {
        id: r[p.promLink] || null,
        name: promotion.Name || '',
        from: p.promSourceRel ? promotion[p.promSourceRel]?.Name || '' : '',
        to: p.promDestRel ? promotion[p.promDestRel]?.Name || '' : '',
        status: p.promStatus ? promotion[p.promStatus] || '' : '',
        when: r.CreatedDate,
      };
    });
  }

  // What is already attached to one story. Fetched per story on expand rather
  // than for the whole list up front: the list runs to 200, and an IN clause
  // over that many ids makes a query string long enough to be refused.
  async function storyMetadata(org, v, resolved, storyId) {
    if (!resolved.canAttach) return null;

    const { metaStory, metaName, metaType } = resolved.meta;
    const columns = ['Id', metaName, metaType].filter(Boolean);

    const soql =
      `SELECT ${columns.join(', ')} FROM ${STORY_METADATA} ` +
      `WHERE ${metaStory} = '${storyId}' ORDER BY ${metaName || 'Id'} LIMIT 500`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`);

    return (body.records || []).map((r) => ({
      name: metaName ? r[metaName] : r.Id,
      type: metaType ? r[metaType] || '' : '',
    }));
  }

  /*
   * The commit records against one story, newest first.
   *
   * This is the evidence that a commit happened. Copado AI reports success and
   * moves on to a promotion, and the only way to tell a real commit from a
   * described one is that Copado wrote a record for it.
   *
   * Returns null — not an empty list — when the object is missing or
   * unreadable, so "this org does not track commits here" stays
   * distinguishable from "nothing was committed".
   */
  // Which of the candidate names this org actually uses on the commit object.
  // null when the object is missing or unreadable, which is not the same as
  // there being no commits.
  async function commitFields(org, v) {
    const described = await describe(org, v, STORY_COMMIT);
    if (!described.ok) return null;

    const names = new Set(described.fields.map((f) => f.name));
    const field = {};
    for (const [key, candidates] of Object.entries(COMMIT_FIELDS)) {
      field[key] = candidates.find((n) => names.has(n)) || null;
    }
    return field.story ? field : null;
  }

  const commitColumns = (field) => ['Id', 'Name', 'CreatedDate',
    field.story, field.commit, field.status, field.message, field.when].filter(Boolean);

  const toCommit = (r, field) => ({
    id: r.Id,
    storyId: field.story ? r[field.story] : null,
    // The commit hash is the most identifying thing when it is there; the
    // record name is what Copado's own UI shows when it is not.
    name: (field.commit && r[field.commit]) || r.Name,
    status: (field.status && r[field.status]) || '',
    message: (field.message && r[field.message]) || '',
    when: (field.when && r[field.when]) || r.CreatedDate,
  });

  async function commitsFor(org, v, storyId) {
    const field = await commitFields(org, v);
    if (!field) return null;

    const soql =
      `SELECT ${commitColumns(field).join(', ')} FROM ${STORY_COMMIT} ` +
      `WHERE ${field.story} = '${storyId}' ORDER BY CreatedDate DESC LIMIT 20`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);
    if (!body) return null;

    return (body.records || []).map((r) => toCommit(r, field));
  }

  /*
   * The newest commit against each of many stories, in one pass.
   *
   * The story list shows what is happening to each story, and a query per row
   * would be a hundred round trips. Ids are chunked because an IN clause over a
   * whole list makes a query string long enough for Salesforce to refuse.
   */
  async function latestCommits(org, v, storyIds) {
    const field = await commitFields(org, v);
    if (!field || !storyIds.length) return null;

    const latest = new Map();

    for (const group of chunk(storyIds, 80)) {
      const ids = group.map((id) => `'${id}'`).join(',');
      const soql =
        `SELECT ${commitColumns(field).join(', ')} FROM ${STORY_COMMIT} ` +
        `WHERE ${field.story} IN (${ids}) ORDER BY CreatedDate DESC LIMIT 1000`;

      const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);

      // Newest first, so the first one seen for a story is the one to keep.
      for (const r of body?.records || []) {
        const commit = toCommit(r, field);
        if (commit.storyId && !latest.has(commit.storyId)) latest.set(commit.storyId, commit);
      }
    }

    return latest;
  }

  /*
   * Finds a story by its exact title.
   *
   * No longer how a create is confirmed: a title match cannot tell a story just
   * made from one that already carried that title, so the caller compares
   * against the ids it saw beforehand instead. Kept because looking a story up
   * by title is still a correct thing to want.
   */
  async function findByTitle(org, v, resolved, title) {
    if (!resolved.story.title || !title) return null;

    const escaped = title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const soql =
      `SELECT Id, Name, ${resolved.story.title} FROM ${USER_STORY} ` +
      `WHERE ${resolved.story.title} = '${escaped}' ORDER BY CreatedDate DESC LIMIT 1`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);
    const record = body?.records?.[0];

    if (record) {
      return { id: record.Id, name: record.Name, title: record[resolved.story.title] || title };
    }
    return findRecentByTitle(org, v, resolved, title);
  }

  /*
   * Copado rarely stores the title byte-for-byte as it was typed: it trims,
   * re-cases, or drops a trailing full stop. An `=` match misses every one of
   * those and reports a story that plainly exists as missing — which is what
   * leaves the Commit button hidden after a successful create.
   *
   * So the newest stories are pulled and compared with case and punctuation
   * flattened. Only the recent ones: this runs right after a create, and an
   * older story with a similar title is not the one just made.
   */
  async function findRecentByTitle(org, v, resolved, title) {
    const records = await recentStories(org, v, resolved, 25);
    const want = flatten(title);
    if (!want) return null;

    // Exact once flattened, and nothing looser. A containment match here reads
    // an existing story as the one just made — "Test" sits inside almost any
    // title — and reporting someone else's story as yours is worse than
    // reporting nothing. Recognising a reworded title is the caller's job,
    // because only the caller knows which stories are new.
    return records.find((r) => flatten(r.title) === want) || null;
  }

  /*
   * Everything the org can show about a deployment in flight.
   *
   * A promotion is not the only shape this takes. Depending on the pipeline and
   * the Copado version, deploying a story writes a Promotion, a Deployment, a
   * Job Execution, or several — so watching only promotions reports a
   * successful deployment as nothing at all.
   *
   * `readable` matters as much as the records themselves: an org where none of
   * these objects can be read is a different answer from one where nothing has
   * happened yet, and collapsing the two is how "deployed fine" becomes
   * "nothing was deployed".
   */
  const ACTIVITY_SOURCES = [
    { object: 'copado__Deployment__c', label: 'Deployment',
      story: ['copado__User_Story__c'],
      status: ['copado__Status__c'] },

    { object: 'copado__JobExecution__c', label: 'Job',
      story: ['copado__UserStory__c', 'copado__User_Story__c'],
      status: ['copado__Status__c'] },
  ];

  async function activityFor(org, v, storyId) {
    const items = [];
    let readable = false;

    const promotions = await promotionsFor(org, v, storyId).catch(() => null);
    if (promotions) {
      readable = true;
      for (const p of promotions) {
        items.push({
          id: p.id,
          kind: 'promotion',
          name: p.name || '',
          label: `Promotion ${p.name || ''} · ${p.from || '?'} → ${p.to || '?'}`.replace('  ', ' '),
          status: p.status,
          when: p.when,
        });
      }
    }

    for (const source of ACTIVITY_SOURCES) {
      const described = await describe(org, v, source.object);
      if (!described.ok) continue;

      const names = new Set(described.fields.map((f) => f.name));
      const storyField = source.story.find((n) => names.has(n));
      if (!storyField) continue;

      readable = true;
      const statusField = source.status.find((n) => names.has(n));
      const columns = ['Id', 'Name', 'CreatedDate', statusField].filter(Boolean);

      const soql =
        `SELECT ${columns.join(', ')} FROM ${source.object} ` +
        `WHERE ${storyField} = '${storyId}' ORDER BY CreatedDate DESC LIMIT 10`;

      const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);

      for (const r of body?.records || []) {
        items.push({
          id: r.Id,
          kind: source.object,
          name: r.Name,
          label: `${source.label} ${r.Name}`,
          status: statusField ? r[statusField] || '' : '',
          when: r.CreatedDate,
        });
      }
    }

    items.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    return { readable, items };
  }

  /*
   * Where Copado writes the reason a job failed.
   *
   * "Completed with error" is a status, not an explanation, and the explanation
   * is what the user has to act on — which component, which field, which line.
   * Copado keeps it in a different object depending on version and on which
   * engine ran the job, so each candidate is described at runtime and the first
   * that exists and links to this story is used.
   *
   * Ordered newest engine first: an org with both should report from the one
   * that actually ran the deployment.
   */
/*
 * The reason a deployment failed, read from the job that ran it.
 *
 * The job is found through its Context field, not through a lookup. Copado
 * leaves copado__Promotion__c empty on a job execution and records the link as
 * markup instead — copado__Context__c holds
 *
 *     <a href="/a17hm00000XQX2E" target="_self">Promotion: P00012</a>
 *
 * so the association is a 15-character record id inside an HTML string. Every
 * lookup-based search returns nothing while the row sits there plainly linked,
 * which is what three rounds of guessing kept running into.
 *
 * Ids are compared on their first 15 characters: the markup carries the short
 * form and a query returns the long one.
 */
  const ERROR_FIELD = /error|failure|message|detail/i;
  const CONTEXT_FIELD = /context|parent|related|link/i;
  const JOB_OBJECT = /job|execution|step|result|deploy|log/i;

  // Salesforce generates a companion object per custom object: a change event
  // stream, a sharing table, a history table. They carry the same name and none
  // of the data, and they sort ahead of the real object because an uppercase
  // letter sorts before a lowercase one — so they were being searched first and
  // eating the budget.
  const NOISE_OBJECT = /__(ChangeEvent|Share|History|Feed|Tag|ViewStat|VoteStat)$/;

  const shortId = (id) => (id || '').slice(0, 15);

  // A summary record can mention a failure that a step describes properly, so
  // the job that ran is asked first.
  function jobRank(name) {
    const n = name.toLowerCase();
    if (n.includes('jobexecution') || n.includes('job_execution')) return 0;
    if (n.includes('jobstep') || n.includes('job_step')) return 1;
    if (n.includes('result')) return 2;
    return 3;
  }

  const errorFieldsOf = (described) => described.fields
    .filter((f) => ERROR_FIELD.test(f.name)
      && (f.type === 'textarea' || f.type === 'string'))
    .map((f) => f.name);

  const isText = (f) => f.type === 'string' || f.type === 'textarea' || f.type === 'url';

  const contextFieldsOf = (described) => described.fields
    .filter((f) => CONTEXT_FIELD.test(f.name) && isText(f))
    .map((f) => f.name);

  /*
   * The deployment error, straight from the job execution.
   *
   *   SELECT Id, copado__Status__c, copado__Context__c, copado__ErrorMessage__c
   *   FROM copado__JobExecution__c
   *   WHERE copado__Context__c LIKE '%a17hm00000XQX2E%'
   *
   * Context holds the link as markup — <a href="/a17hm00000XQX2E">Promotion:
   * P00012</a> — with copado__Promotion__c left empty beside it, so the id has
   * to be matched inside the string. It is filterable, which an earlier version
   * of this file wrongly assumed it was not.
   *
   * The id is matched on its first 15 characters: the markup carries the short
   * form, a query returns the long one.
   *
   * Status is not constrained. The user's own query used Status = 'Error', but
   * a failed job is also written as 'Failed' or 'Completed with error' depending
   * on where it stopped, and a message is a message.
   */
  async function jobExecutionError(org, v, ids, probed) {
    const described = await describe(org, v, JOB_EXECUTION);
    if (!described.ok) return null;

    const names = new Set(described.fields.map((f) => f.name));
    const has = (n) => names.has(n);
    if (!has('copado__Context__c') || !has('copado__ErrorMessage__c')) return null;

    const columns = ['Id', 'copado__Context__c', 'copado__ErrorMessage__c',
      has('copado__Status__c') && 'copado__Status__c'].filter(Boolean);

    for (const id of ids) {
      const short = shortId(id);
      if (!short) continue;

      const rows = await rowsOf(org, v,
        `SELECT ${columns.join(', ')} FROM ${JOB_EXECUTION} `
        + `WHERE copado__Context__c LIKE '%${short}%' `
        + 'ORDER BY CreatedDate DESC LIMIT 10', probed);

      const hit = rows.find((r) => (r.copado__ErrorMessage__c || '').trim());
      if (hit) {
        return {
          id: hit.Id,
          object: JOB_EXECUTION,
          status: hit.copado__Status__c || '',
          message: hit.copado__ErrorMessage__c.trim(),
        };
      }
    }
    return null;
  }

  async function failureFor(org, v, storyId) {
    const promotions = await promotionsFor(org, v, storyId).catch(() => null);

    // The promotion is what a deployment runs against, so it leads.
    const ids = [...(promotions || []).map((p) => p.id).filter(Boolean), storyId];

    // The ids are half the answer when nothing is found: a promotion missing
    // from this list means the search never had a chance.
    const probed = [`looked for: ${ids.map(shortId).join(', ') || 'nothing'}`];

    // The query that is known to answer this, tried first and written out
    // plainly. Everything below it is inference about an org this code cannot
    // see; this is the one shape confirmed against a real one.
    const known = await jobExecutionError(org, v, ids, probed);
    if (known) return known;

    const all = await relatedObjects(org, v);
    const objects = (all || [])
      .filter((n) => JOB_OBJECT.test(n) && !NOISE_OBJECT.test(n))
      .sort((a, b) => jobRank(a) - jobRank(b))
      .slice(0, 6);

    // Every job record tied to this promotion, however it is tied.
    const jobs = [];

    for (const objectName of objects) {
      const described = await describe(org, v, objectName);
      if (!described.ok) { probed.push(`${objectName}: not readable`); continue; }

      const errorFields = errorFieldsOf(described);
      const contextFields = contextFieldsOf(described);
      const lookupFields = described.fields
        .filter((f) => f.type === 'reference'
          && (f.referenceTo || []).some((r) => r === PROMOTION || r === USER_STORY))
        .map((f) => f.name);

      probed.push(`${objectName}: errors=[${errorFields}] context=[${contextFields}] lookups=[${lookupFields}]`);
      if (!errorFields.length && !contextFields.length) continue;

      const found = await jobsFor(org, v, objectName, described, {
        ids, errorFields, contextFields, lookupFields, probed,
      });
      jobs.push(...found);

      const message = found.map((r) => r.message).find(Boolean);
      if (message) {
        const record = found.find((r) => r.message);
        return { id: record.id, object: objectName, status: record.status, message };
      }
    }

    // The jobs were found but none carries the text: it is on their steps.
    if (jobs.length) {
      const stepIds = jobs.map((j) => j.id);
      for (const objectName of objects) {
        const described = await describe(org, v, objectName);
        if (!described.ok) continue;

        const errorFields = errorFieldsOf(described);
        const parentFields = described.fields
          .filter((f) => f.type === 'reference'
            && (f.referenceTo || []).some((r) => objects.includes(r)))
          .map((f) => f.name);
        if (!errorFields.length || !parentFields.length) continue;

        for (const field of parentFields.slice(0, 3)) {
          const record = await newestWithError(org, v, objectName, described, errorFields,
            `${field} IN (${stepIds.map((id) => `'${id}'`).join(',')})`, probed);
          if (record) return record;
        }
      }
    }

    console.debug('Copado: no failure text found', probed);
    return { notFound: true, probed };
  }

  /*
   * The job records tied to these ids.
   *
   * One query, matched in here rather than by the database. LIKE is not used:
   * the field holding the link is usually a formula or rich text, SOQL refuses
   * LIKE on both, and a refused query is indistinguishable from an empty one.
   *
   * The SELECT is kept to the few columns actually needed. One field the
   * connected user cannot read fails the whole statement, and a wide SELECT
   * turns a readable error into no result at all.
   */
  async function jobsFor(org, v, objectName, described, opts) {
    const { ids, errorFields, contextFields, lookupFields, probed } = opts;
    const shorts = ids.map(shortId).filter(Boolean);

    const statusField = described.fields.some((f) => f.name === 'copado__Status__c')
      ? 'copado__Status__c' : null;

    // A lookup that is populated answers precisely and cheaply, so it is worth
    // one attempt before falling back to reading recent rows.
    const errors = errorFields.slice(0, 2);
    const contexts = contextFields.slice(0, 3);
    const columns = ['Id', statusField, ...errors, ...contexts].filter(Boolean);
    const select = `SELECT ${[...new Set(columns)].join(', ')} FROM ${objectName}`;

    for (const field of lookupFields.slice(0, 2)) {
      const where = `${field} IN (${ids.map((id) => `'${id}'`).join(',')})`;
      const rows = await rowsOf(org, v,
        `${select} WHERE ${where} ORDER BY CreatedDate DESC LIMIT 25`, probed);

      const matched = pick(rows, shorts, contexts, errors, statusField);
      if (matched.length) return matched;
    }

    if (!contexts.length) return [];

    /*
     * Progressively narrower, because one unreadable column fails the whole
     * statement. Status is the first thing dropped — it is decoration here —
     * and the last attempt asks for nothing but the error and the link.
     */
    const attempts = [
      ['Id', statusField, ...errors, ...contexts],
      ['Id', ...errors, ...contexts],
      ['Id', errors[0], contexts[0]],
    ];

    for (const columnSet of attempts) {
      const cols = [...new Set(columnSet.filter(Boolean))];
      const rows = await rowsOf(org, v,
        `SELECT ${cols.join(', ')} FROM ${objectName} ORDER BY CreatedDate DESC LIMIT 200`, probed);
      if (!rows.length) continue;

      const matched = pick(rows, shorts,
        contexts.filter((f) => cols.includes(f)),
        errors.filter((f) => cols.includes(f)),
        cols.includes(statusField) ? statusField : null);

      if (matched.length) return matched;
    }
    return [];
  }

  async function rowsOf(org, v, soql, probed) {
    try {
      const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`);
      return body?.records || [];
    } catch (err) {
      probed?.push(`  query failed: ${err.message.split('\n')[0].slice(0, 120)}`);
      return [];
    }
  }

  function pick(rows, shorts, contextFields, errorFields, statusField) {
    const out = [];

    for (const r of rows) {
      // A row reached through a lookup is already ours; one reached through a
      // scan has to prove it carries the id.
      const context = contextFields.map((f) => r[f] || '').join(' ');
      const linked = !context || shorts.some((x) => context.includes(x));
      if (!linked) continue;

      out.push({
        id: r.Id,
        status: statusField ? r[statusField] || '' : '',
        message: errorFields.map((f) => (r[f] || '').trim()).find(Boolean) || '',
      });
    }
    return out;
  }

  async function newestWithError(org, v, objectName, described, errorFields, where, probed) {
    const statusField = described.fields.some((f) => f.name === 'copado__Status__c')
      ? 'copado__Status__c' : null;

    const columns = ['Id', 'Name', 'CreatedDate', statusField, ...errorFields].filter(Boolean);
    const rows = await rowsOf(org, v,
      `SELECT ${columns.join(', ')} FROM ${objectName} WHERE ${where} ORDER BY CreatedDate DESC LIMIT 25`,
      probed);

    for (const r of rows) {
      const message = errorFields.map((f) => (r[f] || '').trim()).find(Boolean);
      if (message) {
        return {
          id: r.Id,
          object: objectName,
          status: statusField ? r[statusField] || '' : '',
          message,
        };
      }
    }
    return null;
  }
  /*
   * The newest stories, id and title, newest first.
   *
   * Taken twice around a create: once before, to know what was already there,
   * and once after. Only a story absent from the first list can be the one just
   * created — which is the only reliable way to tell a new story from an old
   * one with a similar title, and does not depend on the org's clock.
   */
  async function recentStories(org, v, resolved, limit = 200) {
    const field = resolved.story.title;
    if (!field) return [];

    const soql =
      `SELECT Id, Name, ${field}, CreatedDate FROM ${USER_STORY} ` +
      `ORDER BY CreatedDate DESC LIMIT ${limit}`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);

    return (body?.records || []).map((r) => ({
      id: r.Id,
      name: r.Name,
      title: r[field] || '',
      createdAt: r.CreatedDate,
    }));
  }

  const flatten = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Same check when the agent named the story itself.
  async function findByName(org, v, name) {
    if (!name) return null;

    const escaped = name.replace(/'/g, "\\'");
    const soql = `SELECT Id, Name FROM ${USER_STORY} WHERE Name = '${escaped}' LIMIT 1`;

    const body = await data(org, v, `/query?q=${encodeURIComponent(soql)}`).catch(() => null);
    const record = body?.records?.[0];
    return record ? { id: record.Id, name: record.Name } : null;
  }

  /* -------------------------------------------------------------- create */

  // storyRef is either a real id, when attaching to an existing story, or the
  // '@{story.id}' placeholder that composite resolves from the record created
  // earlier in the same request.
  function metadataSubrequests(v, resolved, storyRef, components) {
    const batches = chunk(components, RECORDS_PER_SUBREQUEST);
    if (batches.length > MAX_METADATA_SUBREQUESTS) {
      throw new Error(
        `${components.length} components exceeds what one request can carry. ` +
        'Select fewer, or split them across several stories.'
      );
    }

    return batches.map((batch, i) => ({
      method: 'POST',
      url: `/services/data/${v}/composite/sobjects`,
      referenceId: `meta${i}`,
      body: {
        allOrNone: true,
        records: batch.map((c) => {
          const record = {
            attributes: { type: STORY_METADATA },
            [resolved.meta.metaStory]: storyRef,
          };
          if (resolved.meta.metaName) record[resolved.meta.metaName] = c.fullName;
          if (resolved.meta.metaType) record[resolved.meta.metaType] = c.type;
          return record;
        }),
      },
    }));
  }

  // Adds components to a story that already exists, leaving every other field
  // on it untouched.
  async function attachToStory(org, v, resolved, story, components) {
    if (!resolved.canAttach) {
      throw new Error(`Components cannot be attached: ${STORY_METADATA} is not usable in this org.`);
    }

    const result = await call(org, `/services/data/${v}/composite`, {
      method: 'POST',
      body: JSON.stringify({
        allOrNone: true,
        compositeRequest: metadataSubrequests(v, resolved, story.id, components),
      }),
    });

    const failure = firstFailure(result);
    if (failure) throw new Error(failure);

    return {
      id: story.id,
      name: story.name,
      url: `${org.instanceUrl}/lightning/r/${USER_STORY}/${story.id}/view`,
      attached: components.length,
      created: false,
    };
  }

  // The story and every component land in one composite call with
  // allOrNone, so a failure part way through cannot leave an orphan story
  // behind for someone to find later and wonder about.
  async function createUserStory(org, v, resolved, form, components) {
    const story = { [resolved.story.title]: form.title };
    if (resolved.story.project && form.projectId) story[resolved.story.project] = form.projectId;
    if (resolved.story.sprint && form.sprintId) story[resolved.story.sprint] = form.sprintId;
    if (resolved.story.environment && form.environmentId) {
      story[resolved.story.environment] = form.environmentId;
    }
    if (resolved.story.status && form.status) story[resolved.story.status] = form.status;

    const compositeRequest = [{
      method: 'POST',
      url: `/services/data/${v}/sobjects/${USER_STORY}`,
      referenceId: 'story',
      body: story,
    }];

    if (resolved.canAttach && components.length) {
      compositeRequest.push(...metadataSubrequests(v, resolved, '@{story.id}', components));
    }

    const result = await call(org, `/services/data/${v}/composite`, {
      method: 'POST',
      body: JSON.stringify({ allOrNone: true, compositeRequest }),
    });

    const failure = firstFailure(result);
    if (failure) throw new Error(failure);

    const id = result.compositeResponse[0].body.id;
    return {
      id,
      name: null,   // auto-number, not known until the record is read back
      url: `${org.instanceUrl}/lightning/r/${USER_STORY}/${id}/view`,
      attached: resolved.canAttach ? components.length : 0,
      created: true,
    };
  }

  // Composite reports per-subrequest status, and allOrNone rolls everything
  // back — so the first real error is the one worth showing.
  function firstFailure(result) {
    for (const part of result.compositeResponse || []) {
      if (part.httpStatusCode >= 400) {
        const message = salesforceError(part.body);
        if (message && !/rolled back/i.test(message)) return message;
      }
      // sObject Collections reports row-level errors inside a 200 response.
      for (const row of Array.isArray(part.body) ? part.body : []) {
        if (row && row.success === false && row.errors?.length) {
          return row.errors.map((e) => e.message).join('\n');
        }
      }
    }
    return null;
  }

  function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  /* --------------------------------------------------------------- entry */

  // One call for the confirm screen: connection, schema and lookups together.
  async function prepare() {
    const org = await connection();
    const v = await version(org);
    const [resolved, lists] = await Promise.all([schema(org, v), options(org, v)]);
    return { org, v, resolved, lists };
  }

  const stories = (ctx) => listStories(ctx.org, ctx.v, ctx.resolved);

  const metadataFor = (ctx, storyId) => storyMetadata(ctx.org, ctx.v, ctx.resolved, storyId);

  const promotionsOf = (ctx, storyId) => promotionsFor(ctx.org, ctx.v, storyId);

  const commitsOf = (ctx, storyId) => commitsFor(ctx.org, ctx.v, storyId);

  const commitsOfStories = (ctx, ids) => latestCommits(ctx.org, ctx.v, ids);

  const failureOf = (ctx, storyId) => failureFor(ctx.org, ctx.v, storyId);

  const activityOf = (ctx, storyId) => activityFor(ctx.org, ctx.v, storyId);

  const recent = (ctx, limit) => recentStories(ctx.org, ctx.v, ctx.resolved, limit);

  const sourceEnvOf = (ctx, salesforceOrgId) => sourceEnvironment(ctx.org, ctx.v, salesforceOrgId);

  const byTitle = (ctx, title) => findByTitle(ctx.org, ctx.v, ctx.resolved, title);
  const byName = (ctx, name) => findByName(ctx.org, ctx.v, name);

  // create/attach write user story records directly. Nothing calls them: the
  // Copado route asks the agent to do that work instead, so the org connection
  // is read-only. Kept because they are correct and tested, and the record path
  // is the fallback if prompting turns out not to fit.
  const create = (ctx, form, components) =>
    createUserStory(ctx.org, ctx.v, ctx.resolved, form, components);

  const attach = (ctx, story, components) =>
    attachToStory(ctx.org, ctx.v, ctx.resolved, story, components);

  return {
    prepare, stories, recent, metadataFor, promotionsOf, commitsOf, commitsOfStories, failureOf, activityOf, sourceEnvOf,
    byTitle, byName, create, attach,
    USER_STORY, STORY_METADATA, STORY_COMMIT,
  };
})();
