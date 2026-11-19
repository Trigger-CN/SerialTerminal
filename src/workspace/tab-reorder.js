function getHorizontalInsertionIndex(rects, pointerX) {
  const index = rects.findIndex(rect => pointerX < rect.left + rect.width / 2);
  return index === -1 ? rects.length : index;
}

module.exports = { getHorizontalInsertionIndex };
