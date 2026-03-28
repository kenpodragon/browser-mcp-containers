# Findings: Building Containerized Browser MCP Servers

This document tells the story of how and why we built a system of Docker-containerized browsers for AI agent MCP (Model Context Protocol) access. It covers the problems we hit, the dead ends we explored, and the solutions that actually worked. If you're building something similar, this should save you weeks of debugging.

> **Setup instructions:** See [README.md](README.md). **Troubleshooting:** See [Q_and_A.md](Q_and_A.md).

---

## 1. The Problem

AI coding agents like Claude Code can use browser MCP servers to navigate web pages, fill forms, take screenshots, and interact with web applications. Out of the box, these servers run via stdio — the MCP server launches a browser process directly, communicates over stdin/stdout, and dies when the client disconnects.

This works fine for a single project. It falls apart when you need more:

- **Session conflicts.** Two projects can't share a browser instance. Cookies, tabs, and navigation state collide. One agent closes a tab another agent was using.
- **Process management.** Stdio-based MCP servers are tightly coupled to the editor. VS Code hangs on shutdown waiting for the browser process to die. Kill the editor, and the browser becomes an orphan.
- **Parallel access.** If you're working on multiple web applications simultaneously — say, testing an API integration while also debugging a frontend — you need multiple isolated browser instances running at the same time.
- **Authenticated browsing.** Agents often need to be logged into real services (LinkedIn, internal dashboards, admin panels). Sharing a single browser profile across agents means one agent's logout breaks another's session.

We needed isolated, parallel, authenticated browser instances that could survive editor restarts and serve multiple projects without interference.

---

## 2. Architecture Decision

The solution: run each browser in its own Docker container, exposed over HTTP/SSE instead of stdio.

Each container gets a dedicated port on a sequential range (9100, 9101, 9102, ...). The AI agent's MCP client configuration points at `http://localhost:PORT/sse` instead of launching a local process. Containers can be restarted, rebuilt, and managed independently of the editor.

We settled on two container types to cover different use cases:

### Playwright MCP Containers

These use the official Playwright MCP server with its built-in Chromium browser. They're simpler to configure, handle anti-bot detection well out of the box, and natively support cookie loading via Playwright's `storageState.json` format. The downside: no Chrome extension support. If your workflow doesn't need extensions, Playwright containers are the better choice.

### Chrome DevTools MCP Containers

These run a full Chrome instance controlled via the Chrome DevTools Protocol. They support loading MV3 extensions — critical for workflows that depend on ad blockers, cookie managers, or custom automation extensions. The trade-off is significantly more setup: Chrome needs explicit flags to behave correctly in a container, and the MCP server (which speaks stdio natively) needs `mcp-proxy` as a bridge to expose an HTTP/SSE endpoint.

**Important**: these containers use **Chrome for Testing**, not regular Google Chrome. Starting with Chrome 142, the standard Chrome distribution removed support for `--load-extension`, making it impossible to side-load unpacked extensions. Chrome for Testing is a separate distribution maintained by the Chrome team specifically for automated testing — it retains `--load-extension` support. We install it via Puppeteer's download mechanism and point the MCP server at its binary with `--executablePath`.

Both container types are defined in Docker Compose with shared infrastructure: cookie volumes, extension mounts, and network configuration.

---

## 3. The Cookie Import Problem

An AI agent browsing the web anonymously is only marginally useful. The real value comes when the agent can browse *as you* — logged into your accounts, with your sessions, your preferences, your access. That means importing your real browser cookies into the container.

This used to be straightforward. Chrome stored cookies in a SQLite database, encrypted with DPAPI (on Windows) using keys accessible to any process running as the same user. Dozens of Python libraries could decrypt and export them.

**Chrome v146 changed everything.** Google introduced app-bound DPAPI encryption, where the decryption key is tied to the Chrome installation itself — not just the user account. External processes can no longer decrypt Chrome's cookies. The Python libraries that worked for years now fail silently or throw cryptographic errors.

We tried several approaches:
- Direct DPAPI decryption with `win32crypt` — fails with the new app-bound keys
- Extracting the app-bound key from Chrome's binary — Chrome detects tampering and rotates it
- Using Chromium-based tools that mimic Chrome's decryption — blocked by the same protections

**The solution that works: a Chrome MV3 extension.**

Chrome extensions running inside the browser have legitimate access to the `chrome.cookies` API. They can read every cookie for every domain without any encryption barriers — the browser handles decryption internally.

We built a cookie-exporter extension that:
1. Calls `chrome.cookies.getAll({})` to retrieve every cookie
2. Formats them into Playwright's `storageState.json` structure
3. Captures the browser's fingerprint (more on this in Section 7)
4. Exports everything as a single downloadable JSON file

On the container side:
- **Playwright containers** load cookies natively — Playwright's `--storage-state` flag accepts the exported file directly
- **Chrome DevTools containers** use a companion `cookie-injector` extension that reads the same file at startup and calls `chrome.cookies.set()` for each cookie

One export, two consumption paths, zero external decryption.

---

## 4. The Anti-Detection Problem

With cookies loaded, we expected both container types to behave identically. They didn't.

LinkedIn was our test case — it has aggressive bot detection that's well-documented and consistent. The same exported cookies, the same user account, very different results:

- **Playwright containers**: Loaded LinkedIn perfectly. The session was accepted, no challenges, no redirects. Browsing worked exactly like a real browser.
- **Chrome DevTools containers**: Immediately redirected to the login page. The cookies were being set (we verified in DevTools), but LinkedIn rejected the session on every page load.

Something about the Chrome DevTools container was triggering bot detection that Playwright avoided entirely.

---

## 5. Root Cause: Puppeteer's Default Flags

The Chrome DevTools MCP server uses Puppeteer internally to launch and control Chrome. Puppeteer, being designed for automated testing, adds several default Chrome flags at launch time. Two of these are devastating for authenticated browsing:

### `--disable-extensions`

This flag silently prevents ALL Chrome extensions from loading. Our cookie-injector extension? Never ran. Our anti-detection content scripts? Never injected. Chrome launched, the extensions were mounted in the filesystem, but the flag told Chrome to ignore them completely.

There's no error, no warning, no log entry. The extensions simply don't exist as far as Chrome is concerned.

### `--enable-automation`

This flag sets `navigator.webdriver` to `true` — a standard property that websites check to detect automated browsers. It also enables the `Chrome is being controlled by automated test software` infobar, and modifies other browser behaviors that detection scripts look for.

With these two flags active, our container was:
1. Not loading extensions (so no cookies were injected and no fingerprint spoofing was applied)
2. Advertising itself as an automated browser to every website it visited

The fix is a Chrome flag specifically designed for this situation:

```
--ignore-default-chrome-arg='--disable-extensions'
--ignore-default-chrome-arg='--enable-automation'
```

These flags tell Chrome to remove specific arguments from Puppeteer's default set while keeping everything else intact. After adding them, extensions loaded correctly and `navigator.webdriver` reported `false`.

---

## 6. Key Discovery: `--headless=new` Supports Extensions

Before finding the flag fix, we spent considerable time on what turned out to be a complete dead end.

Our assumption was that Chrome's headless mode couldn't load extensions. This is actually true — for the *old* headless mode. The original `--headless` flag launched a completely separate browser engine (`chrome-headless-shell`) that shared almost no code with regular Chrome. It couldn't load extensions, didn't support content scripts, and behaved differently in dozens of subtle ways.

Based on this assumption, we tried running Chrome in *headed* mode inside the container, using Xvfb (X Virtual Framebuffer) as a virtual display:

- Installed Xvfb in the container
- Started a virtual display at `:99`
- Launched Chrome against that display
- **Result**: `--remote-debugging-port` wouldn't bind. Chrome in headed mode inside Docker refused to expose the debugging port, even with every combination of flags we tried.

We then tried installing D-Bus (which Chrome uses for inter-process communication in headed mode). It didn't help. We tried different display configurations. Nothing worked.

**The breakthrough**: Chrome 112 (released in 2023) introduced a new headless mode — `--headless=new` — that is functionally identical to headed Chrome. Unlike the old headless mode, this is not a separate browser engine. It's the same Chrome, with the same capabilities, just without rendering to a display. Critically, it fully supports:

- `--load-extension` for MV3 extensions
- Content scripts injected into the MAIN world
- Extension service workers
- All `chrome.*` APIs

We dropped Xvfb entirely, switched to `--headless=new`, and everything worked. Extensions loaded, content scripts ran, and the debugging port bound correctly. The entire Xvfb detour was unnecessary.

If you're reading this and considering Xvfb for extension support in Docker: don't. Use `--headless=new`.

**One exception**: The Playwright container *does* use Xvfb intentionally, but for a different reason. Playwright's User-Agent includes `HeadlessChrome` when running headless, which is a detection signal. By running headed on Xvfb, the UA reports as regular `Chrome` instead. This is a Playwright-specific workaround — the Chrome DevTools container doesn't need it because we control the `--user-agent` flag directly.

---

## 7. Browser Signature Spoofing

Even with extensions loading and `navigator.webdriver` returning `false`, we still had a fingerprint gap. The browser inside the container is a different installation on a different machine (well, a container pretending to be a machine). Its fingerprint — User-Agent string, screen resolution, hardware specs, GPU renderer — doesn't match the real browser that originally created the cookies.

Sophisticated detection systems compare the browser's reported properties against what they've seen from previous sessions. If you logged in from a Windows machine with a 2560x1440 display and an NVIDIA GPU, then suddenly the same cookies appear from a Linux machine with a 1920x1080 display and a SwiftShader GPU, that's suspicious.

**Solution: export the real browser's fingerprint alongside the cookies and replay it in the container.**

The cookie-exporter extension captures everything a fingerprinting script would check:

- `navigator.userAgent` and `navigator.userAgentData` (Client Hints)
- `navigator.platform` and `navigator.languages`
- `screen.width`, `screen.height`, `screen.colorDepth`, `window.devicePixelRatio`
- `navigator.deviceMemory` and `navigator.hardwareConcurrency`
- WebGL vendor and renderer strings
- `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `navigator.connection` properties
- `navigator.doNotTrack`

This fingerprint is stored as a `browserSignature` field in the exported `storageState.json`.

At container startup, a Python script (`generate-anti-detect.py`) reads the signature and produces two outputs:

1. **JavaScript patches**: A script that uses `Object.defineProperty` to override `navigator`, `screen`, and other browser APIs so they return the exported values instead of the container's real values. This script is injected via a content script running in the MAIN world (so it executes in the page's JavaScript context, not an isolated extension context).

2. **Shell variable assignments**: Bash-compatible variable exports (`SIG_UA`, `SIG_LANG`, `SIG_VIEWPORT`) that the entrypoint script `eval`s to set corresponding Chrome flags (`--user-agent`, `--accept-lang`, `--window-size`).

This two-pronged approach ensures that both JavaScript-level APIs and HTTP-level headers report consistent values matching the real browser.

**The one gap we can't close**: WebGL renderer. The container uses SwiftShader (a software OpenGL implementation) because Docker containers don't have GPU access by default. SwiftShader reports itself as `Google SwiftShader` instead of whatever GPU the real machine has. Spoofing the WebGL renderer string requires GPU passthrough to Docker, which is possible but adds significant infrastructure complexity. For most use cases — including LinkedIn — the other fingerprint properties are sufficient.

---

## 8. Localhost Forwarding

Browser containers need to access development servers running on the host machine. When you're testing a web application at `localhost:3000`, the container needs to reach that port.

Docker provides `host.docker.internal` as a hostname that resolves to the host machine. But there's a catch: the browser navigates to `localhost:3000`, not `host.docker.internal:3000`. Rewriting URLs is fragile and breaks cookies, CORS, and relative paths.

The solution is `socat` — a lightweight network relay. The container's entrypoint reads a `FORWARD_PORTS` environment variable and starts a `socat` listener for each port:

```bash
# For each port in FORWARD_PORTS (e.g., "3000,8080"):
socat TCP-LISTEN:3000,fork,reuseaddr TCP:host.docker.internal:3000 &
socat TCP6-LISTEN:3000,fork,reuseaddr TCP:host.docker.internal:3000 &
```

Each port gets both IPv4 and IPv6 listeners that transparently proxy traffic to the host. Inside the container, `localhost:3000` works exactly as it does on the host — the browser doesn't know the difference.

The `extra_hosts` Docker Compose directive ensures `host.docker.internal` resolves correctly on Linux (it's automatic on Docker Desktop for Mac and Windows, but needs explicit configuration on Linux):

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

This approach works identically in both Playwright and Chrome DevTools containers with zero application-level changes.

**Gotcha: internal port conflicts.** The Playwright MCP server listens on port 3000 inside the container. If you include 3000 in `FORWARD_PORTS`, socat tries to bind to the same port and fails — the entrypoint detects this and skips it with a warning. This caused a crash loop in one of our containers until we removed the conflicting port. The same applies to Chrome DevTools containers on port 9222 (the `MCP_PORT`). Rule: never forward a port that the MCP server itself is using internally.

---

## 9. Key Learnings

1. **Puppeteer's default flags are the enemy.** `--disable-extensions` and `--enable-automation` are added silently by Puppeteer's launcher. They break extension loading and advertise automation. Use `--ignore-default-chrome-arg` to remove them selectively.

2. **`--headless=new` fully supports extensions.** Since Chrome 112, the new headless mode is real Chrome without a display. No Xvfb needed. This was our most expensive misconception — we spent significant time on a headed-mode-in-Docker approach that was completely unnecessary.

3. **Chrome v146+ makes external cookie decryption impossible.** App-bound DPAPI ties encryption to the Chrome installation. Browser extensions using `chrome.cookies` are the only reliable export method going forward.

4. **MCP servers are single-client.** Each container handles exactly one MCP client connection. A second client connecting silently fails — commands hang or return errors. If a connection gets stuck, restart the container. Plan one container per concurrent agent.

5. **`.mcp.json` needs explicit `"type"` when mixing transports.** If your MCP client configuration includes both stdio and SSE servers, the client may silently skip SSE entries unless each has an explicit `"type": "sse"` or `"type": "http"` field.

6. **`socat` is the reliable localhost bridge.** `host.docker.internal` resolves to the host, but browsers navigate to `localhost`. `socat` listeners on each forwarded port make the translation transparent.

7. **Browser signature export closes the fingerprint gap.** Exporting the real browser's navigator, screen, and WebGL properties alongside cookies — then replaying them via `Object.defineProperty` overrides and matching Chrome flags — makes the containerized session indistinguishable from the original browser to detection scripts.

8. **Regular Chrome removed `--load-extension` in v142.** You must use Chrome for Testing, which retains extension side-loading support. Install it via Puppeteer's download command and reference it with `--executablePath`.

9. **`docker compose restart` doesn't re-read environment variables.** If you change `.env` or `docker-compose.yml` environment values, `restart` uses the old values. Always use `docker compose up -d` to pick up changes.
