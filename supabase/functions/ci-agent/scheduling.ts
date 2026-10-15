// SIERRA — Módulo de agendamiento automático (v1, 2026-10-15)
// Después de enviar la cotización, SIERRA ofrece horarios REALES del asesor, reserva la cita en su calendario,
// confirma al cliente y avisa al asesor con la ficha del prospecto.
// Reglas: la IA no inventa horarios (todo sale del calendario y de este código); nunca se confirma antes de que
// el evento exista; la base de datos impide dobles reservas (restricción de exclusión en public.appointments).
// Se activa por empresa con workspaces.settings.scheduling.enabled = true. Apagado = SIERRA igual que antes.
// Este archivo no importa nada: index.ts le entrega sus dependencias con initScheduling().

// deno-lint-ignore-file no-explicit-any

// ---------------------------------------------------------------- dependencias
type Deps = {
  admin: any;
  cfg: (name: string) => Promise<string | null>;
  audit: (ws: string, type: string, entity: string, id: string | null, payload: Record<string, unknown>) => Promise<void>;
  waCreds: () => Promise<{ token: string; phoneId: string } | null>;
  waPost: (c: { token: string; phoneId: string }, payload: any) => Promise<{ ok: boolean; status: number; body: string }>;
  waAdvisor: (ws: any, p: any, lead: any, headline: string) => Promise<void>;
  mailAdvisor: (ws: any, subject: string, html: string) => Promise<void>;
  quoteCode: (id: string) => string;
  escH: (s: unknown) => string;
  SB_URL: string;
};
let D: Deps;
export function initScheduling(d: Deps) { D = d; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bg = (p: Promise<unknown>) => {
  const ER = (globalThis as any).EdgeRuntime;
  const q = p.catch((e) => console.error("sched bg", (e as Error)?.message || e));
  if (ER?.waitUntil) ER.waitUntil(q);
};
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- configuración
export type Advisor = { key: string; name: string; email: string | null; whatsapp: string; calendar_id: string | null; busy_calendars: string[]; invite_emails: string[] };
export type SchedCfg = {
  enabled: boolean; provider: "google_bridge" | "internal"; timezone: string;
  min_days_ahead: number; offer_days: number; max_search_days: number;
  slot_minutes: number; buffer_minutes: number; work_days: number[]; work_hours: [string, string][];
  slots_to_offer: number; per_day: number; virtual: boolean; presencial: boolean; address: string | null;
  respond_within_hours: number; hold_minutes: number; dry_run: boolean; meeting_title: string;
  advisors: Advisor[]; emojis: boolean; company: string; bot_whatsapp: string;
};
export function schedCfg(ws: any): SchedCfg | null {
  const s = ws?.settings || {};
  const c = s.scheduling || {};
  if (c.enabled !== true) return null;
  const a0 = s.advisor || {};
  const advisors: Advisor[] = (Array.isArray(c.advisors) && c.advisors.length ? c.advisors : [{}]).map((a: any, i: number) => ({
    key: String(a.key || (i === 0 ? "main" : `a${i}`)),
    name: String(a.name || a0.name || s.owner_name || "Asesor"),
    email: a.email || a0.email || s.contact_email || null,
    whatsapp: String(a.whatsapp || a0.whatsapp || "").replace(/\D/g, ""),
    calendar_id: a.calendar_id || null,
    busy_calendars: Array.isArray(a.busy_calendars) ? a.busy_calendars : [],
    invite_emails: Array.isArray(a.invite_emails) ? a.invite_emails : [],
  }));
  const mod = c.modalities || {};
  return {
    enabled: true,
    provider: c.provider === "google_bridge" ? "google_bridge" : "internal",
    timezone: c.timezone || s.timezone || "America/Bogota",
    min_days_ahead: Number.isFinite(c.min_days_ahead) ? Math.max(1, c.min_days_ahead) : 1, // nunca el mismo día
    offer_days: c.offer_days || 2,
    max_search_days: c.max_search_days || 14,
    slot_minutes: c.slot_minutes || 45,
    buffer_minutes: Number.isFinite(c.buffer_minutes) ? c.buffer_minutes : 15,
    work_days: Array.isArray(c.work_days) && c.work_days.length ? c.work_days : [1, 2, 3, 4, 5],
    work_hours: Array.isArray(c.work_hours) && c.work_hours.length ? c.work_hours : [["08:00", "12:00"], ["14:00", "17:00"]],
    slots_to_offer: c.slots_to_offer || 4,
    per_day: c.per_day || 2,
    virtual: mod.virtual !== false,
    presencial: !!(mod.presencial && (c.address || mod.address)),
    address: c.address || mod.address || null,
    respond_within_hours: c.respond_within_hours || 2,
    hold_minutes: c.hold_minutes || 5,
    dry_run: c.dry_run === true,
    meeting_title: c.meeting_title || "Reunión",
    advisors,
    emojis: s.use_emojis !== false,
    company: s.company_name || ws.name || "",
    bot_whatsapp: String(s.bot_whatsapp || "").replace(/\D/g, ""),
  };
}

// ---------------------------------------------------------------- tiempo y zona horaria
const hm = (t: string) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
export function tzOffsetMin(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}
/** Fecha local (YYYY-MM-DD) + minutos desde medianoche, en la zona tz → instante UTC. */
export function zoned(ymd: string, minutes: number, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let off = tzOffsetMin(new Date(guess), tz);
  let t = guess - off * 60000;
  const off2 = tzOffsetMin(new Date(t), tz);
  if (off2 !== off) { off = off2; t = guess - off * 60000; }
  return new Date(t);
}
export function local(date: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(date);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
  return { ymd, dow, minutes: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
const dowOf = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function fmtDay(d: Date, tz: string) {
  return cap(new Intl.DateTimeFormat("es-CO", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d));
}
export function fmtTime(d: Date, tz: string) {
  return new Intl.DateTimeFormat("es-CO", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d)
    .replace(/[\u00a0\u202f]/g, " ").replace(/\s*a\.?\s*m\.?/i, " a. m.").replace(/\s*p\.?\s*m\.?/i, " p. m.");
}
const fmtFull = (d: Date, tz: string) => `${fmtDay(d, tz)}, ${fmtTime(d, tz)}`;

// ---------------------------------------------------------------- cálculo de espacios libres
export type Busy = { start: number; end: number };
export type Slot = { start: string; end: string; advisor: string };
export type Pref = {
  dates?: string[]; from?: string; to?: string; part?: "am" | "pm" | "eve";
  after?: number; before?: number; exact?: number; sameDay?: boolean; raw?: string;
};
/** Todos los espacios libres entre fromYmd y toYmd (incluidos) para un asesor. */
export function freeSlots(c: SchedCfg, advisorKey: string, busy: Busy[], fromYmd: string, toYmd: string, now = new Date()): Slot[] {
  const out: Slot[] = [];
  const dur = c.slot_minutes, buf = c.buffer_minutes, step = dur + buf;
  for (let day = fromYmd; day <= toYmd; day = addDays(day, 1)) {
    if (!c.work_days.includes(dowOf(day))) continue;
    for (const [a, b] of c.work_hours) {
      for (let m = hm(a); m + dur <= hm(b); m += step) {
        const s = zoned(day, m, c.timezone), e = new Date(s.getTime() + dur * 60000);
        if (s.getTime() <= now.getTime()) continue;
        const lo = s.getTime() - buf * 60000, hi = e.getTime() + buf * 60000;
        if (busy.some((x) => x.start < hi && x.end > lo)) continue;
        out.push({ start: s.toISOString(), end: e.toISOString(), advisor: advisorKey });
      }
    }
  }
  return out;
}
export function firstDay(c: SchedCfg, now = new Date()) { return addDays(local(now, c.timezone).ymd, c.min_days_ahead); }

/** Oferta inicial: mañana y pasado mañana (hábiles), hasta per_day por día, mezclando mañana y tarde. */
export function pickDefault(c: SchedCfg, slots: Slot[]): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) { const k = local(new Date(s.start), c.timezone).ymd; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k)!.push(s); }
  const out: Slot[] = [];
  for (const [, list] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (out.length >= c.slots_to_offer) break;
    const am = list.filter((s) => local(new Date(s.start), c.timezone).minutes < 12 * 60);
    const pm = list.filter((s) => local(new Date(s.start), c.timezone).minutes >= 12 * 60);
    const pick: Slot[] = [];
    if (am[0]) pick.push(am[0]);
    if (pm[0]) pick.push(pm[0]);
    for (const s of list) { if (pick.length >= c.per_day) break; if (!pick.includes(s)) pick.push(s); }
    pick.sort((a, b) => (a.start < b.start ? -1 : 1));
    out.push(...pick.slice(0, Math.min(c.per_day, c.slots_to_offer - out.length)));
  }
  return out;
}

/** Filtra los espacios según la preferencia del cliente. */
export function matchPref(c: SchedCfg, slots: Slot[], p: Pref): Slot[] {
  return slots.filter((s) => {
    const L = local(new Date(s.start), c.timezone);
    if (p.dates?.length && !p.dates.includes(L.ymd)) return false;
    if (p.from && L.ymd < p.from) return false;
    if (p.to && L.ymd > p.to) return false;
    if (p.part === "am" && L.minutes >= 12 * 60) return false;
    if (p.part === "pm" && (L.minutes < 12 * 60 || L.minutes >= 18 * 60)) return false;
    if (p.part === "eve" && L.minutes < 18 * 60) return false;
    if (p.after != null && L.minutes < p.after) return false;
    if (p.before != null && L.minutes + c.slot_minutes > p.before) return false;
    if (p.exact != null && L.minutes !== p.exact) return false;
    return true;
  });
}
/** ¿La preferencia cae fuera de la agenda habitual? (sábado, noche, 7 p. m.…) */
export function outsideAgenda(c: SchedCfg, p: Pref): boolean {
  const days = p.dates || [];
  if (days.length && days.every((d) => !c.work_days.includes(dowOf(d)))) return true;
  if (p.part === "eve") return true;
  const inWin = (m: number) => c.work_hours.some(([a, b]) => m >= hm(a) && m + c.slot_minutes <= hm(b));
  if (p.exact != null && !inWin(p.exact)) return true;
  if (p.after != null && !c.work_hours.some(([, b]) => hm(b) - c.slot_minutes >= p.after!)) return true;
  if (p.before != null && !c.work_hours.some(([a]) => hm(a) + c.slot_minutes <= p.before!)) return true;
  return false;
}

// ---------------------------------------------------------------- lectura de la respuesta del cliente
const DOW: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const MES: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
function hourOf(h: number, mm: number, mer: string | undefined, part?: string): number {
  const m = norm(mer || "");
  if (/^p|tarde|noche/.test(m)) { if (h < 12) h += 12; }
  else if (/^a|manana/.test(m)) { if (h === 12) h = 0; }
  else if (h >= 1 && h <= 6) h += 12; // "a las 3" en contexto comercial = 3 p. m.
  else if (h === 7 && (part === "pm" || part === "eve")) h = 19;
  return h * 60 + mm;
}
/** Convierte frases como "el martes en la tarde", "mañana después de las 3", "el 28 a las 10" en una preferencia. */
export function parsePref(text: string, c: SchedCfg, now = new Date()): Pref | null {
  const t = norm(text);
  const today = local(now, c.timezone).ymd;
  const p: Pref = { raw: text };
  let hit = false;
  // franja del día
  if (/\b(en|por|de|a) la manana\b|\btemprano\b|\bantes del? (medio ?dia|almuerzo)\b/.test(t)) { p.part = "am"; hit = true; }
  if (/\b(en|por|de|a) la tarde\b|\bdespues del? almuerzo\b/.test(t)) { p.part = "pm"; hit = true; }
  if (/\b(en|por|de|a) la noche\b/.test(t)) { p.part = "eve"; hit = true; }
  // días
  const tDay = t.replace(/\bpasado manana\b/g, " pasadomanana ").replace(/\b(en|por|de|a) la manana\b/g, " ");
  if (/\bpasadomanana\b/.test(tDay)) { p.dates = [addDays(today, 2)]; hit = true; }
  else if (/\bmanana\b/.test(tDay)) { p.dates = [addDays(today, 1)]; hit = true; }
  if (/\bhoy\b/.test(t)) { p.dates = [today]; p.sameDay = true; hit = true; }
  const wd = t.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g);
  if (wd) {
    const nextWeek = /\b(proxim[oa]|siguiente|que viene|otra semana)\b/.test(t);
    p.dates = wd.map((w) => {
      let d = addDays(today, 1);
      while (dowOf(d) !== DOW[w]) d = addDays(d, 1);
      if (nextWeek && d < addDays(today, 7 - ((dowOf(today) + 6) % 7))) d = addDays(d, 7);
      return d;
    });
    hit = true;
  }
  const dm = t.match(/\b(?:el|dia|para el)\s+(\d{1,2})(?:\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre))?\b(?!\s*(?::|a\.?\s?m|p\.?\s?m|am|pm|de la))/) || t.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/);
  if (dm) {
    const day = Number(dm[1]);
    if (day >= 1 && day <= 31) {
      const [ty, tm] = today.split("-").map(Number);
      let mon = dm[2] ? MES[dm[2]] : tm, yr = ty;
      let cand = `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (cand < today) { if (dm[2]) yr++; else { mon++; if (mon > 12) { mon = 1; yr++; } } cand = `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
      p.dates = [cand];
      hit = true;
    }
  }
  if (!p.dates && /\b(proxima semana|semana que viene|siguiente semana|otra semana)\b/.test(t)) {
    let d = addDays(today, 1);
    while (dowOf(d) !== 1) d = addDays(d, 1);
    p.from = d; p.to = addDays(d, 6); hit = true;
  } else if (!p.dates && /\besta semana\b/.test(t)) {
    p.from = today; let d = today; while (dowOf(d) !== 0) d = addDays(d, 1); p.to = d; hit = true;
  }
  // horas
  if (/\b(medio ?dia|mediodia)\b/.test(t)) { p.exact = 12 * 60; hit = true; }
  const T = "(\\d{1,2})(?:[:.h](\\d{2}))?\\s*(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?|am|pm|de la manana|de la tarde|de la noche)?";
  const after = t.match(new RegExp(`\\b(?:despues de|a partir de|desde)\\s+(?:las?\\s+)?${T}`));
  const before = t.match(new RegExp(`\\b(?:antes de|maximo a|hasta)\\s+(?:las?\\s+)?${T}`));
  const exact = t.match(new RegExp(`\\b(?:a las?|tipo|las|sobre las|como a las)\\s+${T}`)) || t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)\b/);
  if (after) { p.after = hourOf(Number(after[1]), Number(after[2] || 0), after[3], p.part); hit = true; }
  if (before) { p.before = hourOf(Number(before[1]), Number(before[2] || 0), before[3], p.part); hit = true; }
  if (!after && !before && exact && Number(exact[1]) <= 23) { p.exact = hourOf(Number(exact[1]), Number(exact[2] || 0), exact[3], p.part); hit = true; }
  return hit ? p : null;
}
/** "2", "el 2", "opción 2", "la segunda", "el de las 11" → índice elegido (0-based) o -1. */
export function parseChoice(text: string, options: Slot[], tz: string): number {
  const t = norm(text).replace(/[.!?¡¿,]/g, " ").trim();
  const ord: Record<string, number> = { primero: 1, primera: 1, uno: 1, segundo: 2, segunda: 2, dos: 2, tercero: 3, tercera: 3, tres: 3, cuarto: 4, cuarta: 4, cuatro: 4, quinto: 5, quinta: 5, cinco: 5 };
  const m = t.match(/^(?:(?:si|ok|dale|listo|perfecto|claro)\s+)?(?:(?:me sirve|prefiero|quiero|escojo|elijo|tomo|agendame|agenda)\s+)?(?:el|la)?\s*(?:opcion|numero|#|espacio|horario)?\s*(\d|primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|uno|dos|tres|cuatro|cinco)\s*(?:por favor|porfa|gracias)?$/);
  if (m) { const n = ord[m[1].replace(/^tercer$/, "tercero").replace(/^primer$/, "primero")] || Number(m[1]); return n >= 1 && n <= options.length ? n - 1 : -1; }
  // "el de las 11", "11 am", "a las 3"
  const h = t.match(/\b(?:las?\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)?\b/);
  if (h && /\b(las?|am|pm|a\.? ?m|p\.? ?m|el de)\b/.test(t) && t.split(" ").length <= 7) {
    const want = hourOf(Number(h[1]), Number(h[2] || 0), h[3]);
    const idx = options.map((o, i) => ({ i, m: local(new Date(o.start), tz).minutes })).filter((x) => x.m === want);
    if (idx.length === 1) return idx[0].i;
  }
  return -1;
}
export const isDecline = (text: string) => /^(no|nop|nel)\b[.!]?$|\b(no gracias|no,? gracias|no me interesa|ahora no|por ahora no|no por ahora|mas adelante|despues te (escribo|aviso|confirmo)|luego te (escribo|aviso|confirmo)|yo te (escribo|aviso|confirmo)|lo (voy a )?pienso|no necesito|no hace falta)\b/.test(norm(text));
export const wantsScheduling = (text: string) => /\b(agend\w*|programar (una |la )?(reunion|cita|llamada)|reunirnos|(una|la|mi) (reunion|cita|videollamada)|hablar con (el|un|una) asesor\w*)\b/.test(norm(text));
export const wantsOther = (text: string) => /\b(no me sirve\w*|ninguno|ninguna|otro dia|otra hora|otros horarios|otras opciones|no puedo (ese|esos|esa|esas)|no me queda\w*)\b/.test(norm(text));
export const wantsCancel = (text: string) => /\b(cancel(ar|a|o)|anular|ya no (puedo|podre)|no (puedo|podre) (asistir|ir|conectarme))\b/.test(norm(text));
export const wantsReschedule = (text: string) => /\b(reprogram|cambiar (la |el )?(cita|reunion|hora|fecha|dia|horario)|mover (la |el )?(cita|reunion|horario)|otro (dia|horario)|otra (hora|fecha))/.test(norm(text));
const isYes = (text: string) => /^(si|sii+|claro|dale|ok|okay|listo|perfecto|de una|me sirve|esta bien|confirmo|acepto|sirve)\b/.test(norm(text));

// ---------------------------------------------------------------- calendario (proveedor)
async function bridge(action: string, payload: Record<string, unknown>, timeoutMs = 9000): Promise<any> {
  const url = await D.cfg("CAL_BRIDGE_URL");
  const secret = await D.cfg("CAL_BRIDGE_SECRET");
  if (!url || !secret) throw new Error("CAL_BRIDGE_NOT_CONFIGURED");
  const r = await fetch(url, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ secret, action, ...payload }), signal: AbortSignal.timeout(timeoutMs) });
  const txt = await r.text();
  let j: any = null;
  try { j = JSON.parse(txt); } catch { throw new Error(`CAL_BRIDGE_BAD_RESPONSE ${r.status}: ${txt.slice(0, 160)}`); }
  if (!j.ok) throw new Error(`CAL_BRIDGE_${j.error || "ERROR"}`);
  return j;
}
const advCalendars = (a: Advisor) => [...new Set([a.calendar_id || "primary", ...a.busy_calendars].filter(Boolean))];

/** Ocupación del asesor: calendario real + citas de SIERRA retenidas/confirmadas. */
async function busyFor(ws: any, c: SchedCfg, a: Advisor, fromIso: string, toIso: string): Promise<Busy[]> {
  const busy: Busy[] = [];
  const nowIso = new Date().toISOString();
  const dbP = D.admin.from("appointments").select("starts_at,ends_at,status,hold_expires_at").eq("workspace_id", ws.id).eq("advisor_key", a.key)
    .in("status", ["hold", "confirmed"]).lt("starts_at", toIso).gt("ends_at", fromIso);
  const calP = c.provider === "google_bridge" ? bridge("freebusy", { calendars: advCalendars(a), timeMin: fromIso, timeMax: toIso, timeZone: c.timezone }) : Promise.resolve(null);
  const [{ data: rows }, cal] = await Promise.all([dbP, calP]);
  for (const r of rows || []) if (r.status === "confirmed" || !r.hold_expires_at || r.hold_expires_at > nowIso) busy.push({ start: Date.parse(r.starts_at), end: Date.parse(r.ends_at) });
  if (cal) for (const id of Object.keys(cal.calendars || {})) {
    const k = cal.calendars[id];
    if (k?.errors?.length) throw new Error(`CAL_NO_ACCESS ${id}`); // calendario no compartido: no se ofrecen horarios a ciegas
    for (const b of k?.busy || []) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
  }
  return busy;
}
/** Espacios libres del asesor en un rango de días. */
export async function availability(ws: any, c: SchedCfg, fromYmd: string, toYmd: string): Promise<Slot[]> {
  const a = c.advisors[0];
  const fromIso = zoned(fromYmd, 0, c.timezone).toISOString();
  const toIso = zoned(addDays(toYmd, 1), 0, c.timezone).toISOString();
  const busy = await busyFor(ws, c, a, fromIso, toIso);
  return freeSlots(c, a.key, busy, fromYmd, toYmd);
}
/** Oferta inicial: mañana/pasado; si no hay suficientes, se amplía hasta max_search_days. */
export async function defaultOffer(ws: any, c: SchedCfg): Promise<Slot[]> {
  const from = firstDay(c);
  let span = Math.max(c.offer_days + 2, 4); // incluye fines de semana intermedios
  let opts: Slot[] = [];
  while (true) {
    const to = addDays(from, Math.min(span, c.max_search_days) - 1);
    opts = pickDefault(c, await availability(ws, c, from, to));
    const daysWithSlots = new Set(opts.map((s) => local(new Date(s.start), c.timezone).ymd)).size;
    if ((daysWithSlots >= c.offer_days && opts.length >= Math.min(c.slots_to_offer, c.per_day * c.offer_days)) || span >= c.max_search_days) break;
    span = Math.min(c.max_search_days, span + 7);
  }
  return opts;
}

// ---------------------------------------------------------------- mensajes
const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
function listSlots(c: SchedCfg, opts: Slot[]): string {
  const out: string[] = [];
  let lastDay = "";
  opts.forEach((s, i) => {
    const d = new Date(s.start);
    const day = fmtDay(d, c.timezone);
    if (day !== lastDay) { out.push((out.length ? "\n" : "") + `*${day}*`); lastDay = day; }
    out.push(`${c.emojis ? NUM[i] : `${i + 1}.`} ${fmtTime(d, c.timezone)}`);
  });
  return out.join("\n");
}
const modalityTxt = (c: SchedCfg) => (c.virtual ? "Google Meet" : c.address ? "presencial" : "");
function offerText(c: SchedCfg, opts: Slot[], intro: string): string {
  const e = c.emojis;
  return `${intro}\n\n${listSlots(c, opts)}\n\nEscríbeme el número del que prefieras. Si te queda mejor otro día u hora, dímelo${e ? " 😊" : "."}`;
}
const meetingDetails = (c: SchedCfg) => [`hora Colombia`, modalityTxt(c), `${c.slot_minutes} min`].filter(Boolean).join(" · ");

// ---------------------------------------------------------------- persistencia del estado
async function loadConv(id: string) { const { data } = await D.admin.from("conversations").select("*").eq("id", id).maybeSingle(); return data; }
async function saveSched(convId: string, sched: any) {
  const conv = await loadConv(convId);
  const st = { ...(conv?.state || {}), scheduling: sched };
  await D.admin.from("conversations").update({ state: st }).eq("id", convId);
}
async function logMsg(ws: string, convId: string, role: "user" | "assistant", content: string, meta: Record<string, unknown> = {}) {
  await D.admin.from("messages").insert({ workspace_id: ws, conversation_id: convId, role, content, metadata: { module: "scheduling", ...meta } });
}
async function claim(key: string, ws: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  const { error } = await D.admin.from("scheduling_log").insert({ key, workspace_id: ws, payload });
  return !error;
}
/** Mensaje directo al cliente por WhatsApp (dentro de la ventana de 24 h). */
async function sendClient(wsRow: any, c: SchedCfg, phone: string, text: string, convId: string | null, meta: Record<string, unknown> = {}) {
  if (convId) await logMsg(wsRow.id, convId, "assistant", text, { pushed: true, ...meta });
  if (c.dry_run) { await D.audit(wsRow.id, "sched_wa_dry_run", "conversation", convId, { to: phone, text }); return { ok: true, dry: true }; }
  const cr = await D.waCreds();
  if (!cr || !phone) return { ok: false };
  const r = await D.waPost(cr, { to: String(phone).replace(/\D/g, ""), type: "text", text: { preview_url: false, body: text } });
  if (!r.ok) await D.audit(wsRow.id, "sched_wa_failed", "conversation", convId, { status: r.status, body: r.body });
  return r;
}

// ---------------------------------------------------------------- contexto del prospecto
async function contextByPhone(ws: string, phone: string) {
  const { data: leads } = await D.admin.from("leads").select("id").eq("workspace_id", ws).eq("phone", phone).limit(50);
  const ids = (leads || []).map((x: any) => x.id);
  if (!ids.length) return null;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: p } = await D.admin.from("proposals").select("id,lead_id,conversation_id,quote,diagnosis,share_token,email_status,created_at")
    .eq("workspace_id", ws).in("lead_id", ids).in("email_status", ["sent", "sending"]).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!p || !p.conversation_id) return null;
  const [{ data: lead }, conv, { data: appt }] = await Promise.all([
    D.admin.from("leads").select("*").eq("id", p.lead_id).single(),
    loadConv(p.conversation_id),
    D.admin.from("appointments").select("*").eq("proposal_id", p.id).in("status", ["hold", "confirmed", "requested", "proposed"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return { proposal: p, lead, conv, appt };
}

// ---------------------------------------------------------------- reserva
type BookResult = { ok: true; appt: any } | { ok: false; reason: "taken" | "busy" | "error"; error?: string };
async function expireHolds(ws: string) {
  await D.admin.from("appointments").update({ status: "expired", updated_at: new Date().toISOString() }).eq("workspace_id", ws).eq("status", "hold").lt("hold_expires_at", new Date().toISOString());
}
function eventDescription(c: SchedCfg, ctx: any, roadmapUrl: string | null) {
  const p = ctx.proposal, l = ctx.lead || {}, q = p.quote || {}, dg = p.diagnosis || {};
  const lines = [
    `Reunión agendada automáticamente por SIERRA.`, ``,
    `👤 ${l.name || "Cliente"}${l.company ? " — " + l.company : ""}`,
    `📱 ${l.phone ? "+" + String(l.phone).replace(/\D/g, "") : "—"}   ✉️ ${l.email || "—"}`,
    `🧩 Servicio: ${q.solucion || "—"}`,
    `🎯 Necesidad: ${dg.qualification?.need || "—"}`,
    `💰 Cotización ${D.quoteCode(p.id)}: ${q.inversion?.display || "—"}`,
    roadmapUrl ? `🗺️ Roadmap: ${roadmapUrl}` : "",
    (dg.missing || []).length ? `❓ Por aclarar: ${(dg.missing || []).slice(0, 4).join("; ")}` : "",
    l.phone ? `💬 WhatsApp: https://wa.me/${String(l.phone).replace(/\D/g, "")}` : "",
  ];
  return lines.filter((x) => x !== "").join("\n");
}
async function roadmapUrlOf(wsRow: any, p: any) {
  const base = String(wsRow.settings?.public_base_url || "").replace(/\/+$/, "");
  return base && p.share_token ? `${base}/p/${p.share_token}` : null;
}
/** Reserva atómica: retiene en BD → re-verifica en el calendario → crea el evento → confirma. */
async function book(wsRow: any, c: SchedCfg, ctx: any, slot: { start: string; end: string; advisor: string }, existingId: string | null = null): Promise<BookResult> {
  const a = c.advisors.find((x) => x.key === slot.advisor) || c.advisors[0];
  await expireHolds(wsRow.id);
  // 1) retención (la restricción de exclusión impide choques; el índice único, dos citas para la misma cotización)
  let appt: any;
  const base = { status: "hold", hold_expires_at: new Date(Date.now() + c.hold_minutes * 60000).toISOString(), starts_at: slot.start, ends_at: slot.end, advisor_key: a.key, updated_at: new Date().toISOString() };
  if (existingId) {
    const { data, error } = await D.admin.from("appointments").update(base).eq("id", existingId).select().single();
    if (error) return { ok: false, reason: error.code === "23P01" ? "taken" : "error", error: error.message };
    appt = data;
  } else {
    const { data, error } = await D.admin.from("appointments").insert({ ...base, workspace_id: wsRow.id, lead_id: ctx.lead?.id, proposal_id: ctx.proposal.id, conversation_id: ctx.proposal.conversation_id, modality: c.virtual ? "virtual" : "presencial", location: c.virtual ? null : c.address }).select().single();
    if (error) return { ok: false, reason: error.code === "23P01" ? "taken" : "error", error: error.message };
    appt = data;
  }
  const fail = async (reason: "busy" | "error", error?: string) => {
    await D.admin.from("appointments").update({ status: "failed", notes: { ...(appt.notes || {}), error: error || reason }, updated_at: new Date().toISOString() }).eq("id", appt.id);
    await D.audit(wsRow.id, "appointment_failed", "appointment", appt.id, { reason, error: error || null });
    return { ok: false as const, reason, error };
  };
  try {
    if (c.provider === "google_bridge") {
      // 2) re-verificación solo de ese espacio (con margen)
      const lo = new Date(Date.parse(slot.start) - c.buffer_minutes * 60000).toISOString();
      const hi = new Date(Date.parse(slot.end) + c.buffer_minutes * 60000).toISOString();
      const fb = await bridge("freebusy", { calendars: advCalendars(a), timeMin: lo, timeMax: hi, timeZone: c.timezone });
      const taken = Object.values(fb.calendars || {}).some((k: any) => (k?.busy || []).length > 0 || (k?.errors || []).length > 0);
      if (taken) return await fail("busy");
      // 3) evento real con Meet e invitación al cliente
      const l = ctx.lead || {};
      const attendees = [...new Set([l.email, ...a.invite_emails].filter((x: string) => x && /@/.test(x)))];
      const ev = await bridge("create_event", {
        calendarId: a.calendar_id || "primary",
        eventId: "sierra" + String(appt.id).replace(/-/g, ""),
        summary: `${c.meeting_title}: ${l.name || "Cliente"}${l.company ? " (" + l.company + ")" : ""} — ${ctx.proposal.quote?.solucion || c.company}`,
        description: eventDescription(c, ctx, await roadmapUrlOf(wsRow, ctx.proposal)),
        start: slot.start, end: slot.end, timeZone: c.timezone,
        attendees, meet: c.virtual, location: c.virtual ? null : c.address,
      }, 15000);
      const { data: done } = await D.admin.from("appointments").update({ status: "confirmed", hold_expires_at: null, calendar_event_id: ev.id, calendar_link: ev.htmlLink || null, meet_url: ev.meetUrl || null, updated_at: new Date().toISOString() }).eq("id", appt.id).select().single();
      appt = done;
    } else {
      const { data: done } = await D.admin.from("appointments").update({ status: "confirmed", hold_expires_at: null, updated_at: new Date().toISOString() }).eq("id", appt.id).select().single();
      appt = done;
    }
  } catch (e) {
    return await fail("error", (e as Error)?.message || String(e));
  }
  await D.audit(wsRow.id, "appointment_confirmed", "appointment", appt.id, { proposal_id: ctx.proposal.id, starts_at: appt.starts_at, provider: c.provider, meet: !!appt.meet_url });
  bg(notifyAdvisorBooked(wsRow, c, ctx, appt));
  return { ok: true, appt };
}
function confirmText(c: SchedCfg, appt: any, lead: any) {
  const d = new Date(appt.starts_at), e = c.emojis;
  const where = appt.meet_url ? `${e ? "💻 " : ""}Google Meet: ${appt.meet_url}` : appt.location ? `${e ? "📍 " : ""}${appt.location}` : c.virtual ? `${e ? "💻 " : ""}El enlace de la videollamada llegará a tu correo.` : "";
  const mail = lead?.email && c.provider === "google_bridge" ? `\nTe envié la invitación a ${lead.email} para que quede en tu calendario.` : "";
  return `${e ? "✅ " : ""}¡Reunión confirmada!\n${e ? "📅 " : ""}${fmtDay(d, c.timezone)}, ${fmtTime(d, c.timezone)} (hora Colombia, ${c.slot_minutes} min)\n${where}${mail}\n\nSi necesitas cambiarla, escríbeme por aquí.`;
}
async function notifyAdvisorBooked(wsRow: any, c: SchedCfg, ctx: any, appt: any) {
  if (c.dry_run) { await D.audit(wsRow.id, "sched_advisor_dry_run", "appointment", appt.id, { kind: "booked" }); return; }
  const d = new Date(appt.starts_at);
  const head = `📅 Reunión agendada: ${fmtFull(d, c.timezone)}`;
  const p = ctx.proposal, l = ctx.lead || {}, q = p.quote || {};
  const rm = await roadmapUrlOf(wsRow, p);
  await Promise.allSettled([
    D.waAdvisor(wsRow, p, l, head + (appt.meet_url ? ` · Meet: ${appt.meet_url}` : "")),
    D.mailAdvisor(wsRow, `📅 ${l.name || "Cliente"} agendó reunión — ${fmtFull(d, c.timezone)} (${D.quoteCode(p.id)})`,
      fichaHtml(c, ctx, `📅 Reunión agendada`, `<b>${D.escH(fmtFull(d, c.timezone))}</b> (hora Colombia, ${c.slot_minutes} min) · ${appt.meet_url ? `<a href="${D.escH(appt.meet_url)}">Google Meet</a>` : D.escH(appt.location || "virtual")}${appt.calendar_link ? ` · <a href="${D.escH(appt.calendar_link)}">Ver en calendario</a>` : ""}`, rm, q)),
  ]);
}
function fichaHtml(c: SchedCfg, ctx: any, title: string, when: string, rm: string | null, q: any, extra = "") {
  const p = ctx.proposal, l = ctx.lead || {}, dg = p.diagnosis || {}, E = D.escH;
  const wa = l.phone ? `https://wa.me/${String(l.phone).replace(/\D/g, "")}` : null;
  const row = (k: string, v: string) => `<tr><td style="padding:4px 10px 4px 0;color:#5b6478;white-space:nowrap">${k}</td><td style="padding:4px 0">${v}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;color:#14213d"><div style="background:#22a6ff;color:#031226;padding:16px 20px;border-radius:12px 12px 0 0;font-size:20px;font-weight:700">${E(title)}</div><div style="border:1px solid #e5e7eb;border-top:0;padding:18px 20px;border-radius:0 0 12px 12px;font-size:15px;line-height:1.55"><p style="margin:0 0 12px">${when}</p><table style="border-collapse:collapse;font-size:14px">${[
    row("Cliente", E(l.name || "—") + (l.company ? " — " + E(l.company) : "")),
    row("WhatsApp", l.phone ? "+" + E(String(l.phone).replace(/\D/g, "")) : "—"),
    row("Correo", E(l.email || "—")),
    row("Servicio", E(q.solucion || "—")),
    row("Necesidad", E(dg.qualification?.need || "—")),
    row("Cotización", `${E(D.quoteCode(p.id))} · ${E(q.inversion?.display || "—")}`),
    rm ? row("Roadmap", `<a href="${E(rm)}">Ver roadmap del cliente</a>`) : "",
    (dg.missing || []).length ? row("Por aclarar", E((dg.missing || []).slice(0, 4).join("; "))) : "",
    ctx.conv?.summary ? row("Resumen", E(ctx.conv.summary)) : "",
  ].join("")}</table>${extra}${wa ? `<p style="margin:16px 0 0"><a href="${wa}" style="background:#25d366;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600">Escribirle por WhatsApp</a></p>` : ""}</div></div>`;
}

// ---------------------------------------------------------------- solicitud especial (fuera de agenda)
const citaCode = (appt: any) => "CITA-" + String(appt.action_token || "").replace(/-/g, "").slice(0, 4).toUpperCase();
/** Suma horas hábiles (dentro de la agenda) a partir de ahora. */
export function businessDeadline(c: SchedCfg, hours: number, now = new Date()): Date {
  let left = hours * 60;
  let day = local(now, c.timezone).ymd;
  let cursor = now.getTime();
  for (let i = 0; i < 30 && left > 0; i++, day = addDays(day, 1)) {
    if (!c.work_days.includes(dowOf(day))) continue;
    for (const [a, b] of c.work_hours) {
      const s = Math.max(zoned(day, hm(a), c.timezone).getTime(), cursor), e = zoned(day, hm(b), c.timezone).getTime();
      if (e <= s) continue;
      const take = Math.min(left, (e - s) / 60000);
      left -= take; cursor = s + take * 60000;
      if (left <= 0) return new Date(cursor);
    }
  }
  return new Date(cursor);
}
async function createSpecialRequest(wsRow: any, c: SchedCfg, ctx: any, start: Date) {
  const a = c.advisors[0];
  await D.admin.from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("proposal_id", ctx.proposal.id).in("status", ["requested", "proposed", "hold"]);
  const end = new Date(start.getTime() + c.slot_minutes * 60000);
  const respondBy = businessDeadline(c, c.respond_within_hours);
  const { data: appt, error } = await D.admin.from("appointments").insert({
    workspace_id: wsRow.id, lead_id: ctx.lead?.id, proposal_id: ctx.proposal.id, conversation_id: ctx.proposal.conversation_id,
    advisor_key: a.key, starts_at: start.toISOString(), ends_at: end.toISOString(), status: "requested", respond_by: respondBy.toISOString(),
    modality: c.virtual ? "virtual" : "presencial", notes: { requested_text: fmtFull(start, c.timezone) },
  }).select().single();
  if (error) throw new Error(error.message);
  await D.audit(wsRow.id, "appointment_requested", "appointment", appt.id, { starts_at: appt.starts_at, respond_by: appt.respond_by });
  bg(notifyAdvisorRequest(wsRow, c, ctx, appt));
  return appt;
}
async function notifyAdvisorRequest(wsRow: any, c: SchedCfg, ctx: any, appt: any, reminder = false) {
  if (c.dry_run) { await D.audit(wsRow.id, "sched_advisor_dry_run", "appointment", appt.id, { kind: reminder ? "request_reminder" : "request" }); return; }
  const d = new Date(appt.starts_at), code = citaCode(appt);
  const accept = `${D.SB_URL}/functions/v1/ci-agent?sched=${appt.action_token}&do=accept`;
  const decline = `${D.SB_URL}/functions/v1/ci-agent?sched=${appt.action_token}&do=decline`;
  const propose = c.bot_whatsapp ? `https://wa.me/${c.bot_whatsapp}?text=${encodeURIComponent(`PROPONGO ${code} `)}` : null;
  const limit = fmtFull(new Date(appt.respond_by), c.timezone);
  const head = `${reminder ? "⏰ RECORDATORIO — " : ""}🙋 Solicitud de horario especial ${code}: ${fmtFull(d, c.timezone)}. Responde antes de ${limit}. Escribe a SIERRA "ACEPTO ${code}" o "PROPONGO ${code} jueves 3 pm"`;
  const q = ctx.proposal.quote || {};
  const rm = await roadmapUrlOf(wsRow, ctx.proposal);
  const btn = (href: string, label: string, bgc: string) => `<a href="${href}" style="display:inline-block;margin:6px 8px 0 0;background:${bgc};color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600">${label}</a>`;
  const extra = `<p style="margin:16px 0 4px">${btn(accept, "✅ Acepto este horario", "#16a34a")}${btn(decline, "No puedo", "#6b7280")}${propose ? btn(propose, "Proponer otro horario (WhatsApp)", "#22a6ff") : ""}</p><p style="font-size:12px;color:#5b6478">También puedes escribirle a SIERRA por WhatsApp: <b>ACEPTO ${code}</b> o <b>PROPONGO ${code} jueves 3 pm</b>. Si no respondes antes de ${D.escH(limit)}, SIERRA le ofrecerá al cliente los espacios libres más cercanos.</p>`;
  await Promise.allSettled([
    D.waAdvisor(wsRow, ctx.proposal, ctx.lead || {}, head),
    D.mailAdvisor(wsRow, `${reminder ? "⏰ Recordatorio: " : ""}🙋 ${ctx.lead?.name || "Cliente"} pide reunión fuera de agenda — ${fmtFull(d, c.timezone)} (${code})`,
      fichaHtml(c, ctx, "🙋 Solicitud de horario especial", `El cliente pidió <b>${D.escH(fmtFull(d, c.timezone))}</b> (fuera de la agenda habitual). Le dijimos que le confirmamos antes de <b>${D.escH(limit)}</b>.`, rm, q, extra)),
  ]);
}

// ---------------------------------------------------------------- oferta después de enviar la cotización
/** Se llama cuando el correo de la cotización salió. Envía los horarios por WhatsApp (una sola vez por cotización). */
export async function offerAfterQuote(wsRow: any, proposalId: string, delayMs: number) {
  const c = schedCfg(wsRow);
  if (!c) return;
  const t0 = Date.now();
  const { data: p } = await D.admin.from("proposals").select("id,lead_id,conversation_id,quote,diagnosis,share_token").eq("id", proposalId).single();
  const { data: lead } = await D.admin.from("leads").select("*").eq("id", p.lead_id).single();
  if (!lead?.phone || !p.conversation_id) return;
  let opts: Slot[] = [];
  try { opts = await defaultOffer(wsRow, c); } catch (e) { await D.audit(wsRow.id, "sched_offer_error", "proposal", p.id, { error: (e as Error)?.message }); }
  const wait = delayMs - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  if (!(await claim(`offer:${p.id}`, wsRow.id, { delay: delayMs }))) return; // ya se ofreció
  const e = c.emojis;
  let text: string;
  if (opts.length) {
    text = offerText(c, opts, `${e ? "📅 " : ""}Si quieres resolver dudas con un asesor, agenda tu reunión ahora (${meetingDetails(c)}):`);
    await saveSched(p.conversation_id, { step: "offered", options: opts, offered_at: new Date().toISOString(), round: 1, proposal_id: p.id });
  } else {
    text = `${e ? "📅 " : ""}Si quieres resolver dudas con un asesor, escríbeme *agendar* y te muestro los horarios disponibles.`;
    await saveSched(p.conversation_id, { step: "idle", proposal_id: p.id });
  }
  await sendClient(wsRow, c, lead.phone, text, p.conversation_id, { kind: "offer" });
  await D.audit(wsRow.id, "sched_offered", "proposal", p.id, { options: opts.length, ms: Date.now() - t0 });
}

// ---------------------------------------------------------------- interceptor de la conversación
export type Turn = { reply: string; conversation_id: string; lead: any };
/**
 * Se ejecuta al inicio de cada mensaje de WhatsApp. Devuelve una respuesta si el mensaje es del agendamiento;
 * null para que la conversación siga su flujo normal (IA).
 */
export async function handleTurn(wsRow: any, phone: string, message: string): Promise<Turn | null> {
  const c = schedCfg(wsRow);
  if (!c || !phone) return null;
  const ctx = await contextByPhone(wsRow.id, phone);
  if (!ctx) return null;
  const sched = ctx.conv?.state?.scheduling || {};
  const offerFresh = sched.offered_at && Date.now() - Date.parse(sched.offered_at) < 3 * 86400000;
  const active = ["offered", "ask_time", "proposed", "special_pending"].includes(sched.step) && (offerFresh || sched.step === "special_pending" || sched.step === "proposed");
  const appt = ctx.appt;
  const kw = wantsScheduling(message), cancel = wantsCancel(message), resch = wantsReschedule(message);
  if (!active && !kw && !(appt && (cancel || resch))) return null;

  const ws = wsRow.id, convId = ctx.proposal.conversation_id, e = c.emojis, tz = c.timezone;
  const t0 = Date.now();
  await logMsg(ws, convId, "user", message);
  const reply = async (text: string, next: any | null, meta: Record<string, unknown> = {}) => {
    if (next !== null) await saveSched(convId, { ...next, proposal_id: ctx.proposal.id });
    await logMsg(ws, convId, "assistant", text, meta);
    await D.audit(ws, "sched_turn", "conversation", convId, { ms: Date.now() - t0, step: next?.step ?? sched.step, ...meta });
    return { reply: text, conversation_id: convId, lead: { phone } };
  };
  const offer = async (opts: Slot[], intro: string, round: number) => {
    if (!opts.length) return null;
    return await reply(offerText(c, opts, intro), { step: "offered", options: opts, offered_at: new Date().toISOString(), round });
  };
  const pendingId = appt && ["requested", "proposed", "hold"].includes(appt.status) ? appt.id : null;
  const tryBook = async (slot: Slot, existingId: string | null = pendingId) => {
    // si el calendario se demora, se responde "confirmando…" y la confirmación llega por WhatsApp apenas exista el evento
    const job = book(wsRow, c, ctx, slot, existingId);
    const quick = await Promise.race([job, sleep(8000).then(() => null)]);
    if (quick === null) {
      bg((async () => {
        const r = await job;
        const txt = r.ok ? confirmText(c, r.appt, ctx.lead) : `Lo siento, ese horario acaba de ocuparse o no pude confirmarlo. Escríbeme *agendar* y te muestro nuevas opciones.`;
        await saveSched(convId, r.ok ? { step: "confirmed", appointment_id: r.appt.id, proposal_id: ctx.proposal.id } : { step: "idle", proposal_id: ctx.proposal.id });
        await sendClient(wsRow, c, phone, txt, convId, { kind: r.ok ? "confirm_late" : "fail_late" });
      })());
      return await reply(`${e ? "⏳ " : ""}Estoy confirmando tu reunión con el asesor, dame unos segundos…`, { step: "booking" }, { slow: true });
    }
    const r = quick as BookResult;
    if (r.ok) return await reply(confirmText(c, r.appt, ctx.lead), { step: "confirmed", appointment_id: r.appt.id }, { booked: true });
    // ocupado o error: nunca se confirma; se ofrecen nuevas opciones reales
    let opts: Slot[] = [];
    try { opts = (await defaultOffer(wsRow, c)).filter((s) => s.start !== slot.start); } catch (_) { /* calendario no disponible */ }
    const why = r.reason === "error" ? "No pude confirmar ese horario en el calendario en este momento." : "Ese horario acaba de ocuparse.";
    return (await offer(opts, `${why} Estos son los espacios disponibles ahora:`, (sched.round || 1) + 1))
      || await reply(`${why} Ya le avisé al asesor para que te contacte y acuerden la hora.`, { step: "idle" }, { error: r.error || r.reason });
  };

  try {
    // ---- cita existente: cambiar / cancelar
    if (appt && appt.status === "confirmed" && (cancel || resch || (kw && !active))) {
      if (!cancel && !resch) {
        const d = new Date(appt.starts_at);
        return await reply(`Ya tienes tu reunión agendada para el *${fmtFull(d, tz)}*${appt.meet_url ? ` (Meet: ${appt.meet_url})` : ""}. ¿Quieres cambiarla? Escríbeme *cambiar* o *cancelar*.`, null);
      }
      if (c.provider === "google_bridge" && appt.calendar_event_id) {
        try { await bridge("cancel_event", { calendarId: (c.advisors.find((x) => x.key === appt.advisor_key) || c.advisors[0]).calendar_id || "primary", eventId: appt.calendar_event_id }); }
        catch (err) { await D.audit(ws, "sched_cancel_error", "appointment", appt.id, { error: (err as Error)?.message }); }
      }
      await D.admin.from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", appt.id);
      await D.audit(ws, "appointment_cancelled", "appointment", appt.id, { by: "client", reschedule: resch && !cancel });
      if (!c.dry_run) bg(D.mailAdvisor(wsRow, `❌ ${ctx.lead?.name || "Cliente"} ${resch && !cancel ? "reprogramó" : "canceló"} su reunión del ${fmtFull(new Date(appt.starts_at), tz)} (${D.quoteCode(ctx.proposal.id)})`, `<p>${D.escH(ctx.lead?.name || "El cliente")} ${resch && !cancel ? "pidió cambiar" : "canceló"} la reunión del <b>${D.escH(fmtFull(new Date(appt.starts_at), tz))}</b>. El evento se retiró del calendario.</p>`));
      if (cancel && !resch) return await reply(`Listo, cancelé tu reunión del ${fmtFull(new Date(appt.starts_at), tz)}. Cuando quieras agendar otra, escríbeme *agendar*.`, { step: "idle" });
      const pref = parsePref(message, c);
      const opts = pref ? await prefOptions(wsRow, c, pref) : await defaultOffer(wsRow, c);
      return (await offer(opts.slice(0, c.slots_to_offer), `Listo, liberé tu horario anterior. Estos son los espacios disponibles (${meetingDetails(c)}):`, 1))
        || await reply(`Listo, liberé tu horario anterior. En este momento no veo espacios disponibles; ya le avisé al asesor para que te contacte.`, { step: "idle" });
    }

    // ---- el asesor propuso un horario: el cliente acepta o pide otro
    if (sched.step === "proposed" && sched.appointment_id) {
      if (isYes(message)) {
        const { data: ap } = await D.admin.from("appointments").select("*").eq("id", sched.appointment_id).single();
        return await tryBook({ start: ap.starts_at, end: ap.ends_at, advisor: ap.advisor_key }, ap.id);
      }
      if (isDecline(message)) {
        await D.admin.from("appointments").update({ status: "declined", updated_at: new Date().toISOString() }).eq("id", sched.appointment_id);
        return await reply(`Entendido. Cuando quieras retomar, escríbeme *agendar* y buscamos otro horario.`, { step: "idle" });
      }
    }

    // ---- solicitud especial: falta la hora
    if (sched.step === "ask_time") {
      const pref = parsePref(message, c) || {};
      const date = (pref.dates || [])[0] || sched.date;
      const mins = pref.exact ?? pref.after ?? null;
      if (date && mins != null) return await special(new Date(zoned(date, mins, tz)));
    }

    // ---- elección de un horario ofrecido
    if (sched.step === "offered" && Array.isArray(sched.options) && sched.options.length) {
      const i = parseChoice(message, sched.options, tz);
      if (i >= 0) return await tryBook(sched.options[i]);
    }

    // ---- no le interesa ahora
    if (active && isDecline(message)) {
      return await reply(`Entendido${ctx.lead?.name ? ", " + String(ctx.lead.name).split(" ")[0] : ""}. Cuando quieras agendar la reunión con el asesor, escríbeme *agendar* por este chat.`, { step: "declined" }, { declined: true });
    }

    // ---- no le sirven las opciones pero no dijo cuándo
    if (active && wantsOther(message) && !parsePref(message, c)) {
      return await reply(`Claro, buscamos otro horario. ¿Qué día y franja te quedan mejor? Por ejemplo: *el martes en la tarde* o *la próxima semana en la mañana*.`, { ...sched, step: "offered", options: sched.options || [], offered_at: new Date().toISOString() });
    }

    // ---- preferencia ("el martes en la tarde", "después de las 4", "la otra semana")
    const pref = parsePref(message, c);
    if (pref) {
      if (pref.sameDay && (pref.dates || []).length === 1) {
        const opts = await defaultOffer(wsRow, c);
        return (await offer(opts, `Para preparar bien la reunión agendamos desde el día siguiente. Estos son los espacios más cercanos (${meetingDetails(c)}):`, (sched.round || 1) + 1))
          || await reply(`Para preparar bien la reunión agendamos desde el día siguiente. ¿Qué día te queda bien?`, { step: "offered", options: [], offered_at: new Date().toISOString() });
      }
      if (outsideAgenda(c, pref)) {
        const date = (pref.dates || [])[0];
        const mins = pref.exact ?? (pref.after != null && pref.after > 0 ? pref.after : null) ?? (pref.part === "eve" ? 18 * 60 : null);
        if (date && mins != null) return await special(zoned(date, mins, tz));
        if (date) return await reply(`Ese día está fuera de la agenda habitual, pero puedo consultarlo con el asesor. ¿A qué hora te quedaría bien?`, { step: "ask_time", date, offered_at: new Date().toISOString(), options: sched.options || [] });
      }
      const opts = await prefOptions(wsRow, c, pref);
      if (opts.length) {
        const exactHit = matchPref(c, opts, pref).length > 0;
        const intro = exactHit ? `Claro. Estos son los espacios que tengo:` : `En ese horario no tengo espacio. Lo más cercano es:`;
        return (await offer(opts, intro, (sched.round || 1) + 1))!;
      }
      return await reply(`No encuentro espacios en las próximas dos semanas con esa preferencia. Si quieres, se lo consulto directamente al asesor: dime el día y la hora que te sirven.`, { step: "offered", options: [], offered_at: new Date().toISOString() });
    }

    // ---- pidió agendar (palabra clave o botón del correo)
    if (kw || /quiero agendar/.test(norm(message))) {
      const opts = await defaultOffer(wsRow, c);
      return (await offer(opts, `${e ? "📅 " : ""}¡Con gusto! Estos son los espacios disponibles para tu reunión con el asesor (${meetingDetails(c)}):`, 1))
        || await reply(`En los próximos días no veo espacios libres en la agenda. Dime qué día y hora te sirven y se lo consulto al asesor.`, { step: "offered", options: [], offered_at: new Date().toISOString() });
    }
  } catch (err) {
    await D.audit(ws, "sched_error", "conversation", convId, { error: (err as Error)?.message || String(err) });
    return await reply(`Tuve un problema consultando la agenda en este momento. Ya le avisé al asesor para que te contacte y acuerden la reunión.`, null, { error: (err as Error)?.message });
  }
  // Mensaje que no es del agendamiento (p. ej. una pregunta sobre el servicio): sigue el flujo normal.
  return null;

  async function special(start: Date) {
    if (start.getTime() < zoned(firstDay(c!), 0, tz).getTime()) {
      return await reply(`Para preparar bien la reunión agendamos desde el día siguiente. ¿Qué otro día te sirve?`, null);
    }
    const ap = await createSpecialRequest(wsRow, c!, ctx!, start);
    return await reply(`Ese horario (${fmtFull(start, tz)}) está fuera de la agenda habitual, pero ya se lo solicité al asesor. ${e ? "🙌 " : ""}Te confirmo por aquí antes de *${fmtFull(new Date(ap.respond_by), tz)}*.`, { step: "special_pending", appointment_id: ap.id }, { special: true });
  }
}
async function prefOptions(wsRow: any, c: SchedCfg, pref: Pref): Promise<Slot[]> {
  const first = firstDay(c);
  const from = [pref.from, ...(pref.dates || [])].filter(Boolean).sort()[0] as string | undefined;
  const start = from && from > first ? from : first;
  const all = await availability(wsRow, c, first, addDays(first, c.max_search_days - 1));
  const hit = matchPref(c, all.filter((s) => local(new Date(s.start), c.timezone).ymd >= start), pref);
  const take = (list: Slot[]) => {
    const out: Slot[] = []; const perDay = new Map<string, number>();
    for (const s of list) { const d = local(new Date(s.start), c.timezone).ymd; const n = perDay.get(d) || 0; if (n >= 3) continue; perDay.set(d, n + 1); out.push(s); if (out.length >= 3) break; }
    return out;
  };
  if (hit.length) return take(hit);
  // lo más cercano a lo que pidió: misma franja otro día, o el primer espacio desde esa fecha
  const relaxed = matchPref(c, all.filter((s) => local(new Date(s.start), c.timezone).ymd >= start), { part: pref.part, after: pref.after, before: pref.before });
  return take(relaxed.length ? relaxed : all.filter((s) => local(new Date(s.start), c.timezone).ymd >= start));
}

// ---------------------------------------------------------------- respuestas del asesor
/** El asesor le escribe a SIERRA: "ACEPTO CITA-AB12" o "PROPONGO CITA-AB12 jueves 3 pm". */
export async function handleAdvisorCommand(wsRow: any, message: string): Promise<string | null> {
  const c = schedCfg(wsRow);
  if (!c) return null;
  const t = norm(message);
  const m = t.match(/^(acepto|aceptar|confirmo|propongo|no puedo|rechazo)\b\s*(cita-?\s*([0-9a-f]{4}))?\s*(.*)$/);
  if (!m) return null;
  const { data: pend } = await D.admin.from("appointments").select("*").eq("workspace_id", wsRow.id).in("status", ["requested"]).order("created_at", { ascending: false }).limit(20);
  const list = (pend || []).filter((a: any) => !m[3] || String(a.action_token).replace(/-/g, "").slice(0, 4) === m[3]);
  if (!list.length) return m[3] ? `No encontré una solicitud pendiente con el código CITA-${m[3].toUpperCase()}.` : null;
  if (list.length > 1) return `Tienes ${list.length} solicitudes pendientes: ${list.map((a: any) => `${citaCode(a)} (${fmtFull(new Date(a.starts_at), c.timezone)})`).join(", ")}. Indica el código, por ejemplo: ACEPTO ${citaCode(list[0])}.`;
  const ap = list[0];
  if (/^(acepto|aceptar|confirmo)$/.test(m[1])) { const r = await advisorAccept(wsRow, c, ap); return r; }
  if (/^(no puedo|rechazo)$/.test(m[1])) return await advisorDecline(wsRow, c, ap);
  const pref = parsePref(m[4] || "", c);
  const date = pref?.dates?.[0], mins = pref?.exact ?? pref?.after;
  if (!date || mins == null) return `Para proponer otro horario escribe el día y la hora, por ejemplo: PROPONGO ${citaCode(ap)} jueves 3 pm.`;
  return await advisorPropose(wsRow, c, ap, zoned(date, mins, c.timezone));
}
async function ctxForAppt(ap: any) {
  const { data: p } = await D.admin.from("proposals").select("id,lead_id,conversation_id,quote,diagnosis,share_token").eq("id", ap.proposal_id).single();
  const { data: lead } = await D.admin.from("leads").select("*").eq("id", p.lead_id).single();
  return { proposal: p, lead, conv: await loadConv(p.conversation_id), appt: ap };
}
async function advisorAccept(wsRow: any, c: SchedCfg, ap: any): Promise<string> {
  const ctx = await ctxForAppt(ap);
  const r = await book(wsRow, c, ctx, { start: ap.starts_at, end: ap.ends_at, advisor: ap.advisor_key }, ap.id);
  if (!r.ok) {
    await D.admin.from("appointments").update({ status: "requested" }).eq("id", ap.id); // sigue pendiente
    return r.reason === "error" ? `No pude crear el evento en el calendario (${r.error || "error"}). Intenta de nuevo en un momento.` : `Ese horario ya está ocupado en tu calendario. Propón otro: PROPONGO ${citaCode(ap)} jueves 3 pm.`;
  }
  await saveSched(ctx.proposal.conversation_id, { step: "confirmed", appointment_id: ap.id, proposal_id: ctx.proposal.id });
  await sendClient(wsRow, c, ctx.lead.phone, `${c.emojis ? "🙌 " : ""}¡Buenas noticias! El asesor aceptó tu horario.\n\n` + confirmText(c, r.appt, ctx.lead), ctx.proposal.conversation_id, { kind: "special_accepted" });
  return `✅ Listo. Reunión confirmada con ${ctx.lead?.name || "el cliente"} el ${fmtFull(new Date(ap.starts_at), c.timezone)}. Ya le avisé y quedó en tu calendario.`;
}
async function advisorDecline(wsRow: any, c: SchedCfg, ap: any): Promise<string> {
  const ctx = await ctxForAppt(ap);
  await D.admin.from("appointments").update({ status: "declined", updated_at: new Date().toISOString() }).eq("id", ap.id);
  let opts: Slot[] = [];
  try { opts = await defaultOffer(wsRow, c); } catch (_) { /* sin calendario */ }
  const txt = opts.length
    ? offerText(c, opts, `El asesor no tiene disponible ese horario, pero estos espacios sí (${meetingDetails(c)}):`)
    : `El asesor no tiene disponible ese horario. Dime otro día y hora que te sirvan y se lo consulto.`;
  await saveSched(ctx.proposal.conversation_id, opts.length ? { step: "offered", options: opts, offered_at: new Date().toISOString(), round: 2, proposal_id: ctx.proposal.id } : { step: "offered", options: [], offered_at: new Date().toISOString(), proposal_id: ctx.proposal.id });
  await sendClient(wsRow, c, ctx.lead.phone, txt, ctx.proposal.conversation_id, { kind: "special_declined" });
  return `Entendido. Le ofrecí al cliente los espacios disponibles de tu agenda.`;
}
async function advisorPropose(wsRow: any, c: SchedCfg, ap: any, start: Date): Promise<string> {
  const ctx = await ctxForAppt(ap);
  const end = new Date(start.getTime() + c.slot_minutes * 60000);
  await D.admin.from("appointments").update({ status: "proposed", starts_at: start.toISOString(), ends_at: end.toISOString(), updated_at: new Date().toISOString() }).eq("id", ap.id);
  await saveSched(ctx.proposal.conversation_id, { step: "proposed", appointment_id: ap.id, offered_at: new Date().toISOString(), proposal_id: ctx.proposal.id });
  await sendClient(wsRow, c, ctx.lead.phone, `El asesor te propone reunirse el *${fmtFull(start, c.timezone)}* (hora Colombia). ¿Te sirve? Responde *SÍ* para confirmarla o dime otra opción.`, ctx.proposal.conversation_id, { kind: "advisor_proposal" });
  return `✅ Le propuse al cliente el ${fmtFull(start, c.timezone)}. Te aviso cuando confirme.`;
}
/** Enlaces del correo del asesor (Acepto / No puedo). Devuelve a dónde redirigir. */
export async function handleAdvisorLink(token: string, action: string): Promise<string> {
  const { data: ap } = await D.admin.from("appointments").select("*").eq("action_token", token).maybeSingle();
  if (!ap) return "https://wa.me/";
  const { data: wsRow } = await D.admin.from("workspaces").select("*").eq("id", ap.workspace_id).single();
  const c = schedCfg(wsRow);
  const back = c?.bot_whatsapp ? `https://wa.me/${c.bot_whatsapp}` : "https://wa.me/";
  if (!c || ap.status !== "requested") return ap.calendar_link || back;
  const msg = action === "accept" ? await advisorAccept(wsRow, c, ap) : await advisorDecline(wsRow, c, ap);
  await D.audit(wsRow.id, "sched_advisor_link", "appointment", ap.id, { action, result: msg.slice(0, 160) });
  const { data: after } = await D.admin.from("appointments").select("calendar_link").eq("id", ap.id).single();
  return after?.calendar_link || back;
}

// ---------------------------------------------------------------- tareas periódicas (cron cada 10 min)
export async function tick(): Promise<Record<string, number>> {
  const out = { expired_holds: 0, reminders: 0 };
  const nowIso = new Date().toISOString();
  const { data: ex } = await D.admin.from("appointments").update({ status: "expired" }).eq("status", "hold").lt("hold_expires_at", nowIso).select("id");
  out.expired_holds = (ex || []).length;
  // Solicitudes especiales vencidas: recordatorio al asesor + espacios cercanos al cliente (una sola vez).
  const { data: due } = await D.admin.from("appointments").select("*").eq("status", "requested").lt("respond_by", nowIso).limit(20);
  for (const ap of due || []) {
    if (!(await claim(`overdue:${ap.id}`, ap.workspace_id))) continue;
    const { data: wsRow } = await D.admin.from("workspaces").select("*").eq("id", ap.workspace_id).single();
    const c = schedCfg(wsRow);
    if (!c) continue;
    const ctx = await ctxForAppt(ap);
    await notifyAdvisorRequest(wsRow, c, ctx, ap, true);
    // ¿el cliente escribió en las últimas 23 h? (ventana gratuita de WhatsApp)
    const { data: lastU } = await D.admin.from("messages").select("created_at").eq("conversation_id", ctx.proposal.conversation_id).eq("role", "user").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const inWindow = lastU && Date.now() - Date.parse(lastU.created_at) < 23 * 3600000;
    let opts: Slot[] = [];
    try { opts = await defaultOffer(wsRow, c); } catch (_) { /* noop */ }
    if (inWindow && opts.length) {
      await saveSched(ctx.proposal.conversation_id, { step: "offered", options: opts, offered_at: new Date().toISOString(), round: 2, proposal_id: ctx.proposal.id, special_appointment_id: ap.id });
      await sendClient(wsRow, c, ctx.lead.phone, offerText(c, opts, `El asesor aún no confirma el horario que pediste; sigue en revisión. Mientras tanto, para no hacerte esperar, estos son los espacios libres más cercanos (${meetingDetails(c)}):`), ctx.proposal.conversation_id, { kind: "special_overdue" });
    }
    await D.audit(ap.workspace_id, "sched_special_overdue", "appointment", ap.id, { offered_client: !!(inWindow && opts.length) });
    out.reminders++;
  }
  return out;
}
