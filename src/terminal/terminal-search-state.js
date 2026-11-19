'use strict';

function createTerminalRevisionTracker(term, onInvalidate = () => {}) {
  let revision = 0;
  let disposed = false;
  const disposables = [];

  const invalidate = (reason = 'explicit') => {
    if (disposed) return revision;
    revision++;
    onInvalidate(term, revision, reason);
    return revision;
  };

  const subscribe = (owner, event, reason) => {
    if (typeof event !== 'function') return;
    const disposable = event.call(owner, () => invalidate(reason));
    if (disposable && typeof disposable.dispose === 'function') disposables.push(disposable);
  };

  subscribe(term, term?.onWriteParsed, 'write');
  subscribe(term, term?.onResize, 'resize');
  subscribe(term?.buffer, term?.buffer?.onBufferChange, 'buffer');

  return {
    get revision() {
      return revision;
    },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposables.splice(0).forEach(disposable => disposable.dispose());
    }
  };
}

function findAnchoredMatchIndex(matches, anchor) {
  if (!anchor || !Number.isInteger(anchor.line) || anchor.line < 0) return -1;
  return matches.findIndex(match => (
    match.line === anchor.line &&
    match.column === anchor.column &&
    match.length === anchor.length
  ));
}

function resolveNavigationIndex(direction, current, total) {
  if (!Number.isInteger(total) || total < 1) return 0;
  if (direction === 'previous') return current <= 1 ? total : current - 1;
  return current < 1 || current >= total ? 1 : current + 1;
}

module.exports = {
  createTerminalRevisionTracker,
  findAnchoredMatchIndex,
  resolveNavigationIndex
};
