/**
 * FIA Copilot — Data Dashboard
 * Full platform analytics for CEO & Coaches.
 * Consumes /api/dashboard for ALL database data.
 */

export function getAdminPanelHtml(_baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FIA Copilot — Data Dashboard</title>
<style>
:root{--bg:#0a0b10;--bg2:#12131a;--bg3:#1a1b25;--bg4:#24253a;--border:#2a2b3d;--text:#e4e4ef;--text2:#9394a5;--text3:#5d5e72;--accent:#6366f1;--accent2:#818cf8;--green:#22c55e;--green2:#4ade80;--yellow:#eab308;--yellow2:#facc15;--red:#ef4444;--red2:#f87171;--blue:#3b82f6;--blue2:#60a5fa;--purple:#a855f7;--purple2:#c084fc;--cyan:#06b6d4;--orange:#f97316}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.5;font-size:13px;overflow-x:hidden}

/* Layout */
.layout{display:flex;min-height:100vh}
.sidebar{width:240px;background:var(--bg2);border-right:1px solid var(--border);padding:20px 0;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;z-index:100}
.sidebar-brand{padding:0 20px 20px;border-bottom:1px solid var(--border);margin-bottom:8px}
.sidebar-brand h1{font-size:16px;color:#fff;font-weight:700}
.sidebar-brand p{font-size:11px;color:var(--text3);margin-top:2px}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--text2);cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;border-left:3px solid transparent}
.nav-item:hover{background:var(--bg3);color:var(--text)}
.nav-item.active{background:var(--bg3);color:var(--accent2);border-left-color:var(--accent)}
.nav-icon{width:18px;text-align:center;font-size:15px;opacity:.7}
.nav-section{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);padding:16px 20px 6px;font-weight:700}
.main{margin-left:240px;flex:1;padding:24px 32px;min-height:100vh}

/* Header */
.page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;gap:12px}
.page-title{font-size:22px;font-weight:700;color:#fff}
.page-sub{font-size:12px;color:var(--text3);margin-top:2px}
.header-actions{display:flex;gap:8px;align-items:center}
.btn{font-family:inherit;font-size:12px;font-weight:600;padding:7px 14px;border-radius:7px;border:1px solid var(--border);cursor:pointer;transition:all .15s;background:var(--bg3);color:var(--text)}
.btn:hover{background:var(--bg4);border-color:var(--accent)}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-primary:hover{background:#4f46e5}
.timestamp{font-size:11px;color:var(--text3)}

/* Page sections */
.page{display:none}
.page.active{display:block}

/* KPI Grid */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.kpi{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px}
.kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:2px}
.kpi-value{font-size:28px;font-weight:800;color:#fff;line-height:1.2}
.kpi-value.green{color:var(--green2)}.kpi-value.blue{color:var(--blue2)}.kpi-value.yellow{color:var(--yellow2)}.kpi-value.red{color:var(--red2)}.kpi-value.purple{color:var(--purple2)}.kpi-value.cyan{color:var(--cyan)}.kpi-value.orange{color:var(--orange)}
.kpi-sub{font-size:11px;color:var(--text3);margin-top:2px}

/* Panels */
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px}
.panel{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:16px}
.panel-title{font-size:13px;font-weight:700;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.panel-title .icon{font-size:15px;opacity:.6}

/* Funnel */
.funnel-step{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.funnel-label{font-size:12px;color:var(--text2);min-width:140px;text-align:right}
.funnel-bar-wrap{flex:1;height:26px;background:var(--bg);border-radius:5px;overflow:hidden;position:relative}
.funnel-bar{height:100%;border-radius:5px;display:flex;align-items:center;padding:0 10px;font-size:11px;font-weight:700;color:#fff;transition:width .6s ease;min-width:fit-content}
.funnel-pct{font-size:11px;color:var(--text3);min-width:40px;text-align:right}

/* Horizontal bars */
.hbar{display:flex;flex-direction:column;gap:5px}
.hbar-row{display:flex;align-items:center;gap:8px}
.hbar-label{font-size:11px;color:var(--text2);min-width:90px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hbar-track{flex:1;height:20px;background:var(--bg);border-radius:4px;overflow:hidden}
.hbar-fill{height:100%;border-radius:4px;display:flex;align-items:center;padding:0 8px;font-size:10px;font-weight:700;color:#fff;transition:width .5s;min-width:fit-content}
.hbar-val{font-size:11px;color:var(--text3);min-width:28px}

/* Sparkline (CSS mini chart) */
.spark{display:flex;align-items:flex-end;gap:2px;height:50px;padding:4px 0}
.spark-bar{flex:1;background:var(--accent);border-radius:2px 2px 0 0;min-width:4px;transition:height .3s;position:relative}
.spark-bar:hover{opacity:.8}
.spark-bar:hover::after{content:attr(data-tip);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#000;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;white-space:nowrap;z-index:10}

/* Heatmap (capsule grid) */
.heatmap{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.heat-cell{aspect-ratio:1;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;position:relative;cursor:default;transition:transform .15s}
.heat-cell:hover{transform:scale(1.08);z-index:2}
.heat-cell .cap-num{font-size:16px;font-weight:800}
.heat-cell .cap-sub{font-size:9px;opacity:.8}

/* Table */
.table-wrap{overflow-x:auto;max-height:500px;overflow-y:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:8px 10px;background:var(--bg3);color:var(--text2);font-weight:700;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
td{padding:8px 10px;border-bottom:1px solid var(--bg3)}
tr:hover td{background:var(--bg3)}
.badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:700;white-space:nowrap}
.b-green{background:#052e16;color:var(--green2)}.b-blue{background:#172554;color:var(--blue2)}.b-yellow{background:#422006;color:var(--yellow2)}.b-red{background:#450a0a;color:var(--red2)}.b-purple{background:#2e1065;color:var(--purple2)}.b-gray{background:var(--bg4);color:var(--text3)}.b-cyan{background:#083344;color:var(--cyan)}.b-orange{background:#431407;color:var(--orange)}

/* Suggestion cards */
.suggestion{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:8px;border-left:3px solid var(--accent)}
.suggestion.alta{border-left-color:var(--red)}.suggestion.media{border-left-color:var(--yellow)}.suggestion.baja{border-left-color:var(--blue)}
.suggestion-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.suggestion-type{font-size:10px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:var(--text3)}
.suggestion-msg{font-size:13px;color:var(--text)}
.suggestion-data{margin-top:8px;font-size:11px;color:var(--text2)}

/* Pills */
.pills{display:flex;flex-wrap:wrap;gap:6px}
.pill{background:var(--bg);border:1px solid var(--border);border-radius:9999px;padding:4px 12px;font-size:11px;color:var(--text2);display:inline-flex;align-items:center;gap:6px}
.pill b{color:#fff}

/* Search */
.search-bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.search-bar input{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:7px 12px;border-radius:7px;font-size:12px;font-family:inherit;min-width:250px}
.search-bar input:focus{outline:none;border-color:var(--accent)}
.search-bar select{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:7px 12px;border-radius:7px;font-size:12px;font-family:inherit}

/* Score gauge */
.gauge-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.gauge-label{font-size:12px;color:var(--text2);min-width:80px}
.gauge-track{flex:1;height:10px;background:var(--bg);border-radius:5px;overflow:hidden}
.gauge-fill{height:100%;border-radius:5px;transition:width .5s}
.gauge-val{font-size:13px;font-weight:700;min-width:35px;text-align:right}

/* Legend */
.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}
.legend-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text2)}
.legend-dot{width:8px;height:8px;border-radius:50%}

/* Responsive */
@media(max-width:1024px){
  .sidebar{width:60px}.sidebar-brand h1,.sidebar-brand p,.nav-item span:not(.nav-icon),.nav-section{display:none}.nav-item{justify-content:center;padding:12px}.main{margin-left:60px;padding:16px}
  .grid-2,.grid-3{grid-template-columns:1fr}
}
@media(max-width:640px){.sidebar{display:none}.main{margin-left:0}}

/* Loading */
#loading{position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999}
#loading .spinner{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#loading p{margin-top:12px;color:var(--text2);font-size:13px}
.hidden{display:none!important}
</style>
</head>
<body>

<div id="loading"><div class="spinner"></div><p>Cargando data...</p></div>

<div class="layout">
  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sidebar-brand"><h1>FIA Copilot</h1><p>Data Dashboard</p></div>
    <div class="nav-section">Analytics</div>
    <div class="nav-item active" data-page="overview"><span class="nav-icon">&#9678;</span><span>Overview</span></div>
    <div class="nav-item" data-page="users"><span class="nav-icon">&#9823;</span><span>Usuarios</span></div>
    <div class="nav-item" data-page="capsules"><span class="nav-icon">&#9635;</span><span>Capsulas</span></div>
    <div class="nav-item" data-page="scores"><span class="nav-icon">&#9733;</span><span>Scoring</span></div>
    <div class="nav-item" data-page="vault"><span class="nav-icon">&#9830;</span><span>Boveda</span></div>
    <div class="nav-section">Comunicaciones</div>
    <div class="nav-item" data-page="engagement"><span class="nav-icon">&#9993;</span><span>Engagement</span></div>
    <div class="nav-item" data-page="logs"><span class="nav-icon">&#9776;</span><span>Logs</span></div>
    <div class="nav-section">Inteligencia</div>
    <div class="nav-item" data-page="suggestions"><span class="nav-icon">&#9889;</span><span>Sugerencias IA</span></div>
  </nav>

  <!-- Main -->
  <main class="main">
    <!-- ═══════ OVERVIEW ═══════ -->
    <div class="page active" id="p-overview">
      <div class="page-header">
        <div><div class="page-title">Overview</div><div class="page-sub">Vista ejecutiva de toda la plataforma</div></div>
        <div class="header-actions"><span class="timestamp" id="ts"></span><button class="btn btn-primary" onclick="reload()">Actualizar</button></div>
      </div>
      <div class="kpi-grid" id="kpi-main"></div>
      <div class="grid-2">
        <div class="panel"><div class="panel-title"><span class="icon">&#9660;</span>Funnel de conversion</div><div id="funnel"></div></div>
        <div class="panel"><div class="panel-title"><span class="icon">&#9636;</span>Actividad diaria (30d)</div><div class="spark" id="spark-events"></div><div class="legend" id="spark-legend"></div></div>
      </div>
      <div class="grid-2">
        <div class="panel"><div class="panel-title"><span class="icon">&#9733;</span>Distribucion de Scores</div><div id="score-overview"></div></div>
        <div class="panel"><div class="panel-title"><span class="icon">&#9823;</span>Usuarios activos diarios (7d)</div><div class="spark" id="spark-dau"></div></div>
      </div>
      <div class="panel"><div class="panel-title"><span class="icon">&#9889;</span>Sugerencias prioritarias</div><div id="top-suggestions"></div></div>
    </div>

    <!-- ═══════ USERS ═══════ -->
    <div class="page" id="p-users">
      <div class="page-header"><div><div class="page-title">Usuarios</div><div class="page-sub">Detalle completo de cada usuario de la plataforma</div></div></div>
      <div class="kpi-grid" id="kpi-users"></div>
      <div class="grid-3">
        <div class="panel"><div class="panel-title">Por plan</div><div class="pills" id="pills-plan"></div></div>
        <div class="panel"><div class="panel-title">Por industria</div><div class="pills" id="pills-industry"></div></div>
        <div class="panel"><div class="panel-title">Por rol</div><div class="pills" id="pills-rol"></div></div>
      </div>
      <div class="panel"><div class="panel-title">Registros por semana</div><div class="spark" id="spark-signups"></div></div>
      <div class="panel">
        <div class="panel-title">Tabla de usuarios</div>
        <div class="search-bar">
          <input type="text" id="user-search" placeholder="Buscar nombre, empresa, email..." oninput="filterUsers()">
          <select id="user-status-filter" onchange="filterUsers()"><option value="">Todos los estados</option><option value="activo">Activo</option><option value="inactivo">Inactivo</option><option value="inactivo_critico">Critico</option><option value="diagnosticado">Diagnosticado</option><option value="registrado">Registrado</option><option value="graduado">Graduado</option></select>
          <select id="user-plan-filter" onchange="filterUsers()"><option value="">Todos los planes</option></select>
        </div>
        <div class="table-wrap">
          <table><thead><tr>
            <th>Nombre</th><th>Empresa</th><th>Plan</th><th>Estado</th><th>Caps</th><th>Score</th><th>Boveda</th><th>WA</th><th>Ultima act.</th><th>Msgs</th>
          </tr></thead><tbody id="user-table"></tbody></table>
        </div>
      </div>
    </div>

    <!-- ═══════ CAPSULES ═══════ -->
    <div class="page" id="p-capsules">
      <div class="page-header"><div><div class="page-title">Capsulas</div><div class="page-sub">Analisis de las 25 capsulas del Metodo FIA</div></div></div>
      <div class="kpi-grid" id="kpi-caps"></div>
      <div class="panel"><div class="panel-title"><span class="icon">&#9635;</span>Heatmap de completacion</div><div class="heatmap" id="heatmap"></div><div class="legend" style="margin-top:12px"><div class="legend-item"><span class="legend-dot" style="background:var(--red)"></span>0-25%</div><div class="legend-item"><span class="legend-dot" style="background:var(--orange)"></span>26-50%</div><div class="legend-item"><span class="legend-dot" style="background:var(--yellow)"></span>51-75%</div><div class="legend-item"><span class="legend-dot" style="background:var(--green)"></span>76-100%</div></div></div>
      <div class="grid-2">
        <div class="panel"><div class="panel-title">Usuarios por capsula</div><div class="hbar" id="cap-users-chart"></div></div>
        <div class="panel"><div class="panel-title">Drop-off (trabados)</div><div class="hbar" id="cap-dropoff-chart"></div></div>
      </div>
      <div class="panel">
        <div class="panel-title">Detalle por capsula</div>
        <div class="table-wrap"><table><thead><tr><th>#</th><th>Titulo</th><th>Empezaron</th><th>Completaron</th><th>Trabados</th><th>% Completacion</th><th>Outputs</th></tr></thead><tbody id="cap-table"></tbody></table></div>
      </div>
    </div>

    <!-- ═══════ SCORES ═══════ -->
    <div class="page" id="p-scores">
      <div class="page-header"><div><div class="page-title">Scoring</div><div class="page-sub">Analisis de diagnosticos y lead scores</div></div></div>
      <div class="kpi-grid" id="kpi-scores"></div>
      <div class="grid-2">
        <div class="panel"><div class="panel-title">Score Overall — Histograma</div><div class="hbar" id="hist-overall"></div></div>
        <div class="panel"><div class="panel-title">Fit Score — Histograma</div><div class="hbar" id="hist-fit"></div></div>
      </div>
      <div class="grid-2">
        <div class="panel"><div class="panel-title">Intent Score — Histograma</div><div class="hbar" id="hist-intent"></div></div>
        <div class="panel"><div class="panel-title">Score promedio (gauges)</div><div id="score-gauges"></div></div>
      </div>
      <div class="panel">
        <div class="panel-title">Todos los scores</div>
        <div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Empresa</th><th>Fit</th><th>Intent</th><th>Overall</th><th>Estado</th></tr></thead><tbody id="score-table"></tbody></table></div>
      </div>
    </div>

    <!-- ═══════ VAULT ═══════ -->
    <div class="page" id="p-vault">
      <div class="page-header"><div><div class="page-title">Boveda</div><div class="page-sub">Outputs generados por los usuarios</div></div></div>
      <div class="kpi-grid" id="kpi-vault"></div>
      <div class="grid-2">
        <div class="panel"><div class="panel-title">Por tipo de contenido</div><div class="hbar" id="vault-type-chart"></div></div>
        <div class="panel"><div class="panel-title">Por capsula</div><div class="hbar" id="vault-cap-chart"></div></div>
      </div>
    </div>

    <!-- ═══════ ENGAGEMENT ═══════ -->
    <div class="page" id="p-engagement">
      <div class="page-header"><div><div class="page-title">Engagement</div><div class="page-sub">Rendimiento de las comunicaciones automatizadas</div></div></div>
      <div class="kpi-grid" id="kpi-eng"></div>
      <div class="panel"><div class="panel-title">Mensajes enviados (30d)</div><div class="spark" id="spark-eng"></div></div>
      <div class="grid-2">
        <div class="panel"><div class="panel-title">Rendimiento por journey</div><div id="journey-table-wrap"></div></div>
        <div class="panel"><div class="panel-title">Tipos de evento (30d)</div><div class="hbar" id="event-types-chart"></div></div>
      </div>
    </div>

    <!-- ═══════ LOGS ═══════ -->
    <div class="page" id="p-logs">
      <div class="page-header"><div><div class="page-title">Engagement Logs</div><div class="page-sub">Registro de todos los mensajes enviados</div></div></div>
      <div class="search-bar"><input type="text" id="log-filter" placeholder="Filtrar por user_id..."><button class="btn" onclick="loadLogs()">Buscar</button><button class="btn" onclick="document.getElementById('log-filter').value='';loadLogs()">Limpiar</button></div>
      <div class="panel"><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Journey</th><th>Mensaje</th><th>Status</th><th>Click</th><th>Respondio</th><th>Respuesta</th></tr></thead><tbody id="log-table"></tbody></table></div></div>
    </div>

    <!-- ═══════ SUGGESTIONS ═══════ -->
    <div class="page" id="p-suggestions">
      <div class="page-header"><div><div class="page-title">Sugerencias IA</div><div class="page-sub">Acciones recomendadas basadas en los datos</div></div></div>
      <div id="all-suggestions"></div>
    </div>
  </main>
</div>

<script>
const API='';
let D=null; // dashboard data
let allUsers=[];

// ─── NAV ───
document.querySelectorAll('.nav-item').forEach(function(el){
  el.addEventListener('click',function(){
    document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active')});
    document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});
    el.classList.add('active');
    document.getElementById('p-'+el.dataset.page).classList.add('active');
    if(el.dataset.page==='logs'&&!document.getElementById('log-table').dataset.loaded)loadLogs();
  });
});

// ─── HELPERS ───
function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}
function kpi(label,val,color,sub){return '<div class="kpi"><div class="kpi-label">'+esc(label)+'</div><div class="kpi-value '+(color||'')+'">'+val+'</div>'+(sub?'<div class="kpi-sub">'+esc(sub)+'</div>':'')+'</div>'}
function statusBadge(s){var m={'activo':'b-green','inactivo':'b-yellow','inactivo_critico':'b-red','diagnosticado':'b-cyan','registrado':'b-gray','graduado':'b-purple'};return '<span class="badge '+(m[s]||'b-gray')+'">'+esc(s)+'</span>'}
function pct(n,t){return t>0?Math.round(n/t*100):0}
function maxOf(arr){return Math.max.apply(null,arr.concat([1]))}

function sparkBars(container,data,colorFn,tipFn){
  var mx=maxOf(data.map(function(d){return d.v}));
  container.innerHTML=data.map(function(d,i){
    var h=Math.max((d.v/mx)*100,2);
    var c=colorFn?colorFn(d,i):'var(--accent)';
    return '<div class="spark-bar" style="height:'+h+'%;background:'+c+'" data-tip="'+(tipFn?tipFn(d):d.v)+'"></div>';
  }).join('');
}

function hbars(container,items,color){
  var mx=maxOf(items.map(function(i){return i.v}));
  container.innerHTML=items.map(function(i){
    var w=Math.max(pct(i.v,mx),3);
    return '<div class="hbar-row"><span class="hbar-label" title="'+esc(i.l)+'">'+esc(i.l)+'</span><div class="hbar-track"><div class="hbar-fill" style="width:'+w+'%;background:'+(color||'var(--accent)')+'">'+i.v+'</div></div></div>';
  }).join('');
}

function histogram(container,buckets,color){
  var items=Object.entries(buckets).map(function(e){return{l:e[0],v:e[1]}});
  hbars(container,items,color);
}

// ─── LOAD ───
async function loadDashboard(){
  try{
    var res=await fetch(API+'/api/dashboard');
    D=await res.json();
    allUsers=D.users||[];
    renderAll();
  }catch(e){console.error('Dashboard load failed',e)}
  document.getElementById('loading').classList.add('hidden');
}

function renderAll(){
  renderOverview();
  renderUsers();
  renderCapsules();
  renderScores();
  renderVault();
  renderEngagement();
  renderSuggestions();
  document.getElementById('ts').textContent='Actualizado: '+new Date().toLocaleTimeString('es-AR');
}

// ─── OVERVIEW ───
function renderOverview(){
  var k=D.kpis;
  document.getElementById('kpi-main').innerHTML=
    kpi('Usuarios totales',k.total_users,'blue')+
    kpi('Activos (7d)',k.active_this_week,'green')+
    kpi('Diagnosticados',k.diagnosed,'cyan')+
    kpi('Graduados',k.graduated,'purple')+
    kpi('Inactivos',k.inactive,'yellow',k.critical+' criticos')+
    kpi('Caps promedio',k.avg_capsules_completed,'blue','/25')+
    kpi('Outputs Boveda',k.total_vault_outputs,'purple')+
    kpi('Eventos (30d)',k.total_events_30d,'green');

  // Funnel
  var f=D.funnel;var t=Math.max(f.registered,1);
  var steps=[
    {l:'Registrados',v:f.registered,c:'var(--blue)'},
    {l:'Diagnosticados',v:f.diagnosed,c:'var(--cyan)'},
    {l:'Empezaron capsulas',v:f.started_capsules,c:'var(--accent)'},
    {l:'5+ capsulas',v:f.completed_5_plus,c:'var(--purple)'},
    {l:'10+ capsulas',v:f.completed_10_plus,c:'var(--yellow)'},
    {l:'20+ capsulas',v:f.completed_20_plus,c:'var(--orange)'},
    {l:'Graduados (25)',v:f.graduated,c:'var(--green)'}
  ];
  document.getElementById('funnel').innerHTML=steps.map(function(s){
    var w=Math.max(pct(s.v,t),3);
    return '<div class="funnel-step"><span class="funnel-label">'+s.l+'</span><div class="funnel-bar-wrap"><div class="funnel-bar" style="width:'+w+'%;background:'+s.c+'">'+s.v+'</div></div><span class="funnel-pct">'+pct(s.v,t)+'%</span></div>';
  }).join('');

  // Activity spark
  sparkBars(document.getElementById('spark-events'),
    D.activity.daily_events.map(function(d){return{v:d.count,l:d.date}}),
    null,function(d){return d.l+': '+d.v+' eventos'});
  document.getElementById('spark-legend').innerHTML='<div class="legend-item"><span class="legend-dot" style="background:var(--accent)"></span>Eventos por dia</div>';

  // DAU spark
  sparkBars(document.getElementById('spark-dau'),
    D.activity.dau.map(function(d){return{v:d.users,l:d.date}}),
    function(){return 'var(--green)'},function(d){return d.l+': '+d.v+' usuarios'});

  // Score overview
  var sc=D.scores;
  if(sc.total===0){document.getElementById('score-overview').innerHTML='<div style="color:var(--text3);text-align:center;padding:20px">Sin diagnosticos aun</div>';return}
  var dist=sc.distribution;var dt=Math.max(dist.alto+dist.medio+dist.bajo,1);
  document.getElementById('score-overview').innerHTML=
    '<div class="hbar">'+
    '<div class="hbar-row"><span class="hbar-label">Alto (70+)</span><div class="hbar-track"><div class="hbar-fill" style="width:'+Math.max(pct(dist.alto,dt),3)+'%;background:var(--green)">'+dist.alto+'</div></div></div>'+
    '<div class="hbar-row"><span class="hbar-label">Medio (40-69)</span><div class="hbar-track"><div class="hbar-fill" style="width:'+Math.max(pct(dist.medio,dt),3)+'%;background:var(--yellow)">'+dist.medio+'</div></div></div>'+
    '<div class="hbar-row"><span class="hbar-label">Bajo (&lt;40)</span><div class="hbar-track"><div class="hbar-fill" style="width:'+Math.max(pct(dist.bajo,dt),3)+'%;background:var(--red)">'+dist.bajo+'</div></div></div>'+
    '</div>'+
    '<div style="margin-top:12px;display:flex;gap:16px">'+
    '<div style="font-size:12px;color:var(--text2)">Promedio Overall: <strong style="color:#fff">'+sc.averages.overall+'/100</strong></div>'+
    '<div style="font-size:12px;color:var(--text2)">Fit: <strong style="color:#fff">'+sc.averages.fit+'</strong></div>'+
    '<div style="font-size:12px;color:var(--text2)">Intent: <strong style="color:#fff">'+sc.averages.intent+'</strong></div>'+
    '</div>';

  // Top suggestions
  var sug=D.suggestions||[];
  document.getElementById('top-suggestions').innerHTML=sug.length===0?
    '<div style="color:var(--text3);padding:12px">Sin sugerencias - todo en orden</div>':
    sug.slice(0,3).map(renderSuggestion).join('');
}

// ─── USERS ───
function renderUsers(){
  var k=D.kpis;
  document.getElementById('kpi-users').innerHTML=
    kpi('Total',k.total_users,'blue')+kpi('Con WhatsApp',k.with_whatsapp,'purple')+kpi('Opted-out',k.opted_out,k.opted_out>0?'red':'')+
    kpi('Activos',k.active,'green')+kpi('Inactivos',k.inactive,'yellow')+kpi('Criticos',k.critical,'red');

  // Breakdowns
  renderPills('pills-plan',D.breakdowns.by_plan);
  renderPills('pills-industry',D.breakdowns.by_industry);
  renderPills('pills-rol',D.breakdowns.by_rol);

  // Signups spark
  var signups=D.signups_by_week||[];
  if(signups.length>0){
    sparkBars(document.getElementById('spark-signups'),
      signups.map(function(s){return{v:s.count,l:s.week}}),
      function(){return 'var(--blue)'},function(d){return 'Semana '+d.l+': '+d.v+' registros'});
  }

  // Plan filter options
  var planFilter=document.getElementById('user-plan-filter');
  var plans=Object.keys(D.breakdowns.by_plan).sort();
  planFilter.innerHTML='<option value="">Todos los planes</option>'+plans.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>'}).join('');

  filterUsers();
}

function filterUsers(){
  var q=(document.getElementById('user-search').value||'').toLowerCase();
  var st=document.getElementById('user-status-filter').value;
  var pl=document.getElementById('user-plan-filter').value;
  var filtered=allUsers.filter(function(u){
    if(q&&!(u.nombre||'').toLowerCase().includes(q)&&!(u.empresa||'').toLowerCase().includes(q)&&!(u.email||'').toLowerCase().includes(q))return false;
    if(st&&u.status!==st)return false;
    if(pl&&u.plan!==pl)return false;
    return true;
  });
  var tb=document.getElementById('user-table');
  if(filtered.length===0){tb.innerHTML='<tr><td colspan="10" style="text-align:center;color:var(--text3)">Sin resultados</td></tr>';return}
  tb.innerHTML=filtered.slice(0,100).map(function(u){
    return '<tr>'+
      '<td><strong>'+esc(u.nombre)+'</strong><br><span style="font-size:10px;color:var(--text3)">'+esc(u.email)+'</span></td>'+
      '<td>'+esc(u.empresa)+'<br><span style="font-size:10px;color:var(--text3)">'+esc(u.industria)+'</span></td>'+
      '<td><span class="badge b-blue">'+esc(u.plan)+'</span></td>'+
      '<td>'+statusBadge(u.status)+'</td>'+
      '<td><strong>'+u.capsules_completed+'</strong>/25</td>'+
      '<td>'+(u.overall_score!==null?u.overall_score+'/100':'-')+'</td>'+
      '<td>'+u.vault_outputs+'</td>'+
      '<td>'+(u.whatsapp==='si'?(u.wp_opted_out?'<span class="badge b-red">Opted-out</span>':'<span class="badge b-green">Si</span>'):'<span class="badge b-gray">No</span>')+'</td>'+
      '<td>'+(u.days_since_last_event>=0?u.days_since_last_event+'d':'-')+'</td>'+
      '<td>'+u.messages_received+(u.messages_clicked>0?' / '+u.messages_clicked+' clicks':'')+'</td>'+
    '</tr>';
  }).join('');
}

function renderPills(id,obj){
  var sorted=Object.entries(obj).sort(function(a,b){return b[1]-a[1]});
  document.getElementById(id).innerHTML=sorted.map(function(e){return '<span class="pill"><b>'+e[1]+'</b>'+esc(e[0])+'</span>'}).join('');
}

// ─── CAPSULES ───
function renderCapsules(){
  var caps=D.capsule_analytics||[];
  var totalStarted=caps.reduce(function(s,c){return s+c.total_started},0);
  var totalCompleted=caps.reduce(function(s,c){return s+c.completed},0);
  var totalDropoff=caps.reduce(function(s,c){return s+c.in_progress},0);
  var avgRate=caps.length>0?Math.round(caps.reduce(function(s,c){return s+c.completion_rate},0)/caps.length):0;

  document.getElementById('kpi-caps').innerHTML=
    kpi('Total empezaron',totalStarted,'blue')+kpi('Completaron',totalCompleted,'green')+
    kpi('Trabados',totalDropoff,'red')+kpi('% Completacion promedio',avgRate+'%',avgRate>=60?'green':(avgRate>=30?'yellow':'red'));

  // Heatmap
  document.getElementById('heatmap').innerHTML=caps.map(function(c){
    var r=c.completion_rate;
    var bg=r<=25?'var(--red)':r<=50?'var(--orange)':r<=75?'var(--yellow)':'var(--green)';
    if(c.total_started===0)bg='var(--bg4)';
    return '<div class="heat-cell" style="background:'+bg+'" title="Cap '+c.numero+': '+esc(c.titulo)+'\\n'+c.completed+' completaron, '+c.in_progress+' trabados ('+c.completion_rate+'%)"><div class="cap-num">'+c.numero+'</div><div class="cap-sub">'+c.completion_rate+'%</div></div>';
  }).join('');

  // Users per capsule
  hbars(document.getElementById('cap-users-chart'),
    caps.filter(function(c){return c.total_started>0}).map(function(c){return{l:'Cap '+c.numero,v:c.total_started}}),'var(--blue)');

  // Drop-off
  var dropoffs=caps.filter(function(c){return c.in_progress>0}).sort(function(a,b){return b.in_progress-a.in_progress});
  hbars(document.getElementById('cap-dropoff-chart'),
    dropoffs.map(function(c){return{l:'Cap '+c.numero,v:c.in_progress}}),'var(--red)');

  // Table
  document.getElementById('cap-table').innerHTML=caps.map(function(c){
    var rateColor=c.completion_rate>=70?'b-green':c.completion_rate>=40?'b-yellow':'b-red';
    if(c.total_started===0)rateColor='b-gray';
    return '<tr><td><strong>'+c.numero+'</strong></td><td>'+esc(c.titulo)+'</td><td>'+c.total_started+'</td><td>'+c.completed+'</td><td>'+c.in_progress+'</td><td><span class="badge '+rateColor+'">'+c.completion_rate+'%</span></td><td>'+c.vault_outputs+'</td></tr>';
  }).join('');
}

// ─── SCORES ───
function renderScores(){
  var sc=D.scores;
  document.getElementById('kpi-scores').innerHTML=
    kpi('Diagnosticados',sc.total,'cyan')+kpi('Overall promedio',sc.averages.overall,'blue','/100')+
    kpi('Fit promedio',sc.averages.fit,'purple','/100')+kpi('Intent promedio',sc.averages.intent,'green','/100')+
    kpi('Score alto (70+)',sc.distribution.alto,'green')+kpi('Score bajo (<40)',sc.distribution.bajo,sc.distribution.bajo>0?'red':'');

  histogram(document.getElementById('hist-overall'),sc.overall_histogram,'var(--blue)');
  histogram(document.getElementById('hist-fit'),sc.fit_histogram,'var(--purple)');
  histogram(document.getElementById('hist-intent'),sc.intent_histogram,'var(--green)');

  // Gauges
  document.getElementById('score-gauges').innerHTML=
    '<div class="gauge-row"><span class="gauge-label">Overall</span><div class="gauge-track"><div class="gauge-fill" style="width:'+sc.averages.overall+'%;background:var(--blue)"></div></div><span class="gauge-val" style="color:var(--blue2)">'+sc.averages.overall+'</span></div>'+
    '<div class="gauge-row"><span class="gauge-label">Fit</span><div class="gauge-track"><div class="gauge-fill" style="width:'+sc.averages.fit+'%;background:var(--purple)"></div></div><span class="gauge-val" style="color:var(--purple2)">'+sc.averages.fit+'</span></div>'+
    '<div class="gauge-row"><span class="gauge-label">Intent</span><div class="gauge-track"><div class="gauge-fill" style="width:'+sc.averages.intent+'%;background:var(--green)"></div></div><span class="gauge-val" style="color:var(--green2)">'+sc.averages.intent+'</span></div>';

  // Score table (join with user data)
  var scoreData=(sc.all_scores||[]).map(function(s){
    var u=allUsers.find(function(u){return u.id===s.user_id})||{};
    return Object.assign({},s,{nombre:u.nombre||'?',empresa:u.empresa||'?',status:u.status||'?'});
  }).sort(function(a,b){return b.overall-a.overall});

  document.getElementById('score-table').innerHTML=scoreData.map(function(s){
    var oc=s.overall>=70?'b-green':s.overall>=40?'b-yellow':'b-red';
    return '<tr><td>'+esc(s.nombre)+'</td><td>'+esc(s.empresa)+'</td><td>'+s.fit+'</td><td>'+s.intent+'</td><td><span class="badge '+oc+'">'+s.overall+'</span></td><td>'+statusBadge(s.status)+'</td></tr>';
  }).join('');
}

// ─── VAULT ───
function renderVault(){
  var v=D.vault;
  document.getElementById('kpi-vault').innerHTML=
    kpi('Total outputs',v.total,'purple')+kpi('Usuarios con outputs',v.users_with_outputs,'blue')+
    kpi('Tipos distintos',Object.keys(v.by_type).length,'cyan')+
    kpi('Capsulas con outputs',Object.keys(v.by_capsule).length,'green','/25');

  var types=Object.entries(v.by_type).sort(function(a,b){return b[1]-a[1]}).map(function(e){return{l:e[0],v:e[1]}});
  hbars(document.getElementById('vault-type-chart'),types,'var(--purple)');

  var byCap=[];
  for(var i=1;i<=25;i++){if(v.by_capsule[i])byCap.push({l:'Cap '+i,v:v.by_capsule[i]})}
  hbars(document.getElementById('vault-cap-chart'),byCap,'var(--cyan)');
}

// ─── ENGAGEMENT ───
function renderEngagement(){
  var e=D.engagement;
  document.getElementById('kpi-eng').innerHTML=
    kpi('Mensajes enviados',e.all_time.sent,'blue','Total historico')+
    kpi('Click rate',e.all_time.click_rate+'%','green')+
    kpi('Response rate',e.all_time.response_rate+'%','yellow')+
    kpi('Enviados (7d)',e.last_7d.sent,'cyan')+
    kpi('Clicks (7d)',e.last_7d.clicked,'green')+
    kpi('Respuestas (7d)',e.last_7d.responded,'purple');

  // Daily spark
  sparkBars(document.getElementById('spark-eng'),
    e.daily_timeline.map(function(d){return{v:d.sent,l:d.date}}),
    function(){return 'var(--blue)'},function(d){return d.l+': '+d.v+' msgs'});

  // Journey table
  var journeys=Object.entries(e.by_journey).sort(function(a,b){return b[1].sent-a[1].sent});
  document.getElementById('journey-table-wrap').innerHTML='<table><thead><tr><th>Journey</th><th>Enviados</th><th>Clicks</th><th>Respuestas</th><th>CTR</th></tr></thead><tbody>'+
    journeys.map(function(j){
      var ctr=j[1].sent>0?Math.round(j[1].clicked/j[1].sent*1000)/10:0;
      return '<tr><td><strong>'+esc(j[0])+'</strong></td><td>'+j[1].sent+'</td><td>'+j[1].clicked+'</td><td>'+j[1].responded+'</td><td><span class="badge '+(ctr>=20?'b-green':ctr>=5?'b-yellow':'b-red')+'">'+ctr+'%</span></td></tr>';
    }).join('')+'</tbody></table>';

  // Event types
  var evts=Object.entries(D.activity.event_types).sort(function(a,b){return b[1]-a[1]}).map(function(e){return{l:e[0],v:e[1]}});
  hbars(document.getElementById('event-types-chart'),evts,'var(--green)');
}

// ─── LOGS ───
async function loadLogs(){
  var uid=document.getElementById('log-filter').value.trim();
  var params=new URLSearchParams({limit:'50'});
  if(uid)params.set('user_id',uid);
  try{
    var res=await fetch(API+'/api/engagement/logs?'+params);
    var data=await res.json();
    var tb=document.getElementById('log-table');
    tb.dataset.loaded='1';
    if(!data.logs||data.logs.length===0){tb.innerHTML='<tr><td colspan="8" style="text-align:center;color:var(--text3)">Sin registros</td></tr>';return}
    tb.innerHTML=data.logs.map(function(log){
      var date=new Date(log.created_at).toLocaleString('es-AR',{dateStyle:'short',timeStyle:'short'});
      var msg=log.mensaje_enviado.length>80?log.mensaje_enviado.slice(0,80)+'...':log.mensaje_enviado;
      var sc=log.status==='sent'?'b-green':(log.status==='failed'?'b-red':'b-yellow');
      return '<tr><td>'+date+'</td><td style="font-family:monospace;font-size:10px">'+log.user_id.slice(0,8)+'...</td><td>'+esc(log.journey_name)+'</td><td title="'+esc(log.mensaje_enviado)+'">'+esc(msg)+'</td><td><span class="badge '+sc+'">'+log.status+'</span></td><td>'+(log.clicked?'<span class="badge b-green">Si</span>':'<span class="badge b-gray">No</span>')+'</td><td>'+(log.responded?'<span class="badge b-green">Si</span>':'<span class="badge b-gray">No</span>')+'</td><td>'+(log.response_text||'-')+'</td></tr>';
    }).join('');
  }catch(e){console.error('Logs failed',e)}
}

// ─── SUGGESTIONS ───
function renderSuggestion(s){
  return '<div class="suggestion '+esc(s.priority)+'">'+
    '<div class="suggestion-header"><span class="suggestion-type">'+esc(s.type)+'</span><span class="badge '+(s.priority==='alta'?'b-red':s.priority==='media'?'b-yellow':'b-blue')+'">'+esc(s.priority)+'</span></div>'+
    '<div class="suggestion-msg">'+esc(s.message)+'</div>'+
    (s.data?'<div class="suggestion-data">'+JSON.stringify(s.data).slice(0,300)+'</div>':'')+
    '</div>';
}
function renderSuggestions(){
  var sug=D.suggestions||[];
  document.getElementById('all-suggestions').innerHTML=sug.length===0?
    '<div class="panel" style="text-align:center;color:var(--text3);padding:40px">Sin sugerencias activas. Todo parece estar bien.</div>':
    sug.map(renderSuggestion).join('');
}

// ─── RELOAD ───
async function reload(){await loadDashboard()}

// ─── INIT ───
loadDashboard();
setInterval(loadDashboard,120000);
</script>
</body>
</html>`;
}
