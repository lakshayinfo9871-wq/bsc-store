const CACHE_NAME = "bsc-store-v1";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME));
});

self.addEventListener("fetch", e => {
  e.respondWith(fetch(e.request));
});