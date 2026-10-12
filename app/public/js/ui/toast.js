// One message at a time at the bottom of the screen, with an optional action (Undo).

import { esc } from './util.js';

let timer = null;
let current = null;

export function toast({ text, action = null, ms }) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    clearTimeout(timer);
    current = action;
    root.innerHTML = `<div class="toast" role="status">
        <span class="toast-text">${esc(text)}</span>
        ${action ? `<button type="button" class="toast-btn" data-toast-action>${esc(action.label)}</button>` : ''}
        <button type="button" class="toast-close" data-toast-close aria-label="Dismiss">×</button>
    </div>`;
    root.classList.add('show');
    timer = setTimeout(hide, ms ?? (action ? 7000 : 3500));
}

export function hide() {
    clearTimeout(timer);
    current = null;
    const root = document.getElementById('toast-root');
    if (!root) return;
    root.classList.remove('show');
    root.innerHTML = '';
}

export function initToast() {
    const root = document.getElementById('toast-root');
    root.addEventListener('click', e => {
        if (e.target.closest('[data-toast-action]')) {
            const a = current;
            hide();
            if (a) a.run();
        } else if (e.target.closest('[data-toast-close]')) {
            hide();
        }
    });
}
