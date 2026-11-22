// User-visible "Driver" wording is now "Contractor". Routes, roles, and field
// names stay driver_*. Run: npm test
const assert = require('assert');
const h = require('./helpers/server');

const DRIVER_WORD = /\bDrivers?\b|\bdrivers?\b/;

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// Visible page text: HTML text nodes plus title/placeholder/aria-label/alt, and
// English string literals inside <script> (confirm, alert, textContent).
function visibleText(html) {
  let src = String(html);
  const scriptStrings = [];
  src = src.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, code) => {
    const re = /(['"])((?:\\.|[^\\])*?)\1/g;
    let m;
    while ((m = re.exec(code))) {
      const raw = m[2].replace(/\\['"]/g, "'").replace(/\\n/g, '\n');
      if (/\s/.test(raw)) scriptStrings.push(raw);
    }
    const tre = /`([\s\S]*?)`/g;
    while ((m = tre.exec(code))) {
      const raw = m[1];
      if (/\s/.test(raw)) scriptStrings.push(raw);
    }
    return ' ';
  });
  src = src.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  src = src.replace(/<!--[\s\S]*?-->/g, ' ');
  const attrs = [];
  src.replace(/\b(?:title|placeholder|aria-label|alt)\s*=\s*("([^"]*)"|'([^']*)')/gi, (_, _q, d, s) => {
    attrs.push(d != null ? d : s);
    return _;
  });
  const text = src.replace(/<[^>]+>/g, ' ');
  return decodeEntities([text, attrs.join(' '), scriptStrings.join(' ')].join(' ')).replace(/\s+/g, ' ');
}

function assertContractorWording(html, label) {
  const visible = visibleText(html);
  assert.ok(/\bContractors?\b|\bcontractors?\b/.test(visible), `${label}: expected visible Contractor wording\n${visible.slice(0, 400)}`);
  const leftover = visible.match(DRIVER_WORD);
  assert.ok(!leftover, `${label}: visible leftover "${leftover && leftover[0]}" in: ${visible.slice(Math.max(0, (leftover && leftover.index) || 0) - 80, ((leftover && leftover.index) || 0) + 80)}`);
}

(async () => {
  const { check, results } = h.makeChecker();
  const adminPassword = 'Contractor-Wording-Admin-1';
  const dataDir = h.tempDataDir('dt1-contractor-wording-');
  const srv = await h.startServer({
    DATA_DIR: dataDir,
    LOGAN_TMS_PASSWORD: adminPassword,
    LOGAN_API_TOKEN: '',
    SESSION_SECRET: 'contractor-wording-test'
  });
  try {
    const admin = await h.loginAdmin(srv.port, adminPassword);
    const get = (p) => h.request(srv.port, { Cookie: h.cookieHeader(admin) }, { path: p });

    await check('sidebar, contractors list, and settlements render Contractor and no visible Driver word', async () => {
      for (const path of ['/dashboard', '/drivers', '/settlements']) {
        const page = await get(path);
        assert.strictEqual(page.status, 200, path);
        if (path === '/dashboard' || path === '/drivers') {
          assert.ok(page.body.includes('href="/drivers"') && page.body.includes('>Contractors<'), `${path}: sidebar/list still links to /drivers with Contractors label`);
        }
        if (path === '/drivers') {
          assert.ok(page.body.includes('Add New Contractor'));
          assert.ok(page.body.includes('<h1>Contractors</h1>'));
        }
        if (path === '/settlements') {
          assert.ok(page.body.includes('Contractor Settlement') || page.body.includes('contractor'));
        }
        assertContractorWording(page.body, path);
      }
    });

    await check('load form, invoices, and communications use Contractor labels', async () => {
      for (const path of ['/loads/new', '/loads', '/invoices', '/communications', '/drivers/new', '/projects']) {
        const page = await get(path);
        assert.strictEqual(page.status, 200, path);
        assertContractorWording(page.body, path);
      }
    });
  } finally {
    await h.stop(srv.child);
  }
  console.log(`\n${results.length} contractor-wording checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
