document.getElementById("exportBtn").addEventListener("click", async () => {
  const btn = document.getElementById("exportBtn");
  const status = document.getElementById("status");

  btn.disabled = true;
  btn.textContent = "Exporting...";
  status.className = "";
  status.style.display = "none";

  try {
    // 1. Export cookies
    const cookies = await chrome.cookies.getAll({});

    // 2. Capture browser signature from the active tab
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let browserSignature = null;

    // If on a chrome:// or edge:// page, navigate to google.com first
    if (tab && tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:"))) {
      status.textContent = "Navigating to a real page for signature...";
      status.className = "success";
      status.style.display = "block";
      await chrome.tabs.update(tab.id, { url: "https://www.google.com" });
      // Wait for page to finish loading
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      // Re-query the tab to get updated info
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }

    if (tab && tab.id) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Collect all fingerprint-relevant signals from the real browser
            let webglRenderer = null;
            let webglVendor = null;
            try {
              const canvas = document.createElement("canvas");
              const gl = canvas.getContext("webgl");
              const ext = gl.getExtension("WEBGL_debug_renderer_info");
              if (ext) {
                webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
                webglVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
              }
            } catch (e) { /* no WebGL */ }

            return {
              // Core identity
              userAgent: navigator.userAgent,
              platform: navigator.platform,
              languages: Array.from(navigator.languages),

              // Client Hints (available synchronously)
              userAgentData: navigator.userAgentData ? {
                brands: navigator.userAgentData.brands.map(b => ({ brand: b.brand, version: b.version })),
                mobile: navigator.userAgentData.mobile,
                platform: navigator.userAgentData.platform,
              } : null,

              // Hardware
              deviceMemory: navigator.deviceMemory,
              hardwareConcurrency: navigator.hardwareConcurrency,
              maxTouchPoints: navigator.maxTouchPoints,

              // Screen
              screenWidth: screen.width,
              screenHeight: screen.height,
              screenColorDepth: screen.colorDepth,
              devicePixelRatio: window.devicePixelRatio,

              // WebGL
              webglRenderer: webglRenderer,
              webglVendor: webglVendor,

              // Browser features
              cookieEnabled: navigator.cookieEnabled,
              doNotTrack: navigator.doNotTrack,
              pluginCount: navigator.plugins.length,
              pdfViewerEnabled: navigator.pdfViewerEnabled,

              // Timezone
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              timezoneOffset: new Date().getTimezoneOffset(),

              // Connection
              connectionType: navigator.connection ? navigator.connection.effectiveType : null,
              connectionRtt: navigator.connection ? navigator.connection.rtt : null,
              connectionDownlink: navigator.connection ? navigator.connection.downlink : null,
            };
          },
        });
        browserSignature = result.result;
      } catch (e) {
        console.warn("Could not capture browser signature:", e.message);
      }
    }

    // 3. Build storageState with embedded signature
    const storageState = {
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expirationDate || -1,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: ({ "no_restriction": "None", "lax": "Lax", "strict": "Strict", "unspecified": "None" })[c.sameSite] || "Lax",
      })),
      origins: [],
      browserSignature: browserSignature,
    };

    const json = JSON.stringify(storageState, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    await chrome.downloads.download({
      url: url,
      filename: "storageState.json",
      saveAs: true,
      conflictAction: "overwrite",
    });

    URL.revokeObjectURL(url);

    const sigStatus = browserSignature
      ? `+ signature (${browserSignature.platform}, ${browserSignature.screenWidth}x${browserSignature.screenHeight})`
      : "(no signature — open a page first)";
    status.textContent = `Exported ${cookies.length} cookies ${sigStatus}`;
    status.className = "success";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = "error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Export Cookies";
  }
});
