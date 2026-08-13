# creel — static browser agent harness

# Serve the harness locally
serve port="8420":
    python3 -m http.server {{port}} --directory app

# Local DeepSeek CORS proxy (BYOK passthrough)
proxy port="8421":
    python3 proxy/local-proxy.py {{port}}

# Syntax-check the creel-authored JS and the shell
check:
    node --check app/quipu-backend.js
    node --check app/yupana-backend.js
    node --check app/sw.js
    node --check proxy/deepseek-cors-worker.js
    python3 -m py_compile proxy/local-proxy.py
    @echo "check ok"
