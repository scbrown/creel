/* creel — in-page quipu graph explorer.
 *
 * Renders the live in-page quipu-wasm store visually, using quipu's own UI
 * pieces vendored from scbrown/quipu@6cf8864 (vendor/quipu-ui/): the
 * GraphCanvas force layout and the <quipu-*> web components.
 *
 * Those components speak quipu-server's REST dialect through one helper
 * (quipuFetch) against an `endpoint` attribute. Here the endpoint is the
 * synthetic origin `inpage://quipu`, and a fetch wrapper translates just
 * that scheme into wasm tool calls — /query → quipu_query (normalizing the
 * components' `sparql` key), /shapes → quipu_shapes, /entity_history → the
 * provider's dedicated export. Nothing else in the page sees the wrapper.
 *
 * UI: a floating "◉ graph" button opens a full-screen overlay with tabs —
 * Graph (GraphCanvas fed by the quipu_graph payload, click a node for its
 * entity view), SPARQL, Entity, Timeline, Schema.
 */
(function () {
  'use strict';

  const ENDPOINT = 'inpage://quipu';
  let componentsLoaded = false;
  let overlay = null;

  // ── fetch shim: inpage://quipu/* → wasm tool calls ───────────────
  const realFetch = window.fetch.bind(window);
  window.fetch = async function creelFetch(input, options) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(ENDPOINT)) return realFetch(input, options);

    const path = url.slice(ENDPOINT.length).replace(/\/$/, '') || '/';
    const body = options && options.body ? JSON.parse(options.body) : {};
    const respond = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    try {
      if (!window.CreelQuipu.provider) await window.CreelQuipu.ensureWasm();
      const call = (tool, args) => window.CreelQuipu.provider.callTool(tool, args);
      switch (path) {
        case '/query': {
          if (body.sparql && !body.query) body.query = body.sparql;
          return respond(await call('quipu_query', body));
        }
        case '/shapes':
          return respond(await call('quipu_shapes', body));
        case '/graph':
          return respond(await call('quipu_graph', body));
        case '/entity_history':
          return respond(await window.CreelQuipu.entityHistory(body.iri));
        default:
          return respond({ error: `inpage quipu endpoint has no ${path}` }, 404);
      }
    } catch (e) {
      return respond({ error: e && e.message ? e.message : String(e) }, 500);
    }
  };

  function loadComponents() {
    if (componentsLoaded) return Promise.resolve();
    componentsLoaded = true;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/quipu-ui/quipu-components.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── overlay ──────────────────────────────────────────────────────
  const TABS = ['Graph', 'SPARQL', 'Entity', 'Timeline', 'Schema'];

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n[k] = v;
      else n.setAttribute(k, v);
    }
    n.append(...children);
    return n;
  }

  async function openOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
    await loadComponents().catch((e) => console.warn('quipu-ui load failed', e));

    const panes = {};
    const tabBtns = {};
    overlay = el('div', {
      id: 'creelQuipuExplorer',
      style: 'position:fixed;inset:0;z-index:99999;background:#12121c;display:flex;flex-direction:column;color:#cfd2d6;font:13px system-ui,sans-serif;',
    });

    const header = el('div', { style: 'display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #2a2a3a;flex-wrap:wrap;' },
      el('span', { style: 'font-weight:600;color:#8be9fd;margin-right:8px;' }, 'quipu graph — in-page store'),
      ...TABS.map((t) => (tabBtns[t] = el('button', {
        style: 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:4px 12px;border-radius:5px;cursor:pointer;',
        onclick: () => showTab(t),
      }, t))),
      el('span', { style: 'flex:1' }),
      el('button', {
        style: 'background:#2a1d1d;border:1px solid #3a2a2a;color:#ff8080;padding:4px 12px;border-radius:5px;cursor:pointer;',
        onclick: () => { overlay.remove(); overlay = null; },
      }, 'Close'),
    );
    overlay.appendChild(header);

    const body = el('div', { style: 'flex:1;position:relative;overflow:hidden;' });
    overlay.appendChild(body);
    for (const t of TABS) {
      panes[t] = el('div', { style: 'position:absolute;inset:0;display:none;overflow:auto;' });
      body.appendChild(panes[t]);
    }

    function showTab(name) {
      for (const t of TABS) {
        panes[t].style.display = t === name ? 'block' : 'none';
        tabBtns[t].style.background = t === name ? '#2d2d44' : '#1d1d2e';
      }
      if (name === 'Graph' && !panes.Graph.dataset.loaded) renderGraph();
      if (name !== 'Graph' && !panes[name].dataset.loaded) renderComponent(name);
    }

    async function renderGraph() {
      panes.Graph.dataset.loaded = '1';
      panes.Graph.style.overflow = 'hidden';
      panes.Graph.textContent = 'Loading graph…';
      try {
        if (!window.CreelQuipu.provider) await window.CreelQuipu.ensureWasm();
        const payload = await window.CreelQuipu.provider.callTool('quipu_graph', { limit: 2000 });
        if (!payload.nodes || !payload.nodes.length) {
          panes.Graph.textContent = 'Graph is empty — ask the agent to record a quipu episode, then reopen.';
          return;
        }
        const { GraphCanvas, GRAPH_SLOT_COLORS } = await import('./vendor/quipu-ui/graph-canvas.js');
        panes.Graph.textContent = '';
        const canvas = el('canvas', { style: 'width:100%;height:100%;display:block;touch-action:none;cursor:grab;' });
        panes.Graph.appendChild(canvas);

        // Stable slots: rank types by census count, top N get palette slots.
        const slotOf = new Map();
        (payload.types || [])
          .slice()
          .sort((a, b) => (b.count || 0) - (a.count || 0))
          .slice(0, (GRAPH_SLOT_COLORS || []).length || 8)
          .forEach((t, i) => slotOf.set(t.iri, i));

        const gc = new GraphCanvas(canvas, {
          onSelect: (node) => {
            if (!node || !node.iri) return;
            panes.Entity.dataset.loaded = '';
            renderComponent('Entity', node.iri);
            showTab('Entity');
          },
        });
        gc.setData(payload, slotOf);

        const stats = el('div', {
          style: 'position:absolute;bottom:8px;right:12px;font-size:11px;color:#8892a4;background:rgba(26,26,46,.8);padding:2px 8px;border-radius:3px;',
        }, `${payload.stats?.nodes ?? payload.nodes.length} nodes · ${payload.stats?.edges ?? payload.edges.length} edges — click a node for its entity view`);
        panes.Graph.appendChild(stats);
      } catch (e) {
        panes.Graph.textContent = `Graph failed: ${e.message || e}`;
      }
    }

    function renderComponent(name, entityIri) {
      panes[name].dataset.loaded = '1';
      panes[name].textContent = '';
      const attrs = { endpoint: ENDPOINT, style: 'display:block;margin:12px;height:calc(100% - 24px);' };
      let tag;
      if (name === 'SPARQL') tag = 'quipu-sparql';
      else if (name === 'Entity') { tag = 'quipu-entity'; attrs.iri = entityIri || ''; }
      else if (name === 'Timeline') tag = 'quipu-timeline';
      else if (name === 'Schema') tag = 'quipu-schema';
      if (!customElements.get(tag)) {
        panes[name].textContent = 'quipu-ui components failed to load.';
        return;
      }
      if (name === 'Entity' && !attrs.iri) {
        const input = el('input', {
          placeholder: 'Entity IRI — or click a node in the Graph tab',
          style: 'width:min(640px,90%);margin:12px;background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:6px 10px;border-radius:5px;',
          onkeydown: (ev) => {
            if (ev.key === 'Enter' && ev.target.value.trim()) {
              renderComponent('Entity', ev.target.value.trim());
            }
          },
        });
        panes[name].appendChild(input);
        return;
      }
      panes[name].appendChild(el(tag, attrs));
    }

    document.body.appendChild(overlay);
    showTab('Graph');
  }

  function injectButton() {
    if (document.getElementById('creelGraphBtn')) return;
    const btn = el('button', {
      id: 'creelGraphBtn',
      title: 'Explore the in-page quipu knowledge graph',
      style: 'position:fixed;bottom:76px;right:16px;z-index:9999;background:#1d1d2e;color:#8be9fd;'
        + 'border:1px solid #2a2a3a;border-radius:18px;padding:7px 14px;cursor:pointer;'
        + 'font:12px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);',
      onclick: openOverlay,
    }, '◉ graph');
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }
})();
