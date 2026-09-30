// ==UserScript==
// @name         OGameX Assistant
// @namespace    ogamex-assistant
// @homepageURL  https://github.com/Mitjano/ogamex-assistant
// @supportURL   https://github.com/Mitjano/ogamex-assistant/issues
// @version      3.120.1
// @description  Asystent OGameX: obrona floty (auto-ratunek, zawroty), Fleet Save, ekspedycje, mining, złom, farma nieaktywnych. Alarmy push przez ntfy.sh (temat losowany przy instalacji — patrz panel).
// @author       MCH
// @match        https://genesis.ogamex.net/*
// @match        https://athena.ogamex.net/*
// @updateURL    https://raw.githubusercontent.com/Mitjano/ogamex-assistant/main/ogamex-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/Mitjano/ogamex-assistant/main/ogamex-assistant.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// @connect      raw.githubusercontent.com
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function() {
  "use strict";
  const VERSION = "3.120.1";
  const HOST = location.host;
  const UNI = HOST === "athena.ogamex.net" ? "Athena" : HOST === "genesis.ogamex.net" ? "Genesis" : HOST.split(".")[0] || HOST;
  const PAGE_AT = Date.now();
  const Store = {
    get(k, d = null) {
      try {
        const v = GM_getValue(`${HOST}:ogx3_${k}`, undefined);
        return v === undefined ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        GM_setValue(`${HOST}:ogx3_${k}`, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        GM_setValue(`${HOST}:ogx3_${k}`, "null");
      } catch {}
    }
  };
  const LOG_MAX = 400;
  let logEntries = Store.get("log", []) || [];
  let logTimer = null;
  function log(msg, type = "info") {
    const time = (new Date).toLocaleTimeString("pl-PL", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const s = String(msg);
    logEntries.unshift({
      time: time,
      msg: s.length > 700 ? s.slice(0, 700) + " [ucięte]" : s,
      type: type
    });
    if (logEntries.length > LOG_MAX) logEntries.length = LOG_MAX;
    if (!logTimer) logTimer = setTimeout(() => {
      logTimer = null;
      Store.set("log", logEntries);
    }, 800);
    try {
      UI.renderLog();
    } catch {}
  }
  function flushLog() {
    try {
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = null;
      }
      Store.set("log", logEntries);
    } catch {}
  }
  let leavingPage = false;
  try {
    window.addEventListener("pagehide", () => {
      leavingPage = true;
      flushLog();
    });
    window.addEventListener("beforeunload", () => {
      leavingPage = true;
      flushLog();
    });
  } catch {}
  const Nav = {
    go(url, why) {
      try {
        Store.set("nav_last", {
          at: Date.now(),
          to: String(url),
          why: why
        });
      } catch {}
      flushLog();
      leavingPage = true;
      location.replace(url);
    },
    click(el, why) {
      try {
        Store.set("nav_last", {
          at: Date.now(),
          to: "klik: " + why,
          why: why
        });
      } catch {}
      flushLog();
      leavingPage = true;
      el.click();
    }
  };
  const ECO_KIND = k => k === "expedition" || k === "asteroid" || k === "debris" || k === "farm";
  const ECO_LABEL = k => ({
    expedition: "fala ekspedycji",
    asteroid: "lot minerów",
    debris: "lot po złom",
    farm: "atak farmy"
  }[k] || "lot ekonomii");
  const Journal = {
    add(kind, msg) {
      const j = Store.get("journal", []) || [];
      j.unshift({
        at: Date.now(),
        kind: kind,
        msg: String(msg).slice(0, 400)
      });
      if (j.length > 600) j.length = 600;
      Store.set("journal", j);
      Notifier.fromJournal(kind, msg);
    }
  };
  const Heartbeat = {
    URL: "http://127.0.0.1:8765/hb?u=" + encodeURIComponent(location.host.split(".")[0] || "gra"),
    ping() {
      const now = Date.now();
      if (now - (Store.get("hb_last", 0) || 0) < 6e4) return;
      Store.set("hb_last", now);
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url: this.URL,
          timeout: 4e3,
          onload: () => {
            Store.set("hb_down_push", 0);
            Store.set("hb_ever", true);
            if (Store.get("hb_ok", null) !== true) {
              Store.set("hb_ok", true);
              log("[WATCHDOG] strażnik odpowiada — zawieszona karta zostanie ożywiona automatycznie (restart Firefoksa + push).", "success");
            }
          },
          onerror: () => this.down(),
          ontimeout: () => this.down()
        });
      } catch {
        this.down();
      }
    },
    down() {
      const bylKiedys = Store.get("hb_ever", false) === true;
      if (Store.get("hb_ok", null) !== false) {
        Store.set("hb_ok", false);
        log(bylKiedys ? "[WATCHDOG] strażnik PRZESTAŁ odpowiadać (LaunchAgent wyłączony?) — po zawieszeniu karty NIE będzie auto-restartu." : "[WATCHDOG] na tej maszynie strażnika nie ma (nigdy nie odpowiedział) — nie alarmuję. Zawieszona karta nie zostanie tu ożywiona automatycznie.", "warn");
      }
      if (bylKiedys && Date.now() - (Store.get("hb_down_push", 0) || 0) >= 36e5) {
        Store.set("hb_down_push", Date.now());
        Notifier.push(`🩺 Strażnik karty NIE DZIAŁA (${UNI})`, "Watchdog na Macu nie odpowiada — zawieszona karta NIE zostanie ożywiona i obrona może umrzeć po cichu. Napraw: bash watchdog/install.sh w repo ogamex-userscript.", "high", "warning");
      }
    }
  };
  function hdrSafe(s) {
    const t = String(s == null ? "" : s);
    if (/^[\x20-\x7E]*$/.test(t)) return t;
    try {
      const bytes = (new TextEncoder).encode(t);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return "=?UTF-8?B?" + btoa(bin) + "?=";
    } catch {
      return t.replace(/[^\x20-\x7E]/g, "").trim() || "OGameX";
    }
  }
  const Notifier = {
    THROTTLE: {
      ATAK: 5 * 6e4,
      RATUNEK: 2 * 6e4,
      "POWRÓT": 5 * 6e4,
      "BŁĄD": 5 * 6e4,
      FS: 10 * 6e4,
      EKO: 30 * 6e4
    },
    TOPIC: "",
    topic() {
      let t = Store.get("ntfy_topic", "");
      if (!t) {
        t = "ogx-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
        Store.set("ntfy_topic", t);
        log(`[PUSH] Twój kanał alarmowy ntfy: ${t} — zainstaluj aplikację ntfy na telefonie i zasubskrybuj DOKŁADNIE ten temat, inaczej alarmy o atakach nie dojdą. Temat widać też w panelu (Ustawienia: Obrona).`, "warn");
      }
      return t;
    },
    enabled() {
      return Store.get("ntfy_on", true) !== false;
    },
    throttleKey(kind, msg) {
      const c = [ ...String(msg || "").matchAll(/\[(\d+:\d+:\d+)\]/g) ].map(m => m[1]);
      return c.length ? `${kind}|${[ ...new Set(c) ].sort().join(",")}` : kind;
    },
    throttled(kind, msg) {
      const key = this.throttleKey(kind, msg);
      const last = Store.get("ntfy_last", {}) || {};
      if (Date.now() - (last[key] || 0) < (this.THROTTLE[kind] || 5 * 6e4)) return true;
      last[key] = Date.now();
      Store.set("ntfy_last", last);
      return false;
    },
    push(title, msg, priority = "default", tags = "") {
      if (!this.enabled()) {
        if (priority === "urgent" || priority === "high") log(`[PUSH] POMINIĘTE — push OFF (${title}).`, "warn");
        return;
      }
      const topic = this.topic();
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: "https://ntfy.sh/" + topic,
          headers: {
            Title: hdrSafe(title),
            Priority: priority,
            Tags: hdrSafe(tags)
          },
          data: String(msg).slice(0, 600),
          timeout: 15e3,
          onload: r => log(`[PUSH] wysłano (${priority}) na ${topic}: ${title} — HTTP ${r && r.status}`, "info"),
          onerror: () => log("[PUSH] ntfy.sh nie odpowiedziało.", "warn"),
          ontimeout: () => log("[PUSH] ntfy.sh timeout.", "warn")
        });
      } catch (e) {
        log(`[PUSH] błąd: ${e.message}`, "warn");
      }
    },
    speak(text, times = 2) {
      if (!Store.get("voice_on", false)) return;
      try {
        if (!("speechSynthesis" in window)) return;
        const v = (speechSynthesis.getVoices() || []).find(x => /^pl/i.test(x.lang || ""));
        for (let i = 0; i < times; i++) {
          const u = new SpeechSynthesisUtterance(text);
          if (v) u.voice = v;
          u.lang = "pl-PL";
          speechSynthesis.speak(u);
        }
      } catch {}
    },
    fromJournal(kind, msg) {
      const m = String(msg || "");
      if (kind === "ATAK") {
        if (this.throttled("ATAK", m)) return;
        this.push(`⚔️ ATAK (${UNI})`, CFG.autoRescue ? m : `OBSERWATOR — bot NIE rusza flotą, ratuj ręcznie! ${m}`, "urgent", "rotating_light");
        this.speak("Uwaga! Atak na bazę!", 3);
      } else if (kind === "RATUNEK" && /WYS[ŁL]ANO|wysłan/i.test(m)) {
        if (this.throttled("RATUNEK", m)) return;
        this.push(`🛟 Flota ewakuowana (${UNI})`, m, "default", "shield");
      } else if (kind === "FS" && /WYS[ŁL]ANO|wysłan/i.test(m)) {
        if (this.throttled("FS", m)) return;
        this.push(`🌙 Fleet Save (${UNI})`, m, "min", "crescent_moon");
      } else if (kind === "BŁĄD") {
        if (this.throttled("BŁĄD", m)) return;
        this.push(`⚠️ Obrona: BŁĄD (${UNI})`, m, "high", "warning");
      } else if (kind === "SONDA") {
        if (this.throttled("SONDA", m)) return;
        this.push(`🛰 Skan (${UNI}) — flotą nie ruszam`, m, "default", "satellite");
      } else if (kind === "EKO") {
        if (this.throttled("EKO", m)) return;
        this.push(`🧰 Ekonomia stoi (${UNI})`, m, "low", "gear");
      } else if (kind === "POWRÓT" && /wróci|wysłan/i.test(m)) {
        if (this.throttled("POWRÓT", m)) return;
        this.push(`✅ Flota w domu (${UNI})`, m, "min", "white_check_mark");
      }
    }
  };
  const DEFAULTS = {
    enabled: true,
    autoRescue: false,
    homeToMoon: false,
    deutReserve: 0,
    airSpeedPct: 3,
    confirmMs: 2e4,
    tooLateSec: 40,
    recallBufferSec: 90,
    tickMs: 2e4,
    impact: {
      enabled: true,
      leadSec: 60,
      recyclerOffsetSec: 2,
      beep: true,
      title: true,
      goMaxLateSec: 300
    },
    barExcess: true,
    barHoldMs: 6e4,
    barConfirmGraceMs: 6e4,
    hangarTrustMs: 10 * 6e4,
    barMaxAgeMs: 3 * 6e4,
    barKeepFreshMs: 1e5,
    barSpyHoldMs: 5 * 6e4,
    barSpyMaxExcess: 1,
    barFromList: false,
    maxNavPerHour: 240,
    attackHangarMaxAgeMs: 45e3,
    attackGuardWindowMs: 30 * 6e4,
    quietHours: {
      enabled: true,
      startHour: 23,
      endHour: 5
    },
    recon: false,
    reconMs: 8 * 6e4,
    reconEmptyMs: 45 * 6e4,
    reconMode: "fleet",
    stealth: {
      enabled: true,
      colonyHours: 8
    },
    human: {
      breaks: true,
      breakEveryMinMin: 35,
      breakEveryMaxMin: 65,
      breakLenMinMin: 5,
      breakLenMaxMin: 15,
      economyAtNight: false,
      ecoIdleSec: 0
    },
    fs: {
      enabled: false,
      returnHour: 7,
      returnMinute: 0,
      speedPct: 10,
      target: null,
      slotReserve: 1,
      restHours: 0
    },
    aster: {
      enabled: false,
      scanGapSec: 6,
      minTtlSec: 300,
      launchFrom: null,
      cargoPerMiner: 0,
      expectedRes: 0,
      buffer: 1.15,
      percentile: 85,
      sampleSize: 20,
      minMiners: 1,
      maxMiners: 0,
      parallel: true,
      partialRatio: .5,
      slotReserve: 1,
      gapSec: 20,
      maxFlightMin: 45,
      idleScanMin: 15,
      quietPerTick: 8,
      quietGapMs: 1200,
      lockMin: 60
    },
    bonus: {
      enabled: true,
      gapMin: 2,
      retryMin: 15
    },
    moon: {
      enabled: true,
      maxMetalShare: .25,
      minKm: 1e3,
      maxTries24h: 3
    },
    debris: {
      enabled: true,
      everyMin: 20,
      cargoPerRecycler: 125e3,
      unknownShare: .2
    },
    expo: {
      enabled: false,
      waves: 1,
      discoverer40: true,
      holdingHours: 1,
      gapMinSec: 60,
      gapMaxSec: 90,
      restMinMin: 0,
      restMaxMin: 0,
      slotReserve: 1,
      excludeTypes: [ "ASTEROID_MINER", "COLONY_SHIP", "DEATH_STAR", "RECYCLER", "AVATAR", "SPY_PROBE" ],
      launchFrom: null
    },
    farm: {
      enabled: false,
      shipType: "BATTLESHIP",
      perAttack: 0,
      ranges: "",
      launchFrom: null,
      maxTargetRank: 800,
      dbRefreshHours: 12,
      minTargetProfit: 0,
      sequential: false,
      repeatEachSweep: true,
      targetCooldownMin: 180,
      slotReserve: 2
    }
  };
  const pinCodeOwned = c => {
    c.expo.excludeTypes = DEFAULTS.expo.excludeTypes.slice();
    return c;
  };
  const CFG = (() => {
    const saved = Store.get("cfg", {}) || {};
    const out = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) ? Object.assign({}, v, saved[k] || {}) : saved[k] !== undefined ? saved[k] : v;
    }
    pinCodeOwned(out);
    return out;
  })();
  let cfgSavedAt = Store.get("cfg_saved_at", 0) || 0;
  const cfgMerge = (into, from) => {
    for (const [k, v] of Object.entries(from || {})) {
      into[k] = v && typeof v === "object" && !Array.isArray(v) ? Object.assign({}, into[k] || {}, v) : v;
    }
  };
  const saveCfg = () => {
    cfgSavedAt = Date.now();
    Store.set("cfg_saved_at", cfgSavedAt);
    Store.set("cfg", CFG);
  };
  const syncCfg = () => {
    try {
      const at = Store.get("cfg_saved_at", 0) || 0;
      if (at <= cfgSavedAt) return false;
      const st = Store.get("cfg", null);
      if (!st) {
        cfgSavedAt = at;
        return false;
      }
      const before = {
        expo: !!CFG.expo?.enabled,
        aster: !!CFG.aster?.enabled,
        debris: !!CFG.debris?.enabled,
        farm: !!CFG.farm?.enabled,
        bot: !!CFG.enabled,
        auto: !!CFG.autoRescue
      };
      cfgMerge(CFG, st);
      pinCodeOwned(CFG);
      cfgSavedAt = at;
      const after = {
        expo: !!CFG.expo?.enabled,
        aster: !!CFG.aster?.enabled,
        debris: !!CFG.debris?.enabled,
        farm: !!CFG.farm?.enabled,
        bot: !!CFG.enabled,
        auto: !!CFG.autoRescue
      };
      const diff = Object.keys(before).filter(k => before[k] !== after[k]).map(k => `${{
        expo: "ekspedycje",
        aster: "minery",
        debris: "złom",
        farm: "farma",
        bot: "bot",
        auto: "auto-ratunek"
      }[k]} ${after[k] ? "ON" : "OFF"}`);
      log(`[CFG] ustawienia zmienione w innej karcie (${new Date(at).toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })}) — przeładowane${diff.length ? ": " + diff.join(", ") : ""}.`, diff.length ? "warn" : "info");
      try {
        if (typeof UI !== "undefined" && UI && UI.renderStatus) UI.renderStatus();
      } catch {}
      return true;
    } catch {
      return false;
    }
  };
  if (!Store.get("migr_debris_on_v356", false)) {
    Store.set("migr_debris_on_v356", true);
    if (!CFG.debris.enabled) {
      CFG.debris.enabled = true;
      saveCfg();
    }
  }
  if (!Store.get("migr_aster_quiet_v3101", false)) {
    Store.set("migr_aster_quiet_v3101", true);
    if (CFG.aster && (CFG.aster.quietPerTick || 4) === 4 && (CFG.aster.quietGapMs || 2500) === 2500) {
      CFG.aster.quietPerTick = DEFAULTS.aster.quietPerTick;
      CFG.aster.quietGapMs = DEFAULTS.aster.quietGapMs;
      saveCfg();
    }
  }
  if (!Store.get("migr_air_speed_min_v378", false)) {
    Store.set("migr_air_speed_min_v378", true);
    if ((CFG.airSpeedPct || 0) > 3) {
      log(`[CFG] prędkość ucieczki ${CFG.airSpeedPct}% → 3% (decyzja właściciela 11.09: możliwie najwolniej, żeby dało się zawrócić).`, "warn");
      CFG.airSpeedPct = 3;
      saveCfg();
    }
  }
  if (!Store.get("migr_moon_on_v367", false)) {
    Store.set("migr_moon_on_v367", true);
    let migMoon = false;
    if (!CFG.moon.enabled) {
      CFG.moon.enabled = true;
      migMoon = true;
    }
    if (CFG.moon.minKm === 2e3) {
      CFG.moon.minKm = 1e3;
      migMoon = true;
    }
    if (migMoon) {
      saveCfg();
      log("[KSIĘŻYC] migracja v3.67.0: włączam moduł domyślnie i celuję w najmniejszą średnicę (stary zapis by to zablokował).", "warn");
    }
  }
  if (!Store.get("migr_fs_returnhour_v368", false)) {
    Store.set("migr_fs_returnhour_v368", true);
    const savedFs = (Store.get("cfg", {}) || {}).fs;
    if (savedFs && typeof savedFs.endHour === "number" && typeof savedFs.startHour === "number") {
      CFG.fs.returnHour = savedFs.endHour;
      delete CFG.fs.startHour;
      delete CFG.fs.endHour;
      saveCfg();
      log(`[FS] migracja v3.68.0: dawne okno „do ${savedFs.endHour}:00" staje się godziną powrotu ${savedFs.endHour}:00.`, "warn");
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = (a, b) => a + Math.random() * (b - a);
  async function fetchT(url, opts = {}, ms = 8e3) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController : null;
    const t = ctrl ? setTimeout(() => {
      try {
        ctrl.abort();
      } catch {}
    }, ms) : null;
    try {
      return await fetch(url, ctrl ? {
        ...opts,
        signal: ctrl.signal
      } : opts);
    } finally {
      if (t) clearTimeout(t);
    }
  }
  const key = c => c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : typeof c === "string" ? c : null;
  const parseKey = k => {
    const m = String(k || "").match(/^(\d+):(\d+):(\d+)$/);
    return m ? {
      galaxy: +m[1],
      system: +m[2],
      position: +m[3]
    } : null;
  };
  const page = () => {
    const p = location.pathname;
    if (p.includes("/fleet")) return "fleet";
    if (p.includes("/galaxy")) return "galaxy";
    return p.replace(/^\//, "") || "home";
  };
  const setInput = (input, v) => {
    const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (s) s.call(input, v); else input.value = v;
    input.dispatchEvent(new Event("input", {
      bubbles: true
    }));
    input.dispatchEvent(new Event("change", {
      bubbles: true
    }));
  };
  const looksLoggedOut = (res, html) => {
    try {
      if (res && res.redirected && /login|auth|password/i.test(String(res.url || ""))) return true;
      return /name=["']password["']|type=["']password["']|<form[^>]*login/i.test(String(html || "").slice(0, 1500));
    } catch {
      return false;
    }
  };
  const mmss = sec => {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")) + ":" + String(x).padStart(2, "0");
  };
  const parseCd = t => {
    const m = String(t || "").trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const mi = +m[2], s = +m[3];
    if (mi > 59 || s > 59) return null;
    return +(m[1] || 0) * 3600 + mi * 60 + s;
  };
  const etaOf = el => {
    if (!el) return 0;
    const a = parseInt(el.getAttribute("data-remaining-seconds") || "0") || 0;
    const t = parseCd(el.textContent);
    if (t != null && a > 0 && Math.abs(a - t) > 120) {
      try {
        if (!Once.said("cdgap", 6 * 36e5)) log(`[ZEGAR] licznik i atrybut rozjeżdżają się o ${Math.abs(a - t)} s (atrybut ${a} s, napis „${String(el.textContent || "").trim().slice(0, 20)}”). Biorę mniejszą. Jeśli ten napis to nie odliczanie, pokaż tę linię Claude'owi.`, "warn");
      } catch {}
    }
    return t != null && a > 0 ? Math.min(a, t) : a || t || 0;
  };
  const PlanetBar = {
    _coords(el) {
      const m = (el?.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
      return m ? {
        galaxy: +m[1],
        system: +m[2],
        position: +m[3]
      } : null;
    },
    moonOf(planetEl) {
      let n = planetEl ? planetEl.nextElementSibling : null;
      while (n && !(n.classList && n.classList.contains("moon-select"))) {
        if (n.classList && n.classList.contains("planet-select")) return null;
        n = n.nextElementSibling;
      }
      return n || null;
    },
    pairs(doc) {
      const out = [];
      for (const p of (doc || document).querySelectorAll("a.planet-select, .planet-select")) {
        const c = this._coords(p);
        if (!c) continue;
        out.push({
          key: key(c),
          ...c,
          hasMoon: !!this.moonOf(p),
          name: (p.textContent || "").replace(/\[.*?\]/, "").replace(/\s+/g, " ").trim().slice(0, 30)
        });
      }
      return out;
    },
    active() {
      const el = document.querySelector("a.moon-select.selected, .moon-select.selected, a.planet-select.selected, .planet-select.selected");
      if (!el) return null;
      const isMoon = el.classList.contains("moon-select");
      let c = this._coords(el);
      if (!c && isMoon) {
        let p = el.previousElementSibling;
        while (p && !(p.classList && p.classList.contains("planet-select"))) p = p.previousElementSibling;
        c = this._coords(p);
      }
      if (!c) {
        const row = el.closest("li, div, tr") || el.parentElement;
        c = this._coords(row);
      }
      return c ? {
        key: key(c),
        ...c,
        body: isMoon ? "moon" : "planet"
      } : null;
    },
    anchor(k, body) {
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        if (key(this._coords(p)) !== k) continue;
        if (body === "moon") return this.moonOf(p);
        return p;
      }
      return null;
    },
    ownKeys() {
      const s = new Set(this.pairs().map(p => p.key));
      if (s.size) Store.set("own_keys", [ ...s ]); else for (const k of Store.get("own_keys", []) || []) s.add(k);
      return s;
    }
  };
  const Bar = {
    parse(text) {
      const t = String(text || "");
      const m = t.match(/(\d+)\s*Missions?\s*:/);
      if (!m) return /No fleet movement/i.test(t) ? {
        total: 0,
        own: 0,
        foreign: 0,
        barType: null,
        counter: false
      } : null;
      const total = parseInt(m[1]) || 0;
      const win = t.slice(m.index, m.index + 1200).replace(/\s+/g, " ").slice(0, 220);
      const seg = re => {
        const x = win.match(re);
        return x ? parseInt(x[1]) || 0 : null;
      };
      const own = seg(/(\d+)\s*Own/), hostile = seg(/(\d+)\s*Hostile/), friendly = seg(/(\d+)\s*Friendly/);
      if (own === null && hostile === null && friendly === null) return null;
      const foreign = hostile !== null ? hostile : Math.max(0, total - (own || 0) - (friendly || 0));
      const barType = ((win.match(/Type\s*:\s*([A-Za-z][A-Za-z ()]{0,24})/) || [])[1] || "").trim() || null;
      const attackType = /Type\s*:\s*(Attack|ACS|Destr|Bomb|Missile|Invas|Federation|Group|Hold)/i.test(win);
      return {
        total: total,
        own: own || 0,
        foreign: foreign,
        barType: barType,
        counter: true,
        spyType: /^(Spy|Espionage)/i.test(barType || ""),
        attackType: attackType
      };
    },
    read() {
      try {
        const b = document.body;
        if (!b) return null;
        const panel = document.getElementById("ogx3-panel");
        if (!panel) return this.parse(b.textContent);
        let t = "";
        for (const n of b.childNodes) {
          if (n === panel) continue;
          if (n.nodeType === 1 && n.contains && n.contains(panel)) continue;
          t += " " + (n.textContent || "");
        }
        return this.parse(t);
      } catch {
        try {
          return this.parse(document.body.textContent);
        } catch {
          return null;
        }
      }
    },
    async fetchFresh() {
      try {
        const r = await fetchT("/home", {
          credentials: "same-origin"
        });
        if (!r || !r.ok || /\/auth\/login/.test(r.url || "")) return null;
        const doc = (new DOMParser).parseFromString(await r.text(), "text/html");
        const b = this.parse(doc.body && doc.body.textContent || "");
        if (!b) return null;
        const fullPage = !!doc.querySelector("a.planet-select, .planet-select, #planetList");
        let pary = null;
        try {
          if (fullPage) pary = PlanetBar.pairs(doc);
        } catch {}
        return b.counter || fullPage && b.total === 0 ? {
          ...b,
          counter: true,
          pary: pary
        } : null;
      } catch {
        return null;
      }
    }
  };
  const Rows = {
    URL: "/home/fleetmovementlist",
    ATTACK: /(ATTACK|MISSILE|DESTRUCT|DESTROY|BOMBARD|INVAS|FEDERATION|GROUP|ACS|HOLD)/i,
    SPY: /(ESPIONAGE|SPY|PROBE|SCAN)/i,
    SAFE: /(TRANSPORT|DEPLOY|STATION|RETURN|EXPEDITION|COLONI|HARVEST|RECYCL|ASTEROID|COLLECT)/i,
    classify(tr, own) {
      const type = (String(tr.className).match(/row-mission-type-([A-Z_]+)/i) || [])[1] || "?";
      const srcEl = tr.querySelector(".fleet-source-coords");
      const coords = [ ...(tr.textContent || "").matchAll(/\[(\d+:\d+:\d+)\]/g) ].map(m => m[1]);
      const srcExplicit = (String(srcEl?.textContent || "").match(/(\d+:\d+:\d+)/) || [])[1] || null;
      const src = srcExplicit || (coords.length >= 2 ? coords[0] : null);
      const dst = !srcExplicit && coords.length === 1 ? coords[0] : coords.filter(c => c !== src).pop() || null;
      const eta = etaOf(tr.querySelector("[data-remaining-seconds]"));
      const isSpy = this.SPY.test(type);
      const hostileCls = /row-hostile-mission/i.test(String(tr.className));
      const friendlyCls = /row-friendly-mission/i.test(String(tr.className));
      const attack = friendlyCls ? false : hostileCls ? !isSpy : this.ATTACK.test(type) || !isSpy && !this.SAFE.test(type);
      const tdOf = c => {
        if (!c) return null;
        const a = [ ...tr.querySelectorAll("a") ].find(x => (x.textContent || "").includes(`[${c}]`));
        return a ? a.closest("td") : null;
      };
      const bodyOf = td => !td ? null : td.querySelector("img[src*='moon']") || /\bMoon\b/i.test(td.textContent || "") ? "moon" : "planet";
      const isReturn = /return/i.test(String(tr.className)) || tr.dataset.returnFlight === "true";
      return {
        id: tr.getAttribute("data-fleet-id") || "",
        type: type,
        src: src,
        dst: dst,
        eta: eta,
        readAt: Date.now(),
        srcBody: bodyOf(srcEl && srcEl.closest("td") || tdOf(src)),
        dstBody: bodyOf(tdOf(dst)),
        mine: !!(src && own.size && own.has(src)) || !hostileCls && !friendlyCls && !!dst && own.has(dst) && !!src && own.has(src),
        friendly: friendlyCls,
        hostile: hostileCls,
        attack: attack,
        spy: isSpy && !friendlyCls,
        isReturn: isReturn,
        html: (tr.outerHTML || "").replace(/\s+/g, " ").slice(0, 900)
      };
    },
    listFail(powod) {
      const nl = Store.get("nav_last", null);
      const nasze = leavingPage || nl && Date.now() - (nl.at || 0) < 5e3;
      if (nasze && /Failed to fetch|NetworkError|abort/i.test(String(powod))) {
        if (!Once.said("list_fail_nav", 30 * 6e4)) log(`[LOTY] odczyt listy ruchów przerwany WŁASNYM przeładowaniem strony (${powod}) — to nie awaria gry; nowa strona czyta listę od razu.`, "info");
        return;
      }
      const st = Store.get("list_fail", null) || {
        since: Date.now(),
        n: 0
      };
      Store.set("list_fail", {
        since: st.since || Date.now(),
        n: (st.n || 0) + 1,
        at: Date.now(),
        why: powod
      });
      if (!Once.said("list_fail", 5 * 6e4)) log(`[LOTY] lista ruchów flot nie odpowiada (${powod}) — GŁÓWNY detektor ataków nie widzi NIC; zostaje sam licznik na pasku misji (60 s zwłoki, bez celu).`, "error");
    },
    barFrom(doc) {
      try {
        const txt = doc && doc.body && doc.body.textContent || "";
        const b = Bar.parse(txt);
        if (b && b.counter) {
          if (!Once.said("list_bar_yes", 6 * 36e5)) log(`[LOTY DOM] odpowiedź listy ruchów ZAWIERA licznik misji (${b.total} Missions: ${b.own} Own, ${b.foreign} Hostile). Jeśli te liczby zgadzają się z paskiem na stronie (czyli są GLOBALNE), można włączyć CFG.barFromList — bot miałby wtedy świeży pasek bez przeładowywania strony.`, "info");
          return b;
        }
        if (!Once.said("list_bar_dom", 6 * 36e5)) log(`[LOTY DOM] odpowiedź listy ruchów NIE zawiera licznika „N Missions:” — świeży pasek misji muszę brać ze strony. Fragment: ${String(txt).replace(/\s+/g, " ").slice(0, 300)}`, "info");
      } catch {}
      return null;
    },
    async fetchList(own) {
      let status = 0;
      try {
        const res = await fetchT(this.URL, {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          }
        });
        status = res && res.status || 0;
        Session.tried();
        if (!res.ok) {
          this.listFail(`HTTP ${status}`);
          return {
            ok: false,
            rows: [],
            status: status
          };
        }
        const html = await res.text();
        if (looksLoggedOut(res, html)) {
          Session.lost();
          return {
            ok: false,
            rows: [],
            loggedOut: true,
            status: status
          };
        }
        Session.ok();
        const doc = (new DOMParser).parseFromString(html, "text/html");
        const trs = [ ...doc.querySelectorAll("tr[class*='row-mission-type-']") ];
        Store.set("list_ok_at", Date.now());
        Store.del("list_fail");
        return {
          ok: true,
          rows: trs.map(tr => this.classify(tr, own)),
          bar: this.barFrom(doc)
        };
      } catch (e) {
        this.listFail(`brak odpowiedzi (${e && e.message || "timeout"})`);
        return {
          ok: false,
          rows: [],
          status: status
        };
      }
    },
    readEvents(own) {
      const trs = [ ...document.querySelectorAll("#fleet-movement-content tr[class*='row-mission-type-'], #layoutFleetMovements tr[class*='row-mission-type-']") ];
      return trs.map(tr => this.classify(tr, own));
    },
    ensureOpen() {
      const st = Store.get("events_open", {}) || {};
      if (this.readEvents(new Set).length) {
        if (st.at) Store.set("events_open", {});
        return false;
      }
      const bar = Bar.read();
      if (!bar || !bar.total) return false;
      const wrap0 = document.querySelector("#layoutFleetMovements");
      const content0 = document.getElementById("fleet-movement-content");
      if (wrap0 && content0 && !content0.children.length) {
        Store.set("events_open", {
          at: Date.now(),
          tried: 0,
          dumped: true,
          emptyPanel: true
        });
        if (!Once.said("events_empty", 6 * 36e5)) log("[LOTY] panel „Events” jest na tej stronie PUSTY (nie zwinięty) — gra go tu nie wypełnia. Nie klikam w niego; ataki na kolonie muszą iść innym źródłem.", "warn");
        return false;
      }
      if (Date.now() - (st.at || 0) < 3e4) return false;
      const mine = e => e.closest("#ogx3-panel");
      const clickable = e => {
        if (!e || mine(e) || e.offsetParent === null) return false;
        const href = e.getAttribute && e.getAttribute("href");
        return !(href && href !== "#" && !/^javascript:/i.test(href));
      };
      const barEl = [ ...document.querySelectorAll("a, button, div, span, td, h2, h3") ].find(e => {
        if (!clickable(e) || e.children.length > 3) return false;
        const t = (e.textContent || "").replace(/\s+/g, " ").trim();
        return t.length < 120 && /\d+\s*Missions?\s*:/i.test(t);
      });
      const wrap = document.querySelector("#layoutFleetMovements");
      const byText = re => [ ...document.querySelectorAll("a, button, div, span, td, h2, h3, .title") ].filter(e => clickable(e) && e.children.length <= 3).find(e => {
        const t = (e.textContent || "").replace(/\s+/g, " ").trim();
        return t.length < 60 && re.test(t);
      });
      const fmBtn = byText(/fleet\s*movements?/i);
      const cands = [ {
        el: fmBtn,
        why: "przycisk „Fleet movements”"
      }, {
        el: fmBtn && fmBtn.parentElement,
        why: "rodzic przycisku „Fleet movements”"
      }, {
        el: barEl,
        why: "licznik misji"
      }, {
        el: barEl && barEl.parentElement,
        why: "rodzic licznika misji"
      }, {
        el: wrap && wrap.querySelector(".header .title"),
        why: "nagłówek „Events”"
      }, {
        el: wrap && wrap.querySelector(".header"),
        why: "pasek nagłówka listy lotów"
      }, {
        el: wrap,
        why: "cały kontener listy lotów"
      } ].filter(c => clickable(c.el));
      const tried = st.tried || 0;
      if (tried >= cands.length) {
        if (Date.now() - (st.at || 0) < 10 * 6e4) return false;
        if (!Once.said("events_dom", 30 * 6e4)) {
          const dump = wrap && wrap.outerHTML || fmBtn && fmBtn.outerHTML || (document.querySelector("#fleet-movement-content") || {}).outerHTML || barEl && (barEl.parentElement || barEl).outerHTML || "brak kontenera listy lotów";
          log(`[LOTY DOM] żadne z ${cands.length} kliknięć nie rozwinęło listy lotów (strona: ${page()}) — próbuję dalej co 10 min. Kontener listy: ${String(dump).replace(/\s+/g, " ").slice(0, 1500)}`, "warn");
        }
        Store.set("events_open", {
          at: Date.now(),
          tried: 0,
          dumped: true
        });
        return false;
      }
      const pick = cands[tried];
      Store.set("events_open", {
        at: Date.now(),
        tried: tried + 1
      });
      log(`[LOTY] lista lotów zwinięta — klikam w ${pick.why} (próba ${tried + 1}/${cands.length}).`, "info");
      try {
        pick.el.click();
      } catch {
        return false;
      }
      const n = this.readEvents(new Set).length;
      if (n) {
        log(`[LOTY] lista rozwinięta — widzę ${n} wierszy ze współrzędnymi (${pick.why}).`, "success");
        Store.set("events_open", {});
      }
      return true;
    }
  };
  const Hangar = {
    async restoreActive(uuid) {
      if (!uuid) return false;
      try {
        const r = await fetchT(`/fleet?planet=${uuid}`, {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          },
          credentials: "same-origin"
        });
        return !!(r && r.ok);
      } catch {
        return false;
      }
    },
    async restoreOrShout(uuid, actKey, actBody) {
      if (await this.restoreActive(uuid)) {
        Store.del("planet_drift");
        return true;
      }
      await sleep(600);
      if (await this.restoreActive(uuid)) {
        Store.del("planet_drift");
        return true;
      }
      Store.set("planet_drift", {
        uuid: uuid,
        key: actKey || null,
        body: actBody || null,
        at: Date.now()
      });
      if (!Once.said("planet_drift", 10 * 6e4)) {
        log(`[REKONESANS] NIE przywróciłem Twojej planety [${actKey || "?"}] ${actBody || ""} — sesja gry stoi na obcej kolonii, więc lista ruchów pokazuje TERAZ jej parę, a atak na bazę jest dla niej niewidoczny. Ponawiam przy każdym przebiegu obrony.`, "error");
        Journal.add("BŁĄD", `Sesja gry została na obcej kolonii (nie wróciłem na [${actKey || "?"}]) — lista ruchów raportuje złą parę, obrona widzi tylko licznik na pasku.`);
      }
      return false;
    },
    async scanRemote(k, body) {
      const el = PlanetBar.anchor(k, body);
      const href = el && (el.getAttribute("href") || "");
      const m = href && href.match(/[?&]planet=([^&#"']+)/i);
      if (!m) return null;
      let restore = null, restoreKey = null, restoreBody = null;
      {
        const act = PlanetBar.active();
        if (act && !(act.key === k && act.body === body)) {
          const ea = PlanetBar.anchor(act.key, act.body);
          const ma = ea && (ea.getAttribute("href") || "").match(/[?&]planet=([^&#"']+)/i);
          if (!ma) return null;
          if (ma[1] !== m[1]) {
            restore = ma[1];
            restoreKey = act.key;
            restoreBody = act.body;
          }
        }
      }
      try {
        const r = await fetchT(`/fleet?planet=${m[1]}`, {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          },
          credentials: "same-origin"
        });
        if (restore) {
          await this.restoreOrShout(restore, restoreKey, restoreBody);
          restore = null;
        }
        if (!r.ok) return null;
        const html = await r.text();
        if (looksLoggedOut(r, html)) {
          Session.lost();
          return null;
        }
        const doc = (new DOMParser).parseFromString(html, "text/html");
        const ships = [ ...doc.querySelectorAll("[data-ship-type]") ].map(e => ({
          type: e.dataset.shipType,
          qty: parseInt(e.dataset.shipQuantity || "0") || 0
        })).filter(x => x.type);
        const txt = doc.body ? doc.body.textContent : "";
        const shipsStep = ships.length > 0 || /no ships|there are no ships|brak statk/i.test(txt) || !!doc.querySelector("#btn-next-fleet2, .ship-item");
        if (!shipsStep) {
          if (!Once.said("scanremote_dom", 6 * 36e5)) log(`[REKONESANS DOM] pobrana strona floty [${k}] nie wygląda na krok wyboru statków — wracam do wchodzenia na stronę. Fragment: ${txt.replace(/\s+/g, " ").slice(0, 300)}`, "warn");
          return null;
        }
        const total = ships.reduce((x, y) => x + y.qty, 0);
        const fm = txt.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
        const em = txt.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);
        if (fm || em) {
          const s0 = Situation.load();
          s0.slots = {
            fleet: fm ? {
              used: +fm[1],
              total: +fm[2]
            } : s0.slots?.fleet || null,
            expo: em ? {
              used: +em[1],
              total: +em[2]
            } : s0.slots?.expo || null,
            at: Date.now()
          };
          Situation.save(s0);
        }
        Situation.noteHangar({
          key: k,
          body: body,
          total: total,
          ships: ships,
          at: Date.now(),
          slots: fm ? {
            used: +fm[1],
            total: +fm[2]
          } : null
        });
        return {
          key: k,
          body: body,
          total: total,
          ships: ships
        };
      } catch (e) {
        if (restore) {
          await this.restoreOrShout(restore, restoreKey, restoreBody);
        }
        return null;
      }
    },
    scan() {
      if (page() !== "fleet") return null;
      const a = PlanetBar.active();
      if (!a) {
        if (!Once.said("nosidebar", 30 * 6e4)) {
          log(`[LOT DOM] jestem na /fleet, ale nie rozpoznaję paska planet (a.planet-select/.moon-select). Markup: ${(document.querySelector("#planetList, .planet-list, aside, nav") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 2e3)}`, "error");
          Journal.add("BŁĄD", "Nie rozpoznaję paska planet na stronie Fleet — bot nie wie, gdzie stoi flota. Wyślij log.");
        }
        return null;
      }
      const ships = [ ...document.querySelectorAll("[data-ship-type]") ].map(el => ({
        type: el.dataset.shipType,
        qty: parseInt(el.dataset.shipQuantity || "0") || 0
      })).filter(s => s.type);
      const total = ships.reduce((x, s) => x + s.qty, 0);
      const txt = document.body.textContent;
      const shipsStep = ships.length > 0 || /no ships|there are no ships|brak statk|keine schiffe/i.test(txt) || !!document.querySelector("#btn-next-fleet2, .ship-item, #shipsChosen");
      if (!shipsStep) {
        if (!Once.said("nofleetstep", 30 * 6e4)) log("[LOT] jestem na /fleet, ale to nie krok wyboru statków (formularz w toku?) — NIE zapisuję pustego hangaru.", "info");
        return null;
      }
      const fm = txt.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
      const em = txt.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);
      if (fm || em) {
        const s0 = Situation.load();
        s0.slots = {
          fleet: fm ? {
            used: +fm[1],
            total: +fm[2]
          } : s0.slots?.fleet || null,
          expo: em ? {
            used: +em[1],
            total: +em[2]
          } : s0.slots?.expo || null,
          at: Date.now()
        };
        Situation.save(s0);
      }
      const snap = {
        key: a.key,
        body: a.body,
        total: total,
        ships: ships,
        at: PAGE_AT,
        readAt: Date.now(),
        slots: fm ? {
          used: +fm[1],
          total: +fm[2]
        } : null
      };
      Situation.noteHangar(snap);
      return snap;
    }
  };
  const Session = {
    lost() {
      const s = Store.get("session", {}) || {};
      if (!s.lostAt) {
        s.lostAt = Date.now();
        Store.set("session", s);
        log("[SESJA] gra odpowiada stroną logowania — obrona ŚLEPA. Zaloguj się.", "error");
        Journal.add("BŁĄD", "SESJA WYGASŁA — zaloguj się w grze.");
      }
    },
    ok() {
      const st = Store.get("session", {}) || {};
      if (st.lostAt) {
        Store.set("session", {});
        log("[SESJA] odzyskana — obrona znów widzi.", "success");
      }
    },
    lostRecently() {
      const s = Store.get("session", {}) || {};
      return !!s.lostAt && Date.now() - s.lostAt < 15 * 6e4;
    },
    retryDue() {
      const st = Store.get("session", {}) || {};
      return Date.now() - (st.triedAt || 0) > 6e4;
    },
    tried() {
      const st = Store.get("session", {}) || {};
      Store.set("session", {
        ...st,
        triedAt: Date.now()
      });
    },
    maybeRecover() {
      const st = Store.get("session", {}) || {};
      if (!st.lostAt || Date.now() - st.lostAt < 2 * 6e4) return false;
      if (Date.now() - (st.navAt || 0) < 15 * 6e4) return false;
      if (Fly.mission()) return false;
      Store.set("session", {
        ...st,
        navAt: Date.now()
      });
      log("[SESJA] 2 min od wykrycia wylogowania — próbuję wejść na stronę główną.", "warn");
      setTimeout(() => Nav.go("/", "odzyskiwanie sesji"), 800);
      return true;
    }
  };
  const Situation = {
    load() {
      return Store.get("situation", null) || {
        pairs: {},
        hangars: {},
        threats: [],
        own: [],
        flights: [],
        bar: null,
        active: null,
        updatedAt: 0
      };
    },
    save(s) {
      s.updatedAt = Date.now();
      Store.set("situation", s);
      return s;
    },
    noteHangar(snap) {
      const s = this.load();
      const hk = `${snap.key}|${snap.body}`;
      const cur = s.hangars[hk];
      if (cur && (cur.at || 0) > (snap.at || 0) && !(cur.estFrom && (snap.at || 0) > cur.estFrom)) return;
      s.hangars[hk] = {
        total: snap.total,
        ships: snap.ships,
        at: snap.at
      };
      this.save(s);
    },
    moonGone(s, k, at) {
      let n = 0;
      for (const e of s.expected || []) if (e.fromKey === k && e.fromBody === "moon" && (e.sentAt || 0) < at && (e.returnAt || 0) > at - 6e4) {
        e.fromBody = "planet";
        e.orphan = true;
        n++;
      }
      const hp = (s.hangars || {})[`${k}|planet`];
      const baza = {};
      if (hp && Array.isArray(hp.ships)) for (const x of hp.ships) baza[String(x.type).toUpperCase()] = (baza[String(x.type).toUpperCase()] || 0) + (x.qty || 0);
      s.moonGone = s.moonGone || {};
      const stary = s.moonGone[k];
      s.moonGone[k] = stary && stary.baseline ? {
        ...stary,
        lostAt: at,
        backAt: 0
      } : {
        lostAt: at,
        baseline: hp && Array.isArray(hp.ships) ? baza : null,
        baselineAt: hp ? hp.at || 0 : 0
      };
      if (n) log(`[KSIĘŻYC] [${k}] ${n} fal(e) wysłanych ze zniszczonego księżyca wyląduje na PLANECIE — pilnuję ich lądowań tam.`, "warn");
    },
    async refresh() {
      const s = this.load();
      const now = Date.now();
      s.moonLost = s.moonLost || {};
      const livePairs = PlanetBar.pairs();
      for (const p0 of livePairs) {
        const p = p0.hasMoon && s.moonLost[p0.key] && PAGE_AT < s.moonLost[p0.key] ? {
          ...p0,
          hasMoon: false
        } : p0;
        const had = s.pairs[p.key] && s.pairs[p.key].hasMoon;
        if (had && !p.hasMoon && !s.moonLost[p.key]) {
          s.moonLost[p.key] = now;
          Situation.moonGone(s, p.key, now);
          Journal.add("BŁĄD", `KSIĘŻYC ZNISZCZONY: [${p.key}] ${p.name || ""} — flota wracająca na tę parę wyląduje na gołej planecie (widoczna dla falangi). Ewakuuję automatycznie.`);
        } else if (!had && p.hasMoon && s.moonLost[p.key]) {
          delete s.moonLost[p.key];
          if (s.moonGone && s.moonGone[p.key]) s.moonGone[p.key].backAt = now;
          log(`[KSIĘŻYC] [${p.key}] ${p.name || ""} znów ma księżyc — kończę tryb awaryjny (ewakuacja z gołej planety); fale wysłane ze zniszczonego księżyca lądują na planecie i zwożę je na nowy księżyc razem z surowcami.`, "success");
        }
        s.pairs[p.key] = {
          hasMoon: p.hasMoon,
          name: p.name,
          galaxy: p.galaxy,
          system: p.system,
          position: p.position
        };
      }
      const active = PlanetBar.active();
      if (active) s.active = active;
      const own = PlanetBar.ownKeys();
      const bar = Bar.read();
      if (bar && (!s.bar || PAGE_AT >= (s.bar.at || 0))) s.bar = {
        ...bar,
        at: PAGE_AT,
        readAt: now
      };
      s.fsReturnAt = fsReturnAt(CFG.fs, new Date(now));
      s.fsRestUntil = fsRestUntil(CFG.fs, new Date(now));
      Rows.ensureOpen();
      const evRows = Rows.readEvents(own);
      s.listUntrusted = false;
      {
        const d = Store.get("planet_drift", null);
        if (d && d.uuid && now - (d.at || 0) < 30 * 6e4) {
          if (now - (d.retryAt || 0) < 6e4) s.listUntrusted = true; else if (await Hangar.restoreActive(d.uuid)) {
            Store.del("planet_drift");
            log(`[REKONESANS] przywróciłem planetę operatora [${d.key || "?"}] — lista ruchów znów pokazuje właściwą parę.`, "success");
          } else {
            Store.set("planet_drift", {
              ...d,
              retryAt: now
            });
            s.listUntrusted = true;
          }
        } else if (d) Store.del("planet_drift");
      }
      const skipList = Session.lostRecently() && !Session.retryDue();
      const list = skipList ? {
        ok: false,
        rows: [],
        skipped: true
      } : await Rows.fetchList(own);
      if (CFG.barFromList && list.bar && list.bar.counter) s.bar = {
        ...list.bar,
        at: now,
        readAt: now,
        src: "lista"
      };
      if (list.ok) s.listOkAt = now;
      if (list.ok) {
        const ak = s.active && s.active.key || null;
        s.listSeen = {
          key: ak,
          foreign: list.rows.filter(r => !r.mine).length,
          proven: !!ak && list.rows.some(r => r.mine && (r.src === ak || r.dst === ak)),
          at: now
        };
      } else if (!s.listOkAt) s.listOkAt = Store.get("list_ok_at", 0) || now;
      if (!list.ok && !list.skipped && !Session.lostRecently() && now - (s.listOkAt || 0) > 12e4 && !Once.said("list_blind", 15 * 6e4)) Journal.add("BŁĄD", `Lista ruchów flot nie odpowiada od ${Math.round((now - (s.listOkAt || 0)) / 6e4)} min — ataki widzę już tylko po liczniku na pasku misji (60 s zwłoki, bez celu). Sprawdź grę.`);
      Session.maybeRecover();
      const rows = [ ...evRows.map(r => ({
        ...r,
        source: "events"
      })), ...list.rows.map(r => ({
        ...r,
        source: "list"
      })) ];
      const sim = Store.get("sim", null);
      if (sim && sim.until > now) rows.push({
        id: "sim",
        type: "ATTACK",
        src: "9:999:9",
        dst: sim.key,
        dstBody: sim.body,
        eta: Math.max(5, Math.round((sim.arriveAt - now) / 1e3)),
        attack: true,
        spy: false,
        mine: false,
        hostile: true,
        source: "sim",
        html: "(wiersz z symulacji panelu — TEST, nie prawdziwy atak)"
      }); else if (sim) {
        Store.del("sim");
        log("[TEST] symulacja zakończona.", "info");
      }
      const seen = new Map;
      for (const t of s.threats) if ((t.arriveAt || 0) + 6e4 > now) seen.set(t.id || `${t.dst}|${t.attack ? "A" : "S"}|${Math.round((t.arriveAt || 0) / 2e4)}`, t);
      for (const r of rows) {
        if (r.mine || r.friendly || r.isReturn) continue;
        if ((r.attack || r.spy) && (!r.dst || !own.has(r.dst))) {
          if (r.attack && !Once.said(`badrow|${r.id || r.html.slice(0, 40)}`, 10 * 6e4)) {
            log(`[ATAK DOM] wrogi wiersz, którego CELU nie rozpoznałem (dst=${r.dst || "brak"}): ${r.html}`, "error");
            Journal.add("BŁĄD", `Wrogi wiersz bez rozpoznanego celu (${r.type}) — sprawdź grę i wyślij log.`);
          }
          continue;
        }
        if (!r.attack && !r.spy) continue;
        let etaSec = r.eta || 0;
        if (r.attack && etaSec <= 0) {
          etaSec = Math.max(60, (CFG.tooLateSec || 40) + 30);
          if (!Once.said(`noeta|${r.id || String(r.html).slice(0, 40)}`, 10 * 6e4)) {
            log(`[ATAK DOM] wrogi wiersz BEZ czytelnego odliczania (${r.type}) — traktuję jak uderzenie za ${etaSec}s, żeby nie zniknął z obrony. Zrzut: ${r.html}`, "error");
            Journal.add("ATAK", `Wrogi wiersz bez czytelnego czasu dolotu (${r.type} → [${r.dst || "?"}]) — ratuję tak, jakby uderzenie było tuż-tuż. Sprawdź grę.`);
          }
        } else if (r.spy && etaSec <= 0) {
          etaSec = 60;
          if (!Once.said(`noetaspy|${r.dst || "?"}`, 30 * 6e4)) log(`[LOTY] wiersz sondy (${r.type} → [${r.dst || "?"}]) bez czytelnego odliczania — liczę go jako rozpoznany lot, żeby nie udawał nadwyżki na pasku.`, "info");
        }
        const arriveAt = (r.readAt || now) + etaSec * 1e3;
        const k = r.id || `${r.dst}|${r.attack ? "A" : "S"}|${Math.round(arriveAt / 2e4)}`;
        const prev = seen.get(k);
        seen.set(k, {
          id: r.id || null,
          dst: r.dst,
          dstBody: r.dstBody || prev?.dstBody || null,
          arriveAt: arriveAt,
          attack: !!r.attack,
          spy: !!r.spy,
          src: r.src || prev?.src || null,
          srcBody: r.srcBody,
          type: r.type,
          seenAt: prev?.seenAt || now,
          lastSeenAt: now,
          source: r.source,
          html: r.html
        });
        if (!prev && r.attack) log(`[ATAK DOM] wrogi wiersz (${r.type}, ${r.source}): ${r.html}`, r.source === "sim" ? "warn" : "error");
      }
      s.threats = [ ...seen.values() ];
      try {
        Impact.note(rows);
      } catch {}
      if (CFG.barExcess && now - (s.bar && s.bar.at || 0) > (CFG.barKeepFreshMs || 1e5) && !Once.said("bar_keep", 45e3)) {
        const kb = await Bar.fetchFresh();
        if (kb) {
          const tk = Date.now();
          s.bar = {
            ...kb,
            at: tk,
            readAt: tk,
            src: "fetch"
          };
          if (!Once.said("bar_keep_log", 30 * 6e4)) log(`[OBRONA] pasek misji odświeżony w tle (fetch /home, bez przeładowania strony): ${kb.foreign} obcych lotów — ślepy alarm nie gaśnie, gdy bot stoi bezczynnie.`, "info");
          for (const p of kb.pary || []) {
            const had = s.pairs[p.key] && s.pairs[p.key].hasMoon;
            if (had && !p.hasMoon && !s.moonLost[p.key]) {
              s.moonLost[p.key] = tk;
              Situation.moonGone(s, p.key, tk);
              s.pairs[p.key] = {
                ...s.pairs[p.key],
                hasMoon: false
              };
              log(`[KSIĘŻYC] [${p.key}] stracił księżyc — zobaczyłem to w tle, bez przeładowania strony.`, "warn");
              Journal.add("BŁĄD", `KSIĘŻYC ZNISZCZONY: [${p.key}] — flota wracająca na tę parę wyląduje na gołej planecie (widoczna dla falangi). Ewakuuję automatycznie.`);
            }
          }
        }
      }
      s.barExcess = barExcessState(s.bar, s.threats, Store.get("bar_excess", null), now, CFG);
      if (s.barExcess.needFresh && !Once.said("bar_fresh", 2e4)) {
        const fb = await Bar.fetchFresh();
        if (fb) {
          const t2 = Date.now();
          s.bar = {
            ...fb,
            at: t2,
            readAt: t2,
            src: "fetch"
          };
          s.barExcess = barExcessState(s.bar, s.threats, Store.get("bar_excess", null), t2, CFG);
          const werdykt = s.barExcess.count > 0 ? s.barExcess.active ? "nadwyżka POTWIERDZONA — ratuję w ciemno" : "nadwyżka wciąż niepotwierdzona" : "nadwyżka zniknęła (obce loty doleciały i odleciały — np. rój sond)";
          log(`[OBRONA] nadwyżka na pasku po progu — świeży pasek z /home: ${fb.foreign} obcych → ${werdykt}.`, s.barExcess.active ? "error" : "info");
        } else if (!Once.said("bar_fresh_fail", 5 * 6e4)) {
          log(`[OBRONA] nadwyżka na pasku po progu, a świeżego paska z /home nie dostałem — po ${Math.round((CFG.barConfirmGraceMs ?? 6e4) / 1e3)} s zadziałam na starym odczycie (sieć nie wyłącza obrony).`, "warn");
        }
      }
      Store.set("bar_excess", s.barExcess);
      {
        const barFresh = s.bar && now - (s.bar.at || 0) < 9e4;
        const clear = !!(barFresh && typeof s.bar.total === "number" && (s.bar.foreign || 0) === 0);
        s.hostileClear = clear ? s.hostileClear && s.hostileClear.since ? s.hostileClear : {
          since: now
        } : null;
        if (s.hostileClear && now - s.hostileClear.since >= 6e4) {
          const before = (s.threats || []).length;
          const zdjete = (s.threats || []).filter(t => !(t.source === "sim" || now - (t.lastSeenAt || 0) < 3e4 || (s.bar.at || 0) <= (t.seenAt || 0)));
          s.threats = (s.threats || []).filter(t => t.source === "sim" || now - (t.lastSeenAt || 0) < 3e4 || (s.bar.at || 0) <= (t.seenAt || 0));
          if (s.threats.length < before) {
            log(`[OBRONA] pasek misji czysty od ≥60 s — napastnik ZAWRÓCIŁ (${before - s.threats.length} zagrożeń zdjętych przed terminem dolotu). Ucieczka może wracać.`, "success");
            try {
              Impact.oznaczOdwolane(zdjete.map(t => t.id).filter(Boolean), now);
            } catch {}
          }
        }
      }
      s.own = rows.filter(r => r.mine).map(r => ({
        id: r.id,
        src: r.src,
        srcBody: r.srcBody,
        dst: r.dst,
        dstBody: r.dstBody,
        eta: r.eta,
        arriveAt: now + (r.eta || 0) * 1e3,
        isReturn: r.isReturn,
        type: r.type,
        seenAt: now
      }));
      {
        const ex = rows.find(r => r.mine && !r.isReturn && /EXPEDITION/i.test(r.type));
        if (ex && !Once.said("ownrow_dom", 6 * 36e5)) log(`[LOT DOM] wiersz WŁASNEJ ekspedycji z listy ruchów (do liczenia statków po wysyłce): ${ex.html}`, "info");
      }
      {
        const land = {
          ...this.load().landings || {}
        };
        for (const o of s.own) {
          if (!o.isReturn || !(o.src || o.dst)) continue;
          const lkKey = o.src || o.dst;
          const fl = (s.flights || []).find(f => f.fromKey === lkKey && f.phase !== "done" && o.dst && f.toKey === o.dst) || (s.flights || []).find(f => f.fromKey === lkKey && f.phase !== "done");
          const rawBody2 = fl && fl.fromBody || (o.src ? o.srcBody : o.dstBody) || "planet";
          const body = rawBody2 === "moon" && !(s.pairs[lkKey] && s.pairs[lkKey].hasMoon) ? "planet" : rawBody2;
          const lk = `${lkKey}|${body}`;
          if (!land[lk] || o.arriveAt > land[lk]) land[lk] = o.arriveAt;
        }
        for (const [lk, at] of Object.entries(land)) if (now - at > 60 * 6e4) delete land[lk];
        s.landings = land;
      }
      {
        const cur = this.load();
        for (const [hk, hv] of Object.entries(cur.hangars || {})) {
          const mine = s.hangars[hk];
          if (!mine || (hv.at || 0) > (mine.at || 0)) s.hangars[hk] = hv;
        }
        if (cur.slots && (!s.slots || (cur.slots.at || 0) > (s.slots.at || 0))) s.slots = cur.slots;
        for (const f of cur.flights || []) if (!(s.flights || []).some(x => x.fromKey === f.fromKey && x.sentAt === f.sentAt)) (s.flights = s.flights || []).push(f);
        for (const e of cur.expected || []) if (!(s.expected || []).some(x => x.fromKey === e.fromKey && x.sentAt === e.sentAt)) (s.expected = s.expected || []).push(e);
      }
      for (const hk of Object.keys(s.hangars || {})) {
        const i = hk.indexOf("|");
        if (i < 0 || hk.slice(i + 1) !== "moon") continue;
        const hkey = hk.slice(0, i);
        if (!s.pairs[hkey] || s.pairs[hkey].hasMoon !== false) continue;
        const h = s.hangars[hk] || {};
        delete s.hangars[hk];
        log(`[KSIĘŻYC] [${hkey}] nie ma księżyca, a w stanie leżał jego hangar sprzed ${Math.round((now - (h.at || 0)) / 6e4)} min (${(h.total || 0).toLocaleString("pl-PL")} szt.) — kasuję. Bot nie będzie udawał, że flota stoi na nieistniejącym ciele.`, "warn");
      }
      if (s.fsMeasured) {
        for (const rk of Object.keys(s.fsMeasured)) if (now - ((s.fsMeasured[rk] || {}).at || 0) > 24 * 36e5) delete s.fsMeasured[rk];
      }
      s.pairGone = s.pairGone || {};
      if (livePairs.length) {
        const liveKeys = new Set(livePairs.map(p => p.key));
        for (const k of Object.keys(s.pairs)) {
          if (liveKeys.has(k)) {
            delete s.pairGone[k];
            continue;
          }
          if (!s.pairGone[k]) {
            s.pairGone[k] = now;
            continue;
          }
          if (now - s.pairGone[k] < 6e4) continue;
          const hm = s.hangars[`${k}|moon`], hpl = s.hangars[`${k}|planet`];
          const szt = (hm && hm.total || 0) + (hpl && hpl.total || 0);
          delete s.pairs[k];
          delete s.pairGone[k];
          delete s.hangars[`${k}|moon`];
          delete s.hangars[`${k}|planet`];
          if (s.moonLost) delete s.moonLost[k];
          if (s.rescues) delete s.rescues[k];
          if (s.landings) {
            delete s.landings[`${k}|moon`];
            delete s.landings[`${k}|planet`];
          }
          if (s.fsMeasured) for (const rk of Object.keys(s.fsMeasured)) if (rk.startsWith(`${k}>`) || rk.endsWith(`>${k}`)) delete s.fsMeasured[rk];
          log(`[PASEK] para [${k}] zniknęła z paska planet (przenosiny albo porzucona kolonia) — kasuję ją ze stanu razem z hangarem (${szt.toLocaleString("pl-PL")} szt.). Jeśli to przenosiny, flota stoi teraz pod nowymi koordami i rekonesans ją odczyta; sprawdź stały cel FS, start ekspedycji i listę księżyców do odbudowy.`, "warn");
          if (szt > 0) Journal.add("STAN", `Para [${k}] zniknęła z paska planet — zapomniałem jej hangar (${szt.toLocaleString("pl-PL")} szt.). Sprawdź stały cel FS i start ekspedycji.`);
        }
      }
      {
        const exp = (s.expected || []).filter(e => !(e.pending && now - (e.sentAt || 0) > 10 * 6e4) && now - (e.returnAt || 0) < 60 * 6e4);
        for (const o of s.own) {
          if (!o.isReturn) continue;
          const lkKey = o.src || o.dst;
          if (!lkKey) continue;
          let best = null;
          for (const e of exp) if (e.fromKey === lkKey && !e.pending && Math.abs(e.returnAt - o.arriveAt) < 3 * 6e4 && (!best || Math.abs(e.returnAt - o.arriveAt) < Math.abs(best.returnAt - o.arriveAt))) best = e;
          if (best) best.returnAt = o.arriveAt;
        }
        s.expected = exp;
      }
      for (const k of Object.keys(s.moonGone || {})) {
        const mg = s.moonGone[k];
        const sieroty = (s.expected || []).filter(e => e.fromKey === k && e.orphan);
        const hpG = (s.hangars || {})[`${k}|planet`];
        if (!mg.baseline && hpG && Array.isArray(hpG.ships) && !sieroty.some(e => (e.returnAt || 0) <= (hpG.at || 0))) {
          mg.baseline = {};
          for (const x of hpG.ships) mg.baseline[String(x.type).toUpperCase()] = (mg.baseline[String(x.type).toUpperCase()] || 0) + (x.qty || 0);
          mg.baselineAt = hpG.at || 0;
        }
        const ostatnia = Math.max(0, ...sieroty.map(e => e.returnAt || 0));
        void ostatnia;
        if (now - (mg.lostAt || 0) > 24 * 36e5) delete s.moonGone[k];
      }
      {
        const cur2 = this.load();
        if (cur2.expoHome) s.expoHome = cur2.expoHome;
        const el = {
          ...cur2.expoLandings || {}
        };
        for (const o of s.own) {
          if (o.isReturn || !/EXPEDITION/i.test(o.type || "") || !(o.src || o.dst) || !o.eta) continue;
          const k = o.src || o.dst;
          const regs = (s.expected || []).filter(e => e.fromKey === k && e.kind === "expedition");
          const earliest = regs.length ? Math.min(...regs.map(e => e.returnAt || 0)) : 0;
          if (earliest && o.arriveAt < earliest - 3 * 6e4) continue;
          const rawBody = (regs.length ? regs[regs.length - 1].fromBody : null) || (s.expoHome && s.expoHome.key === k ? s.expoHome.body : null) || o.srcBody || "planet";
          const body = rawBody === "moon" && !(s.pairs[k] && s.pairs[k].hasMoon) ? "planet" : rawBody;
          const lk = `${k}|${body}`;
          const list = el[lk] || [];
          if (!list.some(t => Math.abs(t - o.arriveAt) < 2e4)) list.push(o.arriveAt);
          el[lk] = list;
        }
        for (const lk of Object.keys(el)) {
          el[lk] = el[lk].filter(t => now - t < 60 * 6e4).sort((a, b) => a - b).slice(-20);
          if (!el[lk].length) delete el[lk];
        }
        s.expoLandings = el;
      }
      if (!Store.get("migr_ghost_v3971", false)) {
        Store.set("migr_ghost_v3971", true);
        const duchy = (s.flights || []).filter(f => f.phase === "launched" && !f.sentTotal && f.recallAt && (() => {
          const h = (s.hangars || {})[`${f.fromKey}|${f.fromBody}`];
          return !!h && (h.total || 0) > (f.leftHome || 0) && (h.at || 0) > f.sentAt + 15 * 6e4;
        })());
        for (const f of duchy) {
          f.phase = "done";
          log(`[LOT] sprzątam wpis-ducha [${f.fromKey}]→[${f.toKey}] sprzed v3.97.1: flota stoi w hangarze źródła, a wpis wisiał jako „w powietrzu” i blokował ekonomię. Jednorazowo, przy aktualizacji.`, "warn");
        }
      }
      s.flights = (s.flights || []).filter(f => flightAlive(f, s, now));
      return this.save(s);
    },
    fleetAt(s, k, now = Date.now()) {
      const noMoon = !!(s.pairs && s.pairs[k] && s.pairs[k].hasMoon === false);
      const m = noMoon ? null : s.hangars[`${k}|moon`], p = s.hangars[`${k}|planet`];
      const fresh = h => h && now - h.at < 48 * 36e5 && h.total > 0;
      if (fresh(m) && (!fresh(p) || m.at >= p.at || m.total >= p.total)) return {
        body: "moon",
        total: m.total,
        at: m.at
      };
      if (fresh(p)) return {
        body: "planet",
        total: p.total,
        at: p.at
      };
      return null;
    }
  };
  function nightWindow(fs, d) {
    if (!fs || !fs.enabled) return {
      active: false,
      endsAt: 0
    };
    const h = d.getHours(), m = d.getMinutes();
    const start = fs.startHour, end = fs.endHour;
    const inWin = start === end ? false : start < end ? h >= start && h < end : h >= start || h < end;
    const endD = new Date(d);
    endD.setMinutes(0, 0, 0);
    endD.setHours(end);
    if (endD.getTime() <= d.getTime()) endD.setDate(endD.getDate() + 1);
    return {
      active: inWin,
      endsAt: endD.getTime(),
      startHour: start,
      endHour: end,
      nowHM: `${h}:${String(m).padStart(2, "0")}`
    };
  }
  function fsReturnAt(fs, d) {
    if (!fs || !fs.enabled) return 0;
    const num = (v, dflt, max) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.trunc(n))) : dflt;
    };
    const target = new Date(d);
    target.setHours(num(fs.returnHour, 7, 23), num(fs.returnMinute, 0, 59), 0, 0);
    if (target.getTime() <= d.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  function fsRestUntil(fs, d) {
    if (!fs || !fs.enabled) return 0;
    const num = (v, dflt, max) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.trunc(n))) : dflt;
    };
    const godzin = num(fs.restHours, 0, 23);
    if (!godzin) return 0;
    const ostatni = new Date(d);
    ostatni.setHours(num(fs.returnHour, 7, 23), num(fs.returnMinute, 0, 59), 0, 0);
    if (ostatni.getTime() > d.getTime()) ostatni.setDate(ostatni.getDate() - 1);
    return ostatni.getTime() + godzin * 36e5;
  }
  function flightStale(f, now) {
    if (!f) return true;
    if (f.phase === "recall_failed") return true;
    if (f.pending && now - f.sentAt > 10 * 6e4) return true;
    if (f.recallAt && now > f.recallAt + 60 * 6e4) return true;
    return false;
  }
  const flightsBlocking = (s, now) => (s.flights || []).some(f => f.phase !== "done" && !flightStale(f, now));
  function flightAlive(f, s, now) {
    if (f.pending && now - f.sentAt < 10 * 6e4) return true;
    if (f.pending) {
      log(`[LOT] wpis "${f.kind}" [${f.fromKey}]→[${f.toKey}] wisi 10 min bez potwierdzenia — zdejmuję, para wraca pod pełną obronę.`, "warn");
      return false;
    }
    const watchKey = f.recallAt ? `${f.fromKey}|${f.fromBody}` : `${f.toKey}|${f.toBody}`;
    const h = (s.hangars || {})[watchKey];
    const leftHome = f.recallAt ? f.leftHome || 0 : 0;
    if (h && (h.total || 0) > leftHome && h.at > f.sentAt + 6e4) {
      const stillOut = !!f.recallAt && f.phase === "launched";
      if (!stillOut) {
        if (f.phase === "recall_clicked") log(`[LOT] domykam wpis [${f.fromKey}]→[${f.toKey}] hangarem, choć zawrót NIEPOTWIERDZONY wierszem powrotnym — jeśli to nie ta flota wróciła, sprawdź listę ruchów.`, "warn");
        log(`[LOT] domknięty — flota widziana na [${watchKey.replace("|", " ")}] (${(h.total || 0).toLocaleString("pl-PL")}).`, "success");
        return false;
      }
      if ((f.sentTotal || 0) > 0 && (h.total || 0) >= (f.sentTotal || 0) + leftHome) {
        log(`[LOT] domykam wpis [${f.fromKey}]→[${f.toKey}] (${f.phase}): w hangarze [${watchKey.replace("|", " ")}] stoi ${(h.total || 0).toLocaleString("pl-PL")} szt., czyli CAŁA wysłana flota (${(f.sentTotal || 0).toLocaleString("pl-PL")}) wróciła — flota jest w domu (zawrót ręczny albo brama skoków). Para wraca pod pełną obronę, ekonomia rusza.`, "warn");
        return false;
      }
      if (!Once.said(`expclose|${f.fromKey}|${f.sentAt}`, 10 * 6e4)) log(`[LOT] hangar [${watchKey.replace("|", " ")}] pełny, a lot [${f.fromKey}]→[${f.toKey}] jest W POWIETRZU (${f.phase}) — to powroty/lądowania, nie ratunek; wpis ZOSTAJE (zawrót planowo).`, "info");
    }
    if (!f.recallAt && now - f.sentAt > 30 * 6e4) {
      log(`[LOT] ${f.kind} [${f.fromKey}]→[${f.toKey}] przeterminowany (30 min) — zdejmuję wpis (obrona działała przez cały ten czas: od v3.75.0 każda flota pod uderzeniem dostaje własny lot; wpis blokował tylko ekonomię).`, "warn");
      return false;
    }
    if (now - f.sentAt > 12 * 36e5) return false;
    return true;
  }
  function barExcessState(bar, threats, prev, now, cfg) {
    if (!cfg.barExcess || !bar) return {
      active: false,
      count: 0,
      since: 0
    };
    if (now - (bar.at || 0) > (cfg.barMaxAgeMs || 3 * 6e4)) return {
      active: false,
      count: 0,
      since: 0,
      stale: true
    };
    const live = (threats || []).filter(t => t.arriveAt > now);
    const excess = Math.max(0, (bar.foreign || 0) - live.length);
    if (excess <= 0) return {
      active: false,
      count: 0,
      since: 0
    };
    const since = prev && prev.count > 0 && prev.since ? prev.since : bar.at || now;
    const spyHold = !!bar.spyType && !bar.attackType && excess <= (cfg.barSpyMaxExcess ?? 1);
    const hold = spyHold ? cfg.barSpyHoldMs || 5 * 6e4 : cfg.barHoldMs || 6e4;
    const seenFor = (bar.at || now) - since;
    const confirmed = seenFor >= hold;
    const overdue = now - since >= hold + (cfg.barConfirmGraceMs ?? 6e4);
    const needFresh = !confirmed && now - since >= hold;
    return {
      active: confirmed || overdue,
      confirmed: confirmed,
      count: excess,
      since: since,
      seenAt: bar.at || now,
      spyType: !!bar.spyType,
      spyHold: spyHold,
      needFresh: needFresh,
      waitMs: Math.max(0, hold - (now - since))
    };
  }
  const PLANET_CARGO = [ "HEAVY_CARGO", "LIGHT_CARGO" ];
  function zwozKeep(mg) {
    if (!mg || !mg.baseline) return null;
    const out = {};
    for (const t of PLANET_CARGO) if ((mg.baseline[t] || 0) > 0) out[t] = mg.baseline[t];
    return Object.keys(out).length ? out : null;
  }
  function zwozPlan(hp, mg) {
    const out = [];
    for (const x of hp && hp.ships || []) {
      const t = String(x.type).toUpperCase();
      const q = (x.qty || 0) - (mg && mg.baseline && PLANET_CARGO.includes(t) ? mg.baseline[t] || 0 : 0);
      if (q > 0) out.push({
        type: x.type,
        qty: q
      });
    }
    return out;
  }
  function decide(s, cfg, now) {
    const actions = [], alerts = [];
    const guardRecon = [];
    const pairs = s.pairs || {};
    const CAP_RATUNKU = {
      DEATH_STAR: 1
    };
    const threatsFor = k => (s.threats || []).filter(t => t.dst === k && t.attack && t.arriveAt > now);
    const attackedBodies = k => {
      const b = new Set;
      for (const t of threatsFor(k)) b.add(t.dstBody || "unknown");
      return b;
    };
    const anyAttack = (s.threats || []).some(t => t.attack && t.arriveAt > now);
    const flightBlind = f => flightStale(f, now);
    const inFlightFrom = k => (s.flights || []).find(f => f.fromKey === k && f.phase !== "done" && !flightBlind(f));
    const extended = new Set;
    const extendAll = (k, th) => {
      if (!th || !th.length) return [];
      const lastArrive = Math.max(...th.map(t => t.arriveAt));
      const recallAt = lastArrive + cfg.recallBufferSec * 1e3;
      const out = [];
      for (const x of s.flights || []) {
        if (x.fromKey !== k || x.kind !== "air" || x.phase !== "launched" || !x.recallAt || flightBlind(x)) continue;
        if (recallAt <= x.recallAt) continue;
        const idx = x.id || `${x.fromKey}>${x.toKey}|${x.fromBody || ""}|${x.sentAt || 0}`;
        if (extended.has(idx)) continue;
        extended.add(idx);
        out.push({
          kind: "extend",
          flight: x,
          recallAt: recallAt,
          why: "dosłana fala"
        });
      }
      return out;
    };
    const fleetsAt = k => [ "moon", "planet" ].map(b => ({
      body: b,
      h: b === "moon" && pairs[k] && pairs[k].hasMoon === false ? null : (s.hangars || {})[`${k}|${b}`]
    })).filter(x => x.h && (x.h.total || 0) > 0 && now - (x.h.at || 0) < 48 * 36e5).map(x => ({
      body: x.body,
      total: x.h.total,
      at: x.h.at,
      ships: x.h.ships || []
    }));
    const neighbourMoon = k => {
      const c = pairs[k];
      if (!c) return null;
      for (const [ok, o] of Object.entries(pairs)) {
        if (ok !== k && o.hasMoon && o.galaxy === c.galaxy && o.system === c.system && attackedBodies(ok).size === 0) return ok;
      }
      return null;
    };
    const dist = (a, b) => Math.abs(a.galaxy - b.galaxy) * 1e6 + Math.abs(a.system - b.system) * 1e3 + Math.abs((a.position || 0) - (b.position || 0));
    const anyRefuge = (k, exclude) => {
      const c = pairs[k];
      if (!c) return null;
      let best = null, bestD = Infinity;
      for (const [ok, o] of Object.entries(pairs)) {
        if (ok === k || ok === exclude || attackedBodies(ok).size !== 0) continue;
        const d = dist(c, o);
        if (d < bestD) {
          bestD = d;
          best = {
            key: ok,
            body: o.hasMoon ? "moon" : "planet"
          };
        }
      }
      return best;
    };
    const returnsFrom = k => (s.expected || []).filter(e => e.fromKey === k && !e.pending);
    const liveFromBody = (k, raw) => raw === "moon" && !(pairs[k] && pairs[k].hasMoon) ? "planet" : raw;
    const landedSince = (k, body, at) => returnsFrom(k).some(e => liveFromBody(k, e.fromBody) === body && e.returnAt <= now && e.returnAt > (at || 0)) || ((s.landings || {})[`${k}|${body}`] || 0) <= now && ((s.landings || {})[`${k}|${body}`] || 0) > (at || 0) || ((s.expoLandings || {})[`${k}|${body}`] || []).some(t => t <= now && t > (at || 0));
    const incomingBefore = (k, when) => returnsFrom(k).filter(e => e.returnAt > now && e.returnAt < when).sort((a, b) => a.returnAt - b.returnAt);
    const hhmmss = t => new Date(t).toLocaleTimeString("pl-PL", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const hhmm = t => new Date(t).toLocaleTimeString("pl-PL", {
      hour: "2-digit",
      minute: "2-digit"
    });
    const fsCands = [];
    const fsNaPlanecie = [];
    for (const k of Object.keys(pairs)) {
      const th = threatsFor(k);
      const all = fleetsAt(k);
      let fleet = Situation.fleetAt(s, k, now);
      const bodies = attackedBodies(k);
      const bodiesReal = bodies.has("unknown") ? [ "moon", "planet" ].filter(b => b === "planet" || pairs[k] && pairs[k].hasMoon) : [ ...bodies ];
      const hangarPewny = b => {
        const h = (s.hangars || {})[`${k}|${b}`];
        if (!h || !h.at) return true;
        if (landedSince(k, b, h.at)) return false;
        if ((h.total || 0) > 0 && now - h.at > (cfg.hangarTrustMs || 10 * 6e4)) return false;
        return true;
      };
      const hangarNiepewny = bodiesReal.some(b => !hangarPewny(b));
      if (th.some(t => t.attack && t.arriveAt > now && t.arriveAt - now <= (cfg.attackGuardWindowMs || 30 * 6e4))) {
        const maxAge = cfg.attackHangarMaxAgeMs || 45e3;
        for (const b of bodiesReal) {
          const h = (s.hangars || {})[`${k}|${b}`];
          if (!h || !h.at) continue;
          const wiek = now - h.at;
          if (wiek > maxAge) guardRecon.push({
            kind: "recon",
            key: k,
            body: b,
            quiet: true,
            alarm: true,
            guard: true,
            why: `ATAK na [${k}] — hangar ${b === "moon" ? "księżyca" : "planety"} sprzed ${Math.round(wiek / 1e3)} s, sprawdzam w tle (pod ostrzałem nie ufam pamięci)`
          });
        }
      }
      if (!th.length) {
        const wszystkieLoty = (s.flights || []).filter(x => x.fromKey === k && x.kind === "air" && [ "launched", "recall_clicked" ].includes(x.phase));
        const f = inFlightFrom(k) || wszystkieLoty[0];
        for (const lot of wszystkieLoty) {
          const kolejny = lot !== f ? " (kolejny lot tej pary)" : "";
          if (lot.phase === "launched" && lot.recallAt && now >= lot.recallAt) actions.push({
            kind: "recall",
            flight: lot,
            why: "ataki minęły — zawrót ucieczki" + kolejny
          }); else if (lot.phase === "launched" && !lot.fs && lot.recallAt && s.hostileClear && now - (s.hostileClear.since || now) >= 6e4) actions.push({
            kind: "recall",
            flight: lot,
            why: "napastnik zawrócił (pasek czysty ≥60 s) — wcześniejszy zawrót ucieczki" + kolejny
          }); else if (lot.phase === "recall_clicked" && now - (lot.recalledAt || 0) > 2 * 6e4) actions.push({
            kind: "recall",
            flight: lot,
            why: "zawrót bez potwierdzenia — ponawiam" + kolejny
          });
        }
        const landMap = {
          ...s.landings || {}
        };
        for (const e of returnsFrom(k)) if (e.returnAt <= now && now - e.returnAt < 30 * 6e4) {
          const lk = `${k}|${liveFromBody(k, e.fromBody)}`;
          if (!landMap[lk] || e.returnAt > landMap[lk]) landMap[lk] = e.returnAt;
        }
        const landCands = Object.entries(landMap);
        for (const [lk, list] of Object.entries(s.expoLandings || {})) {
          if (!lk.startsWith(k + "|")) continue;
          const past = (list || []).filter(t => t <= now && now - t < 30 * 6e4).pop();
          if (past) landCands.push([ lk, past ]);
        }
        for (const lot of s.flights || []) {
          if (!lot || lot.recallAt || lot.phase === "done" || !(lot.flightMs > 0)) continue;
          if (lot.toKey !== k) continue;
          const wyladowal = (lot.sentAt || 0) + lot.flightMs;
          if (wyladowal <= now) landCands.push([ `${lot.toKey}|${lot.toBody}`, wyladowal ]);
        }
        for (const [lk, at] of landCands) {
          const [lkey, lbody] = lk.split("|");
          if (lkey !== k || at > now || now - at > 30 * 6e4) continue;
          const lh = (s.hangars || {})[lk];
          if (lh && (lh.at || 0) >= at) continue;
          const lf58 = cfg.expo && cfg.expo.launchFrom;
          const guarded58 = lf58 ? `${lf58.galaxy}:${lf58.system}:${lf58.position}` : null;
          if (cfg.stealth && cfg.stealth.enabled && !f && guarded58 && k !== guarded58) continue;
          actions.push({
            kind: "recon",
            key: k,
            body: lbody,
            quiet: true,
            lost: !!((s.moonGone || {})[k] || (s.moonLost || {})[k]),
            why: `wróciła własna flota na ${lbody === "moon" ? "księżyc" : "planetę"} [${k}] — sprawdzam hangar`
          });
          break;
        }
        const hp = (s.hangars || {})[`${k}|planet`];
        if (((s.moonGone || {})[k] || (s.moonLost || {})[k]) && (!hp || now - (hp.at || 0) > 6e4) && !actions.some(a => a.kind === "recon" && a.key === k && a.body === "planet")) actions.push({
          kind: "recon",
          key: k,
          body: "planet",
          quiet: true,
          lost: true,
          why: `tryb po utracie księżyca [${k}] — kontrolny odczyt planety (fale mogą lądować w każdej chwili)`
        });
        {
          const mg = (s.moonGone || {})[k];
          if (mg && pairs[k].hasMoon && !anyAttack && !(s.barExcess && s.barExcess.count > 0) && hp && (hp.total || 0) > 0 && now - (hp.at || 0) < 30 * 6e4 && (hp.at || 0) > (mg.lostAt || 0)) {
            const plan = zwozPlan(hp, mg);
            const lotyZ = (s.flights || []).filter(x => x.fromKey === k && x.phase !== "done" && !flightBlind(x));
            const wolny = lotyZ.every(x => x.fs && x.kind === "air" || x.kind === "home" && (hp.at || 0) > (x.sentAt || 0) + 2e4 && (hp.total || 0) > (x.leftHome || 0));
            if (plan.length && wolny) {
              const ile = plan.reduce((a, x) => a + x.qty, 0);
              const keepZ = zwozKeep(mg);
              actions.push({
                kind: "fly",
                fromKey: k,
                fromBody: "planet",
                toKey: k,
                toBody: "moon",
                speed: 100,
                recall: false,
                home: true,
                ...keepZ ? {
                  keepQty: keepZ
                } : {},
                why: `księżyc [${k}] odbudowany — fala ze zniszczonego księżyca wylądowała na planecie (${ile.toLocaleString("pl-PL")} szt.${mg.baseline ? "" : ", stan planety sprzed straty nieznany — biorę cały hangar"}), zwożę ją na nowy księżyc z surowcami`
              });
              continue;
            }
          }
        }
        const rs = (s.rescues || {})[k];
        const rescuedAt = rs && typeof rs === "object" ? rs.at || 0 : 0;
        const backFromRescue = rescuedAt > 0 && now - rescuedAt < 6 * 36e5;
        const backPlan = backFromRescue && !cfg.homeToMoon && rs.ships ? Object.entries(rs.ships).filter(([, q]) => q > 0).map(([type, qty]) => ({
          type: type,
          qty: qty
        })) : null;
        const backMa = !backPlan || !(hp && Array.isArray(hp.ships) && hp.ships.length) || (hp.at || 0) < (rs.landAt || rs.at || 0) || hp.ships.some(x => x.qty > 0 && backPlan.some(p => String(p.type).toUpperCase() === String(x.type).toUpperCase()));
        if (!f && !anyAttack && pairs[k].hasMoon && hp && (hp.total || 0) > 0 && now - (hp.at || 0) < 30 * 6e4 && (cfg.homeToMoon || backFromRescue && backMa)) {
          actions.push({
            kind: "fly",
            fromKey: k,
            fromBody: "planet",
            toKey: k,
            toBody: "moon",
            why: backFromRescue ? "powrót po ratunku: planeta → księżyc" : "dom = księżyc",
            speed: 100,
            recall: false,
            home: true,
            backHome: backFromRescue,
            ...backPlan && backPlan.length ? {
              plan: backPlan
            } : {}
          });
          continue;
        }
        const lotyPary = (s.flights || []).filter(x => x.fromKey === k && x.phase !== "done" && !flightBlind(x));
        const evacWolna = !lotyPary.some(x => !x.evac) && lotyPary.every(x => hp && (hp.at || 0) > (x.sentAt || 0) + 2e4 && (hp.total || 0) > (x.leftHome || 0));
        const planEv = (s.moonGone || {})[k] && (s.moonGone || {})[k].baseline ? zwozPlan(hp, s.moonGone[k]) : null;
        if ((!f || evacWolna) && !pairs[k].hasMoon && (s.moonLost || {})[k] && hp && (hp.total || 0) > 0 && now - (hp.at || 0) < 30 * 6e4 && !(planEv && !planEv.length)) {
          const nbLost = neighbourMoon(k);
          const refLost = nbLost ? {
            key: nbLost,
            body: "moon"
          } : anyRefuge(k);
          if (refLost) {
            actions.push({
              kind: "fly",
              fromKey: k,
              fromBody: "planet",
              toKey: refLost.key,
              toBody: refLost.body,
              why: `księżyc [${k}] zniszczony, flota goła na planecie (falanga) → ewakuacja do [${refLost.key}] ${refLost.body === "moon" ? "księżyc" : "planeta"}`,
              speed: 100,
              recall: false,
              rescue: true,
              evac: true,
              home: true,
              saveTotal: hp.total,
              ...planEv && zwozKeep(s.moonGone[k]) ? {
                keepQty: zwozKeep(s.moonGone[k])
              } : {}
            });
          } else {
            alerts.push({
              key: k,
              level: "error",
              throttleMs: 15 * 6e4,
              msg: `księżyc [${k}] zniszczony, flota stoi na planecie (widoczna dla falangi), a nie mam dokąd jej ewakuować — reaguj ręcznie`
            });
          }
          continue;
        }
        const fsH = fleet && fleet.body === "moon" ? s.hangars[`${k}|moon`] : null;
        const fsSamaRezerwa = !!(fsH && Array.isArray(fsH.ships) && fsH.ships.some(x => (x.qty || 0) > 0) && fsH.ships.filter(x => (x.qty || 0) > 0).every(x => CAP_RATUNKU[String(x.type).toUpperCase()] !== undefined));
        if (!f && fleet && cfg.fs && cfg.fs.enabled && fleet.total > 0 && !fsSamaRezerwa && now - (fleet.at || 0) > 60 * 6e4) {
          actions.push({
            kind: "recon",
            key: k,
            body: fleet.body,
            quiet: true,
            why: `FS: odczyt hangaru [${k}] za stary — sprawdzam, zanim wyślę flotę`
          });
          continue;
        }
        if (!f && fleet && cfg.fs && cfg.fs.enabled && fleet.total > 0 && fleet.body !== "moon") {
          fsNaPlanecie.push({
            key: k,
            total: fleet.total
          });
        }
        const lotyFsZPary = (s.flights || []).filter(x => x.fromKey === k && x.phase !== "done" && !flightStale(x, now));
        const fsDosylowy = !!(f && lotyFsZPary.length && lotyFsZPary.every(x => x.fs) && fleet && fleet.body === "moon" && fleet.total > 0 && (fleet.at || 0) > Math.max(...lotyFsZPary.map(x => x.sentAt || 0)));
        if ((!f || fsDosylowy) && fleet && cfg.fs && cfg.fs.enabled && fleet.total > 0 && fleet.body === "moon" && !fsSamaRezerwa) {
          let dest = null;
          if (cfg.fs.target) {
            const want = cfg.fs.target;
            if (want === k) alerts.push({
              key: k,
              level: "warn",
              throttleMs: 30 * 6e4,
              msg: `FS: skonfigurowany cel [${want}] to ta sama para — ustaw inny księżyc`
            }); else if (!pairs[want]) alerts.push({
              key: k,
              level: "warn",
              throttleMs: 30 * 6e4,
              msg: `FS: skonfigurowany cel [${want}] nieznany (brak na pasku planet)`
            }); else if (!pairs[want].hasMoon) alerts.push({
              key: k,
              level: "warn",
              throttleMs: 30 * 6e4,
              msg: `FS: skonfigurowany cel [${want}] nie ma księżyca`
            }); else if (attackedBodies(want).size) alerts.push({
              key: k,
              level: "warn",
              throttleMs: 30 * 6e4,
              msg: `FS: skonfigurowany cel [${want}] jest pod atakiem — czekam`
            }); else dest = {
              key: want,
              body: "moon"
            };
          } else {
            const home = pairs[k];
            let best = -1;
            let skippedNoMoon = 0;
            for (const [ok, o] of Object.entries(pairs)) {
              if (ok === k || attackedBodies(ok).size) continue;
              if (!o.hasMoon) {
                skippedNoMoon++;
                continue;
              }
              const d = Math.abs(o.galaxy - home.galaxy) * 1e3 + Math.abs(o.system - home.system);
              if (d > best) {
                best = d;
                dest = {
                  key: ok,
                  body: "moon"
                };
              }
            }
            if (!dest) alerts.push({
              key: k,
              level: "warn",
              throttleMs: 30 * 6e4,
              msg: skippedNoMoon ? `FS: żadna wolna kolonia nie ma księżyca (${skippedNoMoon} bez księżyca) — ustaw stały cel albo postaw księżyc` : `FS: brak celu (jedyna kolonia albo wszystkie atakowane)`
            });
          }
          if (dest && (s.fsRestUntil || 0) > now) {
            alerts.push({
              key: k,
              level: "warn",
              throttleMs: 60 * 6e4,
              msg: `FS: okno dnia — flota zostaje w domu do ${hhmm(s.fsRestUntil)} (tak ustawiłeś: ${cfg.fs.restHours} h po powrocie), żeby pracowała na ekspedycjach. Obrona działa normalnie.`
            });
            dest = null;
          }
          if (dest) {
            const fsSpeed = cfg.fs.speedPct || 10;
            const short = (s.fsMeasured || {})[`${k}>${dest.key}`];
            const znany = !!short && short.flightMs > 0 && (short.speedPct || 0) === fsSpeed && now - (short.at || 0) < 24 * 36e5;
            const openAt = znany ? (s.fsReturnAt || 0) - 2 * short.flightMs : 0;
            if (znany && now < openAt) {
              alerts.push({
                key: k,
                level: "warn",
                throttleMs: 60 * 6e4,
                msg: `FS: lot [${k}]→[${dest.key}] trwa ${Math.round(short.flightMs / 6e4)} min, a flota ma być w domu o ${hhmm(s.fsReturnAt || 0)} — startuję dopiero o ${hhmm(openAt)} (wcześniej doleciałaby i WYLĄDOWAŁA na obcym księżycu). Chcesz wcześniej? Zmniejsz prędkość FS albo wybierz dalszy cel.`
              });
            } else {
              fsCands.push({
                kind: "fly",
                fromKey: k,
                fromBody: fleet.body,
                toKey: dest.key,
                toBody: dest.body,
                why: `FLEET SAVE${fsDosylowy ? " DOSYŁOWY (fala wylądowała w trakcie lotu)" : ""} → [${dest.key}], w domu ~${hhmm(s.fsReturnAt || 0)}`,
                speed: fsSpeed,
                recall: true,
                air: true,
                fs: true,
                capTypes: CAP_RATUNKU,
                homeAt: s.fsReturnAt,
                recallAt: s.fsReturnAt,
                saveTotal: fleet.total
              });
            }
          }
        }
        continue;
      }
      const soonest = Math.min(...th.map(t => t.arriveAt));
      const secs = Math.round((soonest - now) / 1e3);
      const firstSeen = Math.min(...th.map(t => t.seenAt));
      const inc = incomingBefore(k, soonest);
      const incTxt = inc.length ? ` UWAGA: ${inc.length === 1 ? "własny powrót ląduje" : inc.length + " własne powroty lądują"} PRZED uderzeniem (pierwszy ${hhmmss(inc[0].returnAt)}, ~${inc[0].total.toLocaleString("pl-PL")} szt.).` : "";
      if (!fleet && th.length && secs <= 180) {
        const lad = [ ...bodies ].filter(b => b !== "unknown").find(b => landedSince(k, b, ((s.hangars || {})[`${k}|${b}`] || {}).at || 0)) || (bodies.has("unknown") ? [ "moon", "planet" ].filter(b => b === "planet" || pairs[k].hasMoon).find(b => landedSince(k, b, ((s.hangars || {})[`${k}|${b}`] || {}).at || 0)) : null);
        if (lad) {
          fleet = {
            body: lad,
            total: 0,
            at: now
          };
          alerts.push({
            key: k,
            level: "error",
            push: true,
            throttleMs: 6e4,
            msg: `atak na [${k}] za ${secs}s — migawka hangaru jest pusta, ale rejestr powrotów mówi, że właśnie wylądowała tam fala. RATUJĘ bez czekania na odczyt (formularz policzy, ile stoi).`
          });
        }
      }
      if (!fleet) {
        const fOut = inFlightFrom(k);
        if (fOut) {
          actions.push(...extendAll(k, th));
          const land = (fOut.sentAt || 0) + (fOut.flightMs || 0);
          if (hangarNiepewny) {
            alerts.push({
              key: k,
              level: "error",
              push: true,
              throttleMs: 5 * 6e4,
              msg: `atak na [${k}] za ${secs}s — z pary leci już ${fOut.kind} → [${fOut.toKey}], ale NIE MAM świeżego odczytu atakowanego ciała: jeśli wróciła fala, stoi pod uderzeniem. Sprawdzam hangar, a Ty zerknij na grę.`,
              pushKey: "slepota"
            });
            actions.push({
              kind: "recon",
              key: k,
              body: bodiesReal.find(b => !hangarPewny(b)) || "planet",
              quiet: true,
              alarm: true,
              why: `atak na [${k}] — po ucieczce nie wiem, czy coś wróciło do hangaru`
            });
          }
          alerts.push({
            key: k,
            level: "warn",
            throttleMs: 5 * 6e4,
            msg: `atak na [${k}] za ${secs}s — flota już wyleciała (${fOut.kind} → [${fOut.toKey}] ${fOut.toBody === "moon" ? "ksiezyc" : "planeta"}${fOut.flightMs ? `, ląduje ${new Date(land).toLocaleTimeString("pl-PL", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit"
            })}` : ""}), nie ma czego ratować.${incTxt}`
          });
        } else alerts.push({
          key: k,
          level: "error",
          push: true,
          throttleMs: 5 * 6e4,
          msg: `atak na [${k}] za ${secs}s — nie wiem, gdzie stoi flota (brak świeżego odczytu hangaru). Sprawdź grę.${incTxt}`,
          pushKey: "slepota"
        });
        const fresh = b => {
          const h = (s.hangars || {})[`${k}|${b}`];
          return h && now - (h.at || 0) < 15 * 6e4 && !landedSince(k, b, h.at);
        };
        const order = [ ...new Set([ ...attackedBodies(k), pairs[k] && pairs[k].hasMoon ? "moon" : "planet", "planet" ]) ].filter(b => b === "moon" ? pairs[k] && pairs[k].hasMoon : b === "planet");
        const want = order.find(b => !fresh(b)) || order[0] || "planet";
        if (secs > 90) actions.push({
          kind: "recon",
          key: k,
          body: want,
          why: `atak, a hangar nieznany — sprawdzam ${want === "moon" ? "księżyc" : "planetę"} [${k}]`
        });
        continue;
      }
      const hitBodies = all.filter(x => bodies.has(x.body) || bodies.has("unknown")).sort((a, b) => b.total - a.total);
      const f = inFlightFrom(k);
      const swiezoWyladowalo = hangarNiepewny;
      const stojiWDomu = (hitBodies[0] && hitBodies[0].ships || []).filter(x => (x.qty || 0) > 0);
      const tylkoRezerwa = !swiezoWyladowalo && stojiWDomu.length > 0 && stojiWDomu.every(x => CAP_RATUNKU[String(x.type).toUpperCase()] !== undefined);
      if (tylkoRezerwa) alerts.push({
        key: k,
        level: "warn",
        throttleMs: 30 * 6e4,
        msg: `atak na ${hitBodies[0].body} [${k}], ale stoi tam już TYLKO rezerwa spowalniająca (${stojiWDomu.map(x => `${x.type}×${x.qty.toLocaleString("pl-PL")}`).join(", ")}) — zostawiam ją w domu, żeby kolejne fale miały czym zwolnić ucieczkę`
      });
      const drugiLot = !!f && (hitBodies.length > 0 || swiezoWyladowalo) && !tylkoRezerwa;
      const hitRef = hitBodies[0] || {
        body: [ ...bodies ].find(b => b !== "unknown") || (pairs[k] && pairs[k].hasMoon ? "moon" : "planet"),
        total: 0
      };
      if (swiezoWyladowalo) actions.push({
        kind: "recon",
        key: k,
        body: hitRef.body,
        quiet: true,
        alarm: true,
        why: `ATAK na [${k}] — fala wylądowała po ostatnim odczycie hangaru, sprawdzam ile naprawdę stoi`
      });
      if (drugiLot && f.fs) alerts.push({
        key: k,
        level: "error",
        push: true,
        throttleMs: 10 * 6e4,
        msg: `ATAK na [${k}] za ${secs}s, a z tej pary trwa Fleet Save → [${f.toKey}]. FS jest lotem dobrowolnym, obrona ma pierwszeństwo — ratuję ${hitRef.body} (${hitRef.total ? hitRef.total.toLocaleString("pl-PL") + " szt." : "świeżo wylądowaną falę"}) osobnym lotem`
      }); else if (drugiLot) alerts.push({
        key: k,
        level: "error",
        push: true,
        throttleMs: 6e4,
        msg: `ATAK na [${k}] za ${secs}s: z tej pary już leci ratunek (${f.kind}/${f.phase} → [${f.toKey}]), ale na ${hitRef.body} ${hitRef.total ? "STOI " + hitRef.total.toLocaleString("pl-PL") + " szt." : "WŁAŚNIE WYLĄDOWAŁA fala (hangar starszy niż lądowanie)"} — wysyłam DRUGI lot ratunkowy`
      });
      if (f && drugiLot) {
        actions.push(...extendAll(k, th));
      }
      if (th.length) {
        const landedHit = [ ...bodies ].filter(b => b !== "unknown").filter(b => landedSince(k, b, ((s.hangars || {})[`${k}|${b}`] || {}).at || 0));
        if (inc.length || landedHit.length) alerts.push({
          key: k,
          level: "error",
          throttleMs: 6e4,
          msg: `ATAK na [${k}] za ${secs}s: ${landedHit.length ? `fala z powrotu JUŻ stoi na atakowanym ciele (${landedHit.join("/")})` : ""}${landedHit.length && inc.length ? ", a " : ""}${inc.length ? `${inc.length === 1 ? "kolejna fala ląduje" : inc.length + " kolejne fale lądują"} przed uderzeniem (pierwsza ${hhmmss(inc[0].returnAt)}, ~${inc[0].total.toLocaleString("pl-PL")} szt.)` : ""} — każda z nich dostanie własny lot ratunkowy po wylądowaniu; jeśli któraś ląduje tuż przed uderzeniem, zawróć ją ręcznie`
        });
      }
      if (f && !drugiLot) {
        actions.push(...extendAll(k, th));
        if (f.kind === "air" && f.phase === "launched") {} else if (f.phase === "recalled" || f.phase === "recall_clicked") alerts.push({
          key: k,
          level: "error",
          throttleMs: 5 * 6e4,
          msg: `ATAK na [${k}] za ${secs}s, a flota WRACA z [${f.toKey}] — sprawdź, czy zdąży wylądować po uderzeniu; nie mam czego ratować`
        }); else alerts.push({
          key: k,
          level: "error",
          throttleMs: 5 * 6e4,
          msg: `ATAK na [${k}] za ${secs}s, a z tej pary trwa lot (${f.kind}/${f.phase}) — flota jest w powietrzu, reaguj ręcznie, jeśli wróci za wcześnie`
        });
        continue;
      }
      const ladowaniePilne = secs <= 180 && bodiesReal.find(b => landedSince(k, b, ((s.hangars || {})[`${k}|${b}`] || {}).at || 0));
      if (!hitBodies.length && ladowaniePilne && fleet) {
        alerts.push({
          key: k,
          level: "error",
          push: true,
          throttleMs: 6e4,
          msg: `atak na [${k}] ${ladowaniePilne === "moon" ? "księżyc" : "planetę"} za ${secs}s, a rejestr powrotów mówi, że właśnie wylądowała tam fala — RATUJĘ bez czekania na odczyt hangaru (formularz policzy, ile naprawdę stoi).`
        });
        fleet.body = ladowaniePilne;
        fleet.total = 0;
      }
      if (!hitBodies.length && !ladowaniePilne) {
        const landedHit = [ ...bodies ].filter(b => b !== "unknown").find(b => landedSince(k, b, ((s.hangars || {})[`${k}|${b}`] || {}).at || 0));
        if (landedHit) {
          alerts.push({
            key: k,
            level: "error",
            msg: `atak na [${k}] ${landedHit === "moon" ? "księżyc" : "planetę"} za ${secs}s, a PO ostatnim odczycie hangaru wylądowała tam fala z rejestru powrotów — sprawdzam, czy jest co ratować`
          });
          actions.push({
            kind: "recon",
            key: k,
            body: landedHit,
            quiet: true,
            alarm: true,
            why: `atak, a na ${landedHit === "moon" ? "księżycu" : "planecie"} [${k}] właśnie wylądowała fala — sprawdzam hangar`
          });
          if (secs > 90) actions.push({
            kind: "recon",
            key: k,
            body: landedHit,
            why: `atak, a na ${landedHit === "moon" ? "księżycu" : "planecie"} [${k}] właśnie wylądowała fala — sprawdzam hangar`
          });
          continue;
        }
        const hAt = b => {
          const h = (s.hangars || {})[`${k}|${b}`];
          return h && h.at ? h.at : 0;
        };
        const freshest = Math.max(...all.map(x => x.at || 0), 0);
        const nieufne = bodiesReal.filter(b => hAt(b) && now - hAt(b) > 30 * 6e4);
        if (!freshest && secs > 120) for (const b of bodiesReal) actions.push({
          kind: "recon",
          key: k,
          body: b,
          quiet: true,
          why: `atak na [${k}] — nie mam ŻADNEGO odczytu tej pary, sprawdzam przed uznaniem spokoju`
        });
        if (nieufne.length || now - freshest > 30 * 6e4) {
          const nieznane = nieufne.length ? nieufne : bodiesReal;
          const wiek = b => {
            const h = (s.hangars || {})[`${k}|${b}`];
            return h && h.at ? `${Math.round((now - h.at) / 6e4)} min temu` : "NIGDY";
          };
          alerts.push({
            key: k,
            level: "error",
            push: true,
            msg: `atak na [${k}] za ${secs}s, a hangar ${nieznane.map(b => `${b === "moon" ? "księżyca" : "planety"} czytany ${wiek(b)}`).join(", ")} — NIE WIEM, czy flota nadal stoi po bezpiecznej stronie. Sprawdź grę.`,
            pushKey: "slepota"
          });
          actions.push({
            kind: "recon",
            key: k,
            body: nieznane[0] || "planet",
            quiet: true,
            alarm: true,
            why: `atak na [${k}] — nie mam świeżego odczytu atakowanego ciała, sprawdzam`
          });
          if (secs > 90) actions.push({
            kind: "recon",
            key: k,
            body: nieznane[0] || "planet",
            why: `atak, a dane o hangarze [${k}] są przeterminowane — sprawdzam`
          });
          continue;
        }
        actions.push({
          kind: "hold",
          key: k,
          why: `atak w ${[ ...bodies ].join("/")}, flota na ${all.map(x => x.body).join("+") || fleet.body} — bezpieczna strona (odczyt atakowanego ciała świeży)`
        });
        continue;
      }
      const src0 = hitRef;
      if (hitBodies.length > 1) alerts.push({
        key: k,
        level: "error",
        push: true,
        throttleMs: 6e4,
        msg: `flota na OBU ciałach [${k}] pod atakiem — teraz ratuję ${src0.body} (${src0.total.toLocaleString("pl-PL")} szt.), ${hitBodies[1].body} (${hitBodies[1].total.toLocaleString("pl-PL")} szt.) idzie osobnym lotem w następnym przebiegu`
      });
      fleet.body = src0.body;
      fleet.total = src0.total;
      if (tylkoRezerwa) continue;
      if (now - firstSeen < cfg.confirmMs && secs > cfg.tooLateSec + cfg.confirmMs / 1e3) {
        alerts.push({
          key: k,
          level: "warn",
          msg: `atak na [${k}] za ${secs}s — potwierdzam ${Math.round((cfg.confirmMs - (now - firstSeen)) / 1e3)}s`
        });
        continue;
      }
      if (secs < cfg.tooLateSec) {
        alerts.push({
          key: k,
          level: "error",
          push: true,
          pushKey: "bezradny",
          msg: `atak na [${k}] za ${secs}s — ZA PÓŹNO na formularz, nie zdążę wysłać floty. Ratuj ręcznie, jeśli możesz.`
        });
        continue;
      }
      const etaMs = soonest - now, saveTotal = src0.total;
      const nb = neighbourMoon(k);
      const rf = (s.rescueFail || {})[`${k}>${nb}`] || null;
      const nbBlocked = !!nb && !!rf && rf.count >= 2 && now - (rf.at || 0) < 10 * 6e4;
      if (nb && !nbBlocked) {
        actions.push({
          kind: "fly",
          fromKey: k,
          fromBody: fleet.body,
          toKey: nb,
          toBody: "moon",
          why: `atak w ${fleet.body} [${k}] → sąsiedni księżyc`,
          rescue: true,
          capTypes: CAP_RATUNKU,
          etaMs: etaMs,
          saveTotal: saveTotal,
          speed: cfg.airSpeedPct,
          recall: true,
          air: true,
          recallAt: Math.max(...th.map(t => t.arriveAt)) + cfg.recallBufferSec * 1e3
        });
        continue;
      }
      const wKsiezycDestroy = th.some(t => /DESTRUCT|DESTROY/i.test(String(t.type || "")));
      const refDestroy = wKsiezycDestroy && !nbBlocked ? anyRefuge(k, null) : null;
      if (refDestroy) {
        actions.push({
          kind: "fly",
          fromKey: k,
          fromBody: fleet.body,
          toKey: refDestroy.key,
          toBody: refDestroy.body,
          why: `DESTROY w ${fleet.body} [${k}], brak wolnego księżyca w układzie → najbliższa spokojna kolonia [${refDestroy.key}] (księżyc może przestać istnieć — nie ląduję na planecie pod nim)`,
          rescue: true,
          capTypes: CAP_RATUNKU,
          etaMs: etaMs,
          saveTotal: saveTotal,
          speed: cfg.airSpeedPct,
          recall: true,
          air: true,
          recallAt: Math.max(...th.map(t => t.arriveAt)) + cfg.recallBufferSec * 1e3
        });
        continue;
      }
      const other = fleet.body === "moon" ? "planet" : "moon";
      if ((other === "planet" || pairs[k].hasMoon) && !bodies.has(other) && !bodies.has("unknown")) {
        actions.push({
          kind: "fly",
          fromKey: k,
          fromBody: fleet.body,
          toKey: k,
          toBody: other,
          why: nbBlocked ? `sąsiedni księżyc [${nb}] nie chce wystartować (${rf.count}× nieudane, pewnie deuter) → drugie ciało pary, wolniej` : `atak w ${fleet.body} [${k}] → drugie ciało`,
          speed: nbBlocked ? cfg.airSpeedPct : 100,
          recall: false,
          rescue: true,
          capTypes: CAP_RATUNKU,
          etaMs: etaMs,
          saveTotal: saveTotal
        });
        continue;
      }
      const ref = anyRefuge(k, nbBlocked ? nb : null);
      if (ref) {
        actions.push({
          kind: "fly",
          fromKey: k,
          fromBody: fleet.body,
          toKey: ref.key,
          toBody: ref.body,
          why: `atak na oba ciała [${k}] → powietrze do [${ref.key}]${nbBlocked ? ` (nie ${nb}, ${rf.count}× nieudane)` : ""}`,
          rescue: true,
          capTypes: CAP_RATUNKU,
          etaMs: etaMs,
          saveTotal: saveTotal,
          speed: cfg.airSpeedPct,
          recall: true,
          air: true,
          recallAt: Math.max(...th.map(t => t.arriveAt)) + cfg.recallBufferSec * 1e3
        });
        continue;
      }
      alerts.push({
        key: k,
        level: "error",
        push: true,
        pushKey: "bezradny",
        msg: `atak na [${k}] — NIE MAM DOKĄD uciec (każde ciało jest atakowane albo nie ma innej kolonii). Flota zostaje pod uderzeniem — reaguj ręcznie.`
      });
    }
    if (fsNaPlanecie.length) {
      fsNaPlanecie.sort((a, b) => (b.total || 0) - (a.total || 0));
      const suma = fsNaPlanecie.reduce((a, x) => a + (x.total || 0), 0);
      const lista = fsNaPlanecie.slice(0, 6).map(x => `[${x.key}] ${(x.total || 0).toLocaleString("pl-PL")}`).join(", ") + (fsNaPlanecie.length > 6 ? ` i ${fsNaPlanecie.length - 6} innych` : "");
      alerts.push({
        key: "fs-planeta",
        level: "warn",
        throttleMs: 60 * 6e4,
        msg: `FS: flota stoi na planecie na ${fsNaPlanecie.length} parach, łącznie ${suma.toLocaleString("pl-PL")} szt. — nie wysyłam stamtąd (falanga), czekam aż będzie na księżycu: ${lista}`
      });
    }
    if (fsCands.length) {
      fsCands.sort((a, b) => (b.saveTotal || 0) - (a.saveTotal || 0));
      const best = fsCands[0];
      const fsSlots = s.slots && s.slots.fleet && now - (s.slots.at || 0) < 30 * 6e4 ? s.slots.fleet : null;
      const fsAir = (s.flights || []).filter(f => f.fs && f.phase !== "done" && !flightStale(f, now)).length;
      const reserve = cfg.fs && cfg.fs.slotReserve != null ? cfg.fs.slotReserve : 1;
      const wolne = fsSlots && fsSlots.total ? fsSlots.total - fsSlots.used - reserve : fsAir ? 0 : 1;
      if (wolne > 0) {
        if (fsCands.length > 1) best.why += ` (${fsCands.length} księżyców z flotą — po JEDNYM locie na przebieg, najpierw największy hangar)`;
        actions.push(best);
      } else {
        alerts.push({
          key: best.fromKey,
          level: "warn",
          throttleMs: 30 * 6e4,
          msg: fsSlots ? `FS: sloty floty ${fsSlots.used}/${fsSlots.total}, rezerwa ${reserve} — nie wysyłam Fleet Save, bo ostatnie wolne sloty należą do ratunku` : `FS: jeden lot Fleet Save już wisi w powietrzu, a liczby slotów floty nie znam (odczyt ze strony floty starszy niż 30 min) — kolejnego nie wysyłam, żeby zostało czym uciekać`
        });
      }
    }
    for (const f of s.flights || []) {
      if (!flightBlind(f)) continue;
      if (f.kind === "air" && [ "launched", "recall_clicked" ].includes(f.phase)) continue;
      if (f.phase === "recalled" && f.recalledAt && f.sentAt) {
        const landAt = f.recalledAt + Math.max(0, f.recalledAt - f.sentAt);
        const hSrc = (s.hangars || {})[`${f.fromKey}|${f.fromBody}`];
        const sprawdzony = !!hSrc && (hSrc.at || 0) > landAt;
        if (now < landAt + 60 * 6e4) alerts.push({
          key: f.fromKey,
          level: "warn",
          throttleMs: 60 * 6e4,
          msg: `lot [${f.fromKey}]→[${f.toKey}] zawrócony o ${hhmm(f.recalledAt)}, wraca — ląduje ~${hhmm(landAt)}; do lądowania para jest pod pełną obroną`
        }); else if (!sprawdzony) {
          actions.push({
            kind: "recon",
            key: f.fromKey,
            body: f.fromBody,
            quiet: true,
            why: `lot [${f.fromKey}]→[${f.toKey}] miał wylądować ~${hhmm(landAt)} — sprawdzam hangar, zanim podniosę alarm`
          });
          alerts.push({
            key: f.fromKey,
            level: "warn",
            throttleMs: 30 * 6e4,
            msg: `lot [${f.fromKey}]→[${f.toKey}] miał wylądować ~${hhmm(landAt)}, a hangaru [${f.fromKey}] ${f.fromBody === "moon" ? "księżyc" : "planeta"} jeszcze nie czytałem po tej godzinie — sprawdzam w tle, zanim cokolwiek ogłoszę`
          });
        } else alerts.push({
          key: f.fromKey,
          level: "error",
          throttleMs: 60 * 6e4,
          msg: `lot [${f.fromKey}]→[${f.toKey}] zawrócony o ${hhmm(f.recalledAt)} powinien był wylądować ~${hhmm(landAt)}, a hangar [${f.fromKey}] ${f.fromBody === "moon" ? "księżyc" : "planeta"} odczytany o ${hhmm(hSrc.at)} jest pusty — sprawdź ręcznie, gdzie jest flota`
        });
        continue;
      }
      alerts.push({
        key: f.fromKey,
        level: "error",
        throttleMs: 15 * 6e4,
        msg: `lot [${f.fromKey}]→[${f.toKey}] ${f.phase === "recall_failed" ? "NIE ZOSTAŁ ZAWRÓCONY" : "dawno po terminie zawrotu"} — sprowadź flotę ręcznie; para znów pod pełną obroną`
      });
    }
    if (s.barExcess && s.barExcess.active) {
      const ls = s.listSeen;
      const listQuiet = k => !!ls && ls.key === k && ls.proven === true && ls.foreign === 0 && now - (ls.at || 0) < 12e4 && !s.listUntrusted;
      const candidates = Object.keys(pairs).map(k => ({
        k: k,
        f: fleetsAt(k).sort((a, b) => b.total - a.total)[0]
      })).filter(x => x.f && !inFlightFrom(x.k) && threatsFor(x.k).length === 0).sort((a, b) => b.f.total - a.f.total);
      const spared = candidates.filter(x => listQuiet(x.k));
      const withFleet = candidates.filter(x => !listQuiet(x.k));
      const spareTop = spared.length && candidates[0] && candidates[0].k === spared[0].k && s.bar && s.bar.attackType ? spared[0].k : null;
      for (const x of spared) alerts.push({
        key: x.k,
        level: x.k === spareTop ? "error" : "warn",
        push: x.k === spareTop,
        throttleMs: 10 * 6e4,
        msg: x.k === spareTop ? `pasek widzi ${s.barExcess.count} obcych lotów bez rozpoznanego celu, a lista ruchów przy [${x.k}] jest cicha — ZOSTAWIAM W DOMU NAJWIĘKSZĄ FLOTĘ KONTA (${x.f.total.toLocaleString("pl-PL")} szt.). Cisza listy NIE wyklucza ataku z WŁASNEGO UKŁADU, bo fork takich lotów na liście nie pokazuje. Sprawdź grę i ratuj ręcznie, jeśli coś leci.` : `pasek widzi ${s.barExcess.count} obcych lotów bez celu, ale lista ruchów (świeża, z własnym wierszem tej pary) nie pokazuje przy [${x.k}] żadnego obcego lotu — nadwyżka dotyczy innej kolonii, flota (${x.f.total.toLocaleString("pl-PL")} szt.) zostaje w domu`
      });
      if (withFleet.length) {
        const t = withFleet[0];
        const znane = (s.threats || []).filter(x => x.arriveAt > now);
        const detail = `pasek: ${s.bar ? `${s.bar.foreign} obcych z ${s.bar.total} (własne ${s.bar.own}), najbliższy typ: ${s.bar.barType || "?"}${s.bar.attackType ? ", bojowy" : ""}${s.bar.spyType ? ", sonda" : ""}, odczyt ${s.bar.src || "strona"} sprzed ${Math.round((now - (s.bar.at || now)) / 1e3)}s` : "brak"}; lista zna ${znane.length}: ${znane.map(x => `${x.type || "?"} → [${x.dst}] ${x.dstBody || "?"} za ${Math.round((x.arriveAt - now) / 1e3)}s`).join(", ") || "nic"}`;
        alerts.push({
          key: t.k,
          level: "error",
          blind: true,
          detail: detail,
          msg: `ŚLEPY ALARM: pasek widzi ${s.barExcess.count} obcych lotów bez rozpoznanego celu od ${Math.round((now - s.barExcess.since) / 1e3)}s — bronię [${t.k}] ${t.f.body} (${t.f.total.toLocaleString("pl-PL")} statków)`
        });
        const nb = neighbourMoon(t.k);
        const dest = nb ? {
          key: nb,
          body: "moon"
        } : anyRefuge(t.k);
        if (dest) actions.push({
          kind: "fly",
          fromKey: t.k,
          fromBody: t.f.body,
          toKey: dest.key,
          toBody: dest.body,
          why: "ŚLEPY ALARM (pasek widzi atak, listy brak)",
          speed: cfg.airSpeedPct,
          recall: true,
          air: true,
          blind: true,
          capTypes: CAP_RATUNKU,
          saveTotal: t.f.total,
          recallAt: now + 10 * 6e4
        }); else alerts.push({
          key: t.k,
          level: "error",
          msg: "ŚLEPY ALARM, ale nie mam dokąd uciec — reaguj ręcznie"
        });
      } else if (!spared.length) {
        alerts.push({
          key: "?",
          level: "error",
          push: true,
          msg: `ŚLEPY ALARM: pasek widzi ${s.barExcess.count} obcych, ale nie wiem, gdzie stoi flota — reaguj ręcznie`
        });
      }
    } else if (s.barExcess && s.barExcess.count > 0 && s.barExcess.spyHold && now - (s.barExcess.since || now) >= (cfg.barHoldMs || 6e4)) {
      alerts.push({
        key: "pasek",
        level: "warn",
        push: true,
        pushKey: "sonda",
        throttleMs: 5 * 6e4,
        msg: `pasek widzi ${s.barExcess.count} obcych lotów bez rozpoznanego celu od ${Math.round((now - s.barExcess.since) / 1e3)}s — najbliższy dolot to SONDA (skan), więc flotą nie ruszam. Jeśli za sondą idzie atak, zobaczysz osobny alarm; możesz też ratować ręcznie`
      });
    }
    const known = new Set(Object.keys(pairs));
    for (const t of s.threats || []) {
      if (!t.attack || t.arriveAt <= now || known.has(t.dst)) continue;
      alerts.push({
        key: t.dst,
        level: "error",
        unknownPair: true,
        msg: `ATAK na [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - now) / 1e3)}s, a tej kolonii NIE MA na pasku planet — reaguj ręcznie`
      });
    }
    for (const g of guardRecon) if (!actions.some(a => a.kind === "recon" && a.key === g.key && a.body === g.body)) actions.push(g);
    return {
      actions: actions,
      alerts: alerts
    };
  }
  const NavRate = {
    note() {
      const a = (Store.get("nav_log", []) || []).filter(t => Date.now() - t < 36e5);
      a.push(Date.now());
      Store.set("nav_log", a);
    },
    over() {
      const a = (Store.get("nav_log", []) || []).filter(t => Date.now() - t < 36e5);
      return a.length >= (CFG.maxNavPerHour ?? 240);
    }
  };
  const Human = {
    onBreak() {
      return Date.now() < (Store.get("break_until", 0) || 0);
    },
    breakLeftMin() {
      return Math.max(0, Math.ceil(((Store.get("break_until", 0) || 0) - Date.now()) / 6e4));
    },
    maybeStart() {
      const h = CFG.human || {};
      if (!h.breaks) return false;
      const now = Date.now();
      const idle = now - (Store.get("eco_last", 0) || 0);
      Store.set("eco_last", now);
      let next = Store.get("break_next", 0) || 0;
      if (!next || now >= next && idle > 20 * 6e4) {
        Store.set("break_next", now + jitter(h.breakEveryMinMin, h.breakEveryMaxMin) * 6e4);
        if (next && !Once.said("break_stale", 60 * 6e4)) log("[PRZERWA] ekonomia stała dłużej niż 20 min (bot wyłączony) — zaległa przerwa przepada, licznik startuje od nowa.", "info");
        return false;
      }
      if (now < next) return false;
      const len = jitter(h.breakLenMinMin, h.breakLenMaxMin) * 6e4;
      Store.set("break_until", now + len);
      Store.set("break_next", now + len + jitter(h.breakEveryMinMin, h.breakEveryMaxMin) * 6e4);
      log(`[PRZERWA] ekonomia pauzuje na ~${Math.round(len / 6e4)} min (rytm człowieka). Obrona działa normalnie.`, "info");
      return true;
    },
    playing(ms = 9e4) {
      return Date.now() - (Store.get("input_at", 0) || 0) < ms;
    },
    FS_MIMO: [ "moon", "debris", "farm" ],
    MANUAL_YIELD_MS: 2e4,
    MANUAL_YIELD_CAP_MS: 12e4,
    yielding(now = Date.now()) {
      const y = Store.get("eco_yield", null);
      return !!(y && now - y.last < this.MANUAL_YIELD_MS && now - y.since < this.MANUAL_YIELD_CAP_MS);
    },
    economyAllowed(s, who = "") {
      const farma = who === "farm";
      if (!farma && this.onBreak()) return `przerwa (~${this.breakLeftMin()} min)`;
      if (!farma && this.maybeStart()) return "przerwa właśnie się zaczęła";
      if (!CFG.human.economyAtNight && !this.FS_MIMO.includes(who) && s && (s.flights || []).some(f => f.fs && f.phase !== "done" && !flightStale(f, Date.now()))) return "flota jest na Fleet Save";
      if (!CFG.human.economyAtNight && !farma && this.quiet()) return "godziny ciszy (konto ma wyglądać na śpiące)";
      {
        const now2 = Date.now();
        const klik = Store.get("input_at", 0) || 0;
        const cisza = now2 - klik;
        const idleMin = Math.max(0, Math.round((CFG.human.ecoIdleSec ?? 0) / 60));
        if (idleMin > 0 && cisza < idleMin * 6e4) {
          const since = Store.get("eco_wait_since", 0) || 0;
          if (!since) Store.set("eco_wait_since", now2);
          const czeka = Math.round((now2 - (since || now2)) / 6e4);
          return czeka >= 1 ? `grasz — ekonomia czeka od ${czeka} min (ruszy po ${idleMin} min od ostatniego kliknięcia)` : "grasz — nie przełączam Ci planety, ekspedycja poczeka";
        }
        if (Store.get("eco_wait_since", 0)) Store.set("eco_wait_since", 0);
      }
      if (this.yielding()) {
        const y = Store.get("eco_yield", null);
        return `grasz — zmieniłeś stronę, fala ruszy za ${Math.ceil((this.MANUAL_YIELD_MS - (Date.now() - y.last)) / 1e3)} s`;
      }
      if (!farma && NavRate.over()) return `sufit ${CFG.maxNavPerHour} nawigacji/h — ekonomia czeka`;
      return null;
    },
    quiet() {
      const q = CFG.quietHours || {};
      if (!q.enabled || q.startHour === q.endHour) return false;
      const d = new Date;
      const day = d.toISOString().slice(0, 10);
      let j = Store.get("quiet_jitter", null);
      if (!j || j.day !== day) {
        j = {
          day: day,
          a: Math.round(Math.random() * 40 - 20),
          b: Math.round(Math.random() * 40 - 20)
        };
        Store.set("quiet_jitter", j);
      }
      const nowMin = d.getHours() * 60 + d.getMinutes();
      const norm = m => (m % 1440 + 1440) % 1440;
      const a = norm(q.startHour * 60 + j.a), b = norm(q.endHour * 60 + j.b);
      return a < b ? nowMin >= a && nowMin < b : nowMin >= a || nowMin < b;
    }
  };
  const Moon = {
    KM: [ 8944, 8e3, 7e3, 6e3, 5e3, 4e3, 3e3, 2e3, 1e3 ],
    st() {
      const d = {
        tries: {},
        m: null
      };
      return {
        ...d,
        ...Store.get("moon", d) || d
      };
    },
    save(v) {
      Store.set("moon", v);
    },
    canTry(st, k, odbudowa) {
      const e = (st.tries || {})[k];
      if (!e) return true;
      if (Date.now() - e.at > 24 * 36e5) return true;
      const limit = odbudowa ? 20 : CFG.moon.maxTries24h || 3;
      const karencja = odbudowa ? 6e4 : 10 * 6e4;
      return e.n < limit && Date.now() - e.at > karencja;
    },
    noteTry(st, k) {
      const t = st.tries || (st.tries = {});
      const e = t[k] && Date.now() - t[k].at < 24 * 36e5 ? t[k] : {
        n: 0,
        at: 0
      };
      e.n += 1;
      e.at = Date.now();
      t[k] = e;
      this.save(st);
      return e.n;
    },
    metal() {
      const el = document.querySelector(".resource-item-metal, #resources_metal, [class*='metal']");
      const m = el && (el.textContent || "").match(/\d[\d .,']*/);
      const n = m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : NaN;
      return Number.isFinite(n) ? n : null;
    },
    formEls() {
      const own = e => e.closest("#ogx3-panel");
      const inputs = [ ...document.querySelectorAll("input") ].filter(i => !own(i) && i.offsetParent !== null && /number|text/i.test(i.type || "text"));
      const input = inputs.find(i => /diam|śred|sred/i.test(`${i.id} ${i.name} ${i.className}`)) || inputs.find(i => /^\s*[\d.,]+\s*$/.test(i.value || "")) || inputs[0] || null;
      const btn = [ ...document.querySelectorAll("a, button, input[type='submit']") ].find(e => !own(e) && e.offsetParent !== null && /form\s*a\s*moon|utw[oó]rz\s*ksi/i.test(e.value || e.textContent || "")) || null;
      return {
        input: input,
        btn: btn
      };
    },
    cost() {
      const t = document.body.textContent || "";
      const i = t.search(/Requirements|Wymagania|Cost|Koszt/i);
      if (i < 0) return null;
      const m = t.slice(i, i + 400).match(/\d{1,3}(?:[ .,]\d{3})+|\d{4,}/);
      return m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : null;
    },
    async setKm(input, km) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      input.focus();
      if (setter) setter.call(input, String(km)); else input.value = String(km);
      for (const ev of [ "input", "change", "keyup" ]) input.dispatchEvent(new Event(ev, {
        bubbles: true
      }));
      input.blur();
      await sleep(jitter(500, 900));
    },
    rebuildOnly() {
      return !CFG.moon.enabled;
    },
    doOdbudowy(s) {
      return Object.keys(s.moonLost || {}).some(k => !((s.pairs || {})[k] || {}).hasMoon);
    },
    pending() {
      const st = this.st();
      return !!(st.m || st.zwoz);
    },
    zwozTick(s, st, now) {
      const z = st.zwoz;
      if (!z) return false;
      if (now - z.at > 60 * 6e4 || !((s.pairs || {})[z.key] || {}).hasMoon) {
        delete st.zwoz;
        this.save(st);
        return false;
      }
      if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) {
        if (!Once.said("moon_zwoz_wait|" + z.key, 10 * 6e4)) log(`[KSIĘŻYC] [${z.key}] ma nowy księżyc, ale trwa atak — zwóz floty z planety poczeka na ciszę.`, "info");
        return false;
      }
      delete st.zwoz;
      this.save(st);
      try {
        const hp2 = (s.hangars || {})[`${z.key}|planet`];
        if (hp2 && (hp2.total || 0) > 0 && !Fly.mission()) {
          log(`[KSIĘŻYC] księżyc [${z.key}] odbudowany, na planecie stoi flota (${hp2.total.toLocaleString("pl-PL")} szt.) — zwożę na nowy księżyc.`, "warn");
          const mgZ = (s.moonGone || {})[z.key], planZ = mgZ && mgZ.baseline ? zwozPlan(hp2, mgZ) : null, keepZ2 = zwozKeep(mgZ);
          if (planZ && !planZ.length) return false;
          Fly.start({
            kind: "home",
            fromKey: z.key,
            fromBody: "planet",
            toKey: z.key,
            toBody: "moon",
            why: "księżyc odbudowany — zwożę flotę z planety",
            speed: 100,
            recall: false,
            home: true,
            ...keepZ2 ? {
              keepQty: keepZ2
            } : {}
          });
        }
      } catch (e) {
        log(`[KSIĘŻYC] zwóz po odbudowie nie wyszedł: ${e.message}`, "warn");
      }
      return false;
    },
    target(s, st) {
      const podAtakiem = (s.threats || []).some(t => t.attack && t.arriveAt > Date.now());
      const tylkoOdbudowa = this.rebuildOnly() || podAtakiem;
      for (const [k, p] of Object.entries(s.pairs || {})) {
        if (p.hasMoon) continue;
        if (tylkoOdbudowa && !(s.moonLost || {})[k]) continue;
        if (st && !this.canTry(st, k, !!(s.moonLost || {})[k])) continue;
        return k;
      }
      return null;
    },
    async tick(s) {
      if (Fly.mission()) return false;
      const now = Date.now();
      const st = this.st();
      const m = st.m;
      if (this.rebuildOnly() && !this.doOdbudowy(s) && !m && !st.zwoz) return false;
      if (m && now - m.at < 10 * 6e4) {
        if ((s.pairs || {})[m.key]?.hasMoon) {
          st.m = null;
          if (st.tries && st.tries[m.key]) delete st.tries[m.key];
          st.zwoz = {
            key: m.key,
            at: now
          };
          this.save(st);
          log(`[KSIĘŻYC] ✅ [${m.key}] ma księżyc (${m.km} km za ${(m.cost || 0).toLocaleString("pl-PL")} metalu).`, "success");
          Journal.add("POWRÓT", `Postawiony księżyc przy [${m.key}] — ${m.km} km.`);
          return this.zwozTick(s, st, now);
        }
        if (m.km && /moonformation/i.test(location.pathname)) {
          const odbudowa = !!(s.moonLost || {})[m.key];
          const n = this.noteTry(st, m.key);
          const frag = ((document.querySelector(".alert, .error, .alert-danger, #content, .content") || document.body).textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
          st.m = null;
          this.save(st);
          log(`[KSIĘŻYC] gra NIE przyjęła „Form a moon" przy [${m.key}] (${m.km} km za ${(m.cost || 0).toLocaleString("pl-PL")} metalu) — strona formowania stoi, księżyca nie ma (próba ${n}). Tekst strony: ${frag}`, "error");
          if (odbudowa && !Once.said("moon_reject|" + m.key, 30 * 6e4)) Journal.add("BŁĄD", `Gra odrzuciła odbudowę księżyca przy [${m.key}] (${m.km} km) — sprawdź metal i warunki w grze. Tekst: ${frag.slice(0, 120)}`);
          return false;
        }
        if ((m.navs || 0) >= 4) {
          const odbudowa = !!(s.moonLost || {})[m.key];
          const n = this.noteTry(st, m.key);
          st.m = null;
          this.save(st);
          log(`[KSIĘŻYC] 4 nawigacje bez efektu przy [${m.key}] — odpuszczam (próba ${n}) i czekam, żeby nie przestawiać planety w kółko. ${odbudowa ? "To ODBUDOWA po stracie: wrócę za minutę, aż trafię w okno bez ratunku." : `Limit ${CFG.moon.maxTries24h || 3}/dobę.`}`, "warn");
          return false;
        }
      } else if (m) {
        st.m = null;
        this.save(st);
      }
      if (st.zwoz) {
        this.zwozTick(s, st, now);
        if (Fly.mission()) return false;
      }
      if (!this.doOdbudowy(s) && (s.threats || []).some(t => t.attack && t.arriveAt > now)) return false;
      if (!this.doOdbudowy(s) && Human.economyAllowed(s, "moon")) return false;
      const cur = this.st();
      const key0 = cur.m ? cur.m.key : this.target(s, cur);
      if (!key0) {
        const anyMoonless = Object.values(s.pairs || {}).some(p => !p.hasMoon);
        if (!Once.said("moon_none", 6 * 36e5)) log(anyMoonless ? "[KSIĘŻYC] wszystkie bezksiężycowe pary są w karencji (limit 3 prób/24h albo 10 min po nieudanej) — czekam." : "[KSIĘŻYC] każda planeta ma już księżyc — nie ma co stawiać.", "info");
        return false;
      }
      if (this.rebuildOnly() && !(s.moonLost || {})[key0]) {
        cur.m = null;
        this.save(cur);
        if (!Once.said("moon_off_drop|" + key0, 6 * 36e5)) log(`[KSIĘŻYC] moduł wyłączony — porzucam próbę przy [${key0}]. Odbudowa księżyca ZNISZCZONEGO przez atak działa dalej.`, "info");
        return false;
      }
      if (this.rebuildOnly() && !Once.said("moon_rebuild_off|" + key0, 6 * 36e5)) log(`[KSIĘŻYC] moduł jest WYŁĄCZONY, ale [${key0}] straciła księżyc — odbudowuję mimo to, bo wracająca flota lądowałaby na gołej planecie widocznej dla falangi. Pozostałe kolonie dalej pomijam.`, "warn");
      if (!cur.m && !this.canTry(cur, key0, !!(s.moonLost || {})[key0])) return false;
      const act = s.active;
      if (!act || act.key !== key0 || act.body !== "planet") {
        const el = PlanetBar.anchor(key0, "planet");
        if (!el) {
          if (!Once.said("moon_anchor|" + key0, 36e5)) log(`[KSIĘŻYC] nie widzę [${key0}] na pasku planet — pomijam.`, "warn");
          return false;
        }
        cur.m = {
          key: key0,
          at: now,
          navs: ((cur.m || {}).navs || 0) + 1
        };
        this.save(cur);
        log(`[KSIĘŻYC] stawiam księżyc przy [${key0}] — przełączam się na tę planetę.`, "warn");
        Nav.click(el, `księżyc: przełączenie na [${key0}]`);
        return true;
      }
      if (!/moonformation/i.test(location.pathname)) {
        cur.m = {
          key: key0,
          at: now,
          navs: ((cur.m || {}).navs || 0) + 1
        };
        this.save(cur);
        Nav.go("/home/moonformation", `księżyc: formularz dla [${key0}]`);
        return true;
      }
      const {input: input, btn: btn} = this.formEls();
      if (!input || !btn) {
        this.noteTry(cur, key0);
        log(`[KSIĘŻYC DOM] nie rozpoznaję strony formowania (input:${!!input}, przycisk:${!!btn}). Markup: ${(document.querySelector("#content, .content, main") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1500)}`, "error");
        cur.m = null;
        this.save(cur);
        return false;
      }
      const metal = this.metal();
      if (metal == null) {
        const curX = this.st();
        this.noteTry(curX, key0);
        curX.m = null;
        this.save(curX);
        log("[KSIEZYC] nie odczytalem stanu metalu — nie ryzykuje zakupu bez znanego budzetu.", "error");
        log("[KSIEZYC DOM] pasek surowcow: " + ((document.querySelector(".resource-item-metal, #resources_metal, [class*='metal']") || document.body).outerHTML || "").replace(/\s+/g, " ").slice(0, 300), "warn");
        return false;
      }
      const budget = Math.floor(metal * Math.min(1, Math.max(.01, CFG.moon.maxMetalShare ?? .25)));
      let picked = null;
      const order = [ ...this.KM ].filter(km => km >= (CFG.moon.minKm || 1e3)).sort((a, b) => a - b);
      for (const km of order) {
        await this.setKm(input, km);
        const c = this.cost();
        if (c == null) continue;
        if (c <= budget) {
          picked = {
            km: km,
            cost: c
          };
          break;
        }
      }
      if (!picked) {
        const n = this.noteTry(cur, key0);
        log(`[KSIĘŻYC] za drogo: metal ${metal == null ? "?" : metal.toLocaleString("pl-PL")}, budżet ${budget == null ? "?" : budget.toLocaleString("pl-PL")} (${Math.round((CFG.moon.maxMetalShare || .25) * 100)}%) — żadna średnica ≥ ${CFG.moon.minKm} km się nie mieści (próba ${n}).`, "warn");
        cur.m = null;
        this.save(cur);
        return false;
      }
      const n = this.noteTry(cur, key0);
      cur.m = {
        key: key0,
        at: Date.now(),
        navs: ((cur.m || {}).navs || 0) + 1,
        km: picked.km,
        cost: picked.cost
      };
      this.save(cur);
      log(`[KSIĘŻYC] [${key0}]: ${picked.km} km za ${picked.cost.toLocaleString("pl-PL")} metalu (mam ${metal == null ? "?" : metal.toLocaleString("pl-PL")}, sufit ${Math.round((CFG.moon.maxMetalShare || .25) * 100)}%) — próba ${n}. Klikam „Form a moon".`, "success");
      Journal.add("RATUNEK", `Stawiam księżyc przy [${key0}]: ${picked.km} km za ${picked.cost.toLocaleString("pl-PL")} metalu.`);
      Nav.click(btn, `księżyc: formowanie ${picked.km} km przy [${key0}]`);
      return true;
    }
  };
  const Bonus = {
    st() {
      const d = {
        claims: [],
        nextTry: 0,
        pending: 0,
        fails: 0
      };
      return {
        ...d,
        ...Store.get("bonus", d) || d
      };
    },
    save(v) {
      Store.set("bonus", v);
    },
    today(st) {
      const t0 = new Date;
      t0.setHours(0, 0, 0, 0);
      return (st.claims || []).filter(t => t >= t0.getTime()).length;
    },
    find() {
      const own = e => e.closest("#ogx3-panel");
      const byId = document.getElementById("btn-online-bonus");
      if (byId && !own(byId)) return byId;
      const byHref = [ ...document.querySelectorAll("a[href*='onlinebonus'], a[href*='online-bonus']") ].find(e => !own(e));
      if (byHref) return byHref;
      return [ ...document.querySelectorAll("a, button") ].find(e => !own(e) && e.offsetParent !== null && /^(online bonus|bonus online)\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim())) || null;
    },
    async findRemote() {
      this.probed = false;
      const at = Store.get("bonus_probe_at", 0) || 0;
      if (Date.now() - at < 2 * 6e4) return null;
      Store.set("bonus_probe_at", Date.now());
      try {
        const r = await fetchT("/home", {
          credentials: "same-origin"
        });
        if (!r.ok || /\/auth\/login/.test(r.url || "")) return null;
        const doc = (new DOMParser).parseFromString(await r.text(), "text/html");
        this.probed = true;
        return doc.getElementById("btn-online-bonus") || doc.querySelector("a[href*='onlinebonus'], a[href*='online-bonus']") || [ ...doc.querySelectorAll("a, button") ].find(e => /^(online bonus|bonus online)\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim())) || null;
      } catch {
        return null;
      }
    },
    claimable(el) {
      if (!el) return {
        ok: false,
        why: "brak przycisku"
      };
      const label = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/\d{1,2}:\d{2}/.test(label)) return {
        ok: false,
        why: `odliczanie („${label}")`,
        wait: 5 * 6e4
      };
      if (el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true" || el.disabled) return {
        ok: false,
        why: "wyszarzony",
        wait: 10 * 6e4
      };
      return {
        ok: true,
        label: label
      };
    },
    async tick(s) {
      if (!CFG.bonus.enabled || Fly.mission()) return false;
      const now = Date.now();
      const st = this.st();
      if (st.pending) {
        const gone = this.claimable(this.find());
        if (!gone.ok) {
          st.claims = [ ...(st.claims || []).filter(t => now - t < 48 * 36e5), now ];
          st.pending = 0;
          st.fails = 0;
          st.nextTry = now + Math.max(1, CFG.bonus.gapMin) * 6e4;
          this.save(st);
          log(`[BONUS] odebrany — antymateria + punkty Akademii. Dziś: ${this.today(st)}.`, "success");
          return false;
        }
        st.pending = 0;
        st.fails = (st.fails || 0) + 1;
        st.nextTry = now + Math.max(1, CFG.bonus.retryMin) * 6e4;
        this.save(st);
        log(`[BONUS] kliknięcie nie odebrało bonusu (przycisk dalej aktywny, próba ${st.fails}) — wracam za ${CFG.bonus.retryMin} min.`, "warn");
        return false;
      }
      if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) return false;
      if (now < (st.nextTry || 0)) return false;
      const why = Human.economyAllowed(s);
      if (why) {
        const playing = Date.now() - (Store.get("manual_at", 0) || 0) < 10 * 6e4;
        if (!(playing && /godziny ciszy|okno nocne|przerw/i.test(why)) && !/grasz —/.test(why)) {
          if (!Once.said("bonus_wait|" + why.slice(0, 14), 60 * 6e4)) log(`[BONUS] nie odbieram teraz: ${why}.`, "info");
          return false;
        }
      }
      let el = this.find();
      let c = this.claimable(el);
      if (!c.ok && c.why === "brak przycisku") {
        const remote = await this.findRemote();
        if (remote && remote.getAttribute && remote.getAttribute("href")) {
          el = remote;
          c = this.claimable(remote);
          if (c.ok) {
            c.label = (c.label || "Online bonus") + " (widziany w /home)";
            c.remote = true;
          }
        } else if (!remote && this.probed) c = {
          ok: false,
          why: "bonus jeszcze nie wrócił (menu /home sprawdzone)"
        };
      }
      if (!c.ok) {
        if (c.wait) {
          st.nextTry = now + c.wait;
          this.save(st);
        }
        if (!Once.said("bonus|" + c.why, 60 * 6e4)) log(`[BONUS] nie odbieram: ${c.why}${c.wait ? ` — wracam za ${Math.round(c.wait / 6e4)} min` : " (spróbuję na następnej stronie)"}.`, "info");
        return false;
      }
      if (!Once.said("bonus_markup", 24 * 36e5)) log(`[BONUS DOM] ${el.outerHTML.replace(/\s+/g, " ").slice(0, 300)}`, "info");
      st.pending = now;
      this.save(st);
      const href = el.tagName === "A" ? el.getAttribute("href") || "" : "";
      if (c.remote && !href) {
        st.pending = 0;
        this.save(st);
        return false;
      }
      log(`[BONUS] odbieram bonus online („${c.label}").`, "success");
      if (href && href !== "#" && !/^javascript:/i.test(href)) {
        Nav.go(c.remote ? href : el.href || href, "bonus online (antymateria + punkty Akademii)");
        return true;
      }
      Nav.click(el, "bonus online (antymateria + punkty Akademii)");
      return true;
    }
  };
  const ExpoLink = {
    TTL: 7 * 24 * 36e5,
    get() {
      const v = Store.get("expo_link", null);
      if (!v || !v.mission) return null;
      if (Date.now() - (v.at || 0) > this.TTL) {
        Store.del("expo_link");
        log("[EXPO] link ekspedycji ma ponad tydzień — uczę się go od nowa (fork mógł przenumerować misje).", "info");
        return null;
      }
      return v;
    },
    learn() {
      if (page() !== "galaxy" || this.get()) return;
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== "16") continue;
        const a = item.querySelector("a[href*='/fleet']");
        if (!a) {
          log(`[EXPO] wiersz 16 bez linku /fleet — markup: ${item.innerHTML.replace(/\s+/g, " ").slice(0, 600)}`, "warn");
          return;
        }
        const href = a.getAttribute("href");
        const mission = (href.match(/[?&]mission=(\d+)/) || [])[1] || null;
        if (!mission) {
          const n = (Store.get("expo_link_fail", 0) || 0) + 1;
          Store.set("expo_link_fail", n);
          log(`[EXPO] wiersz 16 ma link /fleet BEZ parametru mission (${href}) — nie zapisuję niepełnego linku (próba ${n}). Markup: ${item.innerHTML.replace(/\s+/g, " ").slice(0, 600)}`, "warn");
          if (n >= 3 && !Once.said("expo_link_fail", 6 * 36e5)) Journal.add("EKO", `Nie umiem odczytać id misji ekspedycji z wiersza 16 galaktyki (${n} prób) — ekspedycje STOJĄ. Zrzut markupu jest w logu.`);
          return;
        }
        Store.set("expo_link", {
          href: href,
          mission: parseInt(mission),
          at: Date.now()
        });
        Store.del("expo_link_fail");
        log(`[EXPO] link ekspedycji wyuczony: ${href} (mission=${mission})`, "success");
        return;
      }
    }
  };
  function expoHomeBody(s, homeKey, pair, excl, now) {
    return pair && pair.hasMoon ? "moon" : "planet";
  }
  function expoPlan(s, cfg, now, burst) {
    const e = cfg.expo || {};
    if (!e.enabled) return {
      skip: "wyłączone"
    };
    if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) return {
      skip: "alarm — obrona ma pierwszeństwo"
    };
    if (flightsBlocking(s, now)) return {
      skip: "ratunek w powietrzu"
    };
    const homeKey = e.launchFrom ? key(e.launchFrom) : s.active && s.active.key;
    if (!homeKey) return {
      skip: "nie wiem, skąd startować"
    };
    const pair = (s.pairs || {})[homeKey];
    if (!pair) return {
      skip: `[${homeKey}] nie ma na pasku planet`
    };
    const excl = (e.excludeTypes || []).map(t => String(t).toUpperCase());
    const body = expoHomeBody(s, homeKey, pair, excl, now);
    const h = s.hangars[`${homeKey}|${body}`];
    if (!h || now - h.at > 15 * 6e4) return {
      skip: `hangar [${homeKey}] ${body} nieznany/stary — najpierw rekonesans`
    };
    const slotsFresh = s.slots && now - (s.slots.at || 0) < 30 * 6e4;
    const expoRaw = slotsFresh ? s.slots.expo : null, fleet = slotsFresh ? s.slots.fleet : null;
    const barFresh = s.bar && typeof s.bar.own === "number" && now - (s.bar.at || 0) < 5 * 6e4;
    const expo = expoRaw && barFresh && s.bar.own < expoRaw.used ? {
      ...expoRaw,
      used: s.bar.own,
      fromBar: true
    } : expoRaw;
    const cap = Math.max(1, Math.min(e.waves || 1, expo?.total || e.waves || 1));
    if (expo && expo.used >= cap) return {
      skip: `ekspedycje ${expo.used}/${expo.total} (limit fal ${cap}) — czekam na powroty`
    };
    const wOdstepie = !!(burst && burst.lastSendAt && now - burst.lastSendAt < (burst.gapMs || e.gapMinSec * 1e3));
    const avail = (h.ships || []).filter(x => x.qty > 0 && !excl.includes(String(x.type).toUpperCase()));
    if (!avail.length) {
      if (body === "moon") {
        const hp0 = (s.hangars || {})[`${homeKey}|planet`];
        const availP = (hp0 && hp0.ships || []).filter(x => x.qty > 0 && !excl.includes(String(x.type).toUpperCase()));
        const nP = availP.reduce((n, x) => n + x.qty, 0);
        const freshP = !!hp0 && now - (hp0.at || 0) < 30 * 6e4;
        if (nP > 0 && freshP) return {
          skip: `flota bazy stoi na PLANECIE [${homeKey}] (${nP.toLocaleString("pl-PL")} szt.), a ekspedycje startują tylko z księżyca — zwożę ją na księżyc`,
          ferry: {
            fromKey: homeKey,
            total: nP
          },
          stuck: true
        };
        if (!freshP) return {
          skip: `hangar [${homeKey}] moon pusty, a odczyt planety ${hp0 ? "jest stary" : "nigdy nie był robiony"} — sprawdzam, czy flota nie stoi na planecie`,
          needPlanet: true,
          stuck: true
        };
      }
      return {
        skip: "brak statków do wysłania (poza wykluczeniami)",
        stuck: true
      };
    }
    const waves = Math.max(1, e.waves || 1);
    const burstFresh = !!(burst && burst.lastSendAt && now - burst.lastSendAt < 3 * 36e5);
    const inSeries = burstFresh && burst.waves === waves && (burst.sent || 0) < waves ? burst.sent || 0 : 0;
    const freeSlots = expo && expo.total ? Math.max(1, cap - expo.used) : Infinity;
    const slotBound = freeSlots < waves - inSeries;
    const doma = avail.reduce((n, x) => n + x.qty, 0);
    const znane = (s.expected || []).filter(x => x.kind === "expedition" && x.fromKey === homeKey && (x.returnAt || 0) > now && (x.total || 0) > 0);
    const znanychSzt = znane.reduce((n, x) => n + x.total, 0);
    const lataGra = expo && expo.total ? expo.used : 0;
    const juzLata = Math.max(lataGra, inSeries);
    const wolne = Math.max(1, cap - juzLata);
    const wPowietrzu = znane.length ? lataGra > znane.length ? Math.round(znanychSzt / znane.length * lataGra) : znanychSzt : Math.round(doma / wolne * (cap - wolne));
    const docelowa = (doma + wPowietrzu) / cap;
    const left = Math.max(1, doma / Math.max(1e-9, docelowa));
    if (wOdstepie && !(doma >= 2 * docelowa && lataGra * 2 >= cap)) return {
      skip: "odstęp między falami"
    };
    const flota = doma + wPowietrzu;
    const flotaSpadek = burst && burst.flota > 0 && burstFresh && flota < .95 * burst.flota ? burst.flota : 0;
    const ostatniSlot = !!(expo && expo.total) && lataGra >= cap - 1;
    const bierzeWszystko = doma <= docelowa * 1.01 || ostatniSlot;
    const docelowaSzt = Math.max(1, Math.round(docelowa));
    const share = qty => qty < left ? qty : Math.floor(qty / left);
    const ships = avail.map(x => ({
      type: x.type,
      qty: bierzeWszystko ? x.qty : share(x.qty)
    })).filter(x => x.qty > 0);
    if (!ships.length) return {
      skip: `flota za mała na ${waves} fal (udział fali ${docelowaSzt.toLocaleString("pl-PL")} szt.) — zmniejsz liczbę fal`
    };
    {
      const sumaFali = ships.reduce((n, x) => n + x.qty, 0);
      const wLocie = (s.expected || []).filter(x => x.kind === "expedition" && x.fromKey === homeKey && (x.returnAt || 0) > now).map(x => x.total || 0);
      const najw = wLocie.length ? Math.max(...wLocie) : 0;
      if (najw > 0 && sumaFali * 100 < najw) return {
        skip: `resztka ${sumaFali.toLocaleString("pl-PL")} szt. (fala w locie z tej bazy: ${najw.toLocaleString("pl-PL")}) — nie zajmuję slotu, czekam na powroty`
      };
    }
    const takesAll = avail.every(a => (ships.find(x => x.type === a.type)?.qty || 0) >= a.qty);
    const fleetElsewhere = Object.entries(s.hangars || {}).some(([kk, hh]) => kk !== `${homeKey}|${body}` && (hh?.total || 0) > 0 && now - (hh.at || 0) < 48 * 36e5);
    if ((!takesAll || fleetElsewhere) && fleet && fleet.total && fleet.total - fleet.used <= (e.slotReserve || 0)) {
      return {
        skip: `wolne sloty floty ≤ rezerwa (${e.slotReserve}) — fala zostawiłaby flotę bez slotu na ucieczkę`
      };
    }
    const [g, sy] = homeKey.split(":");
    const lastWhy = !bierzeWszystko ? "" : waves === 1 ? "seria = 1 fala" : ostatniSlot && doma > docelowa * 1.01 ? `ostatni wolny slot ekspedycji (${expo.used}/${expo.total}) — cały hangar ${doma.toLocaleString("pl-PL")} szt., udział fali ${docelowaSzt.toLocaleString("pl-PL")} szt.` : doma <= docelowa ? `hangar ${doma.toLocaleString("pl-PL")} szt. nie przekracza udziału jednej fali (${docelowaSzt.toLocaleString("pl-PL")} szt.)` : `hangar ${doma.toLocaleString("pl-PL")} szt. = udział fali (${docelowaSzt.toLocaleString("pl-PL")} szt.) z dokładnością do 1% — resztki z zaokrągleń lecą razem`;
    const slotsTxt = expo ? `sloty ekspedycji ${expo.used}/${expo.total}${expo.fromBar ? ` (odczyt ${expoRaw.used}/${expoRaw.total} przycięty do ${s.bar.own} własnych lotów z paska)` : ""}` : "sloty nieznane";
    return {
      toKey: `${g}:${sy}:16`,
      fromKey: homeKey,
      fromBody: body,
      ships: ships,
      last: !!bierzeWszystko,
      waves: waves,
      left: left,
      slotBound: slotBound,
      lastWhy: lastWhy,
      slotsTxt: slotsTxt,
      docelowa: docelowaSzt,
      doma: doma,
      wPowietrzu: wPowietrzu,
      cap: cap,
      flota: flota,
      flotaSpadek: flotaSpadek,
      ostatniSlot: ostatniSlot,
      duration: {
        minutes: e.discoverer40 ? 40 : 0,
        hours: Math.max(1, e.holdingHours || 1)
      }
    };
  }
  const Expo = {
    burst() {
      return Store.get("burst", null);
    },
    STALL_BENIGN: /wyłączone|odstęp między falami|alarm — obrona|ratunek w powietrzu|przerwa między seriami|resztka/,
    noteStall(p, now) {
      const kluczSkipu = String(p.skip || "").replace(/[\d\s.,]+/g, "#");
      const st = Store.get("expo_stall", null);
      const ciagly = !!(st && st.skip === kluczSkipu && st.since && now - (st.at || st.since) < 12 * 36e5);
      const since = ciagly ? st.since : now;
      if (!ciagly || now - (st.at || 0) > 6e4) Store.set("expo_stall", {
        skip: kluczSkipu,
        since: since,
        at: now
      });
      if (this.STALL_BENIGN.test(p.skip)) return;
      const limit = p.stuck ? 30 * 6e4 : 6 * 36e5;
      if (now - since < limit) return;
      if (Once.said("expo_stall_alarm", 6 * 36e5)) return;
      Journal.add("EKO", `Ekspedycje stoją od ${Math.round((now - since) / 6e4)} min: ${p.skip}. To priorytet nr 2 — sprawdź, gdzie stoi flota.`);
    },
    maybeReturnOperator(reason) {
      const r = Store.get("eco_return", null);
      if (!r) return false;
      if (!/czekam na powroty|brak statków/.test(String(reason || ""))) return false;
      Store.del("eco_return");
      if (Date.now() - (r.at || 0) > 30 * 6e4) return false;
      if ((Store.get("input_at", 0) || 0) !== (r.input || 0)) return false;
      let to = r.url;
      if (r.uuid && !/[?&]planet=/.test(to)) to += (to.includes("?") ? "&" : "?") + "planet=" + r.uuid;
      const here = location.pathname + location.search;
      if (here === to || here === r.url) return false;
      log(`[LOT] seria domknięta — wracam na stronę, na której byłeś (${r.url}).`, "info");
      Nav.go(to, "powrót na stronę operatora po serii ekspedycji");
      return true;
    },
    async tick(s) {
      ExpoLink.learn();
      if (Fly.mission() || !CFG.expo.enabled) return false;
      {
        const st = Store.get("cfg", null);
        if (st && st.expo && st.expo.enabled === false) {
          syncCfg();
          if (!CFG.expo.enabled) return false;
        }
      }
      const why = Human.economyAllowed(s);
      if (why) {
        if (!Once.said("human|" + why.slice(0, 12), 10 * 6e4)) log(`[EXPO] wstrzymane: ${why}`, "info");
        return false;
      }
      const now = Date.now();
      {
        const b0 = this.burst();
        if (b0 && b0.lastSendAt && now - b0.lastSendAt > 3 * 36e5) {
          Store.del("burst");
          log(`[EXPO] licznik serii sprzed ${Math.round((now - b0.lastSendAt) / 6e4)} min jest martwy (przerwa dłuższa niż 3 h) — nowa seria liczy się od pierwszej fali.`, "info");
        }
      }
      const b = this.burst();
      const p = expoPlan(s, CFG, now, b);
      if (p.skip) {
        this.noteStall(p, now);
        if (/hangar .* nieznany\/stary/.test(p.skip) && !Once.said("expo_pull", 6e4)) {
          const hk = CFG.expo.launchFrom ? key(CFG.expo.launchFrom) : s.active && s.active.key;
          const pr = hk ? (s.pairs || {})[hk] : null;
          const hb = expoHomeBody(s, hk, pr, (CFG.expo.excludeTypes || []).map(t => String(t).toUpperCase()), now);
          if (hk) {
            const got = await Hangar.scanRemote(hk, hb);
            if (got) {
              log(`[EXPO] dociągnąłem hangar [${hk}] ${hb} w tle (${got.total.toLocaleString("pl-PL")} szt.) — wysyłka w następnym przebiegu.`, "info");
              return false;
            }
          }
        }
        if (p.needPlanet && !Once.said("expo_pull_planet", 20 * 6e4)) {
          const hk = CFG.expo.launchFrom ? key(CFG.expo.launchFrom) : s.active && s.active.key;
          if (hk) {
            const got = await Hangar.scanRemote(hk, "planet");
            if (got) {
              log(`[EXPO] księżyc [${hk}] pusty — sprawdziłem w tle hangar PLANETY tej pary (${got.total.toLocaleString("pl-PL")} szt.).`, "info");
              return false;
            }
          }
        }
        if (p.ferry && !Fly.mission() && !Fly.blocked({
          fromKey: p.ferry.fromKey,
          toKey: p.ferry.fromKey
        }) && !Once.said(`expo_ferry|${p.ferry.fromKey}`, 30 * 6e4)) {
          log(`[EXPO] ${p.skip} — startuję zwóz [${p.ferry.fromKey}] planeta → księżyc (${p.ferry.total.toLocaleString("pl-PL")} szt.).`, "warn");
          if (Fly.start({
            kind: "home",
            fromKey: p.ferry.fromKey,
            fromBody: "planet",
            toKey: p.ferry.fromKey,
            toBody: "moon",
            why: "ciało startowe ekspedycji to księżyc, a flota stoi na planecie — zwożę ją do domu pary",
            speed: 100,
            recall: false,
            home: true
          })) {
            await Fly.tick();
            return true;
          }
        }
        this.maybeReturnOperator(p.skip);
        if (!Once.said("expo|" + p.skip.replace(/[\d\s.,]+/g, "#"), 10 * 6e4)) log(`[EXPO] ${p.skip}`, "info");
        return false;
      }
      Store.del("expo_stall");
      {
        const rMax = CFG.expo.restMaxMin ?? 0;
        const inSeries = b && b.waves && (b.sent || 0) > 0 && (b.sent || 0) < (p.waves || 1);
        if (rMax > 0 && !inSeries && b && (b.sent || 0) > 0) {
          const r = Store.get("expo_rest", null);
          if (!r) {
            const until = now + jitter(Math.min(CFG.expo.restMinMin ?? 0, rMax), rMax) * 6e4;
            Store.set("expo_rest", {
              until: until
            });
            log(`[EXPO] przerwa między seriami ~${Math.max(1, Math.round((until - now) / 6e4))} min — seria nie rusza jak w zegarku.`, "info");
            return false;
          }
          if (now < r.until) return false;
          Store.del("expo_rest");
        }
      }
      if (!Store.get("eco_return", null)) {
        const act0 = PlanetBar.active();
        const ea0 = act0 && PlanetBar.anchor(act0.key, act0.body);
        const mu0 = ea0 && (ea0.getAttribute("href") || "").match(/[?&]planet=([^&#"']+)/i);
        Store.set("eco_return", {
          url: location.pathname + location.search,
          uuid: mu0 ? mu0[1] : null,
          at: Date.now(),
          input: Store.get("input_at", 0) || 0
        });
      }
      const link = ExpoLink.get();
      if (!link || !link.mission) {
        if (page() === "galaxy") {
          ExpoLink.learn();
          return false;
        }
        if (Once.said("expo|golearn", 10 * 6e4)) return false;
        const [g, sy] = String(p.fromKey || "").split(":");
        if (!g || !sy) return false;
        log("[EXPO] nie znam jeszcze id misji ekspedycji — zaglądam raz na galaktykę bazy.", "info");
        NavRate.note();
        Nav.go(`/galaxy?x=${g}&y=${sy}`, "ekspedycje: nauka id misji z galaktyki");
        return true;
      }
      if (Fly.blocked({
        fromKey: p.fromKey,
        toKey: p.toKey
      })) {
        if (!Once.said(`expoblk|${p.fromKey}`, 5 * 6e4)) log(`[EXPO] trasa [${p.fromKey}]→[${p.toKey}] w karencji po nieudanym locie — czekam.`, "warn");
        return false;
      }
      const sent = b && b.waves === p.waves && !p.last ? (b.sent || 0) + 1 : p.last ? 0 : 1;
      const total = p.ships.reduce((n, x) => n + x.qty, 0);
      const started = Fly.start({
        kind: "expedition",
        fromKey: p.fromKey,
        fromBody: p.fromBody,
        toKey: p.toKey,
        toBody: "planet",
        why: `ekspedycja ${p.last ? `(cały hangar: ${p.lastWhy})` : `(fala ${sent}/${p.waves}, udział ${p.docelowa.toLocaleString("pl-PL")} szt. z floty ${(p.doma + p.wPowietrzu).toLocaleString("pl-PL")} szt.; w hangarze ${p.doma.toLocaleString("pl-PL")}, w powietrzu ${p.wPowietrzu.toLocaleString("pl-PL")})`} — ${total.toLocaleString("pl-PL")} szt., ${p.slotsTxt}`,
        speed: 100,
        plan: p.ships,
        takeAllExcept: p.last ? (CFG.expo.excludeTypes || []).slice() : null,
        shareCtx: p.last ? {
          wPowietrzu: p.wPowietrzu || 0,
          cap: p.cap || 1,
          lastSlot: !!p.ostatniSlot
        } : null,
        missionType: "EXPEDITION",
        takeResources: false,
        duration: p.duration,
        missionId: link.mission
      });
      if (!started) return false;
      if (p.flotaSpadek && !Once.said("expo|flota-spadek", 30 * 6e4)) log(`[EXPO] flota ekspedycyjna spadła z ${p.flotaSpadek.toLocaleString("pl-PL")} do ${p.flota.toLocaleString("pl-PL")} szt. między dwoma planami — albo ekspedycja straciła flotę, albo rejestr powrotów zgubił falę (lądowanie w sekundzie wysyłki). Sprawdź listę ruchów flot: lot dużo mniejszy od reszty = rejestr.`, "warn");
      Store.set("burst", {
        waves: p.waves,
        sent: p.last ? 0 : sent,
        lastSendAt: now,
        gapMs: jitter(CFG.expo.gapMinSec, CFG.expo.gapMaxSec) * 1e3,
        flota: p.flota
      });
      return true;
    }
  };
  const Aster = {
    RANGES_URL: "/galaxy/Partial_AsteroidLocation",
    st() {
      return Store.get("aster", {
        ranges: [],
        rangesAt: 0,
        idx: 0,
        sys: null,
        lastScanAt: 0,
        sentAt: 0,
        sentTo: null
      }) || {};
    },
    save(v) {
      Store.set("aster", v);
    },
    parseRanges(html) {
      const coords = [];
      const re = /\[(\d+):(\d+):(\d+)\]/g;
      let m;
      while ((m = re.exec(html)) !== null) coords.push({
        galaxy: +m[1],
        system: +m[2]
      });
      const out = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        const a = coords[i], b = coords[i + 1];
        if (a.galaxy === b.galaxy) out.push({
          galaxy: a.galaxy,
          startSystem: Math.min(a.system, b.system),
          endSystem: Math.max(a.system, b.system)
        });
      }
      return out.sort((x, y) => x.galaxy - y.galaxy || x.startSystem - y.startSystem);
    },
    orderRanges(ranges, homeKey) {
      const byStart = (ranges || []).slice().sort((x, y) => x.galaxy - y.galaxy || x.startSystem - y.startSystem);
      const merged = [];
      for (const r of byStart) {
        const last = merged[merged.length - 1];
        if (last && last.galaxy === r.galaxy && r.startSystem <= last.endSystem + 1) last.endSystem = Math.max(last.endSystem, r.endSystem); else merged.push({
          galaxy: r.galaxy,
          startSystem: r.startSystem,
          endSystem: r.endSystem
        });
      }
      const [hg, hs] = String(homeKey || "").split(":").map(Number);
      if (!Number.isFinite(hg) || !Number.isFinite(hs)) return merged;
      const gap = r => r.endSystem < hs ? hs - r.endSystem : r.startSystem > hs ? r.startSystem - hs : 0;
      return merged.sort((a, b) => {
        const aSame = a.galaxy === hg, bSame = b.galaxy === hg;
        if (aSame !== bSame) return aSame ? -1 : 1;
        if (a.galaxy !== b.galaxy) return a.galaxy - b.galaxy;
        return gap(a) - gap(b) || a.startSystem - b.startSystem;
      });
    },
    async fetchRanges(homeKey) {
      try {
        const r = await fetchT(this.RANGES_URL, {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            Accept: "*/*"
          },
          credentials: "same-origin"
        });
        if (!r.ok) {
          log(`[ASTER] zakresy: HTTP ${r.status}`, "warn");
          return null;
        }
        const html = await r.text();
        if (looksLoggedOut(r, html)) {
          Session.lost();
          return null;
        }
        if (!/galaxy-asteroid-modal|asteroid-modal-desc|playerAste/i.test(html)) {
          log("[ASTER] odpowiedź to nie modal asteroid — pomijam.", "warn");
          return null;
        }
        const ranges = this.orderRanges(this.parseRanges(html), homeKey);
        log(ranges.length ? `[ASTER] zakresy (od najbliższego bazie${homeKey ? ` [${homeKey}]` : ""}): ${ranges.map(x => `[${x.galaxy}:${x.startSystem}-${x.endSystem}]`).join(", ")}` : "[ASTER] brak zakresów (zbadaj technologię / brak wyników).", "info");
        return ranges;
      } catch (e) {
        log(`[ASTER] zakresy: ${e.message}`, "warn");
        return null;
      }
    },
    readRow17(root = document, coords = null) {
      for (const item of root.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== "17") continue;
        const ttlEl = item.querySelector("[data-asteroid-disappear]");
        const ttl = ttlEl ? parseInt(ttlEl.getAttribute("data-asteroid-disappear") || "0", 10) || 0 : 0;
        const link = item.querySelector("a.btn-asteroid, a[href*='mission=12']");
        if (link) return {
          fleetUrl: link.getAttribute("href") || "",
          ttl: ttl
        };
        if (ttl > 0) {
          if (coords) return {
            fleetUrl: `/fleet?x=${coords.galaxy}&y=${coords.system}&z=17&mission=12`,
            ttl: ttl
          };
          const um = location.href.match(/[?&]x=(\d+)[\s\S]*?[?&]y=(\d+)/);
          return um ? {
            fleetUrl: `/fleet?x=${um[1]}&y=${um[2]}&z=17&mission=12`,
            ttl: ttl
          } : null;
        }
        return null;
      }
      return null;
    },
    GALAXY_DATA_URL: "/galaxy/galaxydata",
    async scanQuiet(target) {
      try {
        const rd = await fetchT(`${this.GALAXY_DATA_URL}?x=${target.galaxy}&y=${target.system}`, {
          credentials: "same-origin",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            Accept: "*/*"
          }
        }, 8e3);
        if (rd.ok) {
          const frag = await rd.text();
          if (looksLoggedOut(rd, frag)) {
            Session.lost();
            return {
              ok: false,
              why: "wylogowany"
            };
          }
          const fdoc = (new DOMParser).parseFromString(`<!doctype html><html><body>${frag}</body></html>`, "text/html");
          if (fdoc.querySelectorAll(".galaxy-item").length) return {
            ok: true,
            hit: this.readRow17(fdoc, target),
            via: "galaxydata"
          };
          if (!Once.said("aster_gdata_dom", 24 * 36e5)) log(`[ASTER DOM] /galaxy/galaxydata bez wierszy (.galaxy-item) — próbuję całej strony. Markup: ${frag.replace(/\s+/g, " ").slice(0, 800)}`, "warn");
        }
        const r = await fetchT(`/galaxy?x=${target.galaxy}&y=${target.system}`, {
          credentials: "same-origin",
          headers: {
            Accept: "text/html"
          }
        }, 8e3);
        if (!r.ok) return {
          ok: false,
          why: `HTTP ${r.status}`
        };
        const html = await r.text();
        if (looksLoggedOut(r, html)) {
          Session.lost();
          return {
            ok: false,
            why: "wylogowany"
          };
        }
        const doc = (new DOMParser).parseFromString(html, "text/html");
        const rows = doc.querySelectorAll(".galaxy-item").length;
        if (!rows) {
          if (!Once.said("aster_quiet_dom", 24 * 36e5)) log(`[ASTER DOM] strona galaktyki pobrana w tle nie ma wierszy (.galaxy-item) — skanuję nawigacją. Markup: ${html.replace(/\s+/g, " ").slice(0, 1200)}`, "warn");
          return {
            ok: false,
            why: "brak wierszy"
          };
        }
        return {
          ok: true,
          hit: this.readRow17(doc, target)
        };
      } catch (e) {
        return {
          ok: false,
          why: e && e.message || "błąd"
        };
      }
    },
    JOURNAL_URL: "/home/Partial_AsteroidJournal",
    async learnYield(st, now) {
      if (CFG.aster.expectedRes) return st;
      if (now - (st.yieldsAt || 0) < 30 * 6e4) return st;
      try {
        const r = await fetchT(this.JOURNAL_URL, {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            Accept: "*/*"
          },
          credentials: "same-origin"
        });
        if (!r.ok) return {
          ...st,
          yieldsAt: now
        };
        const html = await r.text();
        if (looksLoggedOut(r, html)) {
          Session.lost();
          return st;
        }
        const rows = html.split(/<\/tr>|<\/li>|<\/div>\s*<div/i);
        const out = [];
        for (const row of rows) {
          const nums = (row.replace(/<[^>]+>/g, " ").match(/\d{1,3}(?:[ .,]\d{3})+|\d{4,}/g) || []).map(x => parseInt(x.replace(/[^\d]/g, ""), 10)).filter(n => n >= 1e3);
          if (nums.length) out.push(nums.reduce((a, b) => a + b, 0));
        }
        if (!out.length) {
          if (!Once.said("aster_journal_dom", 24 * 36e5)) log(`[ASTER DOM] nie rozpoznaję dziennika asteroid — nie umiem oszacować urobku, więc lecą wszystkie minery. Markup: ${html.replace(/\s+/g, " ").slice(0, 1200)}`, "warn");
          return {
            ...st,
            yieldsAt: now
          };
        }
        const ys = out.slice(0, CFG.aster.sampleSize || 20);
        log(`[ASTER] dziennik: ${ys.length} raportów, mediana ${Math.round(ys.slice().sort((a, b) => a - b)[Math.floor(ys.length / 2)]).toLocaleString("pl-PL")} surowców.`, "info");
        return {
          ...st,
          yields: ys,
          yieldsAt: now
        };
      } catch (e) {
        return {
          ...st,
          yieldsAt: now
        };
      }
    },
    expected(st) {
      if (CFG.aster.expectedRes) return CFG.aster.expectedRes;
      const ys = (st.yields || []).slice().sort((a, b) => a - b);
      if (!ys.length) return 0;
      const i = Math.min(ys.length - 1, Math.floor((ys.length - 1) * (CFG.aster.percentile || 85) / 100));
      return ys[i];
    },
    size(st, available) {
      const cargo = CFG.aster.cargoPerMiner || st.cargo || 0;
      const exp = this.expected(st);
      const cap = Math.max(0, CFG.aster.maxMiners || 0);
      if (cap) {
        const qty = Math.min(available, cap);
        return {
          qty: qty,
          why: qty < cap ? `ilość z panelu ${cap.toLocaleString("pl-PL")}, w hangarze tylko ${available.toLocaleString("pl-PL")} — lecą wszystkie` : `ilość z panelu ${cap.toLocaleString("pl-PL")}`
        };
      }
      if (!cargo || !exp) return {
        qty: available,
        why: "brak danych o ładowni/urobku — lecą wszystkie"
      };
      const need = Math.ceil(exp * (CFG.aster.buffer || 1.15) / cargo);
      const qty = Math.max(CFG.aster.minMiners || 1, Math.min(available, need));
      return {
        qty: qty,
        need: need,
        why: `urobek ~${exp.toLocaleString("pl-PL")} × zapas ${CFG.aster.buffer} ÷ ${cargo.toLocaleString("pl-PL")}/miner = ${need}`
      };
    },
    freeSlots(s) {
      const f = s.slots && s.slots.fleet;
      if (!f || !f.total) return 1;
      return Math.max(0, f.total - f.used - (CFG.aster.slotReserve || 0));
    },
    learnCargo(m) {
      if (CFG.aster.cargoPerMiner) return;
      const st0 = Store.get("aster", {}) || {};
      if (st0.cargo) return;
      try {
        let t = (document.querySelector("#content, .content, form") || document.body).textContent || "";
        if (t.replace(/\s+/g, "").length < 50) t = document.body.textContent || t;
        const cm = t.match(/cargo\s*space[^\d]{0,20}[\d .,]*\/\s*([\d .,]+)/i) || t.match(/ładown[^\d]{0,20}[\d .,]*\/\s*([\d .,]+)/i) || t.match(/cargo\s*space[^\d]{0,20}([\d .,]+)/i) || t.match(/ładown[^\d]{0,20}([\d .,]+)/i);
        const qty = (m.plan || []).reduce((a, x) => a + (x.qty || 0), 0);
        if (!cm) {
          if (!Once.said("aster_cargo_dom", 24 * 36e5)) log("[ASTER DOM] nie widzę pojemności ładowni na formularzu — bez tego lecą wszystkie minery. Tekst: " + t.replace(/\s+/g, " ").slice(-400), "warn");
          return;
        }
        const cap = parseInt(String(cm[1]).replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(cap) || cap <= 0 || qty <= 0) return;
        const per = Math.floor(cap / qty);
        if (per <= 0) return;
        st0.cargo = per;
        Store.set("aster", st0);
        log("[ASTER] nauczone: 1 miner uniesie " + per.toLocaleString("pl-PL") + " surowców (" + cap.toLocaleString("pl-PL") + " na " + qty + " szt.).", "success");
      } catch {}
    },
    locked(st, key) {
      const l = (st.locks || {})[key] || 0;
      return l > Date.now();
    },
    lock(st, key) {
      const l = {
        ...st.locks || {}
      };
      for (const k of Object.keys(l)) if (l[k] < Date.now()) delete l[k];
      l[key] = Date.now() + (CFG.aster.lockMin || 60) * 6e4;
      return {
        ...st,
        locks: l
      };
    },
    tooFar(homeKey, target) {
      const cap = CFG.aster.maxFlightMin || 0;
      if (!cap || !homeKey) return false;
      const [hg, hs] = homeKey.split(":").map(Number);
      if (hg !== target.galaxy) return true;
      const est = Math.max(11, Math.ceil(11 + Math.abs(hs - target.system) / 15));
      return est > cap;
    },
    nextSystem(st) {
      const rs = st.ranges || [];
      if (!rs.length) return null;
      const r = rs[(st.idx || 0) % rs.length];
      const sys = st.sys && st.sys >= r.startSystem && st.sys <= r.endSystem ? st.sys : r.startSystem;
      return {
        galaxy: r.galaxy,
        system: sys,
        range: r
      };
    },
    nextRange(st) {
      const rs = st.ranges || [];
      if (!rs.length) return st;
      return {
        ...st,
        idx: ((st.idx || 0) + 1) % rs.length,
        sys: null
      };
    },
    advance(st) {
      const rs = st.ranges || [];
      if (!rs.length) return st;
      const r = rs[(st.idx || 0) % rs.length];
      const nx = (st.sys || r.startSystem) + 1;
      if (nx > r.endSystem) return {
        ...st,
        idx: ((st.idx || 0) + 1) % rs.length,
        sys: null
      };
      return {
        ...st,
        sys: nx
      };
    },
    async tick(s) {
      if (!CFG.aster.enabled || Fly.mission()) return false;
      const why = Human.economyAllowed(s);
      if (why) {
        if (!Once.said("aster|" + why.slice(0, 12), 10 * 6e4)) log(`[ASTER] wstrzymane: ${why}`, "info");
        return false;
      }
      if ((s.threats || []).some(t => t.attack && t.arriveAt > Date.now())) return false;
      let st = this.st();
      const now = Date.now();
      if (st.sentAt && now - st.sentAt < (CFG.aster.parallel ? CFG.aster.gapSec ?? 20 : 300) * 1e3) return false;
      if (now - (st.lastScanAt || 0) < (CFG.aster.scanGapSec ?? 6) * 1e3) return false;
      const homeKey = CFG.aster.launchFrom ? key(CFG.aster.launchFrom) : s.active && s.active.key;
      const homePair = homeKey ? (s.pairs || {})[homeKey] : null;
      if (homeKey && !homePair) {
        if (!Once.said("aster|nopair", 30 * 6e4)) log(`[ASTER] [${homeKey}] nie ma na pasku planet — nie zgaduję ciała startowego.`, "info");
        return false;
      }
      const homeBody = homePair && homePair.hasMoon ? "moon" : "planet";
      const hm = homeKey ? s.hangars[`${homeKey}|${homeBody}`] : null;
      const miners = hm ? (hm.ships || []).find(x => String(x.type).toUpperCase() === "ASTEROID_MINER") : null;
      if (!miners || miners.qty <= 0) {
        if (!Once.said("aster|nominers", 15 * 6e4)) log("[ASTER] brak minerów w hangarze bazy (albo są w locie) — nie skanuję.", "info");
        return false;
      }
      if (this.freeSlots(s) <= 0) {
        if (!Once.said("aster|slots", 10 * 6e4)) log(`[ASTER] wszystkie sloty floty zajęte (rezerwa ${CFG.aster.slotReserve}) — czekam na powroty.`, "info");
        return false;
      }
      st = await this.learnYield(st, now);
      const plan = this.size(st, miners.qty);
      if (plan.need && CFG.aster.partialRatio && miners.qty < plan.need * CFG.aster.partialRatio) {
        if (!Once.said("aster|partial", 10 * 6e4)) log(`[ASTER] w hangarze ${miners.qty} minerów, a sensowny lot to ${plan.need} — czekam na powroty (próg ${Math.round(CFG.aster.partialRatio * 100)}%).`, "info");
        return false;
      }
      if (!(st.ranges || []).length || now - (st.rangesAt || 0) > 30 * 6e4 || st.rangesHome !== (homeKey || null)) {
        const r = await this.fetchRanges(homeKey);
        if (!r) return false;
        st = {
          ...st,
          ranges: r,
          rangesAt: now,
          rangesHome: homeKey || null,
          idx: 0,
          sys: null
        };
        this.save(st);
        if (!r.length) return false;
      }
      if (st.idleUntil && now < st.idleUntil) return false;
      if (st.sys && now - (st.lastScanAt || 0) > (CFG.aster.rescanAfterSec ?? 180) * 1e3) st = {
        ...st,
        sys: null
      };
      let target = this.nextSystem(st);
      if (!target) return false;
      let skipped = 0;
      while (target && (this.tooFar(homeKey, target) || this.locked(st, `${target.galaxy}:${target.system}`))) {
        st = this.advance(st);
        skipped++;
        if (skipped > 60) {
          st.idleUntil = now + (CFG.aster.idleScanMin || 15) * 6e4;
          this.save(st);
          if (!Once.said("aster|idle", 30 * 6e4)) log(`[ASTER] cały obieg zakresów odpada (za daleko albo flota już tam leci) — pauza ${CFG.aster.idleScanMin} min.`, "info");
          return false;
        }
        target = this.nextSystem(st);
      }
      if (!target) return false;
      if (skipped) this.save(st);
      const handle = (hit, tgt) => {
        st = {
          ...this.advance(st),
          lastScanAt: now
        };
        if (!(hit && hit.fleetUrl)) {
          this.save(st);
          return "next";
        }
        const min = Math.max(60, CFG.aster.minTtlSec || 300);
        if (hit.ttl && hit.ttl < min) {
          log(`[ASTER] [${tgt.galaxy}:${tgt.system}:17] znika za ${hit.ttl}s — za mało czasu, skanuję dalej.`, "info");
          this.save(st);
          return "next";
        }
        log(`[ASTER] ZNALEZIONA asteroida [${tgt.galaxy}:${tgt.system}:17] (TTL ${hit.ttl || "?"}s) — wysyłam ${plan.qty.toLocaleString("pl-PL")} z ${miners.qty.toLocaleString("pl-PL")} minerów (${plan.why}).`, "success");
        st = this.nextRange(st);
        this.save(this.lock({
          ...st,
          sentAt: now,
          sentTo: `${tgt.galaxy}:${tgt.system}:17`
        }, `${tgt.galaxy}:${tgt.system}`));
        const astKey = `${tgt.galaxy}:${tgt.system}:17`;
        if (Fly.blocked({
          fromKey: homeKey,
          toKey: astKey
        })) {
          if (!Once.said(`astblk|${astKey}`, 5 * 6e4)) log(`[ASTER] trasa [${homeKey}]→[${astKey}] w karencji po nieudanym locie — czekam.`, "warn");
          return "sent";
        }
        Fly.start({
          kind: "asteroid",
          fromKey: homeKey,
          fromBody: homeBody,
          toKey: astKey,
          toBody: "planet",
          why: `mining asteroidy [${astKey}]`,
          speed: 100,
          plan: [ {
            type: "ASTEROID_MINER",
            qty: plan.qty
          } ],
          missionType: "ASTEROID",
          takeResources: false,
          missionId: 12,
          directUrl: hit.fleetUrl,
          ttl: hit.ttl || 0,
          ttlAt: now
        });
        return "sent";
      };
      const onThat = page() === "galaxy" && new RegExp(`[?&]x=${target.galaxy}(?:&|$)`).test(location.search) && new RegExp(`[?&]y=${target.system}(?:&|$)`).test(location.search);
      if (onThat) return handle(this.readRow17(), target) === "sent";
      const quietOk = !(st.quietBroken2At && now - st.quietBroken2At < 30 * 6e4);
      if (quietOk) {
        const perTick = Math.max(1, CFG.aster.quietPerTick || 4);
        for (let i = 0; i < perTick && target; i++) {
          if (i) await new Promise(r => setTimeout(r, Math.max(500, (CFG.aster.quietGapMs || 2500) + Math.round(Math.random() * 1e3))));
          if (Fly.mission()) return true;
          const r = await this.scanQuiet(target);
          if (!r.ok) {
            if (r.why === "brak wierszy") {
              st = {
                ...st,
                quietBroken2At: now
              };
              this.save(st);
              break;
            }
            if (!Once.said("aster|quietfail", 10 * 6e4)) log(`[ASTER] cichy skan [${target.galaxy}:${target.system}] nie wyszedł (${r.why}) — spróbuję za chwilę.`, "info");
            this.save({
              ...st,
              lastScanAt: now
            });
            return false;
          }
          if (handle(r.hit, target) === "sent") return true;
          if (!Once.said("aster|quiet", 6 * 36e5)) log(`[ASTER] skan układów idzie w tle (bez przeładowań strony) — ${perTick} układy na przebieg.`, "info");
          target = this.nextSystem(st);
          while (target && (this.tooFar(homeKey, target) || this.locked(st, `${target.galaxy}:${target.system}`))) {
            st = this.advance(st);
            target = this.nextSystem(st);
            if (++skipped > 60) {
              target = null;
            }
          }
          if (skipped) this.save(st);
        }
        if (!st.quietBroken2At || now - st.quietBroken2At >= 30 * 6e4) return false;
        if (!target) return false;
      }
      this.save({
        ...st,
        lastScanAt: now
      });
      NavRate.note();
      Nav.go(`/galaxy?x=${target.galaxy}&y=${target.system}`, `mining: skan układu [${target.galaxy}:${target.system}]`);
      return true;
    }
  };
  const Debris = {
    findLink(baseKey) {
      const pos = parseInt((baseKey || "").split(":")[2] || "0") || 0;
      const wanted = [ 16, pos ].filter(Boolean);
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = parseInt(item.querySelector(".planet-index")?.textContent || "0") || 0;
        if (!wanted.includes(idx)) continue;
        const cell = item.querySelector(".col-debris, .galaxy-col.col-debris");
        if (!cell) continue;
        let amount = 0, tipHref = null, sawTip = false;
        for (const te of cell.querySelectorAll("[data-tooltip-content]")) {
          const raw = te.getAttribute("data-tooltip-content") || "";
          if (!/debris/i.test(raw)) continue;
          sawTip = true;
          try {
            const tdoc = (new DOMParser).parseFromString(raw, "text/html");
            const ta2 = tdoc.querySelector("a[href*='/fleet']");
            if (ta2 && !tipHref) tipHref = ta2.getAttribute("href");
            const txt = tdoc.body && tdoc.body.textContent || "";
            for (const mm of txt.matchAll(/\d{1,3}(?:[.,]\d{3})+/g)) amount += parseInt(String(mm[0]).replace(/[^\d]/g, ""), 10) || 0;
            if (!ta2 && !Once.said("debris_tip", 6 * 36e5)) log(`[ZŁOM] dymek pola złomu bez linku zbierania — pełna treść: ${raw.replace(/\s+/g, " ").slice(0, 1500)}`, "warn");
          } catch {}
        }
        const a = cell.querySelector("a[href*='/fleet']");
        if (a) return {
          href: a.getAttribute("href"),
          pos: idx,
          amount: amount
        };
        if (tipHref) return {
          href: tipHref,
          pos: idx,
          amount: amount,
          viaTip: true
        };
        const rel = cell.querySelector("[rel^='debris']")?.getAttribute("rel");
        const tip = rel ? document.getElementById(rel) : null;
        const ta = tip?.querySelector("a[href*='/fleet']");
        if (ta) return {
          href: ta.getAttribute("href"),
          pos: idx,
          amount: amount
        };
        if (!sawTip) continue;
        if (!Once.said("debris_dom", 6 * 36e5)) log(`[ZŁOM] pole złomu bez linku (poz. ${idx}) — markup: ${(cell.innerHTML || "").replace(/\s+/g, " ").slice(0, 500)}`, "info");
        const [g, sy] = (baseKey || "").split(":");
        return {
          href: `/fleet?x=${g}&y=${sy}&z=${idx}`,
          pos: idx,
          noLink: true,
          amount: amount,
          viaTip: true
        };
      }
      return null;
    },
    async tick(s) {
      if (!CFG.debris.enabled || Fly.mission()) return false;
      if (Human.economyAllowed(s, "debris")) return false;
      if ((s.threats || []).some(t => t.attack && t.arriveAt > Date.now())) return false;
      const now = Date.now();
      if ((s.expected || []).some(e => e.kind === "debris" && now < (e.sentAt || 0) + (e.flightMs || 0) + 6e4)) return false;
      const homeKey = CFG.expo && CFG.expo.launchFrom ? key(CFG.expo.launchFrom) : s.active && s.active.key;
      if (!homeKey) return false;
      const homePair = (s.pairs || {})[homeKey];
      if (!homePair) {
        if (!Once.said("debris|nopair", 30 * 6e4)) log(`[ZŁOM] [${homeKey}] nie ma na pasku planet — nie zgaduję ciała startowego.`, "info");
        return false;
      }
      const homeBody = homePair.hasMoon ? "moon" : "planet";
      const hm = s.hangars[`${homeKey}|${homeBody}`];
      const rec = hm ? (hm.ships || []).find(x => String(x.type).toUpperCase() === "RECYCLER") : null;
      if (!rec || rec.qty <= 0) return false;
      const [g, sy] = homeKey.split(":");
      const onGal = page() === "galaxy" && new RegExp(`[?&]x=${g}(?:&|$)`).test(location.search) && new RegExp(`[?&]y=${sy}(?:&|$)`).test(location.search);
      const last = Store.get("debris_at", 0) || 0;
      const goAt = Store.get("debris_go", 0) || 0;
      const arrived = onGal && now - goAt < 3 * 6e4;
      if (!arrived && now - last < (CFG.debris.everyMin || 20) * 6e4) return false;
      if (!onGal) {
        Store.set("debris_at", now);
        Store.set("debris_go", now);
        NavRate.note();
        Nav.go(`/galaxy?x=${g}&y=${sy}`, "złom: sprawdzam pole szczątków");
        return true;
      }
      Store.set("debris_at", now);
      Store.set("debris_go", 0);
      const hit = this.findLink(homeKey);
      if (!hit) return false;
      if (Fly.blocked({
        fromKey: homeKey,
        toKey: `${g}:${sy}:${hit.pos}`
      })) {
        if (!Once.said(`debblk|${hit.pos}`, 5 * 6e4)) log(`[ZŁOM] trasa [${homeKey}]→[${g}:${sy}:${hit.pos}] w karencji po nieudanym locie — czekam.`, "warn");
        return false;
      }
      if (hit.viaTip && !(hit.amount > 0)) {
        if (!Once.said(`debempty|${hit.pos}`, 30 * 6e4)) log(`[ZŁOM] poz. ${hit.pos}: dymek pola bez ilości surowców (pole puste albo nieczytelne) — nie wysyłam w ciemno.`, "info");
        return false;
      }
      const cargo = CFG.debris.cargoPerRecycler || 125e3;
      const qty = hit.amount > 0 ? Math.min(rec.qty, Math.max(1, Math.ceil(hit.amount * 1.1 / cargo))) : Math.max(1, Math.floor(rec.qty * (CFG.debris.unknownShare ?? .2)));
      log(`[ZŁOM] pole złomu na poz. ${hit.pos}${hit.amount ? ` (~${hit.amount.toLocaleString("pl-PL")} surowców)` : " (rozmiar nieznany)"} — wysyłam ${qty.toLocaleString("pl-PL")} z ${rec.qty.toLocaleString("pl-PL")} recyklerów.`, "success");
      return Fly.start({
        kind: "debris",
        fromKey: homeKey,
        fromBody: homeBody,
        toKey: `${g}:${sy}:${hit.pos}`,
        toBody: "debris",
        why: `zbieranie złomu [${g}:${sy}:${hit.pos}]`,
        speed: 100,
        plan: [ {
          type: "RECYCLER",
          qty: qty
        } ],
        missionType: "COLLECT",
        takeResources: false,
        directUrl: hit.href
      });
    }
  };
  const Farm = {
    DB_TTL_MS: 7 * 864e5,
    BAN_TTL_MS: 14 * 864e5,
    YIELD_TTL_MS: 30 * 864e5,
    SWEEP_REST_MS: 15 * 6e4,
    RANK_RX: /rank(?:ing)?\s*:?\s*(\d{1,3}(?:[.,  ]\d{3})+|\d+)/i,
    st() {
      return Store.get("farm", null) || {};
    },
    save(v) {
      Store.set("farm", v);
    },
    parseRanges(str) {
      const out = [];
      String(str || "").split(/[,;]/).forEach(part => {
        const m = part.trim().match(/^(\d+)\s*:\s*(\d+)\s*-\s*(\d+)$/);
        if (!m) return;
        const g = +m[1], a = Math.min(+m[2], +m[3]), b = Math.max(+m[2], +m[3]);
        if (b - a <= 500) out.push({
          galaxy: g,
          start: a,
          end: b
        });
      });
      return out;
    },
    parseRank(raw) {
      const m = this.RANK_RX.exec(String(raw || ""));
      if (!m) return null;
      const n = parseInt(m[1].replace(/\D/g, ""), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    rankOk(rank, maxRank) {
      if (!maxRank) return true;
      if (rank == null) return true;
      return rank <= maxRank;
    },
    readSystem(doc, galaxy, system, own) {
      const rows = [ ...doc.querySelectorAll(".galaxy-item") ];
      const all = [];
      for (const item of rows) {
        const pos = parseInt((item.querySelector(".planet-index")?.textContent || "").trim(), 10);
        if (!Number.isFinite(pos) || pos < 1 || pos > 15) continue;
        const text = (item.textContent || "").replace(/\s+/g, " ");
        const statuses = [ ...text.matchAll(/\(\s*([sinvpbI])\s*\)/g) ].map(x => x[1]);
        if (!(statuses.includes("i") || statuses.includes("I"))) continue;
        if (statuses.includes("v") || statuses.includes("p") || statuses.includes("b")) continue;
        const coord = `${galaxy}:${system}:${pos}`;
        if (own && own.has(coord)) continue;
        const attrText = [ item, ...item.querySelectorAll("[data-tooltip-content],[title],[data-title]") ].map(el => `${el.getAttribute?.("data-tooltip-content") || ""} ${el.getAttribute?.("title") || ""} ${el.getAttribute?.("data-title") || ""}`).join(" ").replace(/<[^>]*>/g, " ");
        const rank = this.parseRank(text) ?? this.parseRank(attrText);
        const nameM = text.match(/([^()]{2,32}?)\s*\(\s*[iI]\s*\)/);
        all.push({
          coord: coord,
          galaxy: galaxy,
          system: system,
          position: pos,
          rank: rank,
          name: nameM ? nameM[1].trim().slice(0, 24) : "?",
          html: String(item.innerHTML || "").replace(/\s+/g, " ").slice(0, 400)
        });
      }
      return {
        rows: rows.length,
        all: all
      };
    },
    db() {
      return Store.get("farm_db", {}) || {};
    },
    dbUpdate(galaxy, system, entries) {
      const db = this.db(), before = JSON.stringify(db), prefix = `${galaxy}:${system}:`, now = Date.now();
      for (const c of Object.keys(db)) if (c.startsWith(prefix)) delete db[c];
      for (const e of entries) db[e.coord] = {
        name: e.name || "?",
        rank: e.rank ?? null,
        seenAt: now
      };
      for (const c of Object.keys(db)) if ((db[c].seenAt || 0) < now - this.DB_TTL_MS) delete db[c];
      if (JSON.stringify(db) !== before) Store.set("farm_db", db);
    },
    done() {
      const ttl = Math.max(1, CFG.farm.targetCooldownMin || 180) * 6e4;
      return (Store.get("farm_done", []) || []).filter(e => Date.now() - (e.at || 0) < (CFG.farm.repeatEachSweep !== false ? 24 * 36e5 : ttl));
    },
    isDone(coord) {
      return this.done().some(e => e.coord === coord);
    },
    markDone(coord) {
      const d = this.done();
      d.push({
        coord: coord,
        at: Date.now()
      });
      Store.set("farm_done", d.slice(-3e3));
    },
    unmark(coord) {
      Store.set("farm_done", this.done().filter(e => e.coord !== coord));
    },
    bans() {
      const b = Store.get("farm_ban", {}) || {};
      const cut = Date.now() - this.BAN_TTL_MS;
      for (const c of Object.keys(b)) if ((b[c].at || 0) < cut) delete b[c];
      return b;
    },
    banned(coord) {
      return !!this.bans()[coord];
    },
    yields() {
      const y = Store.get("farm_yield", {}) || {};
      const cut = Date.now() - this.YIELD_TTL_MS;
      for (const c of Object.keys(y)) if ((y[c].at || 0) < cut) delete y[c];
      return y;
    },
    median(y) {
      const v = Object.values(y).map(e => e.p).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    },
    order(targets) {
      const y = this.yields(), floor = CFG.farm.minTargetProfit || 0;
      let t = targets.filter(x => !(floor > 0 && y[x.coord] && y[x.coord].p < floor));
      if (CFG.farm.sequential !== true) {
        const med = this.median(y);
        if (med != null) t = t.slice().sort((a, b) => ((y[b.coord] || {}).p ?? med) - ((y[a.coord] || {}).p ?? med));
      }
      return t;
    },
    eligibleSystems(ranges) {
      const db = this.db(), y = this.yields(), maxRank = CFG.farm.maxTargetRank || 0;
      const seen = new Set, out = [];
      for (const c of Object.keys(db)) {
        if (!this.rankOk(db[c].rank, maxRank) || this.banned(c)) continue;
        const [g, sy] = c.split(":").map(Number);
        if (!ranges.some(r => r.galaxy === g && sy >= r.start && sy <= r.end)) continue;
        const k = `${g}:${sy}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          galaxy: g,
          system: sy
        });
      }
      const sum = {};
      for (const c of Object.keys(y)) {
        const k = c.split(":").slice(0, 2).join(":");
        sum[k] = (sum[k] || 0) + y[c].p;
      }
      out.sort((a, b) => (sum[`${b.galaxy}:${b.system}`] || 0) - (sum[`${a.galaxy}:${a.system}`] || 0) || a.galaxy - b.galaxy || a.system - b.system);
      return out;
    },
    COMBAT_CANDIDATES: [ "/messages/messagedata?MessageCategoryType=FLEET_BATTLE_REPORT&page=1", "/messages/messagedata?MessageCategoryType=FLEET_COMBAT&page=1", "/messages/messagedata?MessageCategoryType=COMBAT&page=1", "/messages/messagedata?MessageCategoryType=COMBAT_REPORTS&page=1" ],
    parseCombat(text) {
      const out = [], marks = [], re = /Combat report:[^\[]{0,80}\[(\d+):(\d+):(\d+)\]/g;
      const num = x => {
        const n = parseInt(String(x).replace(/[^0-9]/g, ""), 10);
        return Number.isFinite(n) ? n : null;
      };
      let m;
      while (m = re.exec(text)) marks.push({
        start: m.index + m[0].length,
        idx: m.index,
        coord: `${m[1]}:${m[2]}:${m[3]}`
      });
      for (let i = 0; i < marks.length; i++) {
        let chunk = text.slice(marks[i].start, marks[i + 1] ? marks[i + 1].idx : marks[i].start + 1600);
        chunk = chunk.replace(/\d{1,2}\.\d{2}\.\d{4}[\s ]+\d{1,2}:\d{2}(:\d{2})?/g, " ");
        const resM = chunk.match(/Resources\s*:\s*([0-9][0-9.,\s ]*)/i);
        let losses = null;
        const pairRe = /([^:\n]{2,40}?)\s*:\s*([0-9][0-9.,\s ]*)/g;
        let pm;
        while (pm = pairRe.exec(chunk)) {
          if (/resources|debris/i.test(pm[1].trim())) continue;
          losses = num(pm[2]);
          break;
        }
        out.push({
          coord: marks[i].coord,
          losses: losses,
          resources: resM ? num(resM[1]) : null
        });
      }
      return out;
    },
    applyCombat(reports, label) {
      const b = Store.get("farm_ban", {}) || {};
      let n = 0;
      for (const r of reports) {
        if (r.losses == null || r.losses <= 0) continue;
        if (!b[r.coord]) {
          n++;
          log(`[FARMA BAN] [${r.coord}] — obrona rozbiła flotę (straty ${r.losses.toLocaleString("pl-PL")}, łup ${r.resources ?? "?"}). Ban 14 dni.`, "warn");
        }
        b[r.coord] = {
          at: Date.now(),
          losses: r.losses
        };
      }
      if (n) {
        Store.set("farm_ban", b);
        log(`[FARMA BAN] ${label}: +${n}, czarna lista ${Object.keys(this.bans()).length}.`, "warn");
      }
      return n;
    },
    parsePlunder(text) {
      const out = [], re = /(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2})[\s ]+([^\[\]()]{2,32}?)\s*\(\s*[a-zA-Z]\s*\)\s*\[(\d+):(\d+):(\d+)\][\s ]*\+[\s ]*([0-9]{1,3}(?:[.,\s ][0-9]{3})*)/g;
      let m;
      while (m = re.exec(text)) out.push({
        when: m[1],
        player: m[2].trim(),
        coord: `${m[3]}:${m[4]}:${m[5]}`,
        profit: parseInt(m[6].replace(/[^0-9]/g, ""), 10)
      });
      return out;
    },
    learnPlunder(rows, label) {
      const seenArr = Store.get("farm_yield_seen", []) || [], seen = new Set(seenArr), y = this.yields();
      let n = 0;
      for (const r of rows) {
        if (!Number.isFinite(r.profit) || r.profit < 0) continue;
        const k = `${r.coord}|${r.when}`;
        if (seen.has(k)) continue;
        seen.add(k);
        seenArr.unshift(k);
        const e = y[r.coord];
        y[r.coord] = {
          p: e ? Math.round(e.p * .5 + r.profit * .5) : r.profit,
          n: (e?.n || 0) + 1,
          at: Date.now(),
          player: r.player || e?.player || "?"
        };
        n++;
      }
      if (n) {
        Store.set("farm_yield", y);
        Store.set("farm_yield_seen", seenArr.slice(0, 4e3));
        log(`[FARMA ŁUP] ${label}: +${n} wpisów łupu (baza ${Object.keys(y).length} celów).`, "info");
      }
      return n;
    },
    harvest() {
      try {
        const panel = document.getElementById("ogx3-panel");
        let t = "";
        for (const n of document.body ? document.body.childNodes : []) {
          if (n === panel || n.nodeType === 1 && panel && n.contains(panel)) continue;
          t += " " + (n.textContent || "");
        }
        t = t.replace(/\s+/g, " ");
        if (/^\/messages/.test(location.pathname) && /Combat report:/i.test(t)) this.applyCombat(this.parseCombat(t), "strona wiadomości");
        if (/Plunder Journal/i.test(t)) this.learnPlunder(this.parsePlunder(t), "strona profilu");
      } catch {}
    },
    async watch() {
      const now = Date.now();
      if (now - (Store.get("farm_combat_at", 0) || 0) >= 10 * 6e4) {
        Store.set("farm_combat_at", now);
        const known = Store.get("farm_combat_url", "");
        let ok = false;
        const ci = Store.get("farm_combat_i", 0) || 0;
        if (!known) Store.set("farm_combat_i", ci + 1);
        for (const url of known ? [ known ] : [ this.COMBAT_CANDIDATES[ci % this.COMBAT_CANDIDATES.length] ]) {
          try {
            const r = await fetchT(url, {
              headers: {
                "X-Requested-With": "XMLHttpRequest"
              },
              credentials: "same-origin"
            });
            if (!r.ok) continue;
            const html = await r.text();
            if (looksLoggedOut(r, html)) {
              Session.lost();
              return;
            }
            const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
            if (!/Combat report:/i.test(text)) continue;
            if (!known) {
              Store.set("farm_combat_url", url);
              log(`[FARMA BAN] endpoint raportów bojowych potwierdzony: ${url}`, "info");
            }
            this.applyCombat(this.parseCombat(text), "raporty (fetch)");
            ok = true;
            break;
          } catch {}
        }
        if (!ok && !known && ci >= this.COMBAT_CANDIDATES.length && !Once.said("farm_combat_probe", 24 * 36e5)) log("[FARMA BAN] żaden adres raportów bojowych nie dał „Combat report:” — bany zbieram ze strony wiadomości (wejdź czasem w Combat reports).", "warn");
      }
      if (now - (Store.get("farm_plunder_at", 0) || 0) >= 15 * 6e4) {
        Store.set("farm_plunder_at", now);
        try {
          const r = await fetchT("/home/Partial_PlunderJournal", {
            headers: {
              "X-Requested-With": "XMLHttpRequest"
            },
            credentials: "same-origin"
          });
          if (r.ok) {
            const html = await r.text();
            const rows = this.parsePlunder(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
            if (rows.length) this.learnPlunder(rows, "dziennik (fetch)"); else if (!Once.said("farm_plunder_dom", 24 * 36e5)) log(`[FARMA ŁUP DOM] dziennik grabieży bez wierszy — zrzut: ${html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 600)}`, "warn");
          }
        } catch {}
      }
    },
    reserve() {
      return Math.max(1, CFG.farm.slotReserve ?? 2) + (CFG.expo.enabled || CFG.aster.enabled || CFG.debris.enabled ? 1 : 0) + (CFG.fs.enabled ? Math.max(1, CFG.fs.slotReserve ?? 1) + 1 : 0);
    },
    freeSlots(s, now) {
      const f = s.slots && s.slots.fleet;
      if (!f || !f.total || now - (s.slots.at || 0) > 30 * 6e4) return (s.expected || []).some(e => e.kind === "farm" && (e.pending || (e.returnAt || 0) > now)) ? 0 : 1;
      const poOdczycie = (s.expected || []).filter(e => (e.sentAt || 0) > (s.slots.at || 0) && (e.returnAt || 0) > now).length;
      return f.total - f.used - poOdczycie - this.reserve();
    },
    nextReturn(s, fromKey, now) {
      const r = (s.expected || []).filter(e => e.kind === "farm" && e.fromKey === fromKey && (e.returnAt || 0) > now).map(e => e.returnAt).sort((a, b) => a - b);
      return r[0] || 0;
    },
    pause(ms, why, unmarkCoord) {
      const st = this.st();
      st.pauseUntil = Date.now() + ms;
      st.pauseWhy = why;
      this.save(st);
      if (unmarkCoord) this.unmark(unmarkCoord);
      if (!Once.said("farm_pause|" + String(why).slice(0, 20), 10 * 6e4)) log(`[FARMA] pauza ${Math.max(1, Math.round(ms / 6e4))} min: ${why}.`, "warn");
    },
    formOk(m, els) {
      const typ = String(CFG.farm.shipType || "").toUpperCase();
      const el = els.find(e => String(e.dataset.shipType || "").toUpperCase() === typ);
      const have = el ? parseInt(el.dataset.shipQuantity || "0") || 0 : 0;
      const need = m.plan && m.plan[0] && m.plan[0].qty || 0;
      if (have < need) {
        this.noShips(m, have);
        return false;
      }
      const s = Situation.load();
      const f = s.slots && s.slots.fleet;
      if (f && f.total && Date.now() - (s.slots.at || 0) < 6e4 && f.total - f.used - this.reserve() <= 0) {
        const s2 = Situation.load(), nr = this.nextReturn(s2, m.fromKey, Date.now());
        this.pause(Math.min(10 * 6e4, Math.max(3e4, (nr || Date.now() + 6e4) - Date.now() + 5e3)), `sloty floty ${f.used}/${f.total}, rezerwa ${this.reserve()} dla ratunku — czekam na powrót ataku`, m.toKey);
        return false;
      }
      return true;
    },
    noShips(m, have) {
      const s = Situation.load(), nr = this.nextReturn(s, m.fromKey, Date.now());
      const typ = CFG.farm.shipType;
      this.pause(Math.min(15 * 6e4, Math.max(3e4, (nr || Date.now() + 10 * 6e4) - Date.now() + 5e3)), `na [${m.fromKey}] ${m.fromBody} stoi ${have.toLocaleString("pl-PL")} ${typ}, a atak to ${(CFG.farm.perAttack || 0).toLocaleString("pl-PL")} — ${nr ? "czekam na powrót floty farmy" : "brak floty farmy w drodze"}`, m.toKey);
    },
    sent(m, what) {
      const d = (new Date).toISOString().slice(0, 10), st = Store.get("farm_stats", null);
      Store.set("farm_stats", {
        day: d,
        n: (st && st.day === d ? st.n : 0) + 1,
        last: m.toKey,
        at: Date.now()
      });
      Store.set("farm_restore", {
        from: m.fromKey,
        at: Date.now()
      });
      try {
        this.restoreSession(Situation.load(), {
          key: m.fromKey
        }).catch(() => {});
      } catch {}
      log(`[FARMA] atak wysłany: ${what} → [${m.toKey}]`, "success");
    },
    launch(s) {
      const lf = CFG.farm.launchFrom;
      if (!lf) return null;
      const k = key(lf), p = (s.pairs || {})[k];
      if (!p) return {
        missing: k
      };
      return {
        key: k,
        body: p.hasMoon ? "moon" : "planet"
      };
    },
    async restoreSession(s, lp) {
      const r = Store.get("farm_restore", null);
      if (!r) return;
      Store.del("farm_restore");
      const now = Date.now();
      let best = null;
      for (const [hk, h] of Object.entries(s.hangars || {})) {
        const [k, b] = hk.split("|");
        if (k === lp.key || !h || !(h.total > 0) || now - (h.at || 0) > 6 * 36e5 || !(s.pairs || {})[k]) continue;
        if (!best || h.total > best.total) best = {
          key: k,
          body: b,
          total: h.total
        };
      }
      if (!best && CFG.expo.launchFrom && key(CFG.expo.launchFrom) !== lp.key && (s.pairs || {})[key(CFG.expo.launchFrom)]) best = {
        key: key(CFG.expo.launchFrom),
        body: s.pairs[key(CFG.expo.launchFrom)].hasMoon ? "moon" : "planet"
      };
      if (!best) return;
      const el = PlanetBar.anchor(best.key, best.body) || PlanetBar.anchor(best.key, "planet");
      const mm = el && (el.getAttribute("href") || "").match(/[?&]planet=([^&#"']+)/i);
      if (!mm) {
        if (!Once.said("farm_restore_nouuid", 6 * 36e5)) log(`[FARMA] nie umiem przywrócić sesji na [${best.key}] (brak linku na pasku planet) — lista ruchów pokazuje teraz bazę farmy.`, "warn");
        return;
      }
      const ok = await Hangar.restoreActive(mm[1]);
      if (!Once.said("farm_restore_log", 30 * 6e4)) log(ok ? `[FARMA] po ataku sesja wraca na [${best.key}] ${best.body} (tam stoi flota) — lista ruchów pilnuje bazy, nie farmy.` : `[FARMA] NIE przywróciłem sesji na [${best.key}] — lista ruchów pokazuje bazę farmy.`, ok ? "info" : "warn");
    },
    onGalaxy(g, sy) {
      return page() === "galaxy" && new RegExp(`[?&]x=${g}(?:&|$)`).test(location.search) && new RegExp(`[?&]y=${sy}(?:&|$)`).test(location.search);
    },
    go(g, sy, why) {
      Nav.go(`/galaxy?x=${g}&y=${sy}`, `farma: ${why} [${g}:${sy}]`);
    },
    finish(st, why) {
      if (st.mode !== "lap") {
        Store.set("farm_last_full", Date.now());
        Store.set("farm_stale_lap", false);
      }
      const db = this.db(), maxRank = CFG.farm.maxTargetRank || 0;
      const w = Object.keys(db).filter(c => this.rankOk(db[c].rank, maxRank)).length;
      log(`[FARMA] ${st.mode === "lap" ? "okrążenie po bazie" : "pełny skan"} zakończony (${why}): ${st.scanned || 0} układów, baza ${Object.keys(db).length} nieaktywnych (${w} w limicie rankingu), czarna lista ${Object.keys(this.bans()).length}. Następny przebieg za ${Math.round(this.SWEEP_REST_MS / 6e4)} min.`, "info");
      if (st.unknownRank) log(`[FARMA] ${st.unknownRank} cel(ów) bez odczytanego rankingu — filtr ich nie ogranicza. Zrzut wiersza: [FARMA RANK DOM].`, "warn");
      this.save({
        restUntil: Date.now() + this.SWEEP_REST_MS
      });
    },
    attack(s, lp, t, st) {
      const qty = Math.max(1, parseInt(CFG.farm.perAttack, 10) || 0);
      const toKey = t.coord;
      if (Fly.blocked({
        fromKey: lp.key,
        toKey: toKey
      })) {
        if (!Once.said(`farmblk|${toKey}`, 5 * 6e4)) log(`[FARMA] trasa [${lp.key}]→[${toKey}] w karencji po nieudanym locie — biorę następny cel.`, "info");
        this.markDone(toKey);
        return false;
      }
      this.markDone(toKey);
      const y = this.yields()[toKey];
      const ok = Fly.start({
        kind: "farm",
        fromKey: lp.key,
        fromBody: lp.body,
        toKey: toKey,
        toBody: "planet",
        why: `farma: atak na [${toKey}]${t.rank ? ` (rank ${t.rank})` : ""}${y ? `, średni łup ${y.p.toLocaleString("pl-PL")}` : ""}`,
        speed: 100,
        plan: [ {
          type: CFG.farm.shipType,
          qty: qty
        } ],
        missionType: "ATTACK",
        takeResources: false
      });
      if (!ok) {
        this.unmark(toKey);
        return false;
      }
      if (!Once.said("farm_row_dom", 24 * 36e5) && t.html) log(`[FARMA DOM] pierwszy wiersz celu: ${String(t.html).replace(/\s+/g, " ").slice(0, 500)}`, "info");
      return true;
    },
    status(now = Date.now()) {
      const c = CFG.farm;
      if (!c.enabled) return "wyłączona";
      if (!c.launchFrom) return "ustaw „start z” (g:s:p)";
      if (!(c.perAttack > 0)) return "wpisz sztuk na atak";
      if (!this.parseRanges(c.ranges).length) return "wpisz zakresy (np. 2:1-499)";
      const st = this.st(), stats = Store.get("farm_stats", null), d = (new Date).toISOString().slice(0, 10);
      const dzis = stats && stats.day === d ? stats.n : 0;
      const bits = [ `dziś ${dzis} ataków` ];
      if (st.pauseUntil > now) bits.unshift(`pauza ${Math.ceil((st.pauseUntil - now) / 6e4)} min: ${st.pauseWhy || ""}`); else if (st.active) bits.unshift(`${st.mode === "lap" ? "okrążenie" : "pełny skan"} ${st.scanned || 0}/${st.total || 0} · w kolejce ${(st.targets || []).length}`); else if (st.restUntil > now) bits.unshift(`przerwa ${Math.ceil((st.restUntil - now) / 6e4)} min`);
      bits.push(`baza ${Object.keys(this.db()).length}`, `ban ${Object.keys(this.bans()).length}`);
      return bits.join(" · ");
    },
    async tick(s) {
      const c = CFG.farm;
      if (!c || !c.enabled || Fly.mission()) return false;
      {
        const lp0 = this.launch(s);
        if (lp0 && !lp0.missing) await this.restoreSession(s, lp0);
      }
      this.harvest();
      const why = Human.economyAllowed(s, "farm");
      if (why) {
        if (!Once.said("farm|" + why.slice(0, 12), 10 * 6e4)) log(`[FARMA] wstrzymana: ${why}`, "info");
        return false;
      }
      if ((s.threats || []).some(t => t.attack && t.arriveAt > Date.now())) return false;
      const now = Date.now();
      if (s.barExcess && s.barExcess.count > 0) {
        if (!Once.said("farm|bar", 5 * 6e4)) log("[FARMA] wstrzymana: na pasku misji są obce loty, których lista nie tłumaczy (ślepy alarm).", "info");
        return false;
      }
      if (now - (Store.get("list_ok_at", 0) || 0) > 2 * 6e4) {
        if (!Once.said("farm|list", 10 * 6e4)) log("[FARMA] wstrzymana: lista ruchów flot nie odpowiada od ponad 2 min — obrona jest częściowo ślepa.", "warn");
        return false;
      }
      if (Session.lostRecently && Session.lostRecently()) return false;
      const lp = this.launch(s);
      if (!lp) {
        if (!Once.said("farm|nofrom", 30 * 6e4)) log("[FARMA] brak „start z” w panelu — nie zgaduję, skąd lecą ataki (decyzja ownera: start ustawiany ręcznie).", "warn");
        return false;
      }
      if (lp.missing) {
        if (!Once.said("farm|nopair", 30 * 6e4)) log(`[FARMA] [${lp.missing}] nie ma na pasku planet — popraw „start z”.`, "warn");
        return false;
      }
      if ((s.moonLost || {})[lp.key] || (s.moonGone || {})[lp.key] && !((s.pairs || {})[lp.key] || {}).hasMoon) {
        if (!Once.said("farm|moonlost", 30 * 6e4)) log(`[FARMA] wstrzymana: baza farmy [${lp.key}] straciła księżyc — nie latam z widocznej planety.`, "warn");
        return false;
      }
      if (!(c.perAttack > 0)) {
        if (!Once.said("farm|noqty", 30 * 6e4)) log("[FARMA] wpisz w panelu, ile statków leci na jeden atak.", "warn");
        return false;
      }
      if (CFG.expo.enabled && CFG.expo.launchFrom && key(CFG.expo.launchFrom) === lp.key && !(CFG.expo.excludeTypes || []).includes(String(c.shipType).toUpperCase()) && !Once.said("farm|expo", 6 * 36e5)) log(`[FARMA] start farmy [${lp.key}] = baza ekspedycji — fale ekspedycji zabierają też ${c.shipType}, więc atakom zabraknie statków. Lepiej ustaw „start z” na innym księżycu.`, "warn");
      const ranges = this.parseRanges(c.ranges);
      if (!ranges.length) {
        if (!Once.said("farm|norange", 30 * 6e4)) log(`[FARMA] brak poprawnych zakresów („${c.ranges || ""}”) — wpisz np. 2:1-499.`, "warn");
        return false;
      }
      let st = this.st();
      if (st.pauseUntil && now < st.pauseUntil) return false;
      await this.watch();
      if (Fly.mission()) return true;
      const own = new Set(Object.keys(s.pairs || {}));
      const wolne = this.freeSlots(s, now);
      if (st.active) {
        const czeka = (st.targets || []).filter(t => !this.isDone(t.coord) && !this.banned(t.coord));
        if (czeka.length) {
          if (wolne <= 0) {
            const nr = this.nextReturn(s, lp.key, now);
            if (!Once.said("farm|slots", 10 * 6e4)) log(`[FARMA] sloty floty zajęte (rezerwa ${this.reserve()} dla ratunku) — ${czeka.length} cel(e) czekają${nr ? `, najbliższy powrót ~${new Date(nr).toLocaleTimeString("pl-PL", {
              hour: "2-digit",
              minute: "2-digit"
            })}` : ""}.`, "info");
            return false;
          }
          const t = this.order(czeka)[0];
          if (!t) {
            st.targets = [];
            this.save(st);
            return false;
          }
          if (!this.onGalaxy(t.galaxy, t.system)) {
            this.go(t.galaxy, t.system, "wracam do układu celu");
            return true;
          }
          if (this.attack(s, lp, t, st)) {
            await Fly.tick();
            return true;
          }
          return false;
        }
        if ((st.targets || []).length) {
          st.targets = [];
          this.save(st);
        }
        const next = (st.queue || [])[0];
        if (!next) {
          this.finish(st, "kolejka pusta");
          return false;
        }
        if (!this.onGalaxy(next.galaxy, next.system)) {
          await sleep(jitter(800, 2500));
          this.go(next.galaxy, next.system, st.scanned ? "następny układ" : "start przebiegu");
          return true;
        }
        let rd = this.readSystem(document, next.galaxy, next.system, own);
        for (let i = 0; i < 10 && !rd.rows; i++) {
          await sleep(500);
          rd = this.readSystem(document, next.galaxy, next.system, own);
        }
        if (!rd.rows) {
          st.galWait = (st.galWait || 0) + 1;
          if (st.galWait < 3) {
            this.save(st);
            return false;
          }
          if (!Once.said("farm_gal_dom", 6 * 36e5)) log(`[FARMA DOM] galaktyka [${next.galaxy}:${next.system}] bez wierszy .galaxy-item po 3 próbach — pomijam układ. Fragment: ${((document.querySelector("#content, .content") || document.body).innerHTML || "").replace(/\s+/g, " ").slice(0, 600)}`, "warn");
        }
        st.galWait = 0;
        const maxRank = c.maxTargetRank || 0;
        let pomRank = 0, nieznany = 0, ban = 0;
        const cele = [];
        for (const e of rd.all) {
          if (maxRank > 0 && e.rank == null) {
            nieznany++;
            if (!Once.said("farm_rank_dom", 24 * 36e5)) log(`[FARMA RANK DOM] wiersz bez rankingu: ${String(e.html).replace(/\s+/g, " ").slice(0, 600)}`, "warn");
          }
          if (!this.rankOk(e.rank, maxRank)) {
            pomRank++;
            continue;
          }
          if (this.banned(e.coord)) {
            ban++;
            continue;
          }
          if (this.isDone(e.coord)) continue;
          cele.push({
            coord: e.coord,
            galaxy: e.galaxy,
            system: e.system,
            position: e.position,
            rank: e.rank,
            ...Once.said("farm_row_dom_keep", 24 * 36e5) ? {} : {
              html: e.html
            }
          });
        }
        if (rd.rows) this.dbUpdate(next.galaxy, next.system, rd.all);
        st.queue = st.queue.slice(1);
        st.scanned = (st.scanned || 0) + 1;
        st.unknownRank = (st.unknownRank || 0) + nieznany;
        st.targets = cele;
        this.save(st);
        if (cele.length) log(`[FARMA] [${next.galaxy}:${next.system}] ${cele.length} cel(e): ${cele.map(x => x.coord + (x.rank ? ` (rank ${x.rank})` : "")).join(", ")}${pomRank ? ` · ${pomRank} powyżej limitu rankingu` : ""}${ban ? ` · ${ban} na czarnej liście` : ""}`, "success");
        if (cele.length && wolne > 0) {
          const t = this.order(cele)[0];
          if (t && this.attack(s, lp, t, st)) {
            await Fly.tick();
            return true;
          }
        }
        if (cele.length) {
          if (!Once.said("farm|slots", 10 * 6e4)) log(`[FARMA] sloty floty zajęte (rezerwa ${this.reserve()} dla ratunku) — ${cele.length} cel(e) czekają na powrót ataku.`, "info");
          return false;
        }
        const nx = st.queue[0];
        if (!nx) {
          this.finish(st, "koniec zakresów");
          return false;
        }
        await sleep(jitter(800, 2500));
        this.go(nx.galaxy, nx.system, "następny układ");
        return true;
      }
      if (st.restUntil && now < st.restUntil) return false;
      const lastFull = Store.get("farm_last_full", 0) || 0;
      const dbFresh = now - lastFull < Math.max(1, c.dbRefreshHours || 12) * 36e5;
      let queue = null, mode = "full";
      if (c.sequential !== true && (dbFresh || !Store.get("farm_stale_lap", false))) {
        const sys = this.eligibleSystems(ranges);
        if (sys.length) {
          queue = sys;
          mode = "lap";
          if (!dbFresh) {
            Store.set("farm_stale_lap", true);
            log("[FARMA] pełny skan zaległy, ale baza zna cele — najpierw okrążenie po nich, pełny skan zaraz po.", "info");
          }
        }
      }
      if (!queue) {
        queue = [];
        for (const r of ranges) for (let sy = r.start; sy <= r.end; sy++) queue.push({
          galaxy: r.galaxy,
          system: sy
        });
      }
      if (c.repeatEachSweep !== false) Store.set("farm_done", []);
      st = {
        active: true,
        mode: mode,
        queue: queue,
        scanned: 0,
        total: queue.length,
        targets: [],
        unknownRank: 0,
        startedAt: now
      };
      this.save(st);
      log(mode === "lap" ? `[FARMA] okrążenie PO BAZIE: ${queue.length} układ(ów) ze znanymi celami${c.maxTargetRank ? ` (rank ≤ ${c.maxTargetRank})` : ""}; start z [${lp.key}] ${lp.body}, ${c.perAttack.toLocaleString("pl-PL")} × ${c.shipType} na atak.` : `[FARMA] pełny skan: ${queue.length} układów (${c.ranges}); start z [${lp.key}] ${lp.body}, ${c.perAttack.toLocaleString("pl-PL")} × ${c.shipType} na atak.`, "success");
      this.go(queue[0].galaxy, queue[0].system, "start przebiegu");
      return true;
    }
  };
  const Fly = {
    MISSIONS: [ "DEPLOY", "DEPLOYMENT", "STATION", "STATIONING" ],
    mission() {
      return Store.get("mission", null);
    },
    url(m) {
      if (m.directUrl) return m.directUrl;
      const [g, sy, po] = m.toKey.split(":");
      return `/fleet?x=${g}&y=${sy}&z=${po}${m.missionId ? "&mission=" + m.missionId : ""}`;
    },
    start(a) {
      if (this.mission()) return false;
      Store.set("mission", {
        ...a,
        step: "switch",
        startedAt: Date.now()
      });
      if (!ECO_KIND(a.kind)) Journal.add(a.fs ? "FS" : "RATUNEK", `Start lotu: [${a.fromKey}] ${a.fromBody} → [${a.toKey}] ${a.toBody} (${a.why})`);
      log(`[LOT] ${a.why}: [${a.fromKey}] ${a.fromBody} → [${a.toKey}] ${a.toBody}, ${a.speed}%`, "warn");
      return true;
    },
    abort(why, opts = {}) {
      const m = this.mission();
      Store.del("mission");
      if (!m) return;
      try {
        const sA = Situation.load();
        const n0 = (sA.flights || []).length;
        sA.flights = (sA.flights || []).filter(f => !(f.fromKey === m.fromKey && (f.fromBody || m.fromBody) === m.fromBody && f.pending));
        if ((sA.flights || []).length !== n0) Situation.save(sA);
      } catch {}
      if (opts.quiet) {
        log(`[LOT] przerwany: ${why}`, "warn");
        const blq = Store.get("fly_block", {}) || {};
        blq[`${m.fromKey}>${m.toKey}`] = Date.now() + 3 * 6e4;
        Store.set("fly_block", blq);
        return;
      }
      log(`[LOT] przerwany: ${why}`, "error");
      Journal.add(ECO_KIND(m.kind) ? "EKO" : "BŁĄD", `Lot [${m.fromKey}]→[${m.toKey}] przerwany: ${why}`);
      if (m.rescue && m.air && m.toBody === "moon" && why !== "operator") {
        try {
          const sR = Situation.load();
          sR.rescueFail = sR.rescueFail || {};
          const rk = `${m.fromKey}>${m.toKey}`;
          const prev = sR.rescueFail[rk];
          sR.rescueFail[rk] = {
            count: (prev && Date.now() - prev.at < 10 * 6e4 ? prev.count : 0) + 1,
            at: Date.now()
          };
          Situation.save(sR);
        } catch {}
      }
      const bl = Store.get("fly_block", {}) || {};
      bl[`${m.fromKey}>${m.toKey}`] = Date.now() + 3 * 6e4;
      Store.set("fly_block", bl);
    },
    newId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
    zawrotPotwierdzony(wierszyPowrotnych, juzZawroconych) {
      return (wierszyPowrotnych || 0) > (juzZawroconych || 0);
    },
    recallOf(mm) {
      const r = mm.recallAt || 0;
      if (!r || !mm.flightMs) return r;
      return Date.now() + mm.flightMs < r ? 0 : r;
    },
    async sendProof(m, ls) {
      if (!ls || ls.before == null || !(ls.total > 0)) return {
        ok: null,
        why: "stempel bez stanu hangaru sprzed kliknięcia"
      };
      let h = null;
      try {
        const act = PlanetBar.active();
        if (page() === "fleet" && act && act.key === m.fromKey && act.body === m.fromBody) h = Hangar.scan();
        if (!h) h = await Hangar.scanRemote(m.fromKey, m.fromBody);
      } catch (e) {
        return {
          ok: null,
          why: `odczyt hangaru rzucił: ${e.message}`
        };
      }
      if (!h || typeof h.total !== "number") return {
        ok: null,
        why: "hangar źródła nieodczytany"
      };
      const tol = Math.max(1, Math.floor(ls.total * .1));
      const expectedLeft = Math.max(0, ls.before - ls.total);
      if (h.total <= expectedLeft + tol) return {
        ok: true,
        total: h.total
      };
      if (h.total >= ls.before - tol) return {
        ok: false,
        total: h.total
      };
      return {
        ok: null,
        total: h.total,
        why: `hangar zmalał tylko częściowo (${h.total.toLocaleString("pl-PL")} z ${ls.before.toLocaleString("pl-PL")})`
      };
    },
    shortfall(ls, afterShips) {
      if (!ls || !ls.ships || !ls.beforeShips || !Array.isArray(afterShips)) return [];
      const teraz = {};
      for (const x of afterShips) {
        const t = String(x.type).toUpperCase();
        teraz[t] = (teraz[t] || 0) + (x.qty || 0);
      }
      const out = [];
      for (const [t, q] of Object.entries(ls.ships)) {
        const oczek = Math.max(0, (ls.beforeShips[t] || 0) - q), jest = teraz[t] || 0;
        if (jest > oczek) out.push({
          type: t,
          left: jest,
          expected: oczek
        });
      }
      return out;
    },
    landedDuring(ls, afterShips, sentReal) {
      if (!ls || !ls.beforeShips || !Array.isArray(afterShips)) return true;
      if ((ls.total || 0) > 0 && sentReal > ls.total) return true;
      const teraz = {};
      for (const x of afterShips) {
        const t = String(x.type).toUpperCase();
        teraz[t] = (teraz[t] || 0) + (x.qty || 0);
      }
      return Object.entries(teraz).some(([t, q]) => q > (ls.beforeShips[t] || 0));
    },
    shortfallTxt(lista) {
      return lista.map(x => `${x.type} ${x.left.toLocaleString("pl-PL")}${x.expected ? ` (miało zostać ${x.expected.toLocaleString("pl-PL")})` : ""}`).join(", ");
    },
    async pinRowId(m) {
      try {
        const sP = Situation.load();
        const f = (sP.flights || []).filter(x => x.fromKey === m.fromKey && x.toKey === m.toKey).sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))[0];
        if (!f || f.rowId) return;
        const znane = new Set((sP.flights || []).filter(x => x !== f && x.rowId).map(x => x.rowId));
        const r = await fetchT(Rows.URL, {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          }
        });
        if (!r.ok) return;
        const doc = (new DOMParser).parseFromString(await r.text(), "text/html");
        const wolne = [ ...doc.querySelectorAll("tr[class*='row-mission-type-']") ].filter(tr => /DEPLOY|STATION/i.test(tr.className) && !/return/i.test(tr.className) && (tr.textContent || "").includes(`[${f.toKey}]`) && (tr.textContent || "").includes(`[${f.fromKey}]`) && tr.getAttribute("data-fleet-id") && !znane.has(tr.getAttribute("data-fleet-id")));
        if (wolne.length === 1) {
          f.rowId = wolne[0].getAttribute("data-fleet-id");
          Situation.save(sP);
          log(`[LOT] wiersz lotu przypięty: ${String(f.rowId).slice(0, 12)}… ([${f.fromKey}]→[${f.toKey}]) — zawrót trafi w TEN lot, nie w bliźniaka na tej samej trasie.`, "info");
        }
      } catch {}
    },
    confirmed(m, info = {}) {
      const eco = ECO_KIND(m.kind);
      const s = Situation.load();
      const lsT = Store.get("last_send", null);
      const sentTotal = lsT && lsT.from === m.fromKey && lsT.toKey === m.toKey && (lsT.at || 0) >= (m.startedAt || 0) && lsT.total > 0 ? lsT.total : 0;
      if (!eco) {
        const f0 = (s.flights || []).find(f => f.fromKey === m.fromKey && (f.fromBody || m.fromBody) === m.fromBody && f.pending);
        const sentReal = info.sentReal > 0 ? info.sentReal : sentTotal;
        if (f0) {
          delete f0.pending;
          if (sentReal) f0.sentTotal = sentReal;
          if (m.flightMs) {
            f0.flightMs = m.flightMs;
            f0.recallAt = this.recallOf({
              ...m,
              flightMs: m.flightMs
            });
          }
        } else if (!(s.flights || []).some(f => f.fromKey === m.fromKey && (f.sentAt || 0) >= (m.startedAt || 0))) {
          s.flights = [ ...s.flights || [], {
            kind: m.air ? "air" : m.home ? "home" : "swap",
            fs: !!m.fs,
            evac: !!m.evac,
            excludeTypes: m.excludeTypes || null,
            capTypes: m.capTypes || null,
            fromKey: m.fromKey,
            fromBody: m.fromBody,
            toKey: m.toKey,
            toBody: m.toBody,
            id: Fly.newId(),
            sentAt: Date.now(),
            flightMs: m.flightMs || 0,
            sentTotal: sentReal,
            recallAt: this.recallOf(m),
            phase: "launched",
            tries: 0
          } ];
        }
      }
      {
        const e0 = (s.expected || []).find(e => e.pending && e.fromKey === m.fromKey) || (s.expected || []).filter(e => e.fromKey === m.fromKey && (e.sentAt || 0) >= (m.startedAt || 0)).pop();
        if (e0) {
          delete e0.pending;
          if (sentTotal > 0) e0.total = sentTotal;
          if (!Once.said(`powrot|${e0.fromKey}|${e0.sentAt}`, 36e5)) log(`[POWRÓT] zapamiętany: ${(e0.total || 0).toLocaleString("pl-PL")} szt. (${e0.kind}) wróci na [${e0.fromKey}] ${e0.fromBody === "moon" ? "księżyc" : "planetę"} ~${new Date(e0.returnAt).toLocaleTimeString("pl-PL", {
            hour: "2-digit",
            minute: "2-digit"
          })}.`, "info");
        }
      }
      Situation.save(s);
      if (!eco) {
        if (typeof info.fresh === "number") noteLeftHome(m.fromKey, m.fromBody, info.fresh); else emptySourceHangar(m.fromKey, m.fromBody, "wysyłka potwierdzona", m.excludeTypes, m.capTypes);
      }
      if (m.fs) {
        try {
          const ft = Store.get("fs_try", {}) || {};
          delete ft[`${m.fromKey}>${m.toKey}`];
          Store.set("fs_try", ft);
        } catch {}
      }
      if (m.evac) {
        try {
          const et = Store.get("evac_try", {}) || {};
          delete et[`${m.fromKey}>${m.toKey}`];
          Store.set("evac_try", et);
        } catch {}
      }
      if (m.fromBody === "moon" && m.toBody === "planet" && m.toKey === m.fromKey && !m.home && !eco && !m.fs) {
        try {
          const sR = Situation.load();
          sR.rescues = sR.rescues || {};
          sR.rescues[m.fromKey] = {
            at: Date.now(),
            landAt: Date.now() + (m.flightMs || 0),
            ships: sentTotal && lsT && lsT.ships && Object.keys(lsT.ships).length ? {
              ...lsT.ships
            } : null
          };
          Situation.save(sR);
        } catch {}
      }
      if (m.backHome) {
        try {
          const sB = Situation.load();
          if (sB.rescues) {
            delete sB.rescues[m.fromKey];
            Situation.save(sB);
          }
        } catch {}
      }
      Store.del("mission");
      if (!eco && m.air) {
        this.pinRowId(m).catch(() => {});
      }
      const what = info.loaded || "(skład nieznany)";
      const types = info.loaded ? info.loaded.split(", ").length : 0;
      if (m.kind === "expedition") log(`[EXPO] fala wysłana: ${what} → [${m.toKey}]`, "success"); else if (m.kind === "debris") log(`[ZŁOM] recyklery wysłane: ${what} → [${m.toKey}]`, "success"); else if (m.kind === "asteroid") log(`[ASTER] minery wysłane: ${what} → [${m.toKey}]`, "success"); else if (m.kind === "farm") Farm.sent(m, what); else Journal.add(m.fs ? "FS" : m.home ? "POWRÓT" : "RATUNEK", `WYSŁANO: [${m.fromKey}] ${m.fromBody} → [${m.toKey}] ${m.toBody} (${types} typów statków)${m.air ? `, zawrót ~${new Date(m.recallAt).toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit"
      })}` : ""}`);
    },
    blocked(a) {
      const bl = Store.get("fly_block", {}) || {};
      const until = bl[`${a.fromKey}>${a.toKey}`] || 0;
      if (!until) return false;
      if ((a.air || a.rescue) && !a.evac) return until - 2 * 6e4 - 15e3 > Date.now();
      return until > Date.now();
    },
    NAV_MAX: 6,
    STEP2_MS: 12e3,
    bumpNav(m) {
      m.navs = (m.navs || 0) + 1;
      Store.set("mission", m);
    },
    async tick() {
      const m = this.mission();
      if (!m) return;
      if (Date.now() - m.startedAt > 15 * 6e4) {
        Store.del("mission");
        log(`[LOT] porzucona misja sprzed ${Math.round((Date.now() - m.startedAt) / 6e4)} min (bot był wyłączony) — sprzątam bez karencji.`, "warn");
        return;
      }
      if (Date.now() - m.startedAt > 5 * 6e4) return this.abort("5 min bez potwierdzenia wysyłki");
      if ((m.navs || 0) >= this.NAV_MAX) return this.abort(`${this.NAV_MAX} nawigacji bez otwarcia formularza — pętla przełączania ciał (krok „${m.step}", cel ${this.url(m)})`);
      {
        const ecoOn = {
          expedition: () => CFG.expo.enabled,
          asteroid: () => CFG.aster.enabled,
          debris: () => CFG.debris.enabled,
          farm: () => CFG.farm.enabled
        }[m.kind];
        if (ecoOn && !ecoOn()) {
          const ls0 = Store.get("last_send", null);
          const sent = ls0 && ls0.toKey === m.toKey && ls0.from === m.fromKey && ls0.kind === m.kind && (ls0.at || 0) >= (m.startedAt || 0);
          if (!sent) {
            Store.del("mission");
            log(`[LOT] przerwany bez karencji: wyłączyłeś ${m.kind === "expedition" ? "ekspedycje" : m.kind === "asteroid" ? "minery" : m.kind === "farm" ? "farmę" : "zbieranie złomu"} w trakcie misji (krok „${m.step}").`, "warn");
            return;
          }
        }
        if (ecoOn && (CFG.human.ecoIdleSec || 0) > 0 && (m.step === "switch" || m.step === "switch_wait")) {
          const klik = Store.get("input_at", 0) || 0;
          if (klik > (m.startedAt || 0)) {
            Store.del("mission");
            if (m.kind === "farm") Farm.unmark(m.toKey);
            log(`[LOT] odłożony bez karencji: kliknąłeś ${Math.max(0, Math.round((Date.now() - klik) / 1e3))} s temu, zanim bot otworzył formularz — ${ECO_LABEL(m.kind)} poczeka ${Math.round(CFG.human.ecoIdleSec / 60)} min od Twojego ostatniego kliknięcia.`, "info");
            return;
          }
        }
      }
      if (ECO_KIND(m.kind) && Human.yielding() && ((Store.get("eco_yield", null) || {}).last || 0) > (m.startedAt || 0)) {
        const ls1 = Store.get("last_send", null);
        const sent1 = ls1 && ls1.toKey === m.toKey && ls1.from === m.fromKey && ls1.kind === m.kind && (ls1.at || 0) >= (m.startedAt || 0);
        if (!sent1) {
          Store.del("mission");
          if (m.kind === "farm") Farm.unmark(m.toKey);
          log(`[LOT] odłożony bez karencji: sam otworzyłeś ${location.pathname} — nie zabieram Ci karty, ${ECO_LABEL(m.kind)} ruszy ${Math.round(Human.MANUAL_YIELD_MS / 1e3)} s po Twojej ostatniej zmianie strony (najdłużej ${Math.round(Human.MANUAL_YIELD_CAP_MS / 6e4)} min).`, "info");
          return;
        }
      }
      try {
        if (m.step === "switch") {
          const a = PlanetBar.active();
          if (a && a.key === m.fromKey && a.body === m.fromBody) {
            m.step = "form";
            this.bumpNav(m);
            Nav.go(this.url(m), `lot: formularz [${m.fromKey}]→[${m.toKey}]`);
            return;
          }
          const el = PlanetBar.anchor(m.fromKey, m.fromBody);
          if (!el) return this.abort(`brak [${m.fromKey}] ${m.fromBody} na pasku planet`);
          if (ECO_KIND(m.kind) && !Store.get("eco_return", null)) {
            const act0 = PlanetBar.active();
            const ea0 = act0 && PlanetBar.anchor(act0.key, act0.body);
            const mu0 = ea0 && (ea0.getAttribute("href") || "").match(/[?&]planet=([^&#"']+)/i);
            Store.set("eco_return", {
              url: location.pathname + location.search,
              uuid: mu0 ? mu0[1] : null,
              at: Date.now(),
              input: Store.get("input_at", 0) || 0
            });
          }
          log(`[LOT] przełączam na ${m.fromBody} [${m.fromKey}]`, "info");
          m.step = "switch_wait";
          this.bumpNav(m);
          Nav.click(el, `lot: przełączenie na ${m.fromBody} [${m.fromKey}]`);
          return;
        }
        if (m.step === "switch_wait") {
          const a = PlanetBar.active();
          if (a && a.key === m.fromKey && a.body === m.fromBody) {
            m.step = "form";
            this.bumpNav(m);
            Nav.go(this.url(m), `lot: formularz [${m.fromKey}]→[${m.toKey}]`);
          }
          return;
        }
        if (m.step === "form") {
          {
            const lsOk = Store.get("last_send", null);
            if (lsOk && lsOk.toKey === m.toKey && lsOk.from === m.fromKey && lsOk.kind === m.kind && (lsOk.at || 0) >= (m.startedAt || 0) && location.href.includes("fleetSendSuccessfully")) {
              log(`[LOT] gra potwierdziła wysyłkę [${m.fromKey}]→[${m.toKey}] (adres fleetSendSuccessfully) — „Send fleet" przeładował stronę, zanim bot zdążył to zapisać.`, "info");
              let sentReal = 0;
              try {
                const act = PlanetBar.active();
                const hs = page() === "fleet" && act && act.key === m.fromKey && act.body === m.fromBody && lsOk.ships ? Hangar.scan() : null;
                if (hs && typeof lsOk.before === "number") {
                  sentReal = Math.max(0, lsOk.before - hs.total);
                  if (this.landedDuring(lsOk, hs.ships, sentReal)) sentReal = 0;
                  const brak = sentReal ? this.shortfall(lsOk, hs.ships) : [];
                  if (brak.length) log(`[LOT] po wysyłce w hangarze ${m.fromBody} [${m.fromKey}] zostało ponad plan: ${this.shortfallTxt(brak)} (odjęcie hangaru dałoby ~${sentReal.toLocaleString("pl-PL")} z ${(lsOk.total || 0).toLocaleString("pl-PL")} szt.). To lądowanie fali w sekundzie wysyłki (22.09: „737 mln” wróciło jako 3,7 mld) — rejestr powrotów trzyma to, co wpisano w formularz.`, "info");
                }
              } catch {}
              this.confirmed(m, {
                loaded: lsOk.loaded || "",
                sentReal: ECO_KIND(m.kind) ? sentReal : 0
              });
              return;
            }
          }
          const ECO_KINDS = [ "expedition", "asteroid", "debris", "farm" ];
          const guardMs = m.kind === "debris" || m.kind === "farm" ? 3 * 6e4 : ECO_KINDS.includes(m.kind) ? 2e4 : 3 * 6e4;
          const ls = Store.get("last_send", null);
          const lsMine = !!ls && ls.kind === m.kind && ls.from === m.fromKey && ls.toKey === m.toKey && (!ls.fromBody || ls.fromBody === m.fromBody) && (!ls.toBody || ls.toBody === m.toBody) && (ECO_KINDS.includes(m.kind) || (ls.at || 0) >= (m.startedAt || 0) && (ls.startedAt == null || ls.startedAt === m.startedAt));
          if (lsMine && Date.now() - ls.at < guardMs) {
            const juzPoszla = `[LOT] wysyłka do [${m.toKey}] już poszła ${Math.round((Date.now() - ls.at) / 1e3)}s temu — nie powtarzam`;
            const zdejmijPending = () => {
              try {
                const sD = Situation.load();
                const fD = (sD.flights || []).find(x => x.fromKey === m.fromKey && (x.fromBody || m.fromBody) === m.fromBody && x.pending);
                if (fD) {
                  delete fD.pending;
                  if (m.flightMs) fD.flightMs = m.flightMs;
                  Situation.save(sD);
                  log(`[LOT] wpis lotu [${fD.fromKey}]→[${fD.toKey}] potwierdzony (wysyłka już poszła).`, "success");
                }
              } catch {}
            };
            const karencjaTrasy = () => {
              try {
                const blG = Store.get("fly_block", {}) || {};
                blG[`${m.fromKey}>${m.toKey}`] = ls.at + guardMs;
                Store.set("fly_block", blG);
              } catch {}
            };
            if (ECO_KINDS.includes(m.kind)) {
              log(`${juzPoszla}.`, "warn");
              zdejmijPending();
              Store.del("mission");
              return;
            }
            const dowod = await this.sendProof(m, ls);
            if (dowod.ok === false) {
              const n = (m.refused || 0) + 1;
              log(`[LOT] gra NIE przyjęła wysyłki [${m.fromKey}]→[${m.toKey}]: hangar ${m.fromBody} nadal ma ${dowod.total.toLocaleString("pl-PL")} szt. (przed klikiem ${(ls.before || 0).toLocaleString("pl-PL")}) — stempel „kliknąłem" to nie dowód wysyłki, hangaru NIE zeruję. ${n >= 2 ? "Druga odmowa z rzędu — przerywam i alarmuję." : "Ponawiam formularz."}`, "error");
              if (n >= 2) return this.abort(`gra dwukrotnie odrzuciła wysyłkę ratunku [${m.fromKey}]→[${m.toKey}] — flota STOI na ${m.fromBody} [${m.fromKey}] (slot? deuter?), hangar nietknięty`);
              m.refused = n;
              Store.set("mission", m);
            } else if (dowod.ok === true) {
              log(`${juzPoszla} (hangar źródła potwierdza: zostało ${dowod.total.toLocaleString("pl-PL")} szt.).`, "warn");
              zdejmijPending();
              noteLeftHome(m.fromKey, m.fromBody, dowod.total);
              karencjaTrasy();
              Store.del("mission");
              return;
            } else {
              log(`${juzPoszla} (bez dowodu z hangaru: ${dowod.why} — migawki NIE zeruję, decide() sprawdzi formularzem, czy coś tu jeszcze stoi).`, "warn");
              zdejmijPending();
              Store.del("mission");
              return;
            }
          }
          if (page() !== "fleet") {
            navGuard(m, this);
            return;
          }
          Store.set("form_nav", null);
          if (this._busy) return;
          this._busy = true;
          try {
            await this.form(m);
          } finally {
            this._busy = false;
          }
        }
      } catch (e) {
        this.abort(`błąd: ${e.message}`);
      }
    },
    findButton(text) {
      const want = String(text).trim().toLowerCase();
      const alt = {
        next: [ "next", "dalej", "weiter", "continue" ],
        "send fleet": [ "send fleet", "wyślij flotę", "wyslij flote", "send" ]
      }[want] || [ want ];
      const ok = el => el.offsetParent !== null && !el.closest("#ogx3-panel") && !el.closest(".planet-select, .moon-select, .sidebar, nav");
      const label = el => String(el.value || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const area = document.querySelector("#content, .content, main, #fleet, .fleet-content, .fleet-form") || document.body;
      const sel = "a, button, input[type='submit'], input[type='button'], [role='button']";
      const inArea = [ ...area.querySelectorAll(sel) ].filter(ok);
      const anywhere = [ ...document.querySelectorAll(sel) ].filter(ok);
      const exact = list => list.find(el => alt.includes(label(el)));
      const loose = list => list.find(el => {
        const l = label(el);
        return l.length <= 24 && alt.some(a => l.includes(a));
      });
      return exact(inArea) || exact(anywhere) || loose(inArea) || loose(anywhere) || null;
    },
    flightMsOnPage() {
      const ft = (document.body.textContent || "").match(/Duration\s*of\s*flight[^0-9]{0,40}?(?:(\d{1,3})\s*d\D{0,4})?(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
      if (!ft) return 0;
      const dni = ft[1] !== undefined ? +ft[1] : 0;
      return (dni > 0 ? dni * 86400 + (+ft[2] * 3600 + +ft[3] * 60 + +(ft[4] || 0)) : ft[4] !== undefined ? +ft[2] * 3600 + +ft[3] * 60 + +ft[4] : +ft[2] * 60 + +ft[3]) * 1e3;
    },
    gameError() {
      const pop = [ ...document.querySelectorAll(".swal2-popup") ].find(p => !p.closest("#ogx3-panel") && !p.classList.contains("swal2-hide") && (p.offsetParent !== null || p.getClientRects().length > 0));
      if (!pop) return null;
      const t = sel => (pop.querySelector(sel)?.textContent || "").replace(/\s+/g, " ").trim();
      const tytul = t(".swal2-title");
      if (!/error|błąd|fehler/i.test(tytul) && !pop.classList.contains("swal2-icon-error")) return null;
      const tresc = t(".swal2-html-container, #swal2-content");
      return {
        text: [ tytul, tresc ].filter(Boolean).join(": ") || (pop.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        pop: pop
      };
    },
    refused(err, krok) {
      try {
        const ok = err.pop.querySelector(".swal2-confirm, .swal2-close");
        if (ok) ok.click();
      } catch {}
      this.abort(`gra odrzuciła formularz na kroku ${krok}: „${err.text}"`);
      Nav.go("/fleet", "gra odrzuciła formularz floty — zamykam okno błędu i odświeżam stronę");
    },
    isDisabled(el) {
      return !el || el.disabled || el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true";
    },
    async peekThreat(m) {
      if (!m || m.rescue || m.blind) return null;
      try {
        const s = Situation.load();
        const own = new Set(Object.keys(s.pairs || {}));
        if (!own.size) return null;
        const r = await Rows.fetchList(own);
        if (!r || !r.ok) return null;
        const t = (r.rows || []).find(x => x.attack && !x.mine && !x.friendly && !x.isReturn && x.dst && own.has(x.dst));
        return t ? `${t.type} → [${t.dst}]${t.eta ? ` za ${t.eta}s` : ""}` : null;
      } catch {
        return null;
      }
    },
    async clickWhenEnabled(text, maxMs = 25e3) {
      const t0 = Date.now();
      let seen = null, saidWait = false, obrot = 0;
      while (Date.now() - t0 < maxMs) {
        const b = this.findButton(text);
        if (b) seen = b;
        if (b && !this.isDisabled(b)) {
          if (saidWait) log(`[LOT] przycisk „${text}" ożył po ${((Date.now() - t0) / 1e3).toFixed(1)}s — klikam.`, "info");
          b.click();
          log(`[LOT] klik „${text}" (<${b.tagName.toLowerCase()}${b.id ? " id=" + b.id : ""}>)`, "info");
          return b;
        }
        if (b && !saidWait) {
          saidWait = true;
          log(`[LOT] przycisk „${text}" jest wyłączony — czekam, zamiast klikać w martwy element.`, "info");
        }
        if (++obrot % 10 === 0) {
          const atak = await this.peekThreat(this.mission());
          if (atak) {
            log(`[LOT] ALARM w trakcie wypełniania formularza (${atak}) — przerywam lot dobrowolny, obrona ma pierwszeństwo.`, "error");
            this.abort(`ALARM w trakcie formularza (${atak})`, {
              quiet: true
            });
            return null;
          }
        }
        await sleep(400);
      }
      const cands = [ ...document.querySelectorAll("a, button, input[type='submit'], input[type='button'], [role='button']") ].filter(el => el.offsetParent !== null && !el.closest("#ogx3-panel")).map(el => `<${el.tagName.toLowerCase()}${el.id ? " id=" + el.id : ""}${el.className ? ' class="' + String(el.className).slice(0, 40) + '"' : ""}${el.disabled ? " DISABLED" : ""}>${String(el.value || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)}`).slice(0, 25).join(" | ");
      const bodyTxt = document.body.textContent.replace(/\s+/g, " ").trim();
      const iDur = bodyTxt.search(/Duration\s*of\s*flight/i);
      const txt = iDur >= 0 ? bodyTxt.slice(Math.max(0, iDur - 250), iDur + 450) : (document.querySelector("#content, .content, form") || document.body).textContent.replace(/\s+/g, " ").trim().slice(-300);
      const paliwo = [ ...document.querySelectorAll("div, span, td, li, p, label, small, b, strong") ].filter(el => el.children.length === 0 && !el.closest("#ogx3-panel") && /deuter|fuel|consumption|paliw|slot|not enough|insufficient|za mało/i.test(el.textContent || "")).map(el => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 8).join(" | ");
      log(seen ? `[LOT] przycisk „${text}" BYŁ na stronie, ale przez ${maxMs / 1e3}s pozostał WYŁĄCZONY — gra nie przyjmuje tej floty. KANDYDACI: ${cands}` : `[LOT] przycisku „${text}" NIE MA na stronie (${maxMs / 1e3}s). KANDYDACI: ${cands}`, "error");
      log(`[LOT] tekst formularza (wokół „Duration of flight"): …${txt}`, "error");
      if (paliwo) log(`[LOT] paliwo/sloty na stronie: ${paliwo}`, "error");
      return null;
    },
    async form(m) {
      const a = PlanetBar.active();
      if (!a || a.key !== m.fromKey || a.body !== m.fromBody) {
        m.step = "switch";
        Store.set("mission", m);
        return;
      }
      if (m.navs) {
        m.navs = 0;
        Store.set("mission", m);
      }
      await sleep(jitter(1200, 2200));
      const els = [ ...document.querySelectorAll("[data-ship-type]") ];
      const snap = Hangar.scan();
      if (!snap) {
        if (document.querySelector("#btn-next-fleet3, #btn-submit-fleet, #fleet2_target_x, .mission-item")) {
          const n = (m.formBusy || 0) + 1;
          m.formBusy = n;
          Store.set("mission", m);
          if (n >= 4) return this.abort(`formularz floty [${m.fromKey}] ${m.fromBody} stoi w kroku 2/3 mimo ${n - 1} przebiegów i przeładowań (ktoś go wypełnia albo fork utknął)`);
          if (n === 1) {
            log(`[LOT] formularz floty [${m.fromKey}] jest już w toku (krok 2/3) — nie zaczynam od nowa, czekam jeden przebieg.`, "info");
            return;
          }
          log(`[LOT] formularz floty [${m.fromKey}] nadal w kroku 2/3 (${n}/3) — przeładowuję formularz od kroku 1.`, "warn");
          Nav.go(this.url(m), `lot: formularz w toku od ${n} przebiegów, przeładowuję [${m.fromKey}]→[${m.toKey}]`);
          return;
        }
        const n = (m.formUnreadable || 0) + 1;
        if (n >= 3) return this.abort(`strona floty [${m.fromKey}] ${m.fromBody} nieczytelna ${n}× z rzędu (nie widzę kroku wyboru statków) — nie wiem, co stoi w hangarze; sprawdź grę`);
        m.formUnreadable = n;
        this.bumpNav(m);
        Store.set("mission", m);
        log(`[LOT] strona floty [${m.fromKey}] ${m.fromBody} nieczytelna (${n}/3) — to NIE jest pusty hangar; przeładowuję formularz.`, "warn");
        Nav.go(this.url(m), `lot: formularz nieczytelny, ponawiam [${m.fromKey}]→[${m.toKey}]`);
        return;
      }
      if (snap.total === 0) {
        if (m.kind === "farm") Farm.noShips(m, 0);
        log(`[LOT] hangar ${m.fromBody} [${m.fromKey}] pusty — nic do wysłania.`, "warn");
        Store.del("mission");
        return;
      }
      if (m.kind === "farm" && !Farm.formOk(m, els)) {
        Store.del("mission");
        return;
      }
      const loaded = [];
      let loadedTotal = 0;
      const loadedMap = {};
      const want = m.plan ? new Map(m.plan.map(p => [ String(p.type).toUpperCase(), p.qty ])) : null;
      const excl = new Set((m.excludeTypes || []).map(t => String(t).toUpperCase()));
      const cap = new Map(Object.entries(m.capTypes || {}).map(([t, n]) => [ String(t).toUpperCase(), Math.max(0, parseInt(n, 10) || 0) ]));
      const wszystko = Array.isArray(m.takeAllExcept) ? new Set(m.takeAllExcept.map(t => String(t).toUpperCase())) : null;
      let dziel = 1;
      if (wszystko && m.shareCtx && m.shareCtx.cap > 1 && !m.shareCtx.lastSlot) {
        const stoi = els.reduce((n, el) => n + (wszystko.has(String(el.dataset.shipType || "").toUpperCase()) ? 0 : parseInt(el.dataset.shipQuantity || "0") || 0), 0);
        const udzial = (stoi + (m.shareCtx.wPowietrzu || 0)) / m.shareCtx.cap;
        if (udzial > 0 && stoi >= 1.5 * udzial) {
          dziel = stoi / udzial;
          m.splitOnForm = true;
          log(`[LOT] w formularzu stoi ${stoi.toLocaleString("pl-PL")} szt. — to ${dziel.toFixed(2).replace(".", ",")} udziału fali (${Math.round(udzial).toLocaleString("pl-PL")} szt.), czyli od planu wylądowała kolejna fala. Biorę JEDEN udział, reszta poleci następnym lotem.`, "warn");
        }
      }
      const keep = new Map(Object.entries(m.keepQty || {}).map(([t, n]) => [ String(t).toUpperCase(), Math.max(0, parseInt(n, 10) || 0) ]));
      const qtyFor = (type, have) => wszystko ? wszystko.has(type) ? 0 : dziel > 1 ? have < dziel ? have : Math.floor(have / dziel) : have : want ? Math.min(want.get(type) || 0, have) : excl.has(type) ? 0 : keep.has(type) ? Math.max(0, have - keep.get(type)) : cap.has(type) ? Math.min(have, cap.get(type)) : have;
      if (cap.size && !want) {
        const jestCosPoza = els.some(el => {
          const t = String(el.dataset.shipType || "").toUpperCase();
          return (parseInt(el.dataset.shipQuantity || "0") || 0) > 0 && !excl.has(t) && !cap.has(t);
        });
        if (!jestCosPoza) {
          log(`[LOT] w hangarze ${m.fromBody} [${m.fromKey}] nie ma nic poza rezerwą (${[ ...cap.keys() ].join(", ")}) — nie wywożę jej po sztuce, zostaje w domu na kolejne fale.`, "warn");
          Store.del("mission");
          return;
        }
      }
      for (const el of els) {
        const type = String(el.dataset.shipType || "").toUpperCase();
        const have = parseInt(el.dataset.shipQuantity || "0") || 0;
        if (!have) continue;
        const qty = qtyFor(type, have);
        if (qty <= 0) continue;
        const item = el.closest(".ship-item") || el.parentElement;
        const input = item?.querySelector("input.numberFormatInput, input[type='text'], input[type='number']");
        if (!input) continue;
        setInput(input, qty);
        loadedTotal += qty;
        loadedMap[type] = qty;
        loaded.push(`${el.dataset.shipType}×${qty.toLocaleString("pl-PL")}`);
        if (want) await sleep(jitter(120, 380));
      }
      if (loaded.length) {
        for (let round = 0; round < 2; round++) {
          let fixed = 0;
          for (const el of els) {
            const type = String(el.dataset.shipType || "").toUpperCase();
            const have = parseInt(el.dataset.shipQuantity || "0") || 0;
            if (!have) continue;
            const qty = qtyFor(type, have);
            if (qty <= 0) continue;
            const item = el.closest(".ship-item") || el.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text'], input[type='number']");
            if (!input) continue;
            const cur = parseInt(String(input.value || "0").replace(/[^0-9]/g, "")) || 0;
            if (cur !== qty) {
              setInput(input, qty);
              fixed++;
            }
          }
          if (!fixed) break;
          log(`[LOT] formularz zgubił ${fixed} pól statków — wpisuję ponownie (runda ${round + 1}/2).`, "warn");
          await sleep(jitter(300, 600));
        }
      }
      if (!loaded.length) {
        const stale = !!want && els.length > 0 && !els.some(el => (parseInt(el.dataset.shipQuantity || "0") || 0) > 0 && (wszystko ? !wszystko.has(String(el.dataset.shipType || "").toUpperCase()) : (want.get(String(el.dataset.shipType || "").toUpperCase()) || 0) > 0));
        if (stale) {
          log(`[LOT] plan nieaktualny — w hangarze ${m.fromBody} [${m.fromKey}] zostały tylko statki spoza planu (${els.map(e => `${e.dataset.shipType}(${e.dataset.shipQuantity})`).join(", ")}). Odpuszczam falę.`, "warn");
          return this.abort("plan nieaktualny — w hangarze tylko statki spoza planu", {
            quiet: true
          });
        }
        const onlyExcluded = !want && excl.size > 0 && els.length > 0 && els.every(el => (parseInt(el.dataset.shipQuantity || "0") || 0) === 0 || excl.has(String(el.dataset.shipType || "").toUpperCase()));
        if (onlyExcluded) {
          log(`[LOT] w hangarze ${m.fromBody} [${m.fromKey}] zostały tylko wykluczone typy (${els.map(e => `${e.dataset.shipType}(${e.dataset.shipQuantity})`).join(", ")}) — nic do ewakuacji, zostają na robocie.`, "info");
          return this.abort("tylko wykluczone typy w hangarze (miner/recykler w trakcie pracy)", {
            quiet: true
          });
        }
        if (keep.size && els.every(el => {
          const t = String(el.dataset.shipType || "").toUpperCase();
          const q = parseInt(el.dataset.shipQuantity || "0") || 0;
          return q === 0 || keep.has(t) && q <= keep.get(t);
        })) {
          log(`[LOT] na ${m.fromBody} [${m.fromKey}] stoją tylko transportery mieszkające na planecie — nie ma czego wywozić.`, "info");
          return this.abort("tylko transportery sprzed utraty księżyca", {
            quiet: true
          });
        }
        log(`[LOT DOM] nie znalazłem pól statków. Statki: ${els.map(e => `${e.dataset.shipType}(${e.dataset.shipQuantity})`).join(", ")} | HTML: ${(document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1500)}`, "error");
        return this.abort("brak pól statków");
      }
      if (wszystko && want) {
        const planSuma = [ ...want.values() ].reduce((a, b) => a + (b || 0), 0);
        if (loadedTotal > planSuma) log(`[LOT] fala domykająca: w hangarze jest więcej niż w planie (${loadedTotal.toLocaleString("pl-PL")} zamiast ${planSuma.toLocaleString("pl-PL")} szt. — w międzyczasie wylądowała flota), zabieram cały hangar.`, "info");
      }
      log(`[LOT] załadowano: ${loaded.join(", ")}`, "info");
      await sleep(jitter(400, 800));
      if (m.missionType === "ASTEROID") Aster.learnCargo(m);
      const nextBtn1 = await this.clickWhenEnabled("Next");
      if (!nextBtn1) return this.abort("Next (krok 1) martwy");
      const krok2Wstal = () => {
        const b = this.findButton("Next");
        return !!b && b !== nextBtn1 && !(nextBtn1.id && b.id === nextBtn1.id) || this.flightMsOnPage() > 0;
      };
      let odmowa = null;
      const t0 = Date.now();
      while (Date.now() - t0 < this.STEP2_MS && !(krok2Wstal() && document.getElementById("fleet2_target_x"))) {
        if (odmowa = this.gameError()) break;
        await sleep(400);
      }
      if (odmowa || !krok2Wstal() && (odmowa = this.gameError())) return this.refused(odmowa, "krok 1 (wybór statków)");
      if (!krok2Wstal()) return this.abort(`krok 2 formularza nie wstał w ${Math.round(this.STEP2_MS / 1e3)} s — widoczny „Next" to wciąż przycisk kroku 1 (id=${nextBtn1.id || "brak"}), gra nie przerysowała strony`);
      const [g, sy, po] = m.toKey.split(":");
      const fx = document.getElementById("fleet2_target_x"), fy = document.getElementById("fleet2_target_y"), fz = document.getElementById("fleet2_target_z");
      if (fx && fy && fz && `${fx.value}:${fy.value}:${fz.value}` !== m.toKey) {
        setInput(fx, g);
        setInput(fy, sy);
        setInput(fz, po);
        log(`[LOT] koordy celu ustawione na [${m.toKey}]`, "info");
        await sleep(600);
      }
      const inSidebar = el => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx3-panel");
      const wantType = m.toBody === "moon" ? "2" : m.toBody === "debris" ? "3" : "1";
      const btn = [ ...document.querySelectorAll(`[data-planet-type="${wantType}"]`) ].filter(el => !inSidebar(el))[0];
      if (btn) {
        btn.click();
        log(`[LOT] cel: ${m.toBody === "moon" ? "KSIĘŻYC" : m.toBody === "debris" ? "ZŁOM" : "PLANETA"}`, "info");
        await sleep(jitter(500, 900));
      } else {
        log(`[LOT DOM] brak przełącznika ciała (data-planet-type=${wantType}); panel celu: ${(document.getElementById("target_planet_type_container") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1200)}`, "warn");
      }
      if (m.speed && m.speed !== 100) {
        let ok = false, wybrana = null, dostepne = [];
        const txt = e => (e.textContent || "").trim();
        for (const h of [ ...document.querySelectorAll("a, span, button, div, td, li") ].filter(e => txt(e) === "100" && e.offsetParent !== null && !e.closest("#ogx3-panel"))) {
          const kids = [ ...h.parentElement?.children || [] ];
          const texts = kids.map(txt);
          if (!(texts.includes("10") && texts.includes("50"))) continue;
          dostepne = kids.map(k => ({
            el: k,
            pct: /^\d{1,3}$/.test(txt(k)) ? parseInt(txt(k), 10) : null
          })).filter(x => x.pct !== null && x.pct > 0 && x.pct <= 100);
          const nieSzybsze = dostepne.filter(x => x.pct <= m.speed);
          const wybor = nieSzybsze.length ? nieSzybsze.reduce((a, b) => b.pct > a.pct ? b : a) : dostepne.length ? dostepne.reduce((a, b) => b.pct < a.pct ? b : a) : null;
          if (wybor) {
            wybor.el.click();
            ok = true;
            wybrana = wybor.pct;
            m.speedUsed = wybrana;
          }
          break;
        }
        if (ok && wybrana !== m.speed) log(`[LOT] prędkości ${m.speed}% nie ma na liście forka (są: ${dostepne.map(x => x.pct).join(", ")}) — lecę najbliższą NIE SZYBSZĄ: ${wybrana}%.`, "warn"); else if (ok) log(`[LOT] lista prędkości forka: ${dostepne.map(x => x.pct).join(", ")}.`, "info");
        log(`[LOT] prędkość ${m.speed}%: ${ok ? `ustawiona (${wybrana}%)` : "NIE USTAWIONA — lecę z domyślną, lot będzie krótki"}`, ok ? "info" : "error");
        if (!ok && !Once.said("speed_fail", 30 * 6e4)) {
          Journal.add("BŁĄD", `Nie znalazłem suwaka prędkości — lot [${m.fromKey}]→[${m.toKey}] leci z domyślną prędkością (krótko). Sprawdź zrzut w logu.`);
          log(`[LOT DOM] okolica suwaka prędkości: ${(document.querySelector("#target_planet_type_container")?.closest("form") || document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 2e3)}`, "error");
        }
        await sleep(jitter(700, 1100));
      }
      const czasLotu = this.flightMsOnPage();
      if (czasLotu > 0) {
        m.flightMs = czasLotu;
        log(`[LOT] czas lotu ${Math.round(m.flightMs / 1e3)} s`, "info");
        if (m.kind === "asteroid" && m.ttl) {
          const left = m.ttl * 1e3 - (Date.now() - (m.ttlAt || Date.now()));
          if (left < m.flightMs * 1.1) {
            log(`[ASTER] asteroida znika za ${Math.round(left / 1e3)} s, a lot trwa ${Math.round(m.flightMs / 1e3)} s — NIE wysyłam minerów, skanuję dalej.`, "warn");
            return this.abort("asteroida zniknie przed dolotem", {
              quiet: true
            });
          }
        }
        if (m.fs && m.recallAt) {
          const t0 = Date.now(), homeAt = m.homeAt || m.recallAt, half = (homeAt - t0) / 2;
          const hh = t => new Date(t).toLocaleTimeString("pl-PL", {
            hour: "2-digit",
            minute: "2-digit"
          });
          if (!(half > 0)) return this.abort(`FS: godzina powrotu (${hh(homeAt)}) nie jest w przyszłości`, {
            quiet: true
          });
          const zapamietajLot = () => {
            try {
              const sS = Situation.load();
              sS.fsMeasured = sS.fsMeasured || {};
              sS.fsMeasured[`${m.fromKey}>${m.toKey}`] = {
                flightMs: m.flightMs,
                speedPct: m.speed || 0,
                at: Date.now()
              };
              Situation.save(sS);
            } catch {}
          };
          zapamietajLot();
          if (m.flightMs < half) {
            const mins = ms => Math.round(ms / 6e4);
            if (!Once.said(`fsshort|${m.fromKey}`, 60 * 6e4)) Journal.add("BŁĄD", `Fleet Save odwołany: lot [${m.fromKey}]→[${m.toKey}] trwa ${mins(m.flightMs)} min, a do powrotu o ${hh(homeAt)} zostało ${mins(homeAt - t0)} min. Flota doleciałaby i WYLĄDOWAŁA zamiast wisieć w powietrzu. Startuję dopiero o ${hh(homeAt - 2 * m.flightMs)}; jeśli ma być wcześniej — zmniejsz prędkość FS albo ustaw dalszy cel.`);
            return this.abort(`FS: lot ${mins(m.flightMs)} min jest za krótki na powrót o ${hh(homeAt)} — flota by wylądowała; zmniejsz prędkość albo wybierz dalszy cel`, {
              quiet: true
            });
          }
          m.recallAt = t0 + half;
          Store.set("mission", m);
          log(`[FS] lot ${Math.round(m.flightMs / 6e4)} min, zawrót o ${hh(m.recallAt)} — flota ma być w domu o ${hh(homeAt)}.`, "info");
        } else if (m.recallAt && Date.now() + m.flightMs < m.recallAt) {
          log(`[LOT] lot trwa ${Math.round(m.flightMs / 1e3)} s i doleci przed terminem zawrotu — flota WYLĄDUJE na [${m.toKey}] ${m.toBody}; zawrotu nie planuję.`, "warn");
          m.landing = true;
          m.recallAt = 0;
          Store.set("mission", m);
        }
      }
      if (m.missionType === "ASTEROID") Aster.learnCargo(m);
      const nextBtn2 = await this.clickWhenEnabled("Next");
      if (!nextBtn2) return this.abort("Next (krok 2) martwy");
      if ((nextBtn2 === nextBtn1 || nextBtn1.id && nextBtn2.id === nextBtn1.id) && !Once.said("samebtn23", 10 * 6e4)) {
        log(`[LOT DOM] podejrzenie: krok 2→3 kliknął ${nextBtn2 === nextBtn1 ? "DOKŁADNIE TEN SAM element" : "przycisk o tym samym id"} co krok 1→2 (id=${nextBtn1.id || "(brak)"}) — strona mogła nie zdążyć przejść do kroku 2. Krok1: ${(nextBtn1.outerHTML || "").slice(0, 300)} | Krok2 (w chwili klikania): ${(nextBtn2.outerHTML || "").slice(0, 300)} | #content teraz: ${(document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1200)}`, "error");
      }
      const t1 = Date.now();
      while (Date.now() - t1 < 8e3 && !this.findButton("Send fleet")) await sleep(400);
      const missions = [ ...document.querySelectorAll(".mission-item, [class*='mission-item']") ];
      const nameOf = el => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
      const wanted = m.missionType === "EXPEDITION" ? [ "EXPEDITION", "EKSPEDYCJ" ] : m.missionType === "ASTEROID" ? [ "ASTEROID_MINING", "ASTEROID" ] : m.missionType === "COLLECT" ? [ "RECYCL", "HARVEST" ] : m.missionType === "ATTACK" ? [ "ATTACK", "ATAK" ] : this.MISSIONS;
      const zakazane = m.missionType === "ATTACK" ? /ACS|ALLIANCE|UNION|FEDERA|MISSILE|DESTR|GROUP/ : null;
      let picked = null;
      for (const w of wanted) {
        picked = missions.find(x => nameOf(x).includes(w) && !(zakazane && zakazane.test(nameOf(x))));
        if (picked) break;
      }
      if (!picked) {
        log(`[LOT DOM] brak misji ${wanted[0]}. Dostępne: ${missions.map(x => `${(x.textContent || "").trim().slice(0, 20)}[${x.className}]`).join(", ") || "NONE"}`, "error");
        if (m.kind === "farm") Farm.pause(30 * 6e4, "brak kafla misji Attack na kroku 3 formularza (zrzut dostępnych misji w logu)", m.toKey);
        return this.abort(`brak misji ${wanted[0]}`);
      }
      const pickTarget = picked.matches("a, button") ? picked : picked.querySelector("a, button, img") || picked.closest("a, button") || picked;
      pickTarget.click();
      log(`[LOT] misja: „${(picked.textContent || "").trim().slice(0, 24)}" (${picked.className}${pickTarget !== picked ? `, klik w <${pickTarget.tagName.toLowerCase()}>` : ""})`, "info");
      if (m.kind === "debris" && !Once.said("collect_dom", 6 * 36e5)) log(`[ZŁOM DOM] kafel misji: ${(picked.outerHTML || "").replace(/\s+/g, " ").slice(0, 600)}`, "info");
      await sleep(jitter(400, 800));
      if (m.duration) {
        const sel = [ ...document.querySelectorAll("select") ].find(x => [ ...x.options ].some(o => /min|hour|godz|\bh\b/i.test(o.textContent || "")));
        const opts = sel ? [ ...sel.options ] : [ ...document.querySelectorAll("[class*='duration'] a, [class*='duration'] li, [id*='duration'] option") ];
        const txt = o => (o.textContent || "").replace(/\s+/g, " ").trim();
        let hit = null, minutesHit = false;
        if (m.duration.minutes > 0) {
          hit = opts.find(o => {
            const t = txt(o);
            const mm = t.match(/^(\d+)\s*min/i);
            if (mm && +mm[1] === m.duration.minutes) return true;
            const hh = t.match(/^(\d+[.,]\d+)\s*(h|hour|godz)/i);
            if (hh && hh[1].replace(",", ".").startsWith(String((m.duration.minutes / 60).toFixed(2)).slice(0, 3))) return true;
            return String(o.value ?? "") === String(m.duration.minutes) && /min/i.test(t);
          }) || null;
          minutesHit = !!hit;
        }
        if (!hit) hit = opts.find(o => {
          const t = txt(o);
          return !/min/i.test(t) && (t.match(/^(\d+)\b/) || [])[1] === String(m.duration.hours);
        }) || null;
        if (m.duration.minutes > 0 && !minutesHit && !Once.said("disc40", 15 * 6e4)) log(`[ODKRYWCA] brak opcji „${m.duration.minutes} min" (dostępne: ${opts.map(txt).join(", ") || "brak"}) — klasa to nie Odkrywca? Wysyłam na ${m.duration.hours} h.`, "warn");
        if (hit) {
          if (sel) {
            sel.value = hit.value;
            sel.dispatchEvent(new Event("change", {
              bubbles: true
            }));
          } else hit.click();
          log(`[EXPO] czas trwania: ${txt(hit)}`, "info");
          await sleep(jitter(400, 700));
        } else if (!Once.said("dur_dom", 15 * 6e4)) log(`[EXPO DOM] nie znalazłem wyboru czasu trwania: ${(document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1500)}`, "warn");
        m.holdMs = hit ? minutesHit ? m.duration.minutes * 6e4 : m.duration.hours * 36e5 : (m.duration.hours || 1) * 36e5;
      }
      if (m.takeResources !== false) {
        const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
        if (allRes) allRes.click(); else [ ...document.querySelectorAll("a.btn-res-full, .btn-res-full") ].forEach(b => b.click());
        await sleep(jitter(400, 700));
        await this.deutFirst(m);
        await this.applyReserve();
      }
      const send = this.findButton("Send fleet") || [ ...document.querySelectorAll("a, button, input[type='submit']") ].find(el => /send fleet/i.test(el.value || el.textContent || "") && el.offsetParent !== null);
      if (!send) return this.abort("brak przycisku Send fleet");
      const shipsBefore = snap.total;
      const beforeMap = {};
      for (const x of snap.ships || []) beforeMap[String(x.type).toUpperCase()] = (beforeMap[String(x.type).toUpperCase()] || 0) + (x.qty || 0);
      if (ECO_KIND(m.kind) && m.flightMs) {
        const sE = Situation.load();
        const nowy = {
          kind: m.kind,
          fromKey: m.fromKey,
          fromBody: m.fromBody,
          total: loadedTotal,
          sentAt: Date.now(),
          flightMs: m.flightMs,
          holdMs: m.holdMs || 0,
          returnAt: Date.now() + 2 * m.flightMs + (m.holdMs || 0),
          pending: true
        };
        const wszystkie = [ ...sE.expected || [], nowy ];
        sE.expected = [ ...wszystkie.filter(e => e.kind !== "farm").slice(-40), ...wszystkie.filter(e => e.kind === "farm").slice(-160) ].sort((x, y) => (x.sentAt || 0) - (y.sentAt || 0));
        if (m.kind === "expedition") sE.expoHome = {
          key: m.fromKey,
          body: m.fromBody,
          at: Date.now()
        };
        Situation.save(sE);
      }
      if (!ECO_KIND(m.kind)) {
        const sPre = Situation.load();
        const inAir = f => !!f.recallAt && [ "launched", "recall_clicked", "recall_failed" ].includes(f.phase);
        const zdjete = [];
        sPre.flights = (sPre.flights || []).filter(f => {
          if (f.fromKey !== m.fromKey) return true;
          if (f.pending && f.fromBody === m.fromBody) return false;
          if (inAir(f)) return true;
          if (!f.pending && !(f.kind === "home" && !f.recallAt)) zdjete.push(f);
          return false;
        });
        for (const f of zdjete) Journal.add("BŁĄD", `Nadpisuję wpis lotu [${f.fromKey}] ${f.fromBody} → [${f.toKey}] (${f.kind}/${f.phase}) nowym lotem z tego samego ciała — zawrotu tamtej floty bot już NIE kliknie. Sprowadź ją ręcznie.`);
        sPre.flights.push({
          kind: m.air ? "air" : m.home ? "home" : "swap",
          fs: !!m.fs,
          evac: !!m.evac,
          excludeTypes: m.excludeTypes || null,
          capTypes: m.capTypes || null,
          fromKey: m.fromKey,
          fromBody: m.fromBody,
          toKey: m.toKey,
          toBody: m.toBody,
          id: Fly.newId(),
          sentAt: Date.now(),
          flightMs: m.flightMs || 0,
          recallAt: this.recallOf(m),
          phase: "launched",
          tries: 0,
          pending: true
        });
        Situation.save(sPre);
      }
      Store.set("last_send", {
        at: Date.now(),
        toKey: m.toKey,
        toBody: m.toBody,
        kind: m.kind,
        from: m.fromKey,
        fromBody: m.fromBody,
        startedAt: m.startedAt,
        loaded: loaded.join(", "),
        total: loadedTotal,
        before: shipsBefore,
        ships: loadedMap,
        beforeShips: beforeMap
      });
      if (m.missionType === "ASTEROID") Aster.learnCargo(m);
      log("[LOT] Send fleet kliknięty.", "success");
      Nav.click(send, `wysyłka floty [${m.fromKey}]→[${m.toKey}] (Send fleet)`);
      await sleep(jitter(3e3, 4500));
      let okUrl = location.href.includes("fleetSendSuccessfully");
      let after = null, fresh = false;
      if (!okUrl) {
        const prob = ECO_KIND(m.kind) ? 3 : 2;
        for (let p = 0; p < prob; p++) {
          if (p) await sleep(jitter(2500, 4e3));
          if (location.href.includes("fleetSendSuccessfully")) {
            okUrl = true;
            break;
          }
          let h = null;
          try {
            h = await Hangar.scanRemote(m.fromKey, m.fromBody);
          } catch {}
          if (h && typeof h.total === "number") {
            after = h;
            fresh = true;
            if (h.total < shipsBefore - Math.floor(loadedTotal * .1)) break;
          }
        }
      }
      if (!after && page() === "fleet") after = Hangar.scan();
      const expectedLeft = Math.max(0, shipsBefore - loadedTotal);
      const tol = Math.floor(loadedTotal * .1);
      const ok = okUrl || after && loadedTotal > 0 && after.total <= expectedLeft + tol;
      const partial = !ok && fresh && loadedTotal > 0 && after.total < shipsBefore - tol;
      if (!ok && !partial) {
        const err = [ ...document.querySelectorAll(".swal2-popup .swal2-html-container, .swal2-popup #swal2-content, .swal2-popup .swal2-title, .error, .alert, .modal.show, [class*='error']") ].find(e => !e.closest("#ogx3-panel") && (e.textContent || "").trim());
        const disabledTxt = this.isDisabled(send) ? " — przycisk „Send fleet” jest WYŁĄCZONY (gra nie przyjmuje tej floty: slot? deuter?)" : "";
        log(`[LOT] wysyłka NIE potwierdzona (${err ? (err.textContent || "").trim().slice(0, 160) : "brak komunikatu"}${disabledTxt}; hangar ${after ? `${after.total.toLocaleString("pl-PL")} szt.${fresh ? " (świeży odczyt z serwera)" : ""}, oczekiwano ≤ ${expectedLeft.toLocaleString("pl-PL")}` : "nieodczytany"})`, "error");
        const sBad = Situation.load();
        sBad.flights = (sBad.flights || []).filter(f => !(f.fromKey === m.fromKey && (f.fromBody || m.fromBody) === m.fromBody && f.pending));
        sBad.expected = (sBad.expected || []).filter(e => !(e.fromKey === m.fromKey && e.pending));
        Situation.save(sBad);
        return this.abort("brak potwierdzenia wysyłki");
      }
      let sentReal = 0;
      if (fresh) {
        sentReal = Math.max(0, shipsBefore - after.total);
        const lsTu = {
          ships: loadedMap,
          beforeShips: beforeMap,
          total: loadedTotal
        };
        const wyladowala = this.landedDuring(lsTu, after.ships, sentReal);
        if (wyladowala) sentReal = 0;
        const brak = wyladowala ? [] : this.shortfall(lsTu, after.ships);
        if (wyladowala) {
          log(`[LOT] wysyłka potwierdzona świeżym odczytem hangaru; w tym czasie wylądowała flota, więc nie oceniam, ile dokładnie poleciało (zostało ${after.total.toLocaleString("pl-PL")} szt.).`, "info");
        } else if (partial || brak.length) {
          log(`[LOT] po wysyłce w hangarze ${m.fromBody} [${m.fromKey}] zostało ponad plan: ${this.shortfallTxt(brak) || "(różnica bez wskazania typu)"} (odjęcie hangaru dałoby ~${sentReal.toLocaleString("pl-PL")} z ${loadedTotal.toLocaleString("pl-PL")} szt.). To lądowanie fali w sekundzie wysyłki (22.09: „737 mln” wróciło jako 3,7 mld) — rejestr powrotów trzyma to, co wpisano w formularz. ${ECO_KIND(m.kind) ? "Reszta poleci z następną falą." : "Obrona widzi resztę w hangarze."}`, "info");
        } else {
          log(`[LOT] strona nie przeładowała się po „Send fleet”, ale świeży odczyt hangaru potwierdza wysyłkę (zostało ${after.total.toLocaleString("pl-PL")} szt.).`, "info");
        }
      }
      this.confirmed(m, {
        loaded: loaded.join(", "),
        fresh: fresh ? after.total : null,
        sentReal: sentReal
      });
      if (okUrl && /cały hangar/.test(m.why || "") && !m.splitOnForm && Expo.maybeReturnOperator("czekam na powroty")) return;
      if (okUrl) Nav.go("/", "po wysyłce floty — powrót na stronę główną");
    },
    async deutFirst(m) {
      const tag = `[LOT] deuter najpierw [${m.fromKey}] ${m.fromBody}`;
      try {
        const fulls = [ ...document.querySelectorAll("a.btn-res-full, .btn-res-full") ];
        if (fulls.length < 3) {
          if (!Once.said("deut_first_dom", 6 * 36e5)) log(`${tag}: nie widzę 3 wierszy surowców (${fulls.length}), zostawiam ładunek gry.`, "warn");
          return;
        }
        const rowOf = f => {
          let r = f.parentElement;
          while (r && r.parentElement && r.parentElement.querySelectorAll("a.btn-res-full, .btn-res-full").length === 1) r = r.parentElement;
          return r || f.parentElement;
        };
        const rows = fulls.map(rowOf);
        const byName = re => {
          for (const r of rows) {
            const i = r && [ ...r.querySelectorAll("input") ].find(x => re.test(x.name || "") || re.test(x.id || ""));
            if (i) return i;
          }
          return null;
        };
        const inRow = i => rows[i] && rows[i].querySelector("input");
        const iM = byName(/metal/i) || inRow(0), iC = byName(/cryst|kryszt/i) || inRow(1), iD = byName(/deut/i) || inRow(2);
        if (!iM || !iC || !iD || new Set([ iM, iC, iD ]).size < 3) {
          if (!Once.said("deut_first_dom", 6 * 36e5)) log(`${tag}: nie rozpoznaję pól metal/kryształ/deuter, zostawiam ładunek gry.`, "warn");
          return;
        }
        const val = i => parseInt(String(i.value || "0").replace(/[^\d]/g, ""), 10) || 0;
        const m0 = val(iM), c0 = val(iC), d0 = val(iD), razem = m0 + c0 + d0;
        const el = document.querySelector(".resource-item-deuterium, #resources_deuterium");
        const dTxt = el ? el.textContent || "" : "";
        const dm = dTxt.match(/\d[\d .,']*/);
        const skrot = /\d\s?(k|m|b|t|tys|mln|mld|bln)\b/i.test(dTxt);
        const naCiele = dm && !skrot ? parseInt(dm[0].replace(/[^\d]/g, ""), 10) : NaN;
        if (!Number.isFinite(naCiele)) {
          if (!Once.said("deut_first_bar", 6 * 36e5)) log(`${tag}: nie widzę stanu deuteru na pasku surowców, zostawiam ładunek gry.`, "warn");
          return;
        }
        if (naCiele < d0) {
          log(`${tag}: pasek pokazuje ${naCiele.toLocaleString("pl-PL")} deuteru, a w polu jest ${d0.toLocaleString("pl-PL")} — odczyt niespójny, zostawiam ładunek gry.`, "warn");
          return;
        }
        const cel = Math.min(naCiele, razem);
        if (cel <= d0) return;
        let brak = cel - d0;
        const zM = Math.min(m0, brak);
        brak -= zM;
        const zC = Math.min(c0, brak);
        brak -= zC;
        const dN = d0 + zM + zC;
        const ustaw = async () => {
          setInput(iM, m0 - zM);
          await sleep(150);
          setInput(iC, c0 - zC);
          await sleep(150);
          setInput(iD, dN);
          await sleep(300);
        };
        await ustaw();
        if (val(iM) !== m0 - zM || val(iC) !== c0 - zC || val(iD) !== dN) await ustaw();
        if (val(iM) !== m0 - zM || val(iC) !== c0 - zC || val(iD) !== dN) {
          log(`${tag}: formularz nie przyjął zmian (metal ${val(iM)}, kryształ ${val(iC)}, deuter ${val(iD)}) — przywracam ładunek gry.`, "warn");
          const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
          if (allRes) {
            allRes.click();
            await sleep(jitter(400, 700));
          } else {
            setInput(iD, d0);
            setInput(iC, c0);
            setInput(iM, m0);
            await sleep(300);
          }
          return;
        }
        log(`${tag}: deuter ${d0.toLocaleString("pl-PL")} → ${dN.toLocaleString("pl-PL")} (na ciele ${naCiele.toLocaleString("pl-PL")}), metal −${zM.toLocaleString("pl-PL")}, kryształ −${zC.toLocaleString("pl-PL")}; ładunek razem bez zmian ${razem.toLocaleString("pl-PL")}.`, "info");
      } catch (e) {
        log(`${tag}: ${e.message}`, "warn");
      }
    },
    async applyReserve() {
      const reserve = Number(CFG.deutReserve) || 0;
      if (!reserve) return;
      try {
        const fulls = [ ...document.querySelectorAll("a.btn-res-full, .btn-res-full") ];
        if (fulls.length < 3) return;
        const rowOf = f => {
          let r = f.parentElement;
          while (r && r.parentElement && r.parentElement.querySelectorAll("a.btn-res-full, .btn-res-full").length === 1) r = r.parentElement;
          return r || f.parentElement;
        };
        const full = fulls.find(f => /deut/i.test((rowOf(f)?.textContent || "") + " " + (rowOf(f)?.querySelector("input")?.name || ""))) || fulls[2];
        const input = rowOf(full)?.querySelector("input[name*='deut' i]") || rowOf(full)?.querySelector("input");
        if (!input) return;
        const cur = parseInt((input.value || "0").replace(/[^\d]/g, "")) || 0;
        setInput(input, Math.max(0, cur - reserve));
        log(`[LOT] rezerwa deuteru: zostawiam ${Math.min(cur, reserve).toLocaleString("pl-PL")}, zabieram ${Math.max(0, cur - reserve).toLocaleString("pl-PL")}`, "info");
        await sleep(300);
      } catch (e) {
        log(`[LOT] rezerwa: ${e.message}`, "warn");
      }
    },
    async recall(f0) {
      const s = Situation.load();
      let f = (s.flights || []).find(x => f0.id && x.id === f0.id || !f0.id && x.fromKey === f0.fromKey && x.toKey === f0.toKey && (x.sentAt === f0.sentAt || !f0.sentAt));
      if (!f) {
        f = {
          ...f0
        };
        s.flights = [ ...s.flights || [], f ];
      }
      const a = PlanetBar.active();
      if (!a || a.key !== f.fromKey) {
        const el = PlanetBar.anchor(f.fromKey, f.fromBody);
        if (el) {
          f.navTries = (f.navTries || 0) + 1;
          if (f.navTries > 5) {
            f.phase = "recall_failed";
            Situation.save(s);
            log(`[ZAWRÓT] pięć klików w [${f.fromKey}] ${f.fromBody} i nadal stoję na [${a ? a.key : "?"}] — przestaję przeładowywać grę. Zawróć flotę ręcznie.`, "error");
            Journal.add("BŁĄD", `Nie umiem przełączyć się na [${f.fromKey}] (5 klików bez skutku) — zawróć lot [${f.fromKey}]→[${f.toKey}] ręcznie.`);
            return;
          }
          Situation.save(s);
          log(`[ZAWRÓT] przełączam na [${f.fromKey}] ${f.fromBody} (${f.navTries}/5)`, "info");
          Nav.click(el, `zawrót lotu [${f.fromKey}]→[${f.toKey}]: przełączam parę`);
          return;
        }
        f.tries = (f.tries || 0) + 1;
        if (f.tries >= 5) {
          f.phase = "recall_failed";
          Journal.add("BŁĄD", `Nie mogę przełączyć się na [${f.fromKey}] — zawróć flotę ręcznie.`);
        }
        Situation.save(s);
        log(`[ZAWRÓT] brak [${f.fromKey}] ${f.fromBody} na pasku planet (${f.tries}/5)`, "warn");
        return;
      }
      if (f.navTries) {
        f.navTries = 0;
        Situation.save(s);
      }
      let html = "";
      try {
        const r = await fetchT(Rows.URL, {
          headers: {
            "X-Requested-With": "XMLHttpRequest"
          }
        });
        if (r.ok) html = await r.text();
      } catch {}
      const doc = (new DOMParser).parseFromString(html, "text/html");
      const trs = [ ...doc.querySelectorAll("tr[class*='row-mission-type-']") ];
      const ours = trs.filter(tr => /DEPLOY|STATION/i.test(tr.className) && (tr.textContent || "").includes(`[${f.toKey}]`) && (tr.textContent || "").includes(`[${f.fromKey}]`));
      if (f.rowId) {
        const moj = trs.find(tr => tr.getAttribute("data-fleet-id") === f.rowId);
        if (moj && /return/i.test(moj.className)) {
          f.phase = "recalled";
          f.recalledAt = f.recalledAt || Date.now();
          Situation.save(s);
          log(`[ZAWRÓT] ✅ lot [${f.fromKey}]→[${f.toKey}] (wiersz ${String(f.rowId).slice(0, 12)}…) już WRACA.`, "success");
          Journal.add("POWRÓT", `Zawrót potwierdzony: flota wraca na [${f.fromKey}].`);
          return;
        }
        if (moj) {
          const id2 = f.rowId;
          let live2 = document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id2}"]`);
          if (!live2) {
            for (const t of [ ...document.querySelectorAll("a, button, div, span") ].filter(e => e.offsetParent !== null && !e.closest("#ogx3-panel") && /fleet\s*movements|^events$|\d+\s*Missions?/i.test((e.textContent || "").trim()))) {
              t.click();
              for (let i = 0; i < 8 && !live2; i++) {
                await sleep(500);
                live2 = document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id2}"]`);
              }
              if (live2) break;
            }
          }
          if (!live2) {
            if (page() !== "fleet") {
              Nav.go("/fleet", `zawrót lotu [${f.fromKey}]→[${f.toKey}] (wiersz przypięty)`);
              return;
            }
            f.tries = (f.tries || 0) + 1;
            Situation.save(s);
            log(`[ZAWRÓT] brak przycisku zawracania dla przypiętego wiersza (${f.tries}/5)`, "warn");
            return;
          }
          const w2 = typeof unsafeWindow !== "undefined" && unsafeWindow || window;
          const o2 = w2.confirm;
          try {
            w2.confirm = () => true;
            live2.click();
            await sleep(800);
          } finally {
            try {
              w2.confirm = o2;
            } catch {}
          }
          f.phase = "recall_clicked";
          f.recalledAt = Date.now();
          Situation.save(s);
          log(`[ZAWRÓT] kliknięty po przypiętym wierszu ${String(f.rowId).slice(0, 12)}… ([${f.fromKey}]→[${f.toKey}]) — czekam na klasę return.`, "success");
          Journal.add("POWRÓT", `Zawrót wysłany: flota wraca na [${f.fromKey}].`);
          return;
        }
      }
      const wracaRows = ours.filter(tr => /return/i.test(tr.className)).length;
      const juzZawrocone = (s.flights || []).filter(x => x !== f && x.fromKey === f.fromKey && x.toKey === f.toKey && (x.rowId || [ "recalled", "recall_clicked" ].includes(x.phase))).length;
      if (Fly.zawrotPotwierdzony(wracaRows, juzZawrocone)) {
        f.phase = "recalled";
        f.recalledAt = f.recalledAt || Date.now();
        Situation.save(s);
        log(`[ZAWRÓT] ✅ lot [${f.fromKey}]→[${f.toKey}] już WRACA (wierszy powrotnych ${wracaRows}, wcześniej zawróconych ${juzZawrocone}).`, "success");
        Journal.add("POWRÓT", `Zawrót potwierdzony: flota wraca na [${f.fromKey}].`);
        return;
      }
      const zajete = new Set((s.flights || []).filter(x => x !== f && x.rowId).map(x => x.rowId));
      const kandydaci = ours.filter(tr => !/return/i.test(tr.className) && !zajete.has(tr.getAttribute("data-fleet-id")));
      let row = kandydaci[0] || null;
      if (kandydaci.length > 1 && f.flightMs && f.sentAt) {
        const oczek = Math.max(0, (f.sentAt + f.flightMs - Date.now()) / 1e3);
        const etaWiersza = tr => etaOf(tr.querySelector("[data-remaining-seconds]") || tr.cells && tr.cells[0] || tr);
        row = kandydaci.reduce((a, b) => Math.abs(etaWiersza(b) - oczek) < Math.abs(etaWiersza(a) - oczek) ? b : a);
        log(`[ZAWRÓT] ${kandydaci.length} nieodróżnialne wiersze [${f.fromKey}]→[${f.toKey}] — biorę licznik najbliżej dolotu TEGO lotu (oczekiwane ~${Math.round(oczek)} s).`, "info");
      }
      if (!row) {
        f.tries = (f.tries || 0) + 1;
        f.recalledAt = Date.now();
        if (f.tries >= 5) {
          f.phase = "recall_failed";
          Journal.add("BŁĄD", `Nie widzę lotu [${f.fromKey}]→[${f.toKey}] na liście — zawróć ręcznie.`);
        }
        Situation.save(s);
        log(`[ZAWRÓT] brak wiersza lotu (${f.tries}/5). Wiersze: ${trs.map(tr => tr.className.replace(/\s+/g, " ") + " :: " + (tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100)).join(" || ").slice(0, 1200)}`, "warn");
        return;
      }
      const id = row.getAttribute("data-fleet-id") || "";
      let live = id ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id}"]`) : document.querySelector("a.x_btn_fleet_return");
      if (!live) {
        for (const t of [ ...document.querySelectorAll("a, button, div, span") ].filter(e => e.offsetParent !== null && !e.closest("#ogx3-panel") && /fleet\s*movements|^events$|\d+\s*Missions?/i.test((e.textContent || "").trim()))) {
          t.click();
          for (let i = 0; i < 8 && !live; i++) {
            await sleep(500);
            live = id ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id}"]`) : document.querySelector("a.x_btn_fleet_return");
          }
          if (live) break;
        }
      }
      if (!live) {
        if (page() !== "fleet") {
          Nav.go("/fleet", `zawrót lotu [${f.fromKey}]→[${f.toKey}]`);
          return;
        }
        f.tries = (f.tries || 0) + 1;
        Situation.save(s);
        log(`[ZAWRÓT] brak przycisku zawracania (${f.tries}/5)`, "warn");
        return;
      }
      const w = typeof unsafeWindow !== "undefined" && unsafeWindow || window;
      const orig = w.confirm;
      try {
        w.confirm = () => true;
        live.click();
        await sleep(800);
      } finally {
        try {
          w.confirm = orig;
        } catch {}
      }
      f.phase = "recall_clicked";
      f.recalledAt = Date.now();
      Situation.save(s);
      log(`[ZAWRÓT] kliknięty dla [${f.fromKey}]→[${f.toKey}] — czekam na potwierdzenie wierszem powrotnym.`, "success");
      Journal.add("POWRÓT", `Zawrót wysłany: flota wraca na [${f.fromKey}].`);
    }
  };
  const Wake = {
    _lock: null,
    _ctx: null,
    _busy: false,
    async ensure() {
      try {
        if ("wakeLock" in navigator && document.visibilityState === "visible" && !this._busy && (!this._lock || this._lock.released)) {
          this._busy = true;
          try {
            this._lock = await navigator.wakeLock.request("screen");
            this._lock.addEventListener?.("release", () => log("[WAKE] blokada uśpienia zwolniona.", "warn"));
            if (!Once.said("wake_on", 6 * 36e5)) log("[WAKE] blokada uśpienia aktywna — komputer nie zaśnie, póki karta z grą jest widoczna.", "info");
          } finally {
            this._busy = false;
          }
        }
      } catch (e) {
        if (!Once.said("wake_err", 36e5)) log(`[WAKE] nie udało się zablokować uśpienia: ${e.message}`, "warn");
      }
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this._ctx) {
          this._ctx = new Ctx;
          const o = this._ctx.createOscillator(), g = this._ctx.createGain();
          g.gain.value = 1e-4;
          o.frequency.value = 20;
          o.connect(g);
          g.connect(this._ctx.destination);
          o.start();
          if (!Once.said("wake_audio", 6 * 36e5)) log("[WAKE] karta trzymana przy życiu cichym dźwiękiem — w tle nie zostanie zdławiona.", "info");
        }
        if (this._ctx.state === "suspended") await this._ctx.resume();
      } catch {}
    }
  };
  const Calib = {
    need() {
      return Store.get("calib_done", false) !== true;
    },
    get() {
      return Store.get("calib", {}) || {};
    },
    put(part, data) {
      const c = this.get();
      if (c[part]) return;
      c[part] = {
        at: Date.now(),
        data: String(data).slice(0, 4e3)
      };
      Store.set("calib", c);
      log(`[KALIBRACJA] zebrano: ${part} (${Object.keys(c).length}/4). Gdy będzie komplet — klik „Kopiuj raport startowy".`, "info");
      this.check();
    },
    check() {
      const c = this.get();
      if ([ "planetBar", "bar", "events", "fleetPage" ].every(k => c[k])) {
        Store.set("calib_done", true);
        log("[KALIBRACJA] KOMPLET — kliknij przycisk kopiowania raportu startowego i wyślij go do Claude'a. Do tego czasu zostaw tryb Obserwator.", "success");
        Notifier.push(`📋 Raport startowy gotowy (${UNI})`, "Skopiuj raport z panelu i wyślij Claude'owi (potwierdzenie parserów).", "default", "clipboard");
      }
    },
    collect() {
      if (!this.need()) return;
      try {
        const bar = document.querySelector("a.planet-select, .planet-select");
        if (bar) this.put("planetBar", (bar.closest("ul, div, nav, aside") || bar.parentElement).outerHTML.replace(/\s+/g, " "));
        const b = Bar.read();
        if (b) this.put("bar", `parse=${JSON.stringify(b)} | tekst=${document.body.textContent.replace(/\s+/g, " ").match(/.{0,80}Missions?.{0,220}/i)?.[0] || "(brak segmentu Missions)"}`);
        const ev = document.querySelector("#fleet-movement-content, #layoutFleetMovements");
        if (ev && (ev.textContent || "").trim().length > 20) this.put("events", ev.outerHTML.replace(/\s+/g, " "));
        if (page() === "fleet") {
          const ships = [ ...document.querySelectorAll("[data-ship-type]") ];
          const one = ships[0] ? (ships[0].closest(".ship-item") || ships[0].parentElement).outerHTML.replace(/\s+/g, " ") : "(brak [data-ship-type])";
          this.put("fleetPage", `statki=${ships.length} (${ships.map(e => e.dataset.shipType).join(",")}) | pierwszy wiersz=${one} | pola celu=${[ "fleet2_target_x", "fleet2_target_y", "fleet2_target_z" ].map(id => id + ":" + (document.getElementById(id) ? "jest" : "BRAK")).join(", ")} | data-planet-type=${document.querySelectorAll("[data-planet-type]").length} | mission-item=${[ ...document.querySelectorAll(".mission-item, [class*='mission-item']") ].map(m => (m.textContent || "").trim().slice(0, 14) + "[" + m.className + "]").join(", ") || "BRAK"} | btn-all-res=${document.querySelector("a.btn-all-res, .btn-all-res") ? "jest" : "BRAK"}`);
        }
      } catch (e) {
        log(`[KALIBRACJA] błąd zbierania: ${e.message}`, "warn");
      }
    },
    report() {
      const c = this.get();
      const head = `RAPORT STARTOWY OGameX 3 v${VERSION} · ${HOST} · ${(new Date).toLocaleString("pl-PL")}\nPary: ${JSON.stringify(PlanetBar.pairs())}\nAktywne: ${JSON.stringify(PlanetBar.active())}\nPasek: ${JSON.stringify(Bar.read())}\n`;
      const parts = [ "planetBar", "bar", "events", "fleetPage" ].map(k => `\n──── ${k} ${c[k] ? "" : "(BRAK — odwiedź odpowiednią stronę)"}\n${c[k]?.data || ""}`).join("");
      return head + parts;
    }
  };
  function navGuard(m, fly) {
    const k = `${m.fromKey}>${m.toKey}`;
    const g = Store.get("form_nav", null) || {};
    const tries = g.key === k && Date.now() - (g.at || 0) < 3 * 6e4 ? (g.tries || 0) + 1 : 1;
    Store.set("form_nav", {
      key: k,
      at: Date.now(),
      tries: tries
    });
    if (tries >= 3) {
      Store.set("form_nav", null);
      return fly.abort(`formularz nie otwiera się pod ${fly.url(m)} (3 próby) — fork oddaje inną stronę`);
    }
    if (tries === 2) log(`[LOT] drugi raz wchodzę na ${fly.url(m)}, a to nie jest strona floty — jeśli powtórzy się raz jeszcze, przerywam lot.`, "warn");
    fly.bumpNav(m);
    Nav.go(fly.url(m), `lot: formularz [${m.fromKey}]→[${m.toKey}] (próba ${tries})`);
  }
  const Recon = {
    st() {
      return Store.get("recon", {
        at: 0,
        idx: 0
      }) || {
        at: 0,
        idx: 0
      };
    },
    bodiesOf(s) {
      const all = [];
      for (const [k, p] of Object.entries(s.pairs || {})) {
        all.push([ k, "planet" ]);
        if (p.hasMoon) all.push([ k, "moon" ]);
      }
      const lostPlanets = Object.keys(s.moonLost || {}).map(k => [ k, "planet" ]);
      const dedupe = list => [ ...new Map(list.map(e => [ `${e[0]}|${e[1]}`, e ])).values() ];
      if ((CFG.reconMode || "fleet") === "all") return dedupe([ ...all, ...lostPlanets ]);
      const lf = CFG.expo && CFG.expo.launchFrom ? key(CFG.expo.launchFrom) : null;
      if (lf) return dedupe([ ...all.filter(([k]) => k === lf), ...lostPlanets ]);
      const eh = s.expoHome && Date.now() - (s.expoHome.at || 0) < 7 * 24 * 36e5 ? `${s.expoHome.key}|${s.expoHome.body}` : null;
      return dedupe([ ...all.filter(([k, b]) => {
        const h = (s.hangars || {})[`${k}|${b}`];
        return `${k}|${b}` === eh || !!(h && h.total > 0);
      }), ...lostPlanets ]);
    },
    async tick(s) {
      if (!CFG.recon || Fly.mission()) return false;
      const now = Date.now();
      if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) return false;
      if (!Human.playing()) {
        const bg = Store.get("recon_bg", {
          at: 0,
          idx: 0
        }) || {
          at: 0,
          idx: 0
        };
        if (now - (bg.at || 0) > 6e4) {
          const covered = new Set(this.bodiesOf(s).map(([k, b]) => `${k}|${b}`));
          const rest = [];
          for (const [k, p] of Object.entries(s.pairs || {})) {
            for (const b of p.hasMoon ? [ "planet", "moon" ] : [ "planet" ]) {
              const hk = `${k}|${b}`;
              if (covered.has(hk)) continue;
              const h = (s.hangars || {})[hk];
              const ttlBg = CFG.stealth && CFG.stealth.enabled ? (CFG.stealth.colonyHours || 8) * 36e5 : CFG.reconEmptyMs || 45 * 6e4;
              if (h && now - (h.at || 0) < ttlBg) continue;
              rest.push([ k, b ]);
            }
          }
          if (rest.length) {
            const [bk, bb] = rest[(bg.idx || 0) % rest.length];
            Store.set("recon_bg", {
              at: now,
              idx: (bg.idx || 0) + 1
            });
            const got = await Hangar.scanRemote(bk, bb);
            if (got && got.total > 0 && !Once.said(`bg|${bk}|${bb}`, 6 * 36e5)) {
              log(`[REKONESANS] kolonia ${bb} [${bk}] odczytana w tle: ${got.total.toLocaleString("pl-PL")} szt. — teraz wiem, że tam coś stoi.`, "info");
            }
          }
        }
      }
      if (flightsBlocking(s, Date.now())) return false;
      const st = this.st();
      if (now - (st.at || 0) < 9e4) return false;
      const manual = Store.get("manual_at", 0) || 0;
      if (now - manual < 45e3 && now - (st.at || 0) < 5 * 6e4) {
        if (!Once.said("recon_manual", 5 * 6e4)) log("[REKONESANS] grasz — nie przełączam Ci planety. Wrócę, gdy przestaniesz klikać (najdalej za 5 min).", "info");
        return false;
      }
      const stale2 = h => now - h.at > (h.total > 0 ? CFG.reconMs : CFG.reconEmptyMs || CFG.reconMs);
      const stale = (k, b) => {
        const h = s.hangars[`${k}|${b}`];
        if (!h) return true;
        return stale2(h);
      };
      const allowed = new Set(this.bodiesOf(s).map(([k, b]) => `${k}|${b}`));
      const a = s.active;
      if (a && stale(a.key, a.body)) {
        if (page() === "fleet") {
          Hangar.scan();
          const h2 = (Situation.load().hangars || {})[`${a.key}|${a.body}`];
          if (h2 && !stale2(h2)) return false;
        }
        if (allowed.size === 0 || allowed.has(`${a.key}|${a.body}`)) {
          Store.set("recon", {
            ...st,
            at: now
          });
          const quiet = await Hangar.scanRemote(a.key, a.body);
          if (quiet) {
            log(`[REKONESANS] hangar ${a.body} [${a.key}] odczytany w tle (${quiet.total.toLocaleString("pl-PL")} szt.) — bez przełączania strony.`, "info");
            return false;
          }
          if (page() === "fleet") return false;
          log(`[REKONESANS] sprawdzam hangar ${a.body} [${a.key}] — bez tego nie wiem, gdzie stoi flota.`, "info");
          const [g, sy, po] = a.key.split(":");
          Nav.go(`/fleet?x=${g}&y=${sy}&z=${po}`, `rekonesans hangaru ${a.body} [${a.key}]`);
          return true;
        }
        if (!Once.said("recon_skip_active", 30 * 6e4)) log(`[REKONESANS] jesteś na [${a.key}] — to nie jest ciało, które pilnuję, więc nie otwieram Ci zakładki Flota.`, "info");
      }
      const list = this.bodiesOf(s).filter(([k, b]) => stale(k, b));
      if (!list.length) return false;
      const [k, b] = list[(st.idx || 0) % list.length];
      const el = PlanetBar.anchor(k, b);
      if (!el) {
        Store.set("recon", {
          at: now,
          idx: (st.idx || 0) + 1
        });
        return false;
      }
      Store.set("recon", {
        at: now,
        idx: (st.idx || 0) + 1
      });
      const quiet2 = await Hangar.scanRemote(k, b);
      if (quiet2) {
        log(`[REKONESANS] hangar ${b} [${k}] odczytany w tle (${quiet2.total.toLocaleString("pl-PL")} szt.) — bez przełączania planety.`, "info");
        return false;
      }
      log(`[REKONESANS] przechodzę na ${b} [${k}], żeby odczytać hangar.`, "info");
      el.click();
      return true;
    }
  };
  let running = false;
  function emptySourceHangar(fromKey, fromBody, why, keepTypes, capTypes) {
    try {
      const s = Situation.load();
      const hk = `${fromKey}|${fromBody}`;
      const h = s.hangars[hk];
      if (!h || (h.total || 0) === 0) return;
      const lot = (s.flights || []).filter(x => x.fromKey === fromKey && x.fromBody === fromBody && x.phase !== "done").sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))[0];
      if (lot && lot.leftHome !== undefined && (h.total || 0) === lot.leftHome) return;
      const keep = new Set((keepTypes || []).map(t => String(t).toUpperCase()));
      const cap = new Map(Object.entries(capTypes || {}).map(([t, n]) => [ String(t).toUpperCase(), Math.max(0, parseInt(n, 10) || 0) ]));
      const left = keep.size || cap.size ? (h.ships || []).map(x => {
        const t = String(x.type).toUpperCase();
        if (keep.has(t)) return (x.qty || 0) > 0 ? x : null;
        if (cap.has(t)) {
          const zostalo = Math.max(0, (x.qty || 0) - cap.get(t));
          return zostalo > 0 ? {
            ...x,
            qty: zostalo
          } : null;
        }
        return null;
      }).filter(Boolean) : [];
      const total = left.reduce((x, sh) => x + (sh.qty || 0), 0);
      s.hangars[hk] = {
        total: total,
        ships: left,
        at: Date.now(),
        estFrom: lot ? lot.sentAt || 0 : 0
      };
      if (lot) lot.leftHome = total;
      Situation.save(s);
      log(total ? `[LOT] hangar ${fromBody} [${fromKey}]: flota wyleciała, w domu zostaje ${total.toLocaleString("pl-PL")} szt. celowo pominiętych (${left.map(x => x.type).join(", ")}) — ${why}.` : `[LOT] hangar ${fromBody} [${fromKey}] wyzerowany — flota z niego wyleciała (${why}).`, "info");
    } catch {}
  }
  function noteLeftHome(fromKey, fromBody, total) {
    try {
      const s = Situation.load();
      const lot = (s.flights || []).filter(x => x.fromKey === fromKey && x.fromBody === fromBody && x.phase !== "done").sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))[0];
      if (!lot) return;
      lot.leftHome = total;
      Situation.save(s);
    } catch {}
  }
  function confirmPendingSend() {
    try {
      if (!location.href.includes("fleetSendSuccessfully")) return;
      const ls = Store.get("last_send", null);
      if (!ls) return;
      const s = Situation.load();
      const f = (s.flights || []).find(x => x.pending && x.fromKey === ls.from && (!ls.fromBody || !x.fromBody || x.fromBody === ls.fromBody) && Math.abs((x.sentAt || 0) - ls.at) < 6e4);
      const e = (s.expected || []).find(x => x.pending && x.fromKey === ls.from && Math.abs((x.sentAt || 0) - ls.at) < 6e4);
      if (!f && !e) return;
      if (e) delete e.pending;
      if (f) delete f.pending;
      Situation.save(s);
      if (f) {
        log(`[LOT] wysyłka [${f.fromKey}]→[${f.toKey}] potwierdzona przez grę po przeładowaniu — wpis nie czeka na timeout.`, "success");
        emptySourceHangar(f.fromKey, f.fromBody, "potwierdzenie po przeładowaniu", f.excludeTypes, f.capTypes);
      }
    } catch {}
  }
  function defenceReadiness(s) {
    const braki = [];
    const now = Date.now();
    if (!CFG.enabled) braki.push("bot WYŁĄCZONY");
    if (!CFG.autoRescue) braki.push("auto-ratunek OFF — będę tylko alarmował, nie ruszę flotą");
    if (Session.lostRecently()) braki.push("SESJA WYGASŁA — zaloguj się");
    if (!Notifier.enabled()) braki.push("push OFF — nie dostaniesz alarmu na telefon");
    const guard = CFG.expo && CFG.expo.launchFrom ? key(CFG.expo.launchFrom) : s.active && s.active.key;
    if (!guard) braki.push("nie wiem, którego ciała pilnować (brak paska planet)"); else {
      const hm = (s.hangars || {})[`${guard}|moon`], hp = (s.hangars || {})[`${guard}|planet`];
      const swiezy = [ hm, hp ].some(h => h && now - (h.at || 0) < 30 * 6e4);
      if (!swiezy) braki.push(`hangar [${guard}] nieczytany od ponad 30 min — nie wiem, gdzie stoi flota`); else if (!Situation.fleetAt(s, guard, now)) {
        const wLocie = (s.flights || []).some(f => (f.fromKey === guard || f.toKey === guard) && f.phase !== "done" && !flightStale(f, now));
        if (!wLocie) braki.push(`na [${guard}] nie widzę żadnej floty (cała w powietrzu?)`);
      }
    }
    const lo = s.listOkAt || Store.get("list_ok_at", 0) || 0;
    if (!Session.lostRecently() && now - lo > 2 * 6e4) braki.push(`lista ruchów flot nie odpowiada od ${Math.round((now - lo) / 6e4)} min — nie widzę ataków, zostaje sam licznik na pasku`);
    if (s.listUntrusted) braki.push("sesja gry stoi na obcej kolonii (nie udało się przywrócić Twojej planety) — lista ruchów pokazuje ZŁĄ parę");
    if (!s.bar || now - (s.bar.at || 0) > (CFG.barMaxAgeMs || 3 * 6e4)) braki.push(`pasek misji ${s.bar ? `sprzed ${Math.round((now - (s.bar.at || 0)) / 6e4)} min` : "nieodczytany"} — ślepy alarm (ataki z własnego układu) NIE działa`);
    if (Object.keys(s.pairs || {}).length < 2) braki.push("jedna kolonia — nie ma dokąd uciec");
    if (Store.get("hb_ok", null) === false) braki.push(Store.get("hb_ever", false) === true ? "strażnik (watchdog) PRZESTAŁ odpowiadać — zawieszona karta nie zostanie ożywiona" : "na tej maszynie nie ma strażnika — zawieszona karta nie zostanie ożywiona (na Macu jest)");
    return braki;
  }
  async function defenceTick() {
    if (!running) syncCfg();
    if (running || !CFG.enabled) return;
    running = true;
    try {
      if (errorPageGuard()) return;
      if (!TabLock.acquire()) return;
      Store.set("last_tick", Date.now());
      Heartbeat.ping();
      confirmPendingSend();
      Wake.ensure();
      Calib.collect();
      if (page() === "fleet") Hangar.scan();
      const s = await Situation.refresh();
      const {actions: actions, alerts: alerts} = decide(s, CFG, Date.now());
      for (const a of alerts) {
        const k = `alert|${a.key}|${a.msg.replace(/\d+/g, "#").slice(0, 60)}`;
        if (Once.said(k, a.throttleMs || 6e4)) continue;
        log(`[OBRONA] ${a.msg}`, a.level === "error" ? "error" : "warn");
        if ((a.unknownPair || a.blind || a.push) && !Once.said(`push|${a.key}|${a.pushKey || "atak"}`, 5 * 6e4)) {
          Journal.add(a.pushKey === "slepota" ? "BŁĄD" : a.pushKey === "sonda" ? "SONDA" : "ATAK", a.msg);
          if (a.detail) Journal.add("PASEK", a.detail);
        }
      }
      if (Date.now() - (Store.get("ready_at", 0) || 0) > 5 * 6e4) {
        Store.set("ready_at", Date.now());
        const braki = defenceReadiness(s);
        if (braki.length) {
          if (!Once.said("gotowosc|" + braki.join("|").slice(0, 60), 60 * 6e4)) log(`[GOTOWOŚĆ] obrona NIE jest w pełni gotowa: ${braki.join("; ")}.`, "error");
        } else if (!Once.said("gotowosc_ok", 6 * 36e5)) {
          log("[GOTOWOŚĆ] obrona gotowa: bot ON, auto-ratunek ON, hangar świeży, jest dokąd uciec, push włączony.", "success");
        }
      }
      const attacks = (s.threats || []).filter(t => t.attack && t.arriveAt > Date.now());
      if (attacks.length) {
        const k = `atak|${attacks.map(t => t.id || t.dst).join(",")}`;
        const wKsiezyc = attacks.some(t => /DESTRUCT|DESTROY/i.test(String(t.type || "")));
        if (!Once.said(k, 10 * 6e4)) Journal.add("ATAK", (wKsiezyc ? "CELEM JEST KSIĘŻYC (DESTROY) — uciekam „stacjonuj” najwolniej jak fork pozwala i zawrócę flotę, gdy minie; jeśli księżyc padnie, odbuduję go. " : "") + attacks.map(t => `${t.type} → [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - Date.now()) / 1e3)}s (${t.source})`).join("; "));
      }
      const mNow = Fly.mission();
      if (mNow && ECO_KIND(mNow.kind)) {
        const urgent = (s.threats || []).some(t => t.attack && t.arriveAt > Date.now()) || actions.some(a => a.kind === "fly" && !a.fs || a.kind === "recall");
        if (urgent) Fly.abort("ALARM — obrona ma pierwszeństwo przed ekonomią", {
          quiet: true
        });
      } else if (mNow && !mNow.rescue && !mNow.blind) {
        const urgent = (s.threats || []).some(t => t.attack && t.arriveAt > Date.now()) || actions.some(a => a.kind === "fly" && (a.rescue || a.blind) || a.kind === "recall");
        const ls = Store.get("last_send", null);
        const wyslane = !!ls && ls.from === mNow.fromKey && ls.toKey === mNow.toKey && (ls.at || 0) >= (mNow.startedAt || 0);
        if (urgent && !wyslane) Fly.abort(`ALARM — ratunek ma pierwszeństwo przed lotem dobrowolnym (${mNow.why || mNow.kind})`, {
          quiet: true
        });
      }
      await Fly.tick();
      if (Fly.mission()) return;
      const RANK = {
        fly: 0,
        recall: 1,
        extend: 2,
        hold: 3,
        recon: 4
      };
      const prio = a => a.kind === "fly" && !a.rescue && !a.blind ? 5 : 0;
      actions.sort((x, y) => (RANK[x.kind] ?? 9) + prio(x) - ((RANK[y.kind] ?? 9) + prio(y)) || (x.etaMs ?? Infinity) - (y.etaMs ?? Infinity) || (y.saveTotal ?? 0) - (x.saveTotal ?? 0));
      const hasRescue = actions.some(a => a.kind === "fly" && (a.rescue || a.blind) || a.kind === "recall");
      const alarmNow = hasRescue || (s.threats || []).some(t => t.attack && t.arriveAt > Date.now());
      let cicheOdczyty = 0;
      for (const a of actions) {
        if (a.kind !== "recon" || !a.quiet || !a.alarm) continue;
        if (Human.playing()) break;
        const bq = a.body || "planet";
        if (Once.said(`qrecon|${a.key}|${bq}`, 6e4)) continue;
        try {
          const got = await Hangar.scanRemote(a.key, bq);
          log(`[OBRONA] ${a.why} — ${got ? `odczytany w tle (${got.total.toLocaleString("pl-PL")} szt.), bez przełączania planety` : "cichy odczyt nie wyszedł — ratuję bez czekania na hangar"}.`, "info");
        } catch (e) {
          log(`[OBRONA] cichy odczyt hangaru [${a.key}] nie wyszedł (${e.message}) — ratuję bez czekania.`, "warn");
        }
        if (++cicheOdczyty >= 3) break;
      }
      for (const a of actions) {
        if (a.kind === "recon") {
          if (hasRescue && CFG.autoRescue) {
            continue;
          }
          if (a.quiet) {
            if (Human.playing() && !a.alarm) continue;
            const bq = a.body || "planet";
            if (!Once.said(`qrecon|${a.key}|${bq}`, a.alarm || a.lost ? 2e4 : 5 * 6e4)) {
              const got = await Hangar.scanRemote(a.key, bq);
              log(`[OBRONA] ${a.why} — ${got ? `odczytany w tle (${got.total.toLocaleString("pl-PL")} szt.), bez przełączania planety` : "cichy odczyt nie wyszedł, poczekam na naturalny odczyt hangaru"}.`, "info");
            }
            continue;
          }
          const body = a.body || "planet";
          const act = Situation.load().active;
          if (act && act.key === a.key && act.body === body && page() === "fleet") {
            Hangar.scan();
            const g2 = Store.get("alarm_scan", {}) || {};
            if (g2[`${a.key}|${body}`]) {
              delete g2[`${a.key}|${body}`];
              Store.set("alarm_scan", g2);
            }
            continue;
          }
          {
            const kk = `${a.key}|${body}`;
            const g2 = Store.get("alarm_scan", {}) || {};
            const r2 = g2[kk] && Date.now() - g2[kk].at < 10 * 6e4 ? g2[kk] : {
              n: 0,
              at: 0
            };
            if (r2.n >= 3) {
              if (!Once.said(`alarmscan|${kk}`, 10 * 6e4)) {
                log(`[OBRONA] trzeci raz wszedłem na Fleet po hangar [${a.key}] ${body} i nadal go nie widzę — przestaję przeładowywać grę. Sprawdź ręcznie, gdzie stoi flota.`, "error");
                Journal.add("BŁĄD", `Nie mogę odczytać hangaru [${a.key}] ${body} mimo 3 prób przy ALARMIE — sprawdź grę.`);
              }
              continue;
            }
            g2[kk] = {
              n: r2.n + 1,
              at: Date.now()
            };
            Store.set("alarm_scan", g2);
          }
          if (Human.playing()) {
            if (!Once.said(`alarmscan_play|${a.key}`, 5 * 6e4)) log(`[OBRONA] ${a.why} — ale Ty właśnie klikasz w grze, więc nie wyrywam Ci strony. Zerknij na hangar [${a.key}], ja wrócę, gdy przestaniesz.`, "warn");
            continue;
          }
          log(`[OBRONA] ${a.why} — wchodzę na Fleet.`, "warn");
          if (act && act.key === a.key && act.body === body) {
            Nav.go("/fleet", `odczyt hangaru [${a.key}] po alarmie`);
            return;
          }
          const el = PlanetBar.anchor(a.key, body) || PlanetBar.anchor(a.key, "planet");
          if (el) {
            Nav.click(el, `odczyt hangaru [${a.key}] ${body} po alarmie`);
            return;
          }
          continue;
        }
        if (a.kind === "hold") {
          if (!Once.said(`hold|${a.key}`, 12e4)) log(`[OBRONA] [${a.key}]: ${a.why} — nie ruszam floty.`, "info");
          continue;
        }
        if (a.kind === "extend") {
          const s2 = Situation.load();
          const f = (s2.flights || []).find(x => a.flight.id ? x.id === a.flight.id : x.fromKey === a.flight.fromKey && x.toKey === a.flight.toKey && (x.fromBody || a.flight.fromBody) === a.flight.fromBody && x.phase === "launched");
          if (f && f.recallAt < a.recallAt) {
            f.recallAt = a.recallAt;
            Situation.save(s2);
            log(`[LOT] ${a.why} — zawrót lotu [${f.fromKey}]→[${f.toKey}]${f.id ? ` (${String(f.id).slice(0, 8)})` : ""} przesunięty na ${new Date(a.recallAt).toLocaleTimeString("pl-PL")}`, "warn");
          }
          continue;
        }
        if (!CFG.autoRescue) {
          if (!Once.said(`obs|${a.kind}|${a.fromKey || a.flight?.fromKey}`, 6e4)) log(`[OBSERWATOR] zrobiłbym: ${a.kind} ${a.why || ""} — auto-ratunek OFF.`, "warn");
          continue;
        }
        if (a.kind === "recall") {
          await Fly.recall(a.flight);
          break;
        }
        if (a.kind === "fly") {
          if (alarmNow && !a.rescue && !a.blind) {
            if (!Once.said(`rut|${a.fromKey}>${a.toKey}`, 5 * 6e4)) log(`[LOT] WSTRZYMANY lot dobrowolny [${a.fromKey}]→[${a.toKey}] (${a.why}) — na koncie jest para pod ostrzałem, jedyny slot lotu należy do obrony.`, "warn");
            continue;
          }
          if (Fly.blocked(a)) {
            if (!Once.said(`blk|${a.fromKey}${a.toKey}`, 6e4)) log(`[LOT] trasa [${a.fromKey}]→[${a.toKey}] w karencji po nieudanej próbie — czekam.`, "warn");
            continue;
          }
          if (a.fs) {
            const fk = `${a.fromKey}>${a.toKey}`;
            const ft = Store.get("fs_try", {}) || {};
            const r3 = ft[fk] && Date.now() - ft[fk].at < (ft[fk].n >= 3 ? 6 : 1) * 60 * 6e4 ? ft[fk] : {
              n: 0,
              at: 0
            };
            if (r3.n >= 3) {
              if (!Once.said(`fstry|${fk}`, 6 * 60 * 6e4)) log(`[FS] trzecia nieudana próba wysyłki [${a.fromKey}]→[${a.toKey}] w ciągu godziny — odpuszczam tę trasę na 6 h (do ${new Date(r3.at + 6 * 36e5).toLocaleTimeString("pl-PL", {
                hour: "2-digit",
                minute: "2-digit"
              })}). Sprawdź deuter na księżycu źródła i cel Fleet Save; udana wysyłka zeruje licznik.`, "error");
              continue;
            }
            ft[fk] = {
              n: r3.n + 1,
              at: Date.now()
            };
            Store.set("fs_try", ft);
          }
          if (a.evac) {
            const ek = `${a.fromKey}>${a.toKey}`;
            const et = Store.get("evac_try", {}) || {};
            for (const kk of Object.keys(et)) if (Date.now() - ((et[kk] || {}).at || 0) > 60 * 6e4) delete et[kk];
            const r4 = et[ek] || {
              n: 0,
              at: 0
            };
            if (r4.n >= 3) {
              if (!Once.said(`evactry|${ek}`, 60 * 6e4)) {
                log(`[LOT] trzecia nieudana ewakuacja [${a.fromKey}]→[${a.toKey}] w ciągu godziny — przestaję ponawiać do końca godziny. Sprawdź deuter i wolne sloty.`, "error");
                Journal.add("BŁĄD", `Ewakuacja [${a.fromKey}] → [${a.toKey}] nie udaje się (3 próby w godzinę) — flota stoi na planecie bez księżyca, widoczna dla falangi. Przenieś ją ręcznie.`);
              }
              Store.set("evac_try", et);
              continue;
            }
            et[ek] = {
              n: r4.n + 1,
              at: Date.now()
            };
            Store.set("evac_try", et);
          }
          if (a.rescue || a.blind) {
            const odlozone = actions.filter(x => x !== a && x.kind === "fly" && (x.rescue || x.blind));
            if (odlozone.length && !Once.said(`odlozone|${odlozone.map(x => x.fromKey).join(",")}`, 5 * 6e4)) {
              const ciasno = odlozone.filter(x => x.etaMs != null && x.etaMs < 9e4);
              Journal.add("ATAK", `Ratuję [${a.fromKey}] ${a.fromBody}${a.etaMs != null ? ` (uderzenie za ${Math.round(a.etaMs / 1e3)}s)` : ""} — jeden formularz naraz. W KOLEJCE zaraz po tej wysyłce: ${odlozone.map(x => `[${x.fromKey}] ${x.fromBody}${x.etaMs != null ? ` za ${Math.round(x.etaMs / 1e3)}s` : ""}${x.saveTotal ? `, ${x.saveTotal.toLocaleString("pl-PL")} szt.` : ""}`).join("; ")}.${ciasno.length ? ` UWAGA: ${ciasno.map(x => `[${x.fromKey}]`).join(", ")} ma dolot krótszy niż ta kolejka — ratuj ręcznie.` : ""}`);
            }
          }
          if (Fly.start(a)) {
            await Fly.tick();
            break;
          }
          continue;
        }
      }
      const barAge = Date.now() - (s.bar && s.bar.at || 0);
      if (barAge > (CFG.barMaxAgeMs || 3 * 6e4) && CFG.barExcess && !Fly.mission() && !Session.lostRecently() && !Human.playing() && !(s.threats || []).some(t => t.attack && t.arriveAt > Date.now()) && !actions.some(a => a.kind === "fly" || a.kind === "recall" || a.kind === "recon")) {
        const bn = Store.get("bar_nav", null) || {
          at: 0,
          n: 0
        };
        const wiek = Date.now() - (bn.at || 0);
        if (wiek > 30 * 6e4) {
          bn.n = 0;
        }
        if (bn.n >= 3) {
          if (!Once.said("bar_nav_dead", 30 * 6e4)) log(`[OBRONA] trzy przeładowania i nadal nie mam świeżego paska misji (ostatni sprzed ${Math.round(barAge / 6e4)} min) — przestaję kręcić stroną na pół godziny. Ślepy alarm jest w tym czasie WYŁĄCZONY.`, "error");
        } else if (wiek > 15e4) {
          Store.set("bar_nav", {
            at: Date.now(),
            n: (bn.n || 0) + 1
          });
          Nav.go("/home", `obrona: pasek misji sprzed ${Math.round(barAge / 6e4)} min — idę po świeży wzrok`);
          return;
        }
      } else if (barAge < (CFG.barMaxAgeMs || 3 * 6e4) && (Store.get("bar_nav", null) || {}).n) Store.set("bar_nav", {
        at: 0,
        n: 0
      });
      const ekoWolne = !actions.some(a => a.kind === "fly" && !a.fs || a.kind === "recall");
      let moonRuszyl = false;
      if (!Fly.mission() && (Object.keys(s.moonLost || {}).length || ekoWolne || Moon.pending())) {
        try {
          moonRuszyl = await Moon.tick(s);
        } catch (e) {
          log(`[KSIĘŻYC] odbudowa nie wyszła: ${e.message}`, "warn");
        }
      }
      if (!moonRuszyl && !Fly.mission() && ekoWolne) {
        try {
          if (!await Recon.tick(s) && !await Bonus.tick(s) && !await Expo.tick(s) && !await Aster.tick(s) && !await Debris.tick(s)) await Farm.tick(s);
        } catch (e) {
          log(`[EKONOMIA] błąd modułu: ${e.message} — obrona działa dalej.`, "warn");
        }
      }
      Store.set("tick_fails", 0);
    } catch (e) {
      const n = (Store.get("tick_fails", 0) || 0) + 1;
      Store.set("tick_fails", n);
      log(`[OBRONA] błąd pętli (${n}): ${e.message}`, "error");
      if (n === 3) Journal.add("BŁĄD", `Obrona nie kończy przebiegu 3× z rzędu (${e.message}) — bot może być ŚLEPY. Sprawdź grę.`);
    } finally {
      running = false;
      try {
        UI.renderStatus();
      } catch {}
    }
  }
  const Once = {
    said(k, ms) {
      const m = Store.get("once", {}) || {};
      if (Date.now() - (m[k] || 0) < ms) return true;
      m[k] = Date.now();
      for (const x of Object.keys(m)) if (Date.now() - m[x] > 24 * 36e5) delete m[x];
      Store.set("once", m);
      return false;
    }
  };
  const TabLock = {
    KEY: "ogx3_lock",
    id() {
      try {
        let v = sessionStorage.getItem("ogx3_tab");
        if (!v) {
          v = Math.random().toString(36).slice(2);
          sessionStorage.setItem("ogx3_tab", v);
        }
        return v;
      } catch {
        return "single";
      }
    },
    acquire() {
      try {
        const me = this.id();
        const raw = localStorage.getItem(this.KEY);
        const l = raw ? JSON.parse(raw) : null;
        const age = l ? Date.now() - (l.at || 0) : Infinity;
        const visible = document.visibilityState === "visible";
        if (l && l.id !== me && age < (visible && !l.visible ? 45e3 : 9e4)) {
          if (!Once.said("lock", 5 * 6e4)) log("[KARTA] inna karta prowadzi bota — ta jest pasywna (przejmie, gdy tamta zamilknie).", "info");
          return false;
        }
        localStorage.setItem(this.KEY, JSON.stringify({
          id: me,
          at: Date.now(),
          visible: visible
        }));
        return true;
      } catch {
        return true;
      }
    }
  };
  function watchdog() {
    if (!CFG.enabled) return;
    const last = Store.get("last_tick", 0) || 0;
    if (!last || Date.now() - last < 3 * 6e4) return;
    if (Fly.mission()) return;
    const at = Store.get("watchdog_at", 0) || 0;
    if (Date.now() - at < 10 * 6e4) return;
    Store.set("watchdog_at", Date.now());
    log(`[NADZORCA] pętla obrony milczy od ${Math.round((Date.now() - last) / 6e4)} min — przeładowuję stronę.`, "error");
    Journal.add("BŁĄD", "Pętla obrony milczała 3 min — przeładowanie strony (nadzorca).");
    setTimeout(() => Nav.go("/", "nadzorca: pętla obrony milczała"), 1500);
  }
  function errorPageGuard() {
    const url = location.href;
    const txt = (document.body.textContent || "").slice(0, 400);
    const bad = /aspxerrorpath|\/Error\//i.test(url) || /Error occurred|Page not found|Wystąpił błąd|Internal Server Error|Service Unavailable|\b50[0-3]\b/i.test(txt) && !document.querySelector("a.planet-select, .planet-select");
    if (!bad) return false;
    const at = Store.get("errpage_at", 0) || 0;
    if (Date.now() - at < 2 * 6e4) return true;
    Store.set("errpage_at", Date.now());
    log("[BŁĄD STRONY] jestem na stronie błędu gry — wracam na stronę główną.", "error");
    const back = [ ...document.querySelectorAll("a, button") ].find(e => /back to game|wróć|powrót/i.test(e.textContent || ""));
    setTimeout(() => {
      if (back) back.click(); else Nav.go("/", "powrót ze strony błędu gry");
    }, 1200);
    return true;
  }
  function keepalive() {
    const last = Store.get("last_load", 0) || 0;
    if (!Fly.mission() && last && Date.now() - last > 10 * 6e4) {
      log("[KEEPALIVE] przeładowanie (10 min bez nawigacji).", "info");
      Nav.go("/home", "keepalive: 10 min bez nawigacji");
    }
  }
  const Clock = {
    RE: /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/,
    _el: null,
    _txt: null,
    el() {
      if (this._el && this._el.isConnected) return this._el;
      this._el = null;
      try {
        for (const e of document.querySelectorAll("span,div,td,b,p,li,strong")) {
          if (e.children.length) continue;
          const t = (e.textContent || "").trim();
          if (t.length <= 32 && this.RE.test(t)) {
            this._el = e;
            break;
          }
        }
      } catch {}
      return this._el;
    },
    sample() {
      const el = this.el();
      if (!el) return;
      const txt = (el.textContent || "").trim();
      const m = txt.match(this.RE);
      if (!m) return;
      const tyka = this._txt !== null && txt !== this._txt;
      const swieza = typeof performance !== "undefined" && performance.now ? performance.now() < 8e3 : false;
      this._txt = txt;
      if (!tyka && !swieza) return;
      const t = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
      if (!Number.isFinite(t)) return;
      const off = t - Date.now();
      if (Math.abs(off) > 6 * 36e5) return;
      const a = (Store.get("clock_off", []) || []).slice(-6);
      a.push(Math.round(off));
      Store.set("clock_off", a);
    },
    offset() {
      const a = (Store.get("clock_off", []) || []).slice().sort((x, y) => x - y);
      return a.length ? a[Math.floor(a.length / 2)] : 0;
    },
    hms(ms) {
      try {
        return new Date(ms + this.offset()).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
      } catch {
        return "—";
      }
    }
  };
  const Impact = {
    live: new Map,
    obce: new Set,
    _armed: new Set,
    all() {
      return Store.get("impacts", {}) || {};
    },
    save(m) {
      Store.set("impacts", m);
    },
    trs() {
      try {
        return [ ...document.querySelectorAll("#fleet-movement-content tr[class*='row-mission-type-'], #layoutFleetMovements tr[class*='row-mission-type-']") ];
      } catch {
        return [];
      }
    },
    left(tr) {
      const cd = tr.querySelector("[data-remaining-seconds]");
      const v = cd ? etaOf(cd) : 0;
      return v > 0 ? v : null;
    },
    anchor(id, at, precyzja, meta) {
      if (!id || !Number.isFinite(at)) return;
      const nowe = {};
      for (const [k, v] of Object.entries(meta || {})) if (v !== null && v !== undefined) nowe[k] = v;
      const m = this.all();
      const p = m[id];
      if (!p) {
        m[id] = {
          at: at,
          precise: !!precyzja,
          first: Date.now(),
          seen: Date.now(),
          ...nowe
        };
        this.save(m);
        return;
      }
      const lepsza = precyzja ? !p.precise || Math.abs(at - p.at) > 1200 : !p.precise && at < p.at - 400;
      const cosNowego = Object.entries(nowe).some(([k, v]) => p[k] !== v);
      if (!lepsza && !cosNowego && Date.now() - (p.seen || 0) < 3e4) return;
      m[id] = {
        ...p,
        ...nowe,
        at: lepsza ? at : p.at,
        precise: p.precise || !!precyzja,
        seen: Date.now()
      };
      this.save(m);
    },
    note(rows) {
      let n = 0;
      for (const r of rows || []) {
        if (!r || r.mine || r.friendly || r.isReturn) continue;
        if (!(r.attack || r.spy)) continue;
        if (!r.id || !r.eta) continue;
        this.anchor(r.id, (r.readAt || Date.now()) + r.eta * 1e3, false, {
          dst: r.dst || null,
          dstBody: r.dstBody || null,
          type: r.type || "?",
          attack: !!r.attack,
          spy: !!r.spy,
          src: r.src || null
        });
        n++;
      }
      if (n) this.prune();
      return n;
    },
    prune() {
      const m = this.all();
      const now = Date.now();
      let zm = false;
      for (const [k, v] of Object.entries(m)) if (!v || !v.at || now - v.at > 30 * 6e4) {
        delete m[k];
        zm = true;
      }
      if (zm) this.save(m);
    },
    list() {
      return Object.entries(this.all()).map(([id, v]) => ({
        id: id,
        ...v
      })).sort((a, b) => a.at - b.at);
    },
    oznaczOdwolane(idki, kiedy) {
      const m = this.all();
      let n = 0;
      for (const id of idki || []) if (m[id] && !m[id].cancelled) {
        m[id] = {
          ...m[id],
          cancelled: kiedy || Date.now()
        };
        n++;
      }
      if (n) {
        this.save(m);
        log(`[ZEGAR] ${n} wpis(ów) oznaczonych jako ODWOŁANE — napastnik zawrócił przed dolotem.`, "info");
      }
    },
    ataki() {
      return this.list().filter(x => x.attack && !x.cancelled);
    },
    next() {
      const now = Date.now();
      const a = this.ataki();
      return a.find(x => x.at > now) || a.filter(x => x.at > now - 12e4).pop() || null;
    },
    pierwsza(v) {
      return !!v && !this.ataki().some(x => x.dst === v.dst && x.at < v.at && v.at - x.at <= 18e4);
    },
    ostatnia(v) {
      return !!v && !this.ataki().some(x => x.dst === v.dst && x.at > v.at && x.at - v.at <= 18e4);
    },
    sample() {
      const trs = this.trs();
      if (!trs.length) {
        this.live.clear();
        return;
      }
      const znane = this.all();
      for (const tr of trs) {
        const id = tr.getAttribute("data-fleet-id");
        if (!id) continue;
        if (!znane[id]) {
          if (this.obce.has(id)) continue;
          this.obce.add(id);
          let dodane = false;
          try {
            const r = Rows.classify(tr, PlanetBar.ownKeys());
            if (r && r.id && r.eta && (r.attack || r.spy) && !r.mine && !r.friendly && !r.isReturn) dodane = !!this.note([ r ]);
          } catch {}
          if (!dodane) continue;
        }
        const teraz = this.left(tr);
        if (teraz == null) continue;
        const bylo = this.live.get(id);
        this.live.set(id, teraz);
        if (bylo != null && teraz === bylo - 1) this.anchor(id, Date.now() + teraz * 1e3, true, {});
      }
    },
    beep(ile = 3) {
      if (!(CFG.impact && CFG.impact.beep)) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this._ac || (this._ac = new AC);
        if (ctx.state === "suspended") {
          try {
            ctx.resume();
          } catch {}
        }
        for (let i = 0; i < ile; i++) {
          const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * .22;
          o.type = "square";
          o.frequency.value = 1180;
          g.gain.setValueAtTime(1e-4, t0);
          g.gain.exponentialRampToValueAtTime(.25, t0 + .012);
          g.gain.exponentialRampToValueAtTime(1e-4, t0 + .17);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(t0);
          o.stop(t0 + .19);
        }
      } catch {}
    },
    alarms() {
      const cfg = CFG.impact || {};
      if (cfg.enabled === false) return;
      const now = Date.now();
      const m = this.all();
      let zm = false;
      for (const [id, v] of Object.entries(m)) {
        if (!v || !v.attack || !v.at) continue;
        const lead = Math.max(0, cfg.leadSec ?? 60) * 1e3;
        const goAt = v.at + (cfg.recyclerOffsetSec ?? 2) * 1e3;
        if (lead && !v.lead && now >= v.at - lead && now < v.at && this.pierwsza(v)) {
          v.lead = true;
          zm = true;
          const s = Math.max(0, Math.round((v.at - now) / 1e3));
          const gdzie = `[${v.dst}] ${v.dstBody === "moon" ? "☾" : "◍"}`;
          log(`[ZEGAR] uderzenie w ${gdzie} o ${Clock.hms(v.at)} — za ${s} s. Recki o ${Clock.hms(goAt)}.`, "error");
          Notifier.push("⏱ Uderzenie za chwilę", `${gdzie} o ${Clock.hms(v.at)} (za ${s} s). Recki o ${Clock.hms(goAt)}.`, "urgent", "alarm_clock");
          Notifier.speak(`Uderzenie za ${s} sekund`, 1);
          this.beep(3);
        }
        const spoznienie = now - goAt;
        const maxSpoznienie = Math.max(0, cfg.goMaxLateSec ?? 300) * 1e3;
        if (!v.go && spoznienie >= 0 && spoznienie > maxSpoznienie) {
          v.go = true;
          zm = true;
          if (!Once.said(`imp_late|${id}`, 6 * 36e5)) log(`[ZEGAR] uderzenie w [${v.dst}] o ${Clock.hms(v.at)} minęło ${Math.round(spoznienie / 6e4)} min temu (karta była zamknięta) — NIE wołam o recki, złomu tam dawno nie ma.`, "info");
        } else if (!v.go && now >= goAt && this.ostatnia(v)) {
          v.go = true;
          zm = true;
          log(`[ZEGAR] UDERZENIE w [${v.dst}] o ${Clock.hms(v.at)} — RECKI TERAZ (złom leży w [${v.dst}]).`, "success");
          Notifier.push("🛰 RECKI TERAZ", `Uderzenie w [${v.dst}] o ${Clock.hms(v.at)} — wysyłaj recyklery na pole złomu.`, "urgent", "recycle");
          Notifier.speak("Recki teraz", 2);
          this.beep(5);
        } else if (!v.go && !this._armed.has(id) && goAt > now && goAt - now < 3e3 && this.ostatnia(v)) {
          this._armed.add(id);
          setTimeout(() => {
            try {
              this.alarms();
            } catch {}
          }, Math.max(0, goAt - Date.now()));
        }
      }
      if (zm) this.save(m);
    },
    _tyt: null,
    title() {
      if (CFG.impact && CFG.impact.title === false) return;
      const n = this.next();
      const zostalo = n ? Math.round((n.at - Date.now()) / 1e3) : null;
      if (!n || zostalo > 30 * 60) {
        if (this._tyt !== null) {
          try {
            document.title = this._tyt;
          } catch {}
          this._tyt = null;
        }
        return;
      }
      if (this._tyt === null) this._tyt = document.title;
      try {
        document.title = zostalo >= 0 ? `⚔ ${mmss(zostalo)} [${n.dst}]` : `⚔ UDERZENIE [${n.dst}]`;
      } catch {}
    },
    tick() {
      try {
        Clock.sample();
      } catch {}
      try {
        this.alarms();
      } catch {}
      try {
        this.title();
      } catch {}
      try {
        UI.renderImpact();
      } catch {}
    }
  };
  const UI = {
    el: null,
    build() {
      if (document.getElementById("ogx3-panel")) return;
      const d = document.createElement("div");
      d.id = "ogx3-panel";
      d.innerHTML = `\n        <style>\n          #ogx3-panel{position:fixed;top:10px;left:10px;width:232px;background:rgba(0,10,30,.92);border:1px solid #1a5276;border-radius:8px;color:#e0e0e0;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.6);user-select:none;max-height:calc(100vh - 20px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}\n          #ogx3-panel.alarm{border-color:#e74c3c;box-shadow:0 0 0 1px #e74c3c66,0 4px 20px rgba(0,0,0,.6)}\n          #ogx3-panel .hd{background:linear-gradient(135deg,#1a5276,#0d2f4f);padding:8px 10px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move;font-weight:bold;font-size:13px;color:#5dade2}\n          #ogx3-panel.alarm .hd{background:linear-gradient(135deg,#7a1e1e,#3d0f0f);color:#ffb3b3}\n          #ogx3-panel .hd .v{font-size:9px;color:#7f8c8d;font-weight:normal}\n          #ogx3-panel .min{cursor:pointer;font-size:16px;color:#9fb3c2;line-height:1;padding:0 4px}\n          #ogx3-panel .min:hover{color:#fff}\n          #ogx3-panel .strip{padding:7px 10px 6px;border-bottom:1px solid #1a5276;font-size:11px;line-height:1.6}\n          #ogx3-panel .row{display:flex;gap:5px;align-items:baseline}\n          #ogx3-panel .row .ico{width:15px;flex:none;text-align:center}\n          #ogx3-panel .row .lbl{width:58px;flex:none;color:#8fa8b8}\n          #ogx3-panel .row .val{color:#d7e2ea;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n          #ogx3-panel .row.ok .val{color:#6fcf97}\n          #ogx3-panel .row.busy .val{color:#f2b25c}\n          #ogx3-panel .row.alert .val{color:#ff6b6b;font-weight:700}\n          #ogx3-panel .row.dim .val{color:#7f8c8d}\n          #ogx3-panel .body{padding:8px 10px 10px}\n          #ogx3-panel .act{display:flex;gap:4px;margin-bottom:6px}\n          #ogx3-panel .sec{margin-bottom:4px;background:rgba(255,255,255,.03);border-radius:4px;border-left:3px solid #1a5276}\n          #ogx3-panel .sec.open{border-left-color:#27ae60}\n          #ogx3-panel .sec-t{padding:4px 8px;font-size:11px;color:#b9c9d4;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:6px}\n          #ogx3-panel .sec-t:hover{color:#fff}\n          #ogx3-panel .sec-t .arr{display:inline-block;width:9px;color:#5dade2}\n          #ogx3-panel .sec-t>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n          #ogx3-panel .sec-t .tail{color:#7f8c8d;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:74px;flex:none}\n          #ogx3-panel .sec-b{display:none;padding:2px 8px 7px;font-size:11px;line-height:1.5}\n          #ogx3-panel .sec.open .sec-b{display:block}\n          #ogx3-panel .sec-b .line{margin:4px 0;display:flex;gap:4px;flex-wrap:wrap;align-items:center}\n          #ogx3-panel .note{color:#8fa8b8;font-size:10px;margin-top:3px}\n          #ogx3-panel input{background:rgba(0,0,0,.35);border:1px solid #2b4a66;color:#e0e0e0;border-radius:3px;padding:1px 4px;font-size:11px}\n          #ogx3-panel .ogx3-btn{background:rgba(255,255,255,.1);color:#ccc;border:1px solid #555;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:10.5px}\n          #ogx3-panel .ogx3-btn:hover{background:rgba(255,255,255,.2);color:#fff}\n          #ogx3-panel #ogx3-on{padding:3px 12px;border:none;border-radius:4px;font-weight:bold;font-size:12px;color:#fff;cursor:pointer}\n          #ogx3-panel #ogx3-save{background:#c0392b;color:#fff;border-color:#e74c3c;font-weight:bold;flex:1;font-size:10px;padding:4px 2px;white-space:nowrap}\n          #ogx3-panel #ogx3-home{flex:1;font-size:10px;padding:4px 2px;white-space:nowrap}\n          #ogx3-panel .jr{margin:2px 0;font-size:10px;line-height:1.35;color:#b7c4cd}\n          #ogx3-panel .jr b{color:#5dade2;font-weight:600}\n          #ogx3-panel .jr.ATAK b,#ogx3-panel .jr.BŁĄD b{color:#ff6b6b}\n          #ogx3-panel .jr.RATUNEK b,#ogx3-panel .jr.POWRÓT b,#ogx3-panel .jr.FS b{color:#6fcf97}\n          #ogx3-panel .jr.EKO b{color:#e2b25d}   /* v3.77.0: ekonomia stoi — żółto, nie czerwono */\n          #ogx3-panel .imp.odwolany{opacity:.45}   /* v3.82.0: napastnik zawrócił — wpis zostaje, ale nie udaje uderzenia */\n          #ogx3-panel .imp.odwolany .cd{color:#6fcf97;font-weight:600}\n          #ogx3-panel .imp{margin:5px 0;padding:4px 6px;background:rgba(231,76,60,.13);border-left:2px solid #e74c3c;border-radius:3px}\n          #ogx3-panel .imp.spy{background:rgba(241,196,15,.10);border-left-color:#f1c40f}\n          #ogx3-panel .imp .h{font-size:13px;font-weight:700;color:#ff9b9b;font-variant-numeric:tabular-nums;display:flex;justify-content:space-between;gap:6px}\n          #ogx3-panel .imp .h .cd{color:#ffd56b}\n          #ogx3-panel .imp .sub{color:#9fb3c2;font-size:10px;margin-top:1px}\n          #ogx3-panel .imp .sub.rk{color:#7bff9b}\n          #ogx3-panel .imp a{color:#5dade2;text-decoration:none;cursor:pointer}\n          #ogx3-panel .imp a:hover{text-decoration:underline}\n          #ogx3-panel #ogx3-status{white-space:pre-wrap;font-size:10px;line-height:1.4;color:#b7c4cd}\n          #ogx3-panel #ogx3-log{max-height:180px;overflow-y:auto;font:10px/1.35 ui-monospace,monospace;background:rgba(0,0,0,.3);padding:5px;border-radius:4px;margin-top:4px}\n        </style>\n        <div class="hd" id="ogx3-hd">\n          <span>OGameX 3 <span class="v">v${VERSION}</span></span>\n          <span style="display:flex;gap:6px;align-items:center"><button id="ogx3-on"></button><span class="min" id="ogx3-min" title="Zwiń / rozwiń panel">_</span></span>\n        </div>\n        <div class="strip" id="ogx3-strip">\n          <div class="row alert" id="ogx3-r-imp" style="display:none"><span class="ico">⏱</span><span class="lbl">Dolot</span><span class="val">—</span></div>\n          <div class="row" id="ogx3-r-def"><span class="ico">🛡</span><span class="lbl">Obrona</span><span class="val">—</span></div>\n          <div class="row" id="ogx3-r-fleet"><span class="ico">🛰</span><span class="lbl">Flota</span><span class="val">—</span></div>\n          <div class="row" id="ogx3-r-expo"><span class="ico">🚀</span><span class="lbl">Ekspedycje</span><span class="val">—</span></div>\n          <div class="row" id="ogx3-r-ret"><span class="ico">↩</span><span class="lbl">Powroty</span><span class="val">—</span></div>\n          <div class="row" id="ogx3-r-min"><span class="ico">⛏</span><span class="lbl">Mining</span><span class="val">—</span></div>\n          <div class="row" id="ogx3-r-fs"><span class="ico">🌙</span><span class="lbl">Fleet Save</span><span class="val">—</span></div>\n        </div>\n        <div class="body" id="ogx3-body">\n          <div class="act"><button id="ogx3-save" class="ogx3-btn">RATUJ FLOTĘ TERAZ</button><button id="ogx3-home" class="ogx3-btn">WRÓĆ NA BAZĘ</button></div>\n          <div class="sec" data-sec="def"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Obrona</span><span class="tail" id="ogx3-t-def"></span></div><div class="sec-b">\n            <div class="line"><button id="ogx3-auto" class="ogx3-btn"></button><button id="ogx3-recon" class="ogx3-btn"></button></div>\n            <div class="line"><button id="ogx3-h2m" class="ogx3-btn"></button></div>\n            <div class="line"><button id="ogx3-push" class="ogx3-btn"></button><button id="ogx3-voice" class="ogx3-btn"></button><button id="ogx3-pushtest" class="ogx3-btn">Test push</button></div>\n            <div class="line">Rezerwa deuteru <input id="ogx3-res" style="width:74px" /></div>\n            <div class="line">Prędkość ucieczki <input id="ogx3-spd" style="width:32px" />%</div>\n            <div class="note">ntfy: <span id="ogx3-topic"></span></div>\n          </div></div>\n          <div class="sec" data-sec="expo"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Ekspedycje</span><span class="tail" id="ogx3-t-expo"></span></div><div class="sec-b">\n            <div class="line"><button id="ogx3-expo" class="ogx3-btn"></button><button id="ogx3-disc" class="ogx3-btn"></button></div>\n            <div class="line">fale <input id="ogx3-waves" style="width:30px" /> · rezerwa slotów <input id="ogx3-slotres" style="width:26px" /></div>\n            <div class="line">startuj z <input id="ogx3-expo-from" style="width:70px" placeholder="g:s:p" /></div>\n            <div class="note" id="ogx3-expo-st"></div>\n          </div></div>\n          <div class="sec" data-sec="fs"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Fleet Save</span><span class="tail" id="ogx3-t-fs"></span></div><div class="sec-b">\n            <div class="line"><button id="ogx3-fs" class="ogx3-btn"></button> wróć o <input id="ogx3-fs-a" style="width:44px" placeholder="HH:MM" /></div>\n            <div class="line">cel (księżyc) <input id="ogx3-fs-target" style="width:70px" placeholder="g:s:p = najdalsza" /> · prędkość <input id="ogx3-fs-speed" style="width:26px" />%</div>\n            <div class="line">po powrocie w domu <input id="ogx3-fs-rest" style="width:26px" /> h (0 = leci od razu)</div>\n            <div class="note" id="ogx3-fs-st"></div>\n          </div></div>\n          <div class="sec" data-sec="eco"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Ekonomia</span><span class="tail" id="ogx3-t-eco"></span></div><div class="sec-b">\n            <div class="line"><button id="ogx3-aster" class="ogx3-btn"></button><button id="ogx3-deb" class="ogx3-btn"></button><button id="ogx3-bonus" class="ogx3-btn"></button></div>\n            <div class="line"><button id="ogx3-quiet" class="ogx3-btn"></button></div>\n            <div class="note" id="ogx3-bonus-st"></div>\n            <div class="line"><button id="ogx3-moon" class="ogx3-btn"></button> ≤ <input id="ogx3-moon-share" style="width:26px" />% metalu</div>\n            <div class="note" id="ogx3-moon-st"></div>\n            <div class="line">minery na lot <input id="ogx3-aster-max" style="width:86px" placeholder="puste = auto" /> szt.</div>\n            <div class="line">ładownia minera <input id="ogx3-aster-cargo" style="width:86px" placeholder="0 = ucz się" /></div>\n            <div class="note" id="ogx3-aster-st"></div>\n            <div class="line"><button id="ogx3-quiet" class="ogx3-btn"></button> od <input id="ogx3-quiet-a" style="width:24px" />:00 do <input id="ogx3-quiet-b" style="width:24px" />:00</div>\n            <div class="line"><button id="ogx3-breaks" class="ogx3-btn"></button></div>\n            <div class="line">gdy klikasz: fala czeka <input id="ogx3-idle" style="width:26px" /> min ciszy (0 = leci od razu)</div>\n            <div class="note" id="ogx3-human-st"></div>\n          </div></div>\n          <div class="sec" data-sec="farm"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Farma</span><span class="tail" id="ogx3-t-farm"></span></div><div class="sec-b">\n            <div class="line"><button id="ogx3-farm" class="ogx3-btn"></button><button id="ogx3-farm-seq" class="ogx3-btn"></button></div>\n            <div class="line">statek <select id="ogx3-farm-ship" style="background:rgba(0,0,0,.35);border:1px solid #2b4a66;color:#e0e0e0;border-radius:3px;font-size:11px"><option value="BATTLESHIP">OW (okręt wojenny)</option><option value="HEAVY_CARGO">DT (duży transporter)</option><option value="LIGHT_CARGO">MT (mały transporter)</option></select></div>\n            <div class="line">sztuk na atak <input id="ogx3-farm-qty" style="width:86px" placeholder="np. 5000" /></div>\n            <div class="line">start z <input id="ogx3-farm-from" style="width:70px" placeholder="g:s:p" /> · rezerwa slotów <input id="ogx3-farm-res" style="width:26px" /></div>\n            <div class="line">zakresy <input id="ogx3-farm-ranges" style="width:130px" placeholder="2:1-499" /></div>\n            <div class="line">rank ≤ <input id="ogx3-farm-rank" style="width:50px" placeholder="0 = bez" /> · min. łup <input id="ogx3-farm-minp" style="width:70px" placeholder="0" /></div>\n            <div class="note" id="ogx3-farm-st"></div>\n          </div></div>\n          <div class="sec" data-sec="imp"><div class="sec-t"><span><span class="arr">▸</span> Zegar dolotu</span><span class="tail" id="ogx3-t-imp"></span></div><div class="sec-b">\n            <div id="ogx3-imp-list"></div>\n            <div class="line">recki <input id="ogx3-imp-off" style="width:26px" /> s po uderzeniu · alarm <input id="ogx3-imp-lead" style="width:26px" /> s przed</div>\n            <div class="line"><button id="ogx3-imp-beep" class="ogx3-btn"></button><button id="ogx3-imp-copy" class="ogx3-btn">Kopiuj godziny</button></div>\n            <div class="note" id="ogx3-imp-note"></div>\n          </div></div>\n          <div class="sec" data-sec="jr"><div class="sec-t"><span><span class="arr">▸</span> Dziennik obrony</span><span class="tail" id="ogx3-t-jr"></span></div><div class="sec-b"><div id="ogx3-journal"></div></div></div>\n          <div class="sec" data-sec="det"><div class="sec-t"><span><span class="arr">▸</span> Szczegóły stanu</span></div><div class="sec-b"><div id="ogx3-status"></div></div></div>\n          <div class="sec" data-sec="tools"><div class="sec-t"><span><span class="arr">▸</span> Narzędzia i testy</span></div><div class="sec-b">\n            <div class="line"><button id="ogx3-sim-moon" class="ogx3-btn">TEST: atak na księżyc</button><button id="ogx3-sim-planet" class="ogx3-btn">TEST: atak na planetę</button></div>\n            <div class="line"><button id="ogx3-dump" class="ogx3-btn">Zrzut DOM</button><button id="ogx3-report" class="ogx3-btn">Kopiuj raport</button><button id="ogx3-abort" class="ogx3-btn">Przerwij lot</button></div>\n          </div></div>\n          <div class="sec" data-sec="log"><div class="sec-t"><span><span class="arr">▸</span> Log</span><span class="tail" id="ogx3-t-log"></span></div><div class="sec-b">\n            <div class="line"><button id="ogx3-copy" class="ogx3-btn">Kopiuj</button><button id="ogx3-clear" class="ogx3-btn">Wyczyść</button></div>\n            <div id="ogx3-log"></div>\n          </div></div>\n        </div>`;
      document.body.appendChild(d);
      this.el = d;
      const $ = id => document.getElementById(id);
      const pos = Store.get("ui_pos", null);
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        const maxL = Math.max(0, (window.innerWidth || 1200) - 60), maxT = Math.max(0, (window.innerHeight || 800) - 40);
        d.style.left = Math.min(Math.max(0, pos.left), maxL) + "px";
        d.style.top = Math.min(Math.max(0, pos.top), maxT) + "px";
      }
      const open = new Set(Store.get("ui_open", []) || []);
      for (const sec of d.querySelectorAll(".sec")) {
        if (open.has(sec.dataset.sec)) {
          sec.classList.add("open");
          sec.querySelector(".arr").textContent = "▾";
        }
        sec.querySelector(".sec-t").onclick = () => {
          const on = sec.classList.toggle("open");
          sec.querySelector(".arr").textContent = on ? "▾" : "▸";
          const s = new Set(Store.get("ui_open", []) || []);
          on ? s.add(sec.dataset.sec) : s.delete(sec.dataset.sec);
          Store.set("ui_open", [ ...s ]);
          if (on && sec.dataset.sec === "jr") this.renderJournal();
        };
      }
      this.setMin(Store.get("ui_min", false) === true);
      $("ogx3-min").onclick = () => this.setMin(!(Store.get("ui_min", false) === true));
      {
        let drag = false, sx = 0, sy = 0, sl = 0, st = 0;
        $("ogx3-hd").addEventListener("mousedown", e => {
          if (e.target.closest("button, .min")) return;
          const r = d.getBoundingClientRect();
          drag = true;
          sx = e.clientX;
          sy = e.clientY;
          sl = r.left;
          st = r.top;
          e.preventDefault();
        });
        document.addEventListener("mousemove", e => {
          if (!drag) return;
          d.style.left = sl + e.clientX - sx + "px";
          d.style.top = st + e.clientY - sy + "px";
          d.style.right = "auto";
        });
        document.addEventListener("mouseup", () => {
          if (!drag) return;
          drag = false;
          const r = d.getBoundingClientRect();
          Store.set("ui_pos", {
            left: Math.round(r.left),
            top: Math.round(r.top)
          });
        });
      }
      $("ogx3-on").onclick = () => {
        CFG.enabled = !CFG.enabled;
        saveCfg();
        if (CFG.enabled) Store.set("last_tick", Date.now());
        log(`Bot ${CFG.enabled ? "ON" : "OFF"}`, "info");
        this.renderStatus();
      };
      $("ogx3-auto").onclick = () => {
        CFG.autoRescue = !CFG.autoRescue;
        saveCfg();
        log(`Auto-ratunek ${CFG.autoRescue ? "ON — bot RUSZA flotą" : "OFF — obserwator"}`, "warn");
        this.renderStatus();
      };
      $("ogx3-h2m").onclick = () => {
        CFG.homeToMoon = !CFG.homeToMoon;
        saveCfg();
        log(CFG.homeToMoon ? "Zwożenie floty planeta→księżyc: ON (bot będzie konsolidował flotę)" : "Zwożenie floty planeta→księżyc: OFF — flota rusza się tylko przy ataku (i wraca po ratunku)", "warn");
        this.renderStatus();
      };
      $("ogx3-push").onclick = () => {
        Store.set("ntfy_on", !Notifier.enabled());
        this.renderStatus();
      };
      $("ogx3-voice").onclick = () => {
        Store.set("voice_on", !Store.get("voice_on", false));
        this.renderStatus();
      };
      $("ogx3-recon").onclick = () => {
        const cur = !CFG.recon ? "off" : CFG.reconMode === "all" ? "all" : "fleet";
        const next = cur === "fleet" ? "all" : cur === "all" ? "off" : "fleet";
        CFG.recon = next !== "off";
        CFG.reconMode = next === "all" ? "all" : "fleet";
        saveCfg();
        log(next === "fleet" ? "Rekonesans: TYLKO ciała z flotą (bot nie objeżdża pustych planet)" : next === "all" ? "Rekonesans: WSZYSTKIE ciała po kolei (będzie przełączał planety)" : "Rekonesans OFF — bot nie będzie wiedział, gdzie stoi flota", next === "off" ? "warn" : "info");
        this.renderStatus();
      };
      $("ogx3-deb").onclick = () => {
        CFG.debris.enabled = !CFG.debris.enabled;
        saveCfg();
        log(`Zbieranie złomu ${CFG.debris.enabled ? "ON" : "OFF"}`, "info");
        this.renderStatus();
      };
      $("ogx3-quiet").onclick = () => {
        CFG.stealth.enabled = !CFG.stealth.enabled;
        saveCfg();
        log(CFG.stealth.enabled ? `Tryb cichy ON — kolonie odpytywane raz na ${CFG.stealth.colonyHours || 8} h (mniej śladów aktywności w galaktyce).` : "Tryb cichy OFF — zwiad kolonii co 45 min (świeższe hangary, więcej śladów).", "info");
        this.renderStatus();
      };
      $("ogx3-aster").onclick = () => {
        CFG.aster.enabled = !CFG.aster.enabled;
        saveCfg();
        log(`Mining asteroid ${CFG.aster.enabled ? "ON" : "OFF"}`, "info");
        this.renderStatus();
      };
      $("ogx3-aster-max").value = CFG.aster.maxMiners ? String(CFG.aster.maxMiners) : "";
      $("ogx3-aster-max").onchange = e => {
        CFG.aster.maxMiners = Math.max(0, parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0);
        saveCfg();
        e.target.value = CFG.aster.maxMiners ? String(CFG.aster.maxMiners) : "";
        log(CFG.aster.maxMiners ? `[ASTER] minery na lot: zawsze ${CFG.aster.maxMiners.toLocaleString("pl-PL")} szt. (bot nie dobiera ilości sam)` : "[ASTER] minery na lot: bez sufitu — wielkość floty liczy bot (a bez danych o ładowni leci CAŁY hangar).", CFG.aster.maxMiners ? "info" : "warn");
      };
      $("ogx3-aster-cargo").value = CFG.aster.cargoPerMiner ? String(CFG.aster.cargoPerMiner) : "";
      $("ogx3-aster-cargo").onchange = e => {
        CFG.aster.cargoPerMiner = Math.max(0, parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0);
        saveCfg();
        e.target.value = CFG.aster.cargoPerMiner ? String(CFG.aster.cargoPerMiner) : "";
        log(CFG.aster.cargoPerMiner ? `[ASTER] ładownia minera: ${CFG.aster.cargoPerMiner.toLocaleString("pl-PL")} surowców — auto-dobór floty działa.` : "[ASTER] ładownia minera: ucz się z formularza.", "info");
      };
      $("ogx3-bonus").onclick = () => {
        CFG.bonus.enabled = !CFG.bonus.enabled;
        saveCfg();
        log(`Bonus online ${CFG.bonus.enabled ? "ON — bot odbiera antymaterię i punkty Akademii" : "OFF"}`, "info");
        this.renderStatus();
      };
      $("ogx3-moon").onclick = () => {
        CFG.moon.enabled = !CFG.moon.enabled;
        saveCfg();
        log(`Stawianie księżyców ${CFG.moon.enabled ? `ON — bot WYDA do ${Math.round(CFG.moon.maxMetalShare * 100)}% metalu na księżyc` : "OFF — nowych księżyców nie stawiam; odbuduję tylko ten ZNISZCZONY przez atak (flota nie może wracać na gołą planetę)"}`, CFG.moon.enabled ? "warn" : "info");
        this.renderStatus();
      };
      $("ogx3-moon-share").value = String(Math.round((CFG.moon.maxMetalShare || .25) * 100));
      $("ogx3-moon-share").onchange = e => {
        CFG.moon.maxMetalShare = Math.max(.01, Math.min(1, (parseInt(e.target.value) || 25) / 100));
        saveCfg();
        this.renderStatus();
      };
      {
        const lf = CFG.expo.launchFrom;
        $("ogx3-expo-from").value = lf ? `${lf.galaxy}:${lf.system}:${lf.position}` : "";
      }
      $("ogx3-expo-from").onchange = e => {
        const v = String(e.target.value || "").trim();
        if (!v) {
          CFG.expo.launchFrom = null;
          saveCfg();
          log("[EXPO] ekspedycje startują z aktywnej planety (pole puste).", "info");
          return;
        }
        const m = v.match(/^(\d+)\s*[:.]\s*(\d+)\s*[:.]\s*(\d+)$/);
        if (!m) {
          alert("Wpisz koordynaty w formacie g:s:p, np. 1:100:5");
          e.target.value = "";
          return;
        }
        CFG.expo.launchFrom = {
          galaxy: +m[1],
          system: +m[2],
          position: +m[3]
        };
        saveCfg();
        log(`[EXPO] ekspedycje startują odtąd z [${m[1]}:${m[2]}:${m[3]}] — niezależnie od tego, gdzie klikasz.`, "info");
      };
      $("ogx3-farm").onclick = () => {
        CFG.farm.enabled = !CFG.farm.enabled;
        saveCfg();
        log(`Farma nieaktywnych ${CFG.farm.enabled ? `ON — ${Farm.status()}` : "OFF"}`, CFG.farm.enabled ? "warn" : "info");
        this.renderStatus();
      };
      $("ogx3-farm-seq").onclick = () => {
        CFG.farm.sequential = !CFG.farm.sequential;
        saveCfg();
        Farm.save({});
        log(CFG.farm.sequential ? "[FARMA] tryb SEKWENCYJNY: każdy przebieg po kolei przez cały zakres, cele w kolejności napotkania." : "[FARMA] priorytet łupu: okrążenia po znanych celach, najtłustsze pierwsze.", "info");
        this.renderStatus();
      };
      $("ogx3-farm-ship").value = CFG.farm.shipType || "BATTLESHIP";
      $("ogx3-farm-ship").onchange = e => {
        CFG.farm.shipType = e.target.value;
        saveCfg();
        log(`[FARMA] statek: ${CFG.farm.shipType}`, "info");
        this.renderStatus();
      };
      $("ogx3-farm-qty").value = CFG.farm.perAttack ? String(CFG.farm.perAttack) : "";
      $("ogx3-farm-qty").onchange = e => {
        CFG.farm.perAttack = Math.max(0, parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0);
        saveCfg();
        e.target.value = CFG.farm.perAttack ? String(CFG.farm.perAttack) : "";
        log(`[FARMA] na atak: ${CFG.farm.perAttack.toLocaleString("pl-PL")} × ${CFG.farm.shipType}`, "info");
        this.renderStatus();
      };
      {
        const lf = CFG.farm.launchFrom;
        $("ogx3-farm-from").value = lf ? `${lf.galaxy}:${lf.system}:${lf.position}` : "";
      }
      $("ogx3-farm-from").onchange = e => {
        const v = String(e.target.value || "").trim();
        if (!v) {
          CFG.farm.launchFrom = null;
          saveCfg();
          log("[FARMA] brak „start z” — farma stoi, dopóki go nie wpiszesz.", "warn");
          this.renderStatus();
          return;
        }
        const m = v.match(/^(\d+)\s*[:.]\s*(\d+)\s*[:.]\s*(\d+)$/);
        if (!m) {
          alert("Wpisz koordynaty w formacie g:s:p, np. 1:100:5");
          e.target.value = "";
          return;
        }
        CFG.farm.launchFrom = {
          galaxy: +m[1],
          system: +m[2],
          position: +m[3]
        };
        saveCfg();
        log(`[FARMA] ataki startują z [${m[1]}:${m[2]}:${m[3]}] (księżyc, jeśli para go ma).`, "info");
        this.renderStatus();
      };
      $("ogx3-farm-res").value = String(Farm.reserve());
      $("ogx3-farm-res").onchange = e => {
        CFG.farm.slotReserve = Math.max(1, parseInt(e.target.value) || 2);
        saveCfg();
        e.target.value = String(CFG.farm.slotReserve);
        this.renderStatus();
      };
      $("ogx3-farm-ranges").value = CFG.farm.ranges || "";
      $("ogx3-farm-ranges").onchange = e => {
        const v = String(e.target.value || "").trim(), r = Farm.parseRanges(v);
        CFG.farm.ranges = v;
        saveCfg();
        Farm.save({});
        log(r.length ? `[FARMA] zakresy: ${r.map(x => `${x.galaxy}:${x.start}-${x.end}`).join(", ")} — nowy przebieg od początku.` : `[FARMA] zakresy „${v}” nieczytelne — wpisz np. 2:1-499 (maks. 500 układów na zakres).`, r.length ? "info" : "warn");
        this.renderStatus();
      };
      $("ogx3-farm-rank").value = String(CFG.farm.maxTargetRank ?? 800);
      $("ogx3-farm-rank").onchange = e => {
        CFG.farm.maxTargetRank = Math.max(0, parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0);
        saveCfg();
        e.target.value = String(CFG.farm.maxTargetRank);
        this.renderStatus();
      };
      $("ogx3-farm-minp").value = String(CFG.farm.minTargetProfit || 0);
      $("ogx3-farm-minp").onchange = e => {
        CFG.farm.minTargetProfit = Math.max(0, parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0);
        saveCfg();
        e.target.value = String(CFG.farm.minTargetProfit);
        this.renderStatus();
      };
      $("ogx3-quiet").onclick = () => {
        CFG.quietHours.enabled = !CFG.quietHours.enabled;
        saveCfg();
        log(`Cisza nocna ekonomii ${CFG.quietHours.enabled ? `ON (${CFG.quietHours.startHour}:00–${CFG.quietHours.endHour}:00 ±20 min)` : "OFF — ekonomia pracuje całą dobę"}`, "info");
        this.renderStatus();
      };
      $("ogx3-quiet-a").value = String(CFG.quietHours.startHour);
      $("ogx3-quiet-a").onchange = e => {
        CFG.quietHours.startHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 23));
        saveCfg();
        this.renderStatus();
      };
      $("ogx3-quiet-b").value = String(CFG.quietHours.endHour);
      $("ogx3-quiet-b").onchange = e => {
        CFG.quietHours.endHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 5));
        saveCfg();
        this.renderStatus();
      };
      $("ogx3-breaks").onclick = () => {
        CFG.human.breaks = !CFG.human.breaks;
        Store.set("break_until", 0);
        Store.set("break_next", 0);
        saveCfg();
        log(`Przerwy „kawowe" ${CFG.human.breaks ? `ON (co ${CFG.human.breakEveryMinMin}–${CFG.human.breakEveryMaxMin} min na ${CFG.human.breakLenMinMin}–${CFG.human.breakLenMaxMin} min)` : "OFF — ekonomia bez przerw"}`, "info");
        this.renderStatus();
      };
      $("ogx3-idle").value = String(Math.round((CFG.human.ecoIdleSec ?? 0) / 60));
      $("ogx3-idle").onchange = e => {
        const m2 = Math.max(0, Math.min(60, parseInt(e.target.value) || 0));
        CFG.human.ecoIdleSec = m2 * 60;
        saveCfg();
        log(m2 > 0 ? `Ekonomia czeka ${m2} min ciszy po Twoim kliknięciu, zanim ruszy falą.` : "Ekonomia NIE czeka, aż przestaniesz klikać — fala może przejąć kartę w trakcie gry.", "info");
        this.renderStatus();
      };
      const fsHHMM = () => `${String(CFG.fs.returnHour ?? 7).padStart(2, "0")}:${String(CFG.fs.returnMinute || 0).padStart(2, "0")}`;
      $("ogx3-fs").onclick = () => {
        CFG.fs.enabled = !CFG.fs.enabled;
        saveCfg();
        log(`Fleet Save ${CFG.fs.enabled ? `ON (wraca o ${fsHHMM()})` : "OFF"}`, "info");
        this.renderStatus();
      };
      $("ogx3-fs-a").value = fsHHMM();
      $("ogx3-fs-a").onchange = e => {
        const raw = String(e.target.value || "").trim();
        const m = raw.match(/^(\d{1,2})(?:[:.](\d{1,2}))?$/);
        const h = m ? parseInt(m[1], 10) : NaN, mi = m && m[2] !== undefined ? parseInt(m[2], 10) : 0;
        if (!m || h > 23 || mi > 59) {
          e.target.value = fsHHMM();
          log(`FS: „${raw}" to nie godzina — wpisz HH:MM (np. 8:50); zostaje ${fsHHMM()}.`, "warn");
          return;
        }
        CFG.fs.returnHour = h;
        CFG.fs.returnMinute = mi;
        saveCfg();
        e.target.value = fsHHMM();
        log(`FS: wraca o ${fsHHMM()}.`, "info");
        this.renderStatus();
      };
      $("ogx3-fs-target").value = CFG.fs.target || "";
      $("ogx3-fs-target").onchange = e => {
        const v = String(e.target.value || "").trim();
        if (!v) {
          CFG.fs.target = null;
          saveCfg();
          log("FS: brak stałego celu — wraca do najdalszej bezpiecznej kolonii.", "info");
          this.renderStatus();
          return;
        }
        const mm = v.match(/^(\d+)\s*[:.]\s*(\d+)\s*[:.]\s*(\d+)$/);
        if (!mm) {
          alert("Wpisz koordynaty księżyca w formacie g:s:p, np. 1:100:5");
          e.target.value = CFG.fs.target || "";
          return;
        }
        CFG.fs.target = `${+mm[1]}:${+mm[2]}:${+mm[3]}`;
        saveCfg();
        log(`FS: stały cel [${CFG.fs.target}].`, "info");
        this.renderStatus();
      };
      $("ogx3-fs-rest").value = String(CFG.fs.restHours ?? 0);
      $("ogx3-fs-rest").onchange = e => {
        const raw = parseInt(e.target.value);
        const v = Number.isFinite(raw) ? raw : 0;
        CFG.fs.restHours = Math.max(0, Math.min(23, v));
        e.target.value = String(CFG.fs.restHours);
        saveCfg();
        log(CFG.fs.restHours ? `FS: po powrocie flota zostaje w domu ${CFG.fs.restHours} h — w tym czasie lecą ekspedycje, FS nie startuje. Obrona działa normalnie.` : "FS: okno dnia wyłączone — flota wylatuje od razu po powrocie (zachowanie sprzed 3.98).", "info");
        this.renderStatus();
      };
      $("ogx3-fs-speed").value = String(CFG.fs.speedPct ?? 10);
      const FS_SPEEDS = [ 3, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100 ];
      $("ogx3-fs-speed").onchange = e => {
        const raw = parseInt(e.target.value);
        const v = Number.isFinite(raw) ? raw : 10;
        const nieSzybsze = FS_SPEEDS.filter(x => x <= Math.max(3, Math.min(100, v)));
        CFG.fs.speedPct = nieSzybsze.length ? nieSzybsze[nieSzybsze.length - 1] : 3;
        e.target.value = String(CFG.fs.speedPct);
        saveCfg();
        log(`FS: prędkość ${CFG.fs.speedPct}%${CFG.fs.speedPct !== v ? ` (lista forka: ${FS_SPEEDS.join(", ")} — wpisane ${v} przycięte do najbliższej nie szybszej)` : ""}.`, "info");
        this.renderStatus();
      };
      $("ogx3-expo").onclick = () => {
        CFG.expo.enabled = !CFG.expo.enabled;
        saveCfg();
        if (CFG.expo.enabled && Human.onBreak()) {
          Store.set("break_until", 0);
          Store.set("break_next", Date.now() + jitter(CFG.human.breakEveryMinMin, CFG.human.breakEveryMaxMin) * 6e4);
          log("[PRZERWA] przerwana ręcznie — włączyłeś ekspedycje.", "info");
        }
        log(`Ekspedycje ${CFG.expo.enabled ? "ON" : "OFF"} — kliknięcie w panelu (zapisane ${new Date(cfgSavedAt || Date.now()).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        })}; ustawienie dotyczy TEJ przeglądarki — bot na innym komputerze ma własne)`, "info");
        this.renderStatus();
      };
      $("ogx3-disc").onclick = () => {
        CFG.expo.discoverer40 = !CFG.expo.discoverer40;
        saveCfg();
        log(`Odkrywca (40 min) ${CFG.expo.discoverer40 ? "ON" : "OFF — ekspedycje na " + CFG.expo.holdingHours + " h"}`, "info");
        this.renderStatus();
      };
      $("ogx3-waves").value = String(CFG.expo.waves);
      $("ogx3-waves").onchange = e => {
        CFG.expo.waves = Math.max(1, parseInt(e.target.value) || 1);
        saveCfg();
        Store.del("burst");
        log(`Fale ekspedycji: ${CFG.expo.waves} (seria liczona od nowa)`, "info");
      };
      $("ogx3-slotres").value = String(CFG.expo.slotReserve);
      $("ogx3-slotres").onchange = e => {
        CFG.expo.slotReserve = Math.max(0, parseInt(e.target.value) || 0);
        saveCfg();
      };
      $("ogx3-res").value = String(CFG.deutReserve || 0);
      $("ogx3-res").onchange = e => {
        CFG.deutReserve = parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0;
        saveCfg();
        log(`Rezerwa deuteru: ${CFG.deutReserve.toLocaleString("pl-PL")}`, "info");
      };
      $("ogx3-spd").value = String(CFG.airSpeedPct);
      $("ogx3-spd").onchange = e => {
        CFG.airSpeedPct = Math.max(1, Math.min(100, parseInt(e.target.value) || 10));
        saveCfg();
      };
      const sim = body => {
        const a = PlanetBar.active();
        if (!a) return alert("Nie widzę aktywnej planety.");
        Store.set("sim", {
          key: a.key,
          body: body,
          arriveAt: Date.now() + 15e4,
          until: Date.now() + 18e4
        });
        log(`[TEST] symulacja: atak na ${body === "moon" ? "KSIĘŻYC" : "PLANETĘ"} [${a.key}], dolot 150 s. Auto-ratunek: ${CFG.autoRescue ? "ON (flota poleci!)" : "OFF (tylko decyzja w logu)"}`, "error");
        defenceTick();
      };
      $("ogx3-sim-moon").onclick = () => sim("moon");
      $("ogx3-sim-planet").onclick = () => sim("planet");
      $("ogx3-dump").onclick = () => {
        const ev = document.querySelector("#fleet-movement-content, #layoutFleetMovements");
        log(`[DOM] pasek planet: ${JSON.stringify(PlanetBar.pairs().slice(0, 6))} … aktywne: ${JSON.stringify(PlanetBar.active())}`, "info");
        log(`[DOM] pasek misji: ${JSON.stringify(Bar.read())}`, "info");
        log(`[DOM] Events (${ev ? "jest" : "BRAK"}): ${(ev?.outerHTML || "").replace(/\s+/g, " ").slice(0, 2500)}`, "info");
        if (page() === "fleet") log(`[DOM] hangar: ${JSON.stringify(Hangar.scan())}`, "info");
      };
      $("ogx3-report").onclick = () => {
        Calib.collect();
        const r = Calib.report();
        navigator.clipboard?.writeText(r).then(() => log("[KALIBRACJA] raport skopiowany do schowka — wklej go Claude'owi.", "success"), () => log(r, "info"));
      };
      $("ogx3-pushtest").onclick = () => Notifier.push("Test OGameX 3", "Powiadomienia działają. Temat: " + Notifier.topic(), "default", "white_check_mark");
      $("ogx3-abort").onclick = () => Fly.abort("operator");
      $("ogx3-save").onclick = async () => {
        const s0 = Situation.load();
        const a0 = s0.active;
        if (!a0) return alert("Nie widzę aktywnej planety — otwórz przegląd i spróbuj ponownie.");
        const f = Situation.fleetAt(s0, a0.key, Date.now());
        if (!f) return alert(`Nie widzę floty na [${a0.key}] — wejdź raz na zakładkę Fleet, żeby bot odczytał hangar.`);
        const virt = JSON.parse(JSON.stringify(s0));
        virt.threats = [ {
          id: "manual",
          dst: a0.key,
          dstBody: f.body,
          arriveAt: Date.now() + 5 * 6e4,
          attack: true,
          spy: false,
          seenAt: 0,
          source: "operator",
          type: "ATTACK"
        } ];
        const {actions: actions} = decide(virt, CFG, Date.now());
        const act = actions.find(x => x.kind === "fly" && x.fromKey === a0.key && (x.rescue || x.blind)) || actions.find(x => x.kind === "fly" && (x.rescue || x.blind));
        if (!act) return alert("Nie mam dokąd uciec (jedyna kolonia albo wszystko atakowane). Zobacz log.");
        log(`[OPERATOR] ręczny ratunek: ${act.why}`, "warn");
        if (Fly.start({
          ...act,
          why: "RĘCZNY ratunek operatora"
        })) {
          await Fly.tick();
        }
      };
      $("ogx3-home").onclick = async () => {
        const s0 = Situation.load();
        const f = (s0.flights || []).find(x => [ "launched", "recall_clicked", "recall_failed" ].includes(x.phase));
        if (f) {
          log(`[OPERATOR] ręczny zawrót lotu [${f.fromKey}]→[${f.toKey}]`, "warn");
          await Fly.recall(f);
          return;
        }
        const a0 = s0.active;
        const home = a0 && (s0.pairs || {})[a0.key];
        const fleet = a0 ? Situation.fleetAt(s0, a0.key, Date.now()) : null;
        if (home && home.hasMoon && fleet && fleet.body === "planet") {
          log("[OPERATOR] ręczny powrót planeta → księżyc", "warn");
          if (Fly.start({
            kind: "home",
            fromKey: a0.key,
            fromBody: "planet",
            toKey: a0.key,
            toBody: "moon",
            why: "RĘCZNY powrót na księżyc",
            speed: 100,
            home: true
          })) await Fly.tick();
          return;
        }
        alert("Nie widzę lotu do zawrócenia ani floty na planecie pary z księżycem. Sprawdź panel — „Szczegóły stanu”, pole „Loty”.");
      };
      $("ogx3-imp-off").value = String(CFG.impact.recyclerOffsetSec ?? 2);
      $("ogx3-imp-off").onchange = e => {
        CFG.impact.recyclerOffsetSec = Math.max(0, Math.min(600, parseInt(e.target.value) || 0));
        saveCfg();
        log(`[ZEGAR] sygnał „recki teraz" ${CFG.impact.recyclerOffsetSec} s po uderzeniu. Pamiętaj: licznik gry ma ziarno 1 s, więc poniżej 2 s zdarzy się trafić w niezakończoną bitwę.`, "info");
        this.renderImpact();
      };
      $("ogx3-imp-lead").value = String(CFG.impact.leadSec ?? 60);
      $("ogx3-imp-lead").onchange = e => {
        CFG.impact.leadSec = Math.max(0, Math.min(3600, parseInt(e.target.value) || 0));
        saveCfg();
        log(CFG.impact.leadSec ? `[ZEGAR] ostrzeżenie ${CFG.impact.leadSec} s przed pierwszą falą.` : "[ZEGAR] ostrzeżenie przed uderzeniem WYŁĄCZONE — zostaje sam sygnał „recki teraz”.", "info");
      };
      $("ogx3-imp-beep").onclick = () => {
        CFG.impact.beep = !CFG.impact.beep;
        saveCfg();
        this.renderStatus();
        if (CFG.impact.beep) Impact.beep(2);
      };
      $("ogx3-imp-copy").onclick = () => {
        const off = (CFG.impact.recyclerOffsetSec ?? 2) * 1e3;
        const t = Impact.list().map(v => `${Clock.hms(v.at)} ${v.attack ? "ATAK" : "sonda"} [${v.dst}]${v.dstBody === "moon" ? " ☾" : ""} ← [${v.src || "?"}]${v.attack && Impact.ostatnia(v) ? ` · recki ${Clock.hms(v.at + off)}` : ""}`).join("\n") || "(brak obcych flot w drodze)";
        navigator.clipboard?.writeText(t).then(() => log("[ZEGAR] godziny skopiowane do schowka.", "success"), () => log(t, "info"));
      };
      $("ogx3-copy").onclick = () => {
        const t = logEntries.map(e => `[${e.time}] [${e.type.toUpperCase()}] ${e.msg}`).join("\n");
        navigator.clipboard?.writeText(t);
      };
      $("ogx3-clear").onclick = () => {
        logEntries = [];
        Store.set("log", []);
        this.renderLog();
      };
      this.el.addEventListener("click", e => {
        const b = e.target && e.target.closest ? e.target.closest("button") : null;
        if (!b || !this.el.contains(b)) return;
        setTimeout(() => {
          try {
            b.blur();
          } catch {}
        }, 0);
        if (this.zKlawiatury(e)) {
          e.stopImmediatePropagation();
          e.preventDefault();
          log(`[PANEL] zignorowałem „${(b.textContent || "").trim()}" wciśnięte KLAWISZEM (Enter/Spacja na przycisku w fokusie) — ustawienia zmieniasz tylko kliknięciem myszą.`, "warn");
          return;
        }
        if (syncCfg()) {
          e.stopImmediatePropagation();
          e.preventDefault();
          this.renderStatus();
          log(`[PANEL] ustawienia zmieniono w innej karcie — odświeżyłem panel i NIE przełączyłem „${(b.textContent || "").trim()}". Sprawdź stan i kliknij jeszcze raz, jeśli trzeba.`, "warn");
        }
      }, true);
      this.el.addEventListener("change", () => {
        try {
          syncCfg();
        } catch {}
      }, true);
      this.renderStatus();
      this.renderLog();
      this.renderImpact();
    },
    zKlawiatury(e) {
      return !!e && e.isTrusted === true && e.detail === 0;
    },
    _impAuto: false,
    renderImpact() {
      if (!this.el) return;
      const $ = id => document.getElementById(id);
      const cfg = CFG.impact || {};
      const now = Date.now();
      const lista = Impact.list();
      const nx = Impact.next();
      const row = $("ogx3-r-imp");
      if (row) {
        if (nx) {
          const l = Math.round((nx.at - now) / 1e3);
          row.style.display = "";
          row.querySelector(".val").textContent = l >= 0 ? `${Clock.hms(nx.at)} · za ${mmss(l)}` : Impact.ostatnia(nx) ? `RECKI TERAZ · ${Clock.hms(nx.at + (cfg.recyclerOffsetSec ?? 2) * 1e3)}` : `UDERZYŁO ${Clock.hms(nx.at)}`;
        } else {
          row.style.display = "none";
          row.querySelector(".val").textContent = "—";
        }
      }
      const tail = $("ogx3-t-imp");
      if (tail) tail.textContent = nx ? mmss(Math.max(0, (nx.at - now) / 1e3)) : lista.length ? `${lista.length} w pamięci` : "cicho";
      const sec = this.el.querySelector('.sec[data-sec="imp"]');
      if (nx && nx.at - now < 10 * 6e4) {
        if (sec && !this._impAuto) {
          this._impAuto = true;
          if (!sec.classList.contains("open")) {
            sec.classList.add("open");
            const a = sec.querySelector(".arr");
            if (a) a.textContent = "▾";
          }
        }
      } else this._impAuto = false;
      const box = $("ogx3-imp-list");
      if (!box) return;
      if (!lista.length) {
        box.innerHTML = `<div class="note">Cicho — żadnej obcej floty w drodze. Gdy jakaś nadleci, będzie tu GODZINA uderzenia (gra pokazuje samo odliczanie) i godzina wysyłki recków.</div>`;
      } else {
        const off = (cfg.recyclerOffsetSec ?? 2) * 1e3;
        box.innerHTML = lista.map(v => {
          const l = Math.round((v.at - now) / 1e3);
          const g = parseKey(v.dst);
          const ost = v.attack && !v.cancelled && Impact.ostatnia(v);
          return `<div class="imp${v.attack ? "" : " spy"}${v.cancelled ? " odwolany" : ""}">` + `<div class="h"><span>${Clock.hms(v.at)}</span><span class="cd">${v.cancelled ? "ODWOŁANY" : l >= 0 ? "za " + mmss(l) : l >= -120 ? "TERAZ" : "było"}</span></div>` + `<div class="sub">${v.attack ? "atak" : "sonda"} → [${v.dst}] ${v.dstBody === "moon" ? "☾" : "◍"} ← [${v.src || "?"}]${v.precise ? "" : " ~"}</div>` + (ost ? `<div class="sub rk">recki ${Clock.hms(v.at + off)}${g ? ` · <a data-gal="${g.galaxy}:${g.system}">złom ↗</a>` : ""}</div>` : "") + `</div>`;
        }).join("");
        box.onclick = e => {
          const a = e.target.closest("a[data-gal]");
          if (!a) return;
          const [g, s] = String(a.dataset.gal || "").split(":");
          if (g && s) {
            try {
              window.open(`/galaxy?x=${g}&y=${s}`, "_blank");
            } catch {}
          }
        };
      }
      const note = $("ogx3-imp-note");
      if (note) {
        const o = Clock.offset();
        note.textContent = `Godziny w czasie gry${Math.abs(o) >= 5e3 ? ` (Twój zegar ${o > 0 ? "spóźnia się" : "śpieszy się"} o ${Math.round(Math.abs(o) / 1e3)} s)` : ""} · dokładność ±1 s — tyle ma ziarno licznika gry. „~” = odczyt zgrubny, bez złapanego przeskoku sekundy.`;
      }
    },
    setMin(on) {
      Store.set("ui_min", !!on);
      const b = document.getElementById("ogx3-body"), s = document.getElementById("ogx3-strip"), m = document.getElementById("ogx3-min");
      if (b) b.style.display = on ? "none" : "block";
      if (s) s.style.display = on ? "none" : "block";
      if (m) {
        m.textContent = on ? "▫" : "_";
        m.title = on ? "Rozwiń panel" : "Zwiń panel";
      }
    },
    setRow(id, cls, text) {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = "row" + (cls ? " " + cls : "");
      el.querySelector(".val").textContent = text;
    },
    renderJournal() {
      const el = document.getElementById("ogx3-journal");
      if (!el) return;
      const j = (Store.get("journal", []) || []).slice(0, 25);
      el.innerHTML = j.length ? j.map(e => `<div class="jr ${e.kind}"><b>${new Date(e.at).toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit"
      })} ${e.kind}</b> ${String(e.msg).replace(/</g, "&lt;")}</div>`).join("") : `<div class="jr">(pusto — bot nic jeszcze nie zgłosił)</div>`;
    },
    renderStatus() {
      if (!this.el) return;
      const $ = id => document.getElementById(id);
      const s = Situation.load();
      const now = Date.now();
      const th = (s.threats || []).filter(t => t.arriveAt > now);
      const atk = th.filter(t => t.attack);
      $("ogx3-on").textContent = CFG.enabled ? "ON" : "OFF";
      $("ogx3-on").style.background = CFG.enabled ? "#27ae60" : "#e74c3c";
      $("ogx3-auto").textContent = CFG.autoRescue ? "Auto-ratunek ON" : "Obserwator (bez ruchu)";
      $("ogx3-auto").style.background = CFG.autoRescue ? "#1e6b3a" : "#5a4a1e";
      {
        const lf0 = CFG.expo && CFG.expo.launchFrom ? `${CFG.expo.launchFrom.galaxy}:${CFG.expo.launchFrom.system}:${CFG.expo.launchFrom.position}` : null;
        const mode = !CFG.recon ? "OFF" : CFG.reconMode === "all" ? "wszystkie" : lf0 ? `tylko [${lf0}]` : "tylko flota";
        $("ogx3-recon").textContent = `Rekonesans: ${mode}`;
        $("ogx3-recon").style.background = CFG.recon ? "rgba(255,255,255,.1)" : "#6b1e1e";
      }
      $("ogx3-h2m").textContent = CFG.homeToMoon ? "Zwożenie na księżyc ON" : "Flota rusza się TYLKO przy ataku";
      $("ogx3-h2m").style.background = CFG.homeToMoon ? "#5a4a1e" : "#1e6b3a";
      $("ogx3-push").textContent = `Push ${Notifier.enabled() ? "ON" : "OFF"}`;
      $("ogx3-voice").textContent = `Głos ${Store.get("voice_on", false) ? "ON" : "OFF"}`;
      $("ogx3-deb").textContent = `Złom ${CFG.debris.enabled ? "ON" : "OFF"}`;
      $("ogx3-deb").style.background = CFG.debris.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-quiet").textContent = CFG.stealth && CFG.stealth.enabled ? `Tryb cichy ON (kolonie co ${CFG.stealth.colonyHours || 8} h)` : "Tryb cichy OFF (kolonie co 45 min)";
      $("ogx3-quiet").style.background = CFG.stealth && CFG.stealth.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-aster").textContent = `Mining ${CFG.aster.enabled ? "ON" : "OFF"}`;
      $("ogx3-aster").style.background = CFG.aster.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-farm").textContent = `Farma ${CFG.farm.enabled ? "ON" : "OFF"}`;
      $("ogx3-farm").style.background = CFG.farm.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-farm-seq").textContent = CFG.farm.sequential ? "Po kolei 1→koniec" : "Priorytet łupu";
      {
        const fst = Farm.status();
        $("ogx3-farm-st").textContent = fst;
        $("ogx3-t-farm").textContent = CFG.farm.enabled ? `ON · ${CFG.farm.shipType === "BATTLESHIP" ? "OW" : CFG.farm.shipType === "HEAVY_CARGO" ? "DT" : "MT"}` : "OFF";
      }
      $("ogx3-bonus").textContent = `Bonus ${CFG.bonus.enabled ? "ON" : "OFF"}`;
      $("ogx3-bonus").style.background = CFG.bonus.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      {
        const b0 = Bonus.st();
        $("ogx3-bonus-st").textContent = CFG.bonus.enabled ? `bonus online: dziś ${Bonus.today(b0)}${b0.claims && b0.claims.length ? ` · ostatni ${new Date(b0.claims[b0.claims.length - 1]).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit"
        })}` : ""}` : "";
      }
      $("ogx3-moon").textContent = `Księżyce ${CFG.moon.enabled ? "ON" : "OFF"}`;
      $("ogx3-moon").style.background = CFG.moon.enabled ? "#5a4a1e" : "rgba(255,255,255,.1)";
      {
        const s1 = Situation.load();
        const bez = Object.entries(s1.pairs || {}).filter(([, p]) => !p.hasMoon).length;
        const doOdb = Object.keys(s1.moonLost || {}).filter(k => !((s1.pairs || {})[k] || {}).hasMoon).length;
        $("ogx3-moon-st").textContent = CFG.moon.enabled ? `planet bez księżyca: ${bez} · WYDAJE METAL` : `planet bez księżyca: ${bez} · nowych nie stawiam${doOdb ? ` · ODBUDOWUJĘ ${doOdb} zniszczony(ch)` : " · odbuduję tylko księżyc zniszczony przez atak"}`;
      }
      $("ogx3-quiet").textContent = `Cisza nocna ${CFG.quietHours.enabled ? "ON" : "OFF"}`;
      $("ogx3-quiet").style.background = CFG.quietHours.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-breaks").textContent = `Przerwy kawowe ${CFG.human.breaks ? "ON" : "OFF"}`;
      $("ogx3-breaks").style.background = CFG.human.breaks ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-human-st").textContent = CFG.quietHours.enabled || CFG.human.breaks ? `ekonomia śpi: ${[ CFG.quietHours.enabled ? `${CFG.quietHours.startHour}:00–${CFG.quietHours.endHour}:00` : null, CFG.human.breaks ? Human.onBreak() ? `przerwa (~${Human.breakLeftMin()} min)` : "przerwy co " + CFG.human.breakEveryMinMin + "–" + CFG.human.breakEveryMaxMin + " min" : null ].filter(Boolean).join(" · ")} (obrona czuwa zawsze)` : "ekonomia pracuje całą dobę, bez przerw";
      $("ogx3-fs").textContent = `FS ${CFG.fs.enabled ? "ON" : "OFF"}`;
      $("ogx3-fs").style.background = CFG.fs.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-expo").textContent = `Ekspedycje ${CFG.expo.enabled ? "ON" : "OFF"}`;
      $("ogx3-expo").style.background = CFG.expo.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-disc").textContent = `Odkrywca 40 min ${CFG.expo.discoverer40 ? "ON" : "OFF"}`;
      $("ogx3-topic").textContent = Notifier.topic();
      $("ogx3-imp-beep").textContent = `Dźwięk ${CFG.impact.beep ? "ON" : "OFF"}`;
      $("ogx3-imp-beep").style.background = CFG.impact.beep ? "#1e6b3a" : "rgba(255,255,255,.1)";
      const aster = Store.get("aster", {}) || {};
      const burst = Store.get("burst", null);
      const eSl = s.slots?.expo, fSl = s.slots?.fleet;
      const m = Fly.mission();
      const flights = s.flights || [];
      if (Session.lostRecently()) this.setRow("ogx3-r-def", "alert", "SESJA WYGASŁA — zaloguj się"); else if (!CFG.enabled) this.setRow("ogx3-r-def", "dim", "bot WYŁĄCZONY"); else if (atk.length) this.setRow("ogx3-r-def", "alert", atk.map(t => `ATAK → [${t.dst}] ${t.dstBody === "moon" ? "☾" : "◍"} ${Math.max(0, Math.round((t.arriveAt - now) / 1e3))}s`).join(" · ")); else if (th.length) this.setRow("ogx3-r-def", "busy", `sonda → [${th[0].dst}] ${Math.max(0, Math.round((th[0].arriveAt - now) / 1e3))}s`); else {
        const slepy = !!(Store.get("events_open", null) || {}).dumped;
        const ile = Math.max(0, Object.keys(s.pairs || {}).length - 1);
        this.setRow("ogx3-r-def", slepy ? "busy" : CFG.autoRescue ? "ok" : "busy", `czysto · ${CFG.autoRescue ? "auto-ratunek" : "obserwator"}${slepy ? ` · ⚠ ${ile} kolonii bez nadzoru` : ""}`);
      }
      this.el.classList.toggle("alarm", atk.length > 0 || Session.lostRecently());
      if (atk.length && Store.get("ui_min", false) === true) this.setMin(false);
      {
        const a0 = s.active;
        const h = a0 ? Situation.fleetAt(s, a0.key, now) : null;
        const air = flights.filter(f => [ "launched", "recall_clicked", "recall_failed" ].includes(f.phase));
        if (m) this.setRow("ogx3-r-fleet", "busy", `MISJA ${m.step} [${m.fromKey}]→[${m.toKey}]`); else if (air.length) this.setRow("ogx3-r-fleet", "busy", `w powietrzu: [${air[0].fromKey}]→[${air[0].toKey}] ${air[0].phase}`); else if (h) this.setRow("ogx3-r-fleet", "ok", `[${a0.key}] ${h.body === "moon" ? "☾" : "◍"} ${h.total.toLocaleString("pl-PL")} szt.`); else this.setRow("ogx3-r-fleet", "dim", a0 ? `[${a0.key}] — wejdź na Fleet` : "nie widzę planety");
      }
      const expoNext = (() => {
        if (!CFG.expo.enabled) return "OFF";
        try {
          const why = Human.economyAllowed(s);
          if (why) return why.startsWith("przerwa") ? why : why.slice(0, 22);
          const rr = Store.get("expo_rest", null);
          if (rr && rr.until > now) return `przerwa między seriami ${Math.ceil((rr.until - now) / 6e4)} min`;
          const p = expoPlan(s, CFG, now, burst);
          if (p && p.skip) {
            if (/odstęp między falami/.test(p.skip) && burst && burst.lastSendAt) {
              const left = Math.max(0, burst.lastSendAt + (burst.gapMs || 0) - now);
              return `następna za ${Math.ceil(left / 1e3)} s`;
            }
            if (/czekam na powroty|ekspedycje \d/.test(p.skip)) return p.skip.replace("— czekam na powroty", "").trim();
            if (/rekonesans/.test(p.skip)) return "czekam na odczyt hangaru";
            if (p.ferry) return "flota na PLANECIE → zwożę";
            if (p.needPlanet) return "pusty ☾ — sprawdzam planetę";
            return p.skip.slice(0, 26);
          }
          return "fala gotowa";
        } catch {
          return "";
        }
      })();
      {
        const st = `${eSl ? eSl.used + "/" + eSl.total : "?"} · fl ${fSl ? fSl.used + "/" + fSl.total : "?"}${expoNext ? " · " + expoNext : ""}`;
        this.setRow("ogx3-r-expo", CFG.expo.enabled ? "ok" : "dim", CFG.expo.enabled ? st : `OFF · ${st}`);
        const burstAlive = burst && burst.sent && burst.lastSendAt && now - burst.lastSendAt < 3 * 36e5;
        const stall = Store.get("expo_stall", null);
        const stallMin = stall && stall.since && now - (stall.at || 0) < 30 * 6e4 ? Math.round((now - stall.since) / 6e4) : 0;
        $("ogx3-expo-st").textContent = `sloty: expo ${eSl ? eSl.used + "/" + eSl.total : "?"}, floty ${fSl ? fSl.used + "/" + fSl.total : "?"}${burstAlive ? ` · seria ${burst.sent}/${burst.waves}` : ""}${stallMin >= 30 ? ` · STOI ${stallMin} min` : ""}`;
        $("ogx3-t-expo").textContent = CFG.expo.enabled ? CFG.expo.discoverer40 ? "ON · 40 min" : "ON" : "OFF";
      }
      {
        const exp = (s.expected || []).filter(e => !e.pending && e.returnAt > now).sort((a, b) => a.returnAt - b.returnAt);
        const sum = exp.reduce((t, e) => t + (e.total || 0), 0);
        this.setRow("ogx3-r-ret", exp.length ? "ok" : "dim", exp.length ? `${exp.length} lot(y), ${sum.toLocaleString("pl-PL")} szt. · najbliższy ${new Date(exp[0].returnAt).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit"
        })}` : "nic nie wraca");
      }
      {
        const txt = CFG.aster.enabled ? `zakresy ${(aster.ranges || []).length}${aster.sentTo ? ` · ost. [${aster.sentTo}]` : ""}` : "wyłączony";
        this.setRow("ogx3-r-min", CFG.aster.enabled ? "ok" : "dim", txt);
        const aCargo = CFG.aster.cargoPerMiner || aster.cargo || 0;
        const aYield = CFG.aster.expectedRes || ((aster.yields || []).length ? 1 : 0);
        const aHow = CFG.aster.maxMiners ? `${CFG.aster.maxMiners.toLocaleString("pl-PL")} szt./lot` : aCargo && aYield ? "wielkość liczy bot (ładownia znana)" : "UWAGA: leci CAŁY hangar (brak ładowni/urobku)";
        $("ogx3-aster-st").textContent = CFG.aster.enabled ? `${aHow} · zakresy: ${(aster.ranges || []).length}${aster.sentTo ? ` · ostatnio: [${aster.sentTo}]` : ""}` : "";
        $("ogx3-t-eco").textContent = `${CFG.aster.enabled ? "M ON" : "M OFF"} · ${CFG.debris.enabled ? "Z ON" : "Z OFF"}`;
      }
      {
        const rh = `${String(CFG.fs.returnHour ?? 7).padStart(2, "0")}:${String(CFG.fs.returnMinute || 0).padStart(2, "0")}`;
        const fsFlight = flights.find(f => f.fs && f.phase !== "done");
        const fsWait = !fsFlight && CFG.fs.enabled ? Object.values(s.fsMeasured || {}).map(v => ({
          v: v,
          openAt: (s.fsReturnAt || 0) - 2 * (v && v.flightMs || 0)
        })).filter(x => x.v && x.v.flightMs > 0 && now - (x.v.at || 0) < 24 * 36e5 && now < x.openAt).sort((a, b) => a.openAt - b.openAt)[0] : null;
        const restDo = (s.fsRestUntil || 0) > now ? s.fsRestUntil : 0;
        const fsTxt = !CFG.fs.enabled ? "wyłączony" : fsFlight ? `w drodze — zawrót ~${new Date(fsFlight.recallAt || 0).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit"
        })}` : restDo ? `okno dnia — flota w domu do ${new Date(restDo).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit"
        })} (ekspedycje), potem FS` : fsWait ? `czeka: lot ${Math.round(fsWait.v.flightMs / 6e4)} min, start ~${new Date(fsWait.openAt).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit"
        })} (wcześniej flota by wylądowała) · w domu o ${rh}` : `w domu · wraca o ${rh}${CFG.fs.target ? ` · cel [${CFG.fs.target}]` : " · cel: najdalsza kolonia"}`;
        this.setRow("ogx3-r-fs", !CFG.fs.enabled ? "dim" : fsFlight ? "busy" : fsWait ? "busy" : "ok", fsTxt);
        $("ogx3-fs-st").textContent = fsTxt;
        $("ogx3-t-fs").textContent = CFG.fs.enabled ? `→${rh}` : "OFF";
      }
      $("ogx3-t-def").textContent = CFG.autoRescue ? "auto-ratunek" : "obserwator";
      {
        const j = (Store.get("journal", []) || [])[0];
        $("ogx3-t-jr").textContent = j ? `${new Date(j.at).toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit"
        })} ${j.kind}` : "pusto";
        if (this.el.querySelector('.sec[data-sec="jr"]')?.classList.contains("open")) this.renderJournal();
      }
      const fleetsTxt = Object.entries(s.hangars || {}).filter(([, h]) => h.total > 0 && now - h.at < 48 * 36e5).sort((a, b) => b[1].total - a[1].total).slice(0, 4).map(([k, h]) => `${k.replace("|", " ")}: ${h.total.toLocaleString("pl-PL")} (${new Date(h.at).toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit"
      })})`).join("\n  ");
      const fl = flights.map(f => `${f.kind} [${f.fromKey}]→[${f.toKey}] ${f.phase}${f.recallAt ? " zawrót " + new Date(f.recallAt).toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit"
      }) : ""}`).join("\n  ");
      $("ogx3-status").textContent = `Aktywne: ${s.active ? `${s.active.body} [${s.active.key}]` : "?"} · pary: ${Object.keys(s.pairs || {}).length} · pasek: ${s.bar ? `${s.bar.foreign} obcych${s.bar.barType ? " (" + s.bar.barType + ")" : ""} ${(() => {
        const w = Math.round((now - (s.bar.at || 0)) / 1e3);
        return w > Math.round((CFG.barMaxAgeMs || 3 * 6e4) / 1e3) ? `⚠ STARY (sprzed ${Math.round(w / 60)} min)` : `(sprzed ${w} s)`;
      })()}` : "?"}${s.listUntrusted ? " · ⚠ SESJA NA OBCEJ KOLONII" : ""}\nZagrożenia: ${th.length ? th.map(t => `${t.attack ? "ATAK" : "sonda"} → [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - now) / 1e3)}s`).join("; ") : "brak"}\nHangary:\n  ${fleetsTxt || "(wejdź na Fleet)"}\nLoty: ${fl ? "\n  " + fl : "brak"}${m ? `\nMISJA: ${m.step} [${m.fromKey}]→[${m.toKey}]` : ""}${Session.lostRecently() ? "\nSESJA WYGASŁA" : ""}`;
    },
    renderLog() {
      const el = document.getElementById("ogx3-log");
      const tail = document.getElementById("ogx3-t-log");
      if (tail) tail.textContent = logEntries[0] ? `${logEntries[0].time} ${logEntries[0].msg}`.slice(0, 42) : "pusto";
      if (!el) return;
      const col = {
        error: "#ff7b7b",
        warn: "#ffd56b",
        success: "#7bff9b",
        info: "#dfe8f5"
      };
      el.innerHTML = logEntries.slice(0, 150).map(e => `<div style="color:${col[e.type] || "#dfe8f5"}">${e.time} ${e.msg.replace(/</g, "&lt;")}</div>`).join("");
    }
  };
  if (typeof document === "undefined" || typeof window === "undefined") {
    globalThis.OGX3 = {
      decide: decide,
      Situation: Situation,
      Bar: Bar,
      Rows: Rows,
      DEFAULTS: DEFAULTS
    };
    return;
  }
  try {
    window.__OGX3 = {
      decide: decide,
      Situation: Situation,
      Bar: Bar,
      Rows: Rows,
      Fly: Fly,
      Farm: Farm,
      CFG: CFG,
      Store: Store,
      defenceTick: defenceTick,
      expoPlan: expoPlan,
      expoHomeBody: expoHomeBody,
      syncCfg: syncCfg,
      saveCfg: saveCfg,
      barExcessState: barExcessState,
      PlanetBar: PlanetBar,
      Hangar: Hangar,
      UI: UI,
      Recon: Recon,
      Human: Human,
      Impact: Impact,
      Clock: Clock,
      busy: () => running
    };
  } catch {}
  Store.set("last_load", Date.now());
  {
    const pv = Store.get("ver", "");
    if (pv !== VERSION) {
      Store.set("ver", VERSION);
      Store.del("events_open");
      Store.del("mv_probe");
      Store.del("re_probe");
      Store.del("expo_rest");
      if (CFG.human && CFG.human.ecoIdleSec === 300) {
        CFG.human.ecoIdleSec = 0;
        saveCfg();
      }
    }
  }
  try {
    UI.build();
  } catch (e) {
    console.error("[OGX3] panel:", e);
  }
  {
    const nl = Store.get("nav_last", null);
    const fresh = nl && Date.now() - nl.at < 2e4;
    log(`OGameX Assistant 3 v${VERSION} — ${CFG.enabled ? "ON" : "OFF"}, ${CFG.autoRescue ? "AUTO-RATUNEK" : "OBSERWATOR"}, ${location.pathname}${location.search || ""}${fresh ? ` ← bot: ${nl.why}` : " ← otwarte ręcznie"}`, "info");
    if (fresh) {
      try {
        Store.del("nav_last");
      } catch {}
    }
    const loads = (Store.get("loads", []) || []).filter(x => Date.now() - (x.t || x) < 6e4).map(x => typeof x === "number" ? {
      t: x,
      bot: false
    } : x);
    loads.push({
      t: Date.now(),
      bot: !!fresh,
      why: fresh ? String(nl.why || "") : ""
    });
    Store.set("loads", loads.slice(-20));
    const bots = loads.filter(x => x.bot);
    const same = bots.reduce((m, x) => {
      const k = String(x.why || "").slice(0, 28);
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {});
    const worst = Object.entries(same).sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= 4 && !Once.said("tempo", 6e4)) {
      log(`[TEMPO] ten sam powód ${worst[1]}× w ostatniej minucie: „${worst[0]}". To wygląda na pętlę — pokaż tę linię Claude'owi.`, "warn");
    }
    if (!fresh) Store.set("manual_at", Date.now());
    if (!fresh && Date.now() - (Store.get("input_at", 0) || 0) < 15e3) {
      try {
        const mi = Store.get("mission", null), ls = Store.get("last_send", null);
        if (mi && ECO_KIND(mi.kind) || ls && ECO_KIND(ls.kind) && Date.now() - (ls.at || 0) < 5 * 6e4) {
          const now4 = Date.now(), y = Store.get("eco_yield", null);
          Store.set("eco_yield", y && now4 - y.last < 6e4 ? {
            since: y.since,
            last: now4
          } : {
            since: now4,
            last: now4
          });
        }
      } catch {}
    }
  }
  {
    const ostatni = Store.get("last_tick", 0) || 0;
    const przerwa = Date.now() - ostatni;
    if (ostatni && przerwa > 3 * 36e5) {
      const godz = Math.round(przerwa / 36e5);
      const j = (Store.get("journal", []) || []).filter(x => (x.at || 0) >= ostatni);
      const ile = k => j.filter(x => x.kind === k).length;
      if (j.length) {
        log(`[PODSUMOWANIE] bot milczał ${godz} h. W dzienniku obrony z tego czasu: ${ile("ATAK")} × ATAK, ${ile("RATUNEK")} × ratunek, ${ile("POWRÓT")} × powrót, ${ile("BŁĄD")} × błąd, ${ile("EKO")} × ekonomia.`, ile("ATAK") ? "error" : "info");
        for (const x of j.filter(x => x.kind === "ATAK" || x.kind === "BŁĄD").slice(0, 6)) {
          log(`[PODSUMOWANIE] ${new Date(x.at).toLocaleString("pl-PL")} ${x.kind}: ${x.msg}`, "warn");
        }
      } else {
        log(`[PODSUMOWANIE] bot milczał ${godz} h i NIC nie zapisało się w dzienniku obrony. Uwaga: jeśli bot był wyłączony albo karta zamknięta, to nie znaczy „spokojnie" — znaczy „nie patrzyłem". Jedynym pewnym źródłem jest wtedy raport bojowy w wiadomościach gry.`, "warn");
      }
    }
  }
  try {
    if (page() === "fleet") Hangar.scan();
  } catch (e) {
    log(`[START] odczyt hangaru: ${e.message}`, "warn");
  }
  try {
    Wake.ensure();
    Calib.collect();
  } catch (e) {
    log(`[START] wake/kalibracja: ${e.message}`, "warn");
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") Wake.ensure();
  });
  for (const ev of [ "click", "keydown", "wheel" ]) {
    try {
      document.addEventListener(ev, e => {
        if (e && e.isTrusted) Store.set("input_at", Date.now());
      }, {
        capture: true,
        passive: true
      });
    } catch {}
  }
  defenceTick();
  setInterval(defenceTick, CFG.tickMs);
  try {
    Heartbeat.ping();
  } catch {}
  setInterval(() => {
    try {
      Heartbeat.ping();
    } catch {}
  }, 3e4);
  setInterval(() => {
    try {
      const now = Date.now();
      const off = !CFG.enabled, obs = CFG.enabled && !CFG.autoRescue;
      const st = Store.get("guard_state", null) || {};
      const stan = off ? "off" : obs ? "obs" : "ok";
      if (st.stan !== stan) {
        Store.set("guard_state", {
          stan: stan,
          since: now,
          pushAt: 0
        });
        return;
      }
      if (stan === "ok" || now - (st.since || now) < 10 * 6e4 || now - (st.pushAt || 0) < 36e5) return;
      Store.set("guard_state", {
        ...st,
        pushAt: now
      });
      const min = Math.round((now - st.since) / 6e4);
      Notifier.push(off ? `⛔ Bot WYŁĄCZONY (${UNI})` : `👀 Bot w trybie OBSERWATOR (${UNI})`, off ? `Od ${min} min bot jest OFF — nie wykrywa ataków i nie rusza flotą. Włącz go w panelu.` : `Od ${min} min auto-ratunek jest wyłączony — przy ataku bot tylko alarmuje, flotą NIE ruszy. Włącz „Auto-ratunek” w panelu.`, "high", "warning");
    } catch {}
  }, 6e4);
  let sampleAt = 0, tickAt = 0;
  try {
    Impact.tick();
  } catch {}
  setInterval(() => {
    const n = Date.now();
    if (n - sampleAt < 200) return;
    sampleAt = n;
    try {
      Impact.sample();
    } catch {}
  }, 250);
  setInterval(() => {
    const n = Date.now();
    if (n - tickAt < 900) return;
    tickAt = n;
    try {
      Impact.tick();
    } catch {}
  }, 1e3);
  setInterval(keepalive, 6e4);
  setInterval(watchdog, 6e4);
  setInterval(() => {
    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: "https://raw.githubusercontent.com/Mitjano/ogamex-assistant/main/ogamex-assistant.user.js?t=" + Date.now(),
        onload: r => {
          const v = (String(r.responseText || "").match(/@version\s+([\d.]+)/) || [])[1];
          if (v && v !== VERSION && !Once.said("update|" + v, 36e5)) {
            log(`[UPDATE] repo ma v${v}, tu chodzi v${VERSION} — Tampermonkey → Sprawdź aktualizacje.`, "error");
            if (!Once.said("update_push|" + v, 6 * 36e5)) Notifier.push(`⬆️ Nowa wersja bota (${UNI})`, `W repo jest v${v}, w grze chodzi v${VERSION}. Tampermonkey → Panel → Sprawdź aktualizacje.`, "default", "arrow_up");
          }
        }
      });
    } catch {}
  }, 15 * 6e4);
})();
