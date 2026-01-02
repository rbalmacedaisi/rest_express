const express = require('express');
const cors = require('cors');
const OdooAPI = require('./odooApi');
const https = require('https');
const fs = require('fs');

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

    // 3. Regla de Contrato Especial (Beca / IFARHU)
    if (contractType === 'Beca' || contractType === 'IFARHU') {
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

      if (contractType === 'Beca' || contractType === 'IFARHU') {
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
