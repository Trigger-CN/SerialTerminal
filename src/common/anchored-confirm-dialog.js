'use strict';

function createAnchoredConfirmDialog({ document, window, overlay }) {
    const dialog = overlay.querySelector('.app-dialog');
    const title = overlay.querySelector('h2');
    const message = overlay.querySelector('#tab-close-dialog-message');
    const detail = overlay.querySelector('#tab-close-dialog-detail');
    const cancel = overlay.querySelector('#tab-close-dialog-cancel');
    const confirm = overlay.querySelector('#tab-close-dialog-confirm');
    const dismiss = overlay.querySelector('.app-dialog-close');
    let pending = null;

    function finish(approved) {
        if (!pending) return;
        const request = pending;
        pending = null;
        overlay.classList.add('hidden');
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('focusin', onFocusIn, true);
        document.removeEventListener('scroll', position, true);
        window.removeEventListener('resize', position);
        window.removeEventListener('beforeunload', onUnload);
        if (!approved && request.previousFocus?.isConnected) request.previousFocus.focus({ preventScroll: true });
        request.resolve(approved);
    }

    function position() {
        if (!pending) return;
        const { anchor } = pending;
        if (anchor && !anchor.isConnected) return finish(false);
        const margin = 8;
        const width = dialog.offsetWidth;
        const height = dialog.offsetHeight;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const rect = anchor?.getBoundingClientRect();
        const visible = rect && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
        let left = (viewportWidth - width) / 2;
        let top = (viewportHeight - height) / 2;
        if (visible) {
            // Align the dialog's right edge with the close end of the target tab.
            left = rect.right - width;
            const below = viewportHeight - rect.bottom - margin;
            const above = rect.top - margin;
            top = height <= below || below >= above ? rect.bottom + margin : rect.top - height - margin;
        }
        dialog.style.left = `${Math.max(margin, Math.min(left, viewportWidth - width - margin))}px`;
        dialog.style.top = `${Math.max(margin, Math.min(top, viewportHeight - height - margin))}px`;
    }

    function onFocusIn(event) {
        if (pending && !dialog.contains(event.target)) cancel.focus({ preventScroll: true });
    }

    function onKeyDown(event) {
        if (!pending) return;
        event.stopImmediatePropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
        } else if (event.key === 'Tab') {
            event.preventDefault();
            const buttons = [dismiss, cancel, confirm];
            const index = buttons.indexOf(document.activeElement);
            const next = index < 0 ? 1 : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
            buttons[next].focus({ preventScroll: true });
        } else if (event.key === 'Enter' && ![dismiss, cancel, confirm].includes(document.activeElement)) {
            event.preventDefault();
        }
    }

    function onUnload() { finish(false); }
    cancel.addEventListener('click', () => finish(false));
    dismiss.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });

    return {
        show(options) {
            if (pending) return Promise.resolve(false);
            title.textContent = options.title;
            message.textContent = options.message;
            detail.textContent = options.detail;
            cancel.textContent = options.cancelLabel;
            confirm.textContent = options.confirmLabel;
            return new Promise(resolve => {
                pending = { resolve, anchor: options.anchor, previousFocus: document.activeElement };
                overlay.classList.remove('hidden');
                position();
                if (!pending) return;
                document.addEventListener('keydown', onKeyDown, true);
                document.addEventListener('focusin', onFocusIn, true);
                document.addEventListener('scroll', position, true);
                window.addEventListener('resize', position);
                window.addEventListener('beforeunload', onUnload);
                cancel.focus({ preventScroll: true });
            });
        }
    };
}

module.exports = { createAnchoredConfirmDialog };
