/**
 * @file Sidebar search — filters the API index as you type.
 * @license AGPL-3.0-only
 *
 * ES module on every page, deferred by the browser like every module. The page's
 * configuration is its `application/json` block `#docs-config`; its `index` —
 * one entry per function and constant: name, owner, page#anchor, first sentence —
 * is fetched once, on the first keystroke, and the typed text is matched against
 * name and owner as a plain substring. The results replace the module list while
 * the field is non-empty; Enter opens the first result, Esc clears.
 */

/** Wire the field, the module list and the results list; a page without them does nothing. */
function start() {
  var field   = document.querySelector('.sidebar .search');
  var modules = document.querySelector('.sidebar .modules');
  var results = document.querySelector('.sidebar .results');
  var block   = document.getElementById('docs-config');
  if (!field || !modules || !results || !block) return;

  var config = null;
  try { config = JSON.parse(block.textContent); } catch (e) { return; }
  if (!config || !config.index) return;

  var index = null, loading = null;
  function load() {
    if (index) return Promise.resolve(index);
    loading = loading || fetch(config.index).then(function (r) { return r.json(); })
      .then(function (list) { index = list; return list; });
    return loading;
  }

  function show(list, q) {
    var hits = list.filter(function (e) {
      return e.n.toLowerCase().indexOf(q) >= 0 || (e.o + '.' + e.n).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 40);
    results.innerHTML = hits.length ? hits.map(function (e) {
      return '<li><a href="' + e.h + '"><span class="name">' + e.n + '</span>' +
        '<span class="owner">' + e.o + '</span>' +
        (e.s ? '<span class="hint">' + e.s.replace(/</g, '&lt;') + '</span>' : '') + '</a></li>';
    }).join('') : '<li class="none">No match</li>';
    results.hidden = false;
    modules.hidden = true;
  }

  function clear() {
    results.hidden = true;
    results.innerHTML = '';
    modules.hidden = false;
  }

  field.addEventListener('input', function () {
    var q = field.value.trim().toLowerCase();
    if (!q) return clear();
    load().then(function (list) { if (field.value.trim().toLowerCase() === q) show(list, q); });
  });
  field.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { field.value = ''; clear(); }
    if (e.key === 'Enter') {
      var first = results.querySelector('a');
      if (first) window.location.href = first.getAttribute('href');
    }
  });
}

start();
