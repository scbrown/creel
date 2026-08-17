/* creel bridge — popup. Views and edits the creel-origins boundary.
 *
 * The security list lives in the background worker (background.js, module
 * state + chrome.storage.local 'creelOrigins'). The popup never reads the
 * worker's internals — it asks through the two ops the worker exposes for
 * exactly this purpose (list_origins / set_origins), which the background
 * accepts from its own extension pages and from no one else. Everything here
 * is origin management; the popup has no path to act on a tab.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  async function call(op, args) {
    const reply = await chrome.runtime.sendMessage({ op, args: args || {} });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'bridge error');
    return reply.result;
  }

  const state = { origins: [], defaults: [], pagesPrefix: '' };

  function showErr(msg) {
    const el = $('err');
    if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  function render() {
    const ul = $('origins');
    ul.textContent = '';
    for (const origin of state.origins) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'origin';
      span.textContent = origin;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'remove';
      del.title = `stop trusting ${origin}`;
      del.textContent = '✕';
      del.addEventListener('click', async () => {
        try {
          const next = state.origins.filter((o) => o !== origin);
          state.origins = (await call('set_origins', { origins: next })).origins;
          showErr(null);
          render();
        } catch (e) { showErr(e.message); }
      });
      li.append(span, del);
      ul.append(li);
    }
    $('empty').classList.toggle('hidden', state.origins.length > 0);

    const def = $('defaults');
    def.textContent = '';
    for (const origin of state.defaults) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'origin';
      span.textContent = origin;
      if (!state.origins.includes(origin)) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'add-back';
        restore.textContent = '+';
        restore.title = `add ${origin} back`;
        restore.addEventListener('click', async () => {
          try {
            const next = [...state.origins, origin];
            state.origins = (await call('set_origins', { origins: next })).origins;
            showErr(null);
            render();
          } catch (e) { showErr(e.message); }
        });
        li.append(span, restore);
      } else {
        li.append(span);
      }
      def.append(li);
    }

    $('pages-prefix').textContent = state.pagesPrefix;
  }

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $('new-origin').value.trim();
    if (!value) return;
    try {
      state.origins = (await call('set_origins', { origins: [...state.origins, value] })).origins;
      $('new-origin').value = '';
      showErr(null);
      render();
    } catch (err) { showErr(err.message); }
  });

  $('reset-btn').addEventListener('click', async () => {
    try {
      state.origins = (await call('set_origins', { origins: [] })).origins;   // [] → defaults
      showErr(null);
      render();
    } catch (e) { showErr(e.message); }
  });

  (async () => {
    try {
      const info = await call('list_origins');
      state.origins = info.origins;
      state.defaults = info.defaults;
      state.pagesPrefix = info.pagesPrefix;
      $('version').textContent = info.version;
      render();
    } catch (e) {
      showErr(e.message || 'cannot reach the background worker');
    }
    // Advertise the op surface too (nice for debugging; never required).
    call('__ops').then((c) => {
      $('ops-count').textContent = `${c.ops.length} ops`;
    }).catch(() => { $('ops-count').textContent = ''; });
  })();
})();
