/**
 * Cookie Injector for Krakalaken Docker containers.
 * Reads storageState.json (mounted into the extension directory) and
 * injects all cookies via chrome.cookies.set() on startup.
 *
 * The storageState.json is volume-mounted from the host into
 * /app/extensions/cookie-injector/storageState.json inside the container.
 */

async function loadAndInjectCookies() {
  let storageState;

  try {
    const url = chrome.runtime.getURL("storageState.json");
    const resp = await fetch(url);
    storageState = await resp.json();
  } catch (e) {
    console.error("[cookie-injector] Could not load storageState.json:", e.message);
    return;
  }

  const cookies = storageState.cookies || [];
  console.log(`[cookie-injector] Injecting ${cookies.length} cookies...`);

  let success = 0;
  let failed = 0;

  for (const c of cookies) {
    const protocol = c.secure ? "https" : "http";
    const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
    const url = `${protocol}://${domain}${c.path || "/"}`;

    // Map sameSite: Playwright format -> Chrome API format
    let sameSite = "lax";
    if (c.sameSite === "None" || c.sameSite === "no_restriction") sameSite = "no_restriction";
    else if (c.sameSite === "Strict") sameSite = "strict";
    else if (c.sameSite === "Lax") sameSite = "lax";

    try {
      await chrome.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: c.secure || false,
        httpOnly: c.httpOnly || false,
        sameSite,
        expirationDate: c.expires > 0 ? c.expires : undefined,
      });
      success++;
    } catch (e) {
      failed++;
      if (failed <= 5) {
        console.warn(`[cookie-injector] Failed: ${c.domain} ${c.name}: ${e.message}`);
      }
    }
  }

  console.log(`[cookie-injector] Done: ${success} set, ${failed} failed out of ${cookies.length}`);
}

// Run on every startup event
chrome.runtime.onInstalled.addListener(() => loadAndInjectCookies());
chrome.runtime.onStartup.addListener(() => loadAndInjectCookies());
loadAndInjectCookies();
