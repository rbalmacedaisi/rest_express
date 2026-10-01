/**
 * config.js — unico lugar del proyecto que lee process.env.
 *
 * Antes lo leian tres archivos por separado (server.js, odooApi.js y q10Api.js),
 * cada uno con sus propios valores por defecto. De ahi salia la combinacion
 * peligrosa que tenia el repositorio: ODOO_URL apuntaba por defecto a
 * PRODUCCION y ODOO_DB por defecto a STAGING. El guard de arranque validaba lo
 * que leia server.js, pero odooApi.js volvia a leer el entorno por su cuenta y
 * podia acabar en otro sitio.
 *
 * Dos reglas:
 *
 *   1. Ningun secreto ni ningun destino tiene valor por defecto. Si falta, el
 *      proceso no arranca. Un proxy que arranca con las credenciales publicadas
 *      en el repositorio es peor que un proxy que no arranca.
 *   2. Los pares entorno/destino validos estan en una tabla. Cualquier
 *      combinacion fuera de ella aborta. Se cierra por construccion, no por
 *      vigilancia.
 *
 * ORDEN DE DESPLIEGUE (importante): `pm2 restart` NO relee el entorno, reutiliza
 * el que guardo. Hay que poblar las variables y hacer `pm2 restart --update-env`
 * con el codigo ANTERIOR, comprobar con `pm2 env <id>` que estan todas, y solo
 * entonces desplegar este codigo. Al reves, el proceso entra en bucle de
 * reinicios.
 */

const faltantes = [];

/**
 * Minimal .env loader for the production secrets.
 *
 * We deliberately avoid pulling in `dotenv` so the dependency surface
 * stays small (this runs in the EC2 odoo-proxy container with npm
 * install --omit=dev). Rules:
 *
 *   - Reads `./.env` from process.cwd() if present.
 *   - Each non-comment, non-blank line is KEY=VALUE.
 *   - Values may be wrapped in single OR double quotes; both kinds of
 *     inner quotes are stripped.
 *   - Empty values, leading/trailing whitespace are tolerated.
 *   - Lines already set in process.env are NOT overridden, so a shell
 *     export beats .env (which matches Unix convention).
 *   - Variable expansion / interpolation is NOT supported; if you need
 *     ${OTHER}, just put the literal value.
 *   - The file must be readable only by the process user (root or
 *     ubuntu); chmod 600. The .env.example is the public template, the
 *     .env is the live one and lives in /home/ubuntu/odoo-proxy/.env.
 *
 * If the file is missing, the loader silently no-ops and the normal
 * fail-fast in this module runs against process.env.
 */
function loadDotEnv() {
    const fs = require('fs');
    const path = require('path');
    const filepath = path.join(process.cwd(), '.env');
    let raw;
    try {
        raw = fs.readFileSync(filepath, 'utf8');
    } catch (_) {
        // .env absent or unreadable: fall through to process.env only.
        return;
    }
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
loadDotEnv();

function requerido(nombre) {
  const valor = process.env[nombre];
  if (valor === undefined || valor === '') {
    faltantes.push(nombre);
    return undefined;
  }
  return valor;
}

function opcional(nombre, defecto) {
  const valor = process.env[nombre];
  return valor === undefined || valor === '' ? defecto : valor;
}

const cfg = {
  // --- Entorno ---
  odooEnv: opcional('ODOO_ENV', 'production').toLowerCase(),
  port: parseInt(opcional('PORT', '4000'), 10),

  // --- Odoo (destino + credenciales): sin valores por defecto ---
  odooUrl: requerido('ODOO_URL'),
  odooDb: requerido('ODOO_DB'),
  odooUser: requerido('ODOO_USER'),
  odooApiKey: requerido('ODOO_APIKEY'),

  // --- Moodle ---
  moodleUrl: requerido('MOODLE_URL'),
  moodleGraceToken: requerido('MOODLE_GRACE_TOKEN'),
  moodleLettersWebhookToken: requerido('MOODLE_LETTERS_WEBHOOK_TOKEN'),

  // --- Secretos compartidos ---
  adminSecret: requerido('ADMIN_SECRET'),
  proxyApiKey: requerido('ODOO_PROXY_API_KEY'),
  odooLettersWebhookSecret: requerido('ODOO_LETTERS_WEBHOOK_SECRET'),
  odooPaymentWebhookSecret: requerido('ODOO_PAYMENT_WEBHOOK_SECRET'),

  // --- CORS: lista blanca de origenes, separados por coma ---
  corsAllowedOrigins: opcional('CORS_ALLOWED_ORIGINS', '')
    .split(',').map((o) => o.trim()).filter(Boolean),
  corsReportOnly: opcional('CORS_REPORT_ONLY', '1') === '1',

  // --- TLS ---
  tlsKeyPath: opcional('TLS_KEY_PATH', '/home/ubuntu/odoo-proxy/certs/privkey.pem'),
  tlsCertPath: opcional('TLS_CERT_PATH', '/home/ubuntu/odoo-proxy/certs/fullchain.pem'),

  // --- Q10 (fuente financiera legacy, conmutable en runtime) ---
  // Caso aparte: si no esta configurado NO se aborta el arranque, porque la
  // fuente por defecto es Odoo y Q10 puede no usarse nunca. Lo que se hace es
  // impedir que alguien conmute a Q10 sin credenciales.
  q10Base: opcional('Q10_BASE', 'https://site2.q10.com'),
  q10User: process.env.Q10_USER || '',
  q10Pass: process.env.Q10_PASS || '',
  q10AplentId: process.env.Q10_APLENT_ID || '',
};

cfg.q10Configured = !!(cfg.q10User && cfg.q10Pass && cfg.q10AplentId);

// --- Fail-fast: nombres, nunca valores ---
if (faltantes.length) {
  console.error(
    '\n[boot] FALTAN VARIABLES DE ENTORNO OBLIGATORIAS:\n' +
    faltantes.map((n) => '  - ' + n).join('\n') +
    '\n\nNo se arranca con valores por defecto: los que habia en el codigo estan\n' +
    'publicados en el repositorio. Poblalas (AWS Secrets Manager -> entorno del\n' +
    'proceso) y reinicia con `pm2 restart odoo-proxy --update-env`.\n'
  );
  process.exit(1);
}

// --- Pares entorno/destino validos ---
const PARES_VALIDOS = {
  production: { host: 'odoo.isi.edu.pa', db: 'odoo_staging' },
  staging: { host: 'odoo.students.isi.edu.pa', db: 'odoo_staging' },
};

if (!PARES_VALIDOS[cfg.odooEnv] && cfg.odooEnv !== 'development') {
  console.error(`[boot] ODOO_ENV invalido: ${cfg.odooEnv}. Esperado: production | staging | development.`);
  process.exit(1);
}

if (PARES_VALIDOS[cfg.odooEnv]) {
  const esperado = PARES_VALIDOS[cfg.odooEnv];
  const hostReal = (() => {
    try { return new URL(cfg.odooUrl).hostname; } catch (e) { return ''; }
  })();
  if (hostReal !== esperado.host || cfg.odooDb !== esperado.db) {
    console.error(
      `[boot] La configuracion no corresponde al entorno declarado.\n` +
      `  ODOO_ENV=${cfg.odooEnv} espera host=${esperado.host} db=${esperado.db}\n` +
      `  pero se recibio host=${hostReal} db=${cfg.odooDb}\n` +
      `Abortando para no hablar con la base de datos equivocada.`
    );
    process.exit(1);
  }
}

console.log(
  `[boot] ODOO_ENV=${cfg.odooEnv} ODOO_URL=${cfg.odooUrl} ODOO_DB=${cfg.odooDb} ` +
  `MOODLE_URL=${cfg.moodleUrl} q10=${cfg.q10Configured ? 'configurado' : 'no configurado'} ` +
  `cors=${cfg.corsReportOnly ? 'report-only' : cfg.corsAllowedOrigins.length + ' origenes'}`
);

module.exports = cfg;
