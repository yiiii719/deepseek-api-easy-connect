// Service Worker：静态壳走 network-first（改了立刻生效），断网回落到缓存；API 一律不缓存
const VERSION = 'v1'
const SHELL = ['/', '/index.html', '/app.css', '/js/app.js', '/js/md.js', '/manifest.webmanifest', '/icons/icon.svg']
const CACHE = `ds-${VERSION}`

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/v1')) return

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && /\.(css|js|svg|png|webmanifest)$/.test(url.pathname)) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html'))),
  )
})
