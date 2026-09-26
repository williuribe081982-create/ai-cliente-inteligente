# Backend WhatsApp — AI Cliente Inteligente

## Función
Conecta WhatsApp Business Cloud API con el motor AI Cliente Inteligente.

## Flujo
WhatsApp → Meta → /webhook → AI_AGENT_URL → respuesta → WhatsApp.

## Seguridad
Los secretos viven en variables de entorno. Nunca poner META_ACCESS_TOKEN en el frontend.

## Activación
El código está preparado. Para conectar el número real hacen falta los activos autorizados de Meta y el public key/workspace del agente.

## Motor existente
El endpoint de Supabase del producto Claude queda preconfigurado como AI_AGENT_URL. La URL por sí sola no autentica el canal: hay que completar AI_PUBLIC_KEY y WORKSPACE_ID.


## Estado
WhatsApp webhook y despliegue preparados para prueba end-to-end.
