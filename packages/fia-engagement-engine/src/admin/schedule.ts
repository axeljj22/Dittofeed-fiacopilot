/**
 * Scheduled Messages admin page — list, create, toggle and run-now for programmed broadcasts.
 * Lives at /admin/schedule in the engine.
 */

export function getScheduleAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mensajes Programados — FIA Engine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0b10;
      color: #e4e4ef;
      min-height: 100vh;
    }
    .topbar {
      background: #12131a;
      border-bottom: 1px solid #2a2b3d;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .topbar h1 { font-size: 15px; font-weight: 600; color: #fff; }
    .topbar .badge {
      font-size: 11px; background: #1e1f2e; border: 1px solid #2a2b3d;
      border-radius: 4px; padding: 2px 8px; color: #9394a5;
    }
    .topbar a { margin-left: auto; font-size: 12px; color: #818cf8; text-decoration: none; }
    .container { max-width: 900px; margin: 0 auto; padding: 28px 24px; }

    /* Create form */
    .create-card {
      background: #12131a;
      border: 1px solid #2a2b3d;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 32px;
    }
    .create-card h2 { font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 20px; }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    .form-full { grid-column: 1 / -1; }
    label { display: block; font-size: 12px; color: #9394a5; margin-bottom: 6px; }
    input[type="text"], select, textarea {
      width: 100%;
      background: #0a0b10;
      border: 1px solid #2a2b3d;
      border-radius: 8px;
      padding: 10px 12px;
      color: #e4e4ef;
      font-size: 13px;
      font-family: inherit;
    }
    input[type="text"]:focus, select:focus, textarea:focus {
      outline: none;
      border-color: #6366f1;
    }
    select option { background: #12131a; }

    /* Cron picker */
    .cron-picker {
      background: #0a0b10;
      border: 1px solid #2a2b3d;
      border-radius: 8px;
      padding: 14px;
    }
    .cron-picker-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .cron-picker-row label { margin: 0; min-width: 60px; }
    .cron-time { display: flex; gap: 8px; align-items: center; }
    .cron-time select { width: auto; padding: 6px 10px; }
    .day-pills { display: flex; gap: 6px; flex-wrap: wrap; }
    .day-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      background: #1a1b26;
      border: 1px solid #2a2b3d;
      color: #6b7280;
      user-select: none;
    }
    .day-pill.selected { background: #1e1f4e; border-color: #6366f1; color: #a5b4fc; }
    .cron-output {
      font-family: monospace;
      font-size: 12px;
      color: #6366f1;
      background: #0a0b10;
      border: 1px solid #1e1f2e;
      border-radius: 6px;
      padding: 8px 12px;
      margin-top: 10px;
    }
    .cron-desc { font-size: 11px; color: #9394a5; margin-top: 6px; }

    .btn {
      background: #6366f1; color: #fff; border: none;
      border-radius: 8px; padding: 10px 20px; font-size: 13px;
      font-weight: 600; cursor: pointer;
    }
    .btn:hover { background: #4f46e5; }
    .btn-sm {
      padding: 6px 14px; font-size: 12px; border-radius: 6px;
    }
    .btn-danger { background: #7f1d1d; }
    .btn-danger:hover { background: #991b1b; }
    .btn-outline {
      background: transparent;
      border: 1px solid #2a2b3d;
      color: #9394a5;
    }
    .btn-outline:hover { border-color: #6366f1; color: #818cf8; }
    .btn-green { background: #14532d; color: #4ade80; }
    .btn-green:hover { background: #166534; }

    /* Schedule list */
    .schedule-list h2 { font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 16px; }
    .schedule-empty { color: #4b5563; font-size: 13px; text-align: center; padding: 40px; }
    .schedule-item {
      background: #12131a;
      border: 1px solid #2a2b3d;
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 12px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: start;
    }
    .schedule-item.inactive { opacity: 0.6; }
    .sched-name { font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 6px; }
    .sched-meta { display: flex; flex-wrap: wrap; gap: 8px; }
    .meta-chip {
      font-size: 11px;
      background: #1a1b26;
      border: 1px solid #2a2b3d;
      border-radius: 4px;
      padding: 2px 8px;
      color: #9394a5;
    }
    .meta-chip.active-chip { border-color: #14532d; color: #4ade80; }
    .meta-chip.inactive-chip { border-color: #7f1d1d; color: #f87171; }
    .sched-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .last-run { font-size: 11px; color: #4b5563; margin-top: 8px; }
    .run-status { font-size: 11px; }
    .run-status.ok { color: #4ade80; }
    .run-status.err { color: #f87171; }
    .run-status.loading { color: #93c5fd; }

    /* Form status */
    .form-status { font-size: 12px; margin-top: 12px; padding: 8px 12px; border-radius: 6px; display: none; }
    .form-status.ok { background: #14532d; color: #4ade80; display: block; }
    .form-status.err { background: #7f1d1d; color: #fca5a5; display: block; }
    .form-status.loading { background: #1e3a5f; color: #93c5fd; display: block; }

    .nav {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid #2a2b3d;
      font-size: 12px;
    }
    .nav a { color: #818cf8; text-decoration: none; margin-right: 16px; }
    .nav a:hover { text-decoration: underline; }

    #loading { text-align: center; color: #4b5563; padding: 40px; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>⏰ Mensajes Programados</h1>
    <span class="badge">FIA Engine</span>
    <a href="/admin/engagement">← Dashboard</a>
  </div>

  <div class="container">
    <!-- Create new scheduled message -->
    <div class="create-card">
      <h2>Crear mensaje programado</h2>
      <div class="form-grid">
        <div>
          <label>Nombre</label>
          <input type="text" id="f-name" placeholder="Recordatorio semana 2 FIA Ventas">
        </div>
        <div>
          <label>Journey</label>
          <select id="f-journey">
            <option value="reactivacion_inactividad">Reactivación inactividad</option>
            <option value="celebracion_capsula">Celebración cápsula</option>
            <option value="bienvenida_diagnostico">Bienvenida diagnóstico</option>
            <option value="recuperacion_lead_frio">Lead frío</option>
            <option value="resumen_semanal_sponsor">Reporte sponsor</option>
            <option value="campana_activa">Campaña activa</option>
          </select>
        </div>
        <div>
          <label>Segmento</label>
          <select id="f-segment">
            <option value="todos">Todos los usuarios (opt-in WA)</option>
            <option value="fia-ventas">FIA Ventas (alumnos)</option>
            <option value="fia-copilot-pro">FIA Copilot Pro</option>
            <option value="fia-empresas">FIA Empresas</option>
            <option value="leads">Leads (sin plan activo)</option>
          </select>
        </div>
        <div>
          <label>Template (opcional)</label>
          <input type="text" id="f-key" placeholder="cmd_reply.si (clave de engine_config)">
        </div>
      </div>

      <!-- Visual cron picker -->
      <div>
        <label style="margin-bottom:10px">Horario</label>
        <div class="cron-picker">
          <div class="cron-picker-row">
            <label>Días</label>
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
          <div class="cron-picker-row">
            <label>Hora</label>
            <div class="cron-time">
              <select id="p-hour" onchange="updateCron()">
                ${Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${i === 9 ? "selected" : ""}>${String(i).padStart(2, "0")}</option>`).join("")}
              </select>
              <span style="color:#5d5e72">:</span>
              <select id="p-min" onchange="updateCron()">
                ${[0, 15, 30, 45].map((m) => `<option value="${m}">${String(m).padStart(2, "0")}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="cron-output" id="cron-output">0 9 * * 1</div>
          <div class="cron-desc" id="cron-desc">Lunes a las 09:00</div>
        </div>
      </div>

      <div style="margin-top:16px">
        <button class="btn" onclick="createSchedule()">Crear mensaje programado</button>
      </div>
      <div class="form-status" id="form-status"></div>
    </div>

    <!-- Existing schedules -->
    <div class="schedule-list">
      <h2>Mensajes programados</h2>
      <div id="schedules-container">
        <div id="loading">Cargando...</div>
      </div>
    </div>

    <div class="nav">
      <a href="/admin/engagement">← Dashboard</a>
      <a href="/admin/design">✏️ Visual Designer</a>
      <a href="/admin/config">⚙️ Config Editor</a>
    </div>
  </div>

  <script>
    let TOKEN = '';
    let schedules = [];
    let selectedDays = new Set([1]); // Mon by default

    window.addEventListener('load', async () => {
      TOKEN = prompt('Admin token:') || '';
      if (!TOKEN) { document.getElementById('loading').textContent = 'Token requerido.'; return; }
      updateCron();
      await loadSchedules();
    });

    // ── Cron picker ──
    function toggleDay(day) {
      const pill = document.querySelector(\`[data-day="\${day}"]\`);
      if (selectedDays.has(day)) {
        selectedDays.delete(day);
        pill.classList.remove('selected');
      } else {
        selectedDays.add(day);
        pill.classList.add('selected');
      }
      updateCron();
    }

    // Initialize Monday pill as selected
    document.querySelector('[data-day="1"]')?.classList.add('selected');

    function updateCron() {
      const hour = document.getElementById('p-hour').value;
      const min = document.getElementById('p-min').value;
      const days = Array.from(selectedDays).sort().join(',') || '*';
      const expr = \`\${min} \${hour} * * \${days}\`;
      document.getElementById('cron-output').textContent = expr;
      document.getElementById('cron-desc').textContent = describeCron(hour, min, days);
    }

    const DAY_NAMES = { 0:'Domingo',1:'Lunes',2:'Martes',3:'Miércoles',4:'Jueves',5:'Viernes',6:'Sábado' };
    function describeCron(hour, min, days) {
      const time = \`\${String(hour).padStart(2,'0')}:\${String(min).padStart(2,'0')}\`;
      if (days === '*') return \`Todos los días a las \${time}\`;
      const dayNums = days.split(',').map(Number);
      if (dayNums.length === 7) return \`Todos los días a las \${time}\`;
      const names = dayNums.map(d => DAY_NAMES[d] || d).join(', ');
      return \`\${names} a las \${time}\`;
    }

    // ── Load schedules ──
    async function loadSchedules() {
      try {
        const resp = await fetch('/api/schedule', { headers: { Authorization: 'Bearer ' + TOKEN } });
        if (!resp.ok) { document.getElementById('loading').textContent = 'Error ' + resp.status; return; }
        const { data } = await resp.json();
        schedules = data || [];
        renderSchedules();
      } catch (e) {
        document.getElementById('loading').textContent = 'Error de conexión';
      }
    }

    function renderSchedules() {
      const container = document.getElementById('schedules-container');
      if (!schedules.length) {
        container.innerHTML = '<div class="schedule-empty">No hay mensajes programados. Creá uno arriba.</div>';
        return;
      }
      container.innerHTML = schedules.map(s => \`
        <div class="schedule-item \${s.active ? '' : 'inactive'}" id="sched-\${s.id}">
          <div>
            <div class="sched-name">\${escHtml(s.name)}</div>
            <div class="sched-meta">
              <span class="meta-chip \${s.active ? 'active-chip' : 'inactive-chip'}">\${s.active ? '● Activo' : '○ Inactivo'}</span>
              <span class="meta-chip">📅 \${escHtml(s.schedule_cron)}</span>
              <span class="meta-chip">Journey: \${escHtml(s.journey_name)}</span>
              <span class="meta-chip">Segmento: \${escHtml(s.segment)}</span>
              \${s.message_key ? \`<span class="meta-chip">Template: \${escHtml(s.message_key)}</span>\` : ''}
            </div>
            \${s.last_run_at ? \`<div class="last-run">Última ejecución: \${new Date(s.last_run_at).toLocaleString('es-AR')}</div>\` : '<div class="last-run">Nunca ejecutado</div>'}
            <div class="run-status" id="run-status-\${s.id}"></div>
          </div>
          <div class="sched-actions">
            <button class="btn btn-sm btn-green" onclick="runNow('\${s.id}', '\${escHtml(s.name)}')">▶ Ahora</button>
            <button class="btn btn-sm btn-outline" onclick="toggleActive('\${s.id}', \${s.active})">\${s.active ? 'Pausar' : 'Activar'}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteSchedule('\${s.id}', '\${escHtml(s.name)}')">✕</button>
          </div>
        </div>
      \`).join('');
    }

    // ── Create ──
    async function createSchedule() {
      const name = document.getElementById('f-name').value.trim();
      const journey = document.getElementById('f-journey').value;
      const segment = document.getElementById('f-segment').value;
      const key = document.getElementById('f-key').value.trim();
      const cron_expr = document.getElementById('cron-output').textContent.trim();

      if (!name) { showFormStatus('err', 'El nombre es obligatorio'); return; }

      showFormStatus('loading', 'Creando...');
      try {
        const resp = await fetch('/api/schedule', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, journey_name: journey, segment, schedule_cron: cron_expr, message_key: key || null }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          showFormStatus('err', 'Error: ' + (err.error || resp.status));
          return;
        }
        showFormStatus('ok', '✓ Mensaje programado creado');
        document.getElementById('f-name').value = '';
        document.getElementById('f-key').value = '';
        await loadSchedules();
      } catch { showFormStatus('err', 'Error de conexión'); }
    }

    // ── Toggle active ──
    async function toggleActive(id, currentActive) {
      try {
        const resp = await fetch('/api/schedule/' + id, {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !currentActive }),
        });
        if (resp.ok) await loadSchedules();
        else alert('Error al actualizar: ' + resp.status);
      } catch { alert('Error de conexión'); }
    }

    // ── Delete ──
    async function deleteSchedule(id, name) {
      if (!confirm(\`¿Eliminar "\${name}"?\`)) return;
      try {
        const resp = await fetch('/api/schedule/' + id, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + TOKEN },
        });
        if (resp.ok) await loadSchedules();
        else alert('Error al eliminar: ' + resp.status);
      } catch { alert('Error de conexión'); }
    }

    // ── Run now ──
    async function runNow(id, name) {
      if (!confirm(\`¿Ejecutar ahora "\${name}"? Esto enviará mensajes reales a los usuarios del segmento.\`)) return;
      const statusEl = document.getElementById('run-status-' + id);
      statusEl.textContent = 'Ejecutando...';
      statusEl.className = 'run-status loading';
      try {
        const resp = await fetch('/api/schedule/' + id + '/run', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + TOKEN },
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok) {
          statusEl.textContent = \`✓ Enviado a \${data.sent ?? 0} usuarios\`;
          statusEl.className = 'run-status ok';
          await loadSchedules();
        } else {
          statusEl.textContent = 'Error: ' + (data.error || resp.status);
          statusEl.className = 'run-status err';
        }
      } catch {
        statusEl.textContent = 'Error de conexión';
        statusEl.className = 'run-status err';
      }
    }

    function showFormStatus(type, msg) {
      const el = document.getElementById('form-status');
      el.textContent = msg;
      el.className = 'form-status ' + type;
      if (type === 'ok') setTimeout(() => { el.className = 'form-status'; }, 4000);
    }

    function escHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>`;
}
