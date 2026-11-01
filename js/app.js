// app.js — Open Collections 管理界面逻辑（侧边栏与独立窗口共用）。
(function () {
  'use strict';

  const state = {
    data: null,
    search: '',
    editingGroupId: null,
    editingCardId: null
  };

  // ---- DOM 引用 ----
  const $ = (id) => document.getElementById(id);
  const els = {};

  // 创建内联 SVG 图标（symbol 定义在 management.html 的 sprite 中，Lucide/ISC）。
  function iconSvg(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function cacheEls() {
    els.app = $('app');
    els.btnToggleGroups = $('btn-toggle-groups');
    els.groupsBackdrop = $('groups-backdrop');
    els.btnGroupColor = $('btn-group-color');
    els.btnAddMenu = $('btn-add-menu');
    els.addMenu = $('add-menu');
    els.btnCollectTabs = $('btn-collect-tabs');
    els.btnCollectClose = $('btn-collect-close');
    els.groupList = $('group-list');
    els.groupHead = $('group-head');
    els.groupColorDot = $('group-color-dot');
    els.groupNameInput = $('group-name-input');
    els.groupMeta = $('group-meta');
    els.colorPicker = $('color-picker');
    els.searchInput = $('search-input');
    els.searchCount = $('search-count');
    els.cardList = $('card-list');
    els.empty = $('empty-state');
    els.emptyTitle = els.empty.querySelector('.empty-title');
    els.emptyDesc = els.empty.querySelector('.empty-desc');
    els.emptyAction = $('empty-action');
    els.loading = $('loading-state');
    els.error = $('error-state');
    els.errorMsg = $('error-msg');
    els.toast = $('toast');
    els.settings = $('settings-drawer');
    els.editor = $('card-editor');
  }

  // ---- 通知 ----
  let toastTimer;
  function toast(msg, type) {
    type = type || 'info';
    els.toast.textContent = msg;
    els.toast.className = 'toast ' + type;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2600);
  }

  // ---- 数据加载与渲染 ----
  async function loadAndRender() {
    showState('loading');
    try {
      state.data = await Storage.load();
      const firstAlive = state.data.groups.find((g) => !g.deleted);
      if (!state.data.activeGroupId && firstAlive) {
        state.data.activeGroupId = firstAlive.id;
        await Storage.setActiveGroup(state.data.activeGroupId);
      }
      render();
      showState('content');
    } catch (e) {
      console.error(e);
      els.errorMsg.textContent = e.message || '数据加载失败';
      showState('error');
    }
  }

  function showState(s) {
    els.loading.classList.toggle('hidden', s !== 'loading');
    els.error.classList.toggle('hidden', s !== 'error');
    const hasGroup = !!(state.data && state.data.groups.some((g) => !g.deleted));
    els.groupHead.classList.toggle('hidden', !hasGroup);
    els.searchInput.style.display = hasGroup ? '' : 'none';
    els.searchCount.style.display = hasGroup ? '' : 'none';

    if (s !== 'content') {
      els.empty.classList.add('hidden');
      els.cardList.style.display = 'none';
      return;
    }
    // content 状态下 empty/cardList 的显隐由 renderCards 决定；
    // 无分组时 renderCards 会提前返回，这里做兜底。
    if (!hasGroup) {
      els.empty.classList.remove('hidden');
      els.cardList.style.display = 'none';
      updateEmptyState('');
    }
  }

  function getActiveGroup() {
    if (!state.data) return null;
    return state.data.groups.find((g) => g.id === state.data.activeGroupId && !g.deleted) || null;
  }

  // ---- 分组栏折叠 ----
  // 窄屏（侧边栏）默认折叠，宽屏默认展开；手动切换在跨越断点前保持。
  const NARROW_QUERY = window.matchMedia('(max-width: 520px)');

  function setGroupsFolded(folded) {
    els.app.classList.toggle('groups-collapsed', folded);
    if (folded) els.colorPicker.classList.add('hidden');
    const label = folded ? '展开分组栏' : '折叠分组栏';
    els.btnToggleGroups.setAttribute('aria-expanded', String(!folded));
    els.btnToggleGroups.setAttribute('aria-label', label);
    els.btnToggleGroups.title = label;
  }

  function toggleGroups() {
    setGroupsFolded(!els.app.classList.contains('groups-collapsed'));
  }

  function render() {
    renderGroups();
    renderActiveGroup();
    renderCards();
  }

  function renderGroups() {
    const groups = (state.data.groups || []).filter((g) => !g.deleted);
    els.groupList.innerHTML = '';
    for (const g of groups) {
      const li = document.createElement('li');
      li.className = 'group-item' + (g.id === state.data.activeGroupId ? ' active' : '');
      li.dataset.id = g.id;
      const aliveCards = g.cards.filter((c) => !c.deleted).length;
      li.innerHTML = `
        <span class="group-dot" style="background:${Utils.escapeHtml(g.color)}"></span>
        <span class="group-name">${Utils.escapeHtml(g.name)}</span>
        <span class="group-count">${aliveCards}</span>
      `;
      li.addEventListener('click', async () => {
        state.data.activeGroupId = g.id;
        await Storage.setActiveGroup(g.id);
        render();
        // 窄屏下分组栏是浮层，选中后自动收起。
        if (NARROW_QUERY.matches) setGroupsFolded(true);
      });
      els.groupList.appendChild(li);
    }
  }

  function renderActiveGroup() {
    const g = getActiveGroup();
    els.btnGroupColor.classList.toggle('hidden', !g);
    if (!g) {
      els.colorPicker.classList.add('hidden');
      els.groupHead.classList.add('hidden');
      return;
    }
    els.groupColorDot.style.background = g.color;
    els.groupNameInput.value = g.name;
    els.groupNameInput.dataset.id = g.id;
    const alive = g.cards.filter((c) => !c.deleted).length;
    els.groupMeta.textContent = `${alive} 个内容 · 创建于 ${Utils.formatTime(g.createdAt)}`;
    renderColorPicker(g.color);
  }

  function renderColorPicker(selected) {
    els.colorPicker.innerHTML = '';
    for (const c of Utils.PALETTE) {
      const sw = document.createElement('span');
      sw.className = 'color-swatch' + (c === selected ? ' selected' : '');
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener('click', async () => {
        const g = getActiveGroup();
        if (!g) return;
        await Storage.setGroupColor(g.id, c);
        g.color = c;
        renderActiveGroup();
        renderGroups();
      });
      els.colorPicker.appendChild(sw);
    }
  }

  function cardMatchesQuery(card, q) {
    if (!q) return true;
    return [card.title, card.url, card.notes, card.excerpt, card.sourceTitle, card.sourceUrl]
      .some((f) => String(f || '').toLowerCase().includes(q));
  }

  function updateEmptyState(q) {
    if (!state.data) return;
    const hasAnyGroup = state.data.groups.some((g) => !g.deleted);
    if (!hasAnyGroup) {
      els.emptyTitle.textContent = '还没有分组';
      els.emptyDesc.textContent = '先新建一个分组，再开始收藏网页与摘录。';
      els.emptyAction.classList.remove('hidden');
    } else if (q) {
      els.emptyTitle.textContent = '没有匹配的内容';
      els.emptyDesc.textContent = '换个关键词试试；搜索范围包含标题、URL、笔记与摘录正文，并覆盖所有分组。';
      els.emptyAction.classList.add('hidden');
    } else {
      els.emptyTitle.textContent = '这个分组还没有内容';
      els.emptyDesc.textContent = '点击顶部「添加当前页面」，或按 Ctrl+Shift+S 收藏当前网页；选中文字后按 Ctrl+Shift+E 保存摘录。';
      els.emptyAction.classList.add('hidden');
    }
  }

  function renderCards() {
    const g = getActiveGroup();
    els.cardList.innerHTML = '';
    if (!g || !state.data) return;

    const q = state.search.trim().toLowerCase();
    const totalAlive = state.data.groups
      .filter((x) => !x.deleted)
      .reduce((n, x) => n + x.cards.filter((c) => !c.deleted).length, 0);

    let items;
    if (q) {
      // 跨分组搜索：标题、URL、笔记、摘录正文。
      items = [];
      for (const grp of state.data.groups) {
        if (grp.deleted) continue;
        for (const c of grp.cards) {
          if (!c.deleted && cardMatchesQuery(c, q)) items.push({ card: c, group: grp });
        }
      }
      els.searchCount.textContent = `${items.length} 条匹配 / 全部 ${totalAlive}`;
    } else {
      items = g.cards.filter((c) => !c.deleted).map((c) => ({ card: c, group: g }));
      els.searchCount.textContent = '';
    }

    const isEmpty = items.length === 0;
    els.empty.classList.toggle('hidden', !isEmpty);
    els.cardList.style.display = isEmpty ? 'none' : '';
    if (isEmpty) updateEmptyState(q);

    for (const it of items) {
      els.cardList.appendChild(renderCard(it.card, it.group, !!q));
    }
  }

  function renderCard(c, group, searching) {
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = c.id;
    li.draggable = !searching;

    const handle = document.createElement('span');
    handle.className = 'card-handle';
    handle.title = searching ? '搜索状态下不能拖拽排序' : '拖拽排序';
    handle.appendChild(iconSvg('grip-vertical'));
    li.appendChild(handle);

    // favicon：优先扩展内置 _favicon，失败退回首字母色块。
    const faviconEl = document.createElement('div');
    faviconEl.className = 'card-favicon';
    const fallback = () => {
      faviconEl.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = Utils.initial(c.title);
      span.style.background = Utils.colorFromString(c.title);
      faviconEl.appendChild(span);
    };
    if (c.favicon) {
      const img = document.createElement('img');
      img.src = c.favicon;
      img.alt = '';
      img.addEventListener('error', fallback);
      faviconEl.appendChild(img);
    } else {
      fallback();
    }
    li.appendChild(faviconEl);

    const body = document.createElement('div');
    body.className = 'card-body';
    const titleEl = document.createElement('span');
    titleEl.className = 'card-title';
    titleEl.textContent = c.title;
    const urlEl = document.createElement('span');
    urlEl.className = 'card-url';
    urlEl.textContent = Utils.hostname(c.url || c.sourceUrl) || c.url || c.sourceUrl || '';
    body.appendChild(titleEl);
    body.appendChild(urlEl);

    if (c.type === 'excerpt' && c.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'card-excerpt';
      ex.textContent = c.excerpt;
      body.appendChild(ex);
    }
    if (c.notes) {
      const n = document.createElement('div');
      n.className = 'card-notes';
      n.appendChild(iconSvg('file-text'));
      n.appendChild(document.createTextNode(Utils.truncate(c.notes, 80)));
      body.appendChild(n);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    if (searching) {
      const gb = document.createElement('span');
      gb.className = 'card-tag group-badge';
      gb.textContent = group.name;
      gb.style.borderLeft = `3px solid ${group.color}`;
      meta.appendChild(gb);
    }
    const tag = document.createElement('span');
    tag.className = 'card-tag ' + c.type;
    tag.textContent = c.type === 'excerpt' ? '摘录' : '页面';
    const time = document.createElement('span');
    time.className = 'card-time';
    time.textContent = Utils.relativeTime(c.addedAt);
    meta.appendChild(tag);
    meta.appendChild(time);
    body.appendChild(meta);
    li.appendChild(body);

    const editBtn = document.createElement('button');
    editBtn.className = 'card-edit';
    editBtn.title = '编辑标题 / 备注';
    editBtn.appendChild(iconSvg('pencil'));
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardEditor(group.id, c.id);
    });
    li.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'card-delete';
    delBtn.title = '删除卡片';
    delBtn.appendChild(iconSvg('trash'));
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCardQuick(group.id, c.id);
    });
    li.appendChild(delBtn);

    // 单击卡片直接打开原链接（摘录打开来源页）。
    li.addEventListener('click', (e) => {
      if (e.target.closest('.card-handle') || e.target.closest('.card-edit') ||
        e.target.closest('.card-delete')) return;
      openCardLink(c);
    });

    // 拖拽排序（仅当前分组、非搜索状态）。
    if (!searching) {
      li.addEventListener('dragstart', (e) => {
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', c.id);
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        document.querySelectorAll('.card.drag-over').forEach((n) => n.classList.remove('drag-over'));
      });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.card.drag-over').forEach((n) => n.classList.remove('drag-over'));
        li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', async (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === c.id) return;
        await reorderCards(group.id, draggedId, c.id);
      });
    }

    return li;
  }

  function openCardLink(c) {
    const url = c.type === 'excerpt' ? (c.sourceUrl || c.url) : c.url;
    if (url && Utils.isHttpUrl(url)) {
      chrome.tabs.create({ url });
    } else {
      toast('这条内容没有可打开的网页链接', 'error');
    }
  }

  async function reorderCards(groupId, draggedId, targetId) {
    const g = getActiveGroup();
    if (!g) return;
    const alive = g.cards.filter((c) => !c.deleted);
    const ids = alive.map((c) => c.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggedId);
    await Storage.reorderCards(groupId, ids);
    const orderMap = new Map(ids.map((id, i) => [id, i]));
    alive.sort((a, b) => (orderMap.get(a.id) === undefined ? 0 : orderMap.get(a.id)) -
      (orderMap.get(b.id) === undefined ? 0 : orderMap.get(b.id)));
    renderCards();
  }

  // ---- 卡片编辑器 ----
  function openCardEditor(groupId, cardId) {
    const g = state.data && state.data.groups.find((x) => x.id === groupId);
    const c = g && g.cards.find((x) => x.id === cardId);
    if (!c) return;
    state.editingCardId = cardId;
    state.editingGroupId = groupId;
    $('edit-title').value = c.title;
    $('edit-url').value = c.url || '';
    $('edit-excerpt').value = c.excerpt || '';
    $('edit-notes').value = c.notes || '';
    $('edit-url-row').style.display = c.type === 'excerpt' ? 'none' : '';
    $('edit-excerpt-row').style.display = c.type === 'excerpt' ? '' : 'none';
    openDrawer('editor');
  }

  async function saveCardEdit() {
    const g = state.data.groups.find((x) => x.id === state.editingGroupId);
    const c = g && g.cards.find((x) => x.id === state.editingCardId);
    if (!c) return;
    try {
      await Storage.updateCard(state.editingGroupId, state.editingCardId, {
        title: $('edit-title').value.trim() || c.title,
        url: $('edit-url').value.trim(),
        notes: $('edit-notes').value,
        excerpt: c.type === 'excerpt' ? $('edit-excerpt').value : c.excerpt
      });
      toast('已保存', 'success');
      closeDrawer('editor');
      await loadAndRender();
    } catch (e) {
      toast('保存失败：' + (e.message || e), 'error');
    }
  }

  async function deleteCurrentCard() {
    if (!confirm('确定删除这张卡片吗？')) return;
    try {
      await Storage.deleteCard(state.editingGroupId, state.editingCardId);
      toast('已删除', 'success');
      closeDrawer('editor');
      await loadAndRender();
    } catch (e) {
      toast('删除失败：' + (e.message || e), 'error');
    }
  }

  async function deleteCardQuick(groupId, cardId) {
    if (!confirm('确定删除这张卡片吗？')) return;
    try {
      await Storage.deleteCard(groupId, cardId);
      toast('已删除', 'success');
      await loadAndRender();
    } catch (e) {
      toast('删除失败：' + (e.message || e), 'error');
    }
  }

  function openCurrentCardLink() {
    const g = state.data.groups.find((x) => x.id === state.editingGroupId);
    const c = g && g.cards.find((x) => x.id === state.editingCardId);
    if (!c) return;
    openCardLink(c);
  }

  // ---- 分组操作 ----
  async function createGroup() {
    const count = state.data ? state.data.groups.filter((g) => !g.deleted).length : 0;
    const input = prompt('新分组名称：', Utils.defaultGroupName(count + 1));
    const name = (input == null ? '' : String(input)).trim();
    if (!name) return;
    try {
      const g = await Storage.createGroup(name);
      state.data.activeGroupId = g.id;
      await loadAndRender();
      toast('分组已创建', 'success');
    } catch (e) {
      toast('创建失败：' + (e.message || e), 'error');
    }
  }

  async function renameGroupFromInput() {
    const input = els.groupNameInput;
    const id = input.dataset.id;
    const name = input.value.trim();
    if (!name || !id) {
      const g = getActiveGroup();
      input.value = g ? g.name : '';
      return;
    }
    try {
      await Storage.renameGroup(id, name);
      const g = state.data.groups.find((x) => x.id === id);
      if (g) g.name = name;
      renderGroups();
    } catch (e) {
      toast('重命名失败：' + (e.message || e), 'error');
    }
  }

  async function deleteActiveGroup() {
    const g = getActiveGroup();
    if (!g) return;
    if (!confirm(`确定删除分组「${g.name}」及其所有内容吗？本地会立即移除，同步时通过墓碑传播删除。`)) return;
    try {
      await Storage.deleteGroup(g.id);
      await loadAndRender();
      toast('分组已删除', 'success');
    } catch (e) {
      toast('删除失败：' + (e.message || e), 'error');
    }
  }

  // ---- 打开链接 ----
  function openAllInGroup() {
    const g = getActiveGroup();
    if (!g) return;
    const urls = g.cards
      .filter((c) => !c.deleted && Utils.isHttpUrl(c.url || c.sourceUrl))
      .map((c) => (c.type === 'excerpt' ? (c.sourceUrl || c.url) : c.url));
    if (!urls.length) {
      toast('当前分组没有可打开的链接', 'error');
      return;
    }
    if (urls.length > 10 && !confirm(`将打开 ${urls.length} 个标签页，是否继续？`)) return;
    urls.forEach((url) => chrome.tabs.create({ url }));
  }

  // ---- 与 background 通信 ----
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp && resp.ok === false) {
          const err = new Error(resp.error || '操作失败');
          err.code = resp.code;
          return reject(err);
        }
        resolve(resp);
      });
    });
  }

  async function addCurrentPage() {
    try {
      const res = await sendMessage({ type: 'add-current-page' });
      toast((res.result && res.result.message) || '已加入当前分组', 'success');
      await loadAndRender();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---- 批量收藏当前窗口标签页 ----
  function setAddMenuOpen(open) {
    els.addMenu.classList.toggle('hidden', !open);
    els.btnAddMenu.setAttribute('aria-expanded', String(open));
  }

  function isCollectibleTab(tab) {
    // 固定标签与浏览器内部页不参与。
    return !!tab && !tab.pinned && /^https?:/i.test(tab.url || '');
  }

  async function getCollectWindow() {
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
      if (win && Array.isArray(win.tabs)) return win;
    } catch (e) {
      console.warn('[OpenCollections] getLastFocused failed:', e);
    }
    // 回退：以最后聚焦的活动标签所在窗口为准。
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return null;
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    return { id: tab.windowId, tabs };
  }

  async function collectWindowTabs(closeAfter) {
    setAddMenuOpen(false);
    try {
      const group = getActiveGroup();
      if (!group) throw new Error('请先创建一个分组');

      const win = await getCollectWindow();
      if (!win) throw new Error('无法获取当前窗口的标签页');

      const targets = (win.tabs || []).filter(isCollectibleTab);
      if (!targets.length) throw new Error('当前窗口没有可收藏的网页标签页（固定标签与浏览器内部页不计入）');

      await Storage.addCards(group.id, targets.map((tab) => ({
        type: 'page',
        title: tab.title || tab.url,
        url: tab.url,
        favicon: `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`
      })));

      let closed = 0;
      if (closeAfter) {
        // 保留当前活动标签，避免侧边栏随之关闭。
        const activeId = (win.tabs.find((t) => t.active) || {}).id;
        const ids = targets.filter((t) => t.id !== activeId).map((t) => t.id);
        if (ids.length) {
          await chrome.tabs.remove(ids);
          closed = ids.length;
        }
      }

      if (closeAfter) {
        toast(`已收藏 ${targets.length} 个标签页，关闭 ${closed} 个`, 'success');
      } else {
        toast(`已将 ${targets.length} 个标签页收进「${group.name}」`, 'success');
      }
      await loadAndRender();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // 侧边栏按钮点击不会自动获得 activeTab 权限；摘录需要注入脚本读取选区，
  // 因此在用户点击时申请可选的全站访问权限（已授权时不会重复弹窗）。
  function requestPageAccess() {
    return new Promise((resolve) => {
      if (!chrome.permissions || !chrome.permissions.request) return resolve(true);
      chrome.permissions.request({ origins: ['<all_urls>'] }, (granted) => {
        if (chrome.runtime.lastError) {
          console.warn('[OpenCollections] permission request:', chrome.runtime.lastError.message);
        }
        resolve(!!granted);
      });
    });
  }

  async function saveSelection() {
    const granted = await requestPageAccess();
    if (!granted) {
      toast('未获得页面访问权限。可在扩展详情中开启站点访问权限，或在网页上按 Ctrl+Shift+E', 'error');
      return;
    }
    try {
      const res = await sendMessage({ type: 'save-selection' });
      toast((res.result && res.result.message) || '摘录已保存', 'success');
      await loadAndRender();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function openWindow() {
    try {
      await sendMessage({ type: 'open-window' });
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---- 导入导出 ----
  async function exportJSON() {
    try {
      const text = await Storage.exportJSON();
      downloadFile(text, `open-collections-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      toast('已导出 JSON', 'success');
    } catch (e) {
      toast('导出失败：' + (e.message || e), 'error');
    }
  }

  async function exportHTML() {
    try {
      const text = await Storage.exportBookmarksHTML();
      downloadFile(text, `open-collections-bookmarks-${new Date().toISOString().slice(0, 10)}.html`, 'text/html');
      toast('已导出 HTML 书签', 'success');
    } catch (e) {
      toast('导出失败：' + (e.message || e), 'error');
    }
  }

  function triggerImport(overwrite) {
    state._importOverwrite = !!overwrite;
    $('file-import').click();
  }

  async function handleImportFile(file) {
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (e) {
      toast('读取文件失败：' + e.message, 'error');
      return;
    }
    try {
      const res = await Storage.importJSON(text, { merge: !state._importOverwrite });
      toast(state._importOverwrite ? '已覆盖导入' : `已合并导入（新增 ${res.cards || 0} 条）`, 'success');
      await loadAndRender();
    } catch (e) {
      toast('导入失败：' + (e.message || e), 'error');
    }
  }

  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- WebDAV 设置与同步 ----
  let wdSettings = null;

  async function loadSettingsToForm() {
    wdSettings = await Storage.loadSettings();
    const w = wdSettings.webdav || {};
    $('wd-url').value = w.url || '';
    $('wd-username').value = w.username || '';
    $('wd-password').value = w.password || '';
    $('wd-remote-dir').value = w.remoteDir || '/open-collections';
    $('wd-autosync').checked = !!w.autoSync;
    $('wd-interval').value = Number(w.intervalMinutes) || 30;
  }

  function readSettingsFromForm() {
    return {
      webdav: {
        url: $('wd-url').value.trim(),
        username: $('wd-username').value.trim(),
        password: $('wd-password').value,
        remoteDir: $('wd-remote-dir').value.trim() || '/open-collections',
        autoSync: $('wd-autosync').checked,
        intervalMinutes: Math.max(5, Number($('wd-interval').value) || 30)
      }
    };
  }

  function setWDStatus(msg, type) {
    const el = $('wd-status');
    el.textContent = msg || '';
    el.className = 'wd-status' + (type ? ' ' + type : '');
  }

  // 在用户点击的同一个调用栈里申请该站点的网络权限（optional_host_permissions）。
  function requestOriginPermission(url) {
    return new Promise((resolve) => {
      if (!chrome.permissions || !chrome.permissions.request) return resolve(true);
      let origin;
      try {
        const u = new URL(url);
        origin = `${u.protocol}//${u.host}/*`;
      } catch (e) {
        return resolve(false);
      }
      chrome.permissions.request({ origins: [origin] }, (granted) => resolve(!!granted));
    });
  }

  async function persistSettings(s) {
    wdSettings = s;
    await Storage.saveSettings(s);
    await sendMessage({ type: 'webdav-reschedule' });
  }

  async function saveSettings() {
    try {
      await persistSettings(readSettingsFromForm());
      setWDStatus('设置已保存' + (wdSettings.webdav.autoSync ? '，自动同步已启用' : ''), 'success');
    } catch (e) {
      setWDStatus('保存失败：' + (e.message || e), 'error');
    }
  }

  async function testConnection() {
    const s = readSettingsFromForm();
    if (!s.webdav.url) {
      setWDStatus('请先填写 WebDAV 服务器地址', 'error');
      return;
    }
    const granted = await requestOriginPermission(s.webdav.url);
    if (!granted) {
      setWDStatus('未获得访问该服务器的网络权限，请重试并在弹窗中选择允许', 'error');
      return;
    }
    setWDStatus('正在测试连接…', '');
    try {
      await WebDAV.testConnection(s.webdav);
      setWDStatus('连接成功 ✓', 'success');
    } catch (e) {
      setWDStatus('连接失败：' + (e.message || e), 'error');
    }
  }

  async function runSync(mode) {
    const label = { sync: '同步', upload: '上传', download: '下载' }[mode] || mode;
    const s = readSettingsFromForm();
    if (!s.webdav.url) {
      setWDStatus('请先填写 WebDAV 服务器地址', 'error');
      return;
    }
    const granted = await requestOriginPermission(s.webdav.url);
    if (!granted) {
      setWDStatus('未获得访问该服务器的网络权限，请重试并在弹窗中选择允许', 'error');
      return;
    }
    if (!s.webdav.username) {
      setWDStatus('请先填写用户名', 'error');
      return;
    }
    setWDStatus(`正在${label}…`, '');
    try {
      // 先落盘当前表单，保证后台读到的是最新配置。
      await persistSettings(s);
      const res = await sendMessage({ type: 'webdav-sync', mode });
      const result = res && res.result;
      setWDStatus(`${label}完成 ✓${result ? `（${result.groups} 个分组）` : ''}`, 'success');
      await loadAndRender();
    } catch (e) {
      setWDStatus(`${label}失败：${e.message || e}`, 'error');
    }
  }

  // ---- 抽屉 ----
  function openDrawer(name) {
    const drawer = name === 'settings' ? els.settings : els.editor;
    drawer.classList.remove('hidden');
    if (name === 'settings') loadSettingsToForm();
  }
  function closeDrawer(name) {
    const drawer = name === 'settings' ? els.settings : els.editor;
    drawer.classList.add('hidden');
  }

  // ---- 事件绑定 ----
  function bindEvents() {
    els.btnToggleGroups.addEventListener('click', toggleGroups);
    els.groupsBackdrop.addEventListener('click', () => setGroupsFolded(true));
    NARROW_QUERY.addEventListener('change', (e) => setGroupsFolded(e.matches));

    $('btn-new-group').addEventListener('click', createGroup);
    els.emptyAction.addEventListener('click', createGroup);
    els.btnGroupColor.addEventListener('click', () => els.colorPicker.classList.toggle('hidden'));
    $('btn-delete-group').addEventListener('click', deleteActiveGroup);
    $('btn-open-all').addEventListener('click', openAllInGroup);
    els.groupNameInput.addEventListener('change', renameGroupFromInput);
    els.groupNameInput.addEventListener('blur', renameGroupFromInput);

    $('btn-add-page').addEventListener('click', addCurrentPage);
    els.btnAddMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      setAddMenuOpen(els.addMenu.classList.contains('hidden'));
    });
    els.btnCollectTabs.addEventListener('click', () => collectWindowTabs(false));
    els.btnCollectClose.addEventListener('click', () => collectWindowTabs(true));
    $('btn-save-sel').addEventListener('click', saveSelection);
    $('btn-window').addEventListener('click', openWindow);
    $('btn-settings').addEventListener('click', () => openDrawer('settings'));

    els.searchInput.addEventListener('input', Utils.debounce((e) => {
      state.search = e.target.value;
      renderCards();
    }, 150));
    els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        els.searchInput.value = '';
        state.search = '';
        renderCards();
      }
    });

    $('btn-retry').addEventListener('click', loadAndRender);

    // 卡片编辑器
    $('btn-save-card').addEventListener('click', saveCardEdit);
    $('btn-delete-card').addEventListener('click', deleteCurrentCard);
    $('btn-open-card').addEventListener('click', openCurrentCardLink);

    // 导入导出
    $('btn-export-json').addEventListener('click', exportJSON);
    $('btn-export-html').addEventListener('click', exportHTML);
    $('btn-import-json').addEventListener('click', () => triggerImport(false));
    $('btn-import-json-overwrite').addEventListener('click', () => triggerImport(true));
    $('file-import').addEventListener('change', (e) => {
      handleImportFile(e.target.files[0]);
      e.target.value = '';
    });

    // WebDAV
    $('btn-wd-save').addEventListener('click', saveSettings);
    $('btn-wd-test').addEventListener('click', testConnection);
    $('btn-wd-sync').addEventListener('click', () => runSync('sync'));
    $('btn-wd-upload').addEventListener('click', () => runSync('upload'));
    $('btn-wd-download').addEventListener('click', () => runSync('download'));

    // 抽屉关闭
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => closeDrawer(el.dataset.close));
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('.add-split') || e.target.closest('.add-menu')) return;
      setAddMenuOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        setAddMenuOpen(false);
        closeDrawer('settings');
        closeDrawer('editor');
      }
    });

    // 来自 background 的通知（快捷键收藏成功/失败等）。
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'notification' && msg.payload) {
        const p = msg.payload;
        toast(p.message, p.type);
        if (p.type === 'success') loadAndRender();
      }
    });

    // 跨侧边栏/独立窗口的实时刷新。
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes[Storage.STORAGE_KEY] || changes[Storage.SETTINGS_KEY])) {
        loadAndRender();
      }
    });
  }

  // ---- 启动 ----
  function init() {
    cacheEls();
    setGroupsFolded(NARROW_QUERY.matches);
    bindEvents();
    loadAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
