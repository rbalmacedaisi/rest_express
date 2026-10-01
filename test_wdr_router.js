/**
 * test_wdr_router.js
 *
 * Smoke test for wdr.js. Mounts the router on a temporary express app with
 * OdooAPI mocked so we can exercise the validation paths (auth, missing
 * inputs, partner not found, balance conflict) without needing real Odoo.
 *
 * Run: node test_wdr_router.js
 * Exit 0 = OK, non-zero = first failed assertion printed.
 */

const path = require('path');

// Inject config BEFORE wdr.js loads it. wdr.js does `require('./config')`,
// which Node resolves relative to wdr.js's own __dirname (this folder). So
// `require.resolve('./config')` here resolves to the same file.
const configPath = require.resolve('./config');
require.cache[configPath] = {
    exports: { proxyApiKey: 'TEST_PROXY_KEY' },
    loaded: true,
    id: configPath,
};

// Mock OdooAPI: defaults to "no partner", individual cases can swap in
// richer returns via `Mock.respond(...)`.
const odooApiPath = require.resolve('./odooApi');
let responseQueue = [];
class OdooAPIMock {
    async call(model, method, callArgs, callKwargs) {
        if (responseQueue.length > 0) {
            return responseQueue.shift();
        }
        // Behaviour-aware default:
        // - res.partner search_read -> empty (partner_not_found)
        // - account.move search_read -> empty (no invoices)
        // - wizard calls -> success stub with expected fields
        if (model === 'res.partner' && method === 'search_read') {
            return [];
        }
        if (model === 'account.move' && method === 'search_read') {
            return [];
        }
        if (model === 'wizard.aplazar.estudiante') {
            return {
                invoices_updated: 1,
                subscriptions_updated: 1,
                moodle_updated: true,
            };
        }
        throw new Error(`Mock: unhandled ${model}.${method}`);
    }
    // Queue multiple responses; the queue is consumed in order. Empty by default.
    static respond(...args) {
        responseQueue.push(...args);
    }
    static reset() {
        responseQueue = [];
    }
}

// Mutate the existing cache object in place (reassigning `require.cache = {...}`
// replaces it with a new object and Node's internal CJS loader won't see
// subsequent requires against the new identity). Only mutate keys:
require.cache[odooApiPath] = {
    exports: OdooAPIMock,
    loaded: true,
    id: odooApiPath,
};

const express = require('express');
const wdrRouter = require('./wdr');

const app = express();
app.use(express.json());
app.use('/api/odoo/wdr', wdrRouter);
app.use((err, req, res, next) => {
    console.error('[unhandled]', err.stack || err.message || err);
    res.status(500).json({ success: false, error: 'unhandled', message: String(err.message || err) });
});

const API_KEY = 'TEST_PROXY_KEY';

const server = app.listen(0, async () => {
    const port = server.address().port;
    let failures = 0;

    function check(name, condition, details) {
        if (condition) {
            console.log(`  OK   ${name}`);
        } else {
            console.log(`  FAIL ${name}: ${details || ''}`);
            failures++;
        }
    }

    async function call(p, opts = {}) {
        // Always hit the router under the same prefix server.js mounts it on.
        const url = `http://127.0.0.1:${port}/api/odoo/wdr${p}`;
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        const init = { method: opts.method || 'GET', headers };
        if (opts.body) init.body = JSON.stringify(opts.body);
        const r = await fetch(url, init);
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        return { status: r.status, json, text };
    }

    try {
        console.log('# 1. Auth: no header -> 401');
        let x = await call('/pending-balance?documentNumber=8-123-456');
        check('no header returns 401', x.status === 401, `got ${x.status}`);
        check('error code unauthorized', x.json && x.json.error === 'unauthorized');

        console.log('# 2. Auth: wrong key -> 401');
        x = await call('/pending-balance?documentNumber=8-123-456',
            { headers: { 'X-Api-Key': 'WRONG' } });
        check('wrong key returns 401', x.status === 401, `got ${x.status}`);

        console.log('# 3. pending-balance with valid key, no partner -> 404');
        x = await call('/pending-balance?documentNumber=8-123-456',
            { headers: { 'X-Api-Key': API_KEY } });
        check('returns 404', x.status === 404, `got ${x.status}`);
        check('error code partner_not_found', x.json && x.json.error === 'partner_not_found');

        console.log('# 4. pending-balance: partner + no invoices -> 200 hasBalance=false');
        OdooAPIMock.respond([{
            id: 17, name: 'Juan Pérez', vat: '8-123-456', mga_payment_status: 'al_dia',
        }]);
        x = await call('/pending-balance?documentNumber=8-123-456',
            { headers: { 'X-Api-Key': API_KEY } });
        check('returns 200', x.status === 200, `got ${x.status}`);
        check('hasBalance false', x.json && x.json.hasBalance === false);
        check('total == 0', x.json && x.json.total === 0);
        check('invoiceCount == 0', x.json && x.json.invoiceCount === 0);

        console.log('# 5. pending-balance: partner + 1 overdue invoice -> 200 hasBalance=true');
        // The router does TWO Odoo calls: partner then account.move.
        // Override the second one (account.move) too.
        OdooAPIMock.respond([{ // partner
            id: 17, name: 'Juan Pérez', vat: '8-123-456', mga_payment_status: 'vencido',
        }]);
        OdooAPIMock.respond([{ // invoice
            id: 1001, name: 'INV/2026/0001', invoice_date: '2026-09-01',
            invoice_date_due: '2026-09-15', amount_total: 1234.56,
            amount_residual: 1234.56, currency_id: [1, 'USD'],
            state: 'posted', payment_state: 'not_paid',
        }]);
        x = await call('/pending-balance?documentNumber=8-123-456',
            { headers: { 'X-Api-Key': API_KEY } });
        check('returns 200', x.status === 200, `got ${x.status}`);
        check('hasBalance true', x.json && x.json.hasBalance === true);
        check('total == 1234.56', x.json && Math.abs(x.json.total - 1234.56) < 0.01,
            `got ${x.json && x.json.total}`);
        check('invoiceCount == 1', x.json && x.json.invoiceCount === 1);
        check('overdueCount == 1', x.json && x.json.overdueCount === 1);

        console.log('# 6. process-retirement validation');
        x = await call('/process-retirement', {
            method: 'POST', headers: { 'X-Api-Key': API_KEY },
            body: { documentNumber: '8-123-456', reason: 'Motivo mas que suficiente.' },
        });
        check('missing wdrId returns 400', x.status === 400, `got ${x.status}`);
        check('error code missing_wdr_id', x.json && x.json.error === 'missing_wdr_id');

        x = await call('/process-retirement', {
            method: 'POST', headers: { 'X-Api-Key': API_KEY },
            body: { documentNumber: '8-123-456', wdrId: 1, reason: 'corto' },
        });
        check('short reason returns 400', x.status === 400, `got ${x.status}`);
        check('error code reason_too_short', x.json && x.json.error === 'reason_too_short');

        console.log('# 7. process-retirement with balance + force=false -> 409');
        OdooAPIMock.respond([{ // partner
            id: 17, name: 'Juan Pérez', vat: '8-123-456', mga_payment_status: 'vencido',
        }]);
        OdooAPIMock.respond([{ // invoice
            id: 1001, name: 'INV/2026/0001', invoice_date: '2026-09-01',
            invoice_date_due: '2026-09-15', amount_total: 1234.56,
            amount_residual: 1234.56, currency_id: [1, 'USD'],
            state: 'posted', payment_state: 'not_paid',
        }]);
        x = await call('/process-retirement', {
            method: 'POST', headers: { 'X-Api-Key': API_KEY },
            body: {
                documentNumber: '8-123-456', wdrId: 42,
                reason: 'Justificacion completa del override.',
                force: false, actor_username: 'admin',
            },
        });
        check('returns 409', x.status === 409, `got ${x.status}`);
        check('error code pending_balance', x.json && x.json.error === 'pending_balance');
        check('balance.total == 1234.56',
            x.json && x.json.balance && Math.abs(x.json.balance.total - 1234.56) < 0.01,
            `got ${x.json && x.json.balance && x.json.balance.total}`);

        console.log('# 8. process-retirement with balance + force=true -> 200 + wizard');
        OdooAPIMock.respond([{ // partner
            id: 17, name: 'Juan Pérez', vat: '8-123-456', mga_payment_status: 'vencido',
        }]);
        OdooAPIMock.respond([{ // invoice (still pending, force override)
            id: 1001, name: 'INV/2026/0001', invoice_date: '2026-09-01',
            invoice_date_due: '2026-09-15', amount_total: 1234.56,
            amount_residual: 1234.56, currency_id: [1, 'USD'],
            state: 'posted', payment_state: 'not_paid',
        }]);
        x = await call('/process-retirement', {
            method: 'POST', headers: { 'X-Api-Key': API_KEY },
            body: {
                documentNumber: '8-123-456', wdrId: 42,
                reason: 'Justificacion completa del override.',
                force: true, actor_username: 'admin',
            },
        });
        check('returns 200', x.status === 200, `got ${x.status} body=${x.json && JSON.stringify(x.json)}`);
        check('action == retiro', x.json && x.json.action === 'retiro');
        check('wdrId == 42', x.json && x.json.wdrId === 42);
        check('forced == true', x.json && x.json.forced === true);
        check('invoices_updated == 1', x.json && x.json.invoices_updated === 1);
        check('moodle_updated == true', x.json && x.json.moodle_updated === true);

        console.log('# 9. process-retirement NO balance + force=false -> 200 (happy path)');
        OdooAPIMock.respond([{ // partner
            id: 17, name: 'Juan Pérez', vat: '8-123-456', mga_payment_status: 'al_dia',
        }]);
        // account.move search_read returns [] by default in this case (no nextResponse)
        x = await call('/process-retirement', {
            method: 'POST', headers: { 'X-Api-Key': API_KEY },
            body: {
                documentNumber: '8-123-456', wdrId: 43,
                reason: 'Estudiante al dia, sin pendientes, se procesa retiro.',
                force: false,
            },
        });
        check('returns 200', x.status === 200, `got ${x.status} body=${x.json && JSON.stringify(x.json)}`);
        check('forced == false', x.json && x.json.forced === false);
        check('hasBalance == false', x.json && x.json.hasBalance === false);

        console.log('');
        if (failures === 0) {
            console.log('OK   All checks passed.');
            server.close();
            process.exit(0);
        } else {
            console.log(`FAIL ${failures} assertion(s) failed.`);
            server.close();
            process.exit(1);
        }
    } catch (e) {
        console.error('test harness crash:', e && e.stack || e);
        server.close();
        process.exit(2);
    }
});