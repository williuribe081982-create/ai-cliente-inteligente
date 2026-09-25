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

app.get("/health",(_req,res)=>res.json({
  ok:true,
  product:"AI Cliente Inteligente",
  whatsapp:!!(ACCESS_TOKEN&&PHONE_NUMBER_ID),
  ai:!!AI_AGENT_URL,
  workspace:!!WORKSPACE_ID
}));

app.get("/webhook",(req,res)=>{
  const mode=req.query["hub.mode"];
  const token=req.query["hub.verify_token"];
  const challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function askAI(message, phone){
  const s=getSession(phone);

  if(AI_AGENT_URL){
    const response=await fetch(AI_AGENT_URL,{
      method:"POST",
      signal:AbortSignal.timeout(55000),
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        action:"chat",
        public_key:AI_PUBLIC_KEY,
        workspace_id:WORKSPACE_ID || undefined,
        message,
        conversation_id:s.conversation_id || null,
        lead:{phone,...s.lead},
        state:s.state,
        history:s.messages.slice(-16)
      })
    });

    if(response.ok){
      const data=await response.json();
      updateSession(phone,{
        conversation_id:data.conversation_id || s.conversation_id,
        lead:{...s.lead,...(data.lead||{})},
        state:{...s.state,...(data.state||{})}
      });
      if(data.reply) return data.reply;
      console.error(new Date().toISOString(),"AI sin reply:",JSON.stringify(data).slice(0,500));
    }else{
      const errText=await response.text().catch(()=>"");
      console.error(new Date().toISOString(),`AI ${response.status}:`,errText.slice(0,500));
      // Si la conversación guardada ya no existe en el workspace, empezar una nueva en el próximo mensaje.
      if(response.status===404 && errText.includes("CONVERSATION_NOT_FOUND")) updateSession(phone,{conversation_id:null});
    }
  }else{
    console.error(new Date().toISOString(),"AI_AGENT_URL no configurada");
  }

  // Respaldo neutral: nunca inventa servicios, precios ni condiciones.
  return "Gracias por escribirnos 🙌. En este momento no puedo procesar tu mensaje automáticamente. Un asesor de nuestro equipo te responderá pronto.";
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

          try{
            addMessage(phone,"user",text);
            const reply=await askAI(text,phone);
            addMessage(phone,"assistant",reply);
            await sendWhatsAppText(phone,reply);
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

app.listen(PORT,()=>console.log(`AI Cliente Inteligente listening on :${PORT}`));
