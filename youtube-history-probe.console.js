/*
 * YouTube watch-history shape probe, for the history exporter.
 *
 * Paste into the DevTools console on https://www.youtube.com/feed/history while signed in,
 * or keep it as a snippet (DevTools > Sources > Snippets) and run it from there.
 *
 * It asks YouTube for the first page of your watch history and for whatever that page's
 * "load more" tokens lead to, then reports:
 *   checks    are the things an exporter would read there at all?
 *   sections  how the page is divided (one section per day?), with each section's heading
 *   paging    every "load more" token, where it sits, and what following it brings
 *   facts     a few plain numbers
 *   kinds     which kinds of item YouTube sent, and how many of each
 *   fields    every field on a history row, a Short and a section heading: names and types
 *   changes   what is different from the last run in this browser
 *
 * It only reads. The report holds no titles, ids or tokens. It does hold the day headings
 * of your history, in YouTube's words ("Today", "Tuesday", "23 Nov"), because an exporter
 * has to turn those into dates. After a run, copy(ytHistoryProbe) puts it on the clipboard.
 */
(async () => {
  const STORE = 'yt-playlists-export:history-probe'; // the last report, kept in this browser's localStorage
  const FEED = 'FEhistory'; // the API's name for /feed/history
  const NOISE = /tracking|logging|^ved$/i; // fields that differ on every request
  const MORE = ['continuationItemViewModel', 'continuationItemRenderer']; // "load more" items
  const ROWS = ['lockupViewModel', 'videoRenderer', 'compactVideoRenderer', 'playlistVideoRenderer']; // a video in a list
  const SHORTS = ['shortsLockupViewModel', 'reelItemRenderer']; // a Short on a shelf
  const VIDEO = 'LOCKUP_CONTENT_TYPE_VIDEO';

  // ---- the signed request the page itself makes (same as in the exporter)

  const cfg = (key) => window.ytcfg?.get?.(key) ?? window.ytcfg?.data_?.[key];
  const cookie = (name) => document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const sha1 = async (input) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input))), (byte) => byte.toString(16).padStart(2, '0')).join('');

  async function browse(payload) {
    const [first, second] = String(cfg('DATASYNC_ID') || '').split('||');
    const user = cfg('USER_SESSION_ID') || (second ? second : first) || null;
    const brand = cfg('DELEGATED_SESSION_ID') || (second ? first : null);
    const time = Math.floor(Date.now() / 1000);
    const cookies = [['SAPISIDHASH', cookie('SAPISID') || cookie('__Secure-3PAPISID')], ['SAPISID1PHASH', cookie('__Secure-1PAPISID')], ['SAPISID3PHASH', cookie('__Secure-3PAPISID')]].filter(([, value]) => value);
    if (!cookies.length) throw new Error('Not signed in to YouTube in this tab.');
    const tokens = await Promise.all(
      cookies.map(async ([scheme, value]) => `${scheme} ${time}_${await sha1((user ? [user, time, value, location.origin] : [time, value, location.origin]).join(' '))}${user ? '_u' : ''}`),
    );
    const response = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Authorization: tokens.join(' '),
        'X-Origin': location.origin,
        'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
        ...(brand && { 'X-Goog-PageId': brand }),
      },
      body: JSON.stringify({ context: cfg('INNERTUBE_CONTEXT'), ...payload }),
    });
    if (!response.ok) throw new Error(`YouTube answered HTTP ${response.status}.`);
    return response.json();
  }

  // ---- looking through a response

  /**
   * Every value stored under one of the keys, in document order, with the way down to it
   * (keys and array positions). Matched values are not searched further.
   */
  function locate(node, keys, trail = [], found = []) {
    if (Array.isArray(node)) {
      node.forEach((item, i) => locate(item, keys, [...trail, i], found));
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (keys.includes(key)) found.push({ key, value, trail: [...trail, key] });
        else locate(value, keys, [...trail, key], found);
      }
    }
    return found;
  }
  /** A way down written out, with every array position shown as []. */
  const written = (trail) => trail.map((step, i) => (typeof step === 'number' ? '[]' : `${i ? '.' : ''}${step}`)).join('');
  const reach = (root, trail) => trail.reduce((node, step) => node?.[step], root);

  const text = (node) =>
    typeof node === 'string' ? node : node?.content ?? node?.simpleText ?? (Array.isArray(node?.runs) ? node.runs.map((run) => run.text || '').join('') : '');

  function tokenOf(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.continuationCommand?.token === 'string') return node.continuationCommand.token;
    for (const value of Object.values(node)) {
      const token = tokenOf(value);
      if (token) return token;
    }
    return null;
  }

  /** How many of each kind of item ("...Renderer", "...ViewModel") a response holds. */
  function kindsIn(json) {
    const count = {};
    (function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return undefined;
      for (const [key, value] of Object.entries(node)) {
        if (/(Renderer|ViewModel)$/.test(key)) count[key] = (count[key] || 0) + 1;
        visit(value);
      }
      return undefined;
    })(json);
    return Object.fromEntries(Object.entries(count).sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * Every field found on a set of items, with its type. A trailing "?" marks a field only
   * some of the items have. Values are left out, except YouTube's own constants (words
   * like LOCKUP_CONTENT_TYPE_VIDEO), which say a lot and identify nobody.
   */
  function fieldsOf(items) {
    const seen = new Map();
    for (const item of items) {
      const own = new Map();
      (function visit(node, path) {
        if (Array.isArray(node)) return node.forEach((value) => visit(value, `${path}[]`));
        if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) if (!NOISE.test(key)) visit(value, path ? `${path}.${key}` : key);
          return undefined;
        }
        const constant = typeof node === 'string' && /^[A-Z][A-Z0-9]*(_[A-Z0-9]+){2,}$/.test(node);
        const kind = node === null ? 'null' : constant ? node : typeof node;
        if (!own.has(path)) own.set(path, new Set());
        own.get(path).add(kind);
        return undefined;
      })(item, '');
      for (const [path, kinds] of own) {
        if (!seen.has(path)) seen.set(path, { kinds: new Set(), count: 0 });
        kinds.forEach((kind) => seen.get(path).kinds.add(kind));
        seen.get(path).count += 1;
      }
    }
    const sorted = [...seen].sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(sorted.map(([path, { kinds, count }]) => [path, [...kinds].sort().join(' | ') + (count < items.length ? '?' : '')]));
  }

  // ---- history items, and the headings above them

  const isRow = (item) => item.key !== 'lockupViewModel' || item.value?.contentType === VIDEO;
  const rowsIn = (json) => locate(json, ROWS).filter(isRow);
  const shortsIn = (json) => locate(json, SHORTS);
  const itemsIn = (json) => [...rowsIn(json), ...shortsIn(json)];

  /** The first short piece of text under a node, and the way down to it. */
  function firstText(node, trail = []) {
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) {
        const found = firstText(item, [...trail, i]);
        if (found) return found;
      }
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (NOISE.test(key)) continue;
        if (typeof value === 'string' && ['content', 'simpleText', 'text'].includes(key) && value.length <= 60) return { text: value, trail: [...trail, key] };
        const found = firstText(value, [...trail, key]);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Group the items of a response by the headings above them. A heading is whatever sits
   * under a key with "header" in its name, on any object the item is inside of (the page's
   * own header, at the very top, does not count).
   */
  function sectionsOf(json) {
    const sections = new Map();
    const headerNodes = new Map(); // the heading's own data, for the "fields" part of the report
    for (const item of itemsIn(json)) {
      const headings = [];
      for (let depth = 1; depth < item.trail.length; depth++) {
        const node = reach(json, item.trail.slice(0, depth));
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
        const key = Object.keys(node).find((name) => /header/i.test(name) && name !== item.trail[depth]);
        const found = key && firstText(node[key], [...item.trail.slice(0, depth), key]);
        if (found) {
          headings.push(found);
          headerNodes.set(JSON.stringify([...item.trail.slice(0, depth), key]), node[key]);
        }
      }
      // One section per place in the response: two days never share a heading's position.
      const id = headings.length ? JSON.stringify(headings.map((heading) => heading.trail)) : `none ${written(item.trail)}`;
      if (!sections.has(id)) sections.set(id, { heading: headings.map((heading) => heading.text).join(' > ') || '(none)', 'heading at': headings.map((heading) => written(heading.trail)).join(' and ') || '', rows: 0, shorts: 0 });
      sections.get(id)[SHORTS.includes(item.key) ? 'shorts' : 'rows'] += 1;
    }
    return { list: [...sections.values()], headers: [...headerNodes.values()] };
  }

  // ---- what an exporter would read from a row

  const partsOf = (lockup) => (lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((row) => row.metadataParts || []);
  const badgesOf = (lockup) => locate(lockup.contentImage, ['thumbnailBadgeViewModel']).map((badge) => text(badge.value?.text));
  function findChannelId(node) {
    if (!node || typeof node !== 'object') return '';
    const id = node.browseEndpoint?.browseId;
    if (typeof id === 'string' && id.startsWith('UC')) return id;
    for (const value of Object.values(node)) {
      const found = findChannelId(value);
      if (found) return found;
    }
    return '';
  }

  /** Follow every "load more" token in a response and count what each brings. */
  async function followMore(json) {
    const list = [];
    const followed = new Set();
    let next = null;
    for (const [i, more] of locate(json, MORE).slice(0, 4).entries()) {
      const token = tokenOf(more.value);
      const entry = { kind: more.key, where: written(more.trail), first: i === 0, 'items it brings': 'no token inside', 'more after it': '' };
      if (token && !followed.has(token)) {
        followed.add(token);
        const answer = await browse({ continuation: token });
        next ??= answer;
        entry['items it brings'] = itemsIn(answer).length;
        entry['more after it'] = locate(answer, MORE).length;
      } else if (token) {
        entry['items it brings'] = 'same token as an earlier one';
      }
      list.push(entry);
    }
    return { list, next };
  }

  // ---- run

  const checks = [];
  /** ok when found on at least half of the items. */
  const check = (what, found, of) =>
    checks.push(of === undefined ? { check: what, ok: Boolean(found), found: String(found) } : { check: what, ok: of > 0 && found / of >= 0.5, found: `${found} of ${of}` });
  const count = (items, test) => items.filter(test).length;

  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(STORE));
  } catch {
    // no earlier run, or storage is off: nothing to compare with
  }

  console.log('%cYouTube history probe: asking for your watch history...', 'font-weight: bold');
  const feed = await browse({ browseId: FEED });
  const rows = rowsIn(feed);
  const shorts = shortsIn(feed);
  const lockups = rows.filter((item) => item.key === 'lockupViewModel').map((item) => item.value);
  const older = rows.filter((item) => item.key !== 'lockupViewModel').map((item) => item.value);
  const { list: sections, headers: headingNodes } = sectionsOf(feed);

  check('history rows found', rows.length);
  check('sections with a heading', count(sections, (section) => section.heading !== '(none)'), sections.length);
  if (lockups.length) {
    check('row: id', count(lockups, (row) => row.contentId), lockups.length);
    check('row: title', count(lockups, (row) => text(row.metadata?.lockupMetadataViewModel?.title)), lockups.length);
    check('row: channel name', count(lockups, (row) => text(partsOf(row)[0]?.text)), lockups.length);
    check('row: channel id', count(lockups, (row) => findChannelId(row.metadata?.lockupMetadataViewModel)), lockups.length);
    check('row: duration badge', count(lockups, (row) => badgesOf(row).some((badge) => /^\d+(:\d\d)+$/.test(badge))), lockups.length);
    check('row: a second line of details (views, perhaps)', count(lockups, (row) => partsOf(row).length > 1), lockups.length);
    check('row: watch progress', count(lockups, (row) => Number.isFinite(locate(row.contentImage, ['thumbnailOverlayProgressBarViewModel'])[0]?.value?.startPercent)), lockups.length);
  }
  if (older.length) {
    for (const field of ['videoId', 'title', 'ownerText', 'shortBylineText', 'lengthText', 'viewCountText', 'descriptionSnippet', 'thumbnailOverlays']) {
      check(`older row: ${field}`, count(older, (row) => row[field] != null), older.length);
    }
  }

  console.log('Following the "load more" tokens...');
  const more = await followMore(feed);
  const paging = more.list;
  if (paging.length) check('paging: the first token brings more history', paging[0]['items it brings'] > 0);
  else check('paging: no token, the first page is the whole history', true);
  const nextSections = more.next ? sectionsOf(more.next).list : [];
  const contentTypes = {};
  for (const item of locate(feed, ['lockupViewModel'])) contentTypes[item.value?.contentType] = (contentTypes[item.value?.contentType] || 0) + 1;
  const fields = {
    row: fieldsOf(lockups.length ? lockups : older),
    short: fieldsOf(shorts.map((item) => item.value)),
    heading: fieldsOf(headingNodes),
    loadMore: fieldsOf(locate(feed, MORE).map((item) => item.value)),
  };
  const client = cfg('INNERTUBE_CONTEXT')?.client || {};
  const lastHeading = sections.at(-1)?.heading;
  const facts = {
    'rows on the first page': rows.length,
    'Shorts on the first page': shorts.length,
    'sections on the first page': sections.length,
    'rows on the next page': more.next ? rowsIn(more.next).length : 'no next page',
    // Does a day carry on across two pages under the same heading?
    'next page starts under the last heading of the first': more.next ? nextSections[0]?.heading === lastHeading : 'no next page',
    'kinds of lockup on the first page': contentTypes,
    'where the rows sit': [...new Set(rows.map((item) => written(item.trail)))],
    'where the Shorts sit': [...new Set(shorts.map((item) => written(item.trail)))],
  };
  const report = {
    probe: 'history 1',
    when: new Date().toISOString(),
    client: `${client.clientName} ${client.clientVersion}`, // as sent with every request
    language: String(client.hl),
    checks,
    sections: { 'first page': sections.slice(0, 15), 'next page': nextSections.slice(0, 6) },
    paging,
    facts,
    // Fields that may say when something was watched, or how far.
    notable: Object.keys(fields.row).filter((path) => /time|date|percent|progress|(^|\.)index|feedback/i.test(path)),
    kinds: { feed: kindsIn(feed), nextPage: more.next ? kindsIn(more.next) : {} },
    fields,
  };

  // ---- what changed since the last run

  function changesSince(before) {
    const out = [];
    if (before.client !== report.client) out.push(`client version: ${before.client} -> ${report.client}`);
    const was = Object.fromEntries((before.checks || []).map((entry) => [entry.check, entry.ok]));
    for (const entry of checks) {
      if (!(entry.check in was)) out.push(`new check: "${entry.check}" (${entry.ok ? 'ok' : 'FAILING'})`);
      else if (was[entry.check] !== entry.ok) out.push(`check "${entry.check}": ${was[entry.check] ? 'ok' : 'failing'} -> ${entry.ok ? 'ok' : 'FAILING'}`);
    }
    const compare = (label, old = {}, now = {}, typed = false) => {
      for (const key of Object.keys(now)) if (!(key in old)) out.push(`new ${label}: ${key}${typed ? ` (${now[key]})` : ''}`);
      for (const key of Object.keys(old)) if (!(key in now)) out.push(`gone ${label}: ${key}`);
      if (typed) {
        const plain = (kind) => kind.replace(/\?$/, '');
        for (const key of Object.keys(now)) if (key in old && plain(old[key]) !== plain(now[key])) out.push(`changed ${label}: ${key}: ${old[key]} -> ${now[key]}`);
      }
    };
    for (const part of Object.keys(report.kinds)) compare(`kind of item in ${part}`, before.kinds?.[part], report.kinds[part]);
    for (const part of Object.keys(fields)) compare(`field on ${part}`, before.fields?.[part], fields[part], true);
    const outline = (list = []) => JSON.stringify(list.map((entry) => [entry.kind, entry.where, entry['items it brings'] > 0]));
    if (outline(before.paging) !== outline(paging)) out.push('paging: the "load more" tokens, or whether they bring anything, differ (see the paging table)');
    const places = (pages = {}) => JSON.stringify([...new Set(Object.values(pages).flat().map((section) => section['heading at']))]);
    if (places(before.sections) !== places(report.sections)) out.push('sections: the headings sit somewhere else (see the sections tables)');
    return out;
  }

  console.log(`%cChecks (${checks.every((entry) => entry.ok) ? 'all ok' : 'SOME FAILING'}), client ${report.client}`, 'font-weight: bold');
  console.table(checks);
  for (const [page, list] of Object.entries(report.sections)) {
    console.log(`%cSections, ${page}`, 'font-weight: bold');
    console.table(list);
  }
  console.log(`%cPaging: ${paging.length ? 'every "load more" token on the first page' : 'no "load more" token on the first page'}`, 'font-weight: bold');
  if (paging.length) console.table(paging);
  console.log('Facts:', facts);
  if (report.notable.length) console.log('Notable fields on a row:', report.notable);
  console.groupCollapsed('Kinds of item per response');
  for (const [part, kinds] of Object.entries(report.kinds)) console.log(part, kinds);
  console.groupEnd();
  console.groupCollapsed('Fields (names and types only)');
  for (const [part, list] of Object.entries(fields)) console.log(part, list);
  console.groupEnd();

  if (!last?.report) {
    console.log('First run in this browser: nothing to compare with yet.');
  } else {
    const changes = changesSince(last.report);
    console.log(`%c${changes.length ? `${changes.length} change(s)` : 'No changes'} since ${last.report.when}`, 'font-weight: bold');
    for (const change of changes) console.log(`  ${change}`);
    report.changes = changes;
  }
  try {
    const { changes, ...kept } = report;
    localStorage.setItem(STORE, JSON.stringify({ report: kept }));
  } catch {
    console.log('Could not save this run, so the next one will have nothing to compare with.');
  }

  window.ytHistoryProbe = report;
  console.log('Saved as ytHistoryProbe. To share it, run: copy(ytHistoryProbe)');
})().catch((error) => console.error('YouTube history probe failed:', error.message));
