/* creel — dedicated worker hosting the quipu-wasm store.
 *
 * Runs quipu (SQLite + SPARQL, compiled to wasm32) off the main thread:
 * OPFS's FileSystemSyncAccessHandle only exists in workers, and quipu's
 * locks must not block the UI. quipu-backend.js relays the harness's MCP
 * frames here as {id, op, args} messages.
 *
 * Ops: init → {persistence}, tools → [defs], call {name, args} → result,
 *      export → Uint8Array, import {bytes} → {ok}.
 */

let wasm = null;

async function boot() {
  wasm = await import('./wasm/pkg/creel_quipu_provider.js');
  await wasm.default();
  let persistence = 'memory';
  try {
    await wasm.install_opfs();
    wasm.open('creel.db');
    persistence = 'opfs';
  } catch (e) {
    console.warn('quipu-worker: OPFS unavailable, using memory store', e);
    wasm.open_memory();
  }
  return { persistence };
}

const ops = {
  init: () => boot(),
  tools: () => JSON.parse(wasm.tool_definitions()),
  call: ({ name, args }) => JSON.parse(wasm.call_tool(name, JSON.stringify(args || {}))),
  export: () => wasm.export_db(),
  entity_history: ({ iri }) => JSON.parse(wasm.entity_history(iri)),
  import: ({ bytes }) => { wasm.open_from_bytes(new Uint8Array(bytes)); return { ok: true }; },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    if (!wasm && op !== 'init') throw new Error('quipu-wasm not initialized');
    const result = await ops[op](args);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
