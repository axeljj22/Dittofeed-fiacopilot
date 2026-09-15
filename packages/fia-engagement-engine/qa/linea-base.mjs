/**
 * Linea base de la Fase 1: que registro Sofia desde que se instrumento.
 * Manda el informe por mail. Corre donde estan los datos.
 */
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync("/opt/victoria/.env","utf8").split(/\r?\n/)
  .filter(l=>l.includes("=")&&!l.startsWith("#"))
  .map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const sb = Object.fromEntries(readFileSync("/opt/sofia/dittofeed/.env","utf8").split(/\r?\n/)
  .filter(l=>l.includes("=")&&!l.startsWith("#"))
  .map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const url = sb.SUPABASE_URL || sb.NEXT_PUBLIC_SUPABASE_URL;
const key = sb.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey:key, Authorization:`Bearer ${key}` };
const q = async p => (await fetch(`${url}/rest/v1/${p}`,{headers:h})).json();

const filas = await q("sofia_diagnostics?select=motivo_silencio,subject_origin,motor_busqueda,fragmentos,similitudes&limit=2000");
const cuenta = (c) => { const m={}; for(const f of filas) m[f[c] ?? "(respondio)"] = (m[f[c] ?? "(respondio)"]??0)+1; return m; };
const sims = filas.flatMap(f => f.similitudes ?? []).map(Number).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
const p = (x) => sims.length ? sims[Math.floor(sims.length*x)].toFixed(2) : "—";

let html = `<div style="font-family:system-ui,sans-serif;max-width:640px"><h2>Sofia — linea base Fase 1</h2>`;
if (!filas.length) {
  html += `<p style="background:#fee;padding:10px;border-left:3px solid #c00"><b>0 filas registradas.</b>
  O no hubo trafico en los grupos, o la instrumentacion no esta escribiendo. Revisar.</p>`;
} else {
  html += `<p><b>${filas.length}</b> decisiones registradas.</p>`;
  html += `<h3>Por que se callo</h3><ul>`;
  for (const [k,v] of Object.entries(cuenta("motivo_silencio"))) html += `<li><b>${v}</b> — ${k}</li>`;
  html += `</ul><h3>De donde salio el sujeto</h3><ul>`;
  for (const [k,v] of Object.entries(cuenta("subject_origin"))) html += `<li><b>${v}</b> — ${k}</li>`;
  html += `</ul><h3>Motor de busqueda</h3><ul>`;
  for (const [k,v] of Object.entries(cuenta("motor_busqueda"))) html += `<li><b>${v}</b> — ${k}</li>`;
  html += `</ul><h3>Similitudes (para mover el umbral con datos)</h3>
  <p>hoy el corte es <b>0.25</b> · mediana ${p(0.5)} · percentil 25: ${p(0.25)} · percentil 75: ${p(0.75)}</p>`;
}
html += `</div>`;
const r = await fetch("https://api.resend.com/emails",{method:"POST",
  headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,"content-type":"application/json"},
  body:JSON.stringify({from:env.AVISOS_MAIL_FROM,to:env.AVISOS_MAIL_TO,
    subject:`Sofia — linea base: ${filas.length} decisiones registradas`, html})});
console.log(r.ok ? "mail enviado" : "fallo: "+JSON.stringify(await r.json()).slice(0,120));
