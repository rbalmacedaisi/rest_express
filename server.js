const express = require('express');
const cors = require('cors');
const OdooAPI = require('./odooApi');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- BYPASS FINANCIERO GLOBAL ---
// Secret para proteger el endpoint admin (cámbialo en producción)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'gmk_admin_bypass_2026';

// --- PERIODO DE GRACIA (primer login) ---
const MOODLE_URL         = process.env.MOODLE_URL         || 'https://lms.isi.edu.pa';
const MOODLE_GRACE_TOKEN = process.env.MOODLE_GRACE_TOKEN || 'gmk_grace_check_2026';

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

app.get('/api/odoo/invoices', async (req, res) => {
  try {
    const documentNumber = req.query.documentNumber;
    const partnerId = req.query.partnerId;

    if (!documentNumber && !partnerId) {
      return res.status(400).json({ error: 'Se requiere documentNumber o partnerId' });
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

    // 3. Regla de Contrato Especial (Beca / IFARHU / Carrera Completa)
    if (contractType === 'Beca' || contractType === 'IFARHU' || contractType === 'Carrera Completa') {
      const result = { allowed: true, reason: 'becado' };
      console.log(`[STATUS] Acceso PERMITIDO (Beca/IFARHU) para: ${documentNumber}`);
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

      if (contractType === 'Beca' || contractType === 'IFARHU' || contractType === 'Carrera Completa') {
        results[doc] = { allowed: true, reason: 'becado' };
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
    const updateData = {};
    if (phone !== undefined)     updateData.phone     = phone;
    if (birthdate !== undefined) updateData.birthdate = birthdate; // YYYY-MM-DD

    await odoo.call('res.partner', 'write', [[partnerId], updateData]);

    console.log(`[Profile Update] Partner ${partnerId} (${partners[0].name}) actualizado:`, updateData);
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
