// ---------------------------------------------------------------------------
// Browser MCP Export — popup.js
// Grab IndexedDB from multiple sites, then download one storageState.json
// with cookies + browser signature + all collected IndexedDB data.
// ---------------------------------------------------------------------------

const grabBtn = document.getElementById("grabBtn");
const downloadBtn = document.getElementById("downloadBtn");
const clearBtn = document.getElementById("clearBtn");
const status = document.getElementById("status");
const collectionLabel = document.getElementById("collectionLabel");
const collectionToggle = document.getElementById("collectionToggle");
const collectionBody = document.getElementById("collectionBody");
const collectionList = document.getElementById("collectionList");
const collectionHeader = document.getElementById("collectionHeader");

// ---------------------------------------------------------------------------
// Collection display
// ---------------------------------------------------------------------------

collectionHeader.addEventListener("click", () => {
  collectionBody.classList.toggle("open");
  collectionToggle.textContent = collectionBody.classList.contains("open") ? "\u25B2" : "\u25BC";
});

async function getStoredIDB() {
  const data = await chrome.storage.local.get("collectedIndexedDB");
  return data.collectedIndexedDB || {};
}

async function setStoredIDB(idbData) {
  await chrome.storage.local.set({ collectedIndexedDB: idbData });
}

async function refreshCollectionUI() {
  const stored = await getStoredIDB();
  const origins = Object.keys(stored);

  if (origins.length === 0) {
    collectionLabel.textContent = "No IndexedDB collected";
    collectionList.innerHTML = '<span class="empty-msg">No databases collected yet.</span>';
    return;
  }

  const totalDbs = Object.values(stored).reduce((sum, dbs) => sum + dbs.length, 0);
  const totalRecords = Object.values(stored).reduce((sum, dbs) =>
    sum + dbs.reduce((s, db) =>
      s + db.objectStores.reduce((r, st) => r + (st.records || []).length, 0), 0), 0);

  collectionLabel.textContent = `${origins.length} origin${origins.length > 1 ? "s" : ""}, ${totalDbs} DB${totalDbs > 1 ? "s" : ""}, ${totalRecords} record${totalRecords > 1 ? "s" : ""}`;

  let html = "";
  for (const origin of origins) {
    const dbs = stored[origin];
    const dbNames = dbs.map(d => d.name).join(", ");
    const recCount = dbs.reduce((s, db) =>
      s + db.objectStores.reduce((r, st) => r + (st.records || []).length, 0), 0);
    html += `<div class="origin-item">
      <span class="origin-name">${origin}</span><br>
      <span class="origin-detail">${dbs.length} db${dbs.length > 1 ? "s" : ""}: ${dbNames} (${recCount} records)</span>
    </div>`;
  }
  collectionList.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Grab IndexedDB from the active tab
// ---------------------------------------------------------------------------

async function captureIndexedDB(tab) {
  if (!tab || !tab.id) return {};

  try {
    const [idbResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const result = {};
        try {
          const databases = await indexedDB.databases();
          for (const dbInfo of databases) {
            if (!dbInfo.name) continue;
            try {
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(dbInfo.name, dbInfo.version);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onupgradeneeded = () => {
                  req.transaction.abort();
                  reject(new Error("upgrade triggered"));
                };
              });

              const dbExport = { name: db.name, version: db.version, objectStores: [] };
              const storeNames = Array.from(db.objectStoreNames);

              for (const storeName of storeNames) {
                try {
                  const tx = db.transaction(storeName, "readonly");
                  const store = tx.objectStore(storeName);
                  const records = await new Promise((res, rej) => {
                    const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                  });
                  const keys = await new Promise((res, rej) => {
                    const r = store.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                  });

                  dbExport.objectStores.push({
                    name: storeName,
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    indexes: Array.from(store.indexNames).map(idxName => {
                      const idx = store.index(idxName);
                      return { name: idx.name, keyPath: idx.keyPath, unique: idx.unique, multiEntry: idx.multiEntry };
                    }),
                    records: keys.map((key, i) => ({ key, value: records[i] })),
                  });
                } catch (e) { /* skip unreadable stores */ }
              }

              db.close();
              if (dbExport.objectStores.length > 0) {
                if (!result[location.origin]) result[location.origin] = [];
                result[location.origin].push(dbExport);
              }
            } catch (e) { /* skip unopenable databases */ }
          }
        } catch (e) { /* indexedDB.databases() not supported */ }
        return result;
      },
    });
    return (idbResult && idbResult.result) ? idbResult.result : {};
  } catch (e) {
    console.warn("Could not capture IndexedDB:", e.message);
    return {};
  }
}

grabBtn.addEventListener("click", async () => {
  grabBtn.disabled = true;
  grabBtn.textContent = "Grabbing...";
  status.className = "";
  status.style.display = "none";

  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:")) {
      status.textContent = "Navigate to a real page first (not chrome:// or about:)";
      status.className = "error";
      return;
    }

    const captured = await captureIndexedDB(tab);
    const capturedOrigins = Object.keys(captured);

    if (capturedOrigins.length === 0) {
      status.textContent = `No IndexedDB found on ${new URL(tab.url).origin}`;
      status.className = "error";
      return;
    }

    // Merge with existing stored data
    const stored = await getStoredIDB();
    for (const [origin, dbs] of Object.entries(captured)) {
      stored[origin] = dbs; // Replace per-origin (latest capture wins)
    }
    await setStoredIDB(stored);

    const dbCount = captured[capturedOrigins[0]].length;
    const recCount = captured[capturedOrigins[0]].reduce((s, db) =>
      s + db.objectStores.reduce((r, st) => r + (st.records || []).length, 0), 0);
    status.textContent = `Grabbed ${dbCount} DB${dbCount > 1 ? "s" : ""} (${recCount} records) from ${capturedOrigins[0]}`;
    status.className = "success";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = "error";
  } finally {
    grabBtn.disabled = false;
    grabBtn.textContent = "Grab DB";
    await refreshCollectionUI();
  }
});

// ---------------------------------------------------------------------------
// Download storageState.json with cookies + signature + all collected IDB
// ---------------------------------------------------------------------------

async function captureBrowserSignature(tab) {
  if (!tab || !tab.id) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        let webglRenderer = null, webglVendor = null;
        try {
          const canvas = document.createElement("canvas");
          const gl = canvas.getContext("webgl");
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          if (ext) {
            webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
            webglVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
          }
        } catch (e) {}

        return {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          languages: Array.from(navigator.languages),
          userAgentData: navigator.userAgentData ? {
            brands: navigator.userAgentData.brands.map(b => ({ brand: b.brand, version: b.version })),
            mobile: navigator.userAgentData.mobile,
            platform: navigator.userAgentData.platform,
          } : null,
          deviceMemory: navigator.deviceMemory,
          hardwareConcurrency: navigator.hardwareConcurrency,
          maxTouchPoints: navigator.maxTouchPoints,
          screenWidth: screen.width,
          screenHeight: screen.height,
          screenColorDepth: screen.colorDepth,
          devicePixelRatio: window.devicePixelRatio,
          webglRenderer, webglVendor,
          cookieEnabled: navigator.cookieEnabled,
          doNotTrack: navigator.doNotTrack,
          pluginCount: navigator.plugins.length,
          pdfViewerEnabled: navigator.pdfViewerEnabled,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          timezoneOffset: new Date().getTimezoneOffset(),
          connectionType: navigator.connection ? navigator.connection.effectiveType : null,
          connectionRtt: navigator.connection ? navigator.connection.rtt : null,
          connectionDownlink: navigator.connection ? navigator.connection.downlink : null,
        };
      },
    });
    return result.result;
  } catch (e) {
    console.warn("Could not capture browser signature:", e.message);
    return null;
  }
}

downloadBtn.addEventListener("click", async () => {
  downloadBtn.disabled = true;
  grabBtn.disabled = true;
  downloadBtn.textContent = "Exporting...";
  status.className = "";
  status.style.display = "none";

  try {
    // 1. Get active tab
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // If on chrome:// page, navigate to google.com for signature
    if (tab && tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:"))) {
      status.textContent = "Navigating to a real page for signature...";
      status.className = "success";
      status.style.display = "block";
      await chrome.tabs.update(tab.id, { url: "https://www.google.com" });
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }

    status.textContent = "Collecting cookies + signature...";
    status.className = "success";
    status.style.display = "block";

    // 2. Export cookies (global)
    const cookies = await chrome.cookies.getAll({});

    // 3. Browser signature
    const browserSignature = await captureBrowserSignature(tab);

    // 4. Also grab IndexedDB from current tab (auto-grab on download)
    const currentIDB = await captureIndexedDB(tab);

    // 5. Merge current tab's IDB with stored collection
    const stored = await getStoredIDB();
    for (const [origin, dbs] of Object.entries(currentIDB)) {
      stored[origin] = dbs;
    }
    await setStoredIDB(stored);

    // 6. Build storageState
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
      indexedDB: stored,
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
      ? `sig(${browserSignature.platform})`
      : "no sig";
    const originCount = Object.keys(stored).length;
    const totalDbs = Object.values(stored).reduce((s, d) => s + d.length, 0);
    status.textContent = `Exported ${cookies.length} cookies, ${sigStatus}, ${originCount} origin${originCount !== 1 ? "s" : ""} (${totalDbs} DBs)`;
    status.className = "success";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = "error";
  } finally {
    downloadBtn.disabled = false;
    grabBtn.disabled = false;
    downloadBtn.textContent = "Download All";
    await refreshCollectionUI();
  }
});

// ---------------------------------------------------------------------------
// Clear stored IndexedDB
// ---------------------------------------------------------------------------

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("collectedIndexedDB");
  status.textContent = "Cleared all stored IndexedDB data";
  status.className = "success";
  await refreshCollectionUI();
});

// ---------------------------------------------------------------------------
// Init — refresh collection display on popup open
// ---------------------------------------------------------------------------

refreshCollectionUI();
