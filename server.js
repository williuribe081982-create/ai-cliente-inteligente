const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({limit:"1mb"}));

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
  if(!signature) return false;
  const expected="sha256="+crypto
    .createHmac("sha256",META_APP_SECRET)
    .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}

// Capture raw body for optional Meta signature validation.
app.use("/webhook", express.json({
  limit:"1mb",
  verify:(req,_res,buf)=>{ req.rawBody=Buffer.from(buf); }
}));

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
    }
  }

  // Fallback only when the real AI endpoint is not configured.
  const t=message.toLowerCase();
  if(t.includes("moto")) return "Perfecto 🏍️. Te ayudo con la revisión técnico-mecánica de tu moto. ¿En qué ciudad deseas realizarla?";
  if(t.includes("carro")||t.includes("auto")) return "Perfecto 🚗. Te ayudo con la revisión técnico-mecánica de tu carro. ¿Es gasolina, diésel, híbrido o eléctrico?";
  if(t.includes("híbr")||t.includes("electr")) return "Perfecto ⚡. ¿En qué ciudad deseas realizar la revisión?";
  if(t.includes("tarifa")||t.includes("precio")||t.includes("cuánto")||t.includes("cuanto")) return "Claro. Puedo orientarte con la tarifa según tu vehículo y sede. Primero dime qué vehículo tienes.";
  return "Hola 👋 Soy el asistente inteligente. Cuéntame qué vehículo tienes y qué necesitas y te ayudaré a encontrar el servicio adecuado.";
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

app.post("/webhook",async(req,res)=>{
  if(!verifyMetaSignature(req)) return res.sendStatus(401);
  // Acknowledge Meta immediately.
  res.sendStatus(200);

  try{
    for(const entry of (req.body.entry||[])){
      for(const change of (entry.changes||[])){
        for(const message of (change.value?.messages||[])){
          if(message.type!=="text") continue;
          const phone=message.from;
          const text=message.text?.body?.trim();
          if(!phone||!text) continue;

          addMessage(phone,"user",text);
          const reply=await askAI(text,phone);
          addMessage(phone,"assistant",reply);
          await sendWhatsAppText(phone,reply);
        }
      }
    }
  }catch(error){
    console.error(new Date().toISOString(),error);
  }
});

app.get("/api/conversations",(_req,res)=>{
  res.json(Object.values(store()).map(x=>({
    phone:x.phone,
    lead:x.lead,
    state:x.state,
    conversation_id:x.conversation_id,
    messages:x.messages.slice(-20)
  })));
});

app.listen(PORT,()=>console.log(`AI Cliente Inteligente listening on :${PORT}`));
