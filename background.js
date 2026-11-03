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
      // 首次安装创建受保护的「默认集锦」。
      await Storage.createGroup('默认集锦', Utils.PALETTE[0], { system: true });
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

// ---- 工具：获取「最近活跃的普通网页标签」----
// 独立管理窗口/侧边栏自身是扩展页面，不是网页。用户在独立窗口里点「添加当前页面」
// 或按摘录快捷键时，活动标签是扩展页，取不到目标网页。
// 因此监听 tabs.onActivated/onUpdated，记录「最近活跃的普通 http/https 标签」。
// 仅当活动标签是扩展自身页面（独立窗口）时回退使用它；侧边栏停在受限页时不回退，改为明确报错。
const RECENT_TAB_KEY = 'recentWebTab';

function isWebTabUrl(url) {
  return /^https?:/i.test(String(url || ''));
}

// 是否为扩展自身的页面（侧边栏/独立管理窗口）。只有这种场景才需要回退到「最近网页」；
// 用户停在 chrome://、其它扩展页等受限页时，应把该页原样返回以便调用方明确报错。
function isOwnManagementPage(url) {
  try {
    const base = typeof chrome.runtime.getURL === 'function'
      ? chrome.runtime.getURL('')
      : `chrome-extension://${chrome.runtime.id}/`;
    return !!url && String(url).indexOf(base) === 0;
  } catch (e) {
    return false;
  }
}

async function trackWebTab(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0 || !isWebTabUrl(tab.url)) return;
  const record = { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || tab.url };
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [RECENT_TAB_KEY]: record });
    } else {
      globalThis.__recentWebTab = record;
    }
  } catch (e) {}
}

async function readRecentWebTab() {
  try {
    if (chrome.storage.session) {
      const items = await chrome.storage.session.get(RECENT_TAB_KEY);
      return (items && items[RECENT_TAB_KEY]) || null;
    }
  } catch (e) {}
  return globalThis.__recentWebTab || null;
}

async function clearRecentWebTab(tabId) {
  const recent = await readRecentWebTab();
  if (recent && recent.id === tabId) {
    try {
      if (chrome.storage.session) await chrome.storage.session.remove(RECENT_TAB_KEY);
      else globalThis.__recentWebTab = null;
    } catch (e) {}
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(trackWebTab).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title) trackWebTab(tab);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearRecentWebTab(tabId).catch(() => {});
});

// ---- 最近活跃的普通浏览器窗口（独立窗口批量收藏用）----
// 独立管理窗口是 popup 类型：记录最近聚焦的 normal 窗口，供「收藏并关闭标签页」定位目标。
const RECENT_WINDOW_KEY = 'recentNormalWindow';

async function readRecentNormalWindow() {
  try {
    if (chrome.storage.session) {
      const items = await chrome.storage.session.get(RECENT_WINDOW_KEY);
      const rec = items && items[RECENT_WINDOW_KEY];
      if (rec && typeof rec.id === 'number') {
        const win = await chrome.windows.get(rec.id).catch(() => null);
        if (win && win.type === 'normal') return rec.id;
      }
      return null;
    }
  } catch (e) {}
  return typeof globalThis.__recentNormalWindow === 'object'
    ? globalThis.__recentNormalWindow.id : null;
}

if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    try {
      const win = await chrome.windows.get(windowId);
      if (win.type !== 'normal') return;
      if (chrome.storage.session) {
        await chrome.storage.session.set({ [RECENT_WINDOW_KEY]: { id: win.id } });
      } else {
        globalThis.__recentNormalWindow = { id: win.id };
      }
    } catch (e) {}
  });
}

// 活动标签是普通网页时直接用；扩展自身页面（独立窗口）才回退到最近活跃网页标签。
// 用户主动停留在受限页时返回该页，由 addCurrentPage / saveSelection 给出明确错误，
// 避免静默收藏/摘录到另一个网页。
async function getActiveWebTab() {
  let tab = null;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active || null;
  } catch (e) {}
  if (tab) {
    if (isWebTabUrl(tab.url)) return tab;
    if (!isOwnManagementPage(tab.url)) return tab;
  }
  const recent = await readRecentWebTab();
  if (recent && typeof recent.id === 'number') {
    try {
      const t = await chrome.tabs.get(recent.id);
      if (t && isWebTabUrl(t.url)) return t;
    } catch (e) {}
  }
  return null;
}

// ---- 工具：获取活动标签页信息（保留原行为供内部兼容调用）----
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
  const tab = await getActiveWebTab();
  if (!tab || !tab.url) throw new Error('请先在浏览器中打开一个网页再添加');
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
  const tab = await getActiveWebTab();
  if (!tab || !tab.id) throw new Error('请先在浏览器中打开一个网页再保存摘录');
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
      throw new Error('无法读取选区：页面访问权限不足。请再次点击「摘录」并允许访问网页');
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

// ---- 独立管理窗口：尺寸策略只在这一处，所有入口（命令/消息/图标降级）共用 ----
// 默认 1200×850；上限为屏幕可用区域的 92%（Service Worker 无 screen 对象，
// 由 management 页面上报），极小屏时 92% 优先于最小宽度，保证窗口完整落在屏幕内。
// 用户手动调整后的尺寸经防抖持久化，下次沿用；脏数据（非数字/越界）回退默认。
// bounds 带 schema 版本：升级时旧结构（含历史小尺寸）整体失效一次，避免重开仍是小窗。
// Chromium 的 windows.create 不支持窗口级 minWidth，960px 下限用于尺寸校验；
// 独立窗口页面（?standalone=1）另有 CSS min-width 兜底，分组栏任何宽度都不会自动消失。
const MANAGEMENT_WINDOW_DEFAULT = { width: 1200, height: 850 };
const MANAGEMENT_WINDOW_MIN = { width: 960, height: 600 };
const MANAGEMENT_WINDOW_MAX = { width: 4000, height: 2400 };
const WINDOW_BOUNDS_SCHEMA_VERSION = 2;
const BOUNDS_SAVE_DEBOUNCE_MS = 600;

function normalizeWindowSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  return {
    width: Number.isFinite(w) && w >= MANAGEMENT_WINDOW_MIN.width && w <= MANAGEMENT_WINDOW_MAX.width
      ? Math.round(w)
      : MANAGEMENT_WINDOW_DEFAULT.width,
    height: Number.isFinite(h) && h >= MANAGEMENT_WINDOW_MIN.height && h <= MANAGEMENT_WINDOW_MAX.height
      ? Math.round(h)
      : MANAGEMENT_WINDOW_DEFAULT.height
  };
}

function fitSizeToScreen(size, screenInfo) {
  if (!screenInfo || !(Number(screenInfo.w) > 0) || !(Number(screenInfo.h) > 0)) return size;
  const capW = Math.floor(Number(screenInfo.w) * 0.92);
  const capH = Math.floor(Number(screenInfo.h) * 0.92);
  let width = Math.min(size.width, capW);
  let height = Math.min(size.height, capH);
  // 极小屏：92% 可用区域优先于最小宽度，宁可窄于 960 也不超出屏幕。
  width = Math.max(width, Math.min(MANAGEMENT_WINDOW_MIN.width, capW));
  height = Math.max(height, Math.min(MANAGEMENT_WINDOW_MIN.height, capH));
  return { width, height };
}

async function managementWindowSize() {
  let size = Object.assign({}, MANAGEMENT_WINDOW_DEFAULT);
  try {
    const bounds = await Storage.loadWindowBounds();
    // schema 迁移：旧版本结构（无 v 标记）一次性失效，防止历史小尺寸残留。
    if (bounds && bounds.v === WINDOW_BOUNDS_SCHEMA_VERSION) {
      const normalized = normalizeWindowSize(bounds.width, bounds.height);
      // 仅当存储值通过校验（未触发回退）时才采用，脏数据走默认值。
      if (bounds.width != null && normalized.width === Math.round(Number(bounds.width))) {
        size.width = normalized.width;
      }
      if (bounds.height != null && normalized.height === Math.round(Number(bounds.height))) {
        size.height = normalized.height;
      }
    }
  } catch (e) {}
  try {
    const screenInfo = await Storage.loadScreenInfo();
    size = fitSizeToScreen(size, screenInfo);
  } catch (e) {}
  return size;
}

async function openManagementWindow() {
  const size = await managementWindowSize();
  let win = null;
  try {
    win = await chrome.windows.create({
      // standalone=1：页面据此启用窗口专属布局兜底（CSS min-width 等），侧边栏不受影响。
      url: chrome.runtime.getURL(MANAGEMENT_PAGE) + '?standalone=1',
      type: 'popup',
      width: size.width,
      height: size.height
      // 不传 left/top：Chromium 默认将窗口居中。
    });
  } catch (e) {
    console.error('[OpenCollections] create management window failed:', e);
    return;
  }
  if (win && win.id != null) {
    await Storage.saveWindowBounds({
      v: WINDOW_BOUNDS_SCHEMA_VERSION,
      windowId: win.id,
      width: size.width,
      height: size.height
    }).catch(() => {});
  }
}

// 用户手动调整管理窗口大小后记住新尺寸（防抖）；只认我们创建的窗口 id。
let boundsSaveTimer = null;
chrome.windows.onBoundsChanged.addListener((win) => {
  if (!win || win.id == null) return;
  Storage.loadWindowBounds().then((bounds) => {
    if (!bounds || bounds.windowId !== win.id) return;
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      Storage.saveWindowBounds({
        v: WINDOW_BOUNDS_SCHEMA_VERSION,
        windowId: win.id,
        width: win.width,
        height: win.height
      }).catch(() => {});
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  }).catch(() => {});
});

// 窗口关闭后清除 windowId，保留尺寸供下次打开沿用。
chrome.windows.onRemoved.addListener((windowId) => {
  Storage.loadWindowBounds().then((bounds) => {
    if (bounds && bounds.windowId === windowId) {
      return Storage.saveWindowBounds({ windowId: null });
    }
  }).catch(() => {});
});

// ---- 快捷键 ----
// 命令 → 处理器映射（与 manifest commands 一一对应，不得共用入口）：
//   add-current-page       → addCurrentPage
//   save-selection         → saveSelection
//   open-management-window → openManagementWindow
// 注意：面板唯一入口是工具栏图标（_execute_action），由上方 setPanelBehavior 直接打开
// 侧边栏；Chromium 不会为 _execute_action 派发 onCommand，因此这里不监听它，
// 也就不会与浏览器默认行为重复触发导致面板打开两次。旧的 toggle-side-panel 命令
// 已删除（与图标行为合并），用户为其自定义的绑定会随之失效，属预期行为。
chrome.commands.onCommand.addListener((command) => {
  if (command === 'add-current-page') {
    addCurrentPage()
      .then(() => notifyUI({ type: 'success', message: '已加入当前分组' }))
      .catch((e) => notifyUI({ type: 'error', message: e.message }));
  } else if (command === 'save-selection') {
    saveSelection()
      .then(() => notifyUI({ type: 'success', message: '摘录已保存' }))
      .catch((e) => notifyUI({ type: 'error', message: e.message }));
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
    case 'get-recent-web-window':
      readRecentWebTab()
        .then((recent) => sendResponse({ ok: true, windowId: recent ? recent.windowId : null }))
        .catch(() => sendResponse({ ok: true, windowId: null }));
      return true;
    case 'get-recent-normal-window':
      readRecentNormalWindow()
        .then((id) => sendResponse({ ok: true, windowId: typeof id === 'number' ? id : null }))
        .catch(() => sendResponse({ ok: true, windowId: null }));
      return true;
    case 'webdav-sync':
      if (activeSyncAbort) {
        sendResponse({ ok: false, error: '已有同步正在进行', code: 'busy' });
        return false;
      }
      {
        const controller = new AbortController();
        activeSyncAbort = controller;
        WebDAV.runSync(msg.mode || 'sync', { signal: controller.signal })
          .then((res) => sendResponse({ ok: true, result: res }))
          .catch((e) => sendResponse({
            ok: false,
            error: e.code === 'cancelled' ? '同步已取消' : e.message,
            code: e.code
          }))
          .finally(() => {
            // 取消后引用要保留到本次同步真正落定，避免旧同步的 finally 清掉新同步的控制器。
            if (activeSyncAbort === controller) activeSyncAbort = null;
          });
      }
      return true;
    case 'webdav-cancel':
      if (activeSyncAbort) {
        // 只中止请求，不立即清空；控制器由该次同步的 finally 按身份清理。
        activeSyncAbort.abort();
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
    settings.webdav.url) {
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
      const controller = new AbortController();
      activeSyncAbort = controller;
      WebDAV.runSync('sync', { signal: controller.signal })
        .catch((e) => {
          console.error('[OpenCollections] auto sync failed:', e);
          notifyUI({ type: 'error', message: '自动同步失败：' + e.message });
        })
        .finally(() => {
          if (activeSyncAbort === controller) activeSyncAbort = null;
        });
    }).catch(() => {});
  }
});
