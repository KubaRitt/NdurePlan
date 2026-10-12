import asyncio, json, sys, re
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from harness import *

results = []
def check(name, cond, detail=''):
    results.append((bool(cond), name, detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))

async def calls(pg, name=None):
    c = await pg.evaluate('window.__mockState.calls')
    return [x for x in c if name is None or x['name'] == name]

async def text(pg, sel):
    return (await pg.locator(sel).first.inner_text()).strip()

async def phone_flows(b):
    pg = await new_page(b, 'phone')
    await load(pg)
    check('phone: week view renders 7 strip days', await pg.locator('.strip-day').count() == 7)
    check('phone: 7 day cards', await pg.locator('.day-card').count() == 7)
    t0 = await text(pg, '.stats div:first-child dd')

    # one-tap done on Monday's session (seeded as done -> becomes not done)
    mon = pg.locator('.day-card').nth(0)
    await mon.locator('.done-btn').first.tap()
    await pg.wait_for_timeout(300)
    up = await calls(pg, 'updateSession')
    check('phone: done circle saves {done:false}', up and up[-1]['args']['patch'] == {'done': False}, up[-1:] if up else 'no call')
    t1 = await text(pg, '.stats div:first-child dd')
    check('phone: week time updates after un-done', t0 != t1, f'{t0} -> {t1}')
    await mon.locator('.done-btn').first.tap()
    await pg.wait_for_timeout(300)

    # open Thursday (future -> Plan tab)
    await pg.locator('.day-card').nth(3).locator('.day-card-head').tap()
    await pg.wait_for_selector('.ov-sheet .day-panel')
    title = await text(pg, '.ov-sheet #day-title')
    check('phone: day sheet opens for Thursday', title.startswith('Thursday'), title)
    tab = await pg.locator('.ov-sheet .tab.on').inner_text()
    thu = await pg.locator('.ov-sheet .day-panel').get_attribute('data-day')
    today = await pg.evaluate("(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()")
    expected = 'Plan' if thu > today else 'Diary'
    check(f'phone: day sheet opens on {expected} tab ({"future" if expected == "Plan" else "today/past"} day)', tab.strip() == expected, tab)
    if tab.strip() != 'Plan':
        await pg.locator('.ov-sheet .tab', has_text='Plan').tap()
        await pg.wait_for_timeout(150)
    await pg.screenshot(path=str(SHOTS / 'p_day_sheet_plan.png'))

    # add from template + undo
    n0 = await pg.locator('.ov-sheet .s-card').count()
    await pg.locator('.ov-sheet .chip', has_text='Strength').first.tap()
    await pg.wait_for_selector('.toast')
    await pg.wait_for_timeout(200)
    n1 = await pg.locator('.ov-sheet .s-card').count()
    check('phone: template chip adds a session', n1 == n0 + 1, f'{n0}->{n1}')
    check('phone: toast says Added', 'Added' in await text(pg, '.toast-text'))
    await pg.screenshot(path=str(SHOTS / 'p_toast_undo.png'))
    await pg.locator('.toast-btn').tap()
    await pg.wait_for_timeout(300)
    n2 = await pg.locator('.ov-sheet .s-card').count()
    check('phone: Undo removes the added session', n2 == n0, f'{n2} vs {n0}')

    # edit the speed session: 200 m reps to 0:34
    await pg.locator('.ov-sheet .s-card', has_text='Speed').locator('[data-action="edit-session"]').tap()
    await pg.wait_for_selector('.ov-full .editor')
    check('phone: editor opens full screen', await pg.locator('.ov-full .editor').count() == 1)
    save_box = await pg.locator('.ov-full button[type=submit]').bounding_box()
    check('phone: Save visible at top without scrolling', save_box and save_box['y'] >= 0 and save_box['y'] < 100, save_box)
    await pg.screenshot(path=str(SHOTS / 'p_editor_collapsed.png'))
    blk = pg.locator('.ov-full .blk', has_text='200 m')
    await blk.locator('.blk-toggle').tap()
    dur = blk.locator('input[data-bf="dur"]')
    check('phone: 200 m block shows 0:35 per rep', await dur.input_value() == '0:35', await dur.input_value())
    await dur.fill('0:34')
    await pg.wait_for_timeout(100)
    summ = await blk.locator('[data-blk-sum]').inner_text()
    check('phone: block summary shows new time and pace', '0:34' in summ and '2:50 /km' in summ, summ)
    await pg.screenshot(path=str(SHOTS / 'p_editor_block_open.png'))
    # bad input blocks save
    await dur.fill('abc')
    await pg.locator('.ov-full button[type=submit]').tap()
    await pg.wait_for_timeout(150)
    check('phone: invalid time blocks Save with message', await pg.locator('.ov-full [data-ed-error]:not([hidden])').count() == 1)
    check('phone: field marked invalid', await dur.get_attribute('aria-invalid') == 'true')
    await dur.fill('0:34')
    await pg.locator('.ov-full button[type=submit]').tap()
    await pg.wait_for_timeout(400)
    check('phone: editor closed after Save', await pg.locator('.ov-full').count() == 0)
    up = await calls(pg, 'updateSession')
    blocks = up[-1]['args']['patch']['blocks'] if up else []
    b200 = [x for x in blocks if x['type'] == '200 m']
    check('phone: saved 200 m duration_s = 34', b200 and b200[0]['duration_s'] == 34, b200)
    check('phone: sheet still open after editor closed', await pg.locator('.ov-sheet .day-panel').count() == 1)

    # Back gesture closes the sheet but stays in the app
    await pg.go_back()
    await pg.wait_for_timeout(300)
    check('phone: Back closes the day sheet', await pg.locator('.ov-sheet').count() == 0)
    check('phone: still on dashboard after Back', pg.url.endswith('dashboard.html'), pg.url)

    # Today tab: diary
    await pg.locator('.tabbar [data-view="today"]').tap()
    await pg.wait_for_selector('#view-today .day-panel')
    tab = await pg.locator('#view-today .tab.on').inner_text()
    if thu != today:  # otherwise the Plan tab picked in the sheet above is remembered for today
        check('phone: Today opens on Diary', tab.strip() == 'Diary', tab)
    if tab.strip() != 'Diary':
        await pg.locator('#view-today .tab', has_text='Diary').tap()
        await pg.wait_for_selector('#view-today .day-log')
    card = pg.locator('#view-today .log-card:not(.day-log)').first
    await card.locator('.switch').tap()
    await card.locator('input[data-log="duration"]').fill('50:00')
    await card.locator('input[data-log="hr"]').fill('139')
    await card.locator('[data-action="set-rpe"][data-rpe="4"]').tap()
    await card.locator('textarea[data-log="notes"]').fill('Felt easy')
    day = pg.locator('#view-today .day-log')
    await day.locator('input[data-diary="sleep_h"]').fill('8,5')
    await day.locator('[data-action="set-legs"][data-value="heavy"]').tap()
    await day.locator('[data-action="set-pain"][data-value="0"]').tap()
    await pg.wait_for_timeout(100)
    out0 = await pg.locator('#view-today [data-pain-out]').inner_text()
    check('phone: "No pain today" logs 0', out0 == '0/10', out0)
    day = pg.locator('#view-today .day-log')
    await day.locator('input[data-diary="pain"]').fill('4')
    await day.locator('textarea[data-diary="notes"]').fill('Knee fine after strength')
    await pg.screenshot(path=str(SHOTS / 'p_today_diary.png'), full_page=True)
    await pg.wait_for_timeout(1200)
    up = [c for c in await calls(pg, 'updateSession') if 'actual' in c['args']['patch']]
    last = up[-1]['args']['patch'] if up else {}
    actual = dict(last.get('actual') or {})
    check('phone: diary saves actual time/HR, RPE, done, notes', last.get('rpe') == 4 and actual.get('duration_s') == 3000 and actual.get('hr') == 139 and last.get('notes') == 'Felt easy' and 'done' in last, last)
    dz = await calls(pg, 'upsertDiary')
    dl = dz[-1]['args'] if dz else {}
    check('phone: day diary saves sleep 8.5 (comma), legs, pain, notes', dl.get('sleep_h') == 8.5 and dl.get('legs') == 'heavy' and dl.get('pain') == 4 and dl.get('notes') == 'Knee fine after strength', dl)
    n_saves = len(dz)
    check('phone: diary typing is debounced (few saves)', n_saves <= 3, n_saves)

    # back to week: diary line visible on today's card
    await pg.locator('.tabbar [data-view="plan"]').tap()
    await pg.wait_for_timeout(200)
    line = await pg.locator('.day-card.today .diary-line').inner_text()
    check('phone: week card shows diary line', 'Sleep 8.5 h' in line and 'Knee/ITB 4/10' in line and 'Legs heavy' in line, line)

    # swipe to next week, plan on an empty day with the editor
    title0 = await text(pg, '.weekbar-title')
    await pg.evaluate("""() => {
        const el = document.getElementById('view-plan');
        const t = (type, x) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 })], changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 })] }));
        t('touchstart', 300); t('touchend', 80);
    }""")
    await pg.wait_for_timeout(250)
    title1 = await text(pg, '.weekbar-title')
    check('phone: swipe left goes to next week', title0 != title1, f'{title0} -> {title1}')
    await pg.locator('.day-card').nth(0).locator('.link-btn').tap()
    await pg.wait_for_selector('.ov-sheet .day-panel')
    await pg.locator('.ov-sheet [data-action="new-session"]').tap()
    await pg.wait_for_selector('.ov-full .editor')
    await pg.locator('.ov-full input[data-f="description"]').fill('Test run')
    await pg.locator('.ov-full .blk').first.locator('input[data-bf="dur"]').fill('45')
    await pg.locator('.ov-full button[type=submit]').tap()
    await pg.wait_for_timeout(400)
    cs = await calls(pg, 'createSessions')
    made = cs[-1]['args'][0] if cs else {}
    check('phone: new custom session saved (45 -> 45 min)', made.get('description') == 'Test run' and made['blocks'][0]['duration_s'] == 2700, made)
    check('phone: new session shows in the sheet', await pg.locator('.ov-sheet .s-card', has_text='Test run').count() == 1)

    # delete + undo
    await pg.locator('.ov-sheet .s-card', has_text='Test run').locator('[data-action="delete-session"]').tap()
    await pg.wait_for_timeout(300)
    check('phone: delete removes immediately', await pg.locator('.ov-sheet .s-card', has_text='Test run').count() == 0)
    check('phone: delete toast offers Undo', (await text(pg, '.toast-btn')) == 'Undo')
    await pg.locator('.toast-btn').tap()
    await pg.wait_for_timeout(300)
    check('phone: Undo restores deleted session', await pg.locator('.ov-sheet .s-card', has_text='Test run').count() == 1)
    await pg.locator('.ov-sheet [data-action="close-overlay"]').tap()
    await pg.wait_for_timeout(300)

    # copy a week into an empty week (week +2)
    await pg.locator('[data-action="week-next"]').tap()
    await pg.wait_for_timeout(250)
    await pg.locator('[data-action="copy-week"]').tap()
    await pg.wait_for_selector('[data-copy-form]')
    await pg.locator('[data-copy-form] [data-copy-date]').fill('')
    await pg.screenshot(path=str(SHOTS / 'p_copy_week.png'))
    await pg.locator('[data-copy-form] [data-copy-last]').tap()
    prev = await pg.locator('[data-copy-preview]').inner_text()
    await pg.locator('[data-copy-form] button[type=submit]').tap()
    await pg.wait_for_timeout(400)
    n = await pg.locator('.dc-session').count()
    check('phone: copy week fills the empty week', n >= 3, f'{n} sessions; preview: {prev}')
    tt = await text(pg, '.toast-text')
    check('phone: copy toast', tt.startswith('Copied'), tt)
    await pg.locator('.toast-btn').tap()
    await pg.wait_for_timeout(300)
    check('phone: Undo copy empties the week again', await pg.locator('.dc-session').count() == 0)

    # settings
    await pg.locator('.tabbar [data-view="settings"]').tap()
    await pg.wait_for_selector('.settings')
    await pg.screenshot(path=str(SHOTS / 'p_settings.png'), full_page=True)
    await pg.locator('input[name="run|easy"]').fill('30')
    await pg.locator('[data-form="zones"] button[type=submit]').tap()
    await pg.wait_for_timeout(150)
    check('phone: zone out of range rejected', await pg.locator('[data-zones-error]:not([hidden])').count() == 1)
    await pg.locator('input[name="run|easy"]').fill('160')
    await pg.locator('[data-form="zones"] button[type=submit]').tap()
    await pg.wait_for_timeout(300)
    z = await calls(pg, 'saveHrZones')
    check('phone: zones saved', z and z[-1]['args']['run']['easy'] == 160, z[-1:] if z else 'none')
    await pg.locator('[data-action="set-theme"][data-value="dark"]').tap()
    check('phone: dark theme applied', await pg.evaluate("document.documentElement.dataset.theme") == 'dark')
    await pg.screenshot(path=str(SHOTS / 'p_settings_dark.png'))
    await pg.locator('[data-action="set-theme"][data-value="system"]').tap()

    audit = await pg.evaluate(AUDIT)
    check('phone: no horizontal overflow (settings)', not audit['overflowX'])
    check('phone: no console errors', not pg.errors, pg.errors)
    await pg.context.close()

async def phone_audits(b):
    # per-screen audit of text size / tap targets / overflow
    pg = await new_page(b, 'phone')
    await load(pg)
    out = {}
    out['week'] = await pg.evaluate(AUDIT)
    await pg.locator('.day-card').nth(2).locator('.day-card-head').tap()
    await pg.wait_for_selector('.ov-sheet .day-panel')
    out['sheet'] = await pg.evaluate(AUDIT)
    await pg.locator('.ov-sheet .tab', has_text='Plan').tap()
    await pg.locator('.ov-sheet [data-action="edit-session"]').first.tap()
    await pg.wait_for_selector('.ov-full .editor')
    await pg.locator('.ov-full .blk-toggle').first.tap()
    out['editor'] = await pg.evaluate(AUDIT)
    for k, v in out.items():
        st = [x for x in v['smallTargets'] if 'NdurePlan' not in x]
        check(f'phone audit {k}: no overflow', not v['overflowX'])
        check(f'phone audit {k}: no text under 12px', not v['smallText'], v['smallText'][:5])
        check(f'phone audit {k}: tap targets >= 40px', not st, st[:8])
    await pg.context.close()

async def failure_flows(b):
    pg = await new_page(b, 'phone', mock={'schemaMissing': True})
    await load(pg)
    check('schema: banner shown', await pg.locator('#banner:not([hidden])').count() == 1)
    btxt = await pg.locator('#banner').inner_text()
    check('schema: banner points at the migrations', 'supabase/migrations' in btxt, btxt)
    check('schema: sessions still visible', await pg.locator('.dc-session').count() > 0)
    await pg.screenshot(path=str(SHOTS / 'p_schema_banner.png'))
    await pg.context.close()

    pg = await new_page(b, 'phone', mock={'failWrites': True})
    await load(pg)
    btn = pg.locator('.day-card').nth(2).locator('.done-btn').first
    before = await btn.get_attribute('aria-pressed')
    await btn.tap()
    await pg.wait_for_timeout(400)
    after = await pg.locator('.day-card').nth(2).locator('.done-btn').first.get_attribute('aria-pressed')
    check('offline: failed save rolls back the tick', before == after, f'{before} -> {after}')
    tt = await text(pg, '.toast-text')
    check('offline: toast explains', "Couldn't" in tt, tt)
    check('offline: status says Not saved', (await text(pg, '#save-status')) == 'Not saved')
    await pg.context.close()

    pg = await new_page(b, 'phone', mock={'signedIn': False})
    await pg.goto(f'{BASE}/dashboard.html')
    await pg.wait_for_url('**/login.html', timeout=5000)
    check('auth: signed-out user is sent to login', pg.url.endswith('login.html'))
    await pg.context.close()

    pg = await new_page(b, 'phone', mock={'empty': True})
    await load(pg)
    await pg.screenshot(path=str(SHOTS / 'p_empty.png'))
    check('empty: friendly empty summary', 'Nothing planned yet' in await pg.locator('.summary').inner_text())
    check('empty: no console errors', not pg.errors, pg.errors)
    await pg.context.close()

async def desktop_flows(b):
    pg = await new_page(b, 'desktop')
    await load(pg)
    check('desktop: 3 columns', await pg.locator('.cols > .col').count() == 3)
    await pg.screenshot(path=str(SHOTS / 'd_week.png'))
    today_sel = await pg.locator('.tl-day.selected').get_attribute('data-date')
    # click Thursday row
    thu = pg.locator('.tl-week').filter(has=pg.locator('.tl-day.today')).locator('.tl-day').nth(3)
    await thu.locator('.tl-date').click()
    await pg.wait_for_timeout(150)
    rp = await text(pg, '.col-right #day-title')
    check('desktop: clicking a day shows it on the right', rp.startswith('Thursday'), rp)
    await pg.keyboard.press('ArrowRight')
    await pg.wait_for_timeout(120)
    check('desktop: ArrowRight -> Friday', (await text(pg, '.col-right #day-title')).startswith('Friday'))
    await pg.keyboard.press('PageDown')
    await pg.wait_for_timeout(150)
    sel = await pg.locator('.tl-day.selected').get_attribute('data-date')
    check('desktop: PageDown moves a week', sel and sel > today_sel, sel)
    await pg.keyboard.press('t')
    await pg.wait_for_timeout(150)
    check('desktop: t jumps to today', await pg.locator('.tl-day.selected').get_attribute('data-date') == today_sel)

    # add on a day via + and the template inside the editor
    target = pg.locator('.tl-week').filter(has=pg.locator('.tl-day.today')).locator('.tl-day').nth(4)
    tdate = await target.get_attribute('data-date')
    await target.hover()
    await target.locator('.add-btn').click()
    await pg.wait_for_selector('.ov-modal .editor')
    await pg.locator('.ov-modal .chip', has_text='Threshold').click()
    await pg.wait_for_timeout(100)
    prev = await pg.locator('.ov-modal [data-ed-preview]').inner_text()
    check('desktop: template fills editor (preview shows heart and legs)', 'heart' in prev and 'legs' in prev, prev)
    await pg.screenshot(path=str(SHOTS / 'd_editor.png'))
    await pg.locator('.ov-modal button[type=submit]').click()
    await pg.wait_for_timeout(400)
    cs = await calls(pg, 'createSessions')
    made = cs[-1]['args'][0] if cs else {}
    check('desktop: session created on chosen day', made.get('date') == tdate and made.get('description', '').startswith('Threshold'), made.get('date'))
    check('desktop: target HR filled from zones', made['blocks'][1]['target_hr'] == 181, made['blocks'][1] if made else None)

    # edit: change a block to sprint -> HR field disappears
    await pg.locator('.col-right .tab', has_text='Plan').click()
    await pg.locator('.col-right .s-card', has_text='Threshold').locator('[data-action="edit-session"]').click()
    await pg.wait_for_selector('.ov-modal .editor')
    blk = pg.locator('.ov-modal .blk').nth(1)
    await blk.locator('.blk-toggle').click()
    await blk.locator('[data-ed="zone"][data-z="sprint"]').click()
    blk = pg.locator('.ov-modal .blk').nth(1)
    check('desktop: sprint zone hides target HR', await blk.locator('input[data-bf="hr"]').count() == 0)
    await pg.keyboard.press('Escape')
    await pg.wait_for_timeout(300)
    check('desktop: Esc closes editor (after confirm)', await pg.locator('.ov-modal').count() == 0)

    # infinite scroll up keeps position
    sc = pg.locator('.tl-scroll')
    weeks0 = await pg.locator('.tl-week').count()
    first_visible = await pg.evaluate("""() => { const sc = document.querySelector('.tl-scroll'); const top = sc.getBoundingClientRect().top;
        return [...sc.querySelectorAll('.tl-week')].find(w => w.getBoundingClientRect().bottom > top + 40).dataset.week; }""")
    await pg.evaluate("document.querySelector('.tl-scroll').scrollTop = 100")
    await pg.wait_for_timeout(400)
    weeks1 = await pg.locator('.tl-week').count()
    check('desktop: scrolling up loads earlier weeks', weeks1 > weeks0, f'{weeks0}->{weeks1}')
    st = await pg.evaluate("document.querySelector('.tl-scroll').scrollTop")
    check('desktop: scroll position kept after prepend', st > 1000, st)

    # density
    await pg.locator('[data-action="toggle-density"]').click()
    await pg.wait_for_timeout(150)
    check('desktop: compact hides chip meta', await pg.locator('.tl-chip-meta').count() == 0)
    await pg.locator('[data-action="toggle-density"]').click()

    # calendar month navigation
    await pg.locator('[data-action="cal-next"]').click()
    await pg.wait_for_timeout(150)
    day15 = pg.locator('.cal-day', has_text=re.compile(r'^15$')).first
    await day15.click()
    await pg.wait_for_timeout(300)
    sel = await pg.locator('.tl-day.selected').get_attribute('data-date')
    check('desktop: calendar jump selects the 15th of next month', sel and sel.endswith('-15'), sel)
    vis = await pg.evaluate("""() => { const d = document.querySelector('.tl-day.selected'); const sc = document.querySelector('.tl-scroll');
        const r = d.getBoundingClientRect(), c = sc.getBoundingClientRect(); return r.top >= c.top - 1 && r.bottom <= c.bottom + 1; }""")
    check('desktop: jumped-to day is scrolled into view', vis)

    # diary on desktop right panel
    await pg.keyboard.press('t')
    await pg.wait_for_timeout(200)
    await pg.locator('.col-right .tab', has_text='Diary').click()
    await pg.locator('.col-right input[data-diary="rest_hr"]').fill('46')
    await pg.wait_for_timeout(1000)
    dz = await calls(pg, 'upsertDiary')
    check('desktop: diary saves from right panel', dz and dz[-1]['args'].get('rest_hr') == 46, dz[-1:] if dz else None)
    focused = await pg.evaluate("document.activeElement && document.activeElement.dataset.diary")
    check('desktop: focus stays in the field while saving', focused == 'rest_hr', focused)

    await pg.locator('.topnav [data-view="settings"]').click()
    await pg.wait_for_selector('.settings')
    await pg.screenshot(path=str(SHOTS / 'd_settings.png'))
    check('desktop: no console errors', not pg.errors, pg.errors)
    await pg.context.close()

    # dark desktop + tablet screenshots
    pg = await new_page(b, 'desktop', color_scheme='dark')
    await load(pg)
    await pg.screenshot(path=str(SHOTS / 'd_week_dark.png'))
    await pg.context.close()
    pg = await new_page(b, dict(viewport={'width': 820, 'height': 1180}, device_scale_factor=1, has_touch=True, is_mobile=True))
    await load(pg)
    a = await pg.evaluate(AUDIT)
    check('tablet 820px: no overflow', not a['overflowX'])
    await pg.screenshot(path=str(SHOTS / 't_week.png'))
    await pg.context.close()

async def main():
    srv = start_server()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for fn in (phone_flows, phone_audits, failure_flows, desktop_flows):
            try:
                await fn(b)
            except Exception as e:
                check(f'{fn.__name__} crashed', False, repr(e)[:400])
        await b.close()
    if srv: srv.terminate()
    fails = [r for r in results if not r[0]]
    print(f'\n{len(results) - len(fails)} passed, {len(fails)} failed')
asyncio.run(main())
