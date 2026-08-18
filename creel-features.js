/* creel — feature flags (creel-yon).
 *
 * One place that answers "is this runtime part of creel right now?", loaded
 * before the harness script so every gate can read it at definition time.
 *
 * A flag is not a deletion. Everything behind a false flag stays in the tree,
 * wired and callable, so turning it back on is one setting rather than an
 * archaeology project — and so the harness never ships a half-removed
 * subsystem whose leftovers still fetch, still render, or still claim a tool
 * name the model can call.
 *
 * Precedence: the defaults below, overridden by localStorage 'creel_features'
 * (a JSON object of flag → boolean), overridden by a #creel-features= hash
 * parameter. The hash form exists so a spawned fleet tab can be given a
 * different surface than the operator's tab without touching shared storage,
 * and so a test can drive a flag it must not leave behind.
 *
 * Classic script on purpose: top-level const lands in the global lexical
 * environment the harness script shares, so CREEL_FEATURES resolves there
 * without a window.* round-trip.
 */
const CREEL_FEATURE_DEFAULTS = {
  /* Python (Pyodide WASM) — PythonExec, VfsToPyodide, PyodideToVfs and the
   * ~10-15MB runtime download that backs them. Off: creel's own work does not
   * need in-page Python, and the runtime costs a slow first tool call, four
   * CDN hosts of fallback logic, a settings block, and a paragraph of system
   * prompt describing semantics no live tool has. */
  python: false,
};

const CREEL_FEATURES = (function readFeatureFlags() {
  const flags = { ...CREEL_FEATURE_DEFAULTS };
  const apply = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      // Only known flags, only booleans — an unknown key is a typo, and
      // silently accepting it would make a dead flag look live.
      if (k in flags && typeof v === 'boolean') flags[k] = v;
    }
  };
  try { apply(JSON.parse(localStorage.getItem('creel_features') || 'null')); } catch { /* unreadable override */ }
  try {
    const m = /creel-features=([^&]*)/.exec(location.hash || '');
    if (m) apply(JSON.parse(decodeURIComponent(m[1])));
  } catch { /* malformed hash */ }
  return flags;
})();

/** Tools that only exist when the Python runtime is enabled. Their names stay
 *  reserved either way, so a skill cannot claim one while the flag is off and
 *  then collide when it is turned back on. */
const PYTHON_TOOL_NAMES = new Set(['PythonExec', 'VfsToPyodide', 'PyodideToVfs']);

/** True when a built-in tool is live under the current flags. */
function featureAllowsTool(name) {
  if (PYTHON_TOOL_NAMES.has(name)) return !!CREEL_FEATURES.python;
  return true;
}

/** The message a disabled tool returns — it names the flag, because a model
 *  that gets "unavailable" with no reason retries the same call. */
function featureDisabledError(name) {
  if (PYTHON_TOOL_NAMES.has(name)) {
    return `Error: ${name} is unavailable — the Python runtime is disabled in this harness `
      + '(feature flag "python"). Do not retry it or the other Python tools. Use JSExec for '
      + 'in-page scripting, NodeExec for Node APIs, or the Read/Write/Edit/Glob/Grep file tools.';
  }
  return `Error: ${name} is unavailable — disabled by feature flag.`;
}

if (typeof window !== 'undefined') {
  window.CREEL_FEATURES = CREEL_FEATURES;
  window.featureAllowsTool = featureAllowsTool;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CREEL_FEATURE_DEFAULTS, PYTHON_TOOL_NAMES, featureAllowsTool, featureDisabledError };
}
