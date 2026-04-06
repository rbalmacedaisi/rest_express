'use strict';

/**
 * Q10 API Client
 * Replicates the authentication and data extraction from q10-financial-status-v2.py
 * but as a persistent session module for the Express Server.
 *
 * Credentials are read from env vars:
 *   Q10_USER, Q10_PASS, Q10_APLENT_ID, Q10_BASE
 */

const https = require('https');
const http = require('http');

const Q10_BASE  = process.env.Q10_BASE      || 'https://site2.q10.com';
const Q10_USER  = process.env.Q10_USER      || 'q10@isi.edu.pa';
const Q10_PASS  = process.env.Q10_PASS      || 'taswi4-penhEp-fecmij';
const Q10_APLENT = process.env.Q10_APLENT_ID || '5f0cac06-a506-459a-a7b8-364b50574728';

const RELOGIN_INTERVAL_MS = 270 * 1000; // Re-login before the 300s Q10 session expires
const REQ_DELAY_MS        = 250;        // Delay between requests to avoid throttling

// ---------------------------------------------------------------------------
// Cookie jar: stores session cookies across requests
// ---------------------------------------------------------------------------
class CookieJar {
  constructor() { this._c = {}; }

  update(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const h of arr) {
      const pair = h.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name  = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this._c[name] = value;
    }
  }

  toString() {
    return Object.entries(this._c).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ---------------------------------------------------------------------------
// HTML helpers (mirror of the Python helpers in the script)
// ---------------------------------------------------------------------------
function htmlUnescape(text) {
  return text
    .replace(/&#193;/g, 'Á').replace(/&#225;/g, 'á')
    .replace(/&#201;/g, 'É').replace(/&#233;/g, 'é')
    .replace(/&#205;/g, 'Í').replace(/&#237;/g, 'í')
    .replace(/&#211;/g, 'Ó').replace(/&#243;/g, 'ó')
    .replace(/&#218;/g, 'Ú').replace(/&#250;/g, 'ú')
    .replace(/&#209;/g, 'Ñ').replace(/&#241;/g, 'ñ')
    .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ').replace(/&amp;/g, '&');
}

function cleanHtml(t) {
  t = htmlUnescape(t);
  t = t.replace(/<[^>]+>/g, '').trim();
  return t.replace(/\s+/g, ' ').trim();
}

function parseBalboa(text) {
  const m = String(text).match(/B\/\.([0-9,]+\.?\d*)/);
  if (!m) return 0.0;
  return parseFloat(m[1].replace(/,/g, ''));
}

// Convert "DD/MM/YYYY" → "YYYY-MM-DD" for invoice_date_due compatibility
function convertDate(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const parts = String(ddmmyyyy).trim().split('/');
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Q10Client: manages a persistent authenticated session
// ---------------------------------------------------------------------------
class Q10Client {
  constructor() {
    this._jar        = new CookieJar();
    this._lastLogin  = 0;
    this._loginPromise = null; // Guard against concurrent login attempts
  }

  // -------------------------------------------------------------------------
  // Low-level HTTP request with cookie jar support
  // -------------------------------------------------------------------------
  _request(method, url, options = {}) {
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${url}`));
      }

      const body = options.body || null;
      let bodyStr = null;
      if (body) {
        if (typeof body === 'string') {
          bodyStr = body;
        } else {
          bodyStr = Object.entries(body)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
        }
      }

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        ...(options.headers || {}),
      };

      const cookieStr = this._jar.toString();
      if (cookieStr) headers['Cookie'] = cookieStr;

      if (bodyStr) {
        headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   method.toUpperCase(),
        headers,
        rejectUnauthorized: false,
      };

      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const req = transport.request(reqOptions, (res) => {
        if (res.headers['set-cookie']) {
          this._jar.update(res.headers['set-cookie']);
        }

        // Follow redirects (unless explicitly disabled)
        if ([301, 302, 303].includes(res.statusCode) && res.headers['location']) {
          if (options.followRedirect !== false) {
            const loc = res.headers['location'];
            const redirectUrl = loc.startsWith('http')
              ? loc
              : `${parsedUrl.protocol}//${parsedUrl.host}${loc}`;
            res.resume(); // Drain response body before following
            resolve(this._request('GET', redirectUrl, { ...options, body: null }));
            return;
          }
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, text: data });
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(new Error('Q10 request timeout')); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Multi-step authentication (mirrors Q10Session.login() in the Python script)
  // -------------------------------------------------------------------------
  login() {
    if (this._loginPromise) return this._loginPromise; // Avoid concurrent logins
    this._loginPromise = this._doLogin().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  async _doLogin() {
    console.log('[Q10] Starting login...');
    this._jar = new CookieJar(); // Reset session cookies

    // Step 1: GET login page to initialise session cookies
    await this._request('GET', `${Q10_BASE}/login?ReturnUrl=%2F&aplentId=${Q10_APLENT}`);

    // Step 2: POST credentials → get inst_t token
    const r2 = await this._request('POST', `${Q10_BASE}/Login?returnUrl=%2F&aplentId=${Q10_APLENT}`, {
      body: { NombreUsuario: Q10_USER, Contrasena: Q10_PASS, Recordarme: 'false' },
    });
    const instT = (r2.text.match(/id="inst_t"[^>]*value="([^"]+)"/) || [])[1];
    if (!instT) throw new Error('[Q10] inst_t token not found');

    // Step 3: Select institution → get rol_t token
    const r3 = await this._request('POST', `${Q10_BASE}/Instituciones`, {
      body: { inst_t: instT, aplentId: Q10_APLENT },
    });
    const rolT = (r3.text.match(/id="rol_t"[^>]*value="([^"]+)"/) || [])[1];
    if (!rolT) throw new Error('[Q10] rol_t token not found');

    // Step 4: Select role → get ta token (follows redirects automatically)
    const r4 = await this._request('POST', `${Q10_BASE}/Roles`, {
      body: { rol_t: rolT, roleId: '0', aplent: '', studentId: '', esSso: 'False' },
    });
    const ta = (r4.text.match(/id="ta"[^>]*value="([^"]+)"/) || [])[1];
    if (!ta) throw new Error('[Q10] ta token not found');

    // Step 5: Final authentication — do NOT follow redirect, capture Location header
    const r5 = await this._request('POST', `${Q10_BASE}/AutenticarUsuario`, {
      body: { codigoSeguridad: '', ta },
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      followRedirect: false,
    });

    // Step 6: Follow the final redirect and verify login
    const loc = r5.headers['location'];
    if (!loc) throw new Error('[Q10] No Location header after AutenticarUsuario');
    const finalUrl = loc.startsWith('http') ? loc : `${Q10_BASE}${loc}`;
    const r6 = await this._request('GET', finalUrl);
    if (!r6.text.includes('Cerrar')) throw new Error('[Q10] Login verification failed');

    this._lastLogin = Date.now();
    console.log('[Q10] Login successful');
  }

  async _ensureSession() {
    if (!this._lastLogin || (Date.now() - this._lastLogin > RELOGIN_INTERVAL_MS)) {
      await this.login();
    }
  }

  // -------------------------------------------------------------------------
  // Authenticated GET with retry logic (mirrors Q10Session.get())
  // -------------------------------------------------------------------------
  async _get(path, retries = 3) {
    await sleep(REQ_DELAY_MS);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await this._request('GET', `${Q10_BASE}${path}`);
        if (res.statusCode === 200) return res;
        // If session expired (unexpected redirect to login)
        if (res.statusCode === 302 || res.text.includes('NombreUsuario')) {
          console.warn(`[Q10] Session appears expired, re-logging in...`);
          this._lastLogin = 0;
          await this.login();
          await sleep(REQ_DELAY_MS);
          continue;
        }
        return res;
      } catch (err) {
        if (attempt < retries - 1) {
          console.warn(`[Q10] Attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
          await sleep(5000 * Math.pow(2, attempt));
          this._lastLogin = 0;
          await this.login();
        } else {
          throw err;
        }
      }
    }
    throw new Error(`[Q10] All ${retries} retries exhausted`);
  }

  // -------------------------------------------------------------------------
  // Find student by document number (cedula)
  // Returns { id, name } or null
  // -------------------------------------------------------------------------
  async findStudent(documentNumber) {
    const res = await this._get(`/Personas/Lista?texto=${encodeURIComponent(documentNumber)}&pagina=1`);
    if (res.statusCode !== 200) return null;
    // Match: href="/Estudiante/{id}">Name</a></td> <td>extra</td>
    const m = res.text.match(/href="\/Estudiante\/(\d+)">([^<]+)<\/a><\/td>\s*<td>([^<]+)<\/td>/);
    if (!m) return null;
    return { id: m[1], name: cleanHtml(m[2]) };
  }

  // -------------------------------------------------------------------------
  // Get all credit IDs for a student (main + dropdown)
  // -------------------------------------------------------------------------
  async getCreditIds(studentId) {
    const res = await this._get(`/Estudiante/${studentId}/Creditos`);
    if (res.statusCode !== 200) return [];
    const text = res.text;

    const mainMatch = text.match(/id="divDetalle"[^>]+data-url="[^"]*Credito\/(\d+)\/Detalle"/);
    const mainId    = mainMatch ? mainMatch[1] : null;
    const dropdownIds = [...text.matchAll(/class="cambiar"[^>]+data-credito="(\d+)"/g)].map(m => m[1]);

    const all = [];
    if (mainId) all.push(mainId);
    for (const id of dropdownIds) {
      if (!all.includes(id)) all.push(id);
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // Parse credit detail HTML → { labelStatus, cuotasPendientes }
  // Mirrors extract_single_credit() and get_pending_cuotas() in the Python script
  // -------------------------------------------------------------------------
  _parseCreditDetail(html) {
    const textDec = htmlUnescape(html);

    // Determine status from Bootstrap label classes
    let labelStatus = 'unknown';
    let m = textDec.match(/class="label label-success"[^>]*>([^<]+)<\/label>/);
    if (m) {
      labelStatus = cleanHtml(m[1]).includes('Paz') ? 'paz_y_salvo' : 'al_dia';
    } else {
      m = textDec.match(/class="label label-danger"[^>]*>([^<]+)<\/label>/);
      if (m) {
        labelStatus = 'mora';
      } else {
        m = textDec.match(/class="label label-warning"[^>]*>([^<]+)<\/label>/);
        if (m) labelStatus = 'pendiente'; // Treat as mora (conservative)
      }
    }

    // Extract pending cuotas from the "Cuotas programadas" table
    const cuotasPendientes = [];
    const sectionMatch = html.match(/Cuotas programadas([\s\S]+?)(?=Pagos realizados|Abono|Registrar|Agregar)/);
    if (sectionMatch) {
      const rows = [...sectionMatch[1].matchAll(/<tr[^>]*>([\s\S]+?)<\/tr>/g)];
      for (const row of rows.slice(1)) { // Skip header row
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]+?)<\/td>/g)].map(c => c[1]);
        if (cells.length < 8) continue;
        const pendienteText = cleanHtml(cells[7]);
        if (pendienteText.toUpperCase().includes('PAGADO')) continue;
        const pendiente = parseBalboa(cells[7]);
        if (pendiente <= 0) continue;
        cuotasPendientes.push({
          nro:      cleanHtml(cells[0]),
          fecha:    cleanHtml(cells[1]),
          total:    parseBalboa(cells[5]),
          pendiente,
        });
      }
    }

    return { labelStatus, cuotasPendientes };
  }

  // -------------------------------------------------------------------------
  // Public: get financial status for a single student
  // Returns { allowed, reason, cuotasPendientes }
  // -------------------------------------------------------------------------
  async getStudentStatus(documentNumber) {
    await this._ensureSession();

    const student = await this.findStudent(documentNumber);
    if (!student) {
      console.log(`[Q10] Student not found: ${documentNumber}`);
      return { allowed: false, reason: 'sin_contrato_o_usuario', cuotasPendientes: [] };
    }

    const creditIds = await this.getCreditIds(student.id);
    if (!creditIds.length) {
      console.log(`[Q10] No credits found for student: ${documentNumber} (ID: ${student.id})`);
      return { allowed: false, reason: 'sin_contrato_o_usuario', cuotasPendientes: [] };
    }

    let hasMoraLabel = false;
    const allCuotasPendientes = [];

    for (const cid of creditIds) {
      const res = await this._get(`/Estudiante/${student.id}/Credito/${cid}/Detalle`);
      if (res.statusCode !== 200) {
        console.warn(`[Q10] Could not fetch credit ${cid} for student ${documentNumber}: HTTP ${res.statusCode}`);
        continue;
      }
      const { labelStatus, cuotasPendientes } = this._parseCreditDetail(res.text);
      if (labelStatus === 'mora' || labelStatus === 'pendiente') {
        hasMoraLabel = true;
      }
      allCuotasPendientes.push(...cuotasPendientes);
    }

    // Student is in mora if: explicit danger label OR has cuotas with positive balance
    if (hasMoraLabel || allCuotasPendientes.length > 0) {
      console.log(`[Q10] MORA for ${documentNumber}: label=${hasMoraLabel}, cuotas=${allCuotasPendientes.length}`);
      return { allowed: false, reason: 'mora', cuotasPendientes: allCuotasPendientes };
    }

    console.log(`[Q10] AL DÍA for ${documentNumber}`);
    return { allowed: true, reason: 'al_dia', cuotasPendientes: [] };
  }

  // -------------------------------------------------------------------------
  // Public: get financial status for multiple students (sequential with delay)
  // Returns { documentNumber: { allowed, reason, cuotasPendientes } }
  // -------------------------------------------------------------------------
  async getStudentStatusBulk(documentNumbers) {
    const results = {};
    for (const doc of documentNumbers) {
      try {
        results[doc] = await this.getStudentStatus(doc);
      } catch (err) {
        console.error(`[Q10] Error getting status for ${doc}:`, err.message);
        results[doc] = { allowed: false, reason: 'sin_contrato_o_usuario', cuotasPendientes: [] };
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Convert Q10 cuotasPendientes to Odoo invoice format
  // (for compatibility with /api/odoo/invoices consumers — restriccion-pago.vue)
  // -------------------------------------------------------------------------
  cuotasToInvoices(cuotasPendientes) {
    return (cuotasPendientes || []).map((cuota, idx) => ({
      id:               `q10_cuota_${idx + 1}`,
      name:             `Cuota ${cuota.nro}`,
      amount_total:     cuota.total,
      amount_residual:  cuota.pendiente,
      invoice_date_due: convertDate(cuota.fecha),
      state:            'posted',
      enlacePago:       null,
    }));
  }
}

// ---------------------------------------------------------------------------
// Export singleton — shared session across all requests
// ---------------------------------------------------------------------------
module.exports = new Q10Client();
