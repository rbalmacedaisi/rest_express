// isi_moodle_lxp/services/odooApi.js
const xmlrpc = require('xmlrpc');
const { URL } = require('url'); // Importa la clase URL

// Usa variables de entorno o valores por defecto
const ODOO_URL_BASE = process.env.ODOO_URL || 'https://odoo.isi.edu.pa'; // Guarda la URL base
const ODOO_DB = process.env.ODOO_DB || 'odoo';
const ODOO_USER = process.env.ODOO_USER || 'tic@isi.edu.pa';
const ODOO_APIKEY = process.env.ODOO_APIKEY || '3b2a6fa21d721f678eaf8551ac04a280099e97a7';

class OdooAPI {
    constructor() {
        const urlParts = new URL(ODOO_URL_BASE); // Usa la clase URL para parsear

        const baseOptions = {
            host: urlParts.hostname,
            port: urlParts.port || (urlParts.protocol === 'https:' ? 443 : 80),
            rejectUnauthorized: process.env.NODE_ENV !== 'development', // Deshabilita en dev si tienes problemas con certs auto-firmados
            request: { // Opciones adicionales para la petición HTTP subyacente si es necesario
                timeout: 10000 // 10 segundos de timeout
            }
        };

        // Crea clientes con rutas específicas y configura para HTTPS
        if (urlParts.protocol === 'https:') {
            this.commonClient = xmlrpc.createSecureClient({ ...baseOptions, path: '/xmlrpc/2/common' });
            this.objectClient = xmlrpc.createSecureClient({ ...baseOptions, path: '/xmlrpc/2/object' });
        } else { // Si fuera HTTP (no es tu caso aquí)
            this.commonClient = xmlrpc.createClient({ ...baseOptions, path: '/xmlrpc/2/common' });
            this.objectClient = xmlrpc.createClient({ ...baseOptions, path: '/xmlrpc/2/object' });
        }

        this.db = ODOO_DB;
        this.username = ODOO_USER;
        this.apiKey = ODOO_APIKEY;
        this.uid = null;

        // El manejo de errores se realiza en el callback (err, value) de methodCall
    }

    async authenticate() {
        console.log(`[OdooAPI] Intentando autenticar a Odoo DB: ${this.db}, User: ${this.username}`);
        return new Promise((resolve, reject) => {
            // Llama solo con el nombre del método Odoo, los parámetros y el callback
            this.commonClient.methodCall('authenticate', [this.db, this.username, this.apiKey, {}], (err, uid) => {
                if (err) {
                    console.error('[OdooAPI Authenticate Error]:', err);
                    if (err.body) {
                        console.error('[OdooAPI Authenticate Error Body]:', err.body.toString());
                    }
                    return reject(err);
                }
                console.log(`[OdooAPI] Autenticación exitosa. UID: ${uid}`);
                this.uid = uid;
                resolve(uid);
            });
        });
    }

    async call(model, method, args = [], kwargs = {}) {
        if (!this.uid) {
            console.log('[OdooAPI] UID no disponible, intentando autenticar...');
            try {
                await this.authenticate();
            } catch (authError) {
                console.error('[OdooAPI] Falló la autenticación antes de la llamada:', authError);
                throw new Error('Authentication failed before Odoo API call.');
            }
        }

        console.log(`[OdooAPI] Llamando a Odoo: Model: ${model}, Method: ${method}, Args: ${JSON.stringify(args)}, Kwargs: ${JSON.stringify(kwargs)}`);

        return new Promise((resolve, reject) => {
            // Llama solo con el nombre del método Odoo, los parámetros y el callback
            this.objectClient.methodCall(
                'execute_kw',
                [this.db, this.uid, this.apiKey, model, method, args, kwargs],
                (err, value) => {
                    if (err) {
                        console.error('[OdooAPI Call Error]:', err);
                        if (err.body) {
                            console.error('[OdooAPI Call Error Body]:', err.body.toString());
                        }
                        return reject(err);
                    }
                    console.log(`[OdooAPI] Llamada exitosa a ${model}.${method}.`);
                    resolve(value);
                }
            );
        });
    }
}

module.exports = OdooAPI;
