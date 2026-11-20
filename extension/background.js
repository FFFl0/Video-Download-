// Service worker: перехватывает сетевые ответы с видео, хранит список
// найденных файлов для каждой вкладки и управляет загрузками HLS.
importScripts('m3u8.js');

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|ogv|3gp|avi|flv)(?:$|[?#])/i;
const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv'
};
const HLS_MIME_RE = /mpegurl/i;
const HLS_URL_RE = /\.m3u8(?:$|[?#:])/i;
// Сегменты и форматы, которые нельзя скачать одним файлом.
const SKIP_MIME_RE = /(dash\+xml|mp2t|iso\.segment)/i;
const SKIP_URL_RE = /\.(mpd|ts|m4s|aac)(?:$|[?#])|[?&](range|bytestart|byteend)=/i;

const MAX_PER_TAB = 100;

// ---------- Хранилище ----------

const cache = new Map(); // tabId -> Array<video>
let queue = Promise.resolve();

function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function load(tabId) {
  if (cache.has(tabId)) return cache.get(tabId);
  const key = `tab_${tabId}`;
  const data = await chrome.storage.session.get(key);
  const list = data[key] || [];
  cache.set(tabId, list);
  return list;
}

function notify(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function save(tabId, list) {
  cache.set(tabId, list);
  await chrome.storage.session.set({ [`tab_${tabId}`]: list });
  updateBadge(tabId, list.filter((v) => !v.hidden).length);
  notify({ type: 'videos-updated', tabId });
}

async function clearTab(tabId) {
  cache.delete(tabId);
  await chrome.storage.session.remove(`tab_${tabId}`);
  updateBadge(tabId, 0);
}

function updateBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

const FIELDS = ['kind', 'mime', 'ext', 'size', 'width', 'height', 'duration', 'title', 'referer',
  'variants', 'audio', 'encrypted', 'live', 'fmp4', 'error', 'parsed'];

// Добавляет или дополняет запись о видео.
function upsert(tabId, info) {
  return serialize(async () => {
    const list = await load(tabId);
    const url = normalizeUrl(info.url);
    if (info.mime && !info.ext) info = { ...info, ext: MIME_EXT[info.mime] };
    let item = list.find((v) => v.url === url);
    let changed = false;
    if (!item) {
      if (list.length >= MAX_PER_TAB) return;
      item = { url, found: Date.now() };
      list.push(item);
      changed = true;
    }
    for (const key of FIELDS) {
      const value = info[key];
      if (value === undefined || value === '' || value === 0) continue;
      if (key === 'size' && item.size && value < item.size) continue;
      if (JSON.stringify(item[key]) !== JSON.stringify(value)) {
        item[key] = value;
        changed = true;
      }
    }
    if (changed) {
      markHiddenPlaylists(list);
      await save(tabId, list);
    }
  });
}

// Плейлисты отдельных качеств и аудиодорожек, на которые ссылается мастер-плейлист,
// не показываем отдельно — они доступны через выбор качества.
function markHiddenPlaylists(list) {
  const children = new Set();
  for (const v of list) {
    if (v.kind !== 'hls') continue;
    v.variants?.forEach((x) => x.url !== v.url && children.add(x.url));
    v.audio?.forEach((u) => children.add(u));
  }
  for (const v of list) if (v.kind === 'hls') v.hidden = children.has(v.url);
}

// ---------- Referer для запросов расширения ----------
// Многие видеосерверы отдают файлы только с заголовком Referer своего плеера.

let refererQueue = Promise.resolve();

function setReferer(hosts, referer) {
  if (!referer || !hosts?.length) return Promise.resolve();
  refererQueue = refererQueue.then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    let maxId = rules.reduce((m, r) => Math.max(m, r.id), 0);
    const remove = rules.filter((r) => hosts.includes(r.condition.requestDomains?.[0])).map((r) => r.id);
    let origin;
    try {
      origin = new URL(referer).origin;
    } catch {
      return;
    }
    const addRules = hosts.map((host) => ({
      id: ++maxId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: referer },
          { header: 'origin', operation: 'set', value: origin }
        ]
      },
      // tabIds: [-1] — только запросы самого расширения, не страниц.
      condition: { requestDomains: [host], tabIds: [-1] }
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: remove, addRules });
  }).catch((e) => console.warn('setReferer', e));
  return refererQueue;
}

// ---------- HLS ----------

const parsing = new Set();

async function fetchPlaylist(url, referer) {
  await setReferer([new URL(url).hostname], referer);
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseM3U8(await res.text(), url);
}

async function inspectHls(tabId, url, referer) {
  const key = `${tabId} ${url}`;
  if (parsing.has(key)) return;
  parsing.add(key);
  try {
    const pl = await fetchPlaylist(url, referer);
    if (pl.type === 'master') {
      if (!pl.variants.length) return;
      // Длительность и формат берём из лучшего варианта.
      let media = null;
      try {
        media = await fetchPlaylist(pl.variants[0].url, referer);
      } catch {}
      const best = pl.variants[0];
      await upsert(tabId, {
        url,
        kind: 'hls',
        parsed: true,
        variants: pl.variants,
        audio: pl.audio,
        width: best.width,
        height: best.height,
        duration: media?.duration,
        encrypted: media?.encrypted,
        live: media?.live,
        fmp4: !!media?.map,
        ext: media?.map ? 'mp4' : 'ts'
      });
    } else {
      if (!pl.segments.length) return;
      await upsert(tabId, {
        url,
        kind: 'hls',
        parsed: true,
        variants: [{ url, width: 0, height: 0, bandwidth: 0 }],
        duration: pl.duration,
        encrypted: pl.encrypted,
        live: pl.live,
        fmp4: !!pl.map,
        ext: pl.map ? 'mp4' : 'ts'
      });
    }
  } catch (e) {
    await upsert(tabId, { url, kind: 'hls', parsed: true, error: String(e.message || e) });
  } finally {
    parsing.delete(key);
  }
}

// ---------- Перехват сетевых ответов ----------

function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const url = details.url;
    if (!/^https?:/i.test(url)) return;

    const type = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    const referer = details.initiator && details.initiator !== 'null' ? `${details.initiator}/` : '';

    if (HLS_MIME_RE.test(type) || HLS_URL_RE.test(url)) {
      upsert(details.tabId, { url, kind: 'hls', ext: 'ts', referer }).then(() =>
        inspectHls(details.tabId, normalizeUrl(url), referer)
      );
      return;
    }

    if (SKIP_URL_RE.test(url) || SKIP_MIME_RE.test(type)) return;

    const isVideoMime = type.startsWith('video/');
    const hasVideoExt = VIDEO_EXT_RE.test(url);
    const genericType = !type || type === 'application/octet-stream' || type === 'binary/octet-stream';
    if (!isVideoMime && !(hasVideoExt && (genericType || details.type === 'media'))) return;

    let size = 0;
    const range = header(details.responseHeaders, 'content-range'); // bytes 0-1023/123456
    const total = range.match(/\/(\d+)\s*$/);
    if (total) size = Number(total[1]);
    else if (details.statusCode === 200) size = Number(header(details.responseHeaders, 'content-length')) || 0;

    upsert(details.tabId, {
      url,
      kind: 'file',
      mime: isVideoMime ? type : '',
      ext: MIME_EXT[type] || (url.match(VIDEO_EXT_RE)?.[1] || '').toLowerCase(),
      size,
      referer
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ---------- Загрузки HLS через offscreen-документ ----------
// Service worker не умеет создавать blob-ссылки, поэтому сегменты скачивает
// и склеивает невидимый offscreen-документ.

let jobs = null; // id -> job
let jobsSaveTimer = null;

async function getJobs() {
  if (!jobs) jobs = (await chrome.storage.session.get('jobs')).jobs || {};
  return jobs;
}

function jobsChanged(immediate = false) {
  const flush = () => {
    jobsSaveTimer = null;
    chrome.storage.session.set({ jobs });
    notify({ type: 'jobs-updated' });
  };
  if (immediate) {
    clearTimeout(jobsSaveTimer);
    flush();
  } else if (!jobsSaveTimer) {
    jobsSaveTimer = setTimeout(flush, 300);
  }
}

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Склейка сегментов HLS-видео в один файл для скачивания'
    })
    .catch((e) => {
      if (!/single offscreen/i.test(e.message)) throw e;
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function closeOffscreenIfIdle() {
  const all = await getJobs();
  const active = Object.values(all).some((j) => j.status === 'downloading' || j.status === 'saving');
  if (!active) chrome.offscreen.closeDocument().catch(() => {});
}

async function finishJob(job, status, error = '') {
  job.status = status;
  job.error = error;
  if (job.blobUrl) {
    notify({ target: 'offscreen', type: 'revoke', blobUrl: job.blobUrl });
    delete job.blobUrl;
  }
  jobsChanged(true);
  closeOffscreenIfIdle();
}

async function startHlsJob(msg) {
  const all = await getJobs();
  const list = await load(msg.tabId);
  const item = list.find((v) => v.url === msg.itemUrl);
  const id = crypto.randomUUID();
  // Убираем старые завершённые задания для этого видео.
  for (const [k, j] of Object.entries(all)) {
    if (j.itemUrl === msg.itemUrl && j.tabId === msg.tabId && !['downloading', 'saving'].includes(j.status)) delete all[k];
  }
  all[id] = {
    id,
    tabId: msg.tabId,
    itemUrl: msg.itemUrl,
    filename: msg.filename,
    saveAs: msg.saveAs,
    status: 'downloading',
    done: 0,
    total: 0,
    bytes: 0
  };
  jobsChanged(true);
  await ensureOffscreen();
  notify({
    target: 'offscreen',
    type: 'start',
    job: { id, playlistUrl: msg.variantUrl, referer: item?.referer || '' }
  });
  return id;
}

async function onHlsReady(msg) {
  const job = (await getJobs())[msg.jobId];
  if (!job) {
    notify({ target: 'offscreen', type: 'revoke', blobUrl: msg.blobUrl });
    return;
  }
  job.status = 'saving';
  job.blobUrl = msg.blobUrl;
  job.bytes = msg.size;
  jobsChanged(true);
  const options = { url: msg.blobUrl, filename: job.filename, saveAs: job.saveAs, conflictAction: 'uniquify' };
  try {
    let downloadId;
    try {
      downloadId = await chrome.downloads.download(options);
    } catch (e) {
      // Chrome отклоняет некоторые имена — пробуем запасное.
      if (!/filename/i.test(e.message)) throw e;
      const ext = job.filename.split('.').pop();
      downloadId = await chrome.downloads.download({ ...options, filename: `video.${ext}` });
    }
    if (downloadId === undefined) throw new Error('canceled');
    job.downloadId = downloadId;
    jobsChanged(true);
  } catch (e) {
    const msgText = String(e.message || e);
    await finishJob(job, /cancel/i.test(msgText) ? 'cancelled' : 'error', msgText);
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const all = await getJobs();
  const job = Object.values(all).find((j) => j.downloadId === delta.id);
  if (!job) return;
  if (delta.state.current === 'complete') finishJob(job, 'done');
  else if (delta.state.current === 'interrupted') finishJob(job, 'cancelled');
});

// ---------- Жизненный цикл вкладок ----------

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) serialize(() => clearTab(details.tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => clearTab(tabId));
});

// ---------- Сообщения ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return; // адресовано offscreen-документу

  switch (msg?.type) {
    case 'dom-videos': {
      if (!sender.tab) return;
      for (const v of msg.videos || []) {
        if (!/^https?:/i.test(v.url) || SKIP_URL_RE.test(v.url)) continue;
        if (HLS_URL_RE.test(v.url)) {
          upsert(sender.tab.id, { url: v.url, kind: 'hls', ext: 'ts', title: v.title });
          inspectHls(sender.tab.id, normalizeUrl(v.url), sender.origin ? `${sender.origin}/` : '');
          continue;
        }
        upsert(sender.tab.id, {
          url: v.url,
          kind: 'file',
          width: v.width,
          height: v.height,
          duration: v.duration,
          title: v.title,
          ext: (v.url.match(VIDEO_EXT_RE)?.[1] || '').toLowerCase()
        });
      }
      return;
    }

    case 'get-videos':
      serialize(() => load(msg.tabId)).then((list) => sendResponse(list || []));
      return true;

    case 'update-video':
      upsert(msg.tabId, msg.info).then(() => sendResponse(true));
      return true;

    case 'set-referer':
      setReferer(msg.hosts, msg.referer).then(() => sendResponse(true));
      return true;

    case 'get-jobs':
      getJobs().then((all) => sendResponse(Object.values(all).filter((j) => j.tabId === msg.tabId)));
      return true;

    case 'hls-download':
      startHlsJob(msg).then(sendResponse, (e) => sendResponse({ error: String(e.message || e) }));
      return true;

    case 'hls-cancel':
      getJobs().then((all) => {
        const job = all[msg.jobId];
        if (!job) return;
        notify({ target: 'offscreen', type: 'cancel', jobId: msg.jobId });
        if (job.status === 'saving' && job.downloadId !== undefined) chrome.downloads.cancel(job.downloadId);
      });
      return;

    case 'hls-progress':
      getJobs().then((all) => {
        const job = all[msg.jobId];
        if (!job || job.status !== 'downloading') return;
        Object.assign(job, { done: msg.done, total: msg.total, bytes: msg.bytes });
        jobsChanged();
      });
      return;

    case 'hls-ready':
      onHlsReady(msg);
      return;

    case 'hls-failed':
      getJobs().then((all) => {
        const job = all[msg.jobId];
        if (job) finishJob(job, msg.cancelled ? 'cancelled' : 'error', msg.error);
      });
      return;
  }
});
