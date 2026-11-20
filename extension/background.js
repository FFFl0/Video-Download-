// Service worker: перехватывает сетевые ответы с видео и хранит список
// найденных файлов отдельно для каждой вкладки.

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
// Потоковые форматы и сегменты, которые нельзя скачать одним файлом.
const STREAM_MIME_RE = /(mpegurl|dash\+xml|mp2t|iso\.segment)/i;
const STREAM_URL_RE = /\.(m3u8|mpd|ts|m4s)(?:$|[?#])|[?&](range|bytestart|byteend)=/i;

const MAX_PER_TAB = 100;

// --- Хранилище (chrome.storage.session переживает перезапуск service worker) ---

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

async function save(tabId, list) {
  cache.set(tabId, list);
  await chrome.storage.session.set({ [`tab_${tabId}`]: list });
  updateBadge(tabId, list.length);
  chrome.runtime.sendMessage({ type: 'videos-updated', tabId }).catch(() => {});
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
    for (const key of ['mime', 'ext', 'size', 'width', 'height', 'duration', 'title']) {
      const value = info[key];
      if (value && item[key] !== value) {
        // Размер из Content-Range надёжнее, но не затираем больший размер меньшим.
        if (key === 'size' && item.size && value < item.size) continue;
        item[key] = value;
        changed = true;
      }
    }
    if (changed) await save(tabId, list);
  });
}

// --- Перехват сетевых ответов ---

function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const url = details.url;
    if (!/^https?:/i.test(url) || STREAM_URL_RE.test(url)) return;

    const type = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    if (STREAM_MIME_RE.test(type)) return;

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
      mime: isVideoMime ? type : '',
      ext: MIME_EXT[type] || (url.match(VIDEO_EXT_RE)?.[1] || '').toLowerCase(),
      size
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame', 'main_frame'] },
  ['responseHeaders']
);

// --- Жизненный цикл вкладок ---

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) serialize(() => clearTab(details.tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => clearTab(tabId));
});

// --- Сообщения от content script и popup ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'dom-videos' && sender.tab) {
    const tabId = sender.tab.id;
    for (const v of msg.videos || []) {
      if (!/^https?:/i.test(v.url) || STREAM_URL_RE.test(v.url)) continue;
      upsert(tabId, {
        url: v.url,
        width: v.width,
        height: v.height,
        duration: v.duration,
        title: v.title,
        ext: (v.url.match(VIDEO_EXT_RE)?.[1] || '').toLowerCase()
      });
    }
    return;
  }

  if (msg?.type === 'get-videos') {
    serialize(() => load(msg.tabId)).then((list) => sendResponse(list || []));
    return true; // ответ асинхронный
  }

  if (msg?.type === 'update-video') {
    upsert(msg.tabId, msg.info).then(() => sendResponse(true));
    return true;
  }
});
