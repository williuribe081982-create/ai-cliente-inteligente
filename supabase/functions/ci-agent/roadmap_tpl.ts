// Roadmap interactivo como adjunto HTML autónomo (logo embebido, funciona sin conexión).
const RAW = "https://raw.githubusercontent.com/williuribe081982-create/ai-cliente-inteligente/main";
const FALLBACK = "https://ai-cliente-inteligente.onrender.com";
let cache: { tpl: string; logo: string } | null = null;

async function get(url: string, ms = 12000): Promise<Response> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r;
}

async function assets(): Promise<{ tpl: string; logo: string }> {
  if (cache) return cache;
  let tpl = "";
  try { tpl = await (await get(`${RAW}/roadmap.html`)).text(); } catch { tpl = ""; }
  if (!tpl.includes("/*DATA*/")) throw new Error("plantilla roadmap no disponible");
  let logo = "";
  for (const u of [`${RAW}/logo.png`, `${FALLBACK}/brand/logo.png`]) {
    try { logo = "data:image/png;base64," + bytesB64(new Uint8Array(await (await get(u)).arrayBuffer())); break; } catch { /* next */ }
  }
  cache = { tpl, logo };
  return cache;
}

function bytesB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64utf8(s: string): string { return bytesB64(new TextEncoder().encode(s)); }

// deno-lint-ignore no-explicit-any
export async function buildRoadmapAttachment(data: any): Promise<string> {
  const { tpl, logo } = await assets();
  const d = { ...(data || {}) };
  if (logo) d.consultant = { ...(d.consultant || {}), logo };
  const json = JSON.stringify(d).replace(/</g, "\\u003c");
  const html = tpl.replace(/\/\*DATA\*\/[\s\S]*?\/\*\/DATA\*\//, () => "/*DATA*/" + json + "/*/DATA*/");
  // Botón "Agendar reunión por WhatsApp": enlace con seguimiento que abre el chat del asesor humano con mensaje prellenado.
  return html.replace(/const wa=`https:\/\/wa\.me\/[^`]*`;/, () => "const wa=D.consultant.book_url||`https://wa.me/${D.consultant.whatsapp}`;");
}

export function safeFileName(s: string): string {
  return (s || "Cliente").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "Cliente";
}
