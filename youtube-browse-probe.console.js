/*
 * YouTube "browse" shape probe, for the playlists exporter.
 *
 * Paste into the DevTools console on https://www.youtube.com/feed/playlists while signed
 * in, or keep it as a snippet (DevTools > Sources > Snippets) and run it from there.
 *
 * It asks YouTube for what the exporter reads (your list of playlists, one playlist, and
 * whatever that playlist's "load more" tokens lead to) and reports:
 *   checks   is each thing the exporter reads still where it looks for it?
 *   paging   every "load more" token on those two pages, and what following it brings
 *   kinds    which kinds of item YouTube sent, and how many of each
 *   facts    a few plain numbers: where YouTube's index starts, how many rows show progress
 *   fields   every field on a playlist card and on a video row: names and types only
 *   changes  what is different from the last run in this browser
 *
 * It only reads. The report holds no titles, ids or tokens, so it can be shared: after a
 * run, copy(ytProbe) puts it on the clipboard.
 */
(async () => {
  const PLAYLIST = ''; // a playlist id to inspect. Empty: the one used last time, else your largest
  const STORE = 'yt-playlists-export:probe'; // the last report, kept in this browser's localStorage
  const FEED = 'FEplaylist_aggregation'; // the API's name for /feed/playlists
  const NOISE = /tracking|logging|^ved$/i; // fields that differ on every request
  const MORE = ['continuationItemViewModel', 'continuationItemRenderer']; // "load more" items
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

  /** Every value stored under one of the keys, in document order. Paths show arrays as []. */
  function find(node, keys, path = '', found = []) {
    if (Array.isArray(node)) {
      for (const item of node) find(item, keys, `${path}[]`, found);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key;
        if (keys.includes(key)) found.push({ key, value, path: here });
        else find(value, keys, here, found);
      }
    }
    return found;
  }

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

  // ---- what the exporter reads from a lockup (a playlist card or a video row)

  const partsOf = (lockup) => (lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((row) => row.metadataParts || []);
  const titleOf = (lockup) => text(lockup.metadata?.lockupMetadataViewModel?.title);
  const badgesOf = (lockup) => find(lockup.contentImage, ['thumbnailBadgeViewModel']).map((badge) => text(badge.value?.text));
  const hasCover = (lockup) => find(lockup.contentImage, ['sources']).some((sources) => sources.value?.[0]?.url);
  const channelPart = (lockup) =>
    partsOf(lockup).findIndex((part) => (part.text?.commandRuns || []).some((run) => run.onTap?.innertubeCommand?.browseEndpoint?.browseId?.startsWith('UC')));
  /** The first channel id ("UC...") linked anywhere under a node; rows credited to several channels keep theirs behind the avatars. */
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
  const hasChannelId = (lockup) => channelPart(lockup) >= 0 || Boolean(findChannelId(lockup.metadata?.lockupMetadataViewModel?.image));
  const watchOf = (lockup) => lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint || {};
  const progressOf = (lockup) => find(lockup.contentImage, ['thumbnailOverlayProgressBarViewModel'])[0]?.value?.startPercent;
  /** The parts that are not the channel: on a video row, its views and its age. */
  const othersOf = (lockup) => partsOf(lockup).filter((_, i) => i !== Math.max(channelPart(lockup), 0)).map((part) => text(part.text)).filter(Boolean);
  const videosIn = (json) => find(json, ['lockupViewModel', 'playlistVideoRenderer', 'shortsLockupViewModel']).filter((item) => item.key !== 'lockupViewModel' || item.value?.contentType === VIDEO);
  const cardsIn = (json) => find(json, ['lockupViewModel', 'gridPlaylistRenderer', 'playlistRenderer']).filter((item) => item.key !== 'lockupViewModel' || (item.value?.contentId && item.value.contentType !== VIDEO));

  /**
   * Follow every "load more" token in a response and count what each brings. The exporter
   * follows the first one only, so if a later one is the one with the items, that shows here.
   */
  async function followMore(json, itemsIn) {
    const list = [];
    const followed = new Set();
    let next = null;
    for (const [i, more] of find(json, MORE).slice(0, 4).entries()) {
      const token = tokenOf(more.value);
      const entry = { kind: more.key, where: more.path, 'exporter follows': i === 0, 'items it brings': 'no token inside', 'more after it': '' };
      if (token && !followed.has(token)) {
        followed.add(token);
        const answer = await browse({ continuation: token });
        next ??= answer;
        entry['items it brings'] = itemsIn(answer).length;
        entry['more after it'] = find(answer, MORE).length;
      } else if (token) {
        entry['items it brings'] = 'same token as an earlier one';
      }
      list.push(entry);
    }
    return { list, next };
  }

  // ---- run

  const checks = [];
  /** ok when found on at least half of the items: some videos have no length, some no channel. */
  const check = (what, found, of) =>
    checks.push(of === undefined ? { check: what, ok: Boolean(found), found: String(found) } : { check: what, ok: of > 0 && found / of >= 0.5, found: `${found} of ${of}` });
  const count = (items, test) => items.filter(test).length;

  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(STORE));
  } catch {
    // no earlier run, or storage is off: nothing to compare with
  }

  console.log('%cYouTube browse probe: asking for your playlists...', 'font-weight: bold');
  const feed = await browse({ browseId: FEED });
  const cards = cardsIn(feed).filter((item) => item.key === 'lockupViewModel').map((item) => item.value);
  const olderCards = cardsIn(feed).filter((item) => item.key !== 'lockupViewModel').map((item) => item.value);
  const sizeOf = (card) => Number((badgesOf(card).join(' ').match(/\d[\d.,]*/) || ['0'])[0].replace(/\D/g, ''));
  check('playlist cards found', cards.length + olderCards.length);
  check('card: title', count(cards, titleOf), cards.length);
  check('card: video count badge', count(cards, sizeOf), cards.length);
  check('card: cover picture', count(cards, hasCover), cards.length);
  const feedPaging = await followMore(feed, cardsIn);
  if (feedPaging.list.length) check('paging, playlists: the token the exporter follows brings playlists', feedPaging.list[0]['items it brings'] > 0);
  else check('paging, playlists: no token, the first page holds them all', true);

  // The playlist to inspect: the one named above; else the one used last time, so that two
  // runs compare like with like; else the largest, which is the likeliest to need paging.
  const largest = [...cards].sort((a, b) => sizeOf(b) - sizeOf(a))[0];
  const candidates = PLAYLIST ? [PLAYLIST] : [...new Set([last?.playlist, largest?.contentId, olderCards[0]?.playlistId])].filter(Boolean);
  if (!candidates.length) throw new Error('No playlist to inspect: the list of playlists came back empty.');

  console.log('Asking for one playlist and following its "load more" tokens...');
  let playlistId;
  let first;
  let videos = [];
  for (playlistId of candidates) {
    first = await browse({ browseId: `VL${playlistId}` });
    videos = videosIn(first);
    if (videos.length) break; // else it may be gone, or empty: try the next one
  }
  const notices = find(first, ['alertRenderer', 'alertWithButtonRenderer']).map((item) => item.value);
  const rows = videos.filter((item) => item.key === 'lockupViewModel').map((item) => item.value);
  const olderRows = videos.filter((item) => item.key === 'playlistVideoRenderer').map((item) => item.value);
  check('video rows found', videos.length);
  if (rows.length) {
    check('row: title', count(rows, titleOf), rows.length);
    check('row: channel name', count(rows, (row) => text(partsOf(row)[0]?.text)), rows.length);
    check('row: channel id', count(rows, hasChannelId), rows.length);
    check('row: duration badge', count(rows, (row) => badgesOf(row).some((badge) => /^\d+(:\d\d)+$/.test(badge))), rows.length);
    check('row: views', count(rows, (row) => othersOf(row)[0]), rows.length);
    check('row: published age', count(rows, (row) => othersOf(row)[1]), rows.length);
    check('row: YouTube index', count(rows, (row) => Number.isFinite(watchOf(row).index)), rows.length);
  }
  if (olderRows.length) {
    for (const field of ['title', 'shortBylineText', 'lengthText', 'lengthSeconds', 'videoInfo']) {
      check(`older row: ${field}`, count(olderRows, (row) => row[field] != null), olderRows.length);
    }
  }
  if (playlistId === 'WL' && olderRows.length) {
    // What a tidy-up of Watch later relies on, beyond what an export reads.
    const removes = (row) => find(row.menu, ['playlistEditEndpoint']).some((edit) => (edit.value?.actions || []).some((action) => action.action === 'ACTION_REMOVE_VIDEO'));
    check('older row: entry id (setVideoId)', count(olderRows, (row) => row.setVideoId), olderRows.length);
    check('older row: playable flag', count(olderRows, (row) => typeof row.isPlayable === 'boolean'), olderRows.length);
    check('older row: remove command in its menu', count(olderRows, removes), olderRows.length);
  }

  const videoPaging = await followMore(first, videosIn);
  const nextPage = videoPaging.next;
  const declared = sizeOf(cards.find((card) => card.contentId === playlistId) || {});
  if (videoPaging.list.length) check('paging, videos: the token the exporter follows brings videos', videoPaging.list[0]['items it brings'] > 0 || videos.length >= declared);
  else check('paging, videos: no token, the first page holds the whole playlist', videos.length >= declared);
  const paging = { playlists: feedPaging.list, videos: videoPaging.list };

  const client = cfg('INNERTUBE_CONTEXT')?.client || {};
  const fields = {
    playlistCard: fieldsOf(cards.length ? cards : olderCards),
    video: fieldsOf(rows.length ? rows : olderRows),
    loadMore: fieldsOf(find(first, MORE).map((item) => item.value)),
    notice: fieldsOf(notices), // how a notice's button is wired, for asking YouTube to show hidden videos
  };
  // Plain numbers and YouTube's own labels: nothing of yours.
  const unnumbered = {};
  for (const card of cards) if (!sizeOf(card)) unnumbered[badgesOf(card).join(' ')] = (unnumbered[badgesOf(card).join(' ')] || 0) + 1;
  const facts = {
    'index of the first row': rows.length ? watchOf(rows[0]).index ?? 'none' : 'no rows in the new layout',
    'rows with watch progress': `${count(rows, (row) => Number.isFinite(progressOf(row)))} of ${rows.length}`,
    'rows with a resume time': `${count(rows, (row) => Number.isFinite(watchOf(row).startTimeSeconds))} of ${rows.length}`,
    'card badges without a number': unnumbered, // what cards say when they give no video count
    // YouTube's own messages on the playlist page, such as the one about hidden videos.
    'notices on the playlist page': notices.map((notice) => text(notice.text)),
    'rows that cannot be played': `${count(olderRows, (row) => row.isPlayable === false)} of ${olderRows.length}`,
  };
  const report = {
    probe: 3,
    when: new Date().toISOString(),
    client: `${client.clientName} ${client.clientVersion}`, // as sent with every request
    language: String(client.hl),
    checks,
    paging,
    facts,
    // Fields that would be worth exporting if YouTube sends them: entry ids, availability, watch progress.
    notable: Object.keys(fields.video).filter((path) => /setVideoId|playab|percent|progress|(^|\.)index|lengthSeconds/i.test(path)),
    kinds: { feed: kindsIn(feed), playlist: kindsIn(first), nextPage: nextPage ? kindsIn(nextPage) : {} },
    fields,
  };

  // ---- what changed since the last run

  function changesSince(before) {
    const out = [];
    if (before.client !== report.client) out.push(`client version: ${before.client} -> ${report.client}`);
    const was = Object.fromEntries(before.checks.map((entry) => [entry.check, entry.ok]));
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
    // Compare where the tokens sit and whether they bring anything, not how many items came.
    const outline = (pages = {}) => JSON.stringify(Object.values(pages).flat().map((entry) => [entry.kind, entry.where, entry['items it brings'] > 0]));
    if (outline(before.paging) !== outline(paging)) out.push('paging: the "load more" tokens, or whether they bring anything, differ (see the paging tables)');
    return out;
  }

  console.log(`%cChecks (${checks.every((entry) => entry.ok) ? 'all ok' : 'SOME FAILING'}), client ${report.client}`, 'font-weight: bold');
  console.table(checks);
  for (const [part, list] of Object.entries(paging)) {
    console.log(`%cPaging, ${part}: ${list.length ? 'every "load more" token on the first page' : 'no "load more" token on the first page'}`, 'font-weight: bold');
    if (list.length) console.table(list);
  }
  console.log('Facts:', facts);
  if (report.notable.length) console.log('Notable fields on a video row:', report.notable);
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
    const samePlaylist = last.playlist === playlistId;
    console.log(`%c${changes.length ? `${changes.length} change(s)` : 'No changes'} since ${last.report.when}${samePlaylist ? '' : ' (a different playlist this time, so field changes may only reflect that)'}`, 'font-weight: bold');
    for (const change of changes) console.log(`  ${change}`);
    report.changes = changes;
  }
  try {
    const { changes, ...kept } = report;
    localStorage.setItem(STORE, JSON.stringify({ playlist: playlistId, report: kept })); // the id stays here; it is not in the report
  } catch {
    console.log('Could not save this run, so the next one will have nothing to compare with.');
  }

  window.ytProbe = report;
  console.log('Saved as ytProbe. To share it, run: copy(ytProbe)');
})().catch((error) => console.error('YouTube browse probe failed:', error.message));
