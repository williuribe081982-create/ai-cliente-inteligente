// WIA outreach: envía por el puente Gmail (wia.soluciones@gmail.com) los correos que estén en cola
// en public.outreach_emails. No recibe destinatarios por la petición: solo procesa filas en cola.
import { createClient } from "npm:@supabase/supabase-js@2";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ASSETS = "https://raw.githubusercontent.com/williuribe081982-create/ai-cliente-inteligente/__COMMIT__/media/outreach/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function secret(n: string) { const e = Deno.env.get(n); if (e) return e; const { data } = await admin.rpc("ci_get_platform_secret", { p_name: n }); return (data as string) || null; }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
function b64(buf: Uint8Array) { let s = ""; const CH = 0x8000; for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH)); return btoa(s); }

Deno.serve(async () => {
  const relay = await secret("GMAIL_RELAY_URL"), rkey = await secret("GMAIL_RELAY_KEY");
  if (!relay || !rkey) return Response.json({ ok: false, error: "relay not configured" }, { status: 500 });
  const { data: rows } = await admin.from("outreach_emails").select("*").eq("status", "queued").lte("send_after", new Date().toISOString()).order("priority").limit(5);
  if (!rows?.length) return Response.json({ ok: true, sent: 0 });
  const tpl = await (await fetch(ASSETS + "spas-en.html")).text();
  const vid = b64(new Uint8Array(await (await fetch(ASSETS + "SIERRA_for_Spas_demo.mp4")).arrayBuffer()));
  const out: unknown[] = [];
  for (const r of rows) {
    await admin.from("outreach_emails").update({ status: "sending" }).eq("id", r.id).eq("status", "queued");
    const html = tpl.replace("[Name] · [Spa name]", esc(r.greeting || `${r.spa_name} Team`));
    const payload = { secret: rkey, key: r.id, to: [r.to_email], subject: r.subject, html, reply_to: "wia.soluciones@gmail.com", from_name: "WIA Soluciones Inteligentes",
      attachments: [{ filename: "SIERRA_for_Spas_demo.mp4", content: vid, content_type: "video/mp4" }] };
    let res: Record<string, unknown> = {};
    try {
      const resp = await fetch(relay, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(90000) });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        res = { ok: true, assumed: true };
        if (loc) { try { const j = await (await fetch(loc)).json(); if (typeof j?.ok === "boolean") res = j; } catch (_) { /* 302 = ejecutado */ } }
      } else res = await resp.json().catch(() => ({ ok: false, status: resp.status }));
    } catch (e) {
      // ambiguo: verificar con la misma clave
      await sleep(4000);
      try { const c = await (await fetch(relay, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: rkey, action: "check", key: r.id }) })).json(); res = c?.sent ? { ok: true, id: c.id } : { ok: false, error: String(e) }; }
      catch (_) { res = { ok: true, assumed: true, note: "unconfirmed" }; }
    }
    const ok = res.ok === true;
    await admin.from("outreach_emails").update({ status: ok ? "sent" : "failed", sent_at: ok ? new Date().toISOString() : null, result: res }).eq("id", r.id);
    out.push({ to: r.to_email, ok });
  }
  return Response.json({ ok: true, results: out });
});
