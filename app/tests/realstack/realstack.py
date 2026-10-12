"""End-to-end against the real supabase_api.js + real supabase-js, talking to a
fake PostgREST over a local Postgres that has the migration and RLS."""
import asyncio, base64, json, sys, time, subprocess
HERE = __import__('pathlib').Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'e2e'))
sys.path.insert(0, str(HERE))
from harness import start_server, BASE, PHONE, DESKTOP, SHOTS
from playwright.async_api import async_playwright
subprocess.run([str(HERE / 'reset_db.sh')], check=True)
import fake_postgrest as fp

BUNDLE = (HERE / 'supabase-js.bundle.mjs').read_text()
U1 = '11111111-1111-1111-1111-111111111111'

def b64(o):
    return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')

def session_for(uid, email):
    exp = int(time.time()) + 86400
    token = f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64({'sub': uid, 'email': email, 'role': 'authenticated', 'aud': 'authenticated', 'exp': exp})}.sig"
    return {'access_token': token, 'token_type': 'bearer', 'expires_in': 86400, 'expires_at': exp, 'refresh_token': 'refresh',
            'user': {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': email, 'app_metadata': {}, 'user_metadata': {}, 'created_at': '2026-06-14T00:00:00Z'}}

def psql(sql):
    return subprocess.run(['psql', '-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', 't2', '-At', '-c', sql], capture_output=True, text=True).stdout.strip()

results = []
def check(name, cond, detail=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))

async def page_for(b, kind):
    ctx = await b.new_context(timezone_id='Europe/Prague', locale='en-GB', **(PHONE if kind == 'phone' else DESKTOP))
    async def esm(route):
        await route.fulfill(status=200, content_type='application/javascript', body=BUNDLE)
    await ctx.route('https://esm.sh/**', esm)
    reqs = []
    async def api(route):
        r = route.request
        headers = {k.lower(): v for k, v in r.headers.items()}
        status, h, body = fp.handle(r.method, r.url, headers, r.post_data)
        reqs.append((r.method, r.url.split('/rest/v1/')[-1][:140], status))
        await route.fulfill(status=status, headers={**h, 'access-control-allow-origin': '*'}, body=body)
    await ctx.route('https://ogikyrfnsaswqwsldkhr.supabase.co/**', api)
    await ctx.add_init_script(f"localStorage.setItem('sb-ogikyrfnsaswqwsldkhr-auth-token', {json.dumps(json.dumps(session_for(U1, 'kuba@example.com')))});")
    pg = await ctx.new_page()
    pg.errors = []
    pg.reqs = reqs
    pg.on('pageerror', lambda e: pg.errors.append(str(e)))
    pg.on('console', lambda m: pg.errors.append(m.text) if m.type == 'error' else None)
    pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    return pg

async def main():
    srv = start_server()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await page_for(b, 'phone')
        await pg.goto(f'{BASE}/dashboard.html')
        await pg.wait_for_function("!document.querySelector('.loading')", timeout=10000)
        await pg.wait_for_timeout(400)
        body = await pg.locator('#view-plan').inner_text()
        check('real: own sessions load (old-format row shows)', 'Threshold 4x6 (old format)' in body, body[:200])
        check('real: other user\'s session is not visible (RLS)', 'OTHER USER' not in body)
        thr = pg.locator('.dc-session', has_text='Threshold 4x6')
        meta = await thr.locator('.dc-meta').inner_text()
        check('real: old whole-minute blocks read correctly (15+4x6+3 jog+15 = 57 min)', '57 min' in meta, meta)

        # one-tap done
        await thr.locator('.done-btn').tap()
        await pg.wait_for_timeout(600)
        check('real: done saved to Postgres', psql("select done from sessions where description like 'Threshold 4x6%'") == 't')

        # diary for today
        await pg.locator('.tabbar [data-view="today"]').tap()
        await pg.wait_for_selector('#view-today .day-log')
        await pg.locator('#view-today input[data-diary="sleep_h"]').fill('7,5')
        await pg.locator('#view-today [data-action="set-legs"][data-value="heavy"]').tap()
        await pg.locator('#view-today input[data-diary="pain"]').fill('4')
        await pg.wait_for_timeout(1300)
        row = psql(f"select sleep_h, legs, pain from diary where user_id = '{U1}' and date = current_date")
        check('real: diary row upserted (7,5 -> 7.5)', row == '7.5|heavy|4', row)
        await pg.locator('#view-today textarea[data-diary="notes"]').fill('second save updates the same row')
        await pg.wait_for_timeout(1300)
        n = psql(f"select count(*) from diary where user_id = '{U1}'")
        check('real: second diary save updates, not duplicates', n == '1', n)
        check('real: other user\'s diary untouched', psql(f"select notes from diary where user_id <> '{U1}'") == 'OTHER USER DIARY')

        # add a strength session from template on today (Plan tab)
        await pg.locator('#view-today .tab', has_text='Plan').tap()
        await pg.locator('#view-today .chip', has_text='Strength').tap()
        await pg.wait_for_timeout(700)
        row = psql("select sport_type, discipline, blocks->0->>'intensity', blocks->0->>'duration_s', blocks->0->>'rpe', \"time\" is null from sessions where sport_type = 'strength'")
        check('real: strength session passes the new sport_type check', row == 'strength|Strength|strength|1800|6|t', row)

        # edit it: set start time, change RPE to 7
        await pg.locator('#view-today .s-card', has_text='Strength').locator('[data-action="edit-session"]').tap()
        await pg.wait_for_selector('.ov-full .editor')
        await pg.locator('.ov-full input[data-f="time"]').fill('18:00')
        await pg.locator('.ov-full .blk-toggle').first.tap()
        await pg.locator('.ov-full input[data-bf="rpe"]').fill('7')
        await pg.locator('.ov-full button[type=submit]').tap()
        await pg.wait_for_timeout(700)
        row = psql("select \"time\", blocks->0->>'rpe' from sessions where sport_type = 'strength'")
        check('real: edit saved (time + RPE)', row == '18:00:00|7', row)

        # delete + undo
        await pg.locator('#view-today .s-card', has_text='Strength').locator('[data-action="delete-session"]').tap()
        await pg.wait_for_timeout(600)
        check('real: delete removes the row', psql("select count(*) from sessions where sport_type = 'strength'") == '0')
        await pg.locator('.toast-btn').tap()
        await pg.wait_for_timeout(600)
        check('real: undo puts it back', psql("select count(*) from sessions where sport_type = 'strength'") == '1')

        # save as template
        await pg.locator('#view-today .s-card', has_text='Strength').locator('[data-action="edit-session"]').tap()
        await pg.wait_for_selector('.ov-full .editor')
        await pg.locator('.ov-full [data-ed="tpl-open"]').tap()
        await pg.locator('.ov-full [data-ed-tplname]').fill('Gym A')
        await pg.locator('.ov-full [data-ed="tpl-save"]').tap()
        await pg.wait_for_timeout(600)
        check('real: template stored', psql("select name, sport_type from templates") == 'Gym A|strength')
        await pg.locator('.ov-full [data-ed="cancel"]').tap()
        await pg.wait_for_timeout(300)

        # copy last week into next week
        await pg.locator('.tabbar [data-view="plan"]').tap()
        await pg.locator('[data-action="week-next"]').tap()
        await pg.wait_for_timeout(300)
        await pg.locator('[data-action="copy-week"]').tap()
        await pg.wait_for_selector('[data-copy-form]')
        await pg.locator('[data-copy-form] button[type=submit]').tap()
        await pg.wait_for_timeout(800)
        n = psql(f"select count(*) from sessions where user_id = '{U1}' and date >= date_trunc('week', current_date)::date + 7 and date < date_trunc('week', current_date)::date + 14")
        check('real: copy week inserted rows', int(n or 0) >= 2, n)
        dup_done = psql(f"select bool_or(done) from sessions where user_id = '{U1}' and date >= date_trunc('week', current_date)::date + 7")
        check('real: copied sessions are not marked done', dup_done == 'f', dup_done)

        # FIT files: upload, link, store pieces (real Postgres + RLS)
        FX = HERE.parent / 'fixtures'
        await pg.locator('.tabbar [data-view="today"]').tap()
        await pg.locator('#view-today .tab', has_text='Diary').tap()
        await pg.wait_for_selector('#view-today [data-action="import-files"]')
        async with pg.expect_file_chooser() as fc:
            await pg.locator('#view-today [data-action="import-files"]').first.tap()
        await (await fc.value).set_files([str(FX / 'threshold.fit'), str(FX / 'hills.fit')])
        await pg.wait_for_selector('.ov .imp', timeout=10000)
        await pg.locator('.ov button[type=submit]').tap()
        await pg.wait_for_timeout(1800)
        row = psql(f"select count(*), bool_and(session_id is not null), max(char_length(pieces)) < 3000, bool_and(hr_quality = 'ok') from activities where user_id = '{U1}'")
        check('real: 2 FIT files stored and linked, pieces under 3 kB', row == '2|t|t|t', row)
        row = psql("select s.done, (s.actual->>'duration_s')::int between 3400 and 3430, a.hr_load between 90 and 105 from sessions s join activities a on a.session_id = s.id where s.description like 'Threshold 4x6%'")
        check('real: threshold file linked to the planned session, diary filled', row == 't|t|t', row)
        row = psql(f"select discipline, done from sessions where user_id = '{U1}' and date = '2026-10-04'")
        check('real: unplanned trail file got a new Trail Run session', row == 'Trail Run|t', row)
        hr_before = psql("select hr_load from activities where activity_uid like '%3412345678%' order by start_time desc limit 1")
        check('real: phone opens the day the files went to', await pg.locator('.ov-sheet .act').count() >= 1)
        await pg.locator('.ov-sheet [data-action="close-overlay"]').first.tap()
        await pg.wait_for_timeout(400)

        # zones
        await pg.locator('.tabbar [data-view="settings"]').tap()
        await pg.locator('input[name="run|ap2"]').fill('182')
        await pg.locator('[data-form="zones"] button[type=submit]').tap()
        await pg.wait_for_timeout(600)
        check('real: zones saved to profile', psql(f"select hr_zones->'run'->>'ap2' from profiles where id = '{U1}'") == '182')
        await pg.wait_for_timeout(800)
        hr_after = psql("select hr_load from activities where activity_uid like '%3412345678%' order by start_time desc limit 1")
        check('real: file loads recalculated after the zone change', hr_before and hr_after and float(hr_after) < float(hr_before), (hr_before, hr_after))

        check('real: no page errors', not pg.errors, pg.errors)
        bad = [r for r in pg.reqs if r[2] >= 400]
        check('real: no failed API requests', not bad, bad)
        await pg.context.close()

        # desktop load against the same DB
        pg = await page_for(b, 'desktop')
        await pg.goto(f'{BASE}/dashboard.html')
        await pg.wait_for_function("!document.querySelector('.loading')", timeout=10000)
        await pg.wait_for_timeout(500)
        check('real desktop: loads with no errors', not pg.errors, pg.errors)
        await pg.screenshot(path=str(SHOTS / 'real_desktop.png'))
        await pg.context.close()
        await b.close()
    if srv: srv.terminate()
    print(f'\n{sum(results)} passed, {len(results) - sum(results)} failed')

asyncio.run(main())
