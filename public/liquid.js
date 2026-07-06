/*
 * liquid.js — real WebGL-shader liquid material for leadsfinder.ai
 * ---------------------------------------------------------------------------
 * Wraps @paper-design/shaders (v0.0.77, vendored self-origin at
 * /vendor/paper-shaders.mjs — no CDN dependency, works offline, one lazy import)
 * into two vanilla helpers:
 *
 *   LFLiquid.enhanceButton(buttonEl, {label, variant})
 *       Upgrades an existing <button> into a liquid-metal shader button — the
 *       shader canvas is a decorative aria-hidden layer *behind* a legible text
 *       label; the element stays a real focusable <button> with its own click
 *       handlers intact. Idle/hover/press speed transitions + click ripple,
 *       ported from the reference React <LiquidMetalButton>.
 *
 *   LFLiquid.mountBackground(hostEl, {colors, speed, ...})
 *       Full-bleed animated mesh-gradient shader for no-map surfaces
 *       (boot loader, login/billing backgrounds).
 *
 * Perf / safety:
 *   - WebGL2 feature-detected; on failure every call is a graceful no-op and the
 *     element keeps its CSS styling (buttons stay normal styled buttons).
 *   - Module import is lazy (dynamic import on first need) so the dashboard's
 *     first paint is never blocked by the 197 KB shader bundle.
 *   - Every live ShaderMount is registered; tab-hidden + prefers-reduced-motion
 *     drive speed to 0 (static frame). dispose() on teardown frees the GL
 *     context so we never approach the browser's ~16-context cap.
 *   - maxPixelCount caps canvas resolution (buttons tiny; backgrounds ~2.9 MP)
 *     to hold 60fps on retina.
 */
(function () {
  'use strict';

  var MODULE_URL = '/vendor/paper-shaders.mjs';

  // ---- lazy module load (one import, memoised) ----------------------------
  var modPromise = null;
  function loadModule() {
    if (!modPromise) {
      modPromise = import(MODULE_URL).catch(function (err) {
        // Reset so a later call can retry, but surface the failure to callers.
        modPromise = null;
        throw err;
      });
    }
    return modPromise;
  }

  // ---- capability detection ----------------------------------------------
  var _webgl2 = null;
  function hasWebGL2() {
    if (_webgl2 !== null) return _webgl2;
    try {
      var c = document.createElement('canvas');
      _webgl2 = !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
    } catch (e) {
      _webgl2 = false;
    }
    return _webgl2;
  }

  var rmql = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return rmql.matches; }

  // ---- live-mount registry: pause on hidden tab / reduced motion ----------
  var registry = new Set();
  function applyGlobalSpeed() {
    var freeze = document.hidden || reduced();
    registry.forEach(function (h) {
      if (!h.mount) return;
      try { h.mount.setSpeed(freeze ? 0 : h.baseSpeed); } catch (e) {}
    });
  }
  document.addEventListener('visibilitychange', applyGlobalSpeed);
  if (rmql.addEventListener) rmql.addEventListener('change', applyGlobalSpeed);

  // Speeds ported from the reference LiquidMetalButton.
  var BTN_IDLE = 0.6, BTN_HOVER = 1.0, BTN_PRESS = 2.4;

  // ---- liquid-metal button uniforms (brand-tuned dark glossy metal) -------
  function buttonUniforms(M, variant) {
    var col = M.getShaderColorFromString;
    var palettes = {
      // deep near-black base with a teal metallic tint — refined, not garish
      teal:   { back: '#05100f', tint: '#37e6cf' },
      indigo: { back: '#070813', tint: '#8b90ff' },
      gold:   { back: '#140c02', tint: '#ffc94d' },
    };
    var p = palettes[variant] || palettes.teal;
    return {
      u_colorBack: col(p.back),
      u_colorTint: col(p.tint),
      u_repetition: 4,
      u_softness: 0.5,
      u_shiftRed: 0.3,
      u_shiftBlue: 0.3,
      u_distortion: 0.32,
      u_contour: 1,
      u_shape: 1,   // circle
      u_angle: 45,
    };
  }

  /**
   * Upgrade an existing <button> to a liquid-metal shader button.
   * Returns a handle ({ setLabel, destroy, ... }) or null when unavailable.
   * The handle is also stored on `el._lfLiquid`.
   */
  function enhanceButton(el, opts) {
    opts = opts || {};
    if (!el) return null;
    if (el._lfLiquid) return el._lfLiquid;

    // Graceful fallback: no WebGL2 → leave a normal, fully-styled button.
    if (!hasWebGL2()) { el.classList.add('lf-liquid-fallback'); return null; }

    var labelText = opts.label != null ? opts.label : (el.textContent || '').trim();

    el.classList.add('lf-liquid-btn');

    var host = document.createElement('span');
    host.className = 'lf-liquid-gl';
    host.setAttribute('aria-hidden', 'true');

    var tint = document.createElement('span'); // dark gradient depth layer
    tint.className = 'lf-liquid-tint';
    tint.setAttribute('aria-hidden', 'true');

    var label = document.createElement('span');
    label.className = 'lf-liquid-label';
    label.textContent = labelText;

    // We only ever wrap text-only buttons here; rebuild the inner structure.
    el.textContent = '';
    el.appendChild(host);
    el.appendChild(tint);
    el.appendChild(label);

    var handle = {
      el: el,
      host: host,
      label: label,
      mount: null,
      destroyed: false,
      variant: opts.variant || 'teal',
      baseSpeed: reduced() ? 0 : BTN_IDLE,
      setLabel: function (t) { label.textContent = t; },
      destroy: function () {
        handle.destroyed = true;
        registry.delete(handle);
        if (handle.mount) { try { handle.mount.dispose(); } catch (e) {} handle.mount = null; }
        el._lfLiquid = null;
        el.classList.remove('lf-liquid-btn', 'lf-liquid-live');
      },
    };
    el._lfLiquid = handle;

    loadModule().then(function (M) {
      if (handle.destroyed) return;
      try {
        handle.mount = new M.ShaderMount(
          host,
          M.liquidMetalFragmentShader,
          buttonUniforms(M, handle.variant),
          undefined,          // default webgl attributes
          handle.baseSpeed,   // speed
          0,                  // currentFrame
          1,                  // minPixelRatio (buttons don't need >1)
          700 * 240 * 4       // maxPixelCount — tiny, buttons are small
        );
        registry.add(handle);
        el.classList.add('lf-liquid-live');
        applyGlobalSpeed(); // respect hidden/reduced immediately
      } catch (e) {
        el.classList.add('lf-liquid-fallback');
      }
    }).catch(function () {
      el.classList.add('lf-liquid-fallback');
    });

    // Speed transitions (skipped under reduced motion).
    var setS = function (s) {
      if (handle.mount && !reduced()) { try { handle.mount.setSpeed(s); } catch (e) {} }
    };
    el.addEventListener('pointerenter', function () { if (!el.disabled) setS(BTN_HOVER); });
    el.addEventListener('pointerleave', function () { setS(handle.baseSpeed); });
    el.addEventListener('pointerdown', function () { if (!el.disabled) setS(BTN_PRESS); });
    el.addEventListener('pointerup', function () { setS(el.matches(':hover') ? BTN_HOVER : handle.baseSpeed); });
    el.addEventListener('focus', function () { if (!el.disabled) setS(BTN_HOVER); });
    el.addEventListener('blur', function () { setS(handle.baseSpeed); });

    // Click ripple (CSS-animated, decorative).
    el.addEventListener('click', function (e) {
      if (el.disabled) return;
      var r = el.getBoundingClientRect();
      var size = Math.max(r.width, r.height) * 1.1;
      var rip = document.createElement('span');
      rip.className = 'lf-ripple';
      rip.setAttribute('aria-hidden', 'true');
      rip.style.width = rip.style.height = size + 'px';
      rip.style.left = (e.clientX - r.left - size / 2) + 'px';
      rip.style.top = (e.clientY - r.top - size / 2) + 'px';
      el.appendChild(rip);
      setTimeout(function () { if (rip.parentNode) rip.parentNode.removeChild(rip); }, 640);
    });

    return handle;
  }

  /**
   * Mount a full-bleed animated mesh-gradient shader inside `host`.
   * Returns a handle ({ destroy, ... }) or null when unavailable.
   */
  function mountBackground(host, opts) {
    opts = opts || {};
    if (!host) return null;
    if (host._lfBg) return host._lfBg;

    if (!hasWebGL2()) { host.classList.add('lf-bg-fallback'); return null; }

    var shaderName = opts.shader === 'liquidMetal' ? 'liquidMetalFragmentShader' : 'meshGradientFragmentShader';

    var handle = {
      host: host,
      mount: null,
      destroyed: false,
      baseSpeed: reduced() ? 0 : (opts.speed != null ? opts.speed : 0.28),
      destroy: function () {
        handle.destroyed = true;
        registry.delete(handle);
        if (handle.mount) { try { handle.mount.dispose(); } catch (e) {} handle.mount = null; }
        host._lfBg = null;
        host.classList.remove('lf-bg-live');
      },
    };
    host._lfBg = handle;

    loadModule().then(function (M) {
      if (handle.destroyed) return;
      var colors = (opts.colors || ['#0c4a44', '#12495e', '#1b2a6b', '#050912'])
        .map(M.getShaderColorFromString);
      var uniforms;
      if (shaderName === 'liquidMetalFragmentShader') {
        uniforms = buttonUniforms(M, opts.variant || 'teal');
      } else {
        uniforms = {
          u_colors: colors,
          u_colorsCount: colors.length,
          u_distortion: opts.distortion != null ? opts.distortion : 0.85,
          u_swirl: opts.swirl != null ? opts.swirl : 0.55,
          u_grainMixer: opts.grainMixer != null ? opts.grainMixer : 0.12,
          u_grainOverlay: opts.grainOverlay != null ? opts.grainOverlay : 0.06,
        };
      }
      try {
        handle.mount = new M.ShaderMount(
          host,
          M[shaderName],
          uniforms,
          undefined,
          handle.baseSpeed,
          0,
          1,                        // minPixelRatio
          (opts.maxPixels || 1600 * 900 * 2) // cap ~2.9 MP for 60fps on retina
        );
        registry.add(handle);
        host.classList.add('lf-bg-live');
        applyGlobalSpeed();
      } catch (e) {
        host.classList.add('lf-bg-fallback');
      }
    }).catch(function () {
      host.classList.add('lf-bg-fallback');
    });

    return handle;
  }

  window.LFLiquid = {
    enhanceButton: enhanceButton,
    mountBackground: mountBackground,
    hasWebGL2: hasWebGL2,
    reduced: reduced,
    load: loadModule,
  };
})();
