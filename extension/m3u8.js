// Разбор плейлистов HLS (.m3u8). Используется в background.js и offscreen.js.

function parseM3U8Attrs(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  return attrs;
}

function parseM3U8(text, baseUrl) {
  if (!/^\s*#EXTM3U/.test(text)) throw new Error('Not an M3U8 playlist');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const resolve = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audio = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseM3U8Attrs(line.slice(18));
        let uri = lines[i + 1];
        if (!uri || uri.startsWith('#')) continue;
        const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
        variants.push({
          url: resolve(uri),
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
          width: w || 0,
          height: h || 0
        });
        i++;
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseM3U8Attrs(line.slice(13));
        if (a.URI) audio.push(resolve(a.URI));
      }
    }
    // Лучшее качество первым, без дубликатов.
    const seen = new Set();
    const unique = variants
      .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)
      .filter((v) => !seen.has(v.url) && seen.add(v.url));
    return { type: 'master', variants: unique, audio };
  }

  const segments = [];
  let map = null;
  let encrypted = false;
  let duration = 0;
  let segDuration = 0;
  let byterange = null;
  let nextOffset = 0;
  const parseRange = (value) => {
    const [len, off] = value.split('@').map(Number);
    const offset = Number.isFinite(off) ? off : nextOffset;
    nextOffset = offset + len;
    return { offset, length: len };
  };

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      segDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byterange = parseRange(line.slice(17));
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseM3U8Attrs(line.slice(11));
      if (a.METHOD && a.METHOD !== 'NONE') encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseM3U8Attrs(line.slice(11));
      if (a.URI) map = { url: resolve(a.URI), byterange: a.BYTERANGE ? parseRange(a.BYTERANGE) : null };
    } else if (!line.startsWith('#')) {
      segments.push({ url: resolve(line), byterange });
      duration += segDuration;
      segDuration = 0;
      byterange = null;
    }
  }

  return {
    type: 'media',
    segments,
    map,
    encrypted,
    live: !lines.includes('#EXT-X-ENDLIST'),
    duration: Math.round(duration)
  };
}
