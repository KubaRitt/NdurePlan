// Sheets (phone), modals (desktop) and full-screen editors.
// Each open overlay adds a history entry, so the phone's Back gesture closes
// it instead of leaving the app.

const stack = [];

// After a reload the browser restores the old history state, but no overlay is open any more.
if (history.state && history.state.ndOverlay) history.replaceState(null, '');

/**
 * @param {object} o
 *   kind        'sheet' | 'modal' | 'full'
 *   label       accessible name
 *   render(el)  fills the panel element
 *   onClose()   called after it closed
 *   canClose()  return false to keep it open (e.g. unsaved changes)
 */
export function openOverlay(o) {
    const root = document.getElementById('overlay-root');
    const wrap = document.createElement('div');
    wrap.className = `ov ov-${o.kind || 'modal'}`;
    wrap.innerHTML = `<div class="ov-scrim" data-ov-scrim></div>
        <div class="ov-panel" role="dialog" aria-modal="true" aria-label="${(o.label || '').replace(/"/g, '&quot;')}" tabindex="-1"></div>`;
    root.appendChild(wrap);
    const panel = wrap.querySelector('.ov-panel');
    const entry = { ...o, wrap, panel, opener: document.activeElement };
    stack.push(entry);
    document.documentElement.classList.add('ov-open');
    history.pushState({ ndOverlay: stack.length }, '');
    o.render(panel, entry);
    wrap.querySelector('[data-ov-scrim]').addEventListener('click', () => requestClose(entry));
    requestAnimationFrame(() => {
        wrap.classList.add('in');
        const first = panel.querySelector('[autofocus]') || panel;
        try { first.focus({ preventScroll: true }); } catch { first.focus(); }
    });
    return entry;
}

export function topOverlay() { return stack[stack.length - 1] || null; }
export function overlayCount() { return stack.length; }

function finishClose(entry) {
    const i = stack.indexOf(entry);
    if (i === -1) return;
    stack.splice(i, 1);
    entry.wrap.remove();
    if (!stack.length) document.documentElement.classList.remove('ov-open');
    if (entry.onClose) entry.onClose();
    if (entry.opener && document.contains(entry.opener)) {
        try { entry.opener.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
}

/** Close from the UI (× button, scrim, Esc, Save). */
export function requestClose(entry = topOverlay(), { force = false } = {}) {
    if (!entry) return;
    if (!force && entry.canClose && entry.canClose() === false) return;
    entry.forced = true;
    // Going back removes our history entry; popstate then closes the overlay.
    history.back();
}

window.addEventListener('popstate', e => {
    const depth = (e.state && e.state.ndOverlay) || 0;
    // Only the overlays open right now: an onClose may open a new one (e.g. the day after an import).
    const toClose = stack.slice(depth).reverse();
    for (const top of toClose) {
        if (!top.forced && top.canClose && top.canClose() === false) {
            // Back gesture but the user wants to keep editing: restore the entry.
            history.pushState({ ndOverlay: stack.length }, '');
            return;
        }
        finishClose(top);
    }
});

document.addEventListener('keydown', e => {
    const top = topOverlay();
    if (!top) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        requestClose(top);
        return;
    }
    if (e.key === 'Tab') {
        const items = Array.from(top.panel.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
            .filter(el => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === top.panel)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
});
