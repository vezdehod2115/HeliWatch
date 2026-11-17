/*
 * site-hook.js — код, который выполняется внутри WebView сайта.
 *
 * Задача этапа 1: найти <video>, сообщить о нём в React и уметь выполнить
 * play/pause/seek по команде из React. Никакого доступа к Tauri API здесь нет:
 * только window.HeliNative.post(String) с лимитами на стороне Kotlin.
 *
 * Файл собирается Vite через ?raw и один раз передаётся в Kotlin строкой
 * (команда site_init). Инжект идемпотентен: повторный запуск ничего не делает.
 */
(function () {
  'use strict';

  if (window.__heliwatch) {
    return;
  }

  var VERSION = 1;
  var REMOTE_GUARD_MS = 800;
  var TIME_UPDATE_MS = 1000;
  /* Динамический акцент (§2.5): кадр 16×16 раз в ~1.3 с. */
  var FRAME_SIZE = 16;
  var FRAME_INTERVAL_MS = 1300;
  /* Дедбенд для отправки кадра: меньше — только шум, больше — лишние события. */
  var FRAME_DELTA = 6;
  var VIDEO_EVENTS = [
    'play',
    'playing',
    'pause',
    'seeking',
    'seeked',
    'timeupdate',
    'ratechange',
    'loadedmetadata',
    'durationchange',
    'ended',
    'volumechange',
    'waiting',
    'canplay',
  ];

  var state = {
    video: null,
    applyingUntil: 0,
    lastTimePost: 0,
    pipStyle: false,
    frameStyle: false,
    /* PiP: полноэкранный кадр поверх страницы, без панелей сайта. */
    pipMode: false,
    /* Видео-окно комнаты: {x, y, w, h, r} в CSS-пикселях страницы. */
    frame: null,
    frameAncestors: [],
    observer: null,
    frameCanvas: null,
    frameRgb: null,
    frameTainted: false,
    frameAt: 0,
    ageGate: true,
    ageGateSeen: null,
    ageGateAt: 0,
  };

  function now() {
    return Date.now();
  }

  /** Отправка в Kotlin. Ошибки глотаем: в обычном браузере моста нет. */
  function post(payload) {
    try {
      payload.v = VERSION;
      if (window.HeliNative && typeof window.HeliNative.post === 'function') {
        window.HeliNative.post(JSON.stringify(payload));
      }
    } catch (error) {
      /* no-op */
    }
  }

  function countVideos() {
    try {
      return document.querySelectorAll('video').length;
    } catch (error) {
      return 0;
    }
  }

  function pickVideo() {
    var videos;
    try {
      videos = document.querySelectorAll('video');
    } catch (error) {
      return null;
    }
    var first = null;
    for (var i = 0; i < videos.length; i += 1) {
      var video = videos[i];
      if (!first) {
        first = video;
      }
      if (!video.paused || video.readyState >= 1) {
        return video;
      }
    }
    return first;
  }

  function snapshot(extra) {
    var video = state.video;
    var payload = {
      t: 'video',
      count: countVideos(),
      playing: video ? !video.paused : false,
      time: video ? video.currentTime || 0 : 0,
      duration: video && isFinite(video.duration) ? video.duration : 0,
      rate: video ? video.playbackRate || 1 : 1,
      muted: video ? !!video.muted : false,
      width: video && video.videoWidth ? video.videoWidth : 0,
      height: video && video.videoHeight ? video.videoHeight : 0,
      src: video && video.currentSrc ? String(video.currentSrc).slice(0, 2048) : '',
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) {
          payload[key] = extra[key];
        }
      }
    }
    return payload;
  }

  function emitVideo(event) {
    post(snapshot({ event: event }));
  }

  function isRemoteGuard() {
    return now() < state.applyingUntil;
  }

  function onMediaEvent(event) {
    var type = event && event.type ? event.type : 'update';
    // События, вызванные нашей же командой, не должны уходить обратно.
    if (
      isRemoteGuard() &&
      (type === 'play' || type === 'pause' || type === 'seeked' || type === 'ratechange')
    ) {
      return;
    }
    if (type === 'timeupdate') {
      var stamp = now();
      if (stamp - state.lastTimePost < TIME_UPDATE_MS) {
        return;
      }
      state.lastTimePost = stamp;
    }
    if (type === 'pause' || type === 'ended') {
      // Пауза — акцент возвращается к мятному: кадра больше нет.
      postNoFrame();
    }
    emitVideo(type);
  }

  function detachVideo() {
    var video = state.video;
    if (!video) {
      return;
    }
    for (var i = 0; i < VIDEO_EVENTS.length; i += 1) {
      video.removeEventListener(VIDEO_EVENTS[i], onMediaEvent, true);
    }
    state.video = null;
  }

  function attachVideo(video) {
    if (state.video === video) {
      return;
    }
    detachVideo();
    state.video = video;
    if (!video) {
      emitVideo('lost');
      return;
    }
    for (var i = 0; i < VIDEO_EVENTS.length; i += 1) {
      video.addEventListener(VIDEO_EVENTS[i], onMediaEvent, true);
    }
    // Страница могла пересоздать <video> (YouTube SPA, переключение ролика):
    // возвращаем кадру/окну актуальный элемент.
    applyFrameAncestors(video);
    emitVideo('found');
  }

  function scan() {
    var video = pickVideo();
    if (!video) {
      if (state.video) {
        attachVideo(null);
      }
      return;
    }
    attachVideo(video);
  }

  function reportPage() {
    post({
      t: 'hook-ready',
      href: location.href,
      title: document.title,
      videoCount: countVideos(),
    });
  }

  /**
   * PiP (этап 4) и видео-окно комнаты (этап 8).
   *
   * Один и тот же приём: страница становится прозрачной, её содержимое прячется,
   * а <video> выносится в fixed-слой нужного прямоугольника. В PiP это весь
   * экран, в комнате — центральное окно, вокруг которого React рисует панели.
   * Инжект не перезагружается, позиция обновляется CSS-переменными.
   */
  function ensureFrameStyle() {
    if (state.frameStyle) {
      return;
    }
    try {
      var style = document.createElement('style');
      style.id = '__heliwatch_frame';
      style.textContent =
        'html.hw-pip,html.hw-pip body,html.hw-framed body{background:transparent !important;overflow:hidden !important;}' +
        'html.hw-framed{background:radial-gradient(120% 70% at 50% 0%, #0d3a34, #041615 72%) !important;overflow:hidden !important;}' +
        'html.hw-framed body > *{visibility:hidden !important;}' +
        'html.hw-framed body video,html.hw-pip body video{visibility:visible !important;position:fixed !important;' +
        'left:var(--hw-vx,0px) !important;top:var(--hw-vy,0px) !important;' +
        'width:var(--hw-vw,100vw) !important;height:var(--hw-vh,100vh) !important;' +
        'right:auto !important;bottom:auto !important;min-width:0 !important;min-height:0 !important;' +
        'max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;' +
        'object-fit:contain !important;background:#000 !important;' +
        'border-radius:var(--hw-vr,0px) !important;z-index:2147483647 !important;}' +
        'html.hw-framed body video::-webkit-media-controls,html.hw-pip body video::-webkit-media-controls{display:none !important;}' +
        'html.hw-framed .hw-frame-plain{transform:none !important;filter:none !important;' +
        'perspective:none !important;contain:none !important;will-change:auto !important;' +
        'opacity:1 !important;}' +
        'html.hw-pip .ytp-chrome-bottom,html.hw-pip .ytp-chrome-top,' +
        'html.hw-pip .ytp-gradient-bottom,html.hw-pip .ytp-gradient-top,' +
        'html.hw-pip .ytp-pause-overlay,html.hw-pip .ytp-unmute,' +
        'html.hw-pip .hw-pip-hide{display:none !important;opacity:0 !important;}';
      (document.head || document.documentElement).appendChild(style);
      state.frameStyle = true;
    } catch (error) {
      /* старая страница — просто класс, без стиля */
    }
  }

  function ensurePipStyle() {
    ensureFrameStyle();
    state.pipStyle = true;
  }

  function clearFrameAncestors() {
    for (var i = 0; i < state.frameAncestors.length; i += 1) {
      try {
        state.frameAncestors[i].classList.remove('hw-frame-plain');
      } catch (error) {
        /* узел мог исчезнуть */
      }
    }
    state.frameAncestors = [];
  }

  /**
   * Предки видео с transform/filter создают containing block для fixed —
   * сбрасываем их, иначе окно «прилипает» к контейнеру плеера, а не к экрану.
   */
  function applyFrameAncestors(video) {
    clearFrameAncestors();
    if (!video || (!state.frame && !state.pipMode)) {
      return;
    }
    var node = video.parentElement;
    var depth = 0;
    while (node && node !== document.documentElement && depth < 40) {
      try {
        node.classList.add('hw-frame-plain');
        state.frameAncestors.push(node);
      } catch (error) {
        break;
      }
      node = node.parentElement;
      depth += 1;
    }
  }

  function renderFrame() {
    var root = document.documentElement;
    var frame = state.pipMode ? { x: 0, y: 0, w: 0, h: 0, r: 0 } : state.frame;
    if (!frame) {
      root.classList.remove('hw-framed');
      root.classList.remove('hw-pip');
      clearFrameAncestors();
      return;
    }
    ensureFrameStyle();
    root.classList.add('hw-framed');
    if (state.pipMode) {
      root.classList.add('hw-pip');
      root.style.setProperty('--hw-vx', '0px');
      root.style.setProperty('--hw-vy', '0px');
      root.style.setProperty('--hw-vw', '100vw');
      root.style.setProperty('--hw-vh', '100vh');
      root.style.setProperty('--hw-vr', '0px');
    } else {
      root.classList.remove('hw-pip');
      root.style.setProperty('--hw-vx', Math.round(frame.x) + 'px');
      root.style.setProperty('--hw-vy', Math.round(frame.y) + 'px');
      root.style.setProperty('--hw-vw', Math.round(frame.w) + 'px');
      root.style.setProperty('--hw-vh', Math.round(frame.h) + 'px');
      root.style.setProperty('--hw-vr', (frame.r || 0) + 'px');
    }
    applyFrameAncestors(state.video || pickVideo());
  }

  function setPipMode(on) {
    try {
      state.pipMode = !!on;
      // В маленьком окне не крутим тяжёлые наблюдатели за DOM.
      if (on) {
        if (state.observer) {
          state.observer.disconnect();
          state.observer = null;
        }
      } else {
        startObserver();
      }
      renderFrame();
      return true;
    } catch (error) {
      return false;
    }
  }

  /** Видео-окно комнаты: прямоугольник в CSS-пикселях страницы. */
  function setWindowMode(on, cmd) {
    try {
      if (!on) {
        state.frame = null;
      } else {
        var x = Number(cmd.x);
        var y = Number(cmd.y);
        var w = Number(cmd.w);
        var h = Number(cmd.h);
        if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
          return false;
        }
        // Координаты приходят в CSS-пикселях экрана, а страница с
        // useWideViewPort может быть отмасштабирована (десктопный layout).
        // Переводим прямоугольник в систему координат layout viewport.
        var viewport = window.visualViewport;
        var scaleX = viewport && viewport.width > 0 ? window.innerWidth / viewport.width : 1;
        var scaleY = viewport && viewport.height > 0 ? window.innerHeight / viewport.height : 1;
        if (!isFinite(scaleX) || scaleX <= 0) {
          scaleX = 1;
        }
        if (!isFinite(scaleY) || scaleY <= 0) {
          scaleY = 1;
        }
        x = x * scaleX + (viewport ? viewport.offsetLeft : 0);
        y = y * scaleY + (viewport ? viewport.offsetTop : 0);
        w = w * scaleX;
        h = h * scaleY;
        state.frame = {
          x: x,
          y: y,
          w: w,
          h: h,
          r: (Number(cmd.radius) || 0) * Math.min(scaleX, scaleY),
        };
      }
      renderFrame();
      return true;
    } catch (error) {
      return false;
    }
  }

  // ---------- Динамический акцент (§2.5, этап 7) ----------

  function linearize(channel) {
    var value = Math.min(255, Math.max(0, channel)) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function encodeLinear(value) {
    var clamped = Math.min(1, Math.max(0, value));
    var encoded =
      clamped <= 0.0031308
        ? clamped * 12.92
        : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
  }

  /** Средний цвет в линейном пространстве, без почти чёрных и белых пикселей. */
  function averageFrame(data) {
    var r = 0;
    var g = 0;
    var b = 0;
    var weight = 0;
    var pixels = Math.floor(data.length / 4);
    for (var i = 0; i < pixels; i += 1) {
      var offset = i * 4;
      if (data[offset + 3] < 24) {
        continue;
      }
      var lr = linearize(data[offset]);
      var lg = linearize(data[offset + 1]);
      var lb = linearize(data[offset + 2]);
      var luminance = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      if (luminance < 0.02 || luminance > 0.95) {
        continue;
      }
      r += lr;
      g += lg;
      b += lb;
      weight += 1;
    }
    if (weight === 0) {
      return null;
    }
    return {
      r: encodeLinear(r / weight),
      g: encodeLinear(g / weight),
      b: encodeLinear(b / weight),
    };
  }

  function frameChanged(next) {
    var previous = state.frameRgb;
    if (!next || !previous) {
      return next !== previous;
    }
    return (
      Math.abs(next.r - previous.r) > FRAME_DELTA ||
      Math.abs(next.g - previous.g) > FRAME_DELTA ||
      Math.abs(next.b - previous.b) > FRAME_DELTA
    );
  }

  function sampleFrame() {
    // В PiP/окне комнаты кадр для акцента не нужен: экономим CPU и батарею.
    if (state.pipMode) {
      return;
    }
    var video = state.video || pickVideo();
    if (!video || !video.videoWidth || video.paused) {
      return;
    }
    try {
      if (!state.frameCanvas) {
        state.frameCanvas = document.createElement('canvas');
        state.frameCanvas.width = FRAME_SIZE;
        state.frameCanvas.height = FRAME_SIZE;
      }
      var context = state.frameCanvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        return;
      }
      context.drawImage(video, 0, 0, FRAME_SIZE, FRAME_SIZE);
      var frame = context.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE);
      var rgb = averageFrame(frame.data);
      state.frameTainted = false;
      if (!frameChanged(rgb)) {
        return;
      }
      state.frameRgb = rgb;
      state.frameAt = now();
      post({
        t: 'frame',
        rgb: rgb,
        w: video.videoWidth || 0,
        h: video.videoHeight || 0,
      });
    } catch (error) {
      // Чужое видео на canvas: getImageData бросает SecurityError. Сообщаем один
      // раз — React включит обязательный фоллбэк на мятный.
      if (!state.frameTainted) {
        state.frameTainted = true;
        state.frameRgb = null;
        post({ t: 'frame', rgb: null, w: 0, h: 0 });
      }
    }
  }

  function postNoFrame() {
    if (state.frameTainted) {
      return;
    }
    if (state.frameRgb === null) {
      return;
    }
    state.frameRgb = null;
    post({ t: 'frame', rgb: null, w: 0, h: 0 });
  }

  // ---------- Age-gate YouTube: best effort (этап 7) ----------

  /**
   * Не обходим ограничение: только сообщаем React, что сайт просит подтвердить
   * возраст. Пользователь сам решает — войти в аккаунт в окне сайта или открыть
   * видео в браузере. Флаг выключается командой setAgeGate из настроек.
   */
  function detectAgeGate() {
    if (!state.ageGate || state.pipMode) {
      return;
    }
    var detected = false;
    var hint = '';
    try {
      var selectors =
        'ytd-consent-bump-v2-lightbox, ytd-player-error-message-renderer, ' +
        'tp-yt-paper-dialog, [class*="age-gate"], [id*="age-gate"], ' +
        '[class*="age-verification"], [class*="agecheck"]';
      var nodes = document.querySelectorAll(selectors);
      for (var i = 0; i < nodes.length && i < 8; i += 1) {
        var node = nodes[i];
        if (!node.getClientRects().length) {
          continue;
        }
        var text = String(node.textContent || '').slice(0, 400);
        if (/sign in to confirm|подтверд|возраст|age.?gate|18\+/i.test(text)) {
          detected = true;
          hint = text.slice(0, 120);
          break;
        }
      }
      if (!detected && /(^|\.)youtube\.com$/i.test(location.hostname)) {
        var bodyText = String((document.body && document.body.innerText) || '').slice(0, 4000);
        if (/sign in to confirm your age|подтвердите свой возраст/i.test(bodyText)) {
          detected = true;
          hint = 'YouTube просит подтвердить возраст';
        }
      }
    } catch (error) {
      return;
    }
    var stamp = now();
    var changed = state.ageGateSeen !== detected;
    var stale = detected && stamp - state.ageGateAt > 30000;
    if (!changed && !stale) {
      return;
    }
    state.ageGateSeen = detected;
    state.ageGateAt = stamp;
    post({
      t: 'age-gate',
      detected: detected,
      host: location.hostname,
      hint: hint,
    });
  }

  function startObserver() {
    if (state.observer) {
      return;
    }
    try {
      state.observer = new MutationObserver(function () {
        scan();
      });
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (error) {
      state.observer = null;
    }
  }

  function boot() {
    scan();
    startObserver();
    setInterval(scan, 2500);
    setInterval(sampleFrame, FRAME_INTERVAL_MS);
    setInterval(detectAgeGate, 2500);
    reportPage();
    detectAgeGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // SPA-навигация (YouTube): пересканировать видео после смены URL.
  var lastHref = location.href;
  setInterval(function () {
    if (state.pipMode) {
      return;
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      scan();
      reportPage();
    }
  }, 1500);

  window.__heliwatch = {
    version: VERSION,
    probe: function () {
      scan();
      reportPage();
      return true;
    },
    setPip: setPipMode,
    apply: function (cmd) {
      try {
        if (!cmd || typeof cmd !== 'object') {
          return false;
        }
        var name = String(cmd.cmd || '');
        if (name === 'setAgeGate') {
          // Настройка «подсказка age-gate» не требует видео на странице.
          state.ageGate = !!cmd.on;
          if (!state.ageGate && state.ageGateSeen) {
            state.ageGateSeen = false;
            post({ t: 'age-gate', detected: false, host: location.hostname, hint: '' });
          }
          return true;
        }
        if (name === 'setWindow') {
          // Видео-окно комнаты: не требует, чтобы видео уже нашлось.
          return setWindowMode(!!cmd.on, cmd);
        }
        if (name === 'setPip') {
          return setPipMode(!!cmd.on);
        }
        var video = state.video || pickVideo();
        if (!video) {
          post({ t: 'note', message: 'На странице не найдено видео' });
          return false;
        }
        state.applyingUntil = now() + REMOTE_GUARD_MS;
        if (name === 'play') {
          var promise = video.play();
          if (promise && typeof promise.catch === 'function') {
            promise.catch(function () {
              post({ t: 'note', message: 'Браузер заблокировал воспроизведение' });
            });
          }
        } else if (name === 'pause') {
          video.pause();
        } else if (name === 'seek') {
          var target = Number(cmd.t);
          if (!isFinite(target)) {
            return false;
          }
          video.currentTime = Math.max(0, target);
        } else if (name === 'seekBy') {
          var delta = Number(cmd.delta);
          if (!isFinite(delta)) {
            return false;
          }
          video.currentTime = Math.max(0, (video.currentTime || 0) + delta);
        } else if (name === 'setRate') {
          var rate = Number(cmd.rate);
          if (!isFinite(rate) || rate < 0.25 || rate > 4) {
            return false;
          }
          video.playbackRate = rate;
        } else if (name === 'setVolume') {
          // Ducking из React (§2.5): пока кто-то говорит, звук видео тише.
          var volume = Number(cmd.volume);
          if (!isFinite(volume)) {
            return false;
          }
          video.volume = Math.min(1, Math.max(0, volume));
        } else if (name === 'mute') {
          video.muted = !!cmd.muted;
        } else {
          return false;
        }
        emitVideo('remote-' + name);
        return true;
      } catch (error) {
        post({
          t: 'note',
          message: 'Ошибка команды: ' + (error && error.message ? error.message : error),
        });
        return false;
      }
    },
  };
})();
