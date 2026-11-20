/**
 * The website chat widget, served at /widget.js. Shops add it with
 *   <script src="https://api.example.com/widget.js" data-agently-key="wk_…" async></script>
 * It draws a chat bubble in a shadow root (so the site's CSS can't reach it),
 * keeps a random visitor id in localStorage, sends messages to /widget/:key/messages
 * and polls for replies while the chat is open. Text is only ever set with
 * textContent, never as HTML.
 *
 * Plain ES2017 for old phones' browsers. Kept as a String.raw template, so it
 * must not contain backticks or dollar-brace.
 */
export const WIDGET_SCRIPT = String.raw`(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[data-agently-key]');
  if (!script || window.__agentlyWidget) return;
  window.__agentlyWidget = true;
  var key = script.getAttribute('data-agently-key');
  if (!key) return;
  var base = new URL(script.src, location.href).origin + '/widget/' + encodeURIComponent(key);

  function store(name, value) {
    try {
      if (value === undefined) return localStorage.getItem('agently:' + key + ':' + name);
      localStorage.setItem('agently:' + key + ':' + name, value);
    } catch (e) {}
    return null;
  }
  function newId() {
    var bytes = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return 'v_' + s;
  }
  var visitorId = store('visitor') || newId();
  store('visitor', visitorId);

  function api(path, init) {
    return fetch(base + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || 'Something went wrong');
        return body;
      });
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  var CSS =
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif}' +
    '.bubble{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;z-index:2147483646}' +
    '.bubble svg{width:28px;height:28px}' +
    '.panel{position:fixed;right:20px;bottom:90px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:2147483647;color:#111827}' +
    '.panel.open{display:flex}' +
    '.head{background:var(--c);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}' +
    '.head strong{font-size:15px;display:block}.head span{font-size:12px;opacity:.85}' +
    '.head button{margin-left:auto;background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:4px}' +
    '.list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f9fafb}' +
    '.msg{max-width:80%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
    '.msg.bot,.msg.staff{background:#fff;border:1px solid #e5e7eb;align-self:flex-start;border-bottom-left-radius:4px}' +
    '.msg.visitor{background:var(--c);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
    '.msg.failed{opacity:.6}' +
    '.msg img{display:block;max-width:100%;border-radius:8px}' +
    '.who{font-size:11px;color:#6b7280;margin:0 0 2px 4px}' +
    '.dots{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:10px 14px;display:none}' +
    '.dots.on{display:block}.dots i{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:#9ca3af;animation:b 1.2s infinite}' +
    '.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}' +
    '@keyframes b{0%,60%,100%{opacity:.3}30%{opacity:1}}' +
    '.note{font-size:12px;color:#b91c1c;padding:0 14px 6px;background:#f9fafb;min-height:0}' +
    'form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}' +
    'textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 10px;font-size:14px;height:40px;max-height:100px;outline:none;color:#111827;background:#fff}' +
    'textarea:focus{border-color:var(--c)}' +
    'form button{border:0;border-radius:10px;background:var(--c);color:#fff;padding:0 14px;font-size:14px;cursor:pointer}' +
    'form button:disabled{opacity:.5;cursor:default}' +
    '.brand{text-align:center;font-size:10px;color:#9ca3af;padding:0 0 6px;background:#fff}' +
    '@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}}';

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.4 1.1 4.6 3 6.2L4.3 21l3.7-1.9c1.2.4 2.6.6 4 .6 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var host = el('div');
  host.setAttribute('data-agently-widget', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var style = el('style');
  style.textContent = CSS;
  root.appendChild(style);

  var bubble = el('button', 'bubble');
  bubble.type = 'button';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = ICON_CHAT;

  var panel = el('div', 'panel');
  panel.setAttribute('role', 'dialog');
  var head = el('div', 'head');
  var titles = el('div');
  var title = el('strong', '', 'Chat with us');
  var subtitle = el('span', '', 'We usually reply in a few seconds');
  titles.appendChild(title);
  titles.appendChild(subtitle);
  var close = el('button', '', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close chat');
  head.appendChild(titles);
  head.appendChild(close);

  var list = el('div', 'list');
  list.setAttribute('aria-live', 'polite');
  var dots = el('div', 'dots');
  dots.innerHTML = '<i></i><i></i><i></i>';
  var note = el('div', 'note');
  var form = el('form');
  var input = el('textarea');
  input.placeholder = 'Write a message…';
  input.setAttribute('aria-label', 'Message');
  input.maxLength = 1000;
  var send = el('button', '', 'Send');
  send.type = 'submit';
  form.appendChild(input);
  form.appendChild(send);
  var brand = el('div', 'brand', 'Powered by Agently');

  panel.appendChild(head);
  panel.appendChild(list);
  panel.appendChild(note);
  panel.appendChild(form);
  panel.appendChild(brand);
  root.appendChild(panel);
  root.appendChild(bubble);
  host.style.setProperty('--c', '#2563eb');

  var seen = {};
  var pending = {};
  var lastAt = null;
  var open = false;
  var pollTimer = null;
  var welcome = 'Hi! How can we help you today?';
  var welcomeShown = false;

  function scrollDown() {
    list.scrollTop = list.scrollHeight;
  }

  function addMessage(m) {
    var wrap = el('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = m.from === 'visitor' ? 'flex-end' : 'flex-start';
    if (m.from === 'staff') wrap.appendChild(el('div', 'who', 'Team member'));
    if (m.text) wrap.appendChild(el('div', 'msg ' + m.from, m.text));
    (m.images || []).forEach(function (src) {
      if (!/^https:\/\//.test(src)) return;
      var box = el('div', 'msg ' + m.from);
      var img = el('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.onload = scrollDown;
      box.appendChild(img);
      wrap.appendChild(box);
    });
    list.insertBefore(wrap, dots.parentNode === list ? dots : null);
    scrollDown();
    return wrap;
  }

  function showWelcome() {
    if (welcomeShown) return;
    welcomeShown = true;
    addMessage({ from: 'bot', text: welcome });
  }

  function poll() {
    var q = '?visitorId=' + encodeURIComponent(visitorId) + (lastAt ? '&after=' + encodeURIComponent(lastAt) : '');
    return api('/messages' + q)
      .then(function (r) {
        (r.messages || []).forEach(function (m) {
          if (seen[m.id]) return;
          seen[m.id] = true;
          if (!lastAt || m.at > lastAt) lastAt = m.at;
          if (m.ref && pending[m.ref]) {
            delete pending[m.ref];
            return;
          }
          addMessage(m);
        });
        dots.className = r.waiting ? 'dots on' : 'dots';
        if (r.messages && r.messages.length) store('active', '1');
        scrollDown();
      })
      .catch(function () {});
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (!open) return;
    pollTimer = setTimeout(function () {
      poll().then(schedule);
    }, dots.className === 'dots on' ? 1500 : 4000);
  }

  function toggle(on) {
    open = on;
    panel.className = on ? 'panel open' : 'panel';
    bubble.innerHTML = on ? ICON_CLOSE : ICON_CHAT;
    bubble.setAttribute('aria-label', on ? 'Close chat' : 'Open chat');
    if (on) {
      showWelcome();
      poll().then(schedule);
      setTimeout(function () { input.focus(); }, 50);
    } else {
      clearTimeout(pollTimer);
    }
  }

  bubble.addEventListener('click', function () { toggle(!open); });
  close.addEventListener('click', function () { toggle(false); });

  function submit() {
    var text = input.value.trim();
    if (!text || send.disabled) return;
    note.textContent = '';
    send.disabled = true;
    var mine = addMessage({ from: 'visitor', text: text });
    input.value = '';
    api('/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorId: visitorId, text: text }) })
      .then(function (r) {
        pending[r.id] = true;
        dots.className = 'dots on';
        poll().then(schedule);
      })
      .catch(function (e) {
        mine.firstChild.className += ' failed';
        note.textContent = e.message + ' Your message was not sent.';
        input.value = text;
      })
      .then(function () {
        send.disabled = false;
      });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submit();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  list.appendChild(dots);

  api('/config')
    .then(function (c) {
      host.style.setProperty('--c', /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#2563eb');
      title.textContent = c.name || 'Chat with us';
      if (!c.botOnline) subtitle.textContent = 'Leave a message and our team will reply';
      if (c.welcomeMessage) welcome = c.welcomeMessage;
      (document.body || document.documentElement).appendChild(host);
      // Someone who already chatted sees the conversation again when they open it.
      showWelcome();
      if (store('active') === '1') poll();
    })
    .catch(function () {
      // Not set up for this site, or turned off: show nothing.
    });
})();
`;
