// ==UserScript==
// @name         YouTube Playlists Export
// @namespace    userscripts/youtube-playlists-export
// @version      1.14.0
// @description  Export your YouTube playlists (optionally with every video in them) and your watch history as JSON and CSV, and tidy up Watch later. Adds a button on youtube.com/feed/playlists, /feed/history and the Watch later page.
// @homepageURL  https://github.com/ShaneIsley/yt-lists
// @supportURL   https://github.com/ShaneIsley/yt-lists/issues
// @downloadURL  https://raw.githubusercontent.com/ShaneIsley/yt-lists/main/youtube-playlists-export.user.js
// @updateURL    https://raw.githubusercontent.com/ShaneIsley/yt-lists/main/youtube-playlists-export.user.js
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * One source, two ways to run it:
 *   - userscript: shows an "Export playlists" button on /feed/playlists and an "Export
 *     history" button on /feed/history. YouTube is a single-page app, so the script
 *     matches the whole site and reacts to navigation.
 *   - bookmarklet: the same code, minified. It opens the export panel straight away, for
 *     the history on /feed/history and for playlists anywhere else.
 *
 * On the Watch later page the button is "Tidy Watch later": it reads the list and lets
 * videos be ticked for removal, by rule or by hand. Removing is off until it is allowed
 * in the panel, asks before it starts, and sends the command YouTube's own "Remove from
 * Watch later" menu item would send, one video at a time. Nothing else changes anything.
 *
 * The data comes from YouTube's own web API (the request the page itself makes), signed
 * with the signed-in session's cookies. Nothing is sent anywhere but youtube.com. If the
 * API cannot give the list of playlists, the cards on the page are read instead.
 *
 * YouTube changes its data without notice. Everything that depends on its shape is in
 * the "YouTube data shapes" section, and nowhere else.
 */

(() => {
  'use strict';

  const GLOBAL = '__ytPlaylistsExport';
  if (window[GLOBAL]) {
    // Already loaded on this page (bookmarklet clicked again): just show the panel.
    window[GLOBAL].open();
    return;
  }

  const CONFIG = {
    feedPath: '/feed/playlists',
    feedBrowseId: 'FEplaylist_aggregation', // the API's name for /feed/playlists
    requestDelayMs: 250, // pause between requests
    retryBaseMs: 1500, // wait after HTTP 429 or 5xx; doubles on each retry
    maxRetries: 3,
    maxPages: 300, // safety stop per list
    pageSize: 100, // videos per request; only used to estimate progress
    // Pictures in the progress view. The export never waits for them, but each one is a
    // download, so they are small, few, and only fetched while the panel is in view.
    pictures: true, // false: no pictures at all, and no image requests
    recentPictures: 4, // tiles in the strip under the progress bar
    pictureEveryMs: 1000, // the strip takes at most one new video picture this often
    videoPicture: 'default', // 120x90; 'mqdefault' is sharper (320x180) and several times the bytes
    coverWidth: 96, // width of the playlist cover in the panel, in CSS pixels
    filePrefix: 'youtube-playlists',
    // Watch history
    historyPath: '/feed/history',
    historyBrowseId: 'FEhistory', // the API's name for /feed/history
    historyMaxPages: 1500, // safety stop; one request brings about 200 items
    historyFilePrefix: 'youtube-history',
    // Watch later
    watchLaterId: 'WL',
    // What the playlist page's own "Show unavailable videos" adds to its request, so that
    // deleted and private videos are listed too. Empty: only what the page shows by default.
    showUnavailableParams: 'wgYCCAA%3D',
    watchLaterFilePrefix: 'youtube-watch-later-ticked',
  };

  // Userscript managers define GM_info (or GM.info). A bookmarklet has neither.
  const IS_USERSCRIPT =
    typeof GM_info !== 'undefined' || (typeof GM !== 'undefined' && Boolean(GM.info));
  // Managers that sandbox scripts keep the page's own variables on unsafeWindow.
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // Pixels the cover needs on this screen; no point fetching more on a dense display.
  const COVER_PIXELS = CONFIG.coverWidth * Math.min(window.devicePixelRatio || 1, 2);

  // ---------------------------------------------------------------- helpers

  const log = (...args) => console.debug('[yt-playlists-export]', ...args);
  const isAbort = (error) => error?.name === 'AbortError';
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const two = (n) => String(n).padStart(2, '0');

  /** Wait, but stop waiting (and reject) as soon as the export is stopped. */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Create an element. No innerHTML anywhere: YouTube enforces Trusted Types. */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value);
    }
    el.append(...children.filter((child) => child != null));
    return el;
  }

  /** Change text only when it differs, so screen readers do not repeat themselves. */
  function setText(el, value) {
    if (el.textContent !== value) el.textContent = value;
  }

  /** Visit every key of a JSON tree in document order. Matched nodes are not entered. */
  function scan(node, handlers) {
    if (Array.isArray(node)) {
      for (const item of node) scan(item, handlers);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (Object.hasOwn(handlers, key)) handlers[key](value);
        else scan(value, handlers);
      }
    }
  }

  // ------------------------------------------------------------ YouTube API
  // Functions that talk to YouTube take a "run": { signal, report }. signal stops the
  // work; report(patch) tells the progress view what changed.

  function ytcfg(key) {
    const cfg = page.ytcfg;
    return cfg?.get ? cfg.get(key) : cfg?.data_?.[key];
  }

  function cookie(name) {
    const prefix = `${name}=`;
    const entry = document.cookie.split('; ').find((part) => part.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : null;
  }

  async function sha1Hex(input) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /** DATASYNC_ID is "user||" for the main channel and "brand||user" for a brand channel. */
  function sessionIds() {
    const [first, second] = String(ytcfg('DATASYNC_ID') || '').split('||');
    return {
      user: ytcfg('USER_SESSION_ID') || (second ? second : first) || null,
      brand: ytcfg('DELEGATED_SESSION_ID') || (second ? first : null),
    };
  }

  /**
   * The headers YouTube's own page sends to prove a request comes from the signed-in
   * tab: a SHA-1 over time, a session cookie and the origin ("SAPISIDHASH").
   */
  async function authHeaders() {
    const origin = location.origin;
    const { user, brand } = sessionIds();
    const cookies = [
      ['SAPISIDHASH', cookie('SAPISID') || cookie('__Secure-3PAPISID')],
      ['SAPISID1PHASH', cookie('__Secure-1PAPISID')],
      ['SAPISID3PHASH', cookie('__Secure-3PAPISID')],
    ].filter(([, value]) => value);
    if (!cookies.length) {
      throw new Error('You do not seem to be signed in to YouTube in this tab.');
    }

    const time = Math.floor(Date.now() / 1000);
    const tokens = await Promise.all(
      cookies.map(async ([scheme, value]) => {
        const parts = user ? [user, time, value, origin] : [time, value, origin];
        return `${scheme} ${time}_${await sha1Hex(parts.join(' '))}${user ? '_u' : ''}`;
      }),
    );

    const headers = {
      Authorization: tokens.join(' '),
      'X-Origin': origin,
      'X-Goog-AuthUser': String(ytcfg('SESSION_INDEX') ?? 0),
      'X-Youtube-Bootstrap-Logged-In': 'true',
    };
    if (brand) headers['X-Goog-PageId'] = brand;
    const clientName = ytcfg('INNERTUBE_CONTEXT_CLIENT_NAME');
    const clientVersion = ytcfg('INNERTUBE_CONTEXT_CLIENT_VERSION');
    const visitor = ytcfg('VISITOR_DATA');
    if (clientName != null) headers['X-Youtube-Client-Name'] = String(clientName);
    if (clientVersion) headers['X-Youtube-Client-Version'] = clientVersion;
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    return headers;
  }

  /** One call to the "browse" endpoint, with retries when YouTube asks us to slow down. */
  async function browse(payload, run, path = '/youtubei/v1/browse') {
    const context = ytcfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('YouTube page settings (ytcfg) not found. Reload the page.');
    const body = JSON.stringify({ context, ...payload });

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${path}?prettyPrint=false`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body,
        signal: run.signal,
      });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= CONFIG.maxRetries) {
        throw new Error(`YouTube answered HTTP ${response.status}.`);
      }
      const wait = CONFIG.retryBaseMs * 2 ** attempt;
      run.report({ waiting: Math.ceil(wait / 1000) }); // otherwise the wait looks like a freeze
      await sleep(wait, run.signal);
      run.report({ waiting: 0 });
    }
  }

  /** Yield the first page of a list, then each "load more" page until there are none. */
  async function* browsePages(firstPayload, run, { findNext = nextToken, maxPages = CONFIG.maxPages } = {}) {
    const seenTokens = new Set();
    let payload = firstPayload;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      const json = await browse(payload, run);
      yield json;
      const token = findNext(json);
      if (!token || seenTokens.has(token)) return;
      seenTokens.add(token);
      payload = { continuation: token };
      await sleep(CONFIG.requestDelayMs, run.signal);
    }
  }

  // ---------------------------------------------------- YouTube data shapes
  // Late 2026: playlists and most videos arrive as "lockupViewModel"; some lists (Watch
  // later, for one) still use the older "...Renderer" shapes. Both are read here.

  /** Text nodes come as {content}, {simpleText}, {runs: [{text}]} or a plain string. */
  function text(node) {
    if (typeof node === 'string') return node;
    if (!node) return '';
    if (typeof node.content === 'string') return node.content;
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((part) => part.text || '').join('');
    return '';
  }

  /** "1,234 videos" -> 1234. Null when there is no exact number ("1.2K", "Mix"). */
  function parseCount(value) {
    if (Number.isInteger(value)) return value;
    const match = /(\d(?:[\d.,\u00a0\u202f ]*\d)?)([a-z])?/i.exec(String(value ?? ''));
    return match && !match[2] ? Number(match[1].replace(/\D/g, '')) : null;
  }

  /**
   * From a list of {url, width} sources: the smallest image at least minWidth wide, or the
   * widest there is. Returned as a full https address.
   */
  function pickImage(sources, minWidth) {
    if (!Array.isArray(sources)) return '';
    const byWidth = sources.filter((source) => source?.url).sort((a, b) => (a.width || 0) - (b.width || 0));
    const best = byWidth.find((source) => (source.width || 0) >= minWidth) || byWidth.at(-1);
    if (!best) return '';
    try {
      const url = new URL(best.url, 'https://www.youtube.com');
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  /** A video's picture, built from its id. These plain addresses need no signature. */
  const videoImage = (videoId) =>
    `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${CONFIG.videoPicture}.jpg`;

  /** The token is nested at a different depth in each shape, so look for it anywhere. */
  function findToken(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.continuationCommand?.token === 'string') return node.continuationCommand.token;
    for (const value of Object.values(node)) {
      const token = findToken(value);
      if (token) return token;
    }
    return null;
  }

  /**
   * The "load more" token of a response. Only the list's own continuation item counts:
   * filter chips and sort menus carry tokens too, and those would restart the list.
   */
  function nextToken(json) {
    let token = null;
    const read = (item) => {
      token ??= findToken(item);
    };
    scan(json, { continuationItemRenderer: read, continuationItemViewModel: read });
    return token;
  }

  function findChannel(parts) {
    for (const part of parts) {
      for (const link of part.text?.commandRuns || []) {
        const id = link.onTap?.innertubeCommand?.browseEndpoint?.browseId;
        if (!id?.startsWith('UC')) continue;
        const whole = text(part.text);
        const name =
          Number.isInteger(link.startIndex) && link.length
            ? whole.slice(link.startIndex, link.startIndex + link.length)
            : whole;
        return { name, id, at: parts.indexOf(part) };
      }
    }
    return { name: '', id: '', at: -1 };
  }

  /** The first channel id ("UC...") linked anywhere under a node. */
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

  /** A number as it is, anything else as null: keeps the files honest about what is unknown. */
  const numberOrNull = (value) => (Number.isFinite(value) ? value : null);

  /** "1:02:03" -> 3723. Null for anything that is not a length of time. */
  const toSeconds = (duration) =>
    /^\d+(:\d\d)+$/.test(duration) ? duration.split(':').reduce((total, part) => total * 60 + Number(part), 0) : null;

  /** The parts of a lockup (a playlist card or a video row) that the export uses. */
  function readLockup(lockup) {
    const meta = lockup.metadata?.lockupMetadataViewModel;
    const rows = (meta?.metadata?.contentMetadataViewModel?.metadataRows || []).map(
      (row) => row.metadataParts || [],
    );
    const badges = [];
    let image = '';
    let watchedPercent = null;
    scan(lockup.contentImage, {
      thumbnailBadgeViewModel: (badge) => badges.push(text(badge?.text)),
      // The red line under a picture: how much of the video this account has watched.
      thumbnailOverlayProgressBarViewModel: (bar) => {
        watchedPercent ??= numberOrNull(bar?.startPercent);
      },
      sources: (sources) => {
        image ||= pickImage(sources, COVER_PIXELS); // the first image is the main one
      },
    });
    const parts = rows.flat();
    const channel = findChannel(parts);
    // A row credited to several channels ("A and B") links none of them in its text. Their
    // ids are behind the avatars beside it; the first one credited is taken.
    channel.id ||= findChannelId(meta?.image);
    return {
      title: text(meta?.title),
      image,
      watchedPercent,
      // One line per row under the title, e.g. "Private · Playlist", "Updated today".
      details: rows
        .map((parts) => parts.map((part) => text(part.text)).filter(Boolean).join(' · '))
        .filter(Boolean),
      firstPart: text(parts[0]?.text),
      channel,
      // The parts other than the channel (the first one, if none is linked). On a video
      // row these are its views and its age, in the words YouTube shows.
      others: parts.filter((_, i) => i !== Math.max(channel.at, 0)).map((part) => text(part.text)).filter(Boolean),
      badges: badges.filter(Boolean), // "12 videos" on a playlist, "4:05" on a video
    };
  }

  function makePlaylist({ id, title, type = 'playlist', videoCount = null, owner = '', details = [], thumbnail = '' }) {
    return {
      id,
      title: title.replace(/\s+/g, ' ').trim(),
      url: `https://www.youtube.com/playlist?list=${id}`,
      type,
      videoCount,
      owner,
      details,
      thumbnail, // the cover, shown in the panel only: collect() leaves it out of the files
    };
  }

  function parsePlaylists(json) {
    const found = [];
    const older = (renderer) => {
      if (!renderer?.playlistId) return;
      found.push(
        makePlaylist({
          id: renderer.playlistId,
          title: text(renderer.title),
          videoCount: parseCount(renderer.videoCount ?? text(renderer.videoCountText)),
          owner: text(renderer.shortBylineText || renderer.longBylineText),
          thumbnail: pickImage(renderer.thumbnail?.thumbnails || renderer.thumbnails?.[0]?.thumbnails, COVER_PIXELS),
        }),
      );
    };
    scan(json, {
      lockupViewModel: (lockup) => {
        if (!lockup?.contentId || lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') return;
        const info = readLockup(lockup);
        found.push(
          makePlaylist({
            id: lockup.contentId,
            title: info.title,
            type: String(lockup.contentType || 'playlist')
              .replace('LOCKUP_CONTENT_TYPE_', '')
              .toLowerCase(),
            videoCount: info.badges.map(parseCount).find((count) => count != null) ?? null,
            owner: info.channel.name,
            details: info.details,
            thumbnail: info.image,
          }),
        );
      },
      gridPlaylistRenderer: older,
      playlistRenderer: older,
    });
    return found;
  }

  /** YouTube's own "remove from this playlist" command for a row, exactly as the row's menu holds it. */
  function findRemoveCommand(menu) {
    let command = null;
    scan(menu, {
      serviceEndpoint: (endpoint) => {
        const actions = endpoint?.playlistEditEndpoint?.actions || [];
        if (!command && actions.some((action) => action.action === 'ACTION_REMOVE_VIDEO')) command = endpoint;
      },
    });
    return command;
  }

  /**
   * Every video and Short in a response, in order, as { kind: 'video' | 'short', video }.
   * "skipped", if given, counts what was passed over (lockups of another kind, and items
   * whose id was not where it is looked for), so that nothing vanishes unseen.
   */
  function parseItems(json, skipped = null) {
    const found = [];
    const pass = (what) => {
      if (skipped) skipped[what] = (skipped[what] || 0) + 1;
    };
    const add = (kind, entry, { videoId, title, channel = '', channelId = '', duration = '', seconds = null, viewsText = '', publishedText = '', watch = {}, watchedPercent }) => {
      if (!videoId) return pass(`${kind} without an id`);
      const video = {
        videoId,
        title,
        channel,
        channelId,
        duration,
        durationSeconds: seconds ?? toSeconds(duration),
        viewsText, // as YouTube shows it: "1.2M views", rounded and in the page's language
        publishedText, // likewise: "3 years ago", not a date
        youtubeIndex: numberOrNull(watch.index), // YouTube's own number for the entry; ours is "position"
        watchedPercent: numberOrNull(watchedPercent), // of the video, by this account; null if not started
        resumeSeconds: numberOrNull(watch.startTimeSeconds), // where playback would pick up again
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
      return found.push({ kind, video, entry });
    };
    scan(json, {
      lockupViewModel: (lockup) => {
        if (lockup?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return pass(lockup?.contentType || 'lockup of no stated kind');
        const info = readLockup(lockup);
        add('video', {}, {
          videoId: lockup.contentId,
          title: info.title,
          channel: info.channel.name || info.firstPart,
          channelId: info.channel.id,
          duration: info.badges.find((badge) => toSeconds(badge) != null),
          viewsText: info.others[0],
          publishedText: info.others[1],
          watch: lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint,
          watchedPercent: info.watchedPercent,
        });
      },
      playlistVideoRenderer: (renderer) => {
        const by = renderer?.shortBylineText?.runs?.[0];
        const seconds = Number.parseInt(renderer?.lengthSeconds, 10);
        // "50K views • 10 years ago". The dot between the two is not always the same one.
        const [viewsText, publishedText] = text(renderer?.videoInfo).split(/\s+[•·|]\s+/u);
        // Not exported: the entry's own id in the playlist, whether it can be played, and
        // the command YouTube's "Remove from ..." menu item would send for it.
        const entry = { setVideoId: renderer?.setVideoId || '', playable: renderer?.isPlayable !== false, remove: findRemoveCommand(renderer?.menu) };
        add('video', entry, {
          videoId: renderer?.videoId,
          title: text(renderer?.title),
          channel: by?.text,
          channelId: by?.navigationEndpoint?.browseEndpoint?.browseId,
          duration: text(renderer?.lengthText),
          seconds: Number.isFinite(seconds) ? seconds : null,
          viewsText,
          publishedText,
          watch: renderer?.navigationEndpoint?.watchEndpoint,
          watchedPercent: (renderer?.thumbnailOverlays || []).map((overlay) => overlay.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched).find(Number.isFinite),
        });
      },
      shortsLockupViewModel: (short) =>
        add('short', {}, {
          videoId: short?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId,
          title: text(short?.overlayMetadata?.primaryText),
          viewsText: text(short?.overlayMetadata?.secondaryText),
        }),
      // The older form of a Short.
      reelItemRenderer: (short) =>
        add('short', {}, { videoId: short?.videoId, title: text(short?.headline), viewsText: text(short?.viewCountText) }),
    });
    return found;
  }

  const parseVideos = (json) => parseItems(json).map((item) => item.video);

  /** In the history, the token that matters sits beside the day sections, never inside one. */
  function historyToken(json) {
    let token = null;
    const read = (item) => {
      token ??= findToken(item);
    };
    scan(json, { itemSectionRenderer: () => {}, continuationItemRenderer: read, continuationItemViewModel: read });
    return token;
  }

  /** The first short piece of text under a node: for a heading whose exact place is not known. */
  function firstText(node) {
    if (!node || typeof node !== 'object') return '';
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && ['content', 'simpleText', 'text'].includes(key) && value.length <= 60) return value;
      const found = firstText(value);
      if (found) return found;
    }
    return '';
  }

  /**
   * The watch history as YouTube sends it: one section per day, each with a heading
   * ("Today", "Tuesday", ...) and that day's videos and Shorts. A day that runs past the
   * end of a response carries on in the next one, under the same heading.
   */
  function parseHistory(json) {
    const sections = [];
    scan(json, {
      itemSectionRenderer: (section) => {
        const skipped = {};
        const items = parseItems(section?.contents, skipped);
        const heading = text(section?.header?.itemSectionHeaderRenderer?.title) || firstText(section?.header);
        if (items.length || Object.keys(skipped).length) sections.push({ heading, items, skipped });
      },
    });
    return sections;
  }

  /** YouTube's own message on a page, such as "The playlist does not exist." */
  function parseAlert(json) {
    let message = '';
    const read = (alert) => {
      message ||= text(alert?.text);
    };
    scan(json, { alertRenderer: read, alertWithButtonRenderer: read });
    return message;
  }

  // ------------------------------------------------------------------- days
  // The history gives no time for a video, only a heading per day in YouTube's words:
  // "Today", "Yesterday", a weekday for the past week, then a date such as "20 Nov".

  const DAY_MS = 24 * 60 * 60 * 1000;
  /** Days are kept at noon, so an hour gained or lost to summer time never changes the date. */
  const atNoon = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const addDays = (date, days) => atNoon(new Date(date.getTime() + days * DAY_MS));
  const isoDay = (date) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;

  /** The words for days and months in the page's language, asked of the browser, not listed here. */
  function dayWords(language) {
    try {
      const lower = (value) => value.toLocaleLowerCase(language).replace(/\./g, '').trim();
      const names = (options, count, dateOf) =>
        Array.from({ length: count }, (_, i) => lower(new Intl.DateTimeFormat(language, options).format(dateOf(i))));
      const relative = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
      return {
        lower,
        today: lower(relative.format(0, 'day')),
        yesterday: lower(relative.format(-1, 'day')),
        weekdays: names({ weekday: 'long' }, 7, (i) => new Date(2026, 0, 4 + i, 12)), // 4 January 2026 is a Sunday
        months: names({ month: 'long' }, 12, (i) => new Date(2026, i, 15, 12)),
        shortMonths: names({ month: 'short' }, 12, (i) => new Date(2026, i, 15, 12)),
      };
    } catch (error) {
      if (language === 'en') throw error;
      return dayWords('en'); // a language tag the browser does not know
    }
  }

  /**
   * The day a heading stands for, or null if it cannot be read. Headings come newest
   * first, so "limit" is the latest day this one can be: the day before the previous
   * heading's, or today.
   */
  function readDay(heading, today, limit, words) {
    const said = words.lower(heading);
    if (said === words.today) return today;
    if (said === words.yesterday) return addDays(today, -1);

    const weekday = words.weekdays.indexOf(said);
    if (weekday >= 0) {
      // A weekday means the latest such day before today.
      let day = limit < today ? limit : addDays(today, -1);
      while (day.getDay() !== weekday) day = addDays(day, -1);
      return day;
    }

    // A written date: a day number, a month name and perhaps a year, in any order.
    const tokens = said.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const month = tokens
      .map((token) => words.months.findIndex((name, i) => token.length >= 3 && (name.startsWith(token) || token === words.shortMonths[i])))
      .find((index) => index >= 0);
    const numbers = tokens.filter((token) => /^\d+$/.test(token)).map(Number);
    const dayNumber = numbers.find((n) => n >= 1 && n <= 31);
    const year = numbers.find((n) => n >= 1900);
    if (month === undefined || dayNumber === undefined) return null;
    let day = new Date(year ?? limit.getFullYear(), month, dayNumber, 12);
    if (year === undefined && day > limit) day = new Date(limit.getFullYear() - 1, month, dayNumber, 12);
    return day.getMonth() === month ? day : null; // no 31 February
  }

  // ------------------------------------------------------------- collecting

  /** The covers of the playlists found last, for the strip under the progress bar. */
  const latestCovers = (byId) =>
    [...byId.values()].map((playlist) => playlist.thumbnail).filter(Boolean).slice(-CONFIG.recentPictures);

  async function fetchPlaylistIndex(run) {
    const byId = new Map();
    let pageNo = 0;
    for await (const json of browsePages({ browseId: CONFIG.feedBrowseId }, run)) {
      const batch = parsePlaylists(json);
      if (pageNo++ > 0 && !batch.length) break;
      for (const playlist of batch) if (!byId.has(playlist.id)) byId.set(playlist.id, playlist);
      // nextCover: the first playlist is the first to be read.
      run.report({ found: byId.size, pictures: latestCovers(byId), nextCover: byId.values().next().value?.thumbnail });
    }
    return [...byId.values()];
  }

  /** onRequest(videos) is called after each request, with every video read so far. */
  async function fetchVideos(playlist, run, onRequest) {
    const videos = [];
    let notice = '';
    let pageNo = 0;
    for await (const json of browsePages({ browseId: `VL${playlist.id}` }, run)) {
      const batch = parseVideos(json);
      if (pageNo++ === 0) notice = parseAlert(json);
      else if (!batch.length) break;
      // The same video can be in a playlist twice, so nothing is de-duplicated here.
      for (const video of batch) videos.push({ position: videos.length + 1, ...video });
      onRequest(videos);
    }
    if (!videos.length && playlist.videoCount !== 0) {
      throw new Error(notice || 'No videos found in this playlist.');
    }
    return videos;
  }

  /**
   * Fallback: read the playlist cards on /feed/playlists. The page only adds cards as it
   * scrolls, so scroll to the end first. This honours the filter chosen on the page.
   */
  async function scrapePlaylistIndex(run) {
    const root =
      document.querySelector('ytd-browse[page-subtype="playlists"]') ||
      document.querySelector('ytd-page-manager') || // leaves out the sidebar's playlist links
      document.body;
    const cards = 'yt-lockup-view-model, ytd-rich-item-renderer, ytd-grid-playlist-renderer, ytd-playlist-renderer';
    const read = () => {
      const byId = new Map();
      for (const link of root.querySelectorAll('a[href*="list="]')) {
        const id = new URL(link.getAttribute('href'), location.href).searchParams.get('list');
        if (!id || byId.has(id)) continue;
        const card = link.closest(cards) || link;
        const title =
          card.querySelector('h3')?.textContent || link.getAttribute('title') || link.textContent || '';
        byId.set(id, makePlaylist({ id, title, thumbnail: card.querySelector('img[src^="http"]')?.src || '' }));
      }
      return byId;
    };

    const startY = window.scrollY;
    let found = read();
    for (let idle = 0, round = 0; idle < 3 && round < 200; round++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(900, run.signal);
      const next = read();
      idle = next.size > found.size ? 0 : idle + 1;
      found = next;
      run.report({ found: found.size, pictures: latestCovers(found) });
    }
    window.scrollTo(0, startY);
    return [...found.values()];
  }

  /**
   * Fill in playlist.videos for every playlist. Returns false when the run was stopped
   * part-way: the playlists read until then keep their videos, the rest have none.
   */
  async function collectVideos(playlists, run) {
    // Time goes into requests, not videos, so progress is counted in expected requests.
    const requestsFor = (playlist) =>
      Math.max(1, Math.ceil((playlist.videoCount ?? 1) / CONFIG.pageSize));
    const expected = playlists.reduce((sum, playlist) => sum + requestsFor(playlist), 0);
    let requests = 0;
    let videos = 0;
    let failed = 0;
    const strip = []; // pictures of a few videos read lately, newest last
    let sampledAt = 0;
    // The first report of a phase carries every field its view reads.
    run.report({ phase: 'videos', total: playlists.length, startedAt: Date.now(), index: 0, title: '', cover: '', declared: null, read: 0, fraction: 0, videos, failed });

    for (const [index, playlist] of playlists.entries()) {
      run.report({ index, title: playlist.title, cover: playlist.thumbnail, declared: playlist.videoCount, read: 0, nextCover: playlists[index + 1]?.thumbnail, fraction: requests / expected });
      let made = 0;
      try {
        playlist.videos = await fetchVideos(playlist, run, (read) => {
          made = Math.min(made + 1, requestsFor(playlist));
          const patch = { read: read.length, videos: videos + read.length, fraction: (requests + made) / expected };
          // A sample of what goes by: the strip moves along by one picture, not too often.
          if (read.length && Date.now() - sampledAt >= CONFIG.pictureEveryMs) {
            sampledAt = Date.now();
            strip.push(videoImage(read.at(-1).videoId));
            if (strip.length > CONFIG.recentPictures) strip.shift();
            patch.pictures = [...strip];
          }
          run.report(patch);
        });
        videos += playlist.videos.length;
      } catch (error) {
        if (isAbort(error)) {
          if (!index) throw error; // stopped before anything was read
          return false;
        }
        // One unreadable playlist must not lose the rest of the export.
        playlist.videos = [];
        playlist.error = error.message;
        failed += 1;
        log(`Playlist ${playlist.id} failed:`, error);
      }
      requests += requestsFor(playlist);
      run.report({ videos, failed, fraction: requests / expected });
      // The pause between playlists comes here, not before the next one's first request,
      // so the finished playlist stays in view, complete, while it lasts.
      if (index < playlists.length - 1) {
        try {
          await sleep(CONFIG.requestDelayMs, run.signal);
        } catch {
          return false; // stopped during the pause; this playlist is complete
        }
      }
    }
    return true;
  }

  async function collect(withVideos, run) {
    if (location.hostname !== 'www.youtube.com') {
      throw new Error('Run this on www.youtube.com/feed/playlists.');
    }

    run.report({ phase: 'index', label: 'Reading your playlists…', found: 0, pictures: [] });
    let playlists = [];
    let apiError = null;
    try {
      playlists = await fetchPlaylistIndex(run);
    } catch (error) {
      if (isAbort(error)) throw error;
      apiError = error;
      log('Reading the list of playlists from the API failed:', error);
    }
    if (!playlists.length && location.pathname === CONFIG.feedPath) {
      run.report({ label: 'Reading playlists from the page…', found: 0, waiting: 0 });
      playlists = await scrapePlaylistIndex(run);
    }
    if (!playlists.length) throw apiError || new Error('No playlists found.');

    const complete = withVideos ? await collectVideos(playlists, run) : true;
    return {
      schema: 'youtube-playlists-export/1',
      exportedAt: new Date().toISOString(),
      source: location.origin + CONFIG.feedPath,
      withVideos,
      complete, // false: stopped early, later playlists have no "videos"
      playlists: playlists.map(({ thumbnail, ...playlist }) => playlist), // covers stay in the panel
    };
  }

  /**
   * Read the watch history, newest first, back over "days" days (0: all of it). Every
   * item gets the day of the section it was listed under; YouTube gives nothing finer.
   */
  async function collectHistory({ days, shorts }, run) {
    if (location.hostname !== 'www.youtube.com') {
      throw new Error('Run this on www.youtube.com/feed/history.');
    }
    const words = dayWords(ytcfg('HL') || navigator.language || 'en');
    const today = atNoon(new Date());
    const from = days ? addDays(today, 1 - days) : null; // the earliest day wanted
    const items = [];
    const undated = new Set(); // headings that could not be read as a day
    const skipped = {};
    const strip = [];
    let sampledAt = 0;
    let stopped = ''; // why the export is incomplete, if it is
    let heading = null; // the section being read ...
    let day = null; // ... and its day, null if the heading could not be read
    let lastDay = null; // the latest day that could be read
    let requests = 0;
    run.report({ phase: 'history', label: 'Reading your history…', day: '', fraction: from ? 0 : null, items: 0, startedAt: Date.now(), pictures: [] });

    try {
      const pages = browsePages({ browseId: CONFIG.historyBrowseId }, run, { findNext: historyToken, maxPages: CONFIG.historyMaxPages });
      reading: for await (const json of pages) {
        requests += 1;
        const sections = parseHistory(json);
        if (requests > 1 && !sections.length) break;
        for (const section of sections) {
          if (section.heading !== heading) {
            // A different heading is an earlier day than the one before it.
            heading = section.heading;
            day = readDay(heading, today, lastDay ? addDays(lastDay, -1) : today, words);
            if (day) lastDay = day;
            else undated.add(heading);
          }
          if (from && !day) {
            stopped = `the heading "${heading}" could not be read as a date`; // in range or not? No way to tell
            break reading;
          }
          if (from && day < from) break reading; // older than asked for: done

          for (const [type, count] of Object.entries(section.skipped)) skipped[type] = (skipped[type] || 0) + count;
          for (const { kind, video } of section.items) {
            if (kind === 'short' && !shorts) continue;
            const { youtubeIndex, ...rest } = video; // a playlist's numbering; the history has none
            items.push({ position: items.length + 1, watchedOn: day ? isoDay(day) : null, watchedOnText: heading, kind, ...rest });
          }

          const patch = { day: heading, items: items.length, fraction: from ? Math.min(Math.round((today - day) / DAY_MS) / days, 1) : null };
          const latest = section.items.filter((item) => item.kind === 'video').at(-1);
          if (latest && Date.now() - sampledAt >= CONFIG.pictureEveryMs) {
            sampledAt = Date.now();
            strip.push(videoImage(latest.video.videoId));
            if (strip.length > CONFIG.recentPictures) strip.shift();
            patch.pictures = [...strip];
          }
          run.report(patch);
        }
      }
      if (requests >= CONFIG.historyMaxPages) stopped = `the safety limit of ${CONFIG.historyMaxPages} requests was reached`;
    } catch (error) {
      if (!items.length) throw error;
      // Keep what was read: a long export should not be lost to its last request.
      stopped = isAbort(error) ? 'you stopped it' : error.message;
    }
    if (!items.length && !stopped) throw new Error('No watch history came back. It may be empty, or switched off.');

    return {
      schema: 'youtube-history-export/1',
      exportedAt: new Date().toISOString(),
      source: location.origin + CONFIG.historyPath,
      from: from ? isoDay(from) : null, // the earliest day asked for; null: everything
      includesShorts: shorts,
      complete: !stopped,
      stopped: stopped || null, // why it ended early, in words
      undated: [...undated], // headings that could not be read as a date; their items have watchedOn null
      skipped, // items of kinds this exporter does not read, counted by kind
      items,
    };
  }

  /**
   * Read the whole Watch later list for a tidy-up. Each row keeps, beside what an export
   * holds, whether it can be played, its entry id and YouTube's remove command for it.
   */
  async function collectWatchLater(_, run) {
    if (location.hostname !== 'www.youtube.com') {
      throw new Error('Run this on www.youtube.com/playlist?list=WL.');
    }
    run.report({ phase: 'index', label: 'Reading Watch later…', found: 0, pictures: [] });
    const rows = [];
    const strip = [];
    let sampledAt = 0;
    let notice = '';
    let requests = 0;
    const asked = { hidden: false }; // were the videos YouTube hides asked for, and did it answer?
    for await (const json of watchLaterPages(run, asked)) {
      const batch = parseItems(json);
      if (requests++ === 0) notice = parseAlert(json);
      else if (!batch.length) break;
      for (const { video, entry } of batch) {
        rows.push({ position: rows.length + 1, ...video, playable: entry.playable ?? true, setVideoId: entry.setVideoId || '', remove: entry.remove || null });
      }
      const patch = { found: rows.length };
      if (batch.length && Date.now() - sampledAt >= CONFIG.pictureEveryMs) {
        sampledAt = Date.now();
        strip.push(videoImage(batch.at(-1).video.videoId));
        if (strip.length > CONFIG.recentPictures) strip.shift();
        patch.pictures = [...strip];
      }
      run.report(patch);
    }
    if (!rows.length) throw new Error(notice || 'Watch later came back empty.');
    return { source: `${location.origin}/playlist?list=${CONFIG.watchLaterId}`, notice, rows, askedForHidden: asked.hidden };
  }

  /**
   * The pages of Watch later, with the videos YouTube hides by default (deleted, private)
   * if it will give them: the request is the one behind the page's own "Show unavailable
   * videos". If that request is refused or brings nothing, the list is read the plain way.
   */
  async function* watchLaterPages(run, asked) {
    const plain = { browseId: `VL${CONFIG.watchLaterId}` };
    if (CONFIG.showUnavailableParams) {
      let any = false;
      try {
        for await (const json of browsePages({ ...plain, params: CONFIG.showUnavailableParams }, run)) {
          if (!any && !parseItems(json).length) break;
          any = true;
          asked.hidden = true;
          yield json;
        }
      } catch (error) {
        if (any || isAbort(error)) throw error;
        log('asking for hidden videos failed; reading the list as the page shows it', error);
      }
      if (any) return;
    }
    yield* browsePages(plain, run);
  }

  /** Text as it is compared: no invisible marks, every kind of space a plain one, lower case. */
  const plain = (value) => String(value || '').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();

  /** Text with its odd spaces and invisible marks written out, for a message that has to show them. */
  const visible = (value) => String(value).replace(/[^\S ]|\p{Cf}/gu, (char) => `\\u{${char.codePointAt(0).toString(16)}}`);

  const AGE_UNITS = [['year', 365, 40], ['month', 30, 12], ['week', 7, 8], ['day', 1, 31], ['hour', 0, 23], ['minute', 0, 59], ['second', 0, 59]];

  /**
   * The ways the browser writes "3 years ago" in the page's language, spelled out and
   * abbreviated, each with the days it stands for. Longest first, so that "12 years ago"
   * is not taken for "2 years ago".
   */
  const agePhrases = new Map();
  function agePhrasesFor(language) {
    if (!agePhrases.has(language)) {
      const tag = String(language || '');
      const phrases = new Map();
      // The tag as given, then repaired ("en_GB"), then without its region, then the browser's own.
      for (const candidate of new Set([tag, tag.replace(/_/g, '-'), tag.split(/[-_]/)[0], navigator.language])) {
        for (const style of ['long', 'short', 'narrow']) {
          try {
            const relative = new Intl.RelativeTimeFormat(candidate, { numeric: 'always', style });
            for (const [unit, days, most] of AGE_UNITS) {
              for (let n = 1; n <= most; n++) {
                const phrase = plain(relative.format(-n, unit));
                if (!phrases.has(phrase)) phrases.set(phrase, n * days);
              }
            }
          } catch {
            // not a tag the browser knows, or a browser without this: the next is tried
          }
        }
      }
      agePhrases.set(language, [...phrases].sort((a, b) => b[0].length - a[0].length));
    }
    return agePhrases.get(language);
  }

  // English is read by its pattern, so that it does not depend on how this browser
  // happens to word or space it: "3 years ago", "3 yr. ago", "3y ago".
  const ENGLISH_AGE = /(?:^|\D)(\d+) ?(y|yrs?|years?|mos?|months?|w|wks?|weeks?|d|days?|h|hrs?|hours?|mins?|minutes?|secs?|seconds?)\.? ago/;
  const englishDays = (word) => (word[0] === 'y' ? 365 : word.startsWith('mo') ? 30 : word[0] === 'w' ? 7 : word[0] === 'd' ? 1 : 0);

  /**
   * How many days ago "3 years ago" was, or null if no age is found in the text. English
   * by pattern; any language, by the browser's own wording for the page's language.
   */
  const agesRead = new Map(); // the same texts come round on every keystroke
  function ageInDays(said, language) {
    const key = `${language}\n${said}`;
    if (!agesRead.has(key)) agesRead.set(key, readAge(plain(said), language));
    return agesRead.get(key);
  }
  function readAge(lower, language) {
    if (!/\p{Nd}/u.test(lower)) return null; // no number, no age
    const english = ENGLISH_AGE.exec(lower);
    if (english) return Number(english[1]) * englishDays(english[2]);
    const found = agePhrasesFor(language).find(([phrase]) => {
      const at = lower.indexOf(phrase);
      return at >= 0 && !/\p{Nd}/u.test(lower[at - 1] || ''); // "52 weeks ago" is not "2 weeks ago"
    });
    return found ? found[1] : null;
  }

  // ------------------------------------------------------------- removing
  // The only requests in this script that change anything are built and sent here.

  const EDIT_PATH = '/youtubei/v1/browse/edit_playlist';

  /**
   * The request that removes one row from Watch later, or null. It is built only from the
   * command the row's own menu carries, and only if that command is exactly a removal of
   * this one entry from Watch later, to be sent to the address YouTube uses for it.
   */
  function removalOf(row) {
    const command = row.remove;
    const edit = command?.playlistEditEndpoint;
    const actions = edit?.actions || [];
    if (command?.commandMetadata?.webCommandMetadata?.apiUrl !== EDIT_PATH) return null;
    if (edit.playlistId !== CONFIG.watchLaterId || actions.length !== 1) return null;
    if (actions[0].action !== 'ACTION_REMOVE_VIDEO' || !row.setVideoId || actions[0].setVideoId !== row.setVideoId) return null;
    return { playlistId: edit.playlistId, actions: [{ setVideoId: row.setVideoId, action: 'ACTION_REMOVE_VIDEO' }], ...(edit.params && { params: edit.params }) };
  }

  /**
   * Remove rows one at a time, in order. Stops at Stop, and at the first answer that is
   * not a plain success: after that nothing more is sent. Returns what happened.
   */
  async function removeRows(rows, run) {
    const removed = [];
    let failure = null;
    try {
      for (const row of rows) {
        run.report({ done: removed.length, total: rows.length, title: row.title });
        let answer;
        try {
          answer = await browse(removalOf(row), run, EDIT_PATH);
        } catch (error) {
          if (isAbort(error)) throw error;
          failure = { row, message: error.message || String(error) };
          break;
        }
        if (answer?.status !== 'STATUS_SUCCEEDED') {
          failure = { row, message: `YouTube answered "${answer?.status ?? 'without a status'}" where "STATUS_SUCCEEDED" was expected.` };
          break;
        }
        removed.push(row);
        run.report({ done: removed.length, total: rows.length, title: row.title });
        if (removed.length < rows.length) await sleep(CONFIG.requestDelayMs, run.signal);
      }
    } catch (error) {
      if (!isAbort(error)) throw error;
    }
    return { removed, failure, stopped: run.signal.aborted, left: rows.length - removed.length };
  }

  /** Settings this browser remembers for the page. A browser that refuses storage just forgets. */
  const remembered = {
    get: (name) => {
      try {
        return localStorage.getItem(`yt-playlists-export:${name}`);
      } catch {
        return null;
      }
    },
    set: (name, value) => {
      try {
        localStorage.setItem(`yt-playlists-export:${name}`, value);
      } catch {
        // not remembered, then
      }
    },
  };

  /** Is any condition of the rule filled in? An empty rule picks nothing. */
  const ruleIsSet = (filters) => Boolean(filters.channel.trim() || filters.title.trim() || Number(filters.age) > 0);

  /**
   * Which rows the filters pick. Each filter that is on adds its rows; inside the rule,
   * every condition that is filled in must hold. Returns the positions per filter, and
   * "noAge": the rows an age condition could not judge, because no age was found.
   */
  function chooseRows(rows, filters, language) {
    // Letters only: "beyonce" finds "Beyoncé", "CAFE" finds "café".
    const fold = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const has = (value, wanted) => fold(value).includes(fold(wanted.trim()));
    const minDays = Number(filters.age) > 0 ? Number(filters.age) * (filters.unit === 'months' ? 30 : 365) : 0;
    // The age is looked for in both texts, in case YouTube's line was not split as expected.
    const age = (row) => ageInDays(`${row.publishedText} ${row.viewsText}`, language);
    const ruleSet = ruleIsSet(filters);
    const picks = {
      watched: (row) => row.watchedPercent != null && row.watchedPercent >= Number(filters.percent),
      unavailable: (row) => !row.playable,
      rule: (row) =>
        ruleSet &&
        (!filters.channel.trim() || has(row.channel, filters.channel)) &&
        (!filters.title.trim() || has(row.title, filters.title)) &&
        (!minDays || (age(row) ?? -1) >= minDays),
    };
    const chosen = Object.fromEntries(Object.entries(picks).map(([name, pick]) => [name, new Set(rows.filter(pick).map((row) => row.position))]));
    return { ...chosen, noAge: minDays ? rows.filter((row) => age(row) == null) : [] };
  }

  // ----------------------------------------------------------------- output

  function summarize(data) {
    const lists = data.playlists;
    if (!data.withVideos) return `${plural(lists.length, 'playlist')}.`;
    const read = lists.filter((playlist) => playlist.videos);
    const videos = plural(read.reduce((sum, playlist) => sum + playlist.videos.length, 0), 'video');
    return data.complete
      ? `${plural(lists.length, 'playlist')}, ${videos}.`
      : `Stopped after ${read.length} of ${plural(lists.length, 'playlist')}, ${videos}. The files hold what was read so far.`;
  }

  /** Playlists worth a second look, as lines of text for the result view. */
  function findProblems(data) {
    const read = data.playlists.filter((playlist) => playlist.videos);
    return {
      failed: read
        .filter((playlist) => playlist.error)
        .map((playlist) => `${playlist.title}: ${playlist.error}`),
      short: read
        .filter((playlist) => !playlist.error && playlist.videoCount != null && playlist.videos.length < playlist.videoCount)
        .map((playlist) => `${playlist.title}: ${playlist.videos.length} of ${playlist.videoCount}`),
    };
  }

  /** "about 3 min left". Empty until there is enough history to make a fair guess. */
  function timeLeft({ startedAt, fraction }) {
    const elapsed = Date.now() - startedAt;
    if (elapsed < 5000 || fraction < 0.05 || fraction >= 1) return '';
    const seconds = (elapsed * (1 - fraction)) / fraction / 1000;
    return seconds < 50 ? 'less than a minute left' : `about ${Math.ceil(seconds / 60)} min left`;
  }

  /**
   * CSV text for spreadsheets. "fill" adds the rows, header first, and is handed "safe"
   * for free text. The JSON file is the complete, exact copy.
   */
  function toCsv(fill) {
    // Free text only: stops a spreadsheet running a title such as "=HYPERLINK(...)" as a
    // formula. Ids and links are left exactly as they are.
    const safe = (value) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
    const cell = (value) => {
      const string = String(value ?? '');
      return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
    };

    const rows = [];
    fill(rows, safe);
    // Every row gets the header's width. The leading BOM makes Excel read UTF-8.
    const width = rows[0].length;
    const line = (row) => Array.from({ length: width }, (_, i) => cell(row[i])).join(',');
    return `\ufeff${rows.map(line).join('\r\n')}\r\n`;
  }

  /** One row per video, or one per playlist when videos were not exported. */
  const playlistsCsv = (data) =>
    toCsv((rows, safe) => {
      if (data.withVideos) {
        rows.push(['playlist_id', 'playlist_title', 'position', 'video_id', 'video_title', 'channel', 'duration', 'video_url', 'views_text', 'published_text', 'duration_seconds', 'youtube_index', 'watched_percent', 'resume_seconds']);
        for (const playlist of data.playlists) {
          const head = [playlist.id, safe(playlist.title)];
          const videos = playlist.videos || [];
          if (!videos.length) rows.push(head); // keep empty, unread and unreadable playlists visible
          for (const video of videos) {
            rows.push([...head, video.position, video.videoId, safe(video.title), safe(video.channel), video.duration, video.url, safe(video.viewsText), safe(video.publishedText), video.durationSeconds, video.youtubeIndex, video.watchedPercent, video.resumeSeconds]);
          }
        }
      } else {
        rows.push(['playlist_id', 'playlist_title', 'type', 'video_count', 'owner', 'details', 'playlist_url']);
        for (const playlist of data.playlists) {
          rows.push([playlist.id, safe(playlist.title), playlist.type, playlist.videoCount, safe(playlist.owner), safe(playlist.details.join(' | ')), playlist.url]);
        }
      }
    });

  /** One row per item watched, newest first. */
  const historyCsv = (data) =>
    toCsv((rows, safe) => {
      rows.push(['position', 'watched_on', 'watched_on_text', 'kind', 'video_id', 'video_title', 'channel', 'duration', 'video_url', 'views_text', 'published_text', 'duration_seconds', 'watched_percent', 'resume_seconds']);
      for (const item of data.items) {
        rows.push([item.position, item.watchedOn, safe(item.watchedOnText), item.kind, item.videoId, safe(item.title), safe(item.channel), item.duration, item.url, safe(item.viewsText), safe(item.publishedText), item.durationSeconds, item.watchedPercent, item.resumeSeconds]);
      }
    });

  function summarizeHistory(data) {
    const shorts = data.items.filter((item) => item.kind === 'short').length;
    const days = new Set(data.items.map((item) => item.watchedOnText)).size;
    const line = `${plural(data.items.length, 'item')} from ${plural(days, 'day')}: ${plural(data.items.length - shorts, 'video')}, ${plural(shorts, 'Short')}.`;
    return data.complete ? line : `${line} It ended early because ${data.stopped}. The files hold what was read.`;
  }

  function dateStamp() {
    const now = new Date();
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  }

  // ------------------------------------------------------------------ modes
  // What the panel can export. Which one it offers depends on the page it is opened on.
  // Each mode says what to ask, how to collect it, and how to describe and write the result.

  const choice = (type, name, value, title, hint, checked = false) =>
    h('label', {}, h('input', { type, name, value, checked }), ` ${title}`, hint ? h('small', {}, hint) : null);

  const MODES = {
    playlists: {
      applies: () => location.pathname === CONFIG.feedPath,
      title: 'Export playlists',
      go: 'Export',
      filePrefix: CONFIG.filePrefix,
      fields: () => [
        choice('radio', 'scope', 'playlists', 'Playlists only', 'Title, link and video count of each playlist.', true),
        choice('radio', 'scope', 'videos', 'Playlists and their videos', 'Also every video in every playlist. Takes longer.'),
      ],
      read: (form) => ({ withVideos: form.elements.scope.value === 'videos' }),
      showsCurrent: (chosen) => chosen.withVideos, // the progress view names the playlist being read
      collect: (chosen, run) => collect(chosen.withVideos, run),
      summarize,
      problems(data) {
        const { failed, short } = findProblems(data);
        return [
          { label: `${plural(failed.length, 'playlist')} could not be read`, lines: failed },
          { label: `${plural(short.length, 'playlist')} gave fewer videos than YouTube counts (usually hidden or unavailable ones)`, lines: short },
        ];
      },
      csv: playlistsCsv,
    },
    history: {
      applies: () => location.pathname === CONFIG.historyPath,
      title: 'Export history',
      go: 'Export',
      filePrefix: CONFIG.historyFilePrefix,
      fields: () => [
        choice('radio', 'range', '7', 'Last 7 days', 'Today and the six days before it.', true),
        choice('radio', 'range', '30', 'Last 30 days'),
        choice('radio', 'range', '0', 'Everything', 'As far back as YouTube keeps it. Can take a long time; Stop keeps what was read.'),
        choice('checkbox', 'shorts', 'on', 'Include Shorts', '', true),
      ],
      read: (form) => ({ days: Number(form.elements.range.value), shorts: form.elements.shorts.checked }),
      showsCurrent: () => false,
      collect: collectHistory,
      summarize: summarizeHistory,
      problems(data) {
        const unread = Object.entries(data.skipped);
        return [
          { label: `${plural(data.undated.length, 'heading')} could not be read as a date (kept as text)`, lines: data.undated },
          { label: `${plural(unread.reduce((sum, [, count]) => sum + count, 0), 'item')} of a kind this exporter does not read`, lines: unread.map(([type, count]) => `${type}: ${count}`) },
        ];
      },
      csv: historyCsv,
    },
    // Reads Watch later and lets videos be ticked for removal. Reading changes nothing;
    // removing is a separate step in the panel that has to be allowed and confirmed.
    tidy: {
      applies: () => location.pathname === '/playlist' && new URLSearchParams(location.search).get('list') === CONFIG.watchLaterId,
      title: 'Tidy Watch later',
      go: 'Read the list',
      filePrefix: CONFIG.watchLaterFilePrefix,
      fields: () => [h('p', {}, 'Reads your Watch later list, then lets you tick videos to remove: by how much you have watched, by rule, or by hand.'), h('p', { class: 'note muted' }, 'Reading changes nothing. Removing has to be allowed first, and asks before it starts.')],
      read: () => ({}),
      showsCurrent: () => false,
      collect: collectWatchLater,
      selects: true, // its result is a list to tick, not files to download
    },
  };
  /** The mode that belongs to the page the panel is on; playlists when the page has none. */
  const modeOfPage = () => Object.values(MODES).find((candidate) => candidate.applies());
  const modeHere = () => modeOfPage() || MODES.playlists;

  // --------------------------------------------------------------------- UI

  const STYLE = `
    :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 3000; }
    [hidden] { display: none !important; }
    .box { --bg: #fff; --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,.15);
      --accent: #065fd4; --on-accent: #fff; --error: #c5221f; --track: rgba(255,255,255,.8); color-scheme: light;
      font: 14px/1.45 Roboto, Arial, sans-serif; color: var(--fg); }
    .box.dark { --bg: #212121; --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,.2);
      --accent: #3ea6ff; --on-accent: #0f0f0f; --error: #ff8a80; --track: rgba(0,0,0,.6); color-scheme: dark; }
    button, .download { font: inherit; cursor: pointer; display: inline-block; padding: 8px 16px;
      border: 1px solid var(--line); border-radius: 18px; background: var(--bg); color: var(--fg);
      text-decoration: none; }
    .primary, .download { background: var(--accent); color: var(--on-accent);
      border-color: transparent; font-weight: 500; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .launcher { box-shadow: 0 2px 8px rgba(0,0,0,.3); font-variant-numeric: tabular-nums; }
    .panel { width: 320px; max-height: calc(100vh - 32px); overflow-y: auto; box-sizing: border-box; padding: 16px; background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.35); }
    header, .split { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    header { align-items: center; margin-bottom: 12px; }
    h2 { margin: 0; font-size: 16px; font-weight: 500; }
    .close { border: 0; padding: 2px 10px; font-size: 20px; line-height: 1.2; }
    label { display: block; margin: 8px 0; cursor: pointer; }
    small { display: block; margin-left: 24px; color: var(--muted); }
    p { margin: 0; overflow-wrap: anywhere; }
    .error { color: var(--error); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    /* Progress: every line keeps its height, so nothing jumps as the text changes. */
    .headline { font-weight: 500; }
    .muted { color: var(--muted); font-variant-numeric: tabular-nums; }
    progress { display: block; width: 100%; height: 6px; margin: 8px 0; accent-color: var(--accent); }
    .current { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.45em; }
    .note { font-size: 12px; min-height: 1.45em; }
    /* Pictures sit in tiles of a fixed size: the layout is the same with or without them. */
    .picture { flex: none; position: relative; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: var(--line); }
    /* Same colours as the main bar; the track is light or dark with the theme, so the
       line stands out from the picture above it and from the panel around it. */
    .meter { position: absolute; inset: auto 0 0; height: 4px; background: var(--track); }
    .meter div { height: 100%; background: var(--accent); }
    .picture img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .now { display: flex; align-items: center; gap: 10px; }
    .now .picture { width: ${CONFIG.coverWidth}px; }
    .now div:last-child { flex: 1; min-width: 0; }
    .strip { display: grid; grid-template-columns: repeat(${CONFIG.recentPictures}, 1fr); gap: 6px; margin: 8px 0 6px; }
    details { margin-top: 10px; }
    summary { cursor: pointer; }
    ul { margin: 6px 0 0; padding-left: 18px; max-height: 110px; overflow: auto; color: var(--muted); }
    li { overflow-wrap: anywhere; }
    /* The list to tick, for a tidy-up. It needs more room than the export views. */
    .panel.wide { width: min(600px, calc(100vw - 32px)); }
    .filter { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
    .filter label { display: inline; margin: 0; }
    .filter input[type="text"], .filter input[type="number"], .filter select { font: inherit; color: inherit; background: var(--bg);
      border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
    .filter input[type="number"] { width: 4.5em; }
    .filter input[type="text"] { width: 8.5em; }
    .pick { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; }
    .pick span { display: flex; gap: 6px; }
    .pick button { padding: 3px 12px; font-size: 13px; }
    .rows { max-height: 36vh; overflow: auto; margin: 8px 0 10px; border: 1px solid var(--line); border-radius: 8px; }
    .row { display: flex; align-items: baseline; gap: 8px; margin: 0; padding: 6px 10px; }
    .row + .row { border-top: 1px solid var(--line); }
    .row div { flex: 1; min-width: 0; }
    .row p { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gone { color: var(--error); }
    .danger { border-color: var(--error); color: var(--error); font-weight: 500; }
    .danger:disabled { opacity: .5; cursor: default; }
    label.note { min-height: 0; }
  `;

  function addStyle(root, css) {
    try {
      // Not affected by a page's rules about inline styles.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      root.append(h('style', {}, css));
    }
  }

  function createUi() {
    let running = null; // { label, refresh } while an export runs; the label goes on the launcher
    let notice = ''; // launcher text when an export ended while the panel was closed
    let blobUrls = [];
    let mode = MODES.playlists; // what the panel is offering, exporting or showing the result of
    let offering = false; // the options are up, so the mode can still follow the page

    // A shadow root keeps YouTube's styles out of the panel and ours out of YouTube.
    const host = h('div', { id: 'yt-playlists-export' });
    const shadow = host.attachShadow({ mode: 'open' });
    addStyle(shadow, STYLE);

    const body = h('div');
    const heading = h('h2');
    const launcher = h('button', { class: 'launcher primary', type: 'button', hidden: true, onclick: open });
    const panel = h(
      'section',
      { class: 'panel', hidden: true, role: 'dialog' },
      h('header', {}, heading, h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
      body,
    );
    const box = h('div', { class: 'box' }, launcher, panel);
    shadow.append(box);
    document.body.append(host);

    // Keep keys and clicks in the panel away from YouTube's own handlers. From outside a
    // shadow root they look like they hit a plain <div>, so Space would play or pause.
    for (const type of ['keydown', 'keyup', 'keypress', 'click']) {
      panel.addEventListener(type, (event) => event.stopPropagation());
    }
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    document.addEventListener('visibilitychange', () => running?.refresh());

    const focusFirst = () => body.querySelector('input:checked, a, button')?.focus();

    /** Swap the panel's content. Focus follows only if it already was in the panel. */
    function show(...nodes) {
      const hadFocus = Boolean(shadow.activeElement);
      body.replaceChildren(...nodes.filter(Boolean));
      if (hadFocus) focusFirst();
    }

    /** Offer what can be exported from the page the panel is on. */
    function showOptions() {
      for (const url of blobUrls) URL.revokeObjectURL(url);
      blobUrls = [];
      mode = modeHere();
      offering = true;
      setText(heading, mode.title);
      panel.setAttribute('aria-label', mode.title);
      const chosen = mode;
      const form = h(
        'form',
        {
          onsubmit: (event) => {
            event.preventDefault();
            start(chosen, chosen.read(form));
          },
        },
        ...chosen.fields(),
        h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, chosen.go)),
      );
      panel.classList.remove('wide');
      show(form);
    }

    /** Hand over a file made on the spot, in answer to a click. */
    function saveFile(name, type, content) {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const link = h('a', { href: url, download: name, hidden: true });
      shadow.append(link); // some browsers only follow a link that is in the page
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    /**
     * The list to tick. Filters tick rows for you; a tick or untick made by hand stays as
     * it is whatever the filters say afterwards. Filling in the rule switches it on, and
     * emptying it switches it off. Removing is offered only once it has been allowed, and
     * then goes through a question of its own (confirmRemoval).
     */
    function showSelection(chosen, data) {
      const language = ytcfg('HL') || navigator.language || 'en';
      const byHand = new Map(); // position -> ticked, for rows the user set themselves
      let chosenByFilters = new Set();
      const rows = data.rows;

      const field = (props) => h('input', props);
      const filters = {
        watched: field({ type: 'checkbox', name: 'watched' }),
        percent: field({ type: 'number', name: 'percent', min: 1, max: 100, value: 90, 'aria-label': 'Percent watched' }),
        unavailable: field({ type: 'checkbox', name: 'unavailable' }),
        rule: field({ type: 'checkbox', name: 'rule' }),
        channel: field({ type: 'text', name: 'channel', 'aria-label': 'Channel contains' }),
        title: field({ type: 'text', name: 'title', 'aria-label': 'Title contains' }),
        age: field({ type: 'number', name: 'age', min: 0, 'aria-label': 'Published at least this long ago' }),
        unit: h('select', { name: 'unit', 'aria-label': 'Years or months' }, h('option', { value: 'years' }, 'years'), h('option', { value: 'months' }, 'months')),
      };
      const counts = { watched: h('span', { class: 'muted' }), unavailable: h('span', { class: 'muted' }), rule: h('span', { class: 'muted' }) };
      const total = h('p', { role: 'status' });
      const ruleNote = h('p', { class: 'note muted', hidden: true }); // what an age condition could not judge
      let logged = false;

      const boxes = rows.map((row) => {
        const box = field({ type: 'checkbox', onchange: () => { byHand.set(row.position, box.checked); count(); } });
        return box;
      });
      const facts = (row) =>
        [row.channel, row.duration, row.watchedPercent != null && `watched ${row.watchedPercent}%`, row.publishedText || row.viewsText].filter(Boolean).join(' · ');
      const list = h(
        'div',
        { class: 'rows', role: 'group', 'aria-label': 'Videos in Watch later' },
        ...rows.map((row, i) =>
          h('label', { class: 'row' }, boxes[i], h('div', {}, h('p', { title: row.title }, `${row.position}. ${row.title}`), h('p', { class: 'note muted' }, row.playable ? null : h('span', { class: 'gone' }, 'unavailable '), facts(row)))),
        ),
      );

      const ticked = () => rows.filter((row, i) => boxes[i].checked);
      const allow = field({ type: 'checkbox', name: 'allow', checked: remembered.get('removal') === 'on' });
      const removeButton = h('button', { type: 'button', class: 'danger', onclick: () => confirmRemoval(chosen, data, ticked(), view) });
      function count() {
        setText(total, `${ticked().length.toLocaleString()} of ${plural(rows.length, 'video')} ticked.`);
        setText(removeButton, `Remove ${ticked().length.toLocaleString()} ticked…`);
        removeButton.hidden = !allow.checked;
        removeButton.disabled = !ticked().length;
      }
      allow.addEventListener('change', () => {
        remembered.set('removal', allow.checked ? 'on' : 'off');
        count();
      });
      const settings = () => ({ percent: filters.percent.value, channel: filters.channel.value, title: filters.title.value, age: filters.age.value, unit: filters.unit.value });
      function apply() {
        const picked = chooseRows(rows, settings(), language);
        for (const name of Object.keys(counts)) setText(counts[name], `(${picked[name].size.toLocaleString()})`);
        // The rule says why it picks nothing, rather than a bare "(0)".
        if (!ruleIsSet(settings())) setText(counts.rule, '(fill in at least one box)');
        // Rows whose age was not found are left alone, and said so, with what was there to read.
        const unaged = picked.noAge;
        ruleNote.hidden = !unaged.length;
        if (unaged.length) {
          const lines = unaged.map((row) => [row.viewsText, row.publishedText].filter(Boolean).join(' • ')).filter(Boolean);
          const them = unaged.length === 1 ? 'it' : 'them';
          setText(
            ruleNote,
            `No age found on ${plural(unaged.length, 'video')}, so the age condition leaves ${them} unticked. ` +
              (lines.length ? `For example, YouTube's line for one reads “${visible(lines[0])}”.` : `YouTube sent no views or age for ${them}.`),
          );
          if (!logged) log('no age found', { language, rows: unaged.length, examples: lines.slice(0, 5).map(visible), browserSays: agePhrasesFor(language).slice(0, 3).map(([phrase]) => phrase) });
          logged = true;
        }
        chosenByFilters = new Set(Object.keys(counts).flatMap((name) => (filters[name].checked ? [...picked[name]] : [])));
        rows.forEach((row, i) => {
          boxes[i].checked = byHand.has(row.position) ? byHand.get(row.position) : chosenByFilters.has(row.position);
        });
        count();
      }
      const untick = () => {
        for (const name of Object.keys(counts)) filters[name].checked = false;
        byHand.clear();
        apply();
      };
      const tickAll = () => {
        for (const row of rows) byHand.set(row.position, true);
        apply();
      };
      // Typing a condition is asking for the rule: its tick box follows what is filled in.
      const conditions = [filters.channel, filters.title, filters.age];
      const changed = (event) => {
        if (event.type === 'input' && conditions.includes(event.target)) filters.rule.checked = ruleIsSet(settings());
        apply();
      };

      const save = (extension, type, write) => () => {
        const videos = ticked().map(({ remove, ...video }) => video); // the command stays here; the file is for reading
        saveFile(`${chosen.filePrefix}-${dateStamp()}.${extension}`, type, write({ schema: 'youtube-watch-later-ticked/1', exportedAt: new Date().toISOString(), source: data.source, videos }));
      };
      const tickedCsv = (file) =>
        toCsv((lines, safe) => {
          lines.push(['position', 'video_id', 'video_title', 'channel', 'duration', 'watched_percent', 'published_text', 'playable', 'entry_id', 'video_url']);
          for (const video of file.videos) lines.push([video.position, video.videoId, safe(video.title), safe(video.channel), video.duration, video.watchedPercent, safe(video.publishedText), video.playable, video.setVideoId, video.url]);
        });

      const removable = rows.filter((row) => removalOf(row)).length;
      const controls = h(
        'form',
        { oninput: changed, onchange: changed, onsubmit: (event) => event.preventDefault() },
        h('div', { class: 'filter' }, h('label', {}, filters.watched, ' Watched at least'), filters.percent, '%', counts.watched),
        h('div', { class: 'filter' }, h('label', {}, filters.unavailable, ' Unavailable'), counts.unavailable),
        h('div', { class: 'filter' }, h('label', {}, filters.rule, ' Rule:'), 'channel has', filters.channel, 'title has', filters.title, 'published at least', filters.age, filters.unit, 'ago', counts.rule),
        ruleNote,
      );
      offering = false;
      panel.classList.add('wide');
      const view = [
        h('p', {}, `${plural(rows.length, 'video')} in Watch later. Tick the ones to remove.`),
        data.notice ? h('p', { class: 'note muted' }, `YouTube says: ${data.notice}`) : null,
        data.askedForHidden ? null : h('p', { class: 'note muted' }, 'YouTube would not list the videos it hides (deleted or private ones), so they are not here.'),
        controls,
        h('div', { class: 'pick' }, total, h('span', {}, h('button', { type: 'button', onclick: tickAll }, 'Tick all'), h('button', { type: 'button', onclick: untick }, 'Untick all'))),
        list,
        h('label', { class: 'note' }, allow, ' Allow this script to remove videos from Watch later'),
        h('p', { class: 'note muted' }, `Nothing is removed until you allow it, press Remove and confirm. ${removable.toLocaleString()} of ${rows.length.toLocaleString()} rows carry YouTube's own remove command.`),
        h(
          'div',
          { class: 'actions' },
          removeButton,
          h('button', { class: 'primary', type: 'button', onclick: save('json', 'application/json', (file) => JSON.stringify(file, null, 2)) }, 'Save ticked as JSON'),
          h('button', { type: 'button', onclick: save('csv', 'text/csv;charset=utf-8', tickedCsv) }, 'Save ticked as CSV'),
          h('button', { type: 'button', onclick: showOptions }, 'Back'),
        ),
      ];
      show(...view);
      apply();
    }

    /**
     * The question before anything is removed. It says how many, names the first few, and
     * what cannot be undone. Until one removal has worked in this browser, a run removes
     * a single video, so that the result can be checked on the page first.
     */
    function confirmRemoval(chosen, data, wanted, back) {
      const able = wanted.filter((row) => removalOf(row));
      const unable = wanted.length - able.length;
      const firstRun = remembered.get('removed-once') !== 'yes';
      const going = firstRun ? able.slice(0, 1) : able;
      const names = going.slice(0, 5).map((row) => h('li', {}, `${row.position}. ${row.title}`));
      if (going.length > 5) names.push(h('li', {}, `and ${plural(going.length - 5, 'other')}`));
      show(
        h('p', { class: 'headline' }, going.length ? `Remove ${plural(going.length, 'video')} from Watch later?` : 'None of the ticked videos can be removed.'),
        going.length ? h('ul', {}, ...names) : null,
        firstRun && able.length > 1 ? h('p', {}, `First run: only the first of the ${able.length.toLocaleString()} ticked is removed, so you can check on the page that it is gone. Later runs remove everything ticked.`) : null,
        unable ? h('p', { class: 'note muted' }, `${plural(unable, 'ticked video')} cannot be removed: YouTube's remove command for ${unable === 1 ? 'it' : 'them'} was not found as expected.`) : null,
        going.length ? h('p', { class: 'note muted' }, 'YouTube has no undo for this. A file listing what is about to go is saved first, so it can be added back by hand.') : null,
        h(
          'div',
          { class: 'actions' },
          going.length ? h('button', { type: 'button', class: 'danger', onclick: () => runRemoval(chosen, data, going) }, `Remove ${plural(going.length, 'video')}`) : null,
          h('button', { type: 'button', onclick: () => show(...back) }, 'Cancel'),
        ),
      );
    }

    async function runRemoval(chosen, data, going) {
      const listed = going.map(({ remove, ...video }) => video);
      saveFile(`youtube-watch-later-removed-${dateStamp()}.json`, 'application/json', JSON.stringify({ schema: 'youtube-watch-later-removal/1', startedAt: new Date().toISOString(), source: data.source, videos: listed }, null, 2));

      const controller = new AbortController();
      const headline = h('p', { class: 'headline', role: 'status' });
      const bar = h('progress', { max: going.length, value: 0, 'aria-label': 'Removal progress' });
      const current = h('p', { class: 'current' });
      const note = h('p', { class: 'note muted' });
      const stop = h('button', { type: 'button', onclick: () => controller.abort() }, 'Stop');
      show(headline, bar, current, note, h('div', { class: 'actions' }, stop));
      const run = {
        signal: controller.signal,
        report(patch) {
          if (patch.total) {
            setText(headline, `Removing ${Math.min(patch.done + 1, patch.total).toLocaleString()} of ${patch.total.toLocaleString()}`);
            bar.value = patch.done;
            setText(current, patch.title);
            running.label = `Removing ${patch.done.toLocaleString()}/${patch.total.toLocaleString()}`;
          }
          if ('waiting' in patch) setText(note, patch.waiting ? `YouTube asked to slow down. Waiting ${patch.waiting} s.` : '');
          sync();
        },
      };
      running = { label: 'Removing…', refresh: () => {} };
      let outcome;
      try {
        outcome = await removeRows(going, run);
      } finally {
        running = null;
        sync();
      }
      if (outcome.removed.length) remembered.set('removed-once', 'yes');
      const { removed, failure, stopped, left } = outcome;
      show(
        h('p', { class: 'headline', role: 'status' }, `Removed ${removed.length.toLocaleString()} of ${plural(going.length, 'video')}.`),
        failure ? h('p', { class: 'error', role: 'alert' }, `Stopped at ${failure.row.position}. ${failure.row.title}: ${failure.message} Nothing was sent after it.`) : null,
        stopped && !failure ? h('p', {}, `Stopped by you. ${plural(left, 'video')} left as ${left === 1 ? 'it was' : 'they were'}.`) : null,
        removed.length ? h('p', { class: 'note muted' }, 'Reload the Watch later page to see the list without them.') : null,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', type: 'button', onclick: () => start(chosen, {}) }, 'Read the list again'),
          h('button', { type: 'button', onclick: showOptions }, 'Back'),
        ),
      );
      if (panel.hidden) notice = failure ? 'Removal stopped' : 'Removal done';
      sync();
    }

    // Pictures fetched ahead of being shown, by address. A picture that is already here
    // appears the moment a tile asks for it, so several tiles can change in one frame. Only
    // the newest few are held on to; a tile keeps its own picture alive once it shows it.
    const fetched = new Map();

    /** Download and decode a picture without showing it. Settles when it is ready or failed. */
    function preload(url) {
      if (!url) return Promise.resolve();
      if (!fetched.has(url)) {
        const image = new Image();
        image.fetchPriority = 'low'; // the export's own requests go first
        image.src = url;
        const loaded = image.decode
          ? image.decode()
          : new Promise((resolve, reject) => Object.assign(image, { onload: resolve, onerror: reject }));
        fetched.set(url, { image, done: loaded.catch(() => {}) });
        if (fetched.size > 12) fetched.delete(fetched.keys().next().value);
      }
      return fetched.get(url).done;
    }

    /** A picture slot: a plain tile until its image has loaded, or when there is none. */
    function picture() {
      // alt is empty on purpose: the title next to the picture already names it.
      // decoding sync: tiles that change together are painted together.
      const img = h('img', { alt: '', hidden: true, decoding: 'sync', fetchPriority: 'low', onerror: () => (img.hidden = true) });
      let shown = '';
      return {
        tile: h('div', { class: 'picture' }, img),
        set(url = '') {
          if (url === shown) return;
          shown = url;
          img.hidden = !url;
          if (url) img.src = url;
        },
      };
    }

    /** Build the progress view. Returns the function that redraws it from the state. */
    function showProgress(showsCurrent, onStop) {
      // Only the headline is announced by screen readers, and it changes once per playlist
      // or, in the history, once per day.
      const headline = h('p', { class: 'headline', role: 'status' });
      const percent = h('span', { class: 'muted' });
      const bar = h('progress', { max: 1, 'aria-label': 'Export progress' }); // no value yet: "busy"
      const cover = picture();
      // The current playlist's own progress: a thin line along the bottom of its cover, the
      // way YouTube marks how far a video was watched. The text beside it says the same.
      const fill = h('div');
      const meter = h('div', { class: 'meter', hidden: true }, fill);
      cover.tile.append(meter);
      const current = h('p', { class: 'current' });
      const size = h('p', { class: 'note muted' });
      const strip = Array.from({ length: CONFIG.recentPictures }, picture);
      const note = h('p', { class: 'note muted' });

      // The strip changes as a whole: a new set is fetched first and put up only once every
      // picture in it is here. Otherwise the pictures already seen would move along at once
      // and the new one would turn up late. Sets go up in the order they were asked for.
      let asked = '';
      let turn = 0;
      let shownTurn = 0;
      function showStrip(urls) {
        const key = urls.join(' ');
        if (key === asked) return;
        asked = key;
        const mine = ++turn;
        Promise.all(urls.map(preload)).then(() => {
          if (mine < shownTurn) return; // a newer set is already up
          shownTurn = mine;
          strip.forEach((slot, i) => slot.set(urls[i]));
        });
      }

      show(
        h('div', { class: 'split' }, headline, percent),
        bar,
        // The playlist being read: its cover, title and size. Not needed for a list-only export.
        showsCurrent ? h('div', { class: 'now' }, CONFIG.pictures ? cover.tile : null, h('div', {}, current, size)) : null,
        // A few of the items read lately: playlist covers first, then videos.
        CONFIG.pictures ? h('div', { class: 'strip' }, ...strip.map((slot) => slot.tile)) : null,
        note,
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: onStop }, 'Stop')),
      );

      return (state) => {
        const pause = state.waiting && `YouTube asked for a pause. Trying again in ${state.waiting} s…`;
        // Pictures are fetched only while someone can see them. open() and the tab coming
        // back into view redraw, so they catch up then.
        if (CONFIG.pictures && !panel.hidden && !document.hidden) {
          showStrip(state.pictures);
          cover.set(state.cover);
          preload(state.nextCover); // so the next cover can change together with its title
        }
        if (state.phase === 'videos') {
          const share = `${Math.floor(state.fraction * 100)}%`;
          const facts = [`${state.videos.toLocaleString()} videos so far`, state.failed && `${state.failed} failed`, timeLeft(state)];
          bar.value = state.fraction;
          setText(headline, `Playlist ${state.index + 1} of ${state.total}`);
          setText(percent, share);
          setText(current, state.title);
          current.title = state.title; // the full title on hover when it is cut short
          // "300 of 743 videos" when YouTube's count is known and holds; else what was read.
          const counted = state.declared != null && state.read <= state.declared;
          const read = state.read ? plural(state.read, 'video') : '';
          setText(size, counted ? `${state.read.toLocaleString()} of ${plural(state.declared, 'video')}` : read);
          meter.hidden = !counted;
          fill.style.width = `${counted && state.declared ? (state.read / state.declared) * 100 : 0}%`;
          setText(note, pause || facts.filter(Boolean).join(' · '));
          running.label = `Exporting… ${share}`;
        } else if (state.phase === 'history') {
          // A range of days has an end to measure against; "everything" has none.
          const ranged = state.fraction != null;
          const share = ranged ? `${Math.floor(state.fraction * 100)}%` : '';
          if (ranged) bar.value = state.fraction;
          else bar.removeAttribute('value');
          setText(headline, state.day ? `History: ${state.day}` : state.label);
          setText(percent, share);
          setText(note, pause || [`${state.items.toLocaleString()} items so far`, timeLeft(state)].filter(Boolean).join(' · '));
          running.label = `Exporting… ${ranged ? share : state.items.toLocaleString()}`;
        } else {
          setText(headline, state.label);
          setText(note, pause || `${state.found} found`);
          running.label = `Reading… ${state.found.toLocaleString()}`;
        }
      };
    }

    async function start(chosen, wanted) {
      offering = false;
      const controller = new AbortController();
      const state = {};
      const redraw = showProgress(chosen.showsCurrent(wanted), () => controller.abort());
      running = { label: 'Exporting…', refresh: () => state.phase && redraw(state) };
      const run = {
        signal: controller.signal,
        report(patch) {
          redraw(Object.assign(state, patch));
          sync();
        },
      };
      try {
        const data = await chosen.collect(wanted, run);
        if (chosen.selects) showSelection(chosen, data);
        else showResult(chosen, data);
        if (panel.hidden) notice = chosen.selects ? 'List ready' : 'Export ready';
      } catch (error) {
        if (isAbort(error)) {
          showOptions();
        } else {
          log(error);
          show(
            h('p', { class: 'error', role: 'alert' }, error.message || String(error)),
            h('div', { class: 'actions' }, h('button', { type: 'button', onclick: showOptions }, 'Back')),
          );
          if (panel.hidden) notice = 'Export failed';
        }
      } finally {
        running = null;
        sync();
      }
    }

    function showResult(chosen, data) {
      // Real links: each download is a plain click, so the browser never blocks it.
      const download = (label, extension, type, content) => {
        const url = URL.createObjectURL(new Blob([content], { type }));
        blobUrls.push(url);
        return h('a', { class: 'download', href: url, download: `${chosen.filePrefix}-${dateStamp()}.${extension}` }, label);
      };
      // Things worth a second look, each as a list that opens.
      const list = ({ label, lines }) =>
        lines.length ? h('details', {}, h('summary', {}, label), h('ul', {}, ...lines.map((line) => h('li', {}, line)))) : null;
      show(
        h('p', { role: 'status' }, chosen.summarize(data)),
        ...chosen.problems(data).map(list),
        h(
          'div',
          { class: 'actions' },
          download('Download JSON', 'json', 'application/json', JSON.stringify(data, null, 2)),
          download('Download CSV', 'csv', 'text/csv;charset=utf-8', chosen.csv(data)),
          h('button', { type: 'button', onclick: showOptions }, 'Export again'),
        ),
      );
    }

    /**
     * The launcher shows while the panel is closed: always during an export (with its
     * progress) and after one ended unseen; otherwise only on the pages that have a mode.
     */
    function sync() {
      const here = modeOfPage();
      setText(launcher, running ? running.label : notice || (here || MODES.playlists).title);
      const wanted = running || notice || (IS_USERSCRIPT && here);
      launcher.hidden = !(panel.hidden && wanted);
    }

    function open() {
      box.classList.toggle('dark', document.documentElement.hasAttribute('dark'));
      notice = '';
      panel.hidden = false;
      sync();
      running?.refresh();
      // Options follow the page: opened on the history page they offer the history.
      if (!body.hasChildNodes() || (offering && mode !== modeHere())) showOptions();
      focusFirst();
    }

    /** Closing never stops an export: it carries on behind the launcher. Stop does that. */
    function close() {
      panel.hidden = true;
      sync();
      if (!launcher.hidden) launcher.focus();
    }

    return { open, close, sync };
  }

  // ------------------------------------------------------------------- boot

  const ui = createUi();
  window[GLOBAL] = { open: ui.open, close: ui.close };
  if (IS_USERSCRIPT) {
    window.addEventListener('yt-navigate-finish', ui.sync); // YouTube's in-page navigation
    ui.sync();
  } else {
    ui.open();
  }
})();
