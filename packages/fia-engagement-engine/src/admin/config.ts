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

    <!-- Sistema Prompt de Sofía -->
    <div class="section">
      <div class="section-title">
        <span>Sistema Prompt — Sofía</span>
        <span class="updated-at" id="ts-sofia">—</span>
      </div>
      <textarea id="config-sofia_system_prompt" placeholder="Sistema prompt..."></textarea>
      <div class="char-count"><span id="count-sofia">0</span>/10000</div>
      <button class="btn" onclick="saveConfig('sofia_system_prompt')">Guardar</button>
      <div class="status" id="status-sofia_system_prompt"></div>
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
      <textarea id="config-low_engagement_close" placeholder="Mensaje de cierre..."></textarea>
      <div class="char-count"><span id="count-close">0</span>/300</div>
      <button class="btn" onclick="saveConfig('low_engagement_close')">Guardar</button>
      <div class="status" id="status-low_engagement_close"></div>
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

    <!-- Seguimiento por Segmento (paid vs free) -->
    <div class="section">
      <div class="section-title">
        <span>Cadencia de Seguimiento por Segmento</span>
        <span class="updated-at" id="ts-segment_followup_config">—</span>
      </div>
      <p style="font-size: 12px; color: #9394a5; margin-bottom: 12px;">
        JSON con umbrales de inactividad y cooldown por segmento.
        <code style="background:#1e1f2e;padding:2px 6px;border-radius:4px">paid</code> = alumnos pagos,
        <code style="background:#1e1f2e;padding:2px 6px;border-radius:4px">free</code> = método libre.
        <br>Campos: <code>inactivityDays</code>, <code>levels</code> (array), <code>campaignCooldownDays</code>.
      </p>
      <textarea id="config-segment_followup_config" style="min-height:160px" placeholder='{
  "paid":  { "inactivityDays": 3, "levels": [3, 7, 14], "campaignCooldownDays": 4 },
  "free":  { "inactivityDays": 5, "levels": [5, 10, 20], "campaignCooldownDays": 7 }
}'></textarea>
      <button class="btn" onclick="saveConfig('segment_followup_config')">Guardar</button>
      <div class="status" id="status-segment_followup_config"></div>
    </div>

    <!-- Mapa Slug → Path (fallback pre-migración) -->
    <div class="section">
      <div class="section-title">
        <span>Mapa Programa Slug → Path (fallback)</span>
        <span class="updated-at" id="ts-program_slug_path_map">—</span>
      </div>
      <p style="font-size: 12px; color: #9394a5; margin-bottom: 12px;">
        Puente provisional entre <code style="background:#1e1f2e;padding:2px 6px;border-radius:4px">program_slug</code> y el
        <code style="background:#1e1f2e;padding:2px 6px;border-radius:4px">path_id</code> de cada programa en
        <code>learning_paths</code>. Solo se usa si la migración de BD aún no agrega
        <code>program_slug</code> e <code>is_paid</code> a esa tabla.
        Clave = UUID del path, valor = <code>&#123; slug, isPaid &#125;</code>.
      </p>
      <textarea id="config-program_slug_path_map" style="min-height:160px" placeholder='{
  "b2c3d4e5-f6a7-8901-bcde-f12345678901": { "slug": "fia-ventas",   "isPaid": true },
  "c3d4e5f6-a7b8-9012-cdef-123456789012": { "slug": "fia-empresas", "isPaid": true },
  "d4e5f6a7-b8c9-0123-defa-234567890123": { "slug": "fia-agentica", "isPaid": true }
}'></textarea>
      <button class="btn" onclick="saveConfig('program_slug_path_map')">Guardar</button>
      <div class="status" id="status-program_slug_path_map"></div>
    </div>

    <div class="nav">
      ${ADMIN_LOGOUT_LINK}
      <a href="/admin/engagement">← Dashboard</a>
      <a href="/admin/design">✏️ Visual Designer</a>
      <a href="/admin/whatsapp">📱 WhatsApp</a>
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
