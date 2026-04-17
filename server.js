const express = require('express');
const cors = require('cors');
const OdooAPI = require('./odooApi');
const q10Api  = require('./q10Api');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- BYPASS FINANCIERO GLOBAL ---
// Secret para proteger el endpoint admin (cámbialo en producción)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'gmk_admin_bypass_2026';

// --- PERIODO DE GRACIA (primer login) ---
const MOODLE_URL         = process.env.MOODLE_URL         || 'https://lms.isi.edu.pa';
const MOODLE_GRACE_TOKEN = process.env.MOODLE_GRACE_TOKEN || 'gmk_grace_check_2026';
const MOODLE_LETTERS_WEBHOOK_URL = process.env.MOODLE_LETTERS_WEBHOOK_URL || `${MOODLE_URL}/local/grupomakro_core/letters_webhook.php`;
const MOODLE_LETTERS_WEBHOOK_TOKEN = process.env.MOODLE_LETTERS_WEBHOOK_TOKEN || 'gmk_letter_webhook_2026';
const ODOO_LETTERS_WEBHOOK_SECRET = process.env.ODOO_LETTERS_WEBHOOK_SECRET || 'gmk_letters_hmac_2026';
const ODOO_BASE_URL = process.env.ODOO_URL || 'https://odoo.isi.edu.pa';

/**
 * Consult Moodle to check if a student is in their first-login grace period.
 * Returns true if inGrace, false otherwise (including on error — fail open).
 */
async function checkGracePeriod(documentNumber) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      action: 'local_grupomakro_check_grace_period',
      documentnumber: documentNumber,
      token: MOODLE_GRACE_TOKEN,
    });
    const url = `${MOODLE_URL}/local/grupomakro_core/ajax.php?${params}`;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      rejectUnauthorized: false,
    };
    const lib = parsedUrl.protocol === 'https:' ? https : require('http');
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.inGrace === true ? json : false);
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', (e) => {
      console.warn(`[GRACE] Error consultando periodo de gracia: ${e.message}`);
      resolve(false);
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}
const BYPASS_CONFIG_FILE = path.join(__dirname, 'bypass_config.json');

function loadBypassConfig() {
  try {
    if (fs.existsSync(BYPASS_CONFIG_FILE)) {
      const raw = fs.readFileSync(BYPASS_CONFIG_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[BYPASS] Error leyendo bypass_config.json:', e.message);
  }
  return { enabled: false, updatedAt: null, updatedBy: null };
}

function saveBypassConfig(config) {
  try {
    fs.writeFileSync(BYPASS_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[BYPASS] Error guardando bypass_config.json:', e.message);
  }
}

// Cargar estado inicial desde disco
let bypassConfig = loadBypassConfig();
console.log(`[BYPASS] Estado inicial: ${bypassConfig.enabled ? 'ACTIVADO' : 'desactivado'}`);

// --- FUENTE DE DATOS FINANCIEROS (Q10 / Odoo) ---
const FINANCIAL_SOURCE_CONFIG_FILE = path.join(__dirname, 'financial_source_config.json');

function loadFinancialSourceConfig() {
  try {
    if (fs.existsSync(FINANCIAL_SOURCE_CONFIG_FILE)) {
      const raw = fs.readFileSync(FINANCIAL_SOURCE_CONFIG_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[FINANCIAL_SOURCE] Error leyendo config:', e.message);
  }
  return { source: 'odoo', updatedAt: null, updatedBy: null };
}

function saveFinancialSourceConfig(config) {
  try {
    fs.writeFileSync(FINANCIAL_SOURCE_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[FINANCIAL_SOURCE] Error guardando config:', e.message);
  }
}

let financialSourceConfig = loadFinancialSourceConfig();
console.log(`[FINANCIAL_SOURCE] Fuente inicial: ${financialSourceConfig.source}`);

const app = express();

// Middleware de logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('Headers:', req.headers);
  console.log('IP:', req.ip);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  next();
});

app.use(cors());
app.use(express.json());

// --- CACHE IMPLEMENTATION ---
const studentStatusCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Helper to get from cache
function getCachedStatus(documentNumber) {
  if (!studentStatusCache.has(documentNumber)) return null;
  const { timestamp, data } = studentStatusCache.get(documentNumber);
  if (Date.now() - timestamp > CACHE_TTL_MS) {
    studentStatusCache.delete(documentNumber);
    return null;
  }
  return data;
}

// Helper to set cache
function setCachedStatus(documentNumber, data) {
  studentStatusCache.set(documentNumber, {
    timestamp: Date.now(),
    data
  });
}

// --- LETTER REQUESTS (Moodle <-> Express <-> Odoo) ---
const letterInvoiceCache = new Map();
const letterAttachmentCache = new Map();
const processedLetterWebhookEvents = new Map();
const LETTER_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function cleanupProcessedLetterEvents() {
  const now = Date.now();
  for (const [key, timestamp] of processedLetterWebhookEvents.entries()) {
    if (now - timestamp > LETTER_EVENT_TTL_MS) {
      processedLetterWebhookEvents.delete(key);
    }
  }
}

function normalizePaymentLink(accessUrl) {
  if (!accessUrl) return '';
  try {
    if (typeof accessUrl === 'string' && accessUrl.startsWith('/')) {
      return new URL(accessUrl, ODOO_BASE_URL).toString();
    }
    const parsed = new URL(accessUrl);
    const configured = new URL(ODOO_BASE_URL);
    if (parsed.hostname === configured.hostname) {
      parsed.port = '';
      return parsed.toString();
    }
    return accessUrl;
  } catch (error) {
    return accessUrl;
  }
}

function buildLetterRef(externalRequestId) {
  return `LETTER_REQ:${String(externalRequestId).trim()}`;
}

function canonicalWebhookPayload(payload) {
  const source = payload || {};
  const normalized = {
    invoice_id: String(source.invoice_id || ''),
    invoice_number: String(source.invoice_number || ''),
    payment_state: String(source.payment_state || ''),
    partner_vat: String(source.partner_vat || ''),
    external_request_id: String(source.external_request_id || ''),
    event_time: String(source.event_time || ''),
  };
  return JSON.stringify(normalized);
}

function signWebhookPayload(payload) {
  const canonical = canonicalWebhookPayload(payload);
  return crypto
    .createHmac('sha256', ODOO_LETTERS_WEBHOOK_SECRET)
    .update(canonical)
    .digest('hex');
}

function verifyWebhookSignature(payload, signature) {
  if (!signature) return false;
  const expected = signWebhookPayload(payload);
  const received = String(signature).replace(/^sha256=/i, '').trim().toLowerCase();
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch (error) {
    return false;
  }
}

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const jsonPayload = JSON.stringify(payload);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonPayload),
        ...headers,
      },
    };

    const transport = parsedUrl.protocol === 'https:' ? https : require('http');
    const req = transport.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch (error) {
          parsed = null;
        }
        resolve({
          statusCode: res.statusCode || 0,
          body,
          json: parsed,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('request_timeout'));
    });
    req.write(jsonPayload);
    req.end();
  });
}

async function findPartnerByDocument(odoo, documentNumber) {
  const partners = await odoo.call('res.partner', 'search_read', [[['vat', '=', String(documentNumber).trim()]]], {
    fields: ['id', 'name', 'email', 'vat'],
    limit: 1,
  });
  return partners && partners.length ? partners[0] : null;
}

async function findLetterInvoiceByRef(odoo, externalRequestId) {
  const ref = buildLetterRef(externalRequestId);
  const invoices = await odoo.call('account.move', 'search_read', [[
    ['ref', '=', ref],
    ['move_type', '=', 'out_invoice'],
  ]], {
    fields: ['id', 'name', 'ref', 'partner_id', 'payment_state', 'state', 'access_url'],
    order: 'id desc',
    limit: 1,
  });
  return invoices && invoices.length ? invoices[0] : null;
}

async function readLetterInvoiceById(odoo, invoiceId) {
  const invoices = await odoo.call('account.move', 'search_read', [[
    ['id', '=', Number(invoiceId)],
    ['move_type', '=', 'out_invoice'],
  ]], {
    fields: ['id', 'name', 'ref', 'partner_id', 'payment_state', 'state', 'access_url'],
    limit: 1,
  });
  return invoices && invoices.length ? invoices[0] : null;
}

app.post('/api/odoo/letters/invoice', async (req, res) => {
  try {
    const externalRequestId = String(req.body?.external_request_id || '').trim();
    const documentNumber = String(req.body?.document_number || '').trim();
    const amount = Number(req.body?.amount);
    const requestedProductId = Number(req.body?.odoo_product_id || 0);

    if (!externalRequestId || !documentNumber || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'external_request_id, document_number and amount > 0 are required',
      });
    }

    if (letterInvoiceCache.has(externalRequestId)) {
      return res.json({
        ...letterInvoiceCache.get(externalRequestId),
        idempotent: true,
      });
    }

    const odoo = new OdooAPI();
    let invoice = await findLetterInvoiceByRef(odoo, externalRequestId);

    if (!invoice) {
      const partner = await findPartnerByDocument(odoo, documentNumber);
      if (!partner) {
        return res.status(404).json({
          success: false,
          error: `partner_not_found_for_document:${documentNumber}`,
        });
      }

      const fallbackProductId = Number(process.env.ODOO_LETTERS_DEFAULT_PRODUCT_ID || 0);
      const productId = requestedProductId > 0 ? requestedProductId : fallbackProductId;
      if (productId <= 0) {
        return res.status(400).json({
          success: false,
          error: "odoo_product_id_required",
        });
      }

      const lineValues = {
        name: String(req.body?.description || `Solicitud de carta (#${externalRequestId})`),
        quantity: 1,
        price_unit: amount,
        product_id: productId,
      };

      const invoiceValues = {
        move_type: 'out_invoice',
        partner_id: partner.id,
        ref: buildLetterRef(externalRequestId),
        invoice_origin: String(req.body?.letter_type_code || ''),
        invoice_date: new Date().toISOString().slice(0, 10),
        invoice_line_ids: [[0, 0, lineValues]],
      };

      const invoiceId = await odoo.call('account.move', 'create', [invoiceValues]);
      await odoo.call('account.move', 'action_post', [[invoiceId]]);
      invoice = await readLetterInvoiceById(odoo, invoiceId);
    }

    if (!invoice) {
      return res.status(500).json({
        success: false,
        error: 'invoice_not_created',
      });
    }

    const responsePayload = {
      success: true,
      invoice_id: String(invoice.id),
      invoice_number: String(invoice.name || ''),
      payment_link: normalizePaymentLink(invoice.access_url || ''),
      external_request_id: externalRequestId,
    };
    letterInvoiceCache.set(externalRequestId, responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('[letters/invoice] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post('/api/odoo/letters/attach-document', async (req, res) => {
  try {
    const externalRequestId = String(req.body?.external_request_id || '').trim();
    const documentNumber = String(req.body?.document_number || '').trim();
    const filename = String(req.body?.filename || '').trim();
    const mimetype = String(req.body?.mimetype || 'application/pdf').trim();
    const invoiceId = String(req.body?.invoice_id || '').trim();
    const rawBase64 = String(req.body?.content_base64 || '').trim();
    const contentBase64 = rawBase64.replace(/^data:.*;base64,/i, '');

    if (!externalRequestId || !filename || !contentBase64) {
      return res.status(400).json({
        success: false,
        error: 'external_request_id, filename and content_base64 are required',
      });
    }

    const cacheKey = `${externalRequestId}:${invoiceId}:${filename}`;
    if (letterAttachmentCache.has(cacheKey)) {
      return res.json({
        ...letterAttachmentCache.get(cacheKey),
        idempotent: true,
      });
    }

    const odoo = new OdooAPI();
    let targetModel = '';
    let targetId = 0;

    let invoice = null;
    if (invoiceId) {
      invoice = await readLetterInvoiceById(odoo, invoiceId);
    }
    if (!invoice && externalRequestId) {
      invoice = await findLetterInvoiceByRef(odoo, externalRequestId);
    }

    if (invoice) {
      targetModel = 'account.move';
      targetId = Number(invoice.id);
    } else {
      if (!documentNumber) {
        return res.status(400).json({
          success: false,
          error: 'document_number is required when invoice is not available',
        });
      }
      const partner = await findPartnerByDocument(odoo, documentNumber);
      if (!partner) {
        return res.status(404).json({
          success: false,
          error: `partner_not_found_for_document:${documentNumber}`,
        });
      }
      targetModel = 'res.partner';
      targetId = Number(partner.id);
    }

    const description = buildLetterRef(externalRequestId);
    const existing = await odoo.call('ir.attachment', 'search_read', [[
      ['res_model', '=', targetModel],
      ['res_id', '=', targetId],
      ['name', '=', filename],
      ['description', '=', description],
    ]], {
      fields: ['id', 'name'],
      limit: 1,
    });

    let attachmentId = 0;
    if (existing && existing.length) {
      attachmentId = Number(existing[0].id);
    } else {
      attachmentId = Number(await odoo.call('ir.attachment', 'create', [{
        name: filename,
        datas: contentBase64,
        mimetype,
        type: 'binary',
        res_model: targetModel,
        res_id: targetId,
        description,
      }]));
    }

    const responsePayload = {
      success: true,
      attachment_id: String(attachmentId),
      res_model: targetModel,
      res_id: targetId,
      external_request_id: externalRequestId,
    };
    letterAttachmentCache.set(cacheKey, responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('[letters/attach-document] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post('/api/odoo/letters/webhook/payment', async (req, res) => {
  try {
    cleanupProcessedLetterEvents();

    const payload = req.body || {};
    const signature = req.headers['x-odoo-signature'] || payload.signature || '';
    if (!verifyWebhookSignature(payload, signature)) {
      return res.status(401).json({
        success: false,
        error: 'invalid_signature',
      });
    }

    if (String(payload.payment_state || '') !== 'paid') {
      return res.json({
        success: true,
        ignored: true,
        reason: 'payment_state_not_paid',
      });
    }

    const eventKey = [
      String(payload.invoice_id || ''),
      String(payload.payment_state || ''),
      String(payload.event_time || ''),
      String(payload.external_request_id || ''),
    ].join('|');

    if (processedLetterWebhookEvents.has(eventKey)) {
      return res.json({
        success: true,
        idempotent: true,
        event_key: eventKey,
      });
    }

    const moodlePayload = {
      invoice_id: String(payload.invoice_id || ''),
      invoice_number: String(payload.invoice_number || ''),
      payment_state: String(payload.payment_state || ''),
      partner_vat: String(payload.partner_vat || ''),
      external_request_id: String(payload.external_request_id || ''),
      event_time: String(payload.event_time || ''),
    };

    const moodleResponse = await postJson(
      MOODLE_LETTERS_WEBHOOK_URL,
      moodlePayload,
      { 'X-Webhook-Token': MOODLE_LETTERS_WEBHOOK_TOKEN }
    );

    if (moodleResponse.statusCode < 200 || moodleResponse.statusCode >= 300 || moodleResponse.json?.success === false) {
      console.error('[letters/webhook/payment] Moodle webhook failed:', moodleResponse);
      return res.status(502).json({
        success: false,
        error: 'moodle_webhook_failed',
        moodle_status: moodleResponse.statusCode,
        moodle_response: moodleResponse.json || moodleResponse.body,
      });
    }

    processedLetterWebhookEvents.set(eventKey, Date.now());
    res.json({
      success: true,
      forwarded: true,
      moodle: moodleResponse.json || {},
    });
  } catch (error) {
    console.error('[letters/webhook/payment] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get('/api/odoo/invoices', async (req, res) => {
  try {
    const documentNumber = req.query.documentNumber;
    const partnerId = req.query.partnerId;

    if (!documentNumber && !partnerId) {
      return res.status(400).json({ error: 'Se requiere documentNumber o partnerId' });
    }

    // Fuente Q10 (migración temporal) — solo aplica cuando tenemos documentNumber
    if (financialSourceConfig.source === 'q10' && documentNumber) {
      try {
        console.log(`[Q10] Obteniendo cuotas (invoices) para: ${documentNumber}`);
        const q10Result = await q10Api.getStudentStatus(documentNumber);
        const invoices = q10Api.cuotasToInvoices(q10Result.cuotasPendientes || []);
        return res.json(invoices);
      } catch (q10Err) {
        console.error(`[Q10] Error obteniendo cuotas para ${documentNumber}:`, q10Err.message);
        return res.status(500).json({ error: 'Q10 query failed: ' + q10Err.message });
      }
    }

    const odoo = new OdooAPI();
    let finalPartnerId = partnerId;

    // Si solo tenemos documentNumber, buscamos el partnerId
    if (!partnerId && documentNumber) {
      console.log(`Buscando partnerId para documento: ${documentNumber}`);
      const partners = await odoo.call('res.partner', 'search_read',
        [[['vat', '=', documentNumber]]],
        { fields: ['id', 'name'] }
      );

      if (!partners.length) {
        console.log(`No se encontró partner para documento: ${documentNumber}`);
        return res.json([]);
      }

      finalPartnerId = partners[0].id;
      console.log(`Partner encontrado: ${partners[0].name} (ID: ${finalPartnerId})`);
    }

    // Obtenemos las facturas usando el partnerId
    console.log(`Buscando facturas para partnerId: ${finalPartnerId}`);
    const invoices = await odoo.call(
      'account.move',
      'search_read',
      [[['partner_id', '=', parseInt(finalPartnerId)], ['move_type', '=', 'out_invoice']]],
      {
        fields: ['id', 'amount_total', 'state', 'invoice_date_due', 'name', 'amount_residual', 'access_url'],
        order: 'invoice_date_due desc'
      }
    );

    console.log(`Se encontraron ${invoices.length} facturas`);

    // --- LOG PARA INSPECCIONAR FACTURAS RECIBIDAS DE ODOO ---
    console.log('Facturas recibidas de Odoo:', JSON.stringify(invoices, null, 2));
    // ------------------------------------------------------

    // Mapeamos las facturas para incluir el enlace de pago con el nombre esperado por el frontend
    const invoicesWithPaymentLink = invoices.map(invoice => {
      let paymentLink = invoice.access_url;
      const odooBaseUrl = process.env.ODOO_URL || 'https://odoo.isi.edu.pa';

      try {
        let urlObj;

        // Caso 1: Path relativo
        if (paymentLink && typeof paymentLink === 'string' && paymentLink.startsWith('/')) {
          const baseUrl = new URL(odooBaseUrl);
          baseUrl.port = ''; // Asegurar que la base no tenga puerto
          urlObj = new URL(paymentLink, baseUrl);
        }
        // Caso 2: URL Absoluta (que podría tener el puerto 8069)
        else if (paymentLink && typeof paymentLink === 'string' && paymentLink.startsWith('http')) {
          urlObj = new URL(paymentLink);
          // Si el host coincide con el de nuestra config de Odoo, limpiamos el puerto
          const baseHost = new URL(odooBaseUrl).hostname;
          if (urlObj.hostname === baseHost) {
            urlObj.port = '';
          }
        }

        if (urlObj) {
          paymentLink = urlObj.toString();
        }
      } catch (e) {
        console.error('Error al procesar URL de pago:', paymentLink, e);
      }

      return ({
        id: invoice.id,
        name: invoice.name,
        amount_total: invoice.amount_total,
        state: invoice.state,
        invoice_date_due: invoice.invoice_date_due,
        amount_residual: invoice.amount_residual,
        enlacePago: paymentLink // <-- Usamos el enlace correctamente formateado
      });
    });

    // --- LOG PARA INSPECCIONAR LA RESPUESTA FINAL ANTES DE ENVIAR ---
    console.log('Respuesta final de facturas con enlaces de pago:', JSON.stringify(invoicesWithPaymentLink, null, 2));
    // --------------------------------------------------------------

    res.json(invoicesWithPaymentLink);
  } catch (err) {
    console.error('Error en /api/odoo/invoices:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/odoo/partner-contract-type', async (req, res) => {
  try {
    const documentNumber = req.query.documentNumber;

    if (!documentNumber) {
      return res.status(400).json({ error: 'Se requiere documentNumber' });
    }

    const odoo = new OdooAPI();

    console.log(`Buscando tipo de contrato para documento: ${documentNumber}`);
    const partners = await odoo.call('res.partner', 'search_read',
      [[['vat', '=', documentNumber]]],
      { fields: ['x_studio_tipo_contrato_especial'] }
    );

    if (!partners.length) {
      console.log(`No se encontró partner para documento: ${documentNumber}`);
      return res.json({ contractType: null });
    }

    // Devolvemos el campo específico
    const contractType = partners[0].x_studio_tipo_contrato_especial || null;
    console.log(`Tipo de contrato encontrado: ${contractType}`);

    res.json({ contractType });

  } catch (err) {
    console.error('Error en /api/odoo/partner-contract-type:', err);
    res.status(500).json({ error: err.message });
  }
});

// NUEVO ENDPOINT: Verificar Estado del Estudiante (Con Caché)
app.get('/api/odoo/status', async (req, res) => {
  try {
    const documentNumber = req.query.documentNumber;

    if (!documentNumber) {
      return res.status(400).json({ error: 'Se requiere documentNumber' });
    }

    // 0. Bypass Global: Ignorar Estado Financiero en Login
    if (bypassConfig.enabled) {
      console.log(`[BYPASS] Acceso PERMITIDO por bypass global para: ${documentNumber}`);
      return res.json({ allowed: true, reason: 'bypass_financiero' });
    }

    // 0.1 Periodo de Gracia: primer mes del estudiante
    try {
      const graceResult = await checkGracePeriod(documentNumber);
      if (graceResult) {
        console.log(`[GRACE] Acceso PERMITIDO por periodo de gracia para: ${documentNumber}`);
        return res.json({ allowed: true, reason: 'periodo_gracia', graceuntil: graceResult.graceuntil });
      }
    } catch (graceErr) {
      // Si falla, continúa con validación Odoo normal
      console.warn(`[GRACE] Error en checkGracePeriod: ${graceErr.message}`);
    }

    // 1. Verificar Caché
    const cached = getCachedStatus(documentNumber);
    if (cached) {
      console.log(`[CACHE] Sirviendo estado desde caché para: ${documentNumber}`);
      return res.json(cached);
    }

    // 2. Fuente Q10 (migración temporal)
    if (financialSourceConfig.source === 'q10') {
      // Pre-check: contrato especial en Odoo, independiente de la fuente financiera
      try {
        const odooC = new OdooAPI();
        const cPartners = await odooC.call('res.partner', 'search_read',
          [[['vat', '=', documentNumber]]],
          { fields: ['x_studio_tipo_contrato_especial'], limit: 1 }
        );
        if (cPartners.length > 0 && cPartners[0].x_studio_tipo_contrato_especial) {
          const result = { allowed: true, reason: 'contrato_especial' };
          console.log(`[STATUS] Acceso PERMITIDO (Contrato Especial: ${cPartners[0].x_studio_tipo_contrato_especial} / Q10-path) para: ${documentNumber}`);
          setCachedStatus(documentNumber, result);
          return res.json(result);
        }
      } catch (odooContractErr) {
        console.warn(`[STATUS] No se pudo verificar contrato especial en Odoo para ${documentNumber}:`, odooContractErr.message);
        // Fallo silencioso: continúa hacia Q10
      }

      try {
        console.log(`[Q10] Consultando estado financiero para: ${documentNumber}`);
        const q10Result = await q10Api.getStudentStatus(documentNumber);
        const result = { allowed: q10Result.allowed, reason: q10Result.reason };
        setCachedStatus(documentNumber, result);
        return res.json(result);
      } catch (q10Err) {
        console.error(`[Q10] Error consultando ${documentNumber}:`, q10Err.message);
        return res.status(500).json({ error: 'Q10 query failed: ' + q10Err.message });
      }
    }

    console.log(`[STATUS] Consultando Odoo para: ${documentNumber}`);
    const odoo = new OdooAPI();

    // 2. Obtener Partner ID y Tipo de Contrato
    const partners = await odoo.call('res.partner', 'search_read',
      [[['vat', '=', documentNumber]]],
      { fields: ['id', 'x_studio_tipo_contrato_especial'] }
    );

    if (!partners.length) {
      const result = { allowed: false, reason: 'sin_contrato_o_usuario' };
      setCachedStatus(documentNumber, result);
      return res.json(result);
    }

    const partner = partners[0];
    const contractType = partner.x_studio_tipo_contrato_especial;

    // 3. Regla de Contrato Especial (cualquier valor configurado)
    if (contractType) {
      const result = { allowed: true, reason: 'contrato_especial' };
      console.log(`[STATUS] Acceso PERMITIDO (Contrato Especial: ${contractType}) para: ${documentNumber}`);
      setCachedStatus(documentNumber, result);
      return res.json(result);
    }

    // 4. Buscar Facturas Vencidas
    const invoices = await odoo.call(
      'account.move',
      'search_read',
      [[['partner_id', '=', parseInt(partner.id)], ['move_type', '=', 'out_invoice']]],
      {
        fields: ['state', 'invoice_date_due', 'amount_residual'],
        order: 'invoice_date_due desc'
      }
    );

    // Si no hay facturas
    if (!invoices || invoices.length === 0) {
      const result = { allowed: false, reason: 'sincontrato' };
      console.log(`[STATUS] Acceso DENEGADO (Sin facturas) para: ${documentNumber}`);
      setCachedStatus(documentNumber, result);
      return res.json(result);
    }

    // Filtrar MORA
    const now = new Date();
    const overdue = invoices.filter(inv =>
      inv.state !== 'paid' &&
      inv.invoice_date_due &&
      new Date(inv.invoice_date_due) < now &&
      inv.amount_residual > 0
    );

    // 5. Determinar Estado Final
    let result;
    if (overdue.length > 0) {
      result = { allowed: false, reason: 'mora' };
      console.log(`[STATUS] Acceso DENEGADO (Mora) para: ${documentNumber}`);
    } else {
      result = { allowed: true, reason: 'al_dia' };
      console.log(`[STATUS] Acceso PERMITIDO (Al día) para: ${documentNumber}`);
    }

    // Guardar en caché y retornar
    setCachedStatus(documentNumber, result);
    res.json(result);

  } catch (err) {
    console.error('Error en /api/odoo/status:', err);
    res.status(500).json({ error: err.message });
  }
});

// NUEVO ENDPOINT: Verificar Estado de Estudiantes en Bloque (Bulk)
app.post('/api/odoo/status/bulk', async (req, res) => {
  try {
    const { documentNumbers } = req.body;

    if (!documentNumbers || !Array.isArray(documentNumbers)) {
      return res.status(400).json({ error: 'Se requiere un array de documentNumbers' });
    }

    // Bypass global: todos permitidos
    if (bypassConfig.enabled) {
      console.log(`[BYPASS] Bulk: acceso PERMITIDO por bypass global para ${documentNumbers.length} estudiantes`);
      const results = {};
      documentNumbers.forEach(doc => { results[doc] = { allowed: true, reason: 'bypass_financiero' }; });
      return res.json(results);
    }

    const results = {};
    const toFetch = [];

    // 1. Verificar Caché
    for (const doc of documentNumbers) {
      const cached = getCachedStatus(doc);
      if (cached) {
        results[doc] = cached;
      } else {
        toFetch.push(doc);
      }
    }

    if (toFetch.length === 0) {
      console.log(`[BULK] Sirviendo todos los (${documentNumbers.length}) estados desde caché`);
      return res.json(results);
    }

    // Fuente Q10 (migración temporal)
    if (financialSourceConfig.source === 'q10') {
      // Pre-check: contrato especial en Odoo para todos los pendientes
      let stillToFetch = [...toFetch];
      try {
        const odooC = new OdooAPI();
        const cPartners = await odooC.call('res.partner', 'search_read',
          [[['vat', 'in', toFetch]]],
          { fields: ['vat', 'x_studio_tipo_contrato_especial'] }
        );
        const foundVats = new Set();
        for (const cp of cPartners) {
          foundVats.add(cp.vat);
          if (cp.x_studio_tipo_contrato_especial) {
            const r = { allowed: true, reason: 'contrato_especial' };
            results[cp.vat] = r;
            setCachedStatus(cp.vat, r);
          }
        }
        stillToFetch = toFetch.filter(doc => !results[doc]);
      } catch (odooContractErr) {
        console.warn('[BULK] No se pudo verificar contratos especiales en Odoo:', odooContractErr.message);
        // Fallo silencioso: continúa con Q10 para todos
      }

      if (stillToFetch.length === 0) {
        return res.json(results);
      }

      try {
        console.log(`[Q10] Bulk: consultando ${stillToFetch.length} estudiantes en Q10`);
        const q10Results = await q10Api.getStudentStatusBulk(stillToFetch);
        for (const [doc, q10Result] of Object.entries(q10Results)) {
          const result = { allowed: q10Result.allowed, reason: q10Result.reason };
          results[doc] = result;
          setCachedStatus(doc, result);
        }
        return res.json(results);
      } catch (q10Err) {
        console.error('[Q10] Bulk error:', q10Err.message);
        return res.status(500).json({ error: 'Q10 bulk query failed: ' + q10Err.message });
      }
    }

    console.log(`[BULK] Consultando Odoo para ${toFetch.length} documentos (de ${documentNumbers.length} totales)`);
    const odoo = new OdooAPI();

    // 2. Obtener Partners en bloque
    const partners = await odoo.call('res.partner', 'search_read',
      [[['vat', 'in', toFetch]]],
      { fields: ['id', 'vat', 'x_studio_tipo_contrato_especial'] }
    );

    const partnerMap = {}; // vat -> partner
    partners.forEach(p => {
      partnerMap[p.vat] = p;
    });

    const docToPartnerId = {}; // doc -> partner_id
    const partnerIdsNeedInvoices = [];
    const now = new Date();

    for (const doc of toFetch) {
      const partner = partnerMap[doc];

      if (!partner) {
        results[doc] = { allowed: false, reason: 'sin_contrato_o_usuario' };
        setCachedStatus(doc, results[doc]);
        continue;
      }

      const contractType = partner.x_studio_tipo_contrato_especial;

      if (contractType) {
        results[doc] = { allowed: true, reason: 'contrato_especial' };
        setCachedStatus(doc, results[doc]);
      } else {
        docToPartnerId[doc] = partner.id;
        partnerIdsNeedInvoices.push(partner.id);
      }
    }

    // 3. Obtener Facturas en bloque para los que no son becados
    if (partnerIdsNeedInvoices.length > 0) {
      console.log(`[BULK] Buscando facturas para ${partnerIdsNeedInvoices.length} partners`);
      const allInvoices = await odoo.call(
        'account.move',
        'search_read',
        [[['partner_id', 'in', partnerIdsNeedInvoices], ['move_type', '=', 'out_invoice']]],
        {
          fields: ['partner_id', 'state', 'invoice_date_due', 'amount_residual'],
          order: 'invoice_date_due desc'
        }
      );

      // Agrupar facturas por partner
      const invoicesByPartner = {};
      allInvoices.forEach(inv => {
        const pid = inv.partner_id[0];
        if (!invoicesByPartner[pid]) invoicesByPartner[pid] = [];
        invoicesByPartner[pid].push(inv);
      });

      // Procesar cada estudiante que necesitaba facturas
      for (const doc of toFetch) {
        if (results[doc]) continue; // Ya procesado (becado o no encontrado)

        const partnerId = docToPartnerId[doc];
        const studentInvoices = invoicesByPartner[partnerId] || [];

        if (studentInvoices.length === 0) {
          results[doc] = { allowed: false, reason: 'sincontrato' };
        } else {
          const overdue = studentInvoices.filter(inv =>
            inv.state !== 'paid' &&
            inv.invoice_date_due &&
            new Date(inv.invoice_date_due) < now &&
            inv.amount_residual > 0
          );

          if (overdue.length > 0) {
            results[doc] = { allowed: false, reason: 'mora' };
          } else {
            results[doc] = { allowed: true, reason: 'al_dia' };
          }
        }
        setCachedStatus(doc, results[doc]);
      }
    }

    res.json(results);

  } catch (err) {
    console.error('Error en /api/odoo/status/bulk:', err);
    res.status(500).json({ error: err.message });
  }
});


// NUEVO ENDPOINT: Limpiar Caché
app.post('/api/odoo/cache/clear', (req, res) => {
  const documentNumber = req.body.documentNumber;

  if (documentNumber) {
    if (studentStatusCache.has(documentNumber)) {
      studentStatusCache.delete(documentNumber);
      console.log(`[CACHE] Limpiado manualmente para: ${documentNumber}`);
      return res.json({ success: true, message: `Caché limpiado para ${documentNumber}` });
    } else {
      return res.json({ success: true, message: `No había caché para ${documentNumber}` });
    }
  } else {
    // Limpiar todo (opcional, para admin)
    studentStatusCache.clear();
    console.log(`[CACHE] Todo el caché ha sido limpiado.`);
    return res.json({ success: true, message: 'Todo el caché ha sido limpiado' });
  }
});

// POST /api/odoo/profile/update — actualiza teléfono y/o fecha de nacimiento en Odoo
app.post('/api/odoo/profile/update', async (req, res) => {
  const { documentNumber, phone, birthdate } = req.body;

  if (!documentNumber) {
    return res.status(400).json({ success: false, error: 'documentNumber requerido' });
  }
  if (phone === undefined && birthdate === undefined) {
    return res.status(400).json({ success: false, error: 'Se requiere al menos un campo (phone o birthdate)' });
  }

  try {
    const odoo = new OdooAPI();
    await odoo.authenticate();

    // Buscar partner por número de documento (campo vat)
    const partners = await odoo.call(
      'res.partner', 'search_read',
      [[['vat', '=', documentNumber]]],
      { fields: ['id', 'name'], limit: 1 }
    );

    if (!partners || partners.length === 0) {
      return res.status(404).json({ success: false, error: `Partner no encontrado para documento: ${documentNumber}` });
    }

    const partnerId = partners[0].id;

    // 1. Actualizar res.partner
    const partnerData = {};
    if (phone !== undefined)     partnerData.phone     = phone;
    if (birthdate !== undefined) partnerData.birthdate = birthdate; // YYYY-MM-DD
    await odoo.call('res.partner', 'write', [[partnerId], partnerData]);

    // 2. Si viene birthdate, también actualizar moodle.user.birthDate
    //    (el sync de Odoo→Moodle usa self.birthDate del registro moodle.user,
    //     no del partner, por lo que hay que actualizarlo explícitamente)
    if (birthdate !== undefined) {
      const moodleUsers = await odoo.call(
        'moodle.user', 'search_read',
        [[['partner_id', '=', partnerId]]],
        { fields: ['id'], limit: 1 }
      );
      if (moodleUsers && moodleUsers.length > 0) {
        await odoo.call('moodle.user', 'write', [[moodleUsers[0].id], { birthDate: birthdate }]);
        console.log(`[Profile Update] moodle.user ${moodleUsers[0].id} birthDate actualizado`);
      }
    }

    console.log(`[Profile Update] Partner ${partnerId} (${partners[0].name}) actualizado:`, partnerData);
    res.json({ success: true, partnerId });

  } catch (error) {
    console.error('[Profile Update] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- ENDPOINTS ADMIN: BYPASS FINANCIERO ---

// Middleware de autenticación para endpoints admin
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// GET /api/admin/bypass - Consultar estado actual del bypass
app.get('/api/admin/bypass', adminAuth, (req, res) => {
  res.json({
    enabled: bypassConfig.enabled,
    updatedAt: bypassConfig.updatedAt,
    updatedBy: bypassConfig.updatedBy
  });
});

// POST /api/admin/bypass - Activar o desactivar el bypass
app.post('/api/admin/bypass', adminAuth, (req, res) => {
  const { enabled, updatedBy } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" debe ser un booleano' });
  }

  bypassConfig = {
    enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'admin'
  };

  saveBypassConfig(bypassConfig);

  const estado = enabled ? 'ACTIVADO' : 'desactivado';
  console.log(`[BYPASS] Bypass financiero ${estado} por: ${bypassConfig.updatedBy} (${bypassConfig.updatedAt})`);

  // Si se activa el bypass, limpiar toda la caché para que no haya residuos
  if (enabled) {
    studentStatusCache.clear();
    console.log('[BYPASS] Caché limpiada al activar bypass');
  }

  res.json({
    success: true,
    enabled: bypassConfig.enabled,
    message: `Bypass financiero ${estado} correctamente`
  });
});

// --- ENDPOINTS ADMIN: FUENTE DE DATOS FINANCIEROS ---

// GET /api/admin/financial-source - Consultar fuente activa (odoo | q10)
app.get('/api/admin/financial-source', adminAuth, (req, res) => {
  res.json({
    source:    financialSourceConfig.source,
    updatedAt: financialSourceConfig.updatedAt,
    updatedBy: financialSourceConfig.updatedBy,
  });
});

// POST /api/admin/financial-source - Cambiar fuente
app.post('/api/admin/financial-source', adminAuth, (req, res) => {
  const { source, updatedBy } = req.body;

  if (source !== 'odoo' && source !== 'q10') {
    return res.status(400).json({ error: 'El campo "source" debe ser "odoo" o "q10"' });
  }

  const prev = financialSourceConfig.source;
  financialSourceConfig = {
    source,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'admin',
  };

  saveFinancialSourceConfig(financialSourceConfig);

  // Clear cache when switching source to avoid stale results
  studentStatusCache.clear();
  console.log(`[FINANCIAL_SOURCE] Fuente cambiada de "${prev}" a "${source}" por: ${financialSourceConfig.updatedBy}`);

  // Pre-initialize Q10 session in background when switching to Q10
  if (source === 'q10') {
    q10Api.login().catch(err => console.error('[Q10] Pre-login failed after source switch:', err.message));
  }

  res.json({
    success:   true,
    source:    financialSourceConfig.source,
    message:   `Fuente de datos financieros cambiada a "${source}" correctamente`,
  });
});

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

// Configuración de HTTPS
const httpsOptions = {
  key: fs.readFileSync('/home/ubuntu/odoo-proxy/certs/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/odoo-proxy/certs/fullchain.pem')
};

// Crear servidor HTTPS
https.createServer(httpsOptions, app).listen(PORT, HOST, () => {
  console.log(`Odoo proxy API corriendo en https://${HOST}:${PORT}`);
  console.log('IPs de la máquina:');
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`- ${name}: ${net.address}`);
      }
    }
  }
});
