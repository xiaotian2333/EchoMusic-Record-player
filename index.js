let disposeSnapshot = null;
let disposePlaybackWatch = null;
let disposeTrackWatch = null;
let observerRef = null;
let activeCtx = null;
let cachedCoverContainer = null;
let vinylElementsReady = false;
let resourceCache = null;
let setupToken = 0;
let currentCoverUrl = '';
let currentTrackId = '';
let lastIsPlaying = false;
let frameDirection = 0;
let frameIdx = 0;
let frameRaf = null;
let lastFrameTime = 0;
let needleFrameEl = null;
let coverImages = [];
let rotatingImages = [];

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const FRAME_INTERVAL = 1000 / 30;
const NEEDLE_FRAME_COUNT = 24;
const NEEDLE_RENDER_WIDTH = 152;

function cancelFrameAnimation() {
  if (frameRaf) cancelAnimationFrame(frameRaf);
  frameRaf = null;
  frameDirection = 0;
}

function getPluginFilePath(...parts) {
  const root = String(activeCtx?.descriptor?.directory || '').replace(/[\\/]+$/, '');
  return [root, ...parts].filter(Boolean).join('/');
}

async function getFileUrl(relativePath) {
  const result = await activeCtx.fs.getFileUrl(getPluginFilePath('res', ...relativePath.split('/')));
  return result?.ok ? result.url : relativePath;
}

function replaceAssetUrl(svg, relativePath, url) {
  const escapedPath = relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return svg.replace(new RegExp(`(xlink:href|href)=["']${escapedPath}["']`, 'g'), `$1="${url}"`);
}

async function loadResources() {
  if (resourceCache) return resourceCache;
  if (!activeCtx?.fs?.readTextFile || !activeCtx?.fs?.getFileUrl) {
    throw new Error('插件文件 API 不可用');
  }

  const [bgResult, needleSpriteUrl] = await Promise.all([
    activeCtx.fs.readTextFile(getPluginFilePath('res', 'bg.svg'), { maxBytes: 1024 * 256 }),
    getFileUrl('img/needle-sprite.webp'),
  ]);

  if (!bgResult?.ok) throw new Error(bgResult?.error || 'bg.svg 读取失败');

  const assetPaths = ['img/bg_0.webp', 'img/bg_1.webp'];

  const assetEntries = await Promise.all(
    assetPaths.map(async (path) => [path, await getFileUrl(path)]),
  );
  let bgSvg = bgResult.content;

  for (const [path, url] of assetEntries) {
    bgSvg = replaceAssetUrl(bgSvg, path, url);
  }

  resourceCache = { bgSvg, needleSpriteUrl };
  return resourceCache;
}

function injectVinylStyles() {
  document.getElementById('echo-vinyl-global-style')?.remove();

  const style = document.createElement('style');
  style.id = 'echo-vinyl-global-style';
  style.textContent = `
    .lyric-page {
      overflow: visible !important;
    }

    .lyric-page .cover-side,
    .lyric-page .cover-wrapper,
    .lyric-page .cover-container {
      overflow: visible !important;
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      border: none !important;
      outline: none !important;
    }

    .lyric-page .cover-wrapper {
      width: 510px !important;
      height: 510px !important;
      min-width: 510px !important;
      min-height: 510px !important;
      border-radius: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      filter: none !important;
      --shadow-cover: none !important;
    }

    .lyric-page .cover-container {
      position: relative !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 510px !important;
      height: 510px !important;
      min-width: 510px !important;
      min-height: 510px !important;
      border-radius: 0 !important;
    }

    .lyric-page .cover-container::before,
    .lyric-page .cover-container::after {
      content: none !important;
      display: none !important;
    }

    body.echo-vinyl-ready .lyric-page .cover-container > :not(.echo-vinyl-player) {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    .lyric-page .cover-side .song-info {
      display: none !important;
    }

    .echo-vinyl-player {
      position: absolute !important;
      top: -145px !important;
      left: calc(55%) !important;
      width: 548px !important;
      height: 650px !important;
      transform: translateX(-50%) !important;
      overflow: visible !important;
      pointer-events: none !important;
      z-index: 10 !important;
    }

    .echo-vinyl-bg-layer,
    .echo-vinyl-needle-layer {
      position: absolute !important;
      left: 0 !important;
      width: 100% !important;
      height: 1140px !important;
      overflow: visible !important;
      pointer-events: none !important;
    }

    .echo-vinyl-bg-layer {
      top: 0 !important;
      z-index: 1 !important;
    }

    .echo-vinyl-needle-layer {
      top: -95px !important;
      z-index: 2 !important;
    }

    .echo-vinyl-bg-layer svg,
    .echo-vinyl-needle-frame {
      display: block !important;
    }

    .echo-vinyl-bg-layer svg {
      width: 100% !important;
      height: 100% !important;
      display: block !important;
      overflow: visible !important;
    }

    .echo-vinyl-needle-frame {
      position: absolute !important;
      left: 279.846px !important;
      top: 537.846px !important;
      width: 152px !important;
      height: 96.462px !important;
      background-repeat: no-repeat !important;
      background-size: 3648px 96.462px !important;
      background-position: 0 0;
      pointer-events: none !important;
    }

    .echo-vinyl-rotating {
      transform-box: fill-box !important;
      transform-origin: center !important;
      animation: echoVinylSpin 20s linear infinite !important;
      animation-play-state: paused !important;
    }

    body.echo-vinyl-spinning .echo-vinyl-rotating {
      animation-play-state: running !important;
    }

    @keyframes echoVinylSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

function setSvgHref(element, url) {
  if (url) {
    element.setAttribute('href', url);
    element.setAttributeNS(XLINK_NS, 'xlink:href', url);
    element.style.display = '';
    element.parentElement?.style.setProperty('display', 'block');
    return;
  }

  element.removeAttribute('href');
  element.removeAttributeNS(XLINK_NS, 'href');
  element.style.display = 'none';
  element.parentElement?.style.setProperty('display', 'none');
}

function applyCoverUrl(url) {
  currentCoverUrl = String(url || '').trim();
  coverImages.forEach((image) => setSvgHref(image, currentCoverUrl));
}

function pickTrackFromSnapshot(snapshot) {
  return snapshot?.playback || activeCtx?.stores?.player?.currentTrackSnapshot || null;
}

function applyTrack(track) {
  const nextTrackId = String(track?.trackId || track?.id || track?.hash || '');
  const nextCoverUrl = String(track?.coverUrl || track?.cover || '').trim();

  if (nextTrackId && nextTrackId !== currentTrackId) {
    currentTrackId = nextTrackId;
  }

  if (nextCoverUrl !== currentCoverUrl) {
    applyCoverUrl(nextCoverUrl);
  }
}

function showFrame(index) {
  if (!needleFrameEl) return;
  const nextIndex = Math.max(0, Math.min(NEEDLE_FRAME_COUNT - 1, index));
  needleFrameEl.style.setProperty(
    'background-position',
    `${-nextIndex * NEEDLE_RENDER_WIDTH}px 0`,
    'important',
  );
}

function tickNeedle(timestamp) {
  if (!frameDirection || !needleFrameEl) return;

  if (timestamp - lastFrameTime >= FRAME_INTERVAL) {
    frameIdx += frameDirection;

    if (frameIdx >= NEEDLE_FRAME_COUNT) {
      frameIdx = NEEDLE_FRAME_COUNT - 1;
      showFrame(frameIdx);
      cancelFrameAnimation();
      return;
    }

    if (frameIdx < 0) {
      frameIdx = 0;
      showFrame(frameIdx);
      cancelFrameAnimation();
      return;
    }

    showFrame(frameIdx);
    lastFrameTime = timestamp;
  }

  frameRaf = requestAnimationFrame(tickNeedle);
}

function animateNeedle(direction) {
  if (!needleFrameEl) return;
  if (direction > 0 && frameIdx >= NEEDLE_FRAME_COUNT - 1) {
    showFrame(frameIdx);
    return;
  }
  if (direction < 0 && frameIdx <= 0) {
    showFrame(0);
    return;
  }

  cancelFrameAnimation();
  frameDirection = direction;
  lastFrameTime = performance.now();
  frameRaf = requestAnimationFrame(tickNeedle);
}

function applyPlaybackState(isPlaying, force = false) {
  const nextIsPlaying = Boolean(isPlaying);
  const previousIsPlaying = lastIsPlaying;
  lastIsPlaying = nextIsPlaying;
  document.body.classList.toggle('echo-vinyl-spinning', lastIsPlaying);

  if (!force && previousIsPlaying === nextIsPlaying) {
    if (nextIsPlaying && (frameRaf || frameIdx >= NEEDLE_FRAME_COUNT - 1)) return;
    if (!nextIsPlaying && (frameRaf || frameIdx <= 0)) return;
  }

  animateNeedle(lastIsPlaying ? 1 : -1);
}

function applySnapshot(snapshot) {
  const track = pickTrackFromSnapshot(snapshot);
  applyTrack(track);

  if (snapshot?.playback && typeof snapshot.playback.isPlaying === 'boolean') {
    applyPlaybackState(snapshot.playback.isPlaying);
  }
}

function collectRuntimeElements(player) {
  const bgLayer = player.querySelector('.echo-vinyl-bg-layer');
  coverImages = Array.from(bgLayer.querySelectorAll('#photo1 image, #photo2 image'));
  needleFrameEl = player.querySelector('.echo-vinyl-needle-frame');

  const discCoverImage = bgLayer.querySelector('#photo2 image');
  rotatingImages = [discCoverImage].filter(Boolean);
  rotatingImages.forEach((image) => image.classList.add('echo-vinyl-rotating'));

  frameIdx = 0;
  showFrame(0);
  applyCoverUrl(currentCoverUrl);
}

async function setupVinylElements() {
  const coverContainer = document.querySelector('.lyric-page .cover-container');
  if (!coverContainer) return;

  if (coverContainer === cachedCoverContainer && vinylElementsReady) {
    applyCoverUrl(currentCoverUrl);
    applyPlaybackState(lastIsPlaying);
    return;
  }

  const token = (setupToken += 1);
  let resources;
  try {
    resources = await loadResources();
  } catch (error) {
    console.error('[echomusic-vinyl-rotation] 资源加载失败:', error);
    return;
  }

  if (token !== setupToken) return;
  const currentContainer = document.querySelector('.lyric-page .cover-container');
  if (!currentContainer || currentContainer !== coverContainer) return;

  cancelFrameAnimation();
  coverContainer.querySelectorAll('.echo-vinyl-player').forEach((element) => element.remove());

  const player = document.createElement('div');
  player.className = 'echo-vinyl-player';
  player.innerHTML = `
    <div class="echo-vinyl-bg-layer">${resources.bgSvg}</div>
    <div class="echo-vinyl-needle-layer">
      <div class="echo-vinyl-needle-frame"></div>
    </div>
  `;
  coverContainer.appendChild(player);

  collectRuntimeElements(player);
  if (needleFrameEl) {
    needleFrameEl.style.backgroundImage = `url("${resources.needleSpriteUrl}")`;
  }
  cachedCoverContainer = coverContainer;
  vinylElementsReady = true;
  document.body.classList.add('echo-vinyl-ready');
  applyPlaybackState(lastIsPlaying, true);
}

function cleanupRuntimeDom() {
  cancelFrameAnimation();
  document.querySelectorAll('.echo-vinyl-player').forEach((element) => element.remove());
  document.getElementById('echo-vinyl-global-style')?.remove();
  document.body.classList.remove('echo-vinyl-ready');
  document.body.classList.remove('echo-vinyl-spinning');
  cachedCoverContainer = null;
  vinylElementsReady = false;
  needleFrameEl = null;
  coverImages = [];
  rotatingImages = [];
}

function resetRuntimeState() {
  setupToken += 1;
  activeCtx = null;
  currentCoverUrl = '';
  currentTrackId = '';
  lastIsPlaying = false;
  resourceCache = null;
}

function disposeListeners() {
  if (disposeSnapshot) {
    try { disposeSnapshot(); } catch (error) {}
    disposeSnapshot = null;
  }
  if (disposePlaybackWatch) {
    try { disposePlaybackWatch(); } catch (error) {}
    disposePlaybackWatch = null;
  }
  if (disposeTrackWatch) {
    try { disposeTrackWatch(); } catch (error) {}
    disposeTrackWatch = null;
  }
  if (observerRef) {
    observerRef.disconnect();
    observerRef = null;
  }
}

function registerPlaybackListeners(ctx) {
  if (ctx?.events?.onPlaybackChange) {
    disposePlaybackWatch = ctx.events.onPlaybackChange((isPlaying) => {
      applyPlaybackState(isPlaying);
    });
  } else if (ctx?.vue?.watch && ctx?.player?.isPlaying) {
    disposePlaybackWatch = ctx.vue.watch(ctx.player.isPlaying, (isPlaying) => {
      applyPlaybackState(isPlaying);
    });
  }

  if (ctx?.events?.onTrackChange) {
    disposeTrackWatch = ctx.events.onTrackChange((track) => {
      applyTrack(track);
      setupVinylElements();
    });
  }

  if (ctx?.nowPlaying?.getSnapshot) {
    ctx.nowPlaying.getSnapshot()
      .then((snapshot) => {
        applySnapshot(snapshot);
        setupVinylElements();
      })
      .catch(() => {});
  }

  if (ctx?.nowPlaying?.onSnapshot) {
    disposeSnapshot = ctx.nowPlaying.onSnapshot((snapshot) => {
      applySnapshot(snapshot);
      setupVinylElements();
    });
  }
}

function registerDomObserver() {
  let lastCoverContainer = document.querySelector('.lyric-page .cover-container');

  observerRef = new MutationObserver((mutations) => {
    if (!document.querySelector('.lyric-page')) return;

    let hasCoverChange = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.classList?.contains('lyric-page') ||
          node.classList?.contains('cover-side') ||
          node.classList?.contains('cover-wrapper') ||
          node.classList?.contains('cover-container') ||
          node.querySelector?.('.cover-container, .cover-wrapper')
        ) {
          hasCoverChange = true;
          break;
        }
      }
      if (hasCoverChange) break;
    }

    if (!hasCoverChange) return;

    const nextCoverContainer = document.querySelector('.lyric-page .cover-container');
    if (nextCoverContainer && nextCoverContainer !== lastCoverContainer) {
      lastCoverContainer = nextCoverContainer;
      vinylElementsReady = false;
      cachedCoverContainer = null;
    }
    setupVinylElements();
  });

  observerRef.observe(document.body, { childList: true, subtree: true });
}

export function activate(ctx) {
  disposeListeners();
  cleanupRuntimeDom();
  resetRuntimeState();
  activeCtx = ctx;
  lastIsPlaying = Boolean(ctx?.player?.isPlaying?.value);

  const initialTrack = ctx?.stores?.player?.currentTrackSnapshot || ctx?.player?.currentTrack?.value;
  applyTrack(initialTrack);
  injectVinylStyles();
  registerPlaybackListeners(ctx);
  setupVinylElements();
  registerDomObserver();
}

export function deactivate() {
  disposeListeners();
  cleanupRuntimeDom();
  resetRuntimeState();
}
