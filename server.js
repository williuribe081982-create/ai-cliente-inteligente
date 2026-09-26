const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
// Captura el cuerpo crudo para validar X-Hub-Signature-256 (debe ir antes de cualquier otro parser).
app.use(express.json({
  limit:"1mb",
  verify:(req,_res,buf)=>{ req.rawBody=Buffer.from(buf); }
}));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const AI_AGENT_URL = process.env.AI_AGENT_URL || "";
const AI_PUBLIC_KEY = process.env.AI_PUBLIC_KEY || "";
const WORKSPACE_ID = process.env.WORKSPACE_ID || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "conversations.json");

fs.mkdirSync(DATA_DIR, {recursive:true});
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "{}", "utf8");

const store = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch { return {}; }
};
const save = x => fs.writeFileSync(DATA_FILE, JSON.stringify(x,null,2), "utf8");

function isFreshConversationRequest(message){
  return /\b(hola|buenos? d[ií]as|buenas?(?: tardes| noches)?)\b/i.test(message)
    && /\b(servicios?|informaci[oó]n)\b/i.test(message);
}
function resetSession(phone){
  const all=store();
  all[phone]={phone,lead:{},state:{},conversation_id:null,messages:[]};
  save(all);
  return all[phone];
}
function getSession(phone){
  const all=store();
  all[phone] ||= {
    phone,
    lead:{},
    state:{},
    conversation_id:null,
    messages:[]
  };
  save(all);
  return all[phone];
}

function updateSession(phone, patch){
  const all=store();
  all[phone] ||= {phone,lead:{},state:{},conversation_id:null,messages:[]};
  all[phone]={...all[phone],...patch};
  save(all);
  return all[phone];
}

function addMessage(phone, role, content){
  const all=store();
  all[phone] ||= {phone,lead:{},state:{},conversation_id:null,messages:[]};
  all[phone].messages.push({role,content,at:new Date().toISOString()});
  all[phone].messages=all[phone].messages.slice(-40);
  save(all);
}

function verifyMetaSignature(req){
  if(!META_APP_SECRET) return true;
  const signature=req.get("x-hub-signature-256");
  if(!signature||!req.rawBody) return false;
  const expected="sha256="+crypto
    .createHmac("sha256",META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  const a=Buffer.from(signature), b=Buffer.from(expected);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

app.get("/p/:token",async(req,res)=>{
  try{
    if(!AI_AGENT_URL) return res.sendStatus(503);
    const response=await fetch(AI_AGENT_URL,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"view",token:req.params.token})
    });
    const raw=await response.text();
    if(!response.ok) return res.status(response.status).send(raw);
    const data=JSON.parse(raw);
    if(!data?.html) return res.sendStatus(404);
    res.type("html").send(data.html);
  }catch(error){
    console.error(new Date().toISOString(),"Error vista propuesta:",error?.message||error);
    res.sendStatus(500);
  }
});


// AI BUSINESS ARCHITECT — workspace interno de chats
app.get("/architect",(_req,res)=>{
  try { res.type("html").send(fs.readFileSync(path.join(__dirname,"architect.html"),"utf8")); }
  catch(e){ console.error("architect.html",e); res.sendStatus(500); }
});
app.post("/architect-api",async(req,res)=>{
  try{
    if(!AI_AGENT_URL || !AI_PUBLIC_KEY) return res.status(503).json({ok:false,error:"AI Business Architect no configurado"});
    const b=req.body||{};
    const payload={action:"architect",public_key:AI_PUBLIC_KEY,workspace_id:WORKSPACE_ID||undefined,...b};
    const response=await fetch(AI_AGENT_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
    const raw=await response.text();
    res.status(response.status).type("json").send(raw);
  }catch(e){ console.error(new Date().toISOString(),"Architect API:",e?.message||e); res.status(500).json({ok:false,error:"Error del agente"}); }
});

app.get("/health",(_req,res)=>res.json({
  ok:true,
  product:"AI Cliente Inteligente",
  whatsapp:!!(ACCESS_TOKEN&&PHONE_NUMBER_ID),
  ai:!!AI_AGENT_URL,
  workspace:!!WORKSPACE_ID
}));

// Política de privacidad pública (requerida por Meta para publicar la app).
app.get(["/privacidad","/privacy"],(_req,res)=>{
  res.type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Política de privacidad — AI Cliente Inteligente</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;line-height:1.6;color:#1d1d1f}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6em}</style></head><body>
<h1>Política de privacidad — AI Cliente Inteligente</h1>
<p><b>Responsable:</b> William Hernández Uribe — AI Business Architect. Medellín, Colombia. Contacto: <a href="mailto:arqwilliamhernandez@gmail.com">arqwilliamhernandez@gmail.com</a>.</p>
<h2>1. Qué datos tratamos</h2>
<p>Cuando nos escribes por WhatsApp tratamos tu número de teléfono, el contenido de tus mensajes y los datos que decidas compartir (por ejemplo nombre, empresa o correo electrónico).</p>
<h2>2. Para qué los usamos</h2>
<p>Para responder tus consultas, entender tu necesidad, preparar recomendaciones, roadmaps y cotizaciones, y dar seguimiento comercial. Cuando se cumplen las reglas comerciales autorizadas y confirmas que deseas avanzar, el sistema puede preparar y enviar automáticamente la propuesta y el roadmap por correo.</p>
<h2>3. Con quién los compartimos</h2>
<p>Solo con los proveedores tecnológicos necesarios para prestar el servicio: Meta (WhatsApp Business Platform), nuestro proveedor de alojamiento, nuestra base de datos y el proveedor del modelo de inteligencia artificial que procesa los mensajes. No vendemos tus datos.</p>
<h2>4. Conservación</h2>
<p>Conservamos la información mientras exista una relación comercial o hasta que solicites su eliminación.</p>
<h2>5. Tus derechos</h2>
<p>Puedes conocer, actualizar, rectificar o solicitar la eliminación de tus datos, y revocar tu autorización, conforme a la Ley 1581 de 2012 de Colombia, escribiendo a <a href="mailto:arqwilliamhernandez@gmail.com">arqwilliamhernandez@gmail.com</a>. Atenderemos tu solicitud en los plazos legales.</p>
<h2>6. Eliminación de datos</h2>
<p>Para eliminar tus datos envía un correo a la dirección anterior con el asunto "Eliminar mis datos" indicando tu número de WhatsApp.</p>
<p style="color:#666;font-size:.9rem">Última actualización: 25 de septiembre de 2026.</p>
</body></html>`);
});

app.get("/webhook",(req,res)=>{
  const mode=req.query["hub.mode"];
  const token=req.query["hub.verify_token"];
  const challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function callAgent(action, phone, extra={}){
  const s=getSession(phone);
  if(!AI_AGENT_URL) throw new Error("AI_AGENT_URL no configurada");

  const response=await fetch(AI_AGENT_URL,{
    method:"POST",
    signal:AbortSignal.timeout(55000),
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      action,
      public_key:AI_PUBLIC_KEY,
      workspace_id:WORKSPACE_ID || undefined,
      conversation_id:s.conversation_id || null,
      lead:{phone,...s.lead},
      state:s.state,
      history:s.messages.slice(-16),
      ...extra
    })
  });

  const raw=await response.text();
  let data={};
  try{ data=raw?JSON.parse(raw):{}; }catch{}

  if(!response.ok){
    console.error(new Date().toISOString(),`AI ${action} ${response.status}:`,raw.slice(0,1000));
    if(response.status===404 && raw.includes("CONVERSATION_NOT_FOUND")){
      updateSession(phone,{conversation_id:null});
    }
    throw new Error(`AI ${action} ${response.status}`);
  }

  updateSession(phone,{
    conversation_id:data.conversation_id || s.conversation_id,
    lead:{...s.lead,...(data.lead||{})},
    state:{...s.state,...(data.state||{}),...(data.auto_send_token?{auto_send_token:data.auto_send_token}: {})}
  });

  return data;
}

async function askAI(message, phone, newConversation=false){
  try{
    const data=await callAgent("chat",phone,{message,...(newConversation?{new_conversation:true}: {})});

    // Persistir explícitamente la propuesta/autorización devuelta por ci-agent.
    // Esto evita perder el vínculo entre la conversación actual y el envío automático.
    if(data?.proposal?.id){
      const current=getSession(phone);
      updateSession(phone,{
        state:{
          ...current.state,
          proposal_id:data.proposal.id,
          proposal_ready:true,
          ...(data.proposal.auto_send_token
            ? {auto_send_token:data.proposal.auto_send_token}
            : {})
        }
      });
    }

    return data.reply || "Gracias por escribirnos 🙌. No recibí una respuesta válida del agente.";
  }catch(error){
    console.error(new Date().toISOString(),"Error chat:",error?.message||error);
    return "Gracias por escribirnos 🙌. En este momento no puedo procesar tu mensaje automáticamente. Un asesor de nuestro equipo te responderá pronto.";
  }
}

function hasEmail(lead){
  return typeof lead?.email==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email.trim());
}

function getProposalId(state, lead){
  // A proposal is only eligible for automatic sending when the CURRENT
  // conversation has explicitly reached the proposal stage. Historical
  // proposal ids are deliberately ignored during normal chat recovery.
  if(state?.proposal_ready === true || state?.current_proposal_ready === true){
    return state?.proposal_id ||
      state?.quote_id ||
      state?.proposal?.id ||
      lead?.proposal_id ||
      lead?.quote_id ||
      null;
  }
  return null;
}

async function maybeApproveAndSend(phone){
  const session=getSession(phone);
  const proposalId=getProposalId(session.state,session.lead);
  const autoSendToken=session.state?.auto_send_token;

  if(!proposalId || !hasEmail(session.lead) || !autoSendToken) return null;

  try{
    const sent=await callAgent("auto_send",phone,{
      proposal_id:proposalId,
      auto_send_token:autoSendToken,
      public_key:AI_PUBLIC_KEY
    });

    const sentOk=sent?.sent===true || sent?.ok===true || sent?.already_sent===true;

    updateSession(phone,{state:{
      ...getSession(phone).state,
      email_result:{ok:sentOk,at:new Date().toISOString(),response:sent}
    }});

    if(!sentOk){
      console.error(new Date().toISOString(),"auto_send no confirmó éxito:",JSON.stringify(sent).slice(0,1000));
      return null;
    }

    return {sent:true};
  }catch(error){
    console.error(new Date().toISOString(),"Error auto_send:",error?.message||error);
    return null;
  }
}

async function sendWhatsAppText(to,body){
  if(!ACCESS_TOKEN||!PHONE_NUMBER_ID) throw new Error("WhatsApp credentials are not configured");
  const url=`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const response=await fetch(url,{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${ACCESS_TOKEN}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      messaging_product:"whatsapp",
      to,
      type:"text",
      text:{preview_url:false,body:String(body).slice(0,4096)}
    })
  });
  if(!response.ok) throw new Error(`WhatsApp ${response.status}: ${await response.text()}`);
}

// Meta puede reenviar el mismo evento; se procesa cada message.id una sola vez.
const seen=new Set();
function firstTime(id){
  if(!id) return true;
  if(seen.has(id)) return false;
  seen.add(id);
  if(seen.size>2000) seen.delete(seen.values().next().value);
  return true;
}

app.post("/webhook",async(req,res)=>{
  if(!verifyMetaSignature(req)){
    console.error(new Date().toISOString(),"Webhook rechazado: firma X-Hub-Signature-256 inválida (revisar META_APP_SECRET)", req.get("x-hub-signature-256")?"con firma":"sin firma");
    return res.sendStatus(401);
  }
  const n=(req.body.entry||[]).reduce((k,e)=>k+(e.changes||[]).reduce((m,c)=>m+(c.value?.messages||[]).length,0),0);
  console.log(new Date().toISOString(),`Webhook recibido: ${n} mensaje(s)`);
  // Acknowledge Meta immediately.
  res.sendStatus(200);

  try{
    for(const entry of (req.body.entry||[])){
      for(const change of (entry.changes||[])){
        for(const message of (change.value?.messages||[])){
          if(message.type!=="text") continue;
          if(!firstTime(message.id)) continue;
          const phone=message.from;
          const text=message.text?.body?.trim();
          if(!phone||!text) continue;

          // Una nueva solicitud de servicios inicia una sesión comercial limpia.
          // No reutilizar nombre, email, propuesta, sector ni estado de una conversación anterior.
          if(isFreshConversationRequest(text)) resetSession(phone);

          try{
            addMessage(phone,"user",text);
            const reply=await askAI(text,phone,isFreshConversationRequest(text));
            addMessage(phone,"assistant",reply);
            await sendWhatsAppText(phone,reply);

            const emailResult=await maybeApproveAndSend(phone);
            if(emailResult?.sent===true){
              await sendWhatsAppText(phone,"Listo ✅ Tu propuesta y roadmap fueron enviados al correo que nos proporcionaste.");
              console.log(new Date().toISOString(),"Propuesta enviada por email a ...",String(phone).slice(-4));
            } else {
              // Watchdog de demostración: envío inmediato + reintentos a 60s y 120s como máximo.
              [60000,120000].forEach((delay)=>setTimeout(async()=>{
                try{
                  const result=await maybeApproveAndSend(phone);
                  if(result?.sent===true){
                    await sendWhatsAppText(phone,"Listo ✅ Tu propuesta y roadmap fueron enviados al correo que nos proporcionaste.");
                    console.log(new Date().toISOString(),"Propuesta enviada por email mediante reintento a ...",String(phone).slice(-4));
                  }
                }catch(error){
                  console.error(new Date().toISOString(),"Error watchdog email:",error?.message||error);
                }
              },delay));
            }

            console.log(new Date().toISOString(),"Respuesta enviada a ...",String(phone).slice(-4));
          }catch(error){
            console.error(new Date().toISOString(),"Error procesando mensaje:",error?.message||error);
          }
        }
      }
    }
  }catch(error){
    console.error(new Date().toISOString(),error);
  }
});

// Contiene teléfonos y mensajes: solo disponible si ADMIN_TOKEN está configurado y se envía como Bearer.
app.get("/api/conversations",(req,res)=>{
  const adminToken=process.env.ADMIN_TOKEN||"";
  if(!adminToken || req.get("authorization")!==`Bearer ${adminToken}`) return res.sendStatus(404);
  res.json(Object.values(store()).map(x=>({
    phone:x.phone,
    lead:x.lead,
    state:x.state,
    conversation_id:x.conversation_id,
    messages:x.messages.slice(-20)
  })));
});

async function recoverPendingEmails(){
  try{
    const all=store();
    for(const [phone,session] of Object.entries(all)){
      if(!session?.state?.proposal_id || !session?.state?.auto_send_token || !hasEmail(session?.lead)) continue;
      if(session?.state?.email_result?.ok===true) continue;
      const result=await maybeApproveAndSend(phone);
      if(result?.sent===true){
        try{
          await sendWhatsAppText(phone,"Listo ✅ Tu propuesta y roadmap fueron enviados al correo que nos proporcionaste.");
        }catch(error){
          console.error(new Date().toISOString(),"Email enviado pero no se pudo confirmar por WhatsApp:",error?.message||error);
        }
      }
    }
  }catch(error){
    console.error(new Date().toISOString(),"Error recuperando envíos pendientes:",error?.message||error);
  }
}

app.listen(PORT,async()=>{
  console.log(`AI Cliente Inteligente listening on :${PORT}`);
  await recoverPendingEmails();
});
