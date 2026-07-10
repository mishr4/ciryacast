/*  TMCast embeddable widgets — one-line loader.
 *
 *  Drop a single tag on any page:
 *    <script src="https://cast.tmc.gg/widget.js"
 *            data-station="one" data-type="nowplaying" data-theme="dark"></script>
 *
 *  data-type  : nowplaying | listeners | history | status   (default: nowplaying)
 *  data-theme : dark | light | transparent                  (default: dark)
 *  data-width : CSS width  (default: 100%, max 420px)
 *  data-height: override the per-type default height
 *
 *  It inserts a self-updating, sandboxed <iframe> right where the tag sits.
 *  No dependencies, no globals leaked.
 */
(function () {
  var script = document.currentScript;
  if (!script) {
    // Fallback for async/deferred injection: grab the last widget.js tag
    var all = document.querySelectorAll('script[src*="widget.js"]');
    script = all[all.length - 1];
  }
  if (!script || script.dataset.tmcastMounted) return;
  script.dataset.tmcastMounted = '1';

  var origin = new URL(script.src, location.href).origin;
  var station = script.getAttribute('data-station') || '';
  var type = (script.getAttribute('data-type') || 'nowplaying').toLowerCase();
  var theme = script.getAttribute('data-theme') || 'dark';

  if (!station) { console.warn('[TMCast] widget.js: missing data-station'); return; }

  var HEIGHTS = { nowplaying: 80, listeners: 82, status: 68, history: 236 };
  var height = script.getAttribute('data-height') || HEIGHTS[type] || 80;
  var width = script.getAttribute('data-width') || '100%';

  var iframe = document.createElement('iframe');
  iframe.src = origin + '/widget/' + encodeURIComponent(type) + '/' + encodeURIComponent(station) + '?theme=' + encodeURIComponent(theme);
  iframe.title = 'TMCast ' + type + ' widget';
  iframe.loading = 'lazy';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = 'width:' + width + ';max-width:420px;height:' + height + 'px;border:0;overflow:hidden;display:block;color-scheme:normal;';
  // Sandbox: allow the widget's fetch + opening the full player in a new tab.
  iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin');

  script.parentNode.insertBefore(iframe, script.nextSibling);
})();
