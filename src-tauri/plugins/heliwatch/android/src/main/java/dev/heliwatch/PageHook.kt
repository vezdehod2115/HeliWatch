package dev.heliwatch

/**
 * Обёртка site-hook.js в самовызывающуюся функцию с идемпотентной проверкой.
 * Возвращаемый результат: "ok" — внедрён, "already" — уже был, "error: ..." —
 * понятная причина для лога и события в React.
 */
object PageHook {
  fun wrap(source: String): String = buildString(source.length + 256) {
    append("(function(){try{")
    append("if(window.__heliwatch){return 'already';}")
    append(source)
    append("\nreturn window.__heliwatch?'ok':'no-api';")
    append("}catch(e){return 'error:'+(e&&e.message?e.message:e);}})();")
  }
}
