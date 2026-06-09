# PRD - Express Server (API Gateway)

## 1. Visión General

### 1.1 Descripción del Componente

Express Server es el servidor API Gateway desarrollado en Node.js/Express. Actúa como intermediario entre el Portal del Estudiante (LXP) y Odoo, manejando validación financiera, caché, webhooks y procesamiento de solicitudes.

### 1.2 Propósito del Sistema

- Gateway de API para el portal del estudiante
- Validación de estado financiero de estudiantes
- Gestión de caché de estados
- Procesamiento de webhooks (pagos, cartas)
- Bridge de comunicación Odoo ↔ LXP ↔ Moodle

### 1.3 Estado del Proyecto

**Versión**: 1.0
**Ubicación**: `C:\Users\Ramiro\Documents\TI\Proyectos\ExpressServer\rest_express`
**Puerto**: 4000
**Framework**: Node.js + Express

---

## 2. Arquitectura

### 2.1 Estructura del Proyecto

```
ExpressServer/
└── rest_express/
    ├── financial_source_config.json  # Config fuente financiera
    ├── odooApi.js               # Cliente Odoo XML-RPC
    ├── q10Api.js               # Cliente Q10 API (legacy)
    ├── server.js               # Servidor principal
    ├── server.js.bk          # Backup
    ├── renew-certificates.sh  # renew certificates
    └── package.json           # Dependencias
```

### 2.2 Tecnologías

| Componente | Tecnología |
|------------|------------|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| HTTPS | Node.js https (built-in) |
| HTTP Client | https, http (built-in) |
| XML Parser | xml2js |

### 2.3 Dependencias

```json
{
  "dependencies": {
    "express": "^4.x",
    "cors": "^2.8.x",
    "xml2js": "^0.5.x"
  }
}
```

---

## 3. Configuraciones

### 3.1 Variables de Entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | 4000 | Puerto del servidor |
| `MOODLE_URL` | https://lms.isi.edu.pa | URL de Moodle |
| `MOODLE_GRACE_TOKEN` | gmk_grace_check_2026 | Token período gracia |
| `MOODLE_LETTERS_WEBHOOK_URL` | ${MOODLE_URL}/local/grupomakro_core/letters_webhook.php | Webhook letras |
| `MOODLE_LETTERS_WEBHOOK_TOKEN` | gmk_letter_webhook_2026 | Token webhook letras |
| `ODOO_LETTERS_WEBHOOK_SECRET` | gmk_letters_hmac_2026 | Secret firma HMAC |
| `ODOO_URL` | https://odoo.isi.edu.pa | URL de Odoo |
| `ADMIN_SECRET` | gmk_admin_bypass_2026 | Secret admin |
| `FINANCIAL_SOURCE` | odoo | Fuente de datos |

### 3.2 Configuraciones de Archivo

```json
// bypass_config.json
{
  "enabled": false,
  "updatedAt": null,
  "updatedBy": null
}

// financial_source_config.json
{
  "source": "odoo",
  "updatedAt": null,
  "updatedBy": null
}
```

### 3.3 Certificados SSL

```javascript
// server.js
const httpsOptions = {
  key: fs.readFileSync('/home/ubuntu/odoo-proxy/certs/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/odoo-proxy/certs/fullchain.pem')
};
```

---

## 4. Endpoints

### 4.1 Endpoints de Estado Financiero

#### 4.1.1 GET /api/odoo/status

Verifica el estado financiero de un estudiante.

**Parámetros**:
- `documentNumber` (string, required): Número de documento del estudiante

**Respuesta exitosa (permitido)**:
```json
{
  "allowed": true,
  "reason": "al_dia"
}
```

**Respuesta denegada**:
```json
{
  "allowed": false,
  "reason": "mora"
}
```

**Posibles razones**:
| razón | Descripción |
|-------|-------------|
| `al_dia` | Sin facturas vencidas |
| `periodo_gracia` | Primer mes del estudiante |
| `contrato_especial` | Beca o descuento especial |
| `mora` | Tiene facturas vencidas |
| `sin_contrato` | Sin facturas registradas |
| `sincontrato` | Sin contrato activo |
| `bypass_financiero` | Bypass global activo |

#### 4.1.2 POST /api/odoo/status/bulk

Verifica el estado de múltiples estudiantes.

**Body**:
```json
{
  "documentNumbers": ["12345678", "87654321"]
}
```

**Respuesta**:
```json
{
  "12345678": { "allowed": true, "reason": "al_dia" },
  "87654321": { "allowed": false, "reason": "mora" }
}
```

#### 4.1.3 POST /api/odoo/cache/clear

Limpia la caché de estados.

**Body**:
```json
{
  "documentNumber": "12345678"
}
// o vacío para limpiar todo
```

---

### 4.2 Endpoints de Facturas

#### 4.2.1 GET /api/odoo/invoices

Obtiene las facturas de un estudiante.

**Parámetros**:
- `documentNumber` (string, optional): Número de documento
- `partnerId` (string, optional): ID del partner en Odoo

**Respuesta**:
```json
[
  {
    "id": 123,
    "name": "INV/2024/001",
    "amount_total": 150.00,
    "state": "posted",
    "invoice_date_due": "2024-03-15",
    "amount_residual": 150.00,
    "enlacePago": "https://odoo.isi.edu.pa/..."
  }
]
```

---

### 4.3 Endpoints de Perfil

#### 4.3.1 POST /api/odoo/profile/update

Actualiza el perfil del estudiante.

**Body**:
```json
{
  "documentNumber": "12345678",
  "phone": "+507 1234-5678",
  "birthdate": "2000-01-15"
}
```

**Respuesta**:
```json
{
  "success": true,
  "partnerId": 123
}
```

#### 4.3.2 GET /api/odoo/partner-contract-type

Obtiene el tipo de contrato especial.

**Parámetros**:
- `documentNumber` (string, required)

**Respuesta**:
```json
{
  "contractType": "beca_50"
}
```

---

### 4.4 Endpoints de Cartas

#### 4.4.1 POST /api/odoo/letters/invoice

Crea una factura para una carta solicitados.

**Body**:
```json
{
  "external_request_id": "CARTA_001",
  "document_number": "12345678",
  "amount": 25.00,
  "odoo_product_id": 1,
  "description": "Solicitud de constancia de estudios",
  "letter_type_code": "CONSTANCIA"
}
```

**Respuesta**:
```json
{
  "success": true,
  "invoice_id": "123",
  "invoice_number": "INV/2024/050",
  "payment_link": "https://odoo.isi.edu.pa/...",
  "external_request_id": "CARTA_001"
}
```

#### 4.4.2 POST /api/odoo/letters/attach-document

Adjunta un documento a una factura.

**Body**:
```json
{
  "external_request_id": "CARTA_001",
  "document_number": "12345678",
  "invoice_id": "123",
  "filename": "constancia.pdf",
  "mimetype": "application/pdf",
  "content_base64": "<base64>"
}
```

#### 4.4.3 POST /api/odoo/letters/webhook/payment

Webhook para recibir notificaciones de pago de letras.

**Headers**:
- `x-odoo-signature`: Firma HMAC-SHA256

**Body**:
```json
{
  "invoice_id": "123",
  "invoice_number": "INV/2024/050",
  "payment_state": "paid",
  "partner_vat": "12345678",
  "external_request_id": "CARTA_001",
  "event_time": "2024-01-15T10:00:00Z"
}
```

---

### 4.5 Endpoints Admin

#### 4.5.1 GET /api/admin/bypass

Consulta el estado del bypass financiero.

**Headers**:
- `x-admin-secret`: <ADMIN_SECRET>

**Respuesta**:
```json
{
  "enabled": false,
  "updatedAt": null,
  "updatedBy": null
}
```

#### 4.5.2 POST /api/admin/bypass

Activa o desactiva el bypass financiero global.

**Headers**:
- `x-admin-secret`: <ADMIN_SECRET>

**Body**:
```json
{
  "enabled": true,
  "updatedBy": "admin"
}
```

**Efecto**: Cuando está activado, TODOS los estudiantes pueden acceder SIN validación financiera.

#### 4.5.3 GET /api/admin/financial-source

Consulta la fuente de datos financieros activa.

**Respuesta**:
```json
{
  "source": "odoo",
  "updatedAt": null,
  "updatedBy": null
}
```

#### 4.5.4 POST /api/admin/financial-source

Cambia la fuente de datos financieros.

**Headers**:
- `x-admin-secret`: <ADMIN_SECRET>

**Body**:
```json
{
  "source": "odoo",  // o "q10"
  "updatedBy": "admin"
}
```

---

### 4.6 Endpoints de Reporting

#### 4.6.1 GET /api/odoo/students/career-funnel

Obtiene estadísticas de estudiantes por carrera/período.

**Parámetros**:
- `lp_name` (string, required): Nombre del Learning Plan
- `intake_period` (string, required): Período de intake

**Respuesta**:
```json
{
  "odoo_count": 150,
  "odoo_active": 120,
  "career_name": "Ingeniería en Sistemas"
}
```

---

## 5. Sistema de Caché

### 5.1 Implementación

```javascript
// Map en memoria
const studentStatusCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
```

### 5.2 Lógica de Caché

```
1. Verificar si existe en caché
         ↓
2. ¿existe? → ¿TTL válido?
         ↓
    Sí → Devolver caché
    No → Buscar en Odoo
         ↓
3. Guardar en caché
         ↓
4. Devolver resultado
```

### 5.3 Invalidación de Caché

La caché se limpia cuando:
1. Se activa el bypass financiero
2. Se cambia la fuente de datos financieros
3. Se llama manualmente `/api/odoo/cache/clear`

---

## 6. Lógica de Validación Financiera

### 6.1 Flujo Completo

```
1. LXP consulta /api/odoo/status
         ↓
2. ¿Bypass global activo?
    Sí → Permitir (reason: bypass_financiero)
    No → Continuar
         ↓
3. ¿Período de gracia?
    Sí → Consultar Moodle → Permitir si inGrace
    No → Continuar
         ↓
4. Buscar partner en Odoo
         ↓
5. ¿Partner existe?
    No → Denegar (reason: sin_contrato_o_usuario)
    Sí → Continuar
         ↓
6. ¿Tiene contrato especial?
    Sí → Permitir (reason: contrato_especial)
    No → Continuar
         ↓
7. Buscar facturas del partner
         ↓
8. ¿Hay facturas?
    No → Denegar (reason: sincontrato)
    Sí → Continuar
         ↓
9. ¿Hay facturas vencidas?
    Sí → Denegar (reason: mora)
    No → Permitir (reason: al_dia)
```

### 6.2 Definición de Factura Vencida

```javascript
const isOverdue = invoice =>
  invoice.state !== 'paid' &&
  invoice.invoice_date_due < new Date() &&
  invoice.amount_residual > 0;
```

---

## 7. Integraciones

### 7.1 Integración con Odoo

```
Express ──XML-RPC──► Odoo
            │
            └── res.partner, account.move, etc.
```

**Métodos utilizados**:
- `res.partner.search_read`
- `res.partner.write`
- `account.move.search_read`
- `account.move.create`
- `account.move.action_post`
- `moodle.user.search_read`
- `moodle.user.write`
- `ir.attachment.create`
- `moodle.career.mapping.search_read`

### 7.2 Integración con Moodle

```
Express ──HTTP──► Moodle
           │
           └── local_grupomakro_core/ajax.php
```

**Funcionalidades**:
- Verificar período de gracia
- Webhooks de letras

### 7.3 Integración con Q10 (Legacy)

```
Express ──API──► Q10
           │
           └── getStudentStatus, getStudentStatusBulk
```

**Estado**: Legacy, siendo reemplazado por Odoo

---

## 8. Seguridad

### 8.1 Autenticación Admin

```javascript
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}
```

### 8.2 Verificación de Webhooks

```javascript
function verifyWebhookSignature(payload, signature) {
  // HMAC-SHA256 comparison con timing safe
}
```

### 8.3 Rate Limiting

**Estado**: No implementado actualmente
**Recomendación**: Implementar en producción

---

## 9. Logging

### 9.1 Niveles de Logging

```javascript
console.log()     // General
console.warn()   // Warnings
console.error()  // Errores
```

### 9.2 Logs de request/response

```javascript
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('Headers:', req.headers);
  console.log('IP:', req.ip);
  next();
});
```

---

## 10. Manejo de Errores

### 10.1 Estructura de Respuesta

```json
{
  "success": false,
  "error": "mensaje de error"
}
```

### 10.2 Códigos de Estado

| Código | Descripción |
|--------|-------------|
| 200 | OK |
| 400 | Bad Request |
| 401 | Unauthorized |
| 404 | Not Found |
| 500 | Internal Server Error |
| 502 | Bad Gateway |
| 503 | Service Unavailable |

---

## 11. Consideraciones Técnicas

### 11.1 Timeouts

```javascript
// Timeout de request
req.setTimeout(5000, () => { req.destroy(); resolve(false); });

// Timeout de conexión
req.setTimeout(15000, () => {
  req.destroy(new Error('request_timeout'));
});
```

### 11.2 Gestión de Certificados

```bash
# renew-certificates.sh
# Script para renovar certificados SSL
```

### 11.3 Puerto y Binding

```javascript
const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

https.createServer(httpsOptions, app)
  .listen(PORT, HOST, () => {
    console.log(`Odoo proxy API corriendo en https://${HOST}:${PORT}`);
  });
```

---

## 12. Flujos Completos

### 12.1 Flujo: Login de Estudiante

```
1. Estudiante intenta acceder a LXP
         ↓
2. LXP llama /api/odoo/status?documentNumber=xxx
         ↓
3. Express verifica estado
         ↓
4. ¿allowed?
    Sí → Permitir acceso a LXP
    No → Mostrar mensaje de mora + facturas
```

### 12.2 Flujo: Consulta de Facturas

```
1. Estudiante navega a "Facturas" en LXP
         ↓
2. LXP llama /api/odoo/invoices?documentNumber=xxx
         ↓
3. Express busca partner por documento
         ↓
4. Express obtiene facturas de Odoo
         ↓
5. Express normaliza URLs de pago
         ↓
6. LXP muestra facturas con enlaces
```

### 12.3 Flujo: Solicitud de Carta

```
1. Estudiante solicita carta en LXP
         ↓
2. LXP llama /api/odoo/letters/invoice
         ↓
3. Express crea factura en Odoo
         ↓
4. Express retorna payment_link
         ↓
5. Estudiante paga en Odoo
         ↓
6. Odoo webhook → Express → Moodle
         ↓
7. Carta habilitada en Moodle
```

---

## 13. Roadmap

### 13.1 Mejoras Inmediatas

- [ ] Implementar rate limiting
- [ ] mejorar logs estructurados
- [ ] health check endpoint
- [ ] Métricas de rendimiento

### 13.2 Mejoras Mediano Plazo

- [ ] Cache Redis
- [ ] API versioning
- [ ] Documentación OpenAPI
- [ ] tests automatizados

### 13.3 Mejoras Largo Plazo

- [ ] Rate limiting por usuario
- [ ] autenticacion OAuth
- [ ] Websocket para notifications
- [ ] Rate limiting avanzado

---

## 14. Anexos

### 14.1 URLs de Acceso

| Servicio | URL |
|----------|-----|
| Express | `https://api.isi.edu.pa` (propuesto) |
| Desarrollo | `http://localhost:4000` |

### 14.2 Endpoints Públicos vs Privados

| Público | Privado (Admin) |
|---------|--------------|
| /api/odoo/* | /api/admin/* |
| /api/odoo/status | /api/admin/bypass |
| /api/odoo/invoices | /api/admin/financial-source |

### 14.3 IPs Permitidas

Configurar en producción:
- IP del servidor LXP
- IPs administrativas

---

**Documento creado**: 2026
**Versión**: 1.0
**Componente**: Express Server (API Gateway)