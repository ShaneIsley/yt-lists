// Mock of YouTube's "browse" API in both data layouts, shared by the jsdom tests
// (run.mjs) and the real-browser check (browser.mjs).

export const SID = 'sid/value-123';
export const USER = '1122334455';
export const YTCFG = {
  INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261120.01.00', hl: 'en', gl: 'AU' } },
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20261120.01.00',
  DATASYNC_ID: `${USER}||`,
  SESSION_INDEX: '0',
  HL: 'en-GB',
};

// ------------------------------------------------------------------ builders

const channelRun = (name, id) => ({
  content: name,
  commandRuns: [{ startIndex: 0, length: name.length, onTap: { innertubeCommand: { browseEndpoint: { browseId: id } } } }],
});

export const playlistCard = (id, title, badge, { owner, type = 'LOCKUP_CONTENT_TYPE_PLAYLIST' } = {}) => ({
  lockupViewModel: {
    contentId: id,
    contentType: type,
    contentImage: {
      collectionThumbnailViewModel: {
        primaryThumbnail: {
          thumbnailViewModel: {
            // Smallest first, as YouTube sends them; one address without a scheme.
            image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/small.jpg?sqp=a&rs=b`, width: 168 }, { url: `//i.ytimg.com/vi/${id}/large.jpg?sqp=c&rs=d`, width: 336 }] },
            overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: badge } }] } }],
          },
        },
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: title },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              { metadataParts: [{ text: owner ? channelRun(owner, 'UCowner123') : { content: 'Private' } }, { text: { content: 'Playlist' } }] },
              { metadataParts: [{ text: { content: 'Updated today' } }] },
              // Decoy: a browse link that is not a channel.
              { metadataParts: [{ text: channelRun('View full playlist', `VL${id}`) }] },
            ],
          },
        },
      },
    },
  },
});

const channelTap = (id) => ({ rendererContext: { commandContext: { onTap: { innertubeCommand: { browseEndpoint: { browseId: id } } } } } });

/** extra: { index, watched, resume, credits: [channel ids] } */
export const videoRow = (id, title, channel, duration, views = '1M views', published = '3 years ago', extra = {}) => ({
  lockupViewModel: {
    contentId: id,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    rendererContext: {
      commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: id, playlistId: 'PLx', index: extra.index ?? 0, ...(extra.resume && { startTimeSeconds: extra.resume }) } } } },
    },
    contentImage: {
      thumbnailViewModel: {
        image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg?sqp=signed&rs=signed`, width: 168 }] },
        overlays: [
          {
            thumbnailBottomOverlayViewModel: {
              badges: [{ thumbnailBadgeViewModel: { text: duration } }],
              ...(extra.watched != null && { progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: extra.watched } } }),
            },
          },
        ],
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        // One channel: its avatar, linked. Several: a stack of avatars that opens a list of them.
        image: extra.credits
          ? { avatarStackViewModel: { rendererContext: { commandContext: { onTap: { innertubeCommand: { showDialogCommand: { panelLoadingStrategy: { inlineContent: { dialogViewModel: { customContent: { listViewModel: { listItems: extra.credits.map((credit) => ({ listItemViewModel: { title: { content: 'A credited channel' }, ...channelTap(credit) } })) } } } } } } } } } } } }
          : { decoratedAvatarViewModel: channelTap('UCchan456') },
        title: { content: title },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              { metadataParts: [{ text: extra.credits ? { content: channel } : channelRun(channel, 'UCchan456') }] },
              { metadataParts: [{ text: { content: views } }, { text: { content: published } }] },
            ],
          },
        },
      },
    },
  },
});

const oldVideoRow = (id, title, channel, duration) => ({
  playlistVideoRenderer: {
    videoId: id,
    title: { runs: [{ text: title }] },
    navigationEndpoint: { watchEndpoint: { videoId: id, index: id === 'old1' ? 0 : 1 } },
    ...(id === 'old1' && { thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: {} }, { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 64 } }] }),
    // Deleted and private videos come without a channel line.
    ...(channel && { shortBylineText: { runs: [{ text: channel, navigationEndpoint: { browseEndpoint: { browseId: 'UCold789' } } }] } }),
    lengthText: { simpleText: duration },
    // A deleted video has neither a length nor "views • age".
    ...(channel && { lengthSeconds: '180', videoInfo: { runs: [{ text: '50K views' }, { text: ' • ' }, { text: '10 years ago' }] } }),
  },
});

// New layout: the token is two levels down, under an outer continuationCommand that has none.
const newMore = (token) => ({
  continuationItemViewModel: {
    trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
    continuationCommand: { innertubeCommand: { continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } },
  },
});
const oldMore = (token) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
const oldMoreViaExecutor = (token) => ({
  continuationItemRenderer: {
    continuationEndpoint: { commandExecutorCommand: { commands: [{ somethingElse: {} }, { continuationCommand: { token } }] } },
  },
});

const feedPage = (items, token) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              richGridRenderer: {
                // Decoy: chips carry tokens that reload the list. They must be ignored.
                header: { feedFilterChipBarRenderer: { contents: [{ chipCloudChipRenderer: { navigationEndpoint: { continuationCommand: { token: 'DECOY_CHIP' } } } }] } },
                contents: [...items.map((content) => ({ richItemRenderer: { content } })), ...(token ? [oldMore(token)] : [])],
              },
            },
          },
        },
      ],
    },
  },
});
const newPlaylistPage = (rows, token) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [...rows, ...(token ? [newMore(token)] : [])] } }] } } } }],
    },
  },
});
const oldPlaylistPage = (rows, more) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: [...rows, ...(more ? [more] : [])] } }] } }] } } } }],
    },
  },
});
const appended = (items) => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] });

// ------------------------------------------------------------- Watch later
// As the live page has it: the older row, with the entry's own id, a playable flag, watch
// progress and a menu whose "Remove from Watch later" item carries the command to send.

const menuItem = (label, serviceEndpoint) => ({ menuServiceItemRenderer: { text: { runs: [{ text: label }] }, serviceEndpoint } });
// "info" replaces the usual views-and-age line, for the other ways YouTube may write it.
const watchLaterRow = (n, id, title, { channel = 'Alpha Channel', watched, age = '3 years ago', playable = true, info } = {}) => ({
  playlistVideoRenderer: {
    videoId: id,
    setVideoId: `ENTRY${n}`,
    isPlayable: playable,
    index: { simpleText: String(n) },
    title: { runs: [{ text: title }] },
    ...(playable && {
      shortBylineText: { runs: [{ text: channel, navigationEndpoint: { browseEndpoint: { browseId: 'UCwatchlater' } } }] },
      lengthText: { simpleText: '10:00' },
      lengthSeconds: '600',
      videoInfo: info || { runs: [{ text: '50K views' }, { text: ' • ' }, { text: age }] },
    }),
    navigationEndpoint: { watchEndpoint: { videoId: id, playlistId: 'WL', index: n - 1 } },
    thumbnailOverlays: [
      { thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '10:00' }, style: 'DEFAULT' } },
      ...(watched == null ? [] : [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: watched } }]),
    ],
    menu: {
      menuRenderer: {
        items: [
          menuItem('Add to queue', { signalServiceEndpoint: { signal: 'CLIENT_SIGNAL' } }),
          // Decoy: another edit of the same playlist that is not a removal.
          menuItem('Move to top', { playlistEditEndpoint: { playlistId: 'WL', actions: [{ action: 'ACTION_MOVE_VIDEO_BEFORE', setVideoId: `ENTRY${n}` }] } }),
          menuItem('Remove from Watch later', {
            commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse/edit_playlist' } },
            playlistEditEndpoint: { playlistId: 'WL', actions: [{ setVideoId: `ENTRY${n}`, action: 'ACTION_REMOVE_VIDEO' }], params: 'CAFAAQ%3D%3D', clientActions: [{ playlistRemoveVideosAction: { setVideoIds: [`ENTRY${n}`] } }] },
          }),
        ],
      },
    },
  },
});

// --------------------------------------------- small, awkward set (run.mjs)

const FEED = {
  FEplaylist_aggregation: feedPage(
    [
      playlistCard('PLnew', '=Formula, "quoted" title', '5 videos'),
      playlistCard('PLold', 'Old layout list', '1,003 videos', { owner: 'Some Channel' }),
      playlistCard('PLretry', 'Needs a retry', '1 video'),
    ],
    'FEED_2',
  ),
  FEED_2: appended([
    { richItemRenderer: { content: playlistCard('PLgone', 'Deleted by owner', '7 videos') } },
    { richItemRenderer: { content: playlistCard('PLdenied', 'Server says no', '2 videos') } },
    { richItemRenderer: { content: playlistCard('PLloop', 'Token repeats', '2 videos', { type: 'LOCKUP_CONTENT_TYPE_PODCAST' }) } },
    { richItemRenderer: { content: playlistCard('PLnew', 'Duplicate card', '5 videos') } },
    { gridPlaylistRenderer: { playlistId: 'PLgrid', title: { simpleText: 'Old style card' }, thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/g1/default.jpg', width: 120 }, { url: 'https://i.ytimg.com/vi/g1/mqdefault.jpg', width: 320 }] }, videoCountText: { runs: [{ text: '3' }, { text: ' videos' }] } } },
  ]),
};

const LISTS = {
  VLPLnew: newPlaylistPage(
    [
      videoRow('vidA', 'Alpha', 'Chan A', '4:05', '1M views', '3 years ago', { index: 0, watched: 100 }),
      videoRow('-vidB', 'Beta', 'Chan B', '1:02:03', '1M views', '3 years ago', { index: 1, watched: 37, resume: 1377 }),
    ],
    'NEW_2',
  ),
  NEW_2: appended([
    videoRow('vidC', 'Gamma', 'Chan C', '0:59', '1M views', '3 years ago', { index: 2 }),
    videoRow('vidA', 'Alpha', 'Chan A', '4:05', '1M views', '3 years ago', { index: 3, watched: 100 }),
    newMore('NEW_3'),
  ]),
  // Index 4 is a video YouTube hides. This row is credited to two channels.
  NEW_3: appended([videoRow('vidD', 'Delta', 'Chan D and Chan E', 'LIVE', '1M views', '3 years ago', { index: 5, credits: ['UCcredit1', 'UCcredit2'] })]),
  VLPLold: oldPlaylistPage([oldVideoRow('old1', 'Old one', 'Old Chan', '3:00')], oldMoreViaExecutor('OLD_2')),
  OLD_2: appended([oldVideoRow('old2', '[Deleted video]', '', '')]),
  VLPLretry: newPlaylistPage([videoRow('vidR', 'Retry', 'Chan R', '2:00')]),
  VLPLgone: { alerts: [{ alertRenderer: { type: 'ERROR', text: { simpleText: 'The playlist does not exist.' } } }] },
  VLPLloop: newPlaylistPage([videoRow('loop1', 'Loop one', 'Chan L', '1:00')], 'LOOP'),
  LOOP: appended([videoRow('loop2', 'Loop two', 'Chan L', '1:00'), newMore('LOOP')]),
  VLWL: {
    ...oldPlaylistPage(
      [
        // Ages as they may really arrive: a no-break space inside, an invisible mark in front, abbreviated.
        watchLaterRow(1, 'wl1', 'Watched fully', { watched: 100, age: '3 years ago' }),
        watchLaterRow(2, 'wl2', 'Half watched', { channel: 'Beta Channel', watched: 45, age: '‎2 months ago' }),
        watchLaterRow(3, 'wl3', 'Not started', { age: '5 yr ago' }),
        watchLaterRow(4, 'wl4', '[Deleted video]', { playable: false }),
      ],
      oldMoreViaExecutor('WL_2'),
    ),
    alerts: [{ alertWithButtonRenderer: { type: 'INFO', text: { simpleText: 'Unavailable videos are hidden' }, dismissButton: { buttonRenderer: {} } } }],
  },
  WL_2: appended([
    // One line of text, with a different dot and no-break spaces around it.
    watchLaterRow(5, 'wl5', 'Nearly done', { channel: 'Gamma', watched: 92, info: { simpleText: '50K views\u00a0\u00b7\u00a011 months ago' } }),
    // A line that is not split where expected: the age is still in there.
    watchLaterRow(6, 'wl6', 'Old talk', { channel: 'Béta Channel', info: { simpleText: '50K views - Streamed 12 years ago' } }),
  ]),
  VLPLtwo: {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
          { itemSectionRenderer: { contents: [videoRow('two1', 'Two 1', 'Chan T', '1:00'), videoRow('two2', 'Two 2', 'Chan T', '2:00'), newMore('TWO_2')] } },
          newMore('TWO_BESIDE'),
        ] } } } }],
      },
    },
  },
  TWO_2: appended([videoRow('two3', 'Two 3', 'Chan T', '3:00', '12 watching', '')]),
  TWO_BESIDE: appended([]),
  VLPLcredit: newPlaylistPage([
    videoRow('cr1', 'Credited', 'Chan A and Chan B', '1:00', '1M views', '3 years ago', { index: 0, credits: ['UCcredit1', 'UCcredit2'] }),
    videoRow('cr2', 'Plain', 'Chan C', '2:00', '1M views', '3 years ago', { index: 1 }),
  ]),
  VLPLgrid: newPlaylistPage([videoRow('g1', 'G1', 'Chan G', '1:00'), videoRow('g2', 'G2', 'Chan G', '1:00'), videoRow('g3', 'G3', 'Chan G', '1:00')]),
};

// ------------------------------------------------------------ watch history

const historyRow = (older, id, title) =>
  older
    ? {
        videoRenderer: {
          videoId: id,
          title: { runs: [{ text: title }] },
          ownerText: { runs: [{ text: 'Old Chan', navigationEndpoint: { browseEndpoint: { browseId: 'UCold789' } } }] },
          lengthText: { simpleText: '3:00' },
          viewCountText: { simpleText: '50K views' },
          descriptionSnippet: { runs: [{ text: 'About this video' }] },
          thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 64 } }],
        },
      }
    : videoRow(id, title, 'Chan H', '4:05', '1M views', '', { watched: 80 });
// As on the live page: "Today" and "Yesterday" come as runs, other headings as simpleText.
const dayOf = (heading, contents) => ({
  itemSectionRenderer: {
    header: { itemSectionHeaderRenderer: { title: /^(Today|Yesterday)$/.test(heading) ? { runs: [{ text: heading }] } : { simpleText: heading } } },
    contents,
  },
});
const shortsShelf = (ids) => ({
  reelShelfRenderer: {
    title: { runs: [{ text: 'Shorts' }] },
    items: ids.map((id) => ({ shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } }, overlayMetadata: { primaryText: { content: `Short ${id}` }, secondaryText: { content: '2M views' } } } })),
  },
});

const enGB = (options, date) => new Intl.DateTimeFormat('en-GB', options).format(date);
export const daysAgo = (n, now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12);
/** The headings YouTube would show, in British English, for days 2, 3, 10 and 400 ago. */
export const historyHeadings = (now = new Date()) => ({
  d2: enGB({ weekday: 'long' }, daysAgo(2, now)),
  d3: enGB({ weekday: 'long' }, daysAgo(3, now)),
  d10: `${daysAgo(10, now).getDate()} ${enGB({ month: 'short' }, daysAgo(10, now))}`,
  d400: `${daysAgo(400, now).getDate()} ${enGB({ month: 'short' }, daysAgo(400, now))} ${daysAgo(400, now).getFullYear()}`,
});

/**
 * Three responses of history, newest first. The day that ends the first response carries
 * on in the second. Then come a date without a year, one with a year, and a heading that
 * is not a date at all.
 */
const historyPages = (older, now) => {
  const { d2, d3, d10, d400 } = historyHeadings(now);
  const row = (id, title) => historyRow(older, id, title);
  return {
    FEhistory: {
      header: { pageHeaderRenderer: { pageTitle: 'Watch history' } }, // the page's own header is not a day
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
            dayOf('Today', [row('hist1', 'History one'), row('hist2', 'History two'), shortsShelf(['sh1', 'sh2', 'sh3'])]),
            dayOf('Yesterday', [row('hist3', 'History three')]),
            dayOf(d2, [row('hist4', 'History four')]),
            oldMore('HIST_2'), // the live history still uses the older "load more" item
          ] } } } }],
        },
      },
    },
    HIST_2: appended([
      dayOf(d2, [row('hist5', 'History five')]),
      dayOf(d3, [row('hist6', 'History six'), row('hist7', 'History seven'), playlistCard('PLwatched', 'A playlist in the history', '3 videos')]),
      dayOf(d10, [row('hist8', 'History eight')]),
      oldMore('HIST_3'),
    ]),
    HIST_3: appended([dayOf(d400, [row('hist9', 'History nine')]), dayOf('Some time ago', [row('hist10', 'History ten')])]),
  };
};

/** respond(body) -> { status, json }. calls lists every browseId or token asked for. */
export function createMockApi({ feedStatus = 200, olderHistory = false, now = new Date() } = {}) {
  const HISTORY = historyPages(olderHistory, now);
  const calls = [];
  const edits = []; // every request that would change something
  let retryHits = 0;
  return {
    calls,
    edits,
    /** The answer to an edit of a playlist. "editStatus" may be a function of the request. */
    editStatus: 'STATUS_SUCCEEDED',
    edit(body) {
      edits.push({ playlistId: body.playlistId, actions: body.actions, params: body.params });
      const status = typeof this.editStatus === 'function' ? this.editStatus(body) : this.editStatus;
      return { status: 200, json: { status } };
    },
    respond(body) {
      const key = body.browseId || body.continuation;
      calls.push(key);
      if (key === 'FEplaylist_aggregation' && feedStatus !== 200) return { status: feedStatus, json: {} };
      if (key in FEED) return { status: 200, json: FEED[key] };
      if (key in HISTORY) return { status: 200, json: HISTORY[key] };
      if (key === 'VLPLretry' && retryHits++ === 0) return { status: 429, json: {} };
      if (key === 'VLPLdenied') return { status: 403, json: {} };
      if (key in LISTS) return { status: 200, json: LISTS[key] };
      return { status: 404, json: {} };
    },
  };
}

// ------------------------------------- larger, realistic set (browser.mjs)

/** playlists: [{ id, title, count, gone? }]. Videos come 100 to a request, as on YouTube. */
export function createDemoApi(playlists) {
  const calls = [];
  const byId = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  const page = (playlist, pageNo) => {
    const from = pageNo * 100;
    const to = Math.min(from + 100, playlist.count);
    const rows = [];
    for (let i = from; i < to; i++) rows.push(videoRow(`${playlist.id}-${i}`.slice(-11), `${playlist.title} #${i + 1}`, 'Some Channel', '3:21'));
    const more = to < playlist.count ? `${playlist.id}:${pageNo + 1}` : null;
    return pageNo === 0 ? newPlaylistPage(rows, more) : appended([...rows, ...(more ? [newMore(more)] : [])]);
  };
  return {
    calls,
    respond(body) {
      const key = body.browseId || body.continuation;
      calls.push(key);
      if (key === 'FEplaylist_aggregation') {
        // The cards show YouTube's count, which includes videos it later hides.
        return { status: 200, json: feedPage(playlists.map((p) => playlistCard(p.id, p.title, `${(p.count + (p.hidden || 0)).toLocaleString('en')} videos`))) };
      }
      const [id, pageNo = '0'] = key.replace(/^VL/, '').split(':');
      const playlist = byId.get(id);
      if (!playlist) return { status: 404, json: {} };
      if (playlist.gone) return { status: 200, json: LISTS.VLPLgone };
      return { status: 200, json: page(playlist, Number(pageNo)) };
    },
  };
}
