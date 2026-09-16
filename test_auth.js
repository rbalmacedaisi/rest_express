/**
 * test_auth.js — pruebas de los middlewares de autenticacion.
 *
 * Node puro, sin dependencias de test: es el patron que ya usa
 * test_staging_guard.js. Meter un framework nuevo en un servicio sin lockfile
 * durante una remediacion de seguridad es como se provoca el incidente que se
 * intenta evitar.
 *
 * Uso:  node test_auth.js
 */

process.env.ODOO_URL = 'https://odoo.isi.edu.pa';
process.env.ODOO_DB = 'odoo_staging';
process.env.ODOO_USER = 'u';
process.env.ODOO_APIKEY = 'k';
process.env.MOODLE_URL = 'https://lms.isi.edu.pa';
process.env.MOODLE_GRACE_TOKEN = 't';
process.env.MOODLE_LETTERS_WEBHOOK_TOKEN = 't';
process.env.ADMIN_SECRET = 'admin-secreto';
process.env.ODOO_PROXY_API_KEY = 'clave-servicio';
process.env.ODOO_LETTERS_WEBHOOK_SECRET = 's';
process.env.ODOO_PAYMENT_WEBHOOK_SECRET = 's';
process.env.AUTH_ENFORCE = 'tramites,estudiante';

const express = require('express');
const identity = require('./moodle_identity');
const { requireService, requireStudent, requireAdmin } = require('./auth');

// --- Moodle simulado -------------------------------------------------------
// El token dice que responde Moodle. Asi se pueden ejercitar los caminos que en
// la realidad solo aparecen cuando Moodle se cae.
const ALUMNO_A = { userid: 11, username: 'ana', documentNumber: '8-111-1111', via: 'moodle_token' };

identity.resolver = async function (token) {
  if (token === 'token-de-ana') return { identidad: ALUMNO_A, degradada: false };
  if (token === 'token-degradado') return { identidad: ALUMNO_A, degradada: true };
  if (token === 'token-invalido') throw new identity.ErrorTokenInvalido('invalidtoken');
  if (token === 'moodle-caido') throw new identity.ErrorMoodleCaido('ECONNREFUSED');
  throw new identity.ErrorTokenInvalido('desconocido');
};

// --- App de prueba ---------------------------------------------------------
const app = express();
app.use(express.json());
app.get('/facturas', requireStudent('estudiante'), (req, res) =>
  res.json({ userid: req.student.userid, doc: req.query.documentNumber }));
app.post('/tramite', requireService('tramites'), (req, res) => res.json({ ok: true }));
app.get('/admin', requireAdmin, (req, res) => res.json({ ok: true }));

// --- Casos -----------------------------------------------------------------
const casos = [
  // El agujero que se cierra: la cedula ajena con token propio.
  { n: 'EL CASO: token de Ana pidiendo la cedula de otro -> 403',
    r: '/facturas?documentNumber=8-222-2222', h: { Authorization: 'Bearer token-de-ana' }, esp: 403 },
  { n: 'token de Ana pidiendo SU cedula -> 200',
    r: '/facturas?documentNumber=8-111-1111', h: { Authorization: 'Bearer token-de-ana' }, esp: 200 },
  { n: 'token de Ana sin declarar cedula -> 200 (la pone el token)',
    r: '/facturas', h: { Authorization: 'Bearer token-de-ana' }, esp: 200 },
  { n: 'sin token -> 401',
    r: '/facturas?documentNumber=8-222-2222', h: {}, esp: 401 },
  { n: 'token invalido -> 401 (Moodle respondio)',
    r: '/facturas', h: { Authorization: 'Bearer token-invalido' }, esp: 401 },
  // La distincion que evita el cierre de sesion masivo.
  { n: 'Moodle caido -> 503, NUNCA 401',
    r: '/facturas', h: { Authorization: 'Bearer moodle-caido' }, esp: 503 },
  { n: 'cache degradada -> 200 con X-Auth-Degraded',
    r: '/facturas', h: { Authorization: 'Bearer token-degradado' }, esp: 200,
    cab: { 'x-auth-degraded': 'stale-cache' } },
  { n: 'cabecera X-Moodle-Token tambien vale -> 200',
    r: '/facturas', h: { 'X-Moodle-Token': 'token-de-ana' }, esp: 200 },
  // Servicio y admin.
  { n: 'tramite sin clave -> 401', r: '/tramite', m: 'POST', h: {}, esp: 401 },
  { n: 'tramite con clave -> 200', r: '/tramite', m: 'POST',
    h: { 'X-Api-Key': 'clave-servicio' }, esp: 200 },
  { n: 'admin sin secreto -> 401', r: '/admin', h: {}, esp: 401 },
  { n: 'admin con secreto -> 200', r: '/admin', h: { 'X-Admin-Secret': 'admin-secreto' }, esp: 200 },
];

const srv = app.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  let fallos = 0;

  for (const c of casos) {
    const res = await fetch(base + c.r, { method: c.m || 'GET', headers: c.h });
    let ok = res.status === c.esp;
    let detalle = `HTTP ${res.status}`;
    if (ok && c.cab) {
      for (const [k, v] of Object.entries(c.cab)) {
        if (res.headers.get(k) !== v) { ok = false; detalle += ` (falta ${k}: ${v})`; }
      }
    }
    if (!ok) fallos += 1;
    console.log(`${ok ? '  OK  ' : '  FALLO'}  ${c.n.padEnd(58)} [${detalle}]`);
  }

  console.log(fallos ? `\n${fallos} CASO(S) FALLIDO(S)` : '\nTODOS LOS CASOS PASAN');
  srv.close(() => process.exit(fallos ? 1 : 0));
});
