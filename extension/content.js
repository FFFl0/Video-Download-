// Content script: находит <video> и <source> на странице и сообщает
// фоновому скрипту адреса, разрешение и длительность.
(() => {
  if (window.__videoDownloaderInjected) return;
  window.__videoDownloaderInjected = true;

  let lastReport = '';
  let timer = null;

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return '';
    }
  }

  function collect() {
    const result = new Map();
    const add = (url, video) => {
      url = absolute(url);
      if (!/^https?:/i.test(url)) return; // blob:/data: скачать напрямую нельзя
      const prev = result.get(url) || {};
      result.set(url, {
        url,
        width: video?.videoWidth || prev.width || 0,
        height: video?.videoHeight || prev.height || 0,
        duration: Number.isFinite(video?.duration) ? Math.round(video.duration) : prev.duration || 0,
        title: document.title || ''
      });
    };

    for (const video of document.querySelectorAll('video')) {
      if (video.currentSrc) add(video.currentSrc, video);
      if (video.getAttribute('src')) add(video.getAttribute('src'), video.currentSrc ? null : video);
      for (const source of video.querySelectorAll('source[src]')) {
        const type = (source.type || '').toLowerCase();
        if (type.includes('mpegurl') || type.includes('dash')) continue;
        add(source.getAttribute('src'), absolute(source.getAttribute('src')) === video.currentSrc ? video : null);
      }
    }
    return [...result.values()];
  }

  function report() {
    timer = null;
    const videos = collect();
    const key = JSON.stringify(videos);
    if (key === lastReport) return;
    lastReport = key;
    if (!videos.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'dom-videos', videos }).catch(() => {});
    } catch {
      // Расширение было перезагружено — старый content script больше не работает.
    }
  }

  function schedule() {
    if (!timer) timer = setTimeout(report, 500);
  }

  // События медиа не всплывают, но ловятся на фазе перехвата.
  for (const ev of ['loadedmetadata', 'loadstart', 'play']) {
    document.addEventListener(ev, (e) => e.target instanceof HTMLVideoElement && schedule(), true);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  });

  report();
})();
