/**
 * UzFinance · puente Gmail → /api/ingest/email
 *
 * Corre dentro de TU cuenta de Gmail (Google Apps Script), cada 5 minutos.
 * Envía a la app SOLO: messageId, remitente, asunto, fecha de recepción y cuerpo en texto.
 * Secretos: SOLO en Propiedades de la secuencia de comandos (Script Properties), nunca en este archivo.
 *
 * Propiedades requeridas:  UZ_URL (https://<tu-app>.azurewebsites.net)  y  UZ_TOKEN (token del puente Gmail).
 * Guía completa: README.md (misma carpeta).
 *
 * Gmail agrupa en un mismo hilo varios correos con el mismo asunto: aquí se procesa CADA MENSAJE por separado
 * (su propio messageId). La etiqueta del hilo es solo informativa; lo que ya se envió se sabe por mensaje.
 */

var SENDER = 'notificaciones@banamex.com';
var LABEL_SENT = 'uzfinance-enviado';        // informativa: el hilo tiene mensajes enviados
var LABEL_REJECTED = 'uzfinance-rechazado';  // el hilo tiene un mensaje que la app rechazó (error permanente)
var TIME_BUDGET_MS = 4.5 * 60000;            // el límite de Apps Script es 6 min por ejecución
var MAX_BODY = 40000;                        // la app acepta hasta 60,000 caracteres
var OVERLAP_MS = 6 * 3600 * 1000;            // se mira un poco hacia atrás por correos que lleguen con retraso
var DAY_MS = 24 * 3600 * 1000;
var PAGE = 100;                              // hilos por página de búsqueda
var MAX_PAGES = 10;
var SENT_KEEP = 200;                         // ids recordados (Script Properties admite ~9 KB por valor)

// Solo asuntos de transacciones (el resto de correos del banco no se envía).
var SUBJECTS = [
  'retiro/compra con tarjeta banamex',
  'retiro/compra con tarjeta adicional',
  'retiro/compra con cuenta banamex',
  'cargo a cuenta para pago a establecimiento',
  'deposito a cuenta o tarjeta banamex'
];

var ACCENTS = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' };
var ENTITIES = { ntilde: 'ñ', Ntilde: 'Ñ', iexcl: '¡', reg: '®', copy: '©' };
var KNOWN_LABELS = ['monto', 'establecimiento', 'fecha y hora', 'estatus', 'no. autorizacion', 'operacion', 'cuenta de cargo',
  'referencia establecimiento', 'referencia 4', 'medio', 'fecha de corte', 'fecha limite de pago', 'minimo a pagar'];

/* ───────────── puntos de entrada ───────────── */

/** Disparador cada 5 min. Sin correos nuevos no llama a la app (no despierta la base de datos). */
function processNew() {
  sync_('CURSOR', 'SENT', Date.now() - 2 * DAY_MS, OVERLAP_MS);
}

/**
 * Una sola vez: últimos 6 meses, por lotes e idempotente. Si se agota el tiempo, vuelve a ejecutarla:
 * continúa donde se quedó. `resetBackfill()` la reinicia.
 */
function backfill() {
  var done = sync_('BACKFILL_CURSOR', 'BACKFILL_SENT', Date.now() - 183 * DAY_MS, 0);
  console.log(done ? 'Backfill completo.' : 'Backfill incompleto: vuelve a ejecutar backfill().');
}

function resetBackfill() {
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('BACKFILL_CURSOR');
  p.deleteProperty('BACKFILL_SENT');
}

/**
 * Prueba sin escribir. Toma el correo de transacción más reciente, imprime su ESTRUCTURA con los valores
 * enmascarados (letras → x, dígitos → 9; solo las etiquetas conocidas quedan legibles), indica si usará
 * texto plano o HTML y muestra cómo lo interpretaría la app (dry-run). Pásame esa salida si hay que ajustar el parser.
 */
function testConnection() {
  var threads = GmailApp.search('from:' + SENDER, 0, 20);
  var msgs = flatten_(GmailApp.getMessagesForThreads(threads)).filter(isCandidate_);
  if (!msgs.length) { console.log('No hay correos de transacciones recientes para probar.'); return; }
  msgs.sort(byDate_);
  var m = msgs[msgs.length - 1];
  var plain = m.getPlainBody();
  var fromHtml = htmlToText_(m.getBody());
  var chosen = bodyText_(m);
  console.log('Asunto: ' + m.getSubject());
  console.log('Texto plano → ' + describe_(plain));
  console.log('Estructura (texto plano):\n' + maskedStructure_(plain));
  console.log('HTML convertido → ' + describe_(fromHtml));
  console.log('Estructura (HTML):\n' + maskedStructure_(fromHtml));
  console.log('Se enviará: ' + chosen.source);
  var r = post_(m, true);
  console.log('App → HTTP ' + r.code + ' ' + r.text);   // solo el veredicto, nunca el cuerpo
}

/** Crea el disparador de cada 5 minutos (ejecútala una vez). */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('processNew').timeBased().everyMinutes(5).create();
  console.log('Disparador creado: processNew cada 5 minutos.');
}

/** Quita los disparadores de este script. */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/* ───────────── núcleo ───────────── */

/**
 * Procesa mensajes (no hilos) en orden cronológico. Devuelve true si terminó sin quedarse sin tiempo ni toparse
 * con un error transitorio. El cursor solo avanza con mensajes ya resueltos, así nada se salta.
 */
function sync_(cursorKey, sentKey, initialMs, overlapMs) {
  var started = Date.now();
  var props = PropertiesService.getScriptProperties();
  var cursor = Number(props.getProperty(cursorKey)) || initialMs;
  var sinceMs = cursor - overlapMs;
  var sentSet = loadSent_(sentKey);   // id → fecha del mensaje (distingue mensajes con la misma marca de tiempo)
  var stats = { ok: 0, rejected: 0, skipped: 0 };

  var threads = searchThreads_('from:' + SENDER + ' after:' + Math.floor(sinceMs / 1000));
  var msgs = flatten_(GmailApp.getMessagesForThreads(threads)).filter(function (m) {
    if (m.getDate().getTime() < sinceMs || !isCandidate_(m)) { stats.skipped++; return false; }
    if (sentSet[m.getId()]) { stats.skipped++; return false; }
    return true;
  });
  msgs.sort(byDate_);

  var sentLabel = null, rejectedLabel = null;
  var complete = true;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (Date.now() - started > TIME_BUDGET_MS) { complete = false; break; }
    var r = post_(m, false);
    var code = r.code;
    if (code === 200) {
      stats.ok++;
      if (!sentLabel) sentLabel = getLabel_(LABEL_SENT);
      m.getThread().addLabel(sentLabel);
    } else if (code === 401) {
      saveState_(props, cursorKey, sentKey, cursor, sentSet);
      throw new Error('401: UZ_TOKEN incorrecto o revocado. Revisa las propiedades del script.');
    } else if (code === 0 || code === 429 || code >= 500) {
      complete = false; break;   // transitorio: la siguiente corrida lo reintenta (este mensaje no se marca)
    } else {
      // 400/403/413/415: reintentar no ayudaría. Se deja constancia y se sigue con el siguiente.
      stats.rejected++;
      console.warn('Rechazado (HTTP ' + code + ') asunto: ' + m.getSubject());
      if (!rejectedLabel) rejectedLabel = getLabel_(LABEL_REJECTED);
      m.getThread().addLabel(rejectedLabel);
    }
    sentSet[m.getId()] = m.getDate().getTime();
    cursor = Math.max(cursor, m.getDate().getTime());
  }
  saveState_(props, cursorKey, sentKey, cursor, sentSet);
  console.log('Enviados: ' + stats.ok + ' · rechazados: ' + stats.rejected + ' · omitidos: ' + stats.skipped);
  return complete;
}

function searchThreads_(q) {
  var all = [];
  for (var p = 0; p < MAX_PAGES; p++) {
    var page = GmailApp.search(q, p * PAGE, PAGE);
    all = all.concat(page);
    if (page.length < PAGE) break;
  }
  return all;
}

function loadSent_(key) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || '{}'); } catch (e) { return {}; }
}

/** Guarda el cursor y solo los ids que aún importan (los que caen dentro de la ventana de la próxima búsqueda). */
function saveState_(props, cursorKey, sentKey, cursor, sentSet) {
  props.setProperty(cursorKey, String(cursor));
  var floor = cursorKey === 'CURSOR' ? Date.now() - 2 * DAY_MS : cursor;
  var keep = Object.keys(sentSet)
    .filter(function (id) { return sentSet[id] >= floor; })
    .sort(function (a, b) { return sentSet[b] - sentSet[a]; })
    .slice(0, SENT_KEEP);
  var out = {};
  keep.forEach(function (id) { out[id] = sentSet[id]; });
  props.setProperty(sentKey, JSON.stringify(out));
}

/** Filtro local: remitente exacto y asunto soportado. */
function isCandidate_(m) {
  return address_(m.getFrom()) === SENDER && SUBJECTS.indexOf(fold_(m.getSubject())) !== -1;
}

function post_(m, dryRun) {
  var props = PropertiesService.getScriptProperties();
  var base = (props.getProperty('UZ_URL') || '').replace(/\/+$/, '');
  var token = props.getProperty('UZ_TOKEN');
  if (!base || !token) throw new Error('Faltan las propiedades UZ_URL y UZ_TOKEN (Script Properties).');
  if (base.indexOf('https://') !== 0) throw new Error('UZ_URL debe empezar con https://');

  var payload = JSON.stringify({
    messageId: m.getId(),
    from: address_(m.getFrom()),
    subject: m.getSubject(),
    receivedAt: m.getDate().toISOString(),
    bodyText: bodyText_(m).text.substring(0, MAX_BODY)
  });
  var headers = { Authorization: 'Bearer ' + token };
  if (dryRun) headers['X-Dry-Run'] = '1';

  // 503 = la base de datos gratuita se está despertando (30–60 s): reintentos con espera.
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var res = UrlFetchApp.fetch(base + '/api/ingest/email', {
        method: 'post', contentType: 'application/json', payload: payload, headers: headers, muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code !== 503 || attempt === 2) return { code: code, text: res.getContentText().substring(0, 300) };
    } catch (e) {
      if (attempt === 2) return { code: 0, text: String(e).substring(0, 200) };
    }
    Utilities.sleep(20000);
  }
  return { code: 0, text: '' };
}

/* ───────────── cuerpo del correo ───────────── */

/**
 * Texto plano si conserva las etiquetas de la tabla; si Gmail lo entrega desordenado, se reconstruye desde el HTML
 * (una celda por línea: "Etiqueta⏎valor"). Se envía siempre texto, nunca HTML.
 */
function bodyText_(m) {
  var plain = m.getPlainBody();
  if (hasLabels_(plain)) return { text: plain, source: 'texto plano' };
  var text = htmlToText_(m.getBody());
  return hasLabels_(text) ? { text: text, source: 'HTML (el texto plano venía desordenado)' } : { text: plain, source: 'texto plano (sin etiquetas reconocibles)' };
}

function hasLabels_(text) {
  var f = fold_(text);
  return /(^|\s)monto(\s|$)/.test(f) && f.indexOf('fecha y hora') !== -1;
}

/** HTML → texto con cada celda/bloque en su propia línea (también con tablas anidadas). */
function htmlToText_(html) {
  var t = String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(td|th|tr|p|div|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&([aeiouAEIOU])(acute);/g, function (_, v) { return ACCENTS[v]; })
    .replace(/&(ntilde|Ntilde|iexcl|reg|copy);/g, function (_, n) { return ENTITIES[n]; })
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); });
  return t.split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean).join('\n');
}

/** Estructura sin datos: etiquetas conocidas legibles; todo lo demás, letras → x/X y dígitos → 9. */
function maskedStructure_(text) {
  var lines = String(text || '').split(/\r?\n/);
  var out = lines.slice(0, 60).map(function (l, i) {
    var raw = l.replace(/\s+$/, '');
    var shown = KNOWN_LABELS.indexOf(fold_(raw).replace(/[:.]+$/, '')) !== -1 ? raw
      : raw.replace(/[A-ZÁÉÍÓÚÑ]/g, 'X').replace(/[a-záéíóúñ]/g, 'x').replace(/\d/g, '9');
    return (i + 1) + ': ' + shown;
  });
  if (lines.length > 60) out.push('… (' + lines.length + ' líneas en total)');
  return out.join('\n');
}

function describe_(text) {
  var s = String(text || '');
  return s.split(/\r?\n/).length + ' líneas, ' + (s.indexOf('\t') !== -1 ? 'con' : 'sin') + ' tabuladores, ' +
    (s.indexOf('|') !== -1 ? 'con' : 'sin') + ' barras "|", ' + s.length + ' caracteres';
}

/* ───────────── utilidades ───────────── */

function flatten_(arrays) {
  return [].concat.apply([], arrays);
}

function byDate_(a, b) {
  return a.getDate().getTime() - b.getDate().getTime() || (a.getId() < b.getId() ? -1 : 1);
}

function address_(from) {
  var match = /<([^>]+)>/.exec(from);
  return (match ? match[1] : from).trim().toLowerCase();
}

function fold_(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
