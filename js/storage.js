// storage.js — 数据持久化与领域逻辑。依赖 chrome.storage.local 与 Utils。
// 可在 background（importScripts）与 management 页面（<script>）中复用。
(function (global) {
  'use strict';

  const STORAGE_KEY = 'openpocket:v1';
  const BACKUP_PREFIX = 'openpocket:backup:';
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
      intervalMinutes: 30
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

  function isSW() {
    return typeof ServiceWorkerGlobalScope !== 'undefined' &&
      global instanceof ServiceWorkerGlobalScope;
  }

  // 从 chrome.storage.local 读取，损坏或为空时返回默认数据并记录错误。
  async function loadRaw() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (items) => {
          if (chrome.runtime.lastError) {
            console.error('[OpenCollections] storage read error:', chrome.runtime.lastError);
            resolve(Utils.clone(DEFAULT_DATA));
            return;
          }
          const raw = items[STORAGE_KEY];
          if (raw == null) {
            resolve(Utils.clone(DEFAULT_DATA));
            return;
          }
          if (typeof raw === 'string') {
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              console.error('[OpenCollections] data JSON parse failed, using default.', e);
              resolve(Utils.clone(DEFAULT_DATA));
            }
            return;
          }
          if (typeof raw === 'object') {
            resolve(raw);
          } else {
            console.error('[OpenCollections] unexpected data type, using default.');
            resolve(Utils.clone(DEFAULT_DATA));
          }
        });
      } catch (e) {
        console.error('[OpenCollections] storage exception:', e);
        resolve(Utils.clone(DEFAULT_DATA));
      }
    });
  }

  // 规范化数据，确保字段完整，处理损坏结构。
  function normalize(data) {
    if (!data || typeof data !== 'object') data = Utils.clone(DEFAULT_DATA);
    data.version = data.version || 1;
    if (!Array.isArray(data.groups)) data.groups = [];
    data.groups = data.groups.map(normalizeGroup).filter(Boolean);
    if (!data.activeGroupId || !data.groups.find((g) => g.id === data.activeGroupId)) {
      data.activeGroupId = data.groups[0] ? data.groups[0].id : null;
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
    return {
      id,
      name,
      color: typeof g.color === 'string' ? g.color : Utils.PALETTE[0],
      createdAt: Number(g.createdAt) || Utils.now(),
      updatedAt: Number(g.updatedAt) || Number(g.createdAt) || Utils.now(),
      deleted: !!g.deleted,
      deletedAt: g.deletedAt ? Number(g.deletedAt) : null,
      cards: Array.isArray(g.cards) ? g.cards.map(normalizeCard).filter(Boolean) : []
    };
  }

  function normalizeCard(c) {
    if (!c || typeof c !== 'object') return null;
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
      deletedAt: c.deletedAt ? Number(c.deletedAt) : null
    };
  }

  async function saveRaw(data) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: data }, () => {
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

  // 对外 API
  const Storage = {};

  Storage.STORAGE_KEY = STORAGE_KEY;
  Storage.BACKUP_PREFIX = BACKUP_PREFIX;
  Storage.SETTINGS_KEY = SETTINGS_KEY;

  Storage.load = async function () {
    const raw = await loadRaw();
    return normalize(raw);
  };

  Storage.save = async function (data) {
    const normalized = normalize(data);
    await saveRaw(normalized);
    return normalized;
  };

  // 在事务回调里拿到可变 data，返回后自动保存。
  Storage.mutate = async function (mutator) {
    const data = await Storage.load();
    const result = await mutator(data);
    await Storage.save(data);
    return result === undefined ? data : result;
  };

  // ---- 分组操作 ----
  Storage.createGroup = async function (name, color) {
    return Storage.mutate((data) => {
      const idx = data.groups.filter((g) => !g.deleted).length + 1;
      const group = {
        id: Utils.uuid(),
        name: name || Utils.defaultGroupName(idx),
        color: color || Utils.PALETTE[Math.floor(Math.random() * Utils.PALETTE.length)],
        createdAt: Utils.now(),
        updatedAt: Utils.now(),
        deleted: false,
        deletedAt: null,
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
      return g;
    });
  };

  Storage.setGroupColor = async function (groupId, color) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId && !x.deleted);
      if (!g) throw new Error('分组不存在');
      g.color = color;
      g.updatedAt = Utils.now();
      return g;
    });
  };

  // 软删除分组（带墓碑，便于同步）。
  Storage.deleteGroup = async function (groupId) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) return;
      g.deleted = true;
      g.deletedAt = Utils.now();
      g.updatedAt = Utils.now();
      g.cards.forEach((c) => {
        c.deleted = true;
        c.deletedAt = Utils.now();
        c.updatedAt = Utils.now();
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
  function cardFromInput(cardInput) {
    return normalizeCard({
      id: Utils.uuid(),
      type: cardInput.type || 'page',
      title: cardInput.title || '无标题',
      url: cardInput.url || '',
      favicon: cardInput.favicon || '',
      notes: cardInput.notes || '',
      excerpt: cardInput.excerpt || '',
      sourceTitle: cardInput.sourceTitle || '',
      sourceUrl: cardInput.sourceUrl || '',
      addedAt: Utils.now(),
      updatedAt: Utils.now(),
      deleted: false,
      deletedAt: null
    });
  }

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

  // 查找全部重复链接组（仅网页卡片；摘录不参与），按添加时间升序返回组内条目。
  Storage.findDuplicateGroups = function (data) {
    const byKey = new Map();
    const groups = (data && Array.isArray(data.groups)) ? data.groups : [];
    for (const g of groups) {
      if (g.deleted) continue;
      for (const c of g.cards || []) {
        if (c.deleted || c.type === 'excerpt') continue;
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

  // 批量软删除指定分组内的卡片。
  Storage.deleteCards = async function (groupId, cardIds) {
    const wanted = new Set(Array.isArray(cardIds) ? cardIds : []);
    if (!wanted.size) return { removed: 0 };
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) return { removed: 0 };
      const now = Utils.now();
      let removed = 0;
      for (const c of g.cards) {
        if (c.deleted || !wanted.has(c.id)) continue;
        c.deleted = true;
        c.deletedAt = now;
        c.updatedAt = now;
        removed++;
      }
      if (removed) g.updatedAt = now;
      return { removed };
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
        const group = data.groups.find((g) => g.id === entry.groupId);
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

  // 拖拽移动：同组移到末尾；跨组复制到目标组末尾并在源组打墓碑，保证同步不复活。
  Storage.moveCardToGroup = async function (fromGroupId, cardId, toGroupId) {
    if (!fromGroupId || !cardId || !toGroupId) throw new Error('移动参数不完整');
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

      const copy = Utils.clone(card);
      copy.id = Utils.uuid();
      copy.addedAt = card.addedAt;
      copy.updatedAt = now;
      to.cards.push(copy);

      card.deleted = true;
      card.deletedAt = now;
      card.updatedAt = now;
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
  Storage.addCardsToDailyGroup = async function (dateKey, cardInputs) {
    const key = String(dateKey || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('日期格式不正确');
    if (!Array.isArray(cardInputs) || cardInputs.length === 0) {
      throw new Error('没有要收藏的标签页');
    }
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
        revived = true;
      }
      const cards = cardInputs.map((cardInput) => {
        const card = cardFromInput(cardInput);
        group.cards.push(card);
        return card;
      });
      group.updatedAt = now;
      data.activeGroupId = group.id;
      return { group, cards, created, revived };
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
          if (!c.deleted) sourceCards.set(c.id, { group: g, card: c });
        }
      }

      const specs = Array.isArray(plan.groups) ? plan.groups : [];
      const now = Utils.now();
      const baseColorIndex = data.groups.filter((g) => !g.deleted).length;
      const createdGroups = [];
      const reusedGroups = [];
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
          if (entry) picked.push(entry);
        }
        if (!picked.length) continue;

        let name = typeof spec.name === 'string' ? spec.name.trim() : '';
        if (!name) name = '整理 ' + (i + 1);
        const nameKey = Utils.normalizeName(name);

        // 按规范化名称复用已有分组；所有源分组都不作为复用目标。
        let target = data.groups.find((g) =>
          !g.deleted && !sourceIdSet.has(g.id) && Utils.normalizeName(g.name) === nameKey);
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
          entry.card.deleted = true;
          entry.card.deletedAt = now;
          entry.card.updatedAt = now;
          updatedSources.add(entry.group);
          movedCards++;
        }

        target.updatedAt = now;
        if (reused) reusedGroups.push({ id: target.id, name: target.name, count: picked.length });
        else createdGroups.push({ id: target.id, name: target.name, count: target.cards.length });
      }

      updatedSources.forEach((g) => { g.updatedAt = now; });
      return { createdGroups, reusedGroups, movedCards, skippedDuplicates };
    });
  };

  Storage.updateCard = async function (groupId, cardId, patch) {
    return Storage.mutate((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (!g) throw new Error('分组不存在');
      const c = g.cards.find((x) => x.id === cardId);
      if (!c) throw new Error('卡片不存在');
      const allowed = ['title', 'notes', 'favicon', 'url', 'excerpt'];
      for (const k of allowed) {
        if (k in patch) c[k] = typeof patch[k] === 'string' ? patch[k] : c[k];
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
      // 覆盖：先做本地备份再写入。
      await Storage.createBackup('import-overwrite');
      const fresh = normalize({ groups: incoming.groups, activeGroupId: null });
      fresh.activeGroupId = fresh.groups[0] ? fresh.groups[0].id : null;
      await Storage.save(fresh);
      return { groups: fresh.groups.length };
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
        // 分组级冲突取较新；不恢复已删除分组。
        if (existing.deleted) continue;
        if (ng.updatedAt >= existing.updatedAt) {
          existing.name = ng.name;
          existing.color = ng.color;
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
  Storage.createBackup = async function (reason) {
    const data = await Storage.load();
    const suffix = Math.random().toString(36).slice(2, 8);
    const key = BACKUP_PREFIX + Date.now() + '-' + (reason || 'manual') + '-' + suffix;
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: data }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(key);
      });
    });
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
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (items) => resolve(items[key]));
    });
  };

  Storage.restoreBackup = async function (key) {
    const data = await Storage.getBackup(key);
    if (!data) throw new Error('备份不存在');
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

  function normalizeSettings(raw) {
    const base = Utils.clone(DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return base;
    const webdav = raw.webdav && typeof raw.webdav === 'object' ? raw.webdav : {};
    base.webdav = {
      enabled: !!webdav.enabled,
      url: typeof webdav.url === 'string' ? webdav.url : '',
      username: typeof webdav.username === 'string' ? webdav.username : '',
      password: typeof webdav.password === 'string' ? webdav.password : '',
      remoteDir: typeof webdav.remoteDir === 'string' && webdav.remoteDir ? webdav.remoteDir : '/open-collections',
      autoSync: !!webdav.autoSync,
      intervalMinutes: Math.max(5, Number(webdav.intervalMinutes) || 30)
    };
    const behavior = raw.behavior && typeof raw.behavior === 'object' ? raw.behavior : {};
    base.behavior = {
      batchCollectDaily: !!behavior.batchCollectDaily,
      aiIncludeInbox: !!behavior.aiIncludeInbox,
      allowDuplicateLinks: !!behavior.allowDuplicateLinks
    };
    const ai = raw.ai && typeof raw.ai === 'object' ? raw.ai : {};
    const categories = Utils.normalizeCategories(ai.categories);
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
    return new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (items) => {
        resolve(normalizeSettings(items[SETTINGS_KEY]));
      });
    });
  };

  // 合并写入，避免只保存某一个配置段时清空其他配置。
  // 敏感字段：写入前用免密保险库密钥加密，明文字段绝不落盘；全程无感，无需密码。
  Storage.updateSettings = async function (patch) {
    const current = await Storage.loadSettings();
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = normalizeSettings({
      ...current,
      ...p,
      webdav: { ...current.webdav, ...(p.webdav || {}) },
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
    await writeSettings(next);
    return next;
  };

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
  async function migratePlaintextSecrets() {
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
  }
  Storage.migratePlaintextSecrets = migratePlaintextSecrets;

  // 旧版主密码数据的一次性迁移：输入旧密码 → 解出明文 → 立即用保险库密钥重封装。
  // 原子写入；失败时旧密文原样保留，可重试，绝不丢数据。
  Storage.migrateLegacySecrets = async function (password) {
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
  };

  // 是否需要旧版迁移（设置页据此显示一次性迁移卡片）。
  Storage.needsLegacyMigration = async function () {
    const settings = await Storage.loadSettings();
    return !!(settings.security && settings.security.enabled && settings.secretsV === 1);
  };

  // 清除本地密钥：丢弃保险库并删除全部已加密凭据（凭据需重新填写，不可逆）。
  // 旧版主密码残留数据也一并清除（不再需要旧密码）。
  Storage.clearVaultAndSecrets = async function () {
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
  };

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

  // ---- 分组栏折叠状态（按场景分别持久化）----
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

  // patch 形如 { sidepanel: true, standalone: false }，两场景互不影响。
  Storage.saveFoldState = async function (patch) {
    const current = await Storage.loadFoldState();
    const next = Object.assign({}, current, patch);
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [FOLD_STATE_KEY]: next }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(next);
      });
    });
  };

  Storage.loadWindowBounds = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(WINDOW_BOUNDS_KEY, (items) => {
        const raw = items && items[WINDOW_BOUNDS_KEY];
        resolve(raw && typeof raw === 'object' ? raw : null);
      });
    });
  };

  // patch 合并写入，保留未提供字段（windowId 与历史尺寸互不覆盖）。
  Storage.saveWindowBounds = async function (patch) {
    const current = await Storage.loadWindowBounds();
    const next = Object.assign({}, current, patch);
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [WINDOW_BOUNDS_KEY]: next }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(next);
      });
    });
  };

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
  Storage.saveAiCacheEntries = async function (entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const cache = await Storage.loadAiCache();
    const now = Utils.now();
    for (const e of entries) {
      if (!e || !e.key || !e.category) continue;
      cache[e.key] = { c: e.category, t: now };
    }
    const keys = Object.keys(cache);
    if (keys.length > AI_CACHE_MAX) {
      keys.sort((a, b) => ((cache[a] && cache[a].t) || 0) - ((cache[b] && cache[b].t) || 0));
      for (const k of keys.slice(0, keys.length - AI_CACHE_MAX)) delete cache[k];
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [AI_CACHE_KEY]: cache }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  };

  Storage.clearAiCache = async function () {
    return new Promise((resolve) => {
      chrome.storage.local.remove(AI_CACHE_KEY, () => resolve());
    });
  };

  // ---- 同步合并（供 webdav.js 使用）----
  // 把远端数据与本地数据按 lastModified 合并，返回合并结果。
  Storage.mergeRemote = function (localData, remoteData) {
    const local = normalize(localData || Utils.clone(DEFAULT_DATA));
    const remote = normalize(remoteData || Utils.clone(DEFAULT_DATA));

    const result = Utils.clone(local);
    const localGroupMap = new Map(result.groups.map((g) => [g.id, g]));

    for (const rg of remote.groups) {
      const lg = localGroupMap.get(rg.id);
      if (!lg) {
        result.groups.push(Utils.clone(rg));
        continue;
      }
      // 远端墓碑较新 → 本地也标记删除。比较基准：本地已删除看 deletedAt，否则看最后编辑时间。
      const lgRef = lg.deleted ? (lg.deletedAt || 0) : lg.updatedAt;
      if (rg.deleted && rg.deletedAt >= lgRef) {
        lg.deleted = true;
        lg.deletedAt = rg.deletedAt;
        lg.updatedAt = Math.max(lg.updatedAt, rg.updatedAt);
        lg.cards.forEach((c) => {
          if (!c.deleted) { c.deleted = true; c.deletedAt = rg.deletedAt; c.updatedAt = rg.deletedAt; }
        });
        continue;
      }
      if (lg.deleted) {
        // 本地已删除，保留本地删除（除非远端更新且未删除——这里取较新）。
        if (!rg.deleted && rg.updatedAt > (lg.deletedAt || 0)) {
          // 远端复活了，恢复本地。
          Object.assign(lg, Utils.clone(rg));
        }
        continue;
      }
      // 都活着，分组字段取较新。
      if (rg.updatedAt > lg.updatedAt) {
        lg.name = rg.name;
        lg.color = rg.color;
        lg.updatedAt = rg.updatedAt;
      }
      // 卡片级合并。
      const cardMap = new Map(lg.cards.map((c) => [c.id, c]));
      for (const rc of rg.cards) {
        const lc = cardMap.get(rc.id);
        if (!lc) {
          lg.cards.push(Utils.clone(rc));
          continue;
        }
        if (rc.deleted && rc.deletedAt >= (lc.deleted ? (lc.deletedAt || 0) : lc.updatedAt)) {
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

  global.Storage = Storage;
})(typeof self !== 'undefined' ? self : this);
