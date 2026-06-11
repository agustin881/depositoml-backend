const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// Marcador de version (para verificar que Railway tiene el codigo nuevo)
app.get('/api/version', (req, res) => res.json({ version: 'backfill-update-v3', costo_congelado: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Middleware: exige usuario logueado (token de Supabase) ────────
async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Sesion invalida' });
    req.authUser = data.user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'No autorizado' });
  }
}

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI  = process.env.ML_REDIRECT_URI || 'https://margenml-frontend.vercel.app/';

// ── OAUTH ─────────────────────────────────────────────────────────
app.post('/api/auth/token', async (req, res) => {
  try {
    const { code } = req.body;
    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri:  ML_REDIRECT_URI
      })
    });
    const data = await resp.json();
    if (data.error) return res.status(400).json(data);

    const { error } = await supabase.from('ml_tokens').upsert({
      user_id:       String(data.user_id),
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString()
    }, { onConflict: 'user_id' });

    if (error) console.error('Supabase upsert error:', error);

    res.json({ access_token: data.access_token, user_id: data.user_id, expires_in: data.expires_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REFRESH TOKEN ─────────────────────────────────────────────────
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { user_id } = req.body;
    const { data: tokenRow } = await supabase
      .from('ml_tokens').select('*').eq('user_id', user_id).single();
    if (!tokenRow) return res.status(404).json({ error: 'Token no encontrado' });

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
    if (data.error) return res.status(400).json(data);

    await supabase.from('ml_tokens').upsert({
      user_id:       String(data.user_id),
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString()
    }, { onConflict: 'user_id' });

    res.json({ access_token: data.access_token, expires_in: data.expires_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Helper: token válido ──────────────────────────────────────────
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
    console.error('Refresh falló:', data);
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

// ── Helper: datos de envío completos ─────────────────────────────
async function getShipData(shipmentId, token) {
  if (!shipmentId) return {};
  try {
    const r = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const ship = await r.json();
    if (ship.error) return {};

    // Costo "bruto" del envío = tarifa total de ML (con IVA)
    let costoEnvio   = (ship.shipping_option && ship.shipping_option.list_cost) || ship.base_cost || 0;
    // Aporte del comprador (fallback: campo del shipment; suele venir 0 en envíos subsidiados)
    let pagoComprador = (ship.shipping_option && ship.shipping_option.cost) || 0;

    // Desglose real de costos: acá está lo que paga el comprador y lo que banca el vendedor.
    try {
      const rc = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/costs`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const costs = await rc.json();
      if (costs && !costs.error) {
        const gross    = Number(costs.gross_amount) || 0;
        const recvCost = (costs.receiver && Number(costs.receiver.cost)) || 0;
        const sender   = (Array.isArray(costs.senders) && costs.senders[0]) || {};
        const sendCost = Number(sender.cost) || 0;

        // Solo piso el aporte del comprador si el desglose lo informa (>0).
        if (recvCost > 0) pagoComprador = recvCost;
        // Si el shipment no traía list_cost pero el desglose sí trae el bruto, lo uso.
        if (!costoEnvio && gross > 0) costoEnvio = gross;

        // Log de verificación: bruto - aporteComprador debería dar el neto del vendedor (senders.cost)
        console.log(`[ENVIO] ship=${shipmentId} bruto=${costoEnvio} pagoComprador=${pagoComprador} netoCalc=${costoEnvio - pagoComprador} netoVendedor(senders.cost)=${sendCost} | keys=${Object.keys(costs).join(',')}`);
      }
    } catch(e) { /* si /costs falla, quedan los valores del shipment */ }

    // ML devuelve la dirección del comprador bajo receiver_address (no receiver)
    const rcv = ship.receiver_address || ship.receiver || {};
    console.log(`[PROV] ship=${shipmentId} provincia=${(rcv.state && rcv.state.name) || '(vacío)'} ciudad=${(rcv.city && rcv.city.name) || '(vacío)'} | shipKeys=${Object.keys(ship).join(',')}`);
    return {
      costo_envio:            costoEnvio,
      precio_comprador_envio: pagoComprador,
      logistic_type:          ship.logistic_type || '',
      provincia:             (rcv.state && rcv.state.name) || '',
      ciudad:                (rcv.city  && rcv.city.name)  || '',
    };
  } catch(e) {
    return {};
  }
}

// ── Helper: datos de ítem (tipo de publicación) ───────────────────
async function getItemData(itemId, token) {
  if (!itemId) return {};
  try {
    const r = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=listing_type_id,seller_sku`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const item = await r.json();
    if (item.error) return {};
    return {
      tipo_publicacion: item.listing_type_id || '',
    };
  } catch(e) {
    return {};
  }
}

// ── Helper: construir objeto venta completo ───────────────────────
async function buildVentaRow(order, userId, token, incluirEnvio = true) {
  const item     = (order.order_items && order.order_items[0]) || {};
  const payment  = (order.payments && order.payments[0]) || {};
  const sku      = (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '';
  const comision = order.order_items
    ? order.order_items.reduce((a, i) => a + (i.sale_fee || 0), 0) : 0;

  // Cuotas y costo financiero
  const cuotas = payment.installments || 1;
  // ML cobra un costo financiero por cuotas: total_paid_amount - transaction_amount
  const costoFinanciero = (payment.total_paid_amount && payment.transaction_amount)
    ? Math.max(0, payment.total_paid_amount - payment.transaction_amount)
    : 0;

  // Tipo de publicación
  const itemData = incluirEnvio && item.item && item.item.id
    ? await getItemData(item.item.id, token)
    : {};

  // Envío
  const shipData = incluirEnvio && order.shipping && order.shipping.id
    ? await getShipData(order.shipping.id, token)
    : {};

  return {
    nro_venta:             String(order.id),
    user_id:               String(userId),
    fecha:                 order.date_created,
    fecha_cierre:          order.date_closed || null,
    sku:                   sku ? String(sku).trim() : '',
    titulo:                item.item ? item.item.title : '',
    unidades:              item.quantity || 1,
    precio:                order.total_amount,
    comision,
    costo_envio:           shipData.costo_envio           || 0,
    precio_comprador_envio:shipData.precio_comprador_envio || 0,
    logistic_type:         shipData.logistic_type          || '',
    provincia:             shipData.provincia              || '',
    ciudad:                shipData.ciudad                 || '',
    estado:                order.status,
    con_cuotas:            cuotas > 1,
    cuotas:                cuotas,
    costo_financiero:      costoFinanciero,
    tipo_publicacion:      itemData.tipo_publicacion       || '',
    pack_id:               order.pack_id ? String(order.pack_id) : null,
    item_id:               (item.item && item.item.id) ? String(item.item.id) : null,
    raw:                   order
  };
}

// ── Helper: encontrar la orden asociada a un envío (Flex/shipments) ─
async function getOrderIdFromShipment(shipmentId, token) {
  if (!shipmentId) return null;
  try {
    // 1) El detalle del envío a veces ya trae order_id
    const r = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const ship = await r.json();
    if (ship && ship.order_id) return String(ship.order_id);

    // 2) Si no, /shipments/{id}/items devuelve el order_id de cada ítem
    const ri = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/items`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const items = await ri.json();
    if (Array.isArray(items) && items[0] && items[0].order_id) {
      return String(items[0].order_id);
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── WEBHOOK ───────────────────────────────────────────────────────
// ── Helper: costo interno de Contabilium para un SKU ──────────────
async function getCostoInterno(sku) {
  try {
    if (!sku) return null;
    const token = await getContabiliumToken();
    if (!token) return null;
    const r = await fetch(`https://rest.contabilium.com/api/conceptos/getByCodigo?codigo=${encodeURIComponent(sku)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (data && data.CostoInterno != null) return data.CostoInterno;
    return null;
  } catch (e) {
    return null;
  }
}

app.post('/api/webhook/ml', async (req, res) => {
  try {
    const { topic, resource, user_id } = req.body || {};
    if (typeof resource !== 'string') return res.sendStatus(200);

    const token = await getValidToken(user_id);
    if (!token) return res.sendStatus(200);

    let orderId = null;

    if (resource.startsWith('/orders/')) {
      // Ventas normales (Full / Colecta / M1) y cambios de estado (cancela/devuelve)
      orderId = resource.split('/').pop();
    } else if (resource.startsWith('/shipments/')) {
      // Envíos (incluye Flex): hay que sacar la orden asociada al envío
      const shipmentId = resource.split('/').pop();
      orderId = await getOrderIdFromShipment(shipmentId, token);
    } else {
      // Cualquier otro tópico que no nos interesa
      return res.sendStatus(200);
    }

    if (!orderId) return res.sendStatus(200);

    const orderResp = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const order = await orderResp.json();
    if (order.error || !order.id) return res.sendStatus(200);

    // upsert: si la orden ya existía, se actualiza su estado (cancelada / devuelta / etc.)
    const row = await buildVentaRow(order, user_id, token, true);
    await supabase.from('ventas').upsert(row, { onConflict: 'nro_venta' });

    // Congelar el costo de Contabilium al momento de la venta (solo si aun no lo tiene)
    if (row.sku) {
      const cInterno = await getCostoInterno(row.sku);
      if (cInterno != null) {
        await supabase.from('ventas')
          .update({ costo_congelado: cInterno })
          .eq('nro_venta', row.nro_venta)
          .is('costo_congelado', null);
      }
    }

    console.log('Venta guardada (webhook):', order.id, order.status, '/', topic || resource.split('/')[1]);
    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    return res.sendStatus(200);
  }
});

// ── VENTAS: obtener ventas guardadas (paginado para superar límite de 1000) ─
app.get('/api/ventas', requireAuth, async (req, res) => {
  try {
    const { user_id, desde, hasta } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

    let todas = [];
    let offset = 0;
    const lote = 1000;

    while (true) {
      let query = supabase.from('ventas').select('nro_venta,user_id,fecha,fecha_cierre,sku,titulo,unidades,precio,comision,costo_envio,precio_comprador_envio,logistic_type,provincia,ciudad,estado,con_cuotas,cuotas,costo_financiero,tipo_publicacion,pack_id,item_id,costo_congelado').eq('user_id', user_id);
      if (desde) query = query.gte('fecha', desde);
      if (hasta) query = query.lte('fecha', hasta);
      query = query.order('fecha', { ascending: false }).range(offset, offset + lote - 1);

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      todas = todas.concat(data);
      if (data.length < lote) break;   // último lote
      offset += lote;
      if (offset > 500000) break;       // tope de seguridad
    }

    res.json({ ventas: todas, total: todas.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SYNC DIARIO: cron job, trae ventas de ayer completas ──────────
app.get('/api/sync/diario', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  res.json({ message: 'Sync diario iniciado' });

  try {
    const { data: tokens } = await supabase.from('ml_tokens').select('*');
    if (!tokens || tokens.length === 0) return;

    for (const tokenRow of tokens) {
      const userId = tokenRow.user_id;
      const token  = await getValidToken(userId);
      if (!token) continue;

      // Ayer completo en hora Argentina (UTC-3)
      const ayer = new Date();
      ayer.setDate(ayer.getDate() - 1);
      const desdeISO = ayer.toISOString().substring(0,10) + 'T00:00:00.000-03:00';
      const hastaISO = ayer.toISOString().substring(0,10) + 'T23:59:59.000-03:00';

      let offset = 0, total = 999, guardadas = 0;

      while (offset < Math.min(total, 9950)) {
        const url = `https://api.mercadolibre.com/orders/search?seller=${userId}`
          + `&order.date_created.from=${encodeURIComponent(desdeISO)}`
          + `&order.date_created.to=${encodeURIComponent(hastaISO)}`
          + `&sort=date_asc&offset=${offset}&limit=50&access_token=${token}`;

        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) { console.error('Sync diario error ML:', data.error); break; }

        total = data.paging.total;

        for (const order of data.results || []) {
          const row = await buildVentaRow(order, userId, token, true);
          await supabase.from('ventas').upsert(row, { onConflict: 'nro_venta' });
          guardadas++;
          await new Promise(r => setTimeout(r, 150)); // pausa entre ventas
        }

        offset += 50;
        await new Promise(r => setTimeout(r, 400));
      }

      console.log(`Sync diario user ${userId}: ${guardadas} ventas procesadas`);
    }
  } catch (e) {
    console.error('Sync diario error:', e.message);
  }
});

// ── SYNC (manual) ─────────────────────────────────────────────────
// Recorre las ventas desde hoy hacia atrás `dias` días y las guarda.
// incluirEnvio = true trae tipo de envío (Flex/Full/Colecta/M1) — más lento.
async function runSync(userId, dias, incluirEnvio) {
  let guardadas = 0;
  let errores = 0;
  try {
    const desde = new Date();
    desde.setDate(desde.getDate() - (dias || 90));

    let chunkDesde = new Date(desde);
    const hoy = new Date();

    console.log(`========================================`);
    console.log(`[SYNC] ARRANCA user=${userId} dias=${dias} envio=${incluirEnvio}`);
    console.log(`[SYNC] rango: ${desde.toISOString().substring(0,10)} -> ${hoy.toISOString().substring(0,10)}`);
    console.log(`========================================`);

    while (chunkDesde < hoy) {
      // Token renovado por chunk (los syncs largos pueden superar la vida del token)
      const token = await getValidToken(userId);
      if (!token) { console.error('[SYNC] CORTE: sin token para', userId); break; }

      const chunkHasta = new Date(chunkDesde);
      chunkHasta.setDate(chunkDesde.getDate() + 7);
      if (chunkHasta > hoy) chunkHasta.setTime(hoy.getTime());

      const desdeISO = chunkDesde.toISOString().substring(0,10)+'T00:00:00.000-03:00';
      const hastaISO = chunkHasta.toISOString().substring(0,10)+'T23:59:59.000-03:00';

      console.log(`[SYNC] CHUNK ${desdeISO.substring(0,10)} -> ${hastaISO.substring(0,10)} | guardadas hasta ahora=${guardadas}`);

      let offset = 0, total = 999;
      while (offset < Math.min(total, 9950)) {
        const url = `https://api.mercadolibre.com/orders/search?seller=${userId}`
          + `&order.date_created.from=${encodeURIComponent(desdeISO)}`
          + `&order.date_created.to=${encodeURIComponent(hastaISO)}`
          + `&sort=date_asc&offset=${offset}&limit=50&access_token=${token}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) { console.error('[SYNC] ERROR ML orders/search:', JSON.stringify(data)); break; }
        total = (data.paging && data.paging.total) || 0;
        const cantidad = (data.results || []).length;
        console.log(`[SYNC]   pagina offset=${offset} total_ML=${total} trajo=${cantidad}`);

        for (const order of data.results || []) {
          try {
            // /orders/search NO trae el seller_sku completo -> traemos la orden
            // completa igual que el webhook, asi el SKU matchea con Contabilium
            let orderFull = order;
            try {
              const oResp = await fetch(`https://api.mercadolibre.com/orders/${order.id}?access_token=${token}`);
              const oData = await oResp.json();
              if (oData && oData.id) orderFull = oData;
            } catch (_) {}
            const row = await buildVentaRow(orderFull, userId, token, incluirEnvio);
            const { error: upErr } = await supabase.from('ventas').upsert(row, { onConflict: 'nro_venta' });
            if (upErr) { errores++; console.error('[SYNC] ERROR upsert venta', order.id, ':', upErr.message); }
            else guardadas++;
          } catch (orderErr) {
            errores++;
            console.error('[SYNC] ERROR procesando venta', order && order.id, ':', orderErr.message);
          }
          if (incluirEnvio) await new Promise(r => setTimeout(r, 120));
        }

        offset += 50;
        await new Promise(r => setTimeout(r, incluirEnvio ? 300 : 200));
      }

      chunkDesde.setDate(chunkDesde.getDate() + 8);
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`========================================`);
    console.log(`[SYNC] COMPLETO user ${userId}: ${guardadas} guardadas, ${errores} errores (dias=${dias}, envio=${incluirEnvio})`);
    console.log(`========================================`);
  } catch (e) {
    console.error('[SYNC] ERROR FATAL:', e.message, '|', e.stack);
  }
  return guardadas;
}

// POST /api/sync  { user_id, dias, envio }
app.post('/api/sync', (req, res) => {
  const { user_id, dias, envio } = req.body || {};
  const incluirEnvio = envio !== false && envio !== 'no';
  res.json({ message: 'Sincronización iniciada', user_id, dias, envio: incluirEnvio });
  runSync(String(user_id), Number(dias) || 90, incluirEnvio);
});

// GET /api/sync?user_id=...&dias=...&envio=si|no  (para disparar desde el navegador)
app.get('/api/sync', (req, res) => {
  const user_id = req.query.user_id;
  const dias    = Number(req.query.dias) || 7;
  const incluirEnvio = req.query.envio !== 'no';
  if (!user_id) return res.status(400).json({ error: 'Falta user_id. Ej: /api/sync?user_id=67619515&dias=7' });
  res.json({
    message: 'Sincronización iniciada. Corre en segundo plano; mirá los logs de Railway para ver el avance.',
    user_id, dias, envio: incluirEnvio
  });
  runSync(String(user_id), dias, incluirEnvio);
});

// ── CONTABILIUM: obtener token ────────────────────────────────────
async function getContabiliumToken() {
  const resp = await fetch('https://rest.contabilium.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.CONTABILIUM_CLIENT_ID,
      client_secret: process.env.CONTABILIUM_CLIENT_SECRET
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Contabilium auth falló: ' + JSON.stringify(data));
  return data.access_token;
}

// ── CONTABILIUM: traer todos los productos con costo ──────────────
// GET /api/costos/contabilium
// Devuelve array de { codigo, nombre, costoInterno, iva, precio }
app.get('/api/costos/contabilium', requireAuth, async (req, res) => {
  try {
    const token = await getContabiliumToken();
    const pageSize = 50;
    const base = 'https://rest.contabilium.com/api/conceptos/search';
    const PAUSA = 500; // Contabilium limita a 25 pedidos/10s -> ~2/seg es seguro
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const getPage = async (pageParam, n) => {
      const url = `${base}?pageSize=${pageSize}&${pageParam}=${n}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return r.json();
    };
    const primerCod = (d) => {
      const it = (d && (d.Items || d.items)) || [];
      return it.length ? String(it[0].Codigo || it[0].codigo || '').toUpperCase().trim() : '';
    };
    const _seen = new Map();
    const addItems = (d) => {
      const it = (d && (d.Items || d.items)) || [];
      let n = 0;
      for (const x of it) {
        const c = String(x.Codigo || x.codigo || '').toUpperCase().trim();
        if (c && !_seen.has(c)) { _seen.set(c, x); n++; }
      }
      return { nuevos: n, len: it.length };
    };

    // Página 1 (cualquier nombre da la primera página si el parámetro se ignora)
    const d1 = await getPage('pageNumber', 1);
    const cod1 = primerCod(d1);
    const totalItems = (d1 && d1.TotalItems != null) ? d1.TotalItems : null;
    console.log(`[CONTA] pagina 1: primerCod=${cod1} TotalItems=${totalItems}`);
    addItems(d1);

    // Detectar cuál parámetro pagina DE VERDAD (que la página 2 traiga otros códigos)
    const candidatos = ['pageNumber', 'page', 'nroPagina', 'pagina', 'nroPag', 'pageIndex'];
    let pageParam = null;
    for (const cand of candidatos) {
      await sleep(PAUSA);
      const d2 = await getPage(cand, 2);
      const cod2 = primerCod(d2);
      console.log(`[CONTA] probando "${cand}=2" -> primerCod=${cod2}`);
      if (cod2 && cod2 !== cod1) { pageParam = cand; addItems(d2); break; }
    }

    if (pageParam) {
      console.log(`[CONTA] paginación OK con parámetro "${pageParam}"`);
      let page = 3; // ya tenemos página 1 y 2
      while (true) {
        await sleep(PAUSA);
        const d = await getPage(pageParam, page);
        const { nuevos, len } = addItems(d);
        console.log(`[CONTA] pagina ${page} (${pageParam}) nuevos=${nuevos} | unicos=${_seen.size}`);
        if (len === 0 || nuevos === 0 || len < pageSize) break;
        page++;
        if (page > 500) break;
      }
    } else {
      console.error('[CONTA] NINGUN parametro de paginacion cambio la pagina -> solo ' + _seen.size + ' productos. Revisar el nombre del parametro en la doc de Contabilium.');
    }

    const costos = [..._seen.values()].map(p => ({
      codigo:       String(p.Codigo || p.codigo || '').toUpperCase().trim(),
      nombre:       p.Nombre || p.nombre || '',
      costoInterno: p.CostoInterno || p.costoInterno || 0,
      iva:          p.Iva || p.iva || 0,
      precio:       p.Precio || p.precio || 0,
      estado:       p.Estado || p.estado || ''
    })).filter(p => p.codigo);

    console.log(`[CONTA] TOTAL: ${costos.length} productos unicos (parametro=${pageParam || 'NINGUNO'}, esperado ~${totalItems})`);
    res.json({ costos, total: costos.length, pageParam: pageParam || null });
  } catch (e) {
    console.error('Contabilium error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CONTABILIUM: buscar producto por SKU ──────────────────────────
app.get('/api/costos/contabilium/:sku', requireAuth, async (req, res) => {
  try {
    const token = await getContabiliumToken();
    const sku = encodeURIComponent(req.params.sku);
    const r = await fetch(`https://rest.contabilium.com/api/conceptos/getByCodigo?codigo=${sku}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (data.error || !data.Codigo) return res.status(404).json({ error: 'SKU no encontrado' });
    res.json({
      codigo:       data.Codigo,
      nombre:       data.Nombre,
      costoInterno: data.CostoInterno || 0,
      iva:          data.Iva || 0,
      precio:       data.Precio || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BACKFILL HISTÓRICO (TEMPORAL): carga costo_congelado desde el CMV ──
// Matchea cada venta con el CMV por SKU exacto + precio (c/IVA) + día (±2),
// y si no, por el precio más cercano del mismo SKU en el mes. Sobreescribe.
app.post('/api/costos/backfill', requireAuth, async (req, res) => {
  try {
    const userId = req.body.user_id;
    const filas  = req.body.rows || [];
    if (!userId || !filas.length) return res.status(400).json({ error: 'Faltan datos' });

    const DAY = 864e5;
    const cmv = [];
    let minD = null, maxD = null;
    for (const f of filas) {
      const sku   = String(f.sku || '').trim();
      const cant  = (parseFloat(f.cantidad) || 1) || 1;
      const pu    = parseFloat(f.precioUnit);
      const iva   = parseFloat(f.iva) || 0;
      const costo = parseFloat(f.costo);
      const dia   = f.fecha ? new Date(f.fecha) : null;
      if (!sku || isNaN(pu) || isNaN(costo) || !dia || isNaN(dia.getTime())) continue;
      const t = dia.getTime();
      cmv.push({ sku, bruto_u: pu * (1 + iva / 100), costo_u: costo / cant, t });
      if (minD === null || t < minD) minD = t;
      if (maxD === null || t > maxD) maxD = t;
    }
    if (!cmv.length) return res.status(400).json({ error: 'CMV vacio o invalido' });

    const bySku = {};
    for (const r of cmv) { (bySku[r.sku] = bySku[r.sku] || []).push(r); }

    // Traer ventas del rango (±2 dias) paginando (tope 1000 del plan free)
    const desde = new Date(minD - 2 * DAY).toISOString();
    const hasta = new Date(maxD + 2 * DAY).toISOString();
    let ventas = [], from = 0;
    while (true) {
      const { data, error } = await supabase.from('ventas')
        .select('nro_venta,sku,precio,unidades,fecha_cierre,fecha')
        .eq('user_id', userId)
        .gte('fecha_cierre', desde).lte('fecha_cierre', hasta)
        .range(from, from + 999);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || !data.length) break;
      ventas = ventas.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    const updates = [];
    let exacto = 0, aprox = 0, sin = 0;
    for (const v of ventas) {
      const sku = String(v.sku || '').trim();
      const cands = bySku[sku];
      const unidades = parseFloat(v.unidades) || 1;
      const precio = parseFloat(v.precio) || 0;
      const dt = new Date(v.fecha_cierre || v.fecha);
      if (!cands || !precio || isNaN(dt.getTime())) { sin++; continue; }
      const bruto_u = unidades > 0 ? precio / unidades : precio;
      const t = dt.getTime();
      let best = null;
      for (const c of cands) {
        if (Math.abs(c.t - t) / DAY <= 2.5) {
          const pdif = Math.abs(c.bruto_u - bruto_u);
          if (best === null || pdif < best.pdif) best = { pdif, costo_u: c.costo_u };
        }
      }
      let costo_u = null, esExacto = false;
      if (best) {
        costo_u = best.costo_u;
        esExacto = bruto_u > 0 && (best.pdif / bruto_u) <= 0.005;
      } else {
        let b2 = null;
        for (const c of cands) {
          const pdif = Math.abs(c.bruto_u - bruto_u);
          if (b2 === null || pdif < b2.pdif) b2 = { pdif, costo_u: c.costo_u };
        }
        if (b2) costo_u = b2.costo_u;
      }
      if (costo_u === null) { sin++; continue; }
      if (esExacto) exacto++; else aprox++;
      updates.push({ nro_venta: v.nro_venta, costo_congelado: Math.round(costo_u * unidades * 100) / 100 });
    }

    let actualizadas = 0;
    for (let i = 0; i < updates.length; i += 50) {
      const lote = updates.slice(i, i + 50);
      const resultados = await Promise.all(lote.map(u =>
        supabase.from('ventas')
          .update({ costo_congelado: u.costo_congelado })
          .eq('user_id', userId)
          .eq('nro_venta', u.nro_venta)
      ));
      for (const r of resultados) { if (!r.error) actualizadas++; }
    }

    res.json({ ventas: ventas.length, exacto, aprox, sin, actualizadas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATUS ────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '4.4.0', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
// ── MEDIDAS: planilla de pesos/medidas publicada en Google Sheets ────
const MEDIDAS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTpXeWJBa0W6P4uZuEl8VrR2HN75pHr5oDXlD3BraTnSsVpjDh950v6O6k3y_q-lIA2S-feSRlh6tdu/pub?gid=1181343863&single=true&output=csv';
let _medidasCache = null, _medidasTs = 0;

function _parseCSV(text){
  const rows=[]; let row=[]; let field=''; let inQ=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQ){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else inQ=false; }
      else field+=c;
    } else {
      if(c==='"') inQ=true;
      else if(c===','){ row.push(field); field=''; }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else if(c==='\r'){ /* ignorar */ }
      else field+=c;
    }
  }
  if(field!==''||row.length){ row.push(field); rows.push(row); }
  return rows;
}
function _numAR(s){
  if(s==null) return 0;
  s=String(s).replace(/[$\s\u00a0]/g,'');
  if(!s) return 0;
  if(s.indexOf('.')>-1 && s.indexOf(',')>-1) s=s.replace(/\./g,'').replace(',','.');
  else if(s.indexOf(',')>-1) s=s.replace(',','.');
  const n=parseFloat(s);
  return isNaN(n)?0:n;
}
function _normH(c){ return (c||'').replace(/\s+/g,' ').trim().toLowerCase(); }
function buildMedidas(text){
  const rows=_parseCSV(text);
  let hi=-1;
  for(let i=0;i<rows.length;i++){ if(rows[i].some(c=>_normH(c)==='sku producto')){ hi=i; break; } }
  if(hi<0) return {};
  const hdr=rows[hi].map(_normH);
  const cSku=hdr.indexOf('sku producto');
  const cLargo=hdr.indexOf('largo'), cAncho=hdr.indexOf('ancho'), cAlto=hdr.indexOf('alto');
  const cPeso=hdr.indexOf('peso'), cKg=hdr.indexOf('kg de envio'), cEnvioML=hdr.indexOf('envio mercado libre');
  const map={};
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i]; const sku=(r[cSku]||'').trim();
    if(!sku) continue;
    map[sku.toUpperCase()]={
      sku, largo:_numAR(r[cLargo]), ancho:_numAR(r[cAncho]), alto:_numAR(r[cAlto]),
      peso:_numAR(r[cPeso]), kgEnvio:_numAR(r[cKg]), envioML:_numAR(r[cEnvioML])
    };
  }
  return map;
}

// GET /api/medidas -> mapa SKU -> medidas (cacheado 5 min). Lee la planilla publicada.
app.get('/api/medidas', requireAuth, async (req, res) => {
  try {
    const ahora = Date.now();
    if (_medidasCache && (ahora - _medidasTs) < 5*60*1000) {
      return res.json({ medidas: _medidasCache, skus: Object.keys(_medidasCache).length, cache: true });
    }
    const r = await fetch(MEDIDAS_CSV_URL);
    const text = await r.text();
    const map = buildMedidas(text);
    if (Object.keys(map).length > 0) { _medidasCache = map; _medidasTs = ahora; }
    console.log('[MEDIDAS] cargadas', Object.keys(map).length, 'SKUs desde Google Sheets');
    res.json({ medidas: map, skus: Object.keys(map).length, cache: false });
  } catch (e) {
    console.error('[MEDIDAS] error:', e.message);
    res.status(500).json({ error: e.message, medidas: {} });
  }
});

app.listen(PORT, () => console.log(`MargenML backend v3 corriendo en puerto ${PORT}`));

module.exports = app;
