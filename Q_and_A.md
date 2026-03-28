# Browser MCP Containers — Q&A / Troubleshooting Guide

This document captures hard-won solutions to problems you will encounter when running Chrome in Docker containers with MCP (Model Context Protocol) servers. Each question is phrased the way you would actually search for it. If you are here, you probably just spent an hour staring at a silent failure — the answer is below.

> **Setup instructions:** See [README.md](README.md). **Full story:** See [FINDINGS.md](FINDINGS.md).

---

## Chrome Extensions in Docker

### How do I load Chrome extensions in headless mode?

Use `--headless=new` (not `--headless` or `--headless=old`). Since Chrome 112, the new headless mode is full Chrome without a display — it fully supports `--load-extension`, content scripts, service workers, and all `chrome.*` APIs. The old headless mode (`chrome-headless-shell`) is a separate, limited binary that never supported extensions.

### Why aren't my Chrome extensions loading in Puppeteer / Chrome DevTools MCP?

Puppeteer adds `--disable-extensions` by default. This silently blocks ALL extensions — no errors, no warnings, nothing in the logs. Fix it by passing:

```
--ignore-default-chrome-arg='--disable-extensions'
```

### Why does `--load-extension` not work with regular Chrome?

Starting with Chrome 142, the standard Chrome distribution removed `--load-extension` support entirely. You must use **Chrome for Testing** — a separate distribution from the Chrome team that retains extension side-loading. Install it via Puppeteer:

```bash
npx @puppeteer/browsers install chrome@stable
```

Then point your launcher at it with `--executablePath`.

### Do I need Xvfb to run Chrome with extensions in Docker?

No. This is a common misconception. `--headless=new` supports extensions natively since Chrome 112. Xvfb adds complexity without benefit. We tried the Xvfb approach and hit a dead end: `--remote-debugging-port` would not bind in headed mode inside Docker.

### Why does `--remote-debugging-port` not work with headed Chrome in Docker?

Chrome in headed mode inside Docker (even with Xvfb) silently refuses to bind the remote debugging port. Installing D-Bus does not fix it. Use `--remote-debugging-pipe` instead (which chrome-devtools-mcp uses in pipe mode), or just use `--headless=new` and skip Xvfb entirely.

---

## Bot Detection / Anti-Detection

### Why does `navigator.webdriver` return `true` in my Puppeteer-controlled Chrome?

Puppeteer adds `--enable-automation` by default, which sets `navigator.webdriver=true`. Fix it with:

```
--ignore-default-chrome-arg='--enable-automation'
```

Also add `--disable-blink-features=AutomationControlled` for extra safety.

### How do I make a Docker Chrome container pass LinkedIn bot detection?

You need three things:

1. `--ignore-default-chrome-arg='--enable-automation'` — hides `navigator.webdriver`
2. `--ignore-default-chrome-arg='--disable-extensions'` — allows anti-detect extensions to load
3. Browser signature spoofing so the container's fingerprint matches the real browser that created the cookies

The included `generate-anti-detect.py` script handles #3 automatically by reading your real browser's fingerprint and generating a matching Chrome flags file.

### What browser fingerprint properties do detection scripts check?

The major ones: `navigator.userAgent`, `navigator.platform`, `navigator.languages`, `screen.width/height`, `navigator.deviceMemory`, `navigator.hardwareConcurrency`, `navigator.connection` (rtt, effectiveType, downlink), `window.devicePixelRatio`, `screen.colorDepth`, WebGL renderer/vendor, timezone, and `navigator.webdriver`. The included cookie-exporter extension captures all of these from your real browser.

### Can I spoof the WebGL renderer in Docker?

Not easily. Docker containers use SwiftShader (software rendering) which reports `Google SwiftShader` instead of your real GPU. Spoofing the WebGL canvas output requires actual GPU passthrough to Docker. For most detection systems (including LinkedIn), the other fingerprint properties are sufficient — WebGL renderer alone does not trigger a block.

### What's the difference between `--headless` and `--headless=new`?

`--headless` (or `--headless=old`) launches `chrome-headless-shell` — a separate, limited browser engine. `--headless=new` launches real Chrome without a display. Since Chrome 132, the old mode is a completely separate binary. Always use `--headless=new` if you need extensions, content scripts, or full Chrome behavior.

---

## Cookie Export and Import

### How do I export Chrome cookies for use in Docker containers?

Use a Chrome MV3 extension with the `cookies` permission. Call `chrome.cookies.getAll({})` to get all cookies, format them into Playwright's `storageState.json` format, and download. External decryption tools no longer work since Chrome v146.

### Why can't I decrypt Chrome cookies with Python anymore?

Chrome v146+ introduced app-bound DPAPI encryption on Windows. The decryption key is tied to the Chrome installation itself, not your user account. Libraries like `pycookiecheat`, `browser_cookie3`, and manual `win32crypt` DPAPI calls all fail with the new encryption. The only reliable method is a browser extension using the `chrome.cookies` API.

### How do I import cookies into a Playwright container?

Mount your `storageState.json` into the container and point Playwright at it via config:

```json
{
  "browser": {
    "contextOptions": {
      "storageState": "/app/storageState.json"
    }
  }
}
```

Playwright loads the cookies natively on browser context creation.

### How do I import cookies into a Chrome DevTools container?

Use the `cookie-injector` MV3 extension included in this repo. It reads `storageState.json` (volume-mounted into the extension directory) and calls `chrome.cookies.set()` for each cookie on Chrome startup. Load it with `--load-extension=/path/to/cookie-injector`.

---

## Docker Networking

### How do I access localhost from inside a Docker container's browser?

Use `socat` to forward ports. Set `FORWARD_PORTS=5173,8080` in your `docker-compose.yml` environment. The entrypoint script creates socat listeners on each port that transparently proxy to `host.docker.internal`. The browser navigates to `localhost:5173` inside the container and it reaches the host. **Important:** Do not include the container's internal MCP port (3000 for Playwright, 9222 for Chrome DevTools) in FORWARD_PORTS — socat will fail to bind and the entrypoint will skip it.

### Why doesn't `host.docker.internal` work directly in the browser?

The browser navigates to `localhost`, not `host.docker.internal`. Even though `host.docker.internal` resolves to the host, URLs, cookies, CORS policies, and relative paths all expect `localhost`. Rewriting URLs is fragile and breaks frequently. socat port forwarding is transparent — nothing in the browser needs to change.

### Why does my Playwright container crash or log "SKIP: port 3000" on startup?

Port 3000 is the Playwright MCP server's internal listen port. If you include 3000 in `FORWARD_PORTS`, socat tries to bind to the same port and fails. The entrypoint detects this conflict and skips it with a warning, but if you're relying on forwarding port 3000, your app won't be reachable. The same applies to port 9222 in Chrome DevTools containers. **Rule: never include the container's internal MCP port in `FORWARD_PORTS`.**

### Why does `host.docker.internal` need `extra_hosts` in docker-compose?

On Docker Desktop (Mac/Windows), `host.docker.internal` resolves automatically. On Linux, it does not. Adding the following makes it work everywhere:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

---

## MCP Configuration

### Why don't my MCP browser tools show up in Claude Code?

Check these in order:

1. Container is running: `docker compose ps`
2. SSE endpoint responds: `curl http://localhost:9100/sse`
3. Your `.mcp.json` has `"type": "sse"` explicitly set (required when mixing HTTP and SSE transports)
4. Delete stale project cache: `rm -rf ~/.claude/projects/<path-encoded-project>/` and reload your IDE

### Why does Claude Code silently skip my SSE MCP server?

If your `.mcp.json` has BOTH HTTP-transport servers (like `wpcom-mcp`) and SSE-transport servers (like Playwright MCP), you MUST set `"type": "sse"` or `"type": "http"` explicitly on each entry. Without explicit types, Claude Code auto-detects the transport and gets confused when there is a mix. No error, no warning — the SSE server just does not appear in the tool list.

### Why does my MCP connection seem stuck / tools don't respond?

MCP servers are single-client. If a previous session did not disconnect cleanly, the server is still "connected" to the old client. Fix: `docker compose restart <service>`. Each container serves exactly one MCP client at a time — this is a protocol limitation, not a bug.

### Should I use `/sse` or `/mcp` endpoint?

Use `/sse`. The `/mcp` endpoint is for Streamable HTTP transport which returns 400 errors with most current MCP clients. Claude Code expects the legacy SSE transport at `/sse`.

---

## Docker Compose

### Why don't my environment variable changes take effect after `docker compose restart`?

`docker compose restart` restarts the container with the OLD environment. It does not re-read `docker-compose.yml`. Use `docker compose up -d` instead to pick up changes.

### How do I retrieve screenshots from a Chrome DevTools container?

Screenshots are saved inside the container at `/app/`. They are not returned inline by the MCP server. Retrieve them with:

```bash
docker cp <container-name>:/app/screenshot.png ./screenshot.png
```

Screenshots are lost when the container is recreated — copy them out before running `docker compose down`.

### Why does my Dockerfile `apt-get install` fail in the Playwright image?

The official Playwright MCP image runs as a non-root user. Add `USER root` before any `apt-get` commands in your Dockerfile, then switch back to the original user afterward if needed.
