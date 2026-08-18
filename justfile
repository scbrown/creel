# creel — static browser agent harness

# Serve the harness locally
serve port="8420":
    python3 -m http.server {{port}} --directory app

# Local DeepSeek CORS proxy (BYOK passthrough)
proxy port="8421":
    python3 proxy/local-proxy.py {{port}}

# Syntax-check every creel-authored JS file and the proxy
check:
    #!/usr/bin/env bash
    set -euo pipefail
    for f in app/*.js app/harness/*.js extension/*.js proxy/*.js tests/*.js tools/*.js; do
        node --check "$f"
    done
    # onepagent.html began as a vendored fork, but creel edits it constantly
    # and its scripts are inline — so they get parsed too, or a syntax error
    # in 16k lines only shows up as a blank page.
    node tools/check-html.js app/onepagent.html extension/popup.html
    # The harness is a stack of ordered parts; a part the service worker does
    # not know about works for whoever added it and breaks offline for everyone.
    node tools/check-shell.js
    python3 -m py_compile proxy/local-proxy.py
    python3 -c "import json;json.load(open('extension/manifest.json'))"
    # The extension injects the app's locator engine into foreign pages, so
    # the two copies must be byte-identical or an agent gets one vocabulary
    # for creel tabs and a subtly different one for the web.
    if ! cmp -s app/creel-locator.js extension/creel-locator.js; then
        echo "extension/creel-locator.js has drifted from app/creel-locator.js — run: just sync-locator" >&2
        diff -u app/creel-locator.js extension/creel-locator.js | head -20 >&2
        exit 1
    fi
    echo "check ok"

# Re-copy the locator engine into the extension after editing the app's copy.
sync-locator:
    cp -f app/creel-locator.js extension/creel-locator.js
    @echo "extension locator synced"

# Everything: fast logic tests, then the real page in real Chromium.
test: check
    node tests/test-beads.js
    node tests/test-device.js
    node tests/test-ui-crosstab.js
    node tests/test-bridge.js
    node tests/test-leave-warning.js
    node tests/test-features.js
    node tests/test-state.js
    node tests/test-fleet.js
    node tests/test-sw.js
    node tests/test-render.js
    node tests/test-ui-browser.js
    node tests/test-bridge-browser.js

# Just the fast ones — routing, the bridge handshake, the beads store, and
# device classification, against a DOM stub / temp dir.
test-unit: check
    node tests/test-beads.js
    node tests/test-device.js
    node tests/test-ui-crosstab.js
    node tests/test-bridge.js
    node tests/test-leave-warning.js

# The real page and the real extension, in real headless Chromium, driven only
# through the tool surfaces an agent gets. Zero dependencies: Node's built-in
# WebSocket speaking CDP (tests/browser.js). Skips cleanly when no Chromium is
# installed; CHROME_PATH overrides discovery.
test-ui: check
    node tests/test-features.js
    node tests/test-state.js
    node tests/test-fleet.js
    node tests/test-sw.js
    node tests/test-render.js
    node tests/test-ui-browser.js
    node tests/test-bridge-browser.js
