// ════════════════════════════════════════════════════════════
// YIO Fish - 通用错误日志上报
// 用法：在 HTML <head> 加 <script src="/yio-error-log.js?app=cucina"></script>
// 自动捕获：JS 错误、unhandled Promise rejection
// ════════════════════════════════════════════════════════════
(function() {
  'use strict';

  // 从 script src 解析 app 名称（如 ?app=cucina）
  const scripts = document.getElementsByTagName('script');
  let APP_NAME = 'unknown';
  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i].src || '';
    if (src.indexOf('yio-error-log.js') >= 0) {
      const m = src.match(/[?&]app=([^&]+)/);
      if (m) APP_NAME = decodeURIComponent(m[1]);
      break;
    }
  }

  const WORKER_URL = 'https://yio-api.zhou136103031.workers.dev';
  const MAX_ERRORS_PER_SESSION = 20;  // 防止失控
  let errorsReported = 0;
  const recentErrors = new Set();  // 防重复上报

  // 上报函数
  function reportError(payload) {
    if (errorsReported >= MAX_ERRORS_PER_SESSION) return;
    
    // 简单去重：同一个 message+stack 5 分钟内只报一次
    const fingerprint = (payload.message || '') + '|' + ((payload.stack || '').slice(0, 200));
    if (recentErrors.has(fingerprint)) return;
    recentErrors.add(fingerprint);
    setTimeout(function() { recentErrors.delete(fingerprint); }, 5 * 60 * 1000);

    errorsReported++;

    // 尝试获取餐厅和用户上下文
    let restaurantId = null;
    let userName = null;
    try {
      // 从全局变量或 sessionStorage 取（不同应用名字不同）
      restaurantId = window.REST_ID || window.RESTAURANT_ID || 
                     (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('yf_restaurant_id'));
      userName = window.currentUser || 
                 (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('yf_admin_user'));
    } catch (e) {}

    const body = {
      app: APP_NAME,
      level: payload.level || 'error',
      message: String(payload.message || '').slice(0, 1000),
      stack: payload.stack ? String(payload.stack).slice(0, 3000) : null,
      url: location.href.slice(0, 500),
      user_agent: navigator.userAgent.slice(0, 300),
      restaurant_id: restaurantId || null,
      user_name: userName || null,
      metadata: payload.metadata || null
    };

    // 用 fetch + keepalive，不阻塞页面
    try {
      fetch(WORKER_URL + '/log/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true  // 即使页面关闭也能完成上报
      }).catch(function() {});
    } catch (e) {}
  }

  // 捕获 JS 错误
  window.addEventListener('error', function(e) {
    if (!e || !e.message) return;
    // 忽略一些常见但无害的错误
    const msg = String(e.message);
    if (msg.indexOf('ResizeObserver loop') >= 0) return;  // Chrome 误报
    if (msg.indexOf('Script error') >= 0 && !e.filename) return;  // 跨域无源
    
    reportError({
      level: 'error',
      message: msg,
      stack: e.error && e.error.stack ? e.error.stack : (e.filename + ':' + e.lineno + ':' + e.colno),
      metadata: {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno
      }
    });
  });

  // 捕获 Promise 拒绝
  window.addEventListener('unhandledrejection', function(e) {
    let message = 'Unhandled Promise Rejection';
    let stack = null;
    if (e.reason instanceof Error) {
      message = e.reason.message || message;
      stack = e.reason.stack;
    } else if (typeof e.reason === 'string') {
      message = e.reason;
    } else if (e.reason && typeof e.reason === 'object') {
      try { message = JSON.stringify(e.reason).slice(0, 500); } catch(e2) {}
    }
    reportError({
      level: 'error',
      message: '[Promise] ' + message,
      stack: stack
    });
  });

  // 暴露手动上报接口（业务代码可调用）
  window.yioLogError = function(message, extra) {
    reportError({
      level: (extra && extra.level) || 'error',
      message: message,
      stack: extra && extra.stack,
      metadata: extra && extra.metadata
    });
  };
})();
