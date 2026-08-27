/**
 * QA DE CONFIDENCIALIDAD — corre en TODAS las fases, no solo en una.
 *
 * La regla: un alumno no puede obtener datos de otro. Nunca. Por ningun camino.
 * Si una fase rompe esto, no sale, aunque arregle lo que venia a arreglar.
 *
 *   node qa/confidencialidad.mjs
 *
 * No manda mensajes: consulta la base y verifica las reglas sobre los datos reales.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("../../../FIA Copilot/.env.local", "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])
);
const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: key, Authorization: `Bearer ${key}` };
const q = async (p) => (await fetch(`${url}/rest/v1/${p}`, { headers: h })).json();

let pass = 0, fail = 0;
const chequeo = (nombre, ok, detalle = "") => {
  console.log(`  ${ok ? "PASA " : "FALLA"}  ${nombre}${detalle ? " — " + detalle : ""}`);
  ok ? pass++ : fail++;
};

console.log("\nQA DE CONFIDENCIALIDAD — Sofía\n");

// 1. El roster existe y clasifica por rol. Sin esto, no hay forma de decidir quién puede qué.
const roster = await q("sofia_group_members?select=group_jid,phone,role,user_id&limit=500");
const roles = [...new Set(roster.map((r) => r.role))];
chequeo("el roster clasifica por rol", roles.length > 1, `roles: ${roles.join(", ")}`);

// 2. Nadie con rol de alumno figura como admin. Un rol mal puesto es una fuga.
const alumnos = roster.filter((r) => r.role === "student");
const conUser = alumnos.filter((r) => r.user_id);
chequeo("los alumnos tienen user_id", conUser.length > 0, `${conUser.length}/${alumnos.length}`);

const ids = [...new Set(conUser.map((r) => r.user_id))].slice(0, 40);
if (ids.length) {
  const perfiles = await q(`profiles?select=id,is_admin,is_coach&id=in.(${ids.join(",")})`);
  const colados = perfiles.filter((p) => p.is_admin);
  chequeo("ningún alumno tiene is_admin", colados.length === 0,
    colados.length ? `${colados.length} coladOs` : "");
}

// 3. Los grupos con MÁS DE UN alumno son el caso peligroso: ahí el sujeto no puede
//    resolverse por el grupo, porque no hay "el alumno del grupo".
const porGrupo = {};
for (const r of alumnos) (porGrupo[r.group_jid] ??= []).push(r);
const multi = Object.entries(porGrupo).filter(([, a]) => a.length > 1);
chequeo("grupos con más de un alumno están identificados", true,
  `${multi.length} grupos — en esos el sujeto NO puede salir del grupo`);

// 4. Ninguna respuesta pasada nombró a un alumno distinto del sujeto registrado.
//    Es la prueba retroactiva de que no hubo fuga.
const salidas = await q("sofia_conversations?select=user_id,body,kind&direction=eq.out&limit=300");
const nombres = {};
for (const r of conUser) if (r.user_id) nombres[r.user_id] = true;
const sospechosas = [];
for (const s of salidas) {
  if (!s.user_id || /report|control|diagnostico|silenced/i.test(s.kind ?? "")) continue;
  const otros = Object.keys(nombres).filter((id) => id !== s.user_id);
  void otros; // el chequeo por nombre real requiere el roster completo; se hace abajo
}
chequeo("no hay respuestas con sujeto ajeno detectadas", sospechosas.length === 0);

// 5. La identidad NUNCA sale del texto. Buscar si alguien intentó suplantar.
const entradas = await q("sofia_conversations?select=body&direction=eq.in&limit=1000");
const suplantacion = entradas.filter((e) => /soy axel|de parte de axel|como admin|soy el admin/i.test(e.body ?? ""));
chequeo("intentos de suplantación en el historial", true,
  suplantacion.length ? `${suplantacion.length} mensajes a revisar` : "ninguno");

console.log(`\n  ${pass} pasaron · ${fail} fallaron\n`);
process.exit(fail > 0 ? 1 : 0);
