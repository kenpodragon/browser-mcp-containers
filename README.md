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

3. Click the cookie-exporter extension icon in Chrome. It exports all cookies plus your browser's full fingerprint and saves a `storageState.json` file.

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

## Cookie Export Pipeline

**Why a browser extension?** Starting with Chrome v146+, cookies are encrypted using app-bound DPAPI. External tools (Python scripts, standalone decryptors) can no longer decrypt Chrome cookies. A browser extension is the only reliable way to export them.

**What the extension captures:**

- **All cookies** from the current Chrome profile
- **Full browser fingerprint**: User-Agent, platform, screen dimensions, WebGL renderer, Client Hints (Sec-CH-UA headers), languages, timezone, connection info (`navigator.connection`), `deviceMemory`, `hardwareConcurrency`, `colorDepth`, `pixelRatio`, `doNotTrack`

**Export format:** The `storageState.json` file is Playwright-compatible (cookies + origins arrays) with an added `browserSignature` field containing the captured fingerprint. Both Playwright and Chrome DevTools containers read from this same file.

## Anti-Detection

At container startup, `generate-anti-detect.py` reads the `browserSignature` field from `docker/shared/storageState.json` and generates JavaScript patches plus Chrome launch flags that make the container's browser match your real browser's fingerprint.

**Spoofed signals:**

- `navigator.platform`, `navigator.languages`, `navigator.userAgent`
- `screen.width`, `screen.height`, `screen.availWidth`, `screen.availHeight`
- `navigator.deviceMemory`, `navigator.hardwareConcurrency`
- `navigator.connection` (effectiveType, downlink, rtt)
- `navigator.webdriver` (set to `false`)
- Client Hints (`Sec-CH-UA`, `Sec-CH-UA-Platform`, etc.)
- `colorDepth`, `pixelDepth`, `devicePixelRatio`, `doNotTrack`

**Matching Chrome flags:** `--user-agent`, `--accept-lang`, `--window-size` are set to match the captured signature.

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

## Credits

- Author: [Stephen Salaka](https://www.linkedin.com/in/ssalaka/)
- Blog: [does-god-exist.org](https://does-god-exist.org/)
- Built as part of multi-project AI agent infrastructure
- See `FINDINGS.md` for the full story of how this was built and what we learned
- See `Q_and_A.md` for troubleshooting and common questions
