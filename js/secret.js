// secret.js — 敏感字段加密：PBKDF2-SHA256 派生 + AES-GCM 逐字段加密。
// 派生密钥只在内存与 chrome.storage.session（浏览器内存，关闭即失效）中保存，绝不写入 local 磁盘。
(function (global) {
  'use strict';

  const ITERATIONS = 600000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const SESSION_KEY = 'openpocket:unlock';
  const CANARY = 'open-collections-master-key-check';

  function webcrypto() {
    const c = global.crypto;
    if (!c || !c.subtle) throw new Error('当前环境不支持 Web Crypto，无法加密凭据');
    return c;
  }

  function toB64(bytes) {
    let binary = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
  }

  function fromB64(text) {
    const binary = atob(String(text || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(password, saltB64, iterations) {
    const c = webcrypto();
    if (!saltB64) throw new Error('缺少加密盐值，无法派生密钥');
    const salt = fromB64(saltB64);
    const material = await c.subtle.importKey(
      'raw',
      new TextEncoder().encode(String(password || '')),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return c.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: Number(iterations) || ITERATIONS,
        hash: 'SHA-256'
      },
      material,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptText(key, text) {
    const c = webcrypto();
    const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
    const data = await c.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(String(text == null ? '' : text))
    );
    return { iv: toB64(iv), v: toB64(new Uint8Array(data)) };
  }

  async function decryptText(key, envelope) {
    if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.v !== 'string') {
      throw new Error('密文格式不完整');
    }
    const c = webcrypto();
    const plain = await c.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv) },
      key,
      fromB64(envelope.v)
    );
    return new TextDecoder().decode(plain);
  }

  function sessionArea() {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) || null;
  }

  function sessionGet() {
    return new Promise((resolve) => {
      const area = sessionArea();
      if (!area) return resolve(null);
      try {
        area.get(SESSION_KEY, (items) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve(null);
          const raw = items && items[SESSION_KEY];
          resolve(raw && typeof raw === 'object' ? raw : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sessionSet(value) {
    return new Promise((resolve) => {
      const area = sessionArea();
      if (!area) return resolve();
      try {
        area.set({ [SESSION_KEY]: value }, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function sessionRemove() {
    return new Promise((resolve) => {
      const area = sessionArea();
      if (!area) return resolve();
      try {
        area.remove(SESSION_KEY, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  let memoryKey = null;
  let memorySalt = '';

  async function exportKey(key) {
    const raw = await webcrypto().subtle.exportKey('raw', key);
    return toB64(new Uint8Array(raw));
  }

  async function importKey(b64) {
    return webcrypto().subtle.importKey(
      'raw',
      fromB64(b64),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  const Secret = {
    ITERATIONS: ITERATIONS,
    SESSION_KEY: SESSION_KEY,
    CANARY: CANARY,

    // 生成新的 salt 与派生密钥（不持久化）。
    async create(password) {
      const c = webcrypto();
      const salt = toB64(c.getRandomValues(new Uint8Array(SALT_BYTES)));
      const key = await deriveKey(password, salt, ITERATIONS);
      return { key, salt, iterations: ITERATIONS };
    },

    // 校验密码并解锁；成功后把密钥放入内存与会话存储。
    async unlock(password, security) {
      if (!security || !security.salt || !security.check) {
        throw new Error('加密数据不完整，请清除主密码后重新设置');
      }
      const key = await deriveKey(password, security.salt, security.iterations);
      let plain;
      try {
        plain = await decryptText(key, security.check);
      } catch (e) {
        throw new Error('主密码不正确');
      }
      if (plain !== CANARY) throw new Error('主密码不正确');
      memoryKey = key;
      memorySalt = security.salt;
      await sessionSet({ key: await exportKey(key), salt: security.salt });
      return true;
    },

    // 从会话存储恢复解锁状态（页面重开 / Service Worker 重启）。
    async restore(security) {
      if (!security || !security.enabled) return false;
      if (memoryKey && memorySalt === security.salt) return true;
      const saved = await sessionGet();
      if (!saved || saved.salt !== security.salt || !saved.key) return false;
      try {
        memoryKey = await importKey(saved.key);
        memorySalt = security.salt;
        return true;
      } catch (e) {
        memoryKey = null;
        memorySalt = '';
        return false;
      }
    },

    async ensureKey(security) {
      if (!security || !security.enabled) return null;
      if (memoryKey && memorySalt === security.salt) return memoryKey;
      await Secret.restore(security);
      return memoryKey;
    },

    // 新设置主密码后直接采用当前密钥，避免再次派生。
    async adopt(key, salt) {
      memoryKey = key;
      memorySalt = salt;
      await sessionSet({ key: await exportKey(key), salt });
    },

    isUnlocked() {
      return !!memoryKey;
    },

    async lock() {
      memoryKey = null;
      memorySalt = '';
      await sessionRemove();
    },

    encrypt(key, text) {
      return encryptText(key, text);
    },

    decrypt(key, envelope) {
      return decryptText(key, envelope);
    },

    // 只校验密码，不改变解锁状态。
    async verify(password, security) {
      if (!security || !security.salt || !security.check) {
        throw new Error('加密数据不完整，请清除主密码后重新设置');
      }
      const key = await deriveKey(password, security.salt, security.iterations);
      let plain;
      try {
        plain = await decryptText(key, security.check);
      } catch (e) {
        throw new Error('主密码不正确');
      }
      if (plain !== CANARY) throw new Error('主密码不正确');
      return key;
    }
  };

  global.Secret = Secret;
})(typeof self !== 'undefined' ? self : this);
