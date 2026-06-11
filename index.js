// ============================================================
//  DEPÓSITO · BACKEND  v3
//  Fase 1: impresión por SKU + registro + reimpresión + conteo
//  Fase 2 (parcial): código de autorización del día + colectas del día
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ── Núcleo: lista de envíos de una tanda, ordenada por SKU ────────
async function obtenerEnvios(tipo) {
  const logisticBuscado = LOGISTIC[tipo];
  if (!logisticBuscado) throw new Error('Tipo inválido (usá flex o colecta)');
  const token = await getValidToken(ML_USER_ID);
  if (!token) throw new Error('No hay token de ML disponible en ml_tokens');

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
      s.logistic = ship.logistic_type || (ship.logistic && ship.logistic.type) || '';
    } catch (e) { s.status = 'error'; s.logistic = ''; }
    return s;
  });

  const deLaTanda = detallados.filter(s => s.logistic === logisticBuscado);
  const listos    = deLaTanda.filter(s => s.status === 'ready_to_ship');
  const noListos  = deLaTanda.filter(s => s.status !== 'ready_to_ship');

  const ordenarPorSku = (a, b) => {
    if (!a.sku && b.sku) return 1;
    if (a.sku && !b.sku) return -1;
    return a.sku.localeCompare(b.sku, 'es', { numeric: true, sensitivity: 'base' });
  };
  listos.sort(ordenarPorSku); noListos.sort(ordenarPorSku);
  console.log(`[ENVIOS] tipo=${tipo} listos=${listos.length} no_listos=${noListos.length}`);
  return { listos, no_listos: noListos, token };
}

// ── Helper: pedir etiquetas y armar el PDF en orden ───────────────
async function armarPdf(shipments, token) {
  const buffers = await poolMap(shipments, 5, async (s) => {
    const r = await fetch(
      `https://api.mercadolibre.com/shipment_labels?shipment_ids=${s.shipment_id}&response_type=pdf`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) { console.error(`[ETIQUETA] ship=${s.shipment_id} HTTP ${r.status}`); return null; }
    return await r.buffer();
  });
  const merged = await PDFDocument.create();
  const impresos = []; let fallidas = 0;
  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    if (!buf || buf.__error) { fallidas++; continue; }
    try {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      impresos.push(shipments[i]);
    } catch (e) { console.error(`[ETIQUETA] unir ship=${shipments[i].shipment_id}: ${e.message}`); fallidas++; }
  }
  const bytes = await merged.save();
  return { bytes, impresos, fallidas };
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

// ── Endpoints: impresión ──────────────────────────────────────────
app.get('/api/despacho/pendientes', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    const { listos, no_listos } = await obtenerEnvios(tipo);
    res.json({
      tipo, cantidad: listos.length,
      listos: listos.map(({ shipment_id, nro_venta, sku, titulo, unidades }) =>
        ({ shipment_id, nro_venta, sku, titulo, unidades })),
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
    let lista = [];
    if (idsParam) {
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
    } else { return res.status(400).json({ error: 'Indicá ?ids= o ?tipo=flex|colecta' }); }
    if (!lista.length) return res.status(404).json({ error: 'No hay nada para reimprimir' });
    lista.sort((a, b) => (a.sku || 'zzz').localeCompare(b.sku || 'zzz', 'es', { numeric: true }));
    const token = await getValidToken(ML_USER_ID);
    const { bytes, impresos, fallidas } = await armarPdf(lista, token);
    console.log(`[REIMPRIMIR] pedidas=${lista.length} unidas=${impresos.length} fallidas=${fallidas}`);
    pdfResponse(res, bytes, impresos.length, fallidas, `reimpresion_${fechaHoyART()}.pdf`);
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

// ── Endpoint: colectas del día (transportista, patente, horario) ──
app.get('/api/despacho/colectas', async (_req, res) => {
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
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
    res.json({ dia, colectas });
  } catch (e) { console.error('[COLECTAS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Salud ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, app: 'deposito-backend', fase: '2.0' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Depósito backend escuchando en :${PORT}`));
