/**
 * moodle_identity.js — resuelve quien es el estudiante que hace la peticion.
 *
 * El problema que arregla: hasta ahora el proxy identificaba al estudiante por
 * un parametro de URL, `?documentNumber=<cedula>`, sin ninguna credencial. Eso
 * permitia leer el estado de cuenta completo de cualquier persona con solo
 * conocer su cedula, que en Panama es semipublica y de formato predecible.
 *
 * La solucion no inventa un sistema de sesiones nuevo. El LXP ya tiene un
 * wstoken de Moodle, y Moodle ya sabe a quien pertenece; aqui solo se le
 * pregunta. Dos llamadas en el peor caso:
 *
 *   core_webservice_get_site_info      -> userid
 *   core_user_get_users_by_field(id)   -> customfields.documentnumber
 *
 * La cedula deja de ser algo que el cliente declara y pasa a ser algo que
 * Moodle afirma.
 *
 * Distincion central, y la razon de casi todo el codigo de este archivo:
 *
 *   "Moodle dice que el token no vale"  -> 401, es una respuesta.
 *   "No se pudo hablar con Moodle"      -> 503, NO es una respuesta.
 *
 * Confundirlas provocaria un cierre de sesion masivo cada vez que Moodle tenga
 * un mal minuto.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const config = require('./config');

const TTL_FRESCO_MS = 5 * 60 * 1000;      // 5 min
const TTL_DEGRADADO_MS = 30 * 60 * 1000;  // 30 min, solo si Moodle no responde
const TTL_NEGATIVO_MS = 60 * 1000;        // 1 min
const MAX_ENTRADAS = 5000;
const MAX_NEGATIVAS = 1000;
const TIMEOUT_MS = 8000;

// Agente con keep-alive: sin esto se abre un handshake TLS nuevo por llamada, y
// con la introspeccion en caliente eso multiplica el coste contra Moodle.
const agente = new https.Agent({ keepAlive: true, maxSockets: 20 });

const cacheTokens = new Map();     // hash(token) -> { identidad, expira, expiraDegradado }
const cacheNegativa = new Map();   // hash(token) -> expira

// Interruptor: si Moodle deja de responder, no tiene sentido que 200 peticiones
// se queden 8 segundos cada una esperando. Con un solo proceso eso agota el
// bucle de eventos y tumba tambien lo que si funciona.
const circuito = { fallos: 0, abiertoHasta: 0, UMBRAL: 5, REPOSO_MS: 30000 };

const metricas = {
  'moodle.introspect.hit': 0,
  'moodle.introspect.miss': 0,
  'moodle.introspect.fail': 0,
  'moodle.introspect.degraded': 0,
  'moodle.circuit.open': 0,
};

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function podar(mapa, maximo) {
  if (mapa.size <= maximo) return;
  // Map conserva el orden de insercion: las primeras son las mas viejas.
  const sobran = mapa.size - maximo;
  let i = 0;
  for (const clave of mapa.keys()) {
    mapa.delete(clave);
    if (++i >= sobran) break;
  }
}

class ErrorTokenInvalido extends Error {}
class ErrorMoodleCaido extends Error {}

function pedirJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const cliente = u.protocol === 'https:' ? https : http;
    const req = cliente.get(
      u,
      { agent: u.protocol === 'https:' ? agente : undefined, timeout: TIMEOUT_MS },
      (res) => {
        let cuerpo = '';
        res.on('data', (c) => { cuerpo += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new ErrorMoodleCaido(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(cuerpo));
          } catch (e) {
            // Respuesta no-JSON: casi siempre una pagina de error de nginx.
            reject(new ErrorMoodleCaido('respuesta no JSON'));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new ErrorMoodleCaido('timeout')); });
    req.on('error', (e) => reject(new ErrorMoodleCaido(e.message)));
  });
}

function urlWs(token, wsfunction, extra = '') {
  const base = config.moodleUrl.replace(/\/+$/, '');
  return `${base}/webservice/rest/server.php?wstoken=${encodeURIComponent(token)}` +
    `&wsfunction=${wsfunction}&moodlewsrestformat=json${extra}`;
}

/**
 * Pregunta a Moodle de quien es el token.
 * Lanza ErrorTokenInvalido (es una respuesta) o ErrorMoodleCaido (no lo es).
 */
async function introspectar(token) {
  const info = await pedirJson(urlWs(token, 'core_webservice_get_site_info'));

  // Moodle devuelve 200 con un cuerpo de excepcion cuando el token no sirve.
  if (info && info.exception) {
    if (info.errorcode === 'invalidtoken' || info.errorcode === 'accessexception') {
      throw new ErrorTokenInvalido(info.errorcode);
    }
    throw new ErrorMoodleCaido(info.errorcode || 'excepcion de Moodle');
  }
  if (!info || !info.userid) throw new ErrorMoodleCaido('respuesta sin userid');

  const usuarios = await pedirJson(
    urlWs(token, 'core_user_get_users_by_field', `&field=id&values[0]=${info.userid}`)
  );
  if (usuarios && usuarios.exception) throw new ErrorMoodleCaido(usuarios.errorcode || 'excepcion');

  const usuario = Array.isArray(usuarios) ? usuarios[0] : null;
  const campos = (usuario && usuario.customfields) || [];
  const campoDoc = campos.find((c) => c.shortname === 'documentnumber');

  return {
    userid: info.userid,
    username: info.username || (usuario && usuario.username) || '',
    documentNumber: campoDoc && campoDoc.value ? String(campoDoc.value).trim() : '',
    via: 'moodle_token',
  };
}

/**
 * Resuelve la identidad, con cache.
 *
 * Devuelve { identidad, degradada } o lanza ErrorTokenInvalido / ErrorMoodleCaido.
 */
async function resolver(token) {
  const clave = hash(token);
  const ahora = Date.now();

  const negativa = cacheNegativa.get(clave);
  if (negativa && negativa > ahora) throw new ErrorTokenInvalido('cacheada');

  const entrada = cacheTokens.get(clave);
  if (entrada && entrada.expira > ahora) {
    metricas['moodle.introspect.hit'] += 1;
    return { identidad: entrada.identidad, degradada: false };
  }

  if (circuito.abiertoHasta > ahora) {
    metricas['moodle.circuit.open'] += 1;
    if (entrada && entrada.expiraDegradado > ahora) {
      metricas['moodle.introspect.degraded'] += 1;
      return { identidad: entrada.identidad, degradada: true };
    }
    throw new ErrorMoodleCaido('circuito abierto');
  }

  metricas['moodle.introspect.miss'] += 1;
  try {
    const identidad = await introspectar(token);
    circuito.fallos = 0;
    cacheTokens.set(clave, {
      identidad,
      expira: ahora + TTL_FRESCO_MS,
      expiraDegradado: ahora + TTL_DEGRADADO_MS,
    });
    podar(cacheTokens, MAX_ENTRADAS);
    return { identidad, degradada: false };
  } catch (e) {
    if (e instanceof ErrorTokenInvalido) {
      // Es una respuesta de Moodle, no un fallo: no cuenta para el circuito.
      cacheNegativa.set(clave, ahora + TTL_NEGATIVO_MS);
      podar(cacheNegativa, MAX_NEGATIVAS);
      throw e;
    }
    metricas['moodle.introspect.fail'] += 1;
    circuito.fallos += 1;
    if (circuito.fallos >= circuito.UMBRAL) {
      circuito.abiertoHasta = ahora + circuito.REPOSO_MS;
      circuito.fallos = 0;
      console.error('[identity] Moodle no responde; circuito abierto 30 s.');
    }
    // Una sesion viva no se rompe porque Moodle tenga un mal minuto.
    if (entrada && entrada.expiraDegradado > ahora) {
      metricas['moodle.introspect.degraded'] += 1;
      return { identidad: entrada.identidad, degradada: true };
    }
    throw e;
  }
}

function extraerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-moodle-token'] || req.query.wstoken || '';
}

function purgarCaches() {
  const n = cacheTokens.size + cacheNegativa.size;
  cacheTokens.clear();
  cacheNegativa.clear();
  return n;
}

function getMetricas() {
  return {
    ...metricas,
    cache_entries: cacheTokens.size,
    negative_entries: cacheNegativa.size,
    circuit_open: circuito.abiertoHasta > Date.now(),
  };
}

module.exports = {
  resolver,
  extraerToken,
  purgarCaches,
  getMetricas,
  ErrorTokenInvalido,
  ErrorMoodleCaido,
  // Exportados para las pruebas:
  _hash: hash,
  _introspectar: introspectar,
};
