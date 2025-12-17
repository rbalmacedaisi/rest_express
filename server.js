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
        console.log(`No se encontr▒ partner para documento: ${documentNumber}`);
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

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

// Configuraci▒n de HTTPS
const httpsOptions = {
  key: fs.readFileSync('/home/ubuntu/odoo-proxy/certs/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/odoo-proxy/certs/fullchain.pem')
};

// Crear servidor HTTPS
https.createServer(httpsOptions, app).listen(PORT, HOST, () => {
  console.log(`Odoo proxy API corriendo en https://${HOST}:${PORT}`);
  console.log('IPs de la m▒quina:');
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
