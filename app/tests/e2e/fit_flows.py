"""FIT upload flows on phone and desktop (mock API, clock fixed to Fri 9 Oct 2026).
Run: python3 tests/e2e/fit_flows.py
"""
import asyncio, base64, json, sys, tempfile, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from harness import *

FX = APP / 'tests/fixtures'
NOW = '2026-10-09T10:00:00+02:00'
results = []

def check(name, cond, detail=''):
    results.append((bool(cond), name, detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))

async def page_at(b, kind):
    pg = await new_page(b, kind)
    await pg.clock.set_fixed_time(NOW)
    return pg

async def db(pg):
    return await pg.evaluate('window.__mockState.db()')

async def calls(pg, name):
    return [c for c in await pg.evaluate('window.__mockState.calls') if c['name'] == name]

async def pick(pg, files):
    async with pg.expect_file_chooser() as fc:
        await pg.locator('[data-action="import-files"]:visible').first.click()
    await (await fc.value).set_files(files)

async def phone(b):
    pg = await page_at(b, 'phone')
    await load(pg)
    await pg.locator('.tabbar [data-view="today"]').tap()
    await pg.wait_for_selector('#view-today .day-panel')
    check('phone: Today diary has "Add FIT files"', await pg.locator('#view-today [data-action="import-files"]').count() == 1)

    junk = pathlib.Path(tempfile.mkdtemp()) / 'notes.txt'
    junk.write_text('not a fit file')
    await pick(pg, [str(FX / 'threshold.fit'), str(FX / 'garmin-export.zip'), str(FX / 'stops.fit'), str(FX / 'cadence-lock.fit'), str(junk)])
    await pg.wait_for_selector('.ov [data-import-form] .imp', timeout=8000)
    await pg.wait_for_timeout(200)
    cards = pg.locator('.ov .imp')
    check('import: 3 new activities listed (the ZIP copy is a duplicate)', await cards.count() == 3, await cards.count())
    body = await pg.locator('.ov .dialog-body').inner_text()
    check('import: unreadable file is named with the reason', 'notes.txt' in body and 'not a FIT or ZIP' in body, body[:300])
    check('import: duplicate noted', 'already saved' in body, body[:300])
    data = await db(pg)
    tue = next(s for s in data['sessions'] if s['date'] == '2026-10-06')
    mon = next(s for s in data['sessions'] if s['date'] == '2026-10-05')
    card = lambda day: pg.locator('.ov .imp').filter(has=pg.locator('.imp-head', has_text=day))
    sel_thr = await card('Tue').locator('select').input_value()
    sel_stops = await card('Mon').locator('select').input_value()
    sel_lock = await card('Sat').locator('select').input_value()
    check('import: threshold file matched to Tuesday’s planned session', sel_thr == f"s:{tue['id']}", sel_thr)
    check('import: Monday file matched to Monday’s run', sel_stops == f"s:{mon['id']}", sel_stops)
    check('import: Saturday file (nothing planned) -> new Road Run', sel_lock == 'n:Road Run', sel_lock)
    thr_txt = await card('Tue').inner_text()
    check('import: loads shown before saving', 'Heart' in thr_txt and 'Legs' in thr_txt, thr_txt)
    stops_txt = await card('Mon').inner_text()
    check('import: long stops explained', 'standing still is not counted' in stops_txt, stops_txt)
    lock_txt = await card('Sat').inner_text()
    check('import: cadence-locked HR explained', 'step rate' in lock_txt, lock_txt)
    a = await pg.evaluate(AUDIT)
    check('import dialog: no overflow / small text', not a['overflowX'] and not a['smallText'], a)
    await pg.screenshot(path=str(SHOTS / 'p_import_dialog.png'))
    # change the Saturday one to orienteering
    await card('Sat').locator('select').select_option('n:Orienteering')
    await pg.wait_for_timeout(100)
    lock_after = await card('Sat').locator('[data-imp-loads]').inner_text()
    check('import: loads follow the chosen session type', 'Legs' in lock_after, lock_after)
    await pg.locator('.ov button[type=submit]').tap()
    await pg.wait_for_selector('.toast')
    toast = await pg.locator('.toast-text').inner_text()
    check('import: toast confirms', 'Saved 3 files' in toast and '1 new session' in toast, toast)
    await pg.wait_for_timeout(300)
    data = await db(pg)
    check('import: 3 activities stored', len(data['activities']) == 3, len(data['activities']))
    check('import: pieces stored as text, about 1.7 kB/h', all(isinstance(x.get('pieces'), str) and len(x['pieces']) < 3000 for x in data['activities']))
    new_o = [s for s in data['sessions'] if s['date'] == '2026-10-03']
    check('import: new orienteering session created', len(new_o) == 1 and new_o[0]['orienteering'] is True and new_o[0]['done'] is True, new_o)
    tue = next(s for s in data['sessions'] if s['id'] == tue['id'])
    check('import: diary filled from the file', tue['done'] and abs(tue['actual']['duration_s'] - 3419) <= 2 and tue['actual']['km'] > 12.8, tue['actual'])

    # the sheet for the last date opens on the diary with the file
    await pg.wait_for_selector('.ov-sheet .act', timeout=4000)
    title = await pg.locator('.ov-sheet #day-title').inner_text()
    check('import: phone opens the day it went to', title.startswith('Tuesday'), title)
    act = await pg.locator('.ov-sheet .act').first.inner_text()
    check('diary: file card with Heart and Legs', 'Heart' in act and 'Legs' in act, act)
    await pg.locator('.ov-sheet details.laps summary').first.tap()
    await pg.wait_for_timeout(150)
    rows = await pg.locator('.ov-sheet .laps-t tbody tr').count()
    check('diary: 9 laps listed', rows == 9, rows)
    check('diary: time fields hidden when a file is linked', await pg.locator('.ov-sheet [data-log="duration"]').count() == 0)
    a = await pg.evaluate(AUDIT)
    small = [x for x in a['smallTargets'] if 'NdurePlan' not in x]  # brand link sits under the sheet
    check('diary with laps: no overflow / small text / small targets', not a['overflowX'] and not a['smallText'] and not small, a)
    await pg.screenshot(path=str(SHOTS / 'p_diary_file.png'), full_page=False)

    # Orienteering tick -> legs x 0.9 from the stored pieces
    act_before = next(x for x in (await db(pg))['activities'] if x['session_id'] == tue['id'])
    await pg.locator('.ov-sheet [data-log="orienteering"]').first.check()
    await pg.wait_for_timeout(600)
    act_after = next(x for x in (await db(pg))['activities'] if x['session_id'] == tue['id'])
    check('orienteering tick: legs recalculated x 0.9', abs(act_after['body_load'] - act_before['body_load'] * 0.9) < 0.3, (act_before['body_load'], act_after['body_load']))
    check('orienteering tick: heart unchanged', act_after['hr_load'] == act_before['hr_load'])
    check('orienteering tick: saved on the session', any(c['args']['patch'].get('orienteering') is True for c in await calls(pg, 'updateSession')))

    # remove + undo
    await pg.locator('.ov-sheet [data-action="remove-activity"]').first.tap()
    await pg.wait_for_selector('.toast-text:has-text("Removed")')
    check('remove: file card gone', await pg.locator('.ov-sheet .act').count() == 0)
    await pg.locator('.toast-btn').tap()
    await pg.wait_for_timeout(400)
    check('remove: undo brings it back', await pg.locator('.ov-sheet .act').count() == 1)

    # week summary
    await pg.locator('.ov-sheet [data-action="close-overlay"]').first.tap()
    await pg.wait_for_timeout(300)
    summ = await pg.locator('.summary').first.inner_text()
    check('week: Heart and Legs load in the summary', 'Heart load' in summ and 'Legs load' in summ, summ)
    check('week: orienteering share shown', 'Orienteering' in summ, summ)
    a = await pg.evaluate(AUDIT)
    check('week with files: no overflow / small text', not a['overflowX'] and not a['smallText'], a)
    await pg.screenshot(path=str(SHOTS / 'p_week_loads.png'))
    errs = [e for e in pg.errors if 'favicon' not in e]
    check('phone: no console errors', not errs, errs[:3])
    await pg.context.close()

async def desktop(b):
    pg = await page_at(b, 'desktop')
    await load(pg)
    # drag and drop a file onto the window
    data = base64.b64encode((FX / 'hills.fit').read_bytes()).decode()
    await pg.evaluate("""(b64) => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'hills.fit'));
        for (const type of ['dragenter', 'dragover']) document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true }));
        window.__dropHint = getComputedStyle(document.getElementById('drop-hint')).display;
        document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    }""", data)
    check('desktop: drop hint appears while dragging', await pg.evaluate('window.__dropHint') == 'flex')
    await pg.wait_for_selector('.ov .imp', timeout=8000)
    sel = await pg.locator('.ov .imp select').input_value()
    d = await db(pg)
    sun = next(s for s in d['sessions'] if s['date'] == '2026-10-04')
    check('desktop: dropped trail file matched to Sunday’s long run', sel == f"s:{sun['id']}", sel)
    await pg.screenshot(path=str(SHOTS / 'd_import_dialog.png'))
    await pg.locator('.ov button[type=submit]').click()
    await pg.wait_for_selector('.col-right .act', timeout=5000)
    title = await pg.locator('.col-right #day-title').inner_text()
    check('desktop: right column shows Sunday with the file', title.startswith('Sunday'), title)
    lap = await pg.locator('.col-right details.laps summary').inner_text()
    check('desktop: 10 laps', '10' in lap, lap)
    await pg.locator('.col-right details.laps summary').click()
    await pg.screenshot(path=str(SHOTS / 'd_diary_file.png'))

    # import again -> duplicate, nothing to save
    async with pg.expect_file_chooser() as fc:
        await pg.locator('.tl-tools [data-action="import-files"]').click()
    await (await fc.value).set_files([str(FX / 'hills.fit')])
    await pg.wait_for_selector('.ov .dialog-body:has-text("already saved")', timeout=8000)
    check('desktop: same file again is skipped', await pg.locator('.ov button[type=submit]').is_disabled())
    await pg.keyboard.press('Escape')
    await pg.wait_for_timeout(300)

    # zones change -> loads recalculated from the pieces
    before = (await db(pg))['activities'][0]['hr_load']
    await pg.locator('.topnav [data-view="settings"]').click()
    await pg.wait_for_selector('[data-form="zones"]')
    await pg.fill('input[name="run|easy"]', '150')
    await pg.locator('[data-form="zones"] button[type=submit]').click()
    await pg.wait_for_selector('.toast-text:has-text("recalculated")', timeout=5000)
    after = (await db(pg))['activities'][0]['hr_load']
    check('zones: heart load recalculated (lower Easy -> higher load)', after > before, (before, after))
    await pg.screenshot(path=str(SHOTS / 'd_settings_files.png'))
    errs = [e for e in pg.errors if 'favicon' not in e]
    check('desktop: no console errors', not errs, errs[:3])
    await pg.context.close()

async def edge(b):
    pg = await page_at(b, 'phone')
    await load(pg)
    n_sess = len((await db(pg))['sessions'])
    # a failed save is rolled back completely, then a retry works once
    await pg.evaluate("window.__mockState.cfg.failOn = 'createActivities'")
    await pick(pg, [str(FX / 'cadence-lock.fit')])
    await pg.wait_for_selector('.ov .imp')
    await pg.locator('.ov button[type=submit]').tap()
    await pg.wait_for_selector('.toast-text:has-text("Couldn")')
    await pg.wait_for_timeout(500)
    d = await db(pg)
    check('rollback: no new session left behind after a failed save', len(d['sessions']) == n_sess, len(d['sessions']) - n_sess)
    check('rollback: dialog stays open to try again', await pg.locator('.ov .imp').count() == 1)
    await pg.evaluate("window.__mockState.cfg.failOn = null")
    await pg.locator('.ov button[type=submit]').tap()
    await pg.wait_for_selector('.toast-text:has-text("Saved 1 file")')
    await pg.wait_for_timeout(300)
    d = await db(pg)
    check('retry: exactly one new session and one file', len(d['sessions']) == n_sess + 1 and len(d['activities']) == 1, (len(d['sessions']) - n_sess, len(d['activities'])))
    # remove the only file of that unplanned session, then add the same file again within the undo time
    await pg.wait_for_selector('.ov-sheet .act')
    await pg.locator('.ov-sheet [data-action="remove-activity"]').tap()
    await pg.wait_for_selector('.toast-text:has-text("Removed")')
    await pg.wait_for_timeout(300)
    d = await db(pg)
    s_new = next(x for x in d['sessions'] if x['date'] == '2026-10-03')
    check('remove last file: unplanned session no longer done, file values cleared', s_new['done'] is False and not (s_new['actual'] or {}).get('duration_s'), s_new)
    await pg.locator('.ov-sheet [data-action="close-overlay"]').first.tap()
    await pg.wait_for_timeout(300)
    await pg.locator('.tabbar [data-view="today"]').tap()
    await pick(pg, [str(FX / 'cadence-lock.fit')])
    await pg.wait_for_selector('.ov .imp')
    await pg.locator('.ov .imp select').select_option(f"s:{s_new['id']}")
    await pg.locator('.ov button[type=submit]').tap()
    await pg.wait_for_selector('.toast-text:has-text("Saved 1 file")')
    await pg.wait_for_timeout(9000)  # past the 8 s purge of the removed file
    d = await db(pg)
    check('re-added file is relinked, not deleted by the purge', len(d['activities']) == 1 and d['activities'][0]['session_id'] == s_new['id'], d['activities'])
    errs = [e for e in pg.errors if 'favicon' not in e and 'Network down' not in e and 'import rollback' not in e]
    check('edge: no unexpected console errors', not errs, errs[:3])
    await pg.context.close()

async def main():
    srv = start_server()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for fn in (phone, desktop, edge):
            try:
                await fn(b)
            except Exception as e:
                check(f'{fn.__name__} crashed', False, repr(e)[:500])
        await b.close()
    if srv: srv.terminate()
    fails = [r for r in results if not r[0]]
    print(f'\n{len(results) - len(fails)} passed, {len(fails)} failed')
    sys.exit(1 if fails else 0)

asyncio.run(main())
