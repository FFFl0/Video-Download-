const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

const els = {
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  emptyHint: document.getElementById('empty-hint'),
  count: document.getElementById('count'),
  askWhere: document.getElementById('ask-where'),
  status: document.getElementById('status'),
  tpl: document.getElementById('item-tpl')
};

const cards = new Map(); // url -> { li, item, edited }
const probed = new Set();
let tab = null;

// ---------- Утилиты ----------

function formatSize(bytes) {
  if (!bytes) return t('sizeUnknown');
  const units = t('units').split(',');
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function qualityLabel(w, h) {
  if (!w || !h) return '';
  const p = Math.min(w, h); // учитываем вертикальные видео
  if (p >= 2000) return '4K';
  if (p >= 1400) return '1440p';
  const steps = [1080, 720, 480, 360, 240, 144];
  const step = steps.find((s) => p >= s * 0.9);
  return step ? `${step}p` : `${p}p`;
}

// Пытаемся угадать качество из адреса, например video_720p.mp4 или 1280x720.
function qualityFromUrl(url) {
  const wh = url.match(/[_\-/.](\d{3,4})x(\d{3,4})[_\-/.]/i);
  if (wh) return qualityLabel(+wh[1], +wh[2]);
  const p = url.match(/[_\-/.=](2160|1440|1080|720|480|360|240|144)p?[_\-/.&]/i);
  return p ? (p[1] === '2160' ? '4K' : `${p[1]}p`) : '';
}

function sanitize(name) {
  return (
    name
      .replace(/[\\/:*?"<>|~\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 150) || 'video'
  );
}

function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last.replace(/\.[a-z0-9]{2,4}$/i, '');
  } catch {
    return '';
  }
}

function defaultName(item, list) {
  const base = sanitize(item.title || tab?.title || nameFromUrl(item.url) || 'video');
  const sameBase = list.filter((v) => sanitize(v.title || tab?.title || nameFromUrl(v.url)) === base);
  if (sameBase.length < 2) return base;
  const q = qualityLabel(item.width, item.height) || qualityFromUrl(item.url);
  const suffix = q || String(sameBase.indexOf(item) + 1);
  return `${base} (${suffix})`;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  clearTimeout(setStatus.timer);
  if (text) setStatus.timer = setTimeout(() => (els.status.textContent = ''), 4000);
}

// ---------- Отрисовка ----------

function sortList(list) {
  const pixels = (v) => (v.width || 0) * (v.height || 0);
  return [...list].sort((a, b) => pixels(b) - pixels(a) || (b.size || 0) - (a.size || 0));
}

function render(list) {
  list = sortList(list);
  els.count.textContent = list.length ? String(list.length) : '';
  els.empty.hidden = list.length > 0;

  const seen = new Set();
  for (const item of list) {
    seen.add(item.url);
    let card = cards.get(item.url);
    if (!card) {
      const li = els.tpl.content.firstElementChild.cloneNode(true);
      card = { li, item, edited: false };
      const input = li.querySelector('.name');
      input.addEventListener('input', () => (card.edited = true));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && download(card));
      const btn = li.querySelector('.download');
      btn.textContent = t('download');
      btn.addEventListener('click', () => download(card));
      const host = li.querySelector('.host');
      host.href = item.url;
      host.title = t('openLink');
      try {
        host.textContent = new URL(item.url).host + new URL(item.url).pathname;
      } catch {
        host.textContent = item.url;
      }
      cards.set(item.url, card);
    }
    card.item = item;
    updateCard(card, list);
    els.list.appendChild(card.li); // сохраняет порядок сортировки
  }

  for (const [url, card] of cards) {
    if (!seen.has(url)) {
      card.li.remove();
      cards.delete(url);
    }
  }
}

function updateCard(card, list) {
  const { li, item } = card;
  const input = li.querySelector('.name');
  if (!card.edited) input.value = defaultName(item, list);
  li.querySelector('.ext').textContent = `.${item.ext || 'mp4'}`;

  const q = qualityLabel(item.width, item.height) || qualityFromUrl(item.url);
  const badge = li.querySelector('.quality');
  badge.hidden = !q;
  badge.textContent = q;

  const parts = [];
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  parts.push(formatSize(item.size));
  if (item.duration) parts.push(formatDuration(item.duration));
  if (item.ext) parts.push(item.ext.toUpperCase());
  li.querySelector('.info').textContent = parts.join(' · ');
}

// ---------- Определение размера и разрешения ----------

async function probeSize(item) {
  const info = {};
  const read = (res) => {
    const range = res.headers.get('content-range')?.match(/\/(\d+)\s*$/);
    const size = range ? +range[1] : res.status === 200 ? +res.headers.get('content-length') : 0;
    if (size) info.size = size;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (type.startsWith('video/')) info.mime = type;
  };
  try {
    const res = await fetch(item.url, { method: 'HEAD', credentials: 'include' });
    if (res.ok) read(res);
  } catch {}
  if (!info.size) {
    const ctrl = new AbortController();
    try {
      const res = await fetch(item.url, {
        headers: { Range: 'bytes=0-0' },
        credentials: 'include',
        signal: ctrl.signal
      });
      if (res.ok) read(res);
    } catch {}
    ctrl.abort();
  }
  return info;
}

function probeMetadata(item) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    const done = (info) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(info);
    };
    const timer = setTimeout(() => done({}), 10000);
    video.onloadedmetadata = () =>
      done({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : 0
      });
    video.onerror = () => done({});
    video.src = item.url;
  });
}

async function probe(item) {
  if (probed.has(item.url)) return;
  probed.add(item.url);
  const [size, meta] = await Promise.all([
    item.size ? {} : probeSize(item),
    item.width && item.duration ? {} : probeMetadata(item)
  ]);
  const info = { ...size, ...meta };
  if (Object.values(info).some(Boolean)) {
    await chrome.runtime.sendMessage({ type: 'update-video', tabId: tab.id, info: { url: item.url, ...info } });
  }
}

async function probeAll(list) {
  const queue = list.filter((v) => !probed.has(v.url) && (!v.size || !v.width || !v.duration));
  const worker = async () => {
    while (queue.length) await probe(queue.shift());
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- Скачивание ----------

async function download(card) {
  const { li, item } = card;
  const btn = li.querySelector('.download');
  const name = sanitize(li.querySelector('.name').value);
  const filename = `${name}.${item.ext || 'mp4'}`;
  const options = { url: item.url, filename, saveAs: els.askWhere.checked, conflictAction: 'uniquify' };
  btn.disabled = true;
  try {
    try {
      await chrome.downloads.download(options);
    } catch (e) {
      // Chrome отклоняет некоторые имена — пробуем запасное.
      if (!/filename/i.test(e.message)) throw e;
      await chrome.downloads.download({ ...options, filename: `video.${item.ext || 'mp4'}` });
    }
    setStatus(t('downloadStarted'));
  } catch (e) {
    setStatus(t('downloadError', [e.message || String(e)]), true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Инициализация ----------

async function refresh() {
  const list = await chrome.runtime.sendMessage({ type: 'get-videos', tabId: tab.id });
  render(list || []);
  probeAll(list || []);
}

async function init() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);

  const { askWhere = true } = await chrome.storage.sync.get('askWhere');
  els.askWhere.checked = askWhere;
  els.askWhere.addEventListener('change', () => chrome.storage.sync.set({ askWhere: els.askWhere.checked }));

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:|^file:/i.test(tab.url || '')) {
    els.empty.hidden = false;
    els.emptyHint.textContent = t('unsupportedPage');
    return;
  }

  let pending = null;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'videos-updated' && msg.tabId === tab.id && !pending) {
      pending = setTimeout(() => {
        pending = null;
        refresh();
      }, 200);
    }
  });

  await refresh();
}

init();
