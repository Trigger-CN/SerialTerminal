'use strict';

// 按分组分桶的「标签列表集合」（P5）。
//
// 背景：`filterTabs` / `chartTabs` 从 P3 起一直是**全应用单例**，靠
// `isActiveSerialGroup(groupId)` 这道临时边界防止串数据。代价是：非激活分组的
// 字节不会进过滤页与图表页，用户切回该分组时会发现那段时间的数据是空的。
//
// 本模块只解决「同一类标签在不同分组各有一份」，不碰 DOM、不碰 renderer 的
// 其它状态，因此可以直接在 Node 里断言。
//
// 设计取舍：**不把 54 处 `filterTabs.forEach/.find/.push` 全部改写成
// `getGroupTabList(groupId).forEach`。** 改成 Map 之后，让 renderer 里的
// `let filterTabs` 在切换分组时**指向另一个数组**即可，消费点一行都不用动。
// 这与 P4 把四个显示参数的模块级 `let` 降级为「默认分组缓存」是同一个手法：
// 单分组/默认分组的行为逐字节不变，风险被限制在切换的那一处。

const { normalizeGroupId, DEFAULT_SERIAL_GROUP_ID } = require('./serial-group-registry');

function createGroupTabListStore({ defaultGroupId = DEFAULT_SERIAL_GROUP_ID } = {}) {
  const defaultId = normalizeGroupId(defaultGroupId);
  // groupId -> 该分组的标签数组。存的是**数组引用本身**，不是副本：
  // 调用方拿到的数组必须与 store 里的同一个，否则 push/splice 到副本上，
  // 后续 setActive 时再取回原数组，刚加的标签就「凭空消失」了。
  const lists = new Map();

  // 默认分组在构造时就建好。其它分组按需 ensure。
  lists.set(defaultId, []);

  function ensureList(groupId) {
    const id = normalizeGroupId(groupId);
    let list = lists.get(id);
    if (!list) {
      list = [];
      lists.set(id, list);
    }
    return list;
  }

  // 取某个分组的数组引用。**幂等**：反复取到的是同一个数组。
  function getList(groupId) {
    return ensureList(groupId);
  }

  // 列表里已有多少个标签。
  //
  // **故意不走 getList()**：读操作不得创建条目。否则 removeList() 之后
  // 一次 count() 就会把这个分组重新加回 listGroupIds()，调用方完全看不到
  // 「我刚删的那一组又回来了」，而后续 ensureList() 与残留引用会指向不同数组。
  function count(groupId) {
    const list = lists.get(normalizeGroupId(groupId));
    return list ? list.length : 0;
  }

  // 该分组是否已有标签。同样不创建条目。
  function isEmpty(groupId) {
    return count(groupId) === 0;
  }

  // 用一批标签**替换**某分组的列表内容。
  //
  // 必须是原地替换（splice + push）而不是把 `lists.set(id, next)`：
  // 调用方可能已经持有旧数组的引用（renderer 的模块级 `let filterTabs`
  // 就可能是它），换成新数组会让那个引用变成孤儿，之后 push 进去的标签
  // 再也不会被任何消费点看到。
  function replaceList(groupId, tabs) {
    const list = getList(groupId);
    list.length = 0;
    if (Array.isArray(tabs)) list.push(...tabs);
    return list;
  }

  // 清空某分组的列表。同样原地清。
  function clearList(groupId) {
    return replaceList(groupId, []);
  }

  // 释放一个分组的列表。默认分组不可释放——与 SerialGroupContextStore 同一规则：
  // 释放后没有任何路径能恢复，用户会看到一个「标签栏永远空着」的分组。
  function removeList(groupId) {
    const id = normalizeGroupId(groupId);
    if (id === defaultId) return false;
    return lists.delete(id);
  }

  function listGroupIds() {
    return Array.from(lists.keys());
  }

  function size() {
    return lists.size;
  }

  // 调试/断言用：把每个分组的标签数导成普通对象。
  function snapshot() {
    const result = {};
    lists.forEach((list, id) => {
      result[id] = list.length;
    });
    return result;
  }

  return {
    defaultGroupId: defaultId,
    ensureList,
    getList,
    count,
    isEmpty,
    replaceList,
    clearList,
    removeList,
    listGroupIds,
    size,
    snapshot
  };
}

module.exports = { createGroupTabListStore };
