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
   * PiP (этап 4): класс `hw-pip` на <html> и один стиль на страницу.
   * Стиль прячет чужие контролы, которые в маленьком окне перекрывают видео
   * (нижняя панель YouTube и градиенты). Инжект при этом не перезагружается.
   */
  function ensurePipStyle() {
    if (state.pipStyle) {
      return;
    }
    try {
      var style = document.createElement('style');
      style.id = '__heliwatch_pip';
      style.textContent =
        'html.hw-pip,html.hw-pip body{background:transparent !important;}' +
        'html.hw-pip video{object-fit:contain !important;}' +
        'html.hw-pip .ytp-chrome-bottom,html.hw-pip .ytp-chrome-top,' +
        'html.hw-pip .ytp-gradient-bottom,html.hw-pip .ytp-gradient-top,' +
        'html.hw-pip .ytp-pause-overlay,html.hw-pip .ytp-unmute,' +
        'html.hw-pip .hw-pip-hide{display:none !important;opacity:0 !important;}';
      (document.head || document.documentElement).appendChild(style);
      state.pipStyle = true;
    } catch (error) {
      /* старая страница — просто класс, без стиля */
    }
  }

  function setPipMode(on) {
    try {
      ensurePipStyle();
      if (on) {
        document.documentElement.classList.add('hw-pip');
      } else {
        document.documentElement.classList.remove('hw-pip');
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  function boot() {
    scan();
    try {
      var observer = new MutationObserver(function () {
        scan();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (error) {
      /* старый WebView — обойдёмся периодическим сканом */
    }
    setInterval(scan, 2500);
    reportPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // SPA-навигация (YouTube): пересканировать видео после смены URL.
  var lastHref = location.href;
  setInterval(function () {
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
        var video = state.video || pickVideo();
        if (!video) {
          post({ t: 'note', message: 'На странице не найдено видео' });
          return false;
        }
        var name = String(cmd.cmd || '');
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
