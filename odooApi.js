// isi_moodle_lxp/services/odooApi.js
const xmlrpc = require('xmlrpc');
const { URL } = require('url'); // Importa la clase URL

// La configuracion viene de config.js, que es el unico modulo que lee
// process.env. Antes este archivo lo leia por su cuenta con sus propios valores
// por defecto, y podia acabar hablando con una base de datos distinta de la que
// server.js creia haber validado. La API key ya no tiene valor por defecto.
const config = require('./config');

const ODOO_URL_BASE = config.odooUrl;
const ODOO_DB = config.odooDb;
const ODOO_USER = config.odooUser;
const ODOO_APIKEY = config.odooApiKey;

class OdooAPI {
    constructor() {
        const urlParts = new URL(ODOO_URL_BASE); // Usa la clase URL para parsear

        const baseOptions = {
            host: urlParts.hostname,
            port: urlParts.port || (urlParts.protocol === 'https:' ? 443 : 80),
            rejectUnauthorized: process.env.NODE_ENV !== 'development', // Deshabilita en dev si tienes problemas con certs auto-firmados
            request: { // Opciones adicionales para la petici�n HTTP subyacente si es necesario
                timeout: 10000 // 10 segundos de timeout
            }
        };

        // Crea clientes con rutas espec�ficas y configura para HTTPS
        if (urlParts.protocol === 'https:') {
            this.commonClient = xmlrpc.createSecureClient({ ...baseOptions, path: '/xmlrpc/2/common' });
            this.objectClient = xmlrpc.createSecureClient({ ...baseOptions, path: '/xmlrpc/2/object' });
        } else { // Si fuera HTTP (no es tu caso aqu�)
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
            // Llama solo con el nombre del m�todo Odoo, los par�metros y el callback
            this.commonClient.methodCall('authenticate', [this.db, this.username, this.apiKey, {}], (err, uid) => {
                if (err) {
                    console.error('[OdooAPI Authenticate Error]:', err);
                    if (err.body) {
                        console.error('[OdooAPI Authenticate Error Body]:', err.body.toString());
                    }
                    return reject(err);
                }
                console.log(`[OdooAPI] Autenticaci�n exitosa. UID: ${uid}`);
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
                console.error('[OdooAPI] Fall� la autenticaci�n antes de la llamada:', authError);
                throw new Error('Authentication failed before Odoo API call.');
            }
        }

        console.log(`[OdooAPI] Llamando a Odoo: Model: ${model}, Method: ${method}, Args: ${JSON.stringify(args)}, Kwargs: ${JSON.stringify(kwargs)}`);

        return new Promise((resolve, reject) => {
            // Llama solo con el nombre del m�todo Odoo, los par�metros y el callback
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
