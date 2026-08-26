/**
 * Service worker for desktop notifications.
 *
 * Kept intentionally small. It exists for one reason: notifications raised
 * through a service worker registration can carry action buttons and survive
 * the dashboard tab losing focus, which a page-scoped `new Notification()`
 * cannot reliably do.
 *
 * There is no caching here on purpose. This dashboard is useless without a live
 * connection to its own server, so serving a stale shell offline would only
 * mislead - a cached page would show a frozen mention feed with no indication
 * that nothing is arriving.
 */

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every old tab to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Clicking a notification focuses an existing dashboard tab when there is one,
 * and opens the linked post if the notification carried a URL.
 */
self.addEventListener('notificationclick', (event) => {
  const targetUrl = event.notification?.data?.url || '/';
  event.notification.close();

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    const isExternal = /^https?:\/\//i.test(targetUrl) &&
      !targetUrl.startsWith(self.location.origin);

    if (isExternal) {
      await self.clients.openWindow(targetUrl);
      // Also surface the dashboard, so the alert can be triaged in context.
      const dashboard = windows.find((client) => client.url.startsWith(self.location.origin));
      if (dashboard) await dashboard.focus();
      return;
    }

    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.focus();
      return;
    }

    await self.clients.openWindow('/');
  })());
});
