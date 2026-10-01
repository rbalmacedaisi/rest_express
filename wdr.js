/**
 * wdr.js
 *
 * Express endpoints for the RET-01 (Solicitud de Retiro del Programa) module
 * deployed by isi_moodle.patch (locales/grupomakro_core). The Moodle WDR manager
 * talks to Odoo exclusively through this router so the retirement flow has a
 * single audit surface.
 *
 *   GET  /api/odoo/wdr/pending-balance?documentNumber=<vat>
 *     Read the partner's currently-due balance so the Moodle admin inbox can
 *     decide whether to block "Procesar" (when retirement_block_when_has_balance
 *     is on) or proceed.
 *
 *   POST /api/odoo/wdr/process-retirement
 *     Drive wizard.aplazar.estudiante.do_retiro. If the partner has a
 *     non-zero balance and force=false, refuse with 409 so the Moodle admin
 *     inbox shows the balance and forces an explicit override with
 *     force=true + a justification reason.
 *
 * Auth: optional X-Api-Key shared with Moodle (config.proxyApiKey, same value
 * as local_grupomakro_core | odoo_proxy_api_key). When unset the middleware is
 * a no-op, matching the rest of /api/odoo/* behaviour. The scope covers
 * /api/odoo/wdr/* AND /api/odoo/students/* — both originate from Moodle, and
 * applying the key check at this router keeps the audit surface unified.
 */

const express = require('express');
const OdooAPI = require('./odooApi');

const router = express.Router();

const API_KEY = require('./config').proxyApiKey;

// SCOPED auth: only apply to /api/odoo/wdr/* routes. When the env var is
// empty we stay open so existing cron / LXP callers are unaffected during
// local development. Production must keep API_KEY set.
router.use((req, res, next) => {
    if (!API_KEY) return next();
    const provided = req.header('X-Api-Key') || req.header('x-api-key');
    if (!provided || provided !== API_KEY) {
        return res.status(401).json({
            success: false,
            error: 'unauthorized',
            message: 'Missing or invalid X-Api-Key header.',
        });
    }
    next();
});

function odoo() {
    return new OdooAPI();
}

function actorContext(body) {
    return {
        actor_username: body.actor_username || null,
        actor_email: body.actor_email || null,
        actor_moodle_id: body.actor_moodle_id || null,
    };
}

// Shared helper that resolves a partner + the partner docs-ready state.
// Returns { success, partner, errorCode } so callers can branch without
// rewriting the same try/catch.
async function resolvePartner(documentNumber) {
    if (!documentNumber) {
        return { success: false, errorCode: 'missing_document_number', status: 400 };
    }
    try {
        const o = odoo();
        const partners = await o.call(
            'res.partner',
            'search_read',
            [[['vat', '=', documentNumber], ['active', '=', true]]],
            { fields: ['id', 'name', 'vat', 'mga_payment_status'], limit: 1 }
        );
        if (!partners || partners.length === 0) {
            return {
                success: false,
                errorCode: 'partner_not_found',
                status: 404,
                message: `No Odoo partner with vat=${documentNumber}`,
            };
        }
        return { success: true, partner: partners[0] };
    } catch (err) {
        return {
            success: false,
            errorCode: 'odoo_error',
            status: 500,
            message: err.message || 'Odoo call failed',
        };
    }
}

// Shared helper that fetches the currently-due invoices for a partner.
// We mirror the criteria used by /api/odoo/students/:vat/pending-invoices
// so the balance we report matches what the student-facing surface already
// shows. account.move with state=posted + payment_state in (not_paid, partial).
async function fetchPendingInvoices(partnerId) {
    const o = odoo();
    return o.call(
        'account.move',
        'search_read',
        [[
            ['partner_id', '=', partnerId],
            ['move_type', '=', 'out_invoice'],
            ['state', '=', 'posted'],
            ['payment_state', 'in', ['not_paid', 'partial']],
        ]],
        {
            fields: [
                'id', 'name', 'invoice_date', 'invoice_date_due',
                'amount_total', 'amount_residual', 'currency_id', 'state', 'payment_state',
            ],
            order: 'invoice_date_due asc',
        }
    );
}

// GET /api/odoo/wdr/pending-balance?documentNumber=<vat>
//
// Reports whether the student can be retired without outstanding debt.
// The Moodle admin inbox calls it when the admin clicks "Procesar" so it
// can show the balance alongside the WDR request and ask the admin to
// force an override when needed.
router.get('/pending-balance', async (req, res) => {
    const documentNumber = (req.query.documentNumber || '').toString().trim();
    const resolved = await resolvePartner(documentNumber);
    if (!resolved.success) {
        return res.status(resolved.status).json({
            success: false,
            error: resolved.errorCode,
            message: resolved.message || undefined,
        });
    }
    const partner = resolved.partner;
    try {
        const today = new Date().toISOString().slice(0, 10);
        const invoices = await fetchPendingInvoices(partner.id);
        const rows = invoices || [];
        let total = 0;
        let overdueCount = 0;
        const currencySet = new Set();
        for (const inv of rows) {
            const residual = Number(inv.amount_residual || 0);
            total += residual;
            if (inv.invoice_date_due && inv.invoice_date_due < today) overdueCount++;
            const currencyName = inv.currency_id && inv.currency_id[1] ? inv.currency_id[1] : 'USD';
            currencySet.add(currencyName);
        }
        // Currency mismatch is rare but a real Risk Calculator failure mode:
        // a partner with two currencies could make "hasBalance" ambiguous, so
        // we surface the list instead of picking one.
        const currencies = Array.from(currencySet);
        return res.json({
            success: true,
            documentNumber,
            partner_id: partner.id,
            partner_name: partner.name,
            financial_status: partner.mga_payment_status || null,
            hasBalance: total > 0.0001,
            total: Math.round(total * 100) / 100,
            currency: currencies.length === 1 ? currencies[0] : currencies.join('|'),
            currencies,
            invoiceCount: rows.length,
            overdueCount,
            fetchedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[wdr] pending-balance error:', err.message || err);
        return res.status(500).json({
            success: false,
            error: 'odoo_error',
            message: err.message || 'Odoo call failed',
        });
    }
});

// POST /api/odoo/wdr/process-retirement
//
// Body: {
//   documentNumber,    // vat in Odoo (= mdl_user_info_data.data for shortname=documentnumber)
//   wdrId,            // isi_gmk_wdr.id (audit trail only; Odoo doesn't see it)
//   reason,            // justification (required, >=10 chars)
//   force,            // bool: if true, bypass the balance check
//   actor_username,   // moodle username of the admin who clicked Procesar
//   actor_email,      // email of the same admin
//   actor_moodle_id   // mdl_user.id of the same admin
// }
//
// Returns the same shape as POST /api/odoo/students/retirar plus a
// hasBalance field so the Moodle inbox knows whether the balance was zero,
// non-zero+overridden, or non-zero+blocked.
router.post('/process-retirement', async (req, res) => {
    const body = req.body || {};
    const documentNumber = (body.documentNumber || '').toString().trim();
    const wdrId = parseInt(body.wdrId, 10);
    const reason = (body.reason || '').toString().trim();
    const force = !!body.force;
    const actor = actorContext(body);

    if (!documentNumber) {
        return res.status(400).json({ success: false, error: 'missing_document_number' });
    }
    if (!Number.isFinite(wdrId) || wdrId <= 0) {
        return res.status(400).json({ success: false, error: 'missing_wdr_id' });
    }
    if (!reason || reason.length < 10) {
        return res.status(400).json({ success: false, error: 'reason_too_short' });
    }

    // 1. Resolve partner.
    const resolved = await resolvePartner(documentNumber);
    if (!resolved.success) {
        return res.status(resolved.status).json({
            success: false,
            error: resolved.errorCode,
            wdrId,
            message: resolved.message || undefined,
        });
    }
    const partner = resolved.partner;

    // 2. Check balance unless force=true.
    let hasBalance = false;
    let balanceReport = null;
    try {
        const today = new Date().toISOString().slice(0, 10);
        const invoices = await fetchPendingInvoices(partner.id);
        const rows = invoices || [];
        let total = 0;
        let overdueCount = 0;
        const currencySet = new Set();
        for (const inv of rows) {
            total += Number(inv.amount_residual || 0);
            if (inv.invoice_date_due && inv.invoice_date_due < today) overdueCount++;
            const currencyName = inv.currency_id && inv.currency_id[1] ? inv.currency_id[1] : 'USD';
            currencySet.add(currencyName);
        }
        hasBalance = total > 0.0001;
        balanceReport = {
            total: Math.round(total * 100) / 100,
            currency: Array.from(currencySet).join('|'),
            invoiceCount: rows.length,
            overdueCount,
        };
    } catch (err) {
        console.error('[wdr] balance check failed:', err.message || err);
        return res.status(500).json({
            success: false,
            error: 'balance_check_failed',
            wdrId,
            message: err.message || 'Odoo call failed during balance check',
        });
    }

    if (hasBalance && !force) {
        return res.status(409).json({
            success: false,
            error: 'pending_balance',
            wdrId,
            documentNumber,
            partner_id: partner.id,
            partner_name: partner.name,
            hasBalance: true,
            balance: balanceReport,
            message: 'Estudiante tiene balance pendiente. Reintenta con force=true y una justificacion (>=10 chars).',
        });
    }

    // 3. Drive wizard.aplazar.estudiante.do_retiro. This is the same code
    // path the LXP /api/odoo/students/retirar uses; we replicate it instead
    // of proxying because we have to combine the balance check, the forced-
    // override audit and the Odoo write into a single round-trip-able call.
    let result;
    try {
        const o = odoo();
        const wizardId = await o.call(
            'wizard.aplazar.estudiante',
            'create',
            [{ partner_id: partner.id }],
            {}
        );
        result = await o.call(
            'wizard.aplazar.estudiante',
            'do_retiro',
            [[wizardId], reason, actor],
            {}
        );
        try {
            await o.call('wizard.aplazar.estudiante', 'unlink', [[wizardId]], {});
        } catch (e) {
            // best-effort
        }
    } catch (wizardErr) {
        console.error('[wdr] wizard call failed:', wizardErr.message || wizardErr);
        return res.status(500).json({
            success: false,
            error: 'wizard_failed',
            wdrId,
            documentNumber,
            partner_id: partner.id,
            hasBalance,
            balance: balanceReport,
            message: wizardErr.message || 'Odoo wizard call failed',
        });
    }

    return res.json({
        success: true,
        action: 'retiro',
        wdrId,
        documentNumber,
        partner_id: partner.id,
        partner_name: partner.name,
        hasBalance,
        forced: hasBalance && force,
        balance: balanceReport,
        invoices_updated: (result && result.invoices_updated) || 0,
        subscriptions_updated: (result && result.subscriptions_updated) || 0,
        moodle_updated: (result && result.moodle_updated) || false,
        odoo_result: result || null,
        processed_at: new Date().toISOString(),
    });
});

module.exports = router;