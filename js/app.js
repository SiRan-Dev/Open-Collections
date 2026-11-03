// app.js — Open Collections 管理界面逻辑（侧边栏与独立窗口共用）。
(function () {
  'use strict';

  const state = {
    data: null,
    search: '',
    editingGroupId: null,
    editingCardId: null,
    aiConfig: null,
    aiPlan: null,
    aiGroupIds: [],
    aiBackupKey: null,
    aiAbort: null,
    aiRunId: 0,
    aiInboxSkipped: 0,
    batchCollectDaily: false,
    aiIncludeInbox: false,
    dragCard: null,
    cardDropId: null,
    groupDropId: null
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
    els.groupsPanel = document.querySelector('.groups-panel');
    els.groupsHead = document.querySelector('.groups-head');
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
    els.aiDrawer = $('ai-drawer');
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
    const daily = groups.filter((g) => Storage.isDailyGroup(g))
      .sort((a, b) => b.id.localeCompare(a.id));
    const normal = groups.filter((g) => !Storage.isDailyGroup(g));

    if (daily.length) {
      appendGroupSection('收件箱 · 每日标签页');
      daily.forEach(appendGroupItem);
    }
    if (normal.length) {
      if (daily.length) appendGroupSection('主题集锦');
      normal.forEach(appendGroupItem);
    }
  }

  function appendGroupSection(label) {
    const li = document.createElement('li');
    li.className = 'group-section-label';
    li.textContent = label;
    li.title = label === '收件箱 · 每日标签页'
      ? '批量收藏的临时收件箱，按日期分组，等待整理'
      : '已归类保存的长期主题分组';
    els.groupList.appendChild(li);
  }

  function appendGroupItem(g) {
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
    els.groupMeta.textContent = Storage.isDailyGroup(g)
      ? `${alive} 个内容 · 每日收件箱（临时待整理） · 创建于 ${Utils.formatTime(g.createdAt)}`
      : `${alive} 个内容 · 主题集锦 · 创建于 ${Utils.formatTime(g.createdAt)}`;
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
      const g = getActiveGroup();
      if (g && Storage.isDailyGroup(g)) {
        els.emptyTitle.textContent = '收件箱是空的';
        els.emptyDesc.textContent = '批量收藏会按日期收进这里；之后可用「AI 整理」归入主题集锦。';
      } else {
        els.emptyTitle.textContent = '这个分组还没有内容';
        els.emptyDesc.textContent = '点击顶部「添加当前页面」，或按 Ctrl+Shift+S 收藏当前网页；选中文字后按 Ctrl+Shift+E 保存摘录。';
      }
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

  // ---- 拖拽状态与落点提示 ----
  function hasInternalDrag() {
    return !!(state.dragCard && state.dragCard.cardId);
  }

  function getDraggedCardId(e) {
    let id = '';
    try {
      if (e && e.dataTransfer) {
        id = e.dataTransfer.getData('text/plain') ||
          e.dataTransfer.getData('application/x-open-collections-card') || '';
      }
    } catch (err) {}
    return id || (state.dragCard && state.dragCard.cardId) || '';
  }

  function findCardGroupId(cardId) {
    if (!state.data || !cardId) return '';
    for (const g of state.data.groups) {
      if (g.deleted) continue;
      if (g.cards.some((c) => !c.deleted && c.id === cardId)) return g.id;
    }
    return '';
  }

  function findGroupRow(groupId) {
    if (!els.groupList || !groupId) return null;
    return Array.from(els.groupList.querySelectorAll('.group-item'))
      .find((n) => n.dataset.id === groupId) || null;
  }

  function clearCardDropIndicators() {
    state.cardDropId = null;
    if (els.cardList) {
      els.cardList.classList.remove('drag-invalid');
      els.cardList.querySelectorAll('.card.drag-over').forEach((n) => n.classList.remove('drag-over'));
    }
  }

  function clearGroupDropIndicators() {
    state.groupDropId = null;
    if (els.groupList) {
      els.groupList.querySelectorAll('.group-item.drop-target, .group-item.drop-invalid')
        .forEach((n) => n.classList.remove('drop-target', 'drop-invalid'));
      els.groupList.classList.remove('drag-invalid');
    }
    if (els.groupHead) els.groupHead.classList.remove('drop-target');
    if (els.groupsHead) els.groupsHead.classList.remove('drag-invalid');
    if (els.groupsPanel) els.groupsPanel.classList.remove('drag-invalid');
  }

  function clearDragState() {
    state.dragCard = null;
    clearCardDropIndicators();
    clearGroupDropIndicators();
    if (els.cardList) {
      els.cardList.querySelectorAll('.card.dragging').forEach((n) => n.classList.remove('dragging'));
    }
  }

  function setGroupDropTarget(groupId) {
    if (!groupId || state.groupDropId === groupId) return;
    clearGroupDropIndicators();
    clearCardDropIndicators();
    state.groupDropId = groupId;
    const row = findGroupRow(groupId);
    if (row) row.classList.add('drop-target');
  }

  function setGroupDropInvalid(container) {
    clearGroupDropIndicators();
    clearCardDropIndicators();
    const target = container || els.groupList;
    if (target) target.classList.add('drag-invalid');
  }

  function setCardDropTarget(cardEl, cardId) {
    if (state.cardDropId === cardId) return;
    clearCardDropIndicators();
    clearGroupDropIndicators();
    state.cardDropId = cardId;
    if (cardEl) cardEl.classList.add('drag-over');
  }

  function setCardListInvalid() {
    clearCardDropIndicators();
    clearGroupDropIndicators();
    if (els.cardList) els.cardList.classList.add('drag-invalid');
  }

  async function moveDraggedCardToGroup(targetGroupId, cardId, fromGroupId) {
    const drag = state.dragCard;
    const cid = cardId || (drag && drag.cardId) || '';
    const fid = fromGroupId || (drag && drag.groupId) || findCardGroupId(cid);
    const target = state.data && state.data.groups.find((g) => g.id === targetGroupId && !g.deleted);
    clearDragState();
    if (!cid || !fid || !targetGroupId) {
      toast('无法识别拖拽的卡片', 'error');
      return;
    }
    try {
      const res = await Storage.moveCardToGroup(fid, cid, targetGroupId);
      toast(res.sameGroup
        ? `已移到「${target ? target.name : '该分组'}」末尾`
        : `已移动到「${target ? target.name : '目标分组'}」`, 'success');
      await loadAndRender();
    } catch (e) {
      toast('移动失败：' + (e.message || e), 'error');
    }
  }

  function bindGroupDropTargets() {
    const panel = els.groupsPanel;
    if (panel) {
      panel.addEventListener('dragover', (e) => {
        if (!hasInternalDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        const row = e.target.closest('.group-item');
        if (row && els.groupList && els.groupList.contains(row) && row.dataset.id) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          setGroupDropTarget(row.dataset.id);
          return;
        }
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        const container = e.target.closest('.groups-head') ||
          e.target.closest('.group-list') || panel;
        setGroupDropInvalid(container);
      });

      panel.addEventListener('dragleave', (e) => {
        if (!hasInternalDrag()) return;
        if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
        clearGroupDropIndicators();
      });

      panel.addEventListener('drop', (e) => {
        if (!hasInternalDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        const row = e.target.closest('.group-item');
        if (!row || !els.groupList || !els.groupList.contains(row) || !row.dataset.id) {
          clearDragState();
          toast('请把卡片放到具体分组上', 'error');
          return;
        }
        const drag = state.dragCard;
        const cardId = getDraggedCardId(e) || (drag && drag.cardId);
        const fromGroupId = (drag && drag.groupId) || findCardGroupId(cardId);
        moveDraggedCardToGroup(row.dataset.id, cardId, fromGroupId);
      });
    }

    if (els.groupHead) {
      els.groupHead.addEventListener('dragover', (e) => {
        if (!hasInternalDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (els.groupHead.classList.contains('drop-target')) return;
        clearGroupDropIndicators();
        clearCardDropIndicators();
        els.groupHead.classList.add('drop-target');
      });

      els.groupHead.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && els.groupHead.contains(e.relatedTarget)) return;
        els.groupHead.classList.remove('drop-target');
      });

      els.groupHead.addEventListener('drop', (e) => {
        if (!hasInternalDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        const active = getActiveGroup();
        if (!active) {
          clearDragState();
          return;
        }
        const drag = state.dragCard;
        const cardId = getDraggedCardId(e) || (drag && drag.cardId);
        const fromGroupId = (drag && drag.groupId) || findCardGroupId(cardId);
        moveDraggedCardToGroup(active.id, cardId, fromGroupId);
      });
    }

    if (els.cardList) {
      els.cardList.addEventListener('dragover', (e) => {
        if (!hasInternalDrag()) return;
        if (e.target.closest('.card')) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        setCardListInvalid();
      });

      els.cardList.addEventListener('dragleave', (e) => {
        if (!hasInternalDrag()) return;
        if (e.relatedTarget && els.cardList.contains(e.relatedTarget)) return;
        els.cardList.classList.remove('drag-invalid');
      });

      els.cardList.addEventListener('drop', (e) => {
        if (!hasInternalDrag()) return;
        if (e.target.closest('.card')) return;
        e.preventDefault();
        e.stopPropagation();
        clearDragState();
        toast('请把卡片放到具体分组或另一张卡片上', 'error');
      });
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
    time.textContent = Utils.formatAddedTime(c.addedAt);
    time.title = Utils.formatTime(c.addedAt);
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

    // 拖拽：卡内排序 + 拖到左侧分组/当前分组标题实现跨组移动。
    if (!searching) {
      li.addEventListener('dragstart', (e) => {
        clearDragState();
        state.dragCard = { cardId: c.id, groupId: group.id };
        li.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', c.id); } catch (err) {}
          try { e.dataTransfer.setData('application/x-open-collections-card', c.id); } catch (err) {}
        }
      });

      li.addEventListener('dragend', () => {
        clearDragState();
      });

      li.addEventListener('dragover', (e) => {
        if (!hasInternalDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        setCardDropTarget(li, c.id);
      });

      li.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && li.contains(e.relatedTarget)) return;
        if (state.cardDropId === c.id) {
          li.classList.remove('drag-over');
          state.cardDropId = null;
        }
      });

      li.addEventListener('drop', async (e) => {
        if (!hasInternalDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        const draggedId = getDraggedCardId(e);
        const drag = state.dragCard;
        if (!draggedId || draggedId === c.id) {
          clearDragState();
          return;
        }
        if (drag && drag.groupId && drag.groupId !== group.id) {
          await moveDraggedCardToGroup(group.id);
          return;
        }
        clearCardDropIndicators();
        await reorderCards(group.id, draggedId, c.id);
        clearDragState();
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
    const g = state.data && state.data.groups.find((x) => x.id === groupId && !x.deleted);
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
  function refreshCollectMenuCopy() {
    const daily = !!state.batchCollectDaily;
    const tabsDesc = els.btnCollectTabs.querySelector('.add-menu-desc');
    const closeDesc = els.btnCollectClose.querySelector('.add-menu-desc');
    if (tabsDesc) {
      tabsDesc.textContent = daily
        ? '收进「收件箱 · 每日标签页」，不关闭标签；跳过固定标签与内部页'
        : '加入当前分组，不关闭标签；跳过固定标签与内部页';
    }
    if (closeDesc) {
      closeDesc.textContent = daily
        ? '收进「收件箱 · 每日标签页」后关闭这些标签（含当前页）并留下一个新标签页；固定标签保留'
        : '收藏后关闭这些标签（含当前页）并留下一个新标签页；固定标签保留';
    }
  }

  function setAddMenuOpen(open) {
    if (open) refreshCollectMenuCopy();
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
      const settings = await Storage.loadSettings();
      const oneTabMode = !!(settings.behavior && settings.behavior.batchCollectDaily);
      const activeGroup = getActiveGroup();
      if (!oneTabMode && !activeGroup) throw new Error('请先创建一个分组');

      const win = await getCollectWindow();
      if (!win) throw new Error('无法获取当前窗口的标签页');

      const targets = (win.tabs || []).filter(isCollectibleTab);
      if (!targets.length) throw new Error('当前窗口没有可收藏的网页标签页（固定标签与浏览器内部页不计入）');

      const cardInputs = targets.map((tab) => ({
        type: 'page',
        title: tab.title || tab.url,
        url: tab.url,
        favicon: `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`
      }));

      let targetGroup;
      let created = false;
      let revived = false;
      if (oneTabMode) {
        const res = await Storage.addCardsToDailyGroup(Utils.dateKey(Utils.now()), cardInputs);
        targetGroup = res.group;
        created = res.created;
        revived = res.revived;
      } else {
        await Storage.addCards(activeGroup.id, cardInputs);
        targetGroup = activeGroup;
      }

      let closed = 0;
      if (closeAfter) {
        // 先开一个新标签页接管窗口（侧边栏跟随窗口而非标签），
        // 再关闭全部已收藏标签，包括当前页。
        await chrome.tabs.create({ active: true });
        const ids = targets.map((t) => t.id);
        if (ids.length) {
          await chrome.tabs.remove(ids);
          closed = ids.length;
        }
      }

      if (closeAfter) {
        toast(`已收进「${targetGroup.name}」并关闭 ${closed} 个标签页`, 'success');
      } else if (oneTabMode && created) {
        toast(`已新建「${targetGroup.name}」并收进 ${targets.length} 个标签页`, 'success');
      } else if (oneTabMode && revived) {
        toast(`已重新启用「${targetGroup.name}」并收进 ${targets.length} 个标签页`, 'success');
      } else if (oneTabMode) {
        toast(`已追加 ${targets.length} 个标签页到「${targetGroup.name}」`, 'success');
      } else {
        toast(`已将 ${targets.length} 个标签页收进「${targetGroup.name}」`, 'success');
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
    const b = wdSettings.behavior || {};
    const a = wdSettings.ai || {};
    $('wd-url').value = w.url || '';
    $('wd-username').value = w.username || '';
    $('wd-password').value = w.password || '';
    $('wd-remote-dir').value = w.remoteDir || '/open-collections';
    $('wd-autosync').checked = !!w.autoSync;
    $('wd-interval').value = Number(w.intervalMinutes) || 30;
    $('behavior-batch-daily').checked = !!b.batchCollectDaily;
    $('behavior-ai-inbox').checked = !!b.aiIncludeInbox;
    updateAiInboxOptionVisibility();
    $('ai-base-url').value = a.baseUrl || '';
    $('ai-api-key').value = a.apiKey || '';
    $('ai-model').value = a.model || '';
    $('ai-categories').value = (a.categories && a.categories.length
      ? a.categories
      : AI.DEFAULT_CATEGORIES).join('\n');
    state.aiConfig = wdSettings.ai;
    state.batchCollectDaily = !!b.batchCollectDaily;
    state.aiIncludeInbox = !!b.aiIncludeInbox;
    refreshAiCacheInfo().catch(() => {});
  }

  // AI 与收藏行为各自有独立保存按钮，这里只读 WebDAV，避免误覆盖其他配置段。
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

  function setStatus(id, msg, type) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'wd-status' + (type ? ' ' + type : '');
  }

  function setWDStatus(msg, type) {
    setStatus('wd-status', msg, type);
  }

  function setBehaviorStatus(msg, type) {
    setStatus('behavior-status', msg, type);
  }

  function setAiStatus(msg, type) {
    setStatus('ai-status', msg, type);
  }

  // 在用户点击的同一个调用栈里申请该站点的网络权限（optional_host_permissions）。
  function requestOriginPermission(url) {
    return new Promise((resolve) => {
      if (!chrome.permissions || !chrome.permissions.request) return resolve(true);
      let origin;
      try {
        const u = new URL(url);
        // match pattern 不支持端口，使用 hostname 以兼容 localhost / 非标准端口。
        origin = `${u.protocol}//${u.hostname}/*`;
      } catch (e) {
        return resolve(false);
      }
      chrome.permissions.request({ origins: [origin] }, (granted) => resolve(!!granted));
    });
  }

  async function persistSettings(s, opts) {
    opts = opts || {};
    wdSettings = await Storage.updateSettings(s);
    state.aiConfig = wdSettings.ai;
    state.batchCollectDaily = !!(wdSettings.behavior && wdSettings.behavior.batchCollectDaily);
    state.aiIncludeInbox = !!(wdSettings.behavior && wdSettings.behavior.aiIncludeInbox);
    if (opts.reschedule !== false) await sendMessage({ type: 'webdav-reschedule' });
  }

  async function saveSettings() {
    try {
      await persistSettings(readSettingsFromForm());
      setWDStatus('设置已保存' + (wdSettings.webdav.autoSync ? '，自动同步已启用' : ''), 'success');
    } catch (e) {
      setWDStatus('保存失败：' + (e.message || e), 'error');
    }
  }

  function updateAiInboxOptionVisibility() {
    const block = $('behavior-ai-inbox-block');
    const cb = $('behavior-ai-inbox');
    if (!block || !cb) return;
    const enabled = !!$('behavior-batch-daily').checked;
    block.classList.toggle('hidden', !enabled);
    cb.disabled = !enabled;
  }

  async function saveBehaviorSettings() {
    try {
      await persistSettings({
        behavior: {
          batchCollectDaily: $('behavior-batch-daily').checked,
          aiIncludeInbox: $('behavior-ai-inbox').checked
        }
      }, { reschedule: false });
      setBehaviorStatus('设置已保存', 'success');
    } catch (e) {
      setBehaviorStatus('保存失败：' + (e.message || e), 'error');
    }
  }

  function readAiForm() {
    let categories = Utils.normalizeCategories($('ai-categories').value.split(/[\n,，、]/));
    if (!categories.length) categories = AI.DEFAULT_CATEGORIES.slice();
    return {
      baseUrl: $('ai-base-url').value.trim(),
      apiKey: $('ai-api-key').value.trim(),
      model: $('ai-model').value.trim(),
      categories
    };
  }

  async function refreshAiCacheInfo() {
    const cache = await Storage.loadAiCache();
    const count = Object.keys(cache).length;
    const info = $('ai-cache-info');
    const btn = $('btn-ai-cache-clear');
    if (info) {
      info.textContent = count
        ? `本地缓存：${count} 条分类记录，命中时不会重复调用 AI。`
        : '本地缓存为空。';
    }
    if (btn) btn.disabled = count === 0;
  }

  async function clearAiCache() {
    if (!confirm('清空 AI 分类缓存？下次整理会重新调用 AI。')) return;
    try {
      await Storage.clearAiCache();
      await refreshAiCacheInfo();
      setAiStatus('分类缓存已清空', 'success');
    } catch (e) {
      setAiStatus('清空缓存失败：' + (e.message || e), 'error');
    }
  }

  async function saveAiSettings() {
    const cfg = readAiForm();
    if (cfg.baseUrl) {
      try {
        AI.normalizeEndpoint(cfg.baseUrl);
      } catch (e) {
        setAiStatus(e.message, 'error');
        return;
      }
    }
    try {
      await persistSettings({ ai: cfg }, { reschedule: false });
      $('ai-categories').value = wdSettings.ai.categories.join('\n');
      setAiStatus('设置已保存', 'success');
    } catch (e) {
      setAiStatus('保存失败：' + (e.message || e), 'error');
    }
  }

  async function testAiConnection() {
    const cfg = readAiForm();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      setAiStatus('请先填写接口地址、API Key 与模型名称', 'error');
      return;
    }
    const granted = await requestOriginPermission(cfg.baseUrl);
    if (!granted) {
      setAiStatus('未获得访问该接口的网络权限，请重试并在弹窗中选择允许', 'error');
      return;
    }
    setAiStatus('正在测试连接…', '');
    let res;
    try {
      res = await AI.testConnection(cfg);
    } catch (e) {
      setAiStatus('连接失败：' + (e.message || e), 'error');
      return;
    }
    try {
      await persistSettings({ ai: cfg }, { reschedule: false });
      $('ai-categories').value = wdSettings.ai.categories.join('\n');
      setAiStatus('连接成功 ✓ 设置已保存' + (res.reply ? `（${Utils.truncate(res.reply, 20)}）` : ''), 'success');
    } catch (e) {
      setAiStatus('连接成功，但保存设置失败：' + (e.message || e), 'error');
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

  // ---- AI 整理 ----
  function openSettingsForAi() {
    openDrawer('settings');
    setTimeout(() => {
      const section = $('ai-settings-section');
      if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
    }, 50);
  }

  function openAiDrawer() {
    els.aiDrawer.classList.remove('hidden');
  }

  function closeAiDrawer() {
    state.aiRunId++;
    if (state.aiAbort) {
      state.aiAbort.abort();
      state.aiAbort = null;
    }
    els.aiDrawer.classList.add('hidden');
    state.aiPlan = null;
    state.aiGroupIds = [];
    state.aiInboxSkipped = 0;
    state.aiBackupKey = null;
    updateAiInboxSkipHint();
    $('btn-ai-organize').disabled = false;
  }

  function updateAiInboxSkipHint() {
    const el = $('ai-inbox-skip');
    if (!el) return;
    const count = state.aiInboxSkipped;
    el.classList.toggle('hidden', count <= 0);
    el.textContent = count > 0
      ? `收件箱 ${count} 条未参与本次整理（可在设置中开启「AI 整理时包含每日收件箱的条目」）`
      : '';
  }

  function renderAiState(name) {
    ['ai-loading', 'ai-empty', 'ai-error', 'ai-proposal', 'ai-applied'].forEach((id) => {
      $(id).classList.toggle('hidden', id !== 'ai-' + name);
    });
    updateAiInboxSkipHint();
  }

  // 计算本次 AI 整理的候选范围：当前分组 + 可选的每日收件箱。
  function collectAiCandidates(current) {
    const includeInbox = !!state.batchCollectDaily && !!state.aiIncludeInbox;
    const currentIsInbox = Storage.isDailyGroup(current);
    // 在收件箱视图内主动点击「AI 整理」属于显式意图，即使总开关关闭也执行一次。
    const explicitInbox = currentIsInbox && !includeInbox;
    const inboxGroups = state.data.groups.filter((g) => !g.deleted && Storage.isDailyGroup(g));
    const groupIds = [current.id];
    const skippedGroups = [];
    for (const g of inboxGroups) {
      if (g.id === current.id) continue;
      if (includeInbox || currentIsInbox) groupIds.push(g.id);
      else skippedGroups.push(g);
    }
    const cards = [];
    const cardGroupNames = {};
    for (const id of groupIds) {
      const g = state.data.groups.find((x) => x.id === id && !x.deleted);
      if (!g) continue;
      for (const c of g.cards) {
        if (c.deleted) continue;
        cards.push(c);
        cardGroupNames[c.id] = g.name;
      }
    }
    const skippedCount = skippedGroups.reduce(
      (n, g) => n + g.cards.filter((c) => !c.deleted).length, 0);
    return { groupIds, cards, cardGroupNames, skippedCount, explicitInbox };
  }

  function renderAiPlan(plan) {
    const cardMap = new Map();
    state.aiGroupIds.forEach((id) => {
      const g = state.data.groups.find((x) => x.id === id && !x.deleted);
      if (!g) return;
      g.cards.forEach((c) => {
        if (!c.deleted) cardMap.set(c.id, c);
      });
    });
    const list = $('ai-plan-list');
    list.innerHTML = '';
    $('ai-summary').textContent = plan.summary || `AI 建议拆分为 ${plan.groups.length} 个分组。`;

    plan.groups.forEach((g, index) => {
      const item = document.createElement('div');
      item.className = 'ai-plan-item';

      const head = document.createElement('label');
      head.className = 'ai-plan-head';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.aiIndex = String(index);
      const dot = document.createElement('span');
      dot.className = 'ai-plan-dot';
      dot.style.background = g.color;
      const name = document.createElement('span');
      name.className = 'ai-plan-name';
      name.textContent = g.name;
      const count = document.createElement('span');
      count.className = 'ai-plan-count';
      count.textContent = `${g.cardIds.length} 条`;
      head.appendChild(checkbox);
      head.appendChild(dot);
      head.appendChild(name);
      head.appendChild(count);
      item.appendChild(head);

      if (g.reuseGroupName) {
        const reuse = document.createElement('div');
        reuse.className = 'ai-plan-reason';
        reuse.textContent = '将并入已有分组「' + g.reuseGroupName + '」';
        item.appendChild(reuse);
      }

      if (g.reason) {
        const reason = document.createElement('div');
        reason.className = 'ai-plan-reason';
        reason.textContent = g.reason;
        item.appendChild(reason);
      }

      const cards = g.cardIds.map((id) => cardMap.get(id)).filter(Boolean);
      const cardList = document.createElement('ul');
      cardList.className = 'ai-plan-cards';
      cards.slice(0, 6).forEach((c) => {
        const li = document.createElement('li');
        li.textContent = c.title;
        cardList.appendChild(li);
      });
      if (cards.length > 6) {
        const li = document.createElement('li');
        li.textContent = `…等 ${cards.length} 条`;
        cardList.appendChild(li);
      }
      item.appendChild(cardList);
      list.appendChild(item);
    });

    $('ai-unassigned').textContent = plan.unassignedCount > 0
      ? `${plan.unassignedCount} 条内容将保留在原分组。`
      : '所有内容都已归类。';
    const stats = $('ai-cache-stats');
    if (stats) {
      const dedupe = plan.dedupedCount ? ` / 去重 ${plan.dedupedCount} 条` : '';
      stats.textContent = plan.apiCalled === false
        ? `本次未调用 AI / 复用缓存 ${plan.cacheHits || 0} 条`
        : `本次新增请求 ${plan.requestedCount || 0} 条 / 复用缓存 ${plan.cacheHits || 0} 条${dedupe}`;
    }
    renderAiState('proposal');
  }

  async function startAiOrganize() {
    const cfg = state.aiConfig;
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      toast('请先在设置中配置 AI 接口', 'error');
      openSettingsForAi();
      return;
    }
    const group = getActiveGroup();
    if (!group) {
      toast('请先选择一个分组', 'error');
      return;
    }
    const candidate = collectAiCandidates(group);
    const cards = candidate.cards;
    if (cards.length < 2) {
      const extra = candidate.skippedCount
        ? `；收件箱 ${candidate.skippedCount} 条未参与本次整理`
        : '';
      toast(`当前可整理内容至少需要 2 条${extra}`, 'error');
      return;
    }
    if (cards.length > AI.MAX_CARDS) {
      toast(`本次范围有 ${cards.length} 条内容，一次最多整理 ${AI.MAX_CARDS} 条，请先缩小候选范围`, 'error');
      return;
    }
    if (state.aiAbort) return;

    const btn = $('btn-ai-organize');
    btn.disabled = true;
    let runId = state.aiRunId;
    try {
      const granted = await requestOriginPermission(cfg.baseUrl);
      if (!granted) {
        toast('未获得访问该 AI 接口的网络权限', 'error');
        return;
      }

      runId = ++state.aiRunId;
      const controller = new AbortController();
      state.aiAbort = controller;
      state.aiGroupIds = candidate.groupIds.slice();
      state.aiInboxSkipped = candidate.skippedCount;
      state.aiBackupKey = null;
      if (candidate.explicitInbox) {
        toast('当前为收件箱视图，已按你的操作整理收件箱条目', 'info');
      }
      const scopeLabel = candidate.groupIds.length > 1
        ? `「${group.name}」与每日收件箱`
        : `「${group.name}」`;
      $('ai-loading-text').textContent = `正在分析${scopeLabel}中的 ${cards.length} 条内容…`;
      openAiDrawer();
      renderAiState('loading');

      const categoryList = cfg.categories && cfg.categories.length
        ? Utils.normalizeCategories(cfg.categories)
        : AI.DEFAULT_CATEGORIES.slice();
      const existingNames = state.data.groups
        .filter((g) => !g.deleted)
        .map((g) => g.name);
      const cache = await Storage.loadAiCache();
      if (runId !== state.aiRunId) return;
      const plan = await AI.organizeGroup({
        cfg,
        groupName: group.name,
        existingNames,
        categories: categoryList,
        cache,
        cards,
        cardGroupNames: candidate.cardGroupNames,
        signal: controller.signal
      });
      if (runId !== state.aiRunId) return;
      if (!plan.groups.length) {
        $('ai-empty-text').textContent = plan.summary || 'AI 没有找到合适的分类，当前分组保持不变。';
        renderAiState('empty');
        return;
      }

      const aliveCount = state.data.groups.filter((g) => !g.deleted).length;
      plan.groups.forEach((g, index) => {
        const existing = state.data.groups.find((x) =>
          !x.deleted && !state.aiGroupIds.includes(x.id) &&
          Utils.normalizeName(x.name) === Utils.normalizeName(g.name));
        if (existing) {
          g.color = existing.color;
          g.reuseGroupName = existing.name;
        } else {
          g.color = Utils.PALETTE[(aliveCount + index) % Utils.PALETTE.length];
        }
      });
      state.aiPlan = plan;
      renderAiPlan(plan);
      if (plan.cacheEntries && plan.cacheEntries.length) {
        Storage.saveAiCacheEntries(plan.cacheEntries)
          .then(() => refreshAiCacheInfo())
          .catch((e) => console.warn('[OpenCollections] save AI cache failed:', e));
      }
    } catch (e) {
      if (runId !== state.aiRunId) return;
      if (e.code === 'cancelled') {
        $('ai-empty-text').textContent = '已取消本次整理。';
        renderAiState('empty');
        return;
      }
      $('ai-error-msg').textContent = e.message || '整理失败';
      renderAiState('error');
    } finally {
      if (runId === state.aiRunId) {
        state.aiAbort = null;
        btn.disabled = false;
      }
    }
  }

  async function applyAiPlan() {
    if (!state.aiPlan || !state.aiGroupIds.length) return;
    const checks = Array.from($('ai-plan-list').querySelectorAll('input[data-ai-index]'));
    const selected = checks
      .filter((n) => n.checked)
      .map((n) => Number(n.dataset.aiIndex));
    if (!selected.length) {
      toast('请至少选择一个分组', 'error');
      return;
    }

    const groups = selected
      .map((i) => state.aiPlan.groups[i])
      .filter(Boolean)
      .map((g) => ({ name: g.name, color: g.color, cardIds: g.cardIds }));
    const sourceGroupIds = state.aiGroupIds.slice();
    $('btn-ai-apply').disabled = true;
    $('btn-ai-cancel').disabled = true;
    try {
      const backupKey = await Storage.createBackup('ai-organize');
      const res = await Storage.applyOrganizePlan({ sourceGroupIds, groups });
      state.aiBackupKey = backupKey;
      await loadAndRender();
      $('ai-applied-text').textContent = res.movedCards
        ? `已新建 ${res.createdGroups.length} 个、并入 ${res.reusedGroups.length} 个已有分组，移动 ${res.movedCards} 条内容。`
        : '没有可移动的内容，数据可能已变化。';
      renderAiState('applied');
    } catch (e) {
      toast('应用失败：' + (e.message || e), 'error');
    } finally {
      $('btn-ai-apply').disabled = false;
      $('btn-ai-cancel').disabled = false;
    }
  }

  async function undoAiPlan() {
    if (!state.aiBackupKey) return;
    if (!confirm('撤销本次 AI 整理？将恢复到整理前的数据。')) return;
    try {
      await Storage.restoreBackup(state.aiBackupKey);
      await loadAndRender();
      closeAiDrawer();
      toast('已撤销本次整理', 'success');
    } catch (e) {
      toast('撤销失败：' + (e.message || e), 'error');
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
    $('btn-ai-organize').addEventListener('click', startAiOrganize);
    $('btn-open-all').addEventListener('click', openAllInGroup);
    els.groupNameInput.addEventListener('change', renameGroupFromInput);
    els.groupNameInput.addEventListener('blur', renameGroupFromInput);

    // 左侧分组列表与当前分组标题作为跨组拖拽落点。
    bindGroupDropTargets();

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

    // 收藏行为
    $('btn-behavior-save').addEventListener('click', saveBehaviorSettings);
    $('behavior-batch-daily').addEventListener('change', updateAiInboxOptionVisibility);

    // AI 自动整理
    $('btn-ai-save').addEventListener('click', saveAiSettings);
    $('btn-ai-test').addEventListener('click', testAiConnection);
    $('btn-ai-cache-clear').addEventListener('click', clearAiCache);
    $('btn-ai-abort').addEventListener('click', closeAiDrawer);
    $('btn-ai-empty-close').addEventListener('click', closeAiDrawer);
    $('btn-ai-error-close').addEventListener('click', closeAiDrawer);
    $('btn-ai-retry').addEventListener('click', startAiOrganize);
    $('btn-ai-apply').addEventListener('click', applyAiPlan);
    $('btn-ai-cancel').addEventListener('click', closeAiDrawer);
    $('btn-ai-undo').addEventListener('click', undoAiPlan);
    $('btn-ai-done').addEventListener('click', closeAiDrawer);

    // WebDAV
    $('btn-wd-save').addEventListener('click', saveSettings);
    $('btn-wd-test').addEventListener('click', testConnection);
    $('btn-wd-sync').addEventListener('click', () => runSync('sync'));
    $('btn-wd-upload').addEventListener('click', () => runSync('upload'));
    $('btn-wd-download').addEventListener('click', () => runSync('download'));

    // 抽屉关闭
    document.querySelectorAll('[data-close]').forEach((el) => {
      const name = el.dataset.close;
      el.addEventListener('click', () => {
        if (name === 'ai') closeAiDrawer();
        else closeDrawer(name);
      });
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
        closeAiDrawer();
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
      if (area === 'local' && changes[Storage.SETTINGS_KEY]) {
        Storage.loadSettings()
          .then((s) => {
            state.aiConfig = s.ai;
            state.batchCollectDaily = !!(s.behavior && s.behavior.batchCollectDaily);
            state.aiIncludeInbox = !!(s.behavior && s.behavior.aiIncludeInbox);
            refreshCollectMenuCopy();
          })
          .catch(() => {});
      }
      if (area === 'local' && (changes[Storage.STORAGE_KEY] || changes[Storage.SETTINGS_KEY])) {
        loadAndRender();
      }
    });
  }

  // ---- 启动 ----
  function init() {
    cacheEls();
    // 关于页版本号取自 manifest，避免发版时多处手改漏更新。
    const about = $('about-version');
    if (about && chrome.runtime && chrome.runtime.getManifest) {
      about.textContent = 'Open Collections v' + chrome.runtime.getManifest().version +
        ' · 本地集锦管理。数据存放于浏览器 chrome.storage.local。';
    }
    setGroupsFolded(NARROW_QUERY.matches);
    bindEvents();
    Storage.loadSettings()
      .then((s) => {
        state.aiConfig = s.ai;
        state.batchCollectDaily = !!(s.behavior && s.behavior.batchCollectDaily);
        state.aiIncludeInbox = !!(s.behavior && s.behavior.aiIncludeInbox);
        refreshCollectMenuCopy();
      })
      .catch((e) => console.warn('[OpenCollections] load settings failed:', e));
    loadAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
