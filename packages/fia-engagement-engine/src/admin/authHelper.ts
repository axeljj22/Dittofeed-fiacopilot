/**
 * Shared admin auth helper — localStorage-based login overlay.
 *
 * Embeds a self-contained script block into admin HTML pages.
 * On load: checks localStorage for a saved token; if missing, shows a styled
 * password overlay and validates against GET /api/config before saving.
 * Sets window.TOKEN and calls window.onAuthReady() once authenticated.
 */

export const ADMIN_AUTH_SCRIPT = `<script>
(function(){
  var KEY='fia_admin_token';
  var STYLE='#fia-auth{position:fixed;inset:0;background:#0a0b10;display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,-apple-system,sans-serif}'
    +'#fia-auth .box{background:#12131a;border:1px solid #2a2b3d;border-radius:16px;padding:40px 48px;width:380px;text-align:center}'
    +'#fia-auth h2{color:#fff;font-size:22px;font-weight:700;margin-bottom:6px}'
    +'#fia-auth p{color:#9394a5;font-size:13px;margin-bottom:28px}'
    +'#fia-auth input{width:100%;background:#0a0b10;border:1px solid #2a2b3d;border-radius:8px;padding:13px;color:#e4e4ef;font-size:16px;margin-bottom:12px;text-align:center;letter-spacing:3px;outline:none;transition:border-color .15s}'
    +'#fia-auth input:focus{border-color:#6366f1}'
    +'#fia-auth button{width:100%;background:#6366f1;color:#fff;border:none;border-radius:8px;padding:13px;font-size:14px;font-weight:600;cursor:pointer;transition:background .2s}'
    +'#fia-auth button:hover{background:#4f46e5}'
    +'#fia-auth .err{color:#f87171;font-size:12px;margin-top:12px;min-height:16px}';

  function init(t){
    window.TOKEN=t;
    if(typeof window.onAuthReady==='function') window.onAuthReady();
  }

  function showOverlay(){
    var s=document.createElement('style'); s.textContent=STYLE; document.head.appendChild(s);
    var d=document.createElement('div'); d.id='fia-auth';
    d.innerHTML='<div class="box">'
      +'<h2>FIA Engine Admin</h2>'
      +'<p>Ingresá tu contraseña de administrador</p>'
      +'<input type="password" id="fia-pw" placeholder="••••••••••" autocomplete="current-password">'
      +'<button onclick="window._fiaLogin()">Ingresar</button>'
      +'<div class="err" id="fia-err"></div>'
      +'</div>';
    document.body.appendChild(d);
    setTimeout(function(){ var el=document.getElementById('fia-pw'); if(el) el.focus(); }, 80);
    document.getElementById('fia-pw').addEventListener('keydown', function(e){
      if(e.key==='Enter') window._fiaLogin();
    });
    window._fiaLogin=async function(){
      var pw=document.getElementById('fia-pw').value.trim();
      if(!pw) return;
      var btn=document.querySelector('#fia-auth button'); btn.textContent='Verificando...'; btn.disabled=true;
      try {
        var r=await fetch('/api/config',{headers:{Authorization:'Bearer '+pw}});
        if(r.ok){
          localStorage.setItem(KEY,pw);
          document.getElementById('fia-auth').remove();
          init(pw);
        } else {
          document.getElementById('fia-err').textContent='Contraseña incorrecta';
          btn.textContent='Ingresar'; btn.disabled=false;
          document.getElementById('fia-pw').select();
        }
      } catch(e) {
        document.getElementById('fia-err').textContent='Error de conexión';
        btn.textContent='Ingresar'; btn.disabled=false;
      }
    };
  }

  window._fiaLogout=function(){localStorage.removeItem(KEY); location.reload();};

  var saved=localStorage.getItem(KEY);
  if(saved){ init(saved); }
  else { document.addEventListener('DOMContentLoaded', showOverlay); }
})();
</script>`;

export const ADMIN_LOGOUT_LINK = `<div style="text-align:right;padding:4px 0 16px"><a href="#" onclick="window._fiaLogout();return false" style="color:#5d5e72;font-size:11px;text-decoration:none">Cerrar sesión</a></div>`;
