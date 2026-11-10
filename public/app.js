const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const langSelect = document.getElementById('lang-select');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const modal = document.getElementById('player-modal');
const playerTitle = document.getElementById('player-title');
const closeModalBtn = document.getElementById('close-modal');

const LANG_STORAGE_KEY = 'customtube.lang';
const SCROLL_THRESHOLD_PX = 600;

// Feed state: either mode 'recommended' (query is ignored) or 'search'.
const feed = {
  mode: 'recommended',
  query: '',
  lang: '',
  nextPageToken: null,
  hasMore: false,
  isLoading: false,
  loadingPromise: null,
};

async function loadLanguages() {
  const res = await fetch('/api/languages');
  const languages = await res.json();
  langSelect.innerHTML = languages
    .map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`)
    .join('');
  const saved = localStorage.getItem(LANG_STORAGE_KEY);
  if (saved && languages.some((l) => l.code === saved)) {
    langSelect.value = saved;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function describeFeedStatus(data, label, resultCountSoFar) {
  if (data.total === 0) {
    return label === 'Search' ? `No videos in the catalog match "${data.query}".` : 'The catalog is empty.';
  }
  const moreNote = data.hasMore ? ' Scroll down for more.' : '';
  return `${label}: showing ${resultCountSoFar} of ${data.total} video(s) from the curated catalog.${moreNote}`;
}

function renderResults(items, { append } = { append: false }) {
  const html = items
    .map(
      (v) => `
      <div class="card" data-id="${v.videoId}" data-title="${escapeHtml(v.title)}">
        <img src="${v.thumbnail}" alt="${escapeHtml(v.title)}" loading="lazy" />
        <h4>${escapeHtml(v.title)}</h4>
        <p class="channel">${escapeHtml(v.channelTitle)}</p>
      </div>`
    )
    .join('');

  if (append) {
    resultsEl.insertAdjacentHTML('beforeend', html);
  } else {
    resultsEl.innerHTML = html;
  }
}

// Event delegation: survives appended cards from infinite scroll without rebinding listeners.
resultsEl.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openPlayer(card);
});

// --- Player (YouTube IFrame Player API, so we can detect when a video ends) ---

// Resolves once https://www.youtube.com/iframe_api has loaded (it calls this global).
const ytApiReady = new Promise((resolve) => {
  window.onYouTubeIframeAPIReady = resolve;
});

let player = null; // YT.Player, created lazily on first open
let currentCard = null; // the .card currently playing; its next sibling is "up next"
let isAdvancing = false;
let openedByAutoplay = false; // true when the current video was reached via auto-advance

async function openPlayer(card, { auto = false } = {}) {
  currentCard = card;
  openedByAutoplay = auto;
  playerTitle.textContent = card.dataset.title;
  modal.classList.remove('hidden');

  await ytApiReady;
  if (player) {
    player.loadVideoById(card.dataset.id);
    return;
  }
  await new Promise((resolve) => {
    player = new YT.Player('player-frame', {
      videoId: card.dataset.id,
      playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
      events: {
        onReady: resolve,
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) playNext();
        },
        onError: handlePlayerError,
      },
    });
  });
}

// Plays the card after the current one, loading the next feed page first if we're at the end.
async function playNext() {
  if (isAdvancing || modal.classList.contains('hidden')) return;
  // The feed was replaced (new search / language) while this video played: nothing to continue.
  if (!currentCard || !currentCard.isConnected) return;

  isAdvancing = true;
  try {
    let next = currentCard.nextElementSibling;
    if (!next && feed.hasMore) {
      await loadMore();
      next = currentCard.isConnected ? currentCard.nextElementSibling : null;
    }
    if (next && !modal.classList.contains('hidden')) await openPlayer(next, { auto: true });
  } finally {
    isAdvancing = false;
  }
}

// e.g. 101/150 = owner disabled embedding. During auto-advance, skip to the next video rather
// than stall; on a video the user clicked, explain instead of silently jumping elsewhere.
function handlePlayerError(e) {
  if (openedByAutoplay) {
    playNext();
    return;
  }
  const id = currentCard?.dataset.id;
  const reason = e.data === 101 || e.data === 150 ? "The owner doesn't allow this video to play here." : 'This video could not be played.';
  playerTitle.innerHTML = `${escapeHtml(reason)} <a href="https://www.youtube.com/watch?v=${encodeURIComponent(id)}" target="_blank" rel="noopener">Watch on YouTube</a>`;
}

function closePlayer() {
  modal.classList.add('hidden');
  if (player?.stopVideo) player.stopVideo();
  currentCard = null;
}

closeModalBtn.addEventListener('click', closePlayer);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closePlayer();
});

function buildFeedUrl() {
  const base =
    feed.mode === 'search'
      ? `/api/search?q=${encodeURIComponent(feed.query)}&lang=${encodeURIComponent(feed.lang)}`
      : `/api/recommended?lang=${encodeURIComponent(feed.lang)}`;
  return feed.nextPageToken ? `${base}&pageToken=${encodeURIComponent(feed.nextPageToken)}` : base;
}

async function startFeed(mode, { query = '', lang }) {
  // Let any in-flight page of the previous feed finish first, so it can't write its
  // results / page token into the new feed after we reset it.
  if (feed.loadingPromise) await feed.loadingPromise;
  feed.mode = mode;
  feed.query = query;
  feed.lang = lang;
  feed.nextPageToken = null;
  feed.hasMore = false;
  resultsEl.innerHTML = '';
  await loadMore({ initial: true });
}

// Returns the in-flight request if one is already running, so callers (e.g. autoplay)
// can await it instead of getting an immediate no-op.
function loadMore(opts) {
  if (feed.loadingPromise) return feed.loadingPromise;
  feed.loadingPromise = doLoadMore(opts).finally(() => {
    feed.loadingPromise = null;
  });
  return feed.loadingPromise;
}

async function doLoadMore({ initial = false } = {}) {
  if (!initial && !feed.hasMore) return;

  feed.isLoading = true;
  statusEl.textContent = initial
    ? (feed.mode === 'search' ? 'Searching the catalog...' : 'Loading recommended videos...')
    : 'Loading more videos...';

  try {
    const res = await fetch(buildFeedUrl());
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || 'failed to load videos'}`;
      feed.hasMore = false;
      return;
    }

    renderResults(data.results, { append: !initial });
    feed.nextPageToken = data.nextPageToken;
    feed.hasMore = Boolean(data.hasMore);

    const resultCountSoFar = resultsEl.querySelectorAll('.card').length;
    statusEl.textContent = describeFeedStatus(data, feed.mode === 'search' ? 'Search' : 'Recommended', resultCountSoFar);
  } catch (err) {
    statusEl.textContent = 'Network error while loading videos.';
  } finally {
    feed.isLoading = false;
  }
}

window.addEventListener('scroll', () => {
  if (feed.isLoading || !feed.hasMore) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - SCROLL_THRESHOLD_PX;
  if (nearBottom) loadMore();
});

// Logo = home: close the player, clear the search, and show the recommended feed.
// Modifier/middle clicks fall through to the plain href="/" (e.g. open in a new tab).
document.getElementById('home-link').addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  closePlayer();
  input.value = '';
  window.scrollTo({ top: 0 });
  startFeed('recommended', { lang: langSelect.value });
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  const lang = langSelect.value;
  if (!q) return;

  localStorage.setItem(LANG_STORAGE_KEY, lang);
  startFeed('search', { query: q, lang });
});

langSelect.addEventListener('change', () => {
  localStorage.setItem(LANG_STORAGE_KEY, langSelect.value);
  if (!input.value.trim()) {
    startFeed('recommended', { lang: langSelect.value });
  }
});

(async function init() {
  await loadLanguages();
  startFeed('recommended', { lang: langSelect.value });
})();
