/* =========================================================
 * api.js —— 多厂商大模型流式适配层
 * 支持：OpenAI 兼容（DeepSeek/OpenAI/Moonshot/智谱/通义/硅基流动/
 *      OpenRouter/任意自建）/ Anthropic Claude / Google Gemini
 * 纯浏览器直连，无后端中转。
 * ========================================================= */
(function (global) {
  'use strict';

  /** 预置服务商 */
  var PROVIDERS = {
    volcengine:  { label: '火山方舟 豆包',        base: 'https://ark.cn-beijing.volces.com/api/v3',        model: 'doubao-seed-character-260628',      kind: 'openai',
                   hint: '火山必须先「开通」模型才能调用 —— 没开通的 ID 一律返回 404，跟填错无关。角色扮演首选 doubao-seed-character（豆包人设专用）。想要更强的通用能力，去控制台「开通管理」激活 doubao-seed-2-1-pro 或 deepseek-v4-1-flash，再点下面的标签。',
                   models: ['doubao-seed-character-260628', 'doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-1-lite-260915', 'doubao-seed-evolving', 'deepseek-v4-1-flash-261017', 'kimi-k3-1-pro-261024'],
                   noList: true },
    deepseek:    { label: 'DeepSeek 深度求索', base: 'https://api.deepseek.com/v1',                    model: 'deepseek-chat',                kind: 'openai' },
    openai:      { label: 'OpenAI',            base: 'https://api.openai.com/v1',                      model: 'gpt-4o-mini',                  kind: 'openai' },
    moonshot:    { label: 'Moonshot 月之暗面',  base: 'https://api.moonshot.cn/v1',                     model: 'moonshot-v1-8k',               kind: 'openai' },
    zhipu:       { label: '智谱 GLM',           base: 'https://open.bigmodel.cn/api/paas/v4',           model: 'glm-4-flash',                  kind: 'openai' },
    dashscope:   { label: '阿里通义千问',        base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',                 kind: 'openai' },
    siliconflow: { label: '硅基流动 SiliconFlow', base: 'https://api.siliconflow.cn/v1',                 model: 'Qwen/Qwen2.5-7B-Instruct',     kind: 'openai' },
    openrouter:  { label: 'OpenRouter',         base: 'https://openrouter.ai/api/v1',                  model: 'deepseek/deepseek-chat',       kind: 'openai' },
    anthropic:   { label: 'Anthropic Claude',   base: 'https://api.anthropic.com',                     model: 'claude-sonnet-4-20250514',     kind: 'anthropic' },
    gemini:      { label: 'Google Gemini',      base: 'https://generativelanguage.googleapis.com',     model: 'gemini-2.0-flash',             kind: 'gemini' },
    custom:      { label: '自定义（OpenAI 兼容）', base: '',                                            model: '',                             kind: 'openai' }
  };

  function normBase(base, kind) {
    var b = String(base || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
    if (!b) return '';
    // OpenAI 兼容：若末尾没有版本号，自动补 /v1
    if (kind === 'openai' && !/\/v\d+[a-z]*$/i.test(b)) b += '/v1';
    return b;
  }

  function buildUrl(cfg) {
    var base = normBase(cfg.base, cfg.kind);
    if (!base) throw new Error('接口地址为空，请先在设置里填写 Base URL');
    var model = String(cfg.model || '').trim();
    if (!model && cfg.kind !== 'custom') throw new Error('模型名为空');
    var real;
    if (cfg.kind === 'anthropic') real = base + '/v1/messages';
    else if (cfg.kind === 'gemini') {
      real = base + '/v1beta/models/' + encodeURIComponent(model) +
             ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(cfg.apiKey || '');
    } else real = base + '/chat/completions';

    /* 中转站大多不返回 CORS 头，浏览器直连会被拦。
       填了代理地址就把真实 URL 拼在代理后面：PROXY?url=<encoded> */
    var proxy = String(cfg.proxy || '').trim();
    if (proxy) {
      var sep = proxy.indexOf('?') >= 0 ? '&' : '?';
      return proxy + sep + 'url=' + encodeURIComponent(real);
    }
    return real;
  }

  function buildRequest(cfg, messages) {
    var url = buildUrl(cfg);
    var headers = { 'Content-Type': 'application/json' };
    var body;

    if (cfg.kind === 'anthropic') {
      headers['x-api-key'] = cfg.apiKey || '';
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      var sys = '';
      var msgs = [];
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m.role === 'system') { sys += (sys ? '\n\n' : '') + m.content; continue; }
        msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      }
      // Anthropic 要求首条为 user
      if (msgs.length && msgs[0].role === 'assistant') msgs.unshift({ role: 'user', content: '（开始）' });
      // 保证严格交替
      var clean = [];
      for (var j = 0; j < msgs.length; j++) {
        if (clean.length && clean[clean.length - 1].role === msgs[j].role) {
          clean[clean.length - 1].content += '\n\n' + msgs[j].content;
        } else clean.push(msgs[j]);
      }
      if (!clean.length) clean.push({ role: 'user', content: '（开始）' });
      body = {
        model: cfg.model,
        max_tokens: Number(cfg.maxTokens) || 1024,
        temperature: Number(cfg.temperature),
        stream: true,
        system: sys || undefined,
        messages: clean
      };
    } else if (cfg.kind === 'gemini') {
      var sysTxt = '';
      var contents = [];
      for (var k = 0; k < messages.length; k++) {
        var mm = messages[k];
        if (mm.role === 'system') { sysTxt += (sysTxt ? '\n\n' : '') + mm.content; continue; }
        contents.push({ role: mm.role === 'assistant' ? 'model' : 'user', parts: [{ text: mm.content }] });
      }
      if (contents.length && contents[0].role === 'model') contents.unshift({ role: 'user', parts: [{ text: '（开始）' }] });
      body = {
        contents: contents,
        generationConfig: {
          temperature: Number(cfg.temperature),
          maxOutputTokens: Number(cfg.maxTokens) || 1024
        }
      };
      if (sysTxt) body.systemInstruction = { parts: [{ text: sysTxt }] };
    } else {
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
      if ((cfg.base || '').indexOf('openrouter.ai') >= 0) {
        headers['HTTP-Referer'] = location.origin || 'http://localhost';
        headers['X-Title'] = 'AI Roleplay Simulator';
      }
      body = {
        model: cfg.model,
        messages: messages,
        stream: true,
        temperature: Number(cfg.temperature),
        max_tokens: Number(cfg.maxTokens) || 1024
      };
    }

    return { url: url, headers: headers, body: body };
  }

  /** 从不同厂商的 SSE 事件里抽出增量文本 */
  function pickDelta(kind, obj) {
    try {
      if (kind === 'anthropic') {
        if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
        if (obj.type === 'message_start' || obj.type === 'content_block_start') return '';
        return '';
      }
      if (kind === 'gemini') {
        var c = obj.candidates && obj.candidates[0];
        if (!c) return '';
        var parts = (c.content && c.content.parts) || [];
        var out = '';
        for (var i = 0; i < parts.length; i++) if (typeof parts[i].text === 'string') out += parts[i].text;
        return out;
      }
      // openai 兼容
      var ch = obj.choices && obj.choices[0];
      if (!ch) return '';
      var d = ch.delta || ch.message || {};
      if (typeof d.content === 'string') return d.content;
      if (Array.isArray(d.content)) {
        var s = '';
        for (var n = 0; n < d.content.length; n++) if (d.content[n].text) s += d.content[n].text;
        return s;
      }
      return '';
    } catch (e) { return ''; }
  }

  function pickFinish(kind, obj) {
    if (kind === 'openai') {
      var ch = obj.choices && obj.choices[0];
      return !!(ch && ch.finish_reason);
    }
    if (kind === 'anthropic') return obj.type === 'message_stop';
    return false;
  }

  /**
   * 把 HTTP 错误翻译成中文可执行的诊断
   */
  function diagnose(status, cfg, detail) {
    var host = '';
    try { host = new URL(buildUrl(cfg)).host; } catch (e) { host = cfg.base || '(地址无效)'; }

    var key = String(cfg.apiKey || '');
    var keyLooksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(key);
    var isOpenAIHost = /(^|\.)openai\.com$/i.test(host);
    var isVolcHost = /volces\.com$/i.test(host);
    var isDeepSeekHost = /deepseek\.com$/i.test(host);

    var lines = ['接口返回 ' + status + '（' + host + '）'];
    if (detail) lines.push(detail);

    if (status === 401 || status === 403) {
      if (isOpenAIHost && !/^sk-/.test(key)) {
        lines.push('→ 你把服务商选成了 OpenAI，请求发到了 api.openai.com，但填的是别家的 key。');
        lines.push('  火山的 key 必须配火山地址：服务商改成「火山方舟 豆包」，');
        lines.push('  或把 Base URL 手动改成 https://ark.cn-beijing.volces.com/api/v3');
      } else if (isVolcHost && /^sk-/.test(key) && !keyLooksUuid) {
        lines.push('→ 这个地址是火山方舟的，但 key 是 sk- 开头的（DeepSeek/OpenAI 风格）。');
        lines.push('  火山的 API Key 是一串带连字符的 UUID，去火山方舟控制台 → API Key 管理 复制。');
      } else if (isDeepSeekHost && !/^sk-/.test(key)) {
        lines.push('→ DeepSeek 的 key 以 sk- 开头，确认没有粘错。');
      } else {
        lines.push('→ Key 无效或已过期，或者 Key 与这个接口地址不属于同一家服务商。');
        lines.push('  Key 和 Base URL 必须配对：火山的 key 只认火山的地址。');
      }
    } else if (status === 404) {
      if (/has not activated the model|not activated/i.test(detail)) {
        var m = ((detail.match(/activated the model ([A-Za-z0-9._-]+)/) || [])[1] || '').replace(/[.\s]+$/, '');
        lines.push('→ 这个模型你的账号还没开通' + (m ? '（' + m + '）' : '') + '，跟填错无关。');
        lines.push('  火山方舟控制台 → 开通管理 → 找到该模型 → 点开通，开通后就能用。');
      } else if (/does not exist/i.test(detail)) {
        lines.push('→ 模型 ID 不存在。去控制台模型广场复制当前 Model ID。');
      } else {
        lines.push('→ 地址或模型名不存在。检查两件事：');
        lines.push('  1) Base URL 是否多了/少了路径（火山的结尾是 /api/v3）');
        lines.push('  2) 模型名是否正确（火山可填 ep-xxx 接入点，或控制台复制的 Model ID）');
      }
    } else if (status === 429) {
      lines.push('→ 请求太频繁或额度用完，等一会儿再试，或去控制台看余额/提额度。');
    } else if (status >= 500) {
      lines.push('→ 服务商那边出问题了，跟你填的没关系，过几分钟再试。');
    }

    return lines.join('\n');
  }

  /**
   * 流式对话
   * @param {object} cfg  {kind, base, apiKey, model, temperature, maxTokens}
   * @param {Array}  messages [{role, content}]
   * @param {object} opts {signal, onDelta(text, full), onDone(full)}
   * @returns {Promise<string>} 完整回复
   */
  async function streamChat(cfg, messages, opts) {
    opts = opts || {};
    var req = buildRequest(cfg, messages);
    var res;

    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      var h = '';
      try { h = new URL(req.url).host; } catch (e4) { }
      var msg = String((e && e.message) || e || '');

      /* 浏览器跨域拦截的典型特征：TypeError / Failed to fetch，且拿不到任何响应体。
         这不是网络问题，是对方没返回 Access-Control-Allow-Origin。 */
      var isCors = /Failed to fetch|NetworkError|Load failed|TypeError/i.test(msg);
      if (isCors && !cfg.proxy) {
        throw new Error('【跨域被拦】' + h + ' 不允许浏览器直连\n' +
          '浏览器安全策略会拦掉没有 CORS 头的接口，这不是 Key 或网络的问题。\n' +
          '→ 解决办法：设置里填一个「代理地址」（Cloudflare Worker，免费），\n' +
          '   请求会经它转发，不再受浏览器跨域限制。');
      }
      if (isCors && cfg.proxy) {
        throw new Error('【代理失败】经代理连不上 ' + h + '\n' +
          '→ 检查代理地址是否可访问；代理是否允许转发到这个域名；Cloudflare Worker 是否部署成功。\n' +
          '原始错误：' + msg);
      }

      throw new Error('连不上 ' + (h || req.url) + '\n' +
        msg + '\n' +
        '→ 检查手机网络；确认 Base URL 拼写正确。');
    }

    if (!res.ok) {
      var errTxt = '';
      try { errTxt = await res.text(); } catch (e2) { errTxt = ''; }
      var pretty = errTxt;
      try {
        var jo = JSON.parse(errTxt);
        pretty = (jo.error && (jo.error.message || jo.error.code)) || jo.message || errTxt;
      } catch (e3) { /* 保持原样 */ }
      throw new Error(diagnose(res.status, cfg, String(pretty).slice(0, 400)));
    }

    if (!res.body || !res.body.getReader) {
      // 环境不支持流式，退化为整包读取
      var txt = await res.text();
      var full0 = '';
      txt.split('\n').forEach(function (line) {
        line = line.trim();
        if (!line.indexOf('data:')) {
          var payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try { full0 += pickDelta(cfg.kind, JSON.parse(payload)); } catch (e) { }
          }
        }
      });
      if (opts.onDelta) opts.onDelta(full0, full0);
      if (opts.onDone) opts.onDone(full0);
      return full0;
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    var full = '';
    var finished = false;

    while (!finished) {
      var step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });

      // 按行切分，保留最后一段不完整数据
      var nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (line.charAt(0) === ':') continue;            // SSE 注释/心跳
        if (line.indexOf('data:') !== 0) continue;       // event: / id: 忽略
        var data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { finished = true; break; }
        var obj;
        try { obj = JSON.parse(data); } catch (e) { continue; }

        // 错误对象直接在流里返回
        if (obj.error) {
          var em = (obj.error && (obj.error.message || obj.error.code)) || '未知流式错误';
          throw new Error('接口错误：' + em);
        }
        var piece = pickDelta(cfg.kind, obj);
        if (piece) {
          full += piece;
          if (opts.onDelta) opts.onDelta(piece, full);
        }
        if (pickFinish(cfg.kind, obj)) { /* 等流自然结束 */ }
      }
    }

    // 冲刷最后残余
    if (buffer.trim().indexOf('data:') === 0) {
      var tail = buffer.trim().slice(5).trim();
      if (tail && tail !== '[DONE]') {
        try {
          var o = JSON.parse(tail);
          var p = pickDelta(cfg.kind, o);
          if (p) { full += p; if (opts.onDelta) opts.onDelta(p, full); }
        } catch (e) { }
      }
    }

    if (opts.onDone) opts.onDone(full);
    return full;
  }

  /** 非流式单次调用，用于"测试连接" */
  async function ping(cfg) {
    var req = buildRequest(cfg, [
      { role: 'system', content: '你是连通性测试助手，只回四个字：连接正常' },
      { role: 'user', content: 'ping' }
    ]);
    req.body.stream = false;
    if (req.body.stream === false) { /* ok */ }
    var t0 = Date.now();
    var res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    });
    var txt = await res.text();
    var ms = Date.now() - t0;
    if (!res.ok) {
      var msg = txt;
      try { var j = JSON.parse(txt); msg = (j.error && (j.error.message || j.error.code)) || j.message || txt; } catch (e) { }
      throw new Error('HTTP ' + res.status + ' · ' + String(msg).slice(0, 400));
    }
    var reply = '';
    try {
      var o = JSON.parse(txt);
      if (cfg.kind === 'anthropic') {
        reply = (o.content || []).map(function (c) { return c.text || ''; }).join('');
      } else if (cfg.kind === 'gemini') {
        var cand = (o.candidates || [])[0];
        reply = cand ? ((cand.content && cand.content.parts) || []).map(function (p) { return p.text || ''; }).join('') : '';
      } else {
        reply = (((o.choices || [])[0] || {}).message || {}).content || '';
      }
    } catch (e) { reply = String(txt).slice(0, 200); }
    return { ms: ms, reply: reply };
  }

  /** 拉取可用模型列表（OpenAI 兼容 /models） */
  async function listModels(cfg) {
    if (cfg.kind && cfg.kind !== 'openai') {
      throw new Error('当前服务商不支持自动拉取模型，请手动填写模型名');
    }
    var base = normBase(cfg.base, 'openai');
    if (!base) throw new Error('先把 Base URL 填上');
    var headers = {};
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

    var res;
    try {
      res = await fetch(base + '/models', { headers: headers });
    } catch (e) {
      throw new Error('该服务商没有开放模型列表接口（浏览器直连被拦），请手动填写模型名或点下方的候选标签');
    }
    if (!res.ok) {
      var t = '';
      try { t = await res.text(); } catch (e2) { }
      var m = t;
      try {
        var j = JSON.parse(t);
        m = (j.error && (j.error.message || j.error.code)) || j.message || t;
      } catch (e3) { }
      throw new Error('拉取失败 HTTP ' + res.status + ' · ' + String(m).slice(0, 300));
    }

    var data = await res.json();
    var arr = data.data || data.models || data.result || [];
    var ids = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      var id = typeof it === 'string' ? it : (it.id || it.model || it.name);
      if (id && ids.indexOf(id) < 0) ids.push(String(id));
    }
    if (!ids.length) throw new Error('接口没有返回模型列表，请手动填写模型名');
    return ids.sort();
  }

  global.LLM = {
    PROVIDERS: PROVIDERS,
    streamChat: streamChat,
    ping: ping,
    listModels: listModels,
    normBase: normBase
  };
})(window);
