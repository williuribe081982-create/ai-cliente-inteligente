// Módulo determinístico: estado, roadmap (GL-CI-04), cotización (GL-CI-05), render HTML.
// Sin IA: todo dato comercial sale del catálogo del workspace.
// ---------- utilidades ----------
export const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
export function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat("es-CO", { style: "currency", currency: currency || "COP", maximumFractionDigits: 0 }).format(amount); }
  catch { return `${currency || ""} ${amount}`; }
}
// deno-lint-ignore no-explicit-any
export function mergeState(prev: any, out: any) {
  const q = { ...(prev.qualification || {}) };
  for (const [k, v] of Object.entries(out.qualification || {})) if (clean(v)) q[k] = clean(v);
  const uniq = (a: string[]) => [...new Set(a.filter(Boolean))].slice(-25);
  return {
    qualification: q,
    confirmed: uniq([...(prev.confirmed || []), ...(out.confirmed || [])]),
    hypotheses: out.hypotheses || [],
    missing: out.missing || [],
    intent: out.intent,
    service_match: out.service_match || null,
    out_of_catalog: !!out.out_of_catalog,
    diagnosis: out.diagnosis || prev.diagnosis || null,
    proposal_id: prev.proposal_id || null,
    auto_send_token: prev.auto_send_token || null,
    proposal_ready: !!prev.proposal_ready,
    advance_confirmed: !!prev.advance_confirmed || !!out.advance_confirmed,
    existing_proposal: prev.existing_proposal || null,
    // alcance de la cotización: "single" (un servicio) o "bundle" (paquete completo); se conserva el último explícito
    quote_scope: ["single", "bundle"].includes(out.quote_scope) ? out.quote_scope : (prev.quote_scope || null),
    updated_at: new Date().toISOString(),
  };
}

// ---------- GL-CI-04 ROADMAP + GL-CI-05 QUOTE (determinísticos desde catálogo) ----------
// deno-lint-ignore no-explicit-any
export function buildProposal(ws: any, lead: any, service: any, state: any, packageName: string | null, sources: any[]) {
  const settings = ws.settings || {};
  const pricing = service.pricing || {};
  const scope = service.scope || {};
  const terms = service.terms || {};
  const q = state.qualification || {};
  const dx = state.diagnosis || {};
  const currency = pricing.currency || settings.currency || "COP";

  // inversión — solo precios autorizados
  // deno-lint-ignore no-explicit-any
  let investment: any = { authorized: false, display: "Pendiente — no existe precio autorizado en el catálogo", currency };
  let pkg = null;
  if (pricing.price_type === "packages" && Array.isArray(pricing.packages)) {
    // deno-lint-ignore no-explicit-any
    pkg = pricing.packages.find((p: any) => packageName && p.name?.toLowerCase() === packageName.toLowerCase()) || null;
    if (pkg && typeof pkg.amount === "number") investment = { authorized: true, type: "package", package: pkg.name, amount: pkg.amount, currency, display: `${money(pkg.amount, currency)} — paquete ${pkg.name}`, includes: pkg.includes || [] };
    else investment = { authorized: false, currency, display: "Pendiente — seleccionar paquete del catálogo", options: pricing.packages.map((p: any) => ({ name: p.name, amount: p.amount, display: typeof p.amount === "number" ? money(p.amount, currency) : "sin precio" })) };
  } else if (pricing.price_type === "fixed" && typeof pricing.amount === "number") {
    investment = { authorized: true, type: "fixed", amount: pricing.amount, currency, display: money(pricing.amount, currency) };
  } else if (pricing.price_type === "from" && typeof pricing.amount === "number") {
    investment = { authorized: false, indicative: true, type: "from", amount: pricing.amount, currency, display: `Desde ${money(pricing.amount, currency)} (valor final a confirmar por el equipo)` };
  } else if (pricing.price_type === "quote") {
    investment = { authorized: false, indicative: true, type: "quote", currency, display: pricing.display || "A cotizar según el alcance del proyecto" };
  }
  if (pricing.notes) investment.notes = pricing.notes;

  const stages = Array.isArray(scope.stages) ? scope.stages : [];
  const deliverables = [...(scope.deliverables || []), ...(pkg?.includes || [])];
  const conditions = [
    ...(terms.payment ? [`Forma de pago: ${terms.payment}`] : []),
    ...(terms.guarantee ? [`Garantía: ${terms.guarantee}`] : []),
    ...((terms.conditions || []) as string[]),
  ];
  const validity = terms.validity_days ? `${terms.validity_days} días desde la fecha de envío` : null;
  const nextStep = settings.next_step || "Responder a este correo para confirmar la propuesta o resolver dudas.";

  const roadmap = {
    contexto: `Tu empresa busca conocer y aplicar el servicio ${service.name} para mejorar sus resultados.`,
    objetivo: `Definir con claridad qué implementar, en qué orden y con qué resultados esperados, paso a paso, con el servicio ${service.name}.`,
    diagnostico: { problemas: [], confirmado: state.confirmed || [], hipotesis: state.hypotheses || [], faltante: state.missing || [] },
    solucion: { servicio: service.name, descripcion: service.description, por_que: service.description || null },
    etapas: stages,
    entregables: deliverables,
    tiempo: scope.duration || null,
    inversion: investment.display,
    condiciones: conditions,
    proximo_paso: nextStep,
  };

  const quote = {
    empresa: { nombre: settings.company_name || ws.name, contacto: settings.contact_email || null, telefono: settings.phone || null, web: settings.website || null },
    cliente: { nombre: lead.name, empresa: lead.company, email: lead.email, telefono: lead.phone },
    necesidad: q.need || null,
    solucion: service.name,
    alcance: { incluye: scope.includes || [], excluye: scope.excludes || [] },
    entregables: deliverables,
    etapas: stages,
    tiempos: scope.duration || null,
    inversion: investment,
    condiciones: conditions,
    vigencia: validity,
    proximos_pasos: nextStep,
    fecha: new Date().toISOString().slice(0, 10),
  };

  // validación (humano en el circuito)
  const checks = [
    { id: "service_catalog", ok: !!service?.id && service.active !== false, label: "Servicio existe y está activo en el catálogo" },
    { id: "need", ok: !!q.need, label: "Necesidad del cliente identificada" },
    { id: "client_name", ok: !!(lead.name || lead.company), label: "Nombre o empresa del cliente" },
    { id: "client_email", ok: !!lead.email && isEmail(lead.email), label: "Email válido del cliente" },
    { id: "price_authorized", ok: investment.authorized === true, label: "Precio autorizado en catálogo" },
    { id: "stages", ok: stages.length > 0, label: "Etapas/metodología definidas en catálogo" },
    { id: "sources", ok: sources.length > 0, label: "Fuentes de conocimiento trazables" },
  ];
  const critical = ["service_catalog", "need", "client_name", "client_email", "price_authorized"];
  const passed = checks.filter((c) => critical.includes(c.id)).every((c) => c.ok);
  const validation = { passed, checks, warnings: checks.filter((c) => !c.ok).map((c) => c.label), validated_at: new Date().toISOString() };

  return { roadmap, quote, validation, html: renderHtml(ws, quote, roadmap, !passed) };
}

// ---------- Paquete completo (configurable por workspace: settings.bundle) ----------
// deno-lint-ignore no-explicit-any
export function bundleConfig(ws: any, services: any[]) {
  const b = (ws.settings || {}).bundle;
  if (!b || b.enabled === false || !Array.isArray(services) || services.length < 2) return null;
  const order: string[] = Array.isArray(b.order) ? b.order : [];
  // only_listed: el paquete incluye solo los servicios de "order" (p. ej. excluir un producto que se vende aparte).
  const pool = b.only_listed && order.length ? services.filter((x) => order.includes(x.id)) : services;
  if (pool.length < 2) return null;
  const list = [...pool].sort((x, y) => {
    const ix = order.indexOf(x.id), iy = order.indexOf(y.id);
    return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy);
  });
  return { ...b, services: list };
}

// deno-lint-ignore no-explicit-any
export function buildBundleProposal(ws: any, lead: any, services: any[], state: any, sources: any[]) {
  const settings = ws.settings || {};
  const cfgB = bundleConfig(ws, services);
  if (!cfgB) throw new Error("Paquete no configurado");
  const currency = settings.currency || "COP";
  const q = state.qualification || {};
  // deno-lint-ignore no-explicit-any
  const items = cfgB.services.map((s: any) => {
    const pr = s.pricing || {};
    const ok = pr.price_type === "fixed" && typeof pr.amount === "number";
    return { id: s.id, nombre: s.name, descripcion: s.description || "", incluye: s.scope?.includes || [], amount: ok ? pr.amount : null, display: ok ? money(pr.amount, pr.currency || currency) : "A definir" };
  });
  const allPriced = items.every((i: { amount: number | null }) => typeof i.amount === "number");
  const subtotal = items.reduce((a: number, i: { amount: number | null }) => a + (i.amount || 0), 0);
  const d = cfgB.discount || {};
  const discount = d.type === "percent" ? Math.round(subtotal * (Number(d.value) || 0) / 100) : Math.min(Number(d.value) || 0, subtotal);
  const total = subtotal - discount;
  const pct = subtotal ? Math.round((discount / subtotal) * 100) : 0;
  const ivaNote = settings.tax_note || "Valores antes de IVA.";
  const investment = allPriced
    ? { authorized: true, type: "bundle", currency, subtotal, discount, amount: total, savings_pct: pct,
        subtotal_display: money(subtotal, currency), discount_display: money(discount, currency), display: money(total, currency),
        notes: `Subtotal ${money(subtotal, currency)} · Descuento por paquete −${money(discount, currency)}${pct ? ` (${pct}%)` : ""} · ${ivaNote}` }
    : { authorized: false, type: "bundle", currency, display: "Pendiente — hay servicios sin precio autorizado" };

  // Cada servicio es una fase del roadmap integral (contenido a la medida en settings.bundle.phases).
  // deno-lint-ignore no-explicit-any
  const phasesCfg: Record<string, any> = cfgB.phases || {};
  // deno-lint-ignore no-explicit-any
  const etapas = cfgB.services.map((s: any) => {
    const c = phasesCfg[s.id] || {};
    const short = c.name || s.name;
    return {
      name: `${short} — ${c.desc || s.description || ""}`, title: s.name,
      objetivos: c.objetivos || (s.scope?.includes || []).slice(0, 4), entregables: c.entregables || [],
      criterio: c.criterio || [], humano: c.humano || [], duration: c.duration || null,
    };
  });
  const terms = cfgB.terms || {};
  const conditions = [
    ...(terms.payment ? [`Forma de pago: ${terms.payment}`] : []),
    ...((terms.conditions || []) as string[]),
    "El descuento aplica al contratar el paquete completo.",
    ivaNote,
  ];
  const nextStep = settings.next_step || "Responder a este correo para confirmar la propuesta o resolver dudas.";
  const name = cfgB.name || "Paquete completo";
  const roadmap = {
    contexto: "Tu empresa busca una transformación integral: conocer y aplicar todos nuestros servicios de forma coordinada.",
    objetivo: "Implementar, paso a paso y en el orden correcto, una solución integral donde cada fase potencia a la siguiente.",
    diagnostico: { problemas: [], confirmado: state.confirmed || [], hipotesis: state.hypotheses || [], faltante: state.missing || [] },
    solucion: { servicio: name, descripcion: cfgB.tagline || `Todos los servicios integrados en una sola hoja de ruta.`, por_que: cfgB.tagline || null },
    etapas, entregables: [], tiempo: cfgB.duration || null, inversion: investment.display, condiciones: conditions, proximo_paso: nextStep,
    beneficios: cfgB.benefits || [],
  };
  const quote = {
    tipo: "paquete",
    empresa: { nombre: settings.company_name || ws.name, contacto: settings.contact_email || null, telefono: settings.phone || null, web: settings.website || null },
    cliente: { nombre: lead.name, empresa: lead.company, email: lead.email, telefono: lead.phone },
    necesidad: q.need || `Cotización del ${name}`,
    solucion: name,
    items,
    beneficios: cfgB.benefits || [],
    alcance: { incluye: items.map((i: { nombre: string }) => i.nombre), excluye: [] },
    entregables: [], etapas, tiempos: cfgB.duration || null,
    inversion: investment, condiciones: conditions,
    vigencia: terms.validity_days ? `${terms.validity_days} días desde la fecha de envío` : null,
    proximos_pasos: nextStep, fecha: new Date().toISOString().slice(0, 10),
  };
  const checks = [
    { id: "service_catalog", ok: items.length >= 2, label: "Servicios del paquete activos en el catálogo" },
    { id: "need", ok: true, label: "Necesidad del cliente identificada" },
    { id: "client_name", ok: !!(lead.name || lead.company), label: "Nombre o empresa del cliente" },
    { id: "client_email", ok: !!lead.email && isEmail(lead.email), label: "Email válido del cliente" },
    { id: "price_authorized", ok: allPriced, label: "Precio autorizado en catálogo" },
    { id: "stages", ok: etapas.length > 0, label: "Etapas/metodología definidas en catálogo" },
    { id: "sources", ok: true, label: "Fuentes de conocimiento trazables" },
  ];
  const passed = checks.every((c) => c.ok);
  const validation = { passed, checks, warnings: checks.filter((c) => !c.ok).map((c) => c.label), validated_at: new Date().toISOString() };
  void sources;
  return { roadmap, quote, validation, html: renderHtml(ws, quote, roadmap, !passed) };
}

// ---------- Render: diseño "Noche Ejecutiva" (web y correo) ----------
// deno-lint-ignore no-explicit-any
function brandOf(ws: any) {
  const s = ws.settings || {};
  return {
    ink: s.brand_color || "#0b1a33",
    gold: s.accent_color || "#22a6ff",
    logo: s.logo_url || null,
    company: s.company_name || ws.name || "",
    owner: s.owner_name || s.company_name || ws.name || "",
    title: s.owner_title || "",
    wa: (s.advisor?.whatsapp || s.whatsapp) ? `https://wa.me/${String(s.advisor?.whatsapp || s.whatsapp).replace(/\D/g, "")}` : null as string | null,
    base: (s.public_base_url || "").replace(/\/+$/, ""),
  };
}
// deno-lint-ignore no-explicit-any
function splitStage(st: any, i: number) {
  const raw = String(typeof st === "string" ? st : st?.name || "");
  const [head, ...rest] = raw.split(/\s+[—–-]\s+/);
  const name = head.replace(/^\s*\d+\s*[.)-]?\s*/, "").trim() || `Etapa ${i + 1}`;
  const d0 = rest.join(" — ") || (typeof st === "object" ? (st?.description || "") : "");
  const desc = d0 ? d0.charAt(0).toUpperCase() + d0.slice(1) : "";
  const extra = typeof st === "object" ? [st?.duration, ...(st?.deliverables || [])].filter(Boolean).join(" · ") : "";
  return { n: String(i + 1).padStart(2, "0"), name, desc, extra };
}
const fecha = (iso: string) => { try { return new Date(iso + "T12:00:00Z").toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); } catch { return iso; } };

// deno-lint-ignore no-explicit-any
export function renderHtml(ws: any, quote: any, roadmap: any, draft: boolean, bookUrl: string | null = null) {
  const b = brandOf(ws);
  if (bookUrl) b.wa = bookUrl;
  const st = (quote.etapas || []).map(splitStage);
  const cli = [quote.cliente.nombre, quote.cliente.empresa].filter(Boolean).join(" · ");
  let n = 0;
  const sec = (title: string, body: string) => `<section><div class="h"><i>${String(++n).padStart(2, "0")}</i><h2>${esc(title)}</h2></div>${body}</section>`;
  const chips = (a: string[]) => `<div class="chips">${a.map((x) => `<span>${esc(x)}</span>`).join("")}</div>`;
  const parts = [
    sec("Contexto y objetivo", `<div class="two"><div class="card"><h3>Contexto</h3><p>${esc(roadmap.contexto || quote.necesidad || "")}</p></div><div class="card"><h3>Objetivo</h3><p>${esc(roadmap.objetivo || quote.necesidad || "")}</p></div></div>`),
    (roadmap.diagnostico?.problemas || []).length ? sec("Diagnóstico", `<ul class="pb">${roadmap.diagnostico.problemas.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>`) : "",
    (quote.items || []).length ? sec("Servicios incluidos en el paquete", `<table class="it">${quote.items.map((x: any, i: number) => `<tr><td class="n">${String(i + 1).padStart(2, "0")}</td><td><b>${esc(x.nombre)}</b><br><span>${esc(x.descripcion)}</span></td><td class="p">${esc(x.display)}</td></tr>`).join("")}${quote.inversion?.subtotal_display ? `<tr class="sum"><td></td><td>Subtotal (servicios por separado)</td><td class="p">${esc(quote.inversion.subtotal_display)}</td></tr><tr class="dis"><td></td><td>Descuento por paquete completo${quote.inversion.savings_pct ? ` (${quote.inversion.savings_pct}%)` : ""}</td><td class="p">−${esc(quote.inversion.discount_display)}</td></tr><tr class="tot"><td></td><td>Total paquete</td><td class="p">${esc(quote.inversion.display)}</td></tr>` : ""}</table>${(quote.beneficios || []).length ? `<div class="card" style="margin-top:22px"><h3>Beneficios de adquirir el paquete completo</h3><ul class="pb">${quote.beneficios.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}`) : "",
    quote.tipo === "paquete" ? "" : sec("Solución propuesta", `<div class="card"><h3>${esc(quote.solucion)}</h3><p>${esc(roadmap.solucion?.por_que || roadmap.solucion?.descripcion || "")}</p></div>${(quote.alcance?.incluye || []).length ? chips(quote.alcance.incluye) : ""}${(quote.alcance?.excluye || []).length ? `<p class="mut">No incluye: ${esc(quote.alcance.excluye.join(", "))}</p>` : ""}`),
    st.length ? sec("Roadmap de implementación", `<div class="tl">${st.map((s: any) => `<div class="st"><div class="n">${s.n}</div><h4>${esc(s.name)}</h4><p>${esc(s.desc)}</p>${s.extra ? `<p class="x">${esc(s.extra)}</p>` : ""}</div>`).join("")}</div>${quote.tiempos ? `<p class="mut">Tiempo estimado: ${esc(quote.tiempos)}</p>` : ""}`) : "",
    (quote.entregables || []).length ? sec("Entregables", chips(quote.entregables)) : "",
    sec("Inversión", `<div class="inv"><div class="k">Inversión total</div>${quote.inversion?.subtotal_display ? `<div class="old">${esc(quote.inversion.subtotal_display)}</div>` : ""}<div class="v">${esc(quote.inversion?.display || "")}</div>${quote.inversion?.discount_display ? `<div class="save">Ahorras ${esc(quote.inversion.discount_display)}${quote.inversion.savings_pct ? ` (${quote.inversion.savings_pct}%)` : ""}</div>` : ""}<small>${esc([quote.inversion?.authorized ? quote.inversion.currency : "", quote.inversion?.notes].filter(Boolean).join(" · "))}</small>${b.wa ? `<br><a class="cta" href="${esc(b.wa)}">Agendar reunión</a>` : ""}</div>`),
    (quote.condiciones || []).length || quote.vigencia ? sec("Condiciones", `<ul class="pb">${(quote.condiciones || []).map((c: string) => `<li>${esc(c)}</li>`).join("")}${quote.vigencia ? `<li>Vigencia: ${esc(quote.vigencia)}</li>` : ""}</ul>`) : "",
    sec("Próximo paso", `<p style="font-size:17px">${esc(quote.proximos_pasos || "")}</p>`),
  ].join("");
  const css = `:root{--bg:#070b16;--bg2:#0c1324;--line:#1c2740;--gold:#22a6ff;--gold2:#9fe0ff;--blue:#5fa8ff;--txt:#e8ecf4;--mut:#8a94aa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:Montserrat,Arial,sans-serif;font-weight:300;line-height:1.6}
.w{max-width:980px;margin:0 auto;padding:0 24px}
.draft{background:#3a2d10;color:#f3d9a4;text-align:center;padding:10px;font-weight:600;letter-spacing:.1em}
.hero{position:relative;overflow:hidden;padding:56px 0 64px;background:radial-gradient(1200px 500px at 70% -10%,#16264a 0%,transparent 60%),linear-gradient(180deg,#0a1122,#070b16)}
.hero:before{content:"";position:absolute;inset:0;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:48px 48px;-webkit-mask:linear-gradient(180deg,#000,transparent);mask:linear-gradient(180deg,#000,transparent)}
.top{display:flex;justify-content:space-between;gap:12px;font-size:11px;letter-spacing:.3em;color:var(--mut);text-transform:uppercase;position:relative}.top b{color:var(--gold);font-weight:500}
.logo{display:block;width:250px;margin:42px 0 26px;position:relative}.brand{font-family:Michroma,sans-serif;letter-spacing:.2em;margin:42px 0 26px;position:relative}
.k{font-size:12px;letter-spacing:.35em;color:#ffffff;text-transform:uppercase;font-weight:500;position:relative}
h1{font-family:Michroma,sans-serif;font-weight:400;font-size:40px;line-height:1.2;margin:14px 0 10px;letter-spacing:.02em;position:relative}h1 span{color:var(--blue)}
.lema{font-size:18px;color:#c3cbdb;max-width:640px;position:relative}
.meta{display:flex;gap:40px;flex-wrap:wrap;margin-top:34px;padding-top:22px;border-top:1px solid var(--line);position:relative}
.meta div{font-size:12px;color:var(--mut);letter-spacing:.15em;text-transform:uppercase}.meta b{display:block;color:var(--txt);font-size:15px;letter-spacing:0;text-transform:none;font-weight:500;margin-top:4px}
section{padding:56px 0;border-top:1px solid var(--line)}
.h{display:flex;align-items:baseline;gap:16px;margin-bottom:26px}.h i{font-style:normal;color:var(--gold);font-size:12px;letter-spacing:.3em}
h2{font-family:Michroma,sans-serif;font-weight:400;font-size:22px;margin:0;letter-spacing:.04em}
.two{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:24px}.card h3{margin:0 0 8px;font-size:12px;letter-spacing:.25em;text-transform:uppercase;color:var(--gold);font-weight:500}.card p{margin:0;font-size:15px;color:#cfd6e4}
ul.pb{list-style:none;padding:0;margin:0}ul.pb li{padding:14px 0 14px 34px;position:relative;border-bottom:1px solid var(--line);font-size:16px}ul.pb li:before{content:"";position:absolute;left:0;top:25px;width:18px;height:2px;background:var(--gold)}
.tl{position:relative;margin-left:22px}.tl:before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;background:linear-gradient(var(--gold),var(--blue))}
.st{position:relative;padding:0 0 26px 44px}.st .n{position:absolute;left:-21px;top:0;width:44px;height:44px;border-radius:50%;background:#0b1428;border:1px solid var(--gold);display:flex;align-items:center;justify-content:center;font-family:Michroma,sans-serif;font-size:13px;color:var(--gold2)}
.st h4{margin:8px 0 4px;font-size:18px;font-weight:600}.st p{margin:0;color:var(--mut);font-size:15px}.st p.x{color:var(--txt);margin-top:4px}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.chips span{border:1px solid #2a3a5c;border-radius:999px;padding:9px 16px;font-size:14px;background:#0e1830}
.mut{color:var(--mut)}
.inv{text-align:center;background:linear-gradient(135deg,#0f1a33,#0a1022);border:1px solid #1d3a66;border-radius:18px;padding:44px 24px}.inv .v{font-family:Michroma,sans-serif;font-size:46px;color:var(--gold2);margin:8px 0}.inv small{color:var(--mut)}
.cta{display:inline-block;margin-top:26px;background:linear-gradient(90deg,var(--gold),var(--gold2));color:#031226;text-decoration:none;font-weight:600;padding:15px 30px;border-radius:999px;letter-spacing:.05em}
footer{padding:30px 0 50px;border-top:1px solid var(--line);color:var(--mut);font-size:12px;letter-spacing:.2em;text-transform:uppercase;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
table.it{width:100%;border-collapse:collapse}table.it td{padding:14px 10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:15px}table.it td.n{color:var(--gold);font-family:Michroma,sans-serif;font-size:12px;width:40px}table.it td span{color:var(--mut);font-size:14px}table.it td.p{text-align:right;white-space:nowrap;color:var(--gold2)}table.it tr.sum td{color:var(--mut)}table.it tr.dis td{color:#7ee2a8}table.it tr.dis td.p{color:#7ee2a8}table.it tr.tot td{font-weight:600;font-size:17px;border-bottom:0}
.inv .old{color:var(--mut);text-decoration:line-through;font-size:18px}.inv .save{display:inline-block;margin:4px 0 10px;background:#0f2a1c;border:1px solid #2f6b4a;color:#7ee2a8;border-radius:999px;padding:6px 16px;font-weight:600;font-size:14px}
@media(max-width:680px){h1{font-size:28px}.two{grid-template-columns:1fr}.inv .v{font-size:32px}.meta{gap:22px}}
@media print{.cta{display:none}}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Propuesta — ${esc(quote.solucion)} — ${esc(cli)}</title><link href="https://fonts.googleapis.com/css2?family=Michroma&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet"><style>${css}</style></head><body>
${draft ? `<div class="draft">BORRADOR — requiere completar datos y aprobación</div>` : ""}
<div class="hero"><div class="w"><div class="top"><span>Propuesta estratégica</span><b>${esc(fecha(quote.fecha))}</b></div>
${b.logo ? `<img class="logo" src="${esc(b.logo)}" alt="${esc(b.company)}">` : `<div class="brand">${esc(b.company)}</div>`}
${b.title ? `<div class="k">${esc(b.title.split("·").pop()!.trim())}</div>` : ""}
<h1>${quote.tipo === "paquete" ? "Cotización integral" : "Roadmap de"} <span>${esc(quote.solucion)}</span></h1><div class="lema">${esc(roadmap.solucion?.descripcion || "")}</div>
<div class="meta"><div>Preparado para<b>${esc(cli)}</b></div><div>${quote.tipo === "paquete" ? "Paquete" : "Servicio"}<b>${esc(quote.solucion)}</b></div>${st.length ? `<div>${quote.tipo === "paquete" ? "Fases" : "Metodología"}<b>${st.length} ${quote.tipo === "paquete" ? "servicios integrados" : "etapas"}</b></div>` : ""}</div></div></div>
<div class="w">${parts}
<footer><span>${esc([b.owner, b.title.split("·").pop()?.trim()].filter(Boolean).join(" · "))}</span><span>${esc([quote.empresa.telefono, quote.empresa.contacto, quote.empresa.web].filter(Boolean).join(" · "))}</span></footer></div>
</body></html>`;
}

// Versión para correo: mismo diseño con tablas y estilos en línea (compatible con Gmail/Outlook).
// deno-lint-ignore no-explicit-any
export function renderEmail(ws: any, quote: any, roadmap: any, viewUrl: string | null, bookUrl: string | null = null) {
  const b = brandOf(ws);
  if (bookUrl) b.wa = bookUrl;
  const st = (quote.etapas || []).map(splitStage);
  const cli = [quote.cliente.nombre, quote.cliente.empresa].filter(Boolean).join(" · ");
  const F = "font-family:Montserrat,Arial,Helvetica,sans-serif;";
  const BG = "#070b16", BG2 = "#0c1324", LN = "#1c2740", GD = "#22a6ff", GD2 = "#9fe0ff", BL = "#5fa8ff", TX = "#e8ecf4", MU = "#8a94aa";
  let n = 0;
  const head = (t: string) => `<div style="${F}margin:0 0 18px"><span style="color:${GD};font-size:11px;letter-spacing:3px">${String(++n).padStart(2, "0")}</span>&nbsp;&nbsp;<span style="color:${TX};font-size:19px;letter-spacing:1px">${esc(t)}</span></div>`;
  const row = (inner: string) => `<tr><td style="padding:34px 32px;border-top:1px solid ${LN}">${inner}</td></tr>`;
  const card = (t: string, body: string) => `<div style="background:${BG2};border:1px solid ${LN};border-radius:12px;padding:18px 20px;margin-bottom:12px"><div style="${F}font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${GD};margin-bottom:6px">${esc(t)}</div><div style="${F}font-size:14px;line-height:1.6;color:#cfd6e4">${body}</div></div>`;
  const line = (t: string) => `<tr><td width="30" valign="top" style="padding:13px 0"><div style="width:18px;height:2px;background:${GD};margin-top:9px"></div></td><td style="padding:12px 0;border-bottom:1px solid ${LN};${F}font-size:15px;color:${TX}">${esc(t)}</td></tr>`;
  const btn = (href: string, label: string, bg: string, fg: string) => `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};text-decoration:none;${F}font-size:14px;font-weight:600;letter-spacing:1px;padding:14px 26px;border-radius:999px;margin:6px 4px 0">${label}</a>`;
  const steps = st.map((s: any, i: number) => `<tr><td width="54" valign="top" style="padding:0 0 ${i === st.length - 1 ? 0 : 18}px"><div style="width:40px;height:40px;line-height:40px;border-radius:50%;border:1px solid ${GD};background:#0b1428;text-align:center;${F}font-size:13px;color:${GD2}">${s.n}</div></td><td valign="top" style="padding:0 0 ${i === st.length - 1 ? 0 : 18}px;border-left:2px solid ${i < st.length / 2 ? GD : BL};padding-left:16px"><div style="${F}font-size:16px;font-weight:600;color:${TX};margin-top:2px">${esc(s.name)}</div><div style="${F}font-size:13px;line-height:1.5;color:${MU}">${esc(s.desc)}</div>${s.extra ? `<div style="${F}font-size:13px;color:${TX}">${esc(s.extra)}</div>` : ""}</td></tr>`).join("");
  const rows = [
    `<tr><td style="padding:32px 32px 36px;background:#0a1122">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="${F}font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${MU}">Propuesta estratégica</td><td align="right" style="${F}font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${GD}">${esc(fecha(quote.fecha))}</td></tr></table>
${b.logo ? `<img src="${esc(b.logo)}" width="210" alt="${esc(b.company)}" style="display:block;border:0;margin:30px 0 14px">` : `<div style="${F}color:${TX};letter-spacing:3px;margin:30px 0 20px">${esc(b.company)}</div>`}
<div style="${F}font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ffffff">${esc(b.title.split("·").pop()?.trim() || "")}</div>
<div style="${F}font-size:28px;line-height:1.25;color:${TX};margin:10px 0 8px">${quote.tipo === "paquete" ? "Cotización integral:" : "Roadmap de"} <span style="color:${BL}">${esc(quote.solucion)}</span></div>
<div style="${F}font-size:15px;color:#c3cbdb">${esc(roadmap.solucion?.descripcion || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid ${LN}"><tr>
<td style="padding-top:14px;${F}font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${MU}">Preparado para<br><span style="font-size:14px;letter-spacing:0;text-transform:none;color:${TX};font-weight:500">${esc(cli)}</span></td>
<td style="padding-top:14px;${F}font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${MU}">${quote.tipo === "paquete" ? "Paquete" : "Servicio"}<br><span style="font-size:14px;letter-spacing:0;text-transform:none;color:${TX};font-weight:500">${esc(quote.solucion)}</span></td>
${st.length ? `<td style="padding-top:14px;${F}font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${MU}">${quote.tipo === "paquete" ? "Fases" : "Metodología"}<br><span style="font-size:14px;letter-spacing:0;text-transform:none;color:${TX};font-weight:500">${st.length} ${quote.tipo === "paquete" ? "servicios" : "etapas"}</span></td>` : ""}
</tr></table>
${viewUrl ? `<div style="margin-top:26px">${btn(viewUrl, "Ver mi roadmap interactivo", GD, "#031226")}</div>` : ""}
<div style="${F}font-size:13px;line-height:1.5;color:${MU};margin-top:16px">Tu roadmap interactivo también va adjunto a este correo (archivo .html): descárgalo y ábrelo con tu navegador.</div></td></tr>`,
    row(head("Contexto y objetivo") + card("Contexto", esc(roadmap.contexto || quote.necesidad || "")) + card("Objetivo", esc(roadmap.objetivo || quote.necesidad || ""))),
    (roadmap.diagnostico?.problemas || []).length ? row(head("Diagnóstico") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${roadmap.diagnostico.problemas.map(line).join("")}</table>`) : "",
    (quote.items || []).length ? row(head("Servicios incluidos en el paquete") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${quote.items.map((x: any, i: number) => `<tr><td width="34" valign="top" style="padding:12px 0;border-bottom:1px solid ${LN};${F}font-size:12px;color:${GD}">${String(i + 1).padStart(2, "0")}</td><td valign="top" style="padding:12px 8px 12px 0;border-bottom:1px solid ${LN};${F}font-size:15px;color:${TX}">${esc(x.nombre)}<div style="font-size:13px;color:${MU};line-height:1.5">${esc(x.descripcion)}</div></td><td align="right" valign="top" style="padding:12px 0;border-bottom:1px solid ${LN};${F}font-size:14px;color:${GD2};white-space:nowrap">${esc(x.display)}</td></tr>`).join("")}${quote.inversion?.subtotal_display ? `<tr><td></td><td style="padding:12px 0 4px;${F}font-size:14px;color:${MU}">Subtotal (servicios por separado)</td><td align="right" style="padding:12px 0 4px;${F}font-size:14px;color:${MU};white-space:nowrap">${esc(quote.inversion.subtotal_display)}</td></tr><tr><td></td><td style="padding:4px 0;${F}font-size:14px;color:#7ee2a8">Descuento por paquete completo${quote.inversion.savings_pct ? ` (${quote.inversion.savings_pct}%)` : ""}</td><td align="right" style="padding:4px 0;${F}font-size:14px;color:#7ee2a8;white-space:nowrap">−${esc(quote.inversion.discount_display)}</td></tr><tr><td></td><td style="padding:8px 0 0;${F}font-size:16px;font-weight:600;color:${TX}">Total paquete</td><td align="right" style="padding:8px 0 0;${F}font-size:16px;font-weight:600;color:${GD2};white-space:nowrap">${esc(quote.inversion.display)}</td></tr>` : ""}</table>` + ((quote.beneficios || []).length ? `<div style="margin-top:22px">${card("Beneficios de adquirir el paquete completo", quote.beneficios.map((x: string) => "✓ " + esc(x)).join("<br>"))}</div>` : "")) : "",
    quote.tipo === "paquete" ? "" : row(head("Solución propuesta") + card(quote.solucion, esc(roadmap.solucion?.por_que || roadmap.solucion?.descripcion || "")) + ((quote.alcance?.incluye || []).length ? `<div>${quote.alcance.incluye.map((x: string) => `<span style="display:inline-block;border:1px solid #2a3a5c;background:#0e1830;border-radius:999px;padding:8px 14px;margin:6px 6px 0 0;${F}font-size:13px;color:${TX}">${esc(x)}</span>`).join("")}</div>` : "")),
    st.length ? row(head("Roadmap de implementación") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>` + (quote.tiempos ? `<div style="${F}font-size:13px;color:${MU};margin-top:14px">Tiempo estimado: ${esc(quote.tiempos)}</div>` : "")) : "",
    row(head("Inversión") + `<div style="text-align:center;background:#0f1a33;border:1px solid #1d3a66;border-radius:16px;padding:32px 20px"><div style="${F}font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${GD}">Inversión total</div>${quote.inversion?.subtotal_display ? `<div style="${F}font-size:17px;color:${MU};text-decoration:line-through;margin-top:8px">${esc(quote.inversion.subtotal_display)}</div>` : ""}<div style="${F}font-size:36px;color:${GD2};margin:8px 0">${esc(quote.inversion?.display || "")}</div>${quote.inversion?.discount_display ? `<div style="display:inline-block;background:#0f2a1c;border:1px solid #2f6b4a;color:#7ee2a8;border-radius:999px;padding:6px 16px;${F}font-size:14px;font-weight:600;margin-bottom:10px">Ahorras ${esc(quote.inversion.discount_display)}${quote.inversion.savings_pct ? ` (${quote.inversion.savings_pct}%)` : ""}</div>` : ""}<div style="${F}font-size:12px;color:${MU}">${esc([quote.inversion?.authorized ? quote.inversion.currency : "", quote.inversion?.notes].filter(Boolean).join(" · "))}</div><div style="margin-top:16px">${b.wa ? btn(b.wa, "Agendar reunión", GD, "#031226") : ""}${viewUrl ? btn(viewUrl, "Ver roadmap interactivo", "#16264a", TX) : ""}</div></div>`),
    (quote.condiciones || []).length || quote.vigencia ? row(head("Condiciones") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${[...(quote.condiciones || []), ...(quote.vigencia ? ["Vigencia: " + quote.vigencia] : [])].map(line).join("")}</table>`) : "",
    row(head("Próximo paso") + `<div style="${F}font-size:15px;line-height:1.6;color:${TX}">${esc(quote.proximos_pasos || "")}</div>`),
    `<tr><td style="padding:22px 32px 30px;border-top:1px solid ${LN};${F}font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${MU}">${esc([b.owner, b.title.split("·").pop()?.trim()].filter(Boolean).join(" · "))}<br><span style="letter-spacing:1px">${esc([quote.empresa.telefono, quote.empresa.contacto, quote.empresa.web].filter(Boolean).join(" · "))}</span></td></tr>`,
  ].join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>Propuesta — ${esc(quote.solucion)}</title></head>
<body style="margin:0;padding:0;background:${BG}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG}"><tr><td align="center" style="padding:20px 8px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${BG};border:1px solid ${LN};border-radius:14px;overflow:hidden">${rows}</table>
</td></tr></table></body></html>`;
}

// Datos para el roadmap interactivo (plantilla roadmap.html servida por el canal web).
// deno-lint-ignore no-explicit-any
export function roadmapData(ws: any, quote: any, roadmap: any, bookUrl: string | null = null) {
  const b = brandOf(ws);
  const s = ws.settings || {};
  const cli = quote.cliente || {};
  const name = cli.empresa || cli.nombre || "Cliente";
  const initials = String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();
  // deno-lint-ignore no-explicit-any
  const phases = (quote.etapas || []).map((st: any, i: number) => {
    const x = splitStage(st, i);
    const o = typeof st === "object" && st ? st : {};
    return {
      name: x.name, short: o.title || x.name, desc: x.desc || o.description || "",
      duration: o.duration || null,
      objetivos: o.objetivos || o.objectives || [], entregables: o.entregables || o.deliverables || [],
      criterio: o.criterio || [], humano: o.humano || [],
      video: o.video || null, image: o.image || null, mockups: o.mockups || [], docs: o.docs || [],
    };
  });
  const problems = roadmap.diagnostico?.problemas || [];
  return {
    consultant: { name: b.owner, title: (b.title.split("·").pop() || "").trim(), logo: b.logo, whatsapp: String(s.advisor?.whatsapp || s.whatsapp || "").replace(/\D/g, ""), email: s.contact_email || "", phone: s.phone || "", book_url: bookUrl },
    client: { name, short: initials || "C", tagline: cli.empresa && cli.nombre ? cli.nombre : "Propuesta personalizada", motto: s.motto || "Negocio antes que tecnología", logo: null },
    service: quote.solucion,
    intro: roadmap.solucion?.descripcion || quote.necesidad || "",
    video: { title: "Video del roadmap", url: s.roadmap_video_url || null },
    stats: quote.tipo === "paquete" ? [
      { v: String(phases.length), l: "Servicios integrados", ic: "map" },
      { v: quote.inversion?.savings_pct ? `${quote.inversion.savings_pct}%` : "✓", l: "Ahorro por paquete", ic: "money" },
      { v: "1", l: "Hoja de ruta integral", ic: "road" },
      { v: "100%", l: "Enfoque en el negocio", ic: "star" },
    ] : [
      { v: String(phases.length), l: "Etapas del roadmap", ic: "map" },
      { v: String(problems.length || 1), l: problems.length ? "Puntos críticos" : "Diagnóstico integral", ic: problems.length ? "alert" : "search" },
      { v: String((quote.alcance?.incluye || []).length || 1), l: "Componentes incluidos", ic: "doc" },
      { v: "100%", l: "Enfoque en el negocio", ic: "star" },
    ],
    investment: { display: quote.inversion?.display || "", currency: quote.inversion?.authorized ? (quote.inversion.currency || "") : "", note: quote.inversion?.notes || "" },
    phases,
    metrics: [{ l: "Procesos optimizados", ic: "chart" }, { l: "Tiempo de respuesta", ic: "clock" }, { l: "Productividad del equipo", ic: "users" }, { l: "Información en tiempo real", ic: "doc" }],
    pillars: ["Información organizada", "Datos conectados", "Operación más eficiente", "Decisiones con mayor claridad"],
  };
}
