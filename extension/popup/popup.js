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

const cards = new Map(); // url -> { li, item, edited, variantUrl }
const probed = new Set();
let jobsByItem = new Map(); // itemUrl -> job
let currentList = [];
let tab = null;

// ---------- Утилиты ----------

function formatSize(bytes) {
  if (!bytes) return '';
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
  const p = url.match(/[_\-/.=](2160|1440|1080|720|480|360|240|144)p?[_\-/.&:]/i);
  return p ? (p[1] === '2160' ? '4K' : `${p[1]}p`) : '';
}

function sanitize(name) {
  return (
    name
      .replace(/\s*:\s*/g, ' - ')
      .replace(/[\\/:*?"<>|~\u0000-\u001f\u007f-\u009f​-‏‪-‮﻿]+/g, '_')
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

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  clearTimeout(setStatus.timer);
  if (text) setStatus.timer = setTimeout(() => (els.status.textContent = ''), 4000);
}

// ---------- Модель карточки ----------

function selectedVariant(card) {
  const variants = card.item.variants || [];
  return variants.find((v) => v.url === card.variantUrl) || variants[0] || null;
}

// Разрешение выбранного варианта (для HLS) или самого файла.
function dims(card) {
  const v = card.item.kind === 'hls' ? selectedVariant(card) : null;
  return v && v.width ? v : card.item;
}

function quality(card) {
  const d = dims(card);
  return qualityLabel(d.width, d.height) || qualityFromUrl(selectedVariant(card)?.url || card.item.url);
}

function estimateSize(item, variant) {
  return variant?.bandwidth && item.duration ? (variant.bandwidth * item.duration) / 8 : 0;
}

function baseName(item) {
  return sanitize(item.title || tab?.title || nameFromUrl(item.url) || 'video');
}

function defaultName(card) {
  const base = baseName(card.item);
  const same = currentList.filter((v) => baseName(v) === base);
  if (same.length < 2 && !(card.item.variants?.length > 1)) return base;
  const suffix = quality(card) || String(same.indexOf(card.item) + 1);
  return `${base} (${suffix})`;
}

function extension(item) {
  return item.ext || (item.kind === 'hls' ? 'ts' : 'mp4');
}

// ---------- Отрисовка ----------

function sortList(list) {
  const height = (v) => Math.max(v.height || 0, ...(v.variants || []).map((x) => x.height || 0));
  return [...list].sort(
    (a, b) => (b.kind === 'hls') - (a.kind === 'hls') || height(b) - height(a) || (b.size || 0) - (a.size || 0)
  );
}

function createCard(item) {
  const li = els.tpl.content.firstElementChild.cloneNode(true);
  const card = { li, item, edited: false, variantUrl: '' };

  const input = li.querySelector('.name');
  input.addEventListener('input', () => (card.edited = true));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && download(card));

  const select = li.querySelector('.variant');
  select.addEventListener('change', () => {
    card.variantUrl = select.value;
    updateCard(card);
  });

  const btn = li.querySelector('.download');
  btn.textContent = t('download');
  btn.addEventListener('click', () => download(card));

  const cancel = li.querySelector('.cancel');
  cancel.textContent = t('cancel');
  cancel.addEventListener('click', () => {
    const job = jobsByItem.get(card.item.url);
    if (job) chrome.runtime.sendMessage({ type: 'hls-cancel', jobId: job.id });
  });

  const host = li.querySelector('.host');
  host.href = item.url;
  host.title = t('openLink');
  try {
    const u = new URL(item.url);
    host.textContent = u.host + u.pathname;
  } catch {
    host.textContent = item.url;
  }
  return card;
}

function render(list) {
  currentList = sortList(list.filter((v) => !v.hidden));
  els.count.textContent = currentList.length ? String(currentList.length) : '';
  els.empty.hidden = currentList.length > 0;

  const seen = new Set();
  for (const item of currentList) {
    seen.add(item.url);
    let card = cards.get(item.url);
    if (!card) {
      card = createCard(item);
      cards.set(item.url, card);
    }
    card.item = item;
    updateCard(card);
    els.list.appendChild(card.li); // сохраняет порядок сортировки
  }

  for (const [url, card] of cards) {
    if (!seen.has(url)) {
      card.li.remove();
      cards.delete(url);
    }
  }
}

function updateVariantSelect(card) {
  const select = card.li.querySelector('.variant');
  const variants = card.item.variants || [];
  const informative = variants.filter((v) => v.height || v.bandwidth);
  select.hidden = variants.length < 2 && !informative.length;
  if (select.hidden) return;

  const key = JSON.stringify(variants);
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(
      ...variants.map((v) => {
        const label = [
          qualityLabel(v.width, v.height) || (v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : '?'),
          estimateSize(card.item, v) ? `~${formatSize(estimateSize(card.item, v))}` : ''
        ]
          .filter(Boolean)
          .join(' · ');
        return new Option(label, v.url);
      })
    );
  }
  if (!variants.some((v) => v.url === card.variantUrl)) card.variantUrl = variants[0]?.url || '';
  select.value = card.variantUrl;
}

function updateCard(card) {
  const { li, item } = card;
  const isHls = item.kind === 'hls';
  if (isHls) updateVariantSelect(card);
  else li.querySelector('.variant').hidden = true;

  const input = li.querySelector('.name');
  if (!card.edited) input.value = defaultName(card);
  li.querySelector('.ext').textContent = `.${extension(item)}`;

  const q = quality(card);
  const badge = li.querySelector('.quality');
  badge.hidden = !q;
  badge.textContent = q;

  const d = dims(card);
  const parts = [];
  if (d.width && d.height) parts.push(`${d.width}×${d.height}`);
  if (isHls) {
    const est = estimateSize(item, selectedVariant(card));
    if (est) parts.push(`~${formatSize(est)}`);
  } else {
    parts.push(formatSize(item.size) || t('sizeUnknown'));
  }
  if (item.duration) parts.push(formatDuration(item.duration));
  parts.push(isHls ? 'HLS' : extension(item).toUpperCase());
  li.querySelector('.info').textContent = parts.join(' · ');

  // Причина, по которой скачать нельзя.
  let problem = '';
  if (isHls) {
    if (!item.parsed) problem = t('loadingInfo');
    else if (item.error) problem = t('hlsError', [item.error]);
    else if (item.encrypted) problem = t('encrypted');
    else if (item.live) problem = t('live');
  }
  const note = li.querySelector('.note');
  note.hidden = !problem;
  note.textContent = problem;

  updateProgress(card, problem);
}

function updateProgress(card, problem) {
  const { li } = card;
  const job = jobsByItem.get(card.item.url);
  const box = li.querySelector('.progress');
  const btn = li.querySelector('.download');
  const active = job && (job.status === 'downloading' || job.status === 'saving');
  btn.disabled = !!problem || !!active;

  box.hidden = !job;
  if (!job) return;

  const fill = li.querySelector('.fill');
  const text = li.querySelector('.ptext');
  const percent = job.total ? Math.floor((job.done / job.total) * 100) : 0;
  box.dataset.status = job.status;
  li.querySelector('.cancel').hidden = job.status !== 'downloading';

  switch (job.status) {
    case 'downloading':
      fill.style.width = `${percent}%`;
      text.textContent = t('downloading', [String(percent), formatSize(job.bytes) || '0']);
      break;
    case 'saving':
      fill.style.width = '100%';
      text.textContent = t('saving');
      break;
    case 'done':
      fill.style.width = '100%';
      text.textContent = t('done', [formatSize(job.bytes)]);
      break;
    case 'cancelled':
      fill.style.width = '0';
      text.textContent = t('cancelled');
      break;
    default:
      fill.style.width = '0';
      text.textContent = t('failed', [job.error || '?']);
  }
}

// ---------- Определение размера и разрешения обычных файлов ----------

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
  const queue = list.filter(
    (v) => v.kind !== 'hls' && !probed.has(v.url) && (!v.size || !v.width || !v.duration)
  );
  const worker = async () => {
    while (queue.length) await probe(queue.shift());
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- Скачивание ----------

async function download(card) {
  const { li, item } = card;
  const btn = li.querySelector('.download');
  if (btn.disabled) return;
  const filename = `${sanitize(li.querySelector('.name').value)}.${extension(item)}`;
  btn.disabled = true;

  if (item.kind === 'hls') {
    const res = await chrome.runtime.sendMessage({
      type: 'hls-download',
      tabId: tab.id,
      itemUrl: item.url,
      variantUrl: selectedVariant(card)?.url || item.url,
      filename,
      saveAs: els.askWhere.checked
    });
    if (res?.error) setStatus(t('failed', [res.error]), true);
    await refreshJobs();
    return;
  }

  const options = { url: item.url, filename, saveAs: els.askWhere.checked, conflictAction: 'uniquify' };
  try {
    try {
      await chrome.downloads.download(options);
    } catch (e) {
      // Chrome отклоняет некоторые имена — пробуем запасное.
      if (!/filename/i.test(e.message)) throw e;
      await chrome.downloads.download({ ...options, filename: `video.${extension(item)}` });
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
  const list = (await chrome.runtime.sendMessage({ type: 'get-videos', tabId: tab.id })) || [];
  render(list);
  probeAll(list);
}

async function refreshJobs() {
  const jobs = (await chrome.runtime.sendMessage({ type: 'get-jobs', tabId: tab.id })) || [];
  jobsByItem = new Map(jobs.map((j) => [j.itemUrl, j]));
  for (const card of cards.values()) updateCard(card);
}

function debounce(fn, ms) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
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

  const refreshSoon = debounce(refresh, 200);
  const refreshJobsSoon = debounce(refreshJobs, 100);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'videos-updated' && msg.tabId === tab.id) refreshSoon();
    if (msg?.type === 'jobs-updated') refreshJobsSoon();
  });

  await refresh();
  await refreshJobs();
}

init();
