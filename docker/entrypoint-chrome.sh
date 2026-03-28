#!/bin/bash
set -e

# Forward localhost ports to host machine via socat
# Set FORWARD_PORTS=3000,5173,8080 to make localhost:PORT inside the container
# transparently reach the host machine's localhost:PORT
if [ -n "$FORWARD_PORTS" ]; then
    IFS=',' read -ra PORTS <<< "$FORWARD_PORTS"
    for port in "${PORTS[@]}"; do
        port=$(echo "$port" | tr -d ' ')
        echo "Forwarding localhost:$port → host.docker.internal:$port"
        socat TCP4-LISTEN:${port},fork,reuseaddr TCP:host.docker.internal:${port} 2>/dev/null &
        socat TCP6-LISTEN:${port},fork,reuseaddr,ipv6only TCP:host.docker.internal:${port} 2>/dev/null &
    done
    sleep 0.5
fi

# Build extension load args from all subdirs in /app/extensions
EXT_PATHS=""
if [ -d "/app/extensions" ]; then
    for ext_dir in /app/extensions/*/; do
        if [ -f "${ext_dir}manifest.json" ]; then
            if [ -n "$EXT_PATHS" ]; then
                EXT_PATHS="${EXT_PATHS},${ext_dir%/}"
            else
                EXT_PATHS="${ext_dir%/}"
            fi
        fi
    done
fi

# Find Chrome for Testing (supports --load-extension, unlike regular Chrome 142+)
CHROME_FOR_TESTING=$(find /root/.cache -name 'chrome' -type f -path '*/chrome-linux64/*' 2>/dev/null | head -1)
if [ -n "$CHROME_FOR_TESTING" ]; then
    echo "Using Chrome for Testing: $CHROME_FOR_TESTING"
else
    echo "WARNING: Chrome for Testing not found, falling back to system Chrome (extensions may not load)"
fi

CHROME_BIN="${CHROME_FOR_TESTING:-google-chrome-stable}"

# Read browser signature from storageState.json (exported by cookie-exporter extension)
STORAGE_STATE="/app/storageState.json"
DEFAULT_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
DEFAULT_LANG="en-US,en"
DEFAULT_VIEWPORT="1920x1080"

if [ -f "$STORAGE_STATE" ] && [ -f "/app/generate-anti-detect.py" ] && command -v python3 &>/dev/null; then
    # Generate content.js for cookie-injector extension + extract bash vars (UA/lang/viewport)
    eval "$(python3 /app/generate-anti-detect.py "$STORAGE_STATE" /app/extensions/cookie-injector/content.js env)"
    USER_AGENT="${SIG_UA:-$DEFAULT_UA}"
    ACCEPT_LANG="${SIG_LANG:-$DEFAULT_LANG}"
    VIEWPORT="${SIG_VIEWPORT:-$DEFAULT_VIEWPORT}"
    echo "Browser signature loaded: UA=${USER_AGENT:0:60}..."
else
    USER_AGENT="$DEFAULT_UA"
    ACCEPT_LANG="$DEFAULT_LANG"
    VIEWPORT="$DEFAULT_VIEWPORT"
    echo "No storageState.json or python3 — using default browser signature"
fi

# Build chrome-devtools-mcp args (array for correct quoting)
CHROME_ARG_FLAGS=()
CHROME_ARG_FLAGS+=(--chromeArg=--no-sandbox)
CHROME_ARG_FLAGS+=(--chromeArg=--disable-setuid-sandbox)
CHROME_ARG_FLAGS+=(--chromeArg=--disable-dev-shm-usage)
CHROME_ARG_FLAGS+=("--chromeArg=--user-agent=$USER_AGENT")
CHROME_ARG_FLAGS+=("--chromeArg=--accept-lang=$ACCEPT_LANG")
CHROME_ARG_FLAGS+=(--chromeArg=--disable-blink-features=AutomationControlled)

if [ -n "$EXT_PATHS" ]; then
    CHROME_ARG_FLAGS+=("--chromeArg=--load-extension=$EXT_PATHS")
    CHROME_ARG_FLAGS+=("--chromeArg=--disable-extensions-except=$EXT_PATHS")
    CHROME_ARG_FLAGS+=(--chromeArg=--enable-unsafe-extension-debugging)
fi

echo "Launching chrome-devtools-mcp (headless, pipe mode, extensions enabled)..."
echo "Chrome binary: $CHROME_BIN"
echo "Extensions: ${EXT_PATHS:-none}"

# chrome-devtools-mcp launches Chrome via pipe (--headless=new default)
# --ignore-default-chrome-arg removes Puppeteer defaults that break extensions/anti-detection:
#   --disable-extensions: blocks ALL extensions from loading
#   --enable-automation: sets navigator.webdriver=true (bot detection signal)
# mcp-proxy bridges stdio to SSE+HTTP for MCP clients
exec npx mcp-proxy \
    --port ${MCP_PORT:-9222} \
    -- npx chrome-devtools-mcp --no-usage-statistics \
    --executablePath "$CHROME_BIN" \
    --headless \
    --viewport "$VIEWPORT" \
    --isolated \
    --ignore-default-chrome-arg='--disable-extensions' \
    --ignore-default-chrome-arg='--enable-automation' \
    "${CHROME_ARG_FLAGS[@]}"
