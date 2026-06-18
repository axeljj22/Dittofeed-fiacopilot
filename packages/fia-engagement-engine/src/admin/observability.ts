/**
 * Observability dashboard — quality of Sofía's conversations.
 * Lives at /admin/observability. Reads /api/observability/* (stats + threads + thread detail).
 */

import { ADMIN_AUTH_SCRIPT, ADMIN_LOGOUT_LINK } from "./authHelper";

export function getObservabilityHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Observabilidad — FIA Engine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0b10; color: #e4e4ef; min-height: 100vh; }
    .topbar { background: #12131a; border-bottom: 1px solid #2a2b3d; padding: 14px 24px; display: flex; align-items: center; gap: 16px; }
    .topbar h1 { font-size: 15px; font-weight: 600; color: #fff; }
    .topbar .badge { font-size: 11px; background: #1e1f2e; border: 1px solid #2a2b3d; border-radius: 4px; padding: 2px 8px; color: #9394a5; }
    .topbar .right { margin-left: auto; display: flex; gap: 12px; align-items: center; }
    .topbar a { font-size: 12px; color: #818cf8; text-decoration: none; }
    select, button { background: #0a0b10; border: 1px solid #2a2b3d; border-radius: 6px; padding: 6px 10px; color: #e4e4ef; font-size: 12px; cursor: pointer; }
    button.primary { background: #6366f1; color: #fff; border: none; font-weight: 600; }
    button.primary:hover { background: #4f46e5; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .kpi { background: #12131a; border: 1px solid #2a2b3d; border-radius: 12px; padding: 18px; }
    .kpi .v { font-size: 26px; font-weight: 700; color: #fff; }
    .kpi .l { font-size: 12px; color: #9394a5; margin-top: 4px; }
    .kpi.warn .v { color: #fbbf24; }
    .kpi.bad .v { color: #f87171; }
    .kpi.good .v { color: #4ade80; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    @media (max-width: 800px) { .grid-2 { grid-template-columns: 1fr; } }
    .panel { background: #12131a; border: 1px solid #2a2b3d; border-radius: 12px; padding: 18px; }
    .panel h3 { font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 14px; }
    .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; }
    .bar-row .name { width: 150px; color: #9394a5; text-transform: capitalize; }
    .bar-row .track { flex: 1; background: #0a0b10; border-radius: 4px; height: 16px; overflow: hidden; }
    .bar-row .fill { background: #6366f1; height: 100%; }
    .bar-row .num { width: 40px; text-align: right; color: #e4e4ef; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; color: #9394a5; font-weight: 500; padding: 8px; border-bottom: 1px solid #2a2b3d; }
    td { padding: 8px; border-bottom: 1px solid #1a1b26; }
    tr.clickable:hover { background: #1a1b26; cursor: pointer; }
    .chip { font-size: 10px; border: 1px solid #2a2b3d; border-radius: 4px; padding: 1px 6px; color: #9394a5; }
    .chip.fail { border-color: #7f1d1d; color: #f87171; }
    .chip.in { border-color: #1e3a5f; color: #93c5fd; }
    .chip.out { border-color: #14532d; color: #4ade80; }
    .nav { margin-top: 24px; padding-top: 16px; border-top: 1px solid #2a2b3d; font-size: 12px; }
    .nav a { color: #818cf8; text-decoration: none; margin-right: 16px; }
    /* Modal */
    .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 50; }
    .modal { position: fixed; top: 5%; left: 50%; transform: translateX(-50%); width: min(640px, 92vw); max-height: 88vh; overflow-y: auto; background: #12131a; border: 1px solid #2a2b3d; border-radius: 12px; padding: 20px; z-index: 51; display: none; }
    .modal h3 { font-size: 14px; color: #fff; margin-bottom: 14px; }
    .msg { margin-bottom: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13px; max-width: 85%; }
    .msg.in { background: #1a1b26; }
    .msg.out { background: #1e1f4e; margin-left: auto; }
    .msg .meta { font-size: 10px; color: #6b7280; margin-top: 4px; }
    #muted { color: #4b5563; padding: 30px; text-align: center; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>📊 Observabilidad de Sofía</h1>
    <span class="badge">FIA Engine</span>
    <div class="right">
      <select id="days" onchange="loadAll()">
        <option value="7">7 días</option>
        <option value="30" selected>30 días</option>
        <option value="90">90 días</option>
      </select>
      <button class="primary" onclick="classifyNow()">Clasificar ahora</button>
      <a href="/admin/engagement">← Dashboard</a>
    </div>
  </div>

  <div class="container">
    <div class="kpi-grid" id="kpis"></div>
    <div class="grid-2">
      <div class="panel"><h3>Tipos de mensaje</h3><div id="by-kind"></div></div>
      <div class="panel"><h3>Categorías de preguntas (clasificación IA)</h3><div id="by-label"></div></div>
    </div>
    <div class="panel">
      <h3>Conversaciones recientes</h3>
      <div id="threads"><div id="muted">Cargando...</div></div>
    </div>
    <div class="nav">
      <a href="/admin/engagement">← Dashboard</a>
      <a href="/admin/schedule">⏰ Cadencia</a>
      <a href="/admin/config">⚙️ Config</a>
      ${ADMIN_LOGOUT_LINK}
    </div>
  </div>

  <div class="modal-bg" id="modal-bg" onclick="closeModal()"></div>
  <div class="modal" id="modal"><h3>Conversación</h3><div id="modal-body"></div></div>

  ${ADMIN_AUTH_SCRIPT}
  <script>
    let TOKEN = '';
    window.onAuthReady = async function() { TOKEN = window.TOKEN; await loadAll(); };

    function hdr() { return { Authorization: 'Bearer ' + TOKEN }; }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function days() { return document.getElementById('days').value; }

    async function loadAll() {
      await Promise.all([loadStats(), loadThreads()]);
    }

    async function loadStats() {
      try {
        const resp = await fetch('/api/observability/stats?days=' + days(), { headers: hdr() });
        if (!resp.ok) return;
        const { data } = await resp.json();
        renderKpis(data);
        renderBars('by-kind', data.byKind);
        renderBars('by-label', data.byLabel);
      } catch {}
    }

    function renderKpis(d) {
      const pct = Math.round((d.responseRate || 0) * 100);
      const cards = [
        { v: d.threads, l: 'Conversaciones' },
        { v: d.inbound, l: 'Mensajes recibidos' },
        { v: d.outbound, l: 'Mensajes enviados' },
        { v: pct + '%', l: 'Reportes respondidos', cls: pct >= 30 ? 'good' : 'warn' },
        { v: d.truncatedThreads, l: 'Sin responder (truncadas)', cls: d.truncatedThreads > 0 ? 'warn' : '' },
        { v: d.failed, l: 'Fallos de envío (bugs)', cls: d.failed > 0 ? 'bad' : '' },
        { v: d.templateFallbacks, l: 'Cayó a template (IA falló)', cls: d.templateFallbacks > 0 ? 'warn' : '' },
        { v: d.weeklyReports, l: 'Reportes enviados' },
      ];
      document.getElementById('kpis').innerHTML = cards.map(function(c){
        return '<div class="kpi ' + (c.cls || '') + '"><div class="v">' + esc(c.v) + '</div><div class="l">' + esc(c.l) + '</div></div>';
      }).join('');
    }

    function renderBars(id, obj) {
      const entries = Object.entries(obj || {}).sort(function(a,b){return b[1]-a[1];});
      const el = document.getElementById(id);
      if (!entries.length) { el.innerHTML = '<div style="color:#4b5563;font-size:12px">Sin datos todavía</div>'; return; }
      const max = Math.max.apply(null, entries.map(function(e){return e[1];}));
      el.innerHTML = entries.map(function(e){
        const w = Math.round((e[1] / max) * 100);
        return '<div class="bar-row"><div class="name">' + esc(e[0]) + '</div><div class="track"><div class="fill" style="width:' + w + '%"></div></div><div class="num">' + e[1] + '</div></div>';
      }).join('');
    }

    async function loadThreads() {
      try {
        const resp = await fetch('/api/observability/threads?days=' + days() + '&limit=100', { headers: hdr() });
        if (!resp.ok) { document.getElementById('threads').innerHTML = '<div id="muted">Error ' + resp.status + '</div>'; return; }
        const { data } = await resp.json();
        renderThreads(data || []);
      } catch { document.getElementById('threads').innerHTML = '<div id="muted">Error de conexión</div>'; }
    }

    function renderThreads(rows) {
      if (!rows.length) { document.getElementById('threads').innerHTML = '<div id="muted">No hay conversaciones en el período</div>'; return; }
      document.getElementById('threads').innerHTML =
        '<table><thead><tr><th>Último mensaje</th><th>Tipo</th><th>Categoría</th><th>Msgs</th><th>Cuándo</th><th></th></tr></thead><tbody>' +
        rows.map(function(t){
          const dirChip = '<span class="chip ' + t.lastDirection + '">' + (t.lastDirection === 'in' ? 'recibido' : 'enviado') + '</span>';
          const fail = t.hasFailure ? ' <span class="chip fail">fallo</span>' : '';
          return '<tr class="clickable" onclick="openThread(\\'' + t.conversationId + '\\')">' +
            '<td>' + esc((t.lastBody || '').slice(0,60)) + '</td>' +
            '<td>' + dirChip + ' ' + esc(t.lastKind) + fail + '</td>' +
            '<td>' + (t.label ? '<span class="chip">' + esc(t.label) + '</span>' : '—') + '</td>' +
            '<td>' + t.messageCount + '</td>' +
            '<td>' + new Date(t.lastAt).toLocaleString('es-AR') + '</td>' +
            '<td>›</td></tr>';
        }).join('') + '</tbody></table>';
    }

    async function openThread(id) {
      document.getElementById('modal-bg').style.display = 'block';
      document.getElementById('modal').style.display = 'block';
      document.getElementById('modal-body').innerHTML = 'Cargando...';
      try {
        const resp = await fetch('/api/observability/thread/' + id, { headers: hdr() });
        const { data } = await resp.json();
        document.getElementById('modal-body').innerHTML = (data || []).map(function(m){
          return '<div class="msg ' + m.direction + '">' + esc(m.body) +
            '<div class="meta">' + esc(m.kind) + ' · ' + esc(m.status) + ' · ' + new Date(m.created_at).toLocaleString('es-AR') + '</div></div>';
        }).join('') || 'Sin mensajes';
      } catch { document.getElementById('modal-body').innerHTML = 'Error de conexión'; }
    }

    function closeModal() {
      document.getElementById('modal-bg').style.display = 'none';
      document.getElementById('modal').style.display = 'none';
    }

    async function classifyNow() {
      try {
        const resp = await fetch('/api/observability/classify', { method: 'POST', headers: hdr() });
        const data = await resp.json().catch(function(){return {};});
        alert(resp.ok ? ('Clasificadas ' + (data.classified ?? 0) + ' conversaciones') : ('Error: ' + (data.error || resp.status)));
        await loadAll();
      } catch { alert('Error de conexión'); }
    }
  </script>
</body>
</html>`;
}
