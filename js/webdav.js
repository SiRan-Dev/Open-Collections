// webdav.js — WebDAV 同步：v2 版本化远端结构、范围开关、合并与冲突报告。
// 依赖 Utils 与 Storage。可在 background（importScripts）与 management 页面加载。
//
// 远端结构（<remoteDir>/openpocket/v2/）：
//   meta.json         { app, schemaVersion, lastWrite, files: { collections, settings, aiCache?, backups? } }
//   collections.json  { schemaVersion, lastWrite, data: { version, groups, activeGroupId } }
//   settings.json     { schemaVersion, lastWrite, settings: {...}, keys: { 键路径: 最后修改时间 } }
//   ai-cache.json     { schemaVersion, lastWrite, cache: {...} }        —— 可选范围，默认关
//   backups.json      { schemaVersion, lastWrite, snapshots: [{key, data}] } —— 可选范围，默认关
// 凭据（WebDAV 用户名/密码、AI API Key）与保险库密钥永不写入任何远端文件。
// 旧版 v1 单文件（open-collections-data.json）只识别并提示，不强行覆盖。
(function (global) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const REMOTE_BASE = 'openpocket/v2';
  const LEGACY_FILE = 'open-collections-data.json';
  const FILE_META = 'meta.json';
  const FILE_COLLECTIONS = 'collections.json';
  const FILE_SETTINGS = 'settings.json';
  const FILE_AI_CACHE = 'ai-cache.json';
  const FILE_BACKUPS = 'backups.json';
  const BACKUP_SYNC_LIMIT = 3;

  function assertEnabled(settings) {
    if (!settings || settings.enabled !== true) {
      throw { code: 'disabled', message: 'WebDAV 同步未启用：请先在设置中启用并确认首次说明' };
    }
  }

  function assertHttps(url) {
    try {
      Utils.requireHttpsUrl(url, 'WebDAV 服务器地址');
    } catch (e) {
      throw { code: 'https', message: e.message };
    }
  }

  function joinUrl(base, path) {
    base = String(base || '').replace(/\/+$/, '');
    path = String(path || '').replace(/^\/+/, '');
    return base + '/' + path;
  }

  function remoteDirPath(settings) {
    return (settings.remoteDir || '/open-collections').replace(/^\/+|\/+$/g, '');
  }

  function remoteFileUrl(settings, name) {
    return joinUrl(settings.url, remoteDirPath(settings) + '/' + REMOTE_BASE + '/' + name);
  }

  function legacyFileUrl(settings) {
    return joinUrl(settings.url, remoteDirPath(settings) + '/' + LEGACY_FILE);
  }

  function basicAuth(user, pass) {
    const raw = `${user || ''}:${pass || ''}`;
    // btoa 在 service worker 中可用。
    const encoded = (typeof btoa === 'function') ? btoa(unescape(encodeURIComponent(raw))) : Buffer.from(raw).toString('base64');
    return 'Basic ' + encoded;
  }

  // 把 fetch 错误分类为可读信息。
  function classifyError(err, status) {
    if (status === 401) return { code: 401, message: '认证失败（401）：请检查用户名与密码' };
    if (status === 403) return { code: 403, message: '权限不足（403）：账户无权访问该目录' };
    if (status === 404) return { code: 404, message: '路径不存在（404）：请检查服务器地址与远端目录' };
    if (status >= 500) return { code: status, message: `服务器错误（${status}）` };
    if (err && err.name === 'TypeError' && /Failed to fetch|NetworkError/i.test(err.message)) {
      return { code: 0, message: '网络错误：无法连接到 WebDAV 服务器，请检查地址与网络' };
    }
    return { code: status || 0, message: err ? err.message : '未知错误' };
  }

  // 请求 host 权限（已授权则直接通过，避免每次弹窗）。
  async function ensureHostPermission(url) {
    if (!chrome.permissions) return true;
    let origin = '*://*/*';
    try {
      const u = new URL(url);
      origin = `${u.protocol}//${u.host}/*`;
    } catch (e) {}
    const opts = { origins: [origin] };
    if (chrome.permissions.contains) {
      const has = await new Promise((resolve) => {
        chrome.permissions.contains(opts, (granted) => resolve(!!granted));
      });
      if (has) return true;
    }
    if (!chrome.permissions.request) return true;
    return new Promise((resolve) => {
      chrome.permissions.request(opts, (granted) => resolve(!!granted));
    });
  }

  async function davRequest(url, settings, options) {
    options = options || {};
    const headers = Object.assign({
      'Authorization': basicAuth(settings.username, settings.password)
    }, options.headers || {});
    let resp;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    let cancelled = false;
    const timer = controller ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20000) : null;
    const external = options.signal || null;
    const onAbort = () => {
      cancelled = true;
      if (controller) controller.abort();
    };
    if (controller && external) {
      if (external.aborted) {
        cancelled = true;
        controller.abort();
      } else {
        external.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      resp = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        credentials: 'omit',
        signal: controller ? controller.signal : undefined
      });
    } catch (e) {
      if (cancelled) throw { code: 'cancelled', message: '同步已取消' };
      if (timedOut) {
        throw { code: 0, message: '请求超时（20 秒）：服务器无响应或网络过慢' };
      }
      throw classifyError(e, 0);
    } finally {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw classifyError(new Error(text || resp.statusText), resp.status);
    }
    return resp;
  }

  // 读取远端 JSON；404 返回 null，解析失败给出可读错误。
  async function readRemoteJson(wd, url, options) {
    try {
      const resp = await davRequest(url, wd, { method: 'GET', signal: options && options.signal });
      const text = await resp.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        throw { code: 0, message: '远端文件 ' + url.split('/').pop() + ' JSON 解析失败，已停止且未覆盖任何数据' };
      }
    } catch (e) {
      if (e && e.code === 404) return null;
      throw e;
    }
  }

  async function writeRemoteJson(wd, url, obj, options) {
    await davRequest(url, wd, {
      method: 'PUT',
      signal: options && options.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj, null, 2)
    });
  }

  // 依次确保 remoteDir、openpocket、v2 三层目录存在。
  async function ensureRemoteDirs(wd, options) {
    const signal = options && options.signal;
    const dir = remoteDirPath(wd);
    const segments = [dir, dir + '/openpocket', dir + '/openpocket/v2'];
    for (const seg of segments) {
      const url = joinUrl(wd.url, seg + '/');
      try {
        await davRequest(url, wd, {
          method: 'PROPFIND',
          signal,
          headers: { 'Depth': '0' },
          body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>'
        });
      } catch (e) {
        if (e.code === 404) {
          try {
            await davRequest(url, wd, { method: 'MKCOL', signal });
          } catch (e2) {
            // 并发或已存在时的 405/409 视为成功。
            if (!(e2 && (e2.code === 405 || e2.code === 409))) throw e2;
          }
        } else {
          throw e;
        }
      }
    }
  }

  // schema 检查：远端版本与本地不一致时停止，绝不强行覆盖。
  function assertSchemaCompatible(meta) {
    if (!meta) return;
    const v = Number(meta.schemaVersion);
    if (v !== SCHEMA_VERSION) {
      throw {
        code: 'schema',
        message: v > SCHEMA_VERSION
          ? `远端数据由更新版本写入（schema v${v}，本端支持 v${SCHEMA_VERSION}）。已停止且未覆盖任何数据；请升级本扩展后再同步`
          : `远端数据结构版本不兼容（schema v${v || '未知'}，本端需要 v${SCHEMA_VERSION}）。已停止且未覆盖任何数据；请先在服务器上清理旧数据后用「仅上传」重建`
      };
    }
  }

  const WebDAV = {};
  WebDAV.SCHEMA_VERSION = SCHEMA_VERSION;
  WebDAV.REMOTE_BASE = REMOTE_BASE;

  // 测试连接：对远端目录做 PROPFIND（不存在则尝试创建）。
  WebDAV.testConnection = async function (settings) {
    assertEnabled(settings);
    assertHttps(settings && settings.url);
    if (!settings.username) throw { code: 0, message: '请填写用户名' };
    const granted = await ensureHostPermission(settings.url);
    if (!granted) throw { code: 0, message: '需要授权访问该服务器的网络权限' };
    await ensureRemoteDirs(settings, {});
    return { ok: true };
  };

  // 上传本地数据到远端（v2 结构）。data 为收藏数据对象。
  WebDAV.upload = async function (settings, data, options) {
    assertEnabled(settings);
    assertHttps(settings && settings.url);
    const granted = await ensureHostPermission(settings.url);
    if (!granted) throw { code: 0, message: '需要授权访问该服务器的网络权限' };
    await ensureRemoteDirs(settings, options);
    const now = Date.now();
    await writeRemoteJson(settings, remoteFileUrl(settings, FILE_COLLECTIONS), {
      schemaVersion: SCHEMA_VERSION,
      lastWrite: now,
      data
    }, options);
    const bundle = await Storage.exportSettingsForSync();
    await writeRemoteJson(settings, remoteFileUrl(settings, FILE_SETTINGS), {
      schemaVersion: SCHEMA_VERSION,
      lastWrite: now,
      settings: bundle.settings,
      keys: bundle.keys
    }, options);
    await writeRemoteJson(settings, remoteFileUrl(settings, FILE_META), {
      app: 'open-collections',
      schemaVersion: SCHEMA_VERSION,
      lastWrite: now,
      files: { collections: now, settings: now }
    }, options);
    return { ok: true };
  };

  // 下载远端收藏数据（仅 collections.json 的 data，供内部合并使用）。
  WebDAV.download = async function (settings, options) {
    assertEnabled(settings);
    assertHttps(settings && settings.url);
    const granted = await ensureHostPermission(settings.url);
    if (!granted) throw { code: 0, message: '需要授权访问该服务器的网络权限' };
    const meta = await readRemoteJson(settings, remoteFileUrl(settings, FILE_META), options);
    assertSchemaCompatible(meta);
    if (!meta) return null;
    const pack = await readRemoteJson(settings, remoteFileUrl(settings, FILE_COLLECTIONS), options);
    return pack && pack.data ? pack.data : null;
  };

  // 拉取远端备份快照（最多保留最近 3 份），上传到 backups.json。
  async function collectLocalBackupSnapshots() {
    const list = await Storage.listBackups();
    const snapshots = [];
    for (const item of list.slice(0, BACKUP_SYNC_LIMIT)) {
      const data = await Storage.getBackup(item.key);
      if (data) snapshots.push({ key: item.key, data });
    }
    return snapshots;
  }

  // 完整同步：备份本地 → 下载远端 → 合并 → 保存本地 → 按范围回写远端。
  // mode: 'sync'（双向合并）/ 'upload'（仅上传）/ 'download'（仅下载）。
  WebDAV.runSync = async function (mode, opts) {
    mode = mode || 'sync';
    opts = opts || {};
    const settings = await Storage.loadSettings();
    const wdConfig = settings.webdav || {};
    if (wdConfig.enabled !== true) {
      throw { code: 'disabled', message: 'WebDAV 同步未启用：请先在设置中启用并确认首次说明' };
    }
    assertHttps(wdConfig.url);
    // 凭据只在发请求前临时解密，不写入设置对象，也不参与任何远端文件内容。
    const secrets = await Storage.loadSecrets();
    const wd = Object.assign({}, wdConfig, {
      username: secrets.webdavUsername,
      password: secrets.webdavPassword
    });
    if (!wd.username) throw { code: 0, message: '请先在设置中填写 WebDAV 用户名' };
    const scope = Object.assign({ aiCache: false, backups: false }, wdConfig.syncScope || {});
    if (opts.signal && opts.signal.aborted) {
      throw { code: 'cancelled', message: '同步已取消' };
    }

    // 拉取/合并前生成本地快照（可回滚）。
    const backupKey = await Storage.createBackup('sync-before');
    const localData = await Storage.load();

    // ---- 远端读取与版本检查 ----
    let meta = null;
    if (mode !== 'upload') {
      meta = await readRemoteJson(wd, remoteFileUrl(wd, FILE_META), { signal: opts.signal });
      assertSchemaCompatible(meta);
      if (!meta) {
        // 旧版 v1 单文件：识别并提示，不强行覆盖。
        const legacy = await readRemoteJson(wd, legacyFileUrl(wd), { signal: opts.signal });
        if (legacy) {
          throw {
            code: 'schema',
            message: '检测到旧版远端数据（v1 单文件结构），已停止且未覆盖任何数据；请用「仅上传」把本机数据写入新版结构，或先在服务器上移除旧文件'
          };
        }
      }
    } else {
      // 显式上传也要避免覆盖由更新版本写入的远端。
      meta = await readRemoteJson(wd, remoteFileUrl(wd, FILE_META), { signal: opts.signal });
      if (meta && Number(meta.schemaVersion) > SCHEMA_VERSION) assertSchemaCompatible(meta);
    }

    let remoteCollections = null;
    let remoteSettingsPack = null;
    let remoteCachePack = null;
    let remoteBackupsPack = null;
    if (mode !== 'upload' && meta) {
      remoteCollections = await readRemoteJson(wd, remoteFileUrl(wd, FILE_COLLECTIONS), { signal: opts.signal });
      remoteSettingsPack = await readRemoteJson(wd, remoteFileUrl(wd, FILE_SETTINGS), { signal: opts.signal });
      if (scope.aiCache) {
        remoteCachePack = await readRemoteJson(wd, remoteFileUrl(wd, FILE_AI_CACHE), { signal: opts.signal });
      }
      if (scope.backups) {
        remoteBackupsPack = await readRemoteJson(wd, remoteFileUrl(wd, FILE_BACKUPS), { signal: opts.signal });
      }
    }

    if (opts.signal && opts.signal.aborted) {
      throw { code: 'cancelled', message: '同步已取消' };
    }

    // ---- 合并/替换 ----
    // 收藏数据的读改写放进 Storage.mutate：网络读写可能持续数秒，期间用户新增/编辑的数据
    // 会在锁内重新加载后参与合并，而不是被同步开始时读取的旧快照覆盖。
    let saved;
    let settingsChanged = 0;
    let cacheMergedCount = null;
    let backupsImported = 0;
    let skippedUncollectable = 0;

    if (mode === 'upload') {
      // 强制上传：本地全部标记为最新，让本地在这次同步中胜出。
      saved = await Storage.mutate((data) => {
        Storage.touchAll(data);
      });
    } else if (mode === 'download') {
      if (!remoteCollections || !remoteCollections.data) {
        throw { code: 404, message: '远端还没有收藏数据文件，未做任何修改' };
      }
      if (remoteSettingsPack && remoteSettingsPack.settings) {
        const r = await Storage.applySyncedSettings(remoteSettingsPack.settings, remoteSettingsPack.keys, { force: true });
        settingsChanged = r.changed.length;
      }
      if (scope.aiCache && remoteCachePack && remoteCachePack.cache) {
        await Storage.saveAiCacheRaw(remoteCachePack.cache);
        cacheMergedCount = Object.keys(remoteCachePack.cache).length;
      }
      saved = await Storage.mutate((data) => {
        const incoming = Utils.clone(remoteCollections.data);
        data.groups = incoming.groups;
        data.activeGroupId = incoming.activeGroupId;
        if (incoming.version != null) data.version = incoming.version;
      });
    } else {
      // sync：收藏按条目级 lastModified + 删除墓碑合并；设置按键级时间取新。
      if (remoteSettingsPack && remoteSettingsPack.settings) {
        const r = await Storage.applySyncedSettings(remoteSettingsPack.settings, remoteSettingsPack.keys);
        settingsChanged = r.changed.length;
      }
      if (scope.aiCache && remoteCachePack && remoteCachePack.cache) {
        // 缓存逐键取时间较新者，合并后本地容量上限内保留最新。
        const local2 = await Storage.loadAiCache();
        const mergedCache = Object.assign({}, local2);
        for (const [k, v] of Object.entries(remoteCachePack.cache)) {
          if (!v || typeof v.c !== 'string') continue;
          const cur = mergedCache[k];
          if (!cur || (Number(v.t) || 0) >= (Number(cur.t) || 0)) mergedCache[k] = { c: v.c, t: Number(v.t) || 0 };
        }
        await Storage.saveAiCacheRaw(mergedCache);
        cacheMergedCount = Object.keys(mergedCache).length;
      }
      saved = await Storage.mutate((data) => {
        const mergeStats = {};
        const merged = Storage.mergeRemote(data, remoteCollections ? remoteCollections.data : null, mergeStats);
        skippedUncollectable = mergeStats.skippedUncollectable || 0;
        data.groups = merged.groups;
        data.activeGroupId = merged.activeGroupId;
        if (merged.version != null) data.version = merged.version;
      });
    }

    // 备份快照：远端快照并入本地备份命名空间（不可变，按键并集）。
    if (scope.backups && remoteBackupsPack && Array.isArray(remoteBackupsPack.snapshots)) {
      const localList = await Storage.listBackups();
      const known = new Set(localList.map((b) => b.key));
      for (const snap of remoteBackupsPack.snapshots) {
        if (!snap || typeof snap.key !== 'string' || known.has(snap.key)) continue;
        try {
          await Storage.putBackup(snap.key, snap.data);
          backupsImported++;
        } catch (e) {}
      }
    }

    const stats = Storage.diffCollections(localData, saved);

    // 除「仅下载」外都回写远端，保证两端一致。
    if (mode !== 'download') {
      await ensureRemoteDirs(wd, { signal: opts.signal });
      const now = Date.now();
      const files = { collections: now, settings: now };
      await writeRemoteJson(wd, remoteFileUrl(wd, FILE_COLLECTIONS), {
        schemaVersion: SCHEMA_VERSION,
        lastWrite: now,
        data: saved
      }, { signal: opts.signal });
      const bundle = await Storage.exportSettingsForSync();
      await writeRemoteJson(wd, remoteFileUrl(wd, FILE_SETTINGS), {
        schemaVersion: SCHEMA_VERSION,
        lastWrite: now,
        settings: bundle.settings,
        keys: bundle.keys
      }, { signal: opts.signal });
      if (scope.aiCache) {
        const cache = await Storage.loadAiCache();
        await writeRemoteJson(wd, remoteFileUrl(wd, FILE_AI_CACHE), {
          schemaVersion: SCHEMA_VERSION,
          lastWrite: now,
          cache
        }, { signal: opts.signal });
        files.aiCache = now;
        if (cacheMergedCount == null) cacheMergedCount = Object.keys(cache).length;
      }
      if (scope.backups) {
        const snapshots = await collectLocalBackupSnapshots();
        await writeRemoteJson(wd, remoteFileUrl(wd, FILE_BACKUPS), {
          schemaVersion: SCHEMA_VERSION,
          lastWrite: now,
          snapshots
        }, { signal: opts.signal });
        files.backups = now;
      }
      await writeRemoteJson(wd, remoteFileUrl(wd, FILE_META), {
        app: 'open-collections',
        schemaVersion: SCHEMA_VERSION,
        lastWrite: now,
        files
      }, { signal: opts.signal });
    }

    // 清理旧备份，保留最近 10 份。
    await Storage.clearOldBackups(10);

    return {
      ok: true,
      mode,
      backupKey,
      groups: saved.groups.filter((g) => !g.deleted).length,
      stats,
      settingsChanged,
      aiCacheCount: cacheMergedCount,
      uncollectableSkipped: skippedUncollectable,
      backupsImported
    };
  };

  global.WebDAV = WebDAV;
})(typeof self !== 'undefined' ? self : this);
