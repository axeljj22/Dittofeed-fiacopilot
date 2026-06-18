/**
 * Engine Config Editor — admin panel for editing prompts, templates, and responses.
 * Loads and saves configuration from the engine_config table in Supabase.
 */

import {
  SOFIA_SYSTEM_PROMPT_DEFAULT,
  OPT_OUT_FOOTER_DEFAULT,
  JOURNEY_PROMPTS_DEFAULT,
} from "../config/engineConfigCache";
import { ADMIN_AUTH_SCRIPT, ADMIN_LOGOUT_LINK } from "./authHelper";

export function getConfigEditorHtml(_baseUrl: string): string {
  const journeyNames = Object.keys(JOURNEY_PROMPTS_DEFAULT);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Config Editor — FIA Engine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0b10;
      color: #e4e4ef;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
      color: #fff;
    }
    .subtitle {
      font-size: 13px;
      color: #9394a5;
      margin-bottom: 24px;
    }
    .section {
      background: #12131a;
      border: 1px solid #2a2b3d;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .updated-at {
      font-size: 11px;
      color: #9394a5;
      font-weight: normal;
    }
    textarea, input[type="text"] {
      width: 100%;
      background: #0a0b10;
      border: 1px solid #2a2b3d;
      border-radius: 8px;
      padding: 12px;
      color: #e4e4ef;
      font-family: monospace;
      font-size: 13px;
      margin-bottom: 12px;
    }
    textarea {
      min-height: 120px;
      resize: vertical;
    }
    input[type="text"] {
      min-height: 40px;
    }
    .btn {
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover {
      background: #4f46e5;
    }
    .btn:disabled {
      background: #4b5563;
      cursor: not-allowed;
    }
    .status {
      font-size: 12px;
      margin-top: 8px;
      padding: 8px 12px;
      border-radius: 6px;
      display: none;
    }
    .status.ok {
      background: #14532d;
      color: #4ade80;
      display: block;
    }
    .status.err {
      background: #7f1d1d;
      color: #fca5a5;
      display: block;
    }
    .status.loading {
      background: #1e3a5f;
      color: #93c5fd;
      display: block;
    }
    .char-count {
      font-size: 11px;
      color: #9394a5;
      margin-top: 4px;
      text-align: right;
    }
    .nav {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #2a2b3d;
      font-size: 12px;
    }
    .nav a {
      color: #818cf8;
      text-decoration: none;
      margin-right: 20px;
    }
    .nav a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚙️ Configuración del Engine</h1>
    <p class="subtitle">Edita prompts, templates y respuestas sin deploy</p>

    <div class="section" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="font-size:12px;color:#9394a5">¿Campos vacíos? Carga los valores por defecto que faltan y limpia las claves viejas.</div>
      <div>
        <button class="btn" onclick="seedDefaults()">Completar valores por defecto</button>
        <span class="status" id="status-seed" style="display:inline-block;margin-left:8px"></span>
      </div>
    </div>

    <!-- Sistema Prompt de Sofía (modular: personalidad / catálogo / grounding) -->
    <div class="section">
      <div class="section-title"><span>Sofía — Personalidad y tono</span></div>
      <p style="font-size:12px;color:#9394a5;margin-bottom:12px">Quién es, cómo escribe, emojis, reglas de outbound y opt-out.</p>
      <textarea id="config-sofia_personality" placeholder="Personalidad de Sofía..." style="min-height:200px"></textarea>
      <button class="btn" onclick="saveConfig('sofia_personality')">Guardar</button>
      <div class="status" id="status-sofia_personality"></div>
    </div>

    <div class="section">
      <div class="section-title"><span>Sofía — Catálogo de programas</span></div>
      <p style="font-size:12px;color:#9394a5;margin-bottom:12px">Lista breve de programas que Sofía puede enumerar. El detalle de cápsulas/pasos lo lee de la base de datos.</p>
      <textarea id="config-sofia_programs_catalog" placeholder="Catálogo de programas..." style="min-height:180px"></textarea>
      <button class="btn" onclick="saveConfig('sofia_programs_catalog')">Guardar</button>
      <div class="status" id="status-sofia_programs_catalog"></div>
    </div>

    <div class="section">
      <div class="section-title"><span>Sofía — Reglas anti-alucinación</span></div>
      <p style="font-size:12px;color:#9394a5;margin-bottom:12px">Cómo debe responder cuando no tiene la info en el contexto.</p>
      <textarea id="config-sofia_grounding_rules" placeholder="Reglas de grounding..." style="min-height:120px"></textarea>
      <button class="btn" onclick="saveConfig('sofia_grounding_rules')">Guardar</button>
      <div class="status" id="status-sofia_grounding_rules"></div>
    </div>

    <!-- Mensaje de activación -->
    <div class="section">
      <div class="section-title"><span>Mensaje de activación de Sofía</span></div>
      <p style="font-size:12px;color:#9394a5;margin-bottom:12px">Se envía cuando el usuario activa Sofía desde el front. Variable: <code>{{nombre}}</code>.</p>
      <textarea id="config-activation_welcome_message" placeholder="Hola {{nombre}}, soy Sofía..."></textarea>
      <button class="btn" onclick="saveConfig('activation_welcome_message')">Guardar</button>
      <div class="status" id="status-activation_welcome_message"></div>
    </div>

    <!-- Journey Prompts -->
    <div class="section">
      <div class="section-title">Journey Prompts</div>
      ${journeyNames.map(name => `
        <div style="margin-bottom: 20px;">
          <label style="display: block; font-size: 12px; color: #9394a5; margin-bottom: 8px;">${name}</label>
          <textarea id="config-journey_prompt.${name}" placeholder="Journey prompt..."></textarea>
          <button class="btn" onclick="saveConfig('journey_prompt.${name}')">Guardar</button>
          <div class="status" id="status-journey_prompt.${name}"></div>
        </div>
      `).join('')}
    </div>

    <!-- Opt-out Footer -->
    <div class="section">
      <div class="section-title">
        <span>Pie de Opt-out</span>
        <span class="updated-at" id="ts-footer">—</span>
      </div>
      <textarea id="config-opt_out_footer" placeholder="Opt-out footer..."></textarea>
      <div class="char-count"><span id="count-footer">0</span>/500</div>
      <button class="btn" onclick="saveConfig('opt_out_footer')">Guardar</button>
      <div class="status" id="status-opt_out_footer"></div>
    </div>

    <!-- Low Engagement Close -->
    <div class="section">
      <div class="section-title">
        <span>Cierre de Loop</span>
        <span class="updated-at" id="ts-close">—</span>
      </div>
      <textarea id="config-cmd_reply.low_engagement_close" placeholder="Mensaje de cierre..."></textarea>
      <div class="char-count"><span id="count-close">0</span>/300</div>
      <button class="btn" onclick="saveConfig('cmd_reply.low_engagement_close')">Guardar</button>
      <div class="status" id="status-cmd_reply.low_engagement_close"></div>
    </div>

    <!-- Positive Short Responses (JSON) -->
    <div class="section">
      <div class="section-title">
        <span>Respuestas Positivas Cortas</span>
        <span class="updated-at" id="ts-positive">—</span>
      </div>
      <p style="font-size: 12px; color: #9394a5; margin-bottom: 12px;">
        JSON array de palabras/frases que NO se consideran low-engagement
      </p>
      <textarea id="config-positive_short_responses" placeholder='["si", "dale", "ok", ...]'></textarea>
      <button class="btn" onclick="saveConfig('positive_short_responses')">Guardar</button>
      <div class="status" id="status-positive_short_responses"></div>
    </div>

    <div class="nav">
      ${ADMIN_LOGOUT_LINK}
      <a href="/admin/engagement">← Dashboard</a>
      <a href="/admin/observability">📊 Observabilidad</a>
      <a href="/admin/schedule">⏰ Cadencia</a>
      <a href="/admin/design">✏️ Visual Designer</a>
      <a href="/admin/codex">🤖 Codex</a>
    </div>
  </div>

  ${ADMIN_AUTH_SCRIPT}
  <script>
    let TOKEN = '';

    window.onAuthReady = async function() {
      TOKEN = window.TOKEN;
      try {
        const resp = await fetch('/api/config', {
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        if (!resp.ok) {
          alert('Error: ' + resp.status + ' — contraseña inválida o configuración no encontrada');
          window._fiaLogout();
          return;
        }
        const { data } = await resp.json();

        // Populate textareas with fetched values or defaults
        for (const [key, value] of Object.entries(data)) {
          const el = document.getElementById('config-' + key);
          if (el) {
            el.value = value;
            updateCharCount(key);
          }
        }
      } catch (error) {
        console.error('Failed to load config:', error);
      }
    };

    function updateCharCount(key) {
      const el = document.getElementById('config-' + key);
      const countEl = document.getElementById('count-' + key);
      if (el && countEl) {
        countEl.textContent = el.value.length;
      }
    }

    async function seedDefaults() {
      const statusEl = document.getElementById('status-seed');
      showStatus(statusEl, 'loading', 'Completando...');
      try {
        const resp = await fetch('/api/config/seed-defaults', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN },
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          showStatus(statusEl, 'error', 'Error: ' + (data.error || resp.status));
          return;
        }
        showStatus(statusEl, 'ok', '✓ ' + (data.seeded?.length || 0) + ' creadas, ' + (data.deleted?.length || 0) + ' viejas borradas');
        // Reload the page values
        if (typeof window.onAuthReady === 'function') await window.onAuthReady();
      } catch (error) {
        showStatus(statusEl, 'error', 'Error de conexión');
        console.error(error);
      }
    }

    async function saveConfig(key) {
      const el = document.getElementById('config-' + key);
      const statusEl = document.getElementById('status-' + key);
      const value = el.value.trim();

      if (!value) {
        showStatus(statusEl, 'error', 'El valor no puede estar vacío');
        return;
      }

      // Validate JSON if it looks like JSON
      if (value.startsWith('[') || value.startsWith('{')) {
        try {
          JSON.parse(value);
        } catch {
          showStatus(statusEl, 'error', 'JSON inválido');
          return;
        }
      }

      showStatus(statusEl, 'loading', 'Guardando...');

      try {
        const resp = await fetch('/api/config/' + key, {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ value })
        });

        if (!resp.ok) {
          const err = await resp.json();
          showStatus(statusEl, 'error', 'Error: ' + (err.error || resp.status));
          return;
        }

        showStatus(statusEl, 'ok', '✓ Guardado correctamente');

        // Update timestamp
        const tsEl = document.getElementById('ts-' + key.split('.')[0]);
        if (tsEl) {
          tsEl.textContent = 'Justo ahora';
        }
      } catch (error) {
        showStatus(statusEl, 'error', 'Error de conexión');
        console.error(error);
      }
    }

    function showStatus(el, type, msg) {
      el.textContent = msg;
      el.className = 'status ' + (type === 'ok' ? 'ok' : type === 'error' ? 'err' : 'loading');
    }

    // Update char counts on input
    document.addEventListener('input', (e) => {
      if (e.target.id?.startsWith('config-')) {
        updateCharCount(e.target.id.replace('config-', ''));
      }
    });
  </script>
</body>
</html>`;
}
