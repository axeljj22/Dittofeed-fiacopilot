/**
 * Weekly report cadence editor — sets when Sofía's weekly report runs.
 * Lives at /admin/schedule. Reads/writes the `report_schedule` cron via /api/schedule.
 */

import { ADMIN_AUTH_SCRIPT, ADMIN_LOGOUT_LINK } from "./authHelper";

export function getScheduleAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cadencia del Reporte — FIA Engine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0b10; color: #e4e4ef; min-height: 100vh; }
    .topbar { background: #12131a; border-bottom: 1px solid #2a2b3d; padding: 14px 24px; display: flex; align-items: center; gap: 16px; }
    .topbar h1 { font-size: 15px; font-weight: 600; color: #fff; }
    .topbar .badge { font-size: 11px; background: #1e1f2e; border: 1px solid #2a2b3d; border-radius: 4px; padding: 2px 8px; color: #9394a5; }
    .topbar a { margin-left: auto; font-size: 12px; color: #818cf8; text-decoration: none; }
    .container { max-width: 720px; margin: 0 auto; padding: 28px 24px; }
    .card { background: #12131a; border: 1px solid #2a2b3d; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .card h2 { font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 6px; }
    .card p.sub { font-size: 12px; color: #9394a5; margin-bottom: 20px; }
    label { display: block; font-size: 12px; color: #9394a5; margin-bottom: 8px; }
    .picker-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .picker-row label { margin: 0; min-width: 60px; }
    .day-pills { display: flex; gap: 6px; flex-wrap: wrap; }
    .day-pill { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; background: #1a1b26; border: 1px solid #2a2b3d; color: #6b7280; user-select: none; }
    .day-pill.selected { background: #1e1f4e; border-color: #6366f1; color: #a5b4fc; }
    select { background: #0a0b10; border: 1px solid #2a2b3d; border-radius: 8px; padding: 8px 10px; color: #e4e4ef; font-size: 13px; }
    .cron-output { font-family: monospace; font-size: 12px; color: #6366f1; background: #0a0b10; border: 1px solid #1e1f2e; border-radius: 6px; padding: 8px 12px; margin-top: 10px; }
    .cron-desc { font-size: 12px; color: #9394a5; margin-top: 8px; }
    .btn { background: #6366f1; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 16px; }
    .btn:hover { background: #4f46e5; }
    .status { font-size: 12px; margin-top: 12px; padding: 8px 12px; border-radius: 6px; display: none; }
    .status.ok { background: #14532d; color: #4ade80; display: block; }
    .status.err { background: #7f1d1d; color: #fca5a5; display: block; }
    .status.loading { background: #1e3a5f; color: #93c5fd; display: block; }
    .nav { margin-top: 24px; padding-top: 16px; border-top: 1px solid #2a2b3d; font-size: 12px; }
    .nav a { color: #818cf8; text-decoration: none; margin-right: 16px; }
    .nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>⏰ Cadencia del Reporte Semanal</h1>
    <span class="badge">FIA Engine</span>
    <a href="/admin/engagement">← Dashboard</a>
  </div>

  <div class="container">
    <div class="card">
      <h2>¿Cuándo se envía el reporte de Sofía?</h2>
      <p class="sub">Sofía manda un único reporte semanal a cada usuario activo. Elegí el día y la hora.</p>

      <div class="picker-row">
        <label>Día</label>
        <div class="day-pills">
          <div class="day-pill" data-day="1" onclick="toggleDay(1)">L</div>
          <div class="day-pill" data-day="2" onclick="toggleDay(2)">M</div>
          <div class="day-pill" data-day="3" onclick="toggleDay(3)">X</div>
          <div class="day-pill" data-day="4" onclick="toggleDay(4)">J</div>
          <div class="day-pill" data-day="5" onclick="toggleDay(5)">V</div>
          <div class="day-pill" data-day="6" onclick="toggleDay(6)">S</div>
          <div class="day-pill" data-day="0" onclick="toggleDay(0)">D</div>
        </div>
      </div>
      <div class="picker-row">
        <label>Hora</label>
        <select id="p-hour" onchange="updateCron()">
          ${Array.from({ length: 24 }, (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}</option>`).join("")}
        </select>
        <span style="color:#5d5e72">:</span>
        <select id="p-min" onchange="updateCron()">
          ${[0, 15, 30, 45].map((m) => `<option value="${m}">${String(m).padStart(2, "0")}</option>`).join("")}
        </select>
      </div>
      <div class="cron-output" id="cron-output">0 17 * * 0</div>
      <div class="cron-desc" id="cron-desc">Domingo a las 17:00</div>
      <button class="btn" onclick="saveSchedule()">Guardar cadencia</button>
      <div class="status" id="status"></div>
    </div>

    <div class="nav">
      <a href="/admin/engagement">← Dashboard</a>
      <a href="/admin/observability">📊 Observabilidad</a>
      <a href="/admin/config">⚙️ Config</a>
      ${ADMIN_LOGOUT_LINK}
    </div>
  </div>

  ${ADMIN_AUTH_SCRIPT}
  <script>
    let TOKEN = '';
    let selectedDay = 0; // single day (Sunday default)

    window.onAuthReady = async function() {
      TOKEN = window.TOKEN;
      await loadSchedule();
    };

    const DAY_NAMES = { 0:'Domingo',1:'Lunes',2:'Martes',3:'Miércoles',4:'Jueves',5:'Viernes',6:'Sábado' };

    function toggleDay(day) {
      selectedDay = day;
      document.querySelectorAll('.day-pill').forEach(p => p.classList.remove('selected'));
      document.querySelector('[data-day="' + day + '"]')?.classList.add('selected');
      updateCron();
    }

    function updateCron() {
      const hour = document.getElementById('p-hour').value;
      const min = document.getElementById('p-min').value;
      const expr = min + ' ' + hour + ' * * ' + selectedDay;
      document.getElementById('cron-output').textContent = expr;
      const time = String(hour).padStart(2,'0') + ':' + String(min).padStart(2,'0');
      document.getElementById('cron-desc').textContent = (DAY_NAMES[selectedDay] || selectedDay) + ' a las ' + time;
    }

    function applyCron(expr) {
      // expr: "min hour * * dow"
      const parts = String(expr).trim().split(/\\s+/);
      if (parts.length === 5) {
        const min = parts[0], hour = parts[1], dow = parts[4];
        const day = (dow === '*' ? 0 : parseInt(dow.split(',')[0], 10)) || 0;
        document.getElementById('p-hour').value = String(parseInt(hour, 10) || 0);
        const minVal = [0,15,30,45].includes(parseInt(min,10)) ? parseInt(min,10) : 0;
        document.getElementById('p-min').value = String(minVal);
        toggleDay(day);
      } else {
        toggleDay(0);
      }
    }

    async function loadSchedule() {
      try {
        const resp = await fetch('/api/schedule', { headers: { Authorization: 'Bearer ' + TOKEN } });
        if (!resp.ok) { applyCron('0 17 * * 0'); return; }
        const { data } = await resp.json();
        applyCron(data?.schedule || '0 17 * * 0');
      } catch { applyCron('0 17 * * 0'); }
    }

    async function saveSchedule() {
      const expr = document.getElementById('cron-output').textContent.trim();
      const el = document.getElementById('status');
      el.textContent = 'Guardando...'; el.className = 'status loading';
      try {
        const resp = await fetch('/api/schedule', {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedule: expr }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok) { el.textContent = '✓ Cadencia guardada (' + (data.schedule || expr) + ')'; el.className = 'status ok'; }
        else { el.textContent = 'Error: ' + (data.error || resp.status); el.className = 'status err'; }
      } catch { el.textContent = 'Error de conexión'; el.className = 'status err'; }
    }
  </script>
</body>
</html>`;
}
