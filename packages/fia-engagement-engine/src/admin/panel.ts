/**
 * Admin Engagement Panel — self-contained HTML served by the engine.
 *
 * Accessible at /admin/engagement
 * Shows: global stats, recent logs, per-user detail.
 * Fetches data from the engine's own API endpoints.
 */

export function getAdminPanelHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FIA Engagement Engine — Panel Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e4e4e7; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
    h2 { font-size: 18px; margin: 24px 0 12px; color: #a1a1aa; }
    .subtitle { color: #71717a; font-size: 14px; margin-bottom: 24px; }

    /* Stats cards */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #1c1c22; border: 1px solid #27272a; border-radius: 12px; padding: 20px; }
    .card-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; margin-bottom: 4px; }
    .card-value { font-size: 32px; font-weight: 700; color: #fff; }
    .card-value.green { color: #4ade80; }
    .card-value.blue { color: #60a5fa; }
    .card-value.yellow { color: #facc15; }
    .card-value.red { color: #f87171; }

    /* Table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; background: #1c1c22; color: #a1a1aa; font-weight: 600; border-bottom: 1px solid #27272a; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #1c1c22; }
    tr:hover td { background: #1c1c22; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; }
    .badge-sent { background: #166534; color: #4ade80; }
    .badge-failed { background: #7f1d1d; color: #f87171; }
    .badge-opted_out { background: #78350f; color: #fbbf24; }
    .badge-true { background: #166534; color: #4ade80; }
    .badge-false { background: #27272a; color: #71717a; }

    /* Controls */
    .controls { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
    input, select, button { font-family: inherit; font-size: 13px; }
    input[type="text"] { background: #1c1c22; border: 1px solid #27272a; color: #fff; padding: 8px 12px; border-radius: 8px; width: 300px; }
    button { background: #3b82f6; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; }
    button:hover { background: #2563eb; }
    button.secondary { background: #27272a; }
    button.secondary:hover { background: #3f3f46; }

    /* Refresh indicator */
    .refresh { font-size: 12px; color: #71717a; }
    .loading { opacity: 0.5; pointer-events: none; }

    /* Responsive */
    @media (max-width: 768px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      input[type="text"] { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>FIA Engagement Engine</h1>
    <p class="subtitle">Panel de seguimiento de comunicaciones automatizadas</p>

    <!-- Stats -->
    <div class="stats" id="stats">
      <div class="card"><div class="card-label">Mensajes enviados (7d)</div><div class="card-value blue" id="stat-sent">-</div></div>
      <div class="card"><div class="card-label">Tasa de click</div><div class="card-value green" id="stat-click">-</div></div>
      <div class="card"><div class="card-label">Tasa de respuesta</div><div class="card-value yellow" id="stat-response">-</div></div>
      <div class="card"><div class="card-label">Opted-out activos</div><div class="card-value red" id="stat-optout">-</div></div>
    </div>

    <!-- Controls -->
    <h2>Actividad reciente</h2>
    <div class="controls">
      <input type="text" id="user-filter" placeholder="Filtrar por user_id..." />
      <button onclick="loadLogs()">Buscar</button>
      <button class="secondary" onclick="document.getElementById('user-filter').value=''; loadLogs()">Limpiar</button>
      <button class="secondary" onclick="triggerDetectors()">Ejecutar detectors</button>
      <span class="refresh" id="last-refresh"></span>
    </div>

    <!-- Logs table -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Usuario</th>
            <th>Journey</th>
            <th>Mensaje</th>
            <th>Status</th>
            <th>Click</th>
            <th>Respondio</th>
            <th>Respuesta</th>
          </tr>
        </thead>
        <tbody id="logs-body">
          <tr><td colspan="8" style="text-align:center;color:#71717a">Cargando...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const API = '';  // Same origin

    async function loadStats() {
      try {
        const res = await fetch(API + '/api/engagement/stats');
        const data = await res.json();
        document.getElementById('stat-sent').textContent = data.messages_sent;
        document.getElementById('stat-click').textContent = data.click_rate.toFixed(1) + '%';
        document.getElementById('stat-response').textContent = data.response_rate.toFixed(1) + '%';
        document.getElementById('stat-optout').textContent = data.users_opted_out;
      } catch (e) {
        console.error('Failed to load stats', e);
      }
    }

    async function loadLogs() {
      const userId = document.getElementById('user-filter').value.trim();
      const params = new URLSearchParams({ limit: '50' });
      if (userId) params.set('user_id', userId);

      try {
        const res = await fetch(API + '/api/engagement/logs?' + params);
        const data = await res.json();
        const tbody = document.getElementById('logs-body');

        if (!data.logs || data.logs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#71717a">Sin registros</td></tr>';
          return;
        }

        tbody.innerHTML = data.logs.map(log => {
          const date = new Date(log.created_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
          const msg = log.mensaje_enviado.length > 80 ? log.mensaje_enviado.slice(0, 80) + '...' : log.mensaje_enviado;
          return '<tr>' +
            '<td>' + date + '</td>' +
            '<td style="font-family:monospace;font-size:11px">' + log.user_id.slice(0, 8) + '...</td>' +
            '<td>' + log.journey_name + '</td>' +
            '<td title="' + escapeHtml(log.mensaje_enviado) + '">' + escapeHtml(msg) + '</td>' +
            '<td><span class="badge badge-' + log.status + '">' + log.status + '</span></td>' +
            '<td><span class="badge badge-' + log.clicked + '">' + (log.clicked ? 'Si' : 'No') + '</span></td>' +
            '<td><span class="badge badge-' + log.responded + '">' + (log.responded ? 'Si' : 'No') + '</span></td>' +
            '<td>' + (log.response_text || '-') + '</td>' +
            '</tr>';
        }).join('');

        document.getElementById('last-refresh').textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-AR');
      } catch (e) {
        console.error('Failed to load logs', e);
      }
    }

    async function triggerDetectors() {
      const token = prompt('Admin API Token:');
      if (!token) return;
      try {
        const res = await fetch(API + '/api/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ detector: 'all' })
        });
        const data = await res.json();
        alert(data.status === 'triggered' ? 'Detectors ejecutados' : 'Error: ' + JSON.stringify(data));
        loadStats();
        loadLogs();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Auto-refresh every 60 seconds
    loadStats();
    loadLogs();
    setInterval(() => { loadStats(); loadLogs(); }, 60000);
  </script>
</body>
</html>`;
}
