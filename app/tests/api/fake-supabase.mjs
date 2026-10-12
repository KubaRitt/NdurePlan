// Records every query the data layer builds.
export const log = [];
let nextResult = { data: [], error: null };
export function setResult(r) { nextResult = r; }
function builder(table) {
    const q = { table, ops: [] };
    log.push(q);
    const p = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (res, rej) => Promise.resolve(nextResult).then(res, rej);
            return (...args) => { q.ops.push([prop, ...args]); return p; };
        }
    });
    return p;
}
let authCb = null;
export function createClient(url, key) {
    return {
        from: t => builder(t),
        auth: {
            getSession: async () => ({ data: { session: { user: { id: 'user-1', email: 'a@b.c' } } } }),
            onAuthStateChange: cb => { authCb = cb; return { data: { subscription: {} } }; },
            signInWithPassword: async () => ({ data: {}, error: null }),
            signUp: async () => ({ data: {}, error: null }),
            signOut: async () => ({ error: null })
        }
    };
}
