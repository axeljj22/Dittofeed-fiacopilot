/**
 * A/B Testing admin page — create, manage and view stats for A/B message tests.
 * Lives at /admin/ab in the engine.
 * Tests are stored in engine_config as key-value pairs with prefix "ab_test.".
 */

import { ADMIN_AUTH_SCRIPT, ADMIN_LOGOUT_LINK } from "./authHelper";

export function getAbTestingHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>A/B Testing — FIA Engine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0b10; color: #e4e4ef; min-height: 100vh; }
    .topbar {
      background: #12131a; border-bottom: 1px solid #2a2b3d;
      padding: 14px 24px; display: flex; align-items: center; gap: 16px;
    }
    .topbar h1 { font-size: 15px; font-weight: 600; color: #fff; }
    .topbar .badge { font-size: 11px; background: #1e1f2e; border: 1px solid #2a2b3d; border-radius: 4px; padding: 2px 8px; color: #9394a5; }
    .topbar a { margin-left: auto; font-size: 12px; color: #818cf8; text-decoration: none; }
    .container { max-width: 960px; margin: 0 auto; padding: 28px 24px; }

    .card { background: #12131a; border: 1px solid #2a2b3d; border-radius: 12px; padding: 24px; margin-bottom: 28px; }
    .card h2 { font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 20px; }

    label { display: block; font-size: 12px; color: #9394a5; margin-bottom: 6px; }
    input, select, textarea {
      width: 100%; background: #0a0b10; border: 1px solid #2a2b3d;
      border-radius: 8px; padding: 10px 12px; color: #e4e4ef; font-size: 13px; font-family: inherit;
    }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #6366f1; }
    textarea { min-height: 80px; resize: vertical; }

    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .form-full { grid-column: 1 / -1; }

    .variants-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .variant-card {
      background: #0e0f17; border: 1px solid #2a2b3d; border-radius: 8px; padding: 16px;
    }
    .variant-label { font-size: 12px; font-weight: 700; margin-bottom: 10px; }
    .variant-label.a { color: #818cf8; }
    .variant-label.b { color: #34d399; }

    .btn { background: #6366f1; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #4f46e5; }
    .btn-sm { padding: 6px 14px; font-size: 12px; border-radius: 6px; }
    .btn-danger { background: #7f1d1d; color: #fca5a5; }
    .btn-danger:hover { background: #991b1b; }
    .btn-outline { background: transparent; border: 1px solid #2a2b3d; color: #9394a5; }
    .btn-outline:hover { border-color: #6366f1; color: #818cf8; }

    .form-status { font-size: 12px; margin-top: 12px; padding: 8px 12px; border-radius: 6px; display: none; }
    .form-status.ok { background: #14532d; color: #4ade80; display: block; }
    .form-status.err { background: #7f1d1d; color: #fca5a5; display: block; }
    .form-status.loading { background: #1e3a5f; color: #93c5fd; display: block; }

    .test-item {
      background: #12131a; border: 1px solid #2a2b3d; border-radius: 10px;
      padding: 20px; margin-bottom: 16px;
    }
    .test-header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .test-name { font-size: 15px; font-weight: 600; color: #fff; }
    .chip {
      font-size: 11px; background: #1a1b26; border: 1px solid #2a2b3d;
      border-radius: 4px; padding: 2px 8px; color: #9394a5;
    }
    .chip.active { border-color: #14532d; color: #4ade80; }
    .chip.inactive { border-color: #7f1d1d; color: #f87171; }
    .test-actions { margin-left: auto; display: flex; gap: 8px; }

    .variants-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
    .variant-box {
      background: #0e0f17; border: 1px solid #2a2b3d; border-radius: 8px; padding: 14px;
    }
    .variant-box-title { font-size: 11px; font-weight: 700; margin-bottom: 8px; }
    .variant-box-title.a { color: #818cf8; }
    .variant-box-title.b { color: #34d399; }
    .variant-text { font-size: 12px; color: #9394a5; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }

    /* Stats */
    .stats-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
    .stat-box {
      background: #1a1b26; border-radius: 8px; padding: 14px; text-align: center;
    }
    .stat-box-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #5d5e72; margin-bottom: 10px; }
    .stat-num { font-size: 28px; font-weight: 700; color: #fff; }
    .stat-sub { font-size: 11px; color: #9394a5; margin-top: 4px; }
    .stat-bar { height: 4px; background: #1e1f2e; border-radius: 2px; margin-top: 10px; overflow: hidden; }
    .stat-bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
    .stat-bar-fill.a { background: #818cf8; }
    .stat-bar-fill.b { background: #34d399; }
    .stat-winner { font-size: 11px; color: #fbbf24; margin-top: 8px; text-align: center; font-weight: 600; }

    .empty { color: #4b5563; font-size: 13px; text-align: center; padding: 40px; }
    .nav { margin-top: 40px; padding-top: 16px; border-top: 1px solid #2a2b3d; font-size: 12px; }
    .nav a { color: #818cf8; text-decoration: none; margin-right: 16px; }
    .nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>🧪 A/B Testing</h1>
    <span class="badge">FIA Engine</span>
    <a href="/admin/engagement">← Dashboard</a>
  </div>

  <div class="container">
    <!-- Create test -->
    <div class="card">
      <h2>Crear nuevo A/B Test</h2>
      <div class="form-grid">
        <div>
          <label>Nombre del test</label>
          <input type="text" id="f-name" placeholder="reactivacion_v2">
        </div>
        <div>
          <label>Journey al que aplica</label>
          <select id="f-journey">
            <option value="reactivacion_inactividad">Reactivación inactividad</option>
            <option value="celebracion_capsula">Celebración cápsula</option>
            <option value="bienvenida_diagnostico">Bienvenida diagnóstico</option>
            <option value="recuperacion_lead_frio">Lead frío</option>
            <option value="resumen_semanal_sponsor">Reporte sponsor</option>
            <option value="campana_activa">Campaña activa</option>
          </select>
        </div>
      </div>
      <div class="variants-grid">
        <div class="variant-card">
          <div class="variant-label a">Variante A</div>
          <label>Texto del mensaje</label>
          <textarea id="f-a" placeholder="Hola {{nombre}}, te escribo porque..."></textarea>
        </div>
        <div class="variant-card">
          <div class="variant-label b">Variante B</div>
          <label>Texto del mensaje</label>
          <textarea id="f-b" placeholder="{{nombre}}, soy Sofía — hace unos días..."></textarea>
        </div>
      </div>
      <p style="font-size:12px;color:#5d5e72;margin-bottom:16px">
        Las variables disponibles: <code style="color:#818cf8">{{nombre}}</code>, <code style="color:#818cf8">{{empresa}}</code>, <code style="color:#818cf8">{{deepLink}}</code>.
        El 50% de los usuarios recibirá variante A, el otro 50% variante B (determinista por userId).
      </p>
      <button class="btn" onclick="createTest()">Crear A/B Test</button>
      <div class="form-status" id="form-status"></div>
    </div>

    <!-- Existing tests -->
    <div>
      <h2 style="font-size:14px;font-weight:600;color:#fff;margin-bottom:16px">Tests activos</h2>
      <div id="tests-container"><div class="empty">Cargando...</div></div>
    </div>

    <div class="nav">
      <a href="/admin/engagement">← Dashboard</a>
      <a href="/admin/design">✏️ Visual Designer</a>
      <a href="/admin/schedule">⏰ Programados</a>
      <a href="/admin/config">⚙️ Config</a>
      ${ADMIN_LOGOUT_LINK}
    </div>
  </div>

  ${ADMIN_AUTH_SCRIPT}
  <script>
    let TOKEN = '';
    let tests = [];

    window.onAuthReady = async function() {
      TOKEN = window.TOKEN;
      await loadTests();
    };

    async function loadTests() {
      try {
        const resp = await fetch('/api/ab-tests', { headers: { Authorization: 'Bearer ' + TOKEN } });
        if (!resp.ok) { document.getElementById('tests-container').innerHTML = '<div class="empty">Error ' + resp.status + '</div>'; return; }
        const { data } = await resp.json();
        tests = data || [];
        renderTests();
      } catch { document.getElementById('tests-container').innerHTML = '<div class="empty">Error de conexión</div>'; }
    }

    async function renderTests() {
      const container = document.getElementById('tests-container');
      if (!tests.length) { container.innerHTML = '<div class="empty">No hay tests configurados.</div>'; return; }

      // Load stats for all tests in parallel
      const stats = await Promise.all(tests.map(t => fetchStats(t.name)));

      container.innerHTML = tests.map((t, i) => {
        const s = stats[i];
        const aRate = s.a.impressions > 0 ? Math.round(s.a.responses / s.a.impressions * 100) : 0;
        const bRate = s.b.impressions > 0 ? Math.round(s.b.responses / s.b.impressions * 100) : 0;
        const winner = s.a.impressions > 5 && s.b.impressions > 5
          ? (aRate > bRate ? '🏆 Variante A está ganando' : bRate > aRate ? '🏆 Variante B está ganando' : '🟰 Empate')
          : '📊 Datos insuficientes';

        return \`<div class="test-item">
          <div class="test-header">
            <span class="test-name">\${escHtml(t.name)}</span>
            <span class="chip \${t.active ? 'active' : 'inactive'}">\${t.active ? '● Activo' : '○ Inactivo'}</span>
            <span class="chip">Journey: \${escHtml(t.journey)}</span>
            <div class="test-actions">
              <button class="btn btn-sm btn-outline" onclick="toggleTest('\${escHtml(t.name)}', \${t.active})">\${t.active ? 'Pausar' : 'Activar'}</button>
              <button class="btn btn-sm btn-danger" onclick="deleteTest('\${escHtml(t.name)}')">Eliminar</button>
            </div>
          </div>

          <div class="variants-row">
            <div class="variant-box">
              <div class="variant-box-title a">Variante A</div>
              <div class="variant-text">\${escHtml(t.variantA.slice(0, 200))}\${t.variantA.length > 200 ? '...' : ''}</div>
            </div>
            <div class="variant-box">
              <div class="variant-box-title b">Variante B</div>
              <div class="variant-text">\${escHtml(t.variantB.slice(0, 200))}\${t.variantB.length > 200 ? '...' : ''}</div>
            </div>
          </div>

          <div class="stats-row">
            <div class="stat-box">
              <div class="stat-box-title">Variante A</div>
              <div class="stat-num">\${aRate}%</div>
              <div class="stat-sub">\${s.a.responses} resp / \${s.a.impressions} env</div>
              <div class="stat-bar"><div class="stat-bar-fill a" style="width:\${aRate}%"></div></div>
            </div>
            <div class="stat-box">
              <div class="stat-box-title">Variante B</div>
              <div class="stat-num">\${bRate}%</div>
              <div class="stat-sub">\${s.b.responses} resp / \${s.b.impressions} env</div>
              <div class="stat-bar"><div class="stat-bar-fill b" style="width:\${bRate}%"></div></div>
            </div>
          </div>
          <div class="stat-winner">\${winner}</div>
        </div>\`;
      }).join('');
    }

    async function fetchStats(testName) {
      try {
        const resp = await fetch('/api/ab-stats/' + testName, { headers: { Authorization: 'Bearer ' + TOKEN } });
        if (!resp.ok) return { a: { impressions: 0, responses: 0 }, b: { impressions: 0, responses: 0 } };
        const { data } = await resp.json();
        return data;
      } catch { return { a: { impressions: 0, responses: 0 }, b: { impressions: 0, responses: 0 } }; }
    }

    async function createTest() {
      const name = document.getElementById('f-name').value.trim().replace(/[^a-z0-9_]/gi, '_');
      const journey = document.getElementById('f-journey').value;
      const varA = document.getElementById('f-a').value.trim();
      const varB = document.getElementById('f-b').value.trim();

      if (!name || !varA || !varB) { showStatus('err', 'Completá todos los campos'); return; }

      showStatus('loading', 'Creando...');
      try {
        const resp = await fetch('/api/ab-tests', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, journey, variantA: varA, variantB: varB }),
        });
        if (!resp.ok) { const e = await resp.json().catch(() => ({})); showStatus('err', e.error || resp.status); return; }
        showStatus('ok', '✓ Test creado y activado');
        document.getElementById('f-name').value = '';
        document.getElementById('f-a').value = '';
        document.getElementById('f-b').value = '';
        await loadTests();
      } catch { showStatus('err', 'Error de conexión'); }
    }

    async function toggleTest(name, active) {
      await fetch('/api/ab-tests/' + name, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !active }),
      });
      await loadTests();
    }

    async function deleteTest(name) {
      if (!confirm('¿Eliminar test "' + name + '"? Se eliminarán todas sus variantes.')) return;
      await fetch('/api/ab-tests/' + name, { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN } });
      await loadTests();
    }

    function showStatus(type, msg) {
      const el = document.getElementById('form-status');
      el.textContent = msg; el.className = 'form-status ' + type;
      if (type === 'ok') setTimeout(() => { el.className = 'form-status'; }, 4000);
    }

    function escHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>`;
}
