// SIERRA — Cierre por WhatsApp (v1, 2026-10-15)
// Para negocios donde el dueño cierra personalmente (p. ej. WIA): después de enviar la cotización y el roadmap,
// SIERRA invita al cliente a escribirle directamente al asesor por su WhatsApp Business, con un mensaje ya escrito
// (nombre, servicio y código de cotización). No usa calendario. Independiente del módulo de agendamiento.
// Se activa por empresa con workspaces.settings.handoff = { enabled: true, name, whatsapp }.
// Si una empresa tiene activo el agendamiento (settings.scheduling.enabled), este módulo no actúa.

// deno-lint-ignore-file no-explicit-any
type Deps = {
  admin: any;
  audit: (ws: string, type: string, entity: string, id: string | null, payload: Record<string, unknown>) => Promise<void>;
  waCreds: () => Promise<{ token: string; phoneId: string } | null>;
  waPost: (c: { token: string; phoneId: string }, payload: any) => Promise<{ ok: boolean; status: number; body: string }>;
  quoteCode: (id: string) => string;
};
let D: Deps;
export function initHandoff(d: Deps) { D = d; }

export type HandoffCfg = { name: string; whatsapp: string; emojis: boolean; dry_run: boolean; delay_ms: number };
export function handoffCfg(ws: any): HandoffCfg | null {
  const s = ws?.settings || {};
  const h = s.handoff || {};
  if (h.enabled !== true || s.scheduling?.enabled === true) return null;
  const whatsapp = String(h.whatsapp || s.advisor?.whatsapp || "").replace(/\D/g, "");
  if (!whatsapp) return null;
  return { name: String(h.name || s.advisor?.name || s.owner_name || "nuestro asesor"), whatsapp, emojis: s.use_emojis !== false, dry_run: h.dry_run === true, delay_ms: Number(h.delay_ms) || 0 };
}

const first = (n: unknown) => String(n || "").trim().split(/\s+/)[0] || "";

/** Texto que verá el cliente (exportado para pruebas). */
export function handoffText(c: HandoffCfg, lead: any, quote: any, code: string): string {
  const pre = `Hola ${first(c.name)}, soy ${lead?.name || "un cliente"}. Recibí la cotización de ${quote?.solucion || "sus servicios"} (${code}) y quiero avanzar.`;
  const link = `https://wa.me/${c.whatsapp}?text=${encodeURIComponent(pre)}`;
  const e = c.emojis;
  return `${e ? "🤝 " : ""}${first(lead?.name) ? first(lead.name) + ", si" : "Si"} quieres resolver dudas o avanzar con tu proyecto, escríbele directamente a *${c.name}* por WhatsApp${e ? " 👇" : ":"}\n${link}\n\nEl mensaje ya va escrito con los datos de tu cotización.`;
}

/** Después de enviar la cotización: una sola invitación por cotización. */
export async function handoffAfterQuote(wsRow: any, proposalId: string, delayMs: number) {
  const c = handoffCfg(wsRow);
  if (!c) return;
  const { data: p } = await D.admin.from("proposals").select("id,lead_id,conversation_id,quote").eq("id", proposalId).single();
  const { data: lead } = await D.admin.from("leads").select("*").eq("id", p.lead_id).single();
  if (!lead?.phone) return;
  await new Promise((r) => setTimeout(r, Math.max(delayMs, c.delay_ms)));
  const { error } = await D.admin.from("scheduling_log").insert({ key: `handoff:${p.id}`, workspace_id: wsRow.id, payload: {} });
  if (error) return; // ya se envió
  const text = handoffText(c, lead, p.quote || {}, D.quoteCode(p.id));
  if (p.conversation_id) await D.admin.from("messages").insert({ workspace_id: wsRow.id, conversation_id: p.conversation_id, role: "assistant", content: text, metadata: { module: "handoff", pushed: true } });
  if (c.dry_run) { await D.audit(wsRow.id, "handoff_dry_run", "proposal", p.id, { to: lead.phone, text }); return; }
  const cr = await D.waCreds();
  if (!cr) return;
  const r = await D.waPost(cr, { to: String(lead.phone).replace(/\D/g, ""), type: "text", text: { preview_url: false, body: text } });
  await D.audit(wsRow.id, "handoff_sent", "proposal", p.id, { ok: r.ok, status: r.status, error: r.ok ? null : r.body });
}
