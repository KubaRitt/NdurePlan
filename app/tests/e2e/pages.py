import asyncio, sys
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from harness import *
async def main():
    srv = start_server()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # fresh screenshot for the landing page
        pg = await new_page(b, 'desktop')
        await load(pg)
        await pg.screenshot(path=str(SHOTS / 'landing_shot.png'))
        await pg.context.close()
        for kind in ['phone', 'desktop']:
            pg = await new_page(b, kind, mock={'signedIn': False})
            for path in ['index.html', 'login.html', 'login.html?tab=register']:
                await pg.goto(f'{BASE}/{path}'); await pg.wait_for_timeout(400)
                a = await pg.evaluate(AUDIT)
                name = path.replace('.html', '').replace('?tab=', '_')
                await pg.screenshot(path=str(SHOTS / f'{kind}_{name}.png'), full_page=True)
                print(kind, path, 'overflow' if a['overflowX'] else 'fits', 'small text:', a['smallText'][:3], 'errors:', pg.errors)
            title = await pg.locator('#auth-title').inner_text()
            print(kind, 'register title:', title)
            await pg.locator('#auth-submit').click(); await pg.wait_for_timeout(100)
            print(kind, 'empty submit msg:', await pg.locator('#auth-message').inner_text())
            await pg.context.close()
        await b.close()
    if srv: srv.terminate()
asyncio.run(main())
