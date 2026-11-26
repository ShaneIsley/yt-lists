// Real-browser check in headless Chrome: the script runs on a stand-in page served as
// https://www.youtube.com/feed/playlists with YouTube's Trusted Types policy, against
// the mock API. Checks rendering, real SHA-1 signing, real downloads; saves screenshots.
// Usage: npm install playwright-core && node build.mjs && node test/browser.mjs
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { SID, USER, YTCFG, createDemoApi, createMockApi } from './fixtures.mjs';

const ROOT = new URL('../', import.meta.url);
const SHOTS = new URL('shots/', ROOT);
// MEASURE=/path/to/older.user.js runs only the picture count, against that file.
const MEASURE = process.env.MEASURE;
const userscript = await readFile(MEASURE || new URL('youtube-playlists-export.user.js', ROOT), 'utf8');
const bookmarkletUrl = (await readFile(new URL('youtube-playlists-export.bookmarklet.txt', ROOT), 'utf8')).trim();
const bookmarklet = decodeURIComponent(bookmarkletUrl.slice('javascript:'.length));
const probe = await readFile(new URL('youtube-browse-probe.console.js', ROOT), 'utf8');
await mkdir(SHOTS, { recursive: true });

const DEMO = [
  { id: 'PLwatchlater1', title: 'Watch later', count: 212 },
  { id: 'PLcooking0002', title: 'Weeknight cooking', count: 48 },
  { id: 'PLtalks000003', title: 'Conference talks worth rewatching, 2019 to 2026', count: 740, hidden: 3 },
  { id: 'PLmusic000004', title: 'Focus music', count: 365 },
  { id: 'PLgone0000005', title: 'Saved from a deleted channel', count: 12, gone: true },
  { id: 'PLwoodwork006', title: 'Woodworking', count: 95 },
  { id: 'PLtravel00007', title: 'Japan trip ideas', count: 27 },
  { id: 'PLmaths000008', title: 'Linear algebra lectures', count: 130 },
];
const TOTAL_VIDEOS = DEMO.filter((p) => !p.gone).reduce((sum, p) => sum + p.count, 0);

const standIn = (dark) => `<!doctype html><html lang="en"${dark ? ' dark' : ''}><head><meta charset="utf-8">
<title>Playlists - YouTube</title>
<style>
  body { margin: 0; font-family: Roboto, Arial, sans-serif; background: ${dark ? '#0f0f0f' : '#fff'}; color: ${dark ? '#f1f1f1' : '#0f0f0f'}; }
  h1 { margin: 24px; font-size: 28px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 24px; }
  .card { aspect-ratio: 16 / 9; border-radius: 12px; background: ${dark ? '#272727' : '#e5e5e5'}; }
</style></head>
<body><h1>Playlists</h1><div class="grid">${'<div class="card"></div>'.repeat(12)}</div>
<script>window.ytcfg = { get: (key) => (${JSON.stringify(YTCFG)})[key] };</script></body></html>`;

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

async function openPage({ dark, latencyMs, pictureMs = 0, path = '/feed/playlists', search = '', api = createDemoApi(DEMO) }) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 620 }, deviceScaleFactor: 2 });
  await context.addCookies(
    ['SAPISID', '__Secure-3PAPISID'].map((name) => ({ name, value: SID, domain: '.youtube.com', path: '/', secure: true })),
  );
  const problems = [];
  const pictures = []; // every picture actually downloaded (cache hits do not count)
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`));

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === path) {
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'" },
        body: standIn(dark),
      });
    }
    if (url.pathname === '/youtubei/v1/browse/edit_playlist') {
      const { status, json } = api.edit(request.postDataJSON());
      return route.fulfill({ status, json }).catch(() => {});
    }
    if (url.pathname === '/youtubei/v1/browse') {
      // Signed by the browser's own crypto.subtle; check it the way YouTube would.
      const [scheme, token] = request.headers().authorization.split(' ');
      const [time, hash, flag] = token.split('_');
      const expected = createHash('sha1').update(`${USER} ${time} ${SID} https://www.youtube.com`).digest('hex');
      if (scheme !== 'SAPISIDHASH' || hash !== expected || flag !== 'u') problems.push('bad Authorization header');
      const { status, json } = api.respond(request.postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return route.fulfill({ status, json }).catch(() => {}); // the page may have aborted it
    }
    if (url.hostname === 'i.ytimg.com') {
      pictures.push(url.pathname);
      if (pictureMs) await new Promise((resolve) => setTimeout(resolve, pictureMs));
      // A stand-in picture: a coloured scene, different for every address.
      const hue = [...url.pathname].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 360, 7);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="hsl(${hue} 55% 45%)"/><circle cx="${60 + (hue % 200)}" cy="70" r="46" fill="hsl(${(hue + 40) % 360} 70% 70%)"/><rect y="130" width="320" height="50" fill="hsl(${(hue + 200) % 360} 40% 25%)"/></svg>`;
      return route.fulfill({ contentType: 'image/svg+xml', body: svg }).catch(() => {}); // the page may be gone
    }
    return route.fulfill({ status: 204, body: '' });
  });

  await page.goto(`https://www.youtube.com${path}${search}`);
  const shot = async (name, selector = '.panel', pad = 28) => {
    const box = await page.locator(selector).boundingBox();
    await page.screenshot({
      path: new URL(`${name}.png`, SHOTS).pathname,
      clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad },
    });
  };
  const percent = async () => Number.parseInt(await page.locator('.split .muted').textContent(), 10) || 0;
  const save = async (label) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByText(label).click()]);
    return { name: download.suggestedFilename(), text: await readFile(await download.path(), 'utf8') };
  };
  return { page, api, problems, pictures, shot, percent, save, close: () => context.close() };
}

// ---- Picture downloads over one full run of the demo account (21 API requests).
for (const minimised of [false, true]) {
  const t = await openPage({ dark: false, latencyMs: 220 });
  await t.page.evaluate('window.GM_info = { script: {} }');
  await t.page.evaluate(userscript);
  await t.page.locator('.launcher').click();
  await t.page.getByText('Playlists and their videos').click();
  await t.page.getByRole('button', { name: 'Export', exact: true }).click();
  if (minimised) await t.page.locator('.close').click();
  await t.page.getByText(minimised ? 'Export ready' : 'Download JSON').waitFor({ timeout: 60000 });
  const small = t.pictures.filter((path) => path.endsWith('/default.jpg')).length;
  console.log(`info picture downloads, panel ${minimised ? 'minimised' : 'open'}: ${t.pictures.length} (${small} at 120x90)`);
  await t.close();
}
// ---- Slow pictures (350 ms each): what does the strip show, frame by frame?
{
  const t = await openPage({ dark: false, latencyMs: 220, pictureMs: 350 });
  await t.page.evaluate('window.GM_info = { script: {} }');
  await t.page.evaluate(userscript);
  await t.page.locator('.launcher').click();
  await t.page.evaluate(() => {
    const root = document.getElementById('yt-playlists-export').shadowRoot;
    const seen = (window.stripFrames = { frames: 0, unfinished: 0, sets: new Set() });
    const look = () => {
      const shown = [...root.querySelectorAll('.strip img')].filter((img) => !img.hidden);
      if (shown.length) {
        seen.frames += 1;
        seen.sets.add(shown.map((img) => img.src).join(' '));
        // A tile whose picture is still on its way shows the old picture, or nothing.
        if (shown.some((img) => !img.complete || !img.naturalWidth)) seen.unfinished += 1;
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await t.page.getByText('Playlists and their videos').click();
  await t.page.getByRole('button', { name: 'Export', exact: true }).click();
  await t.page.getByText('Download JSON').waitFor({ timeout: 60000 });
  const seen = await t.page.evaluate(() => ({ ...window.stripFrames, sets: window.stripFrames.sets.size }));
  console.log(`info strip with slow pictures: ${seen.sets} different sets over ${seen.frames} frames, ${seen.unfinished} frames with a picture still loading`);
  if (!MEASURE) {
    assert.ok(seen.frames > 100 && seen.sets >= 5, JSON.stringify(seen));
    assert.equal(seen.unfinished, 0); // every change of the strip is complete in the frame it appears
    assert.deepEqual(t.problems, []);
  }
  await t.close();
}

if (MEASURE) {
  await browser.close();
  process.exit(0);
}

// ---- Light theme, userscript mode: full run with minimise, then real downloads.
{
  const t = await openPage({ dark: false, latencyMs: 220 });
  await t.page.evaluate('window.GM_info = { script: {} }');
  await t.page.evaluate(userscript); // like a userscript manager: not subject to the page's policy

  await t.page.locator('.launcher').click();
  await t.shot('1-options');
  await t.page.getByText('Playlists and their videos').click();
  await t.page.getByRole('button', { name: 'Export', exact: true }).click();

  await t.page.locator('progress:not([value])').waitFor(); // busy bar while the list is read
  await t.page.getByText('Playlist 3 of 8').waitFor();
  while ((await t.percent()) < 45) await t.page.waitForTimeout(50);
  assert.match(await t.page.locator('.note').last().textContent(), /^[\d,]+ videos so far( · .+ left)?$/);
  assert.match(await t.page.locator('.now .note').textContent(), /^[1-7]00 of 743 videos$/);
  // The line on the cover is drawn, and as wide as that share of the tile.
  const [meter, fill] = await Promise.all(['.meter', '.meter div'].map((selector) => t.page.locator(selector).boundingBox()));
  const share = Number.parseInt(await t.page.locator('.now .note').textContent(), 10) / 743;
  assert.ok(meter.height === 4 && Math.abs(fill.width / meter.width - share) < 0.02, JSON.stringify({ meter, fill, share }));
  // The pictures really load: the cover and a few sampled videos. On this 2x screen the
  // cover is the 336-wide source; the videos are the small 120x90 ones.
  await t.page.waitForFunction(() => {
    const images = [...document.getElementById('yt-playlists-export').shadowRoot.querySelectorAll('.now img, .strip img')].filter((img) => !img.hidden);
    return images.length >= 4 && images.every((img) => img.complete && img.naturalWidth > 0);
  });
  assert.match(await t.page.locator('.now img').getAttribute('src'), /\/large\.jpg/);
  assert.match(await t.page.locator('.strip img').first().getAttribute('src'), /\/default\.jpg$/);
  assert.equal(await t.page.locator('.strip img').first().getAttribute('fetchpriority'), 'low');
  await t.shot('2-progress');

  await t.page.locator('.close').click();
  assert.match(await t.page.locator('.launcher').textContent(), /^Exporting… \d+%$/);
  await t.shot('3-minimised', '.launcher');
  await t.page.getByText('Export ready').waitFor({ timeout: 60000 });
  await t.page.locator('.launcher').click();

  assert.equal(await t.page.locator('.panel p').first().textContent(), `8 playlists, ${TOTAL_VIDEOS.toLocaleString()} videos.`);
  for (const summary of await t.page.locator('summary').all()) await summary.click();
  await t.shot('4-result');

  const json = await t.save('Download JSON');
  const data = JSON.parse(json.text);
  assert.match(json.name, /^youtube-playlists-\d{4}-\d\d-\d\d\.json$/);
  assert.equal(data.complete, true);
  assert.ok(!json.text.includes('ytimg'));
  assert.deepEqual(data.playlists.map((p) => p.videos.length), DEMO.map((p) => (p.gone ? 0 : p.count)));
  assert.equal(data.playlists[4].error, 'The playlist does not exist.');
  const csv = await t.save('Download CSV');
  assert.ok(csv.name.endsWith('.csv') && csv.text.startsWith('\ufeffplaylist_id,'));
  assert.equal(csv.text.trimEnd().split('\r\n').length, 1 + TOTAL_VIDEOS + 1);
  assert.deepEqual(t.problems, []);
  await t.close();
}

// ---- Dark theme, bookmarklet build: keyboard use, then Stop part-way.
{
  const t = await openPage({ dark: true, latencyMs: 220 });
  await t.page.evaluate(bookmarklet);
  await t.page.locator('.panel').waitFor();
  // Keyboard only: focus starts on the chosen option; arrow down, then Enter to export.
  assert.equal(await t.page.evaluate(() => document.activeElement.id), 'yt-playlists-export');
  await t.page.keyboard.press('ArrowDown');
  await t.page.keyboard.press('Enter');
  await t.page.getByText('Playlist 4 of 8').waitFor({ timeout: 60000 });
  // Focus followed into the progress view, so Stop is one key away.
  assert.equal(await t.page.evaluate(() => document.activeElement.shadowRoot.activeElement.textContent), 'Stop');
  await t.shot('5-progress-dark');
  await t.page.keyboard.press('Enter');
  await t.page.getByText('Stopped after 3 of 8 playlists').waitFor();
  await t.shot('6-stopped-dark');
  const data = JSON.parse((await t.save('Download JSON')).text);
  assert.equal(data.complete, false);
  assert.deepEqual(data.playlists.map((p) => p.videos?.length), [212, 48, 740, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(t.problems, []);
  await t.close();
}

// ---- Watch history: options, progress by day, result and a real download.
{
  const t = await openPage({ dark: false, latencyMs: 700, path: '/feed/history', api: createMockApi() });
  await t.page.evaluate('window.GM_info = { script: {} }');
  await t.page.evaluate(userscript);
  assert.equal(await t.page.locator('.launcher').textContent(), 'Export history');
  await t.page.locator('.launcher').click();
  await t.shot('7-history-options');
  await t.page.getByText('Everything').click();
  await t.page.getByRole('button', { name: 'Export', exact: true }).click();
  await t.page.locator('.headline', { hasText: 'History:' }).waitFor();
  await t.page.waitForFunction(() => [...document.getElementById('yt-playlists-export').shadowRoot.querySelectorAll('.strip img')].some((img) => !img.hidden && img.complete));
  await t.shot('8-history-progress');
  await t.page.getByText('Download JSON').waitFor({ timeout: 60000 });
  for (const summary of await t.page.locator('summary').all()) await summary.click();
  await t.shot('9-history-result');
  const json = await t.save('Download JSON');
  assert.match(json.name, /^youtube-history-\d{4}-\d\d-\d\d\.json$/);
  const data = JSON.parse(json.text);
  assert.deepEqual([data.items.length, data.complete, data.undated], [13, true, ['Some time ago']]);
  assert.match(data.items[0].watchedOn, /^\d{4}-\d\d-\d\d$/);
  const csv = await t.save('Download CSV');
  assert.ok(csv.name.startsWith('youtube-history-') && csv.text.split('\r\n').length === 15);
  assert.deepEqual(t.problems, []);
  await t.close();
}

// ---- Watch later: the list to tick, in the wider panel, and a file saved on a click.
{
  const t = await openPage({ dark: true, latencyMs: 150, path: '/playlist', search: '?list=WL', api: createMockApi() });
  await t.page.evaluate('window.GM_info = { script: {} }');
  await t.page.evaluate(userscript);
  assert.equal(await t.page.locator('.launcher').textContent(), 'Tidy Watch later');
  await t.page.locator('.launcher').click();
  await t.page.getByRole('button', { name: 'Read the list' }).click();
  await t.page.locator('.rows').waitFor();
  await t.page.locator('.filter [name="watched"]').check();
  await t.page.locator('.filter [name="unavailable"]').check();
  assert.equal(await t.page.locator('p[role="status"]').textContent(), '3 of 6 videos ticked.');
  // Typing in the panel must not reach the page (YouTube has single-key shortcuts).
  await t.page.evaluate(() => { window.keysSeen = 0; document.addEventListener('keydown', () => { window.keysSeen += 1; }); });
  // Typed key by key, without touching the Rule tick box: the rule switches itself on.
  await t.page.getByLabel('Channel contains').click();
  await t.page.keyboard.type('betak');
  assert.equal(await t.page.evaluate(() => window.keysSeen), 0);
  assert.equal(await t.page.locator('.filter [name="rule"]').isChecked(), true);
  assert.equal(await t.page.locator('p[role="status"]').textContent(), '3 of 6 videos ticked.'); // nothing is called "betak"
  await t.page.keyboard.press('Backspace');
  assert.equal(await t.page.locator('p[role="status"]').textContent(), '5 of 6 videos ticked.');
  await t.page.getByLabel('Published at least this long ago').click();
  await t.page.keyboard.type('5');
  assert.equal(await t.page.locator('p[role="status"]').textContent(), '4 of 6 videos ticked.');
  await t.shot('12-watch-later');
  await t.page.keyboard.press('Backspace');
  await t.page.getByRole('button', { name: 'Tick all', exact: true }).click();
  assert.equal(await t.page.locator('p[role="status"]').textContent(), '6 of 6 videos ticked.');
  await t.page.getByRole('button', { name: 'Untick all' }).click();
  assert.equal(await t.page.locator('p[role="status"]').textContent(), '0 of 6 videos ticked.');
  await t.page.locator('.filter [name="watched"]').check();
  await t.page.locator('.filter [name="unavailable"]').check();
  await t.page.getByLabel('Channel contains').fill('beta');
  assert.equal(await t.page.locator('p[role="status"]').textContent(), '5 of 6 videos ticked.');
  const saved = await t.save('Save ticked as JSON');
  assert.match(saved.name, /^youtube-watch-later-ticked-\d{4}-\d\d-\d\d\.json$/);
  assert.deepEqual(JSON.parse(saved.text).videos.map((video) => video.videoId), ['wl1', 'wl2', 'wl4', 'wl5', 'wl6']);
  assert.deepEqual([t.api.calls, t.api.edits], [['VLWL', 'WL_2'], []]);
  // Allowed, asked, and on a first run one video goes, with its record saved first.
  await t.page.getByLabel('Allow this script to remove videos from Watch later').check();
  await t.page.getByRole('button', { name: 'Remove 5 ticked…' }).click();
  await t.shot('13-confirm');
  const download = t.page.waitForEvent('download');
  await t.page.getByRole('button', { name: 'Remove 1 video', exact: true }).click();
  assert.match((await download).suggestedFilename(), /^youtube-watch-later-removed-/);
  await t.page.getByRole('button', { name: 'Read the list again' }).waitFor();
  assert.deepEqual(t.api.edits.map((edit) => edit.actions), [[{ setVideoId: 'ENTRY1', action: 'ACTION_REMOVE_VIDEO' }]]);
  await t.shot('13-removed');
  assert.deepEqual(t.problems, []);
  await t.close();
}

// ---- The console probe, pasted into the same page.
{
  const t = await openPage({ dark: false, latencyMs: 20 });
  await t.page.evaluate(probe);
  const report = await t.page.evaluate(() => window.ytProbe);
  assert.deepEqual(report.checks.filter((entry) => !entry.ok), []);
  assert.equal(report.paging.videos[0]['items it brings'], 100);
  assert.equal(await t.page.evaluate(() => JSON.parse(localStorage.getItem('yt-playlists-export:probe')).playlist), 'PLtalks000003'); // the largest
  assert.deepEqual(t.problems, []);
  await t.close();
}

await browser.close();
console.log('ok   real Chrome: Trusted Types, signing, progress, minimise, stop, downloads, console probe');
