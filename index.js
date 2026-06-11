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
const DIAS_BUSQUEDA    = parseInt(process.env.DIAS_BUSQUEDA || '5', 10);

const LOGISTIC = { flex: 'self_service', colecta: 'cross_docking' };

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
async function obtenerShipmentsDetallados(token) {
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
    await sleep(250);
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
        sku: sku ? String(sku).trim() : '', titulo, unidades: item.quantity || 1
      });
    }
  }

  const shipments = Array.from(porShipment.values());
  const detallados = await poolMap(shipments, 5, async (s) => {
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
    } catch (e) { s.status = 'error'; s.logistic = ''; s.limite = null; }
    return s;
  });
  return detallados;
}

const ordenarPorSku = (a, b) => {
  if (!a.sku && b.sku) return 1;
  if (a.sku && !b.sku) return -1;
  return (a.sku || '').localeCompare(b.sku || '', 'es', { numeric: true, sensitivity: 'base' });
};

// ── Envíos de una tanda (flex/colecta), ordenados por SKU ─────────
async function obtenerEnvios(tipo) {
  const logisticBuscado = LOGISTIC[tipo];
  if (!logisticBuscado) throw new Error('Tipo inválido (usá flex o colecta)');
  const token = await getValidToken(ML_USER_ID);
  if (!token) throw new Error('No hay token de ML disponible en ml_tokens');

  const detallados = await obtenerShipmentsDetallados(token);
  const deLaTanda = detallados.filter(s => s.logistic === logisticBuscado);

  // ¿El despacho está programado para más adelante? (cliente eligió recibir después)
  const hoy = fechaHoyART();
  const esFuturo = s => s.limite && String(s.limite).substring(0,10) > hoy;

  const listos      = deLaTanda.filter(s => s.status === 'ready_to_ship' && !esFuturo(s));
  const programados = deLaTanda.filter(s => s.status === 'ready_to_ship' && esFuturo(s));
  // "No listos" = solo lo que todavía está en proceso, NO lo ya despachado/entregado/cancelado
  const TERMINADOS = ['shipped', 'delivered', 'not_delivered', 'cancelled', 'returned'];
  const noListos  = deLaTanda.filter(s =>
    s.status !== 'ready_to_ship' && !TERMINADOS.includes(s.status));

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

// ── Todos los endpoints del depósito exigen estar logueado ────────
app.use('/api/despacho', requireAuth);

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
            solo_hoy: !!(d.vehicle && d.vehicle.only_for_today)
          });
        }
      }
    } catch (e) { console.error('[COLECTAS]', logistic, e.message); }
  }
  _colectasCache = { at: Date.now(), colectas };
  return colectas;
}

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

async function resolverEscaneo(codigo, token) {
  const nums = extraerNumeros(codigo);
  if (!nums.length) return null;

  // ¿Parece número de venta / Pack ID? (empiezan con 2000 y son largos)
  const venta = nums.find(n => n.startsWith('2000') && n.length >= 14);
  if (venta) {
    const s = await resolverShipmentPorVenta(venta, token);
    if (s) return s;
  }

  // Si no, probamos como número de envío (shipment_id)
  const candidatos = nums.filter(n => n !== venta).sort((a, b) => b.length - a.length);
  for (const id of candidatos) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/shipments/${id}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) continue;
      const ship = await r.json();
      if (!ship || !ship.id) continue;
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
    } catch (e) { /* probar el siguiente */ }
  }
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
    let shipStatus = '', tipo = '';
    try {
      const rs = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`,
        { headers: { Authorization: `Bearer ${token}` } });
      const ship = await rs.json();
      shipStatus = ship.status || '';
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

    let aviso = '';
    if (shipStatus === 'shipped')   aviso = 'Ojo: ML ya la marca en camino.';
    if (shipStatus === 'delivered') aviso = 'Ojo: ML ya la marca entregada.';
    console.log(`[DESPACHAR] OK ship=${s.shipment_id} venta=${s.nro_venta} tipo=${tipo}`);
    res.json({ resultado: 'ok', mensaje: 'Despachada', aviso, ...base });
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
    const detallados = await obtenerShipmentsDetallados(token);
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
      else if (s.status === 'ready_to_ship' && esFuturo(s)) b.programados.push(fila);
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

// ── Salud ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, app: 'deposito-backend', fase: '3.0' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Depósito backend escuchando en :${PORT}`));
