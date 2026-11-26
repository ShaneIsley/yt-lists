// End-to-end tests in jsdom: the real script and the built bookmarklet, a mock of
// YouTube's browse API in both data layouts, and the panel driven through its buttons.
// Usage: node build.mjs && node test/run.mjs
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { SID, USER, YTCFG, createMockApi, daysAgo, historyHeadings } from './fixtures.mjs';

const ROOT = new URL('../', import.meta.url);
const userscript = await readFile(new URL('youtube-playlists-export.user.js', ROOT), 'utf8');
const bookmarkletUrl = (await readFile(new URL('youtube-playlists-export.bookmarklet.txt', ROOT), 'utf8')).trim();
const bookmarklet = decodeURIComponent(bookmarkletUrl.slice('javascript:'.length));
const probe = await readFile(new URL('youtube-browse-probe.console.js', ROOT), 'utf8');
const historyProbe = await readFile(new URL('youtube-history-probe.console.js', ROOT), 'utf8');

const FEED_URL = 'https://www.youtube.com/feed/playlists';
const HISTORY_URL = 'https://www.youtube.com/feed/history';
const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot({ url = FEED_URL, source = userscript, userscriptMode = true, signedIn = true, feedStatus = 200, html = '', latencyMs = 0, pictureMs = 20, brokenPictures = /never/, olderHistory = false, now = null, prepare = null } = {}) {
  const virtualConsole = new VirtualConsole(); // keep jsdom noise out of the test output
  const logs = []; // what the page wrote with console.log and console.error
  for (const level of ['log', 'error']) virtualConsole.on(level, (...args) => logs.push(args.join(' ')));
  let reshape = (json) => json; // lets a test stand in for YouTube changing its data
  const dom = new JSDOM(`<!doctype html><html dark><body>${html}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const api = createMockApi({ feedStatus, olderHistory, now: now || new Date() });
  if (now) {
    // Give the page a clock of our choosing: "now" stands still at the given moment.
    const RealDate = window.Date;
    window.Date = class extends RealDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(now.getTime());
      }

      static now() {
        return now.getTime();
      }
    };
  }
  const blobs = [];

  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  window.TextEncoder = TextEncoder;
  window.scrollTo = () => {};
  // jsdom downloads no pictures. Stand in for the browser: a picture fetched ahead is
  // ready (or has failed) pictureMs after it was asked for.
  const images = [];
  window.Image = function Image() {
    const img = window.document.createElement('img');
    const record = { img, done: false };
    images.push(record);
    img.decode = () =>
      new Promise((resolve, reject) => {
        setTimeout(() => {
          record.done = true;
          if (brokenPictures.test(img.src)) reject(new Error('broken picture'));
          else resolve();
        }, pictureMs);
      });
    return img;
  };
  window.Blob = class {
    constructor(parts, options) {
      this.text = parts.join('');
      this.type = options?.type;
    }
  };
  window.URL.createObjectURL = (blob) => `blob:test/${blobs.push(blob)}`;
  window.URL.revokeObjectURL = () => {};
  if (userscriptMode) window.GM_info = { script: { name: 'test' } };
  if (signedIn) {
    window.document.cookie = `SAPISID=${SID}; Secure`;
    window.document.cookie = `__Secure-3PAPISID=${SID}; Secure`;
  }
  window.ytcfg = { get: (key) => YTCFG[key] };

  window.fetch = async (path, init) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const body = JSON.parse(init.body);

    // The request must look like the page's own.
    const editing = path === '/youtubei/v1/browse/edit_playlist?prettyPrint=false';
    if (!editing) assert.equal(path, '/youtubei/v1/browse?prettyPrint=false');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.deepEqual(body.context, YTCFG.INNERTUBE_CONTEXT);
    assert.equal(init.headers['X-Origin'], 'https://www.youtube.com');
    assert.equal(init.headers['X-Goog-AuthUser'], '0');
    assert.equal(init.headers['X-Goog-PageId'], undefined);
    const [scheme, token, ...rest] = init.headers.Authorization.split(' ');
    const [time, hash, flag] = token.split('_');
    assert.equal(scheme, 'SAPISIDHASH');
    assert.equal(hash, sha1(`${USER} ${time} ${SID} https://www.youtube.com`));
    assert.equal(flag, 'u');
    assert.deepEqual(rest.filter((_, i) => i % 2 === 0), ['SAPISID3PHASH']);
    if (!now) assert.ok(Math.abs(Date.now() / 1000 - Number(time)) < 5);

    const { status, json } = editing ? api.edit(body) : api.respond(body);
    if (latencyMs) await pause(latencyMs);
    if (init.signal?.aborted) throw init.signal.reason;
    return { ok: status >= 200 && status < 300, status, json: async () => reshape(json) };
  };

  if (prepare) prepare(window); // a test's own changes to the page, before the script sees it
  window.eval(source);
  const root = window.document.getElementById('yt-playlists-export').shadowRoot;
  const $ = (selector) => root.querySelector(selector);
  const button = (label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);
  const until = async (test, label, ms = 30000) => {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label}; panel says: ${$('.panel').textContent}`);
      await pause(10);
    }
  };
  const start = (scope) => {
    if ($('.panel').hidden) $('.launcher').click();
    $(`input[value="${scope}"]`).checked = true;
    $('button[type="submit"]').click();
  };
  const finished = () => until(() => $('a.download') || $('.error'), 'the export to finish');
  const files = () => {
    const [json, csv] = blobs.slice(-2);
    return { json: JSON.parse(json.text), csv: csv.text, names: [...root.querySelectorAll('a.download')].map((a) => a.download) };
  };
  /** Pictures in the strip right now that had not finished loading when they were put up. */
  const early = () =>
    [...root.querySelectorAll('.strip img')].filter((img) => !img.hidden && !images.some((record) => record.done && record.img.src === img.src)).length;
  /** Run the console probe as pasted into DevTools, and wait for its report. */
  const runProbe = async (source = probe, name = 'ytProbe') => {
    window[name] = undefined;
    logs.length = 0;
    window.eval(source);
    await until(() => window[name] || logs.some((line) => line.includes('probe failed')), 'the probe to report');
    // Copied through JSON, as copy(ytProbe) would give it (and into this side's own arrays).
    return window[name] && JSON.parse(JSON.stringify(window[name]));
  };
  const setReshape = (fn) => {
    reshape = fn;
  };
  return { window, root, $, button, until, start, finished, files, images, early, logs, runProbe, setReshape, lastBlob: () => blobs.at(-1), blobs, calls: api.calls, api };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${String(error.stack).split('\n').slice(0, 14).join('\n     ')}`);
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------------- tests

await test('userscript: launcher only on /feed/playlists, follows in-page navigation', async () => {
  const t = await boot({ url: 'https://www.youtube.com/' });
  assert.equal(t.$('.launcher').hidden, true);
  assert.equal(t.$('.panel').hidden, true);
  t.window.history.pushState({}, '', '/feed/playlists');
  t.window.dispatchEvent(new t.window.Event('yt-navigate-finish'));
  assert.equal(t.$('.launcher').hidden, false);
  assert.equal(t.$('.launcher').textContent, 'Export playlists');
  t.$('.launcher').click();
  assert.equal(t.$('.panel').hidden, false);
  assert.equal(t.$('.launcher').hidden, true);
  assert.ok(t.$('.box').classList.contains('dark'));
  t.$('.close').click();
  assert.equal(t.$('.panel').hidden, true);
  assert.equal(t.$('.launcher').hidden, false);
});

await test('playlists only: index from the API, paged, de-duplicated, decoys ignored', async () => {
  const t = await boot();
  t.start('playlists');
  assert.equal(t.$('progress').hasAttribute('value'), false); // busy bar while the list is read
  assert.equal(t.$('.headline').textContent, 'Reading your playlists…');
  await t.finished();
  assert.equal(t.$('.error'), null);
  assert.deepEqual(t.calls, ['FEplaylist_aggregation', 'FEED_2']);
  const { json, csv, names } = t.files();
  assert.equal(json.schema, 'youtube-playlists-export/1');
  assert.equal(json.withVideos, false);
  assert.equal(json.complete, true);
  assert.deepEqual(json.playlists.map((p) => p.id), ['PLnew', 'PLold', 'PLretry', 'PLgone', 'PLdenied', 'PLloop', 'PLgrid']);
  assert.deepEqual(json.playlists[1], {
    id: 'PLold',
    title: 'Old layout list',
    url: 'https://www.youtube.com/playlist?list=PLold',
    type: 'playlist',
    videoCount: 1003,
    owner: 'Some Channel',
    details: ['Some Channel · Playlist', 'Updated today', 'View full playlist'],
  });
  assert.ok(!JSON.stringify(json).includes('ytimg') && !csv.includes('ytimg')); // pictures are for the panel only
  assert.equal(json.playlists[0].owner, '');
  assert.equal(json.playlists[5].type, 'podcast');
  assert.equal(json.playlists[6].videoCount, 3);
  assert.ok(!('videos' in json.playlists[0]));
  assert.equal(t.$('p').textContent, '7 playlists.');
  assert.equal(t.$('details'), null);
  assert.match(names[0], /^youtube-playlists-\d{4}-\d\d-\d\d\.json$/);
  assert.match(names[1], /\.csv$/);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '\ufeffplaylist_id,playlist_title,type,video_count,owner,details,playlist_url');
  assert.equal(lines[1], 'PLnew,"\'=Formula, ""quoted"" title",playlist,5,,Private · Playlist | Updated today | View full playlist,https://www.youtube.com/playlist?list=PLnew');
  assert.equal(lines.length, 9); // header + 7 + trailing newline
});

await test('with videos: data from both layouts, and the progress view along the way', async () => {
  const t = await boot({ latencyMs: 40 }); // requests take time, so every state can be seen
  t.start('videos');

  // Watch the progress view until the export ends.
  const headlines = [];
  const covers = new Set();
  const strips = []; // { at, strip } each time the strip changes
  const shown = (img) => (img.hidden ? '' : img.src.match(/\/vi\/([^/]+)\/(\w+)/).slice(1).join('/'));
  const notes = new Set();
  const meters = new Set();
  let early = 0;
  const fractions = [];
  let announced = 0;
  new t.window.MutationObserver((records) => (announced += records.length)).observe(t.$('.headline'), { childList: true, characterData: true, subtree: true });
  while (!t.$('a.download') && !t.$('.error')) {
    const headline = t.$('.headline')?.textContent;
    if (headline && headlines.at(-1) !== headline) headlines.push(headline);
    for (const note of t.root.querySelectorAll('.note')) notes.add(note.textContent);
    if (t.$('.meter')) meters.add(`${t.$('.current').textContent}: ${t.$('.meter').hidden ? 'hidden' : t.$('.meter div').style.width}`);
    if (t.$('.now img')) covers.add(`${headline}: ${shown(t.$('.now img'))} ${t.$('.current').textContent}`);
    const strip = [...t.root.querySelectorAll('.strip img')].map(shown).join(' ');
    if (strips.at(-1)?.strip !== strip) strips.push({ at: Date.now(), strip });
    early += t.early();
    if (t.$('progress')?.hasAttribute('value')) fractions.push(t.$('progress').value);
    await pause(5);
  }
  assert.equal(t.$('.error'), null);

  assert.deepEqual(headlines, ['Reading your playlists…', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `Playlist ${n} of 7`)]);
  assert.ok(announced <= 8, `screen readers heard ${announced} headline changes`);
  assert.ok(fractions.length > 5);
  assert.ok(fractions.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= fractions[i - 1])), `bar went backwards: ${fractions}`);
  // 17 requests expected: 1 + 11 + 1 + 1 + 1 + 1 + 1 (one per 100 videos, at least one).
  assert.ok(fractions.includes(1 / 17) && fractions.includes(12 / 17));
  assert.ok(notes.has('YouTube asked for a pause. Trying again in 2 s…'));
  // Pictures: the playlist's cover beside its title and size, the latest items read below.
  assert.ok(covers.has('Reading your playlists…:  '), [...covers].join(' | ')); // empty tile while the list is read
  // The cover is the smallest source wide enough for its tile (96 px here), not the largest.
  assert.ok(covers.has('Playlist 2 of 7: PLold/small Old layout list'), [...covers].join(' | '));
  assert.ok(covers.has('Playlist 7 of 7: g1/default Old style card'), [...covers].join(' | ')); // old-style card
  // The current playlist's own progress, as text and as a line on its cover.
  for (const text of ['0 of 5 videos', '2 of 5 videos', '4 of 5 videos', '5 of 5 videos', '1 of 1,003 videos', '2 of 1,003 videos', '0 of 1 video', '1 of 1 video', '0 of 7 videos', '2 of 2 videos']) {
    assert.ok(notes.has(text), `${text} not in: ${[...notes].join(' | ')}`);
  }
  for (const meter of ['=Formula, "quoted" title: 0%', '=Formula, "quoted" title: 40%', '=Formula, "quoted" title: 80%', '=Formula, "quoted" title: 100%', 'Deleted by owner: 0%']) {
    assert.ok(meters.has(meter), `${meter} not in: ${[...meters].join(' | ')}`);
  }
  const log = strips.map((entry) => entry.strip).join(' | ');
  assert.equal(strips[1].strip, 'PLnew/small PLold/small PLretry/small ', log); // covers while listing
  assert.equal(early, 0); // the strip only ever showed pictures that had arrived
  // Then videos: small pictures, one new one at a time, at most one a second.
  const video = strips.filter((entry) => entry.strip.startsWith('-vidB/default')); // from the first video picture on
  assert.equal(video[0].strip, '-vidB/default   ', log);
  assert.ok(video.length >= 3 && video.length <= 9, log);
  for (let i = 1; i < video.length; i++) {
    const before = video[i - 1].strip.split(' ').filter(Boolean);
    const after = video[i].strip.split(' ').filter(Boolean);
    assert.deepEqual(after.slice(0, -1), before.slice(-(after.length - 1)), log);
    assert.ok(video[i].at - video[i - 1].at >= 950, `${video[i].at - video[i - 1].at} ms between pictures`);
  }
  assert.ok(notes.has('3 found')); // after the first of two index requests
  assert.ok(notes.has('5 videos so far'));
  assert.ok([...notes].some((note) => /^\d+ videos so far · 2 failed/.test(note)), [...notes].join(' | '));

  const { json, csv } = t.files();
  const by = Object.fromEntries(json.playlists.map((p) => [p.id, p]));
  assert.equal(json.complete, true);
  // New layout, three pages, a repeated video kept, ids starting with "-" intact.
  assert.deepEqual(by.PLnew.videos.map((v) => [v.position, v.videoId, v.duration]), [
    [1, 'vidA', '4:05'], [2, '-vidB', '1:02:03'], [3, 'vidC', '0:59'], [4, 'vidA', '4:05'], [5, 'vidD', ''],
  ]);
  assert.deepEqual(by.PLnew.videos[0], { position: 1, videoId: 'vidA', title: 'Alpha', channel: 'Chan A', channelId: 'UCchan456', duration: '4:05', durationSeconds: 245, viewsText: '1M views', publishedText: '3 years ago', youtubeIndex: 0, watchedPercent: 100, resumeSeconds: null, url: 'https://www.youtube.com/watch?v=vidA' });
  // YouTube's index keeps the gap a hidden video leaves; ours counts what was read.
  assert.deepEqual(by.PLnew.videos.map((v) => [v.position, v.youtubeIndex, v.watchedPercent, v.resumeSeconds]), [
    [1, 0, 100, null], [2, 1, 37, 1377], [3, 2, null, null], [4, 3, 100, null], [5, 5, null, null],
  ]);
  // A row credited to several channels: the credit line as its name, the first channel's id.
  assert.deepEqual([by.PLnew.videos[4].channel, by.PLnew.videos[4].channelId], ['Chan D and Chan E', 'UCcredit1']);
  assert.deepEqual(by.PLold.videos.map((v) => [v.youtubeIndex, v.watchedPercent, v.resumeSeconds]), [[0, 64, null], [1, null, null]]); // old layout
  assert.ok(!JSON.stringify(json).includes('ytimg') && !csv.includes('ytimg')); // pictures are for the panel only
  // Old layout, token inside a commandExecutorCommand.
  assert.deepEqual(by.PLold.videos.map((v) => [v.videoId, v.title, v.channel, v.channelId, v.duration, v.durationSeconds, v.viewsText, v.publishedText]), [
    ['old1', 'Old one', 'Old Chan', 'UCold789', '3:00', 180, '50K views', '10 years ago'], ['old2', '[Deleted video]', '', '', '', null, '', ''],
  ]);
  assert.deepEqual(by.PLnew.videos.map((v) => v.durationSeconds), [245, 3723, 59, 245, null]); // "LIVE" is not a length
  // HTTP 429 once, then fine.
  assert.equal(t.calls.filter((c) => c === 'VLPLretry').length, 2);
  assert.equal(by.PLretry.videos.length, 1);
  assert.equal(by.PLretry.error, undefined);
  // Failures stay with their playlist and do not stop the run.
  assert.equal(by.PLgone.error, 'The playlist does not exist.');
  assert.equal(by.PLdenied.error, 'YouTube answered HTTP 403.');
  assert.deepEqual(by.PLdenied.videos, []);
  // A token that repeats is followed once, not forever.
  assert.deepEqual(t.calls.filter((c) => c === 'LOOP'), ['LOOP']);
  assert.equal(by.PLloop.videos.length, 2);
  assert.equal(by.PLgrid.videos.length, 3);

  // The result names the playlists to look at.
  assert.equal(t.$('p').textContent, '7 playlists, 13 videos.');
  const [failed, short] = [...t.root.querySelectorAll('details')];
  assert.equal(failed.querySelector('summary').textContent, '2 playlists could not be read');
  assert.deepEqual([...failed.querySelectorAll('li')].map((li) => li.textContent), ['Deleted by owner: The playlist does not exist.', 'Server says no: YouTube answered HTTP 403.']);
  assert.equal(short.querySelector('summary').textContent, '1 playlist gave fewer videos than YouTube counts (usually hidden or unavailable ones)');
  assert.deepEqual([...short.querySelectorAll('li')].map((li) => li.textContent), ['Old layout list: 2 of 1003']);

  const lines = csv.split('\r\n');
  assert.equal(lines[0], '\ufeffplaylist_id,playlist_title,position,video_id,video_title,channel,duration,video_url,views_text,published_text,duration_seconds,youtube_index,watched_percent,resume_seconds');
  assert.equal(lines[2], 'PLnew,"\'=Formula, ""quoted"" title",2,-vidB,Beta,Chan B,1:02:03,https://www.youtube.com/watch?v=-vidB,1M views,3 years ago,3723,1,37,1377');
  assert.ok(lines.includes(`PLgone,Deleted by owner${','.repeat(12)}`));
  assert.equal(lines.length, 1 + 13 + 2 + 1);

  t.button('Export again').click();
  assert.ok(t.$('input[value="playlists"]').checked);
});

await test('a picture that fails to load leaves a plain tile, and the next one still shows', async () => {
  const t = await boot();
  t.start('videos');
  await t.until(() => t.$('.headline')?.textContent === 'Playlist 1 of 7', 'the first playlist');
  const cover = t.$('.now img');
  assert.equal(cover.hidden, false);
  assert.equal(cover.alt, '');
  cover.dispatchEvent(new t.window.Event('error'));
  assert.equal(cover.hidden, true);
  await t.until(() => t.$('.headline')?.textContent === 'Playlist 2 of 7', 'the second playlist');
  assert.equal(cover.hidden, false);
  assert.match(cover.src, /PLold/);
  t.button('Stop').click();
  await t.finished();
});

await test('the strip changes as a whole, only once its new picture has arrived', async () => {
  // Pictures take 1.5 s here, longer than the gap between two changes of the strip, and
  // the very first one fails to load.
  const t = await boot({ latencyMs: 40, pictureMs: 1500, brokenPictures: /-vidB/ });
  t.start('videos');
  const strips = [];
  let early = 0;
  let asked = 0; // when the first video picture was asked for
  while (!t.$('a.download') && !t.$('.error')) {
    const strip = [...t.root.querySelectorAll('.strip img')].map((img) => (img.hidden ? '' : img.src.match(/\/vi\/([^/]+)\//)[1])).join(' ');
    if (strips.at(-1)?.strip !== strip) strips.push({ at: Date.now(), strip });
    early += t.early();
    if (!asked && t.images.some((record) => /-vidB/.test(record.img.src))) asked = Date.now();
    await pause(5);
  }
  const log = strips.map((entry) => entry.strip).join(' | ');
  assert.equal(early, 0, log);
  const video = strips.filter((entry) => entry.strip.startsWith('-vidB'));
  // A failed picture does not hold the strip up: the set goes up once it is known to have failed.
  assert.equal(video[0].strip, '-vidB   ', log);
  assert.ok(video[0].at - asked >= 1450, `put up ${video[0].at - asked} ms after it was asked for`);
  // Sets asked for while an earlier one was still loading are not lost, and keep their order.
  assert.ok(video.length >= 2, log);
  for (let i = 1; i < video.length; i++) {
    const before = video[i - 1].strip.split(' ').filter(Boolean);
    const after = video[i].strip.split(' ').filter(Boolean);
    assert.deepEqual(after.slice(0, -1), before.slice(-(after.length - 1)), log);
  }
});

await test('no picture is fetched while the panel is closed or the tab is hidden', async () => {
  const t = await boot();
  t.start('videos');
  await t.until(() => /PLnew/.test(t.$('.now img')?.src), 'the first cover');
  const cover = t.$('.now img');
  const addresses = () => [cover, ...t.root.querySelectorAll('.strip img')].map((img) => img.src).join(' ');

  t.$('.close').click();
  await pause(100); // a set fetched just before closing may still go up; nothing new is asked for
  let frozen = addresses();
  const fetchedAhead = t.images.length;
  await t.until(() => t.$('.headline').textContent === 'Playlist 3 of 7', 'the third playlist, panel closed');
  assert.equal(addresses(), frozen);
  assert.equal(t.images.length, fetchedAhead); // nothing fetched ahead either
  t.$('.launcher').click(); // opening catches up at once
  assert.match(cover.src, /PLretry/);

  Object.defineProperty(t.window.document, 'hidden', { value: true, configurable: true });
  await pause(100);
  frozen = addresses();
  const fetchedBeforeHiding = t.images.length;
  await t.until(() => t.$('.headline').textContent === 'Playlist 5 of 7', 'the fifth playlist, tab hidden');
  assert.equal(addresses(), frozen);
  assert.equal(t.images.length, fetchedBeforeHiding);
  Object.defineProperty(t.window.document, 'hidden', { value: false, configurable: true });
  t.window.document.dispatchEvent(new t.window.Event('visibilitychange'));
  assert.match(cover.src, /PLdenied|PLloop/);
  await t.finished();
});

await test('pictures: false in the settings: no image is ever created, the export is the same', async () => {
  const source = userscript.replace('pictures: true,', 'pictures: false,');
  assert.notEqual(source, userscript);
  const t = await boot({ source });
  t.start('videos');
  let images = 0;
  let titled = false;
  while (!t.$('a.download') && !t.$('.error')) {
    images += t.root.querySelectorAll('img, .picture').length;
    titled ||= t.$('.now .current')?.textContent === 'Old layout list';
    await pause(10);
  }
  assert.equal(images, 0);
  assert.equal(t.images.length, 0); // nothing fetched ahead either
  assert.ok(titled);
  assert.equal(t.$('p').textContent, '7 playlists, 13 videos.');
});

await test('Stop part-way keeps what was read; the files say they are incomplete', async () => {
  const t = await boot();
  t.start('videos');
  await t.until(() => t.$('.headline')?.textContent === 'Playlist 3 of 7', 'the third playlist');
  t.button('Stop').click();
  await t.finished();
  const made = t.calls.length;
  await pause(600);
  assert.equal(t.calls.length, made); // really stopped
  assert.equal(t.$('p').textContent, 'Stopped after 2 of 7 playlists, 7 videos. The files hold what was read so far.');
  const { json, csv } = t.files();
  assert.equal(json.complete, false);
  assert.deepEqual(json.playlists.map((p) => p.videos?.length), [5, 2, undefined, undefined, undefined, undefined, undefined]);
  assert.ok(csv.split('\r\n').includes(`PLretry,Needs a retry${','.repeat(12)}`));
  assert.equal([...t.root.querySelectorAll('details')].length, 1); // only the short "Old layout list"
});

await test('Stop before anything was read returns to the options', async () => {
  const t = await boot();
  t.start('videos');
  t.button('Stop').click();
  await t.until(() => t.$('input[value="playlists"]'), 'the options to come back');
  const made = t.calls.length;
  await pause(600);
  assert.equal(t.calls.length, made);
  assert.equal(t.$('.error'), null);
  assert.equal(t.$('a.download'), null);
});

await test('closing the panel mid-run minimises it; the launcher carries the progress', async () => {
  for (const mode of [{ source: userscript, userscriptMode: true }, { source: bookmarklet, userscriptMode: false }]) {
    const t = await boot({ url: 'https://www.youtube.com/', ...mode }); // not on the feed page
    t.start('videos');
    await t.until(() => t.$('.headline')?.textContent === 'Playlist 1 of 7', 'the first playlist');
    t.$('.close').click();
    assert.equal(t.$('.panel').hidden, true);
    assert.equal(t.$('.launcher').hidden, false);
    assert.match(t.$('.launcher').textContent, /^Exporting… \d+%$/);
    const seen = new Set();
    await t.until(() => seen.add(t.$('.launcher').textContent) && t.$('.launcher').textContent === 'Export ready', 'the export to finish behind the launcher');
    assert.ok(seen.size > 4, `launcher showed: ${[...seen]}`);
    assert.ok(t.calls.includes('VLPLgrid')); // it ran to the end while closed
    t.$('.launcher').click();
    assert.equal(t.$('.panel').hidden, false);
    assert.equal(t.$('.launcher').hidden, true);
    assert.equal(t.$('p').textContent, '7 playlists, 13 videos.');
    t.$('.close').click();
    // Seen now: the launcher is gone again, since this is not /feed/playlists.
    assert.equal(t.$('.launcher').hidden, true);
  }
});

await test('API refused: playlists are read from the cards on the page instead', async () => {
  const html = `
    <tp-yt-app-drawer><a href="/playlist?list=PLsidebar">Sidebar decoy</a></tp-yt-app-drawer>
    <ytd-page-manager><ytd-browse page-subtype="playlists">
      <yt-lockup-view-model>
        <a href="/watch?v=abc&list=PLone"><img src="https://i.ytimg.com/vi/abc/hqdefault.jpg?sqp=x"></a>
        <h3 title="First list">  First
          list </h3>
        <a href="/playlist?list=PLone">View full playlist</a>
      </yt-lockup-view-model>
      <yt-lockup-view-model><a href="/playlist?list=LL"></a><h3>Liked videos</h3></yt-lockup-view-model>
    </ytd-browse></ytd-page-manager>`;
  const t = await boot({ feedStatus: 403, html });
  t.start('playlists');
  await t.until(() => t.$('.headline')?.textContent === 'Reading playlists from the page…', 'the fallback');
  await t.until(() => !t.$('.strip img').hidden, 'a cover from the page');
  assert.equal(t.$('.strip img').src, 'https://i.ytimg.com/vi/abc/hqdefault.jpg?sqp=x');
  assert.equal(t.$('.now'), null); // no "current playlist" row in a list-only export
  await t.finished();
  assert.equal(t.$('.error'), null);
  const { json } = t.files();
  assert.deepEqual(json.playlists.map((p) => [p.id, p.title, p.videoCount]), [['PLone', 'First list', null], ['LL', 'Liked videos', null]]);
});

await test('a playlist of unknown size shows what was read, without a meter', async () => {
  // Cards read from the page carry no video count.
  const card = (id, title) => `<yt-lockup-view-model><a href="/playlist?list=${id}"></a><h3>${title}</h3></yt-lockup-view-model>`;
  const html = `<ytd-page-manager><ytd-browse page-subtype="playlists">${card('PLgrid', 'From the page')}${card('PLnew', 'Another')}</ytd-browse></ytd-page-manager>`;
  const t = await boot({ feedStatus: 403, html, latencyMs: 150 });
  t.start('videos');
  await t.until(() => t.$('.current')?.textContent === 'From the page', 'the playlist to start');
  assert.equal(t.$('.meter').hidden, true);
  assert.equal(t.$('.now .note').textContent, '');
  await t.until(() => t.$('.now .note')?.textContent === '3 videos', 'its videos, shown while it is still the current one');
  assert.equal(t.$('.current').textContent, 'From the page');
  assert.equal(t.$('.meter').hidden, true);
  await t.finished();
  assert.deepEqual(t.files().json.playlists.map((p) => p.videos.length), [3, 5]);
});

await test('two "load more" tokens on a page: the one that ends the list of items is followed', async () => {
  const card = (id) => `<yt-lockup-view-model><a href="/playlist?list=${id}"></a><h3>${id}</h3></yt-lockup-view-model>`;
  const html = `<ytd-page-manager><ytd-browse page-subtype="playlists">${card('PLtwo')}</ytd-browse></ytd-page-manager>`;
  const t = await boot({ feedStatus: 403, html });
  t.start('videos');
  await t.finished();
  const [playlist] = t.files().json.playlists;
  assert.deepEqual(playlist.videos.map((v) => [v.videoId, v.durationSeconds, v.viewsText, v.publishedText]), [
    ['two1', 60, '1M views', '3 years ago'], ['two2', 120, '1M views', '3 years ago'], ['two3', 180, '12 watching', ''],
  ]);
  assert.deepEqual(t.calls.filter((call) => call !== 'FEplaylist_aggregation'), ['VLPLtwo', 'TWO_2']); // TWO_BESIDE is never asked for
});

await test('console probe: checks, paging and fields, with nothing that identifies anyone', async () => {
  const t = await boot();
  const report = await t.runProbe(probe.replace("const PLAYLIST = '';", "const PLAYLIST = 'PLtwo';"));
  assert.ok(report, t.logs.join(' | '));
  assert.deepEqual(report.checks.filter((entry) => !entry.ok), []);
  assert.deepEqual(report.checks.map((entry) => `${entry.check}: ${entry.found}`), [
    'playlist cards found: 3', 'card: title: 3 of 3', 'card: video count badge: 3 of 3', 'card: cover picture: 3 of 3',
    'paging, playlists: the token the exporter follows brings playlists: true',
    'video rows found: 2', 'row: title: 2 of 2', 'row: channel name: 2 of 2', 'row: channel id: 2 of 2',
    'row: duration badge: 2 of 2', 'row: views: 2 of 2', 'row: published age: 2 of 2', 'row: YouTube index: 2 of 2',
    'paging, videos: the token the exporter follows brings videos: true',
  ]);
  assert.deepEqual(report.paging.playlists, [
    { kind: 'continuationItemRenderer', where: 'contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content.richGridRenderer.contents[].continuationItemRenderer', 'exporter follows': true, 'items it brings': 5, 'more after it': 0 },
  ]);
  // Both "load more" tokens are followed and told apart: where each sits, and what it brings.
  assert.deepEqual(report.paging.videos, [
    { kind: 'continuationItemViewModel', where: 'contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content.sectionListRenderer.contents[].itemSectionRenderer.contents[].continuationItemViewModel', 'exporter follows': true, 'items it brings': 1, 'more after it': 0 },
    { kind: 'continuationItemViewModel', where: 'contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content.sectionListRenderer.contents[].continuationItemViewModel', 'exporter follows': false, 'items it brings': 0, 'more after it': 0 },
  ]);
  assert.equal(report.probe, 3);
  assert.deepEqual(report.facts, { 'index of the first row': 0, 'rows with watch progress': '0 of 2', 'rows with a resume time': '0 of 2', 'card badges without a number': {}, 'notices on the playlist page': [], 'rows that cannot be played': '0 of 0' });
  assert.equal(report.fields.video.contentType, 'LOCKUP_CONTENT_TYPE_VIDEO'); // YouTube's constants are kept
  assert.equal(report.fields.video['metadata.lockupMetadataViewModel.title.content'], 'string'); // values are not
  assert.equal(report.fields.loadMore['continuationCommand.innertubeCommand.continuationCommand.token'], 'string');
  assert.equal(report.kinds.playlist.lockupViewModel, 2);
  assert.equal(report.client, 'WEB 2.20261120.01.00');
  assert.equal(report.language, 'en');
  const shared = JSON.stringify(report);
  for (const secret of ['two1', 'Two 1', 'Chan T', 'TWO_2', 'TWO_BESIDE', 'PLtwo', 'PLnew', 'Formula', 'UCchan456', 'UCowner123', SID, USER, 'ytimg']) {
    assert.ok(!shared.includes(secret), `the report contains "${secret}"`);
  }
  assert.ok(t.logs.some((line) => line.includes('First run in this browser')));

  // A second run finds nothing new.
  const again = await t.runProbe(probe); // no playlist named: the one used last time
  assert.deepEqual(again.changes, []);
  assert.ok(t.logs.some((line) => line.includes('No changes since')), t.logs.join(' | '));

  // Then YouTube renames something the exporter reads.
  t.setReshape((json) => JSON.parse(JSON.stringify(json).replaceAll('"lockupMetadataViewModel"', '"lockupMetaViewModel"')));
  const changed = await t.runProbe(probe);
  assert.deepEqual(changed.checks.filter((entry) => !entry.ok).map((entry) => entry.check), [
    'card: title', 'row: title', 'row: channel name', 'row: channel id', 'row: views', 'row: published age',
  ]);
  for (const line of [
    'check "row: title": ok -> FAILING',
    'new kind of item in playlist: lockupMetaViewModel',
    'gone kind of item in playlist: lockupMetadataViewModel',
    'gone field on video: metadata.lockupMetadataViewModel.title.content',
    'new field on video: metadata.lockupMetaViewModel.title.content (string)',
  ]) {
    assert.ok(changed.changes.includes(line), `missing "${line}" in: ${changed.changes.join(' | ')}`);
  }
});

await test('console probe on Watch later: what a tidy-up relies on, and the notice about hidden videos', async () => {
  const t = await boot();
  const report = await t.runProbe(probe.replace("const PLAYLIST = '';", "const PLAYLIST = 'WL';"));
  assert.ok(report, t.logs.join(' | '));
  assert.deepEqual(report.checks.filter((entry) => !entry.ok), []);
  const found = Object.fromEntries(report.checks.map((entry) => [entry.check, entry.found]));
  assert.deepEqual([found['older row: entry id (setVideoId)'], found['older row: playable flag'], found['older row: remove command in its menu']], ['4 of 4', '4 of 4', '4 of 4']);
  assert.deepEqual(report.facts['notices on the playlist page'], ['Unavailable videos are hidden']);
  assert.equal(report.facts['rows that cannot be played'], '1 of 4');
  assert.equal(report.fields.notice['text.simpleText'], 'string');
  assert.equal(report.fields.video['menu.menuRenderer.items[].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.actions[].action'], 'ACTION_MOVE_VIDEO_BEFORE | ACTION_REMOVE_VIDEO');
  for (const secret of ['wl1', 'Watched fully', 'ENTRY1', 'Alpha Channel', 'WL_2']) assert.ok(!JSON.stringify(report).includes(secret), `the report contains "${secret}"`);
});

await test('console probe: picks the largest playlist by itself, and reads the older layout', async () => {
  const t = await boot();
  const report = await t.runProbe();
  assert.ok(report, t.logs.join(' | '));
  assert.deepEqual(report.checks.filter((entry) => !entry.ok), []);
  assert.ok(report.checks.some((entry) => entry.check === 'older row: videoInfo' && entry.found === '1 of 1'));
  assert.deepEqual(report.notable, ['lengthSeconds', 'navigationEndpoint.watchEndpoint.index', 'thumbnailOverlays[].thumbnailOverlayResumePlaybackRenderer.percentDurationWatched']);
  assert.equal(report.paging.videos[0].kind, 'continuationItemRenderer');
  assert.equal(report.paging.videos[0]['items it brings'], 1);
  const out = await boot({ signedIn: false });
  assert.equal(await out.runProbe(), undefined);
  assert.ok(out.logs.some((line) => line.includes('probe failed') && line.includes('Not signed in')));
});

await test('console probe: facts about progress, the index, and cards that give no video count', async () => {
  const t = await boot();
  t.setReshape((json) => JSON.parse(JSON.stringify(json).replaceAll('"1 video"', '"No videos"')));
  const report = await t.runProbe(probe.replace("const PLAYLIST = '';", "const PLAYLIST = 'PLnew';"));
  assert.ok(report, t.logs.join(' | '));
  assert.deepEqual(report.facts, { 'index of the first row': 0, 'rows with watch progress': '2 of 2', 'rows with a resume time': '1 of 2', 'card badges without a number': { 'No videos': 1 }, 'notices on the playlist page': [], 'rows that cannot be played': '0 of 0' });
  assert.ok(report.checks.some((entry) => entry.check === 'card: video count badge' && entry.found === '2 of 3'));
  // A row credited to several channels links none in its text; its id is found behind the avatars.
  const credited = await t.runProbe(probe.replace("const PLAYLIST = '';", "const PLAYLIST = 'PLcredit';"));
  assert.ok(credited.checks.some((entry) => entry.check === 'row: channel id' && entry.found === '2 of 2'), JSON.stringify(credited.checks));
  assert.ok(credited.checks.some((entry) => entry.check === 'paging, videos: no token, the first page holds the whole playlist' && entry.ok));
});

await test('history probe: days, their headings, Shorts and paging, in the newer layout', async () => {
  const t = await boot({ url: 'https://www.youtube.com/feed/history' });
  const report = await t.runProbe(historyProbe, 'ytHistoryProbe');
  assert.ok(report, t.logs.join(' | '));
  assert.deepEqual(report.checks.filter((entry) => !entry.ok), []);
  const at = 'contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content.sectionListRenderer.contents[].itemSectionRenderer.header.itemSectionHeaderRenderer.title.runs[].text';
  const { d2, d3, d10 } = historyHeadings();
  assert.deepEqual(report.sections['first page'], [
    { heading: 'Today', 'heading at': at, rows: 2, shorts: 3 },
    { heading: 'Yesterday', 'heading at': at, rows: 1, shorts: 0 },
    { heading: d2, 'heading at': at.replace('runs[].text', 'simpleText'), rows: 1, shorts: 0 },
  ]);
  assert.deepEqual(report.sections['next page'].map((section) => [section.heading, section.rows]), [[d2, 1], [d3, 2], [d10, 1]]);
  assert.deepEqual(report.paging.map((entry) => [entry.kind, entry['items it brings'], entry['more after it']]), [['continuationItemRenderer', 4, 1]]);
  assert.equal(report.facts['rows on the first page'], 4);
  assert.equal(report.facts['Shorts on the first page'], 3);
  assert.equal(report.facts['next page starts under the last heading of the first'], true);
  assert.deepEqual(report.facts['kinds of lockup on the first page'], { LOCKUP_CONTENT_TYPE_VIDEO: 4 });
  assert.deepEqual(report.facts['where the Shorts sit'], ['contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content.sectionListRenderer.contents[].itemSectionRenderer.contents[].reelShelfRenderer.items[].shortsLockupViewModel']);
  assert.equal(report.fields.heading['itemSectionHeaderRenderer.title.runs[].text'], 'string?');
  assert.equal(report.fields.heading['itemSectionHeaderRenderer.title.simpleText'], 'string?');
  assert.equal(report.fields.short['overlayMetadata.primaryText.content'], 'string');
  assert.ok(report.notable.some((path) => path.endsWith('thumbnailOverlayProgressBarViewModel.startPercent')));
  // Day headings are in the report; nothing else of the account's is.
  const shared = JSON.stringify(report);
  for (const secret of ['hist1', 'History one', 'History four', 'Chan H', 'HIST_2', 'sh1', 'Short sh1', 'UCchan456', 'Watch history', SID, USER]) {
    assert.ok(!shared.includes(secret), `the report contains "${secret}"`);
  }
  const again = await t.runProbe(historyProbe, 'ytHistoryProbe');
  assert.deepEqual(again.changes, []);
});

await test('history probe: the older layout, and an empty history', async () => {
  const t = await boot({ url: 'https://www.youtube.com/feed/history', olderHistory: true });
  const report = await t.runProbe(historyProbe, 'ytHistoryProbe');
  assert.ok(report, t.logs.join(' | '));
  assert.deepEqual(report.checks.filter((entry) => !entry.ok).map((entry) => entry.check), ['older row: shortBylineText']);
  assert.deepEqual(report.sections['first page'].map((section) => [section.heading, section.rows, section.shorts]), [['Today', 2, 3], ['Yesterday', 1, 0], [historyHeadings().d2, 1, 0]]);
  assert.equal(report.paging[0].kind, 'continuationItemRenderer');
  assert.ok(report.notable.includes('thumbnailOverlays[].thumbnailOverlayResumePlaybackRenderer.percentDurationWatched'));

  const empty = await boot({ url: 'https://www.youtube.com/feed/history' });
  empty.setReshape(() => ({ contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ messageRenderer: { text: { simpleText: 'This list has no videos.' } } }] } }] } } } }] } } }));
  const nothing = await empty.runProbe(historyProbe, 'ytHistoryProbe');
  assert.ok(nothing, empty.logs.join(' | '));
  assert.deepEqual(nothing.checks.map((entry) => [entry.check, entry.ok]), [['history rows found', false], ['sections with a heading', false], ['paging: no token, the first page is the whole history', true]]);
  assert.equal(nothing.kinds.feed.messageRenderer, 1);
});

// ------------------------------------------------------------ watch history

/** Tick a history range ('7', '30' or '0'), set the Shorts box, press Export, wait for the end. */
async function exportHistory(t, range, { shorts = true } = {}) {
  if (t.$('.panel').hidden) t.$('.launcher').click();
  t.$(`input[name="range"][value="${range}"]`).checked = true;
  t.$('input[name="shorts"]').checked = shorts;
  t.$('button[type="submit"]').click();
  await t.finished();
  return t.files();
}

await test('history, last 7 days: every item gets its day; reading stops at the first older day', async () => {
  const t = await boot({ url: HISTORY_URL, latencyMs: 40 });
  const { d2, d3 } = historyHeadings();
  assert.equal(t.$('.launcher').textContent, 'Export history');
  t.$('.launcher').click();
  assert.equal(t.$('h2').textContent, 'Export history');
  assert.equal(t.$('.panel').getAttribute('aria-label'), 'Export history');
  assert.ok(t.$('input[name="range"][value="7"]').checked && t.$('input[name="shorts"]').checked);

  t.$('button[type="submit"]').click();
  const headlines = [];
  const fractions = new Set();
  const notes = new Set();
  while (!t.$('a.download') && !t.$('.error')) {
    const headline = t.$('.headline')?.textContent;
    if (headline && headlines.at(-1) !== headline) headlines.push(headline);
    if (t.$('progress')?.hasAttribute('value')) fractions.add(t.$('progress').value.toFixed(3));
    if (t.$('.note')) notes.add(t.$('.note').textContent);
    assert.equal(t.$('.now'), null); // no "current playlist" row in the history
    await pause(5);
  }
  assert.equal(t.$('.error'), null);
  // One response holds several days and is read in one go, so the view moves on once per
  // response, to the last day in it. The bar measures days, out of seven.
  assert.deepEqual(headlines, ['Reading your history…', `History: ${d2}`]);
  assert.deepEqual([...fractions], ['0.000', (2 / 7).toFixed(3)]);
  assert.ok(notes.has('7 items so far'), [...notes].join(' | '));
  assert.deepEqual(t.calls, ['FEhistory', 'HIST_2']); // the third response is never asked for

  assert.equal(t.$('p').textContent, '10 items from 4 days: 7 videos, 3 Shorts.');
  const { json, csv, names } = t.files();
  assert.match(names[0], /^youtube-history-\d{4}-\d\d-\d\d\.json$/);
  assert.equal(json.schema, 'youtube-history-export/1');
  assert.deepEqual([json.from, json.includesShorts, json.complete, json.stopped, json.undated], [iso(daysAgo(6)), true, true, null, []]);
  assert.deepEqual(json.items.map((item) => [item.position, item.kind, item.videoId, item.watchedOn, item.watchedOnText]), [
    [1, 'video', 'hist1', iso(daysAgo(0)), 'Today'],
    [2, 'video', 'hist2', iso(daysAgo(0)), 'Today'],
    [3, 'short', 'sh1', iso(daysAgo(0)), 'Today'],
    [4, 'short', 'sh2', iso(daysAgo(0)), 'Today'],
    [5, 'short', 'sh3', iso(daysAgo(0)), 'Today'],
    [6, 'video', 'hist3', iso(daysAgo(1)), 'Yesterday'],
    [7, 'video', 'hist4', iso(daysAgo(2)), d2],
    [8, 'video', 'hist5', iso(daysAgo(2)), d2], // the same day, carried into the next response
    [9, 'video', 'hist6', iso(daysAgo(3)), d3],
    [10, 'video', 'hist7', iso(daysAgo(3)), d3],
  ]);
  assert.deepEqual(json.items[0], {
    position: 1, watchedOn: iso(daysAgo(0)), watchedOnText: 'Today', kind: 'video', videoId: 'hist1', title: 'History one', channel: 'Chan H', channelId: 'UCchan456',
    duration: '4:05', durationSeconds: 245, viewsText: '1M views', publishedText: '', watchedPercent: 80, resumeSeconds: null, url: 'https://www.youtube.com/watch?v=hist1',
  });
  assert.deepEqual(json.items[2], {
    position: 3, watchedOn: iso(daysAgo(0)), watchedOnText: 'Today', kind: 'short', videoId: 'sh1', title: 'Short sh1', channel: '', channelId: '',
    duration: '', durationSeconds: null, viewsText: '2M views', publishedText: '', watchedPercent: null, resumeSeconds: null, url: 'https://www.youtube.com/watch?v=sh1',
  });
  // A playlist listed in the history is not read, and the result says so.
  assert.deepEqual(json.skipped, { LOCKUP_CONTENT_TYPE_PLAYLIST: 1 });
  const [skipped] = [...t.root.querySelectorAll('details')];
  assert.equal(skipped.querySelector('summary').textContent, '1 item of a kind this exporter does not read');
  assert.deepEqual([...skipped.querySelectorAll('li')].map((li) => li.textContent), ['LOCKUP_CONTENT_TYPE_PLAYLIST: 1']);

  const lines = csv.split('\r\n');
  assert.equal(lines[0], '﻿position,watched_on,watched_on_text,kind,video_id,video_title,channel,duration,video_url,views_text,published_text,duration_seconds,watched_percent,resume_seconds');
  assert.equal(lines[1], `1,${iso(daysAgo(0))},Today,video,hist1,History one,Chan H,4:05,https://www.youtube.com/watch?v=hist1,1M views,,245,80,`);
  assert.equal(lines.length, 1 + 10 + 1);

  t.button('Export again').click();
  assert.ok(t.$('input[name="range"][value="7"]').checked); // back to the history's options
});

await test('history, last 30 days without Shorts: a date without a year is read; stops at one beyond', async () => {
  const t = await boot({ url: HISTORY_URL });
  const { json } = await exportHistory(t, '30', { shorts: false });
  assert.equal(t.$('p').textContent, '8 items from 5 days: 8 videos, 0 Shorts.');
  assert.deepEqual(t.calls, ['FEhistory', 'HIST_2', 'HIST_3']);
  assert.deepEqual([json.from, json.includesShorts, json.complete], [iso(daysAgo(29)), false, true]);
  assert.deepEqual(json.items.map((item) => item.videoId), ['hist1', 'hist2', 'hist3', 'hist4', 'hist5', 'hist6', 'hist7', 'hist8']);
  assert.deepEqual([json.items[7].watchedOn, json.items[7].watchedOnText], [iso(daysAgo(10)), historyHeadings().d10]);
});

await test('history, everything: a date with a year; a heading that is no date is kept as text', async () => {
  const t = await boot({ url: HISTORY_URL });
  const { json, csv } = await exportHistory(t, '0');
  assert.equal(t.$('p').textContent, '13 items from 7 days: 10 videos, 3 Shorts.');
  assert.deepEqual([json.from, json.complete, json.stopped], [null, true, null]);
  assert.deepEqual(json.items.slice(-2).map((item) => [item.videoId, item.watchedOn, item.watchedOnText]), [
    ['hist9', iso(daysAgo(400)), historyHeadings().d400],
    ['hist10', null, 'Some time ago'],
  ]);
  assert.deepEqual(json.undated, ['Some time ago']);
  const [undated] = [...t.root.querySelectorAll('details')];
  assert.equal(undated.querySelector('summary').textContent, '1 heading could not be read as a date (kept as text)');
  assert.ok(csv.split('\r\n').some((line) => line.startsWith('13,,Some time ago,video,hist10,')));
});

await test('history: dates as other places write them, and across a new year', async () => {
  // Rewrite the heading of the day ten days back in several styles; each must give the same day.
  const day = daysAgo(10);
  const long = new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(day);
  const short = long.slice(0, 3);
  const { d10 } = historyHeadings();
  for (const written of [`${short} ${day.getDate()}`, `${day.getDate()} ${long}`, `${short} ${day.getDate()}, ${day.getFullYear()}`, `${day.getDate()}. ${short}.`, `${long.toUpperCase()} ${day.getDate()}`]) {
    const t = await boot({ url: HISTORY_URL });
    t.setReshape((json) => JSON.parse(JSON.stringify(json).replaceAll(`"${d10}"`, `"${written}"`)));
    const { json } = await exportHistory(t, '0');
    assert.deepEqual([json.items[10].videoId, json.items[10].watchedOn, json.items[10].watchedOnText], ['hist8', iso(day), written], written);
  }
  // On 5 January, "26 Dec" is last year's; and on a Tuesday, "Sunday" is two days back.
  const now = new Date(2027, 0, 5, 9, 30);
  const t = await boot({ url: HISTORY_URL, now });
  const { json } = await exportHistory(t, '0');
  assert.deepEqual(json.items.map((item) => item.watchedOn).filter((value, i, all) => all.indexOf(value) === i), ['2027-01-05', '2027-01-04', '2027-01-03', '2027-01-02', '2026-12-26', '2025-12-01', null]);
  assert.equal(json.items.find((item) => item.videoId === 'hist4').watchedOnText, 'Sunday');
});

await test('history: an unreadable heading ends a ranged export early, and says why', async () => {
  const t = await boot({ url: HISTORY_URL });
  t.setReshape((json) => JSON.parse(JSON.stringify(json).replaceAll(`"${historyHeadings().d10}"`, '"Earlier"')));
  const { json } = await exportHistory(t, '30');
  assert.deepEqual([json.complete, json.stopped, json.items.length], [false, 'the heading "Earlier" could not be read as a date', 10]);
  assert.equal(t.$('p').textContent, '10 items from 4 days: 7 videos, 3 Shorts. It ended early because the heading "Earlier" could not be read as a date. The files hold what was read.');
});

await test('history: Stop, or a failing request, keeps what was read; an empty history says so', async () => {
  const t = await boot({ url: HISTORY_URL, latencyMs: 150 });
  t.$('.launcher').click();
  t.$('input[name="range"][value="0"]').checked = true;
  t.$('button[type="submit"]').click();
  assert.equal(t.$('progress').hasAttribute('value'), false); // "everything" has no end to measure against
  await t.until(() => t.calls.includes('HIST_2'), 'the second request');
  assert.equal(t.$('progress').hasAttribute('value'), false);
  t.$('.close').click();
  assert.match(t.$('.launcher').textContent, /^Exporting… \d+$/); // a count, since there is no percentage
  t.$('.launcher').click();
  t.button('Stop').click();
  await t.finished();
  const stopped = t.files().json;
  assert.deepEqual([stopped.complete, stopped.stopped, stopped.items.length], [false, 'you stopped it', 7]);

  const failing = await boot({ url: HISTORY_URL });
  failing.setReshape((json) => JSON.parse(JSON.stringify(json).replaceAll('"HIST_3"', '"HIST_MISSING"'))); // the mock answers 404 to that
  const { json } = await exportHistory(failing, '0');
  assert.deepEqual([json.complete, json.stopped, json.items.length], [false, 'YouTube answered HTTP 404.', 11]);

  const empty = await boot({ url: HISTORY_URL });
  empty.setReshape(() => ({ contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [] } } } }] } } }));
  empty.start('7');
  await empty.finished();
  assert.equal(empty.$('.error').textContent, 'No watch history came back. It may be empty, or switched off.');
});

await test('history: Shorts whose id is not where it is looked for are counted, not lost in silence', async () => {
  const t = await boot({ url: HISTORY_URL });
  t.setReshape((json) => JSON.parse(JSON.stringify(json).replaceAll('"reelWatchEndpoint"', '"reelWatchEndpointV2"')));
  const { json } = await exportHistory(t, '7');
  assert.deepEqual(json.skipped, { 'short without an id': 3, LOCKUP_CONTENT_TYPE_PLAYLIST: 1 });
  assert.equal(t.$('p').textContent, '7 items from 4 days: 7 videos, 0 Shorts.');
  assert.equal(t.$('details summary').textContent, '4 items of a kind this exporter does not read');
});

await test('the panel offers what the page has: playlists, or the history', async () => {
  const t = await boot({ url: FEED_URL });
  assert.equal(t.$('.launcher').textContent, 'Export playlists');
  t.$('.launcher').click();
  assert.equal(t.$('h2').textContent, 'Export playlists');
  assert.ok(t.$('input[name="scope"]') && !t.$('input[name="range"]'));
  t.$('.close').click();
  // YouTube moves to the history page without reloading.
  t.window.history.pushState({}, '', '/feed/history');
  t.window.dispatchEvent(new t.window.Event('yt-navigate-finish'));
  assert.equal(t.$('.launcher').textContent, 'Export history');
  t.$('.launcher').click();
  assert.equal(t.$('h2').textContent, 'Export history');
  assert.ok(t.$('input[name="range"]') && !t.$('input[name="scope"]'));
  // A result stays put when the page changes; only the options follow it.
  t.$('button[type="submit"]').click();
  await t.finished();
  t.$('.close').click();
  t.window.history.pushState({}, '', '/feed/playlists');
  t.window.dispatchEvent(new t.window.Event('yt-navigate-finish'));
  t.$('.launcher').click();
  assert.equal(t.$('h2').textContent, 'Export history');
  assert.ok(t.$('a.download'));
  t.button('Export again').click();
  assert.equal(t.$('h2').textContent, 'Export playlists');

  // The bookmarklet does the same from wherever it is clicked.
  const mark = await boot({ url: HISTORY_URL, source: bookmarklet, userscriptMode: false });
  assert.equal(mark.$('h2').textContent, 'Export history');
  const { json } = await exportHistory(mark, '7');
  assert.equal(json.items.length, 10);
});

// ---------------------------------------------------------------- Watch later

const WATCH_LATER_URL = 'https://www.youtube.com/playlist?list=WL';

await test('Watch later: tick by filter and by hand, save the ticked list; only reads are sent', async () => {
  const t = await boot({ url: WATCH_LATER_URL });
  assert.equal(t.$('.launcher').textContent, 'Tidy Watch later');
  t.$('.launcher').click();
  assert.equal(t.$('h2').textContent, 'Tidy Watch later');
  assert.equal(t.$('button[type="submit"]').textContent, 'Read the list');
  t.$('button[type="submit"]').click();
  await t.until(() => t.$('.rows') || t.$('.error'), 'the list');
  assert.equal(t.$('.error'), null);
  assert.ok(t.$('.panel').classList.contains('wide'));

  const rowsShown = [...t.root.querySelectorAll('.row')];
  const tickedIds = () => rowsShown.filter((row) => row.querySelector('input').checked).map((row) => row.querySelector('p').textContent.split('.')[0]).join(' ');
  const counts = () => [...t.root.querySelectorAll('.filter .muted')].map((el) => el.textContent).join(' ');
  const set = (name, value) => {
    const control = t.$(`.filter [name="${name}"]`);
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
    control.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  };
  const tick = (position, value) => {
    const box = rowsShown[position - 1].querySelector('input');
    box.checked = value;
    box.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  };

  assert.deepEqual(rowsShown.map((row) => row.textContent), [
    '1. Watched fullyAlpha Channel · 10:00 · watched 100% · 3 years ago',
    '2. Half watchedBeta Channel · 10:00 · watched 45% · ‎2 months ago',
    '3. Not startedAlpha Channel · 10:00 · 5 yr ago',
    '4. [Deleted video]unavailable ',
    '5. Nearly doneGamma · 10:00 · watched 92% · 11 months ago',
    '6. Old talkBéta Channel · 10:00 · 50K views - Streamed 12 years ago', // not split: shown whole
  ]);
  const said = [...t.root.querySelectorAll('p')].map((p) => p.textContent);
  assert.ok(said.includes('6 videos in Watch later. Tick the ones to remove.'));
  assert.ok(said.includes('YouTube says: Unavailable videos are hidden'));
  assert.ok(said.includes("Nothing is removed until you allow it, press Remove and confirm. 6 of 6 rows carry YouTube's own remove command."));

  // Nothing is ticked until a filter is switched on; the counts show what each would pick.
  assert.equal(tickedIds(), '');
  assert.equal(counts(), '(2) (1) (fill in at least one box)');
  set('watched', true);
  assert.equal(tickedIds(), '1 5');
  set('percent', '40');
  assert.deepEqual([tickedIds(), counts()], ['1 2 5', '(3) (1) (fill in at least one box)']);
  set('unavailable', true);
  assert.equal(tickedIds(), '1 2 4 5');
  // The rule: every condition filled in must hold. Ticked while empty, it picks nothing and says why.
  const ruleOn = () => t.$('.filter [name="rule"]').checked;
  set('rule', true);
  assert.deepEqual([tickedIds(), counts()], ['1 2 4 5', '(3) (1) (fill in at least one box)']);
  set('rule', false);
  // Filling in a condition switches the rule on by itself; accents and case do not matter.
  set('channel', 'BETA');
  assert.deepEqual([ruleOn(), tickedIds(), counts()], [true, '1 2 4 5 6', '(3) (1) (2)']);
  // Switched off by hand it stays off, and still shows what it would pick.
  set('rule', false);
  assert.deepEqual([tickedIds(), counts()], ['1 2 4 5', '(3) (1) (2)']);
  t.$('.filter [name="channel"]').dispatchEvent(new t.window.Event('change', { bubbles: true })); // leaving the box
  assert.equal(ruleOn(), false);
  const ruleNote = () => (t.$('form .note').hidden ? null : t.$('form .note').textContent);
  assert.equal(ruleNote(), null);
  set('age', '5');
  // "12 years ago", not the one from two months ago. The deleted video shows no age at all, and that is said.
  assert.deepEqual([ruleOn(), counts()], [true, '(3) (1) (1)']);
  assert.equal(ruleNote(), 'No age found on 1 video, so the age condition leaves it unticked. YouTube sent no views or age for it.');
  set('channel', '');
  set('unit', 'months');
  set('age', '11');
  assert.equal(counts(), '(3) (1) (4)'); // 3 years, 5 years, 11 months, 12 years
  set('age', '');
  assert.deepEqual([ruleOn(), tickedIds(), ruleNote()], [false, '1 2 4 5', null]); // emptied: off again
  set('title', 'talk');
  assert.deepEqual([ruleOn(), tickedIds(), counts()], [true, '1 2 4 5 6', '(3) (1) (1)']);
  // A tick or untick made by hand outlives any change of the filters.
  tick(1, false);
  tick(3, true);
  assert.equal(t.$('p[role="status"]').textContent, '5 of 6 videos ticked.');
  set('percent', '95');
  assert.equal(tickedIds(), '3 4 6');

  t.button('Save ticked as JSON').click();
  const file = JSON.parse(t.lastBlob().text);
  assert.equal(file.schema, 'youtube-watch-later-ticked/1');
  assert.deepEqual(file.videos.map((video) => [video.position, video.videoId, video.setVideoId, video.playable]), [[3, 'wl3', 'ENTRY3', true], [4, 'wl4', 'ENTRY4', false], [6, 'wl6', 'ENTRY6', true]]);
  assert.ok(!t.lastBlob().text.includes('ACTION_REMOVE_VIDEO')); // the command itself is not written out
  assert.deepEqual([file.videos[0].title, file.videos[0].channel, file.videos[0].publishedText, file.videos[0].watchedPercent], ['Not started', 'Alpha Channel', '5 yr ago', null]);
  t.button('Save ticked as CSV').click();
  const lines = t.lastBlob().text.split('\r\n');
  assert.equal(lines[0], '﻿position,video_id,video_title,channel,duration,watched_percent,published_text,playable,entry_id,video_url');
  assert.equal(lines[2], '4,wl4,[Deleted video],,,,,false,ENTRY4,https://www.youtube.com/watch?v=wl4');

  t.button('Untick all').click();
  assert.deepEqual([tickedIds(), t.$('.filter [name="watched"]').checked, ruleOn()], ['', false, false]);
  // Tick all ticks every row; one can then be taken out by hand, and filters leave the rest alone.
  t.button('Tick all').click();
  assert.deepEqual([tickedIds(), t.$('p[role="status"]').textContent], ['1 2 3 4 5 6', '6 of 6 videos ticked.']);
  tick(2, false);
  set('watched', true);
  assert.equal(tickedIds(), '1 3 4 5 6');
  t.button('Untick all').click();
  assert.equal(t.$('p[role="status"]').textContent, '0 of 6 videos ticked.');
  // Reading the list took two requests, both of them reads, and nothing was edited.
  assert.deepEqual([t.calls, t.api.edits], [['VLWL', 'WL_2'], []]);
  assert.equal(t.button('Remove 0 ticked…').hidden, true); // not offered until it is allowed
  t.button('Back').click();
  assert.ok(!t.$('.panel').classList.contains('wide') && t.$('button[type="submit"]'));
});

await test('Watch later: ages are read whatever the browser makes of the language, and in another language', async () => {
  const open = async (options) => {
    const t = await boot({ url: WATCH_LATER_URL, ...options });
    t.$('.launcher').click();
    t.$('button[type="submit"]').click();
    await t.until(() => t.$('.rows') || t.$('.error'), 'the list');
    const set = (name, value) => {
      t.$(`.filter [name="${name}"]`).value = value;
      t.$(`.filter [name="${name}"]`).dispatchEvent(new t.window.Event('input', { bubbles: true }));
    };
    const ticked = () => [...t.root.querySelectorAll('.row')].filter((row) => row.querySelector('input').checked).map((row) => row.querySelector('p').textContent.split('.')[0]).join(' ');
    return { ...t, set, ticked, note: () => (t.$('form .note').hidden ? null : t.$('form .note').textContent) };
  };
  const withLanguage = (hl) => (window) => {
    const { get } = window.ytcfg;
    window.ytcfg = { get: (key) => (key === 'HL' ? hl : get(key)) };
  };
  // A browser that has no wording to offer at all: English is still read, by its pattern.
  const bare = await open({ prepare: (window) => { window.Intl.RelativeTimeFormat = function () { throw new RangeError('none'); }; } });
  bare.set('age', '3');
  assert.equal(bare.ticked(), '1 3 6'); // "3 years ago", "5 yr ago", "Streamed 12 years ago"
  bare.set('unit', 'months');
  bare.set('age', '2');
  assert.equal(bare.ticked(), '1 2 3 5 6');
  // A language tag the browser refuses ("en_GB"), and one that says nothing about the text.
  for (const hl of ['en_GB', 'zz', undefined]) {
    const odd = await open({ prepare: withLanguage(hl) });
    odd.set('age', '5');
    assert.equal(odd.ticked(), '3 6', String(hl));
  }
  // Another language altogether: the browser's wording for it is what is looked for.
  const german = await open({ prepare: withLanguage('de') });
  const inGerman = { '3 years ago': 'vor 3 Jahren', '‎2 months ago': 'vor 2 Monaten', '5 yr ago': 'Premiere vor 5 Jahren', '11 months ago': 'vor 11 Monaten', 'Streamed 12 years ago': 'Gestreamt vor 12 Jahren', '50K views': '50.000 Aufrufe' };
  german.setReshape((json) => JSON.parse(Object.entries(inGerman).reduce((all, [from, to]) => all.split(from).join(to), JSON.stringify(json))));
  german.button('Back').click();
  german.$('button[type="submit"]').click();
  await german.until(() => german.$('.rows') && german.root.querySelector('.row .note').textContent.includes('vor 3 Jahren'), 'the list in German');
  german.set('age', '5');
  assert.equal(german.ticked(), '3 6'); // "Premiere vor 5 Jahren" and "Gestreamt vor 12 Jahren"
  german.set('unit', 'months');
  german.set('age', '11');
  assert.equal(german.ticked(), '1 3 5 6');
  // What cannot be read is quoted, with any odd space or invisible mark written out.
  const unread = await open({});
  unread.setReshape((json) => JSON.parse(JSON.stringify(json).split('5 yr ago').join('Premieres 5 Dec')));
  unread.button('Back').click();
  unread.$('button[type="submit"]').click();
  await unread.until(() => unread.$('.rows') && unread.root.querySelectorAll('.row')[2].textContent.includes('Premieres'), 'the list again');
  unread.set('age', '1');
  assert.equal(unread.note(), 'No age found on 2 videos, so the age condition leaves them unticked. For example, YouTube\'s line for one reads “50K views • Premieres\\u{a0}5 Dec”.');
});

await test('Watch later: removing must be allowed and confirmed; first run removes one; a bad answer stops it', async () => {
  const open = async (t) => {
    if (t.$('.panel').hidden) t.$('.launcher').click();
    t.$('button[type="submit"]').click();
    await t.until(() => t.$('.rows') || t.$('.error'), 'the list');
  };
  const said = (t) => [...t.root.querySelectorAll('.panel p, .panel li')].map((el) => el.textContent);
  const t = await boot({ url: WATCH_LATER_URL });
  await open(t);
  const allow = () => t.$('[name="allow"]');
  assert.equal(allow().checked, false);
  t.button('Tick all').click();
  assert.equal(t.button('Remove 6 ticked…').hidden, true);
  allow().checked = true;
  allow().dispatchEvent(new t.window.Event('change', { bubbles: true }));
  assert.equal(t.button('Remove 6 ticked…').hidden, false);
  assert.equal(t.window.localStorage.getItem('yt-playlists-export:removal'), 'on');

  // The question. Cancel goes back to the same ticks, and nothing has been sent.
  t.button('Remove 6 ticked…').click();
  assert.ok(said(t).includes('Remove 1 video from Watch later?'));
  assert.ok(said(t).includes('1. Watched fully'));
  assert.ok(said(t).some((line) => line.startsWith('First run: only the first of the 6 ticked is removed')));
  t.button('Cancel').click();
  assert.equal(t.$('p[role="status"]').textContent, '6 of 6 videos ticked.');
  assert.deepEqual(t.api.edits, []);

  // First run: one video, its own command, a file saved before the request.
  t.button('Remove 6 ticked…').click();
  t.button('Remove 1 video').click();
  await t.until(() => t.button('Read the list again'), 'the removal to end');
  assert.deepEqual(t.api.edits, [{ playlistId: 'WL', actions: [{ setVideoId: 'ENTRY1', action: 'ACTION_REMOVE_VIDEO' }], params: 'CAFAAQ%3D%3D' }]);
  const record = JSON.parse(t.lastBlob().text);
  assert.deepEqual([record.schema, record.videos.map((video) => video.setVideoId)], ['youtube-watch-later-removal/1', ['ENTRY1']]);
  assert.ok(said(t).includes('Removed 1 of 1 video.'));
  assert.equal(t.window.localStorage.getItem('yt-playlists-export:removed-once'), 'yes');

  // Later runs take everything ticked. An answer that is not a success stops the run there.
  t.button('Read the list again').click();
  await t.until(() => t.$('.rows'), 'the list again');
  assert.equal(allow().checked, true); // remembered
  t.button('Tick all').click();
  t.api.editStatus = (body) => (body.actions[0].setVideoId === 'ENTRY4' ? 'STATUS_FAILED' : 'STATUS_SUCCEEDED');
  t.button('Remove 6 ticked…').click();
  assert.ok(said(t).includes('Remove 6 videos from Watch later?') && said(t).includes('and 1 other'));
  t.button('Remove 6 videos').click();
  await t.until(() => t.button('Read the list again'), 'the removal to end');
  assert.deepEqual(t.api.edits.slice(1).map((edit) => edit.actions[0].setVideoId), ['ENTRY1', 'ENTRY2', 'ENTRY3', 'ENTRY4']);
  assert.ok(said(t).includes('Removed 3 of 6 videos.'));
  assert.ok(said(t).includes('Stopped at 4. [Deleted video]: YouTube answered "STATUS_FAILED" where "STATUS_SUCCEEDED" was expected. Nothing was sent after it.'));

  // A row whose command is not exactly a removal from Watch later is never sent.
  const odd = await boot({ url: WATCH_LATER_URL, prepare: (window) => { window.localStorage.setItem('yt-playlists-export:removal', 'on'); window.localStorage.setItem('yt-playlists-export:removed-once', 'yes'); } });
  odd.setReshape((json) => JSON.parse(JSON.stringify(json).split('"playlistId":"WL","actions":[{"setVideoId":"ENTRY2"').join('"playlistId":"PLother","actions":[{"setVideoId":"ENTRY2"')));
  await open(odd);
  odd.button('Tick all').click();
  odd.button('Remove 6 ticked…').click();
  assert.ok(said(odd).includes('Remove 5 videos from Watch later?'));
  assert.ok(said(odd).some((line) => line.startsWith('1 ticked video cannot be removed')));
  // Stop ends it between requests.
  const slow = await boot({ url: WATCH_LATER_URL, latencyMs: 60, prepare: (window) => { window.localStorage.setItem('yt-playlists-export:removal', 'on'); window.localStorage.setItem('yt-playlists-export:removed-once', 'yes'); } });
  await open(slow);
  slow.button('Tick all').click();
  slow.button('Remove 6 ticked…').click();
  slow.button('Remove 6 videos').click();
  await slow.until(() => slow.api.edits.length === 2, 'two removals');
  slow.button('Stop').click();
  await slow.until(() => slow.button('Read the list again'), 'the stop');
  assert.ok(slow.api.edits.length <= 3 && said(slow).some((line) => line.startsWith('Stopped by you.')));
});

await test('Watch later: only that playlist gets the tidy button; the bookmarklet offers it there too', async () => {
  const other = await boot({ url: 'https://www.youtube.com/playlist?list=PLsomething' });
  assert.equal(other.$('.launcher').hidden, true);
  const t = await boot({ url: WATCH_LATER_URL, source: bookmarklet, userscriptMode: false });
  assert.equal(t.$('h2').textContent, 'Tidy Watch later');
  t.$('button[type="submit"]').click();
  await t.until(() => t.$('.rows'), 'the list');
  assert.equal(t.root.querySelectorAll('.row').length, 6);
  // An empty or missing list says so.
  const empty = await boot({ url: WATCH_LATER_URL });
  empty.setReshape(() => ({ alerts: [{ alertRenderer: { text: { simpleText: 'This playlist has no videos.' } } }] }));
  empty.$('.launcher').click();
  empty.$('button[type="submit"]').click();
  await empty.until(() => empty.$('.error'), 'the message');
  assert.equal(empty.$('.error').textContent, 'This playlist has no videos.');
});

await test('bookmarklet build: opens at once, same export, second click reuses the panel', async () => {
  assert.ok(bookmarkletUrl.startsWith('javascript:'));
  const t = await boot({ source: bookmarklet, userscriptMode: false });
  assert.equal(t.$('.panel').hidden, false);
  assert.equal(t.$('.launcher').hidden, true);
  t.start('videos');
  await t.finished();
  assert.equal(t.$('p').textContent, '7 playlists, 13 videos.');
  t.$('.close').click();
  assert.equal(t.$('.launcher').hidden, true); // no launcher in bookmarklet mode
  assert.equal(t.window.eval(bookmarklet), undefined);
  assert.equal(t.window.document.querySelectorAll('#yt-playlists-export').length, 1);
  assert.equal(t.$('.panel').hidden, false);
});

await test('signed out, or on another site: a clear message, no export', async () => {
  const out = await boot({ url: 'https://www.youtube.com/', userscriptMode: false, signedIn: false });
  out.start('playlists');
  await out.finished();
  assert.equal(out.$('.error').textContent, 'You do not seem to be signed in to YouTube in this tab.');
  assert.deepEqual(out.calls, []);
  const other = await boot({ url: 'https://example.com/', userscriptMode: false });
  other.start('playlists');
  await other.finished();
  assert.equal(other.$('.error').textContent, 'Run this on www.youtube.com/feed/playlists.');
});

console.log(results.join('\n'));
