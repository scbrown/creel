/* creel — quipu store host, shared by both worker flavors.
 *
 * One module owns booting the wasm and dispatching ops so the dedicated
 * worker (per-tab store) and the SharedWorker (one store for the whole
 * fleet) cannot drift. Boot is once-per-host: concurrent init requests from
 * multiple fleet tabs share a single promise.
 */

export function createHost() {
  let wasm = null;
  let bootPromise = null;
  let bootInfo = null;

  async function boot() {
    wasm = await import('./wasm/pkg/creel_quipu_provider.js');
    await wasm.default();
    let persistence = 'memory';
    try {
      await wasm.install_opfs();
      wasm.open('creel.db');
      persistence = 'opfs';
    } catch (e) {
      console.warn('quipu host: OPFS unavailable, using memory store', e);
      wasm.open_memory();
    }
    bootInfo = { persistence };
    return bootInfo;
  }

  const ops = {
    init: () => { bootPromise = bootPromise || boot(); return bootPromise; },
    tools: () => JSON.parse(wasm.tool_definitions()),
    call: ({ name, args }) => JSON.parse(wasm.call_tool(name, JSON.stringify(args || {}))),
    export: () => wasm.export_db(),
    import: ({ bytes }) => { wasm.open_from_bytes(new Uint8Array(bytes)); return { ok: true }; },
    entity_history: ({ iri }) => JSON.parse(wasm.entity_history(iri)),
  };

  return {
    async dispatch({ id, op, args }) {
      try {
        if (!wasm && op !== 'init') {
          // A late-joining fleet tab may call before sending its own init.
          await (bootPromise = bootPromise || boot());
        }
        const result = await ops[op](args);
        return { id, ok: true, result };
      } catch (err) {
        return { id, ok: false, error: err && err.message ? err.message : String(err) };
      }
    },
  };
}
