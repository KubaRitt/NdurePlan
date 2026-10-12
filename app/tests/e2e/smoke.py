import asyncio, json, sys
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from harness import *

async def main():
    srv = start_server()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for kind in ['phone', 'desktop']:
            pg = await new_page(b, kind)
            await load(pg)
            await pg.screenshot(path=str(SHOTS / f'smoke_{kind}.png'), full_page=(kind == 'phone'))
            print(kind, 'errors:', pg.errors)
            print(kind, 'audit:', json.dumps(await pg.evaluate(AUDIT))[:1500])
        await b.close()
    if srv: srv.terminate()
asyncio.run(main())
