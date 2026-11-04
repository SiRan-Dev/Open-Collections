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
    if (status === 412) return { code: 412, message: '远端文件已被其他设备修改（412）：已停止写入，请重新同步' };
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
      // Chrome match pattern 不支持端口；与 app.js 的 requestOriginPermission 保持一致。
      origin = `${u.protocol}//${u.hostname}/*`;
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
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
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
      cleanup();
      if (cancelled) throw { code: 'cancelled', message: '同步已取消' };
      if (timedOut) {
        throw { code: 0, message: '请求超时（20 秒）：服务器无响应或网络过慢' };
      }
      throw classifyError(e, 0);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      cleanup();
      throw classifyError(new Error(text || resp.statusText), resp.status);
    }
    // 调用方读取响应体（readRemoteJson）后再 cleanup；否则超时/取消不会覆盖 body 读取，
    // 服务器返回响应头后卡住响应体会让同步永久挂起（OCP-CONF-012）。
    resp._davCleanup = cleanup;
    return resp;
  }

  // 读取远端 JSON；404 返回 null，解析失败给出可读错误。
  // 传入 options 时把响应 ETag 写入 options.etag，供后续 PUT 的 If-Match 使用。
  async function readRemoteJson(wd, url, options) {
    try {
      const resp = await davRequest(url, wd, { method: 'GET', signal: options && options.signal });
      let text;
      try {
        text = await resp.text();
      } finally {
        if (typeof resp._davCleanup === 'function') resp._davCleanup();
      }
      if (options && typeof options === 'object') {
        options.etag = resp.headers && typeof resp.headers.get === 'function'
          ? resp.headers.get('ETag') : null;
      }
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
    const headers = { 'Content-Type': 'application/json' };
    if (options && options.ifMatch) headers['If-Match'] = options.ifMatch;
    const resp = await davRequest(url, wd, {
      method: 'PUT',
      signal: options && options.signal,
      headers,
      body: JSON.stringify(obj, null, 2)
    });
    if (typeof resp._davCleanup === 'function') resp._davCleanup();
  }

  // 依次确保 remoteDir 的每一级父目录、openpocket、v2 目录存在。
  // 标准 WebDAV MKCOL 要求父集合已存在；不能把 409 当“已存在”而跳过（OCP-CONF-031）。
  async function ensureRemoteDirs(wd, options) {
    const signal = options && options.signal;
    const dir = remoteDirPath(wd);
    const parts = dir ? dir.split('/').map((s) => s.trim()).filter(Boolean) : [];
    const segments = [];
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      segments.push(cur);
    }
    const base = cur ? cur + '/' : '';
    segments.push(base + 'openpocket');
    segments.push(base + 'openpocket/v2');
    for (const seg of segments) {
      const url = joinUrl(wd.url, seg + '/');
      let resp;
      try {
        resp = await davRequest(url, wd, {
          method: 'PROPFIND',
          signal,
          headers: { 'Depth': '0' },
          body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>'
        });
      } catch (e) {
        if (e.code === 404) {
          try {
            const mk = await davRequest(url, wd, { method: 'MKCOL', signal });
            if (mk && typeof mk._davCleanup === 'function') mk._davCleanup();
          } catch (e2) {
            // 405 通常表示目录已存在（并发创建）；409 表示父目录不存在，不能静默成功。
            if (!(e2 && e2.code === 405)) {
              if (e2 && e2.code === 409) {
                throw { code: 409, message: '创建远端目录失败：父目录不存在或权限不足（' + seg + '）' };
              }
              throw e2;
            }
          }
        } else {
          throw e;
        }
      } finally {
        if (resp && typeof resp._davCleanup === 'function') resp._davCleanup();
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

  function assertPackSchema(pack, name) {
    if (!pack || pack.schemaVersion == null) return;
    const v = Number(pack.schemaVersion);
    if (v !== SCHEMA_VERSION) {
      throw {
        code: 'schema',
        message: `远端文件 ${name} 的结构版本不兼容（schema v${v || '未知'}，本端需要 v${SCHEMA_VERSION}），已停止且未覆盖任何数据`
      };
    }
  }

  // 仅下载/远端合并前校验收藏数据结构，拒绝畸形 data 清空本地（OCP-CONF-002）。
  function assertCollectionsData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw { code: 'schema', message: '远端收藏数据不是有效对象，已停止且未修改本地数据' };
    }
    if (!Array.isArray(data.groups)) {
      throw { code: 'schema', message: '远端收藏数据缺少 groups 数组，已停止且未修改本地数据' };
    }
    for (const g of data.groups) {
      if (!g || typeof g !== 'object' || Array.isArray(g)) {
        throw { code: 'schema', message: '远端收藏数据包含损坏的分组，已停止且未修改本地数据' };
      }
      if (g.cards != null && !Array.isArray(g.cards)) {
        throw { code: 'schema', message: '远端收藏数据包含损坏的卡片列表，已停止且未修改本地数据' };
      }
    }
    return true;
  }

  function sanitizeCollectionsData(data) {
    const clean = Utils.clone(data);
    let skipped = 0;
    for (const g of clean.groups) {
      if (!Array.isArray(g.cards)) g.cards = [];
      g.cards = g.cards.filter((c) => {
        if (c && typeof c === 'object' && Utils.isCollectableUrl(c.url)) return true;
        skipped++;
        return false;
      });
    }
    clean.__skippedUncollectable = skipped;
    return clean;
  }

  function partialRemoteError() {
    return {
      code: 'partial',
      message: '远端存在数据文件但缺少 meta.json（可能上次写入中断）。已停止且未覆盖任何数据；请先在服务器检查/清理残缺文件后重试'
    };
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
    if (!meta) {
      // meta 缺失但 collections 存在 = 部分写入；不能当作空远端（OCP-CONF-017）。
      const maybeCollections = await readRemoteJson(settings, remoteFileUrl(settings, FILE_COLLECTIONS), options);
      if (maybeCollections) throw partialRemoteError();
      return null;
    }
    const pack = await readRemoteJson(settings, remoteFileUrl(settings, FILE_COLLECTIONS), options);
    if (!pack || !pack.data) return null;
    assertPackSchema(pack, FILE_COLLECTIONS);
    assertCollectionsData(pack.data);
    return sanitizeCollectionsData(pack.data);
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
    const granted = await ensureHostPermission(wdConfig.url);
    if (!granted) {
      throw { code: 'permission', message: '需要授权访问该 WebDAV 服务器的网络权限。请先在设置页手动测试连接或同步一次并允许访问' };
    }
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

    // 拉取/合并前生成本地快照（可回滚）；失败路径在 catch 中清理，避免 sync-before 无限累积（OCP-CONF-009）。
    const syncStartedAt = Date.now();
    const backupKey = await Storage.createBackup('sync-before');
    try {
    const localData = await Storage.load();

    // ---- 远端读取与版本检查（同时记录 ETag，写回时用 If-Match 防止并发覆盖，OCP-CONF-030）----
    let meta = null;
    let metaEtag = null;
    let collectionsEtag = null;
    let settingsEtag = null;
    let cacheEtag = null;
    let backupsEtag = null;
    if (mode !== 'upload') {
      const metaOpts = { signal: opts.signal };
      meta = await readRemoteJson(wd, remoteFileUrl(wd, FILE_META), metaOpts);
      metaEtag = metaOpts.etag || null;
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
        // meta 缺失但已有 collections/settings：上次写入中断，不能当空远端覆盖（OCP-CONF-017）。
        const partial = await readRemoteJson(wd, remoteFileUrl(wd, FILE_COLLECTIONS), { signal: opts.signal });
        if (partial) throw partialRemoteError();
      }
    } else {
      // 显式上传也要避免覆盖由更新版本写入的远端；旧版/低版本允许重建（仅上传的语义）。
      const metaOpts = { signal: opts.signal };
      meta = await readRemoteJson(wd, remoteFileUrl(wd, FILE_META), metaOpts);
      metaEtag = metaOpts.etag || null;
      if (meta && Number(meta.schemaVersion) > SCHEMA_VERSION) assertSchemaCompatible(meta);
      if (!meta) {
        const partial = await readRemoteJson(wd, remoteFileUrl(wd, FILE_COLLECTIONS), { signal: opts.signal });
        if (partial) throw partialRemoteError();
      }
    }

    let remoteCollections = null;
    let remoteSettingsPack = null;
    let remoteCachePack = null;
    let remoteBackupsPack = null;
    if (mode !== 'upload' && meta) {
      const collectionsOpts = { signal: opts.signal };
      remoteCollections = await readRemoteJson(wd, remoteFileUrl(wd, FILE_COLLECTIONS), collectionsOpts);
      collectionsEtag = collectionsOpts.etag || null;
      const settingsOpts = { signal: opts.signal };
      remoteSettingsPack = await readRemoteJson(wd, remoteFileUrl(wd, FILE_SETTINGS), settingsOpts);
      settingsEtag = settingsOpts.etag || null;
      if (remoteCollections) assertPackSchema(remoteCollections, FILE_COLLECTIONS);
      if (remoteSettingsPack) assertPackSchema(remoteSettingsPack, FILE_SETTINGS);
      if (scope.aiCache) {
        const cacheOpts = { signal: opts.signal };
        remoteCachePack = await readRemoteJson(wd, remoteFileUrl(wd, FILE_AI_CACHE), cacheOpts);
        cacheEtag = cacheOpts.etag || null;
        if (remoteCachePack) assertPackSchema(remoteCachePack, FILE_AI_CACHE);
      }
      if (scope.backups) {
        const backupsOpts = { signal: opts.signal };
        remoteBackupsPack = await readRemoteJson(wd, remoteFileUrl(wd, FILE_BACKUPS), backupsOpts);
        backupsEtag = backupsOpts.etag || null;
        if (remoteBackupsPack) assertPackSchema(remoteBackupsPack, FILE_BACKUPS);
      }
    }
    // 仅上传也要读取远端备份快照，避免用本地前 3 份覆盖远端独有快照（OCP-CONF-013）。
    if (mode === 'upload' && scope.backups && meta) {
      const backupsOpts = { signal: opts.signal };
      remoteBackupsPack = await readRemoteJson(wd, remoteFileUrl(wd, FILE_BACKUPS), backupsOpts);
      backupsEtag = backupsOpts.etag || null;
      if (remoteBackupsPack) assertPackSchema(remoteBackupsPack, FILE_BACKUPS);
    }

    if (opts.signal && opts.signal.aborted) {
      throw { code: 'cancelled', message: '同步已取消' };
    }

    // ---- 合并/替换 ----
    // 收藏数据的读改写放进 Storage.mutate：网络读写可能持续数秒，期间用户新增/编辑的数据
    // 会在锁内重新加载后参与合并，而不是被同步开始时读取的旧快照覆盖。
    let saved;
    let uploadData = null;
    let settingsChanged = 0;
    let cacheMergedCount = null;
    let cacheSkipped = false;
    let backupsImported = 0;
    let skippedUncollectable = 0;
    let aiCachePayload = null;
    const warnings = [];

    if (mode === 'upload') {
      // 仅上传：只在内存副本上标记最新并上传；远端全部写成功后再落盘时间戳，
      // 失败时本地时间戳保持原样，不污染后续合并（OCP-CONF-029）。
      const current = await Storage.load();
      uploadData = Storage.touchAll(Utils.clone(current));
      saved = uploadData;
    } else if (mode === 'download') {
      if (!remoteCollections || !remoteCollections.data) {
        throw { code: 404, message: '远端还没有收藏数据文件，未做任何修改' };
      }
      assertCollectionsData(remoteCollections.data);
      const cleanCollections = sanitizeCollectionsData(remoteCollections.data);
      skippedUncollectable = cleanCollections.__skippedUncollectable || 0;
      if (remoteSettingsPack && remoteSettingsPack.settings) {
        const r = await Storage.applySyncedSettings(remoteSettingsPack.settings, remoteSettingsPack.keys, { force: true });
        settingsChanged = r.changed.length;
      }
      if (scope.aiCache && remoteCachePack && remoteCachePack.cache) {
        const cacheRes = await Storage.saveAiCacheRaw(remoteCachePack.cache);
        if (cacheRes && cacheRes.skipped) cacheSkipped = true;
        else cacheMergedCount = Object.keys(remoteCachePack.cache).length;
      }
      saved = await Storage.mutate((data) => {
        data.groups = cleanCollections.groups;
        data.activeGroupId = cleanCollections.activeGroupId;
        if (cleanCollections.version != null) data.version = cleanCollections.version;
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
        const cacheRes = await Storage.saveAiCacheRaw(mergedCache);
        if (cacheRes && cacheRes.skipped) cacheSkipped = true;
        else {
          cacheMergedCount = Object.keys(mergedCache).length;
          aiCachePayload = mergedCache;
        }
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
        } catch (e) {
          warnings.push('远端备份快照导入失败：' + (snap.key || '未知') + '（' + (e.message || e) + '）');
        }
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
      }, { signal: opts.signal, ifMatch: collectionsEtag || undefined });
      const bundle = await Storage.exportSettingsForSync();
      await writeRemoteJson(wd, remoteFileUrl(wd, FILE_SETTINGS), {
        schemaVersion: SCHEMA_VERSION,
        lastWrite: now,
        settings: bundle.settings,
        keys: bundle.keys
      }, { signal: opts.signal, ifMatch: settingsEtag || undefined });
      if (scope.aiCache && !cacheSkipped) {
        // 本地配额不足时跳过写回，绝不用旧本地缓存覆盖远端（OCP-CONF-028）。
        const cache = aiCachePayload || await Storage.loadAiCache();
        await writeRemoteJson(wd, remoteFileUrl(wd, FILE_AI_CACHE), {
          schemaVersion: SCHEMA_VERSION,
          lastWrite: now,
          cache
        }, { signal: opts.signal, ifMatch: cacheEtag || undefined });
        files.aiCache = now;
        if (cacheMergedCount == null) cacheMergedCount = Object.keys(cache).length;
      }
      if (scope.backups) {
        const snapshots = await collectLocalBackupSnapshots();
        await writeRemoteJson(wd, remoteFileUrl(wd, FILE_BACKUPS), {
          schemaVersion: SCHEMA_VERSION,
          lastWrite: now,
          snapshots
        }, { signal: opts.signal, ifMatch: backupsEtag || undefined });
        files.backups = now;
      }
      await writeRemoteJson(wd, remoteFileUrl(wd, FILE_META), {
        app: 'open-collections',
        schemaVersion: SCHEMA_VERSION,
        lastWrite: now,
        files
      }, { signal: opts.signal, ifMatch: metaEtag || undefined });
    }

    // 仅上传成功后再把本次上传的时间戳提升到本地（只更新仍存在的条目，保留并发编辑）。
    if (mode === 'upload' && uploadData) {
      const stamps = new Map();
      for (const ug of uploadData.groups) {
        stamps.set(ug.id, { group: ug.updatedAt, cards: new Map(ug.cards.map((c) => [c.id, c.updatedAt])) });
      }
      await Storage.mutate((data) => {
        for (const g of data.groups) {
          const st = stamps.get(g.id);
          if (!st) continue;
          g.updatedAt = st.group;
          for (const c of g.cards) {
            const t = st.cards.get(c.id);
            if (t != null) c.updatedAt = t;
          }
        }
      });
    }

    // 清理旧备份，保留最近 10 份。
    await Storage.clearOldBackups(10);

    // 成功同步后记录水位并清理早于水位 90 天的旧墓碑（仅上传/双向；仅下载不清理本地旧墓碑）。
    if (mode !== 'download') {
      try {
        await Storage.setSyncWatermark(syncStartedAt);
        await Storage.pruneTombstones(syncStartedAt);
      } catch (e) {
        warnings.push('本地墓碑清理失败：' + (e.message || e));
      }
    }

    return {
      ok: true,
      mode,
      uploaded: mode === 'upload',
      backupKey,
      groups: saved.groups.filter((g) => !g.deleted).length,
      stats,
      settingsChanged,
      aiCacheCount: cacheMergedCount,
      aiCacheSkipped: cacheSkipped,
      uncollectableSkipped: skippedUncollectable,
      backupsImported,
      warnings
    };
    } catch (e) {
      // 同步失败时清理本次 sync-before，避免失败自动同步无限累积备份并耗尽配额（OCP-CONF-009）。
      try { await Storage.deleteBackup(backupKey); } catch (err) {}
      throw e;
    }
  };

  global.WebDAV = WebDAV;
})(typeof self !== 'undefined' ? self : this);
