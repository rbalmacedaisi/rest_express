// Standalone test for the staging guard in DES-LXP-008.
// Mirrors the boot guard in server.js without needing express/xmlrpc/cors.
// Run: node test_staging_guard.js
// Exits 0 on success, 1 on guard-trip.

function runBoot(env) {
  const ODOO_ENV = (env.ODOO_ENV || 'production').toLowerCase();
  const ALLOWED = new Set(['production', 'staging', 'development']);
  if (!ALLOWED.has(ODOO_ENV)) {
    throw new Error(`[boot] ODOO_ENV inválido: ${ODOO_ENV}`);
  }
  const URL = env.ODOO_URL || 'https://odoo.isi.edu.pa';
  const DB = env.ODOO_DB || 'odoo_staging';
  if (ODOO_ENV === 'staging') {
    const prodSignals = [
      URL.includes('odoo.isi.edu.pa') && !URL.includes('staging'),
      DB === 'odoo' || DB === 'odoo_prod',
    ];
    if (prodSignals.some(Boolean)) {
      throw new Error(`[boot] ODOO_ENV=staging pero config apunta a prod (URL=${URL}, DB=${DB})`);
    }
  }
  return { ODOO_ENV, URL, DB };
}

const cases = [
  {
    name: 'prod-default (no env vars) -> boot OK',
    env: {},
    expectThrow: false,
    expectEnv: 'production',
  },
  {
    name: 'prod explícito -> boot OK',
    env: { ODOO_ENV: 'production', ODOO_URL: 'https://odoo.isi.edu.pa', ODOO_DB: 'odoo' },
    expectThrow: false,
    expectEnv: 'production',
  },
  {
    name: 'staging + URL staging + DB staging -> boot OK',
    env: { ODOO_ENV: 'staging', ODOO_URL: 'https://odoo.students.isi.edu.pa', ODOO_DB: 'odoo_staging' },
    expectThrow: false,
    expectEnv: 'staging',
  },
  {
    name: 'staging + URL prod -> guard trip',
    env: { ODOO_ENV: 'staging', ODOO_URL: 'https://odoo.isi.edu.pa', ODOO_DB: 'odoo_staging' },
    expectThrow: true,
  },
  {
    name: 'staging + DB prod -> guard trip',
    env: { ODOO_ENV: 'staging', ODOO_URL: 'https://odoo.students.isi.edu.pa', ODOO_DB: 'odoo' },
    expectThrow: true,
  },
  {
    name: 'staging + URL prod + DB prod -> guard trip',
    env: { ODOO_ENV: 'staging', ODOO_URL: 'https://odoo.isi.edu.pa', ODOO_DB: 'odoo' },
    expectThrow: true,
  },
  {
    name: 'ODOO_ENV inválido -> guard trip',
    env: { ODOO_ENV: 'qa' },
    expectThrow: true,
  },
  {
    name: 'development -> boot OK',
    env: { ODOO_ENV: 'development', ODOO_URL: 'http://localhost:8069', ODOO_DB: 'odoo_dev' },
    expectThrow: false,
    expectEnv: 'development',
  },
];

let failed = 0;
for (const c of cases) {
  let err = null;
  let result = null;
  try { result = runBoot(c.env); } catch (e) { err = e; }
  const passed = (err === null) === !c.expectThrow && (!c.expectEnv || (result && result.ODOO_ENV === c.expectEnv));
  const tag = passed ? 'PASS' : 'FAIL';
  if (!passed) failed++;
  console.log(`${tag}  ${c.name}`);
  if (err) console.log(`      err: ${err.message}`);
  if (result) console.log(`      result: ${JSON.stringify(result)}`);
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);