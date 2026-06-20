/* ─────────────────────────────────────────────
   XOCO | GOTOMO — Service Worker
   Strategy:
     • App shell  → Cache First (fast loads)
     • Audio      → Network First, no cache
                    (large files; GitHub raw URLs)
     • GitHub API → Network First, short cache
     • Images     → Stale While Revalidate
   ───────────────────────────────────────────── */

const CACHE_NAME   = 'xoco-gotomo-v1';
const AUDIO_EXTS   = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.aac'];
const GITHUB_API   = 'https://api.github.com/';
const GITHUB_RAW   = 'https://raw.githubusercontent.com/';

// Assets to pre-cache on install (update paths to match your repo layout)
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Anton&family=Work+Sans:wght@300;400;500;600;700&display=swap'
];

// ── INSTALL ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // 1. Audio files — Network Only (never cache; files are large)
  if (isAudio(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // 2. GitHub API — Network First, cache 60 s
  if (url.startsWith(GITHUB_API)) {
    event.respondWith(networkFirstWithTTL(request, 60));
    return;
  }

  // 3. GitHub Raw (videos, images from repo) — Stale While Revalidate
  if (url.startsWith(GITHUB_RAW)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 4. Google Fonts — Cache First (immutable CDN URLs)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 5. Everything else (shell) — Cache First, fall back to network
  event.respondWith(cacheFirst(request));
});

// ── STRATEGIES ────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function staleWhileRevalidate(request) {
  const cache    = await caches.open(CACHE_NAME);
  const cached   = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || fetchPromise;
}

async function networkFirstWithTTL(request, ttlSeconds) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Stamp with fetch time so we can check TTL later
      const stamped = stampResponse(response.clone(), ttlSeconds);
      cache.put(request, stamped);
    }
    return response;
  } catch {
    // Offline — return cached if not expired
    const cached = await cache.match(request);
    if (cached && !isExpired(cached)) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── TTL HELPERS ───────────────────────────────

function stampResponse(response, ttlSeconds) {
  const headers = new Headers(response.headers);
  headers.set('X-SW-Cached-At', Date.now().toString());
  headers.set('X-SW-TTL',       String(ttlSeconds * 1000));
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers
  });
}

function isExpired(response) {
  const cachedAt = parseInt(response.headers.get('X-SW-Cached-At') || '0', 10);
  const ttl      = parseInt(response.headers.get('X-SW-TTL')       || '0', 10);
  return ttl > 0 && (Date.now() - cachedAt) > ttl;
}

// ── HELPERS ───────────────────────────────────

function isAudio(url) {
  return AUDIO_EXTS.some(ext => url.toLowerCase().split('?')[0].endsWith(ext));
}
