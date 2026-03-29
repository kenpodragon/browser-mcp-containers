# Browser MCP Containers

Docker containers running [Playwright MCP](https://github.com/microsoft/playwright-mcp) and [Chrome DevTools MCP](https://github.com/nicholasgriffintn/chrome-devtools-mcp) servers with built-in anti-detection, cookie import, and browser signature spoofing. Works with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Cursor, or any MCP-compatible AI agent. Each container is an isolated browser instance -- one per project, no conflicts between parallel agent sessions.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Google Chrome or Chromium (for cookie export extension)

## Quick Start

1. Clone the repo:
   ```bash
   git clone https://github.com/kenpodragon/browser-mcp-containers.git
   cd browser-mcp-containers
   ```

2. Install the cookie-exporter extension in Chrome:
   - Navigate to `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select the `docker/extensions/cookie-exporter/` directory

3. Export your session data:
   - **Single site**: Navigate to your app (logged in), click the extension icon, click **Download All**
   - **Multiple sites**: Visit each site, click **Grab DB** on each, then click **Download All** once

4. Copy the exported file into the shared directory:
   ```bash
   cp ~/Downloads/storageState.json docker/shared/
   ```

5. Start the containers:
   ```bash
   cd docker && docker compose up -d
   ```

6. Copy `.mcp.json.sample` from the repo root into your project directory as `.mcp.json`. Rename the server keys to match your project (e.g., `playwright-webapp`, `chrome-devtools-extension-dev`).

7. If using Claude Code, copy `CLAUDE.md.sample` to your project as `CLAUDE.md` for tool reference and troubleshooting tips.

8. Open Claude Code (or your MCP client) in the project directory. Browser tools are now available.

9. Verify: `curl http://localhost:9100/sse` should return an SSE event stream. In Claude Code, try `browser_navigate` to confirm tools are working.

## Playwright vs Chrome DevTools

| | Playwright | Chrome DevTools |
|---|---|---|
| **Best for** | Web app testing, authenticated browsing | Chrome extension testing/development |
| **Extension support** | No (extensions can't run inside) | Yes (full Chrome extension loading) |
| **Cookie loading** | Native via `storageState.json` | Via cookie-injector extension |
| **Anti-detection** | `--init-script` JS injection | Content scripts + Chrome flags |
| **Base image** | `mcr.microsoft.com/playwright/mcp` | `node:20-slim` + Chrome for Testing |
| **Internal port** | 3000 | 9222 |
| **Simpler setup** | Yes | More moving parts |

## Export Pipeline

**Why a browser extension?** Starting with Chrome v146+, cookies are encrypted using app-bound DPAPI. External tools (Python scripts, standalone decryptors) can no longer decrypt Chrome cookies. IndexedDB (where Firebase and other frameworks store auth tokens) is also origin-scoped and inaccessible externally. A browser extension is the only reliable way to export both.

**What the extension captures:**

- **All cookies** from the current Chrome profile
- **Full browser fingerprint**: User-Agent, platform, screen dimensions, WebGL renderer, Client Hints, languages, timezone, connection info, hardware specs
- **IndexedDB databases** from the active tab's origin (Firebase auth, app state, etc.)

**Multi-site workflow:** IndexedDB is origin-scoped -- `indexedDB.databases()` only returns databases for the current page's origin. To capture auth state from multiple sites:

1. Navigate to **Site A** (logged in) -- click **Grab DB**
2. Navigate to **Site B** (logged in) -- click **Grab DB**
3. Repeat for all sites needing auth
4. Click **Download All** -- one `storageState.json` with everything

The extension accumulates IndexedDB data across sites using `chrome.storage.local`. A collapsible panel shows all collected origins and databases for review before downloading. The **Clear** button resets the collection.

**Export format:** Playwright-compatible `storageState.json` with added `browserSignature` and `indexedDB` fields. The `indexedDB` key is organized by origin:

```json
{
  "cookies": [...],
  "browserSignature": {...},
  "indexedDB": {
    "http://localhost:5173": [{ "name": "firebaseLocalStorageDb", ... }],
    "https://www.linkedin.com": [{ "name": "beacons", ... }]
  }
}
```

Both Playwright and Chrome DevTools containers read from this same file. The injection is origin-aware -- each page only gets IndexedDB data matching its origin, so multiple sites with the same database name (e.g. `firebaseLocalStorageDb`) don't collide.

## Anti-Detection and Auth Injection

At container startup, `generate-anti-detect.py` reads `docker/shared/storageState.json` and generates JavaScript patches that make the container's browser match your real browser's fingerprint AND inject IndexedDB auth data before page scripts run.

**Spoofed signals:**

- `navigator.platform`, `navigator.languages`, `navigator.userAgent`
- `screen.width`, `screen.height`, `screen.availWidth`, `screen.availHeight`
- `navigator.deviceMemory`, `navigator.hardwareConcurrency`
- `navigator.connection` (effectiveType, downlink, rtt)
- `navigator.webdriver` (set to `false`)
- Client Hints (`Sec-CH-UA`, `Sec-CH-UA-Platform`, etc.)
- `colorDepth`, `pixelDepth`, `devicePixelRatio`, `doNotTrack`

**Matching Chrome flags:** `--user-agent`, `--accept-lang`, `--window-size` are set to match the captured signature.

**IndexedDB injection:** If `storageState.json` contains an `indexedDB` field, the generated script intercepts `indexedDB.open()` calls and injects the exported records before page scripts run. This is origin-aware -- only databases matching the current page's origin are injected. This enables Firebase Auth, session tokens, and other IndexedDB-stored state to carry over into containers.

**Known limitation:** WebGL renderer cannot be spoofed without GPU passthrough. Containers report SwiftShader instead of your real GPU. This is the only remaining detectable signal.

## MCP Configuration

Example `.mcp.json` for your project:

```json
{
  "mcpServers": {
    "playwright-myproject": {
      "type": "sse",
      "url": "http://localhost:9100/sse"
    }
  }
}
```

Key points:

- **Rename server keys** per project (e.g., `playwright-webapp`, `chrome-devtools-extension-dev`)
- Use the **`/sse` endpoint**, NOT `/mcp`. Streamable HTTP returns 400.
- **Always set `"type": "sse"` explicitly** when you have other MCP servers using HTTP transport in the same `.mcp.json`. Without it, Claude Code silently skips the SSE server -- no error, no warning, just missing tools.
- See `.mcp.json.sample` in the repo root for a working example.

## Localhost Forwarding

When your app runs on `localhost:3000` on the host, the browser inside the container can't reach it by default. The `FORWARD_PORTS` environment variable fixes this.

**How it works:** At container startup, `socat` TCP forwarders start inside the container. Each one listens on `localhost:PORT` and transparently proxies traffic to `host.docker.internal:PORT`, reaching the host machine.

**Configuration** in `docker-compose.yml`:

```yaml
environment:
  FORWARD_PORTS: "5173,8080,8000"
```

This forwards three ports. The browser inside the container can now navigate to `localhost:5173`, `localhost:8080`, or `localhost:8000` and reach your host services.

**Port conflict warning:** Do not include the container's internal MCP port in `FORWARD_PORTS`. Playwright uses port 3000 internally, Chrome DevTools uses 9222. Including these will cause socat to fail to bind (the entrypoint skips them with a warning).

**When you need it:** Whenever the browser in the container needs to access a dev server, API, or any service running on your host machine.

All port assignments — host mappings, internal MCP ports, and forwarded ports — are defined in `docker-compose.yml`, giving you a single place to see and manage the full port layout across all containers.

## Adding More Containers

1. Duplicate a service block in `docker/docker-compose.yml`
2. Change these values:
   - Service name (e.g., `playwright-newproject`)
   - Host port mapping (e.g., `9102:3000` for Playwright, `9103:9222` for Chrome DevTools)
   - `PROJECT_NAME` environment variable
   - `FORWARD_PORTS` as needed for the project
3. Run `docker compose up -d` to start the new container.

**One container per project.** MCP servers are single-client by design (fundamental protocol limitation). Two agent sessions connecting to the same container will conflict.

**Port convention:** Use ports `9100-9149` for browser MCP services.

## Known Gotchas

- **MCP single-client**: Each container serves one AI agent session at a time. If the connection seems stuck, restart: `docker compose restart <service>`
- **`"type": "sse"` required**: When mixing HTTP + SSE transports in `.mcp.json`, you **must** set `"type"` explicitly on each server entry. Claude Code silently skips SSE servers otherwise.
- **Stale project cache**: If MCP tools don't appear after config changes, delete `~/.claude/projects/<path-encoded-project>/` and reload your IDE.
- **Chrome DevTools screenshots**: Saved inside the container at `/app/`. Retrieve with: `docker cp <container>:/app/screenshot.png ./`
- **Env var changes**: `docker compose restart` does NOT re-read environment variables. Use `docker compose up -d` instead.
- **Playwright base image**: The official image runs as non-root. The Dockerfile uses `USER root` before `apt-get install`.
- **Auth pages show login first**: When navigating to auth-protected pages (e.g. Firebase), the initial page snapshot may show the login screen. Auth injection is async -- check `browser_console_messages` or take a second snapshot after a moment. The `Page URL` will show the redirected URL (e.g. `/game` or `/feed`) once auth completes.
- **ConstraintError warning**: A `ConstraintError: An object store with the specified name already exists` warning may appear in the console. This is harmless -- the IndexedDB interceptor and the page's framework both try to create the same store. Auth still works.
- **IndexedDB empty on export**: Make sure you're on the actual site page (not `chrome://` or `about:blank`) and logged in before clicking **Grab DB**. IndexedDB is origin-scoped and only returns databases for the current tab's origin.
- **Auth stops working**: Tokens in `storageState.json` expire. Re-export: visit the site (logged in) in Chrome, click **Grab DB**, then **Download All**, save to `docker/shared/`, and `docker compose up -d --force-recreate`.

## Credits

- Author: [Stephen Salaka](https://www.linkedin.com/in/ssalaka/)
- Blog: [does-god-exist.org](https://does-god-exist.org/)
- Built as part of multi-project AI agent infrastructure
- See `FINDINGS.md` for the full story of how this was built and what we learned
- See `Q_and_A.md` for troubleshooting and common questions
