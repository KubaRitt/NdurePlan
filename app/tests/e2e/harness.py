import asyncio, json, pathlib, subprocess, socket, time, sys
from playwright.async_api import async_playwright

APP = pathlib.Path(__file__).resolve().parents[2]   # .../app
PUB = APP / 'public'
MOCK = (APP / 'tests/mock/supabase_api.js').read_text()
SHOTS = APP / 'tests/shots'
SHOTS.mkdir(exist_ok=True)
PORT = 8790
BASE = f'http://localhost:{PORT}'

def start_server():
    s = socket.socket()
    if s.connect_ex(('127.0.0.1', PORT)) == 0:
        s.close(); return None
    s.close()
    p = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)], cwd=PUB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    return p

PHONE = dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
             user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
DESKTOP = dict(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)

async def new_page(browser, kind='phone', mock=None, color_scheme='light'):
    opts = PHONE if kind == 'phone' else DESKTOP if kind == 'desktop' else kind
    ctx = await browser.new_context(timezone_id='Europe/Prague', locale='en-GB', color_scheme=color_scheme, **opts)
    async def mock_api(route):
        await route.fulfill(status=200, content_type='application/javascript', body=MOCK)
    await ctx.route('**/supabase_api.js', mock_api)
    await ctx.route('https://esm.sh/**', lambda r: r.abort())
    await ctx.add_init_script(f'window.__mock = {json.dumps(mock or {})};')
    page = await ctx.new_page()
    page.errors = []
    page.on('pageerror', lambda e: page.errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: page.errors.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    return page

async def load(page, path='dashboard.html'):
    await page.goto(f'{BASE}/{path}')
    await page.wait_for_function("!document.querySelector('.loading')", timeout=8000)
    await page.wait_for_timeout(250)

AUDIT = r"""
() => {
  const out = { overflowX: document.documentElement.scrollWidth > innerWidth + 1, smallText: [], smallTargets: [] };
  const seen = new Set();
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight * 3) return;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (own && parseFloat(cs.fontSize) < 12) { const k = el.tagName + '.' + el.className + ' ' + cs.fontSize; if (!seen.has(k)) { seen.add(k); out.smallText.push(k + ' "' + el.textContent.trim().slice(0, 20) + '"'); } }
    if (el.matches('button, a[href], input, select, textarea, summary') && !el.closest('[hidden]')) {
      if (el.type === 'hidden' || (el.tagName === 'INPUT' && el.closest('.switch-row, label.check-row'))) return;
      if (r.width < 40 || r.height < 40) out.smallTargets.push(`${Math.round(r.width)}x${Math.round(r.height)} ${el.tagName} ${(el.getAttribute('aria-label') || el.textContent || el.name || '').trim().slice(0, 30)}`);
    }
  });
  out.smallTargets = [...new Set(out.smallTargets)];
  return out;
}
"""
