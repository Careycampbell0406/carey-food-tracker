// Offline cache for Carey's Food Tracker
const CACHE = 'carey-ft-v5';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './zxing.min.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so updates arrive), fall back to cache when offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Only handle this app's own files; let Open Food Facts and other sites go straight to the network
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (!res.ok) return caches.match(e.request, { ignoreSearch: true }).then(r => r || res);
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});

/* Water reminders: +250 ml action and occasional periodicSync checks (no push server) */
const IDB_NAME = 'careyFoodTrackerIDB', IDB_STORE = 'kv';
function idbOpen() {
  return new Promise((res, rej) => {
    const q = indexedDB.open(IDB_NAME, 1);
    q.onupgradeneeded = () => q.result.createObjectStore(IDB_STORE);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
function idbGet(key) {
  return idbOpen().then(db => new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
function idbSet(key, val) {
  return idbOpen().then(db => new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(val, key);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}
function todayKey(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hmToMin(t) { const [h, m] = (t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
function fmtL(ml) {
  const L = Math.round(ml / 10) / 100;
  if (Math.abs(L * 4 - Math.round(L * 4)) < 1e-6) {
    const q = Math.round(L * 4) / 4;
    return ((q % 1 === 0 || q % 0.5 === 0) ? q.toFixed(1) : q.toFixed(2)) + ' L';
  }
  return L.toFixed(2) + ' L';
}
function fmtAbout(ml) {
  const q = Math.max(250, Math.round(ml / 250) * 250);
  return fmtL(q);
}

async function swMaybeNotify() {
  const snap = await idbGet('waterSnap');
  if (!snap || !snap.reminders || snap.reminders.on === false) return;
  const k = todayKey();
  if (snap.day !== k) return; // stale snapshot from yesterday; page will refresh when opened
  if ((snap.have || 0) >= (snap.target || 0) && snap.target > 0) return;
  const r = snap.reminders;
  const start = hmToMin(r.start || '08:00'), end = hmToMin(r.end || '20:00');
  const every = [1, 2, 3].includes(+r.every) ? +r.every : 2;
  if (end <= start) return;
  const n = new Date();
  const cur = n.getHours() * 60 + n.getMinutes();
  if (cur < start || cur > end) return;
  const slots = [];
  for (let t = start; t <= end + 1e-6; t += every * 60) slots.push(Math.round(t));
  const due = slots.filter(t => cur + 1e-6 >= t).pop();
  if (due == null) return;
  const key = k + '-' + due;
  if (snap.lastFired === key) return;
  const span = end - start;
  const expected = Math.round((snap.target || 0) * Math.max(0, Math.min(1, (cur - start) / span)));
  const have = snap.have || 0, T = snap.target || 0;
  const unit = snap.unit === 'oz';
  const toU = ml => {
    if (!unit) return fmtL(ml);
    const oz = Math.round(ml / 29.5735295625 * 10) / 10;
    return (oz % 1 === 0 ? String(Math.round(oz)) : String(oz)) + ' oz';
  };
  let body = '💧 ' + toU(have).replace(/ (L|oz)$/, '') + ' of ' + toU(T);
  if (have >= T) return;
  if (expected - have >= 125) body += ' — about ' + (unit ? toU(Math.max(250, Math.round((expected - have) / 250) * 250)) : fmtAbout(expected - have)) + ' behind pace. Have a glass!';
  else body += ' — on track. Keep it up!';
  await self.registration.showNotification("Carey's Food Tracker", {
    body, icon: './icon-192.png', badge: './icon-192.png',
    tag: 'water-remind', renotify: true,
    data: { type: 'water', day: k },
    actions: [{ action: 'add250', title: '+250 ml' }]
  });
  snap.lastFired = key;
  await idbSet('waterSnap', snap);
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'water-reminder') e.waitUntil(swMaybeNotify());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const day = (e.notification.data && e.notification.data.day) || todayKey();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (e.action === 'add250') {
      if (list.length) {
        list.forEach(c => c.postMessage({ type: 'addWater', ml: 250, day }));
        if (list[0].focus) await list[0].focus();
        return;
      }
      const pending = (await idbGet('pendingWater')) || [];
      pending.push({ ml: 250, day, at: Date.now() });
      await idbSet('pendingWater', pending);
      const snap = await idbGet('waterSnap');
      if (snap && snap.day === day) { snap.have = (snap.have || 0) + 250; await idbSet('waterSnap', snap); }
    }
    if (list.length) {
      if (list[0].focus) await list[0].focus();
      if (list[0].navigate) try { await list[0].navigate('./'); } catch (err) {}
    } else {
      await self.clients.openWindow('./');
    }
  })());
});
