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
    # onepagent.html is the vendored OnePagent fork, not creel-authored, and
    # its scripts are inline — everything else here creel owns and must parse.
    for f in app/*.js extension/*.js proxy/*.js tests/*.js; do
        node --check "$f"
    done
    python3 -m py_compile proxy/local-proxy.py
    python3 -c "import json;json.load(open('extension/manifest.json'))"
    echo "check ok"

# The seams that reading one file cannot verify: cross-tab ui calls and the
# page↔extension bridge handshake. No dependencies, no browser.
test: check
    node tests/test-ui-crosstab.js
    node tests/test-bridge.js
