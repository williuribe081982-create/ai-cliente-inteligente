/**
 * SIERRA — Puente de Google Calendar (Apps Script)
 * Lo usa SIERRA para: consultar disponibilidad (libre/ocupado), crear la reunión con Google Meet
 * (invitando al cliente) y cancelarla. Se publica como "Aplicación web" desde la cuenta de servicio de SIERRA
 * (p. ej. wia.soluciones@gmail.com). Los asesores de cada empresa comparten su calendario con esa cuenta.
 *
 * Requiere el servicio avanzado "Google Calendar API" (Servicios → + → Google Calendar API).
 * Publicar: Implementar → Nueva implementación → Aplicación web → Ejecutar como: Yo → Acceso: Cualquier usuario.
 */
const SECRET = 'PEGAR_AQUI_LA_CLAVE'; // la clave real se entrega por un canal privado; no se publica en GitHub

function doGet() {
  // Usado por el cron que mantiene el puente despierto.
  return out({ ok: true, alive: true });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out({ ok: false, error: 'BAD_JSON' }); }
  if (!req || req.secret !== SECRET) return out({ ok: false, error: 'FORBIDDEN' });
  try {
    switch (req.action) {
      case 'ping':
        return out({ ok: true, account: Session.getEffectiveUser().getEmail() });
      case 'freebusy':
        return out(freebusy(req));
      case 'create_event':
        return out(createEvent(req));
      case 'cancel_event':
        return out(cancelEvent(req));
      default:
        return out({ ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    return out({ ok: false, error: 'EXCEPTION', message: String(err && err.message || err) });
  }
}

function freebusy(req) {
  var ids = (req.calendars || ['primary']).slice(0, 20);
  var r = Calendar.Freebusy.query({
    timeMin: req.timeMin, timeMax: req.timeMax, timeZone: req.timeZone || 'America/Bogota',
    items: ids.map(function (id) { return { id: id }; })
  });
  var cals = {};
  ids.forEach(function (id) {
    var c = (r.calendars && r.calendars[id]) || {};
    cals[id] = {
      busy: (c.busy || []).map(function (b) { return { start: b.start, end: b.end }; }),
      errors: c.errors || []
    };
  });
  return { ok: true, calendars: cals };
}

function createEvent(req) {
  var calId = req.calendarId || 'primary';
  var ev = {
    summary: req.summary || 'Reunión',
    description: req.description || '',
    start: { dateTime: req.start, timeZone: req.timeZone || 'America/Bogota' },
    end: { dateTime: req.end, timeZone: req.timeZone || 'America/Bogota' },
    attendees: (req.attendees || []).map(function (m) { return { email: m }; }),
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 30 }] },
    guestsCanModify: false
  };
  if (req.location) ev.location = req.location;
  if (req.eventId) ev.id = req.eventId; // idempotente: el mismo id no crea dos eventos
  if (req.meet) ev.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  var created;
  try {
    created = Calendar.Events.insert(ev, calId, { conferenceDataVersion: req.meet ? 1 : 0, sendUpdates: 'all' });
  } catch (err) {
    // Si el evento ya existe (reintento), se devuelve el existente.
    if (req.eventId && /already exists|duplicate/i.test(String(err))) created = Calendar.Events.get(calId, req.eventId);
    else throw err;
  }
  var meet = created.hangoutLink || null;
  if (!meet && created.conferenceData && created.conferenceData.entryPoints) {
    created.conferenceData.entryPoints.forEach(function (p) { if (p.entryPointType === 'video') meet = p.uri; });
  }
  return { ok: true, id: created.id, htmlLink: created.htmlLink, meetUrl: meet };
}

function cancelEvent(req) {
  Calendar.Events.remove(req.calendarId || 'primary', req.eventId, { sendUpdates: 'all' });
  return { ok: true };
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
