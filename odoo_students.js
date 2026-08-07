/**
 * odoo_students.js
 *
 * Express router exposing the LXP-driven Odoo operations triggered by the
 * Moodle status-change wizard:
 *
 *   GET  /api/odoo/students/:vat/pending-invoices
 *     -> calls Odoo account.move.search_read, returns invoices with is_overdue flag.
 *
 *   POST /api/odoo/students/aplazar
 *     -> invokes subscription_oca.wizard.aplazar.estudiante through the JSON
 *        controller added in Odoo. Body: { vat, target_period_name, reason,
 *        actor_username, actor_email, actor_moodle_id }.
 *
 *   POST /api/odoo/students/retirar
 *     -> invokes the same Odoo wizard with action='retiro'. Same body shape.
 *
 * Auth: optional X-Api-Key middleware, scoped to /api/odoo/students/* ONLY.
 * Legacy endpoints under /api/odoo (status/bulk, products/exists, ...) stay
 * open for the cron and LXP store to keep working unchanged. When unset
 * (current default for the open endpoints), the middleware is a no-op.
 */

const express = require('express');
const OdooAPI = require('./odooApi');

const router = express.Router();

// Optional X-Api-Key shared with the Moodle status-change wizard. When
// ODOO_PROXY_API_KEY is set, every request to /api/odoo/students/* must
// carry a matching X-Api-Key header. The same value must be configured
// in Moodle as 'local_grupomakro_core | odoo_proxy_api_key' and in Odoo
// as 'ir.config_parameter subscription_oca.api_key' for the matching
// authorisation in aplazo_api.py. When unset, the endpoints stay open
// (matching the legacy behaviour).
const ODOO_PROXY_API_KEY = process.env.ODOO_PROXY_API_KEY || '';

// SCOPED auth: only apply to /api/odoo/students/* routes. Legacy
// endpoints under /api/odoo/* (status, products, etc.) keep their open
// access for the cron and LXP store.
router.use('/students', (req, res, next) => {
    if (!ODOO_PROXY_API_KEY) return next();
    const provided = req.header('X-Api-Key') || req.header('x-api-key');
    if (!provided || provided !== ODOO_PROXY_API_KEY) {
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

// GET /api/odoo/students/:vat/pending-invoices
router.get('/students/:vat/pending-invoices', async (req, res) => {
    const vat = req.params.vat;
    if (!vat) {
        return res.status(400).json({ success: false, error: 'missing_vat' });
    }
    try {
        const o = odoo();
        // 1. Resolve partner by VAT.
        const partners = await o.call(
            'res.partner',
            'search_read',
            [[['vat', '=', vat], ['active', '=', true]]],
            { fields: ['id', 'name', 'vat', 'mga_payment_status'] }
        );
        if (!partners || partners.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'partner_not_found',
                message: `No Odoo partner with vat=${vat}`,
            });
        }
        const partner = partners[0];
        // 2. Fetch pending invoices.
        const today = new Date().toISOString().slice(0, 10);
        const invoices = await o.call(
            'account.move',
            'search_read',
            [[
                ['partner_id', '=', partner.id],
                ['move_type', '=', 'out_invoice'],
                ['state', '=', 'posted'],
                ['payment_state', 'in', ['not_paid', 'partial']],
            ]],
            {
                fields: [
                    'id', 'name', 'invoice_date', 'invoice_date_due',
                    'amount_total', 'amount_residual', 'currency_id',
                    'state', 'payment_state',
                ],
                order: 'invoice_date_due asc',
            }
        );
        const rows = (invoices || []).map((inv) => ({
            id: inv.id,
            number: inv.name,
            invoice_date: inv.invoice_date,
            invoice_date_due: inv.invoice_date_due,
            amount_total: inv.amount_total,
            amount_residual: inv.amount_residual,
            currency: inv.currency_id && inv.currency_id[1] ? inv.currency_id[1] : 'USD',
            state: inv.state,
            payment_state: inv.payment_state,
            is_overdue: !!(inv.invoice_date_due && inv.invoice_date_due < today),
        }));
        return res.json({
            success: true,
            vat,
            partner_id: partner.id,
            partner_name: partner.name,
            financial_status: partner.mga_payment_status || null,
            invoices: rows,
        });
    } catch (err) {
        console.error('[odoo_students] pending-invoices error:', err.message || err);
        return res.status(500).json({
            success: false,
            error: 'odoo_error',
            message: err.message || 'Odoo call failed',
        });
    }
});

// POST /api/odoo/students/aplazar
router.post('/students/aplazar', async (req, res) => {
    return handleStatusChange(req, res, 'aplazar');
});

// POST /api/odoo/students/retirar
router.post('/students/retirar', async (req, res) => {
    return handleStatusChange(req, res, 'retiro');
});

async function handleStatusChange(req, res, action) {
    const body = req.body || {};
    const vat = (body.vat || '').toString().trim();
    const reason = (body.reason || '').toString().trim();
    const targetPeriodName = (body.target_period_name || '').toString().trim();
    if (!vat) {
        return res.status(400).json({ success: false, error: 'missing_vat' });
    }
    if (action === 'aplazar' && !targetPeriodName) {
        return res.status(400).json({ success: false, error: 'missing_target_period' });
    }
    if (!reason || reason.length < 10) {
        return res.status(400).json({ success: false, error: 'reason_too_short' });
    }

    try {
        const o = odoo();
        // 1. Resolve partner.
        const partners = await o.call(
            'res.partner',
            'search_read',
            [[['vat', '=', vat]]],
            { fields: ['id', 'name', 'vat'] }
        );
        if (!partners || partners.length === 0) {
            return res.status(404).json({ success: false, error: 'partner_not_found' });
        }
        const partner = partners[0];

        // 2. Resolve target period (only for aplazar).
        let targetPeriod = null;
        if (action === 'aplazar') {
            const periodos = await o.call(
                'periodos.periodo',
                'search_read',
                [[['name', '=', targetPeriodName]]],
                { fields: ['id', 'name', 'x_studio_fecha_inicio_bloque_1'] }
            );
            if (!periodos || periodos.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'period_not_found',
                    message: `No periodos.periodo with name=${targetPeriodName}`,
                });
            }
            targetPeriod = periodos[0];
        }

        // 3. Call the reusable methods on wizard.aplazar.estudiante via XML-RPC.
        //    These are wrappers around the same logic the UI wizard uses.
        const actor = actorContext(body);
        let result;
        try {
            const wizardId = await o.call(
                'wizard.aplazar.estudiante',
                'create',
                action === 'aplazar'
                    ? [{ partner_id: partner.id, periodo_id: targetPeriod.id }]
                    : [{ partner_id: partner.id }],
                {}
            );
            const methodName = action === 'aplazar' ? 'do_aplazo' : 'do_retiro';
            // XML-RPC instance method call: ids list + positional args.
            const wizardArgs = action === 'aplazar'
                ? [[wizardId], reason, actor]
                : [[wizardId], reason, actor];
            result = await o.call(
                'wizard.aplazar.estudiante',
                methodName,
                wizardArgs,
                {}
            );
            // Clean up the transient record.
            try {
                await o.call('wizard.aplazar.estudiante', 'unlink', [[wizardId]], {});
            } catch (e) {
                // best-effort
            }
        } catch (wizardErr) {
            console.error('[odoo_students] wizard call failed:', wizardErr.message || wizardErr);
            return res.status(500).json({
                success: false,
                error: 'wizard_failed',
                message: wizardErr.message || 'Odoo wizard call failed',
            });
        }

        return res.json({
            success: true,
            action,
            vat,
            partner_id: partner.id,
            target_period: action === 'aplazar' ? {
                id: targetPeriod.id,
                name: targetPeriod.name,
                start_block_1: targetPeriod.x_studio_fecha_inicio_bloque_1,
            } : null,
            invoices_updated: (result && result.invoices_updated) || 0,
            subscriptions_updated: (result && result.subscriptions_updated) || 0,
            moodle_updated: (result && result.moodle_updated) || false,
            odoo_result: result || null,
        });
    } catch (err) {
        console.error(`[odoo_students] ${action} error:`, err.message || err);
        return res.status(500).json({
            success: false,
            error: 'odoo_error',
            message: err.message || 'Odoo call failed',
        });
    }
}

module.exports = router;
