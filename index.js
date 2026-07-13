// ============================================================
//  DEPÓSITO · BACKEND  v5.0
//  Fase 1: impresión por SKU + registro + reimpresión + conteo
//  Fase 2: verificación de despacho (escaneo + chequeo de cancelación),
//  seguimiento por etapas, código del día y colectas del día
//  Parte 2 (v5.0): centro de despacho — base de camiones, destinos
//  (Colecta con camión / Flex con transportista), abrir/cerrar destino,
//  escaneo que carga al destino con validación Flex↔Colecta, y detalle
//  de pagos a transportistas tercerizados (Ruedo/Gustavo).
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
const MAX_ORDENES      = parseInt(process.env.MAX_ORDENES || '6000', 10); // tope de ventas a recorrer (20k/mes ≈ 5.300 en 8 días)
const CLAVE_DIAG       = (process.env.CLAVE_DIAG || '').trim(); // clave de los endpoints diag y oauth/login (SIN valor por defecto: configurala en Railway)

// ── Depósitos vinculados (tabla dep_depositos): ID de ML ↔ alias propio ──
// Si hay un depósito marcado como principal, el filtro usa el ID EXACTO
// (robusto: distingue dos depósitos en la misma ciudad). Si no hay ninguno
// configurado, se usa el filtro por texto DEPOSITO_FILTRO como siempre.
let _depCfg = { porId: new Map(), principalId: null };
async function cargarDepositosCfg() {
  try {
    const { data, error } = await supabase.from('dep_depositos').select('ml_address_id,alias,direccion,es_principal');
    if (error) { console.error('[DEPCFG]', error.message); return; }
    const m = new Map(); let ppal = null;
    for (const d of (data || [])) {
      m.set(String(d.ml_address_id), d);
      if (d.es_principal) ppal = String(d.ml_address_id);
    }
    _depCfg = { porId: m, principalId: ppal };
    console.log(`[DEPCFG] ${m.size} depósito(s) vinculados · principal: ${ppal ? (m.get(ppal).alias || ppal) : '(ninguno → filtro por texto "' + (DEPOSITO_FILTRO || 'desactivado') + '")'}`);
  } catch (e) { console.error('[DEPCFG]', e.message); }
}
setTimeout(cargarDepositosCfg, 3000);
setInterval(cargarDepositosCfg, 10 * 60 * 1000);

// ¿Este envío sale de nuestro depósito? (por ID si hay principal; si no, por texto)
function esDeNuestroDeposito(depId, depDir) {
  if (_depCfg.principalId) return !depId ? true : String(depId) === _depCfg.principalId;
  if (!DEPOSITO_FILTRO) return true;
  return !depDir ? true : normalizar(depDir).includes(DEPOSITO_FILTRO) || String(depId || '') === DEPOSITO_FILTRO;
}
// Nombre para mostrar: tu alias si existe, si no la dirección de ML
function nombreDeposito(depId, depDir) {
  const d = depId ? _depCfg.porId.get(String(depId)) : null;
  return (d && d.alias) ? d.alias : (depDir || '(sin dirección informada por ML)');
}

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

// Transportistas Flex tercerizados (no son camiones, no tienen patente).
// Se les ENTREGAN los paquetes. Configurable en Railway con FLEX_TRANSPORTISTAS.
const TRANSPORTISTAS_FLEX = (process.env.FLEX_TRANSPORTISTAS || 'Ruedo,Gustavo')
  .split(',').map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Middleware: exige usuario logueado (token de Supabase) ────────
async function requireAuth(req, res, next) {
  try {
    // Excepción temporal: diagnóstico accesible con clave en la URL (para debug)
    if ((req.path === '/diag' || req.path === '/diag-envio' || req.path === '/diag-colectas' || req.path === '/diag-fechas' || req.path === '/diag-nodo' || req.path === '/diag-imprimir' || req.path === '/diag-camion' || req.path === '/diag-fechadesp' || req.path === '/diag-skus' || req.path === '/diag-cancel' || req.path === '/diag-colcancel' || req.path === '/diag-key') && CLAVE_DIAG && (req.query.clave || '') === CLAVE_DIAG) return next();
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
// Alerta visible cuando el refresh del token falla (se ve en GET / del backend)
let _tokenAlerta = null;

async function getValidToken(userId) {
  const { data: tokenRow } = await supabase
    .from('ml_tokens').select('*').eq('user_id', String(userId)).single();
  if (!tokenRow) return null;
  if (new Date(tokenRow.expires_at).getTime() - 60000 > Date.now()) return tokenRow.access_token;

  // Token vencido → refresh con un reintento (los fallos transitorios son comunes)
  let data = null;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET, refresh_token: tokenRow.refresh_token
        })
      });
      data = await resp.json();
      if (!data.error) break;
      console.error(`[TOKEN] ⚠️ refresh falló (intento ${intento}/2):`, JSON.stringify(data));
      if (intento < 2) await sleep(2000);
    } catch (e) {
      console.error(`[TOKEN] ⚠️ refresh error de red (intento ${intento}/2):`, e.message);
      data = { error: e.message };
      if (intento < 2) await sleep(2000);
    }
  }
  if (!data || data.error) {
    _tokenAlerta = { desde: _tokenAlerta ? _tokenAlerta.desde : new Date().toISOString(),
      ultimo_error: (data && (data.message || data.error)) || 'desconocido',
      accion: 'El token de ML está vencido y el refresh falla. Reconectá ML: /api/oauth/login?clave=TU_CLAVE' };
    console.error('[TOKEN] 🔴 usando token vencido como último recurso — RECONECTÁ MERCADO LIBRE');
    return tokenRow.access_token; // último recurso: puede fallar con 401, pero los mensajes ahora lo explican
  }

  _tokenAlerta = null; // refresh OK → se levanta la alerta
  await supabase.from('ml_tokens').upsert({
    user_id: String(userId), access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  return data.access_token;
}

// ── Reconectar Mercado Libre (genera un token NUEVO con escritura) ──
// Estas rutas NO van detrás de requireAuth (son redirecciones del navegador).
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URI ||
  'https://depositoml-backend-production.up.railway.app/api/oauth/callback';

app.get('/api/oauth/login', (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG) return res.status(403).send('Falta la clave.');
  const url = 'https://auth.mercadolibre.com.ar/authorization'
    + '?response_type=code'
    + '&client_id=' + encodeURIComponent(ML_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(OAUTH_REDIRECT);
  res.redirect(url);
});

app.get('/api/oauth/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`<h2>No se pudo reconectar</h2><p>${req.query.error_description || req.query.error}</p>`);
    }
    const code = req.query.code;
    if (!code) return res.status(400).send('<h2>No llegó el código de Mercado Libre.</h2>');

    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code: String(code),
        redirect_uri: OAUTH_REDIRECT
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      console.error('[OAUTH] error', resp.status, JSON.stringify(data));
      return res.status(400).send(`<h2>No se pudo reconectar</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }

    const uid = String(data.user_id || ML_USER_ID);
    await supabase.from('ml_tokens').upsert({
      user_id: uid,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + (data.expires_in || 21600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    console.log(`[OAUTH] reconectado user=${uid} scope=${data.scope || '(sin scope informado)'}`);

    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 24px;color:#333">
        <div style="font-size:54px">✅</div>
        <h2 style="color:#00A650;margin:8px 0">Mercado Libre reconectado</h2>
        <p style="color:#666">Permisos otorgados: <b>${data.scope || '(revisá en la app)'}</b></p>
        <p>Ya podés cerrar esta pestaña y volver a la app a probar <b>"Separar"</b>.</p>
      </body></html>`);
  } catch (e) {
    console.error('[OAUTH]', e.message);
    res.status(500).send(`<h2>Error</h2><p>${e.message}</p>`);
  }
});

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
  while (offset < Math.min(total, MAX_ORDENES)) {
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
  if (total > MAX_ORDENES) console.warn(`[ENVIOS] ⚠️ hay ${total} ventas en la ventana de ${DIAS_BUSQUEDA} días pero el tope MAX_ORDENES=${MAX_ORDENES} solo cubre las más nuevas. Subí MAX_ORDENES en Railway si necesitás ver más atrás.`);

  const porShipment = new Map();
  for (const o of ordenes) {
    const shipId = o.shipping && o.shipping.id;
    if (!shipId) continue;
    const item = (o.order_items && o.order_items[0]) || {};
    const sku  = (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '';
    const titulo = (item.item && item.item.title) || '';
    // Unidades = suma de TODOS los productos de la orden (no solo el primero)
    const unidadesOrden = (o.order_items || []).reduce((a, it) => a + (it.quantity || 0), 0) || 1;
    if (!porShipment.has(shipId)) {
      porShipment.set(shipId, {
        shipment_id: String(shipId), nro_venta: String(o.id),
        pack_id: o.pack_id ? String(o.pack_id) : null,
        sku: sku ? String(sku).trim() : '', titulo, unidades: unidadesOrden
      });
    } else {
      // Pack con varias órdenes en el mismo envío: sumamos las unidades
      const ex = porShipment.get(shipId);
      ex.unidades = (ex.unidades || 0) + unidadesOrden;
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
      s.pay_before = (ship.shipping_option && ship.shipping_option.estimated_delivery_time
                    && ship.shipping_option.estimated_delivery_time.pay_before) || null;
      s.date_handling = (ship.status_history && ship.status_history.date_handling) || null;
      const sa = ship.sender_address || {};
      s.dep_id  = sa.id ? String(sa.id) : '';
      s.dep_dir = `${sa.address_line || ''} ${(sa.city && sa.city.name) || ''}`.trim();
    } catch (e) { s.status = 'error'; s.logistic = ''; s.limite = null; s.pay_before = null; s.dep_id = ''; s.dep_dir = ''; }
    return s;
  };

  const pasaFiltro = (s) => esDeNuestroDeposito(s.dep_id, s.dep_dir);

  // Estadísticas por depósito de origen (para verificar qué entra y qué queda afuera)
  const statsDep = new Map();
  const anotarDep = (s, incluido) => {
    const k = s.dep_id ? String(s.dep_id) : (s.dep_dir || '(sin dirección)');
    let e = statsDep.get(k);
    if (!e) { e = { id: s.dep_id ? String(s.dep_id) : null, deposito: nombreDeposito(s.dep_id, s.dep_dir), incluidos: 0, excluidos: 0 }; statsDep.set(k, e); }
    if (incluido) e.incluidos++; else e.excluidos++;
  };

  // Procesar en bloques: traer detalle (12 en paralelo) y, si hay callback,
  // guardar ese bloque ya filtrado antes de seguir (carga incremental/robusta).
  const BLOQUE = 120;
  const todos = [];
  let procesados = 0, afuera = 0;
  for (let i = 0; i < shipments.length; i += BLOQUE) {
    const bloque = shipments.slice(i, i + BLOQUE);
    const detallados = await poolMap(bloque, 12, traerDetalle);
    // Marcamos cuáles son de nuestro depósito; guardamos TODOS en memoria
    // (para poder consultar otros depósitos) pero la foto local (onLote)
    // sigue recibiendo SOLO los nuestros, igual que siempre.
    const conMarca = detallados.map(s => { s.es_nuestro = pasaFiltro(s); anotarDep(s, s.es_nuestro); if (!s.es_nuestro) afuera++; return s; });
    const delDeposito = conMarca.filter(s => s.es_nuestro);
    if (onLote && delDeposito.length) { try { await onLote(delDeposito); } catch (e) { console.error('[ENVIOS] onLote', e.message); } }
    for (const s of conMarca) todos.push(s);
    procesados += bloque.length;
    console.log(`[ENVIOS] progreso ${procesados}/${shipments.length} (nuestro: ${todos.filter(x=>x.es_nuestro).length} · otros: ${afuera})`);
    await sleep(120);
  }
  if (afuera) console.log(`[ENVIOS] ${afuera} envío(s) de otro depósito quedaron afuera`);
  _depositosStats = { filtro: DEPOSITO_FILTRO || '(desactivado: entra todo)', depositos: [...statsDep.values()].sort((a,b)=>b.incluidos-a.incluidos || b.excluidos-a.excluidos), actualizado: new Date().toISOString() };
  return todos;
}

// Última foto de depósitos vista al recorrer los envíos de ML
let _depositosStats = null;

// ── Foto local: mapear un envío a la fila de dep_envios ───────────
const tipoDeLogistic = lt =>
  lt === 'self_service' ? 'flex' : lt === 'cross_docking' ? 'colecta' : lt === 'fulfillment' ? 'full' : (lt || 'otro');

function filaEnvio(s) {
  const lt = s.logistic || '';
  const dir = s.dep_dir || '';
  const esNuestro = esDeNuestroDeposito(s.dep_id, dir);
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
    pay_before: s.pay_before || null,
    date_handling: s.date_handling || null,
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
      pay_before: (ship.shipping_option && ship.shipping_option.estimated_delivery_time
               && ship.shipping_option.estimated_delivery_time.pay_before) || null,
      date_handling: (ship.status_history && ship.status_history.date_handling) || null,
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
          s.unidades = ((ship.shipping_items || []).reduce((a, it) => a + (it.quantity || 0), 0))
            || ((order.order_items || []).reduce((a, it) => a + (it.quantity || 0), 0)) || 1;
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
function invalidarCacheEnvios() { _envCache = { at: 0, detallados: null }; } // ej.: al cambiar el depósito principal

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
async function obtenerEnvios(tipo, deposito) {
  const logisticBuscado = LOGISTIC[tipo];
  if (!logisticBuscado) throw new Error('Tipo inválido (usá flex o colecta)');
  const token = await getValidToken(ML_USER_ID);
  if (!token) throw new Error('No hay token de ML disponible en ml_tokens');

  const detallados = await obtenerDetalladosConCache(token);
  const depBuscado = deposito ? normalizar(String(deposito)) : null;
  const deLaTanda = detallados
    .filter(s => s.logistic === logisticBuscado)
    .filter(s => depBuscado
      ? (/^\d+$/.test(depBuscado)
          ? String(s.dep_id || '') === depBuscado           // depósito puntual por ID (exacto)
          : normalizar(s.dep_dir || '') === depBuscado)     // compatibilidad: por dirección
      : s.es_nuestro !== false);                            // por defecto: solo el nuestro

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
  const motivos = []; // por qué rechazó ML cada etiqueta (para informar al frontend)

  // Procesa un envío individual: página 0 = etiqueta, resto = detalle
  // Con reintentos: si ML limita la velocidad (429) o falla (5xx), espera y reintenta.
  async function pedirUno(s) {
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const r = await fetch(
          `https://api.mercadolibre.com/shipment_labels?shipment_ids=${s.shipment_id}&response_type=pdf`,
          { headers: { Authorization: `Bearer ${token}`, Connection: 'close', 'Accept-Encoding': 'identity' }, compress: false }
        );
        if (r.ok) return await r.buffer();
        if ((r.status === 429 || r.status >= 500) && intento < 3) {
          await sleep(intento * 2000); // 2s, luego 4s
          continue;
        }
        let detalleML = '';
        try { const j = await r.json(); detalleML = j.message || j.error || ''; } catch (e) {}
        console.error(`[ETIQUETA] ship=${s.shipment_id} HTTP ${r.status} ${detalleML}`);
        motivos.push({ ship: s.shipment_id, status: r.status, detalle: detalleML });
        return null;
      } catch (e) {
        if (intento < 3) { await sleep(intento * 2000); continue; }
        console.error(`[ETIQUETA] ship=${s.shipment_id}: ${e.message}`);
        motivos.push({ ship: s.shipment_id, status: 0, detalle: e.message });
        return null;
      }
    }
    return null;
  }

  async function unirIndividual(chunk) {
    const buffers = await poolMap(chunk, 2, pedirUno); // de a 2 para no saturar a ML
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
        { headers: { Authorization: `Bearer ${token}`, Connection: 'close', 'Accept-Encoding': 'identity' }, compress: false }
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
    await sleep(1500); // pausa real entre lotes de 50 para respetar el límite de ML
  }

  // Combinar: primero todas las etiquetas (orden SKU), después los detalles
  const merged = await PDFDocument.create();
  const labPages = await merged.copyPages(etiquetas, etiquetas.getPageIndices());
  labPages.forEach(p => merged.addPage(p));
  const detPages = await merged.copyPages(detalles, detalles.getPageIndices());
  detPages.forEach(p => merged.addPage(p));

  const bytes = await merged.save();
  return { bytes, impresos, fallidas, motivos };
}

// Arma un mensaje entendible cuando ML rechazó TODAS las etiquetas
function explicarFalloEtiquetas(motivos) {
  if (!motivos || !motivos.length) return 'No se pudo generar ninguna etiqueta';
  const m = motivos[0];
  const cuantas = motivos.length;
  if (m.status === 401 || m.status === 403)
    return `ML rechazó las ${cuantas} etiqueta(s) por autorización (HTTP ${m.status}). El token de ML está vencido: reconectá Mercado Libre y volvé a intentar.`;
  if (m.status === 400 || m.status === 404)
    return `ML rechazó las ${cuantas} etiqueta(s) (HTTP ${m.status}${m.detalle ? ': ' + m.detalle : ''}). Suele pasar cuando el envío todavía no está listo para imprimir (ej. es de mañana) o ya cambió de estado.`;
  if (m.status === 0)
    return `No pude conectar con ML para generar las etiquetas (${m.detalle || 'error de red'}). Reintentá en un rato.`;
  return `ML rechazó las ${cuantas} etiqueta(s) (HTTP ${m.status}${m.detalle ? ': ' + m.detalle : ''}).`;
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

function pdfResponse(res, bytes, ok, fallidas, nombre, motivo) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.setHeader('X-Etiquetas-Unidas', String(ok));
  res.setHeader('X-Etiquetas-Fallidas', String(fallidas));
  if (motivo) res.setHeader('X-Etiquetas-Motivo', encodeURIComponent(String(motivo).slice(0, 300)));
  res.send(Buffer.from(bytes));
}

// Resume los motivos de rechazo para un fallo PARCIAL (algunas sí, otras no)
function resumirMotivos(motivos) {
  if (!motivos || !motivos.length) return '';
  const cuenta = {};
  for (const m of motivos) cuenta[m.status] = (cuenta[m.status] || 0) + 1;
  const [status] = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0]; // el status más repetido
  const st = Number(status);
  const det = (motivos.find(m => m.status === st && m.detalle) || {}).detalle || '';
  if (st === 429) return 'ML limitó la velocidad (429): esperá 1 minuto y reimprimí las que faltaron desde "Impresas hoy"';
  if (st === 401 || st === 403) return `autorización (HTTP ${st}): el token de ML necesita reconexión`;
  if (st === 400 || st === 404) return `HTTP ${st}${det ? ' ' + det : ''}: envíos aún no listos para imprimir o con estado cambiado`;
  if (st === 0) return `error de red${det ? ': ' + det : ''}`;
  return `HTTP ${st}${det ? ': ' + det : ''}`;
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
    // Seguridad: solo procesamos notificaciones de NUESTRA cuenta (y nuestra app, si está configurada).
    // Cualquiera puede hacer POST a esta URL pública; lo ajeno se descarta sin guardar ni consultar a ML.
    const deNuestraCuenta = String(n.user_id || '') === String(ML_USER_ID);
    const deNuestraApp = !ML_CLIENT_ID || !n.application_id || String(n.application_id) === String(ML_CLIENT_ID);
    if (!deNuestraCuenta || !deNuestraApp) {
      console.warn(`[WEBHOOK] descartado (origen no reconocido): user=${n.user_id || '?'} app=${n.application_id || '?'}`);
      return;
    }
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
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG)
    return res.status(401).json({ error: 'Falta la clave (configurá CLAVE_DIAG en Railway y usá ?clave=...)' });
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
// Decide si un envío va HOY o MAÑANA.
//  - pay_before futuro → MAÑANA.
//  - pay_before de HOY → HOY.
//  - pay_before VIEJO (anterior a hoy) y la venta se liberó HOY (date_handling):
//      · Solo COLECTA: comparo la hora de liberación contra el corte de la última colecta de hoy.
//        liberó antes del corte → HOY; liberó después → MAÑANA.
//      · FLEX: no aplica corte de colecta → HOY.
// corteHoyART: { fecha:'YYYY-MM-DD', corte:'HH:MM' } de la última colecta de hoy (o null).
function cuandoDespacho(s, hoy, corteCol) {
  const pb = s.pay_before ? String(s.pay_before).substring(0, 10) : null;
  if (pb && pb > hoy) return 'manana';        // corte a futuro
  if (pb && pb === hoy) return 'hoy';          // corte de hoy
  // pay_before viejo (anterior a hoy) o sin dato:
  // 1) Si ML informa la fecha real de despacho (estimated_handling_limit) y es futura,
  //    la colecta lo lleva otro día (típico de ventas programadas recién liberadas).
  const lim = s.limite ? String(s.limite).substring(0, 10) : null;
  if (lim && lim > hoy) return 'manana';
  // 2) Colecta liberada hoy después del corte → mañana
  if (s.tipo === 'colecta' && corteCol && corteCol.corte && s.date_handling) {
    const libDia = fechaDeART(s.date_handling);
    if (libDia === hoy) {
      const libHHMM = horaDeART(s.date_handling);   // 'HH:MM' en hora Argentina
      // liberó después del corte de la última colecta → mañana
      if (libHHMM && libHHMM > corteCol.corte) return 'manana';
    }
  }
  return 'hoy';
}

// Fecha 'YYYY-MM-DD' de un timestamp ISO en hora Argentina
function fechaDeART(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); // YYYY-MM-DD
  } catch (_) { return null; }
}
// Hora 'HH:MM' de un timestamp ISO en hora Argentina
function horaDeART(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' }); // HH:MM
  } catch (_) { return null; }
}

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
        .select('shipment_id,nro_venta,sku,titulo,unidades,tipo,status,substatus,limite,pay_before,date_handling,es_nuestro,cancelada,actualizado_at')
        .eq('es_nuestro', true).neq('tipo', 'full')
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      envios = envios.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    const hoy = fechaHoyART();
    // Corte de la última colecta de hoy (cutoff más tarde) para clasificar las de pay_before viejo.
    let corteCol = null;
    try {
      const token0 = await getValidToken(ML_USER_ID);
      if (token0) {
        const cols = await colectasDelDia(token0);
        const cortes = (cols || []).filter(c => c.tanda === 'colecta' && c.cutoff).map(c => c.cutoff).sort();
        if (cortes.length) corteCol = { corte: cortes[cortes.length - 1] };
      }
    } catch (_) {}
    const esFuturo = s => s.limite && String(s.limite) > hoy;
    const imprimible = s => s.status === 'ready_to_ship' &&
      (s.substatus === 'ready_to_print' || s.substatus === 'ready_to_ship' || !s.substatus);

    const etapas = { para_imprimir: [], programados: [], en_preparacion: [],
                     despachadas: [], en_camino: [], entregadas: [], devoluciones: [] };
    const TERMINADOS = ['shipped', 'delivered', 'not_delivered', 'returned', 'cancelled'];
    // Sub-estados que indican que el paquete ya salió del depósito (en la red de ML).
    const EN_RED_ML = new Set(['in_hub', 'in_warehouse', 'on_route', 'in_route',
      'out_for_delivery', 'soon_deliver', 'delivering', 'arrived', 'picked_up', 'dispatched']);

    for (const s of envios) {
      const d = despMap.get(s.shipment_id);
      const fila = {
        shipment_id: s.shipment_id, nro_venta: s.nro_venta, sku: s.sku, titulo: s.titulo,
        unidades: s.unidades || 1, tipo: s.tipo, status: s.status, substatus: s.substatus,
        estado: ESTADO_ES[s.status] || s.status,
        limite: s.limite || null,
        pay_before: s.pay_before || null,
        date_handling: s.date_handling || null,
        // "hoy" o "manana" según corte + hora de liberación (ver cuandoDespacho)
        cuando: cuandoDespacho(s, hoy, corteCol),
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
      else if (EN_RED_ML.has(s.substatus))                  etapas.en_camino.push(fila); // ya salió (en hub / en ruta)
      else if (impSet.has(s.shipment_id))                   etapas.en_preparacion.push(fila);
      else if (imprimible(s))                               etapas.para_imprimir.push(fila);
      else                                                  etapas.programados.push(fila); // futura o "en procesamiento" (todavía no salió)
    }
    for (const k of Object.keys(etapas)) etapas[k].sort(ordenarPorSku);

    // Contadores por tanda de lo que está para imprimir
    const porImprimir = etapas.para_imprimir;

    // Completar en vivo el corte/hora de liberación que falte (envíos viejos sin el dato),
    // así no caen en HOY por defecto. Consultamos ML solo para esos y corregimos la foto.
    const sinPay = porImprimir.filter(s => !s.pay_before || !s.date_handling);
    if (sinPay.length) {
      const tk = await getValidToken(ML_USER_ID);
      if (tk) {
        const auth = { headers: { Authorization: `Bearer ${tk}` } };
        await poolMap(sinPay.slice(0, 100), 6, async (s) => {
          try {
            const r = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`, auth);
            if (!r.ok) return;
            const sh = await r.json();
            const pb = (sh.shipping_option && sh.shipping_option.estimated_delivery_time
                        && sh.shipping_option.estimated_delivery_time.pay_before) || null;
            const dh = (sh.status_history && sh.status_history.date_handling) || null;
            if (pb) s.pay_before = pb;
            if (dh) s.date_handling = dh;
            s.cuando = cuandoDespacho(s, hoy, corteCol);
            if (pb || dh) {
              try { await supabase.from('dep_envios').update({ pay_before: pb || s.pay_before, date_handling: dh || s.date_handling }).eq('shipment_id', s.shipment_id); } catch (_) {}
            }
          } catch (_) {}
        });
      }
    }

    const cont = {
      flex: porImprimir.filter(s => s.tipo === 'flex').length,
      colecta: porImprimir.filter(s => s.tipo === 'colecta').length,
      flex_hoy: porImprimir.filter(s => s.tipo === 'flex' && s.cuando === 'hoy').length,
      colecta_hoy: porImprimir.filter(s => s.tipo === 'colecta' && s.cuando === 'hoy').length,
      flex_manana: porImprimir.filter(s => s.tipo === 'flex' && s.cuando === 'manana').length,
      colecta_manana: porImprimir.filter(s => s.tipo === 'colecta' && s.cuando === 'manana').length
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

// ── DIAG: por qué el badge de Imprimir (Flex+Colecta) no coincide con el ──
// total "para imprimir". Lista las que NO son Flex ni Colecta. ?clave=TU_CLAVE
app.get('/api/despacho/diag-imprimir', async (_req, res) => {
  try {
    const { data: imp } = await supabase.from('dep_impresiones').select('shipment_id');
    const impSet = new Set((imp || []).map(r => r.shipment_id));
    const { data: desp } = await supabase.from('dep_despachos').select('shipment_id');
    const despSet = new Set((desp || []).map(r => r.shipment_id));

    let envios = [], from = 0;
    while (true) {
      const { data, error } = await supabase.from('dep_envios')
        .select('shipment_id,nro_venta,sku,titulo,tipo,status,substatus,limite,es_nuestro,cancelada')
        .eq('es_nuestro', true).neq('tipo', 'full').range(from, from + 999);
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
    const TERM = ['shipped', 'delivered', 'not_delivered', 'returned', 'cancelled'];

    const paraImprimir = [];
    for (const s of envios) {
      if (s.cancelada || s.status === 'cancelled') continue;
      if (TERM.includes(s.status)) continue;
      if (despSet.has(s.shipment_id)) continue;   // despachada
      if (impSet.has(s.shipment_id)) continue;     // en preparación (ya impresa)
      if (!imprimible(s) && esFuturo(s)) continue; // programada
      if (!imprimible(s)) continue;                // en proceso, no imprimible
      paraImprimir.push(s);
    }
    const porTipo = {};
    for (const s of paraImprimir) { const t = s.tipo || '(sin tipo)'; porTipo[t] = (porTipo[t] || 0) + 1; }
    const otros = paraImprimir
      .filter(s => s.tipo !== 'flex' && s.tipo !== 'colecta')
      .map(s => ({ nro_venta: s.nro_venta, sku: s.sku, titulo: s.titulo,
                   tipo: s.tipo || '(sin tipo)', status: s.status, substatus: s.substatus }));

    res.json({
      total_para_imprimir_foto: paraImprimir.length,
      flex: porTipo.flex || 0,
      colecta: porTipo.colecta || 0,
      otros_cant: otros.length,
      badge_imprimir_seria: (porTipo.flex || 0) + (porTipo.colecta || 0),
      por_tipo: porTipo,
      otros
    });
  } catch (e) { console.error('[DIAG-IMPRIMIR]', e.message); res.status(500).json({ error: e.message }); }
});
app.get('/api/despacho/separables', async (_req, res) => {
  try {
    const { data: imp } = await supabase.from('dep_impresiones').select('shipment_id');
    const impSet = new Set((imp || []).map(r => r.shipment_id));
    const { data: desp } = await supabase.from('dep_despachos').select('shipment_id');
    const despSet = new Set((desp || []).map(r => r.shipment_id));

    // Traemos TODA la colecta lista (sin filtrar por unidades): así cazamos también
    // las ventas multi-producto que quedaron mal contadas en la foto (unidades=1).
    let envios = [], from = 0;
    while (true) {
      const { data, error } = await supabase.from('dep_envios')
        .select('shipment_id,nro_venta,sku,titulo,unidades,tipo,status,substatus,cancelada')
        .eq('es_nuestro', true).eq('tipo', 'colecta')
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      envios = envios.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    const TERMINADOS = ['shipped', 'delivered', 'not_delivered', 'returned', 'cancelled'];
    const EN_RED_ML = new Set(['in_hub', 'in_warehouse', 'on_route', 'in_route',
      'out_for_delivery', 'soon_deliver', 'delivering', 'arrived', 'picked_up', 'dispatched']);

    // Candidatos: colecta lista, no cancelada, no terminada, no ya escaneada
    let candidatos = [];
    for (const s of envios) {
      if (s.cancelada || TERMINADOS.includes(s.status) || EN_RED_ML.has(s.substatus)) continue;
      if (despSet.has(s.shipment_id)) continue;
      candidatos.push(s);
    }
    // Tope de seguridad: si hubiera muchísimas, verificamos primero las que la foto ya marca 2+
    const TOPE = 160;
    if (candidatos.length > TOPE) {
      candidatos.sort((a, b) => (b.unidades || 0) - (a.unidades || 0));
      candidatos = candidatos.slice(0, TOPE);
    }

    // Verificamos en vivo cada envío: estado real + unidades reales (todos los productos del pack).
    // Si ya salió → se saca; si tiene 2+ cosas → entra; y de paso corregimos la foto.
    const token = await getValidToken(ML_USER_ID);
    let buenos = [];
    if (token && candidatos.length) {
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const verif = await poolMap(candidatos, 6, async (s) => {
        try {
          const r = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`, auth);
          if (!r.ok) return null;
          const sh = await r.json();
          const yaFue = TERMINADOS.includes(sh.status) || EN_RED_ML.has(sh.substatus);
          const units = (sh.shipping_items || []).reduce((a, it) => a + (it.quantity || 0), 0) || (s.unidades || 1);
          const nItems = (sh.shipping_items || []).length || 1;
          // Autocorregir la foto (estado + unidades reales)
          try { await supabase.from('dep_envios').update({ status: sh.status, substatus: sh.substatus || null, unidades: units }).eq('shipment_id', s.shipment_id); } catch (_) {}
          if (yaFue) return null;                 // ya salió
          if (units < 2 && nItems < 2) return null; // ni multi-unidad ni multi-producto
          // Títulos + cantidades de los productos del envío (ML siempre los da)
          const shipItems = (sh.shipping_items || []).map(it => ({
            title: (it.description || '').trim(), quantity: it.quantity || 1
          }));
          const titulos = shipItems.map(it => it.title).filter(Boolean);
          // Juntamos SKU + título desde las órdenes (para emparejar el SKU por título)
          const prodInfo = [];   // [{sku, title}]
          let skus = [];
          let packId = null;
          const addFromOrder = (order) => {
            for (const it of (order.order_items || [])) {
              const sk = (it.item && (it.item.seller_sku || it.item.seller_custom_field)) || '';
              const ti = (it.item && it.item.title) || '';
              if (sk) { skus.push(String(sk).trim()); prodInfo.push({ sku: String(sk).trim(), title: ti.trim() }); }
            }
          };
          try {
            const ro = await fetch(`https://api.mercadolibre.com/orders/${s.nro_venta}?access_token=${token}`);
            const order = await ro.json();
            packId = order && order.pack_id ? String(order.pack_id) : null;
            addFromOrder(order);
          } catch (_) {}
          // Si faltan SKUs (pack repartido en varias órdenes), los buscamos por el pack
          if (prodInfo.length < nItems && packId) {
            try {
              const rp = await fetch(`https://api.mercadolibre.com/packs/${packId}?access_token=${token}`);
              if (rp.ok) {
                const pack = await rp.json();
                const oids = (pack.orders || []).map(o => o.id).filter(Boolean);
                for (const oid of oids) {
                  try {
                    const r2 = await fetch(`https://api.mercadolibre.com/orders/${oid}?access_token=${token}`);
                    addFromOrder(await r2.json());
                  } catch (_) {}
                }
              }
            } catch (_) {}
          }
          if (!skus.length) skus = [s.sku].filter(Boolean);
          skus = [...new Set(skus.filter(Boolean))];
          // Detalle final: por cada producto del envío (título+cantidad), le pegamos el SKU si lo encontramos por título
          const norm = t => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const items = shipItems.map(si => {
            const m = prodInfo.find(p => norm(p.title) === norm(si.title))
                   || prodInfo.find(p => p.title && si.title && (norm(p.title).includes(norm(si.title)) || norm(si.title).includes(norm(p.title))));
            return { sku: m ? m.sku : (shipItems.length === 1 && skus.length === 1 ? skus[0] : ''), title: si.title, quantity: si.quantity };
          });
          return { ...s, unidades: units, _nitems: nItems, _skus: skus, _titulos: titulos, _items: items, _st: sh.status, _sub: sh.substatus || '' };
        } catch (_) { return null; }
      });
      buenos = verif.filter(Boolean);
    } else {
      // Sin token: caemos a lo que la foto marque como 2+
      buenos = candidatos.filter(s => (s.unidades || 1) >= 2);
    }

    const lista = buenos.map(s => ({
      shipment_id: s.shipment_id, nro_venta: s.nro_venta,
      sku: s.sku, skus: (s._skus && s._skus.length ? s._skus : [s.sku].filter(Boolean)),
      titulos: s._titulos || [], titulo: s.titulo, items: s._items || [],
      unidades: s.unidades || 2, productos: s._nitems || 1, impresa: impSet.has(s.shipment_id),
      estado: s._st || s.status || '', sub: (s._sub != null ? s._sub : s.substatus) || ''
    }));
    lista.sort(ordenarPorSku);
    res.json({ cantidad: lista.length, separables: lista });
  } catch (e) { console.error('[SEPARABLES]', e.message); res.status(500).json({ error: e.message }); }
});

// Dispara el split en ML: separa 1 unidad en su propia caja (2 uds → 1 + 1).
// Helper: dispara el split de un envío en ML. Devuelve el reparto o tira error.
async function mlSepararEnvio(token, shipmentId, nroVenta, unidades) {
  // ML solo deja separar en 2 cajas por vez: 1 unidad va sola, el resto en la otra caja.
  const body = {
    reason: 'OTHER_MOTIVE',
    packs: [
      { orders: [{ id: String(nroVenta), quantity: 1 }] },
      { orders: [{ id: String(nroVenta), quantity: unidades - 1 }] }
    ]
  };
  const r = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/split`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-format-new': 'true' },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error('[SEPARAR] ML', r.status, txt);
    throw new Error(`ML respondió ${r.status}: ${(txt || '').substring(0, 200)}`);
  }
  // Marcar el envío original como separado en la foto local, así desaparece de
  // la lista al instante sin esperar el webhook de ML (ML cancela el original).
  try { await supabase.from('dep_envios').update({ cancelada: true }).eq('shipment_id', String(shipmentId)); }
  catch (e) { console.error('[SEPARAR] no se pudo marcar la foto:', e.message); }
  return unidades === 2 ? '1 + 1' : `1 + ${unidades - 1}`;
}

app.post('/api/despacho/separar', async (req, res) => {
  try {
    const shipmentId = (req.body && req.body.shipment_id) || null;
    const nroVenta = (req.body && req.body.nro_venta) || null;
    const unidades = parseInt((req.body && req.body.unidades) || 0, 10);
    if (!shipmentId || !nroVenta) return res.status(400).json({ error: 'Faltan datos del envío' });
    if (!unidades || unidades < 2) return res.status(400).json({ error: 'La venta no tiene 2 o más unidades' });
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML');
    const separado = await mlSepararEnvio(token, shipmentId, nroVenta, unidades);
    console.log(`[SEPARAR] OK ship=${shipmentId} venta=${nroVenta} (${separado})`);
    res.json({ ok: true, separado_en: separado });
  } catch (e) { console.error('[SEPARAR]', e.message); res.status(400).json({ error: e.message }); }
});

// Separar varias ventas de una vez (una por una, con pausa para no saturar ML).
app.post('/api/despacho/separar-lote', async (req, res) => {
  try {
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No mandaste ventas para separar' });
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML');
    let ok = 0; const errores = [];
    for (const it of items) {
      const u = parseInt(it.unidades || 0, 10);
      if (!it.shipment_id || !it.nro_venta || u < 2) { errores.push({ nro_venta: it.nro_venta || '?', error: 'datos inválidos' }); continue; }
      try { await mlSepararEnvio(token, it.shipment_id, it.nro_venta, u); ok++; }
      catch (e) { errores.push({ nro_venta: it.nro_venta, error: e.message }); }
      await sleep(300);
    }
    console.log(`[SEPARAR-LOTE] ${ok} ok, ${errores.length} con error`);
    res.json({ ok_count: ok, error_count: errores.length, errores });
  } catch (e) { console.error('[SEPARAR-LOTE]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoints: impresión ──────────────────────────────────────────
// ── Depósitos de origen: qué está entrando y qué queda afuera ─────
app.get('/api/despacho/depositos', async (_req, res) => {
  try {
    if (!_depositosStats) {
      const token = await getValidToken(ML_USER_ID);
      if (token) await obtenerDetalladosConCache(token); // fuerza una pasada si nunca corrió
    }
    res.json(_depositosStats || { filtro: DEPOSITO_FILTRO || '(desactivado: entra todo)', depositos: [], actualizado: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Depósitos vinculados: pescar de ML, poner alias y elegir principal ──
app.get('/api/despacho/depositos-ml', async (req, res) => {
  try {
    if (String(req.query.traer || '') === '1') {
      const token = await getValidToken(ML_USER_ID);
      if (!token) throw new Error('No hay token de ML');
      let filas = []; let origen = 'ml';
      // Intento 1: la libreta de direcciones de ML (puede estar bloqueada por políticas de privacidad)
      try {
        const r = await fetch(`https://api.mercadolibre.com/users/${ML_USER_ID}/addresses?access_token=${token}`);
        const dirs = await r.json();
        if (Array.isArray(dirs)) {
          filas = dirs.map(d => ({
            ml_address_id: String(d.id),
            direccion: [d.address_line, d.city && d.city.name].filter(Boolean).join(' '),
            ciudad: (d.city && d.city.name) || null,
            actualizado_at: new Date().toISOString()
          }));
        } else {
          console.warn('[DEPOSITOS-ML] /addresses bloqueado por ML:', JSON.stringify(dirs).slice(0, 160));
        }
      } catch (e) { console.warn('[DEPOSITOS-ML] /addresses:', e.message); }
      // Intento 2 (plan B): cosechar los depósitos de los envíos reales ya recorridos
      if (!filas.length) {
        origen = 'envios';
        const detallados = await obtenerDetalladosConCache(token);
        const m = new Map();
        for (const s of detallados) {
          if (s.dep_id && !m.has(String(s.dep_id))) m.set(String(s.dep_id), s.dep_dir || null);
        }
        filas = [...m.entries()].map(([id, dir]) => ({
          ml_address_id: id, direccion: dir, ciudad: null, actualizado_at: new Date().toISOString()
        }));
        if (!filas.length) throw new Error('ML bloqueó la consulta de direcciones y todavía no hay envíos en el caché para cosechar. Tocá "Actualizar ahora" en Imprimir, esperá que termine, y probá de nuevo.');
      }
      // upsert con merge: actualiza dirección SIN pisar alias ni es_principal
      const { error } = await supabase.from('dep_depositos').upsert(filas, { onConflict: 'ml_address_id' });
      if (error) throw new Error(error.message);
      await cargarDepositosCfg();
      req._origenPesca = origen;
    }
    const { data, error } = await supabase.from('dep_depositos')
      .select('ml_address_id,direccion,ciudad,alias,es_principal').order('es_principal', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ depositos: data || [], origen: req._origenPesca || null, filtro_texto_activo: !_depCfg.principalId ? (DEPOSITO_FILTRO || null) : null });
  } catch (e) { console.error('[DEPOSITOS-ML]', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/despacho/depositos-ml/alias', async (req, res) => {
  try {
    const id = String((req.body && req.body.ml_address_id) || '').trim();
    const alias = String((req.body && req.body.alias) || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta el ID del depósito' });
    const { error } = await supabase.from('dep_depositos').update({ alias: alias || null }).eq('ml_address_id', id);
    if (error) throw new Error(error.message);
    await cargarDepositosCfg();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/despacho/depositos-ml/principal', async (req, res) => {
  try {
    const id = String((req.body && req.body.ml_address_id) || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta el ID del depósito' });
    const { error: e1 } = await supabase.from('dep_depositos').update({ es_principal: false }).neq('ml_address_id', '~');
    if (e1) throw new Error(e1.message);
    const { error: e2 } = await supabase.from('dep_depositos').update({ es_principal: true }).eq('ml_address_id', id);
    if (e2) throw new Error(e2.message);
    await cargarDepositosCfg();
    invalidarCacheEnvios();
    res.json({ ok: true, principal: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/despacho/pendientes', async (req, res) => {
  try {
    const tipo = (req.query.tipo || '').toLowerCase();
    const deposito = (req.query.deposito || '').trim() || null;
    const { listos, programados, no_listos } = await obtenerEnvios(tipo, deposito);
    res.json({
      tipo, deposito, cantidad: listos.length,
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
    const deposito = (req.query.deposito || '').trim() || null;
    const { listos, token } = await obtenerEnvios(tipo, deposito);
    if (!listos.length) return res.status(404).json({ error: 'No hay envíos listos para imprimir en esta tanda' });
    const { bytes, impresos, fallidas, motivos } = await armarPdf(listos, token);
    if (!impresos.length) return res.status(404).json({ error: explicarFalloEtiquetas(motivos) });
    await registrarImpresion(impresos, tipo);
    console.log(`[ETIQUETAS] tipo=${tipo} unidas=${impresos.length} fallidas=${fallidas}`);
    pdfResponse(res, bytes, impresos.length, fallidas, `etiquetas_${tipo}_${fechaHoyART()}.pdf`, fallidas ? resumirMotivos(motivos) : null);
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
    const { bytes, impresos, fallidas, motivos } = await armarPdf(lista, token);
    if (!impresos.length) return res.status(404).json({ error: explicarFalloEtiquetas(motivos) });

    // Registrar impresión agrupando por tanda
    const porTipo = {};
    for (const s of impresos) { (porTipo[s.tipo || 'flex'] = porTipo[s.tipo || 'flex'] || []).push(s); }
    for (const [tipo, arr] of Object.entries(porTipo)) await registrarImpresion(arr, tipo);

    console.log(`[ETIQUETAS-SEL] pedidas=${lista.length} unidas=${impresos.length} fallidas=${fallidas}`);
    pdfResponse(res, bytes, impresos.length, fallidas, `etiquetas_seleccion_${fechaHoyART()}.pdf`, fallidas ? resumirMotivos(motivos) : null);
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
    const { bytes, impresos, fallidas, motivos } = await armarPdf(lista, token);
    if (!impresos.length) return res.status(404).json({ error: explicarFalloEtiquetas(motivos) });
    console.log(`[REIMPRIMIR] pedidas=${lista.length} unidas=${impresos.length} fallidas=${fallidas}`);
    const nombre = ventaParam ? `reimpresion_venta_${ventaParam}.pdf` : `reimpresion_${fechaHoyART()}.pdf`;
    pdfResponse(res, bytes, impresos.length, fallidas, nombre, fallidas ? resumirMotivos(motivos) : null);
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

// ── DIAGNÓSTICO: ¿la llave de servicio está bien? (no muestra la llave) ──
// /api/despacho/diag-key?clave=TU_CLAVE
app.get('/api/despacho/diag-key', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG) return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
  const k = process.env.SUPABASE_SERVICE_KEY || '';
  // Detectar rol de la llave (las keys de Supabase son JWT: header.payload.firma)
  let rol = 'desconocido';
  try {
    const payload = JSON.parse(Buffer.from(k.split('.')[1] || '', 'base64').toString('utf8'));
    rol = payload.role || 'sin-rol';
  } catch (_) { rol = 'no-es-jwt'; }
  // Probar una escritura real en la tabla con RLS
  let escritura = 'no probada';
  try {
    const { error } = await supabase.from('dep_codigo_autorizacion')
      .upsert({ fecha: '1999-01-01', codigo: 'TEST', cargado_at: new Date().toISOString() }, { onConflict: 'fecha' });
    escritura = error ? ('ERROR: ' + error.message) : 'OK ✅ (puede escribir)';
    // limpiar el test
    if (!error) await supabase.from('dep_codigo_autorizacion').delete().eq('fecha', '1999-01-01');
  } catch (e) { escritura = 'ERROR: ' + e.message; }
  res.json({
    largo_llave: k.length,
    tiene_salto_de_linea: /\s/.test(k.trim()) || k !== k.trim(),
    rol_detectado: rol,            // debería ser "service_role"
    prueba_de_escritura: escritura
  });
});

// ── DIAGNÓSTICO: encontrar las canceladas que se cuelan en "a despachar" ──
// /api/despacho/diag-colcancel?clave=TU_CLAVE   (revisa colecta del día y marca canceladas reales)
app.get('/api/despacho/diag-colcancel', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG) return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const TERMINADOS = ['shipped', 'delivered', 'not_delivered', 'returned', 'cancelled'];
    const EN_RED = new Set(['in_hub', 'in_warehouse', 'on_route', 'in_route', 'out_for_delivery', 'soon_deliver', 'delivering', 'arrived', 'picked_up', 'dispatched']);
    const hoy = fechaHoyART();
    let foto = [], from = 0;
    while (true) {
      const { data } = await supabase.from('dep_envios')
        .select('shipment_id,nro_venta,sku,tipo,status,substatus,pay_before,cancelada')
        .eq('es_nuestro', true).eq('tipo', (req.query.tipo || 'colecta'))
        .range(from, from + 999);
      if (!data || !data.length) break; foto = foto.concat(data);
      if (data.length < 1000) break; from += 1000;
    }
    const cand = foto.filter(s => {
      if (s.cancelada || TERMINADOS.includes(s.status) || EN_RED.has(s.substatus)) return false;
      const pb = s.pay_before ? String(s.pay_before).substring(0, 10) : null;
      if (pb && pb > hoy) return false;
      return true;
    });
    const problemas = [];
    await poolMap(cand.slice(0, 200), 6, async (s) => {
      try {
        const ro = await fetch(`https://api.mercadolibre.com/orders/${s.nro_venta}?access_token=${token}`);
        const o = await ro.json();
        const rs = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`, auth);
        const sh = await rs.json();
        const ordenCancel = o.status === 'cancelled';
        const envioFuera = TERMINADOS.includes(sh.status) || EN_RED.has(sh.substatus);
        if (ordenCancel || envioFuera) {
          problemas.push({ nro_venta: s.nro_venta, sku: s.sku, order_status: o.status, ship_status: sh.status, ship_substatus: sh.substatus });
        }
      } catch (_) {}
    });
    res.json({ candidatas: cand.length, se_cuelan: problemas.length, problemas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DIAGNÓSTICO: ¿cómo viene una venta cancelada? (orden vs envío) ──
// /api/despacho/diag-cancel?clave=TU_CLAVE&venta=NRO
app.get('/api/despacho/diag-cancel', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG) return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const venta = (req.query.venta || '').trim();
    if (!venta) throw new Error('Pasá ?venta=NRO');
    const out = { venta };
    // Orden
    try {
      const ro = await fetch(`https://api.mercadolibre.com/orders/${venta}?access_token=${token}`);
      const o = await ro.json();
      out.order = { status: o.status, status_detail: o.status_detail, cancel_detail: o.cancel_detail, shipping_id: o.shipping && o.shipping.id };
      const shipId = o.shipping && o.shipping.id;
      if (shipId) {
        const rs = await fetch(`https://api.mercadolibre.com/shipments/${shipId}`, auth);
        const sh = await rs.json();
        out.shipment = { id: shipId, status: sh.status, substatus: sh.substatus };
      }
    } catch (e) { out.err = e.message; }
    // Lo que tenemos guardado en la foto
    try {
      const { data } = await supabase.from('dep_envios').select('shipment_id,nro_venta,tipo,status,substatus,cancelada,pay_before').eq('nro_venta', venta).limit(2);
      out.foto = data;
    } catch (_) {}
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Refresco AUTOMÁTICO de la colecta del día (no hace falta tocar ningún botón) ──
// Hora Argentina: 00:30, 08:00 y cada hora de 06 a 13. Mantiene los datos frescos
// en el servidor; cuando entrás a Despachar ya están listos al instante.
function horaART() {
  const art = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return { h: art.getHours(), m: art.getMinutes(), dia: art.toDateString() };
}
let _ultRefrescoColecta = '';
setInterval(async () => {
  try {
    const { h, m, dia } = horaART();
    const enVentana =
      (h === 0 && m >= 30 && m < 40) ||   // 00:30
      (h === 8 && m < 10) ||              // 08:00
      (h >= 6 && h <= 13 && m < 10);      // cada hora de 06 a 13
    if (!enVentana) return;
    const clave = `${dia}-${h}`;
    if (_ultRefrescoColecta === clave) return;  // ya se refrescó en esta hora
    _ultRefrescoColecta = clave;
    const token = await getValidToken(ML_USER_ID);
    if (!token) return;
    _colectasCache = { at: 0, colectas: [] };   // invalidar y volver a pedir a ML
    const cols = await colectasDelDia(token);
    console.log(`[COLECTAS] refresco automático ${h}:00 ART · ${cols.filter(c => c.tanda === 'colecta').length} colecta(s)`);
  } catch (e) { console.error('[COLECTAS-CRON]', e.message); }
}, 5 * 60 * 1000);  // revisa cada 5 minutos si toca refrescar

// ── DIAGNÓSTICO: ¿qué SKUs trae una venta/pack? ──
// /api/despacho/diag-skus?clave=TU_CLAVE&venta=NRO   (o &ship=ID)
app.get('/api/despacho/diag-skus', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG) return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    let venta = (req.query.venta || '').trim();
    const ship = (req.query.ship || '').trim();
    let shipJson = null;
    if (ship) {
      const rs = await fetch(`https://api.mercadolibre.com/shipments/${ship}`, auth);
      shipJson = await rs.json();
      venta = venta || shipJson.order_id || (Array.isArray(shipJson.order_ids) && shipJson.order_ids[0]);
    }
    const out = { venta, ship };
    if (venta) {
      const ro = await fetch(`https://api.mercadolibre.com/orders/${venta}?access_token=${token}`);
      const order = await ro.json();
      out.order_status = order.status;
      out.order_items = (order.order_items || []).map(it => ({
        seller_sku: it.item && it.item.seller_sku,
        seller_custom_field: it.item && it.item.seller_custom_field,
        title: it.item && it.item.title,
        quantity: it.quantity
      }));
    }
    if (shipJson) out.shipping_items = (shipJson.shipping_items || []).map(it => ({ description: it.description, quantity: it.quantity }));

    // Buscar el envío de esa venta y, vía el envío, TODAS las órdenes del pack con sus SKU
    if (venta && !ship) {
      try {
        const ro2 = await fetch(`https://api.mercadolibre.com/orders/${venta}?access_token=${token}`);
        const ord2 = await ro2.json();
        const shipId = ord2.shipping && ord2.shipping.id;
        const packId = ord2.pack_id;
        out.pack_id = packId || null;
        out.shipment_id_de_la_venta = shipId || null;
        if (shipId) {
          const rs2 = await fetch(`https://api.mercadolibre.com/shipments/${shipId}?access_token=${token}`);
          const sh2 = await rs2.json();
          out.shipment_items = (sh2.shipping_items || []).map(it => ({ description: it.description, quantity: it.quantity }));
          // El shipment referencia todas las órdenes del pack
          const oids = sh2.order_ids && sh2.order_ids.length ? sh2.order_ids
                     : (sh2.order_id ? [sh2.order_id] : (venta ? [venta] : []));
          out.order_ids_del_envio = oids;
          const skusPack = [];
          for (const oid of oids) {
            try {
              const r = await fetch(`https://api.mercadolibre.com/orders/${oid}?access_token=${token}`);
              const o = await r.json();
              for (const it of (o.order_items || [])) {
                skusPack.push({ venta: String(oid), sku: it.item && it.item.seller_sku, title: it.item && it.item.title, quantity: it.quantity });
              }
            } catch (_) {}
          }
          out.skus_del_pack = skusPack;
        }
      } catch (e) { out.pack_error = e.message; }
    }
    res.json(out);
  } catch (e) { console.error('[DIAG-SKUS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── DIAGNÓSTICO: ¿qué campo trae la fecha de "Despachar: <día>"? ──
// /api/despacho/diag-fechadesp?clave=TU_CLAVE  (opcional &ship=ID)
app.get('/api/despacho/diag-fechadesp', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG) return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    let shipId = (req.query.ship || '').trim();
    const venta = (req.query.venta || '').trim();
    if (!shipId && venta) {
      const ro = await fetch(`https://api.mercadolibre.com/orders/${venta}?access_token=${token}`);
      const ord = await ro.json();
      shipId = ord.shipping && ord.shipping.id ? String(ord.shipping.id) : '';
    }
    if (!shipId) {
      const { data } = await supabase.from('dep_envios')
        .select('shipment_id,status').eq('es_nuestro', true).eq('tipo', 'colecta')
        .eq('status', 'ready_to_ship').limit(1);
      shipId = data && data[0] ? data[0].shipment_id : '';
    }
    if (!shipId) throw new Error('No encontré un envío para mirar');
    const r = await fetch(`https://api.mercadolibre.com/shipments/${shipId}`, auth);
    const sh = await r.json();
    const so = sh.shipping_option || {};
    res.json({
      shipment_id: shipId,
      status: sh.status, substatus: sh.substatus,
      date_created: sh.date_created,
      date_first_printed: sh.date_first_printed,
      shipping_option_fechas: {
        estimated_handling_limit: so.estimated_handling_limit,
        estimated_delivery_limit: so.estimated_delivery_limit,
        estimated_delivery_time: so.estimated_delivery_time,
        pickup_promise: so.pickup_promise,
        buffering: so.buffering
      },
      status_history: sh.status_history
    });
  } catch (e) { console.error('[DIAG-FECHADESP]', e.message); res.status(500).json({ error: e.message }); }
});

// /api/despacho/diag-camion?clave=TU_CLAVE  (opcional &ship=SHIPMENT_ID)
app.get('/api/despacho/diag-camion', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG)
    return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const probar = async (url) => {
      try {
        const r = await fetch(url, auth);
        let b; try { b = await r.json(); } catch { b = await r.text(); }
        const s = JSON.stringify(b);
        return { url, status: r.status, body: (s && s.length > 6000) ? { recortado: true, muestra: s.slice(0, 5500) } : b };
      } catch (e) { return { url, error: e.message }; }
    };
    // Tomamos un envío de colecta real (listo, no despachado) para inspeccionarlo
    let shipId = (req.query.ship || '').trim();
    if (!shipId) {
      const { data } = await supabase.from('dep_envios')
        .select('shipment_id,status').eq('es_nuestro', true).eq('tipo', 'colecta')
        .in('status', ['ready_to_ship', 'handling']).limit(1);
      shipId = data && data[0] ? data[0].shipment_id : '';
    }
    const U = ML_USER_ID;
    const urls = [];
    if (shipId) {
      urls.push(`https://api.mercadolibre.com/shipments/${shipId}`);
      urls.push(`https://api.mercadolibre.com/shipments/${shipId}/carrier`);
      urls.push(`https://api.mercadolibre.com/shipments/${shipId}/lead_time`);
    }
    urls.push(`https://api.mercadolibre.com/users/${U}/shipping/schedule/cross_docking?node_id=ARXRO1`);
    urls.push(`https://api.mercadolibre.com/shipping/carrier_pickup/17500940`);
    urls.push(`https://api.mercadolibre.com/users/${U}/pickups`);
    urls.push(`https://api.mercadolibre.com/shipping/pickups/search?seller_id=${U}`);
    const resultados = [];
    for (const u of urls) { resultados.push(await probar(u)); await sleep(150); }
    res.json({ shipment_muestra: shipId, resultados });
  } catch (e) { console.error('[DIAG-CAMION]', e.message); res.status(500).json({ error: e.message }); }
});

// ── DIAGNÓSTICO de COLECTAS: prueba varias URLs de ML y muestra cuál responde ──
// /api/despacho/diag-colectas?clave=TU_CLAVE
app.get('/api/despacho/diag-colectas', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG)
    return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
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

// ── DIAGNÓSTICO: ¿multi-origen? ¿qué nodo trae el transportista/patente? ──
// /api/despacho/diag-nodo  (app logueada)  ó  ?clave=TU_CLAVE (navegador)
app.get('/api/despacho/diag-nodo', async (_req, res) => {
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const dia = diaSemanaHoyART();

    // 1) ¿la cuenta es multi-origen? (tag warehouse_management en /users)
    let tags = [], multiOrigen = false;
    try {
      const u = await (await fetch(`https://api.mercadolibre.com/users/${ML_USER_ID}`, auth)).json();
      tags = u.tags || [];
      multiOrigen = tags.includes('warehouse_management');
    } catch (e) { /* sigue */ }

    // 2) depósitos/nodos del vendedor
    let nodos = [];
    try {
      const r = await fetch(`https://api.mercadolibre.com/users/${ML_USER_ID}/stores/search?tags=stock_location`, auth);
      const s = await r.json();
      nodos = (s.results || []).map(x => ({
        store_id: x.id != null ? String(x.id) : '',
        network_node_id: x.network_node_id != null ? String(x.network_node_id) : '',
        descripcion: x.description || '',
        direccion: x.location ? `${x.location.address_line || ''} ${x.location.city || ''}`.trim() : ''
      }));
    } catch (e) { /* sigue */ }

    // 3) probar el schedule por cada id candidato (usuario + nodo + store) y extraer HOY
    const candidatos = [{ etiqueta: 'user_id', id: String(ML_USER_ID) }];
    for (const n of nodos) {
      if (n.network_node_id) candidatos.push({ etiqueta: 'node · ' + (n.descripcion || n.network_node_id), id: n.network_node_id });
      if (n.store_id)        candidatos.push({ etiqueta: 'store · ' + (n.descripcion || n.store_id), id: n.store_id });
    }
    const probados = [];
    for (const c of candidatos) {
      try {
        const r = await fetch(`https://api.mercadolibre.com/users/${c.id}/shipping/schedule/cross_docking`, auth);
        let data = {}; try { data = await r.json(); } catch (_) {}
        const hoy = data && data.schedule && data.schedule[dia];
        const detalle = (hoy && Array.isArray(hoy.detail)) ? hoy.detail.map(d => ({
          from: d.from || '', to: d.to || '', cutoff: d.cutoff || '',
          carrier: (d.carrier && d.carrier.name) || '',
          patente: (d.vehicle && d.vehicle.license_plate) || '',
          vehiculo: (d.vehicle && d.vehicle.vehicle_type) || '',
          chofer: (d.driver && d.driver.name) || ''
        })) : [];
        probados.push({ ...c, status: r.status, ventanas_hoy: detalle.length, detalle });
      } catch (e) { probados.push({ ...c, error: e.message }); }
      await sleep(150);
    }

    res.json({ dia, multi_origen: multiOrigen, tags, nodos, probados });
  } catch (e) { console.error('[DIAG-NODO]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoint: buscar una venta por número (estado en ML + lo nuestro) ──
app.get('/api/despacho/buscar', async (req, res) => {
  try {
    const venta = (req.query.venta || '').trim().replace(/\s+/g, '');
    if (!venta) return res.status(400).json({ error: 'Indicá el número de venta' });
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    // El código puede ser nro de venta, shipment_id (del QR) o pack. Lo resolvemos a la orden.
    let ventaId = venta;
    let ro = await fetch(`https://api.mercadolibre.com/orders/${ventaId}?access_token=${token}`);
    let order = await ro.json();
    if (order.error || !order.id) {
      // ¿Está en la foto como shipment_id / nro_venta?
      try {
        const { data } = await supabase.from('dep_envios')
          .select('nro_venta,shipment_id').or(`shipment_id.eq.${venta},nro_venta.eq.${venta}`).limit(1);
        if (data && data[0] && data[0].nro_venta && data[0].nro_venta !== venta) {
          ventaId = data[0].nro_venta;
          order = await (await fetch(`https://api.mercadolibre.com/orders/${ventaId}?access_token=${token}`)).json();
        }
      } catch (_) {}
    }
    if (order.error || !order.id) {
      // ¿Es un shipment_id? Lo resolvemos a su orden vía ML.
      try {
        const rs = await fetch(`https://api.mercadolibre.com/shipments/${venta}`, { headers: { Authorization: `Bearer ${token}` } });
        if (rs.ok) {
          const sh = await rs.json();
          const oid = sh.order_id || (Array.isArray(sh.order_ids) && sh.order_ids[0]);
          if (oid) { ventaId = String(oid); order = await (await fetch(`https://api.mercadolibre.com/orders/${ventaId}?access_token=${token}`)).json(); }
        }
      } catch (_) {}
    }
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

    // ¿Quién lo escaneó/despachó desde el sistema?
    let escaneado_por = null, escaneado_at = null, destino_escaneo = null;
    if (shipId) {
      const { data } = await supabase.from('dep_despachos')
        .select('usuario,despachado_at,destino_nombre').eq('shipment_id', String(shipId))
        .order('despachado_at', { ascending: false }).limit(1);
      if (data && data[0]) {
        escaneado_por = data[0].usuario || null;
        escaneado_at = data[0].despachado_at || null;
        destino_escaneo = data[0].destino_nombre || null;
      }
    }

    res.json({
      nro_venta: String(order.id),
      shipment_id: shipId ? String(shipId) : null,
      sku, titulo, comprador,
      fecha: order.date_created || null,
      estado, estado_codigo: estadoCodigo, substatus,
      despachado: ['shipped', 'delivered'].includes(estadoCodigo),
      entregado: estadoCodigo === 'delivered',
      impreso, impreso_at,
      escaneado_por, escaneado_at, destino_escaneo
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
// Bajar un paquete de la colecta/destino: borra su registro de despacho.
app.post('/api/despacho/bajar', async (req, res) => {
  try {
    const codigo = ((req.body && req.body.codigo) || '').trim();
    if (!codigo) return res.status(400).json({ error: 'Falta el código escaneado' });
    let ids = [];
    try { const j = JSON.parse(codigo); if (j && j.id) ids.push(String(j.id)); } catch (_) {}
    ids = ids.concat(extraerNumeros(codigo)).filter(Boolean).map(String);
    ids = [...new Set(ids)];
    if (!ids.length) return res.status(400).json({ error: 'No pude leer el código' });
    const lista = ids.join(',');
    const { data: encontrados, error: e1 } = await supabase.from('dep_despachos')
      .select('shipment_id,nro_venta,sku,titulo,destino_nombre')
      .or(`shipment_id.in.(${lista}),nro_venta.in.(${lista})`)
      .order('despachado_at', { ascending: false }).limit(1);
    if (e1) throw new Error(e1.message);
    if (!encontrados || !encontrados.length)
      return res.json({ resultado: 'no_estaba' });
    const ship = encontrados[0];
    const { error: e2 } = await supabase.from('dep_despachos').delete().eq('shipment_id', ship.shipment_id);
    if (e2) throw new Error(e2.message);
    console.log(`[BAJAR] saqué ${ship.shipment_id} (venta ${ship.nro_venta}) de ${ship.destino_nombre || '?'}`);
    res.json({ resultado: 'bajado', shipment_id: ship.shipment_id, nro_venta: ship.nro_venta,
      sku: ship.sku, titulo: ship.titulo, destino_nombre: ship.destino_nombre });
  } catch (e) { console.error('[BAJAR]', e.message); res.status(500).json({ error: e.message }); }
});

// Historial de despachos: por fecha (agrupado por destino) o búsqueda por venta.
app.get('/api/despacho/historial', async (req, res) => {
  try {
    const venta = (req.query.venta || '').trim();
    const cols = 'nro_venta,shipment_id,sku,titulo,tipo,destino_id,destino_nombre,colecta_patente,transportista,despachado_at,usuario';

    // Completa cada fila con el camión/patente que se asignó al destino al abrirlo.
    async function enriquecer(rows) {
      const ids = [...new Set(rows.map(r => r.destino_id).filter(Boolean))];
      const m = {};
      if (ids.length) {
        const { data } = await supabase.from('dep_destinos')
          .select('id,patente,descripcion,transportista').in('id', ids);
        for (const d of (data || [])) m[d.id] = d;
      }
      for (const r of rows) {
        const dd = m[r.destino_id] || {};
        r.patente = dd.patente || r.colecta_patente || '';
        r.camion = dd.descripcion || '';
      }
      return rows;
    }

    if (venta) {
      const { data, error } = await supabase.from('dep_despachos').select(cols)
        .or(`nro_venta.eq.${venta},shipment_id.eq.${venta}`)
        .order('despachado_at', { ascending: false });
      if (error) throw new Error(error.message);
      return res.json({ modo: 'venta', venta, resultados: await enriquecer(data || []) });
    }
    const fecha = (req.query.fecha || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Indicá una fecha (o un número de venta)' });
    const desde = `${fecha}T00:00:00-03:00`;
    const hasta = `${fecha}T23:59:59.999-03:00`;
    let rows = [], from = 0;
    while (true) {
      const { data, error } = await supabase.from('dep_despachos').select(cols)
        .gte('despachado_at', desde).lte('despachado_at', hasta)
        .order('despachado_at', { ascending: true }).range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    await enriquecer(rows);
    const grupos = {};
    for (const r of rows) {
      const key = r.destino_nombre || (r.tipo === 'flex' ? 'Flex' : 'Colecta');
      if (!grupos[key]) {
        // Para Colecta mostramos el camión (patente · descripción); para Flex el nombre ya es el transportista.
        const ref = r.tipo === 'colecta' ? [r.patente, r.camion].filter(Boolean).join(' · ') : '';
        grupos[key] = { destino: key, tipo: r.tipo, ref, items: [] };
      }
      grupos[key].items.push(r);
    }
    const lista = Object.values(grupos).sort((a, b) =>
      (a.tipo === 'colecta' ? 0 : 1) - (b.tipo === 'colecta' ? 0 : 1) || a.destino.localeCompare(b.destino));
    res.json({
      modo: 'fecha', fecha, total: rows.length,
      colecta: rows.filter(r => r.tipo === 'colecta').length,
      flex: rows.filter(r => r.tipo === 'flex').length,
      grupos: lista
    });
  } catch (e) { console.error('[HISTORIAL]', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/despacho/despachar', async (req, res) => {
  try {
    const codigo = ((req.body && req.body.codigo) || '').trim();
    if (!codigo) return res.status(400).json({ error: 'Falta el código escaneado' });
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    // Destino abierto al que se está cargando (Parte 2). Opcional: si no
    // viene, se registra igual sin vínculo (compatibilidad).
    const destinoId = (req.body && req.body.destino_id) || null;
    let destino = null;
    if (destinoId) {
      const { data: dd2 } = await supabase.from('dep_destinos').select('*').eq('id', destinoId).limit(1);
      destino = (dd2 && dd2[0]) || null;
    }

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
      // Validación Flex↔Colecta contra el destino abierto
      if (destino && destino.tipo && dv.tipo && destino.tipo !== dv.tipo)
        return res.json({ resultado: 'tipo_incorrecto', esperado: destino.tipo, recibido: dv.tipo,
          mensaje: `Este paquete es ${dv.tipo.toUpperCase()} y el destino abierto es ${destino.tipo.toUpperCase()}`,
          destino_nombre: destino.nombre, ...base });
      const { data: dup } = await supabase.from('dep_despachos')
        .select('despachado_at,usuario').eq('shipment_id', dv.shipment_id)
        .order('despachado_at', { ascending: false }).limit(1);
      if (dup && dup[0])
        return res.json({ resultado: 'duplicada', mensaje: 'Este envío ya estaba escaneado',
          despachado_at: dup[0].despachado_at, usuario: dup[0].usuario || '', ...base });
      const { error } = await supabase.from('dep_despachos').insert({
        shipment_id: dv.shipment_id, nro_venta: dv.nro_venta, sku: dv.sku, titulo: dv.titulo,
        tipo: dv.tipo, usuario: (req.authUser && req.authUser.email) || 'demo',
        destino_id: destino ? destino.id : null,
        destino_nombre: destino ? destino.nombre : null,
        transportista: destino ? (destino.transportista || null) : null
      });
      if (error) throw new Error(error.message);
      let aviso = '';
      if (dv.status === 'shipped')   aviso = 'Ojo: ML ya la marca en camino.';
      if (dv.status === 'delivered') aviso = 'Ojo: ML ya la marca entregada.';
      console.log(`[DESPACHAR][DEMO] OK ship=${dv.shipment_id} venta=${dv.nro_venta}`);
      return res.json({ resultado: 'ok', mensaje: 'Despachada (demo)', aviso,
        destino_nombre: destino ? destino.nombre : null, ...base });
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

    // Validación Flex↔Colecta: no dejar cargar un paquete del tipo equivocado
    // al destino abierto. Solo si conocemos el tipo del paquete.
    if (destino && destino.tipo && tipo && destino.tipo !== tipo) {
      console.log(`[DESPACHAR] TIPO INCORRECTO ship=${s.shipment_id} paquete=${tipo} destino=${destino.tipo}`);
      return res.json({ resultado: 'tipo_incorrecto', esperado: destino.tipo, recibido: tipo,
        mensaje: `Este paquete es ${tipo.toUpperCase()} y el destino abierto es ${destino.tipo.toUpperCase()}`,
        destino_nombre: destino.nombre, ...base });
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
      colecta_horario: col ? `${col.from}-${col.to}` : null,
      destino_id: destino ? destino.id : null,
      destino_nombre: destino ? destino.nombre : null,
      transportista: destino ? (destino.transportista || null) : null
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
    res.json({ resultado: aviso ? 'ok_aviso' : 'ok', mensaje: 'Despachada', aviso, estado_ml: shipStatus,
      destino_nombre: destino ? destino.nombre : null, ...base });
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

    // ── "A despachar" del día = foto (estado real ML), del tipo, NO terminadas,
    //    con pay_before HOY o anterior (hoy + demoradas). Cuenta por paquete.
    //    Reconoce lo impreso en ML (no depende de que lo hayas impreso en el sistema).
    let foto = [], from = 0;
    while (true) {
      const { data, error: e2 } = await supabase.from('dep_envios')
        .select('shipment_id,nro_venta,sku,titulo,tipo,status,substatus,pay_before,limite,cancelada')
        .eq('es_nuestro', true).in('tipo', ['flex', 'colecta'])
        .range(from, from + 999);
      if (e2) throw new Error(e2.message);
      if (!data || !data.length) break;
      foto = foto.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    const TERMINADOS = ['shipped', 'delivered', 'not_delivered', 'returned', 'cancelled'];
    const EN_RED = new Set(['in_hub', 'in_warehouse', 'on_route', 'in_route', 'out_for_delivery',
      'soon_deliver', 'delivering', 'arrived', 'picked_up', 'dispatched']);
    const hoy = fechaHoyART();
    const despIds = new Set((desp || []).map(r => r.shipment_id));

    let aDespachar = [];
    const programadas = new Map(); // ventas con despacho programado para otro día: NO cuentan como faltantes de hoy
    for (const s of foto) {
      if (s.cancelada || TERMINADOS.includes(s.status) || EN_RED.has(s.substatus)) continue; // ya salió
      const pbDay = s.pay_before ? String(s.pay_before).substring(0, 10) : null;
      if (pbDay && pbDay > hoy) continue;   // es para mañana/futuro → no es del día
      if (s.substatus === 'buffered') {     // ML la tiene "en espera" para una colecta futura (ej. entregar el 13)
        if (!despIds.has(s.shipment_id)) programadas.set(s.shipment_id, { ...s, fecha_programada: pbDay });
        continue;
      }
      const limDay = s.limite ? String(s.limite).substring(0, 10) : null;
      if (limDay && limDay > hoy) {         // la fecha real de despacho (ML) es futura → programada
        if (!despIds.has(s.shipment_id)) programadas.set(s.shipment_id, { ...s, fecha_programada: limDay });
        continue;
      }
      aDespachar.push(s);
    }

    // Verificación en vivo (mismo criterio que Imprimir): las que NO escaneamos todavía
    // las chequeamos contra ML para no contar canceladas/ya-salidas que el webhook no actualizó.
    // De paso autocorregimos la foto para que la próxima ya esté bien.
    const token = await getValidToken(ML_USER_ID);
    if (token) {
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const aChequear = aDespachar.filter(s => !despIds.has(s.shipment_id)).slice(0, 160);
      const fuera = new Set();
      await poolMap(aChequear, 6, async (s) => {
        try {
          const r = await fetch(`https://api.mercadolibre.com/shipments/${s.shipment_id}`, auth);
          if (!r.ok) return;
          const sh = await r.json();
          const cancel = sh.status === 'cancelled' || (sh.substatus === 'cancelled');
          const yaSalio = TERMINADOS.includes(sh.status) || EN_RED.has(sh.substatus);
          // ¿Está programada para otro día? (colectas futuras: substatus buffered o fecha de despacho > hoy)
          const hl = sh.shipping_option && sh.shipping_option.estimated_handling_limit && sh.shipping_option.estimated_handling_limit.date;
          const hDay = hl ? String(hl).substring(0, 10) : null;
          const esProgramada = sh.substatus === 'buffered' || (hDay && hDay > hoy);
          if (cancel || yaSalio) {
            fuera.add(s.shipment_id);
            try { await supabase.from('dep_envios').update({ status: sh.status, substatus: sh.substatus || null, cancelada: cancel }).eq('shipment_id', s.shipment_id); } catch (_) {}
          } else if (esProgramada) {
            fuera.add(s.shipment_id);
            programadas.set(s.shipment_id, { ...s, fecha_programada: hDay });
            try { await supabase.from('dep_envios').update({ substatus: sh.substatus || null }).eq('shipment_id', s.shipment_id); } catch (_) {}
          }
        } catch (_) {}
      });
      if (fuera.size) aDespachar = aDespachar.filter(s => !fuera.has(s.shipment_id));
    }

    // Faltan = del día a despachar que todavía NO escaneamos
    const faltan = aDespachar.filter(s => !despIds.has(s.shipment_id)).sort(ordenarPorSku);

    // Desglose por tipo: total a despachar, escaneadas (hoy) y faltan
    const porTipo = { flex: { total: 0, escaneadas: 0, pendientes: 0 }, colecta: { total: 0, escaneadas: 0, pendientes: 0 } };
    for (const s of aDespachar) { if (porTipo[s.tipo]) porTipo[s.tipo].total++; }
    const despUnicas = new Map();
    for (const r of (desp || [])) if (!despUnicas.has(r.shipment_id)) despUnicas.set(r.shipment_id, r);
    for (const r of despUnicas.values()) { if (porTipo[r.tipo]) porTipo[r.tipo].escaneadas++; }
    for (const s of faltan) { if (porTipo[s.tipo]) porTipo[s.tipo].pendientes++; }

    res.json({
      impresas_hoy: impUnicas.size,
      despachadas_hoy: despIds.size,
      faltan_cnt: faltan.length,
      programadas_cnt: programadas.size,
      programadas: [...programadas.values()].sort((a, b) => String(a.fecha_programada || '9999').localeCompare(String(b.fecha_programada || '9999'))),
      por_tipo: porTipo,
      faltan,
      despachadas: desp || []
    });
  } catch (e) { console.error('[DESPACHADOS]', e.message); res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  PARTE 2 · CENTRO DE DESPACHO: camiones, destinos y asignación
// ════════════════════════════════════════════════════════════════

// ── Base de camiones (para Colecta de ML) ─────────────────────────
app.get('/api/despacho/camiones', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('dep_camiones')
      .select('id,patente,descripcion,tipo,observaciones,telefono,activo').eq('activo', true)
      .order('patente', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ camiones: data || [] });
  } catch (e) { console.error('[CAMIONES]', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/despacho/camiones', async (req, res) => {
  try {
    const b = req.body || {};
    const patente = (b.patente || '').trim().toUpperCase();
    const descripcion = (b.descripcion || '').trim();
    const tipo = (b.tipo || '').trim();
    const observaciones = (b.observaciones || '').trim();
    const telefono = (b.telefono || '').trim();
    if (!patente) return res.status(400).json({ error: 'Falta la patente' });
    // ¿ya existe esa patente activa? la reusamos
    const { data: ex } = await supabase.from('dep_camiones')
      .select('id,patente,descripcion,tipo,observaciones,telefono,activo').eq('patente', patente).eq('activo', true).limit(1);
    if (ex && ex[0]) return res.json({ camion: ex[0], existia: true });
    const { data, error } = await supabase.from('dep_camiones')
      .insert({ patente, descripcion, tipo, observaciones, telefono, activo: true })
      .select('id,patente,descripcion,tipo,observaciones,telefono,activo').limit(1);
    if (error) throw new Error(error.message);
    res.json({ camion: (data && data[0]) || null });
  } catch (e) { console.error('[CAMIONES]', e.message); res.status(500).json({ error: e.message }); }
});

// Editar un camión (patente / chofer-descripción)
app.post('/api/despacho/camiones/editar', async (req, res) => {
  try {
    const b = req.body || {};
    const id = b.id || null;
    const patente = (b.patente || '').trim().toUpperCase();
    const descripcion = (b.descripcion || '').trim();
    const tipo = (b.tipo || '').trim();
    const observaciones = (b.observaciones || '').trim();
    const telefono = (b.telefono || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta el id' });
    if (!patente) return res.status(400).json({ error: 'Falta la patente' });
    const { data, error } = await supabase.from('dep_camiones')
      .update({ patente, descripcion, tipo, observaciones, telefono }).eq('id', id)
      .select('id,patente,descripcion,tipo,observaciones,telefono,activo').limit(1);
    if (error) throw new Error(error.message);
    res.json({ camion: (data && data[0]) || null });
  } catch (e) { console.error('[CAMIONES-EDIT]', e.message); res.status(500).json({ error: e.message }); }
});

// Borrar un camión (baja lógica: activo=false; no afecta el historial ya guardado)
app.post('/api/despacho/camiones/borrar', async (req, res) => {
  try {
    const id = (req.body && req.body.id) || null;
    if (!id) return res.status(400).json({ error: 'Falta el id' });
    const { error } = await supabase.from('dep_camiones').update({ activo: false }).eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { console.error('[CAMIONES-DEL]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Destinos del día: abiertos + opciones para abrir ──────────────
app.get('/api/despacho/destinos', async (_req, res) => {
  try {
    const fecha = fechaHoyART();
    const { data: dest } = await supabase.from('dep_destinos')
      .select('*').eq('fecha', fecha).eq('abierto', true)
      .order('abierto_at', { ascending: true });

    // Conteo de paquetes cargados hoy a cada destino
    const { data: desp } = await supabase.from('dep_despachos')
      .select('destino_id,tipo').gte('despachado_at', inicioDeHoyART());
    const conteo = {};
    for (const d of (desp || [])) {
      if (d.destino_id != null) conteo[d.destino_id] = (conteo[d.destino_id] || 0) + 1;
    }
    const abiertos = (dest || []).map(d => ({ ...d, cargados: conteo[d.id] || 0 }));

    // Opciones de Colecta de ML (horarios del día)
    let colectas = [];
    try {
      const token = await getValidToken(ML_USER_ID);
      if (token) colectas = (await colectasDelDia(token)).filter(c => c.tanda === 'colecta');
    } catch (e) { /* sin colectas */ }

    res.json({
      fecha,
      abiertos,
      max_abiertos: 4,
      colectas: colectas.map(c => ({ horario: `${c.from}-${c.to}`, cutoff: c.cutoff, carrier: c.carrier })),
      transportistas: TRANSPORTISTAS_FLEX
    });
  } catch (e) { console.error('[DESTINOS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Abrir un destino (Colecta con camión, o Flex con transportista) ─
app.post('/api/despacho/destinos/abrir', async (req, res) => {
  try {
    const fecha = fechaHoyART();
    const tipo = ((req.body && req.body.tipo) || '').trim();   // 'colecta' | 'flex'
    if (!['colecta', 'flex'].includes(tipo))
      return res.status(400).json({ error: 'Tipo inválido (colecta o flex)' });

    // Tope de 2 abiertos a la vez
    const { data: ab } = await supabase.from('dep_destinos')
      .select('id,nombre,tipo,transportista,colecta_horario').eq('fecha', fecha).eq('abierto', true);
    if ((ab || []).length >= 4)
      return res.status(409).json({ error: 'Ya hay 4 destinos abiertos. Cerrá uno para abrir otro.' });

    let row = { fecha, tipo, abierto: true, abierto_por: (req.authUser && req.authUser.email) || null };

    if (tipo === 'colecta') {
      const camionId = (req.body && req.body.camion_id) || null;
      let patente = '', descripcion = '';
      if (camionId) {
        const { data: cam } = await supabase.from('dep_camiones')
          .select('patente,descripcion').eq('id', camionId).limit(1);
        if (cam && cam[0]) { patente = cam[0].patente || ''; descripcion = cam[0].descripcion || ''; }
      }
      // Nombre: por horario elegido ("Colecta 10:00–12:00") o, si no hay, numerada
      const horario = ((req.body && req.body.horario) || '').trim();
      if (horario) {
        row.nombre = `Colecta ${horario}`;
        row.colecta_horario = horario;
      } else {
        const { data: colsHoy } = await supabase.from('dep_destinos')
          .select('id').eq('fecha', fecha).eq('tipo', 'colecta');
        const n = (colsHoy || []).length + 1;
        row.nombre = `Colecta ${n}`;
        row.colecta_horario = '';
      }
      row.camion_id = camionId;
      row.patente = patente;
      row.descripcion = descripcion;
    } else {
      const transportista = ((req.body && req.body.transportista) || '').trim();
      if (!transportista) return res.status(400).json({ error: 'Elegí el transportista (ej. Ruedo o Gustavo)' });
      const yaAbierto = (ab || []).find(d => d.tipo === 'flex' && (d.transportista || '') === transportista);
      if (yaAbierto) return res.json({ destino: yaAbierto, existia: true });
      row.nombre = transportista;
      row.transportista = transportista;
    }

    const { data, error } = await supabase.from('dep_destinos').insert(row).select('*').limit(1);
    if (error) throw new Error(error.message);
    res.json({ destino: (data && data[0]) || null });
  } catch (e) { console.error('[DESTINO-ABRIR]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Cerrar un destino ─────────────────────────────────────────────
app.post('/api/despacho/destinos/cerrar', async (req, res) => {
  try {
    const id = (req.body && req.body.destino_id) || null;
    if (!id) return res.status(400).json({ error: 'Falta el destino' });
    const { error } = await supabase.from('dep_destinos')
      .update({ abierto: false, cerrado_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { console.error('[DESTINO-CERRAR]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Detalle para pagar a transportistas Flex (Ruedo/Gustavo) ──────
// /api/despacho/pagos-transportista?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
app.get('/api/despacho/pagos-transportista', async (req, res) => {
  try {
    const hoy = fechaHoyART();
    const desde = (req.query.desde || hoy.substring(0, 8) + '01') + 'T00:00:00.000-03:00';
    const hasta = (req.query.hasta || hoy) + 'T23:59:59.999-03:00';
    const { data, error } = await supabase.from('dep_despachos')
      .select('shipment_id,nro_venta,sku,titulo,transportista,despachado_at')
      .not('transportista', 'is', null)
      .gte('despachado_at', desde).lte('despachado_at', hasta)
      .order('despachado_at', { ascending: true });
    if (error) throw new Error(error.message);
    const porTransportista = {};
    for (const d of (data || [])) {
      const t = d.transportista || 'Sin transportista';
      (porTransportista[t] = porTransportista[t] || []).push(d);
    }
    const resumen = Object.keys(porTransportista).map(t => ({ transportista: t, cantidad: porTransportista[t].length }));
    res.json({ desde, hasta, total: (data || []).length, resumen, detalle: porTransportista });
  } catch (e) { console.error('[PAGOS]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Endpoint: SEGUIMIENTO (flujo completo por etiqueta) ───────────
app.get('/api/despacho/seguimiento', async (_req, res) => {
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');
    const reales = (await obtenerDetalladosConCache(token)).filter(s => s.es_nuestro !== false);
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
    // Sub-estados que indican que el paquete YA salió del depósito y está en la red de ML.
    const EN_RED_ML = new Set(['in_hub', 'in_warehouse', 'on_route', 'in_route',
      'out_for_delivery', 'soon_deliver', 'delivering', 'arrived', 'picked_up', 'dispatched']);
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
      else if (EN_RED_ML.has(s.substatus))                  b.en_camino.push(fila); // ya salió (en hub / en ruta)
      else if (impSet.has(s.shipment_id))                   b.en_preparacion.push(fila);
      else if (imprimible(s))                               b.para_imprimir.push(fila);
      else                                                  b.programados.push(fila); // en procesamiento / despacho futuro (todavía no salió)
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
// /api/despacho/diag-fechas?clave=TU_CLAVE
app.get('/api/despacho/diag-fechas', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG)
    return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
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
//   /api/despacho/diag?clave=TU_CLAVE
// ── DIAGNÓSTICO de UN envío (para ubicar el número del QR de Colecta) ──
// /api/despacho/diag-envio?clave=TU_CLAVE&venta=2000015060172118
app.get('/api/despacho/diag-envio', async (req, res) => {
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG)
    return res.status(401).json({ error: 'Agregá ?clave=TU_CLAVE' });
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
  if ((req.query.clave || '') !== CLAVE_DIAG || !CLAVE_DIAG)
    return res.status(401).json({ error: 'Falta la clave (configurá CLAVE_DIAG en Railway y usá ?clave=...)' });
  try {
    const token = await getValidToken(ML_USER_ID);
    if (!token) throw new Error('No hay token de ML disponible');

    // Traemos SIN usar caché ni filtro de depósito
    const desde = new Date(); desde.setDate(desde.getDate() - DIAS_BUSQUEDA);
    const desdeISO = desde.toISOString().substring(0,10) + 'T00:00:00.000-03:00';
    const hastaISO = new Date().toISOString().substring(0,10) + 'T23:59:59.000-03:00';
    const ordenes = []; let offset = 0, total = 999;
    while (offset < Math.min(total, MAX_ORDENES)) {
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
// ══════════════════════════════════════════════════════════════════
//  COLECTA FULL · registrar y verificar bultos/pallets de envíos a Full
//  Tabla dep_full_items. Todo bajo /api/despacho → ya pasa por requireAuth.
// ══════════════════════════════════════════════════════════════════

// Extrae el id escaneable de un código (número de barras crudo o JSON del QR)
function parseFullId(codigo) {
  const c = String(codigo || '').trim();
  if (c.startsWith('{')) {
    try { const j = JSON.parse(c); if (j && j.id) return String(j.id); } catch (e) {}
  }
  const m = c.match(/\d{6,}/);
  return m ? m[0] : '';
}

// Trae todas las filas (paginado por el tope de 1000 de PostgREST)
async function fetchAllFull(envio) {
  let out = [], from = 0; const size = 1000;
  for (;;) {
    let q = supabase.from('dep_full_items')
      .select('id,envio,reference_id,tipo,etiqueta,escaneado_at,registrado_at,destino,deposito')
      .range(from, from + size - 1);
    if (envio) q = q.eq('envio', envio);
    q = q.order('registrado_at', { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out = out.concat(data || []);
    if (!data || data.length < size) break;
    from += size;
    if (from > 30000) break;
  }
  return out;
}

// Registrar los ítems de un envío (no pisa lo ya escaneado)
app.post('/api/despacho/full/registrar', async (req, res) => {
  try {
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No hay ítems para registrar' });
    const rows = items.filter(x => x && x.id && x.reference_id).map(x => ({
      id: String(x.id),
      envio: String(x.envio || String(x.reference_id).split('/')[0]),
      reference_id: String(x.reference_id),
      tipo: x.tipo || null,
      etiqueta: x.etiqueta || String(x.reference_id).split('/')[1] || null,
      destino: x.destino || null,
      deposito: x.deposito || null
    }));
    if (!rows.length) return res.status(400).json({ error: 'Ítems inválidos' });
    // upsert con merge: si ya existe actualiza estos campos (sirve para completar
    // destino/depósito re-subiendo el archivo) SIN tocar escaneado_at
    const { error } = await supabase.from('dep_full_items').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    const envio = rows[0].envio;
    const all = await fetchAllFull(envio);
    console.log(`[FULL][REGISTRAR] envío=${envio} ítems=${rows.length} total=${all.length}`);
    res.json({ ok: true, envio, total: all.length,
      escaneados: all.filter(x => x.escaneado_at).length,
      bultos: all.filter(x => x.tipo === 'box').length,
      pallets: all.filter(x => x.tipo === 'ppi').length });
  } catch (e) { console.error('[FULL][REGISTRAR]', e.message); res.status(500).json({ error: e.message }); }
});

// Lista de envíos Full cargados con su progreso
app.get('/api/despacho/full/envios', async (_req, res) => {
  try {
    const all = await fetchAllFull(null);
    const m = new Map();
    for (const x of all) {
      let e = m.get(x.envio);
      if (!e) { e = { envio: x.envio, total: 0, escaneados: 0, bultos: 0, pallets: 0, ultimo: x.registrado_at, _dest: new Set(), _dep: new Set() }; m.set(x.envio, e); }
      e.total++;
      if (x.escaneado_at) e.escaneados++;
      if (x.tipo === 'box') e.bultos++; else if (x.tipo === 'ppi') e.pallets++;
      if (x.destino) e._dest.add(x.destino);
      if (x.deposito) e._dep.add(x.deposito);
      if ((x.registrado_at || '') > (e.ultimo || '')) e.ultimo = x.registrado_at;
    }
    const envios = [...m.values()].map(e => ({
      envio: e.envio, total: e.total, escaneados: e.escaneados, bultos: e.bultos, pallets: e.pallets,
      ultimo: e.ultimo, destino: [...e._dest].join('/') || null, deposito: [...e._dep].join('/') || null,
      faltan: e.total - e.escaneados, completo: e.escaneados >= e.total
    }))
      .sort((a, b) => String(b.ultimo || '').localeCompare(String(a.ultimo || '')));
    res.json({ envios });
  } catch (e) { console.error('[FULL][ENVIOS]', e.message); res.status(500).json({ error: e.message }); }
});

// Estado detallado de un envío (lista de ítems para tildar)
app.get('/api/despacho/full/estado', async (req, res) => {
  try {
    const envio = (req.query.envio || '').trim();
    if (!envio) return res.status(400).json({ error: 'Falta el envío' });
    const items = (await fetchAllFull(envio)).map(x => ({
      id: x.id, etiqueta: x.etiqueta, tipo: x.tipo, reference_id: x.reference_id,
      escaneado: !!x.escaneado_at, escaneado_at: x.escaneado_at
    }));
    items.sort((a, b) => {
      if (a.tipo !== b.tipo) return a.tipo === 'ppi' ? -1 : 1; // pallets primero
      const na = parseInt(String(a.etiqueta).replace(/\D/g, '')) || 0;
      const nb = parseInt(String(b.etiqueta).replace(/\D/g, '')) || 0;
      return na - nb;
    });
    const total = items.length, escaneados = items.filter(x => x.escaneado).length;
    const crudos = await fetchAllFull(envio);
    const destino = [...new Set(crudos.map(x => x.destino).filter(Boolean))].join('/') || null;
    const deposito = [...new Set(crudos.map(x => x.deposito).filter(Boolean))].join('/') || null;
    res.json({ envio, total, escaneados, faltan: total - escaneados, destino, deposito,
      bultos: items.filter(x => x.tipo === 'box').length,
      pallets: items.filter(x => x.tipo === 'ppi').length, items });
  } catch (e) { console.error('[FULL][ESTADO]', e.message); res.status(500).json({ error: e.message }); }
});

// Escanear un bulto/pallet → lo marca como verificado
app.post('/api/despacho/full/escanear', async (req, res) => {
  try {
    const codigo = ((req.body && req.body.codigo) || '').trim();
    const envioCtx = ((req.body && req.body.envio) || '').trim() || null;
    if (!codigo) return res.status(400).json({ error: 'Falta el código' });
    const id = parseFullId(codigo);
    if (!id) return res.status(400).json({ error: 'No pude leer el código' });
    const { data, error } = await supabase.from('dep_full_items').select('*').eq('id', id).limit(1);
    if (error) throw new Error(error.message);
    const it = data && data[0];
    if (!it) return res.json({ resultado: 'no_pertenece', id, mensaje: 'Este código no es de ningún envío Full cargado' });
    if (envioCtx && String(it.envio) !== String(envioCtx))
      return res.json({ resultado: 'otro_envio', id, envio_real: it.envio, etiqueta: it.etiqueta, tipo: it.tipo,
        mensaje: `Este ítem es del envío ${it.envio}, no del ${envioCtx}` });
    if (it.escaneado_at)
      return res.json({ resultado: 'duplicada', id, etiqueta: it.etiqueta, tipo: it.tipo, escaneado_at: it.escaneado_at,
        mensaje: 'Ya estaba escaneado' });
    const { error: e2 } = await supabase.from('dep_full_items')
      .update({ escaneado_at: new Date().toISOString(), usuario: (req.authUser && req.authUser.email) || null })
      .eq('id', id);
    if (e2) throw new Error(e2.message);
    const items = await fetchAllFull(it.envio);
    const total = items.length;
    const escaneados = items.filter(x => x.escaneado_at || x.id === id).length;
    return res.json({ resultado: 'ok', id, etiqueta: it.etiqueta, tipo: it.tipo, envio: it.envio,
      total, escaneados, faltan: total - escaneados });
  } catch (e) { console.error('[FULL][ESCANEAR]', e.message); res.status(500).json({ error: e.message }); }
});

// Desmarcar (si me equivoqué al escanear)
app.post('/api/despacho/full/desmarcar', async (req, res) => {
  try {
    const id = parseFullId((req.body && (req.body.codigo || req.body.id)) || '');
    if (!id) return res.status(400).json({ error: 'Falta el id' });
    const { error } = await supabase.from('dep_full_items').update({ escaneado_at: null }).eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ ok: true, id });
  } catch (e) { console.error('[FULL][DESMARCAR]', e.message); res.status(500).json({ error: e.message }); }
});

// Borrar un envío completo (limpieza)
app.post('/api/despacho/full/borrar', async (req, res) => {
  try {
    const envio = ((req.body && req.body.envio) || '').trim();
    if (!envio) return res.status(400).json({ error: 'Falta el envío' });
    const { error } = await supabase.from('dep_full_items').delete().eq('envio', envio);
    if (error) throw new Error(error.message);
    res.json({ ok: true, envio });
  } catch (e) { console.error('[FULL][BORRAR]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/', (_req, res) => res.json({ ok: true, app: 'deposito-backend', fase: '5.52-corte-fecha-real', max_ordenes: MAX_ORDENES, diag_protegido: !!CLAVE_DIAG, token_alerta: _tokenAlerta }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

// ── Purga automática del log de webhooks (dep_webhooks crece sin parar) ──
const WEBHOOK_DIAS_RETENCION = parseInt(process.env.WEBHOOK_DIAS_RETENCION || '14', 10);
async function purgarWebhooks() {
  try {
    const corte = new Date(Date.now() - WEBHOOK_DIAS_RETENCION * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('dep_webhooks').delete().lt('received_at', corte);
    if (error) console.error('[PURGA] dep_webhooks:', error.message);
    else console.log(`[PURGA] dep_webhooks: eliminado lo anterior a ${corte} (retención ${WEBHOOK_DIAS_RETENCION} días)`);
  } catch (e) { console.error('[PURGA]', e.message); }
}
setTimeout(purgarWebhooks, 60 * 1000);            // una pasada al minuto de arrancar
setInterval(purgarWebhooks, 6 * 60 * 60 * 1000);  // y después cada 6 horas

app.listen(PORT, () => console.log(`Depósito backend escuchando en :${PORT}`));
