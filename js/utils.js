// utils.js — 通用工具函数，在 background 与 management 页面都可加载。
(function (global) {
  'use strict';

  const Utils = {};

  // AI 默认可编辑的粗分类表；「其他」始终作为兜底保留。
  Utils.DEFAULT_AI_CATEGORIES = ['开发', '学习', '娱乐', '生活', '资讯', '其他'];

  const pad2 = (n) => String(n).padStart(2, '0');

  // 生成足够随机的 ID（不依赖 crypto.randomUUID 以兼容旧环境，但优先使用）。
  Utils.uuid = function () {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  Utils.now = function () {
    return Date.now();
  };

  // 格式化时间戳为本地可读字符串。
  Utils.formatTime = function (ts) {
    if (!ts || !Number.isFinite(Number(ts))) return '';
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // 本地日期键（YYYY-MM-DD），用于每日分组。
  Utils.dateKey = function (ts) {
    const d = ts == null ? new Date() : new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  // 卡片上显示的添加时间：今天 / 昨天 / 月日 / 跨年只显示日期。
  Utils.formatAddedTime = function (ts) {
    if (!ts || !Number.isFinite(Number(ts))) return '';
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '';
    const now = new Date();
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const sameDay = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `今天 ${hm}`;
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const sameAsYesterday = d.getFullYear() === y.getFullYear() &&
      d.getMonth() === y.getMonth() &&
      d.getDate() === y.getDate();
    if (sameAsYesterday) return `昨天 ${hm}`;
    if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
    return Utils.formatTime(ts).slice(0, 10);
  };

  // 相对时间，如「3 分钟前」。
  Utils.relativeTime = function (ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const day = Math.floor(h / 24);
    if (day < 30) return `${day} 天前`;
    return Utils.formatTime(ts);
  };

  // 强制 https：保存与发请求前统一校验，拒绝明文 http。
  Utils.requireHttpsUrl = function (raw, label) {
    const name = label || '地址';
    const text = String(raw || '').trim();
    if (!text) throw new Error('请填写' + name);
    let url;
    try {
      url = new URL(text);
    } catch (e) {
      throw new Error(name + '格式不正确');
    }
    if (url.protocol !== 'https:') {
      throw new Error(name + '必须使用 https://（已拒绝明文 http，避免凭据与内容在传输中被窃听）');
    }
    if (url.username || url.password) {
      throw new Error(name + '不能包含用户名或密码，请把凭据分别填写在用户名/密码字段');
    }
    return url;
  };

  // 从 URL 提取域名。
  Utils.hostname = function (url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  };

  // URL 去重规范化（唯一实现，供收藏、AI 请求与 AI 写入复用）：
  // 忽略协议、末尾斜杠、片段与常见跟踪参数，保留 host + path + query 的实质部分。
  const TRACKING_PARAMS = /^(utm_.*|gclid|fbclid|msclkid|yclid|mc_cid|mc_eid|igshid|spm)$/i;

  // RFC 3986 等价归一：百分号编码的十六进制统一大写；非保留字符（A-Z a-z 0-9 - . _ ~）
  // 的百分号编码还原为字面字符，避免 /%7Euser 与 /~user、a%2Fb 与 a%2fb 被当成不同链接。
  const UNRESERVED_CHAR = /[A-Za-z0-9\-._~]/;
  function normalizeEncodedPath(path) {
    return String(path || '').replace(/%([0-9a-fA-F]{2})/g, (m, hex) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return UNRESERVED_CHAR.test(ch) ? ch : '%' + hex.toUpperCase();
    });
  }

  Utils.normalizeUrl = function (raw) {
    const input = String(raw || '').trim();
    if (!input) return '';
    let u;
    try {
      u = new URL(input);
    } catch (e) {
      return input.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
    }
    if (!/^(http|https):/i.test(u.protocol)) {
      return input.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
    }
    const host = u.host.toLowerCase();
    const path = normalizeEncodedPath(u.pathname).replace(/\/+$/, '') || '/';
    const params = new URLSearchParams(u.search);
    const keys = Array.from(new Set(Array.from(params.keys())));
    for (const key of keys) {
      if (TRACKING_PARAMS.test(key)) params.delete(key);
    }
    // URLSearchParams.sort() 只按键排序，同名参数值顺序仍会不同；按 key+value 排序以稳定去重。
    const query = Array.from(params.entries())
      .sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0])))
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    return host + path + (query ? '?' + query : '');
  };

  // 唯一可收藏判定：只有 http/https 网页可以创建条目。所有采集入口最终都经过这里，
  // 避免浏览器内部页、扩展自身页面、本地文件等被收藏或替换成其他标签。
  Utils.URL_NOT_COLLECTABLE_MESSAGE = '当前页面或链接不受支持，只能收藏 http/https 网页';
  Utils.isCollectableUrl = function (url) {
    if (typeof url !== 'string') return false;
    const input = url.trim();
    if (!input) return false;
    try {
      const protocol = new URL(input).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch (e) {
      return false;
    }
  };

  // 卡片去重键：网页按规范化 URL；摘录按「来源 URL + 选区文本」，同页不同摘录不算重复。
  Utils.cardDedupeKey = function (card) {
    if (!card || typeof card !== 'object') return '';
    const url = Utils.normalizeUrl(card.url || card.sourceUrl);
    if (card.type === 'excerpt') {
      const text = String(card.excerpt || '').trim();
      return url && text ? 'excerpt:' + url + ':' + text : '';
    }
    return url ? 'page:' + url : '';
  };

  // 取标题首字母（用于 favicon 兜底）。
  Utils.initial = function (title) {
    const t = (title || '').trim();
    if (!t) return '?';
    const ch = t[0];
    return /[\u4e00-\u9fa5]/.test(ch) ? ch : ch.toUpperCase();
  };

  // 从字符串生成稳定的 HSL 颜色（兜底色块用）。
  Utils.colorFromString = function (str) {
    let hash = 0;
    const s = String(str || '?');
    for (let i = 0; i < s.length; i++) {
      hash = (hash << 5) - hash + s.charCodeAt(i);
      hash |= 0;
    }
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 65%, 50%)`;
  };

  // 分组预设色板。
  Utils.PALETTE = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
    '#6366f1', '#84cc16'
  ];

  // 深拷贝（仅 JSON 安全）。
  Utils.clone = function (obj) {
    return JSON.parse(JSON.stringify(obj));
  };

  // 简易去抖。
  Utils.debounce = function (fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  // HTML 转义。
  Utils.escapeHtml = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // 截断字符串。
  Utils.truncate = function (s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    if (n <= 0) return '';
    return s.slice(0, Math.max(0, n - 1)) + '…';
  };

  // 判断是否为 http(s) URL。
  Utils.isHttpUrl = function (url) {
    return /^https?:\/\//i.test(String(url || ''));
  };

  // 规范化分组/分类名：忽略大小写、空格与常见分隔符，用于同名复用。
  Utils.normalizeName = function (name) {
    const n = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[\s·•\-_/\\（）()【】\[\]：:]/g, '');
    return n === '其它' ? '其他' : n;
  };

  // 规范化分类表：去重、最多 12 个，并保证存在「其他」作为兜底。
  Utils.normalizeCategories = function (list) {
    const out = [];
    const seen = new Set();
    for (const item of (Array.isArray(list) ? list : [])) {
      const name = String(item || '').trim();
      if (!name) continue;
      const key = Utils.normalizeName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key === '其他' ? '其他' : name);
    }
    if (out.length && !out.some((c) => Utils.normalizeName(c) === '其他')) {
      if (out.length >= 12) out.splice(11);
      out.push('其他');
    }
    const final = out.slice(0, 12);
    // 若「其他」原本排在第 12 位之后，上面的 slice 会把它截掉；这里重新预留兜底槽位。
    if (final.length && !final.some((c) => Utils.normalizeName(c) === '其他')) {
      return out.slice(0, 11).concat('其他');
    }
    return final;
  };

  // 生成带 ID 的分组默认名。
  Utils.defaultGroupName = function (index) {
    return `集锦 ${index}`;
  };

  global.Utils = Utils;
})(typeof self !== 'undefined' ? self : this);
