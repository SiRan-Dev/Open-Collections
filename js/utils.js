// utils.js — 通用工具函数，在 background 与 management 页面都可加载。
(function (global) {
  'use strict';

  const Utils = {};

  // AI 默认可编辑的粗分类表；「其他」始终作为兜底保留。
  Utils.DEFAULT_AI_CATEGORIES = ['开发编程', '学习', '娱乐', '生活', '资讯', '其他'];

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
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // 本地日期键（YYYY-MM-DD），用于每日分组。
  Utils.dateKey = function (ts) {
    const d = ts == null ? new Date() : new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  // 卡片上显示的添加时间：今天 / 昨天 / 月日 / 跨年只显示日期。
  Utils.formatAddedTime = function (ts) {
    if (!ts) return '';
    const d = new Date(ts);
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
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const params = new URLSearchParams(u.search);
    const keys = Array.from(new Set(Array.from(params.keys())));
    for (const key of keys) {
      if (TRACKING_PARAMS.test(key)) params.delete(key);
    }
    params.sort();
    const query = params.toString();
    return host + path + (query ? '?' + query : '');
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
    return s.length > n ? s.slice(0, n) + '…' : s;
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
    return out.slice(0, 12);
  };

  // 生成带 ID 的分组默认名。
  Utils.defaultGroupName = function (index) {
    return `集锦 ${index}`;
  };

  global.Utils = Utils;
})(typeof self !== 'undefined' ? self : this);
