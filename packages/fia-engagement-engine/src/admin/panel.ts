/**
 * Admin Dashboard — Full platform overview for CEO & Coaches.
 *
 * Accessible at /admin/engagement
 * Consumes /api/dashboard endpoint for comprehensive data.
 * Shows: user funnel, capsule bottlenecks, stuck users, scores,
 *        activity timeline, vault stats, engagement metrics.
 */

export function getAdminPanelHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FIA Copilot — Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e4e4e7; line-height: 1.6; }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }

    /* Header */
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 24px; color: #fff; }
    .subtitle { color: #71717a; font-size: 14px; }
    .refresh-info { font-size: 12px; color: #52525b; }
    .btn { background: #3b82f6; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; font-family: inherit; }
    .btn:hover { background: #2563eb; }
    .btn-secondary { background: #27272a; }
    .btn-secondary:hover { background: #3f3f46; }

    /* Tabs */
    .tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid #27272a; padding-bottom: 0; }
    .tab { padding: 10px 20px; cursor: pointer; color: #71717a; font-size: 14px; font-weight: 500; border-bottom: 2px solid transparent; transition: all 0.2s; }
    .tab:hover { color: #a1a1aa; }
    .tab.active { color: #fff; border-bottom-color: #3b82f6; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Section headers */
    h2 { font-size: 18px; margin: 0 0 16px; color: #fff; }
    h3 { font-size: 15px; margin: 0 0 12px; color: #a1a1aa; }

    /* Stats grid */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #1c1c22; border: 1px solid #27272a; border-radius: 12px; padding: 20px; }
    .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; margin-bottom: 4px; }
    .card-value { font-size: 32px; font-weight: 700; color: #fff; }
    .card-value.green { color: #4ade80; }
    .card-value.blue { color: #60a5fa; }
    .card-value.yellow { color: #facc15; }
    .card-value.red { color: #f87171; }
    .card-value.purple { color: #c084fc; }
    .card-sub { font-size: 12px; color: #52525b; margin-top: 4px; }

    /* Two-column layout */
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }

    /* Panel block */
    .panel { background: #1c1c22; border: 1px solid #27272a; border-radius: 12px; padding: 20px; margin-bottom: 24px; }

    /* Funnel */
    .funnel { display: flex; flex-direction: column; gap: 8px; }
    .funnel-step { display: flex; align-items: center; gap: 12px; }
    .funnel-bar { height: 32px; border-radius: 6px; display: flex; align-items: center; padding: 0 12px; font-size: 13px; font-weight: 600; color: #fff; min-width: 40px; transition: width 0.5s; }
    .funnel-label { font-size: 13px; color: #a1a1aa; white-space: nowrap; min-width: 120px; }
    .funnel-count { font-size: 13px; color: #71717a; min-width: 30px; text-align: right; }

    /* Horizontal bar chart */
    .bar-chart { display: flex; flex-direction: column; gap: 6px; }
    .bar-row { display: flex; align-items: center; gap: 8px; }
    .bar-label { font-size: 12px; color: #a1a1aa; min-width: 100px; text-align: right; }
    .bar-track { flex: 1; height: 22px; background: #27272a; border-radius: 4px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; padding: 0 8px; font-size: 11px; font-weight: 600; color: #fff; min-width: fit-content; transition: width 0.5s; }
    .bar-value { font-size: 12px; color: #71717a; min-width: 30px; }

    /* Donut placeholder */
    .donut-container { display: flex; align-items: center; gap: 24px; }
    .donut-legend { display: flex; flex-direction: column; gap: 6px; }
    .legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; }

    /* Table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; background: #18181b; color: #a1a1aa; font-weight: 600; border-bottom: 1px solid #27272a; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #1c1c22; }
    tr:hover td { background: #1c1c22; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; }
    .badge-danger { background: #7f1d1d; color: #f87171; }
    .badge-warning { background: #78350f; color: #fbbf24; }
    .badge-success { background: #166534; color: #4ade80; }
    .badge-info { background: #1e3a5f; color: #60a5fa; }
    .badge-sent { background: #166534; color: #4ade80; }
    .badge-failed { background: #7f1d1d; color: #f87171; }
    .badge-opted_out { background: #78350f; color: #fbbf24; }

    /* Pill tags */
    .pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; background: #27272a; border-radius: 9999px; padding: 4px 12px; font-size: 12px; color: #a1a1aa; }
    .pill-count { font-weight: 700; color: #fff; }

    /* Controls */
    .controls { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
    input[type="text"] { background: #1c1c22; border: 1px solid #27272a; color: #fff; padding: 8px 12px; border-radius: 8px; width: 300px; font-family: inherit; font-size: 13px; }

    .loading-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(15,17,23,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .loading-spinner { font-size: 18px; color: #3b82f6; }
    .hidden { display: none; }

    /* Empty state */
    .empty { text-align: center; padding: 40px 20px; color: #52525b; }
    .empty-icon { font-size: 48px; margin-bottom: 12px; }

    @media (max-width: 768px) {
      .grid-2 { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      input[type="text"] { width: 100%; }
    }
  </style>
</head>
<body>
  <div id="loading" class="loading-overlay">
    <div class="loading-spinner">Cargando dashboard...</div>
  </div>

  <div class="container">
    <div class="header">
      <div>
        <h1>FIA Copilot Dashboard</h1>
        <p class="subtitle">Vista ejecutiva de la plataforma</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="refresh-info" id="last-refresh"></span>
        <button class="btn" onclick="loadAll()">Actualizar</button>
        <button class="btn btn-secondary" onclick="triggerDetectors()">Ejecutar detectors</button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <div class="tab active" data-tab="overview" onclick="switchTab('overview')">Overview</div>
      <div class="tab" data-tab="users" onclick="switchTab('users')">Usuarios</div>
      <div class="tab" data-tab="capsules" onclick="switchTab('capsules')">Capsulas</div>
      <div class="tab" data-tab="engagement" onclick="switchTab('engagement')">Engagement</div>
      <div class="tab" data-tab="logs" onclick="switchTab('logs')">Logs</div>
    </div>

    <!-- TAB: Overview -->
    <div class="tab-content active" id="tab-overview">
      <div class="stats" id="overview-stats"></div>
      <div class="grid-2">
        <div class="panel">
          <h3>Funnel de usuarios</h3>
          <div class="funnel" id="funnel"></div>
        </div>
        <div class="panel">
          <h3>Distribucion de scores</h3>
          <div id="score-dist"></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="panel">
          <h3>Actividad esta semana</h3>
          <div class="bar-chart" id="activity-chart"></div>
          <div class="empty hidden" id="activity-empty">Sin actividad esta semana</div>
        </div>
        <div class="panel">
          <h3>Usuarios en riesgo (top 10)</h3>
          <div class="table-wrap">
            <table id="risk-table">
              <thead><tr><th>Usuario</th><th>Empresa</th><th>Capsula</th><th>Dias inactivo</th></tr></thead>
              <tbody id="risk-body"></tbody>
            </table>
          </div>
          <div class="empty hidden" id="risk-empty">Sin usuarios en riesgo</div>
        </div>
      </div>
    </div>

    <!-- TAB: Users -->
    <div class="tab-content" id="tab-users">
      <div class="stats" id="user-stats"></div>
      <div class="grid-2">
        <div class="panel">
          <h3>Por plan</h3>
          <div class="pills" id="plan-pills"></div>
        </div>
        <div class="panel">
          <h3>Por industria</h3>
          <div class="pills" id="industry-pills"></div>
        </div>
      </div>
      <div class="panel">
        <h3>Scores promedio</h3>
        <div class="bar-chart" id="score-bars"></div>
      </div>
    </div>

    <!-- TAB: Capsules -->
    <div class="tab-content" id="tab-capsules">
      <div class="stats" id="capsule-stats"></div>
      <div class="panel">
        <h3>Capsulas con mas usuarios trabados</h3>
        <div class="bar-chart" id="bottleneck-chart"></div>
        <div class="empty hidden" id="bottleneck-empty">Sin datos de capsulas aun</div>
      </div>
      <div class="panel">
        <h3>Todos los usuarios en riesgo</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Usuario</th><th>Empresa</th><th>Capsula</th><th>Dias inactivo</th><th>Riesgo</th></tr></thead>
            <tbody id="all-risk-body"></tbody>
          </table>
        </div>
        <div class="empty hidden" id="all-risk-empty">Sin usuarios en riesgo</div>
      </div>
    </div>

    <!-- TAB: Engagement -->
    <div class="tab-content" id="tab-engagement">
      <div class="stats" id="engagement-stats"></div>
      <div class="panel">
        <h3>Vault — Productividad</h3>
        <div class="stats" id="vault-stats"></div>
      </div>
    </div>

    <!-- TAB: Logs -->
    <div class="tab-content" id="tab-logs">
      <div class="controls">
        <input type="text" id="user-filter" placeholder="Filtrar por user_id..." />
        <button class="btn" onclick="loadLogs()">Buscar</button>
        <button class="btn btn-secondary" onclick="document.getElementById('user-filter').value=''; loadLogs()">Limpiar</button>
      </div>
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
  </div>

  <script>
    const API = '';

    let dashData = null;

    // ─── Tab switching ───
    function switchTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector('[data-tab="' + tabId + '"]').classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
      if (tabId === 'logs' && !document.getElementById('logs-body').dataset.loaded) {
        loadLogs();
      }
    }

    // ─── Helpers ───
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function statCard(label, value, color) {
      return '<div class="card"><div class="card-label">' + escapeHtml(label) + '</div><div class="card-value ' + (color||'') + '">' + value + '</div></div>';
    }

    function riskBadge(days) {
      if (days >= 15) return '<span class="badge badge-danger">' + days + 'd</span>';
      if (days >= 10) return '<span class="badge badge-warning">' + days + 'd</span>';
      return '<span class="badge badge-info">' + days + 'd</span>';
    }

    // ─── Load dashboard data ───
    async function loadDashboard() {
      try {
        const res = await fetch(API + '/api/dashboard');
        dashData = await res.json();
        renderOverview();
        renderUsers();
        renderCapsules();
        renderEngagement();
      } catch (e) {
        console.error('Failed to load dashboard', e);
      }
    }

    // ─── Render: Overview ───
    function renderOverview() {
      const d = dashData;
      document.getElementById('overview-stats').innerHTML =
        statCard('Usuarios totales', d.users.total, 'blue') +
        statCard('Activos esta semana', d.users.active_this_week, 'green') +
        statCard('Inactivos', d.users.inactive, d.users.inactive > 0 ? 'yellow' : '') +
        statCard('Con WhatsApp', d.users.with_whatsapp, 'purple') +
        statCard('En riesgo', d.risk.total_at_risk, d.risk.total_at_risk > 0 ? 'red' : 'green') +
        statCard('Msgs enviados (7d)', d.engagement.messages_sent_7d, 'blue');

      // Funnel
      var funnel = document.getElementById('funnel');
      var total = Math.max(d.funnel.not_started + d.funnel.in_progress + d.funnel.completed_all_25, 1);
      var steps = [
        { label: 'No empezaron', count: d.funnel.not_started, color: '#f87171' },
        { label: 'En progreso', count: d.funnel.in_progress, color: '#60a5fa' },
        { label: 'Completaron 25', count: d.funnel.completed_all_25, color: '#4ade80' },
      ];
      funnel.innerHTML = steps.map(function(s) {
        var pct = Math.max((s.count / total) * 100, 4);
        return '<div class="funnel-step">' +
          '<span class="funnel-label">' + s.label + '</span>' +
          '<div style="flex:1"><div class="funnel-bar" style="width:' + pct + '%;background:' + s.color + '">' + s.count + '</div></div>' +
          '<span class="funnel-count">' + Math.round((s.count/total)*100) + '%</span>' +
          '</div>';
      }).join('');

      // Score distribution
      var scores = d.scores;
      var scoreDist = document.getElementById('score-dist');
      if (scores.total_assessed === 0) {
        scoreDist.innerHTML = '<div class="empty">Sin diagnosticos aun</div>';
      } else {
        var distTotal = Math.max(scores.distribution.alto + scores.distribution.medio + scores.distribution.bajo, 1);
        scoreDist.innerHTML = '<div class="donut-container">' +
          '<div style="flex:1">' +
            '<div class="bar-chart">' +
              '<div class="bar-row"><span class="bar-label">Alto (70+)</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max((scores.distribution.alto/distTotal)*100,2) + '%;background:#4ade80">' + scores.distribution.alto + '</div></div></div>' +
              '<div class="bar-row"><span class="bar-label">Medio (40-69)</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max((scores.distribution.medio/distTotal)*100,2) + '%;background:#facc15">' + scores.distribution.medio + '</div></div></div>' +
              '<div class="bar-row"><span class="bar-label">Bajo (&lt;40)</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max((scores.distribution.bajo/distTotal)*100,2) + '%;background:#f87171">' + scores.distribution.bajo + '</div></div></div>' +
            '</div>' +
          '</div>' +
          '<div class="donut-legend">' +
            '<div class="legend-item"><span class="legend-dot" style="background:#60a5fa"></span>Promedio overall: <strong>' + scores.averages.overall + '/100</strong></div>' +
            '<div class="legend-item"><span class="legend-dot" style="background:#c084fc"></span>Fit promedio: <strong>' + scores.averages.fit + '</strong></div>' +
            '<div class="legend-item"><span class="legend-dot" style="background:#4ade80"></span>Intent promedio: <strong>' + scores.averages.intent + '</strong></div>' +
            '<div class="legend-item"><span class="legend-dot" style="background:#71717a"></span>Total diagnosticados: <strong>' + scores.total_assessed + '</strong></div>' +
          '</div>' +
        '</div>';
      }

      // Activity chart
      var activity = d.activity;
      var actChart = document.getElementById('activity-chart');
      var actEmpty = document.getElementById('activity-empty');
      var types = Object.entries(activity.by_type).sort(function(a,b) { return b[1] - a[1]; });
      if (types.length === 0) {
        actChart.classList.add('hidden');
        actEmpty.classList.remove('hidden');
      } else {
        actChart.classList.remove('hidden');
        actEmpty.classList.add('hidden');
        var maxEvt = types[0][1];
        actChart.innerHTML = types.slice(0, 8).map(function(t) {
          return '<div class="bar-row"><span class="bar-label">' + escapeHtml(t[0]) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max((t[1]/maxEvt)*100,5) + '%;background:#60a5fa">' + t[1] + '</div></div></div>';
        }).join('');
      }

      // Risk table
      var riskBody = document.getElementById('risk-body');
      var riskEmpty = document.getElementById('risk-empty');
      var stuck = d.risk.stuck_users.slice(0, 10);
      if (stuck.length === 0) {
        riskBody.parentElement.classList.add('hidden');
        riskEmpty.classList.remove('hidden');
      } else {
        riskBody.parentElement.classList.remove('hidden');
        riskEmpty.classList.add('hidden');
        riskBody.innerHTML = stuck.map(function(u) {
          return '<tr><td>' + escapeHtml(u.nombre) + '</td><td>' + escapeHtml(u.empresa) + '</td><td>Cap ' + u.capsule + '</td><td>' + riskBadge(u.daysSinceUpdate) + '</td></tr>';
        }).join('');
      }
    }

    // ─── Render: Users ───
    function renderUsers() {
      var d = dashData;
      document.getElementById('user-stats').innerHTML =
        statCard('Total', d.users.total, 'blue') +
        statCard('Con WhatsApp', d.users.with_whatsapp, 'purple') +
        statCard('Opted-out', d.users.opted_out, d.users.opted_out > 0 ? 'red' : '') +
        statCard('Activos (7d)', d.users.active_this_week, 'green');

      // Plan pills
      document.getElementById('plan-pills').innerHTML = Object.entries(d.users.by_plan)
        .sort(function(a,b) { return b[1] - a[1]; })
        .map(function(p) { return '<span class="pill"><span class="pill-count">' + p[1] + '</span>' + escapeHtml(p[0]) + '</span>'; })
        .join('');

      // Industry pills
      document.getElementById('industry-pills').innerHTML = Object.entries(d.users.by_industry)
        .sort(function(a,b) { return b[1] - a[1]; })
        .map(function(p) { return '<span class="pill"><span class="pill-count">' + p[1] + '</span>' + escapeHtml(p[0]) + '</span>'; })
        .join('');

      // Score bars
      var sc = d.scores;
      document.getElementById('score-bars').innerHTML =
        '<div class="bar-row"><span class="bar-label">Fit Score</span><div class="bar-track"><div class="bar-fill" style="width:' + sc.averages.fit + '%;background:#c084fc">' + sc.averages.fit + '</div></div><span class="bar-value">/100</span></div>' +
        '<div class="bar-row"><span class="bar-label">Intent Score</span><div class="bar-track"><div class="bar-fill" style="width:' + sc.averages.intent + '%;background:#4ade80">' + sc.averages.intent + '</div></div><span class="bar-value">/100</span></div>' +
        '<div class="bar-row"><span class="bar-label">Overall</span><div class="bar-track"><div class="bar-fill" style="width:' + sc.averages.overall + '%;background:#60a5fa">' + sc.averages.overall + '</div></div><span class="bar-value">/100</span></div>';
    }

    // ─── Render: Capsules ───
    function renderCapsules() {
      var d = dashData;
      document.getElementById('capsule-stats').innerHTML =
        statCard('No empezaron', d.funnel.not_started, 'red') +
        statCard('En progreso', d.funnel.in_progress, 'blue') +
        statCard('Graduados', d.funnel.completed_all_25, 'green') +
        statCard('En riesgo', d.risk.total_at_risk, d.risk.total_at_risk > 0 ? 'yellow' : 'green');

      // Bottleneck chart
      var bottleneckChart = document.getElementById('bottleneck-chart');
      var bottleneckEmpty = document.getElementById('bottleneck-empty');
      var bn = d.capsules.bottlenecks;
      if (bn.length === 0) {
        bottleneckChart.classList.add('hidden');
        bottleneckEmpty.classList.remove('hidden');
      } else {
        bottleneckChart.classList.remove('hidden');
        bottleneckEmpty.classList.add('hidden');
        var maxBn = Math.max.apply(null, bn.map(function(b) { return b.stuck_users; }));
        bottleneckChart.innerHTML = bn.map(function(b) {
          return '<div class="bar-row"><span class="bar-label">Capsula ' + b.capsule + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.max((b.stuck_users/maxBn)*100,8) + '%;background:#f87171">' + b.stuck_users + ' trabados</div></div></div>';
        }).join('');
      }

      // All risk users
      var allRiskBody = document.getElementById('all-risk-body');
      var allRiskEmpty = document.getElementById('all-risk-empty');
      var allStuck = d.risk.stuck_users;
      if (allStuck.length === 0) {
        allRiskBody.parentElement.classList.add('hidden');
        allRiskEmpty.classList.remove('hidden');
      } else {
        allRiskBody.parentElement.classList.remove('hidden');
        allRiskEmpty.classList.add('hidden');
        allRiskBody.innerHTML = allStuck.map(function(u) {
          var level = u.daysSinceUpdate >= 15 ? 'danger' : (u.daysSinceUpdate >= 10 ? 'warning' : 'info');
          var levelText = u.daysSinceUpdate >= 15 ? 'Critico' : (u.daysSinceUpdate >= 10 ? 'Alto' : 'Medio');
          return '<tr><td>' + escapeHtml(u.nombre) + '</td><td>' + escapeHtml(u.empresa) + '</td><td>Cap ' + u.capsule + '</td><td>' + u.daysSinceUpdate + ' dias</td><td><span class="badge badge-' + level + '">' + levelText + '</span></td></tr>';
        }).join('');
      }
    }

    // ─── Render: Engagement ───
    function renderEngagement() {
      var d = dashData;
      document.getElementById('engagement-stats').innerHTML =
        statCard('Mensajes enviados (7d)', d.engagement.messages_sent_7d, 'blue') +
        statCard('Tasa de click', d.engagement.click_rate + '%', 'green') +
        statCard('Tasa de respuesta', d.engagement.response_rate + '%', 'yellow') +
        statCard('Opted-out', d.users.opted_out, d.users.opted_out > 0 ? 'red' : '');

      document.getElementById('vault-stats').innerHTML =
        statCard('Outputs en Boveda', d.vault.total_outputs, 'purple') +
        statCard('Usuarios con outputs', d.vault.users_with_outputs, 'blue') +
        statCard('Eventos esta semana', d.activity.events_this_week, 'green');
    }

    // ─── Logs tab ───
    async function loadLogs() {
      var userId = document.getElementById('user-filter').value.trim();
      var params = new URLSearchParams({ limit: '50' });
      if (userId) params.set('user_id', userId);

      try {
        var res = await fetch(API + '/api/engagement/logs?' + params);
        var data = await res.json();
        var tbody = document.getElementById('logs-body');
        tbody.dataset.loaded = '1';

        if (!data.logs || data.logs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#71717a">Sin registros de engagement aun</td></tr>';
          return;
        }

        tbody.innerHTML = data.logs.map(function(log) {
          var date = new Date(log.created_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
          var msg = log.mensaje_enviado.length > 80 ? log.mensaje_enviado.slice(0, 80) + '...' : log.mensaje_enviado;
          return '<tr>' +
            '<td>' + date + '</td>' +
            '<td style="font-family:monospace;font-size:11px">' + log.user_id.slice(0, 8) + '...</td>' +
            '<td>' + log.journey_name + '</td>' +
            '<td title="' + escapeHtml(log.mensaje_enviado) + '">' + escapeHtml(msg) + '</td>' +
            '<td><span class="badge badge-' + log.status + '">' + log.status + '</span></td>' +
            '<td><span class="badge badge-' + (log.clicked ? 'success' : '') + '">' + (log.clicked ? 'Si' : 'No') + '</span></td>' +
            '<td><span class="badge badge-' + (log.responded ? 'success' : '') + '">' + (log.responded ? 'Si' : 'No') + '</span></td>' +
            '<td>' + (log.response_text || '-') + '</td>' +
            '</tr>';
        }).join('');
      } catch (e) {
        console.error('Failed to load logs', e);
      }
    }

    // ─── Trigger detectors ───
    async function triggerDetectors() {
      var token = prompt('Admin API Token:');
      if (!token) return;
      try {
        var res = await fetch(API + '/api/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ detector: 'all' })
        });
        var data = await res.json();
        alert(data.status === 'triggered' ? 'Detectors ejecutados' : 'Error: ' + JSON.stringify(data));
        loadAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // ─── Load all ───
    async function loadAll() {
      await loadDashboard();
      document.getElementById('last-refresh').textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-AR');
      document.getElementById('loading').classList.add('hidden');
    }

    // Init
    loadAll();
    setInterval(loadAll, 120000);
  </script>
</body>
</html>`;
}
