// ==UserScript==
// @name         Stitch Unlocker
// @namespace    https://stitch.withgoogle.com/
// @version      1.1.0
// @description  Client-side region availability and iframe handshake fix for Google Stitch & Google Flow
// @match        https://stitch.withgoogle.com/*
// @match        https://flow.google.com/*
// @match        https://app-companion-430619.appspot.com/*
// @match        https://*.appspot.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @all-frames   true
// ==/UserScript==
(() => {
  'use strict';
  const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* ==========================================================================
     1. Iframe Handshake Fix (Resolves "No handler registered: iframe-ready")
     ========================================================================== */

  // Catch and suppress harmless "iframe-ready" unhandled errors at the window level
  w.addEventListener('error', (event) => {
    if (event.message && event.message.includes('iframe-ready')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
  }, true);

  w.addEventListener('unhandledrejection', (event) => {
    const msg = event.reason?.message || String(event.reason || '');
    if (msg.includes('iframe-ready')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  // Catch postMessage errors before gapi.iframes handles them
  w.addEventListener('message', (event) => {
    try {
      const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      if (data && data.includes('iframe-ready') && data.includes('No handler registered')) {
        event.stopImmediatePropagation();
      }
    } catch {}
  }, true);

  // Hook gapi.iframes on both parent (stitch) and child (app-companion)
  function hookContext(ctx) {
    if (!ctx || ctx.__stitch_hooked) return ctx;
    ctx.__stitch_hooked = true;

    // Parent side (stitch.withgoogle.com): openChild creates child frame proxy
    if (typeof ctx.openChild === 'function') {
      const origOpenChild = ctx.openChild;
      ctx.openChild = function(...args) {
        const child = origOpenChild.apply(this, args);
        if (child && !child.__stitch_hooked) {
          child.__stitch_hooked = true;

          // Prevent host from echoing "iframe-ready" back to child
          const origSend = child.send;
          if (typeof origSend === 'function') {
            child.send = function(name, data, ...sArgs) {
              if (name === 'protocolMessage' && typeof data === 'string') {
                try {
                  const msg = JSON.parse(data);
                  if (msg.messageType === 'iframe-ready') {
                    // Host acknowledges iframe-ready locally, skip echoing back
                    return;
                  }
                } catch {}
              }
              return origSend.call(this, name, data, ...sArgs);
            };
          }

          // Filter out error response if child reported unhandled iframe-ready
          const origRegister = child.register;
          if (typeof origRegister === 'function') {
            child.register = function(name, handler, ...rArgs) {
              if (name === 'protocolMessage' && typeof handler === 'function') {
                const safeHandler = function(raw, ...hArgs) {
                  if (typeof raw === 'string' && raw.includes('iframe-ready') && raw.includes('No handler registered')) {
                    return;
                  }
                  return handler.call(this, raw, ...hArgs);
                };
                return origRegister.call(this, name, safeHandler, ...rArgs);
              }
              return origRegister.call(this, name, handler, ...rArgs);
            };
          }
        }
        return child;
      };
    }

    // Child side (app-companion iframe): getParentIframe gets parent proxy
    if (typeof ctx.getParentIframe === 'function') {
      const origGetParent = ctx.getParentIframe;
      ctx.getParentIframe = function(...args) {
        const parent = origGetParent.apply(this, args);
        if (parent && !parent.__stitch_hooked) {
          parent.__stitch_hooked = true;

          const origRegister = parent.register;
          if (typeof origRegister === 'function') {
            parent.register = function(name, handler, ...rArgs) {
              if (name === 'protocolMessage' && typeof handler === 'function') {
                const safeHandler = function(raw, ...hArgs) {
                  if (typeof raw === 'string') {
                    try {
                      const parsed = JSON.parse(raw);
                      if (parsed.messageType === 'iframe-ready') {
                        // Drop any incoming iframe-ready echo gracefully
                        return;
                      }
                    } catch {}
                  }
                  return handler.call(this, raw, ...hArgs);
                };
                return origRegister.call(this, name, safeHandler, ...rArgs);
              }
              return origRegister.call(this, name, handler, ...rArgs);
            };
          }
        }
        return parent;
      };
    }

    return ctx;
  }

  function hookIframes(iframes) {
    if (!iframes || iframes.__stitch_hooked) return iframes;
    iframes.__stitch_hooked = true;

    const origGetContext = iframes.getContext;
    if (typeof origGetContext === 'function') {
      iframes.getContext = function(...args) {
        const ctx = origGetContext.apply(this, args);
        return hookContext(ctx);
      };
    }
    return iframes;
  }

  function hookGapi(gapi) {
    if (!gapi || gapi.__stitch_hooked) return gapi;
    gapi.__stitch_hooked = true;

    if (gapi.iframes) {
      hookIframes(gapi.iframes);
    } else {
      let iframesVal = undefined;
      Object.defineProperty(gapi, 'iframes', {
        configurable: true,
        enumerable: true,
        get: () => iframesVal,
        set: (v) => { iframesVal = hookIframes(v); }
      });
    }

    if (typeof gapi.load === 'function') {
      const origLoad = gapi.load;
      gapi.load = function(libs, options, ...args) {
        if (typeof options === 'object' && options && typeof options.callback === 'function') {
          const origCb = options.callback;
          options.callback = function(...cbArgs) {
            if (gapi.iframes) hookIframes(gapi.iframes);
            return origCb.apply(this, cbArgs);
          };
        }
        return origLoad.call(this, libs, options, ...args);
      };
    }

    return gapi;
  }

  try {
    let gapiInstance = w.gapi;
    if (gapiInstance) hookGapi(gapiInstance);
    Object.defineProperty(w, 'gapi', {
      configurable: true,
      enumerable: true,
      get: () => gapiInstance,
      set: (val) => {
        gapiInstance = hookGapi(val);
      }
    });
  } catch {}


  /* ==========================================================================
     2. WIZ_global_data Region Unlock (isStitchEnabledInCountry / mL6Y7b)
     ========================================================================== */

  const FORCED_BOOLEAN_KEYS = ['mL6Y7b', 'awbSEf', 'DpimGf', 'Rompu', 'I5EGtf'];

  function applyForcedFlags(target) {
    if (!target || typeof target !== 'object') return target;

    // mL6Y7b is the key for isStitchEnabledInCountry
    target.mL6Y7b = true;
    target.awbSEf = true; // Flow compatibility
    target.DpimGf = true;
    target.Rompu = true;
    target.I5EGtf = true;

    // Enable IS_INTERNAL_TESTER (flag 45745919) in TSDtV proto string
    if (typeof target.TSDtV === 'string' && target.TSDtV.includes('45745919,null,false')) {
      target.TSDtV = target.TSDtV.replace('45745919,null,false', '45745919,null,true');
    }

    return new Proxy(target, {
      get(obj, key) {
        if (FORCED_BOOLEAN_KEYS.includes(key)) return true;
        if (key === 'isCountrySupported' || key === 'isStitchEnabledInCountry') return true;
        if (key === 'CAN_ACCESS_STITCH' || key === 'IS_INTERNAL_TESTER') return true;
        return obj[key];
      },
      set(obj, key, value) {
        obj[key] = value;
        obj.mL6Y7b = true;
        obj.awbSEf = true;
        if (key === 'TSDtV' && typeof value === 'string' && value.includes('45745919,null,false')) {
          obj.TSDtV = value.replace('45745919,null,false', '45745919,null,true');
        }
        return true;
      },
      has(obj, key) {
        if (FORCED_BOOLEAN_KEYS.includes(key)) return true;
        return key in obj;
      }
    });
  }

  try {
    let wiz = applyForcedFlags(w.WIZ_global_data || {});
    Object.defineProperty(w, 'WIZ_global_data', {
      configurable: true,
      enumerable: true,
      get: () => wiz,
      set(value) {
        if (value && typeof value === 'object') {
          wiz = applyForcedFlags(value);
        }
      }
    });
    console.log('[Stitch Unlocker] WIZ_global_data hook installed (mL6Y7b=true, awbSEf=true)');
  } catch (err) {
    console.warn('[Stitch Unlocker] Could not define WIZ_global_data:', err);
  }


  /* ==========================================================================
     3. RPC & API Stream Rewriter (batchexecute / app-companion)
     ========================================================================== */

  // Gate RPCs that return availability/enablement booleans
  const GATE_RPCS = ['cPZSdc', 'KV2T2d', 'rThb8d', 'cO7JOb', 'md9xJf', 'MFtoH'];

  function patchRpcJson(text, id) {
    try {
      const value = JSON.parse(text);
      if (!Array.isArray(value)) return text;
      if (id === 'cPZSdc') {
        while (value.length < 32) value.push(null);
        value[30] = 1;
        value[31] = 1;
      } else if (id === 'MFtoH') {
        // TosService.CheckTos: field 1 indicates accepted TOS
        if (value.length) value[0] = 1;
        else value.push(1);
      } else if (GATE_RPCS.includes(id)) {
        if (value.length) value[0] = 1;
        else value.push(1);
      }
      return JSON.stringify(value);
    } catch { return text; }
  }

  function patchStream(raw) {
    if (typeof raw !== 'string' || !GATE_RPCS.some(id => raw.includes(id))) return raw;
    let start = raw.indexOf(")]}'\n\n");
    let prefix = '';
    if (start >= 0) { start += 6; prefix = raw.slice(0, start); }
    else {
      start = raw.indexOf('\n\n');
      if (start >= 0) { start += 2; prefix = raw.slice(0, start); }
      else start = 0;
    }
    const body = raw.slice(start);
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data)) {
        let changed = false;
        for (const item of data) {
          if (Array.isArray(item) && GATE_RPCS.includes(item[1]) && typeof item[2] === 'string') {
            item[2] = patchRpcJson(item[2], item[1]); changed = true;
          }
        }
        if (changed) return prefix + JSON.stringify(data);
      }
    } catch {}

    let output = prefix, pos = start, changed = false;
    while (pos < raw.length) {
      const nl = raw.indexOf('\n', pos);
      if (nl < 0) { output += raw.slice(pos); break; }
      const sizeText = raw.slice(pos, nl), size = Number(sizeText);
      if (!Number.isFinite(size) || size < 1 || nl + size > raw.length) { output += raw.slice(pos); break; }
      const chunkWithNl = raw.slice(nl, nl + size);
      try {
        const chunk = JSON.parse(chunkWithNl.slice(1));
        let chunkChanged = false;
        for (const item of chunk) {
          if (Array.isArray(item) && GATE_RPCS.includes(item[1]) && typeof item[2] === 'string') {
            item[2] = patchRpcJson(item[2], item[1]); chunkChanged = changed = true;
          }
        }
        output += chunkChanged ? `${1 + JSON.stringify(chunk).length}\n${JSON.stringify(chunk)}` : sizeText + chunkWithNl;
      } catch { output += sizeText + chunkWithNl; }
      pos = nl + size;
    }
    return changed ? output : raw;
  }

  function patchJson(data) {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data)) return data.map(patchJson);
    for (const key of Object.keys(data)) {
      if (key === 'availabilityState') {
        data[key] = 'AVAILABLE';
      } else if ([
        'isCountrySupported', 'is_country_supported',
        'isAgeSupported', 'is_age_supported',
        'isStitchEnabledInCountry', 'is_stitch_enabled_in_country',
        'canAccessStitch', 'can_access_stitch'
      ].includes(key)) {
        data[key] = true;
      } else if (data[key] && typeof data[key] === 'object') {
        data[key] = patchJson(data[key]);
      }
    }
    return data;
  }

  // Intercept XMLHttpRequest
  try {
    const proto = w.XMLHttpRequest?.prototype;
    for (const key of ['responseText', 'response']) {
      const desc = proto && Object.getOwnPropertyDescriptor(proto, key);
      if (!desc?.get) continue;
      Object.defineProperty(proto, key, {
        configurable: true,
        get() {
          const value = desc.get.call(this);
          if (this.responseType && this.responseType !== 'text' && !(key === 'response' && this.responseType === '')) {
            return value;
          }
          return typeof value === 'string' ? patchStream(value) : value;
        }
      });
    }
  } catch {}

  // Intercept Fetch API
  try {
    const originalFetch = w.fetch;
    w.fetch = async function(...args) {
      const request = args[0];
      const url = typeof request === 'string' ? request : request?.url || '';
      const response = await originalFetch.apply(this, args);

      if (url.includes('batchexecute')) {
        try {
          const headers = new Headers(response.headers);
          headers.delete('content-length');
          return new Response(patchStream(await response.text()), {
            status: response.status,
            statusText: response.statusText,
            headers
          });
        } catch {
          return response;
        }
      }

      if ([
        'fetchToolAvailability',
        'checkAppAvailability',
        'trpc/general.',
        'app-companion',
        'appcompanion'
      ].some(part => url.includes(part))) {
        try {
          const text = await response.text();
          const headers = new Headers(response.headers);
          headers.delete('content-length');
          try {
            return new Response(JSON.stringify(patchJson(JSON.parse(text))), {
              status: 200,
              headers
            });
          } catch {
            return new Response(text, {
              status: response.status,
              statusText: response.statusText,
              headers
            });
          }
        } catch {
          return response;
        }
      }

      return response;
    };
  } catch {}
})();
