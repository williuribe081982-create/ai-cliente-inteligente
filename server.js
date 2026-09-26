const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

const AI_AGENT_URL = process.env.AI_AGENT_URL || "";
const AI_PUBLIC_KEY = process.env.AI_PUBLIC_KEY || "";
const WORKSPACE_ID = process.env.WORKSPACE_ID || "";

const AUTO_EMAIL_SERVICE = "Estrategia con IA";
const AUTO_EMAIL_AMOUNT = 2000000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "conversations.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "{}", "utf8");

function store() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return {}; }
}
function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}
function getSession(phone) {
  const all = store();
  all[phone] ||= {
    phone,
    lead: { phone },
    state: {},
    conversation_id: null,
    messages: [],
    processed_message_ids: []
  };
  save(all);
  return all[phone];
}
function updateSession(phone, patch) {
  const all = store();
  all[phone] ||= { phone, lead: { phone }, state: {}, conversation_id: null, messages: [], processed_message_ids: [] };
  all[phone] = { ...all[phone], ...patch };
  save(all);
  return all[phone];
}
function addMessage(phone, role, content) {
  const all = store();
  all[phone] ||= { phone, lead: { phone }, state: {}, conversation_id: null, messages: [], processed_message_ids: [] };
  all[phone].messages.push({ role, content, at: new Date().toISOString() });
  all[phone].messages = all[phone].messages.slice(-40);
  save(all);
}
function markProcessed(phone, id) {
  const s = getSession(phone);
  const ids = new Set(s.processed_message_ids || []);
  ids.add(id);
  updateSession(phone, { processed_message_ids: Array.from(ids).slice(-100) });
}
function wasProcessed(phone, id) {
  return (getSession(phone).processed_message_ids || []).includes(id);
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true;
  const signature = req.get("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;
  const expected = "sha256=" + crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); }
}));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    product: "AI Cliente Inteligente",
    whatsapp: !!(ACCESS_TOKEN && PHONE_NUMBER_ID),
    ai: !!(AI_AGENT_URL && AI_PUBLIC_KEY && WORKSPACE_ID),
    workspace: !!WORKSPACE_ID,
    automatic_email: !!AI_AGENT_URL,
    automatic_service: AUTO_EMAIL_SERVICE,
    automatic_amount_cop: AUTO_EMAIL_AMOUNT
  });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function callAI(payload) {
  if (!AI_AGENT_URL) throw new Error("AI_AGENT_URL is not configured");
  const response = await fetch(AI_AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!response.ok) throw new Error(`AI ${response.status}: ${raw.slice(0, 1000)}`);
  return data;
}

async function askAI(message, phone) {
  const s = getSession(phone);
  const data = await callAI({
    action: "chat",
    public_key: AI_PUBLIC_KEY,
    workspace_id: WORKSPACE_ID || undefined,
    message,
    conversation_id: s.conversation_id || null,
    lead: { phone, ...s.lead },
    state: s.state,
    history: s.messages.slice(-16)
  });

  updateSession(phone, {
    conversation_id: data.conversation_id || s.conversation_id,
    lead: { ...s.lead, ...(data.lead || {}) },
    state: { ...s.state, ...(data.state || {}) }
  });

  return data;
}

function extractProposal(data) {
  return data?.proposal || data?.quote || data?.proposal_data || null;
}
function proposalId(proposal) {
  return proposal?.id || proposal?.proposal_id || proposal?.proposalId || null;
}
function proposalServiceName(proposal) {
  return proposal?.service?.name ||
    proposal?.service_name ||
    proposal?.serviceName ||
    proposal?.services?.name ||
    "";
}
function proposalAmount(proposal) {
  const raw = proposal?.amount ?? proposal?.total ?? proposal?.total_amount ??
    proposal?.price ?? proposal?.quote?.amount;
  const n = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function isAutomaticProposal(proposal) {
  if (!proposal) return false;
  const name = proposalServiceName(proposal).trim().toLowerCase();
  const amount = proposalAmount(proposal);
  return name === AUTO_EMAIL_SERVICE.toLowerCase() &&
    (amount === null || amount === AUTO_EMAIL_AMOUNT);
}

async function finalizeAutomaticEmail(data, phone) {
  const proposal = extractProposal(data);
  if (!isAutomaticProposal(proposal)) return { sent: false, reason: "not_target_service" };

  const pid = proposalId(proposal);
  const lead = { ...getSession(phone).lead, ...(data.lead || {}) };
  const email = String(lead.email || "").trim();

  if (!pid) return { sent: false, reason: "proposal_id_missing" };

  if (!email) {
    return {
      sent: false,
      reason: "email_missing",
      reply: "Perfecto. Ya tenemos lista la propuesta de Estrategia con IA por $2.000.000 COP. Para enviarte el roadmap y la cotización, ¿a qué correo deseas que los envíe?"
    };
  }

  const approval = await callAI({
    action: "approve",
    public_key: AI_PUBLIC_KEY,
    workspace_id: WORKSPACE_ID,
    proposal_id: pid,
    notes: "Aprobación automática por cierre de conversación WhatsApp para servicio Estrategia con IA."
  });

  if (!approval?.ok && approval?.approval_status !== "approved") {
    return {
      sent: false,
      reason: "approval_failed",
      error: approval?.message || approval?.error || "No fue posible aprobar la propuesta."
    };
  }

  const sent = await callAI({
    action: "send_email",
    public_key: AI_PUBLIC_KEY,
    workspace_id: WORKSPACE_ID,
    proposal_id: pid
  });

  if (!sent?.ok) {
    return {
      sent: false,
      reason: "email_failed",
      error: sent?.message || sent?.error || "No fue posible enviar el correo."
    };
  }

  return {
    sent: true,
    recipient: sent.recipient || email,
    provider: sent.provider || "Resend",
    provider_message_id: sent.provider_message_id || null
  };
}

async function sendWhatsAppText(to, body) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) throw new Error("WhatsApp credentials are not configured");
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: false, body: String(body).slice(0, 4096) }
    })
  });
  if (!response.ok) throw new Error(`WhatsApp ${response.status}: ${await response.text()}`);
}

app.post("/webhook", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);

  try {
    for (const entry of (req.body.entry || [])) {
      for (const change of (entry.changes || [])) {
        for (const message of (change.value?.messages || [])) {
          if (message.type !== "text") continue;

          const phone = message.from;
          const text = message.text?.body?.trim();
          const messageId = message.id;
          if (!phone || !text) continue;
          if (messageId && wasProcessed(phone, messageId)) continue;
          if (messageId) markProcessed(phone, messageId);

          addMessage(phone, "user", text);

          let data;
          try {
            data = await askAI(text, phone);
          } catch (aiError) {
            console.error(new Date().toISOString(), aiError);
            const fallback = "Estoy teniendo un inconveniente temporal para procesar la solicitud. Por favor intenta nuevamente en unos minutos.";
            addMessage(phone, "assistant", fallback);
            await sendWhatsAppText(phone, fallback);
            continue;
          }

          let reply = data.reply || "";
          let auto;
          try {
            auto = await finalizeAutomaticEmail(data, phone);
          } catch (emailError) {
            auto = { sent: false, reason: "email_failed", error: emailError.message };
          }

          if (auto.reason === "email_missing") {
            reply = auto.reply;
          } else if (auto.sent) {
            reply = "Perfecto. Ya concretamos la propuesta de Estrategia con IA por $2.000.000 COP. Te acabo de enviar al correo el roadmap y la cotización.";
          } else if (auto.reason === "approval_failed" || auto.reason === "email_failed") {
            reply = `${reply}

La propuesta quedó preparada, pero no pude completar el envío del correo todavía. No voy a marcarla como enviada hasta confirmar la entrega.`;
            console.error("Automatic proposal/email error:", auto);
          }

          if (!reply) reply = "Perfecto. He actualizado tu solicitud.";
          addMessage(phone, "assistant", reply);
          await sendWhatsAppText(phone, reply);
        }
      }
    }
  } catch (error) {
    console.error(new Date().toISOString(), error);
  }
});

app.get("/api/conversations", (_req, res) => {
  res.json(Object.values(store()).map(x => ({
    phone: x.phone,
    lead: x.lead,
    state: x.state,
    conversation_id: x.conversation_id,
    messages: x.messages.slice(-20)
  })));
});

app.listen(PORT, () => console.log(`AI Cliente Inteligente listening on :${PORT}`));
