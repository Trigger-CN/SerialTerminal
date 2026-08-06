'use strict';

function getVerticalInsertionIndex(rects, pointerY) {
  const y = Number(pointerY);
  if (!Number.isFinite(y)) return rects.length;

  const index = rects.findIndex(rect => {
    const top = Number(rect?.top);
    const height = Number(rect?.height);
    return Number.isFinite(top) && Number.isFinite(height) && y < top + height / 2;
  });

  return index < 0 ? rects.length : index;
}

module.exports = { getVerticalInsertionIndex };
