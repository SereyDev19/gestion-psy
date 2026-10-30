// Affichage (taille du texte, thème clair / sombre) : réglages propres à cet ordinateur, appliqués avant l'affichage de la page.
(function () {
  var K = { theme: 'gp_theme', taille: 'gp_taille' };
  function lire(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function ecrire(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible : réglage non conservé */ } }
  function appliquer() {
    var t = lire(K.theme, 'auto'), z = (Number(lire(K.taille, '100')) || 100) / 100;
    var sombre = t === 'sombre' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    var h = document.documentElement;
    h.setAttribute('data-theme', sombre ? 'dark' : 'light');
    h.style.zoom = z === 1 ? '' : String(z);
    h.style.setProperty('--z', String(z));
  }
  appliquer();
  if (window.matchMedia) { var mq = matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', appliquer); else if (mq.addListener) mq.addListener(appliquer); }
  window.GP = { theme: function () { return lire(K.theme, 'auto'); }, taille: function () { return lire(K.taille, '100'); }, regler: function (k, v) { ecrire(K[k], v); appliquer(); } };
})();
