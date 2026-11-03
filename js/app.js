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
    aiPinnedSkipped: 0,
    batchCollectDaily: false,
    aiIncludeInbox: false,
    allowDuplicateLinks: false,
    dedupeGroups: [],
    dedupeSelected: new Set(),
    dedupeExpanded: new Set(),
    dedupeKeep: 'oldest',
    dedupeBackupKey: null,
    dedupeRemoved: [],
    security: null,
    aiHasKey: false,
    webdavHasCredentials: false,
    legacyPlaintextSecrets: false,
    aiEnabled: false,
    webdavEnabled: false,
    pendingConsent: null,
    dragCard: null,
    cardDropId: null,
    groupDropId: null
  };

  // ---- 命令文案唯一来源（COMMAND_META）----
  // manifest commands 的 id、可读显示名与说明都在这里维护；设置页快捷键区与空状态
  // 提示共用这一份，避免各处手写。键位本身绝不写死，运行时从 chrome.commands.getAll()
  // 读取（见 refreshCommandBindings）；读不到时统一提示「可在设置中查看快捷键」。
  // 注意：_execute_action 的 id 是 Chromium 内置保留 id，不能改成自定义 id 冒充。
  const COMMAND_META = {
    '_execute_action': {
      name: '点击工具栏图标',
      desc: '打开 Open Collections（等同点击工具栏图标）',
      builtin: true
    },
    'add-current-page': {
      name: '保存当前页面',
      desc: '把当前页面加入当前分组'
    },
    'save-selection': {
      name: '保存摘录',
      desc: '把选中的文字存为摘录卡片'
    },
    'open-management-window': {
      name: '打开独立管理窗口',
      desc: '在新窗口打开管理界面'
    }
  };

  // 当前键位绑定（id → shortcut）；focus/可见性恢复时刷新，不使用过期缓存渲染。
  let commandBindings = {};
  let commandBindingsReady = false;

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
    els.dedupeDrawer = $('dedupe-drawer');
    els.onboardingBanner = $('onboarding-banner');
    els.btnOnboardingClose = $('btn-onboarding-close');
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
  // 按运行场景分离默认值：独立窗口（standalone=1）默认展开并记忆用户偏好；侧边栏每次
  // 冷启动都确定性折叠，不读回也不写入展开态（避免上次会话手动展开导致下次冷启动又展开）。
  // 场景由打开时的 URL 参数判定（可靠，不受用户手动拉宽侧边栏影响）。HTML 首帧即带
  // groups-collapsed，侧边栏不依赖异步读回，也不会因宽度不可测而误判。收起只是折叠：
  // 分组面板保留在 DOM，顶栏「分组」入口始终可见可点，随时一键展开；绝不出现不可恢复的整块消失。
  let uiScene = 'sidepanel';
  // 用户手动切换过折叠态：晚到的偏好读回不得覆盖用户当前选择。
  let foldUserTouched = false;
  // ≤520px 视口时展开的分组栏是浮层，选中分组后自动收起浮层（不持久化，不算用户偏好）。
  const NARROW_QUERY = window.matchMedia('(max-width: 520px)');

  function setGroupsFolded(folded, persist) {
    if (persist === undefined) persist = true;
    els.app.classList.toggle('groups-collapsed', folded);
    if (folded) els.colorPicker.classList.add('hidden');
    const label = folded ? '展开分组栏' : '折叠分组栏';
    els.btnToggleGroups.setAttribute('aria-expanded', String(!folded));
    els.btnToggleGroups.setAttribute('aria-label', label);
    els.btnToggleGroups.title = label;
    if (persist) {
      foldUserTouched = true;
      // 只记忆独立窗口的偏好；侧边栏不持久化展开态，保证每次冷启动都折叠。
      if (uiScene === 'standalone') {
        Storage.saveFoldState({ [uiScene]: folded }).catch(() => {});
      }
    }
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
      // 仅窄屏浮层模式下，选中分组后收起浮层（浮层会遮挡内容）；非持久化、非浮层布局保持展开。
      if (NARROW_QUERY.matches) setGroupsFolded(true, false);
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
    els.groupMeta.textContent = g.system
      ? `${alive} 个内容 · 受保护分组`
      : Storage.isDailyGroup(g)
        ? `${alive} 个内容 · 每日收件箱（临时待整理） · 创建于 ${Utils.formatTime(g.createdAt)}`
        : `${alive} 个内容 · 主题集锦 · 创建于 ${Utils.formatTime(g.createdAt)}`;
    // 默认集锦（system）不可删除：隐藏删除按钮。
    const delGroupBtn = $('btn-delete-group');
    if (delGroupBtn) delGroupBtn.classList.toggle('hidden', !!g.system);
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
        // 快捷键实时读取当前绑定；未设置时不显示假键位，读不到时引导到设置页。
        els.emptyDesc.textContent = buildEmptyShortcutHint();
      }
      els.emptyAction.classList.add('hidden');
    }
  }

  // 空状态快捷键提示：键位来自 chrome.commands.getAll()，不写死、不猜测。
  function buildEmptyShortcutHint() {
    if (!commandBindingsReady) {
      return '点击顶部「添加当前页面」把网页收藏进来；选中文字后可保存摘录。快捷键可在设置中查看。';
    }
    return '点击顶部「添加当前页面」，或使用快捷键' + shortcutHint('add-current-page') +
      '；选中文字后按保存摘录快捷键' + shortcutHint('save-selection') + '可存为摘录。';
  }

  function shortcutHint(id) {
    const shortcut = commandBindings[id];
    return '（当前为 ' + (shortcut || '未设置') + '）';
  }

  // 把当前绑定应用到空状态与按钮 tooltip；设置页列表由 refreshShortcuts 单独渲染。
  function applyCommandShortcutsToUi() {
    if (state.data) updateEmptyState(state.search.trim().toLowerCase());
    const addBtn = $('btn-add-page');
    if (addBtn) {
      const base = '将当前页面加入当前分组';
      addBtn.title = commandBindingsReady
        ? base + '（当前为 ' + (commandBindings['add-current-page'] || '未设置') + '）'
        : base;
    }
    const selBtn = $('btn-save-sel');
    if (selBtn) {
      const base = '保存选中文字为摘录';
      selBtn.title = commandBindingsReady
        ? base + '（当前为 ' + (commandBindings['save-selection'] || '未设置') + '）'
        : base;
    }
  }

  function refreshCommandBindings() {
    return new Promise((resolve) => {
      if (!chrome.commands || typeof chrome.commands.getAll !== 'function') {
        commandBindings = {};
        commandBindingsReady = false;
        applyCommandShortcutsToUi();
        resolve();
        return;
      }
      chrome.commands.getAll((commands) => {
        if (chrome.runtime.lastError) {
          commandBindings = {};
          commandBindingsReady = false;
        } else {
          commandBindings = {};
          (commands || []).forEach((c) => { commandBindings[c.name] = c.shortcut || ''; });
          commandBindingsReady = true;
        }
        applyCommandShortcutsToUi();
        resolve();
      });
    });
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
      // 默认集锦（system）内固定条目置顶，并渲染「已固定」分隔区。
      const alive = g.cards.filter((c) => !c.deleted);
      if (g.system && alive.some((c) => c.pinned)) {
        alive.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      }
      items = alive.map((c) => ({ card: c, group: g }));
      els.searchCount.textContent = '';
    }

    const isEmpty = items.length === 0;
    els.empty.classList.toggle('hidden', !isEmpty);
    els.cardList.style.display = isEmpty ? 'none' : '';
    if (isEmpty) updateEmptyState(q);

    let dividerInserted = false;
    for (const it of items) {
      const isPinned = !q && it.group.system && !!it.card.pinned;
      // 固定区开头插入一次分隔标题。
      if (isPinned && !dividerInserted) {
        els.cardList.appendChild(makePinnedDivider());
        dividerInserted = true;
      }
      els.cardList.appendChild(renderCard(it.card, it.group, !!q, isPinned));
    }
  }

  // 固定区分隔标题。
  function makePinnedDivider() {
    const li = document.createElement('li');
    li.className = 'pinned-divider';
    li.textContent = '已固定（AI 整理与清理不会移动这些条目）';
    return li;
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
        if (hasInternalDrag()) {
          if (e.target.closest('.card')) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
          setCardListInvalid();
          return;
        }
        // 外部拖放：默认集锦接受网页链接拖入（拖到固定区视为固定）。
        if (acceptExternalDrop()) {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          els.cardList.classList.add('drop-target');
        }
      });

      els.cardList.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && els.cardList.contains(e.relatedTarget)) return;
        els.cardList.classList.remove('drag-invalid', 'drop-target');
      });

      els.cardList.addEventListener('drop', (e) => {
        if (hasInternalDrag()) {
          if (e.target.closest('.card')) return;
          e.preventDefault();
          e.stopPropagation();
          clearDragState();
          toast('请把卡片放到具体分组或另一张卡片上', 'error');
          return;
        }
        els.cardList.classList.remove('drop-target');
        if (!acceptExternalDrop()) return;
        e.preventDefault();
        e.stopPropagation();
        const pinnedTarget = !!(e.target.closest && e.target.closest('.pinned-divider')) ||
          !!(e.target.closest && e.target.closest('.card.pinned'));
        handleExternalUrlDrop(e.dataTransfer, pinnedTarget);
      });
    }
  }

  // 外部拖放仅在默认集锦（system 分组）视图生效。
  function acceptExternalDrop() {
    const g = getActiveGroup();
    return !!(g && g.system) && !state.search.trim();
  }

  // 解析外部拖入的 URL（text/uri-list / text/plain，支持多行多个链接）并按保存流程创建卡片。
  async function handleExternalUrlDrop(dataTransfer, pinned) {
    let text = '';
    try {
      text = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain') || '';
    } catch (e) {
      toast('无法读取拖入内容', 'error');
      return;
    }
    const urls = String(text).split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        try {
          const u = new URL(line);
          return /^https?:$/.test(u.protocol) ? u.href : '';
        } catch (e) {
          // text/plain 里可能混有文字，只提取 http(s) 链接。
          const m = /https?:\/\/[^\s，,）)]+/i.exec(line);
          if (!m) return '';
          try {
            const u = new URL(m[0]);
            return /^https?:$/.test(u.protocol) ? u.href : '';
          } catch (e2) { return ''; }
        }
      })
      .filter(Boolean);
    if (!urls.length) {
      toast(Utils.URL_NOT_COLLECTABLE_MESSAGE, 'error');
      return;
    }
    const g = getActiveGroup();
    if (!g) return;
    const settings = await Storage.loadSettings();
    const allowDup = !!(settings.behavior && settings.behavior.allowDuplicateLinks);
    const data = await Storage.load();
    const inputs = [];
    const seenKeys = new Set();
    let skippedDup = 0;
    for (const url of urls) {
      let title;
      try { title = new URL(url).hostname; } catch (e) { title = url; }
      const input = { type: 'page', title, url, favicon: faviconUrl(url) };
      if (!allowDup) {
        // 先与本次拖入的已收集链接比较，避免同一批里的重复链接全部写入。
        const key = Utils.cardDedupeKey(input);
        if (seenKeys.has(key)) { skippedDup++; continue; }
        const dup = Storage.findDuplicateCard(data, input);
        if (dup) { skippedDup++; continue; }
        seenKeys.add(key);
      }
      inputs.push(input);
    }
    if (!inputs.length) {
      toast(`拖入的 ${skippedDup} 个链接都已存在（去重开启），未添加。可在设置中允许重复后重试`, 'error');
      return;
    }
    const full = inputs.map((i) => Object.assign(i, { pinned: !!pinned }));
    try {
      await Storage.addCards(g.id, full);
    } catch (e) {
      toast(e.message || Utils.URL_NOT_COLLECTABLE_MESSAGE, 'error');
      return;
    }
    toast(`已收进「${g.name}」${urls.length - skippedDup} 个链接${pinned ? '（已固定）' : ''}${skippedDup ? `，跳过 ${skippedDup} 个重复` : ''}`, 'success');
    await loadAndRender();
  }

  // favicon URL 构造（与 background 一致）。
  function faviconUrl(url) {
    try {
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
    } catch (e) {
      return '';
    }
  }

  function renderCard(c, group, searching, isPinned) {
    const li = document.createElement('li');
    li.className = 'card' + (isPinned ? ' pinned' : '');
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

    // 图钉：仅默认集锦（system 分组）内显示；固定条目对 AI 整理与清理免疫。
    // 与编辑/删除共用 .card-action 统一样式，已固定仅改变图标颜色。
    if (group.system && !searching) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'card-action card-pin' + (c.pinned ? ' active' : '');
      pinBtn.title = c.pinned ? '取消固定（恢复参与 AI 整理与清理）' : '固定（AI 整理与清理不会移动它）';
      pinBtn.setAttribute('aria-label', pinBtn.title);
      pinBtn.appendChild(iconSvg('pin'));
      pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await Storage.setCardPinned(group.id, c.id, !c.pinned);
          toast(c.pinned ? '已取消固定' : '已固定：AI 整理与清理不会移动这条', 'success');
          await loadAndRender();
        } catch (err) {
          toast('操作失败：' + (err.message || err), 'error');
        }
      });
      li.appendChild(pinBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'card-action card-edit';
    editBtn.title = '编辑标题 / 备注';
    editBtn.appendChild(iconSvg('pencil'));
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardEditor(group.id, c.id);
    });
    li.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'card-action card-delete';
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
        e.target.closest('.card-delete') || e.target.closest('.card-pin')) return;
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
      if (e.code === 'URL_NOT_COLLECTABLE') toast(e.message || Utils.URL_NOT_COLLECTABLE_MESSAGE, 'error');
      else toast('保存失败：' + (e.message || e), 'error');
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
          err.duplicate = resp.duplicate;
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
      if (e.code === 'duplicate' && e.duplicate) {
        const name = e.duplicate.groupName || '其他分组';
        toast(`已在「${name}」分组中，已跳过`, 'info');
        return;
      }
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
    // 固定标签不参与；可收藏性统一使用 Utils.isCollectableUrl（仅 http/https）。
    return !!tab && !tab.pinned && Utils.isCollectableUrl(tab.url);
  }

  async function getCollectWindow() {
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
      // 只接受普通浏览器窗口；独立管理窗口（popup）里点击时不能用扩展窗口的标签。
      if (win && Array.isArray(win.tabs) && win.type === 'normal') return win;
    } catch (e) {
      console.warn('[OpenCollections] getLastFocused failed:', e);
    }
    // 回退 1：用 background 记录的「最近活跃网页标签」所在窗口（与添加当前页/摘录同一套逻辑）。
    try {
      const res = await sendMessage({ type: 'get-recent-web-window' });
      if (res && res.ok && typeof res.windowId === 'number') {
        const tabs = await chrome.tabs.query({ windowId: res.windowId });
        if (tabs.length) return { id: res.windowId, tabs, type: 'normal' };
      }
    } catch (e) {}
    // 回退 2：以最后聚焦的活动标签所在窗口为准。
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return null;
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    return { id: tab.windowId, tabs, type: 'normal' };
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
      await collectTabsFromWindow(win, closeAfter);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // 批量收藏核心：对指定窗口做静默去重 → 写入 → （可选）关闭本批标签。
  // 写入失败时不会关闭任何标签。
  async function collectTabsFromWindow(win, closeAfter) {
    const settings = await Storage.loadSettings();
    const oneTabMode = !!(settings.behavior && settings.behavior.batchCollectDaily);
    const allowDuplicates = !!(settings.behavior && settings.behavior.allowDuplicateLinks);
    const activeGroup = getActiveGroup();
    if (!oneTabMode && !activeGroup) throw new Error('请先创建一个分组');

    const targets = (win.tabs || []).filter(isCollectibleTab);
    // 受限页只跳过、不参与写入；数量用于汇总提示，避免整批失败或静默丢失。
    const unsupportedCount = (win.tabs || [])
      .filter((tab) => tab && !tab.pinned && !Utils.isCollectableUrl(tab.url)).length;
    if (!targets.length) {
      // 全是不可收藏页面时与其它入口同一句提示；固定标签等纯空窗口保留原说明。
      throw new Error(unsupportedCount
        ? Utils.URL_NOT_COLLECTABLE_MESSAGE
        : '该窗口没有可收藏的网页标签页（固定标签与浏览器内部页不计入）');
    }

    let items = targets.map((tab) => ({
      tab,
      input: {
        type: 'page',
        title: tab.title || tab.url,
        url: tab.url,
        favicon: `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`
      }
    }));

    // 防重复开启时静默跳过重复，不弹确认框：已存在条目和本窗口先出现的相同链接都算重复。
    let skippedDuplicates = 0;
    if (!allowDuplicates) {
      const data = await Storage.load();
      const seenKeys = new Set();
      const duplicateIndexes = new Set();
      items.forEach((item, index) => {
        const key = Utils.cardDedupeKey(item.input);
        if (!key) return;
        if (Storage.findDuplicateCard(data, item.input) || seenKeys.has(key)) {
          duplicateIndexes.add(index);
        }
        seenKeys.add(key);
      });
      skippedDuplicates = duplicateIndexes.size;
      items = items.filter((item, index) => !duplicateIndexes.has(index));
    }

    const cardInputs = items.map((item) => item.input);
    let targetGroup = null;
    let created = false;
    let revived = false;
    if (cardInputs.length) {
      if (oneTabMode) {
        const res = await Storage.addCardsToDailyGroup(Utils.dateKey(Utils.now()), cardInputs);
        targetGroup = res.group;
        created = res.created;
        revived = res.revived;
      } else {
        await Storage.addCards(activeGroup.id, cardInputs);
        targetGroup = activeGroup;
      }
    }

    let closed = 0;
    if (closeAfter) {
      // 先开一个新标签页接管窗口（侧边栏跟随窗口而非标签），
      // 再关闭本批全部可收藏标签，包括被跳过的重复标签；受限页/固定标签保持打开。
      await chrome.tabs.create({ active: true, windowId: win.id });
      const ids = targets.map((tab) => tab.id);
      if (ids.length) {
        // 逐个关闭：若某个标签在收藏前已被关掉，批量 remove 会整体失败，
        // 导致已写入的收藏提示报错且界面不刷新；逐个关闭只统计真正关掉的标签。
        const results = await Promise.all(
          ids.map((id) => chrome.tabs.remove(id).then(() => true, () => false))
        );
        closed = results.filter(Boolean).length;
      }
    }

    const skipNote = skippedDuplicates ? `，跳过 ${skippedDuplicates} 条重复链接` : '';
    const unsupportedNote = unsupportedCount ? `，跳过 ${unsupportedCount} 个不受支持的页面` : '';
    const recoverNote = closed > 0 ? '；标签页已关闭，可用 Ctrl+Shift+T 恢复' : '';
    if (closeAfter && !items.length) {
      const closeNote = closed > 0 ? `，并关闭 ${closed} 个标签页` : '';
      toast(`已跳过 ${skippedDuplicates} 条重复链接${unsupportedNote}${closeNote}${recoverNote}`, 'info');
    } else if (closeAfter) {
      toast(`已收进「${targetGroup.name}」并关闭 ${closed} 个标签页${skipNote}${unsupportedNote}${recoverNote}`, 'success');
    } else if (!items.length) {
      toast(`已跳过 ${skippedDuplicates} 条重复链接${unsupportedNote}，未添加任何标签页`, 'info');
      return;
    } else if (oneTabMode && created) {
      toast(`已新建「${targetGroup.name}」并收进 ${items.length} 个标签页${skipNote}${unsupportedNote}`, 'success');
    } else if (oneTabMode && revived) {
      toast(`已重新启用「${targetGroup.name}」并收进 ${items.length} 个标签页${skipNote}${unsupportedNote}`, 'success');
    } else if (oneTabMode) {
      toast(`已追加 ${items.length} 个标签页到「${targetGroup.name}」${skipNote}${unsupportedNote}`, 'success');
    } else {
      toast(`已将 ${items.length} 个标签页收进「${targetGroup.name}」${skipNote}${unsupportedNote}`, 'success');
    }
    await loadAndRender();
  }

  // ---- 独立窗口：单一「收藏并关闭标签页」入口 ----
  // 目标是「最近活跃的普通浏览器窗口」；有多个普通窗口时先弹选择器，单窗口时给确认提示。
  async function standaloneCollectAndClose() {
    try {
      const res = await sendMessage({ type: 'get-recent-normal-window' });
      const recentId = res && res.ok ? res.windowId : null;
      const allWins = await chrome.windows.getAll({ populate: true });
      const normalWins = (allWins || []).filter((w) => w.type === 'normal' && Array.isArray(w.tabs));
      if (!normalWins.length) {
        toast('请先在浏览器中打开网页', 'error');
        return;
      }
      let target;
      if (normalWins.length > 1) {
        target = await pickWindow(normalWins, recentId);
        if (!target) return; // 用户取消
      } else {
        target = normalWins[0];
      }
      const collectible = (target.tabs || []).filter(isCollectibleTab);
      const skipped = (target.tabs || []).length - collectible.length;
      const skipNote = skipped > 0 ? `\n（另跳过 ${skipped} 个固定标签或浏览器内部页）` : '';
      if (!confirm(`将收藏 ${collectible.length} 个标签页并关闭${skipNote}\n窗口：${target.tabs.length} 个标签页。继续？`)) {
        return;
      }
      await collectTabsFromWindow(target, true);
    } catch (e) {
      toast(e.message || String(e), 'error');
    }
  }

  let windowPickerResolve = null;
  let windowPickerWins = [];

  function pickWindow(wins, preferId) {
    return new Promise((resolve) => {
      const list = $('window-picker-list');
      list.textContent = '';
      windowPickerWins = wins;
      wins.forEach((w, i) => {
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'pick-window';
        radio.value = String(w.id);
        // 默认选中最近活跃的窗口，其次第一个。
        if ((typeof preferId === 'number' && w.id === preferId) ||
          (typeof preferId !== 'number' && i === 0)) {
          radio.checked = true;
        }
        const title = (w.tabs.find((t) => t.active) || w.tabs[0] || {}).title || `窗口 ${w.id}`;
        const text = document.createElement('span');
        text.textContent = `${title}（${w.tabs.length} 个标签页）`;
        label.appendChild(radio);
        label.appendChild(text);
        list.appendChild(label);
      });
      windowPickerResolve = (win) => {
        windowPickerResolve = null;
        $('window-picker').classList.add('hidden');
        resolve(win);
      };
      $('window-picker').classList.remove('hidden');
    });
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
      toast('未获得页面访问权限。可在扩展详情中开启站点访问权限后重试', 'error');
      return;
    }
    try {
      const res = await sendMessage({ type: 'save-selection' });
      const result = (res && res.result) || {};
      toast(result.message || '摘录已保存', result.truncated ? 'info' : 'success');
      await loadAndRender();
    } catch (e) {
      if (e.code === 'duplicate' && e.duplicate) {
        const name = e.duplicate.groupName || '其他分组';
        toast(`该摘录已在「${name}」分组中，已跳过`, 'info');
        return;
      }
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

  // ---- 设置导出 / 导入 ----
  async function exportSettings() {
    try {
      const text = await Storage.exportSettingsJSON();
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `open-collections-settings-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
      downloadFile(text, name, 'application/json');
      toast('已导出设置（不含凭据与密钥）', 'success');
    } catch (e) {
      toast('导出失败：' + (e.message || e), 'error');
    }
  }

  let pendingSettingsImport = null;

  function closeSettingsImportDrawer() {
    const drawer = $('settings-import-drawer');
    if (drawer) drawer.classList.add('hidden');
    pendingSettingsImport = null;
  }

  function formatSettingValue(v) {
    if (v === undefined) return '（默认）';
    if (Array.isArray(v)) return v.length ? v.join('、') : '（空列表）';
    if (typeof v === 'boolean') return v ? '开' : '关';
    return String(v);
  }

  async function handleSettingsImportFile(file) {
    if (!file) return;
    let obj;
    try {
      obj = JSON.parse(await file.text());
    } catch (e) {
      toast('导入失败：文件不是有效的 JSON（' + e.message + '）', 'error');
      return;
    }
    let parsed;
    try {
      parsed = Storage.validateSettingsExport(obj);
    } catch (e) {
      toast('导入失败：' + (e.message || e), 'error');
      return;
    }
    const diffs = await Storage.diffSettingsExport(parsed.settings);
    pendingSettingsImport = parsed;
    const when = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString() : '未知时间';
    const sensitiveText = Object.entries(parsed.sensitive)
      .map(([k, v]) => `${k} ${v === 'configured' ? '已配置' : '未配置'}`)
      .join('；') || '无敏感项状态标记';
    $('settings-import-summary').textContent =
      `导出时间 ${when}${parsed.appVersion ? ` · 来自 v${parsed.appVersion}` : ''} · 与当前设置差异 ${diffs.length} 项 · ${sensitiveText}`;
    const list = $('settings-import-diff');
    list.textContent = '';
    if (!diffs.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '文件中的设置与当前设置完全一致，可直接合并（不会改动任何值）。';
      list.appendChild(p);
    } else {
      for (const d of diffs) {
        const item = document.createElement('div');
        item.className = 'settings-diff-item';
        const title = document.createElement('div');
        title.className = 'settings-diff-key';
        title.textContent = d.key;
        const desc = document.createElement('div');
        desc.className = 'settings-diff-values';
        desc.textContent = `${formatSettingValue(d.oldValue)} → ${formatSettingValue(d.newValue)}`;
        item.appendChild(title);
        item.appendChild(desc);
        list.appendChild(item);
      }
    }
    $('settings-import-drawer').classList.remove('hidden');
  }

  async function applySettingsImport(mode) {
    if (!pendingSettingsImport) return;
    if (mode === 'overwrite' &&
      !confirm('覆盖导入会把文件中未出现的设置项恢复为默认值（凭据除外）。确定继续？')) {
      return;
    }
    try {
      const res = await Storage.applySettingsExport(pendingSettingsImport.settings, mode);
      closeSettingsImportDrawer();
      await loadSettingsToForm();
      toast(`已${mode === 'overwrite' ? '覆盖' : '合并'}导入设置：变更 ${res.applied.length} 项；导入前已自动备份（可在本地存储中恢复）`, 'success');
    } catch (e) {
      toast('导入失败：' + (e.message || e), 'error');
    }
  }

  // ---- WebDAV 设置与同步 ----
  let wdSettings = null;

  async function loadSettingsToForm() {
    const raw = await Storage.loadSettings();
    captureSecretPresence(raw);
    wdSettings = redactSettings(raw);
    const w = raw.webdav || {};
    const b = raw.behavior || {};
    const a = raw.ai || {};
    state.secretsV = Number(raw.secretsV) || 0;
    state.legacySkipped = false;
    $('wd-url').value = w.url || '';
    $('wd-username').value = '';
    $('wd-password').value = '';
    $('wd-remote-dir').value = w.remoteDir || '/open-collections';
    $('wd-autosync').checked = !!w.autoSync;
    $('wd-interval').value = Number(w.intervalMinutes) || 30;
    $('wd-sync-aicache').checked = !!(w.syncScope && w.syncScope.aiCache);
    $('wd-sync-backups').checked = !!(w.syncScope && w.syncScope.backups);
    $('behavior-batch-daily').checked = !!b.batchCollectDaily;
    $('behavior-ai-inbox').checked = !!b.aiIncludeInbox;
    $('behavior-allow-dup').checked = !!b.allowDuplicateLinks;
    updateAiInboxOptionVisibility();
    $('ai-base-url').value = a.baseUrl || '';
    $('ai-api-key').value = '';
    $('ai-model').value = a.model || '';
    $('ai-categories').value = (a.categories && a.categories.length
      ? a.categories
      : AI.DEFAULT_CATEGORIES).join('\n');
    state.aiConfig = {
      baseUrl: a.baseUrl || '',
      model: a.model || '',
      categories: a.categories && a.categories.length ? a.categories : AI.DEFAULT_CATEGORIES.slice()
    };
    state.batchCollectDaily = !!b.batchCollectDaily;
    state.aiIncludeInbox = !!b.aiIncludeInbox;
    state.allowDuplicateLinks = !!b.allowDuplicateLinks;
    state.aiEnabled = !!a.enabled;
    state.webdavEnabled = !!w.enabled;
    updateSecretPresence();
    updateSecurityUI();
    updateNetworkControls();
    refreshShortcuts();
    refreshAiCacheInfo().catch(() => {});
    renderOverview(raw).catch(() => {});
  }

  // 概览四卡：存储占用 / AI 状态 / 同步状态 / 密钥状态。
  async function renderOverview(raw) {
    const storageEl = $('ov-storage-value');
    if (!storageEl) return;
    try {
      const all = await new Promise((resolve) => chrome.storage.local.get(null, (items) => resolve(items || {})));
      const bytes = new Blob([JSON.stringify(all)]).size;
      storageEl.textContent = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
    } catch (e) {
      storageEl.textContent = '未知';
    }
    const aiEl = $('ov-ai-value');
    if (aiEl) aiEl.textContent = raw.ai && raw.ai.enabled ? '已启用' : '未启用';
    const syncEl = $('ov-sync-value');
    if (syncEl) {
      const w = raw.webdav || {};
      syncEl.textContent = w.enabled
        ? `已启用${w.autoSync ? ` · 每 ${Number(w.intervalMinutes) || 30} 分钟` : ''}`
        : '未启用';
    }
    const vaultEl = $('ov-vault-value');
    if (vaultEl) {
      const v = Number(raw.secretsV) || 0;
      vaultEl.textContent = v === 1 ? '待迁移旧密文' : '正常（免密加密）';
    }
  }

  function hasSecretValue(settings, name) {
    if (!settings) return false;
    if (settings.secrets && settings.secrets[name]) return true;
    if (name === 'aiApiKey') return !!settings.ai.apiKey;
    if (name === 'webdavUsername') return !!settings.webdav.username;
    if (name === 'webdavPassword') return !!settings.webdav.password;
    return false;
  }

  function captureSecretPresence(settings) {
    state.aiHasKey = hasSecretValue(settings, 'aiApiKey');
    state.webdavHasCredentials = hasSecretValue(settings, 'webdavUsername') ||
      hasSecretValue(settings, 'webdavPassword');
    state.secretsV = Number(settings && settings.secretsV) || 0;
  }

  // 全局只保留非敏感设置，凭据密文/明文都不进入 wdSettings。
  function redactSettings(settings) {
    if (!settings) return settings;
    return Object.assign({}, settings, {
      webdav: Object.assign({}, settings.webdav, { username: '', password: '' }),
      ai: Object.assign({}, settings.ai, { apiKey: '' })
    });
  }

  function updateSecretPresence() {
    const savedNote = '已加密保存；留空保持不变';
    const keyInput = $('ai-api-key');
    const userInput = $('wd-username');
    const passInput = $('wd-password');
    if (keyInput) keyInput.placeholder = state.aiHasKey ? savedNote : '';
    if (userInput) userInput.placeholder = state.webdavHasCredentials ? savedNote : '';
    if (passInput) passInput.placeholder = state.webdavHasCredentials ? savedNote : '';
  }

  function updateSecurityUI() {
    const status = $('security-status');
    const migrateBlock = $('security-migrate-block');
    const pending = state.secretsV === 1;
    if (migrateBlock) {
      migrateBlock.classList.toggle('hidden', !pending || !!state.legacySkipped);
    }
    if (status) {
      status.className = 'hint' + (pending ? ' warning' : '');
      if (pending) {
        status.textContent = state.legacySkipped
          ? '旧版主密码加密的凭据尚未迁移：旧密文保留不变；重新打开设置可再次迁移，重新保存凭据会自动改用免密加密。'
          : '检测到旧版主密码加密的凭据：输入旧主密码可一次性迁移为免密加密；跳过不会清空任何数据。';
      } else {
        status.textContent = '敏感凭据使用本机自动生成的保险库密钥加密保存，启动时自动解封，全程无需输入密码。';
      }
    }
  }

  function updateNetworkControls() {
    const aiOn = !!state.aiEnabled;
    const wdOn = !!state.webdavEnabled;
    const aiCb = $('ai-enabled');
    const wdCb = $('wd-enabled');
    if (aiCb) aiCb.checked = aiOn;
    if (wdCb) wdCb.checked = wdOn;
    const aiTest = $('btn-ai-test');
    if (aiTest) aiTest.disabled = !aiOn;
    ['btn-wd-test', 'btn-wd-sync', 'btn-wd-upload', 'btn-wd-download'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !wdOn;
    });
    // 未配置功能显示引导卡（而非仅置灰控件）。
    const aiGuide = $('ai-guide');
    if (aiGuide) aiGuide.classList.toggle('hidden', aiOn);
    const wdGuide = $('webdav-guide');
    if (wdGuide) wdGuide.classList.toggle('hidden', wdOn);
  }

  function openConsent(kind) {
    state.pendingConsent = kind;
    if (kind === 'ai') {
      $('consent-title').textContent = '启用 AI 自动整理';
      $('consent-text').textContent =
        `启用后，只有你点击「AI 整理」或「测试连接」时才会联网。\n` +
        `发送目标：你在设置中填写的 https 接口地址。\n` +
        `发送内容：当前整理范围的分组/集锦名称、卡片标题（最多 ${AI.TITLE_MAX} 字）、域名、` +
        `笔记（最多 ${AI.NOTES_MAX} 字）、摘录片段（最多 ${AI.EXCERPT_MAX} 字），以及用于认证的 API Key。\n` +
        '开发者不会收到这些数据；你可以随时关闭此开关。';
    } else {
      $('consent-title').textContent = '启用 WebDAV 云同步';
      $('consent-text').textContent =
        '启用后，只有你点击「测试连接」「立即同步」「仅上传」「仅下载」，或开启「定时自动同步」时才会联网。\n' +
        '发送目标：你在设置中填写的 https WebDAV 服务器。\n' +
        '发送内容：全部分组名称与卡片数据（标题、URL、笔记、摘录等，不截断），以及认证凭据。\n' +
        '开发者不会收到这些数据；关闭后会停止定时任务并取消进行中的同步。';
    }
    $('consent-drawer').classList.remove('hidden');
  }

  function closeConsent() {
    state.pendingConsent = null;
    $('consent-drawer').classList.add('hidden');
    updateNetworkControls();
  }

  async function confirmConsent() {
    const kind = state.pendingConsent;
    state.pendingConsent = null;
    $('consent-drawer').classList.add('hidden');
    if (kind === 'ai') await saveAiSettings(true);
    else if (kind === 'webdav') await saveSettings(true);
  }

  // ---- 快捷键 ----
  let shortcutsSnapshot = [];

  function normalizeShortcutKey(key) {
    const parts = String(key || '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return '';
    return parts.sort().join('+');
  }

  function openShortcutPage(command) {
    const url = /Edg\//i.test(navigator.userAgent)
      ? 'edge://extensions/shortcuts'
      : 'chrome://extensions/shortcuts';
    try {
      chrome.tabs.create({ url });
    } catch (e) {
      toast('无法打开浏览器快捷键页面，请手动访问 ' + url, 'error');
      return;
    }
    // 提示里同时给可读名与命令 id：浏览器快捷键页显示的可能是任一形式。
    const meta = COMMAND_META[command.name];
    const label = meta ? `「${meta.name}」（${command.name}）` : `「${command.name}」`;
    toast(`请在打开的快捷键页面中找到 Open Collections 的${label}进行修改`, 'info');
  }

  function refreshShortcuts() {
    const list = $('shortcuts-list');
    const status = $('shortcuts-status');
    if (!list) return;
    if (!chrome.commands || typeof chrome.commands.getAll !== 'function') {
      shortcutsSnapshot = [];
      list.innerHTML = '';
      if (status) status.textContent = '当前环境不支持读取快捷键绑定。';
      return;
    }
    chrome.commands.getAll((commands) => {
      if (chrome.runtime.lastError) {
        if (status) status.textContent = '读取快捷键失败：' + chrome.runtime.lastError.message;
        return;
      }
      const items = Array.isArray(commands) ? commands : [];
      shortcutsSnapshot = items;
      list.innerHTML = '';
      const byKey = new Map();
      items.forEach((c) => {
        const key = normalizeShortcutKey(c.shortcut);
        if (!key) return;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(c.name);
      });
      const conflictKeys = new Set();
      byKey.forEach((names, key) => {
        if (names.length > 1) conflictKeys.add(key);
      });

      items.forEach((c) => {
        const key = normalizeShortcutKey(c.shortcut);
        const row = document.createElement('div');
        row.className = 'shortcut-row';
        row.dataset.command = c.name || '';

        const meta = COMMAND_META[c.name];
        const info = document.createElement('div');
        info.className = 'shortcut-info';
        const name = document.createElement('span');
        name.className = 'shortcut-name';
        // 主标题用可读名；下划线 id 只放在 tooltip 次要位置。
        name.textContent = meta ? meta.name : (c.name || '未命名命令');
        name.title = c.name || '';
        const desc = document.createElement('span');
        desc.className = 'shortcut-desc';
        desc.textContent = meta ? meta.desc : (c.description || '（无说明）');
        info.appendChild(name);
        info.appendChild(desc);
        // 事实判断：Chromium 对 _execute_action 的说明来源不稳定——可能显示固定文案
        //（如「打开扩展程序」）、扩展名或 action.default_title，manifest 里的自定义
        // description 不一定被采用，实际显示以浏览器为准。不要为了「好看」改用自定义
        // 命令 id 冒充内置命令：只有 _execute_action 能把快捷键绑定到「点击工具栏图标」。
        if (meta && meta.builtin) {
          const note = document.createElement('span');
          note.className = 'shortcut-desc';
          note.textContent = '系统内置命令，等同点击工具栏图标';
          info.appendChild(note);
        }

        const keyBadge = document.createElement('span');
        keyBadge.className = 'shortcut-key' + (c.shortcut ? '' : ' unset');
        keyBadge.textContent = c.shortcut || '未设置';
        if (!c.shortcut) keyBadge.title = '未设置：可在浏览器快捷键页面绑定';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-sm';
        btn.textContent = '去修改';
        btn.dataset.shortcutCommand = c.name || '';
        btn.addEventListener('click', () => {
          const command = shortcutsSnapshot.find((x) => x.name === c.name) || c;
          openShortcutPage(command);
        });

        row.appendChild(info);
        row.appendChild(keyBadge);
        row.appendChild(btn);

        if (key && conflictKeys.has(key)) {
          row.classList.add('shortcut-conflict');
          const others = (byKey.get(key) || []).filter((n) => n !== c.name);
          const warn = document.createElement('span');
          warn.className = 'shortcut-warning';
          warn.textContent = `可能冲突：与「${others.join('、')}」相同`;
          row.appendChild(warn);
        }
        list.appendChild(row);
      });

      if (status) {
        if (conflictKeys.size) {
          status.textContent = `检测到 ${conflictKeys.size} 组重复绑定，可能冲突；可在快捷键页面调整。`;
        } else if (items.some((c) => !c.shortcut)) {
          status.textContent = `共 ${items.length} 个命令，其中有 ${items.filter((c) => !c.shortcut).length} 个未设置快捷键。`;
        } else if (items.length) {
          status.textContent = `共 ${items.length} 个命令，显示值来自浏览器当前绑定。`;
        } else {
          status.textContent = '没有可显示的快捷键命令。';
        }
      }
    });
  }

  async function focusSecuritySettings(message) {
    if (message) toast(message, 'error');
    openDrawer('settings');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const section = $('security-settings-section');
    if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
  }

  // 旧版主密码数据一次性迁移：解密后立即用免密保险库重封装。
  async function migrateLegacySecrets() {
    const input = $('security-legacy-password');
    try {
      const res = await Storage.migrateLegacySecrets(input ? input.value : '');
      if (input) input.value = '';
      const raw = await Storage.loadSettings();
      captureSecretPresence(raw);
      wdSettings = redactSettings(raw);
      state.legacySkipped = false;
      updateSecretPresence();
      updateSecurityUI();
      sendMessage({ type: 'webdav-reschedule' }).catch(() => {});
      toast(`迁移完成：${res.count} 项凭据已改为免密加密保存`, 'success');
    } catch (e) {
      toast('迁移失败：' + (e.message || e), 'error');
    }
  }

  // 跳过迁移：旧密文原样保留并标记「未迁移」，重新保存凭据时才会改用新加密。
  function skipLegacyMigration() {
    const input = $('security-legacy-password');
    if (input) input.value = '';
    state.legacySkipped = true;
    updateSecurityUI();
    toast('已暂时跳过：旧密文保留不变，可重新打开设置再次迁移', 'info');
  }

  async function clearLocalKey() {
    if (!confirm('清除本地密钥将同时删除已加密的 WebDAV 用户名/密码与 AI API Key，且无法恢复。确定继续？')) {
      return;
    }
    try {
      await Storage.clearVaultAndSecrets();
      $('ai-api-key').value = '';
      $('wd-username').value = '';
      $('wd-password').value = '';
      const raw = await Storage.loadSettings();
      captureSecretPresence(raw);
      wdSettings = redactSettings(raw);
      state.legacySkipped = false;
      updateSecretPresence();
      updateSecurityUI();
      sendMessage({ type: 'webdav-reschedule' }).catch(() => {});
      toast('本地密钥与已加密凭据已清除，请重新填写凭据', 'info');
    } catch (e) {
      toast('清除失败：' + (e.message || e), 'error');
    }
  }

  // AI 与收藏行为各自有独立保存按钮，这里只读 WebDAV，避免误覆盖其他配置段。
  function readSettingsFromForm() {
    const webdav = {
      enabled: $('wd-enabled').checked,
      url: $('wd-url').value.trim(),
      remoteDir: $('wd-remote-dir').value.trim() || '/open-collections',
      autoSync: $('wd-autosync').checked,
      intervalMinutes: Math.max(5, Number($('wd-interval').value) || 30),
      syncScope: {
        aiCache: $('wd-sync-aicache').checked,
        backups: $('wd-sync-backups').checked
      }
    };
    const username = $('wd-username').value.trim();
    const password = $('wd-password').value;
    if (username) webdav.username = username;
    if (password) webdav.password = password;
    return { webdav };
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
    const raw = await Storage.updateSettings(s);
    captureSecretPresence(raw);
    wdSettings = redactSettings(raw);
    const a = raw.ai || {};
    state.secretsV = Number(raw.secretsV) || 0;
    // 全局配置只保留非敏感字段，API Key 不进入可序列化状态对象。
    state.aiConfig = {
      baseUrl: a.baseUrl || '',
      model: a.model || '',
      categories: a.categories || []
    };
    state.batchCollectDaily = !!(raw.behavior && raw.behavior.batchCollectDaily);
    state.aiIncludeInbox = !!(raw.behavior && raw.behavior.aiIncludeInbox);
    state.allowDuplicateLinks = !!(raw.behavior && raw.behavior.allowDuplicateLinks);
    state.aiEnabled = !!(raw.ai && raw.ai.enabled);
    state.webdavEnabled = !!(raw.webdav && raw.webdav.enabled);
    updateSecretPresence();
    updateSecurityUI();
    updateNetworkControls();
    if (opts.reschedule !== false) await sendMessage({ type: 'webdav-reschedule' });
  }

  async function saveSettings(force) {
    const wantEnabled = $('wd-enabled').checked;
    if (wantEnabled && !state.webdavEnabled && !force) {
      openConsent('webdav');
      return;
    }
    const wasEnabled = state.webdavEnabled;
    try {
      await persistSettings(readSettingsFromForm());
      $('wd-username').value = '';
      $('wd-password').value = '';
      if (wasEnabled && !state.webdavEnabled) {
        await sendMessage({ type: 'webdav-cancel' }).catch(() => {});
        setWDStatus('WebDAV 已关闭：定时任务已停止，进行中的同步已取消', 'success');
      } else {
        setWDStatus('设置已保存' + (wdSettings.webdav.autoSync && state.webdavEnabled ? '，自动同步已启用' : ''), 'success');
      }
    } catch (e) {
      updateNetworkControls();
      setWDStatus('保存失败：' + (e.message || e), 'error');
      if (e.code === 'legacy') {
        await focusSecuritySettings(e.message);
      }
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
    const wasAllowed = state.allowDuplicateLinks;
    try {
      await persistSettings({
        behavior: {
          batchCollectDaily: $('behavior-batch-daily').checked,
          aiIncludeInbox: $('behavior-ai-inbox').checked,
          allowDuplicateLinks: $('behavior-allow-dup').checked
        }
      }, { reschedule: false });
      setBehaviorStatus('设置已保存', 'success');
      // 仅在「允许重复」由关变开时自动提示清理；没有重复则不打扰。
      if (!wasAllowed && state.allowDuplicateLinks) {
        await scanDuplicates(true);
      }
    } catch (e) {
      setBehaviorStatus('保存失败：' + (e.message || e), 'error');
    }
  }

  // ---- 重复链接清理 ----
  function dedupeKeeper(group) {
    return state.dedupeKeep === 'newest'
      ? group.cards[group.cards.length - 1]
      : group.cards[0];
  }

  function updateDedupeSummary() {
    const groupCount = state.dedupeGroups.length;
    const cardCount = state.dedupeGroups.reduce((n, g) => n + g.cards.length, 0);
    const selectedCount = state.dedupeSelected.size;
    const keepLabel = state.dedupeKeep === 'newest' ? '最新' : '最早';
    $('dedupe-summary').textContent =
      `发现 ${groupCount} 组重复链接，涉及 ${cardCount} 条卡片；已选择 ${selectedCount} 组。` +
      `默认保留${keepLabel}添加的一条，取消勾选可跳过该组。`;
  }

  function renderDedupeDialog() {
    const list = $('dedupe-list');
    list.innerHTML = '';
    state.dedupeGroups.forEach((group, index) => {
      const item = document.createElement('div');
      item.className = 'dedupe-group';
      const keeper = dedupeKeeper(group);
      const head = document.createElement('div');
      head.className = 'dedupe-group-head';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.dedupeSelected.has(index);
      checkbox.dataset.dedupeIndex = String(index);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.dedupeSelected.add(index);
        else state.dedupeSelected.delete(index);
        updateDedupeSummary();
      });

      const name = document.createElement('span');
      name.className = 'dedupe-group-name';
      name.textContent = keeper.card.title || keeper.card.url || '（无标题）';
      name.title = keeper.key;

      const count = document.createElement('span');
      count.className = 'dedupe-group-count';
      count.textContent = `${group.cards.length} 条`;

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn btn-ghost dedupe-toggle';
      toggle.textContent = state.dedupeExpanded.has(index) ? '收起' : '展开';
      toggle.addEventListener('click', () => {
        if (state.dedupeExpanded.has(index)) state.dedupeExpanded.delete(index);
        else state.dedupeExpanded.add(index);
        const expanded = state.dedupeExpanded.has(index);
        cards.classList.toggle('hidden', !expanded);
        toggle.textContent = expanded ? '收起' : '展开';
      });

      head.appendChild(checkbox);
      head.appendChild(name);
      head.appendChild(count);
      head.appendChild(toggle);
      item.appendChild(head);

      const cards = document.createElement('ul');
      cards.className = 'dedupe-cards' + (state.dedupeExpanded.has(index) ? '' : ' hidden');
      group.cards.forEach((entry) => {
        const li = document.createElement('li');
        li.className = 'dedupe-card-row';
        const title = document.createElement('span');
        title.className = 'dedupe-card-title';
        title.textContent = entry.card.title || entry.card.url || '（无标题）';
        const where = document.createElement('span');
        where.className = 'dedupe-card-group';
        where.textContent = entry.groupName;
        where.title = entry.groupName;
        const time = document.createElement('span');
        time.className = 'dedupe-card-time';
        time.textContent = Utils.formatAddedTime(entry.card.addedAt);
        const badge = document.createElement('span');
        badge.className = 'dedupe-badge';
        badge.textContent = '保留';
        li.appendChild(title);
        li.appendChild(where);
        li.appendChild(time);
        if (entry === keeper) li.appendChild(badge);
        cards.appendChild(li);
      });
      item.appendChild(cards);
      list.appendChild(item);
    });
    updateDedupeSummary();
  }

  async function scanDuplicates(auto) {
    try {
      const data = await Storage.load();
      const groups = Storage.findDuplicateGroups(data);
      if (!groups.length) {
        if (!auto) toast('未发现重复链接', 'info');
        return false;
      }
      state.dedupeGroups = groups;
      state.dedupeSelected = new Set(groups.map((g, i) => i));
      state.dedupeExpanded = new Set();
      state.dedupeKeep = 'oldest';
      state.dedupeBackupKey = null;
      state.dedupeRemoved = [];
      renderDedupeDialog();
      $('dedupe-form').classList.remove('hidden');
      $('dedupe-result').classList.add('hidden');
      els.dedupeDrawer.classList.remove('hidden');
      return true;
    } catch (e) {
      toast('查找重复链接失败：' + (e.message || e), 'error');
      return false;
    }
  }

  async function runDedupeCleanup() {
    const selected = state.dedupeGroups.filter((g, index) => state.dedupeSelected.has(index));
    const entries = [];
    for (const group of selected) {
      const keeper = dedupeKeeper(group);
      for (const entry of group.cards) {
        if (entry === keeper) continue;
        entries.push({ groupId: entry.groupId, cardId: entry.card.id });
      }
    }
    if (!entries.length) {
      toast('没有需要清理的重复项', 'info');
      return;
    }
    const btn = $('btn-dedupe-run');
    btn.disabled = true;
    try {
      const backupKey = await Storage.createBackup('dedupe');
      state.dedupeBackupKey = backupKey;
      state.dedupeRemoved = entries;
      const byGroup = new Map();
      for (const entry of entries) {
        if (!byGroup.has(entry.groupId)) byGroup.set(entry.groupId, []);
        byGroup.get(entry.groupId).push(entry.cardId);
      }
      let removed = 0;
      for (const [groupId, cardIds] of byGroup) {
        const res = await Storage.deleteCards(groupId, cardIds);
        removed += res.removed;
      }
      await loadAndRender();
      $('dedupe-form').classList.add('hidden');
      $('dedupe-result').classList.remove('hidden');
      $('dedupe-result-text').textContent =
        `已清理 ${removed} 条重复卡片（保留${state.dedupeKeep === 'newest' ? '最新' : '最早'}添加），已生成备份。`;
      $('btn-dedupe-undo').classList.toggle('hidden', removed === 0);
    } catch (e) {
      toast('清理重复链接失败：' + (e.message || e), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function undoDedupeCleanup() {
    if (!state.dedupeBackupKey || !state.dedupeRemoved.length) return;
    try {
      const res = await Storage.restoreCardsFromBackup(state.dedupeBackupKey, state.dedupeRemoved);
      await loadAndRender();
      $('dedupe-result-text').textContent = `已恢复 ${res.restored} 条卡片。`;
      $('btn-dedupe-undo').classList.add('hidden');
      toast(`已恢复 ${res.restored} 条卡片`, 'success');
    } catch (e) {
      toast('撤销清理失败：' + (e.message || e), 'error');
    }
  }

  function closeDedupeDrawer() {
    els.dedupeDrawer.classList.add('hidden');
  }

  function readAiForm() {
    let categories = Utils.normalizeCategories($('ai-categories').value.split(/[\n,，、]/));
    if (!categories.length) categories = AI.DEFAULT_CATEGORIES.slice();
    const cfg = {
      enabled: $('ai-enabled').checked,
      baseUrl: $('ai-base-url').value.trim(),
      model: $('ai-model').value.trim(),
      categories
    };
    const apiKey = $('ai-api-key').value.trim();
    if (apiKey) cfg.apiKey = apiKey;
    return cfg;
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

  async function saveAiSettings(force) {
    const cfg = readAiForm();
    if (cfg.enabled && !state.aiEnabled && !force) {
      openConsent('ai');
      return;
    }
    const wasEnabled = state.aiEnabled;
    if (cfg.baseUrl) {
      try {
        AI.normalizeEndpoint(cfg.baseUrl);
      } catch (e) {
        setAiStatus(e.message, 'error');
        updateNetworkControls();
        return;
      }
    }
    try {
      await persistSettings({ ai: cfg }, { reschedule: false });
      $('ai-api-key').value = '';
      $('ai-categories').value = wdSettings.ai.categories.join('\n');
      updateSecretPresence();
      updateSecurityUI();
      if (wasEnabled && !state.aiEnabled) {
        closeAiDrawer();
        setAiStatus('AI 整理已关闭：进行中的请求已取消，后续不会再发起请求', 'success');
      } else {
        setAiStatus(state.aiHasKey
          ? '设置已保存，API Key 已加密存储'
          : '设置已保存；使用 AI 前需填写 API Key', 'success');
      }
    } catch (e) {
      updateNetworkControls();
      setAiStatus('保存失败：' + (e.message || e), 'error');
      if (e.code === 'legacy') {
        await focusSecuritySettings();
      }
    }
  }

  async function resolveAiKey(typedKey) {
    if (typedKey) return typedKey;
    const secrets = await Storage.loadSecrets();
    return secrets.aiApiKey || '';
  }

  async function testAiConnection() {
    if (!state.aiEnabled) {
      setAiStatus('AI 整理未启用：请先勾选「启用 AI 自动整理」并保存确认', 'error');
      openSettingsForAi();
      return;
    }
    const cfg = readAiForm();
    if (!cfg.baseUrl || !cfg.model) {
      setAiStatus('请先填写接口地址、API Key 与模型名称', 'error');
      return;
    }
    let apiKey;
    try {
      apiKey = await resolveAiKey(cfg.apiKey);
    } catch (e) {
      setAiStatus(e.message, 'error');
      await focusSecuritySettings();
      return;
    }
    if (!apiKey) {
      setAiStatus('请先填写 API Key 或先在设置中保存 API Key', 'error');
      return;
    }
    // 只把密钥放入本次请求的临时配置，不写入 state。
    const requestCfg = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey };
    const granted = await requestOriginPermission(requestCfg.baseUrl);
    if (!granted) {
      setAiStatus('未获得访问该接口的网络权限，请重试并在弹窗中选择允许', 'error');
      return;
    }
    setAiStatus('正在测试连接…', '');
    let res;
    try {
      res = await AI.testConnection(requestCfg);
    } catch (e) {
      setAiStatus('连接失败：' + (e.message || e), 'error');
      return;
    }
    try {
      const patch = { ai: { baseUrl: cfg.baseUrl, model: cfg.model, categories: cfg.categories } };
      if (cfg.apiKey) patch.ai.apiKey = cfg.apiKey;
      await persistSettings(patch, { reschedule: false });
      $('ai-api-key').value = '';
      $('ai-categories').value = wdSettings.ai.categories.join('\n');
      updateSecretPresence();
      updateSecurityUI();
      setAiStatus('连接成功 ✓ 设置已保存' + (res.reply ? `（${Utils.truncate(res.reply, 20)}）` : ''), 'success');
    } catch (e) {
      setAiStatus('连接成功，但保存设置失败：' + (e.message || e), 'error');
      if (e.code === 'legacy') {
        await focusSecuritySettings();
      }
    }
  }

  async function testConnection() {
    if (!$('wd-enabled').checked) {
      setWDStatus('WebDAV 同步未启用：请先勾选「启用 WebDAV 云同步」并保存确认', 'error');
      openDrawer('settings');
      return;
    }
    const s = readSettingsFromForm();
    if (!s.webdav.url) {
      setWDStatus('请先填写 WebDAV 服务器地址', 'error');
      return;
    }
    const wd = Object.assign({}, s.webdav);
    const typedSecrets = !!(wd.username || wd.password);
    if (!typedSecrets || !wd.username || !wd.password) {
      try {
        const secrets = await Storage.loadSecrets();
        wd.username = wd.username || secrets.webdavUsername;
        wd.password = wd.password || secrets.webdavPassword;
      } catch (e) {
        setWDStatus(e.message, 'error');
        await focusSecuritySettings();
        return;
      }
    }
    if (!wd.username) {
      setWDStatus('请先填写用户名', 'error');
      return;
    }
    const granted = await requestOriginPermission(wd.url);
    if (!granted) {
      setWDStatus('未获得访问该服务器的网络权限，请重试并在弹窗中选择允许', 'error');
      return;
    }
    setWDStatus('正在测试连接…', '');
    try {
      await WebDAV.testConnection(wd);
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
    state.aiPinnedSkipped = 0;
    state.aiBackupKey = null;
    updateAiInboxSkipHint();
    $('btn-ai-organize').disabled = false;
  }

  function updateAiInboxSkipHint() {
    const el = $('ai-inbox-skip');
    if (!el) return;
    const parts = [];
    if (state.aiInboxSkipped > 0) {
      parts.push(`收件箱 ${state.aiInboxSkipped} 条未参与本次整理（可在设置中开启「AI 整理时包含每日收件箱的条目」）`);
    }
    if (state.aiPinnedSkipped > 0) {
      parts.push(`${state.aiPinnedSkipped} 条已固定，未参与本次整理`);
    }
    el.classList.toggle('hidden', !parts.length);
    el.textContent = parts.join('；');
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
    let pinnedSkippedCount = 0;
    for (const id of groupIds) {
      const g = state.data.groups.find((x) => x.id === id && !x.deleted);
      if (!g) continue;
      for (const c of g.cards) {
        if (c.deleted) continue;
        // 固定条目对 AI 整理免疫：不参与请求，也不被移动。
        if (c.pinned) { pinnedSkippedCount++; continue; }
        cards.push(c);
        cardGroupNames[c.id] = g.name;
      }
    }
    const skippedCount = skippedGroups.reduce(
      (n, g) => n + g.cards.filter((c) => !c.deleted).length, 0);
    return { groupIds, cards, cardGroupNames, skippedCount, pinnedSkippedCount, explicitInbox };
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
    if (!state.aiEnabled) {
      toast('AI 整理未启用：请先在设置中启用并确认首次说明', 'error');
      openSettingsForAi();
      return;
    }
    const cfg = state.aiConfig;
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      toast('请先在设置中配置 AI 接口与模型', 'error');
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

    let apiKey;
    try {
      apiKey = await resolveAiKey('');
    } catch (e) {
      await focusSecuritySettings(e.message);
      return;
    }
    if (!apiKey) {
      toast('请先在设置中填写 AI API Key', 'error');
      openSettingsForAi();
      return;
    }
    // 密钥只用于本次请求的临时配置，不写入 state.aiConfig。
    const requestCfg = { baseUrl: cfg.baseUrl, model: cfg.model, categories: cfg.categories, apiKey };

    const btn = $('btn-ai-organize');
    btn.disabled = true;
    let runId = state.aiRunId;
    try {
      const granted = await requestOriginPermission(requestCfg.baseUrl);
      if (!granted) {
        toast('未获得访问该 AI 接口的网络权限', 'error');
        return;
      }
      // 等待授权期间抽屉可能已被关闭（或功能被关闭/其他窗口禁用），此时不得重新发起请求。
      if (runId !== state.aiRunId) return;

      runId = ++state.aiRunId;
      const controller = new AbortController();
      state.aiAbort = controller;
      state.aiGroupIds = candidate.groupIds.slice();
      state.aiInboxSkipped = candidate.skippedCount;
      state.aiPinnedSkipped = candidate.pinnedSkippedCount || 0;
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
        cfg: requestCfg,
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
          .then((res) => {
            refreshAiCacheInfo();
            if (res && res.skipped) toast(res.message || '存储空间不足，已跳过本次 AI 分类缓存', 'info');
          })
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
      if (runId === state.aiRunId) state.aiAbort = null;
      // 无论本轮是否已被取消，按钮都要恢复可用（取消时不会再有新的运行接手）。
      btn.disabled = false;
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
      if (res.movedCards || res.skippedDuplicates) {
        let text = `已新建 ${res.createdGroups.length} 个、并入 ${res.reusedGroups.length} 个已有分组，移动 ${res.movedCards} 条内容。`;
        if (res.skippedDuplicates) {
          text += ` 跳过 ${res.skippedDuplicates} 条目标分组已存在的重复链接。`;
        }
        $('ai-applied-text').textContent = text;
      } else {
        $('ai-applied-text').textContent = '没有可移动的内容，数据可能已变化。';
      }
      renderAiState('applied');
    } catch (e) {
      if (e.code === 'URL_NOT_COLLECTABLE') toast(e.message || Utils.URL_NOT_COLLECTABLE_MESSAGE, 'error');
      else toast('应用失败：' + (e.message || e), 'error');
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
    if (!$('wd-enabled').checked) {
      setWDStatus('WebDAV 同步未启用：请先勾选「启用 WebDAV 云同步」并保存确认', 'error');
      openDrawer('settings');
      return;
    }
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
    const typedSecrets = !!(s.webdav.username || s.webdav.password);
    if (!typedSecrets) {
      try {
        const secrets = await Storage.loadSecrets();
        if (!secrets.webdavUsername) {
          setWDStatus('请先填写用户名', 'error');
          return;
        }
      } catch (e) {
        setWDStatus(e.message, 'error');
        await focusSecuritySettings();
        return;
      }
    }
    setWDStatus(`正在${label}…`, '');
    try {
      // 先落盘当前表单；后台同步时再按需解密凭据。
      await persistSettings(s);
      $('wd-username').value = '';
      $('wd-password').value = '';
      const res = await sendMessage({ type: 'webdav-sync', mode });
      const result = res && res.result;
      let detail = '';
      if (result && result.stats) {
        const cs = result.stats.cards;
        const gs = result.stats.groups;
        const parts = [
          `分组 新增${gs.added}/更新${gs.updated}/删除${gs.deleted}`,
          `卡片 新增${cs.added}/更新${cs.updated}/删除${cs.deleted}`
        ];
        if (result.settingsChanged) parts.push(`设置 ${result.settingsChanged} 个键`);
        if (result.aiCacheSkipped) parts.push('AI 缓存空间不足已跳过');
        if (result.uncollectableSkipped) parts.push(`跳过 ${result.uncollectableSkipped} 个不受支持的链接`);
        detail = `（${parts.join('，')}）`;
      } else if (result) {
        detail = `（${result.groups} 个分组）`;
      }
      setWDStatus(`${label}完成 ✓${detail}`, 'success');
      await loadAndRender();
    } catch (e) {
      setWDStatus(`${label}失败：${e.message || e}`, 'error');
      if (e.code === 'legacy') {
        await focusSecuritySettings();
      }
    }
  }

  // ---- 抽屉 ----
  function openDrawer(name) {
    const drawer = name === 'settings' ? els.settings : els.editor;
    drawer.classList.remove('hidden');
    if (name === 'settings') loadSettingsToForm();
  }

  // 设置分区导航跳转：滚动到目标分区并高亮导航项。
  function gotoSettingsSection(sectionId) {
    const section = $(sectionId);
    const container = document.querySelector('#settings-drawer .settings-sections');
    if (section && container && section.scrollIntoView) {
      section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    document.querySelectorAll('#settings-nav .settings-nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.goto === sectionId);
    });
  }
  function closeDrawer(name) {
    const drawer = name === 'settings' ? els.settings : els.editor;
    drawer.classList.add('hidden');
  }

  // ---- 事件绑定 ----
  function bindEvents() {
    els.btnToggleGroups.addEventListener('click', toggleGroups);
    els.groupsBackdrop.addEventListener('click', () => setGroupsFolded(true));

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

    // 设置导出 / 导入
    $('btn-export-settings').addEventListener('click', exportSettings);
    $('btn-import-settings').addEventListener('click', () => $('file-import-settings').click());
    $('file-import-settings').addEventListener('change', (e) => {
      handleSettingsImportFile(e.target.files[0]);
      e.target.value = '';
    });
    $('btn-settings-import-merge').addEventListener('click', () => applySettingsImport('merge'));
    $('btn-settings-import-overwrite').addEventListener('click', () => applySettingsImport('overwrite'));
    $('btn-settings-import-cancel').addEventListener('click', closeSettingsImportDrawer);

    // 独立窗口：单一「收藏并关闭标签页」入口与窗口选择器。
    $('btn-standalone-collect').addEventListener('click', standaloneCollectAndClose);
    $('btn-window-picker-ok').addEventListener('click', () => {
      if (!windowPickerResolve) return;
      const checked = document.querySelector('input[name="pick-window"]:checked');
      if (!checked) return;
      const id = Number(checked.value);
      // 从最近一次渲染的窗口集合中找回目标（保留 tabs 数据）。
      const win = windowPickerWins.find((w) => w.id === id) || null;
      windowPickerResolve(win);
    });
    $('btn-window-picker-cancel').addEventListener('click', () => {
      if (windowPickerResolve) windowPickerResolve(null);
    });

    // 收藏行为
    $('btn-behavior-save').addEventListener('click', saveBehaviorSettings);
    $('behavior-batch-daily').addEventListener('change', updateAiInboxOptionVisibility);

    // 设置分区导航：点击跳转 + 高亮（卡片与导航共用 data-goto）。
    document.querySelectorAll('#settings-drawer [data-goto]').forEach((el) => {
      el.addEventListener('click', () => gotoSettingsSection(el.dataset.goto));
    });

    // 控件即时生效（不再依赖分散的保存按钮）。
    ['behavior-batch-daily', 'behavior-ai-inbox', 'behavior-allow-dup'].forEach((id) => {
      $(id).addEventListener('change', saveBehaviorSettings);
    });
    const autoSaveWebdav = () => saveSettings(true);
    ['wd-url', 'wd-remote-dir', 'wd-interval', 'wd-autosync', 'wd-sync-aicache', 'wd-sync-backups']
      .forEach((id) => $(id).addEventListener('change', autoSaveWebdav));
    $('wd-enabled').addEventListener('change', saveSettings);
    ['ai-base-url', 'ai-model', 'ai-categories'].forEach((id) => {
      $(id).addEventListener('change', () => saveAiSettings(true));
    });
    $('ai-enabled').addEventListener('change', () => saveAiSettings());
    $('ai-api-key').addEventListener('change', () => {
      if ($('ai-api-key').value.trim()) saveAiSettings(true);
    });

    // 引导卡启用按钮：勾选开关并走既有确认流程。
    $('btn-ai-guide-enable').addEventListener('click', () => {
      $('ai-enabled').checked = true;
      saveAiSettings();
    });
    $('btn-wd-guide-enable').addEventListener('click', () => {
      $('wd-enabled').checked = true;
      saveSettings();
    });

    // 分区恢复默认（凭据不受影响）。
    $('btn-reset-behavior').addEventListener('click', async () => {
      if (!confirm('把「收藏与去重」的全部开关恢复为默认（关闭）？')) return;
      await persistSettings({ behavior: { batchCollectDaily: false, aiIncludeInbox: false, allowDuplicateLinks: false } }, { reschedule: false });
      await loadSettingsToForm();
      toast('收藏与去重已恢复默认', 'success');
    });
    $('btn-reset-ai').addEventListener('click', async () => {
      if (!confirm('把「AI 整理」的接口地址、模型与分类表恢复为默认（API Key 保留，开关关闭）？')) return;
      await persistSettings({ ai: { enabled: false, baseUrl: '', model: '', categories: AI.DEFAULT_CATEGORIES.slice() } }, { reschedule: false });
      await loadSettingsToForm();
      toast('AI 整理已恢复默认', 'success');
    });
    $('btn-reset-webdav').addEventListener('click', async () => {
      if (!confirm('把「云同步」的服务器与同步设置恢复为默认（凭据保留，开关关闭）？')) return;
      await persistSettings({
        webdav: {
          enabled: false, url: '', remoteDir: '/open-collections',
          autoSync: false, intervalMinutes: 30,
          syncScope: { aiCache: false, backups: false }
        }
      });
      await loadSettingsToForm();
      toast('云同步已恢复默认', 'success');
    });
    $('btn-reset-onboarding').addEventListener('click', async () => {
      try {
        await new Promise((resolve) => chrome.storage.local.remove(Storage.ONBOARDING_KEY, () => resolve()));
        if (els.onboardingBanner) els.onboardingBanner.classList.remove('hidden');
        toast('隐私提示条已恢复显示', 'success');
      } catch (e) {
        toast('操作失败：' + (e.message || e), 'error');
      }
    });
    $('btn-reset-general').addEventListener('click', async () => {
      try {
        await Storage.saveFoldState(null);
        toast('分组栏折叠偏好已重置', 'success');
      } catch (e) {
        toast('操作失败：' + (e.message || e), 'error');
      }
    });

    // 本地加密（免密保险库）：旧数据迁移、跳过与清除密钥
    $('btn-security-migrate').addEventListener('click', migrateLegacySecrets);
    $('btn-security-skip').addEventListener('click', skipLegacyMigration);
    $('btn-security-clear-key').addEventListener('click', clearLocalKey);
    $('btn-shortcuts-refresh').addEventListener('click', refreshShortcuts);
    // 绑定可能被用户在浏览器快捷键页修改：窗口获得焦点/重新可见时全部刷新，
    // 不渲染过期键位。
    const refreshCommandUi = () => {
      refreshShortcuts();
      refreshCommandBindings();
    };
    window.addEventListener('focus', refreshCommandUi);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshCommandUi();
    });
    $('btn-consent-confirm').addEventListener('click', confirmConsent);
    $('btn-consent-cancel').addEventListener('click', closeConsent);
    if (els.btnOnboardingClose) {
      els.btnOnboardingClose.addEventListener('click', () => {
        els.onboardingBanner.classList.add('hidden');
        Storage.dismissOnboarding().catch(() => {});
      });
    }
    $('btn-dedupe-scan').addEventListener('click', () => scanDuplicates(false));
    $('btn-dedupe-run').addEventListener('click', runDedupeCleanup);
    $('btn-dedupe-cancel').addEventListener('click', closeDedupeDrawer);
    $('btn-dedupe-close').addEventListener('click', closeDedupeDrawer);
    $('btn-dedupe-undo').addEventListener('click', undoDedupeCleanup);
    document.querySelectorAll('input[name="dedupe-keep"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.dedupeKeep = radio.value;
        renderDedupeDialog();
      });
    });

    // AI 自动整理
    $('btn-ai-save').addEventListener('click', () => saveAiSettings());
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
    $('btn-wd-save').addEventListener('click', () => saveSettings());
    $('btn-wd-test').addEventListener('click', testConnection);
    $('btn-wd-sync').addEventListener('click', () => runSync('sync'));
    $('btn-wd-upload').addEventListener('click', () => runSync('upload'));
    $('btn-wd-download').addEventListener('click', () => runSync('download'));

    // 抽屉关闭
    document.querySelectorAll('[data-close]').forEach((el) => {
      const name = el.dataset.close;
      el.addEventListener('click', () => {
        if (name === 'ai') closeAiDrawer();
        else if (name === 'dedupe') closeDedupeDrawer();
        else if (name === 'consent') closeConsent();
        else if (name === 'settings-import') closeSettingsImportDrawer();
        else if (name === 'window-picker') {
          if (windowPickerResolve) windowPickerResolve(null);
        } else closeDrawer(name);
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
        closeDedupeDrawer();
        closeConsent();
        closeSettingsImportDrawer();
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
          .then(async (s) => {
            const old = changes[Storage.SETTINGS_KEY].oldValue || {};
            const oldAiEnabled = !!(old.ai && old.ai.enabled);
            const oldWdEnabled = !!(old.webdav && old.webdav.enabled);
            captureSecretPresence(s);
            wdSettings = redactSettings(s);
            state.secretsV = Number(s.secretsV) || 0;
            const a = s.ai || {};
            state.aiConfig = {
              baseUrl: a.baseUrl || '',
              model: a.model || '',
              categories: a.categories || []
            };
            state.batchCollectDaily = !!(s.behavior && s.behavior.batchCollectDaily);
            state.aiIncludeInbox = !!(s.behavior && s.behavior.aiIncludeInbox);
            state.allowDuplicateLinks = !!(s.behavior && s.behavior.allowDuplicateLinks);
            state.aiEnabled = !!(s.ai && s.ai.enabled);
            state.webdavEnabled = !!(s.webdav && s.webdav.enabled);
            updateSecretPresence();
            updateSecurityUI();
            updateNetworkControls();
            refreshCollectMenuCopy();
            refreshShortcuts();
            // 其他窗口关闭开关时，本窗口也立即停止进行中的 AI 请求并取消同步。
            if (oldAiEnabled && !state.aiEnabled && state.aiAbort) closeAiDrawer();
            if (oldWdEnabled && !state.webdavEnabled) {
              sendMessage({ type: 'webdav-cancel' }).catch(() => {});
            }
          })
          .catch(() => {});
      }
      if (area === 'local' && (changes[Storage.STORAGE_KEY] || changes[Storage.SETTINGS_KEY])) {
        loadAndRender();
      }
    });
  }

  // ---- 启动 ----
  // 上报屏幕可用区域：Service Worker 没有 screen 对象，独立窗口尺寸用它做上限与居中。
  function reportScreenInfo() {
    try {
      if (typeof screen === 'undefined' || !Storage.saveScreenInfo) return;
      Storage.saveScreenInfo({
        w: Number(screen.availWidth) || 0,
        h: Number(screen.availHeight) || 0
      }).catch(() => {});
    } catch (e) {}
  }

  function init() {
    cacheEls();
    // 关于页版本号取自 manifest，避免发版时多处手改漏更新。
    const about = $('about-version');
    if (about && chrome.runtime && chrome.runtime.getManifest) {
      about.textContent = 'Open Collections v' + chrome.runtime.getManifest().version +
        ' · 本地集锦管理。数据存放于浏览器 chrome.storage.local。';
    }
    // 场景判定：独立窗口由 background 创建时带 standalone=1，可靠且不受拉宽侧边栏影响。
    uiScene = /[?&]standalone=1/.test(location.search) ? 'standalone' : 'sidepanel';
    if (uiScene === 'standalone') {
      document.body.classList.add('standalone-window');
      // 独立窗口默认展开；随后再以读回的偏好为准（读回慢或失败也保持展开）。
      setGroupsFolded(false, false);
      Storage.loadFoldState()
        .then((state2) => {
          if (foldUserTouched) return;
          const stored = state2 && typeof state2.standalone === 'boolean' ? state2.standalone : null;
          setGroupsFolded(stored == null ? false : stored, false);
        })
        .catch(() => {
          if (!foldUserTouched) setGroupsFolded(false, false);
        });
    } else {
      // 侧边栏冷启动确定性折叠：首帧已由 HTML 的 groups-collapsed 保证，这里同步再应用一次，
      // 不读回、不写入侧边栏展开态。偏好读回延迟或上次会话残留的 sidepanel=false 都不会让它展开。
      setGroupsFolded(true, false);
    }
    // 「在独立窗口打开」只在侧边栏场景有意义：独立窗口内隐藏（display:none，不占位）。
    const openWindowBtn = $('btn-window');
    if (openWindowBtn) openWindowBtn.classList.toggle('hidden', uiScene === 'standalone');
    // 独立窗口是扩展页面，没有网页选区可读：隐藏「摘录」按钮（快捷键命令不受影响，
    // 仍作用于最近活跃的普通网页标签）。顶部只保留「收藏并关闭标签页」主按钮，
    // 添加当前页面/下拉菜单仅属于侧边栏场景。
    const excerptBtn = $('btn-save-sel');
    if (excerptBtn) excerptBtn.classList.toggle('hidden', uiScene === 'standalone');
    const addPageBtn = $('btn-add-page');
    if (addPageBtn) addPageBtn.classList.toggle('hidden', uiScene === 'standalone');
    const addMenuBtn = $('btn-add-menu');
    if (addMenuBtn) addMenuBtn.classList.toggle('hidden', uiScene === 'standalone');
    const addSplit = document.querySelector('.add-split');
    if (addSplit) addSplit.classList.toggle('hidden', uiScene === 'standalone');
    const standaloneCollectBtn = $('btn-standalone-collect');
    if (standaloneCollectBtn) standaloneCollectBtn.classList.toggle('hidden', uiScene !== 'standalone');
    bindEvents();
    reportScreenInfo();
    window.addEventListener('resize', Utils.debounce(reportScreenInfo, 300));
    refreshCommandBindings();
    if (els.onboardingBanner) {
      Storage.loadOnboarding()
        .then((dismissed) => els.onboardingBanner.classList.toggle('hidden', dismissed))
        .catch(() => {});
    }
    Storage.loadSettings()
      .then(async (s) => {
        captureSecretPresence(s);
        wdSettings = redactSettings(s);
        state.secretsV = Number(s.secretsV) || 0;
        state.legacySkipped = false;
        const a = s.ai || {};
        state.aiConfig = {
          baseUrl: a.baseUrl || '',
          model: a.model || '',
          categories: a.categories || []
        };
        state.batchCollectDaily = !!(s.behavior && s.behavior.batchCollectDaily);
        state.aiIncludeInbox = !!(s.behavior && s.behavior.aiIncludeInbox);
        state.allowDuplicateLinks = !!(s.behavior && s.behavior.allowDuplicateLinks);
        state.aiEnabled = !!(s.ai && s.ai.enabled);
        state.webdavEnabled = !!(s.webdav && s.webdav.enabled);
        updateSecretPresence();
        updateSecurityUI();
        updateNetworkControls();
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
