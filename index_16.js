// ============================================================
//  DEPÓSITO · BACKEND  (Fase 1: impresión de etiquetas por SKU)
//  App separada de MargenML. Comparte SOLO la base Supabase
//  para leer el token de MercadoLibre (tabla ml_tokens).
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

// Cuántos días hacia atrás buscamos órdenes pagadas para juntar
// los envíos que todavía están "listos para despachar".
const DIAS_BUSQUEDA = parseInt(process.env.DIAS_BUSQUEDA || '5', 10);

// Tipos de logística de ML -> nombre de la tanda
const LOGISTIC = {
  flex:    'self_service',   // Flex
  colecta: 'cross_docking'   // Colecta
};

// ── Helper: token válido (mismo patrón que MargenML) ──────────────
async function getValidToken(userId) {
  const { data: tokenRow } = await supabase
    .from('ml_tokens').select('*').eq('user_id', String(userId)).single();
  if (!tokenRow) return null;

  if (new Date(tokenRow.expires_at).getTime() - 60000 > Date.now()) {
    return tokenRow.access_token;
  }

  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token
    })
  });
  const data = await resp.json();
  if (data.error) {
    console.error('[TOKEN] refresh falló:', data);
    return tokenRow.access_token;
  }

  await supabase.from('ml_tokens').upsert({
    user_id:       String(userId),
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at:    new Date().toISOString()
  }, { onConflict: 'user_id' });

  return data.access_token;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helper: ejecutar tareas con concurrencia limitada ─────────────
// Mantiene el orden de entrada en el array de resultados.
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

// ── Núcleo: armar la lista de envíos a despachar de una tanda ─────
// Devuelve { listos: [...], no_listos: [...] } ya ordenado por SKU.
async function obtenerEnvios(tipo) {
  const logisticBuscado = LOGISTIC[tipo];
  if (!logisticBuscado) throw new Error('Tipo inválido (usá flex o colecta)');

  const token = await getValidToken(ML_USER_ID);
  if (!token) throw new Error('No hay token de ML disponible en ml_tokens');

  // Rango: últimos DIAS_BUSQUEDA días (hora Argentina UTC-3)
  const desde = new Date();
  desde.setDate(desde.getDate() - DIAS_BUSQUEDA);
  const desdeISO = desde.toISOString().substring(0, 10) + 'T00:00:00.000-03:00';
  const hastaISO = new Date().toISOString().substring(0, 10) + 'T23:59:59.000-03:00';

  // 1) Traer órdenes pagadas del rango (paginado)
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
  console.log(`[ENVIOS] tipo=${tipo} órdenes pagadas en ${DIAS_BUSQUEDA}d: ${ordenes.length}`);

  // 2) Quedarnos con un envío por shipment (dedupe de packs/multi-item)
  const porShipment = new Map();
  for (const o of ordenes) {
    const shipId = o.shipping && o.shipping.id;
    if (!shipId) continue;
    const item = (o.order_items && o.order_items[0]) || {};
    const sku  = (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '';
    const titulo = (item.item && item.item.title) || '';
    if (!porShipment.has(shipId)) {
      porShipment.set(shipId, {
        shipment_id: String(shipId),
        nro_venta:   String(o.id),
        sku:         sku ? String(sku).trim() : '',
        titulo,
        unidades:    item.quantity || 1
      });
    }
  }

  // 3) Consultar cada envío para saber estado y tipo de logística
  const shipments = Array.from(porShipment.values());
  const detallados = await poolMap(shipments, 5, async (s) => {
    try {
      const r = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const ship = await r.json();
      s.status   = ship.status || '';
      s.logistic = ship.logistic_type || (ship.logistic && ship.logistic.type) || '';
    } catch (e) {
      s.status = 'error'; s.logistic = '';
    }
    return s;
  });

  // 4) Filtrar por la tanda pedida y separar listos / no listos
  const deLaTanda = detallados.filter(s => s.logistic === logisticBuscado);
  const listos    = deLaTanda.filter(s => s.status === 'ready_to_ship');
  const noListos  = deLaTanda.filter(s => s.status !== 'ready_to_ship');

  // 5) Ordenar por SKU (los sin SKU al final). Orden natural/alfabético.
  const ordenarPorSku = (a, b) => {
    if (!a.sku && b.sku) return 1;
    if (a.sku && !b.sku) return -1;
    return a.sku.localeCompare(b.sku, 'es', { numeric: true, sensitivity: 'base' });
  };
  listos.sort(ordenarPorSku);
  noListos.sort(ordenarPorSku);

  console.log(`[ENVIOS] tipo=${tipo} listos=${listos.length} no_listos=${noListos.length}`);
  return { listos, no_listos: noListos, token };
}

// ── Endpoint: pendientes (vista previa, lo que se va a imprimir) ───
app.get('/api/despacho/pendientes', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    const { listos, no_listos } = await obtenerEnvios(tipo);
    res.json({
      tipo,
      cantidad: listos.length,
      listos:    listos.map(({ shipment_id, nro_venta, sku, titulo, unidades }) =>
        ({ shipment_id, nro_venta, sku, titulo, unidades })),
      no_listos: no_listos.map(({ shipment_id, nro_venta, sku, titulo, status }) =>
        ({ shipment_id, nro_venta, sku, titulo, status }))
    });
  } catch (e) {
    console.error('[PENDIENTES] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint: etiquetas (PDF concatenado, ordenado por SKU) ───────
app.get('/api/despacho/etiquetas', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    const { listos, token } = await obtenerEnvios(tipo);
    if (listos.length === 0) {
      return res.status(404).json({ error: 'No hay envíos listos para imprimir en esta tanda' });
    }

    // Pedimos cada etiqueta INDIVIDUAL en el orden por SKU y la
    // bajamos en paralelo (de a 5). Así garantizamos el orden exacto.
    const pdfs = await poolMap(listos, 5, async (s) => {
      const r = await fetch(
        `https://api.mercadolibre.com/shipment_labels?shipment_ids=${s.shipment_id}&response_type=pdf`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) { console.error(`[ETIQUETA] ship=${s.shipment_id} status HTTP ${r.status}`); return null; }
      return await r.buffer();
    });

    // Concatenar en orden
    const merged = await PDFDocument.create();
    let ok = 0, fallidas = 0;
    for (let i = 0; i < pdfs.length; i++) {
      const buf = pdfs[i];
      if (!buf || buf.__error) { fallidas++; continue; }
      try {
        const src = await PDFDocument.load(buf);
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
        ok++;
      } catch (e) {
        console.error(`[ETIQUETA] no se pudo unir ship=${listos[i].shipment_id}: ${e.message}`);
        fallidas++;
      }
    }
    console.log(`[ETIQUETAS] tipo=${tipo} unidas=${ok} fallidas=${fallidas}`);

    const bytes = await merged.save();
    const fecha = new Date().toISOString().substring(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiquetas_${tipo}_${fecha}.pdf"`);
    res.setHeader('X-Etiquetas-Unidas', String(ok));
    res.setHeader('X-Etiquetas-Fallidas', String(fallidas));
    res.send(Buffer.from(bytes));
  } catch (e) {
    console.error('[ETIQUETAS] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Salud ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, app: 'deposito-backend', fase: 1 }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Depósito backend escuchando en :${PORT}`));
