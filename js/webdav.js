// webdav.js — WebDAV 同步：上传/下载/合并，带备份、冲突策略、错误分类。
// 依赖 Utils 与 Storage。可在 background（importScripts）与 management 页面加载。
(function (global) {
  'use strict';

  const REMOTE_FILE = 'open-collections-data.json';

  function joinUrl(base, path) {
    base = String(base || '').replace(/\/+$/, '');
    path = String(path || '').replace(/^\/+/, '');
    return base + '/' + path;
  }

  function remoteFileUrl(settings) {
    const dir = (settings.remoteDir || '/open-collections').replace(/^\/+|\/+$/g, '');
    return joinUrl(settings.url, dir + '/' + REMOTE_FILE);
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
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
    try {
      resp = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        credentials: 'omit',
        signal: controller ? controller.signal : undefined
      });
    } catch (e) {
      if (controller && controller.signal.aborted) {
        throw { code: 0, message: '请求超时（20 秒）：服务器无响应或网络过慢' };
      }
      throw classifyError(e, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw classifyError(new Error(text || resp.statusText), resp.status);
    }
    return resp;
  }

  const WebDAV = {};

  // 测试连接：对远端目录做 PROPFIND。
  WebDAV.testConnection = async function (settings) {
    if (!settings || !settings.url) throw { code: 0, message: '请填写 WebDAV 服务器地址' };
    if (!settings.username) throw { code: 0, message: '请填写用户名' };
    const granted = await ensureHostPermission(settings.url);
    if (!granted) throw { code: 0, message: '需要授权访问该服务器的网络权限' };
    const dirUrl = joinUrl(settings.url, (settings.remoteDir || '/open-collections').replace(/^\/+|\/+$/g, '') + '/');
    try {
      await davRequest(dirUrl, settings, {
        method: 'PROPFIND',
        headers: { 'Depth': '0' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>'
      });
    } catch (e) {
      // 目录不存在时尝试创建。
      if (e.code === 404) {
        try {
          await davRequest(dirUrl, settings, { method: 'MKCOL' });
        } catch (e2) {
          throw e2;
        }
      } else {
        throw e;
      }
    }
    return { ok: true };
  };

  // 下载远端数据。
  WebDAV.download = async function (settings) {
    if (!settings || !settings.url) throw { code: 0, message: '请填写 WebDAV 服务器地址' };
    const granted = await ensureHostPermission(settings.url);
    if (!granted) throw { code: 0, message: '需要授权访问该服务器的网络权限' };
    const url = remoteFileUrl(settings);
    try {
      const resp = await davRequest(url, settings, { method: 'GET' });
      const text = await resp.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        throw { code: 0, message: '远端数据 JSON 解析失败' };
      }
    } catch (e) {
      if (e.code === 404) return null; // 远端无文件，视为空。
      throw e;
    }
  };

  // 上传本地数据到远端。
  WebDAV.upload = async function (settings, data) {
    if (!settings || !settings.url) throw { code: 0, message: '请填写 WebDAV 服务器地址' };
    const granted = await ensureHostPermission(settings.url);
    if (!granted) throw { code: 0, message: '需要授权访问该服务器的网络权限' };
    // 先确保目录存在。
    const dirUrl = joinUrl(settings.url, (settings.remoteDir || '/open-collections').replace(/^\/+|\/+$/g, '') + '/');
    try {
      await davRequest(dirUrl, settings, {
        method: 'PROPFIND',
        headers: { 'Depth': '0' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>'
      });
    } catch (e) {
      if (e.code === 404) {
        await davRequest(dirUrl, settings, { method: 'MKCOL' });
      } else {
        throw e;
      }
    }
    const url = remoteFileUrl(settings);
    const body = JSON.stringify(data, null, 2);
    await davRequest(url, settings, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    return { ok: true };
  };

  // 完整同步：备份本地 → 下载远端 → 合并 → 保存本地 → 上传。
  WebDAV.runSync = async function (mode) {
    mode = mode || 'sync';
    const settings = await Storage.loadSettings();
    const wd = settings.webdav || {};
    if (!wd.url || !wd.username) throw { code: 0, message: '请先在设置中填写 WebDAV 地址与用户名' };

    // 同步前本地备份。
    const backupKey = await Storage.createBackup('sync-before');
    const localData = await Storage.load();

    let remoteData = null;
    if (mode === 'sync' || mode === 'download') {
      remoteData = await WebDAV.download(wd);
    }

    let merged;
    if (mode === 'upload') {
      // 强制上传：把本地全部标记为最新，让本地在这次同步中胜出。
      merged = Storage.touchAll(Utils.clone(localData));
    } else if (mode === 'download') {
      // 下载模式：用远端覆盖本地（已在上方 backup，可回滚）。
      if (!remoteData) {
        throw { code: 404, message: '远端还没有数据文件，未做任何修改' };
      }
      merged = remoteData;
    } else {
      // sync 模式：按条目 lastModified + 删除墓碑合并，保留各自的时间戳。
      merged = Storage.mergeRemote(localData, remoteData);
    }

    // 保存到本地。
    await Storage.save(merged);

    // 除「仅下载」外都回写远端，保证两端一致。
    if (mode !== 'download') {
      await WebDAV.upload(wd, merged);
    }

    // 清理旧备份，保留最近 10 份。
    await Storage.clearOldBackups(10);

    return {
      ok: true,
      mode,
      backupKey,
      groups: merged.groups.filter((g) => !g.deleted).length
    };
  };

  global.WebDAV = WebDAV;
})(typeof self !== 'undefined' ? self : this);
