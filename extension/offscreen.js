// Offscreen-документ: скачивает сегменты HLS, склеивает их в один Blob
// и передаёт blob-ссылку фоновому скрипту для сохранения.

const PARALLEL = 6;
const RETRIES = 4;
const controllers = new Map(); // jobId -> AbortController

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'start') run(msg.job);
  else if (msg.type === 'cancel') controllers.get(msg.jobId)?.abort('cancelled');
  else if (msg.type === 'revoke') URL.revokeObjectURL(msg.blobUrl);
});

async function fetchWithRetry(url, options, signal) {
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (signal.aborted) throw new Error('cancelled');
    try {
      const res = await fetch(url, { credentials: 'include', ...options, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (signal.aborted) throw new Error('cancelled');
      lastError = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function fetchPlaylist(url, signal) {
  const res = await fetchWithRetry(url, { cache: 'no-store' }, signal);
  return parseM3U8(await res.text(), url);
}

async function fetchSegment(seg, signal) {
  const headers = {};
  if (seg.byterange) {
    const { offset, length } = seg.byterange;
    headers.Range = `bytes=${offset}-${offset + length - 1}`;
  }
  const res = await fetchWithRetry(seg.url, { headers }, signal);
  return res.arrayBuffer();
}

async function run(job) {
  const ctrl = new AbortController();
  controllers.set(job.id, ctrl);
  const { signal } = ctrl;
  try {
    const hostOf = (u) => new URL(u).hostname;
    await send({ type: 'set-referer', hosts: [hostOf(job.playlistUrl)], referer: job.referer });

    let pl = await fetchPlaylist(job.playlistUrl, signal);
    if (pl.type === 'master') {
      if (!pl.variants.length) throw new Error('empty playlist');
      const url = pl.variants[0].url;
      await send({ type: 'set-referer', hosts: [hostOf(url)], referer: job.referer });
      pl = await fetchPlaylist(url, signal);
    }
    if (pl.encrypted) throw new Error('encrypted');
    if (!pl.segments.length) throw new Error('empty playlist');

    const list = pl.map ? [pl.map, ...pl.segments] : pl.segments;
    const hosts = [...new Set(list.map((s) => hostOf(s.url)))];
    await send({ type: 'set-referer', hosts, referer: job.referer });

    const parts = new Array(list.length);
    let next = 0;
    let done = 0;
    let bytes = 0;
    let lastReport = 0;
    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      send({ type: 'hls-progress', jobId: job.id, done, total: list.length, bytes });
    };
    report(true);

    const worker = async () => {
      while (next < list.length && !signal.aborted) {
        const i = next++;
        parts[i] = await fetchSegment(list[i], signal);
        done++;
        bytes += parts[i].byteLength;
        report(false);
      }
    };
    try {
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } catch (e) {
      ctrl.abort(); // останавливаем остальные потоки
      throw e;
    }
    if (signal.aborted) throw new Error('cancelled');
    report(true);

    const blob = new Blob(parts, { type: pl.map ? 'video/mp4' : 'video/mp2t' });
    parts.length = 0;
    send({ type: 'hls-ready', jobId: job.id, blobUrl: URL.createObjectURL(blob), size: blob.size });
  } catch (e) {
    const cancelled = signal.reason === 'cancelled';
    send({ type: 'hls-failed', jobId: job.id, cancelled, error: cancelled ? '' : String(e.message || e) });
  } finally {
    controllers.delete(job.id);
  }
}
