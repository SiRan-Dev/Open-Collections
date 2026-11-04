// storage.js — 数据持久化与领域逻辑。依赖 chrome.storage.local 与 Utils。
// 可在 background（importScripts）与 management 页面（<script>）中复用。
(function (global) {
  'use strict';

  const STORAGE_KEY = 'openpocket:v1';
  const BACKUP_PREFIX = 'openpocket:backup:';
  const SETTINGS_BACKUP_PREFIX = 'openpocket:settings-backup:';
  const CORRUPT_RAW_PREFIX = 'openpocket:corrupt:';
  const SYNC_WATERMARK_KEY = 'openpocket:sync-watermark';
  const SETTINGS_KEY = 'openpocket:settings';

  const DEFAULT_DATA = {
    version: 1,
    groups: [],
    activeGroupId: null
  };

  const DEFAULT_SETTINGS = {
    webdav: {
      enabled: false,
      url: '',
      username: '',
      password: '',
      remoteDir: '/open-collections',
      autoSync: false,
      intervalMinutes: 30,
      // 同步范围：收藏与分组 + 设置项始终同步；分类缓存与备份快照可选，默认关。
      syncScope: { aiCache: false, backups: false }
    },
    behavior: {
      batchCollectDaily: false,
      aiIncludeInbox: false,
      allowDuplicateLinks: false
    },
    ai: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      categories: Utils.DEFAULT_AI_CATEGORIES.slice()
    },
    // security 已废弃（仅用于识别旧版主密码数据待迁移），新版本不再写入。
    security: null,
    // 0=无加密凭据；1=旧版主密码加密（待迁移）；2=免密保险库加密。
    secretsV: 0,
    secrets: {}
  };

  const DAILY_GROUP_PREFIX = 'daily-';
  const AI_CACHE_KEY = 'openpocket:ai-cache';
  const AI_CACHE_MAX = 2000;

  // chrome.storage.local 默认配额 10 MiB（manifest 未申请 unlimitedStorage）。
  // 写盘前预留 1 MiB 安全余量，给设置、AI 缓存、备份快照等其他键及实现差异留出空间。
  const QUOTA_BYTES = 10 * 1024 * 1024;
  const QUOTA_SAFETY_BYTES = 1024 * 1024;

  function isSW() {
    return typeof ServiceWorkerGlobalScope !== 'undefined' &&
      global instanceof ServiceWorkerGlobalScope;
  }

  // 结构化读取错误：调用方保留原有 catch 路径即可；错误信息面向用户可读。
  function storageError(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    if (extra && typeof extra === 'object') Object.assign(err, extra);
    return err;
  }

  function storageReadFailed(detail) {
    return storageError(
      'STORAGE_READ_FAILED',
      '读取本地存储失败，本次操作已取消以避免覆盖已有数据。请稍后重试；若持续失败，请检查浏览器扩展存储是否可用' +
        (detail ? '（' + detail + '）' : '')
    );
  }

  function dataCorrupt(detail) {
    return storageError(
      'DATA_CORRUPT',
      '本地存储的数据已损坏，本次操作已取消以避免覆盖原有内容。请尝试从备份恢复' +
        (detail ? '（' + detail + '）' : '')
    );
  }

  // 损坏原始值另存为恢复副本（尽力而为；失败不阻断报错路径）。
  function preserveCorruptRaw(raw) {
    try {
      const key = CORRUPT_RAW_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      chrome.storage.local.set({ [key]: raw }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[OpenCollections] 无法保存损坏数据的恢复副本:', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.warn('[OpenCollections] 无法保存损坏数据的恢复副本:', e);
    }
  }

  // 从 chrome.storage.local 读取。区分「键不存在」（首次运行，返回默认数据）与
  // 「读取失败 / JSON 损坏 / 类型异常」（抛出结构化错误，绝不返回空默认数据给写路径）。
  async function loadRaw() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (items) => {
          if (chrome.runtime.lastError) {
            console.error('[OpenCollections] storage read error:', chrome.runtime.lastError);
            reject(storageReadFailed(chrome.runtime.lastError.message));
            return;
          }
          if (items == null || typeof items !== 'object') {
            reject(storageReadFailed('返回数据无效'));
            return;
          }
          const raw = items[STORAGE_KEY];
          if (raw == null) {
            resolve(Utils.clone(DEFAULT_DATA));
            return;
          }
          if (typeof raw === 'string') {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch (e) {
              console.error('[OpenCollections] data JSON parse failed.', e);
              preserveCorruptRaw(raw);
              reject(dataCorrupt('收藏数据 JSON 解析失败'));
              return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              preserveCorruptRaw(raw);
              reject(dataCorrupt('收藏数据不是有效的对象结构'));
              return;
            }
            resolve(parsed);
            return;
          }
          if (typeof raw === 'object' && !Array.isArray(raw)) {
            resolve(raw);
          } else {
            console.error('[OpenCollections] unexpected data type.');
            preserveCorruptRaw(raw);
            reject(dataCorrupt('收藏数据类型异常'));
          }
        });
      } catch (e) {
        console.error('[OpenCollections] storage exception:', e);
        reject(storageReadFailed(e && e.message));
      }
    });
  }

  // 规范化数据，确保字段完整，处理损坏结构。
  function normalize(data) {
    if (!data || typeof data !== 'object') data = Utils.clone(DEFAULT_DATA);
    data.version = data.version || 1;
    if (!Array.isArray(data.groups)) data.groups = [];
    data.groups = data.groups.map(normalizeGroup).filter(Boolean);
    // 「默认集锦」是受保护分组（system）：旧数据迁移——没有任何存活 system 组时，
    // 给创建最早的存活分组打标（排除每日收件箱等临时组；onInstalled 新装时创建的组直接带 system）。
    const systemGroups = data.groups
      .filter((g) => g.system && !g.deleted)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    if (systemGroups.length > 1) {
      // 多设备/旧数据可能各自创建 system 组：只保留最早的一个受保护，其余清除标记但不删数据。
      systemGroups.slice(1).forEach((g) => { g.system = false; });
    }
    if (!systemGroups.length) {
      const alive = data.groups.filter((g) => !g.deleted && !Storage.isDailyGroup(g))
        .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
      if (alive.length) alive[0].system = true;
    }
    // 一次性迁移：默认分类「开发编程」更名为「开发」。仅当精确匹配且无同名冲突时执行；
    // 与 normalize 的既有旧数据迁移同层（内存修正，下一次写盘时自然持久化），幂等无副作用。
    const devOld = data.groups.find((g) => !g.deleted && g.name === '开发编程');
    const devNew = data.groups.find((g) => !g.deleted && g.name === '开发');
    if (devOld && !devNew) {
      devOld.name = '开发';
      devOld.updatedAt = Utils.now();
      devOld.metaUpdatedAt = Utils.now();
    }
    // activeGroupId 必须指向存活分组；优先非每日收件箱（OCP-CONF-018）。
    const active = data.groups.find((g) => g.id === data.activeGroupId && !g.deleted);
    if (!active) {
      const nonDaily = data.groups.find((g) => !g.deleted && !Storage.isDailyGroup(g));
      const alive = nonDaily || data.groups.find((g) => !g.deleted);
      data.activeGroupId = alive ? alive.id : null;
    }
    return data;
  }

  function normalizeGroup(g) {
    if (!g || typeof g !== 'object') return null;
    const id = g.id || Utils.uuid();
    const dailyMatch = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(id);
    let name = typeof g.name === 'string' ? g.name : '未命名分组';
    // 兼容旧版自动生成的「标签页 · 日期」命名，去掉与分区标题重复的前缀。
    if (dailyMatch && name === '标签页 · ' + dailyMatch[1]) name = dailyMatch[1];
    const createdAt = Number(g.createdAt) || Utils.now();
    const updatedAt = Number(g.updatedAt) || createdAt;
    // metaUpdatedAt：名称/颜色的最后修改时间，与卡片内容活动时间分离（OCP-CONF-010）。
    const metaUpdatedAt = Number(g.metaUpdatedAt) || createdAt;
    let deletedAt = null;
    if (g.deletedAt != null) {
      const n = Number(g.deletedAt);
      deletedAt = Number.isFinite(n) ? n : null;
    }
    return {
      id,
      name,
      color: typeof g.color === 'string' ? g.color : Utils.PALETTE[0],
      createdAt,
      updatedAt,
      metaUpdatedAt,
      deleted: !!g.deleted,
      deletedAt,
      // system：受保护的「默认集锦」，不可删除，AI 不得改其归属。
      system: !!g.system,
      cards: Array.isArray(g.cards) ? g.cards.map(normalizeCard).filter(Boolean) : []
    };
  }

  function normalizeCard(c) {
    if (!c || typeof c !== 'object') return null;
    let deletedAt = null;
    if (c.deletedAt != null) {
      const n = Number(c.deletedAt);
      deletedAt = Number.isFinite(n) ? n : null;
    }
    return {
      id: c.id || Utils.uuid(),
      type: c.type === 'excerpt' ? 'excerpt' : 'page',
      title: typeof c.title === 'string' ? c.title : '无标题',
      url: typeof c.url === 'string' ? c.url : '',
      favicon: typeof c.favicon === 'string' ? c.favicon : '',
      notes: typeof c.notes === 'string' ? c.notes : '',
      excerpt: typeof c.excerpt === 'string' ? c.excerpt : '',
      sourceTitle: typeof c.sourceTitle === 'string' ? c.sourceTitle : '',
      sourceUrl: typeof c.sourceUrl === 'string' ? c.sourceUrl : '',
      addedAt: Number(c.addedAt) || Utils.now(),
      updatedAt: Number(c.updatedAt) || Number(c.addedAt) || Utils.now(),
      deleted: !!c.deleted,
      deletedAt,
      // pinned：用户固定条目，AI 整理与重复清理不得移动/删除（随条目同步）。
      pinned: !!c.pinned
    };
  }

  // ---- 配额守卫 ----
  // 写盘前用 chrome.storage.local.getBytesInUse 估算「当前已用 - 该键旧值 + 新值」，
  // 超过安全阈值时不写入并抛出结构化 QUOTA_EXCEEDED，避免底层英文 quota 错误直接暴露给用户。
  function utf8ByteLength(str) {
    const s = String(str);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }

  function estimateBytes(value) {
    try {
      return utf8ByteLength(JSON.stringify(value));
    } catch (e) {
      return 0;
    }
  }

  function getBytesInUse(key) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.storage || !chrome.storage.local ||
            typeof chrome.storage.local.getBytesInUse !== 'function') {
          resolve(null);
          return;
        }
        chrome.storage.local.getBytesInUse(key, (bytes) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(Number(bytes) || 0);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function isQuotaMessage(message) {
    return /quota/i.test(String(message || ''));
  }

  function quotaExceeded(used, projected) {
    const err = new Error('存储空间不足，本次保存已取消。请删除旧摘录或清理重复条目后重试');
    err.code = 'QUOTA_EXCEEDED';
    err.used = Math.max(0, Math.round(Number(used) || 0));
    err.projected = Math.max(0, Math.round(Number(projected) || 0));
    err.quota = QUOTA_BYTES;
    return err;
  }

  // AI 分类缓存是「锦上添花」：配额不足时跳过本次缓存并提示，不能阻断整理主流程。
  function aiCacheSkipped(err) {
    return {
      skipped: true,
      code: 'QUOTA_EXCEEDED',
      used: err ? err.used : undefined,
      projected: err ? err.projected : undefined,
      quota: err ? err.quota : QUOTA_BYTES,
      message: '存储空间不足，已跳过本次 AI 分类缓存（不影响整理结果）。可删除旧摘录或清理重复条目后重试'
    };
  }

  async function projectUsage(key, value) {
    const [used, current] = await Promise.all([getBytesInUse(null), getBytesInUse(key)]);
    if (used == null) return null;
    return {
      used,
      projected: Math.max(0, used - (current || 0)) + estimateBytes(value),
      quota: QUOTA_BYTES
    };
  }

  async function assertQuota(key, value) {
    let usage;
    try {
      usage = await projectUsage(key, value);
    } catch (e) {
      // 拿不到用量时宁可放行（仍由底层 set 报错兜底），不让环境差异阻断正常保存。
      console.warn('[OpenCollections] quota precheck skipped:', e);
      return;
    }
    if (!usage) return;
    if (usage.projected > QUOTA_BYTES - QUOTA_SAFETY_BYTES) {
      throw quotaExceeded(usage.used, usage.projected);
    }
  }

  function setRaw(items) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function saveRaw(data) {
    try {
      await setRaw({ [STORAGE_KEY]: data });
    } catch (e) {
      if (!isQuotaMessage(e.message)) throw e;
      let used = 0;
      try { used = (await getBytesInUse(null)) || 0; } catch (err) {}
      throw quotaExceeded(used, used + estimateBytes(data));
    }
  }

  // 串行化所有「读取 → 修改 → 写回」操作：同上下文用本地队列兜底，
  // 支持 Web Locks 的上下文（扩展页面 / Service Worker）再跨上下文共享同一把锁，
  // 避免两个窗口或后台同步并发写时后者覆盖前者的新增数据。
  let localWriteChain = Promise.resolve();
  function withWriteLock(task) {
    const run = () => {
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      if (nav && nav.locks && typeof nav.locks.request === 'function') {
        return Promise.resolve(nav.locks.request('openpocket:storage-write', () => Promise.resolve().then(task)));
      }
      return Promise.resolve().then(task);
    };
    const result = localWriteChain.then(run, run);
    localWriteChain = result.then(() => undefined, () => undefined);
    return result;
  }

  function locked(fn) {
    return function (...args) {
      return withWriteLock(() => fn.apply(null, args));
    };
  }

  // 对外 API
  const Storage = {};

  Storage.STORAGE_KEY = STORAGE_KEY;
  Storage.BACKUP_PREFIX = BACKUP_PREFIX;
  Storage.SETTINGS_BACKUP_PREFIX = SETTINGS_BACKUP_PREFIX;
  Storage.SYNC_WATERMARK_KEY = SYNC_WATERMARK_KEY;
  Storage.SETTINGS_KEY = SETTINGS_KEY;
  Storage.QUOTA_BYTES = QUOTA_BYTES;
  Storage.QUOTA_SAFETY_BYTES = QUOTA_SAFETY_BYTES;

  Storage.load = async function () {
    const raw = await loadRaw();
    return normalize(raw);
  };

  Storage.save = locked(async function (data) {
    const normalized = normalize(data);
    await assertQuota(STORAGE_KEY, normalized);
    await saveRaw(normalized);
    return normalized;
  });

  // 在事务回调里拿到可变 data，返回后自动保存。
  // 内部直接写盘，避免与 save 的锁嵌套（Web Locks 不可重入）。
  // 预检与写盘都在同一把写锁内：并发请求会依次拿到最新用量，不会出现「两个都通过预检后一起超限」。
  Storage.mutate = locked(async function (mutator) {
    const data = await Storage.load();
    const result = await mutator(data);
    const normalized = normalize(data);
    await assertQuota(STORAGE_KEY, normalized);
    await saveRaw(normalized);
    return result === undefined ? data : result;
  });

  // ---- 分组操作 ----
  Storage.createGroup = async function (name, color, options) {
    const opts = options || {};
    return Storage.mutate((data) => {
      const idx = data.groups.filter((g) => !g.deleted).length + 1;
      const group = {
        id: Utils.uuid(),
        name: name || Utils.defaultGroupName(idx),
        color: color || Utils.PALETTE[Math.floor(Math.random() * Utils.PALETTE.length)],
        createdAt: Utils.now(),
        updatedAt: Utils.now(),
        metaUpdatedAt: Utils.now(),
        deleted: false,
        deletedAt: null,
        system: !!opts.system,
        cards: []
      };
      data.groups.push(group);
      data.activeGroupId = group.id;
      return group;
    });
  };

  Storage.renameGroup = async function (groupId, name) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId && !x.deleted);
      if (!g) throw new Error('分组不存在');
      g.name = name || g.name;
      g.updatedAt = Utils.now();
      g.metaUpdatedAt = Utils.now();
      return g;
    });
  };

  Storage.setGroupColor = async function (groupId, color) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId && !x.deleted);
      if (!g) throw new Error('分组不存在');
      g.color = color;
      g.updatedAt = Utils.now();
      g.metaUpdatedAt = Utils.now();
      return g;
    });
  };

  // 软删除分组（带墓碑，便于同步）。默认集锦（system）不可删除。
  Storage.deleteGroup = async function (groupId) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) return;
      if (g.system) {
        const err = new Error('「默认集锦」是受保护分组，不能删除');
        err.code = 'protected';
        throw err;
      }
      g.deleted = true;
      g.deletedAt = Utils.now();
      g.updatedAt = Utils.now();
      g.cards.forEach((c) => {
        c.deleted = true;
        c.deletedAt = Utils.now();
        c.updatedAt = Utils.now();
        // 墓碑只保留同步必需字段，避免长期保留大段摘录正文撑满配额（OCP-CONF-043）。
        c.notes = '';
        c.excerpt = '';
      });
      if (data.activeGroupId === groupId) {
        const alive = data.groups.find((x) => !x.deleted);
        data.activeGroupId = alive ? alive.id : null;
      }
    });
  };

  Storage.setActiveGroup = async function (groupId) {
    return Storage.mutate((data) => {
      if (data.groups.find((g) => g.id === groupId && !g.deleted)) {
        data.activeGroupId = groupId;
      }
    });
  };

  Storage.getActiveGroupId = async function () {
    const data = await Storage.load();
    return data.activeGroupId;
  };

  // ---- 卡片操作 ----
  function notCollectableError(url) {
    const err = new Error(Utils.URL_NOT_COLLECTABLE_MESSAGE);
    err.code = 'URL_NOT_COLLECTABLE';
    err.url = typeof url === 'string' ? url : '';
    return err;
  }

  function cardFromInput(cardInput) {
    const url = cardInput && typeof cardInput.url === 'string' ? cardInput.url : '';
    // 唯一写入口守卫：任何采集调用方（收藏、批量、摘录、拖拽、AI 应用）都必须经过这里，
    // 非 http/https 直接抛错，且整批不产生任何写入。
    if (!Utils.isCollectableUrl(url)) throw notCollectableError(url);
    return normalizeCard({
      id: Utils.uuid(),
      type: cardInput.type || 'page',
      title: cardInput.title || '无标题',
      url,
      favicon: cardInput.favicon || '',
      notes: cardInput.notes || '',
      excerpt: cardInput.excerpt || '',
      sourceTitle: cardInput.sourceTitle || '',
      sourceUrl: cardInput.sourceUrl || '',
      addedAt: Utils.now(),
      updatedAt: Utils.now(),
      deleted: false,
      deletedAt: null,
      pinned: !!cardInput.pinned
    });
  }

  // 切换卡片固定状态（默认集锦内的图钉按钮）。固定条目对 AI 整理与重复清理免疫。
  Storage.setCardPinned = async function (groupId, cardId, pinned) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId && !x.deleted);
      if (!g) throw new Error('分组不存在');
      const c = g.cards.find((x) => x.id === cardId && !x.deleted);
      if (!c) throw new Error('卡片不存在');
      c.pinned = !!pinned;
      c.updatedAt = Utils.now();
      g.updatedAt = Utils.now();
      return c;
    });
  };

  // 跨分组查找重复条目：网页按规范化 URL，摘录按来源 URL + 选区文本。
  // 返回 { group, card }；未命中返回 null。
  Storage.findDuplicateCard = function (data, input, options) {
    const key = Utils.cardDedupeKey(input);
    if (!key) return null;
    const excludeCardId = options && options.excludeCardId;
    const groups = (data && Array.isArray(data.groups)) ? data.groups : [];
    for (const g of groups) {
      if (g.deleted) continue;
      for (const c of g.cards || []) {
        if (c.deleted || c.id === excludeCardId) continue;
        if (Utils.cardDedupeKey(c) === key) return { group: g, card: c };
      }
    }
    return null;
  };

  // 查找全部重复链接组（仅网页卡片；摘录与固定条目不参与），按添加时间升序返回组内条目。
  Storage.findDuplicateGroups = function (data) {
    const byKey = new Map();
    const groups = (data && Array.isArray(data.groups)) ? data.groups : [];
    for (const g of groups) {
      if (g.deleted) continue;
      for (const c of g.cards || []) {
        if (c.deleted || c.type === 'excerpt' || c.pinned) continue;
        const key = Utils.cardDedupeKey(c);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ groupId: g.id, groupName: g.name, card: c });
      }
    }
    const result = [];
    for (const entries of byKey.values()) {
      if (entries.length < 2) continue;
      entries.sort((a, b) => (Number(a.card.addedAt) || 0) - (Number(b.card.addedAt) || 0));
      result.push({ key: Utils.cardDedupeKey(entries[0].card), cards: entries });
    }
    return result;
  };

  // 批量软删除指定分组内的卡片。固定（pinned）条目受保护，跳过并计数。
  Storage.deleteCards = async function (groupId, cardIds) {
    const wanted = new Set(Array.isArray(cardIds) ? cardIds : []);
    if (!wanted.size) return { removed: 0, skippedPinned: 0 };
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) return { removed: 0, skippedPinned: 0 };
      const now = Utils.now();
      let removed = 0;
      let skippedPinned = 0;
      for (const c of g.cards) {
        if (c.deleted || !wanted.has(c.id)) continue;
        if (c.pinned) { skippedPinned++; continue; }
        c.deleted = true;
        c.deletedAt = now;
        c.updatedAt = now;
        removed++;
      }
      if (removed) g.updatedAt = now;
      return { removed, skippedPinned };
    });
  };

  // 撤销重复清理：从备份快照恢复被删除的卡片（只恢复指定条目，不覆盖其他改动）。
  Storage.restoreCardsFromBackup = async function (backupKey, entries) {
    const backup = await Storage.getBackup(backupKey);
    if (!backup || !Array.isArray(backup.groups)) throw new Error('备份不存在');
    return Storage.mutate((data) => {
      const now = Utils.now();
      let restored = 0;
      for (const entry of entries || []) {
        const backupGroup = backup.groups.find((g) => g.id === entry.groupId);
        if (!backupGroup) continue;
        const backupCard = (backupGroup.cards || []).find((c) => c.id === entry.cardId);
        if (!backupCard) continue;
        const group = data.groups.find((g) => g.id === entry.groupId && !g.deleted);
        if (!group) continue;
        const existing = group.cards.find((c) => c.id === entry.cardId);
        if (existing) {
          if (!existing.deleted) continue;
          existing.deleted = false;
          existing.deletedAt = null;
          existing.updatedAt = now;
        } else {
          group.cards.push(Utils.clone(backupCard));
        }
        group.updatedAt = now;
        restored++;
      }
      return { restored };
    });
  };

  Storage.addCards = async function (groupId, cardInputs) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId && !x.deleted);
      if (!g) throw new Error('分组不存在');
      const cards = (cardInputs || []).map((cardInput) => {
        const card = cardFromInput(cardInput);
        g.cards.push(card);
        return card;
      });
      if (cards.length) g.updatedAt = Utils.now();
      return cards;
    });
  };

  Storage.addCard = async function (groupId, cardInput) {
    const cards = await Storage.addCards(groupId, [cardInput]);
    return cards[0];
  };

  // 原子批量添加：在同一个写锁事务内基于最新数据做跨分组查重，避免“先查后写”被并发绕过
  // （OCP-CONF-027）。返回 { cards, skipped }；skipped 含命中的分组信息供 UI 提示。
  Storage.addCardsChecked = async function (groupId, cardInputs, options) {
    const settings = await Storage.loadSettings();
    const opts = options || {};
    const allow = opts.allowDuplicateLinks != null
      ? !!opts.allowDuplicateLinks
      : !!(settings.behavior && settings.behavior.allowDuplicateLinks);
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId && !x.deleted);
      if (!g) throw new Error('分组不存在');
      const existing = new Map();
      for (const group of data.groups) {
        if (group.deleted) continue;
        for (const card of group.cards) {
          if (card.deleted) continue;
          const key = Utils.cardDedupeKey(card);
          if (key && !existing.has(key)) existing.set(key, { group, card });
        }
      }
      const cards = [];
      const skipped = [];
      for (const cardInput of (cardInputs || [])) {
        const card = cardFromInput(cardInput);
        const key = Utils.cardDedupeKey(card);
        if (!allow && key && existing.has(key)) {
          const hit = existing.get(key);
          skipped.push({
            groupId: hit.group.id,
            groupName: hit.group.name,
            title: hit.card.title || card.title,
            cardId: card.id
          });
          continue;
        }
        g.cards.push(card);
        cards.push(card);
        if (key) existing.set(key, { group: g, card });
      }
      if (cards.length) g.updatedAt = Utils.now();
      return { cards, skipped };
    });
  };

  // 拖拽移动：同组移到末尾；跨组复制到目标组末尾并在源组打墓碑，保证同步不复活。
  Storage.moveCardToGroup = async function (fromGroupId, cardId, toGroupId) {
    if (!fromGroupId || !cardId || !toGroupId) throw new Error('移动参数不完整');
    const settings = await Storage.loadSettings();
    const allowDuplicateLinks = !!(settings.behavior && settings.behavior.allowDuplicateLinks);
    return Storage.mutate((data) => {
      const from = data.groups.find((g) => g.id === fromGroupId && !g.deleted);
      if (!from) throw new Error('原分组不存在');
      const card = from.cards.find((c) => c.id === cardId && !c.deleted);
      if (!card) throw new Error('卡片不存在');
      const to = data.groups.find((g) => g.id === toGroupId && !g.deleted);
      if (!to) throw new Error('目标分组不存在');

      const now = Utils.now();
      if (from.id === to.id) {
        from.cards = from.cards.filter((c) => c !== card).concat([card]);
        card.updatedAt = now;
        from.updatedAt = now;
        return { sameGroup: true, cardId: card.id, sourceGroupId: from.id, targetGroupId: to.id };
      }

      if (!allowDuplicateLinks) {
        const dup = Storage.findDuplicateCard({ groups: data.groups }, card, { excludeCardId: card.id });
        if (dup) {
          const err = new Error('目标分组已存在相同链接：' + dup.group.name);
          err.code = 'duplicate';
          err.duplicate = { groupId: dup.group.id, groupName: dup.group.name, title: dup.card.title };
          throw err;
        }
      }

      const copy = Utils.clone(card);
      copy.id = Utils.uuid();
      copy.addedAt = card.addedAt;
      copy.updatedAt = now;
      // pinned 只属于受保护的默认集锦；拖入普通分组时清除，避免“隐形固定”无法取消（OCP-CONF-019）。
      if (!to.system) copy.pinned = false;
      to.cards.push(copy);

      card.deleted = true;
      card.deletedAt = now;
      card.updatedAt = now;
      card.notes = '';
      card.excerpt = '';
      from.updatedAt = now;
      to.updatedAt = now;
      return { sameGroup: false, cardId: copy.id, sourceGroupId: from.id, targetGroupId: to.id };
    });
  };

  // ---- 每日标签页（OneTab 模式）----
  Storage.isDailyGroup = function (group) {
    return !!(group && typeof group.id === 'string' &&
      /^daily-\d{4}-\d{2}-\d{2}$/.test(group.id));
  };

  // 当天多次收藏追加到同一个每日分组；分组被删除时复活并继续追加。
  // 与普通批量添加一样在写锁内做原子查重（OCP-CONF-027）。
  Storage.addCardsToDailyGroup = async function (dateKey, cardInputs, options) {
    const key = String(dateKey || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('日期格式不正确');
    if (!Array.isArray(cardInputs) || cardInputs.length === 0) {
      throw new Error('没有要收藏的标签页');
    }
    const settings = await Storage.loadSettings();
    const opts = options || {};
    const allow = opts.allowDuplicateLinks != null
      ? !!opts.allowDuplicateLinks
      : !!(settings.behavior && settings.behavior.allowDuplicateLinks);
    return Storage.mutate((data) => {
      const id = DAILY_GROUP_PREFIX + key;
      const now = Utils.now();
      let group = data.groups.find((x) => x.id === id);
      let created = false;
      let revived = false;
      if (!group) {
        group = {
          id,
          name: key,
          color: Utils.PALETTE[0],
          createdAt: now,
          updatedAt: now,
          metaUpdatedAt: now,
          deleted: false,
          deletedAt: null,
          cards: []
        };
        data.groups.push(group);
        created = true;
      } else if (group.deleted) {
        group.deleted = false;
        group.deletedAt = null;
        group.updatedAt = now;
        group.metaUpdatedAt = now;
        revived = true;
      }
      const existing = new Map();
      for (const g of data.groups) {
        if (g.deleted) continue;
        for (const c of g.cards) {
          if (c.deleted) continue;
          const k = Utils.cardDedupeKey(c);
          if (k && !existing.has(k)) existing.set(k, { group: g, card: c });
        }
      }
      const cards = [];
      const skipped = [];
      for (const cardInput of cardInputs) {
        const card = cardFromInput(cardInput);
        const cardKey = Utils.cardDedupeKey(card);
        if (!allow && cardKey && existing.has(cardKey)) {
          const hit = existing.get(cardKey);
          skipped.push({ groupId: hit.group.id, groupName: hit.group.name, title: hit.card.title || card.title });
          continue;
        }
        group.cards.push(card);
        cards.push(card);
        if (cardKey) existing.set(cardKey, { group, card });
      }
      group.updatedAt = now;
      data.activeGroupId = group.id;
      return { group, cards, created, revived, skipped };
    });
  };

  // 应用 AI 整理方案：可来自多个源分组；优先复用规范化同名的已有分组，否则新建；卡片复制后原卡片打墓碑。
  // 默认按规范化 URL 跳过目标分组中已存在的重复链接；allowDuplicateLinks 为 true 时全部写入。
  Storage.applyOrganizePlan = async function (plan) {
    plan = plan || {};
    const settings = await Storage.loadSettings();
    const allowDuplicateLinks = plan.allowDuplicateLinks != null
      ? !!plan.allowDuplicateLinks
      : !!(settings.behavior && settings.behavior.allowDuplicateLinks);
    return Storage.mutate((data) => {
      const sourceIds = Array.isArray(plan.sourceGroupIds) && plan.sourceGroupIds.length
        ? plan.sourceGroupIds
        : (plan.sourceGroupId ? [plan.sourceGroupId] : []);
      const sources = data.groups.filter((g) => !g.deleted && sourceIds.includes(g.id));
      if (!sources.length) throw new Error('原分组不存在');
      const sourceIdSet = new Set(sources.map((g) => g.id));
      const sourceCards = new Map();
      for (const g of sources) {
        for (const c of g.cards) {
          if (!c.deleted && !c.pinned) sourceCards.set(c.id, { group: g, card: c });
        }
      }

      const specs = Array.isArray(plan.groups) ? plan.groups : [];
      const now = Utils.now();
      const baseColorIndex = data.groups.filter((g) => !g.deleted).length;
      const createdGroups = [];
      const reusedGroups = [];
      const moves = [];
      const updatedSources = new Set();
      let movedCards = 0;
      let skippedDuplicates = 0;

      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        if (!spec || !Array.isArray(spec.cardIds)) continue;
        const picked = [];
        const seen = new Set();
        for (const id of spec.cardIds) {
          if (typeof id !== 'string' || seen.has(id)) continue;
          seen.add(id);
          const entry = sourceCards.get(id);
          if (entry) {
            // AI 应用同样不能把非 http/https 条目写进目标分组：任一不合法即整次拒绝。
            if (!Utils.isCollectableUrl(entry.card.url)) throw notCollectableError(entry.card.url);
            picked.push(entry);
          }
        }
        if (!picked.length) continue;

        let name = typeof spec.name === 'string' ? spec.name.trim() : '';
        if (!name) name = '整理 ' + (i + 1);
        const nameKey = Utils.normalizeName(name);

        // 按规范化名称复用已有分组（包括源分组）：staysInSource 已保证卡片原分组与目标同名时不会被移动，
        // 因此复用同名源分组不会造成自移动，只避免创建重复同名组（OCP-CONF-023）。
        let target = data.groups.find((g) =>
          !g.deleted && Utils.normalizeName(g.name) === nameKey);
        const reused = !!target;

        if (!target) {
          const color = typeof spec.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(spec.color)
            ? spec.color
            : Utils.PALETTE[(baseColorIndex + createdGroups.length) % Utils.PALETTE.length];
          target = {
            id: Utils.uuid(),
            name,
            color,
            createdAt: now,
            updatedAt: now,
            metaUpdatedAt: now,
            deleted: false,
            deletedAt: null,
            cards: []
          };
          data.groups.push(target);
        }

        // 目标分组已有的去重键，用于默认关闭「允许重复」时跳过重复链接。
        const existingKeys = new Set();
        if (!allowDuplicateLinks) {
          for (const c of target.cards) {
            if (c.deleted) continue;
            const key = Utils.cardDedupeKey(c);
            if (key) existingKeys.add(key);
          }
        }

        for (const entry of picked) {
          sourceCards.delete(entry.card.id);
          if (!allowDuplicateLinks) {
            const key = Utils.cardDedupeKey(entry.card);
            if (key && existingKeys.has(key)) {
              skippedDuplicates++;
              continue;
            }
            if (key) existingKeys.add(key);
          }
          const copy = Utils.clone(entry.card);
          copy.id = Utils.uuid();
          copy.addedAt = entry.card.addedAt;
          copy.updatedAt = now;
          target.cards.push(copy);
          // 记录条目级撤销所需的原卡片快照（内存中返回，不写入 storage）。
          moves.push({
            sourceGroupId: entry.group.id,
            sourceCardId: entry.card.id,
            targetGroupId: target.id,
            targetCardId: copy.id,
            sourceSnapshot: Utils.clone(entry.card)
          });
          entry.card.deleted = true;
          entry.card.deletedAt = now;
          entry.card.updatedAt = now;
          entry.card.notes = '';
          entry.card.excerpt = '';
          updatedSources.add(entry.group);
          movedCards++;
        }

        target.updatedAt = now;
        if (reused) reusedGroups.push({ id: target.id, name: target.name, count: picked.length });
        else createdGroups.push({ id: target.id, name: target.name, count: target.cards.length });
      }

      updatedSources.forEach((g) => { g.updatedAt = now; });
      return { createdGroups, reusedGroups, moves, movedCards, skippedDuplicates };
    });
  };

  // 条目级撤销 AI 整理：只回滚本次计划涉及的卡片/新建分组，不覆盖应用后的其它编辑（OCP-CONF-034）。
  Storage.undoOrganizePlan = async function (undo) {
    undo = undo || {};
    const moves = Array.isArray(undo.moves) ? undo.moves : [];
    const createdGroupIds = Array.isArray(undo.createdGroupIds) ? undo.createdGroupIds : [];
    if (!moves.length && !createdGroupIds.length) return { restored: 0 };
    return Storage.mutate((data) => {
      const now = Utils.now();
      let restored = 0;
      for (const move of moves.slice().reverse()) {
        const target = data.groups.find((g) => g.id === move.targetGroupId);
        if (target) {
          const tc = target.cards.find((c) => c.id === move.targetCardId && !c.deleted);
          if (tc) {
            tc.deleted = true;
            tc.deletedAt = now;
            tc.updatedAt = now;
            tc.notes = '';
            tc.excerpt = '';
          }
        }
        const source = data.groups.find((g) => g.id === move.sourceGroupId);
        if (source && move.sourceSnapshot) {
          const sc = source.cards.find((c) => c.id === move.sourceCardId);
          if (sc) {
            Object.assign(sc, Utils.clone(move.sourceSnapshot));
            sc.deleted = false;
            sc.deletedAt = null;
            sc.updatedAt = now;
            restored++;
          }
        }
        if (target) target.updatedAt = now;
        if (source) source.updatedAt = now;
      }
      for (const id of createdGroupIds) {
        const g = data.groups.find((x) => x.id === id);
        if (g && g.cards.every((c) => c.deleted)) {
          g.deleted = true;
          g.deletedAt = now;
          g.updatedAt = now;
        }
      }
      return { restored };
    });
  };

  Storage.updateCard = async function (groupId, cardId, patch) {
    const settings = await Storage.loadSettings();
    const allowDuplicateLinks = !!(settings.behavior && settings.behavior.allowDuplicateLinks);
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) throw new Error('分组不存在');
      const c = g.cards.find((x) => x.id === cardId);
      if (!c) throw new Error('卡片不存在');
      const prevUrl = c.url;
      const prevExcerpt = c.excerpt;
      const allowed = ['title', 'notes', 'favicon', 'url', 'excerpt'];
      for (const k of allowed) {
        if (k in patch) c[k] = typeof patch[k] === 'string' ? patch[k] : c[k];
      }
      // 编辑只允许把链接改成 http/https；历史遗留的非网页卡片仍可改标题/笔记（URL 未变时不拦）。
      if (typeof patch.url === 'string' && patch.url !== prevUrl && !Utils.isCollectableUrl(patch.url)) {
        throw notCollectableError(patch.url);
      }
      // 编辑 URL/摘录同样要遵守跨分组去重（OCP-CONF-020）。
      if (!allowDuplicateLinks && (c.url !== prevUrl || c.excerpt !== prevExcerpt)) {
        const dup = Storage.findDuplicateCard({ groups: data.groups }, c, { excludeCardId: c.id });
        if (dup) {
          const err = new Error('已存在相同链接：' + dup.group.name);
          err.code = 'duplicate';
          err.duplicate = { groupId: dup.group.id, groupName: dup.group.name, title: dup.card.title };
          throw err;
        }
      }
      c.updatedAt = Utils.now();
      g.updatedAt = Utils.now();
      return c;
    });
  };

  Storage.deleteCard = async function (groupId, cardId) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) return;
      const c = g.cards.find((x) => x.id === cardId);
      if (!c) return;
      c.deleted = true;
      c.deletedAt = Utils.now();
      c.updatedAt = Utils.now();
      g.updatedAt = Utils.now();
    });
  };

  // 重新排序卡片（传入新顺序的 id 数组）。
  Storage.reorderCards = async function (groupId, orderedIds) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) return;
      const alive = g.cards.filter((c) => !c.deleted);
      const map = new Map(alive.map((c) => [c.id, c]));
      const reordered = [];
      for (const id of orderedIds) {
        if (map.has(id)) {
          reordered.push(map.get(id));
          map.delete(id);
        }
      }
      // 把未包含在 orderedIds 里的追加到末尾。
      for (const c of map.values()) reordered.push(c);
      g.cards = reordered.concat(g.cards.filter((c) => c.deleted));
      g.updatedAt = Utils.now();
    });
  };

  // ---- 导入导出 ----
  Storage.exportJSON = async function () {
    const data = await Storage.load();
    // 导出时剔除已删除（墓碑）项，保持导出文件干净。
    const cleaned = {
      version: data.version,
      exportedAt: Utils.now(),
      groups: data.groups
        .filter((g) => !g.deleted)
        .map((g) => ({
          ...g,
          cards: g.cards.filter((c) => !c.deleted)
        }))
    };
    return JSON.stringify(cleaned, null, 2);
  };

  // 导入 JSON：merge=true 合并（按 id 冲突取较新或保留现有），false 覆盖。
  Storage.importJSON = async function (jsonText, opts) {
    opts = opts || {};
    const merge = opts.merge !== false;
    let incoming;
    try {
      incoming = JSON.parse(jsonText);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    if (!incoming || !Array.isArray(incoming.groups)) {
      throw new Error('JSON 格式不正确：缺少 groups 数组');
    }

    if (!merge) {
      // 覆盖：先做本地备份再写入；整段持锁，避免与并发的卡片写入互相覆盖。
      return withWriteLock(async () => {
        await Storage.createBackup('import-overwrite');
        const fresh = normalize({ groups: incoming.groups, activeGroupId: null });
        fresh.activeGroupId = fresh.groups[0] ? fresh.groups[0].id : null;
        const normalized = normalize(fresh);
        await assertQuota(STORAGE_KEY, normalized);
        await saveRaw(normalized);
        return { groups: normalized.groups.length };
      });
    }

    // 合并：按 id 合并分组与卡片，冲突时取 updatedAt 较新者。
    return Storage.mutate((data) => {
      const groupMap = new Map(data.groups.map((g) => [g.id, g]));
      let addedGroups = 0;
      let addedCards = 0;
      for (const ig of incoming.groups) {
        const ng = normalizeGroup(ig);
        if (!ng) continue;
        const existing = groupMap.get(ng.id);
        if (!existing) {
          data.groups.push(ng);
          groupMap.set(ng.id, ng);
          addedGroups++;
          addedCards += ng.cards.length;
          continue;
        }
        // 分组级冲突取较新（用组元数据时间）；不恢复已删除分组。
        if (existing.deleted) continue;
        if ((ng.metaUpdatedAt || 0) >= (existing.metaUpdatedAt || 0)) {
          existing.name = ng.name;
          existing.color = ng.color;
          existing.metaUpdatedAt = ng.metaUpdatedAt || Utils.now();
          existing.updatedAt = Utils.now();
        }
        const cardMap = new Map(existing.cards.map((c) => [c.id, c]));
        for (const ic of ng.cards) {
          const nc = normalizeCard(ic);
          if (!nc) continue;
          const ec = cardMap.get(nc.id);
          if (!ec) {
            existing.cards.push(nc);
            cardMap.set(nc.id, nc);
            addedCards++;
          } else if (!ec.deleted && nc.updatedAt >= ec.updatedAt) {
            Object.assign(ec, nc);
            ec.updatedAt = Utils.now();
          }
        }
      }
      if (!data.activeGroupId && data.groups[0]) data.activeGroupId = data.groups[0].id;
      return { groups: addedGroups, cards: addedCards };
    });
  };

  // 导出为 Netscape 书签 HTML（可导入浏览器收藏夹）。
  Storage.exportBookmarksHTML = async function () {
    const data = await Storage.load();
    const lines = [];
    lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    lines.push('<!-- This is an automatically generated file from Open Collections. -->');
    lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    lines.push('<TITLE>Open Collections 书签导出</TITLE>');
    lines.push('<H1>Open Collections 书签</H1>');
    lines.push('<DL><p>');
    for (const g of data.groups) {
      if (g.deleted) continue;
      const dt = new Date(g.createdAt);
      lines.push(`<DT><H3 ADD_DATE="${Math.floor(dt.getTime() / 1000)}">${Utils.escapeHtml(g.name)}</H3>`);
      lines.push('<DL><p>');
      for (const c of g.cards) {
        if (c.deleted) continue;
        if (c.type === 'excerpt') {
          // 摘录卡片：用分隔符与说明文本表示。
          lines.push(`<DT><A HREF="${Utils.escapeHtml(c.sourceUrl || c.url || '#')}" ADD_DATE="${Math.floor(c.addedAt / 1000)}">[摘录] ${Utils.escapeHtml(c.title)}</A>`);
          if (c.excerpt) {
            lines.push(`<DD>${Utils.escapeHtml(c.excerpt)}`);
          }
        } else {
          const url = c.url || '#';
          lines.push(`<DT><A HREF="${Utils.escapeHtml(url)}" ADD_DATE="${Math.floor(c.addedAt / 1000)}">${Utils.escapeHtml(c.title)}</A>`);
          if (c.notes) {
            lines.push(`<DD>${Utils.escapeHtml(c.notes)}`);
          }
        }
      }
      lines.push('</DL><p>');
    }
    lines.push('</DL><p>');
    return lines.join('\n');
  };

  // ---- 备份（用于同步前快照）----
  // 备份和主数据共享 10 MiB 配额：写前腾出保留名额并做配额预检，写后裁剪到最多 10 份，
  // 避免 AI/去重/失败同步无限累积快照最终阻塞所有保存（OCP-CONF-009）。
  Storage.createBackup = async function (reason) {
    const data = await Storage.load();
    await Storage.clearOldBackups(9);
    const suffix = Math.random().toString(36).slice(2, 8);
    const key = BACKUP_PREFIX + Date.now() + '-' + (reason || 'manual') + '-' + suffix;
    await assertQuota(key, data);
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: data }, () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message;
          if (isQuotaMessage(message)) {
            reject(quotaExceeded(0, estimateBytes(data)));
          } else {
            reject(new Error(message));
          }
        } else {
          resolve();
        }
      });
    });
    await Storage.clearOldBackups(10);
    return key;
  };

  Storage.listBackups = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        const keys = Object.keys(items || {}).filter((k) => k.startsWith(BACKUP_PREFIX));
        resolve(
          keys
            .map((k) => ({ key: k, ts: Number(k.slice(BACKUP_PREFIX.length).split('-')[0]) || 0 }))
            .sort((a, b) => (b.ts - a.ts) || b.key.localeCompare(a.key))
        );
      });
    });
  };

  Storage.getBackup = async function (key) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (items) => {
        if (chrome.runtime.lastError) reject(storageReadFailed(chrome.runtime.lastError.message));
        else if (items == null || typeof items !== 'object') reject(storageReadFailed('备份返回数据无效'));
        else resolve(items[key]);
      });
    });
  };

  Storage.deleteBackup = async function (key) {
    if (typeof key !== 'string' || !key) return;
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, () => resolve());
    });
  };

  Storage.restoreBackup = async function (key) {
    const data = await Storage.getBackup(key);
    if (!data) throw new Error('备份不存在');
    if (!Array.isArray(data.groups)) {
      throw new Error('备份格式不正确：不是收藏数据快照');
    }
    await Storage.save(data);
  };

  Storage.clearOldBackups = async function (keep) {
    keep = keep || 10;
    const list = await Storage.listBackups();
    const toRemove = list.slice(keep).map((b) => b.key);
    if (!toRemove.length) return;
    return new Promise((resolve) => {
      chrome.storage.local.remove(toRemove, () => resolve());
    });
  };

  // 设置导入备份使用独立命名空间：不进入集合备份列表、不会被当集合快照上传或恢复。
  Storage.clearOldSettingsBackups = async function (keep) {
    keep = keep || 5;
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        const keys = Object.keys(items || {}).filter((k) => k.startsWith(SETTINGS_BACKUP_PREFIX));
        const sorted = keys
          .map((k) => ({ key: k, ts: Number(k.slice(SETTINGS_BACKUP_PREFIX.length).split('-')[0]) || 0 }))
          .sort((a, b) => (b.ts - a.ts) || b.key.localeCompare(a.key));
        const toRemove = sorted.slice(keep).map((b) => b.key);
        if (!toRemove.length) {
          resolve();
          return;
        }
        chrome.storage.local.remove(toRemove, () => resolve());
      });
    });
  };

  // 同步水位：成功同步后记录；墓碑 GC 只清理早于水位 90 天的旧墓碑，避免刚删除的项
  // 在另一台离线设备上复活（OCP-CONF-043）。
  Storage.setSyncWatermark = async function (ts) {
    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) return;
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [SYNC_WATERMARK_KEY]: { at: value } }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(value);
      });
    });
  };

  Storage.getSyncWatermark = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(SYNC_WATERMARK_KEY, (items) => {
        const raw = items && items[SYNC_WATERMARK_KEY];
        resolve(raw && Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0);
      });
    });
  };

  Storage.pruneTombstones = async function (watermark) {
    const at = Number(watermark);
    if (!Number.isFinite(at) || at <= 0) return { removedGroups: 0, removedCards: 0 };
    const cutoff = at - 90 * 24 * 60 * 60 * 1000;
    return Storage.mutate((data) => {
      let removedGroups = 0;
      let removedCards = 0;
      data.groups = data.groups.filter((g) => {
        if (g.deleted && Number.isFinite(Number(g.deletedAt)) && Number(g.deletedAt) < cutoff) {
          removedGroups++;
          return false;
        }
        g.cards = g.cards.filter((c) => {
          if (c.deleted && Number.isFinite(Number(c.deletedAt)) && Number(c.deletedAt) < cutoff) {
            removedCards++;
            return false;
          }
          return true;
        });
        return true;
      });
      return { removedGroups, removedCards };
    });
  };

  // ---- 设置（WebDAV、收藏行为等）----
  const SECRET_FIELDS = [
    { name: 'webdavUsername', path: ['webdav', 'username'], label: 'WebDAV 用户名' },
    { name: 'webdavPassword', path: ['webdav', 'password'], label: 'WebDAV 密码' },
    { name: 'aiApiKey', path: ['ai', 'apiKey'], label: 'AI API Key' }
  ];
  Storage.SECRET_FIELDS = SECRET_FIELDS.map((f) => ({ name: f.name, label: f.label }));

  function readPath(obj, path) {
    let cur = obj;
    for (const key of path) {
      if (!cur || typeof cur !== 'object') return '';
      cur = cur[key];
    }
    return typeof cur === 'string' ? cur : '';
  }

  function writePath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (!cur[path[i]] || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
  }

  function secretEnvelope(raw) {
    return raw && typeof raw === 'object' &&
      typeof raw.iv === 'string' && typeof raw.v === 'string'
      ? { iv: raw.iv, v: raw.v }
      : null;
  }

  function hasPlaintextSecrets(settings) {
    return SECRET_FIELDS.some((field) => readPath(settings, field.path) !== '');
  }

  // 导出/同步 URL 前剥离 userinfo，避免历史数据把凭据写进设置文件或远端（OCP-CONF-040）。
  function redactUrlUserinfo(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return raw;
    try {
      const u = new URL(raw);
      if (!u.username && !u.password) return raw;
      u.username = '';
      u.password = '';
      return u.toString();
    } catch (e) {
      return raw;
    }
  }
  function assertSettingsUrls(settings) {
    if (!settings || typeof settings !== 'object') return;
    const wd = settings.webdav;
    if (wd && typeof wd.url === 'string' && wd.url.trim()) {
      Utils.requireHttpsUrl(wd.url, 'WebDAV 服务器地址');
    }
    const ai = settings.ai;
    if (ai && typeof ai.baseUrl === 'string' && ai.baseUrl.trim()) {
      Utils.requireHttpsUrl(ai.baseUrl, 'AI 接口地址');
    }
  }

  // 远端/导入设置不能替用户在本地首次启用网络功能：本地为 false 时强制保持 false，
  // 用户必须在本机手动启用并走首次确认（OCP-CONF-014）。
  function guardNetworkEnabled(local, next) {
    if (!next || !next.webdav || !next.ai) return;
    const localEnabled = !!(local && local.webdav && local.webdav.enabled);
    const localAutoSync = !!(local && local.webdav && local.webdav.autoSync);
    const localAiEnabled = !!(local && local.ai && local.ai.enabled);
    if (!localEnabled) next.webdav.enabled = false;
    if (!localAutoSync) next.webdav.autoSync = false;
    if (!localAiEnabled) next.ai.enabled = false;
  }

  function normalizeSettings(raw) {
    const base = Utils.clone(DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return base;
    const webdav = raw.webdav && typeof raw.webdav === 'object' ? raw.webdav : {};
    const syncScope = webdav.syncScope && typeof webdav.syncScope === 'object' ? webdav.syncScope : {};
    base.webdav = {
      enabled: !!webdav.enabled,
      url: typeof webdav.url === 'string' ? webdav.url : '',
      username: typeof webdav.username === 'string' ? webdav.username : '',
      password: typeof webdav.password === 'string' ? webdav.password : '',
      remoteDir: typeof webdav.remoteDir === 'string' && webdav.remoteDir ? webdav.remoteDir : '/open-collections',
      autoSync: !!webdav.autoSync,
      intervalMinutes: Math.max(5, Number(webdav.intervalMinutes) || 30),
      syncScope: {
        aiCache: !!syncScope.aiCache,
        backups: !!syncScope.backups
      }
    };
    const behavior = raw.behavior && typeof raw.behavior === 'object' ? raw.behavior : {};
    base.behavior = {
      batchCollectDaily: !!behavior.batchCollectDaily,
      aiIncludeInbox: !!behavior.aiIncludeInbox,
      allowDuplicateLinks: !!behavior.allowDuplicateLinks
    };
    const ai = raw.ai && typeof raw.ai === 'object' ? raw.ai : {};
    // 迁移：默认分类「开发编程」更名为「开发」，存量分类表精确匹配项同步改名并去重。
    const renamedCategories = Utils.normalizeCategories(ai.categories)
      .map((c) => (c === '开发编程' ? '开发' : c))
      .filter((c, i, arr) => arr.indexOf(c) === i);
    const categories = renamedCategories;
    base.ai = {
      enabled: !!ai.enabled,
      baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl : '',
      apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '',
      model: typeof ai.model === 'string' ? ai.model : '',
      categories: categories.length ? categories : DEFAULT_SETTINGS.ai.categories.slice()
    };

    // security 只用于识别「旧版主密码加密数据」是否待迁移；新版本不再创建该段。
    base.security = null;
    const security = raw.security && typeof raw.security === 'object' ? raw.security : null;
    if (security && security.enabled) {
      base.security = {
        enabled: true,
        iterations: Number(security.iterations) || 600000,
        salt: typeof security.salt === 'string' ? security.salt : '',
        check: secretEnvelope(security.check)
      };
    }
    // secretsV：0=无加密凭据；1=旧版主密码加密（待迁移）；2=免密保险库加密。
    base.secretsV = Number(raw.secretsV) || (base.security ? 1 : 0);
    const secrets = raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {};
    base.secrets = {};
    for (const field of SECRET_FIELDS) {
      const envelope = secretEnvelope(secrets[field.name]);
      if (envelope) base.secrets[field.name] = envelope;
    }
    // 明文凭据绝不留在磁盘：新版本 encryptInputs 前统一清除；旧版主密码数据本身也不含明文。
    if (base.secretsV) {
      for (const field of SECRET_FIELDS) writePath(base, field.path, '');
    }

    // 保留未知顶层字段，便于后续增加配置段时不丢数据。
    for (const key of Object.keys(raw)) {
      if (key !== 'webdav' && key !== 'behavior' && key !== 'ai' &&
        key !== 'security' && key !== 'secrets' && key !== 'secretsV') base[key] = raw[key];
    }
    return base;
  }

  function writeSettings(settings) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [SETTINGS_KEY]: settings }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  Storage.loadSettings = async function () {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(SETTINGS_KEY, (items) => {
          if (chrome.runtime.lastError) {
            reject(storageReadFailed(chrome.runtime.lastError.message));
            return;
          }
          if (items == null || typeof items !== 'object') {
            reject(storageReadFailed('设置返回数据无效'));
            return;
          }
          resolve(normalizeSettings(items[SETTINGS_KEY]));
        });
      } catch (e) {
        reject(storageReadFailed(e && e.message));
      }
    });
  };

  // 合并写入，避免只保存某一个配置段时清空其他配置。
  // 敏感字段：写入前用免密保险库密钥加密，明文字段绝不落盘；全程无感，无需密码。
  Storage.updateSettings = locked(async function (patch) {
    const current = await Storage.loadSettings();
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = normalizeSettings({
      ...current,
      ...p,
      webdav: {
        ...current.webdav,
        ...(p.webdav || {}),
        syncScope: { ...(current.webdav.syncScope || {}), ...((p.webdav || {}).syncScope || {}) }
      },
      behavior: { ...current.behavior, ...(p.behavior || {}) },
      ai: { ...current.ai, ...(p.ai || {}) },
      security: current.security,
      secrets: current.secrets,
      secretsV: current.secretsV
    });

    const inputs = {};
    for (const field of SECRET_FIELDS) {
      const value = readPath(p, field.path);
      if (typeof value === 'string' && value.trim()) inputs[field.name] = value;
    }
    // 传输安全：保存时即拒绝 http 地址，避免凭据与内容明文传输。
    if (p.webdav && typeof p.webdav.url === 'string' && p.webdav.url.trim()) {
      Utils.requireHttpsUrl(p.webdav.url, 'WebDAV 服务器地址');
    }
    if (p.ai && typeof p.ai.baseUrl === 'string' && p.ai.baseUrl.trim()) {
      Utils.requireHttpsUrl(p.ai.baseUrl, 'AI 接口地址');
    }
    if (Object.keys(inputs).length) {
      if (current.secretsV === 1) {
        const err = new Error('检测到旧版主密码加密的数据：请先在「设置 → 本地加密」完成一次性迁移，再修改凭据');
        err.code = 'legacy';
        throw err;
      }
      const key = await Vault.ensureKey();
      for (const name of Object.keys(inputs)) {
        next.secrets[name] = await Vault.encrypt(key, inputs[name]);
      }
      next.secretsV = 2;
    }
    // 已加密时，绝不把明文写回磁盘。
    if (next.secretsV) {
      for (const field of SECRET_FIELDS) writePath(next, field.path, '');
    }
    // 记录参与同步的设置键的最后修改时间（供 WebDAV 键级合并）。
    // 时间戳先写、设置后写：writeSettings 是本函数最后一个 await，
    // 保证调用方在设置落盘后能同步继续后续 UI 更新（避免轮询竞态）。
    const meta = await loadSettingsMeta();
    const stampNow = Utils.now();
    let metaChanged = false;
    for (const keyPath of SYNC_SETTINGS_KEYS) {
      if (JSON.stringify(readKeyPath(current, keyPath)) !== JSON.stringify(readKeyPath(next, keyPath))) {
        meta.keys[keyPath] = stampNow;
        metaChanged = true;
      }
    }
    if (metaChanged) await saveSettingsMeta(meta);
    await writeSettings(next);
    return next;
  });

  // ---- 设置同步：键级 last-writer-wins（凭据与保险库密钥永不参与）----
  const SETTINGS_META_KEY = 'openpocket:settings-meta';
  Storage.SETTINGS_META_KEY = SETTINGS_META_KEY;

  // 参与同步的设置键（secrets/secretsV/security 与凭据字段不在列）。
  const SYNC_SETTINGS_KEYS = [
    'webdav.enabled', 'webdav.url', 'webdav.remoteDir', 'webdav.autoSync', 'webdav.intervalMinutes',
    'webdav.syncScope.aiCache', 'webdav.syncScope.backups',
    'behavior.batchCollectDaily', 'behavior.aiIncludeInbox', 'behavior.allowDuplicateLinks',
    'ai.enabled', 'ai.baseUrl', 'ai.model', 'ai.categories'
  ];
  Storage.SYNC_SETTINGS_KEYS = SYNC_SETTINGS_KEYS.slice();

  function readKeyPath(obj, dotted) {
    let cur = obj;
    for (const part of dotted.split('.')) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function writeKeyPath(obj, dotted, value) {
    const parts = dotted.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function loadSettingsMeta() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(SETTINGS_META_KEY, (items) => {
          if (chrome.runtime.lastError) {
            reject(storageReadFailed(chrome.runtime.lastError.message));
            return;
          }
          if (items == null || typeof items !== 'object') {
            reject(storageReadFailed('同步时间戳返回数据无效'));
            return;
          }
          const raw = items[SETTINGS_META_KEY];
          const keys = raw && typeof raw.keys === 'object' && raw.keys ? raw.keys : {};
          resolve({ v: 1, keys: Object.assign({}, keys) });
        });
      } catch (e) {
        reject(storageReadFailed(e && e.message));
      }
    });
  }
  Storage.loadSettingsMeta = loadSettingsMeta;

  function saveSettingsMeta(meta) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [SETTINGS_META_KEY]: meta }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  // 导出用于同步的设置：只含 SYNC_SETTINGS_KEYS，绝不含凭据、密文与设备专属值。
  Storage.exportSettingsForSync = async function () {
    const settings = await Storage.loadSettings();
    const meta = await loadSettingsMeta();
    const out = {};
    const keys = {};
    for (const keyPath of SYNC_SETTINGS_KEYS) {
      writeKeyPath(out, keyPath, Utils.clone(readKeyPath(settings, keyPath)));
      keys[keyPath] = Number(meta.keys[keyPath]) || 0;
    }
    if (out.webdav && typeof out.webdav.url === 'string') {
      out.webdav.url = redactUrlUserinfo(out.webdav.url);
    }
    if (out.ai && typeof out.ai.baseUrl === 'string') {
      out.ai.baseUrl = redactUrlUserinfo(out.ai.baseUrl);
    }
    return { settings: out, keys };
  };

  // 合并远端设置：按每个键的最后修改时间取新；force（仅下载）时远端全量覆盖。
  // 不触碰凭据、secrets 与保险库。返回 { changed: string[] }。
  Storage.applySyncedSettings = locked(async function (remoteSettings, remoteKeys, options) {
    const force = !!(options && options.force);
    const local = await Storage.loadSettings();
    const meta = await loadSettingsMeta();
    assertSettingsUrls(remoteSettings);
    const next = Utils.clone(local);
    const changed = [];
    for (const keyPath of SYNC_SETTINGS_KEYS) {
      const remoteValue = readKeyPath(remoteSettings || {}, keyPath);
      if (remoteValue === undefined) continue;
      const rts = Number(remoteKeys && remoteKeys[keyPath]) || 0;
      const lts = Number(meta.keys[keyPath]) || 0;
      if (!force && rts <= lts) continue;
      if (JSON.stringify(readKeyPath(next, keyPath)) !== JSON.stringify(remoteValue)) {
        writeKeyPath(next, keyPath, Utils.clone(remoteValue));
        changed.push(keyPath);
      }
      meta.keys[keyPath] = Math.max(lts, rts);
    }
    // 凭据与加密状态始终保持本地值，远端内容绝不含这些字段。
    next.webdav.username = local.webdav.username;
    next.webdav.password = local.webdav.password;
    next.ai.apiKey = local.ai.apiKey;
    next.security = local.security;
    next.secrets = local.secrets;
    next.secretsV = local.secretsV;
    guardNetworkEnabled(local, next);
    await writeSettings(normalizeSettings(next));
    await saveSettingsMeta(meta);
    return { changed };
  });

  // 读取并解密全部敏感字段；只在调用方即将使用时临时解密。
  Storage.loadSecrets = async function () {
    const settings = await Storage.loadSettings();
    if (settings.secretsV === 1) {
      const err = new Error('检测到旧版主密码加密的数据：请先在「设置 → 本地加密」完成一次性迁移');
      err.code = 'legacy';
      throw err;
    }
    // 历史明文凭据（主密码功能出现之前的旧版本）：自动用保险库密钥加密，无需用户介入。
    if (hasPlaintextSecrets(settings)) {
      await migratePlaintextSecrets();
      return Storage.loadSecrets();
    }
    const out = {};
    const envelopes = settings.secrets || {};
    const names = Object.keys(envelopes).filter((name) => envelopes[name]);
    if (!names.length) {
      for (const field of SECRET_FIELDS) out[field.name] = '';
      return out;
    }
    const key = await Vault.ensureKey();
    for (const field of SECRET_FIELDS) {
      const envelope = envelopes[field.name];
      if (!envelope) {
        out[field.name] = '';
        continue;
      }
      try {
        out[field.name] = await Vault.decrypt(key, envelope);
      } catch (e) {
        const err = new Error('凭据解密失败：本地密钥可能已被重置，请重新填写凭据');
        err.code = 'decrypt';
        throw err;
      }
    }
    return out;
  };

  // 旧版明文（无 security 段的早期版本）静默迁移到保险库加密；失败回滚，不丢数据。
  const migratePlaintextSecrets = locked(async function () {
    const settings = await Storage.loadSettings();
    if (settings.secretsV === 1 || !hasPlaintextSecrets(settings)) return settings;
    const key = await Vault.ensureKey();
    const secrets = {};
    for (const field of SECRET_FIELDS) {
      const plain = readPath(settings, field.path);
      if (plain) secrets[field.name] = await Vault.encrypt(key, plain);
    }
    const next = normalizeSettings({
      ...settings,
      secrets,
      secretsV: 2,
      security: null
    });
    await writeSettings(next);
    return next;
  });
  Storage.migratePlaintextSecrets = migratePlaintextSecrets;

  // 旧版主密码数据的一次性迁移：输入旧密码 → 解出明文 → 立即用保险库密钥重封装。
  // 原子写入；失败时旧密文原样保留，可重试，绝不丢数据。
  Storage.migrateLegacySecrets = locked(async function (password) {
    const settings = await Storage.loadSettings();
    if (!settings.security || !settings.security.enabled) {
      return { migrated: false, reason: 'no-legacy' };
    }
    const legacyKey = await Vault.verifyLegacyPassword(password, settings.security);
    const plain = {};
    for (const field of SECRET_FIELDS) {
      const envelope = settings.secrets[field.name];
      if (!envelope) continue;
      plain[field.name] = await Vault.decryptLegacy(legacyKey, envelope);
    }
    const vaultKey = await Vault.ensureKey();
    const secrets = {};
    for (const name of Object.keys(plain)) {
      secrets[name] = await Vault.encrypt(vaultKey, plain[name]);
    }
    const next = normalizeSettings({
      ...settings,
      secrets,
      secretsV: 2,
      security: null
    });
    await writeSettings(next);
    return { migrated: true, count: Object.keys(secrets).length };
  });

  // 是否需要旧版迁移（设置页据此显示一次性迁移卡片）。
  Storage.needsLegacyMigration = async function () {
    const settings = await Storage.loadSettings();
    return !!(settings.security && settings.security.enabled && settings.secretsV === 1);
  };

  // 清除本地密钥：丢弃保险库并删除全部已加密凭据（凭据需重新填写，不可逆）。
  // 旧版主密码残留数据也一并清除（不再需要旧密码）。
  Storage.clearVaultAndSecrets = locked(async function () {
    const settings = await Storage.loadSettings();
    const next = normalizeSettings({
      ...settings,
      secrets: {},
      secretsV: 0,
      security: null
    });
    for (const field of SECRET_FIELDS) writePath(next, field.path, '');
    await writeSettings(next);
    await Vault.clear();
    return next;
  });

  Storage.saveSettings = async function (settings) {
    return Storage.updateSettings(settings);
  };

  // ---- 首次运行提示（可关闭，不再重复）----
  const ONBOARDING_KEY = 'openpocket:onboarding';
  Storage.ONBOARDING_KEY = ONBOARDING_KEY;

  Storage.loadOnboarding = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(ONBOARDING_KEY, (items) => {
        const raw = items && items[ONBOARDING_KEY];
        resolve(!!(raw && raw.dismissed));
      });
    });
  };

  Storage.dismissOnboarding = async function () {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [ONBOARDING_KEY]: { dismissed: true, at: Utils.now() } }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  };

  // ---- 独立窗口尺寸记忆与屏幕可用区域 ----
  const WINDOW_BOUNDS_KEY = 'openpocket:window-bounds';
  const SCREEN_INFO_KEY = 'openpocket:screen';
  Storage.WINDOW_BOUNDS_KEY = WINDOW_BOUNDS_KEY;
  Storage.SCREEN_INFO_KEY = SCREEN_INFO_KEY;

  // ---- 分组栏折叠状态（仅独立窗口持久化；侧边栏每次冷启动折叠，旧 sidepanel 键忽略）----
  const FOLD_STATE_KEY = 'openpocket:fold-state';
  Storage.FOLD_STATE_KEY = FOLD_STATE_KEY;

  Storage.loadFoldState = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(FOLD_STATE_KEY, (items) => {
        const raw = items && items[FOLD_STATE_KEY];
        resolve(raw && typeof raw === 'object' ? raw : {});
      });
    });
  };

  // patch 形如 { standalone: true }；传 null 表示清空全部折叠偏好（恢复默认）。
  Storage.saveFoldState = locked(async function (patch) {
    if (patch === null) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.remove(FOLD_STATE_KEY, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve({});
        });
      });
    }
    const current = await Storage.loadFoldState();
    const next = Object.assign({}, current, patch);
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [FOLD_STATE_KEY]: next }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(next);
      });
    });
  });

  Storage.loadWindowBounds = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(WINDOW_BOUNDS_KEY, (items) => {
        const raw = items && items[WINDOW_BOUNDS_KEY];
        resolve(raw && typeof raw === 'object' ? raw : null);
      });
    });
  };

  // patch 合并写入，保留未提供字段（windowId 与历史尺寸互不覆盖）；写入串行化避免多上下文丢字段。
  Storage.saveWindowBounds = locked(async function (patch) {
    const current = await Storage.loadWindowBounds();
    const next = Object.assign({}, current, patch);
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [WINDOW_BOUNDS_KEY]: next }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(next);
      });
    });
  });

  // Service Worker 没有 screen 对象，由 management 页面上报可用区域。
  Storage.loadScreenInfo = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(SCREEN_INFO_KEY, (items) => {
        const raw = items && items[SCREEN_INFO_KEY];
        resolve(raw && typeof raw === 'object' ? raw : null);
      });
    });
  };

  Storage.saveScreenInfo = async function (info) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [SCREEN_INFO_KEY]: info }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  };

  // ---- AI 分类缓存（缓存键 → 分类名），用于节省 token ----
  Storage.AI_CACHE_KEY = AI_CACHE_KEY;

  Storage.loadAiCache = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(AI_CACHE_KEY, (items) => {
        const raw = items[AI_CACHE_KEY];
        resolve(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
      });
    });
  };

  // entries: [{ key, category }]
  // 返回 { skipped:false, saved } 或 { skipped:true, code:'QUOTA_EXCEEDED', message }。
  // 配额不足时不抛出，调用方据此提示「已跳过缓存」即可，不影响整理结果。
  Storage.saveAiCacheEntries = locked(async function (entries) {
    if (!Array.isArray(entries) || !entries.length) return { skipped: false, saved: 0 };
    const cache = await Storage.loadAiCache();
    const now = Utils.now();
    let saved = 0;
    for (const e of entries) {
      if (!e || !e.key || !e.category) continue;
      cache[e.key] = { c: e.category, t: now };
      saved++;
    }
    const keys = Object.keys(cache);
    if (keys.length > AI_CACHE_MAX) {
      keys.sort((a, b) => ((cache[a] && cache[a].t) || 0) - ((cache[b] && cache[b].t) || 0));
      for (const k of keys.slice(0, keys.length - AI_CACHE_MAX)) delete cache[k];
    }
    try {
      await assertQuota(AI_CACHE_KEY, cache);
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') return aiCacheSkipped(e);
      throw e;
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [AI_CACHE_KEY]: cache }, () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message;
          if (isQuotaMessage(message)) resolve(aiCacheSkipped());
          else reject(new Error(message));
        } else {
          resolve({ skipped: false, saved });
        }
      });
    });
  });

  Storage.clearAiCache = locked(async function () {
    return new Promise((resolve) => {
      chrome.storage.local.remove(AI_CACHE_KEY, () => resolve());
    });
  });

  // ---- 同步合并（供 webdav.js 使用）----
  // 把远端数据与本地数据按 lastModified 合并，返回合并结果。
  Storage.mergeRemote = function (localData, remoteData, stats) {
    const local = normalize(localData || Utils.clone(DEFAULT_DATA));
    const remote = normalize(remoteData || Utils.clone(DEFAULT_DATA));

    // 远端合并同样只接受 http/https：file:/浏览器内部页等历史条目直接丢弃，
    // 既不新写入本机，也不参与分组复活或覆盖本地同 id 卡片。数量写入 stats 供同步提示。
    let skippedUncollectable = 0;
    for (const rg of remote.groups) {
      rg.cards = rg.cards.filter((c) => {
        if (Utils.isCollectableUrl(c.url)) return true;
        skippedUncollectable++;
        return false;
      });
    }
    if (stats) stats.skippedUncollectable = skippedUncollectable;

    const result = Utils.clone(local);
    const localGroupMap = new Map(result.groups.map((g) => [g.id, g]));

    for (const rg of remote.groups) {
      const lg = localGroupMap.get(rg.id);
      if (!lg) {
        result.groups.push(Utils.clone(rg));
        continue;
      }
      // 远端墓碑较新 → 本地也标记删除。比较基准：本地已删除看 deletedAt，否则看组元数据最后修改时间；
      // 卡片新增/固定只改 updatedAt，不应让已删除分组复活（OCP-CONF-010）。
      if (rg.deleted && lg.system) {
        // 受保护的默认集锦不接受普通合并的远端墓碑，避免保护对象被静默删除（OCP-CONF-011）。
        continue;
      }
      const lgRef = lg.deleted ? (lg.deletedAt || 0) : (lg.metaUpdatedAt || lg.updatedAt || 0);
      if (rg.deleted && rg.deletedAt > lgRef) {
        lg.deleted = true;
        lg.deletedAt = rg.deletedAt;
        lg.updatedAt = Math.max(lg.updatedAt, rg.updatedAt);
        lg.cards.forEach((c) => {
          if (!c.deleted) { c.deleted = true; c.deletedAt = rg.deletedAt; c.updatedAt = rg.deletedAt; }
        });
        continue;
      }
      if (lg.deleted) {
        // 本地已删除，保留本地删除；只有远端分组元数据（重命名/颜色/复活）晚于删除才恢复。
        if (!rg.deleted && (rg.metaUpdatedAt || 0) > (lg.deletedAt || 0)) {
          Object.assign(lg, Utils.clone(rg));
        }
        continue;
      }
      // 都活着，分组名称/颜色取较新（用组元数据时间，不受卡片操作影响）。
      if ((rg.metaUpdatedAt || 0) > (lg.metaUpdatedAt || 0)) {
        lg.name = rg.name;
        lg.color = rg.color;
        lg.metaUpdatedAt = rg.metaUpdatedAt;
        lg.updatedAt = Math.max(lg.updatedAt, rg.updatedAt);
      }
      // 卡片级合并。
      const cardMap = new Map(lg.cards.map((c) => [c.id, c]));
      for (const rc of rg.cards) {
        const lc = cardMap.get(rc.id);
        if (!lc) {
          lg.cards.push(Utils.clone(rc));
          continue;
        }
        if (rc.deleted && rc.deletedAt > (lc.deleted ? (lc.deletedAt || 0) : lc.updatedAt)) {
          lc.deleted = true;
          lc.deletedAt = rc.deletedAt;
          lc.updatedAt = Math.max(lc.updatedAt, rc.updatedAt);
          continue;
        }
        if (lc.deleted) {
          if (!rc.deleted && rc.updatedAt > (lc.deletedAt || 0)) {
            Object.assign(lc, Utils.clone(rc));
          }
          continue;
        }
        if (rc.updatedAt > lc.updatedAt) {
          Object.assign(lc, Utils.clone(rc));
        }
      }
    }
    return normalize(result);
  };

  // 为所有存活项刷新 updatedAt（上传前调用）。
  Storage.touchAll = function (data) {
    const now = Utils.now();
    for (const g of data.groups) {
      if (!g.deleted) {
        for (const c of g.cards) {
          if (!c.deleted) c.updatedAt = now;
        }
        g.updatedAt = now;
      }
    }
    return data;
  };

  // 对比同步前后的收藏数据，统计新增/更新/删除数量（用于同步报告）。
  Storage.diffCollections = function (before, after) {
    const stats = {
      groups: { added: 0, updated: 0, deleted: 0 },
      cards: { added: 0, updated: 0, deleted: 0 }
    };
    const bGroups = new Map(((before && before.groups) || []).map((g) => [g.id, g]));
    const aGroups = new Map(((after && after.groups) || []).map((g) => [g.id, g]));
    for (const ag of ((after && after.groups) || [])) {
      const bg = bGroups.get(ag.id);
      if (!bg) {
        if (!ag.deleted) {
          stats.groups.added++;
          stats.cards.added += ag.cards.filter((c) => !c.deleted).length;
        }
        continue;
      }
      if (!bg.deleted && ag.deleted) stats.groups.deleted++;
      else if (bg.deleted && !ag.deleted) stats.groups.added++;
      else if (!bg.deleted && ag.updatedAt !== bg.updatedAt) stats.groups.updated++;
      const bCards = new Map(bg.cards.map((c) => [c.id, c]));
      const aCards = new Map(ag.cards.map((c) => [c.id, c]));
      for (const ac of ag.cards) {
        const bc = bCards.get(ac.id);
        if (!bc) {
          if (!ac.deleted) stats.cards.added++;
          continue;
        }
        if (!bc.deleted && ac.deleted) stats.cards.deleted++;
        else if (bc.deleted && !ac.deleted) stats.cards.added++;
        else if (!bc.deleted && !ac.deleted && ac.updatedAt !== bc.updatedAt) stats.cards.updated++;
      }
      // after 中完全消失的卡片也要算删除（例如仅下载替换后本地独有卡片消失）。
      for (const bc of bg.cards) {
        if (!bc.deleted && !aCards.has(bc.id)) stats.cards.deleted++;
      }
    }
    // before 中完全消失的分组/卡片：视为删除（OCP-CONF-029 统计失真）。
    for (const bg of ((before && before.groups) || [])) {
      if (bg.deleted || aGroups.has(bg.id)) continue;
      stats.groups.deleted++;
      stats.cards.deleted += bg.cards.filter((c) => !c.deleted).length;
    }
    return stats;
  };

  // 写入远端同步来的备份快照（键必须在备份命名空间内）。
  Storage.putBackup = async function (key, data) {
    if (typeof key !== 'string' || key.indexOf(BACKUP_PREFIX) !== 0 || !data || typeof data !== 'object') {
      throw new Error('非法的备份快照');
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: data }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  };

  // 覆盖写分类缓存（同步用），按时间裁剪到上限。
  // 配额不足时同样降级为跳过（返回 skipped），不阻断同步主流程。
  Storage.saveAiCacheRaw = locked(async function (cache) {
    const entries = Object.entries(cache && typeof cache === 'object' ? cache : {});
    entries.sort((a, b) => ((b[1] && b[1].t) || 0) - ((a[1] && a[1].t) || 0));
    const out = {};
    for (const [k, v] of entries.slice(0, AI_CACHE_MAX)) {
      if (v && typeof v.c === 'string') out[k] = { c: v.c, t: Number(v.t) || 0 };
    }
    try {
      await assertQuota(AI_CACHE_KEY, out);
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') return aiCacheSkipped(e);
      throw e;
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [AI_CACHE_KEY]: out }, () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message;
          if (isQuotaMessage(message)) resolve(aiCacheSkipped());
          else reject(new Error(message));
        } else {
          resolve({ skipped: false, saved: Object.keys(out).length });
        }
      });
    });
  });

  // ---- 设置导出 / 导入（阶段三）----
  const SETTINGS_EXPORT_SCHEMA = 1;
  Storage.SETTINGS_EXPORT_SCHEMA = SETTINGS_EXPORT_SCHEMA;

  // 可导出的设置键（白名单）：不含任何凭据、密文、密钥或设备专属值。
  const EXPORTABLE_SETTINGS_KEYS = [
    'webdav.enabled', 'webdav.url', 'webdav.remoteDir', 'webdav.autoSync', 'webdav.intervalMinutes',
    'webdav.syncScope.aiCache', 'webdav.syncScope.backups',
    'behavior.batchCollectDaily', 'behavior.aiIncludeInbox', 'behavior.allowDuplicateLinks',
    'ai.enabled', 'ai.baseUrl', 'ai.model', 'ai.categories'
  ];
  Storage.EXPORTABLE_SETTINGS_KEYS = EXPORTABLE_SETTINGS_KEYS.slice();

  // 敏感项只导出「已配置/未配置」状态标记，绝不含值。
  const SENSITIVE_MARKERS = ['webdav.username', 'webdav.password', 'ai.apiKey'];

  // 判断敏感项是否已配置：凭据加密后明文字段会被清空，必须同时检查密文信封。
  function secretIsConfigured(settings, keyPath) {
    const field = SECRET_FIELDS.find((f) => f.path.join('.') === keyPath);
    if (field && settings.secrets && settings.secrets[field.name]) return true;
    return !!readKeyPath(settings, keyPath);
  }

  // 导出全部设置：schemaVersion + 导出时间 + 应用版本 + 设置项 + 敏感项状态标记。
  Storage.exportSettingsJSON = async function () {
    const settings = await Storage.loadSettings();
    const out = {};
    for (const keyPath of EXPORTABLE_SETTINGS_KEYS) {
      writeKeyPath(out, keyPath, Utils.clone(readKeyPath(settings, keyPath)));
    }
    if (out.webdav && typeof out.webdav.url === 'string') {
      out.webdav.url = redactUrlUserinfo(out.webdav.url);
    }
    if (out.ai && typeof out.ai.baseUrl === 'string') {
      out.ai.baseUrl = redactUrlUserinfo(out.ai.baseUrl);
    }
    const sensitive = {};
    for (const keyPath of SENSITIVE_MARKERS) {
      sensitive[keyPath] = secretIsConfigured(settings, keyPath) ? 'configured' : 'empty';
    }
    let appVersion = '';
    try {
      if (global.chrome && chrome.runtime && chrome.runtime.getManifest) {
        appVersion = chrome.runtime.getManifest().version || '';
      }
    } catch (e) {}
    return JSON.stringify({
      app: 'open-collections',
      type: 'settings',
      schemaVersion: SETTINGS_EXPORT_SCHEMA,
      exportedAt: Utils.now(),
      appVersion,
      settings: out,
      sensitive
    }, null, 2);
  };

  // 校验导入文件：合法返回 { settings, sensitive, exportedAt, appVersion }；非法/未来版本抛错并说明原因。
  Storage.validateSettingsExport = function (obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('文件不是有效的 JSON 对象');
    }
    if (obj.app !== 'open-collections' || obj.type !== 'settings') {
      throw new Error('这不是 Open Collections 的设置导出文件（缺少 app/type 标识）');
    }
    const v = Number(obj.schemaVersion);
    if (!v) throw new Error('文件缺少 schemaVersion，无法识别版本');
    if (v > SETTINGS_EXPORT_SCHEMA) {
      throw new Error(`该文件由更新版本的扩展导出（schema v${v}，本端支持 v${SETTINGS_EXPORT_SCHEMA}），请先升级扩展再导入`);
    }
    if (!obj.settings || typeof obj.settings !== 'object') {
      throw new Error('文件缺少 settings 字段');
    }
    // 只接受白名单内的键，多余键忽略。
    const settings = {};
    let found = 0;
    for (const keyPath of EXPORTABLE_SETTINGS_KEYS) {
      const value = readKeyPath(obj.settings, keyPath);
      if (value === undefined) continue;
      writeKeyPath(settings, keyPath, Utils.clone(value));
      found++;
    }
    if (!found) throw new Error('文件中没有任何可识别的设置项');
    return {
      settings,
      sensitive: obj.sensitive && typeof obj.sensitive === 'object' ? obj.sensitive : {},
      exportedAt: Number(obj.exportedAt) || 0,
      appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : ''
    };
  };

  // 计算某个导入键在真正落盘后的规范化值；mode='overwrite' 时未出现的键取默认值。
  function normalizedImportValue(local, incomingSettings, keyPath, mode) {
    const raw = readKeyPath(incomingSettings, keyPath);
    if (raw === undefined && mode !== 'overwrite') return null;
    const next = Utils.clone(local);
    if (raw === undefined) {
      writeKeyPath(next, keyPath, Utils.clone(readKeyPath(DEFAULT_SETTINGS, keyPath)));
    } else {
      writeKeyPath(next, keyPath, Utils.clone(raw));
    }
    const normalized = normalizeSettings(next);
    return {
      oldValue: readKeyPath(local, keyPath),
      newValue: readKeyPath(normalized, keyPath),
      reset: raw === undefined
    };
  }

  // 差异预览：按实际落盘后的规范化值比较；mode='overwrite' 还列出未出现键的默认重置。
  // 返回 [{ key, oldValue, newValue, reset }]（仅不同的键）。
  Storage.diffSettingsExport = function (incomingSettings, mode) {
    mode = mode === 'overwrite' ? 'overwrite' : 'merge';
    return Storage.loadSettings().then((local) => {
      const diffs = [];
      for (const keyPath of EXPORTABLE_SETTINGS_KEYS) {
        const effective = normalizedImportValue(local, incomingSettings, keyPath, mode);
        if (!effective) continue;
        if (JSON.stringify(effective.oldValue) !== JSON.stringify(effective.newValue)) {
          diffs.push({
            key: keyPath,
            oldValue: effective.oldValue,
            newValue: effective.newValue,
            reset: effective.reset
          });
        }
      }
      return diffs;
    });
  };

  // 应用导入的设置：mode='merge' 只写文件中出现的键；'overwrite' 额外把未出现的键恢复默认。
  // 应用前写设置专用备份（含同步时间戳，可完整回滚）；写入键并更新同步时间戳，便于后续 WebDAV 传播。
  Storage.applySettingsExport = locked(async function (incomingSettings, mode) {
    const local = await Storage.loadSettings();
    const localMeta = await loadSettingsMeta();
    assertSettingsUrls(incomingSettings);
    const backupKey = SETTINGS_BACKUP_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    await assertQuota(backupKey, { __settingsBackup: true, settings: local, meta: localMeta });
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({
        [backupKey]: { __settingsBackup: true, settings: local, meta: localMeta }
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    await Storage.clearOldSettingsBackups(5);
    const next = Utils.clone(local);
    const applied = [];
    const stampNow = Utils.now();
    const meta = await loadSettingsMeta();
    for (const keyPath of EXPORTABLE_SETTINGS_KEYS) {
      const newValue = readKeyPath(incomingSettings, keyPath);
      if (newValue === undefined) {
        if (mode === 'overwrite') {
          const defaultValue = readKeyPath(DEFAULT_SETTINGS, keyPath);
          if (JSON.stringify(readKeyPath(next, keyPath)) !== JSON.stringify(defaultValue)) {
            writeKeyPath(next, keyPath, Utils.clone(defaultValue));
            applied.push(keyPath);
          }
          meta.keys[keyPath] = stampNow;
        }
        continue;
      }
      if (JSON.stringify(readKeyPath(next, keyPath)) !== JSON.stringify(newValue)) {
        writeKeyPath(next, keyPath, Utils.clone(newValue));
        applied.push(keyPath);
      }
      meta.keys[keyPath] = stampNow;
    }
    // 凭据与加密状态不受导入影响，始终保持本地值。
    next.webdav.username = local.webdav.username;
    next.webdav.password = local.webdav.password;
    next.ai.apiKey = local.ai.apiKey;
    next.security = local.security;
    next.secrets = local.secrets;
    next.secretsV = local.secretsV;
    // 本地未启用网络功能时，导入不能替用户打开（首次启用必须走确认流程，OCP-CONF-014）。
    guardNetworkEnabled(local, next);
    await writeSettings(normalizeSettings(next));
    await saveSettingsMeta(meta);
    return { backupKey, applied };
  });

  // 回滚设置导入：从设置专用备份恢复完整设置与同步时间戳。
  Storage.restoreSettingsBackup = locked(async function (key) {
    if (typeof key !== 'string' ||
      !(key.startsWith(SETTINGS_BACKUP_PREFIX) || key.startsWith(BACKUP_PREFIX))) {
      throw new Error('设置备份键不合法');
    }
    const raw = await new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (items) => {
        if (chrome.runtime.lastError) reject(storageReadFailed(chrome.runtime.lastError.message));
        else if (items == null || typeof items !== 'object') reject(storageReadFailed('设置备份返回数据无效'));
        else resolve(items[key]);
      });
    });
    if (!raw || raw.__settingsBackup !== true || !raw.settings) {
      throw new Error('设置备份不存在或格式不正确');
    }
    await writeSettings(normalizeSettings(raw.settings));
    if (raw.meta) await saveSettingsMeta(raw.meta);
    return true;
  });

  global.Storage = Storage;
})(typeof self !== 'undefined' ? self : this);
