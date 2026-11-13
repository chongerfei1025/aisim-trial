/* =========================================================
 * app.js —— AI 角色模拟器 主逻辑
 * 角色卡 / 会话 / IndexedDB 持久化 / 流式渲染 / 导入导出 / TTS
 * ========================================================= */
(function () {
  'use strict';

  /* ---------------- 工具函数 ---------------- */
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function now() { return Date.now(); }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    return sameDay ? p(d.getHours()) + ':' + p(d.getMinutes())
      : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 会话列表用的时间格式：今天 HH:mm / 昨天 / 周三 / 3月5日 */
  function fmtListTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (d.toDateString() === now.toDateString()) return p2(d.getHours()) + ':' + p2(d.getMinutes());
    var y = new Date(now.getTime());
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    if ((now - d) / 86400000 < 7) return '周' + '日一二三四五六'.charAt(d.getDay());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:99;' +
      'background:rgba(24,28,40,.96);color:#e9edf6;border:1px solid #2f3950;padding:10px 18px;' +
      'border-radius:12px;font-size:13.5px;max-width:80vw;text-align:center;' +
      'box-shadow:0 8px 26px rgba(0,0,0,.5);transition:opacity .3s';
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; }, 1600);
    setTimeout(function () { t.remove(); }, 2000);
  }

  /** 文本域自动撑高（编辑长设定时不用一直滚动） */
  function autoGrow(t) {
    if (!t || t.tagName !== 'TEXTAREA') return;
    t.style.height = 'auto';
    t.style.height = Math.min(900, Math.max(76, t.scrollHeight + 2)) + 'px';
  }
  function autoGrowAll(scope) {
    var root = scope || document;
    Array.prototype.forEach.call(root.querySelectorAll('textarea'), autoGrow);
  }

  /* ---------------- 设置 ---------------- */
  var LS_KEY = 'aisim.settings.v1';

  /* 配置版本：改这个数字，所有设备下次打开会自动套用下面的默认配置 */
  var CONFIG_VERSION = 4;

  /* 内置试用 Key：分片存放，避免在源码里成为一整串可直接复制的明文 */
  var PRESET_KEY = [
    'ark-0851ee7c', '-7632-40c5', '-aafc-7197',
    '66946e97', '-5fbf7'
  ].join('');

  var DEFAULT_SETTINGS = {
    provider: 'volcengine',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: PRESET_KEY,
    model: 'deepseek-v4-1-flash-261017',
    temperature: 0.95,
    maxTokens: 2048,
    userName: '你',
    contextMessages: 80,
    stream: true,
    tts: false,
    _v: CONFIG_VERSION
  };

  function loadSettings() {
    var saved = {};
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) saved = JSON.parse(raw) || {};
    } catch (e) { saved = {}; }

    // 配置版本低于当前版本 → 强制套用新的服务商/地址/模型/Key（只发生一次）
    // 之后用户在设置里手动改动并保存，会带上 _v，不会再被覆盖
    if (Number(saved._v || 0) < CONFIG_VERSION) {
      saved.provider = DEFAULT_SETTINGS.provider;
      saved.base = DEFAULT_SETTINGS.base;
      saved.model = DEFAULT_SETTINGS.model;
      // 只有内置了 Key 才覆盖；部署版（Key 留空）必须保留用户自己填的那一份
      if (DEFAULT_SETTINGS.apiKey) saved.apiKey = DEFAULT_SETTINGS.apiKey;
      // 上下文条数：旧默认 30 太小（只够 15 轮，早期剧情会被挤掉），升到 80
      if (Number(saved.contextMessages) === 30 || !saved.contextMessages) {
        saved.contextMessages = DEFAULT_SETTINGS.contextMessages;
      }
      saved._v = CONFIG_VERSION;
      try { localStorage.setItem(LS_KEY, JSON.stringify(saved)); } catch (e) { }
    }

    var result = Object.assign({}, DEFAULT_SETTINGS, saved);

    // 脏数据兜底：服务商不在支持列表里，或地址/模型为空，一律回退到默认配置
    var known = (typeof LLM !== 'undefined' && LLM.PROVIDERS) ? LLM.PROVIDERS : null;
    if (known && !known[result.provider]) {
      result.provider = DEFAULT_SETTINGS.provider;
      result.base = DEFAULT_SETTINGS.base;
      result.model = DEFAULT_SETTINGS.model;
      if (!result.apiKey) result.apiKey = DEFAULT_SETTINGS.apiKey;
    }
    if (!result.base) result.base = (known && known[result.provider] ? known[result.provider].base : DEFAULT_SETTINGS.base);
    if (!result.model) result.model = (known && known[result.provider] ? known[result.provider].model : DEFAULT_SETTINGS.model);

    return result;
  }

  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { toast('保存失败：存储空间不足'); }
  }

  /* ---------------- IndexedDB ---------------- */
  var DB = (function () {
    var p = null;
    function open() {
      if (p) return p;
      p = new Promise(function (res, rej) {
        var r = indexedDB.open('aisim_db', 2);
        r.onupgradeneeded = function () {
          var db = r.result;
          if (!db.objectStoreNames.contains('personas')) db.createObjectStore('personas', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('worldSaves')) db.createObjectStore('worldSaves', { keyPath: 'id' });
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return p;
    }
    function tx(store, mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(store, mode);
          var os = t.objectStore(store);
          var out, req;
          try { req = fn(os); } catch (e) { rej(e); return; }
          if (req) req.onsuccess = function () { out = req.result; };
          t.oncomplete = function () { res(out); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error); };
        });
      });
    }
    return {
      all: function (s) { return tx(s, 'readonly', function (os) { return os.getAll(); }); },
      get: function (s, k) { return tx(s, 'readonly', function (os) { return os.get(k); }); },
      put: function (s, v) { return tx(s, 'readwrite', function (os) { return os.put(v); }); },
      del: function (s, k) { return tx(s, 'readwrite', function (os) { return os.delete(k); }); },
      clear: function (s) { return tx(s, 'readwrite', function (os) { return os.clear(); }); }
    };
  })();

  /* ---------------- 全局状态 ---------------- */
  var state = {
    settings: loadSettings(),
    personas: [],
    worlds: [],
    tab: 'persona',    // 列表页当前 Tab：persona | world
    mode: null,        // 当前会话类型：persona | world
    personaId: null,
    worldId: null,
    session: null,     // 当前会话（角色对话 / 世界存档）
    streaming: false,
    ac: null,
    editing: null,       // 正在编辑的角色
    editingWorld: null,  // 正在编辑的世界
    personaMemory: {},   // 世界模式：关联角色的聊天记录缓存
    worldMemoryForPersona: '',   // 角色模式：该角色在关联世界里的线下经历
    openToken: 0,        // 会话代次，用于丢弃过期的异步回调
    editingMsgId: null,  // 正在编辑的玩家消息 id
    lastAiEl: null
  };

  /* ---------------- DOM ---------------- */
  var elList = $('#persona-list');
  var elMessages = $('#messages');
  var elInput = $('#input');
  var btnSend = $('#btn-send');
  var btnStop = $('#btn-stop');

  /* ---------------- 视图/抽屉 ---------------- */
  function showView(id) {
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    $(id).classList.add('active');
  }
  function openSheet(id) {
    $('#sheet-mask').classList.add('show');
    $$('.sheet').forEach(function (s) { s.classList.remove('show'); });
    $(id).classList.add('show');
  }
  function closeSheet() {
    $('#sheet-mask').classList.remove('show');
    $$('.sheet').forEach(function (s) { s.classList.remove('show'); });
  }
  function syncTabs() {
    $$('.seg-btn').forEach(function (x) {
      x.classList.toggle('active', x.dataset.tab === state.tab);
    });
  }

  /* =========================================================
   * 角色列表
   * ========================================================= */
  function newPersonaTemplate() {
    return {
      id: uid(),
      name: '新角色',
      avatar: '🙂',
      description: '',
      personality: '',
      scenario: '',
      firstMes: '',
      example: '',
      extra: '',
      createdAt: now(),
      updatedAt: now()
    };
  }

  function renderList() {
    if (state.tab === 'world') return renderWorldList();
    return renderPersonaList();
  }

  function renderPersonaList() {
    return DB.all('personas').then(function (list) {
      state.personas = (list || []).slice().sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return DB.all('worlds');
    }).then(function (worlds) {
      state.worlds = (worlds || []).slice();
      var byId = {};
      state.worlds.forEach(function (w) { byId[w.id] = w; });

      elList.innerHTML = '';

      if (!state.personas.length) {
        elList.innerHTML =
          '<div class="empty"><span class="big">🙂</span>' +
          '还没有角色<br/>点右上角 <b>＋</b> 新建，或 <b>⇩</b> 导入角色卡' +
          '</div>';
        return;
      }

      // 按所属世界分组
      var groups = [];
      var gmap = {};
      state.personas.forEach(function (p) {
        var wid = p.worldId && byId[p.worldId] ? p.worldId : '';
        // 老数据没有 worldId：从世界的 linked 反推
        if (!wid) {
          state.worlds.forEach(function (w) {
            if (!wid && (w.linked || []).indexOf(p.id) >= 0) wid = w.id;
          });
        }
        if (!gmap[wid]) {
          gmap[wid] = { wid: wid, world: byId[wid] || null, list: [] };
          groups.push(gmap[wid]);
        }
        gmap[wid].list.push(p);
      });

      // 有世界的排前面，未归属的排最后
      groups.sort(function (a, b) {
        if (a.wid && !b.wid) return -1;
        if (!a.wid && b.wid) return 1;
        if (a.wid && b.wid) {
          return (a.world.name || '').localeCompare(b.world.name || '', 'zh');
        }
        return 0;
      });

      groups.forEach(function (g) {
        var head = document.createElement('div');
        head.className = 'wgroup';

        var icon = document.createElement('span');
        icon.className = 'wg-icon';
        icon.textContent = g.world ? (g.world.icon || '🌍') : '📁';

        var nm = document.createElement('span');
        nm.className = 'wg-name';
        nm.textContent = g.world ? (g.world.name || '未命名世界') : '未归属角色';

        var cnt = document.createElement('span');
        cnt.className = 'wg-count';
        cnt.textContent = g.list.length;

        head.appendChild(icon);
        head.appendChild(nm);
        head.appendChild(cnt);

        if (g.world) {
          head.addEventListener('click', function () { openWorldEditor(g.world); });
        }

        elList.appendChild(head);

        g.list.forEach(function (p) {
          var card = document.createElement('div');
          card.className = 'pcard';
          card.dataset.id = p.id;

          var av = document.createElement('div');
          av.className = 'pav';
          av.textContent = p.avatar || '🙂';

          var info = document.createElement('div');
          info.className = 'pinfo';

          var row1 = document.createElement('div');
          row1.className = 'prow1';
          var nm2 = document.createElement('span');
          nm2.className = 'pname';
          nm2.textContent = p.name || '未命名';
          row1.appendChild(nm2);

          var row2 = document.createElement('div');
          row2.className = 'prow2';
          var pv = document.createElement('span');
          pv.className = 'pprev';
          var desc = (p.description || p.personality || '').replace(/\s+/g, ' ');
          pv.textContent = desc ? desc.slice(0, 40) : '点击编辑角色卡';
          row2.appendChild(pv);

          info.appendChild(row1);
          info.appendChild(row2);
          card.appendChild(av);
          card.appendChild(info);

          var editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'card-edit';
          editBtn.title = '编辑角色卡';
          editBtn.textContent = '✎';
          editBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            openPersonaEditor(p);
          });
          card.appendChild(editBtn);

          // ★ 点卡片 = 编辑（不再进入聊天）
          card.addEventListener('click', function () { openPersonaEditor(p); });
          elList.appendChild(card);
        });
      });
    }).catch(function (e) {
      elList.innerHTML = '<div class="empty">读取数据失败：' + (e && e.message ? e.message : e) + '</div>';
    });
  }

  function renderWorldList() {
    return DB.all('worlds').then(function (list) {
      state.worlds = (list || []).sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return DB.all('worldSaves');
    }).then(function (saves) {
      var map = {};
      (saves || []).forEach(function (s) { map[s.id] = s; });

      elList.innerHTML = '';
      if (!state.worlds.length) {
        elList.innerHTML =
          '<div class="empty"><span class="big">🌍</span>' +
          '还没有世界<br/>点右上角 <b>＋</b> 建一个，AI 当 GM 带你玩' +
          '</div>';
        return;
      }

      state.worlds.forEach(function (w) {
        var s = map[w.id];
        var msgs = (s && s.messages) ? s.messages.filter(function (m) { return !m.hidden; }) : [];
        var last = msgs.length ? msgs[msgs.length - 1] : null;
        var preview = last
          ? last.content.replace(/[#*`>\n]/g, ' ').replace(/\s+/g, ' ')
          : (w.opening || w.setting || '点击开始冒险');

        var card = document.createElement('div');
        card.className = 'pcard';

        var av = document.createElement('div');
        av.className = 'pav';
        av.textContent = w.icon || '🌍';

        var info = document.createElement('div');
        info.className = 'pinfo';
        var nm = document.createElement('div');
        nm.className = 'pname';
        nm.textContent = w.name || '未命名世界';
        var pv = document.createElement('div');
        pv.className = 'pprev';
        pv.textContent = preview ? preview.slice(0, 60) : '点击开始冒险';
        var mt = document.createElement('div');
        mt.className = 'pmeta';
        var turns = msgs.filter(function (m) { return m.role === 'user'; }).length;
        mt.textContent = 'GM · ' + turns + ' 回合' +
          (w.linked && w.linked.length ? ' · ' + w.linked.length + ' 名 NPC' : '');

        info.appendChild(nm); info.appendChild(pv); info.appendChild(mt);
        card.appendChild(av); card.appendChild(info);

        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'card-edit';
        editBtn.title = '编辑世界设定';
        editBtn.textContent = '✎';
        editBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openWorldEditor(w);
        });
        card.appendChild(editBtn);

        card.addEventListener('click', function () { openWorld(w.id); });
        elList.appendChild(card);
      });
    }).catch(function (e) {
      elList.innerHTML = '<div class="empty">读取数据失败：' + (e && e.message ? e.message : e) + '</div>';
    });
  }

  function updateFoot() {
    if (state.tab === 'world') {
      DB.all('worldSaves').then(function (ss) {
        var turns = 0;
        (ss || []).forEach(function (s) {
          turns += (s.messages || []).filter(function (m) { return m.role === 'user'; }).length;
        });
        $('#list-foot').textContent = state.worlds.length + ' 个世界 · ' + turns + ' 回合 · 数据仅存本机';
      }).catch(function () { });
      return;
    }
    // 角色模式已改为纯管理：只统计角色数，不再统计聊天消息
    var nWorlds = 0;
    var seen = {};
    (state.personas || []).forEach(function (p) {
      if (p.worldId && !seen[p.worldId]) { seen[p.worldId] = 1; nWorlds++; }
    });
    $('#list-foot').textContent = state.personas.length + ' 个角色 · ' + nWorlds + ' 个世界 · 数据仅存本机';
  }

  /* =========================================================
   * 聊天
   * ========================================================= */
  function currentPersona() {
    for (var i = 0; i < state.personas.length; i++) if (state.personas[i].id === state.personaId) return state.personas[i];
    return null;
  }

  function currentWorld() {
    for (var i = 0; i < state.worlds.length; i++) if (state.worlds[i].id === state.worldId) return state.worlds[i];
    return null;
  }

  function openChat(personaId) {
    stopGen();
    state.mode = 'persona';
    state.tab = 'persona';
    state.personaId = personaId;
    state.worldId = null;
    var p = currentPersona();
    if (!p) return;

    var token = ++state.openToken;

    $('#chat-avatar').textContent = p.avatar || '🙂';
    $('#chat-name').textContent = p.name || '未命名';
    var cfg = state.settings;
    $('#chat-sub').textContent = (cfg.model || '未设置模型') + ' · ' + (LLM.PROVIDERS[cfg.provider] ? LLM.PROVIDERS[cfg.provider].label : '自定义');

    showView('#view-chat');
    elMessages.innerHTML = '';
    state.session = null;

    DB.get('sessions', personaId).then(function (s) {
      if (!s) {
        s = { id: personaId, messages: [], createdAt: now(), updatedAt: now() };
        if (p.firstMes) {
          s.messages.push({ id: uid(), role: 'assistant', content: p.firstMes, ts: now() });
        }
        return DB.put('sessions', s).then(function () { return s; });
      }
      return s;
    }).then(function (s) {
      if (token !== state.openToken) return;
      state.session = s;
      if (!s.messages.length && p.firstMes) {
        s.messages.push({ id: uid(), role: 'assistant', content: p.firstMes, ts: now() });
      }
      // 进入即标记已读
      s.lastReadTs = now();
      DB.put('sessions', s).catch(function () { });
      renderMessages();
    }).catch(function (e) { toast('会话载入失败'); });
  }

  /** 时间线：把线上聊天和世界剧情按时间轴串起来 */
  function openTimeline() {
    if (state.mode !== 'world') { toast('时间线在世界里查看'); return; }
    var w = currentWorld();
    if (!w) return;

    $('#tl-title').textContent = '时间线 · ' + (w.name || '');
    var body = $('#timeline-body');
    body.innerHTML = '<div class="tl-empty">正在整理…</div>';
    openSheet('#sheet-timeline');

    loadPersonaMemory(w).then(function () {
      var items = [];

      // 世界剧情
      ((state.session && state.session.messages) || []).forEach(function (m) {
        if (m.hidden) return;
        items.push({
          ts: m.ts || 0,
          kind: 'world',
          label: '',
          isUser: m.role === 'user',
          who: m.role === 'user' ? '你的行动' : 'GM',
          text: m.content
        });
      });

      // 关联角色的线上聊天
      (w.linked || []).forEach(function (id) {
        var p = findPersonaById(id);
        var s = (state.personaMemory || {})[id];
        if (!p || !s || !s.messages) return;
        s.messages.forEach(function (m) {
          if (m.hidden) return;
          items.push({
            ts: m.ts || 0,
            kind: 'chat',
            label: p.name || '她',
            isUser: m.role === 'user',
            who: m.role === 'user' ? '你' : (p.name || '她'),
            text: m.content
          });
        });
      });

      if (!items.length) {
        body.innerHTML = '<div class="tl-empty">还没有记录<br/>先去和角色聊几句，或者在世界里走两步</div>';
        return;
      }

      items.sort(function (a, b) { return a.ts - b.ts; });

      var html = '';
      var lastDay = '';
      items.forEach(function (it) {
        var d = new Date(it.ts || Date.now());
        var dayKey = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        if (dayKey !== lastDay) {
          lastDay = dayKey;
          html += '<div class="time-sep">' + (d.getMonth() + 1) + '月' + d.getDate() + '日</div>';
        }
        var tagCls = it.kind === 'world' ? 'world' : 'chat';
        var tagTxt = it.kind === 'world' ? '世界' : ('与' + it.label + '的聊天');
        var t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        var txt = it.text === undefined ? '' : String(it.text).replace(/\*\*/g, '');
        html += '<div class="tl-item' + (it.isUser ? ' is-user' : '') + '">' +
          '<div class="tl-head">' +
            '<span class="tl-tag ' + tagCls + '">' + escHtml(tagTxt) + '</span>' +
            '<span class="tl-tag">' + escHtml(it.who) + '</span>' +
            '<span class="tl-time">' + t + '</span>' +
          '</div>' +
          '<div class="tl-text">' + escHtml(txt.slice(0, 220)) + (txt.length > 220 ? '…' : '') + '</div>' +
          '</div>';
      });
      body.innerHTML = html;
    });
  }

  /* =========================================================
   * 世界模式（GM 驱动）
   * ========================================================= */
  function openWorld(worldId) {
    stopGen();
    state.mode = 'world';
    state.tab = 'world';
    state.worldId = worldId;
    state.personaId = null;
    var w = currentWorld();
    if (!w) { toast('世界不存在'); return; }

    var token = ++state.openToken;

    $('#chat-avatar').textContent = w.icon || '🌍';
    $('#chat-name').textContent = w.name || '未命名世界';
    $('#chat-sub').textContent = 'GM · ' + (state.settings.model || '未设置模型');

    showView('#view-chat');
    elMessages.innerHTML = '';
    state.session = null;
    state.personaMemory = {};   // 彻底丢掉上一个世界留下的聊天记忆缓存

    DB.get('worldSaves', worldId).then(function (s) {
      if (!s) {
        s = { id: worldId, messages: [], createdAt: now(), updatedAt: now() };
        return DB.put('worldSaves', s).then(function () { return s; });
      }
      return s;
    }).then(function (s) {
      if (token !== state.openToken) return;   // 已经切到别的世界了
      // 防御：存档 id 必须和当前世界一致，否则整份丢弃重建
      if (!s || s.id !== worldId) {
        s = { id: worldId, messages: [], createdAt: now(), updatedAt: now() };
      }
      state.session = s;
      renderMessages();
      // 首次进入 / 重开后为空：先让 GM 生成开局
      if (!s.messages.length) {
        s.messages.push({
          id: uid(),
          role: 'user',
          hidden: true,
          ts: now(),
          content: '（游戏开始。请严格按格式输出：当前状态、场景描写、以及 3 个可选行动。）'
        });
        persistSession();
        runCompletion();
      }
    }).catch(function () { toast('存档载入失败'); });
  }

  function renderMessages() {
    elMessages.innerHTML = '';
    var all = state.session ? state.session.messages : [];
    var msgs = all.filter(function (m) { return !m.hidden; });

    // 最后一条玩家消息（世界模式下允许编辑它）
    var lastUserIdx = -1;
    for (var k = msgs.length - 1; k >= 0; k--) {
      if (msgs[k].role === 'user') { lastUserIdx = k; break; }
    }

    var lastTs = 0;
    msgs.forEach(function (m, i) {
      if (!lastTs || (m.ts && m.ts - lastTs > 5 * 60 * 1000)) appendTimeSep(m.ts);
      if (m.ts) lastTs = m.ts;
      appendBubble(m, { last: i === msgs.length - 1, lastUser: i === lastUserIdx });
    });
    scrollBottom(true);

    // 消息已全部展示 → 标记已读（角色会话才有未读概念）
    if (state.session && state.mode === 'persona') {
      state.session.lastReadTs = now();
      DB.put('sessions', state.session).catch(function () { });
    }
  }

  function appendTimeSep(ts) {
    if (!ts) return;
    var d = document.createElement('div');
    d.className = 'time-sep';
    d.textContent = fmtTime(ts);
    elMessages.appendChild(d);
  }

  /* ---- 世界模式：轻量富文本 + 选项解析 ---- */
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderRich(text) {
    var t = escHtml(text || '');
    // 兜底：模型偶尔把【状态】【变化】接到上一行末尾，强制断行
    t = t.replace(/([^\n])[ \t]*(\*\*【(?:状态|变化)】\*\*)/g, '$1\n\n$2');
    t = t.replace(/^[ \t]*---[ \t]*$/gm, '<hr>');
    t = t.replace(/^[ \t]*#{1,4}[ \t]+(.+)$/gm, '<h3>$1</h3>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    /* 隐藏【状态】【变化】这两个标签本身（chips 已经表达了它们） */
    t = t.replace(/<b>【(?:状态|变化)】<\/b>/g, '<span class="st-hide"></span>');
    t = t.replace(/【(?:状态|变化)】/g, '<span class="st-hide"></span>');
    // 列表项（· - • 开头）
    /* 对话高亮：行内金色，不标说话人（方案 3） */
    t = t.replace(/「([^」\n]{1,160})」/g, '<span class="dlg">「$1」</span>');
    t = t.replace(/&quot;([^\n]{1,160}?)&quot;/g, '<span class="dlg">&quot;$1&quot;</span>');
    /* 中文双引号 "…"（U+201C / U+201D）—— GM 最常用这种 */
    t = t.replace(/\u201C([^\n]{1,160}?)\u201D/g, '<span class="dlg">\u201C$1\u201D</span>');
    /* 单引号变体 '…' */
    t = t.replace(/\u2018([^\n]{1,160}?)\u2019/g, '<span class="dlg">\u2018$1\u2019</span>');
    t = t.replace(/^[ \t]*[-·•][ \t]+(.+)$/gm, '<li>$1</li>');
    t = t.replace(/(?:<li>[^\n]*<\/li>[ \t]*\n?)+/g, function (m) {
      return '<ul>' + m.replace(/\n/g, '') + '</ul>';
    });
    t = t.replace(/\n/g, '<br>');
    /* 对话块前后不留多余 br（display:block 已经负责换行） */
    t = t.replace(/(<\/span>)(?:<br>)+/g, '$1');
    t = t.replace(/(?:<br>)+(<span class="dlg">)/g, '$1');
    return t;
  }

  /** 从 GM 输出末尾提取 3 条可选行动 */
  function extractOptions(text) {
    var t = String(text || '');
    var idx = t.lastIndexOf('---');
    var tail = idx >= 0 ? t.slice(idx + 3) : t.slice(Math.max(0, t.length - 400));
    var opts = [];
    tail.split('\n').forEach(function (line) {
      var m = line.match(/^[ \t]*(?:\d+[.、)]|[-*•])[ \t]*(.{2,60})$/);
      if (m) opts.push(m[1].trim());
    });
    return opts.length >= 2 ? opts.slice(0, 5) : [];
  }

  function appendBubble(m, opt) {
    opt = opt || {};
    var isWorld = state.mode === 'world';
    var isUser = m.role === 'user';
    var isSys = m.role === 'system';

    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (isUser ? 'user' : isSys ? 'sys' : 'ai');
    if (isWorld && !isUser && !isSys) wrap.className += ' rich';

    // —— 头像（微信式圆角方块）——
    var av = document.createElement('span');
    av.className = 'mava' + (isUser ? ' me' : '');
    if (isUser) {
      av.textContent = String(state.settings.userName || '你').trim().slice(0, 1) || '你';
    } else if (isSys) {
      av.textContent = '⚠';
    } else if (isWorld) {
      var cw = currentWorld();
      av.textContent = (cw && cw.icon) || '🎲';
    } else {
      var cp = currentPersona();
      av.textContent = (cp && cp.avatar) || '🙂';
    }

    var box = document.createElement('div');
    box.className = 'bb-wrap';

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (opt.pending && !m.content) {
      bubble.innerHTML = '<span class="typing"><em>对方正在输入</em><i></i><i></i><i></i></span>';
    } else if (isWorld && !isUser && !isSys) {
      // 若解析出可选行动，正文里那段列表由按钮代替，避免重复显示
      var body = m.content;
      if (extractOptions(body).length) {
        var cut = body.lastIndexOf('---');
        if (cut >= 0) body = body.slice(0, cut).trim();
      }
      bubble.innerHTML = renderRich(body);
    } else {
      bubble.textContent = m.content;
    }

    box.appendChild(bubble);

    if (!isUser && !isSys && !opt.pending) {
      // 世界模式：只给最后一轮显示可选行动按钮
      if (isWorld && opt.last) {
        var choice = extractOptions(m.content);
        if (choice.length) {
          var optBox = document.createElement('div');
          optBox.className = 'world-options';
          choice.forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'opt-btn';
            b.textContent = t;
            b.addEventListener('click', function () {
              if (state.streaming) return;
              elInput.value = t;
              sendMessage();
            });
            optBox.appendChild(b);
          });
          box.appendChild(optBox);
        }
      }

      var tools = document.createElement('div');
      tools.className = 'msg-tools';
      var bCopy = document.createElement('button');
      bCopy.textContent = '复制';
      bCopy.onclick = function () {
        navigator.clipboard && navigator.clipboard.writeText(m.content).then(function () { toast('已复制'); },
          function () { toast('复制失败'); });
      };
      var bSpeak = document.createElement('button');
      bSpeak.textContent = '朗读';
      bSpeak.onclick = function () { speak(m.content); };
      tools.appendChild(bCopy); tools.appendChild(bSpeak);
      if (opt.last) {
        var bRegen = document.createElement('button');
        bRegen.textContent = '重新生成';
        bRegen.onclick = function () { regenerate(); };
        tools.appendChild(bRegen);
      }
      box.appendChild(tools);
    }

    // 世界模式：最后一条玩家消息可以编辑
    if (isWorld && isUser && opt.lastUser && !opt.pending) {
      var utl = document.createElement('div');
      utl.className = 'msg-tools';
      var bEdit = document.createElement('button');
      bEdit.textContent = '编辑';
      bEdit.onclick = function () { openMsgEditor(m.id); };
      utl.appendChild(bEdit);
      box.appendChild(utl);
    }

    if (isWorld && !isUser && !isSys) {
      wrap.classList.add('noav');   // 世界剧情不显示头像，界面更干净
    } else {
      wrap.appendChild(av);
    }
    wrap.appendChild(box);
    elMessages.appendChild(wrap);
    if (!isUser) state.lastAiEl = wrap;

    if (opt.autoscroll !== false) {
      var near = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 160;
      if (near || opt.force) scrollBottom();
    }
    return { wrap: wrap, bubble: bubble };
  }

  function setBubbleText(bubble, text) {
    bubble.textContent = text;
    var c = document.createElement('span');
    c.className = 'cursor';
    bubble.appendChild(c);
  }

  function scrollBottom(force) {
    elMessages.scrollTop = elMessages.scrollHeight;
  }

  /* ---------------- 提示词构造 ---------------- */
  /** 载入该角色在所有关联世界里的线下经历（供角色聊天时参考） */
  function loadWorldMemoryForPersona(p) {
    state.worldMemoryForPersona = '';
    if (!p || !state.worlds || !state.worlds.length) return Promise.resolve();
    var ws = state.worlds.filter(function (w) {
      return (w.linked || []).indexOf(p.id) >= 0;   // 不受 syncChat 控制：那个开关管的是反方向
    });
    if (!ws.length) return Promise.resolve();
    return DB.all('worldSaves').then(function (saves) {
      var map = {};
      (saves || []).forEach(function (s) { map[s.id] = s; });
      state.worldMemoryForPersona = buildWorldMemory(ws, map);
    }).catch(function () { state.worldMemoryForPersona = ''; });
  }

  /** 把世界剧情压缩成一段「线下经历」，控制总长度避免撑爆上下文 */
  function buildWorldMemory(ws, saves) {
    var out = [];
    var total = 0;
    var LIMIT = 3000;      // 总字数上限（原来 1200 太小，角色常有"记忆对不上"的感觉）
    var PER_SCENE = 260;   // 每幕保留字数（原来 160，砍掉了太多细节）
    var SCENES = 12;       // 保留幕数（原来 6）

    ws.forEach(function (w) {
      var s = saves[w.id];
      if (!s || !s.messages || !s.messages.length) return;

      var recent = s.messages.filter(function (m) {
        return m.content && !m.hidden && m.role === 'assistant';
      }).slice(-SCENES);
      if (!recent.length) return;

      var lines = recent.map(function (m) {
        var raw = String(m.content);

        // ① 抓出状态块里的时间/地点/处境（这是最可靠的记忆锚点，不能丢）
        var anchor = '';
        var st = raw.match(/\*{0,2}【状态】\*{0,2}([\s\S]*?)(?=\n\s*\n|$)/);
        if (st) {
          var parts = [];
          String(st[1]).split('\n').forEach(function (ln) {
            var t = ln.replace(/^[\s·•\-\*]+/, '').replace(/\*/g, '').trim();
            if (t) parts.push(t);
          });
          if (parts.length) anchor = '[' + parts.join(' / ').slice(0, 80) + '] ';
        }

        // ② 正文：去掉状态块、变化块、选项
        var body = raw
          .replace(/\*{0,2}【(?:状态|变化)】\*{0,2}[\s\S]*?(?=\n\s*\n|$)/g, '')
          .replace(/\n\s*---[\s\S]*$/, '')
          .replace(/\*\*/g, '')
          .replace(/【(?:状态|变化)】/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        var line = anchor + body.slice(0, PER_SCENE);
        return '· ' + line.trim();
      }).filter(function (x) { return x.length > 6; });

      if (!lines.length) return;

      var block = '## 在《' + (w.name || '那个世界') + '》里（最近 ' + lines.length + ' 幕）\n' + lines.join('\n');
      if (total + block.length > LIMIT) {
        if (total === 0) { out.push(block.slice(0, LIMIT)); total = LIMIT; }
        return;
      }
      total += block.length;
      out.push(block);
    });

    return out.join('\n\n');
  }

  function buildSystemPrompt(p) {
    var user = state.settings.userName || '你';
    var fill = function (t) {
      return String(t || '')
        .replace(/\{\{char\}\}/g, p.name || '角色')
        .replace(/\{\{user\}\}/g, user)
        .replace(/<BOT>/g, p.name || '角色')
        .replace(/<USER>/g, user);
    };
    var s = '';
    s += '你现在要扮演角色「' + (p.name || '角色') + '」，与用户进行沉浸式、连贯的角色扮演对话。\n\n';
    s += '# 用户\n用户的称呼是「' + user + '」。\n\n';
    if (p.description) s += '# 角色设定\n' + fill(p.description) + '\n\n';
    if (p.personality) s += '# 性格与说话方式\n' + fill(p.personality) + '\n\n';
    if (p.scenario) s += '# 场景\n' + fill(p.scenario) + '\n\n';
    if (p.example) s += '# 对话示例（仅用于学习语气，不要复述）\n' + fill(p.example) + '\n\n';
    if (state.worldMemoryForPersona) {
      s += '# 你和' + user + '的线下经历（剧情里真实发生过，聊天时可以自然提起）\n';
      s += '以下是你们在剧情世界里一起经历过的事。聊天时如果话题相关，可以自然地提到（比如「上次在那条山道上」），'
        + '但不要生硬复述，也不要主动长篇回顾。没被问到就当作背景记忆。\n\n';
      s += state.worldMemoryForPersona + '\n\n';
    }
    s += '# 扮演规则\n';
    s += '1. 永远以「' + (p.name || '角色') + '」的第一人称身份说话，全程不出戏，绝不提及自己是 AI、模型或程序。\n';
    s += '2. 只输出「' + (p.name || '角色') + '」的台词与动作，绝不为「' + user + '」代写台词、心理活动或行为。\n';
    s += '3. 这是手机聊天，只输出对方会打出来的字。不要加（动作）（神态）（语气）这类描写，也不要用引号把整句包起来。想表达情绪就靠措辞本身——用词、停顿、省略号、语气词。\n';
    s += '4. 语言口语化、符合角色性格与场景；每次回复 1~4 句，像真的在打字，不写长篇独白。\n';
    s += '4.1 反面例子（不要这样写）：\n';
    s += '    （一愣，随即瞪圆了眼睛）「补偿？补偿什么呀！」（声音拔高，往后退了半步）\n';
    s += '    正面例子（要这样写）：\n';
    s += '    补偿？补偿什么呀……你这人怎么这样，我室友招你惹你了。\n';
    s += '5. 保持剧情连贯，记住此前发生过的事与细节。\n';
    s += '6. 不要输出任何解释性的旁白或"作为AI我…"之类内容。\n';
    if (p.extra) s += '\n# 额外要求\n' + fill(p.extra) + '\n';
    return s;
  }

  function buildMessages(p, messages) {
    var limit = Math.max(2, Number(state.settings.contextMessages) || 30);
    var hist = messages.slice(-limit).map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
    });
    // 保留开场白（首条可以是 assistant，各厂商在 api.js 已分别处理）
    if (!hist.length) hist.push({ role: 'user', content: '（开始对话）' });
    return [{ role: 'system', content: buildSystemPrompt(p) }].concat(hist);
  }

  /* =========================================================
   * 世界模式：读取角色板块的聊天记录
   * ========================================================= */
  function findPersonaById(id) {
    for (var i = 0; i < state.personas.length; i++) {
      if (state.personas[i].id === id) return state.personas[i];
    }
    return null;
  }

  /** 把关联角色最近的线上聊天载入内存 */
  function loadPersonaMemory(w) {
    if (!w || w.syncChat === false) {
      state.personaMemory = {};
      return Promise.resolve();
    }
    return DB.all('sessions').then(function (list) {
      var map = {};
      (list || []).forEach(function (s) { map[s.id] = s; });
      state.personaMemory = map;
    }).catch(function () { state.personaMemory = {}; });
  }

  /** 生成"线上聊天记忆"文本块，控制总长度避免撑爆上下文 */
  function buildChatMemory(w) {
    var mem = state.personaMemory || {};
    var out = [];
    var total = 0;
    var LIMIT = 1400;

    (w.linked || []).forEach(function (id) {
      var p = findPersonaById(id);
      var s = mem[id];
      if (!p || !s || !s.messages || !s.messages.length) return;

      var recent = s.messages.filter(function (m) { return m.content && !m.hidden; }).slice(-10);
      if (!recent.length) return;

      var lines = recent.map(function (m) {
        var who = m.role === 'user' ? '玩家' : (p.name || '她');
        return who + '：' + m.content.replace(/\s+/g, ' ').slice(0, 110);
      });

      var block = '## 与' + (p.name || '她') + '的线上聊天（最近 ' + lines.length + ' 条）\n' + lines.join('\n');
      if (total + block.length > LIMIT) {
        if (total === 0) { out.push(block.slice(0, LIMIT)); total = LIMIT; }
        return;
      }
      total += block.length;
      out.push(block);
    });

    return out.join('\n\n');
  }

  /* =========================================================
   * 世界模式：GM 提示词
   * ========================================================= */
  function buildWorldSystemPrompt(w) {
    var user = state.settings.userName || '你';
    var len = String(w.length || '400~500 字').trim();
    var s = '';

    /* ★ 长度要求必须放在最前面 —— 模型对靠前的指令权重最高，
       而且它真正模仿的是下面示例的篇幅，所以示例也必须够长。 */
    s += '# ⚠️ 最高优先级：场景正文的长度\n';
    s += '每轮「场景正文」必须写满 ' + len + '（按中文字符计，不含状态块与选项），少于下限即为不合格输出，必须继续展开补足，不能草草收尾。\n';
    s += '宁可多写环境细节、多铺氛围、多写 NPC 的动作与神态，也不要草草收尾。\n';
    s += '这条要求优先于其他任何风格偏好。\n\n';

    s += '你是文字冒险游戏《' + (w.name || '未命名世界') + '》的 GM（游戏主持人 / 裁判）。\n';
    s += '你负责叙述世界、扮演所有 NPC、判定玩家每个行动的后果，并持续把剧情往前推。\n\n';

    var tgp = w.tags || {};
    var tgLine = [];
    if (tgp.gender) tgLine.push('主角性别：' + tgp.gender);
    if (tgp.genre) tgLine.push('题材：' + tgp.genre);
    if (tgp.rel) tgLine.push('关系结构：' + tgp.rel + '（' + (tgp.rel === '无CP' ? '不安排感情线' : '按此结构安排人物关系') + '）');
    if (tgp.heat) tgLine.push('情感尺度：' + tgp.heat + '（描写亲密的程度以此为上限，不要越界也不要刻意回避）');
    if (tgp.tone) tgLine.push('基调：' + tgp.tone);
    if (tgLine.length) {
      s += '# 题材标签\n' + tgLine.join('\n') + '\n';
      s += '（这是对世界的整体定位。写作风格、人物设置、氛围都要贴合这些标签，但不要直接把标签念给玩家听。）\n\n';
    }

    if (w.setting) s += '# 世界设定\n' + w.setting + '\n\n';
    if (w.playerRole) s += '# 玩家的身份（' + user + '）\n' + w.playerRole + '\n\n';
    if (w.systems) s += '# 特殊系统 / 能力\n' + w.systems + '\n\n';

    if (w.opening) s += '# 开局背景（视为已经发生过，不要原文重述）\n' + w.opening + '\n\n';

    // 注入角色卡（世界读取角色板块的信息）
    var linked = [];
    (w.linked || []).forEach(function (id) {
      for (var i = 0; i < state.personas.length; i++) {
        if (state.personas[i].id === id) { linked.push(state.personas[i]); break; }
      }
    });
    if (linked.length) {
      s += '# 世界中的关键角色（以下人设必须严格遵守，性格与说话方式不可改变）\n';
      linked.forEach(function (p) {
        s += '\n## ' + (p.name || '某人') + '\n';
        if (p.description) s += '设定：' + p.description + '\n';
        if (p.personality) s += '性格 / 说话方式：' + p.personality + '\n';
        if (p.scenario) s += '初遇情境：' + p.scenario + '\n';
        if (p.example) s += '台词示例：\n' + p.example + '\n';
        if (p.extra) s += '补充：' + p.extra + '\n';
      });
      s += '\n这些角色由你代替他们说话和行动，但他们只是 NPC，绝不能替玩家做决定。\n\n';
    }

    // —— 线上聊天记忆（来自「角色」板块）——
    if (w.syncChat !== false) {
      var chatMem = buildChatMemory(w);
      if (chatMem) {
        s += '# 线上聊天记忆（你和她们私下的手机聊天，剧情可以呼应）\n';
        s += '下面是你和她们最近的真实聊天片段，代表你们的关系已经进展到了哪一步。'
          + '在合适的时机自然地呼应——提起聊过的事、延续当时的情绪、沿用当时的称呼，但不要生硬复述原文。'
          + '如果这些内容与世界设定冲突，以世界设定为准。\n\n';
        s += chatMem + '\n\n';
      }
    }

    s += '# 每次回复的固定结构（严格遵守）\n';
    s += '第一部分：状态块。第一行只写 **【状态】**，从第二行起每项单独一行、以「· 」开头：\n';
    s += '**【状态】**\n· 时间：…\n· 地点：…\n· 处境：…\n';
    var hasSystems = String(w.systems || '').replace(/\s/g, '').length > 0;
    if (hasSystems) {
      s += '状态有变化时紧接着再补一个块，同样每项一行：\n';
      s += '**【变化】**\n· <特殊系统里真实存在的某个数值名> −8（当前 92）\n';
      s += '⚠️ 数值名称只能用本世界「特殊系统」里已经定义好的项，从系统设定里原样抄，绝不能自创，也不能沿用其他世界的名字。\n';
    } else {
      s += '⚠️ 本世界**没有设定任何数值系统**。因此：只写【状态】这一个块，**绝对不要**出现【变化】块，也不要写任何「××值」「××度」「××条」这类数值或进度条。\n';
    }
    s += '⚠️ 状态块必须独占若干行，绝对不能和场景正文写在同一行。\n\n';
    s += '第二部分：空一行，写场景正文。长度见开头「最高优先级」那一节：' + len + '。\n';
    s += '⚠️ 正文必须分成 3~4 个自然段，段与段之间必须空一行（两个换行符）。\n';
    s += '每段正文不得少于 120 字，4 段合计 480 字以上——这是硬指标，不是建议。\n';
    s += '四段各承担一件事：一段写环境/氛围，一段写事件或动作，一段写人物反应，一段写处境的变化。\n';
    s += '写不满就继续加细节：手上的动作、脚下的路、风的方向、对方说话时的表情、你身体的感觉。\n';
    s += '禁止把 ' + len + ' 挤成一整块。挤成一整块视为不合格输出。\n';
    if (w.style) s += '风格要求：' + w.style + '\n';
    s += '如果玩家上一步行动产生了结果，必须写出明确收益、推进或代价。\n\n';
    s += '第三部分：另起一行写 --- ，再用 3 条编号列出可选行动，每条不超过 25 字。\n\n';

    s += '第四部分（可选）：角色发微信。\n';
    s += '如果剧情里确实发生了「某个角色用手机给你发消息」的情况，在选项之后另起一行，按这个格式写：\n';
    s += '【微信】角色名|她发的内容\n';
    s += 'App 会自动把这行送去对应角色的聊天窗口，玩家在那里能看到。\n';
    s += '规则：① 只有剧情里真的发生了才写，不要每轮都写，也不要为了用这个功能硬造情节；\n';
    s += '② 一次写 1~4 条，像真人连发微信那样（先问一句、再补一句、最后一句情绪化的）；超过 4 条 App 会丢掉多余的；\n';
    s += '③ 内容必须契合当前剧情（她刚看到的事、她的心情、刚才对话里的某个细节）；\n';
    s += '④ 用角色自己的说话风格，像真人发微信，不要写成旁白或解说；⑤ 角色名必须是世界设定里已有的角色。\n';
    s += '正文里仍然要自然地写出「你手机震了一下」这类动作，不要只留标记。\n\n';

    /* ★ 示例的篇幅决定模型的实际输出篇幅，这一段是控字数的真正开关 */
    s += '完整输出示例（严格模仿这个结构、换行与篇幅）：\n';
    s += '**【状态】**\n· 时间：下午两点零七分\n· 地点：江临大学教学楼 302 教室\n· 处境：你坐在倒数第二排靠窗，鼻子有点发痒\n\n';
    s += '讲台上的中年教授正用激光笔点着 PPT，白色光点在满是公式的页面上跳来跳去。'
      + '空调坏了三天，报修单还压在后勤处某张桌子上，三十多个人挤在一间教室里，热得像蒸笼。'
      + '头顶那台吊扇有气无力地转着，扇叶搅动的空气带着一股陈旧的灰尘味，吹到脸上是温的。\n\n';
    s += '你坐在倒数第二排靠窗的位置，手肘支在桌面上，指尖无意识地敲着课本边缘。'
      + '右前方的女生忽然动了——她把搭在椅背上的外套拿起来，重新穿回身上，动作快得有点不自然，'
      + '像是忽然想起了什么。她低头整理袖口的时候，后颈露出一小截，被窗外漏进来的光切出一道弧线，'
      + '皮肤上浮着一层薄薄的汗意。\n\n';
    s += '教室后排传来看球赛的闷响，几个男生凑在一起，屏幕压得很低，嗡嗡的震动声混在吊扇的吱呀声里。'
      + '有人打哈欠，有人翻书，粉笔灰在光柱里慢慢往下沉。\n\n';
    s += '斜前方有个女生一直在低头写字，笔尖沙沙地划过纸面，写到一半忽然停了，把笔帽咬在嘴里，'
      + '盯着本子发愣。她桌角压着一张皱巴巴的纸，露出半截字迹，像是没写完的申请书，'
      + '末尾那句被反复涂改过，墨迹都洇进了纸背。\n\n';
    s += '窗外的梧桐叶被晒得发蔫，一阵风过，影子在墙面上晃了晃，晃得人眼睛发花。'
      + '前排忽然有人举手，是个声音有点犹豫的男生：「老师，空调真的修不好吗？」'
      + '教室里响起一阵低低的笑声，连教授自己也笑了一下，抬手抹了把额头上的汗，'
      + '说修不好就先忍着，心静自然凉。这话换来又一阵哄笑，有人把课本当扇子扇得哗哗响。\n\n'
      + '就在你准备低头继续装死的时候，走廊尽头传来一阵脚步声——很慢，一下，又一下，'
      + '最后停在了教室后门。门上的小窗透进一块方形的光，被人影遮住了一瞬。'
      + '你侧过身，用只有边上能听见的声音问：「后门今天有人上课吗？」'
      + '旁边那人回头看了眼，摇了摇头，喉结动了动，又把头转回黑板那边，装作什么都没发生。'
      + '你把手从课本边缘收回来，慢慢坐直了一点，视线落在后门那块被遮住的光上。\n\n';
    s += '---\n1. 低头装作没听见，继续写自己的笔记\n2. 直接开口问他到底想说什么\n3. 先退开半步，观察周围其他人的反应\n\n';

    s += '# 铁律\n';
    s += '1. 不替玩家做决定、不写玩家的内心独白。但**主角说出口的话是要写的**，见下面第 11 条。\n';
    s += '2. 玩家每个行动都要有后果：合理则推进，鲁莽则付出代价，不要无条件顺着玩家。\n';
    s += '3. 剧情必须持续推进，不原地打转，不重复上一段写过的内容。\n';
    s += '4. NPC 有独立动机和底线，不会无缘无故讨好或喜欢玩家。\n';
    s += '5. 严守世界观与已发生的事实，不产生矛盾，不引入设定之外的元素。\n';
    s += '5.1 状态块和选项里出现的任何数值、属性、资源名称，都必须来自本世界的「特殊系统」设定。世界没设数值系统，就完全不要写【变化】块，也不要凭空发明「××值」。\n';
    s += '6. 全程第二人称「你」叙述。不出现「作为 AI」「以下是」这类出戏内容，不要解释自己在做什么。\n';
    s += '7. 世界里的指定角色要在场景合适时自然登场，不要生硬塞入；他们登场后必须严格符合其人设。\n';
    s += '8. 不要说「好的，让我们开始」这类开场白，直接从 **【状态】** 开始写。\n';
    s += '9. 场景正文必须达到开头规定的字数下限（' + len + '，按中文字符计，不含状态块与选项）。少于下限即为不合格输出，必须继续展开场景细节、动作过程或 NPC 反应，直到写满为止。\n';
    s += '10. 场景正文必须分成 3~4 个自然段，段与段之间空一行。整段挤在一起视为不合格输出。\n';
    s += '11. ★ 主角也要开口说话。每轮正文里至少要有一句主角（「你」）说出口的话，用「」或""包起来，自然插在叙述里。\n';
    s += '    例：你蹲下去，尽量压低声音："先别出声，听外面。"\n';
    s += '    规则：只写他说出来的话，不写他在想什么、也不替他做决定（不要写「你决定冲上去」这种）。\n';
    s += '    如果整轮只有 NPC 在说话、主角一句没说，视为不合格输出。\n';
    s += '    例外：如果下面的「世界铁律」明确要求「不要写主角台词」，以世界铁律为准。\n';

    /* ★ 世界铁律放在最后：模型对靠后的指令权重最高，
       这样用户在「世界铁律」里写的规则才能真正覆盖上面的默认铁律。 */
    if (w.rules) {
      s += '\n# 世界铁律（★ 优先级高于上面所有默认规则，冲突时以本节为准）\n';
      s += w.rules + '\n';
    }

    return s;
  }

  function buildWorldMessages(w, save) {
    var limit = Math.max(4, Number(state.settings.contextMessages) || 30);
    // 隐藏的「开局触发」消息只在还没有任何正式内容时使用
    var visible = save.messages.filter(function (m) { return !m.hidden; });
    var use = visible.length ? visible : save.messages;
    var hist = use.slice(-limit).map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
    });
    if (!hist.length) hist.push({ role: 'user', content: '（游戏开始）' });
    return [{ role: 'system', content: buildWorldSystemPrompt(w) }].concat(hist);
  }

  function apiConfig() {
    var s = state.settings;
    var prov = LLM.PROVIDERS[s.provider] || LLM.PROVIDERS.custom;
    return {
      kind: prov.kind,
      base: s.base || prov.base,
      apiKey: s.apiKey || '',
      model: s.model || prov.model,
      temperature: Number(s.temperature),
      maxTokens: Number(s.maxTokens) || 1024
    };
  }

  function hasUsableConfig() {
    var c = apiConfig();
    if (!c.model) return false;
    if (!c.apiKey && !/localhost|127\.0\.0\.1|192\.168|10\.\d/.test(c.base)) return false;
    return true;
  }

  /* =========================================================
   * 试用限制（仅试用限制版包含这一段）
   * 未激活时每个账号总共只能发送 TRIAL_LIMIT 条消息，
   * 激活后永久解锁。计数值存在 localStorage，清存档不会重置。
   * ========================================================= */
  var TRIAL_LIMIT = 18;
  var TRIAL_SECRET = 'AISIM-TRIAL-2026-K7QX9MBV3PLC4RZN';
  var TRIAL_PRESET_KEY = PRESET_KEY;
  var TRIAL_KEY_USED = 'aisim.trial.used.v1';
  var TRIAL_KEY_UNLOCK = 'aisim.trial.unlock.v1';
  var TRIAL_B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function trialUsed() {
    try { return parseInt(localStorage.getItem(TRIAL_KEY_USED) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function trialUnlocked() {
    try { return localStorage.getItem(TRIAL_KEY_UNLOCK) === '1'; } catch (e) { return false; }
  }
  function trialAddUse() {
    try { localStorage.setItem(TRIAL_KEY_USED, String(trialUsed() + 1)); } catch (e) { }
  }
  function trialRemain() {
    if (trialUnlocked()) return Infinity;
    return Math.max(0, TRIAL_LIMIT - trialUsed());
  }

  function b32ToBytes(s) {
    var out = [], bits = 0, val = 0;
    for (var i = 0; i < s.length; i++) {
      var idx = TRIAL_B32.indexOf(s.charAt(i));
      if (idx < 0) return null;
      val = (val << 5) | idx;
      bits += 5;
      if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
    }
    return out;
  }

  function bytesToB32(bytes) {
    var out = '', bits = 0, val = 0;
    for (var i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { bits -= 5; out += TRIAL_B32.charAt((val >> bits) & 31); }
    }
    if (bits > 0) out += TRIAL_B32.charAt((val << (5 - bits)) & 31);
    return out;
  }

  /** 校验激活码：12 位，格式 XXXX-XXXX-XXXX，后 6 位是 HMAC 签名 */
  async function trialVerifyCode(code) {
    var raw = String(code || '').toUpperCase()
      .split('').filter(function (c) { return TRIAL_B32.indexOf(c) >= 0; }).join('');
    if (raw.length !== 12) return false;
    var payload = raw.slice(0, 6);
    var sig = raw.slice(6);
    var pBytes = b32ToBytes(payload);
    if (!pBytes) return false;
    try {
      var enc = new TextEncoder();
      var key = await crypto.subtle.importKey(
        'raw', enc.encode(TRIAL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      var mac = await crypto.subtle.sign('HMAC', key, new Uint8Array(pBytes));
      var expect = bytesToB32(new Uint8Array(mac)).slice(0, 6);
      return expect === sig;
    } catch (e) {
      return false;
    }
  }

  function openActivateSheet() {
    $('#act-status').textContent = trialUnlocked()
      ? '已激活，感谢支持。'
      : '免费体验已用完（' + TRIAL_LIMIT + '/' + TRIAL_LIMIT + ' 条）';
    $('#act-code').value = '';
    $('#act-msg').textContent = '';
    $('#act-msg').className = 'test-out';
    openSheet('#sheet-activate');
    setTimeout(function () { autoGrow($('#act-code')); }, 60);
  }

  async function doActivate() {
    var code = $('#act-code').value.trim();
    var msg = $('#act-msg');
    if (!code) { msg.className = 'test-out err'; msg.textContent = '请先填写激活码'; return; }
    msg.className = 'test-out';
    msg.textContent = '正在校验…';
    var ok = await trialVerifyCode(code);
    if (!ok) {
      msg.className = 'test-out err';
      msg.textContent = '激活码无效，请检查是否输错（注意区分 0/O、1/I）';
      return;
    }
    try { localStorage.setItem(TRIAL_KEY_UNLOCK, '1'); } catch (e) { }

    // ★ 激活后立刻断掉预置的试用 Key：后续由用户自己承担 API 费用
    var needOwnKey = false;
    if (state.settings.apiKey === TRIAL_PRESET_KEY) {
      state.settings.apiKey = '';
      saveSettings(state.settings);
      needOwnKey = true;
    }

    msg.className = 'test-out ok';
    msg.textContent = needOwnKey
      ? '✓ 激活成功。试用额度已用完，接下来请填写你自己的 API Key 继续游玩。'
      : '✓ 激活成功，已解锁完整功能';
    refreshTrialBadge();

    setTimeout(function () {
      closeSheet();
      toast('已激活');
      if (needOwnKey) setTimeout(openSettings, 500);
    }, needOwnKey ? 1800 : 900);
  }

  /** 在设置面板里显示当前试用状态 */
  function refreshTrialBadge() {
    var el = $('#s-trial');
    if (!el) return;
    var usingPreset = state.settings.apiKey === TRIAL_PRESET_KEY;
    el.className = 'hint';
    if (trialUnlocked()) {
      if (!state.settings.apiKey) {
        el.textContent = '✓ 已激活 · 请填写你自己的 API Key 才能继续游玩';
      } else if (usingPreset) {
        el.textContent = '✓ 已激活 · 正在使用内置试用 Key，建议换成自己的';
      } else {
        el.textContent = '✓ 已激活，无限制使用';
      }
    } else {
      el.textContent = '试用版：已用 ' + trialUsed() + '/' + TRIAL_LIMIT + ' 条'
        + '，剩余 ' + trialRemain() + ' 条。点「输入激活码」解锁。';
    }
  }

  /**
   * 第二道锁：运行时兜底。
   * 世界没设数值系统时，把模型擅自写出的【变化】块整段删掉。
   * 即使模型不听话，玩家也看不到凭空发明的数值。
   */
  function sanitizeWorldOutput(text) {
    if (!text) return text;
    var w = currentWorld();
    if (!w) return text;
    var hasSystems = String(w.systems || '').replace(/\s/g, '').length > 0;
    if (hasSystems) return text;

    var out = String(text);
    // 删掉 **【变化】** 或 【变化】 标题，连同其后的「· xxx」明细行
    out = out.replace(/\*?\*?【变化】\*?\*?[^\n]*\n(?:[ \t]*[·•][^\n]*\n?)*/g, '');
    return out.replace(/\n{3,}/g, '\n\n');
  }

  /* =========================================================
   * 世界剧情 → 角色微信：跨窗口消息转投
   * GM 可以在回复里用【微信】角色名|内容 的方式，让某个角色
   * 真的在「角色」窗口里发一条消息，内容与当前剧情契合。
   * ========================================================= */
  var WX_RE = /【微信】\s*([^|｜\n：:]+?)\s*[|｜：:]\s*([^\n]+)/g;

  function extractWechatLines(text) {
    var out = [];
    if (!text) return out;
    WX_RE.lastIndex = 0;
    var m;
    while ((m = WX_RE.exec(text)) !== null) {
      var nm = m[1].trim();
      var body = m[2].trim();
      if (nm && body) out.push({ name: nm, text: body });
      if (out.length >= 4) break;
    }
    return out;
  }

  function stripWechatLines(text) {
    if (!text) return text;
    WX_RE.lastIndex = 0;
    var out = text.replace(WX_RE, '');
    return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  /* 把消息写进对应角色的会话（角色窗口）
     注意：角色列表必须从数据库里读，不能用内存里的 state.personas——
     导入卡包时角色是写进数据库的，内存里的 state.personas 可能是空的。 */
  var wxLastSig = '';
  var wxLastAt = 0;

  function pushWechatMessages(lines) {
    if (!lines || !lines.length) return Promise.resolve(0);
    // 诊断计数：如果被重复调用，这里会暴露出来
    window.__wxCalls = (window.__wxCalls || 0) + 1;
    window.__wxLines = (window.__wxLines || []).concat(lines.map(function (x) { return x.text; }));

    // 整批签名去重：同一批内容 10 秒内只投递一次（防止回调重复触发 / 网络重试）
    var sig = lines.map(function (x) { return x.name + '|' + x.text; }).join('\n');
    if (sig === wxLastSig && (now() - wxLastAt) < 10000) {
      window.__wxDedup = (window.__wxDedup || 0) + 1;
      return Promise.resolve(0);
    }
    wxLastSig = sig;
    wxLastAt = now();

    return DB.all('personas').then(function (list) {
      var byName = {};
      (list || []).forEach(function (pp) {
        if (pp && pp.name) byName[pp.name] = pp;
      });
      var chain = Promise.resolve(0);
      lines.forEach(function (line) {
        chain = chain.then(function (n) {
          var target = byName[line.name];
          if (!target) return n;
          return DB.get('sessions', target.id).then(function (s) {
            if (!s) s = { id: target.id, messages: [], createdAt: now(), updatedAt: now() };
            if (!s.messages) s.messages = [];
            s.messages.push({ id: uid(), role: 'assistant', content: line.text, ts: now(), fromWorld: true });
            s.updatedAt = now();
            return DB.put('sessions', s).then(function () { return n + 1; });
          }).catch(function () { return n; });
        });
      });
      return chain;
    }).catch(function () { return 0; });
  }

  /* ---------------- 发送 / 生成 ---------------- */
  function setStreaming(on) {
    state.streaming = on;
    btnSend.classList.toggle('hidden', on);
    btnStop.classList.toggle('hidden', !on);
    elInput.disabled = false;
  }

  function sendMessage() {
    var text = elInput.value.replace(/\r/g, '').trim();
    if (!text || state.streaming) return;
    if (!hasUsableConfig()) {
      toast('先在设置里填 API Key 和模型');
      openSettings();
      return;
    }
    if (!state.session) return;

    // 试用额度检查
    if (!trialUnlocked() && trialRemain() <= 0) {
      openActivateSheet();
      return;
    }

    elInput.value = '';
    elInput.style.height = 'auto';

    var um = { id: uid(), role: 'user', content: text, ts: now() };
    state.session.messages.push(um);
    trialAddUse();
    appendBubble(um, { force: true });
    persistSession();
    runCompletion();
  }

  async function runCompletion() {
    if (!state.session) return;

    // 捕获当前会话引用：生成过程中会话可能被重开或切换，回调必须能识别出来
    var mySession = state.session;

    var isWorld = state.mode === 'world';
    var p = isWorld ? null : currentPersona();
    var w = isWorld ? currentWorld() : null;
    if (isWorld ? !w : !p) return;

    var placeholder = appendBubble({ role: 'assistant', content: '' }, { pending: true, force: true });
    var bubble = placeholder.bubble;
    var acc = '';
    var raf = 0;

    var ac = new AbortController();
    state.ac = ac;
    setStreaming(true);
    scrollBottom();

    // 世界模式：先把关联角色的线上聊天读进内存
    if (isWorld) {
      try { await loadPersonaMemory(w); } catch (e) { /* 读不到就跳过 */ }
    } else {
      try { await loadWorldMemoryForPersona(p); } catch (e) { state.worldMemoryForPersona = ''; }
    }

    // 等待期间会话可能已被重开 / 切换，直接放弃这次生成
    if (state.session !== mySession) {
      if (state.ac === ac) { state.ac = null; setStreaming(false); }
      return;
    }

    var flush = function () {
      raf = 0;
      var near = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 200;
      setBubbleText(bubble, acc);
      if (near) scrollBottom();
    };

    var msgs = isWorld
      ? buildWorldMessages(w, mySession)
      : buildMessages(p, mySession.messages);

    LLM.streamChat(apiConfig(), msgs, {
      signal: ac.signal,
      onDelta: function (piece, full) {
        if (state.session !== mySession) return;
        acc = full;
        if (!raf) raf = requestAnimationFrame(flush);
      }
    }).then(function (full) {
      if (state.session !== mySession) return;   // 已被重开/切换，丢弃结果
      acc = full || acc;
      acc = sanitizeWorldOutput(acc);   // 第二道锁：删掉本世界不该有的【变化】块

      // 世界剧情里角色发来的微信 → 转投到角色聊天窗口
      if (state.mode === 'world') {
        var wxLines = extractWechatLines(acc);
        if (wxLines.length) {
          acc = stripWechatLines(acc);
          pushWechatMessages(wxLines).then(function (n) {
            if (n > 0) toast('收到 ' + n + ' 条新消息');
          });
        }
      }

      bubble.textContent = acc;
      if (!acc.trim()) bubble.textContent = '（没有收到内容，检查模型名 / 额度 / 接口是否支持流式）';

      var am = { id: uid(), role: 'assistant', content: acc, ts: now() };
      mySession.messages.push(am);
      persistSession();
      renderMessages();
      if (state.settings.tts) speak(acc);
    }).catch(function (err) {
      if (state.session !== mySession) return;
      if (err && err.name === 'AbortError') {
        bubble.textContent = acc ? acc + '\n\n（已停止）' : '（已停止）';
        if (acc.trim()) {
          mySession.messages.push({ id: uid(), role: 'assistant', content: sanitizeWorldOutput(acc), ts: now() });
          persistSession();
        }
        renderMessages();
        return;
      }
      var msg = err && err.message ? err.message : String(err);
      bubble.textContent = '⚠ ' + msg;
      placeholder.wrap.className = 'msg sys';
    }).then(function () {
      if (state.session !== mySession) return;
      if (state.ac === ac) state.ac = null;
      setStreaming(false);
      flush && flush();
      scrollBottom();
    });
  }

  function stopGen() {
    if (state.ac) {
      try { state.ac.abort(); } catch (e) { }
      state.ac = null;
    }
    setStreaming(false);
  }

  /* ---- 编辑最后一条玩家消息 ---- */
  function openMsgEditor(msgId) {
    if (!state.session) return;
    var msgs = state.session.messages || [];
    var target = null;
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].id === msgId) { target = msgs[i]; break; }
    }
    if (!target) { toast('消息不存在'); return; }

    state.editingMsgId = msgId;
    $('#edit-msg-text').value = target.content;
    openSheet('#sheet-edit-msg');
    setTimeout(function () { autoGrow($('#edit-msg-text')); }, 60);
  }

  /**
   * @param {boolean} regen true=保存并按新内容重新生成；false=只改文字
   */
  function saveEditedMessage(regen) {
    var id = state.editingMsgId;
    if (!id || !state.session) return;

    var text = $('#edit-msg-text').value.trim();
    if (!text) { toast('内容不能为空'); return; }

    var msgs = state.session.messages || [];
    var idx = -1;
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].id === id) { idx = i; break; }
    }
    if (idx < 0) { toast('消息已不存在'); return; }

    stopGen();
    closeSheet();

    if (regen) {
      // 这条之后的所有内容都会失效，整段丢弃重来
      state.session.messages = msgs.slice(0, idx + 1);
      state.session.messages[idx].content = text;
      state.session.messages[idx].ts = now();
      persistSession();
      renderMessages();
      runCompletion();
    } else {
      msgs[idx].content = text;
      persistSession();
      renderMessages();
      toast('已修改');
    }
    state.editingMsgId = null;
  }

  function regenerate() {
    if (state.streaming || !state.session) return;
    var msgs = state.session.messages;
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();

    if (!msgs.length) {
      if (state.mode === 'world') {
        msgs.push({
          id: uid(), role: 'user', hidden: true, ts: now(),
          content: '（游戏开始。请严格按格式输出：当前状态、场景描写、以及 3 个可选行动。）'
        });
        persistSession();
        renderMessages();
        runCompletion();
        return;
      }
      var p = currentPersona();
      if (p && p.firstMes) msgs.push({ id: uid(), role: 'assistant', content: p.firstMes, ts: now() });
      renderMessages();
      return;
    }
    persistSession();
    renderMessages();
    runCompletion();
  }

  function persistSession() {
    if (!state.session) return;

    // 防御：会话对象与当前所在的世界/角色不一致时绝不写库
    if (state.mode === 'world' && state.worldId && state.session.id !== state.worldId) return;
    if (state.mode === 'persona' && state.personaId && state.session.id !== state.personaId) return;

    state.session.updatedAt = now();

    if (state.mode === 'world') {
      DB.put('worldSaves', state.session).catch(function () { toast('保存失败'); });
      var w = currentWorld();
      if (w) { w.updatedAt = now(); DB.put('worlds', w).catch(function () { }); }
      return;
    }

    DB.put('sessions', state.session).catch(function () { toast('保存失败'); });
    var p = currentPersona();
    if (p) { p.updatedAt = now(); DB.put('personas', p).catch(function () { }); }
  }

  /* ---------------- TTS ---------------- */
  function speak(text) {
    if (!('speechSynthesis' in window)) { toast('本机不支持语音朗读'); return; }
    try {
      speechSynthesis.cancel();
      var clean = String(text)
        .replace(/[*（(][^）)]{0,80}[）)]/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 800);
      if (!clean.trim()) return;
      var u = new SpeechSynthesisUtterance(clean);
      u.lang = 'zh-CN';
      u.rate = 1.03;
      u.pitch = 1.05;
      var vs = speechSynthesis.getVoices() || [];
      for (var i = 0; i < vs.length; i++) {
        if (/zh|Chinese/i.test(vs[i].lang + ' ' + vs[i].name)) { u.voice = vs[i]; break; }
      }
      speechSynthesis.speak(u);
    } catch (e) { toast('朗读失败'); }
  }

  /* =========================================================
   * 角色编辑
   * ========================================================= */
  function openPersonaEditor(persona) {
    state.editing = persona || newPersonaTemplate();
    var p = state.editing;
    $('#pe-title').textContent = persona ? '编辑角色' : '新建角色';
    $('#p-avatar').value = p.avatar || '🙂';
    $('#p-name').value = p.name || '';
    $('#p-desc').value = p.description || '';
    $('#p-personality').value = p.personality || '';
    $('#p-scenario').value = p.scenario || '';
    $('#p-first').value = p.firstMes || '';
    $('#p-example').value = p.example || '';
    $('#p-extra').value = p.extra || '';

    // 填充「所属世界」下拉（主动读库，避免 state.worlds 还没加载时只剩默认项）
    var sel = $('#p-world');
    if (sel) {
      sel.innerHTML = '<option value="">（不归属任何世界）</option>';
      DB.all('worlds').then(function (list) {
        var ws = (list || []).slice().sort(function (a, b) {
          return (a.name || '').localeCompare(b.name || '', 'zh');
        });
        state.worlds = ws;

        sel.innerHTML = '<option value="">（不归属任何世界）</option>';
        ws.forEach(function (w) {
          var o = document.createElement('option');
          o.value = w.id;
          o.textContent = (w.icon || '🌍') + ' ' + (w.name || '未命名世界');
          sel.appendChild(o);
        });

        // 反推：没有 worldId 的老数据，从 world.linked 里找
        var wid = p.worldId || '';
        if (!wid) {
          ws.forEach(function (w) {
            if (!wid && (w.linked || []).indexOf(p.id) >= 0) wid = w.id;
          });
        }
        sel.value = wid;
      }).catch(function () { });
    }

    $('#p-delete').classList.toggle('hidden', !persona);
    openSheet('#sheet-persona');
    setTimeout(function () { autoGrowAll($('#sheet-persona')); }, 60);
  }

  function savePersonaFromForm() {
    var p = state.editing;
    if (!p) return;
    var name = $('#p-name').value.trim();
    if (!name) { toast('给角色起个名字'); return; }
    p.avatar = $('#p-avatar').value.trim() || '🙂';
    p.name = name;
    p.description = $('#p-desc').value.trim();
    p.personality = $('#p-personality').value.trim();
    p.scenario = $('#p-scenario').value.trim();
    p.firstMes = $('#p-first').value.trim();
    p.example = $('#p-example').value.trim();
    p.extra = $('#p-extra').value.trim();

    // 所属世界
    var selW = $('#p-world');
    var newWid = selW ? selW.value : '';
    var oldWid = p.worldId || '';
    p.worldId = newWid;
    p.updatedAt = now();

    // 同步 world.linked（双向一致）
    var syncWorlds = (state.worlds || []).map(function (w) {
      var linked = (w.linked || []).slice();
      var has = linked.indexOf(p.id) >= 0;
      if (w.id === newWid && !has) {
        linked.push(p.id);
        return DB.put('worlds', Object.assign({}, w, { linked: linked }));
      }
      if (w.id !== newWid && has && w.id === oldWid) {
        linked = linked.filter(function (x) { return x !== p.id; });
        return DB.put('worlds', Object.assign({}, w, { linked: linked }));
      }
      return Promise.resolve();
    });

    Promise.all(syncWorlds).then(function () {
      return DB.put('personas', p);
    }).then(function () {
      closeSheet();
      renderList().then(updateFoot);
      if (state.personaId === p.id) {
        $('#chat-name').textContent = p.name;
        $('#chat-avatar').textContent = p.avatar;
      }
      toast('已保存');
    }).catch(function () { toast('保存失败'); });
  }

  function deletePersona(id) {
    return DB.del('personas', id).then(function () { return DB.del('sessions', id); });
  }

  /* =========================================================
   * 世界：模板 / 编辑器 / CRUD
   * ========================================================= */
  function newWorldTemplate() {
    return {
      id: uid(),
      name: '新世界',
      icon: '🌍',
      setting: '',
      playerRole: '',
      systems: '',
      opening: '',
      rules: '',
      style: '',
      length: '400~500 字',
      linked: [],
      syncChat: false,
      createdAt: now(),
      updatedAt: now()
    };
  }

  function openWorldEditor(world) {
    state.editingWorld = world || newWorldTemplate();
    var w = state.editingWorld;

    $('#we-title').textContent = world ? '编辑世界' : '新建世界';
    $('#w-icon').value = w.icon || '🌍';
    $('#w-name').value = w.name || '';
    $('#w-setting').value = w.setting || '';
    $('#w-role').value = w.playerRole || '';
    $('#w-systems').value = w.systems || '';
    $('#w-opening').value = w.opening || '';
    $('#w-rules').value = w.rules || '';
    $('#w-style').value = w.style || '';
    $('#w-length').value = w.length || '400~500 字';
    $('#w-sync').checked = w.syncChat !== false;
    var tg = w.tags || {};
    setTagValue('#tag-gender', tg.gender || '');
    setTagValue('#tag-genre', tg.genre || '');
    setTagValue('#tag-rel', tg.rel || '');
    setTagValue('#tag-heat', tg.heat || '');
    setTagValue('#tag-tone', tg.tone || '');
    $('#w-delete').classList.toggle('hidden', !world);

    $('#w-linked').innerHTML = '<div class="hint" style="margin:0">载入角色卡…</div>';
    DB.all('personas').then(function (list) {
      state.personas = (list || []).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      renderLinkedList(w.linked || []);
    }).catch(function () { });

    openSheet('#sheet-world');
    setTimeout(function () { autoGrowAll($('#sheet-world')); }, 60);
  }

  function renderLinkedList(selected) {
    var box = $('#w-linked');
    box.innerHTML = '';
    if (!state.personas.length) {
      box.innerHTML = '<div class="hint" style="margin:0">还没有角色卡。先去「角色」页建几个，再回来勾选 —— 他们会作为 NPC 进入这个世界，GM 会严格遵守其人设。</div>';
      return;
    }
    state.personas.forEach(function (p) {
      var on = selected.indexOf(p.id) >= 0;
      var item = document.createElement('div');
      item.className = 'link-item' + (on ? ' on' : '');
      item.dataset.id = p.id;

      var av = document.createElement('span');
      av.className = 'li-av';
      av.textContent = p.avatar || '🙂';
      var nm = document.createElement('span');
      nm.className = 'li-name';
      nm.textContent = p.name || '未命名';
      var ck = document.createElement('span');
      ck.className = 'li-check';
      ck.textContent = '✓';

      item.appendChild(av); item.appendChild(nm); item.appendChild(ck);
      item.addEventListener('click', function () { item.classList.toggle('on'); });
      box.appendChild(item);
    });
  }

  function saveWorldFromForm() {
    var w = state.editingWorld;
    if (!w) return;
    var name = $('#w-name').value.trim();
    if (!name) { toast('给世界起个名字'); return; }

    w.icon = $('#w-icon').value.trim() || '🌍';
    w.name = name;
    w.setting = $('#w-setting').value.trim();
    w.playerRole = $('#w-role').value.trim();
    w.systems = $('#w-systems').value.trim();
    w.opening = $('#w-opening').value.trim();
    w.rules = $('#w-rules').value.trim();
    w.style = $('#w-style').value.trim();
    w.length = $('#w-length').value.trim() || '400~500 字';
    w.linked = $$('#w-linked .link-item.on').map(function (el) { return el.dataset.id; });
    w.syncChat = $('#w-sync').checked;
    w.tags = {
      gender: getTagValue('#tag-gender'),
      genre: getTagValue('#tag-genre'),
      rel: getTagValue('#tag-rel'),
      heat: getTagValue('#tag-heat'),
      tone: getTagValue('#tag-tone')
    };
    w.updatedAt = now();

    DB.put('worlds', w).then(function () {
      closeSheet();
      renderList().then(updateFoot);
      if (state.mode === 'world' && state.worldId === w.id) {
        $('#chat-name').textContent = w.name;
        $('#chat-avatar').textContent = w.icon;
      }
      toast('已保存 · 下一轮对话生效');
    }).catch(function () { toast('保存失败'); });
  }

  function deleteWorld(id) {
    return DB.del('worlds', id).then(function () { return DB.del('worldSaves', id); });
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function normalizeCard(o) {
    return {
      id: uid(),
      name: o.name || o.char_name || o.charName || '未命名角色',
      avatar: o.avatar || o.emoji || '🙂',
      description: o.description || o.char_persona || o.desc || '',
      personality: o.personality || o.char_personality || '',
      scenario: o.scenario || o.world_scenario || o.char_scenario || '',
      firstMes: o.firstMes || o.first_mes || o.greeting || o.first_message || '',
      example: o.example || o.mes_example || o.example_dialogs || '',
      extra: o.extra || o.systemExtra || o.system_prompt || '',
      createdAt: now(),
      updatedAt: now()
    };
  }

  function normalizeWorld(o) {
    return {
      id: uid(),
      name: o.name || '导入的世界',
      icon: o.icon || '🌍',
      setting: o.setting || o.world_setting || '',
      playerRole: o.playerRole || o.player_role || '',
      systems: o.systems || '',
      opening: o.opening || o.first_mes || '',
      rules: o.rules || '',
      style: o.style || '',
      length: o.length || '400~500 字',
      linked: [],
      syncChat: o.syncChat !== false,
      createdAt: now(),
      updatedAt: now()
    };
  }

  function importData(data) {
    // ---- 组合包：世界 + 角色，一次导入并自动把世界关联到新角色 ----
    if (data && data.kind === 'bundle' && (data.world || data.personas)) {
      var idmap = {};
      var chain = Promise.resolve();
      (data.personas || []).forEach(function (raw) {
        var p = normalizeCard(raw);
        if (raw.id) idmap[raw.id] = p.id;
        if (p.name) idmap['n:' + p.name] = p.id;
        chain = chain.then(function () { return DB.put('personas', p); });
      });
      var w = normalizeWorld(data.world || {});
      var linked = [];
      ((data.world && data.world.linked) || []).forEach(function (ref) {
        var nid = idmap[ref] || idmap['n:' + ref];
        if (nid && linked.indexOf(nid) < 0) linked.push(nid);
      });
      w.linked = linked;
      // 同步写入角色的 worldId，方便按世界分组显示
      var allP = (data.personas || []).map(function (raw) {
        return idmap[raw.id] || idmap['n:' + (raw.name || '')];
      }).filter(Boolean);
      allP.forEach(function (pid) {
        if (linked.indexOf(pid) < 0) return;
        chain = chain.then(function () {
          return DB.get('personas', pid).then(function (pp) {
            if (pp && !pp.worldId) {
              pp.worldId = w.id;
              return DB.put('personas', pp);
            }
          });
        });
      });
      chain = chain.then(function () { return DB.put('worlds', w); });
      return chain.then(function () {
        state.tab = 'world';
        syncTabs();
        toast('已导入「' + w.name + '」+ ' + (data.personas || []).length + ' 个角色');
        return renderList().then(updateFoot);
      }).catch(function () { toast('导入失败'); });
    }

    // ---- 世界存档 ----
    if (data && (data.kind === 'world' || data.world)) {
      var w2 = normalizeWorld(data.world || data);
      return DB.put('worlds', w2).then(function () {
        if (data.save && data.save.messages) {
          return DB.put('worldSaves', {
            id: w2.id,
            messages: data.save.messages,
            createdAt: data.save.createdAt || now(),
            updatedAt: now()
          });
        }
      }).then(function () {
        state.tab = 'world';
        syncTabs();
        toast('已导入世界「' + w2.name + '」');
        return renderList().then(updateFoot);
      }).catch(function () { toast('导入失败'); });
    }

    // ---- 角色卡 ----
    var cards;
    if (Array.isArray(data)) cards = data;
    else if (data && Array.isArray(data.personas)) cards = data.personas;
    else if (data && data.persona) cards = [data.persona];
    else cards = [data];

    var items = cards.map(normalizeCard);
    var chain2 = Promise.resolve();
    items.forEach(function (c) { chain2 = chain2.then(function () { return DB.put('personas', c); }); });
    return chain2.then(function () {
      state.tab = 'persona';
      syncTabs();
      toast('已导入 ' + items.length + ' 个角色');
      return renderList().then(updateFoot);
    }).catch(function () { toast('导入失败'); });
  }

  function importFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var data;
      try { data = JSON.parse(fr.result); } catch (e) { toast('JSON 解析失败'); return; }
      importData(data);
    };
    fr.onerror = function () { toast('读取文件失败'); };
    fr.readAsText(file, 'utf-8');
  }

  /** 对外暴露的调试/自动化入口（不含任何内置预设） */
  window.__aisim = {
    importData: importData,
    openWorld: function (id) { return openWorld(id); },
    getState: function () { return state; },
    sanitize: sanitizeWorldOutput,
    openWorldEditor: openWorldEditor,
    applyTheme: applyTheme,
    currentTheme: currentTheme
  };

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function exportChat() {
    var stamp = new Date().toISOString().slice(0, 10);

    if (state.mode === 'world') {
      var w = currentWorld();
      if (!w || !state.session) return;
      download((w.name || 'world') + '-' + stamp + '.json', JSON.stringify({
        app: 'aisim',
        version: 1,
        kind: 'world',
        exportedAt: new Date().toISOString(),
        world: w,
        save: state.session
      }, null, 2));
      toast('已导出');
      return;
    }

    var p = currentPersona();
    if (!p || !state.session) return;
    var payload = {
      app: 'aisim',
      version: 1,
      kind: 'persona',
      exportedAt: new Date().toISOString(),
      persona: p,
      session: state.session
    };
    download((p.name || 'char') + '-' + stamp + '.json', JSON.stringify(payload, null, 2));
    toast('已导出');
  }

  /* =========================================================
   * 设置面板
   * ========================================================= */
  function fillProviderSelect() {
    var sel = $('#s-provider');
    sel.innerHTML = '';
    Object.keys(LLM.PROVIDERS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = LLM.PROVIDERS[k].label;
      sel.appendChild(o);
    });
  }

  /** 显示当前服务商的填写说明，并铺上候选模型 */
  /** 实时显示"请求将发往哪个地址"，并在 key/地址不匹配时给出警告 */
  function updateEndpointHint() {
    var box = $('#s-endpoint');
    if (!box) return;
    var s = collectSettingsFromForm();
    var prov = LLM.PROVIDERS[s.provider] || LLM.PROVIDERS.custom;
    var base = String(s.base || prov.base || '').trim().replace(/\/+$/, '');

    if (!base) {
      box.className = 'endpoint-line warn';
      box.textContent = '⚠ 还没填 Base URL，请求发不出去';
      return;
    }

    var finalUrl = base;
    if (prov.kind === 'openai') {
      if (!/\/v\d+[a-z]*$/i.test(finalUrl)) finalUrl += '/v1';
      finalUrl += '/chat/completions';
    } else if (prov.kind === 'anthropic') {
      finalUrl += '/v1/messages';
    } else {
      finalUrl += '/v1beta/models/<模型>:streamGenerateContent';
    }

    var host = '';
    try { host = new URL(finalUrl.replace('<模型>', 'x')).host; } catch (e) { host = ''; }

    var owners = {
      'api.openai.com': 'openai',
      'api.deepseek.com': 'deepseek',
      'ark.cn-beijing.volces.com': 'volcengine',
      'api.moonshot.cn': 'moonshot',
      'open.bigmodel.cn': 'zhipu',
      'dashscope.aliyuncs.com': 'dashscope',
      'api.siliconflow.cn': 'siliconflow',
      'openrouter.ai': 'openrouter',
      'api.anthropic.com': 'anthropic',
      'generativelanguage.googleapis.com': 'gemini'
    };
    var owner = owners[host];
    var key = String(s.apiKey || '').trim();
    var warn = '';

    if (owner && owner !== s.provider) {
      warn = '⚠ 这个地址属于「' + LLM.PROVIDERS[owner].label + '」，但你选的服务商是「' + prov.label +
        '」。Key 和地址必须同属一家，否则一定认证失败。';
    } else if (/openai\.com$/i.test(host) && key && !/^sk-/.test(key)) {
      warn = '⚠ OpenAI 的 Key 以 sk- 开头，你填的这个不是。如果它是火山引擎的 Key，' +
        '请把服务商改成「火山方舟 豆包」，地址会自动变成 ark.cn-beijing.volces.com/api/v3。';
    } else if (/volces\.com$/i.test(host) && /^sk-/.test(key)) {
      warn = '⚠ 这个地址是火山方舟的，但 Key 是 sk- 开头（DeepSeek/OpenAI 风格）。' +
        '火山的 Key 是一串带连字符的 UUID，去火山方舟控制台 → API Key 管理 复制。';
    }

    if (warn) {
      box.className = 'endpoint-line warn';
      box.textContent = warn + '\n请求地址：' + finalUrl;
    } else {
      box.className = 'endpoint-line ok';
      box.textContent = '✓ 请求将发往：' + finalUrl;
    }
  }

  function applyProviderHint() {
    var p = LLM.PROVIDERS[$('#s-provider').value] || {};
    var box = $('#s-provider-hint');
    if (p.hint) {
      box.textContent = p.hint;
      box.classList.remove('hidden');
    } else {
      box.textContent = '';
      box.classList.add('hidden');
    }
    $('#s-model-list').innerHTML = '';
    if (p.models && p.models.length) renderModelChips(p.models);
    updateEndpointHint();
  }

  function renderModelChips(list) {
    var box = $('#s-model-list');
    box.innerHTML = '';
    var cur = $('#s-model').value.trim();
    list.slice(0, 80).forEach(function (id) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-chip' + (id === cur ? ' on' : '');
      b.textContent = id;
      b.title = id;
      b.addEventListener('click', function () {
        $('#s-model').value = id;
        Array.prototype.forEach.call(box.children, function (c) { c.classList.remove('on'); });
        b.classList.add('on');
      });
      box.appendChild(b);
    });
  }

  function openSettings() {
    var s = state.settings;
    fillProviderSelect();
    $('#s-provider').value = s.provider || 'deepseek';
    $('#s-base').value = s.base || '';
    // 内置试用 Key 不在界面上回显明文，避免被抄走
    var isPresetKey = s.apiKey && s.apiKey === TRIAL_PRESET_KEY;
    $('#s-key').value = isPresetKey ? '' : (s.apiKey || '');
    $('#s-key').placeholder = isPresetKey
      ? '已内置试用 Key，无需填写（填了会改用你自己的）'
      : 'sk-...';
    $('#s-key').setAttribute('data-preset', isPresetKey ? '1' : '0');
    $('#s-model').value = s.model || '';
    $('#s-temp').value = s.temperature;
    $('#s-maxtok').value = s.maxTokens;
    $('#s-username').value = s.userName || '你';
    $('#s-ctx').value = s.contextMessages;
    $('#s-stream').checked = !!s.stream;
    $('#s-tts').checked = !!s.tts;
    $('#s-test-out').textContent = '';
    $('#s-test-out').className = 'test-out';
    applyProviderHint();
    refreshStats();
    refreshTrialBadge();
    openSheet('#sheet-settings');
  }

  function refreshStats() {
    DB.all('sessions').then(function (ss) {
      var n = 0;
      (ss || []).forEach(function (x) { n += (x.messages || []).length; });
      $('#s-stats').textContent = '角色 ' + state.personas.length + ' · 消息 ' + n;
    }).catch(function () { });
  }

  function collectSettingsFromForm() {
    return {
      provider: $('#s-provider').value,
      base: $('#s-base').value.trim(),
      apiKey: (function () {
        var el = $('#s-key');
        var typed = el.value.trim();
        // 界面没回显内置 Key：用户没动就继续用内置的，动了就换成他自己的
        if (el.getAttribute('data-preset') === '1' && !typed) return TRIAL_PRESET_KEY;
        return typed;
      })(),
      model: $('#s-model').value.trim(),
      temperature: Math.min(2, Math.max(0, Number($('#s-temp').value) || 0.9)),
      maxTokens: Math.max(64, Number($('#s-maxtok').value) || 1024),
      userName: $('#s-username').value.trim() || '你',
      contextMessages: Math.max(4, Math.min(200, Number($('#s-ctx').value) || 30)),
      stream: $('#s-stream').checked,
      tts: $('#s-tts').checked,
      _v: CONFIG_VERSION
    };
  }

  /* =========================================================
   * 事件绑定
   * ========================================================= */
  function bind() {
    // 列表页：角色 / 世界 切换
    $('#seg-tabs').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.seg-btn') : null;
      if (!b) return;
      state.tab = b.dataset.tab;
      syncTabs();
      renderList().then(updateFoot);
    });

    $('#btn-new').addEventListener('click', function () {
      if (state.tab === 'world') openWorldEditor(null);
      else openPersonaEditor(null);
    });
    $('#btn-settings').addEventListener('click', openSettings);

    // 世界编辑
    $('#w-save').addEventListener('click', saveWorldFromForm);

    // 界面配色切换
    var themeGrid = $('#theme-grid');
    if (themeGrid) {
      themeGrid.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.themebtn');
        if (!btn) return;
        applyTheme(btn.getAttribute('data-t'));
      });
    }

    // 世界标签：点一下切换
    ['#tag-gender', '#tag-genre', '#tag-rel', '#tag-heat', '#tag-tone'].forEach(function (sel) {
      var box = $(sel);
      if (!box) return;
      box.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.tag');
        if (!btn) return;
        var already = btn.classList.contains('on');
        [].forEach.call(box.querySelectorAll('.tag'), function (b) { b.classList.remove('on'); });
        if (!already) btn.classList.add('on');
      });
    });
    $('#edit-msg-only').addEventListener('click', function () { saveEditedMessage(false); });
    $('#edit-msg-save').addEventListener('click', function () { saveEditedMessage(true); });

    // 激活码
    $('#act-submit').addEventListener('click', function () { doActivate(); });
    $('#act-code').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doActivate(); }
    });
    $('#w-delete').addEventListener('click', function () {
      if (!state.editingWorld) return;
      if (!confirm('删除世界「' + state.editingWorld.name + '」及其全部存档？')) return;
      deleteWorld(state.editingWorld.id).then(function () {
        closeSheet();
        state.editingWorld = null;
        state.worldId = null;
        state.session = null;
        state.mode = null;
        showView('#view-list');
        syncTabs();
        renderList().then(updateFoot);
        toast('已删除');
      });
    });
    $('#btn-import').addEventListener('click', function () { $('#file-import').click(); });
    $('#file-import').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });

    // 聊天页
    $('#btn-back').addEventListener('click', function () {
      stopGen();
      showView('#view-list');
      syncTabs();
      renderList().then(updateFoot);
    });
    $('#btn-chat-menu').addEventListener('click', function () {
      var isWorld = state.mode === 'world';
      $('#m-edit').textContent = isWorld ? '✎ 编辑世界设定' : '✎ 编辑角色卡';
      $('#m-export').textContent = isWorld ? '导出这个世界的存档 (JSON)' : '导出这段对话 (JSON)';
      $('#m-reset').textContent = isWorld ? '清空存档，重新开局' : '清空对话重新开始';
      $('#m-delete').textContent = isWorld ? '删除这个世界' : '删除这个角色';
      $('#m-timeline').classList.toggle('hidden', !isWorld);
      openSheet('#sheet-menu');
    });
    $('#m-timeline').addEventListener('click', function () {
      closeSheet();
      setTimeout(openTimeline, 140);
    });
    btnSend.addEventListener('click', sendMessage);
    btnStop.addEventListener('click', stopGen);

    elInput.addEventListener('input', function () {
      elInput.style.height = 'auto';
      elInput.style.height = Math.min(132, elInput.scrollHeight) + 'px';
    });
    elInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    // 抽屉关闭
    $('#sheet-mask').addEventListener('click', closeSheet);
    $$('[data-close]').forEach(function (b) { b.addEventListener('click', closeSheet); });

    // 编辑面板里的长文本自动撑高
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.tagName === 'TEXTAREA' && t.id !== 'input') autoGrow(t);
    }, true);

    // 设置
    $('#s-provider').addEventListener('change', function () {
      var p = LLM.PROVIDERS[$('#s-provider').value];
      if (!p) return;
      if (p.base) $('#s-base').value = p.base;
      if (p.model) $('#s-model').value = p.model;
      applyProviderHint();
    });
    $('#s-models').addEventListener('click', function () {
      var btn = this;
      var out = $('#s-test-out');
      var s = collectSettingsFromForm();
      var prov = LLM.PROVIDERS[s.provider] || LLM.PROVIDERS.custom;
      btn.disabled = true;
      btn.textContent = '…';
      out.className = 'test-out';
      out.textContent = '正在拉取模型列表…';
      LLM.listModels({
        kind: prov.kind,
        base: s.base || prov.base,
        apiKey: s.apiKey
      }).then(function (list) {
        renderModelChips(list);
        out.className = 'test-out ok';
        out.textContent = '✓ 拉取到 ' + list.length + ' 个模型，点下方标签填入';
        if (!s.model && list.length) {
          $('#s-model').value = list[0];
          renderModelChips(list);
        }
      }).catch(function (e) {
        out.className = 'test-out err';
        out.textContent = '✗ ' + (e && e.message ? e.message : e);
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '拉取';
      });
    });
    $('#s-key-eye').addEventListener('click', function () {
      var i = $('#s-key');
      var isPwd = i.type === 'password';
      i.type = isPwd ? 'text' : 'password';
      this.textContent = isPwd ? '隐藏' : '显示';
    });
    ['#s-base', '#s-key', '#s-model'].forEach(function (sel) {
      $(sel).addEventListener('input', updateEndpointHint);
    });
    $('#s-save').addEventListener('click', function () {
      state.settings = collectSettingsFromForm();
      saveSettings(state.settings);
      closeSheet();
      toast('设置已保存');
      var p = currentPersona();
      if (p) $('#chat-sub').textContent = state.settings.model + ' · ' + (LLM.PROVIDERS[state.settings.provider] || {}).label;
    });
    $('#s-test').addEventListener('click', function () {
      var out = $('#s-test-out');
      out.className = 'test-out';
      out.textContent = '正在连接…';
      var cfg = (function () {
        var s = collectSettingsFromForm();
        var prov = LLM.PROVIDERS[s.provider] || LLM.PROVIDERS.custom;
        return {
          kind: prov.kind,
          base: s.base || prov.base,
          apiKey: s.apiKey,
          model: s.model || prov.model,
          temperature: s.temperature,
          maxTokens: 64
        };
      })();
      LLM.ping(cfg).then(function (r) {
        out.className = 'test-out ok';
        out.textContent = '✓ 连接成功 · ' + r.ms + 'ms\n回复：' + (r.reply || '(空)').slice(0, 120);
      }).catch(function (e) {
        out.className = 'test-out err';
        out.textContent = '✗ ' + (e && e.message ? e.message : e);
      });
    });
    $('#s-wipe').addEventListener('click', function () {
      if (!confirm('确定清空所有角色和对话？此操作不可恢复。')) return;
      DB.clear('personas').then(function () { return DB.clear('sessions'); }).then(function () {
        localStorage.removeItem(LS_KEY);
        state.settings = Object.assign({}, DEFAULT_SETTINGS);
        closeSheet();
        renderList().then(updateFoot);
        toast('已清空');
      });
    });

    // 角色编辑
    $('#p-save').addEventListener('click', savePersonaFromForm);
    $('#p-delete').addEventListener('click', function () {
      if (!state.editing) return;
      if (!confirm('删除角色「' + state.editing.name + '」及其对话？')) return;
      deletePersona(state.editing.id).then(function () {
        closeSheet();
        state.editing = null;
        state.personaId = null;
        state.session = null;
        showView('#view-list');
        renderList().then(updateFoot);
        toast('已删除');
      });
    });

    // 聊天菜单
    $('#m-edit').addEventListener('click', function () {
      closeSheet();
      if (state.mode === 'world') {
        var w = currentWorld();
        if (w) openWorldEditor(w);
      } else {
        var p = currentPersona();
        if (p) openPersonaEditor(p);
      }
    });
    $('#m-regen').addEventListener('click', function () { closeSheet(); regenerate(); });
    $('#m-speak').addEventListener('click', function () {
      closeSheet();
      var msgs = state.session ? state.session.messages : [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') { speak(msgs[i].content); return; }
      }
    });
    $('#m-export').addEventListener('click', function () { closeSheet(); exportChat(); });
    $('#m-reset').addEventListener('click', function () {
      closeSheet();
      var isWorld = state.mode === 'world';
      if (!confirm(isWorld ? '清空这个世界存档，重新开局？' : '清空这段对话并重新开始？')) return;

      stopGen();   // 先掐断正在进行的生成，防止旧回复写进新存档

      if (isWorld) {
        var w = currentWorld();
        if (!w) return;
        var fresh = { id: w.id, messages: [], createdAt: now(), updatedAt: now() };
        state.session = null;       // 立即失效，让旧回调识别出会话已变
        DB.put('worldSaves', fresh).then(function () {
          state.personaMemory = {};
          openWorld(w.id);
          toast('已重新开局');
        }).catch(function () { toast('重开失败'); });
        return;
      }

      var p = currentPersona();
      if (!p) return;
      var fresh2 = { id: p.id, messages: [], createdAt: now(), updatedAt: now() };
      if (p.firstMes) fresh2.messages.push({ id: uid(), role: 'assistant', content: p.firstMes, ts: now() });
      state.session = null;
      DB.put('sessions', fresh2).then(function () {
        state.session = fresh2;
        renderMessages();
        toast('已重新开始');
      }).catch(function () { toast('重开失败'); });
    });
    $('#m-delete').addEventListener('click', function () {
      closeSheet();
      if (state.mode === 'world') {
        var w = currentWorld();
        if (!w) return;
        if (!confirm('删除世界「' + w.name + '」及其全部存档？')) return;
        deleteWorld(w.id).then(function () {
          showView('#view-list');
          state.worldId = null;
          state.session = null;
          state.mode = null;
          syncTabs();
          renderList().then(updateFoot);
          toast('已删除');
        });
        return;
      }
      var p = currentPersona();
      if (!p) return;
      if (!confirm('删除角色「' + p.name + '」及其对话？')) return;
      deletePersona(p.id).then(function () {
        showView('#view-list');
        state.personaId = null;
        state.session = null;
        state.mode = null;
        syncTabs();
        renderList().then(updateFoot);
        toast('已删除');
      });
    });
  }



  /* =========================================================
   * 启动
   * ========================================================= */
  /* ---------------- 界面配色 ---------------- */
  var THEME_KEY = 'aisim.theme.v1';
  var THEMES = ['gold', 'paper', 'cyber'];

  function currentTheme() {
    try {
      var v = localStorage.getItem(THEME_KEY);
      return THEMES.indexOf(v) >= 0 ? v : 'gold';
    } catch (e) { return 'gold'; }
  }

  function applyTheme(name) {
    var t = THEMES.indexOf(name) >= 0 ? name : 'gold';
    var b = document.body;
    b.classList.remove('t-gold', 't-paper', 't-cyber');
    b.classList.add('t-' + t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
    var grid = $('#theme-grid');
    if (grid) {
      [].forEach.call(grid.querySelectorAll('.themebtn'), function (btn) {
        btn.classList.toggle('on', btn.getAttribute('data-t') === t);
      });
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var colors = { gold: '#0b0905', paper: '#f7f4ee', cyber: '#06090f' };
      meta.setAttribute('content', colors[t] || '#0b0d12');
    }
  }

  /* ---------------- 世界标签 ---------------- */
  function getTagValue(sel) {
    var el = document.querySelector(sel + ' .tag.on');
    return el ? el.getAttribute('data-v') : '';
  }

  function setTagValue(sel, val) {
    [].forEach.call(document.querySelectorAll(sel + ' .tag'), function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-v') === val);
    });
  }

  function boot() {
    applyTheme(currentTheme());
    bind();
    renderList().then(function () {
      updateFoot();
      if (!hasUsableConfig()) {
        setTimeout(function () {
          openSettings();
          toast('先填 API Key 就能开始');
        }, 400);
      }
    });

    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    }
    if (window.speechSynthesis) { try { speechSynthesis.getVoices(); } catch (e) { } }

    // 软键盘适配：键盘弹起后把最后一条消息顶到可见区
    if (window.visualViewport) {
      var vv = window.visualViewport;
      vv.addEventListener('resize', function () {
        if ($('#view-chat').classList.contains('active')) setTimeout(scrollBottom, 60);
      });
    }
    elInput.addEventListener('focus', function () {
      setTimeout(scrollBottom, 220);
    });

    // 安卓返回键：在聊天页时回到列表
    window.addEventListener('popstate', function () {
      if ($('#view-chat').classList.contains('active')) {
        showView('#view-list');
        renderList().then(updateFoot);
        history.pushState({ v: 'chat' }, '');
      }
    });
    try { history.pushState({ v: 'chat' }, ''); } catch (e) { }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
