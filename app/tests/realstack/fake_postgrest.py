"""A tiny stand-in for Supabase's REST API (PostgREST), backed by a real local
Postgres with the migration applied and Row Level Security switched on.
Only the subset of PostgREST syntax that supabase-js produces for this app
is supported. Requests run as role `authenticated` with the user id taken
from the bearer token, exactly like Supabase does, so RLS is exercised.
"""
import base64, json, re
from urllib.parse import urlparse, parse_qsl
import psycopg2

DSN = 'host=/tmp port=54329 user=postgres dbname=t2'
conn = psycopg2.connect(DSN)
conn.autocommit = False

def jwt_sub(auth):
    try:
        payload = auth.split(' ', 1)[1].split('.')[1]
        payload += '=' * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))['sub']
    except Exception:
        return None

def ident(name):
    if not re.fullmatch(r'[a-z_][a-z0-9_]*', name):
        raise ValueError(f'bad identifier {name!r}')
    return '"' + name + '"'

OPS = {'eq': '=', 'neq': '<>', 'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='}

def where(params, qual=''):
    parts, args = [], []
    for k, v in params:
        if k in ('select', 'order', 'on_conflict', 'limit', 'offset', 'columns'):
            continue
        op, _, val = v.partition('.')
        col = qual + ident(k)
        if op in OPS:
            parts.append(f'{col}::text {OPS[op]} %s' if op in ('eq', 'neq') else f'{col} {OPS[op]} %s')
            args.append(val)
        elif op == 'in':
            items = [x.strip().strip('"') for x in val.strip('()').split(',') if x.strip()]
            parts.append(f'{col}::text = any(%s)')
            args.append(items)
        elif op == 'is' and val == 'null':
            parts.append(f'{col} is null')
        elif op == 'not' and val == 'is.null':
            parts.append(f'{col} is not null')
        else:
            raise ValueError(f'unsupported filter {k}={v}')
    return (' where ' + ' and '.join(parts)) if parts else '', args

def columns(params):
    # select=a,b,c -> only those columns (unknown names fail like PostgREST would)
    sel = dict(params).get('select', '*')
    if sel in ('', '*'):
        return '*'
    return ', '.join(ident(c.strip()) for c in sel.split(',') if c.strip())

def page(params):
    d = dict(params)
    out = ''
    if 'limit' in d: out += f" limit {int(d['limit'])}"
    if 'offset' in d: out += f" offset {int(d['offset'])}"
    return out

def order(params):
    for k, v in params:
        if k == 'order':
            out = []
            for item in v.split(','):
                bits = item.split('.')
                col = ident(bits[0])
                d = 'desc' if 'desc' in bits else 'asc'
                n = ' nulls last' if 'nullslast' in bits else ' nulls first' if 'nullsfirst' in bits else ''
                out.append(f'{col} {d}{n}')
            return ' order by ' + ', '.join(out)
    return ''

def handle(method, url, headers, body):
    """Returns (status, headers, body_text)."""
    u = urlparse(url)
    if u.path.startswith('/auth/v1/'):
        return 204, {}, ''
    m = re.fullmatch(r'/rest/v1/([a-z_]+)', u.path)
    if not m:
        return 404, {}, '{}'
    table = 'public.' + ident(m.group(1))
    params = parse_qsl(u.query, keep_blank_values=True)
    sub = jwt_sub(headers.get('authorization', ''))
    prefer = headers.get('prefer', '')
    single = 'vnd.pgrst.object' in headers.get('accept', '')
    cur = conn.cursor()
    try:
        cur.execute('set local role authenticated')
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (sub or '',))
        w, wargs = where(params)
        rows = None
        if method == 'GET':
            cur.execute(f'select coalesce(json_agg(t), \'[]\') from (select {columns(params)} from {table}{w}{order(params)}{page(params)}) t', wargs)
            rows = cur.fetchone()[0]
        elif method == 'POST':
            data = json.loads(body or '[]')
            data = data if isinstance(data, list) else [data]
            cols = sorted({k for r in data for k in r})
            cl = ', '.join(ident(c) for c in cols)
            on_conflict = dict(params).get('on_conflict')
            sql = f'insert into {table} ({cl}) select {cl} from json_populate_recordset(null::{table}, %s)'
            if on_conflict:
                tgt = ', '.join(ident(c) for c in on_conflict.split(','))
                upd = ', '.join(f'{ident(c)} = excluded.{ident(c)}' for c in cols if c not in on_conflict.split(','))
                sql += f' on conflict ({tgt}) do update set {upd}' if 'merge-duplicates' in prefer else f' on conflict ({tgt}) do nothing'
            cur.execute(f'with r as ({sql} returning *) select coalesce(json_agg(r), \'[]\') from r', (json.dumps(data),))
            rows = cur.fetchone()[0]
        elif method == 'PATCH':
            data = json.loads(body or '{}')
            cols = list(data.keys())
            sets = ', '.join(f'{ident(c)} = j.{ident(c)}' for c in cols)
            wq, wqargs = where(params, 't.')
            cur.execute(f'with r as (update {table} as t set {sets} from (select * from json_populate_record(null::{table}, %s)) j{wq} returning t.*) select coalesce(json_agg(r), \'[]\') from r',
                        [json.dumps(data)] + wqargs)
            rows = cur.fetchone()[0]
        elif method == 'DELETE':
            cur.execute(f'with r as (delete from {table}{w} returning *) select coalesce(json_agg(r), \'[]\') from r', wargs)
            rows = cur.fetchone()[0]
        else:
            return 405, {}, '{}'
        conn.commit()
    except psycopg2.Error as e:
        conn.rollback()
        code = e.pgcode or 'XX000'
        status = 403 if code == '42501' else 409 if code == '23505' else 400
        msg = (e.pgerror or str(e)).strip().splitlines()[0]
        if code == '42703':
            code, msg = 'PGRST204', f"Could not find a column of '{m.group(1)}' in the schema cache ({msg})"
        if code == '42P01':
            code, msg = 'PGRST205', f"Could not find the table 'public.{m.group(1)}' in the schema cache"
        return status, {'content-type': 'application/json'}, json.dumps({'code': code, 'message': msg, 'details': None, 'hint': None})
    finally:
        cur.close()
    if single:
        if len(rows) != 1:
            return 406, {'content-type': 'application/json'}, json.dumps({'code': 'PGRST116', 'message': f'JSON object requested, multiple (or no) rows returned ({len(rows)})'})
        return 200, {'content-type': 'application/vnd.pgrst.object+json'}, json.dumps(rows[0])
    if method != 'GET' and 'return=representation' not in prefer:
        return 204, {}, ''
    return 200 if method != 'POST' else 201, {'content-type': 'application/json'}, json.dumps(rows)
