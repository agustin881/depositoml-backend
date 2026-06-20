// ============================================================
//  DEPÓSITO · BACKEND  v3.0
//  Fase 1: impresión por SKU + registro + reimpresión + conteo
//  Fase 2: verificación de despacho (escaneo + chequeo de cancelación),
//  seguimiento por etapas, código del día y colectas del día
//  App separada de MargenML. Comparte la base Supabase
//  (token de ML en ml_tokens) y usa tablas propias dep_*.
// ============================================================
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument } = require('pdf-lib');

const app = express();
app.use(cors({ origin: '*', exposedHeaders: ['X-Etiquetas-Unidas', 'X-Etiquetas-Fallidas'] }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_USER_ID       = process.env.ML_USER_ID || '67619515';
const DIAS_BUSQUEDA    = parseInt(process.env.DIAS_BUSQUEDA || '8', 10);

const LOGISTIC = { flex: 'self_service', colecta: 'cross_docking' };

// Solo trabajamos los envíos que salen de NUESTRO depósito (Rosario).
// OJO: ML no manda el nombre de la calle en sender_address, manda la
// CIUDAD. Los depósitos Full de ML aparecen como "Caseros" y
// "La Matanza"; el nuestro como "Rosario". Por eso filtramos por la
// ciudad "rosario" (sin acentos/mayúsculas). Configurable en Railway
// con DEPOSITO_FILTRO. Dejar la variable en "" desactiva el filtro.
function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
const DEPOSITO_FILTRO = normalizar(
  process.env.DEPOSITO_FILTRO !== undefined ? process.env.DEPOSITO_FILTRO : 'rosario'
);

// ── MODO DEMO · helpers y semilla (datos de prueba) ───────────────
// Los envíos demo viven en dep_demo y usan shipment_id con prefijo
// "DEMO-". El escaneo y el seguimiento los reconocen por ese prefijo,
// así nunca se mezclan con datos reales ni le pegan a la API de ML.
const ES_DEMO = id => String(id || '').startsWith('DEMO-');

const SEMILLA_DEMO = [
  { sku: 'BACK003-GR',  titulo: 'Mochila Porta Notebook Muy Segura',     tipo: 'flex',    status: 'ready_to_ship', preparar: false, despachar: false },
  { sku: 'BIC06',       titulo: 'Maquina Cuenta Dinero Contadora',       tipo: 'flex',    status: 'ready_to_ship', preparar: true,  despachar: false },
  { sku: 'GAB100',      titulo: 'Gaveta 5 Compartimientos Registradora', tipo: 'colecta', status: 'ready_to_ship', preparar: true,  despachar: false },
  { sku: 'KH-ESC80',    titulo: 'Escritorio Koa Home 80 Melamina',       tipo: 'flex',    status: 'ready_to_ship', preparar: true,  despachar: true  },
  { sku: 'MTF1000NP',   titulo: 'Rack Tv Flotante Modular Negro',        tipo: 'colecta', status: 'shipped',       preparar: true,  despachar: true  },
  { sku: 'PER100-BL',   titulo: 'Perchero Comercial Metalico Blanco',    tipo: 'colecta', status: 'delivered',     preparar: true,  despachar: true  },
  { sku: 'STL150-NE',   titulo: 'Cochecito Paragüitas Cartan Stl150',    tipo: 'flex',    status: 'not_delivered', preparar: true,  despachar: true  },
  { sku: 'REF050-6500K',titulo: 'Reflector Proyector Led 50w Ip66',      tipo: 'flex',    status: 'cancelled',     preparar: true,  despachar: false }
];

async function obtenerDemo() {
  const { data, error } = await supabase.from('dep_demo')
    .select('shipment_id,nro_venta,sku,titulo,tipo,status,limite');
  if (error) { console.error('[DEMO] leer:', error.message); return []; }
  return (data || []).map(d => ({
    shipment_id: d.shipment_id, nro_venta: d.nro_venta, sku: d.sku, titulo: d.titulo,
    logistic: d.tipo === 'flex' ? 'self_service' : d.tipo === 'colecta' ? 'cross_docking' : d.tipo,
    status: d.status, substatus: '', limite: d.limite, dep_id: '', dep_dir: '', _demo: true
  }));
}

// Estados de envío de ML traducidos
const ESTADO_ES = {
  pending:        'Pendiente',
  handling:       'En preparación',
  ready_to_print: 'Etiqueta por imprimir',
  printed:        'Etiqueta impresa',
  ready_to_ship:  'Listo para despachar (todavía no salió)',
  shipped:        'Despachado · en camino',
  delivered:      'Entregado',
  not_delivered:  'No entregado · con problema',
  cancelled:      'Cancelado',
  returned:       'Devuelto'
};

// Emails autorizados a entrar al depósito (separados por coma en Railway).
// Si la variable está vacía, deja entrar a cualquier usuario logueado.
const EMAILS_DEPOSITO = (process.env.EMAILS_DEPOSITO || '')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Middleware: exige usuario logueado (token de Supabase) ────────
async function requireAuth(req, res, next) {
  try {
    // Excepción temporal: diagnóstico accesible con clave en la URL (para debug)
    if ((req.path === '/diag' || req.path === '/diag-envio' || req.path === '/diag-colectas' || req.path === '/diag-fechas') && (req.query.clave || '') === 'pontec2026') return next();
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Sesión inválida' });
    const email = (data.user.email || '').toLowerCase();
    if (EMAILS_DEPOSITO.length && !EMAILS_DEPOSITO.includes(email)) {
      return res.status(403).json({ error: 'Tu usuario no tiene acceso al depósito' });
    }
    req.authUser = data.user;
    next();
  } catch (e) { return res.status(401).json({ error: 'No autorizado' }); }
}

// Hora Argentina (UTC-3)
function fechaHoyART()      { return new Date(Date.now() - 3*3600*1000).toISOString().substring(0,10); }
function inicioDeHoyART()   { return fechaHoyART() + 'T00:00:00.000-03:00'; }
function diaSemanaHoyART()  {
  const d = new Date(Date.now() - 3*3600*1000);
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getUTCDay()];
}

// ── Helper: token válido (mismo patrón que MargenML) ──────────────
async function getValidToken(userId) {
  const { data: tokenRow } = await supabase
    .from('ml_tokens').select('*').eq('user_id', String(userId)).single();
  if (!tokenRow) return null;
  if (new Date(tokenRow.expires_at).getTime() - 60000 > Date.now()) return tokenRow.access_token;

  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET, refresh_token: tokenRow.refresh_token
    })
  });
  const data = await resp.json();
  if (data.error) { console.error('[TOKEN] refresh falló:', data); return tokenRow.access_token; }

  await supabase.from('ml_tokens').upsert({
    user_id: String(userId), access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  return data.access_token;
}

// ── Helper: tareas con concurrencia limitada (mantiene el orden) ──
async function poolMap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Núcleo: traer TODOS los envíos recientes con detalle ──────────
// (estado, logística, fecha límite de despacho)
// onLote(filas) opcional: se llama con cada lote de envíos ya detallados,
// para poder ir guardando en la foto a medida que avanza (carga robusta).
async function obtenerShipmentsDetallados(token, onLote) {
  const desde = new Date();
  desde.setDate(desde.getDate() - DIAS_BUSQUEDA);
  const desdeISO = desde.toISOString().substring(0,10) + 'T00:00:00.000-03:00';
  const hastaISO = new Date().toISOString().substring(0,10) + 'T23:59:59.000-03:00';

  const ordenes = [];
  let offset = 0, total = 999;
  while (offset < Math.min(total, 2000)) {
    const url = `https://api.mercadolibre.com/orders/search?seller=${ML_USER_ID}`
      + `&order.status=paid`
      + `&order.date_created.from=${encodeURIComponent(desdeISO)}`
      + `&order.date_created.to=${encodeURIComponent(hastaISO)}`
      + `&sort=date_desc&offset=${offset}&limit=50&access_token=${token}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) { console.error('[ENVIOS] orders/search error:', JSON.stringify(data)); break; }
    total = (data.paging && data.paging.total) || 0;
    for (const o of (data.results || [])) ordenes.push(o);
    offset += 50;
    await sleep(150);
  }

  const porShipment = new Map();
  for (const o of ordenes) {
    const shipId = o.shipping && o.shipping.id;
    if (!shipId) continue;
    const item = (o.order_items && o.order_items[0]) || {};
    const sku  = (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '';
    const titulo = (item.item && item.item.title) || '';
    if (!porShipment.has(shipId)) {
      porShipment.set(shipId, {
        shipment_id: String(shipId), nro_venta: String(o.id),
        pack_id: o.pack_id ? String(o.pack_id) : null,
        sku: sku ? String(sku).trim() : '', titulo, unidades: item.quantity || 1
      });
    }
  }

  const shipments = Array.from(porShipment.values());
  console.log(`[ENVIOS] ${ordenes.length} órdenes → ${shipments.length} envíos únicos. Pidiendo detalle…`);

  const traerDetalle = async (s) => {
    try {
      const r = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const ship = await r.json();
      s.status   = ship.status || '';
      s.substatus = ship.substatus || '';
      s.logistic = ship.logistic_type || (ship.logistic && ship.logistic.type) || '';
      s.limite   = (ship.shipping_option && ship.shipping_option.estimated_handling_limit
                    && ship.shipping_option.estimated_handling_limit.date) || null;
      const sa = ship.sender_address || {};
      s.dep_id  = sa.id ? String(sa.id) : '';
      s.dep_dir = `${sa.address_line || ''} ${(sa.city && sa.city.name) || ''}`.trim();
    } catch (e) { s.status = 'error'; s.logistic = ''; s.limite = null; s.dep_id = ''; s.dep_dir = ''; }
    return s;
  };

  const pasaFiltro = (s) =>
    !DEPOSITO_FILTRO ? true
      : (!s.dep_dir ? true : normalizar(s.dep_dir).includes(DEPOSITO_FILTRO) || s.dep_id === DEPOSITO_FILTRO);

  // Procesar en bloques: traer detalle (12 en paralelo) y, si hay callback,
  // guardar ese bloque ya filtrado antes de seguir (carga incremental/robusta).
  const BLOQUE = 120;
  const todos = [];
  let procesados = 0, afuera = 0;
  for (let i = 0; i < shipments.length; i += BLOQUE) {
    const bloque = shipments.slice(i, i + BLOQUE);
    const detallados = await poolMap(bloque, 12, traerDetalle);
    const delDeposito = detallados.filter(s => { const ok = pasaFiltro(s); if (!ok) afuera++; return ok; });
    if (onLote && delDeposito.length) { try { await onLote(delDeposito); } catch (e) { console.error('[ENVIOS] onLote', e.message); } }
    for (const s of delDeposito) todos.push(s);
    procesados += bloque.length;
    console.log(`[ENVIOS] progreso ${procesados}/${shipments.length} (acumulado nuestro: ${todos.length})`);
    await sleep(120);
  }
  if (afuera) console.log(`[ENVIOS] ${afuera} envío(s) de otro depósito quedaron afuera`);
  return todos;
}

// ── Foto local: mapear un envío a la fila de dep_envios ───────────
const tipoDeLogistic = lt =>
  lt === 'self_service' ? 'flex' : lt === 'cross_docking' ? 'colecta' : lt === 'fulfillment' ? 'full' : (lt || 'otro');

function filaEnvio(s) {
  const lt = s.logistic || '';
  const dir = s.dep_dir || '';
  const esNuestro = !DEPOSITO_FILTRO ? true
    : (!dir ? true : normalizar(dir).includes(DEPOSITO_FILTRO) || s.dep_id === DEPOSITO_FILTRO);
  return {
    shipment_id: String(s.shipment_id),
    nro_venta: s.nro_venta ? String(s.nro_venta) : null,
    pack_id: s.pack_id ? String(s.pack_id) : null,
    sku: s.sku || null,
    titulo: s.titulo || null,
    unidades: s.unidades || 1,
    tipo: tipoDeLogistic(lt),
    status: s.status || null,
    substatus: s.substatus || null,
    limite: s.limite ? String(s.limite).substring(0,10) : null,
    ciudad_depo: dir || null,
    es_nuestro: esNuestro,
    cancelada: s.status === 'cancelled',
    actualizado_at: new Date().toISOString()
  };
}

// ── Foto local: traer UN envío de ML y guardarlo (lo usa el webhook) ─
async function actualizarFotoEnvio(shipmentId, token) {
  try {
    const r = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const ship = await r.json();
    if (!ship || !ship.id) return false;

    const s = {
      shipment_id: String(ship.id),
      status: ship.status || '',
      substatus: ship.substatus || '',
      logistic: ship.logistic_type || (ship.logistic && ship.logistic.type) || '',
      limite: (ship.shipping_option && ship.shipping_option.estimated_handling_limit
               && ship.shipping_option.estimated_handling_limit.date) || null,
    };
    const sa = ship.sender_address || {};
    s.dep_id = sa.id ? String(sa.id) : '';
    s.dep_dir = `${sa.address_line || ''} ${(sa.city && sa.city.name) || ''}`.trim();

    // Datos de la orden (SKU, título, venta) — los traemos si el envío los referencia
    const oid = ship.order_id || (Array.isArray(ship.order_ids) && ship.order_ids[0]);
    if (oid) {
      try {
        const ro = await fetch(`https://api.mercadolibre.com/orders/${oid}?access_token=${token}`);
        const order = await ro.json();
        if (order && order.id) {
          const item = (order.order_items && order.order_items[0]) || {};
          s.nro_venta = String(order.id);
          s.pack_id = order.pack_id ? String(order.pack_id) : null;
          s.sku = (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '';
          s.sku = s.sku ? String(s.sku).trim() : '';
          s.titulo = (item.item && item.item.title) || '';
          s.unidades = item.quantity || 1;
          if (order.status === 'cancelled') s.status = s.status || 'cancelled';
          s._orderStatus = order.status;
        }
      } catch (e) { /* seguimos con lo que tengamos del envío */ }
    }

    const fila = filaEnvio(s);
    if (s._orderStatus === 'cancelled') fila.cancelada = true;
    const { error } = await supabase.from('dep_envios').upsert(fila, { onConflict: 'shipment_id' });
    if (error) { console.error('[FOTO] upsert', error.message); return false; }
    console.log(`[FOTO] ship=${fila.shipment_id} status=${fila.status}/${fila.substatus} tipo=${fila.tipo} nuestro=${fila.es_nuestro}`);
    return true;
  } catch (e) { console.error('[FOTO]', e.message); return false; }
}

const ordenarPorSku = (a, b) => {
  if (!a.sku && b.sku) return 1;
  if (a.sku && !b.sku) return -1;
  return (a.sku || '').localeCompare(b.sku || '', 'es', { numeric: true, sensitivity: 'base' });
};

// ── Caché compartida de envíos + precarga automática ──────────────
// La misma búsqueda sirve para Flex, Colecta y Seguimiento. Además,
// en horario laboral el backend la refresca solo cada PRECARGA_MINUTOS,
// así el "Buscar pendientes" responde al instante.
const CACHE_TTL_MS   = parseInt(process.env.CACHE_MINUTOS || '5', 10) * 60 * 1000;
const PRECARGA_DESDE = process.env.PRECARGA_DESDE || '06:30';   // hora argentina
const PRECARGA_HASTA = process.env.PRECARGA_HASTA || '19:00';
const PRECARGA_MIN   = parseInt(process.env.PRECARGA_MINUTOS || '5', 10);

let _envCache = { at: 0, detallados: null };

async function obtenerDetalladosConCache(token, forzar = false) {
  if (!forzar && _envCache.detallados && Date.now() - _envCache.at < CACHE_TTL_MS) {
    return _envCache.detallados;
  }
  const detallados = await obtenerShipmentsDetallados(token);
  _envCache = { at: Date.now(), detallados };
  return detallados;
}

let _precargando = false;
setInterval(async () => {
  if (_precargando) return;
  try {
    const hhmm = new Date(Date.now() - 3*3600*1000).toISOString().substring(11,16);
    if (hhmm < PRECARGA_DESDE || hhmm > PRECARGA_HASTA) return;
    if (_envCache.detallados && Date.now() - _envCache.at < PRECARGA_MIN * 60 * 1000 - 30000) return;
    _precargando = true;
    const token = await getValidToken(ML_USER_ID);
    if (token) {
      await obtenerDetalladosConCache(token, true);
      console.log(`[PRECARGA] envíos actualizados (${_envCache.detallados.length})`);
    }
  } catch (e) { console.error('[PRECARGA]', e.message); }
  finally { _precargando = false; }
}, 60 * 1000);

// ── Envíos de una tanda (flex/colecta), ordenados por SKU ─────────
async function obtenerEnvios(tipo) {
  const logisticBuscado = LOGISTIC[tipo];
  if (!logisticBuscado) throw new Error('Tipo inválido (usá flex o colecta)');
  const token = await getValidToken(ML_USER_ID);
  if (!token) throw new Error('No hay token de ML disponible en ml_tokens');

  const detallados = await obtenerDetalladosConCache(token);
  const deLaTanda = detallados.filter(s => s.logistic === logisticBuscado);

  // Criterio (copiando a ML): "listo para imprimir" = substatus
  // ready_to_print (o ready_to_ship sin substatus). Los "programados"
  // son los que ML libera recién en una fecha futura (todavía no
  // imprimibles): no están ready_to_print y su límite es posterior a hoy.
  const hoy = fechaHoyART();
  const esFuturo = s => s.limite && String(s.limite).substring(0,10) > hoy;
  const imprimible = s => s.status === 'ready_to_ship' &&
    (s.substatus === 'ready_to_print' || s.substatus === 'ready_to_ship' || !s.substatus);

  const listos      = deLaTanda.filter(s => imprimible(s));
  const programados = deLaTanda.filter(s => !imprimible(s) && s.status === 'ready_to_ship' && esFuturo(s));
  // "No listos" = en proceso (in_warehouse, ready_to_pack, packed, etc.),
  // NO lo ya despachado/entregado/cancelado ni lo ya imprimible/programado.
  const TERMINADOS = ['shipped', 'delivered', 'not_delivered', 'cancelled', 'returned'];
  const yaContado = new Set([...listos, ...programados].map(s => s.shipment_id));
  const noListos  = deLaTanda.filter(s =>
    !yaContado.has(s.shipment_id) && !TERMINADOS.includes(s.status));

  listos.sort(ordenarPorSku); programados.sort(ordenarPorSku); noListos.sort(ordenarPorSku);
  console.log(`[ENVIOS] tipo=${tipo} listos=${listos.length} programados=${programados.length} no_listos=${noListos.length}`);
  return { listos, programados, no_listos: noListos, token };
}

// ── Helper: pedir etiquetas y armar el PDF en orden ───────────────
// Pide las etiquetas a ML en LOTES de hasta 50 envíos por llamada
// (manteniendo el orden por SKU). En el PDF final van primero TODAS
// las etiquetas y al final del archivo las hojas de detalle/remito.
// Si un lote falla, ese lote se reintenta pidiendo de a un envío.
const LOTE_ETIQUETAS = 50;

async function armarPdf(shipments, token) {
  const etiquetas = await PDFDocument.create();
  const detalles  = await PDFDocument.create();
  const impresos = []; let fallidas = 0;

  // Procesa un envío individual: página 0 = etiqueta, resto = detalle
  async function pedirUno(s) {
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/shipment_labels?shipment_ids=${s.shipment_id}&response_type=pdf`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) { console.error(`[ETIQUETA] ship=${s.shipment_id} HTTP ${r.status}`); return null; }
      return await r.buffer();
    } catch (e) { console.error(`[ETIQUETA] ship=${s.shipment_id}: ${e.message}`); return null; }
  }

  async function unirIndividual(chunk) {
    const buffers = await poolMap(chunk, 5, pedirUno);
    for (let i = 0; i < buffers.length; i++) {
      const buf = buffers[i];
      if (!buf || buf.__error) { fallidas++; continue; }
      try {
        const src = await PDFDocument.load(buf);
        const idx = src.getPageIndices();
        const [lab] = await etiquetas.copyPages(src, [idx[0]]);
        etiquetas.addPage(lab);
        if (idx.length > 1) {
          const dets = await detalles.copyPages(src, idx.slice(1));
          dets.forEach(p => detalles.addPage(p));
        }
        impresos.push(chunk[i]);
      } catch (e) {
        console.error(`[ETIQUETA] unir ship=${chunk[i].shipment_id}: ${e.message}`);
        fallidas++;
      }
    }
  }

  // Partir en lotes de hasta 50, respetando el orden por SKU
  const lotes = [];
  for (let i = 0; i < shipments.length; i += LOTE_ETIQUETAS) {
    lotes.push(shipments.slice(i, i + LOTE_ETIQUETAS));
  }

  for (const lote of lotes) {
    // Un solo envío: directo por la vía individual (mismo resultado)
    if (lote.length === 1) { await unirIndividual(lote); continue; }

    let buf = null;
    try {
      const ids = lote.map(s => s.shipment_id).join(',');
      const r = await fetch(
        `https://api.mercadolibre.com/shipment_labels?shipment_ids=${ids}&response_type=pdf`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (r.ok) buf = await r.buffer();
      else console.error(`[ETIQUETAS] lote de ${lote.length} HTTP ${r.status} → reintento de a uno`);
    } catch (e) {
      console.error(`[ETIQUETAS] lote de ${lote.length}: ${e.message} → reintento de a uno`);
    }

    let unido = false;
    if (buf) {
      try {
        const src = await PDFDocument.load(buf);
        const total = src.getPageCount();
        // En el PDF por lote, ML pone primero 1 página de etiqueta por envío
        // (en el orden pedido) y al final las hojas de detalle consolidadas.
        if (total >= lote.length) {
          const labIdx = Array.from({ length: lote.length }, (_, i) => i);
          const labs = await etiquetas.copyPages(src, labIdx);
          labs.forEach(p => etiquetas.addPage(p));
          if (total > lote.length) {
            const detIdx = Array.from({ length: total - lote.length }, (_, i) => lote.length + i);
            const dets = await detalles.copyPages(src, detIdx);
            dets.forEach(p => detalles.addPage(p));
          }
          impresos.push(...lote);
          unido = true;
        } else {
          console.error(`[ETIQUETAS] lote devolvió ${total} páginas para ${lote.length} envíos → reintento de a uno`);
        }
      } catch (e) {
        console.error(`[ETIQUETAS] lote ilegible: ${e.message} → reintento de a uno`);
      }
    }
    if (!unido) await unirIndividual(lote);
    await sleep(200);
  }

  // Combinar: primero todas las etiquetas (orden SKU), después los detalles
  const merged = await PDFDocument.create();
  const labPages = await merged.copyPages(etiquetas, etiquetas.getPageIndices());
  labPages.forEach(p => merged.addPage(p));
  const detPages = await merged.copyPages(detalles, detalles.getPageIndices());
  detPages.forEach(p => merged.addPage(p));

  const bytes = await merged.save();
  return { bytes, impresos, fallidas };
}

// ── Helper: número de venta (o Pack ID) → datos del envío ─────────
async function resolverShipmentPorVenta(venta, token) {
  let r = await fetch(`https://api.mercadolibre.com/orders/${venta}?access_token=${token}`);
  let order = await r.json();

  // Si no es una orden, probamos como Pack ID (las etiquetas de packs muestran ese número)
  if (order.error || !order.id) {
    try {
      const rp = await fetch(`https://api.mercadolibre.com/packs/${venta}`,
        { headers: { Authorization: `Bearer ${token}` } });
      const pack = await rp.json();
      const oid = pack && pack.orders && pack.orders[0] && pack.orders[0].id;
      if (!oid) return null;
      r = await fetch(`https://api.mercadolibre.com/orders/${oid}?access_token=${token}`);
      order = await r.json();
      if (order.error || !order.id) return null;
    } catch (e) { return null; }
  }

  const shipId = order.shipping && order.shipping.id;
  if (!shipId) return null;
  const item = (order.order_items && order.order_items[0]) || {};
  return {
    shipment_id: String(shipId),
    nro_venta: String(order.id),
    sku: (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '',
    titulo: (item.item && item.item.title) || ''
  };
}

async function registrarImpresion(impresos, tipo) {
  if (!impresos.length) return;
  const filas = impresos.map(s => ({
    shipment_id: s.shipment_id, tipo, sku: s.sku || null,
    nro_venta: s.nro_venta || null, titulo: s.titulo || null
  }));
  const { error } = await supabase.from('dep_impresiones').insert(filas);
  if (error) console.error('[REGISTRO] error guardando impresión:', error.message);
}

function pdfResponse(res, bytes, ok, fallidas, nombre) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.setHeader('X-Etiquetas-Unidas', String(ok));
  res.setHeader('X-Etiquetas-Fallidas', String(fallidas));
  res.send(Buffer.from(bytes));
}

// ══════════════════════════════════════════════════════════════════
//  WEBHOOKS de Mercado Libre (PÚBLICO · va ANTES del requireAuth)
//  ML postea acá cada vez que algo cambia. Por ahora solo lo
//  REGISTRAMOS para diagnosticar qué llega; en el próximo paso lo
//  usamos para mantener la foto local al día.
//  URL a registrar en ML DevCenter:
//    https://<backend>/api/despacho/webhook
// ══════════════════════════════════════════════════════════════════
app.post('/api/despacho/webhook', async (req, res) => {
  // Responder 200 rápido SIEMPRE (si tardás, ML reintenta y te penaliza)
  res.sendStatus(200);
  try {
    const n = req.body || {};
    console.log(`[WEBHOOK] topic=${n.topic || '?'} resource=${n.resource || '?'} user=${n.user_id || '?'}`);
    // Registro crudo (diagnóstico / auditoría)
    supabase.from('dep_webhooks').insert({
      topic: n.topic || null,
      resource: n.resource || null,
      ml_user_id: n.user_id ? String(n.user_id) : null,
      application_id: n.application_id ? String(n.application_id) : null,
      attempts: n.attempts || null,
      sent: n.sent || null,
      received_at: new Date().toISOString(),
      raw: n
    }).then(({ error }) => { if (error) console.error('[WEBHOOK] log', error.message); });

    // Actualizar la FOTO LOCAL del envío afectado (esto da el "tiempo real")
    const res2 = String(n.resource || '');
    if (n.topic === 'shipments' && res2.startsWith('/shipments/')) {
      const shipId = res2.split('/').pop();
      const token = await getValidToken(n.user_id || ML_USER_ID);
      if (token && shipId) await actualizarFotoEnvio(shipId, token);
    } else if ((n.topic === 'orders_v2' || n.topic === 'orders') && res2.includes('/orders/')) {
      // Una venta cambió: buscamos su envío y refrescamos la foto
      const orderId = res2.split('/').pop();
      const token = await getValidToken(n.user_id || ML_USER_ID);
      if (token && orderId) {
        try {
          const ro = await fetch(`https://api.mercadolibre.com/orders/${orderId}?access_token=${token}`);
          const order = await ro.json();
          const shipId = order && order.shipping && order.shipping.id;
          if (shipId) await actualizarFotoEnvio(String(shipId), token);
        } catch (e) { console.error('[WEBHOOK] orden→envío', e.message); }
      }
    }
  } catch (e) { console.error('[WEBHOOK]', e.message); }
});

// Inspección de los últimos webhooks recibidos (con clave, para el navegador)
app.get('/api/despacho/webhook-diag', async (req, res) => {
  if ((req.query.clave || '') !== 'pontec2026')
    return res.status(401).json({ error: 'Agregá ?clave=pontec2026 al final de la URL' });
  try {
    const { data, error } = await supabase.from('dep_webhooks')
      .select('topic,resource,ml_user_id,application_id,received_at')
      .order('received_at', { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    const porTopic = (data || []).reduce((a, w) => { const k = w.topic || '(vacío)'; a[k] = (a[k]||0)+1; return a; }, {});
    res.json({
      total_ultimos_50: (data || []).length,
      por_topic: porTopic,
      ultimo: (data && data[0]) ? data[0].received_at : null,
      detalle: data || []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Todos los endpoints del depósito exigen estar logueado ────────
app.use('/api/despacho', requireAuth);

// ── FOTO LOCAL: carga inicial / resincronización ──────────────────
// Llena dep_envios con todo lo reciente, GUARDANDO a medida que avanza
// (así aunque se corte, lo procesado queda). Los webhooks la mantienen
// al día después. El estado queda en _fotoCarga para que el panel lo vea.
let _fotoCarga = { corriendo: false, guardados: 0, desde: null, fin: null };
app.post('/api/despacho/foto/cargar', async (_req, res) => {
  if (_fotoCarga.corriendo) return res.json({ ok: true, ya_corriendo: true, guardados: _fotoCarga.guardados });
  _fotoCarga = { corriendo: true, guardados: 0, desde: new Date().toISOString(), fin: null };
  res.json({ ok: true, mensaje: 'Carga iniciada. Va guardando a medida que avanza; el panel se va llenando solo.' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) { console.error('[FOTO-CARGA] sin token'); return; }
    await obtenerShipmentsDetallados(token, async (lote) => {
      const filas = lote.map(filaEnvio);
      const { error } = await supabase.from('dep_envios').upsert(filas, { onConflict: 'shipment_id' });
      if (error) console.error('[FOTO-CARGA] lote', error.message);
      else _fotoCarga.guardados += filas.length;
    });
    console.log(`[FOTO-CARGA] COMPLETA · ${_fotoCarga.guardados} envíos en la foto local`);
  } catch (e) { console.error('[FOTO-CARGA]', e.message); }
  finally { _fotoCarga.corriendo = false; _fotoCarga.fin = new Date().toISOString(); }
});

// Estado de la carga (para que el panel muestre el progreso)
app.get('/api/despacho/foto/estado', async (_req, res) => {
  try {
    const { count } = await supabase.from('dep_envios')
      .select('shipment_id', { count: 'exact', head: true }).eq('es_nuestro', true);
    res.json({ corriendo: _fotoCarga.corriendo, guardados_en_esta_carga: _fotoCarga.guardados,
               total_en_foto: count || 0, desde: _fotoCarga.desde, fin: _fotoCarga.fin });
  } catch (e) { res.json({ corriendo: _fotoCarga.corriendo, error: e.message }); }
});

// ── PANEL EN VIVO: lee la foto local (rápido, sin pegarle a ML) ────
// Devuelve todo clasificado por etapa, listo para el panel.
app.get('/api/despacho/panel', async (_req, res) => {
  try {
    // Estados despachados localmente (escaneados al cargar el camión)
    const { data: desp } = await supabase.from('dep_despachos')
      .select('shipment_id,despachado_at,colecta_carrier,colecta_patente');
    const despMap = new Map();
    for (const d of (desp || [])) if (!despMap.has(d.shipment_id)) despMap.set(d.shipment_id, d);

    // Impresas (alguna vez)
    const { data: imp } = await supabase.from('dep_impresiones').select('shipment_id');
    const impSet = new Set((imp || []).map(r => r.shipment_id));

    // Foto local (solo lo nuestro, sin Full)
    let envios = [], from = 0;
    while (true) {
      const { data, error } = await supabase.from('dep_envios')
        .select('shipment_id,nro_venta,sku,titulo,unidades,tipo,status,substatus,limite,es_nuestro,cancelada,actualizado_at')
        .eq('es_nuestro', true).neq('tipo', 'full')
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      envios = envios.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    const hoy = fechaHoyART();
    const esFuturo = s => s.limite && String(s.limite) > hoy;
    const imprimible = s => s.status === 'ready_to_ship' &&
      (s.substatus === 'ready_to_print' || s.substatus === 'ready_to_ship' || !s.substatus);

    const etapas = { para_imprimir: [], programados: [], en_preparacion: [],
                     despachadas: [], en_camino: [], entregadas: [], devoluciones: [] };
    const TERMINADOS = ['shipped', 'delivered', 'not_delivered', 'returned', 'cancelled'];

    for (const s of envios) {
      const d = despMap.get(s.shipment_id);
      const fila = {
        shipment_id: s.shipment_id, nro_venta: s.nro_venta, sku: s.sku, titulo: s.titulo,
        unidades: s.unidades || 1, tipo: s.tipo, status: s.status, substatus: s.substatus,
        estado: ESTADO_ES[s.status] || s.status,
        limite: s.limite || null,
        despachado_at: d ? d.despachado_at : null,
        colecta: d && d.colecta_carrier ? `${d.colecta_carrier}${d.colecta_patente ? ' · ' + d.colecta_patente : ''}` : null
      };
      if (s.cancelada || s.status === 'cancelled') {
        // Cancelada: solo nos importa si ya estaba impresa o despachada (alerta)
        if (impSet.has(s.shipment_id) || d) { fila.alerta = 'CANCELADA'; etapas.devoluciones.push(fila); }
        continue;
      }
      if (['not_delivered', 'returned'].includes(s.status)) etapas.devoluciones.push(fila);
      else if (s.status === 'delivered')                    etapas.entregadas.push(fila);
      else if (s.status === 'shipped')                      etapas.en_camino.push(fila);
      else if (d)                                           etapas.despachadas.push(fila);
      else if (impSet.has(s.shipment_id))                   etapas.en_preparacion.push(fila);
      else if (!imprimible(s) && esFuturo(s))               etapas.programados.push(fila);
      else if (imprimible(s))                               etapas.para_imprimir.push(fila);
      // (lo que está en proceso y no imprimible ni futuro queda sin etapa visible)
    }
    for (const k of Object.keys(etapas)) etapas[k].sort(ordenarPorSku);

    // Contadores por tanda de lo que está para imprimir
    const porImprimir = etapas.para_imprimir;
    const cont = {
      flex: porImprimir.filter(s => s.tipo === 'flex').length,
      colecta: porImprimir.filter(s => s.tipo === 'colecta').length
    };

    // ¿Cuándo se actualizó la foto por última vez?
    let ultima = null;
    for (const s of envios) if (!ultima || s.actualizado_at > ultima) ultima = s.actualizado_at;

    res.json({
      conteos: Object.fromEntries(Object.entries(etapas).map(([k, v]) => [k, v.length])),
      por_imprimir: cont,
      total_foto: envios.length,
      actualizado: ultima,
      etapas
    });
  } catch (e) { console.error('[PANEL]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoints: impresión ──────────────────────────────────────────
app.get('/api/despacho/pendientes', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    const { listos, programados, no_listos } = await obtenerEnvios(tipo);
    res.json({
      tipo, cantidad: listos.length,
      listos: listos.map(({ shipment_id, nro_venta, sku, titulo, unidades }) =>
        ({ shipment_id, nro_venta, sku, titulo, unidades })),
      programados: programados.map(({ shipment_id, nro_venta, sku, titulo, unidades, limite }) =>
        ({ shipment_id, nro_venta, sku, titulo, unidades, limite: limite ? String(limite).substring(0,10) : null })),
      no_listos: no_listos.map(({ shipment_id, nro_venta, sku, titulo, status }) =>
        ({ shipment_id, nro_venta, sku, titulo, status }))
    });
  } catch (e) { console.error('[PENDIENTES]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/despacho/etiquetas', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    const { listos, token } = await obtenerEnvios(tipo);
    if (!listos.length) return res.status(404).json({ error: 'No hay envíos listos para imprimir en esta tanda' });
    const { bytes, impresos, fallidas } = await armarPdf(listos, token);
    await registrarImpresion(impresos, tipo);
    console.log(`[ETIQUETAS] tipo=${tipo} unidas=${impresos.length} fallidas=${fallidas}`);
    pdfResponse(res, bytes, impresos.length, fallidas, `etiquetas_${tipo}_${fechaHoyART()}.pdf`);
  } catch (e) { console.error('[ETIQUETAS]', e.message); res.status(500).json({ error: e.message }); }
});

// Imprimir una SELECCIÓN de envíos (desde el panel: tildados o "todos")
// GET /api/despacho/etiquetas-seleccion?ids=111,222,333
app.get('/api/despacho/etiquetas-seleccion', async (req, res) => {
  try {
    const idsParam = (req.query.ids || '').trim();
    if (!idsParam) return res.status(400).json({ error: 'Indicá ?ids=' });
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Lista de envíos vacía' });

    // Traemos sku/tipo/venta/título desde la foto local para ordenar y registrar bien
    const { data } = await supabase.from('dep_envios')
      .select('shipment_id,sku,tipo,nro_venta,titulo').in('shipment_id', ids);
    const meta = new Map((data || []).map(r => [r.shipment_id, r]));
    const lista = ids.map(id => {
      const m = meta.get(id) || {};
      return { shipment_id: id, sku: m.sku || '', tipo: m.tipo || '',
               nro_venta: m.nro_venta || '', titulo: m.titulo || '' };
    });
    lista.sort(ordenarPorSku);

    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const { bytes, impresos, fallidas } = await armarPdf(lista, token);
    if (!impresos.length) return res.status(404).json({ error: 'No se pudo generar ninguna etiqueta' });

    // Registrar impresión agrupando por tanda
    const porTipo = {};
    for (const s of impresos) { (porTipo[s.tipo || 'flex'] = porTipo[s.tipo || 'flex'] || []).push(s); }
    for (const [tipo, arr] of Object.entries(porTipo)) await registrarImpresion(arr, tipo);

    console.log(`[ETIQUETAS-SEL] pedidas=${lista.length} unidas=${impresos.length} fallidas=${fallidas}`);
    pdfResponse(res, bytes, impresos.length, fallidas, `etiquetas_seleccion_${fechaHoyART()}.pdf`);
  } catch (e) { console.error('[ETIQUETAS-SEL]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/despacho/impresas', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    let q = supabase.from('dep_impresiones')
      .select('shipment_id,tipo,sku,nro_venta,titulo,impreso_at')
      .gte('impreso_at', inicioDeHoyART())
      .order('impreso_at', { ascending: false });
    if (tipo === 'flex' || tipo === 'colecta') q = q.eq('tipo', tipo);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const porShip = new Map();
    for (const row of (data || [])) if (!porShip.has(row.shipment_id)) porShip.set(row.shipment_id, row);
    const unicos = Array.from(porShip.values());
    unicos.sort((a, b) => (a.sku || 'zzz').localeCompare(b.sku || 'zzz', 'es', { numeric: true }));
    res.json({
      total: unicos.length,
      total_flex: unicos.filter(r => r.tipo === 'flex').length,
      total_colecta: unicos.filter(r => r.tipo === 'colecta').length,
      impresas: unicos
    });
  } catch (e) { console.error('[IMPRESAS]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/despacho/reimprimir', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    const idsParam = (req.query.ids || '').trim();
    const ventaParam = (req.query.venta || '').trim().replace(/\s+/g, '');
    let lista = [];
    if (ventaParam) {
      const token0 = await getValidToken(ML_USER_ID);
      if (!token0) throw new Error('No hay token de ML disponible');
      const s = await resolverShipmentPorVenta(ventaParam, token0);
      if (!s) return res.status(404).json({ error: 'No encontré esa venta (o no tiene envío asociado). Revisá el número.' });
      lista = [s];
    } else if (idsParam) {
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
      const { data } = await supabase.from('dep_impresiones').select('shipment_id,sku').in('shipment_id', ids);
      const skuPorId = new Map((data || []).map(r => [r.shipment_id, r.sku]));
      lista = ids.map(id => ({ shipment_id: id, sku: skuPorId.get(id) || '' }));
    } else if (tipo === 'flex' || tipo === 'colecta') {
      const { data } = await supabase.from('dep_impresiones')
        .select('shipment_id,sku,impreso_at').eq('tipo', tipo).gte('impreso_at', inicioDeHoyART());
      const porShip = new Map();
      for (const r of (data || [])) if (!porShip.has(r.shipment_id)) porShip.set(r.shipment_id, r);
      lista = Array.from(porShip.values());
    } else { return res.status(400).json({ error: 'Indicá ?venta=, ?ids= o ?tipo=flex|colecta' }); }
    if (!lista.length) return res.status(404).json({ error: 'No hay nada para reimprimir' });
    lista.sort((a, b) => (a.sku || 'zzz').localeCompare(b.sku || 'zzz', 'es', { numeric: true }));
    const token = await getValidToken(ML_USER_ID);
    const { bytes, impresos, fallidas } = await armarPdf(lista, token);
    console.log(`[REIMPRIMIR] pedidas=${lista.length} unidas=${impresos.length} fallidas=${fallidas}`);
    const nombre = ventaParam ? `reimpresion_venta_${ventaParam}.pdf` : `reimpresion_${fechaHoyART()}.pdf`;
    pdfResponse(res, bytes, impresos.length, fallidas, nombre);
  } catch (e) { console.error('[REIMPRIMIR]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoints: código de autorización del día ─────────────────────
app.get('/api/despacho/codigo', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('dep_codigo_autorizacion')
      .select('*').order('fecha', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    const row = data && data[0];
    if (!row) return res.json({ codigo: null });
    res.json({ codigo: row.codigo, fecha: row.fecha, es_de_hoy: row.fecha === fechaHoyART() });
  } catch (e) { console.error('[CODIGO GET]', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/despacho/codigo', async (req, res) => {
  try {
    const codigo = ((req.body && req.body.codigo) || '').trim();
    if (!codigo) return res.status(400).json({ error: 'Falta el código' });
    const hoy = fechaHoyART();
    const { error } = await supabase.from('dep_codigo_autorizacion')
      .upsert({ fecha: hoy, codigo, cargado_at: new Date().toISOString() }, { onConflict: 'fecha' });
    if (error) throw new Error(error.message);
    res.json({ ok: true, codigo, fecha: hoy, es_de_hoy: true });
  } catch (e) { console.error('[CODIGO POST]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Colectas del día (con caché de 10 min para los escaneos) ──────
// ML devuelve el horario y el corte de cada colecta de Colecta
// (cross_docking). El transportista/patente suele venir vacío (ML no
// lo expone). Flex (self_service) normalmente da 404: no tiene colecta
// de ML porque lo despacha el vendedor con transporte propio.
let _colectasCache = { at: 0, colectas: [] };
async function colectasDelDia(token) {
  if (Date.now() - _colectasCache.at < 10 * 60 * 1000) return _colectasCache.colectas;
  const dia = diaSemanaHoyART();
  const colectas = [];
  for (const [tanda, logistic] of [['colecta', 'cross_docking'], ['flex', 'self_service']]) {
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/users/${ML_USER_ID}/shipping/schedule/${logistic}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) continue; // Flex suele dar 404: no tiene colecta de ML
      const data = await r.json();
      const hoy = data && data.schedule && data.schedule[dia];
      if (hoy && hoy.work && Array.isArray(hoy.detail)) {
        for (const d of hoy.detail) {
          colectas.push({
            tanda,
            from:     d.from   || '',
            to:       d.to     || '',
            cutoff:   d.cutoff || '',
            carrier:  (d.carrier && d.carrier.name) || '',
            patente:  (d.vehicle && d.vehicle.license_plate) || '',
            vehiculo: (d.vehicle && d.vehicle.vehicle_type) || '',
            chofer:   (d.driver && d.driver.name) || '',
            facility: d.facility_id || '',
            solo_hoy: !!(d.vehicle && d.vehicle.only_for_today)
          });
        }
      }
    } catch (e) { console.error('[COLECTAS]', logistic, e.message); }
  }
  // Ordenar por hora de inicio
  colectas.sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  _colectasCache = { at: Date.now(), colectas };
  return colectas;
}

// ── DIAGNÓSTICO de COLECTAS: prueba varias URLs de ML y muestra cuál responde ──
// /api/despacho/diag-colectas?clave=pontec2026
app.get('/api/despacho/diag-colectas', async (req, res) => {
  if ((req.query.clave || '') !== 'pontec2026')
    return res.status(401).json({ error: 'Agregá ?clave=pontec2026' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const probar = async (url) => {
      try {
        const r = await fetch(url, auth);
        let body; try { body = await r.json(); } catch { body = await r.text(); }
        const str = JSON.stringify(body);
        if (str && str.length > 4000) return { url, status: r.status, recortado: true, muestra: str.substring(0, 3500) };
        return { url, status: r.status, body };
      } catch (e) { return { url, error: e.message }; }
    };

    const U = ML_USER_ID;
    const urls = [
      `https://api.mercadolibre.com/users/${U}/shipping/schedule/cross_docking`,
      `https://api.mercadolibre.com/users/${U}/shipping/schedule/self_service`,
      `https://api.mercadolibre.com/shipping/carrier_collections/search?seller_id=${U}`,
      `https://api.mercadolibre.com/sites/MLA/shipping_options/collection?seller_id=${U}`,
      `https://api.mercadolibre.com/users/${U}/shipping_preferences`,
      `https://api.mercadolibre.com/users/${U}/shipping/modes`
    ];
    const resultados = [];
    for (const u of urls) { resultados.push(await probar(u)); await sleep(150); }
    res.json({ user_id: U, dia: diaSemanaHoyART(), resultados });
  } catch (e) { console.error('[DIAG-COLECTAS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoint: colectas del día (transportista, patente, horario) ──
app.get('/api/despacho/colectas', async (_req, res) => {
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const colectas = await colectasDelDia(token);
    res.json({ dia: diaSemanaHoyART(), colectas });
  } catch (e) { console.error('[COLECTAS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoint: buscar una venta por número (estado en ML + lo nuestro) ──
app.get('/api/despacho/buscar', async (req, res) => {
  try {
    const venta = (req.query.venta || '').trim().replace(/\s+/g, '');
    if (!venta) return res.status(400).json({ error: 'Indicá el número de venta' });
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    const ro = await fetch(`https://api.mercadolibre.com/orders/${venta}?access_token=${token}`);
    const order = await ro.json();
    if (order.error || !order.id) {
      return res.status(404).json({ error: 'No encontré esa venta. Revisá el número.' });
    }

    const item = (order.order_items && order.order_items[0]) || {};
    const sku = (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '';
    const titulo = (item.item && item.item.title) || '';
    const comprador = (order.buyer &&
      (order.buyer.nickname || `${order.buyer.first_name || ''} ${order.buyer.last_name || ''}`.trim())) || '';
    const shipId = order.shipping && order.shipping.id;

    let estadoCodigo = '', substatus = '', estado = 'Sin envío asociado';
    if (shipId) {
      const rs = await fetch(`https://api.mercadolibre.com/shipments/${shipId}`,
        { headers: { Authorization: `Bearer ${token}` } });
      const ship = await rs.json();
      estadoCodigo = ship.status || '';
      substatus = ship.substatus || '';
      estado = ESTADO_ES[estadoCodigo] || estadoCodigo || 'Sin información';
    }

    // ¿Se imprimió desde el sistema?
    let impreso = false, impreso_at = null;
    if (shipId) {
      const { data } = await supabase.from('dep_impresiones')
        .select('impreso_at').eq('shipment_id', String(shipId))
        .order('impreso_at', { ascending: true }).limit(1);
      if (data && data[0]) { impreso = true; impreso_at = data[0].impreso_at; }
    }

    res.json({
      nro_venta: String(order.id),
      shipment_id: shipId ? String(shipId) : null,
      sku, titulo, comprador,
      fecha: order.date_created || null,
      estado, estado_codigo: estadoCodigo, substatus,
      despachado: ['shipped', 'delivered'].includes(estadoCodigo),
      entregado: estadoCodigo === 'delivered',
      impreso, impreso_at
    });
  } catch (e) {
    console.error('[BUSCAR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Helper: interpretar lo escaneado (QR, n° de venta o n° de envío) ──
function extraerNumeros(codigo) {
  const nums = String(codigo || '').match(/\d{8,}/g) || [];
  return [...new Set(nums)].filter(n => n !== String(ML_USER_ID));
}

// Intepreta lo escaneado y devuelve el shipment_id "candidato".
// El QR de ML (Flex y Colecta) es un JSON con el campo "id" = shipment_id.
// Si no es JSON, tomamos el primer número largo (pistola / código de barras).
function shipmentIdDelEscaneo(codigo) {
  const txt = String(codigo || '').trim();
  // ¿Es un JSON tipo {"id":"47315533572",...}?
  if (txt.startsWith('{')) {
    try {
      const o = JSON.parse(txt);
      if (o && o.id) return { shipId: String(o.id), origen: 'qr_json' };
    } catch (e) { /* sigue abajo */ }
  }
  // ¿Trae "id":"..." aunque no parsee como JSON completo?
  const m = txt.match(/"id"\s*:\s*"?(\d{6,})"?/);
  if (m) return { shipId: m[1], origen: 'qr_regex' };
  return { shipId: null, origen: 'numero' };
}

async function resolverEscaneo(codigo, token) {
  // 1) Si el QR trae el shipment_id en "id", lo usamos directo
  const { shipId } = shipmentIdDelEscaneo(codigo);

  // 2) Buscar primero en la FOTO LOCAL (instantáneo, sin pegarle a ML)
  const tryFoto = async (campo, valor) => {
    if (!valor) return null;
    const { data } = await supabase.from('dep_envios')
      .select('shipment_id,nro_venta,pack_id,sku,titulo,tipo').eq(campo, String(valor)).limit(1);
    return (data && data[0]) ? data[0] : null;
  };

  if (shipId) {
    const f = await tryFoto('shipment_id', shipId);
    if (f) return { shipment_id: f.shipment_id, nro_venta: f.nro_venta || '', sku: f.sku || '', titulo: f.titulo || '' };
  }

  // 3) Probar los números sueltos contra la foto (shipment_id, nro_venta, pack_id)
  const nums = extraerNumeros(codigo);
  for (const n of nums) {
    const f = (await tryFoto('shipment_id', n)) || (await tryFoto('nro_venta', n)) || (await tryFoto('pack_id', n));
    if (f) return { shipment_id: f.shipment_id, nro_venta: f.nro_venta || '', sku: f.sku || '', titulo: f.titulo || '' };
  }

  // 4) No estaba en la foto: resolver contra ML en vivo (respaldo)
  const idML = shipId || nums.slice().sort((a, b) => b.length - a.length)[0];
  if (idML) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/shipments/${idML}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const ship = await r.json();
        if (ship && ship.id) {
          const oid = ship.order_id || (Array.isArray(ship.order_ids) && ship.order_ids[0]);
          if (oid) {
            const ro = await fetch(`https://api.mercadolibre.com/orders/${oid}?access_token=${token}`);
            const order = await ro.json();
            if (order && order.id) {
              const item = (order.order_items && order.order_items[0]) || {};
              return {
                shipment_id: String(ship.id), nro_venta: String(order.id),
                sku: (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '',
                titulo: (item.item && item.item.title) || ''
              };
            }
          }
          return { shipment_id: String(ship.id), nro_venta: '', sku: '', titulo: '' };
        }
      }
    } catch (e) { /* nada */ }
  }

  // 5) Último recurso: ¿era un número de venta/pack? resolver por venta
  const venta = nums.find(n => n.startsWith('2000') && n.length >= 14);
  if (venta) { const s = await resolverShipmentPorVenta(venta, token); if (s) return s; }
  return null;
}

// ── Endpoint: DESPACHAR (escaneo al cargar el camión) ─────────────
// Chequea EN VIVO contra ML que la venta no esté cancelada antes de registrar.
app.post('/api/despacho/despachar', async (req, res) => {
  try {
    const codigo = ((req.body && req.body.codigo) || '').trim();
    if (!codigo) return res.status(400).json({ error: 'Falta el código escaneado' });
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    // ── Rama DEMO: si la venta/envío es de prueba, resolvemos local ──
    const numsDemo = extraerNumeros(codigo);
    const ventaDemo = numsDemo.find(n => n.startsWith('2000099000'));
    if (ventaDemo || ES_DEMO(codigo)) {
      const { data: dd } = await supabase.from('dep_demo')
        .select('shipment_id,nro_venta,sku,titulo,tipo,status')
        .or(`nro_venta.eq.${ventaDemo || codigo},shipment_id.eq.${codigo}`).limit(1);
      const dv = dd && dd[0];
      if (!dv) return res.status(404).json({ error: 'Venta de prueba no encontrada. Volvé a sembrar el demo.' });
      const base = { shipment_id: dv.shipment_id, nro_venta: dv.nro_venta, sku: dv.sku, titulo: dv.titulo, tipo: dv.tipo, demo: true };
      if (dv.status === 'cancelled')
        return res.json({ resultado: 'cancelada', mensaje: 'NO DESPACHAR · la venta está CANCELADA', ...base });
      const { data: dup } = await supabase.from('dep_despachos')
        .select('despachado_at,usuario').eq('shipment_id', dv.shipment_id)
        .order('despachado_at', { ascending: false }).limit(1);
      if (dup && dup[0])
        return res.json({ resultado: 'duplicada', mensaje: 'Este envío ya estaba escaneado',
          despachado_at: dup[0].despachado_at, usuario: dup[0].usuario || '', ...base });
      const { error } = await supabase.from('dep_despachos').insert({
        shipment_id: dv.shipment_id, nro_venta: dv.nro_venta, sku: dv.sku, titulo: dv.titulo,
        tipo: dv.tipo, usuario: (req.authUser && req.authUser.email) || 'demo'
      });
      if (error) throw new Error(error.message);
      let aviso = '';
      if (dv.status === 'shipped')   aviso = 'Ojo: ML ya la marca en camino.';
      if (dv.status === 'delivered') aviso = 'Ojo: ML ya la marca entregada.';
      console.log(`[DESPACHAR][DEMO] OK ship=${dv.shipment_id} venta=${dv.nro_venta}`);
      return res.json({ resultado: 'ok', mensaje: 'Despachada (demo)', aviso, ...base });
    }

    const s = await resolverEscaneo(codigo, token);
    if (!s) return res.status(404).json({ error: 'No pude interpretar el código. Probá con el número de venta o el número de envío de la etiqueta.' });

    // Estado actual de la VENTA (¿la cancelaron mientras preparábamos?)
    let ordenCancelada = false;
    if (s.nro_venta) {
      try {
        const ro = await fetch(`https://api.mercadolibre.com/orders/${s.nro_venta}?access_token=${token}`);
        const order = await ro.json();
        if (order && order.id) {
          ordenCancelada = order.status === 'cancelled' || !!order.cancel_detail;
        }
      } catch (e) { console.error('[DESPACHAR] check orden:', e.message); }
    }

    // Estado actual del ENVÍO
    let shipStatus = '', shipSub = '', tipo = '';
    try {
      const rs = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`,
        { headers: { Authorization: `Bearer ${token}` } });
      const ship = await rs.json();
      shipStatus = ship.status || '';
      shipSub = ship.substatus || '';
      const lt = ship.logistic_type || (ship.logistic && ship.logistic.type) || '';
      tipo = lt === 'self_service' ? 'flex' : lt === 'cross_docking' ? 'colecta' : lt;
    } catch (e) { console.error('[DESPACHAR] check envío:', e.message); }

    const base = { shipment_id: s.shipment_id, nro_venta: s.nro_venta, sku: s.sku, titulo: s.titulo, tipo };

    if (ordenCancelada || shipStatus === 'cancelled') {
      console.log(`[DESPACHAR] CANCELADA ship=${s.shipment_id} venta=${s.nro_venta}`);
      return res.json({ resultado: 'cancelada', mensaje: 'NO DESPACHAR · la venta está CANCELADA', ...base });
    }

    // ¿Ya se había escaneado?
    const { data: dup } = await supabase.from('dep_despachos')
      .select('despachado_at,usuario').eq('shipment_id', s.shipment_id)
      .order('despachado_at', { ascending: false }).limit(1);
    if (dup && dup[0]) {
      return res.json({ resultado: 'duplicada', mensaje: 'Este envío ya estaba escaneado',
        despachado_at: dup[0].despachado_at, usuario: dup[0].usuario || '', ...base });
    }

    // Snapshot de la colecta del día para esta tanda
    let col = null;
    try {
      const colectas = await colectasDelDia(token);
      col = colectas.find(c => c.tanda === tipo) || null;
    } catch (e) { /* sin colecta, registramos igual */ }

    const { error } = await supabase.from('dep_despachos').insert({
      shipment_id: s.shipment_id, nro_venta: s.nro_venta || null,
      sku: s.sku || null, titulo: s.titulo || null, tipo: tipo || null,
      usuario: (req.authUser && req.authUser.email) || null,
      colecta_carrier: col ? (col.carrier || null) : null,
      colecta_patente: col ? (col.patente || null) : null,
      colecta_horario: col ? `${col.from}-${col.to}` : null
    });
    if (error) throw new Error(error.message);

    // Criterio (opción 3): bloquear solo si CANCELADA (ya filtrado arriba).
    // Acá AVISAMOS sin bloquear si el envío está en un estado distinto al
    // normal de despacho (ready_to_ship / handling). Sirve para quedarse
    // tranquilo de que todo lo demás está bien.
    const NORMALES = ['ready_to_ship', 'handling', 'pending'];
    let aviso = '';
    if (shipStatus === 'shipped')        aviso = 'Ojo: ML ya la marca EN CAMINO (quizás ya cerró la colecta).';
    else if (shipStatus === 'delivered') aviso = 'Ojo: ML ya la marca ENTREGADA.';
    else if (shipStatus === 'not_delivered') aviso = 'Ojo: ML la marca NO ENTREGADA.';
    else if (shipStatus && !NORMALES.includes(shipStatus))
      aviso = `Ojo: estado inusual en ML (${shipStatus}${shipSub ? '/' + shipSub : ''}). Revisá antes de despachar.`;
    console.log(`[DESPACHAR] OK ship=${s.shipment_id} venta=${s.nro_venta} tipo=${tipo} status=${shipStatus}/${shipSub}`);
    res.json({ resultado: aviso ? 'ok_aviso' : 'ok', mensaje: 'Despachada', aviso, estado_ml: shipStatus, ...base });
  } catch (e) { console.error('[DESPACHAR]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoint: tablero del día de verificación ─────────────────────
// Impresas hoy vs escaneadas hoy + lista de lo que falta subir al camión.
app.get('/api/despacho/despachados', async (_req, res) => {
  try {
    const { data: desp, error } = await supabase.from('dep_despachos')
      .select('shipment_id,nro_venta,sku,titulo,tipo,usuario,colecta_carrier,colecta_patente,despachado_at')
      .gte('despachado_at', inicioDeHoyART())
      .order('despachado_at', { ascending: false });
    if (error) throw new Error(error.message);

    const { data: imp } = await supabase.from('dep_impresiones')
      .select('shipment_id,nro_venta,sku,titulo,tipo')
      .gte('impreso_at', inicioDeHoyART());
    const impUnicas = new Map();
    for (const r of (imp || [])) if (!impUnicas.has(r.shipment_id)) impUnicas.set(r.shipment_id, r);

    const despIds = new Set((desp || []).map(r => r.shipment_id));
    const faltan = Array.from(impUnicas.values())
      .filter(r => !despIds.has(r.shipment_id))
      .sort(ordenarPorSku);

    res.json({
      impresas_hoy: impUnicas.size,
      despachadas_hoy: despIds.size,
      faltan_cnt: faltan.length,
      faltan,
      despachadas: desp || []
    });
  } catch (e) { console.error('[DESPACHADOS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoint: SEGUIMIENTO (flujo completo por etiqueta) ───────────
app.get('/api/despacho/seguimiento', async (_req, res) => {
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const reales = await obtenerDetalladosConCache(token);
    const demo = await obtenerDemo();
    const detallados = [...reales, ...demo];
    const ids = detallados.map(s => s.shipment_id);

    let impSet = new Set(), desMap = new Map();
    if (ids.length) {
      const { data: imp } = await supabase.from('dep_impresiones')
        .select('shipment_id').in('shipment_id', ids);
      impSet = new Set((imp || []).map(r => r.shipment_id));
      const { data: des } = await supabase.from('dep_despachos')
        .select('shipment_id,despachado_at,colecta_carrier,colecta_patente').in('shipment_id', ids);
      for (const r of (des || [])) if (!desMap.has(r.shipment_id)) desMap.set(r.shipment_id, r);
    }

    const hoy = fechaHoyART();
    const esFuturo = s => s.limite && String(s.limite).substring(0,10) > hoy;
    const imprimible = s => s.status === 'ready_to_ship' &&
      (s.substatus === 'ready_to_print' || s.substatus === 'ready_to_ship' || !s.substatus);
    const b = { para_imprimir: [], programados: [], en_preparacion: [],
                despachadas: [], en_camino: [], entregadas: [], devoluciones: [] };

    for (const s of detallados) {
      const d = desMap.get(s.shipment_id);
      const fila = {
        shipment_id: s.shipment_id, nro_venta: s.nro_venta, sku: s.sku, titulo: s.titulo,
        tipo: s.logistic === 'self_service' ? 'flex' : s.logistic === 'cross_docking' ? 'colecta' : s.logistic,
        status: s.status, estado: ESTADO_ES[s.status] || s.status,
        limite: s.limite ? String(s.limite).substring(0,10) : null,
        despachado_at: d ? d.despachado_at : null,
        colecta: d && d.colecta_carrier ? `${d.colecta_carrier}${d.colecta_patente ? ' · ' + d.colecta_patente : ''}` : null
      };
      if (['not_delivered', 'returned'].includes(s.status)) b.devoluciones.push(fila);
      else if (s.status === 'delivered')                    b.entregadas.push(fila);
      else if (s.status === 'shipped')                      b.en_camino.push(fila);
      else if (s.status === 'cancelled')                    continue; // canceladas sin despachar: afuera
      else if (desMap.has(s.shipment_id))                   b.despachadas.push(fila);
      else if (impSet.has(s.shipment_id))                   b.en_preparacion.push(fila);
      else if (!imprimible(s) && esFuturo(s))               b.programados.push(fila);
      else                                                  b.para_imprimir.push(fila);
    }
    for (const k of Object.keys(b)) b[k].sort(ordenarPorSku);

    res.json({
      dias: DIAS_BUSQUEDA,
      conteos: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.length])),
      etapas: b
    });
  } catch (e) { console.error('[SEGUIMIENTO]', e.message); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  MODO DEMO · endpoints (los helpers ES_DEMO/SEMILLA_DEMO/obtenerDemo
//  están definidos arriba, junto a las constantes)
// ══════════════════════════════════════════════════════════════════
app.post('/api/despacho/demo/sembrar', async (req, res) => {
  try {
    // Limpiamos demo anterior para empezar de cero
    await supabase.from('dep_despachos').delete().like('shipment_id', 'DEMO-%');
    await supabase.from('dep_impresiones').delete().like('shipment_id', 'DEMO-%');
    await supabase.from('dep_demo').delete().neq('shipment_id', '');

    const hoy = fechaHoyART();
    const filasDemo = [], filasImp = [], filasDesp = [];
    let i = 0;
    for (const s of SEMILLA_DEMO) {
      i++;
      const shipId = `DEMO-${Date.now()}-${i}`;
      const venta  = `2000099000${String(i).padStart(4, '0')}`;
      filasDemo.push({
        shipment_id: shipId, nro_venta: venta, sku: s.sku, titulo: s.titulo,
        tipo: s.tipo, status: s.status, limite: hoy
      });
      if (s.preparar) filasImp.push({
        shipment_id: shipId, nro_venta: venta, sku: s.sku, titulo: s.titulo, tipo: s.tipo
      });
      if (s.despachar) filasDesp.push({
        shipment_id: shipId, nro_venta: venta, sku: s.sku, titulo: s.titulo, tipo: s.tipo,
        usuario: 'demo', colecta_carrier: s.tipo === 'colecta' ? 'Andreani' : null,
        colecta_patente: s.tipo === 'colecta' ? 'AB123CD' : null,
        colecta_horario: s.tipo === 'colecta' ? '14:00-16:00' : null
      });
    }
    if (filasDemo.length) { const { error } = await supabase.from('dep_demo').insert(filasDemo); if (error) throw new Error('dep_demo: ' + error.message); }
    if (filasImp.length)  { const { error } = await supabase.from('dep_impresiones').insert(filasImp); if (error) throw new Error('dep_impresiones: ' + error.message); }
    if (filasDesp.length) { const { error } = await supabase.from('dep_despachos').insert(filasDesp); if (error) throw new Error('dep_despachos: ' + error.message); }

    // Envío de prueba "listo para escanear" (impreso pero sin despachar)
    const listoParaEscanear = filasDemo.find(d =>
      filasImp.some(im => im.shipment_id === d.shipment_id) &&
      !filasDesp.some(de => de.shipment_id === d.shipment_id) &&
      d.status === 'ready_to_ship');
    // Envío de prueba cancelado (para ver la alerta NO DESPACHAR)
    const cancelado = filasDemo.find(d => d.status === 'cancelled');

    console.log(`[DEMO] sembrados ${filasDemo.length} envíos de prueba`);
    res.json({
      ok: true, total: filasDemo.length,
      probar_ok:       listoParaEscanear ? listoParaEscanear.nro_venta : null,
      probar_cancelada: cancelado ? cancelado.nro_venta : null
    });
  } catch (e) { console.error('[DEMO]', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/despacho/demo/limpiar', async (_req, res) => {
  try {
    await supabase.from('dep_despachos').delete().like('shipment_id', 'DEMO-%');
    await supabase.from('dep_impresiones').delete().like('shipment_id', 'DEMO-%');
    await supabase.from('dep_demo').delete().neq('shipment_id', '');
    console.log('[DEMO] datos de prueba eliminados');
    res.json({ ok: true });
  } catch (e) { console.error('[DEMO]', e.message); res.status(500).json({ error: e.message }); }
});

// ── DIAGNÓSTICO de FECHAS LÍMITE de despacho ──────────────────────
// Toma envíos imprimibles y muestra todos los campos de fecha de ML,
// para confirmar cuál es el "Despachar: X" real de la etiqueta.
// /api/despacho/diag-fechas?clave=pontec2026
app.get('/api/despacho/diag-fechas', async (req, res) => {
  if ((req.query.clave || '') !== 'pontec2026')
    return res.status(401).json({ error: 'Agregá ?clave=pontec2026' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    // Tomar algunos envíos nuestros desde la foto (los más recientes)
    const { data: envios } = await supabase.from('dep_envios')
      .select('shipment_id,nro_venta,sku,tipo,status,limite')
      .eq('es_nuestro', true).neq('tipo', 'full')
      .in('status', ['ready_to_ship', 'pending', 'handling'])
      .limit(8);

    const hoy = fechaHoyART();
    const detalle = [];
    let crudo_primero = null;
    for (const e of (envios || [])) {
      try {
        const ship = await (await fetch(`https://api.mercadolibre.com/shipments/${e.shipment_id}`,
          { headers: { Authorization: `Bearer ${token}` } })).json();
        const so = ship.shipping_option || {};
        // Del primer envío, guardamos el shipping_option COMPLETO y las claves del ship
        if (!crudo_primero) crudo_primero = {
          shipment_id: e.shipment_id,
          claves_ship: Object.keys(ship),
          shipping_option_completo: so,
          lead_time: ship.lead_time || null
        };
        detalle.push({
          shipment_id: e.shipment_id, nro_venta: e.nro_venta, sku: e.sku, tipo: e.tipo,
          status: ship.status, substatus: ship.substatus,
          guardado_en_foto: e.limite,
          handling_limit_date: (so.estimated_handling_limit && so.estimated_handling_limit.date) || null,
          estimated_delivery_limit: (so.estimated_delivery_limit && so.estimated_delivery_limit.date) || null,
          estimated_schedule_limit: (so.estimated_schedule_limit && so.estimated_schedule_limit.date) || null,
          date_created: ship.date_created || null
        });
      } catch (err) { detalle.push({ shipment_id: e.shipment_id, error: err.message }); }
    }
    res.json({ hoy_art: hoy, cantidad: detalle.length, envios: detalle, crudo_primero });
  } catch (e) { console.error('[DIAG-FECHAS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoint: DIAGNÓSTICO (qué llega de ML y dónde se pierde) ──────
// No filtra: cuenta envíos por estado, por logística y por depósito.
// Sirve para entender por qué "no trae nada".
// Abrir en el navegador con la clave (temporal, para debug):
//   /api/despacho/diag?clave=pontec2026
// ── DIAGNÓSTICO de UN envío (para ubicar el número del QR de Colecta) ──
// /api/despacho/diag-envio?clave=pontec2026&venta=2000015060172118
app.get('/api/despacho/diag-envio', async (req, res) => {
  if ((req.query.clave || '') !== 'pontec2026')
    return res.status(401).json({ error: 'Agregá ?clave=pontec2026' });
  try {
    const venta = (req.query.venta || '').trim();
    const buscar = (req.query.buscar || '').trim(); // número a ubicar (ej 46428401827)
    if (!venta) return res.status(400).json({ error: 'Indicá ?venta=NUMERO' });
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    const ro = await fetch(`https://api.mercadolibre.com/orders/${venta}?access_token=${token}`);
    const order = await ro.json();
    if (order.error || !order.id) return res.json({ paso: 'orders', error: order });
    const shipId = order.shipping && order.shipping.id;
    if (!shipId) return res.json({ error: 'La venta no tiene envío asociado', order_status: order.status });

    const rs = await fetch(`https://api.mercadolibre.com/shipments/${shipId}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const ship = await rs.json();

    // Buscar dónde aparece el número del QR (si se pasó ?buscar=)
    let apariciones = [];
    if (buscar) {
      const txt = JSON.stringify(ship);
      const recorrer = (obj, ruta) => {
        if (obj == null) return;
        if (typeof obj === 'object') {
          for (const k of Object.keys(obj)) recorrer(obj[k], ruta ? `${ruta}.${k}` : k);
        } else if (String(obj) === buscar || String(obj).includes(buscar)) {
          apariciones.push({ campo: ruta, valor: String(obj) });
        }
      };
      recorrer(ship, '');
    }

    res.json({
      nro_venta: String(order.id),
      shipment_id: String(shipId),
      pack_id: order.pack_id ? String(order.pack_id) : null,
      ship_status: ship.status,
      ship_substatus: ship.substatus,
      logistic_type: ship.logistic_type || (ship.logistic && ship.logistic.type),
      tracking_number: ship.tracking_number || null,
      tracking_method: ship.tracking_method || null,
      buscado: buscar || null,
      apariciones_del_buscado: apariciones,
      // Campos candidatos más comunes, mostrados explícitos
      candidatos: {
        id: ship.id, tracking_number: ship.tracking_number,
        external_reference: ship.external_reference,
        carrier_info: ship.carrier_info || null,
        order_id: ship.order_id || null
      },
      // Por las dudas, todas las claves de primer nivel del envío
      claves_envio: Object.keys(ship)
    });
  } catch (e) { console.error('[DIAG-ENVIO]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/despacho/diag', async (req, res) => {
  if ((req.query.clave || '') !== 'pontec2026')
    return res.status(401).json({ error: 'Agregá ?clave=pontec2026 al final de la URL' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    // Traemos SIN usar caché ni filtro de depósito
    const desde = new Date(); desde.setDate(desde.getDate() - DIAS_BUSQUEDA);
    const desdeISO = desde.toISOString().substring(0,10) + 'T00:00:00.000-03:00';
    const hastaISO = new Date().toISOString().substring(0,10) + 'T23:59:59.000-03:00';
    const ordenes = []; let offset = 0, total = 999;
    while (offset < Math.min(total, 2000)) {
      const url = `https://api.mercadolibre.com/orders/search?seller=${ML_USER_ID}`
        + `&order.status=paid&order.date_created.from=${encodeURIComponent(desdeISO)}`
        + `&order.date_created.to=${encodeURIComponent(hastaISO)}`
        + `&sort=date_desc&offset=${offset}&limit=50&access_token=${token}`;
      const data = await (await fetch(url)).json();
      if (data.error) return res.json({ paso: 'orders/search', error: data });
      total = (data.paging && data.paging.total) || 0;
      for (const o of (data.results || [])) ordenes.push(o);
      offset += 50; await sleep(150);
    }

    const ships = [];
    for (const o of ordenes) {
      const id = o.shipping && o.shipping.id;
      if (id) ships.push(String(id));
    }
    const unicos = [...new Set(ships)];

    const muestra = unicos.slice(0, 400);
    const detalle = await poolMap(muestra, 12, async (id) => {
      try {
        const ship = await (await fetch(`https://api.mercadolibre.com/shipments/${id}`,
          { headers: { Authorization: `Bearer ${token}` } })).json();
        const sa = ship.sender_address || {};
        return {
          status: ship.status || '?', substatus: ship.substatus || '',
          logistic: ship.logistic_type || (ship.logistic && ship.logistic.type) || '?',
          dep: `${sa.address_line || ''} ${(sa.city && sa.city.name) || ''}`.trim(),
          printed: !!ship.date_first_printed,   // ¿ML registra que ya se imprimió?
          date_first_printed: ship.date_first_printed || null
        };
      } catch (e) { return { status: 'error', substatus: '', logistic: '?', dep: '', printed: false }; }
    });

    const cuenta = (arr, key) => arr.reduce((a, x) => { const k = x[key] || '(vacío)'; a[k] = (a[k]||0)+1; return a; }, {});
    const deps = {};
    for (const d of detalle) { const k = d.dep || '(sin dato)'; deps[k] = (deps[k]||0)+1; }

    // Cruce substatus × ¿tiene fecha de impresión? (clave para definir "impresa")
    const subVsPrinted = {};
    for (const d of detalle) {
      const k = d.substatus || '(vacío)';
      subVsPrinted[k] = subVsPrinted[k] || { total: 0, con_fecha_impresion: 0 };
      subVsPrinted[k].total++;
      if (d.printed) subVsPrinted[k].con_fecha_impresion++;
    }

    res.json({
      ventas_encontradas: ordenes.length,
      envios_unicos: unicos.length,
      analizados: detalle.length,
      por_status: cuenta(detalle, 'status'),
      por_substatus: cuenta(detalle, 'substatus'),
      por_logistica: cuenta(detalle, 'logistic'),
      por_deposito: deps,
      substatus_vs_impresa: subVsPrinted,
      con_fecha_impresion_total: detalle.filter(d => d.printed).length,
      filtro_deposito_actual: DEPOSITO_FILTRO || '(desactivado)'
    });
  } catch (e) { console.error('[DIAG]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Salud ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, app: 'deposito-backend', fase: '4.2.2-diag-fechas' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Depósito backend escuchando en :${PORT}`));
