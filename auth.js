/**
 * auth.js — middlewares de autenticacion del proxy.
 *
 * Tres modos de acceso, segun quien llama:
 *
 *   requireService  X-Api-Key. Para Moodle: tramites, crons, wizards de staff.
 *   requireAdmin    X-Admin-Secret. Para operaciones de administracion.
 *   (requireStudent llegara en la fase de identidad del canal LXP.)
 *
 * Rollout: cada grupo empieza en modo PERMISIVO (valida, cuenta y deja pasar) y
 * se cierra por separado con AUTH_ENFORCE. Asi se puede desplegar sin romper
 * nada, mirar los contadores de /api/metrics y cerrar cuando la proporcion de
 * peticiones autenticadas sea 1,0. Revertir un grupo es cambiar una variable de
 * entorno y reiniciar, sin tocar codigo.
 *
 * AUTH_ENFORCE=""                   -> todo permisivo (por defecto)
 * AUTH_ENFORCE="tramites"           -> solo el grupo de tramites exige clave
 * AUTH_ENFORCE="tramites,servicio"  -> dos grupos
 * AUTH_ENFORCE="all"                -> todos
 */

const crypto = require('crypto');
const config = require('./config');

const API_KEY = config.proxyApiKey;
// Permite rotar la clave sin ventana: durante la rotacion valen las dos.
const API_KEY_PREVIOUS = process.env.ODOO_PROXY_API_KEY_PREVIOUS || '';
const ADMIN_SECRET = config.adminSecret;

const ENFORCE = new Set(
  (process.env.AUTH_ENFORCE || '')
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean)
);

function enforcing(grupo) {
  return ENFORCE.has('all') || ENFORCE.has(grupo);
}

// Contadores en memoria. Los lee /api/metrics para decidir cuando cerrar.
const metrics = {
  'auth.ok.service': 0,
  'auth.ok.admin': 0,
  'auth.missing': 0,
  'auth.invalid': 0,
  'auth.permissive_pass': 0,
};

function contar(clave) {
  metrics[clave] = (metrics[clave] || 0) + 1;
}

/**
 * Comparacion en tiempo constante.
 *
 * Se comparan los digest SHA-256 y no las cadenas: timingSafeEqual exige
 * longitudes iguales (lanza si difieren, lo que ya filtraria la longitud del
 * secreto), y el digest siempre mide 32 bytes.
 */
function secretosIguales(a, b) {
  if (!a || !b) return false;
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

function claveDeServicioValida(recibida) {
  if (!recibida) return false;
  return secretosIguales(recibida, API_KEY) ||
    (!!API_KEY_PREVIOUS && secretosIguales(recibida, API_KEY_PREVIOUS));
}

/**
 * Exige X-Api-Key en las rutas llamadas por Moodle (servidor a servidor).
 *
 * El middleware anterior tenia un fallo que lo anulaba: `if (!API_KEY) return
 * next()`. Sin la variable de entorno no protegia nada, y en silencio. Aqui,
 * cuando el grupo esta en enforce y falta la clave de configuracion, se
 * responde 503 y se registra: preferimos un fallo ruidoso a una puerta abierta
 * que nadie ve.
 */
function requireService(grupo) {
  return function (req, res, next) {
    const recibida = req.header('X-Api-Key') || req.header('x-api-key') || '';
    const cerrado = enforcing(grupo);

    if (claveDeServicioValida(recibida)) {
      contar('auth.ok.service');
      req.auth = { via: 'service', group: grupo };
      res.setHeader('X-Auth-Status', 'ok');
      return next();
    }

    if (!API_KEY) {
      // No hay clave configurada en el servidor.
      if (cerrado) {
        console.error(`[auth] ${req.method} ${req.path}: grupo "${grupo}" en enforce ` +
          'pero ODOO_PROXY_API_KEY no esta configurada. Se rechaza.');
        return res.status(503).json({ error: 'auth_not_configured' });
      }
      contar('auth.permissive_pass');
      res.setHeader('X-Auth-Status', 'unconfigured');
      return next();
    }

    const estado = recibida ? 'invalid' : 'missing';
    contar(recibida ? 'auth.invalid' : 'auth.missing');
    res.setHeader('X-Auth-Status', estado);

    if (!cerrado) {
      // Modo permisivo: se deja pasar, pero queda contado y con la cabecera
      // puesta para poder medir cuanto trafico llegaria sin credenciales.
      console.warn(`[auth] PERMISIVO ${req.method} ${req.path} sin clave valida (${estado}).`);
      return next();
    }

    console.warn(`[auth] RECHAZADO ${req.method} ${req.path} (${estado}).`);
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Falta la cabecera X-Api-Key o no es valida.',
    });
  };
}

/**
 * Exige X-Admin-Secret. Sustituye a la comparacion con !== del adminAuth
 * anterior, que ademas se medía contra un valor por defecto publicado en el
 * propio repositorio y en el README.
 */
function requireAdmin(req, res, next) {
  const recibido = req.headers['x-admin-secret'];
  if (secretosIguales(recibido, ADMIN_SECRET)) {
    contar('auth.ok.admin');
    req.auth = { via: 'admin' };
    return next();
  }
  contar(recibido ? 'auth.invalid' : 'auth.missing');
  console.warn(`[auth] RECHAZADO admin ${req.method} ${req.path}.`);
  return res.status(401).json({ error: 'No autorizado' });
}

function getMetrics() {
  return {
    ...metrics,
    enforce: Array.from(ENFORCE),
    service_key_configured: !!API_KEY,
    rotation_key_configured: !!API_KEY_PREVIOUS,
  };
}

module.exports = {
  requireService,
  requireAdmin,
  getMetrics,
  secretosIguales,
  claveDeServicioValida,
  enforcing,
};
