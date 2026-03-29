// Runs in ISOLATED world at document_start — has access to chrome.runtime.getURL.
// Reads browserSignature from storageState.json and injects it into the page's
// MAIN world as window.__browser_mcp_sig SYNCHRONOUSLY before content.js executes.

try {
  const url = chrome.runtime.getURL('storageState.json');

  // Use synchronous XHR to ensure the data is available before MAIN world scripts run
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false); // false = synchronous
  xhr.send();

  if (xhr.status === 200) {
    const data = JSON.parse(xhr.responseText);
    const sig = data.browserSignature;

    if (sig) {
      const script = document.createElement('script');
      script.textContent = `window.__browser_mcp_sig = ${JSON.stringify(sig)};`;
      (document.documentElement || document.head || document.body).prepend(script);
      script.remove();
    }

    // Also inject IndexedDB data into MAIN world
    const idb = data.indexedDB;
    if (idb && typeof idb === 'object' && Object.keys(idb).length > 0) {
      const idbScript = document.createElement('script');
      idbScript.textContent = `window.__browser_mcp_idb = ${JSON.stringify(idb)};`;
      (document.documentElement || document.head || document.body).prepend(idbScript);
      idbScript.remove();
    }
  }
} catch (e) {
  // Silent fail — content.js will use defaults
}
