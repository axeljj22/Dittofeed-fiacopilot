/**
 * Visual Designer SPA — interactive template editor at /admin/design
 * Three-panel layout: sidebar (item list) | editor (textarea + metadata) | preview (WA bubble)
 * All data loaded from and saved to /api/config via Bearer token auth.
 */

import { ADMIN_AUTH_SCRIPT, ADMIN_LOGOUT_LINK } from "./authHelper";

// Known config items with metadata for the designer UI
const DESIGN_ITEMS = [
  // ── Prompts IA ──
  {
    category: "Prompts IA",
    key: "sofia_personality",
    label: "Sofía — Personalidad y tono",
    description: "Quién es Sofía, cómo escribe, emojis, reglas de outbound y opt-out conversacional.",
    charLimit: 8000,
    type: "prompt" as const,
  },
  {
    category: "Prompts IA",
    key: "sofia_programs_catalog",
    label: "Sofía — Catálogo de programas",
    description: "Lista breve de programas que Sofía puede enumerar. El detalle lo lee de la base de datos.",
    charLimit: 6000,
    type: "prompt" as const,
  },
  {
    category: "Prompts IA",
    key: "sofia_grounding_rules",
    label: "Sofía — Reglas anti-alucinación",
    description: "Cómo responder cuando la info no está en el contexto provisto.",
    charLimit: 3000,
    type: "prompt" as const,
  },
  {
    category: "Prompts IA",
    key: "journey_prompt.reporte_semanal",
    label: "Journey: Reporte Semanal",
    description: "Instrucción para el reporte semanal (recap + próxima acción según track o Método de 25 pasos).",
    charLimit: 2000,
    type: "prompt" as const,
  },
  {
    category: "Prompts IA",
    key: "activation_welcome_message",
    label: "Mensaje de activación",
    description: "Se envía cuando el usuario activa Sofía desde el front. Variable: {{nombre}}.",
    charLimit: 600,
    type: "reply" as const,
  },
  // ── Respuestas a Comandos ──
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.stop",
    label: "STOP — Opt-out",
    description: "Respuesta cuando el usuario envía STOP o PARAR para darse de baja.",
    charLimit: 300,
    type: "reply" as const,
  },
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.si",
    label: "SI — Reactivación",
    description: "Respuesta cuando el usuario confirma que quiere retomar. Incluir link a dashboard.",
    charLimit: 300,
    type: "reply" as const,
  },
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.ayuda",
    label: "AYUDA — Soporte",
    description: "Respuesta cuando el usuario pide ayuda. Incluir link para agendar con el equipo.",
    charLimit: 300,
    type: "reply" as const,
  },
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.ventas",
    label: "VENTAS — Info FIA Ventas",
    description: "Respuesta cuando el usuario pide info sobre FIA Ventas / upgrade.",
    charLimit: 300,
    type: "reply" as const,
  },
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.diagnostico",
    label: "DIAGNOSTICO — Resultados",
    description: "Respuesta con link a resultados del diagnóstico.",
    charLimit: 300,
    type: "reply" as const,
  },
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.perfil",
    label: "PERFIL — Editar perfil",
    description: "Respuesta con link a la página de edición de perfil.",
    charLimit: 300,
    type: "reply" as const,
  },
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.puntos",
    label: "PUNTOS — Score FIA",
    description: "Respuesta base para el comando PUNTOS (se enriquece con el score real del usuario).",
    charLimit: 300,
    type: "reply" as const,
  },
  {
    category: "Comandos WhatsApp",
    key: "cmd_reply.low_engagement_close",
    label: "Cierre de loop",
    description: "Mensaje de cierre cuando el usuario envía 4+ mensajes de baja calidad seguidos.",
    charLimit: 300,
    type: "reply" as const,
  },
  // ── Config de mensajes ──
  {
    category: "Config de Mensajes",
    key: "opt_out_footer",
    label: "Pie opt-out (footer)",
    description: "Texto que se agrega al final de cada mensaje outbound de primer contacto. Se renderiza en los templates de fallback.",
    charLimit: 200,
    type: "reply" as const,
  },
  {
    category: "Config de Mensajes",
    key: "positive_short_responses",
    label: "Respuestas positivas cortas",
    description: "JSON array de palabras/frases que NO se consideran low-engagement aunque sean cortas. Ej: [\"si\",\"dale\",\"ok\"]",
    charLimit: 5000,
    type: "json" as const,
  },
];

export function getVisualDesignerHtml(): string {
  const categorized = DESIGN_ITEMS.reduce(
    (acc, item) => {
      if (!acc[item.category]) acc[item.category] = [];
      acc[item.category]!.push(item);
      return acc;
    },
    {} as Record<string, typeof DESIGN_ITEMS>,
  );

  const sidebarHtml = Object.entries(categorized)
    .map(
      ([cat, items]) => `
    <div class="cat-group">
      <div class="cat-label">${cat}</div>
      ${items.map((item) => `<div class="sidebar-item" data-key="${item.key}" onclick="selectItem('${item.key}')">${item.label}</div>`).join("")}
    </div>`,
    )
    .join("");

  const itemsJson = JSON.stringify(DESIGN_ITEMS);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>Visual Designer — FIA Engine</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0b10;
      color: #e4e4ef;
      display: grid;
      grid-template-columns: 240px 1fr 320px;
      grid-template-rows: 48px 1fr;
      height: 100vh;
    }

    /* ── Top bar ── */
    .topbar {
      grid-column: 1 / -1;
      background: #12131a;
      border-bottom: 1px solid #2a2b3d;
      display: flex;
      align-items: center;
      padding: 0 20px;
      gap: 16px;
    }
    .topbar h1 { font-size: 15px; color: #fff; font-weight: 600; }
    .topbar .badge {
      font-size: 11px;
      background: #1e1f2e;
      border: 1px solid #2a2b3d;
      border-radius: 4px;
      padding: 2px 8px;
      color: #9394a5;
    }
    .topbar .save-btn {
      margin-left: auto;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 7px 18px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .topbar .save-btn:hover { background: #4f46e5; }
    .topbar .save-btn:disabled { background: #374151; cursor: not-allowed; }
    .topbar .status-text {
      font-size: 12px;
      color: #9394a5;
      min-width: 120px;
      text-align: right;
    }
    .topbar .status-text.ok { color: #4ade80; }
    .topbar .status-text.err { color: #f87171; }
    .topbar .status-text.loading { color: #93c5fd; }

    /* ── Sidebar ── */
    .sidebar {
      background: #0e0f17;
      border-right: 1px solid #1e1f2e;
      overflow-y: auto;
      padding: 12px 0;
    }
    .cat-group { margin-bottom: 4px; }
    .cat-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #5d5e72;
      padding: 8px 16px 4px;
    }
    .sidebar-item {
      font-size: 13px;
      padding: 8px 16px;
      cursor: pointer;
      color: #9394a5;
      border-left: 2px solid transparent;
      transition: all 0.1s;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sidebar-item:hover { background: #1a1b26; color: #e4e4ef; }
    .sidebar-item.active {
      background: #1a1b26;
      color: #818cf8;
      border-left-color: #6366f1;
    }
    .sidebar-item.modified { color: #fbbf24; }
    .sidebar-item.modified.active { color: #fbbf24; }

    /* ── Editor pane ── */
    .editor-pane {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #0a0b10;
    }
    .editor-header {
      padding: 16px 20px 12px;
      border-bottom: 1px solid #1e1f2e;
      flex-shrink: 0;
    }
    .editor-title { font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 4px; }
    .editor-desc { font-size: 12px; color: #6b7280; line-height: 1.5; }
    .editor-meta {
      display: flex;
      gap: 12px;
      margin-top: 8px;
      align-items: center;
    }
    .meta-chip {
      font-size: 11px;
      background: #1a1b26;
      border: 1px solid #2a2b3d;
      border-radius: 4px;
      padding: 2px 8px;
      color: #9394a5;
    }
    .meta-chip.warn { border-color: #854d0e; color: #fbbf24; }
    .meta-chip.danger { border-color: #7f1d1d; color: #f87171; }

    .editor-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 16px 20px;
      overflow: hidden;
    }
    textarea#editor-area {
      flex: 1;
      background: #0e0f17;
      border: 1px solid #2a2b3d;
      border-radius: 8px;
      padding: 14px;
      color: #e4e4ef;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 13px;
      line-height: 1.6;
      resize: none;
      outline: none;
      transition: border-color 0.2s;
    }
    textarea#editor-area:focus { border-color: #6366f1; }
    .char-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      flex-shrink: 0;
    }
    .char-track {
      flex: 1;
      height: 4px;
      background: #1e1f2e;
      border-radius: 2px;
      overflow: hidden;
    }
    .char-fill {
      height: 100%;
      background: #4ade80;
      border-radius: 2px;
      transition: width 0.1s, background 0.2s;
    }
    .char-fill.warn { background: #fbbf24; }
    .char-fill.danger { background: #f87171; }
    .char-count { font-size: 11px; color: #9394a5; min-width: 80px; text-align: right; }

    /* ── Preview pane ── */
    .preview-pane {
      background: #0e0f17;
      border-left: 1px solid #1e1f2e;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .preview-header {
      padding: 14px 16px 10px;
      border-bottom: 1px solid #1e1f2e;
      font-size: 12px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    .wa-bg {
      flex: 1;
      background: #0e1912;
      background-image: radial-gradient(circle at 1px 1px, #1a2d1a 1px, transparent 0);
      background-size: 20px 20px;
      padding: 16px;
      overflow-y: auto;
    }
    .wa-bubble {
      background: #1e2e1e;
      border: 1px solid #2a4a2a;
      border-radius: 12px 12px 4px 12px;
      padding: 10px 14px;
      font-size: 13px;
      line-height: 1.55;
      color: #d1fae5;
      max-width: 260px;
      word-wrap: break-word;
      white-space: pre-wrap;
      margin-left: auto;
      position: relative;
    }
    .wa-bubble .wa-time {
      font-size: 10px;
      color: #4d7a4d;
      text-align: right;
      margin-top: 4px;
    }
    .wa-bubble mark {
      background: rgba(99,102,241,0.25);
      color: #a5b4fc;
      border-radius: 2px;
      padding: 0 2px;
      font-style: normal;
    }
    .preview-empty {
      padding: 40px 16px;
      text-align: center;
      color: #4b5563;
      font-size: 12px;
      line-height: 1.6;
    }
    .preview-note {
      padding: 12px 16px;
      font-size: 11px;
      color: #5d5e72;
      border-top: 1px solid #1e1f2e;
      line-height: 1.5;
    }
    .preview-vars {
      padding: 10px 16px;
      border-top: 1px solid #1e1f2e;
      flex-shrink: 0;
    }
    .preview-vars-title { font-size: 11px; color: #5d5e72; margin-bottom: 8px; }
    .var-pill {
      display: inline-block;
      font-size: 11px;
      background: #1a1b26;
      border: 1px solid #2a2b3d;
      border-radius: 4px;
      padding: 2px 7px;
      color: #818cf8;
      margin: 2px 3px 2px 0;
      cursor: pointer;
      font-family: monospace;
    }
    .var-pill:hover { background: #252637; }

    /* ── Empty state ── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #4b5563;
      gap: 12px;
    }
    .empty-icon { font-size: 40px; }

    /* ── Loading overlay ── */
    #loading-overlay {
      position: fixed; inset: 0;
      background: rgba(10,11,16,0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      font-size: 14px;
      color: #9394a5;
    }
    #loading-overlay.hidden { display: none; }

    /* ── Responsive ── */
    @media (max-width: 900px) {
      html, body { height: auto; overflow: auto; }
      body {
        grid-template-columns: 1fr;
        grid-template-rows: 48px auto 1fr;
        height: auto;
        min-height: 100vh;
      }
      .sidebar { max-height: 220px; overflow-y: auto; border-right: none; border-bottom: 1px solid #1e1f2e; }
      .preview-pane { display: none; }
      .editor-pane { min-height: 60vh; }
      .topbar .status-text { display: none; }
    }
  </style>
</head>
<body>

  <!-- Top bar -->
  <div class="topbar">
    <h1>✏️ Visual Designer</h1>
    <span class="badge">FIA Engine</span>
    <button class="save-btn" id="save-btn" onclick="saveCurrentItem()" disabled>Guardar</button>
    <span class="status-text" id="save-status"></span>
  </div>

  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    ${sidebarHtml}
  </aside>

  <!-- Editor -->
  <main class="editor-pane" id="editor-pane">
    <div class="empty-state" id="empty-state">
      <span class="empty-icon">📝</span>
      <span>Seleccioná un elemento del panel izquierdo para editarlo</span>
    </div>
    <div id="editor-content" style="display:none; flex:1; display:none; flex-direction:column; overflow:hidden;">
      <div class="editor-header">
        <div class="editor-title" id="editor-title"></div>
        <div class="editor-desc" id="editor-desc"></div>
        <div class="editor-meta">
          <span class="meta-chip" id="meta-key"></span>
          <span class="meta-chip" id="meta-type"></span>
          <span class="meta-chip" id="meta-updated"></span>
          <span class="meta-chip" id="meta-chars"></span>
        </div>
      </div>
      <div class="editor-body">
        <textarea id="editor-area" spellcheck="false" oninput="onEditorInput()"></textarea>
        <div class="char-bar">
          <div class="char-track">
            <div class="char-fill" id="char-fill"></div>
          </div>
          <span class="char-count" id="char-count">0 / 0</span>
        </div>
      </div>
    </div>
  </main>

  <!-- Preview -->
  <aside class="preview-pane">
    <div class="preview-header">Preview WhatsApp</div>
    <div class="wa-bg" id="wa-bg">
      <div class="preview-empty">Seleccioná un template para ver la preview</div>
    </div>
    <div class="preview-vars" id="preview-vars" style="display:none">
      <div class="preview-vars-title">Variables disponibles <span style="color:#3d3e52">(click para insertar)</span></div>
      <div id="vars-list">
        <!-- Populated from GET /api/variables -->
        <span class="var-pill" onclick="insertVar('{{nombre}}')">{{nombre}}</span>
        <span class="var-pill" onclick="insertVar('{{empresa}}')">{{empresa}}</span>
        <span class="var-pill" onclick="insertVar('{{deepLink}}')">{{deepLink}}</span>
        <span class="var-pill" onclick="insertVar('{{capsulaPendiente}}')">{{capsulaPendiente}}</span>
        <span class="var-pill" onclick="insertVar('{{capsulaTitle}}')">{{capsulaTitle}}</span>
        <span class="var-pill" onclick="insertVar('{{overallScore}}')">{{overallScore}}</span>
        <span class="var-pill" onclick="insertVar('{{daysInactive}}')">{{daysInactive}}</span>
      </div>
    </div>
    <div class="preview-note" id="preview-note"></div>
  </aside>

  <div id="loading-overlay">
    <span>Cargando configuración...</span>
    <div style="margin-top:12px;font-size:11px">${ADMIN_LOGOUT_LINK}</div>
  </div>

  ${ADMIN_AUTH_SCRIPT}
  <script>
    const ITEMS = ${itemsJson};
    let TOKEN = '';
    let configData = {};
    let currentKey = null;
    let originalValue = '';
    let isDirty = false;

    let allVariables = [];

    // ── Init ──
    window.onAuthReady = async function() {
      TOKEN = window.TOKEN;
      await Promise.all([loadAllConfig(), loadVariables()]);
      document.getElementById('loading-overlay').classList.add('hidden');
    };

    async function loadVariables() {
      try {
        const resp = await fetch('/api/variables', {
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        if (!resp.ok) return;
        const { data } = await resp.json();
        allVariables = data || [];
        renderVarPills();
      } catch (e) {
        console.warn('Could not load variables from API, using defaults', e);
      }
    }

    function renderVarPills() {
      const container = document.getElementById('vars-list');
      if (!allVariables.length || !container) return;

      const catColors = { perfil: '#818cf8', capsula: '#34d399', score: '#fbbf24', contexto: '#f472b6' };
      container.innerHTML = allVariables.map(v => {
        const color = catColors[v.category] || '#818cf8';
        return \`<span class="var-pill" onclick="insertVar('\${v.key}')"
          title="\${v.description}\\nEjemplo: \${v.example}\\nFuente: \${v.source}"
          style="border-color:\${color}33;color:\${color}">\${v.key}</span>\`;
      }).join('');
    }

    async function loadAllConfig() {
      try {
        const resp = await fetch('/api/config', {
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        if (!resp.ok) {
          alert('Error ' + resp.status + ' — token inválido');
          return;
        }
        const { data } = await resp.json();
        configData = data || {};
      } catch (e) {
        console.error('Failed to load config:', e);
        configData = {};
      }
    }

    // ── Item selection ──
    function selectItem(key) {
      if (isDirty && !confirm('Hay cambios sin guardar. ¿Continuar sin guardar?')) return;

      // Deselect previous
      document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
      const sidebarEl = document.querySelector(\`[data-key="\${key}"]\`);
      if (sidebarEl) sidebarEl.classList.add('active');

      const item = ITEMS.find(i => i.key === key);
      if (!item) return;

      currentKey = key;
      originalValue = configData[key] || '';
      isDirty = false;

      // Show editor
      document.getElementById('empty-state').style.display = 'none';
      const editorContent = document.getElementById('editor-content');
      editorContent.style.display = 'flex';
      editorContent.style.flexDirection = 'column';
      editorContent.style.overflow = 'hidden';
      editorContent.style.flex = '1';

      // Populate editor
      document.getElementById('editor-title').textContent = item.label;
      document.getElementById('editor-desc').textContent = item.description;
      document.getElementById('meta-key').textContent = key;
      document.getElementById('meta-type').textContent = item.type;

      const textarea = document.getElementById('editor-area');
      textarea.value = originalValue;
      textarea.placeholder = originalValue ? '' : '(usando valor por defecto del código — guardá para persistir)';

      // Save button
      document.getElementById('save-btn').disabled = false;
      document.getElementById('save-status').textContent = '';
      document.getElementById('save-status').className = 'status-text';

      // Show vars panel for prompts/replies
      const varsPanel = document.getElementById('preview-vars');
      varsPanel.style.display = item.type !== 'json' ? 'block' : 'none';

      updateCharBar(item);
      updatePreview(item, textarea.value);
      updateUpdatedAt(key);
    }

    function updateUpdatedAt(key) {
      const el = document.getElementById('meta-updated');
      // We don't store timestamps in the GET /api/config response, so show generic info
      el.textContent = configData[key] ? 'guardado en DB' : 'usando default del código';
    }

    // ── Editor input ──
    function onEditorInput() {
      const item = ITEMS.find(i => i.key === currentKey);
      if (!item) return;
      const value = document.getElementById('editor-area').value;
      isDirty = value !== originalValue;
      updateCharBar(item);
      updatePreview(item, value);

      // Mark sidebar item
      const sidebarEl = document.querySelector(\`[data-key="\${currentKey}"]\`);
      if (sidebarEl) {
        if (isDirty) sidebarEl.classList.add('modified');
        else sidebarEl.classList.remove('modified');
      }
    }

    function updateCharBar(item) {
      const value = document.getElementById('editor-area').value;
      const len = value.length;
      const limit = item.charLimit;
      const pct = Math.min(100, (len / limit) * 100);

      const fill = document.getElementById('char-fill');
      fill.style.width = pct + '%';
      fill.className = 'char-fill' + (pct >= 100 ? ' danger' : pct >= 80 ? ' warn' : '');

      document.getElementById('char-count').textContent = \`\${len.toLocaleString()} / \${limit.toLocaleString()}\`;

      const charsChip = document.getElementById('meta-chars');
      charsChip.textContent = pct >= 100 ? '⚠ Excede el límite' : pct >= 80 ? '⚠ Cerca del límite' : len + ' caracteres';
      charsChip.className = 'meta-chip' + (pct >= 100 ? ' danger' : pct >= 80 ? ' warn' : '');
    }

    // ── Preview rendering ──
    function updatePreview(item, value) {
      const bg = document.getElementById('wa-bg');
      const note = document.getElementById('preview-note');

      if (item.type === 'prompt') {
        bg.innerHTML = \`<div class="preview-empty" style="padding:20px;text-align:left;color:#4d7a4d;font-size:12px;line-height:1.6">
          <strong style="display:block;margin-bottom:8px;color:#6b9b6b">Prompt de instrucciones al modelo</strong>
          Este texto se envía como system prompt a la IA. No es un mensaje visible para el usuario — define el comportamiento y personalidad de Sofía.
          <br><br>Longitud actual: <strong style="color:#e4e4ef">\${value.length.toLocaleString()} chars</strong>
        </div>\`;
        note.textContent = 'Los prompts se actualizan en la próxima generación de mensaje (cache TTL: 5min).';
        return;
      }

      if (item.type === 'json') {
        let isValid = true;
        try { JSON.parse(value || '[]'); } catch { isValid = false; }
        bg.innerHTML = \`<div class="preview-empty" style="padding:20px;text-align:left">
          <strong style="display:block;margin-bottom:8px;color:\${isValid ? '#4ade80' : '#f87171'}">\${isValid ? '✓ JSON válido' : '✗ JSON inválido'}</strong>
          <span style="font-family:monospace;font-size:12px;color:#9394a5;word-break:break-all">\${escHtml(value.slice(0, 400))}\${value.length > 400 ? '...' : ''}</span>
        </div>\`;
        note.textContent = 'Asegurate de que sea un array JSON válido antes de guardar.';
        return;
      }

      // reply / template type — render as WhatsApp bubble
      if (!value.trim()) {
        bg.innerHTML = '<div class="preview-empty">Sin contenido — se usará el valor por defecto del código.</div>';
        note.textContent = '';
        return;
      }

      const highlighted = highlightVarsAndLinks(escHtml(value));
      const timeStr = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

      // Build an example-value preview by substituting variables
      let exampleText = value;
      for (const v of allVariables) {
        exampleText = exampleText.split(v.key).join(v.example);
      }
      const exampleHighlighted = highlightVarsAndLinks(escHtml(exampleText));

      bg.innerHTML = \`
        <div style="font-size:10px;color:#4d7a4d;margin-bottom:6px;padding:0 2px">Vista real (variables reemplazadas con ejemplos)</div>
        <div class="wa-bubble" style="margin-bottom:16px">\${exampleHighlighted}<div class="wa-time">\${timeStr} ✓✓</div></div>
        <div style="font-size:10px;color:#374151;margin-bottom:6px;padding:0 2px">Vista de código (variables resaltadas)</div>
        <div class="wa-bubble" style="background:#1a1b26;border-color:#2a2b3d;color:#e4e4ef">\${highlighted}<div class="wa-time" style="color:#5d5e72">\${timeStr} ✓✓</div></div>
      \`;
      note.textContent = item.type === 'reply'
        ? 'Las variables {{...}} se reemplazan con datos reales del usuario en runtime.'
        : 'Vista previa como burbuja de WhatsApp con valores de ejemplo.';
    }

    function highlightVarsAndLinks(html) {
      // Highlight {{variables}}
      html = html.replace(/\\{\\{([^}]+)\\}\\}/g, '<mark>{{$1}}</mark>');
      // Highlight URLs
      html = html.replace(/(https?:\\/\\/[^\\s<]+)/g, '<mark style="background:rgba(16,185,129,0.2);color:#6ee7b7">$1</mark>');
      return html;
    }

    function escHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Variable insertion ──
    function insertVar(varStr) {
      const ta = document.getElementById('editor-area');
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + varStr + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + varStr.length;
      ta.focus();
      onEditorInput();
    }

    // ── Save ──
    async function saveCurrentItem() {
      if (!currentKey) return;
      const item = ITEMS.find(i => i.key === currentKey);
      const value = document.getElementById('editor-area').value.trim();

      if (!value) {
        setStatus('err', 'El valor no puede estar vacío');
        return;
      }

      if (item && item.type === 'json') {
        try { JSON.parse(value); } catch { setStatus('err', 'JSON inválido — corregí antes de guardar'); return; }
      }

      setStatus('loading', 'Guardando...');
      document.getElementById('save-btn').disabled = true;

      try {
        const resp = await fetch('/api/config/' + currentKey, {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          setStatus('err', 'Error: ' + (err.error || resp.status));
        } else {
          configData[currentKey] = value;
          originalValue = value;
          isDirty = false;
          setStatus('ok', '✓ Guardado');
          const sidebarEl = document.querySelector(\`[data-key="\${currentKey}"]\`);
          if (sidebarEl) sidebarEl.classList.remove('modified');
          updateUpdatedAt(currentKey);
        }
      } catch {
        setStatus('err', 'Error de conexión');
      } finally {
        document.getElementById('save-btn').disabled = false;
      }
    }

    function setStatus(type, msg) {
      const el = document.getElementById('save-status');
      el.textContent = msg;
      el.className = 'status-text ' + type;
      if (type === 'ok') {
        setTimeout(() => { if (el.textContent === msg) { el.textContent = ''; el.className = 'status-text'; } }, 3000);
      }
    }

    // Keyboard shortcut: Cmd/Ctrl + S to save
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (currentKey && !document.getElementById('save-btn').disabled) saveCurrentItem();
      }
    });

    // Warn before leaving with unsaved changes
    window.addEventListener('beforeunload', (e) => {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    });
  </script>
</body>
</html>`;
}
