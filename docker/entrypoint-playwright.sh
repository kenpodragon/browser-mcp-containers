#!/bin/bash
set -e

# Clean up stale X lock files from previous crashes
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Start Xvfb for virtual display (headed mode avoids HeadlessChrome fingerprint)
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Wait for Xvfb to start
sleep 1

# Forward localhost ports to host machine via socat
# Set FORWARD_PORTS=3000,5173,8080 to make localhost:PORT inside the container
# transparently reach the host machine's localhost:PORT
if [ -n "$FORWARD_PORTS" ]; then
    IFS=',' read -ra PORTS <<< "$FORWARD_PORTS"
    MCP_LISTEN_PORT=3000
    for port in "${PORTS[@]}"; do
        port=$(echo "$port" | tr -d ' ')
        if [ "$port" = "$MCP_LISTEN_PORT" ]; then
            echo "SKIP: port $port is the MCP listen port — not forwarding"
            continue
        fi
        echo "Forwarding localhost:$port → host.docker.internal:$port"
        socat TCP4-LISTEN:${port},fork,reuseaddr TCP:host.docker.internal:${port} 2>/dev/null &
        socat TCP6-LISTEN:${port},fork,reuseaddr,ipv6only TCP:host.docker.internal:${port} 2>/dev/null &
    done
    sleep 0.5
fi

# Read browser signature from storageState.json and generate anti-detect.js
STORAGE_STATE="/app/storageState.json"
DEFAULT_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"

if [ -f "$STORAGE_STATE" ] && [ -f "/app/generate-anti-detect.py" ] && command -v python3 &>/dev/null; then
    eval "$(python3 /app/generate-anti-detect.py "$STORAGE_STATE" /app/anti-detect.js env)"
    USER_AGENT="${SIG_UA:-$DEFAULT_UA}"
    echo "Browser signature loaded: UA=${USER_AGENT:0:60}..."
else
    USER_AGENT="$DEFAULT_UA"
    echo "No signature available — using default UA"
fi

# Run Playwright MCP in headed mode on Xvfb (no --headless)
# --init-script patches navigator properties to avoid bot detection
# --user-agent removes HeadlessChrome marker
exec node cli.js \
    --browser chromium \
    --no-sandbox \
    --isolated \
    --port 3000 \
    --host 0.0.0.0 \
    --allowed-hosts '*' \
    --config /app/playwright-config.json \
    --user-agent "$USER_AGENT" \
    --init-script /app/anti-detect.js
