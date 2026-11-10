# Takes screenshots with headless Chrome via Playwright (python).
import os, sys, time
from playwright.sync_api import sync_playwright
BASE = os.environ.get('BASE', 'http://localhost:3000')
OUT = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
os.makedirs(OUT, exist_ok=True)

def launch(p):
    try: return p.chromium.launch()
    except Exception: return p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

def answer(page, text, wait_step=None):
    page.fill('.qa-form input', text); page.press('.qa-form input', 'Enter')
    page.wait_for_timeout(900)

def click_quick(page, label):
    page.click(f'.qa-quick button:has-text("{label}")'); page.wait_for_timeout(900)

with sync_playwright() as p:
    b = launch(p)
    # Desktop home
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.goto(BASE + '/', wait_until='networkidle'); pg.wait_for_timeout(600)
    pg.screenshot(path=f'{OUT}/home-desktop.png')
    pg.screenshot(path=f'{OUT}/home-desktop-full.png', full_page=True)
    for name in ['services', 'service-area', 'about', 'contact', 'links']:
        pg.goto(f'{BASE}/{name}', wait_until='networkidle'); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{OUT}/{name}-desktop.png', full_page=True)
    # Floating widget open on home
    pg.goto(BASE + '/', wait_until='networkidle'); pg.evaluate('sessionStorage.clear()'); pg.reload(wait_until='networkidle')
    pg.click('.qa-launch'); pg.wait_for_timeout(1200)
    answer(pg, 'Listowel, ON'); answer(pg, 'Stratford, ON')
    pg.screenshot(path=f'{OUT}/widget-desktop.png')
    pg.close()
    # Mobile home
    m = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    m.goto(BASE + '/', wait_until='networkidle'); m.wait_for_timeout(600)
    m.screenshot(path=f'{OUT}/home-mobile.png')
    m.screenshot(path=f'{OUT}/home-mobile-full.png', full_page=True)
    m.goto(BASE + '/links', wait_until='networkidle'); m.wait_for_timeout(400)
    m.screenshot(path=f'{OUT}/links-mobile.png', full_page=True)
    m.click('.nav-toggle'); m.wait_for_timeout(400); m.screenshot(path=f'{OUT}/mobile-menu.png')
    m.close()
    # Quote page mid-conversation (happy path to estimate)
    q = b.new_page(viewport={'width': 1440, 'height': 1000})
    q.goto(BASE + '/quote', wait_until='networkidle'); q.evaluate('sessionStorage.clear()'); q.reload(wait_until='networkidle'); q.wait_for_timeout(1200)
    for t in ['Listowel, ON', 'Stratford, ON']: answer(q, t)
    q.screenshot(path=f'{OUT}/quote-mid-conversation.png')
    click_quick(q, '40 ft container'); answer(q, '18,000 lbs')
    q.fill('.qa-form input', '2026-11-02'); q.press('.qa-form input', 'Enter'); q.wait_for_timeout(900)
    click_quick(q, 'Tailgate needed'); q.wait_for_timeout(4000)
    q.screenshot(path=f'{OUT}/quote-estimate.png')
    # Over-limit case
    q.click('.qa-reset'); q.wait_for_timeout(1200)
    for t in ['Listowel', 'Kitchener, ON']: answer(q, t)
    click_quick(q, 'General freight'); answer(q, '30 ft'); answer(q, '25,000 lbs')
    q.screenshot(path=f'{OUT}/quote-over-limit.png')
    q.close()
    # Mobile quote assistant
    m = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    m.goto(BASE + '/', wait_until='networkidle'); m.evaluate('sessionStorage.clear()'); m.reload(wait_until='networkidle')
    m.click('.qa-launch'); m.wait_for_timeout(1200)
    answer(m, 'Listowel, ON'); answer(m, 'Stratford, ON'); click_quick(m, '20 ft container')
    m.screenshot(path=f'{OUT}/widget-mobile.png')
    m.close()
    # Admin
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, http_credentials={'username': 'admin', 'password': os.environ.get('ADMIN_PASSWORD', 'change-me')})
    a = ctx.new_page(); a.goto(BASE + '/admin', wait_until='networkidle'); a.wait_for_timeout(800)
    a.click('tr.row'); a.wait_for_timeout(400)
    a.screenshot(path=f'{OUT}/admin.png', full_page=True)
    b.close()
print('ok')
