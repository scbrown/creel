/* creel — dedicated worker hosting the quipu-wasm store.
 *
 * OPFS sync access handles only exist in dedicated workers, so this is
 * where the store lives. Which tab runs it is decided by quipu-backend.js:
 * the Web-Locks-elected leader tab hosts it for the whole fleet (serving
 * other tabs over BroadcastChannel RPC), or a lone tab hosts its own.
 * Host logic is shared via quipu-store-core.js.
 */
import { createHost } from './quipu-store-core.js';

const host = createHost();

self.onmessage = async (e) => {
  self.postMessage(await host.dispatch(e.data));
};
