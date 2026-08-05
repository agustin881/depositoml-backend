# PONTEC OS · CONTEXTO PARA CLAUDE
> Leé este archivo completo antes de empezar. Es el traspaso de meses de trabajo.
> Última actualización: 04/08/2026 · Actualizá la fecha y las versiones cada vez que cierres una sesión.

## QUIÉN SOY
Agustín, dueño de **PONTEC SA** — vendedor de alto volumen en MercadoLibre (~20.000 envíos/mes), Rosario, Argentina. **No soy técnico**: deployo pegando archivos COMPLETOS en el editor web de GitHub (lapicito → Ctrl+A → pegar → Commit). Railway y Vercel deployan solos al commitear. Hablame en argentino informal (voseo). Suelo trabajar de noche.

## EQUIPO
Valeria y Franco (operadores) · Paula y Luciano (encargados) · Marina (operadora). Los roles y permisos se administran desde Pontec OS → Usuarios.

## STACK Y REPOS (GitHub: agustin881)
| App | Repo | Archivo | Hosting |
|---|---|---|---|
| App Depósito backend | `depositoml-backend` | `index.js` | Railway: `depositoml-backend-production.up.railway.app` |
| App Depósito frontend | `depositoml-frontend` | `index.html` | Vercel |
| MargenML backend | `margenml-backend` | **`api/index.js`** (¡dentro de carpeta api!) | Railway: `margenml-backend-production.up.railway.app` |
| MargenML frontend | `margenml-frontend` | `index.html` | Vercel |
| Hub Pontec OS | `pontec-os` | `index.html` | Vercel: `pontec-os.vercel.app` |
| RespondIA landing | `respondia-landing` | — | Vercel |

- **Supabase compartido** (proyecto `flmmgkidltnqlsswiybp`): tablas `dep_*` (Depósito), `mml_*` (MargenML/usuarios), `nv_*` (ventas Cecilia), RespondIA aparte.
- ML user_id `67619515`. Timezone SIEMPRE Argentina (UTC−3 fijo).

## MÉTODO DE TRABAJO (respetalo)
1. **Archivos completos** listos para pegar — nunca fragmentos ni diffs.
2. **Versionado estricto**: backend `fase: 'X.YY-nombre'` visible en la raíz; frontend badge `vNN` visible arriba. Bump en CADA entrega.
3. **Validar antes de entregar**: `node --check` al backend; extraer los bloques `<script>` del HTML y `node --check` a cada uno; verificar balance de `<section>`/`</section>` y `<body>`.
4. Checklists numeradas de deploy con qué verificar (fase/badge).
5. Al arreglar bugs: primero DIAGNÓSTICO con datos reales (hay endpoints `/api/despacho/diag-*?clave=` — la clave es env `CLAVE_DIAG` en Railway), después el bisturí. Probar con simulaciones en node cuando se pueda.
6. ⚠️ LECCIÓN APRENDIDA: siempre partir del código ACTUAL del repo (bajarlo de raw.githubusercontent.com), nunca de una copia vieja — ya tuvimos un retroceso feo por eso (se perdieron los permisos de Logística y hubo que reconstruirlos).

## ESTADO ACTUAL (04/08/2026)
- **Depósito backend v5.81** (`5.81-catalogo-protegido`) · **frontend v75**.
- **Hub Pontec OS v11** (con permisos de Logística restaurados).
- **MargenML backend** con campo `pestanas_logistica` (5 vías) — "permisos v2".
- Todo deployado y funcionando.

## QUÉ HACE CADA APP (resumen)
**App Depósito** (la estrella): Imprimir (Flex/Colecta, HOY/mañana), Despachar (escaneo QR + verificación de productos por EAN), Seguimiento (por depósito), Herramientas (ZPL→PDF de Full, etiquetas de productos 10×15 y 5×2,5, Verificador/banco de pruebas), Pagos de envíos (cierres Ruedo/Gustavo), ⚙ Ajustes (depósitos agrupados multi-identidad, catálogo SKU↔EAN ~854 productos, código de aprobación "VERIFICADO", camiones).
**MargenML**: rentabilidad real ML×Contabilium + registro central de usuarios (`mml_roles`).
**Pontec OS hub**: SSO por postMessage a las apps embebidas + administración de usuarios/roles/pestañas.
**RespondIA**: respuestas AI preventa/posventa (SaaS multi-tenant propio).

## DECISIONES DE ARQUITECTURA CLAVE (no las rompas)
- **Depósitos multi-identidad**: un depósito físico = varios IDs de ML (Colecta `1588335205` + Flex `ARP676195151` = ROSARIO, ambos "principal"). FLEX BAIRES = `ARP676195153` (Villa Crespo, socio: solo impresión, sin verificación, se vigila desde Seguimiento). **FULL = lo despacha ML** (La Matanza/Caseros), excluido siempre por `logistic_type='fulfillment'`. El ID puede venir en `sender_address.id` O escondido en `types: ["logistic_center_XXX"]`.
- **HOY/mañana** (3 capas, cada una nació de una venta real): ① límite/buffering de ML manda → ② `pay_before` trae LA HORA de corte (listo después de esa hora = mañana) → ③ agenda de colectas como red.
- **Verificación de productos**: llave general en Ajustes + catálogo (EAN único) + tilde por depósito + código de aprobación (comparación tolerante a mayúsculas, funciona antes o después de la etiqueta, auditado como 'aprobado' en `dep_despachos.verificacion`).
- **Ritmo rápido**: producto y etiqueta en cualquier orden, incluso seguidos sin esperar (el server valida; memoria de escaneos 90s evita re-consultar ML en la 2ª fase).
- **Rendimiento**: caché de envíos con servir-viejo-y-refrescar + candado de recorrida única; precarga 06:30–23:30; purga automática de `dep_envios` terminados (45 días) e impresiones (60 días); tablero con debounce tras escaneos; UN solo AudioContext.
- **Permisos**: pestañas de Logística por usuario en `mml_roles.pestanas_logistica` (jsonb), administradas desde el hub; el backend del Depósito valida contra `/api/mi-rol` de MargenML (caché 5 min, fallback `EMAILS_DEPOSITO`) y BLOQUEA server-side: `/transportes`→pagos, `/full`→full, catálogo→config (lectura también con full).
- **Contabilium**: rate limit 25 req/10s, `/conceptos/search` incompleto (usar getByCodigo por SKU), campo `CostoInterno`, sin sandbox.
- **Supabase**: tope 1000 filas → SIEMPRE paginar con `.range()`.

## PENDIENTES ANOTADOS
1. WMS del depósito (diseñado completo, SQL `dep_wms_*` y prototipo listos — falta numerar racks físicos y deployar).
2. Picking con verificación EAN por producto + sticker de empleado para los sin código.
3. Colectas/Camiones del día (endpoint `/api/despacho/colectas` a terminar).
4. Asignar camión a Colecta Full.
5. Pontec UI (identidad gráfica): `pontec-ui.css` + `pontec-ui.html` listos para subir a un repo nuevo en Vercel — usarla en TODO proyecto nuevo.
6. Persistencia de pestaña activa (localStorage). Detector "impresas en ML sin papel". Rediseño tablero Seguimiento.
7. Migración del flujo de trabajo a Claude Code (los repos clonados localmente).

## CÓMO EMPEZAR UNA SESIÓN CONMIGO
Bajá el código actual antes de tocar nada:
`curl -s https://raw.githubusercontent.com/agustin881/depositoml-backend/main/index.js`
(ídem para cada repo que vayas a modificar). Verificá la fase/badge deployados contra este documento — si difieren, este doc está viejo: preguntame y actualizalo.
