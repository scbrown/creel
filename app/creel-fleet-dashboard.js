/* creel — the fleet dashboard overlay (creel-hun).
 *
 * Split out of creel-fleet.js. This is the 🧺 panel: a live view of the
 * agents, their results, the comms log, and the manual spawn and launch
 * buttons an operator needs when a popup blocker ate an agent-initiated
 * spawn. Pure UI over the fleet layer's public operations — nothing here
 * owns state, so it is the easiest third of the file to read and the one
 * least likely to break anything when it changes.
 */
(function () {
  'use strict';

  const FLEET = window.CreelFleetInternal;
  if (!FLEET) throw new Error('creel-fleet-dashboard.js loaded before creel-fleet.js — check the script order in onepagent.html');
  const {
    BC, DRAIN_ID, MY_TASK_ID, MY_WORKER_ID,
    putTask, getTask, allTasks, delTask, genId, notify,
    requeueStale, statusReport, isMeta, aliveLocks,
    resolveCaps, spawnWindow, deviceInfo, tabCap,
    commsLog, digestAdd, CreelFleet,
    agentBoot, workerBoot, refreshLiveMirror, drainDigest,
  } = FLEET;
  // ── dashboard overlay ────────────────────────────────────────────
  let overlay = null;
  function h(tag, style, ...kids) {
    const n = document.createElement(tag);
    if (style) n.style.cssText = style;
    n.append(...kids);
    return n;
  }

  async function renderDashboard() {
    if (!overlay) return;
    const list = overlay.querySelector('#creelFleetList');
    const report = await statusReport();
    const chip = overlay.querySelector('#creelFleetChip');
    if (chip) {
      const caps = await resolveCaps();
      const atCap = caps.running >= caps.cap;
      chip.textContent = `${caps.device === 'mobile' ? '📱' : caps.device === 'tablet' ? '📟' : '🖥️'} ${caps.device} · ${caps.running}/${caps.cap} tabs`;
      chip.style.cssText = 'font-size:11px;border:1px solid ' + (atCap ? '#8a6a2a' : '#2a2a3a')
        + ';border-radius:10px;padding:2px 8px;color:' + (atCap ? '#e0af68' : '#8892a4') + ';';
      chip.title = `concurrent agent tabs capped at ${caps.cap} on ${caps.device} — ${caps.free} free`;
    }
    const capnote = overlay.querySelector('#creelFleetCapNote');
    if (capnote) {
      const caps = await resolveCaps();
      capnote.textContent = caps.free > 0
        ? `${caps.free} tab slot${caps.free === 1 ? '' : 's'} free on ${caps.device} (cap ${caps.cap})`
        : `at the ${caps.cap}-tab cap on ${caps.device} — spawns stay queued until a slot frees`;
      capnote.style.color = caps.free > 0 ? '#8892a4' : '#e0af68';
    }
    list.textContent = '';
    if (!report.length) {
      list.appendChild(h('div', 'color:#8892a4;padding:14px;', 'No fleet tasks. Spawn below, or ask the agent to use fleet_spawn.'));
    }
    const COLORS = { queued: '#e0af68', spawned: '#e0af68', running: '#8be9fd', done: '#9ece6a', failed: '#ff8080', dead: '#ff8080' };
    for (const t of report) {
      const row = h('div', 'border:1px solid #2a2a3a;border-radius:6px;padding:8px 10px;margin:8px 0;background:#181826;');
      const head = h('div', 'display:flex;gap:8px;align-items:center;');
      head.append(
        h('span', 'font-weight:600;', t.label || t.id),
        h('span', `color:${COLORS[t.status] || '#cfd2d6'};font-size:11px;`, t.status + (t.status === 'running' && t.alive ? ' ●' : '')),
        h('span', 'flex:1', ''),
      );
      if (['queued', 'spawned'].includes(t.status)) {
        const launch = h('button', 'background:#1d2e1d;border:1px solid #2a3a2a;color:#9ece6a;padding:2px 10px;border-radius:4px;cursor:pointer;', 'Launch');
        launch.onclick = () => { spawnWindow(t.id); };
        head.appendChild(launch);
      }
      if (['running', 'spawned', 'queued'].includes(t.status)) {
        const abort = h('button', 'background:#2e1d1d;border:1px solid #3a2a2a;color:#ff8080;padding:2px 10px;border-radius:4px;cursor:pointer;', 'Abort');
        abort.onclick = () => impl.fleet_abort({ id: t.id }).then(renderDashboard);
        head.appendChild(abort);
      }
      row.appendChild(head);
      row.appendChild(h('div', 'color:#8892a4;font-size:12px;margin-top:4px;white-space:pre-wrap;', String(t.task || '').slice(0, 200)));
      if (t.result) row.appendChild(h('div', 'color:#cfd2d6;font-size:12px;margin-top:6px;border-top:1px dashed #2a2a3a;padding-top:6px;white-space:pre-wrap;', t.result.slice(0, 500)));
      list.appendChild(row);
    }

    const comms = overlay.querySelector('#creelFleetComms');
    if (comms) {
      comms.textContent = '';
      comms.appendChild(h('div', 'color:#e0af68;font-weight:600;margin-bottom:4px;', 'comms'));
      if (!commsLog.length) comms.appendChild(h('div', 'color:#8892a4;', 'no fleet messages yet'));
      for (const m of commsLog.slice(-15).reverse()) {
        comms.appendChild(h('div', 'color:#8892a4;margin:2px 0;',
          `${new Date(m.ts).toLocaleTimeString()} · ${m.fromLabel || m.from} → ${m.to || 'all'}: `,
          h('span', 'color:#cfd2d6;', m.text.slice(0, 120))));
      }
    }
  }

  function openDashboard() {
    if (overlay) { overlay.remove(); overlay = null; return; }
    overlay = h('div', 'position:fixed;top:0;right:0;bottom:0;width:min(430px,95vw);z-index:99998;background:#12121c;border-left:1px solid #2a2a3a;color:#cfd2d6;font:13px system-ui,sans-serif;display:flex;flex-direction:column;box-shadow:-4px 0 16px rgba(0,0,0,.5);');
    const head = h('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a2a3a;');
    // The weft: hand every finished result to the operator's own agent so it
    // synthesizes across the parallel threads, in this same conversation.
    const weft = h('button', 'background:#2e2a12;border:1px solid #4a4422;color:#e0af68;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Synthesize');
    weft.onclick = async () => {
      const s = await impl.fleet_synthesize();
      if (!s.tasks.length) { weft.textContent = 'no results yet'; setTimeout(() => { weft.textContent = 'Synthesize'; }, 1500); return; }
      const lines = s.tasks.map((t) => `- [${t.label} · ${t.status}] ${t.result || '(no result)'}`).join('\n');
      injectTask(`Synthesize this creel burst across its parallel threads (${s.done} done, ${s.failed} failed). `
        + `Give one combined answer, note agreements/conflicts, then (if worth keeping) call fleet_writeback to record the key findings into the quipu graph.\n\n${lines}`);
      overlay.remove(); overlay = null;
    };
    const clear = h('button', 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Clear done');
    clear.onclick = () => impl.fleet_clear().then(renderDashboard);
    const close = h('button', 'background:#2a1d1d;border:1px solid #3a2a2a;color:#ff8080;padding:3px 10px;border-radius:4px;cursor:pointer;', 'Close');
    close.onclick = () => { overlay.remove(); overlay = null; };
    const chip = h('span', 'font-size:11px;color:#8892a4;border:1px solid #2a2a3a;border-radius:10px;padding:2px 8px;', '…');
    chip.id = 'creelFleetChip';
    head.append(h('span', 'font-weight:600;color:#e0af68;', '🧺 fleet'), chip, h('span', 'flex:1', ''), weft, clear, close);
    overlay.appendChild(head);

    const list = h('div', 'flex:1;overflow:auto;padding:6px 12px;');
    list.id = 'creelFleetList';
    overlay.appendChild(list);

    const comms = h('div', 'max-height:30%;overflow:auto;border-top:1px solid #2a2a3a;padding:6px 12px;font-size:11px;');
    comms.id = 'creelFleetComms';
    overlay.appendChild(comms);

    const form = h('div', 'border-top:1px solid #2a2a3a;padding:10px 12px;display:flex;flex-direction:column;gap:6px;');
    const label = document.createElement('input');
    label.placeholder = 'label (optional)';
    label.style.cssText = 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:5px 8px;border-radius:4px;';
    const task = document.createElement('textarea');
    task.placeholder = 'task for a new agent tab…';
    task.rows = 3;
    task.style.cssText = 'background:#1d1d2e;border:1px solid #2a2a3a;color:#cfd2d6;padding:5px 8px;border-radius:4px;resize:vertical;';
    const spawn = h('button', 'background:#1d2e1d;border:1px solid #2a3a2a;color:#9ece6a;padding:6px;border-radius:4px;cursor:pointer;font-weight:600;', 'Spawn agent tab');
    spawn.onclick = async () => {
      if (!task.value.trim()) return;
      await impl.fleet_spawn({ task: task.value.trim(), label: label.value.trim() || undefined });
      task.value = '';
      renderDashboard();
    };
    form.append(label, task, spawn);
    const capnote = h('div', 'font-size:11px;color:#8892a4;', '');
    capnote.id = 'creelFleetCapNote';
    form.appendChild(capnote);
    overlay.appendChild(form);

    document.body.appendChild(overlay);
    renderDashboard();
  }

  function injectButton() {
    if (document.getElementById('creelFleetBtn')) return;
    const btn = h('button', 'position:fixed;bottom:118px;right:16px;z-index:9999;background:#1d1d2e;color:#e0af68;'
      + 'border:1px solid #2a2a3a;border-radius:18px;padding:7px 14px;cursor:pointer;'
      + 'font:12px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);', '🧺 fleet');
    btn.id = 'creelFleetBtn';
    btn.title = 'Fleet dashboard — agents in tabs';
    // An emoji-prefixed label is a poor name to locate by; aria-label wins
    // over content, so {role:'button', name:'Fleet dashboard'} finds it.
    btn.setAttribute('aria-label', 'Fleet dashboard');
    btn.onclick = openDashboard;
    document.body.appendChild(btn);
  }

  BC.addEventListener('message', (e) => {
    if (e.data?.type === 'update' && overlay) renderDashboard();
    if (e.data?.type === 'update') scheduleDigestDrain();
    if (e.data?.type === 'msg') onFleetMsg(e.data);
  });

  // Burst isolation: fleet tabs must never carry the operator's conversation
  // (or any other tab's) into a task. The harness boots fleet tabs fresh
  // (onepagent.html loadConvHistory / IS_FLEET_TAB), but guard here too so a
  // stale harness build still starts clean — newConversation(true) resets
  // in-memory state and (since IS_FLEET_TAB) never touches ba_active_conv.
  function isolateContext() {
    if (!MY_TASK_ID && !MY_WORKER_ID) return;
    if (typeof newConversation === 'function' && typeof conversation !== 'undefined' && conversation.length) {
      newConversation(true);
    }
  }

  // Let the core repaint this panel without knowing it exists.
  FLEET.repaintDashboard = () => { if (overlay) renderDashboard(); };

  function start() {
    CreelFleet.registerDefaults();
    injectButton();
    isolateContext();
    if (MY_TASK_ID) agentBoot();
    if (MY_WORKER_ID) workerBoot();
    refreshLiveMirror(); // seed the count for dispatcher tabs that only read
    // Dashboard tabs: periodically requeue stale leases (frozen-tab detection)
    // and drain the fleet work log into the main tab's conversation.
    if (!MY_TASK_ID && !MY_WORKER_ID) {
      drainDigest();
      setInterval(async () => {
        const requeued = await requeueStale();
        if (requeued.length && overlay) renderDashboard();
        drainDigest();
      }, 60000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
