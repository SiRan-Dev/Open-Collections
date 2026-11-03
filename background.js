// background.js — Service Worker：快捷键、侧边栏/窗口、消息路由、定时同步。
importScripts('js/utils.js', 'js/secret.js', 'js/storage.js', 'js/webdav.js');

const MANAGEMENT_PAGE = 'management.html';

// ---- 安装与启动 ----
chrome.runtime.onInstalled.addListener(async () => {
  try {
    // 让点击扩展图标时打开侧边栏。
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (e) {
    console.warn('[OpenCollections] setPanelBehavior failed:', e);
  }

  // 若没有数据，创建默认分组。
  try {
    const data = await Storage.load();
    const aliveGroups = data.groups.filter((g) => !g.deleted);
    if (aliveGroups.length === 0) {
      await Storage.createGroup('默认集锦', Utils.PALETTE[0]);
    }
  } catch (e) {
    console.error('[OpenCollections] init default group failed:', e);
  }

  // 注册自动同步闹钟（如果设置开启）。
  await rescheduleAutoSync();
});

chrome.runtime.onStartup.addListener(() => {
  rescheduleAutoSync().catch((e) => console.warn('[OpenCollections] reschedule auto sync failed:', e));
});

// 点击工具栏图标（_execute_action）：支持的浏览器直接打开侧边栏（openPanelOnActionClick）；
// 仅在不支持 sidePanel API 的环境，点击图标才降级为打开独立窗口（快捷键命令不做此降级）。
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  // 已经在 onInstalled 中设置；这里再尝试一次以防 SW 重启。
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  chrome.action.onClicked.addListener(() => openManagementWindow());
}

// ---- 工具：获取活动标签页信息 ----
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// 构造 favicon URL（依赖 favicon 权限）。
function faviconUrlFor(url) {
  if (!url) return '';
  try {
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  } catch (e) {
    return '';
  }
}

// ---- 添加当前页面到当前分组 ----
async function addCurrentPage(options) {
  options = options || {};
  const tab = await getActiveTab();
  if (!tab || !tab.url) throw new Error('无法获取当前标签页信息');
  // 忽略扩展自身与浏览器内部页。
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    throw new Error('无法保存浏览器内部页面');
  }
  const groupId = await Storage.getActiveGroupId();
  if (!groupId) throw new Error('请先创建一个分组');
  const input = {
    type: 'page',
    title: tab.title || tab.url,
    url: tab.url,
    favicon: faviconUrlFor(tab.url)
  };

  if (!options.force) {
    const settings = await Storage.loadSettings();
    if (!(settings.behavior && settings.behavior.allowDuplicateLinks)) {
      const data = await Storage.load();
      const dup = Storage.findDuplicateCard(data, input);
      if (dup) {
        const err = new Error(`该链接已存在于「${dup.group.name}」`);
        err.code = 'duplicate';
        err.duplicate = { groupId: dup.group.id, groupName: dup.group.name, title: dup.card.title };
        throw err;
      }
    }
  }

  await Storage.addCard(groupId, input);
  return tab.title || tab.url;
}

// ---- 保存选中文字为摘录卡片 ----
async function saveSelection(options) {
  options = options || {};
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error('无法获取当前标签页');
  if (!/^https?:/i.test(tab.url)) throw new Error('只能在普通网页中保存选区');

  let selection = '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = window.getSelection();
        return sel ? sel.toString() : '';
      }
    });
    selection = (results && results[0] && results[0].result) || '';
  } catch (e) {
    const raw = e && e.message ? e.message : String(e);
    if (/Cannot access|must request permission|Missing host permission/i.test(raw)) {
      throw new Error('无法读取选区：页面访问权限不足。请再次点击「摘录」并允许访问网页，或使用快捷键 Ctrl+Shift+E');
    }
    throw new Error('无法读取选区：' + raw);
  }
  selection = selection.trim();
  if (!selection) throw new Error('请先在页面中选中要保存的文字');

  const groupId = await Storage.getActiveGroupId();
  if (!groupId) throw new Error('请先创建一个分组');
  const input = {
    type: 'excerpt',
    title: tab.title || '摘录',
    url: tab.url,
    favicon: faviconUrlFor(tab.url),
    excerpt: selection.slice(0, 5000),
    sourceTitle: tab.title || '',
    sourceUrl: tab.url
  };

  if (!options.force) {
    const settings = await Storage.loadSettings();
    if (!(settings.behavior && settings.behavior.allowDuplicateLinks)) {
      const data = await Storage.load();
      const dup = Storage.findDuplicateCard(data, input);
      if (dup) {
        const err = new Error(`该摘录已存在于「${dup.group.name}」`);
        err.code = 'duplicate';
        err.duplicate = { groupId: dup.group.id, groupName: dup.group.name, title: dup.card.title };
        throw err;
      }
    }
  }

  await Storage.addCard(groupId, input);
  return selection.length;
}

// ---- 打开侧边栏 ----
// Chromium 侧边栏只有 open、没有关闭 API，命令语义就是「打开」；失败时给出可读提示，
// 绝不降级为打开独立窗口——独立窗口有单独的命令（open-management-window）与按钮入口，
// 两者共用会再次造成「按了侧边栏快捷键却开出独立窗口」的错觉。
function sidePanelUnsupportedMessage() {
  return '当前浏览器不支持侧边栏 API，请改用「打开独立管理窗口」命令或顶栏的独立窗口按钮';
}

async function openSidePanel(tab) {
  if (!chrome.sidePanel || !chrome.sidePanel.open) {
    notifyUI({ type: 'error', message: sidePanelUnsupportedMessage() });
    return;
  }
  // onCommand 自带 tab.windowId 时直接同步使用，避免 await 之后再调 open 丢失用户手势；
  // 键盘命令属于用户手势，但手势不一定跨越扩展的异步桥接。
  let windowId = tab && typeof tab.windowId === 'number' ? tab.windowId : null;
  if (windowId == null) {
    try {
      const win = await chrome.windows.getCurrent();
      windowId = win && typeof win.id === 'number' ? win.id : null;
    } catch (e) {
      windowId = null;
    }
  }
  if (windowId == null) {
    notifyUI({ type: 'error', message: '无法打开侧边栏：没有可用的浏览器窗口' });
    return;
  }
  try {
    await chrome.sidePanel.open({ windowId });
  } catch (e) {
    const reason = (e && e.message) ? e.message : String(e);
    console.warn('[OpenCollections] sidePanel.open failed:', reason);
    notifyUI({ type: 'error', message: '无法打开侧边栏：' + reason });
  }
}

function openManagementWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL(MANAGEMENT_PAGE),
    type: 'popup',
    width: 480,
    height: 720
  });
}

// ---- 快捷键 ----
// 命令 → 处理器映射（与 manifest commands 一一对应，不得共用入口）：
//   add-current-page       → addCurrentPage
//   save-selection         → saveSelection
//   toggle-side-panel      → openSidePanel（仅打开侧边栏）
//   open-management-window → openManagementWindow（仅独立窗口）
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'add-current-page') {
    addCurrentPage()
      .then(() => notifyUI({ type: 'success', message: '已加入当前分组' }))
      .catch((e) => notifyUI({ type: 'error', message: e.message }));
  } else if (command === 'save-selection') {
    saveSelection()
      .then(() => notifyUI({ type: 'success', message: '摘录已保存' }))
      .catch((e) => notifyUI({ type: 'error', message: e.message }));
  } else if (command === 'toggle-side-panel') {
    openSidePanel(tab);
  } else if (command === 'open-management-window') {
    openManagementWindow();
  }
});

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'add-current-page':
      addCurrentPage({ force: !!msg.force })
        .then(() => sendResponse({ ok: true, result: { message: '已加入当前分组' } }))
        .catch((e) => sendResponse({
          ok: false,
          error: e.message,
          code: e.code,
          duplicate: e.duplicate
        }));
      return true;
    case 'save-selection':
      saveSelection({ force: !!msg.force })
        .then((len) => sendResponse({ ok: true, result: { message: `摘录已保存（${len} 字）` } }))
        .catch((e) => sendResponse({
          ok: false,
          error: e.message,
          code: e.code,
          duplicate: e.duplicate
        }));
      return true;
    case 'open-window':
      openManagementWindow();
      sendResponse({ ok: true });
      return false;
    case 'webdav-sync':
      if (activeSyncAbort) {
        sendResponse({ ok: false, error: '已有同步正在进行', code: 'busy' });
        return false;
      }
      activeSyncAbort = new AbortController();
      WebDAV.runSync(msg.mode || 'sync', { signal: activeSyncAbort.signal })
        .then((res) => sendResponse({ ok: true, result: res }))
        .catch((e) => sendResponse({
          ok: false,
          error: e.code === 'cancelled' ? '同步已取消' : e.message,
          code: e.code
        }))
        .finally(() => { activeSyncAbort = null; });
      return true;
    case 'webdav-cancel':
      if (activeSyncAbort) {
        activeSyncAbort.abort();
        activeSyncAbort = null;
        sendResponse({ ok: true, result: { cancelled: true } });
      } else {
        sendResponse({ ok: true, result: { cancelled: false } });
      }
      return false;
    case 'webdav-test':
      WebDAV.testConnection(msg.settings)
        .then((res) => sendResponse({ ok: true, result: res }))
        .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
      return true;
    case 'webdav-reschedule':
      rescheduleAutoSync()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    default:
      return false;
  }
});

// ---- 通知 UI（侧边栏/窗口若处于打开状态）----
function notifyUI(payload) {
  // 广播给所有打开的 management 页面。
  chrome.runtime.sendMessage({ type: 'notification', payload }).catch(() => {});
}

// ---- 自动同步闹钟 ----
const AUTO_SYNC_ALARM = 'open-collections-auto-sync';
let activeSyncAbort = null;

async function rescheduleAutoSync() {
  if (!chrome.alarms) return;
  const settings = await Storage.loadSettings();
  await chrome.alarms.clear(AUTO_SYNC_ALARM);
  if (settings.webdav && settings.webdav.enabled && settings.webdav.autoSync &&
    settings.webdav.url && settings.security && settings.security.enabled) {
    const minutes = Math.max(5, Number(settings.webdav.intervalMinutes) || 30);
    chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: minutes });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) {
    Storage.loadSettings().then((settings) => {
      if (!settings.webdav || settings.webdav.enabled !== true) {
        chrome.alarms.clear(AUTO_SYNC_ALARM);
        return;
      }
      if (activeSyncAbort) return;
      activeSyncAbort = new AbortController();
      WebDAV.runSync('sync', { signal: activeSyncAbort.signal })
        .catch((e) => {
          console.error('[OpenCollections] auto sync failed:', e);
          notifyUI({ type: 'error', message: '自动同步失败：' + e.message });
        })
        .finally(() => { activeSyncAbort = null; });
    }).catch(() => {});
  }
});
