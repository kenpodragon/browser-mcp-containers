// Anti-detection patches for Playwright containers.
// Injected via --init-script, runs before every page's scripts.

Object.defineProperty(navigator, 'webdriver', { get: () => false });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

if (navigator.connection) {
  Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
}

if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
  window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
}

if (typeof Notification !== 'undefined') {
  Object.defineProperty(Notification, 'permission', { get: () => 'default' });
}
