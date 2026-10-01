# rest_express

Proxy Express entre el LXP (Nuxt 2 estático en AWS Amplify), Moodle y Odoo.
Levanta endpoints REST consumidos por el plugin Moodle `local_grupomakro_core`,
los wizards LXP del status académico y los módulos Odoo de webhooks de pago.

Toda la lógica vive en `server.js`, `odoo_students.js`, `odooApi.js` y `q10Api.js`.

## Variables de entorno

Ver [`.env.example`](./.env.example) para la lista completa y defaults.

Las **variables que cambian entre producción y staging** son:

| Variable | Producción | Staging |
|---|---|---|
| `ODOO_ENV` | `production` | `staging` |
| `ODOO_URL` | `https://odoo.isi.edu.pa` | `https://odoo.students.isi.edu.pa` (NLB interno hasta que se exponga vía CF) |
| `ODOO_DB` | `odoo` | `odoo_staging` |
| `ODOO_APIKEY` | secret en AWS SM | secret staging |
| `MOODLE_URL` | `https://lms.isi.edu.pa` | `https://lms.students.isi.edu.pa` |
| `ODOO_PROXY_API_KEY` | secret compartido con Moodle wizard | secret distinto por ambiente |
| `ADMIN_SECRET` | secret | secret (no usar el default `gmk_admin_bypass_2026`) |

## Staging deploy

### Topología objetivo (post INF-005)

```
Internet
   │  (Cloudflare WAF proxy on, cert wildcard *.students.isi.edu.pa)
   ▼
NLB público (prod, fuera del scope staging)
   │
   └── LXP (Amplify, static) ──▶ Express prod ──▶ Odoo prod / Moodle prod

VPC staging 10.1.0.0/16
   │
   ├── EC2 Express staging  ──▶ NLB interno ──▶ EC2 Odoo staging
   │                                              (xmlrpc)
   │                          ──▶ EC2 Moodle staging  (HMAC webhooks)
   │
   └── EC2 Moodle web staging ──▶ RDS/Ec2 Moodle DB staging
```

El Express staging vive en una EC2 `t3.small` dentro del stack
`odoo-aws-staging` (rama `feature/staging-env` en `aws-odoo-infrastructure`).
El NLB interno expone Express a la VPC staging; el tráfico desde Moodle
staging y desde el LXP staging (cuando se publique) llega por el DNS interno
del NLB.

### Pasos de despliegue

1. **Esperar INF-005 CREATE_COMPLETE.** El @ingeniero-de-infraestructura
   levanta los stacks 00/10/30/40/50/60/65/66/70/99. Sin esos stacks,
   Express staging no tiene red ni ECR para correr.
2. **Build de imagen.** El repo `aws-odoo-infrastructure` define ECR
   `odoo-aws-staging/express`. La imagen se construye con el Dockerfile del
   stack (no incluido en este repo; ver `cloudformation/66-ec2-staging-express.yaml`).
3. **Subir secretos a AWS Secrets Manager.** Path:
   `isi/staging/express/<NAME>` (definidos en `40-secrets-staging.yaml`):
   `ODOO_APIKEY`, `MOODLE_GRACE_TOKEN`, `MOODLE_LETTERS_WEBHOOK_TOKEN`,
   `MOODLE_REVALID_WEBHOOK_TOKEN`, `MOODLE_MODULE_WEBHOOK_TOKEN`,
   `MOODLE_FINANCIAL_WEBHOOK_TOKEN`, `ODOO_PAYMENT_WEBHOOK_SECRET`,
   `ODOO_LETTERS_WEBHOOK_SECRET`, `ODOO_REVALID_WEBHOOK_SECRET`,
   `ODOO_MODULE_WEBHOOK_SECRET`, `ODOO_PROXY_API_KEY`, `ADMIN_SECRET`.
4. **Inyectar secrets en el EC2 staging.** Vía `userdata` de la CFN o vía
   `aws ssm get-parameters` en un sidecar. El Express lee
   `process.env.<NAME>` directo, así que el path más simple es poblar
   `/etc/environment` desde SSM en el `userdata`.
5. **Sanity check post-boot.** El log debe arrancar con:
   ```
   [boot] ODOO_ENV=staging ODOO_URL=https://odoo.students.isi.edu.pa ODOO_DB=odoo_staging MOODLE_URL=https://lms.students.isi.edu.pa
   ```
   Si la línea dice `ODOO_ENV=production`, el secret no se inyectó — la
   EC2 está corriendo con los defaults de código, hablar con prod.
6. **Verificar guard de staging.** El guard de boot (en `server.js`) rechaza
   arrancar si `ODOO_ENV=staging` pero `ODOO_URL` apunta a `odoo.isi.edu.pa`
   o `ODOO_DB=odoo`. Esto blinda contra un deploy staging con secretos
   viejos de prod.

### Smoke tests post-deploy

Con `curl` desde la oficina o un bastion en la VPC staging:

```bash
# 1. Health: ¿el proceso arrancó?
curl -s http://<staging-express-internal-dns>:3000/api/odoo/status?documentNumber=000000000

# 2. ¿Odoo staging responde? (espera allowed=false reason=sin_contrato_o_usuario)
# 3. Webhook de pago (idempotencia + dedupe):
curl -X POST http://<staging-express-internal-dns>:3000/api/odoo/cache/invalidate \
  -H 'X-Odoo-Signature: sha256=<HMAC con ODOO_PAYMENT_WEBHOOK_SECRET staging>' \
  -H 'Content-Type: application/json' \
  -d '{"partner_vat":"X-X-X","invoice_id":"1","reason":"invoice_paid","event_time":"2026-09-16T12:00:00Z"}'
```

### Diferencias vs producción

- **Fuente financiera:** en staging arranca en `odoo`. Para probar el path
  Q10 (modo legacy de migración), el endpoint admin permite
  `POST /api/odoo/admin/financial-source {source:"q10"}`. **No recomendado**
  en staging porque el Q10 de prod no debe recibir tráfico staging.
- **Bypass global:** arranca en `false`. Se puede activar vía
  `POST /api/odoo/admin/bypass {enabled:true}` (HMAC con `ADMIN_SECRET`).
- **Caché de status:** vacía al boot. Tarda ~10 min en calentarse con
  tráfico sintético; el `OVERDUE_GRACE_DAYS` de Moodle staging se refresca
  a los 5 min del primer hit.

### Runbook (rotura común)

| Síntoma | Causa probable | Acción |
|---|---|---|
| `401 invalid_signature` en `/api/odoo/cache/invalidate` | `ODOO_PAYMENT_WEBHOOK_SECRET` no coincide con el módulo Odoo staging | Rotar secret en SM y reiniciar EC2 |
| `504 Q10 query failed` | `financial_source_config.json` quedó en `q10` de un test previo | `POST /api/odoo/admin/financial-source {source:"odoo"}` |
| `BYPASS activado por error` | Alguien activó bypass y no desactivó | `POST /api/odoo/admin/bypass {enabled:false}` |
| Boot log dice `ODOO_ENV=production` | SSM parameter no se inyectó al `userdata` | Verificar permisos IAM del rol EC2 + reiniciar |

## RET-01 (Solicitud de Retiro del Programa)

El WDR manager de Moodle (`local_grupomakro_core`) usa estos endpoints
para cerrar el ciclo "el estudiante queda en estado retirado" pasando por
Odoo. Auth: `X-Api-Key` con el mismo valor que `ODOO_PROXY_API_KEY`
(el módulo lee `config.proxyApiKey`).

### GET /api/odoo/wdr/pending-balance?documentNumber=<vat>

Devuelve el balance pendiente (posted + not_paid|partial) de un partner,
sin mutar nada. El inbox admin de Moodle lo llama al hacer clic en
"Procesar" para decidir si bloquea o fuerza la cancelación.

Respuesta (200):

```json
{
  "success": true,
  "documentNumber": "8-123-456",
  "partner_id": 17,
  "partner_name": "Juan Pérez",
  "financial_status": "vencido",
  "hasBalance": true,
  "total": 1234.56,
  "currency": "USD",
  "currencies": ["USD"],
  "invoiceCount": 2,
  "overdueCount": 2,
  "fetchedAt": "2026-10-01T10:00:00.000Z"
}
```

### POST /api/odoo/wdr/process-retirement

Body:

```json
{
  "documentNumber": "8-123-456",
  "wdrId": 42,
  "reason": "Retiro por motivos economicos, autorizado por Direccion Academica.",
  "force": false,
  "actor_username": "admin",
  "actor_email": "admin@isi.edu.pa",
  "actor_moodle_id": 5
}
```

- Si `hasBalance=true` y `force=false` → responde **409** con
  `error: 'pending_balance'`, `balance: { total, currency, invoiceCount, overdueCount }`.
- Si pasa, invoca `wizard.aplazar.estudiante.do_retiro(vat, reason, actor)`
  (mismo código path que `POST /api/odoo/students/retirar`) y devuelve
  `{ success, action: 'retiro', wdrId, partner_id, partner_name, hasBalance, forced,
     balance, invoices_updated, subscriptions_updated, moodle_updated, processed_at }`.

Validación: `wdrId > 0`, `reason.length >= 10` (tope del resto de endpoints
de `students/*`).

Notas:
- `force=true` requiere que el llamador ya validó la justificación en Moodle
  (cap `manage_wdr_requests` + audit log) — Express solo aplica el mínimo
  (`reason.length >= 10`) para no duplicar reglas.
- El `wdrId` es informativo: el audit definitivo vive en
  `mdl_gmk_wdr.status`, `forced_at/by/reason` en Moodle, no en Odoo.
- Si el partner tiene varias monedas en su `account.move`, `currency` viene
  como `"USD|PAB"` y `currencies` mantiene los tokens separados.