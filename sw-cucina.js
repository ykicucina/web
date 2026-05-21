// ════════════════════════════════════════════════════════════
// YIO CucinaFlow Service Worker
// 版本号从注册 URL 的 ?v= 参数读取，单一数据源在 cucina.html
// ════════════════════════════════════════════════════════════

const VERSION       = new URL(self.location).searchParams.get('v') || 'unversioned';
const CACHE_VERSION = `cucina-${VERSION}`;
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// 启动时立即缓存的核心资源
const CORE_ASSETS = [
  '/cucina.html',
  '/manifest-cucina.json',
  '/logo-c.png',
  '/icon-c.png',
];

// ── INSTALL：缓存核心资源 + 自动激活（静默升级，不打扰用户） ──
self.addEventListener('install', e => {
  console.log(`[SW] 安装新版本: ${VERSION}`);
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then(c => c.addAll(CORE_ASSETS).catch(err => {
        console.warn('[SW] 部分核心资源缓存失败（不影响安装）:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE：清理旧版本缓存 ──
self.addEventListener('activate', e => {
  console.log(`[SW] 激活版本: ${VERSION}`);
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('cucina-') && !k.startsWith(CACHE_VERSION))
            .map(k => {
              console.log('[SW] 删除旧缓存:', k);
              return caches.delete(k);
            })
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH：智能路由 ──
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // 只处理 GET
  if (req.method !== 'GET') return;

  // ① Supabase API → 网络优先，不缓存（数据必须实时）
  if (url.hostname.includes('supabase.co')) {
    return; // 让浏览器原生处理
  }

  // ② WhatsApp 跳转链接 → 不拦截
  if (url.hostname.includes('whatsapp.com') || url.hostname.includes('wa.me')) {
    return;
  }

  // ③ HTML 文档 → 网络优先，失败回退缓存（保证拿到最新版本）
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(STATIC_CACHE).then(c => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match(req).then(c => c || caches.match('/cucina.html')))
    );
    return;
  }

  // ④ 静态资源（CDN / 字体 / 图标） → 缓存优先 + 后台刷新（stale-while-revalidate）
  e.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req)
        .then(resp => {
          if (resp.ok && (resp.type === 'basic' || resp.type === 'cors')) {
            const clone = resp.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => cached); // 网络失败 → 用缓存兜底
      return cached || fetchPromise;
    })
  );
});

// ── MESSAGE：接收主页面的更新指令 ──
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ════════════════════════════════════════════════════════════
// Web Push 推送处理（无 payload，SW 收到后自己查状态）
// ════════════════════════════════════════════════════════════

const WORKER_URL = 'https://yki-api.ykicucina.workers.dev';

// ── IndexedDB：读主页面登录后写入的 auth ──
function openAuthDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('yki-cucina-auth', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('auth');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getAuth() {
  try {
    const db = await openAuthDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('auth', 'readonly');
      const req = tx.objectStore('auth').get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

// ── 查"我有几单待处理 / 已发送"──
async function fetchPushStatus(token) {
  try {
    const r = await fetch(WORKER_URL + '/push/status', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return null;
    return await r.json(); // { pending, sent }
  } catch (e) {
    return null;
  }
}

// ── 设置/清除 App Badge（角标，主屏幕图标右上角的红点数字）──
async function setBadge(n) {
  try {
    if ('setAppBadge' in self.navigator) {
      if (n > 0) await self.navigator.setAppBadge(n);
      else await self.navigator.clearAppBadge();
    }
  } catch (e) {}
}

// ── PUSH 事件：收到推送 ──
self.addEventListener('push', e => {
  console.log('[SW] 收到推送');
  e.waitUntil((async () => {
    const auth = await getAuth();

    // 没登录或没令牌 → 显示通用通知
    if (!auth || !auth.token) {
      await self.registration.showNotification('🍽 YIO CucinaFlow', {
        body: '有新动态，打开 App 查看',
        icon: '/icon-c.png',
        badge: '/icon-c.png',
        tag: 'yki-cucina',
        renotify: true,
      });
      return;
    }

    // 查当前订单状态
    const info = await fetchPushStatus(auth.token);
    let title, body, badgeCount;

    if (!info) {
      title = '🍽 YIO CucinaFlow';
      body = '有新动态，打开查看';
      badgeCount = 1;
    } else if (info.pending > 0) {
      title = '🛒 新订货请求';
      body = info.sent > 0
        ? `${info.pending} 单待处理 · ${info.sent} 单待收货`
        : `${info.pending} 单待处理`;
      badgeCount = info.pending + info.sent;
    } else if (info.sent > 0) {
      title = '📦 订单已发送';
      body = `${info.sent} 单待收货`;
      badgeCount = info.sent;
    } else {
      title = '✅ 全部已收货';
      body = '目前没有待办订单';
      badgeCount = 0;
    }

    await self.registration.showNotification(title, {
      body,
      icon: '/icon-c.png',
      badge: '/icon-c.png',
      tag: 'yki-cucina-order',  // 同 tag 替换之前的，不会堆叠
      renotify: true,
      data: { restaurantId: auth.restaurantId || '' },
    });

    await setBadge(badgeCount);
  })());
});

// ── NOTIFICATIONCLICK：点通知打开 App ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const restaurantId = (e.notification.data && e.notification.data.restaurantId) || '';
  const targetUrl = restaurantId
    ? '/cucina.html?r=' + encodeURIComponent(restaurantId)
    : '/cucina.html';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // 已经打开了 → 聚焦那个 tab
        for (const c of clientList) {
          if (c.url.includes('cucina.html')) {
            return c.focus();
          }
        }
        // 否则开新窗口
        return self.clients.openWindow(targetUrl);
      })
  );
});
