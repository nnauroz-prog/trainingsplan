#!/usr/bin/env node
// Automatisierte Tests für die Trainings-App.
// Start:  node tests/run.js
// Benötigt: Node, Playwright mit Chromium, python3 (für den lokalen Server). Testet index.html (vorher ./build.sh).
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = +process.env.TP_PORT || 8790; // TP_PORT: eigener Port, wenn mehrere Testläufe gleichzeitig laufen
const URL = `http://localhost:${PORT}/?test`;
const KEY = "trainingsplan-v2";
let pass = 0, fail = 0;
const allErrors = [];

function ok(name, cond, info = "") {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (info ? "  → " + info : "")); }
}
const section = s => console.log("\n" + s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Testdaten ----------
// Datenstand vor diesem Update: ohne v, dev, Einheit (u) in der Historie
const OLD_V2 = {
  plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Drücken", items: [
    { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 },
    { id: "i2", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 90 },
    { id: "i3", exId: "hs-fly", sets: 3, rmin: 8, rmax: 12, rest: 60 },
    { id: "i4", exId: "c-abc", sets: 3, rmin: 8, rmax: 12, rest: 60 }] }] },
  custom: [{ id: "c-abc", name: "Alte Rudermaschine", muscle: "ruecken", sec: [], type: "plate" }],
  notes: { "hs-chest": "Sitz 4" },
  history: [{ id: "h1", dayId: "d1", day: "Drücken", date: new Date(Date.now() - 5 * 864e5).toISOString(), durationSec: 2400, exercises: [
    { exId: "hs-chest", name: "Brustpresse", sets: [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }, { kg: 40, reps: 12, f: "m" }] },
    { exId: "hs-legpress", name: "Beinpresse", sets: [{ kg: 160, reps: 10 }, { kg: 160, reps: 9 }] },
    { exId: "hs-fly", name: "Butterfly", sets: [{ kg: 65, reps: 12 }, { kg: null, reps: 12 }, { kg: 65, reps: 0 }] },
    { exId: "c-abc", name: "Alte Rudermaschine", sets: [{ kg: 30, reps: 10 }] }] }],
  weights: [{ d: "2026-10-01", kg: 82.4 }],
  session: null, selDay: null
};
// Helle Fläche: alle Farbkanäle über 230 (Sheet im hellen Design, z. B. warmes Weiß)
const isLightBg = c => { const m = (String(c).match(/\d+/g) || []).map(Number); return m.length >= 3 && m[0] > 230 && m[1] > 230 && m[2] > 230; };
const PLAN_SMALL = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [
  { id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 0 },
  { id: "i2", exId: "hs-legpress", sets: 1, rmin: 8, rmax: 12, rest: 0 },
  { id: "i3", exId: "hs-fly", sets: 1, rmin: 8, rmax: 12, rest: 0 }] }] };
const hist = (exId, sets, daysAgo = 3, u) => ({ id: "h" + Math.random(), dayId: "d1", day: "Test",
  date: new Date(Date.now() - daysAgo * 864e5).toISOString(), durationSec: 1800,
  exercises: [Object.assign({ exId, name: exId, sets }, u ? { u } : {})] });

// ---------- Hilfen ----------
let browser;
// Vergleich unabhängig von der Reihenfolge der Felder
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x);
async function open(data, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: opts.light ? "light" : "dark",
    serviceWorkers: opts.sw ? "allow" : "block", ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}) });
  if (data !== undefined) {
    await ctx.addInitScript(([k, v, extra]) => {
      if (!sessionStorage.getItem("seeded")) {
        if (v !== null) localStorage.setItem(k, v);
        if (extra) for (const [ek, ev] of Object.entries(extra)) localStorage.setItem(ek, ev);
        sessionStorage.setItem("seeded", "1");
      }
    }, [KEY, data === null ? null : JSON.stringify(data), opts.extra || null]);
  }
  // Die meisten Prüfungen beziehen sich auf die 2D-Zeichnung; die 3D-Ansicht hat einen eigenen Abschnitt
  await ctx.addInitScript(v3 => { try { if (localStorage.getItem("tp-3d") === null) localStorage.setItem("tp-3d", v3 ? "1" : "0"); } catch (e) {} }, !!opts.v3);
  // Die Tests springen über die Tab-Leiste zur Startseite eines Bereichs; den iOS-Tab-Verlauf prüft Abschnitt „iOS-Navigation“ eigens
  await ctx.addInitScript(on => { try { if (localStorage.getItem("tp-tabmem") === null) localStorage.setItem("tp-tabmem", on ? "1" : "0"); } catch (e) {} }, !!opts.tabmem);
  // Erster Start: Die meisten Tests beginnen direkt bei den Fragen („Plan vorschlagen“); den Einstieg mit den zwei Wegen prüft der Abschnitt „Grundstruktur“ eigens
  await ctx.addInitScript(on => { try { if (localStorage.getItem("tp-intro") === null) localStorage.setItem("tp-intro", on ? "1" : "0"); } catch (e) {} }, !!opts.intro);
  const page = await ctx.newPage();
  page.on("pageerror", e => allErrors.push(e.message));
  // Netzwerkmeldungen für absichtlich simulierte Fehlantworten von Open Food Facts sind keine JavaScript-Fehler
  // Der Testserver hat keine Server-Funktion: /api/food antwortet mit 404, die App nimmt dann die alte Schnittstelle
  page.on("console", m => { if (m.type() === "error" && !(m.text().startsWith("Failed to load resource") && /openfoodfacts\.org|\/api\/food/.test(m.location().url || ""))) allErrors.push(m.text()); });
  await page.goto(URL);
  return { ctx, page };
}
const stored = page => page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
const tp = (page, fn, arg) => page.evaluate(fn, arg);
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
// Regel „Inhalt liegt auf Karten“: Text, der frei auf dem Seitengrund steht (außer Titel, Abschnittsüberschrift, Beitext .foot, Bedienelemente). Leere Liste = in Ordnung
const freeTextOn = page => page.evaluate(() => {
  const pg = document.querySelector("#app .page"); if (!pg) return ["(keine Seite)"];
  const bg = getComputedStyle(document.body).backgroundColor, clear = c => !c || c === "rgba(0, 0, 0, 0)" || c === "transparent" || c === bg;
  const onCard = el => { for (let e = el; e && e !== pg; e = e.parentElement) { const cs = getComputedStyle(e); if (!clear(cs.backgroundColor) || cs.backgroundImage !== "none") return true; } return false; };
  const exempt = el => el.closest(".head,.section-head,.foot,.cap,.label,button,a,label,summary,.exhero,.actionbar,h1,h2,h3");
  const out = [], seen = new Set(), w = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.textContent.trim().length < 2) continue; const el = n.parentElement; if (!el || !el.getClientRects().length) continue;
    if (exempt(el) || onCard(el)) continue; const blk = el.closest("p,li,div,section") || el; if (seen.has(blk)) continue; seen.add(blk);
    out.push(`${blk.tagName.toLowerCase()}${blk.id ? "#" + blk.id : ""}.${String(blk.className).split(" ")[0]} „${blk.textContent.trim().replace(/\s+/g, " ").slice(0, 40)}“`); }
  return out; });
// Welche Elemente ragen rechts hinaus? (für Fehlermeldungen)
const overflowers = page => page.evaluate(() => [...document.querySelectorAll("body *")].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + .5; })
  .slice(0, 5).map(e => `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}:${Math.round(e.getBoundingClientRect().right)} „${(e.textContent || "").trim().slice(0, 24)}“`).join(" | "));
async function finishAllSets(page, kg, reps) {
  for (let g = 0; g < 40 && await page.$("[data-a=doneSet]"); g++) {
    await page.fill("#kgIn", String(kg)); await page.fill("#repsIn", String(reps));
    await page.click("[data-a=doneSet]");
    if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
  }
}

(async () => {
  const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
  await sleep(900);
  try { browser = await chromium.launch({ args: ["--no-sandbox"] }); }
  catch (e) { browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }); }

  try {
    // ===== 1. Datenmigration =====
    section("1. Datenmigration und alte Daten");
    {
      const { ctx, page } = await open(OLD_V2);
      const s = await tp(page, () => window.__tp.state);
      ok("Verlauf bleibt vollständig (1 Training, 4 Geräte)", s.history.length === 1 && s.history[0].exercises.length === 4);
      ok("Satzwerte unverändert", JSON.stringify(s.history[0].exercises[0].sets) === JSON.stringify(OLD_V2.history[0].exercises[0].sets));
      ok("Einheit ergänzt: Brustpresse pro Seite (s)", s.history[0].exercises[0].u === "s");
      ok("Einheit ergänzt: Beinpresse insgesamt (t)", s.history[0].exercises[1].u === "t");
      ok("Einheit ergänzt: Butterfly Gewichtsblock (b)", s.history[0].exercises[2].u === "b");
      ok("Ungültige alte Sätze bleiben gespeichert (nicht gelöscht)", s.history[0].exercises[2].sets.length === 3);
      ok("Eigenes Gerät, Notiz, Körpergewicht, Plan erhalten",
        s.custom[0].name === "Alte Rudermaschine" && s.notes["hs-chest"] === "Sitz 4" && s.weights[0].kg === 82.4 && s.plan.days[0].items.length === 4);
      ok("Neue Felder mit Standardwerten (dev = {}, v = 7)", JSON.stringify(s.dev) === "{}" && s.v === 7);
      await page.click("[data-a=selDay]").catch(() => {}); // löst Speichern aus
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=home]");
      await page.evaluate(() => { window.__tp.state.selDay = "d1"; });
      await page.click("[data-a=start]"); await page.click("[data-a=askStop]"); await page.click("[data-a=askDiscard]"); await page.click("[data-a=stopDiscard]");
      const st = await stored(page);
      ok("Nach dem Speichern: Verlauf und Einheiten dauerhaft im Speicher", st.history.length === 1 && st.history[0].exercises[0].u === "s" && st.v === 7);
      await ctx.close();
    }
    {
      const v1 = { days: [{ name: "Drücken", exercises: [{ name: "Brustpresse", sets: 3, reps: 10, rest: 90 }, { name: "Mein Gerät", sets: 2, reps: 12, rest: 60 }] }] };
      const { ctx, page } = await open(null, { extra: { "trainingsplan-v1": JSON.stringify(v1) } });
      const s = await tp(page, () => window.__tp.state);
      ok("Version 1 wird übernommen (Bibliotheksgerät erkannt, eigenes Gerät angelegt)",
        s.plan && s.plan.days[0].items[0].exId === "hs-chest" && s.custom.some(c => c.name === "Mein Gerät"));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: "kaputt", history: "auch kaputt", dev: [1, 2], weights: [{ d: "x", kg: 5 }], session: { list: "nein" } });
      const s = await tp(page, () => window.__tp.state);
      ok("Beschädigte Daten führen nicht zum Absturz (sichere Standardwerte)", s.plan === null && Array.isArray(s.history) && s.history.length === 0 && s.session === null);
      ok("Einrichtung wird angezeigt", await page.isVisible("[data-a=createPlan]"));
      await ctx.close();
    }
    {
      // Sicherungscode im alten Format (ohne Einheiten) importieren
      const code = "TP1:" + Buffer.from(JSON.stringify(OLD_V2), "utf8").toString("base64");
      const { ctx, page } = await open(null);
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const st = await stored(page);
      ok("Alter Sicherungscode wird importiert (Verlauf, Einheiten ergänzt)", st.history.length === 1 && st.history[0].exercises[1].u === "t" && st.notes["hs-chest"] === "Sitz 4");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=importOpen]");
      await page.fill("#impTxt", "TP1:kaputt"); await page.click("[data-a=importDo]");
      ok("Ungültiger Code wird abgelehnt, Daten bleiben", (await page.textContent("#impMsg")).includes("ungültig") && (await stored(page)).history.length === 1);
      await ctx.close();
    }

    // ===== 2. Gewichtsdarstellung =====
    section("2. Gewichtsdarstellung pro Seite / insgesamt / Block");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const u = await tp(page, () => ["hs-chest", "hs-legpress", "hs-fly"].map(id => window.__tp.unitTxt(window.__tp.ex(id))));
      ok("Brustpresse: „kg pro Seite“", u[0] === "kg pro Seite");
      ok("Beinpresse: „kg insgesamt“", u[1] === "kg insgesamt");
      ok("Steckgewicht: „kg am Gewichtsblock“", u[2] === "kg am Gewichtsblock");
      await page.click("[data-a=start]");
      ok("Trainingsbildschirm zeigt Einheit unter dem Gewicht", (await page.textContent(".unit b")) === "kg pro Seite");
      // ===== 3. Volumen =====
      section("3. Trainingsabschluss mit korrektem Volumen");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Beinpresse zeigt „kg insgesamt“", (await page.textContent(".unit b")) === "kg insgesamt");
      await page.fill("#kgIn", "160"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Butterfly zeigt „kg am Gewichtsblock“", (await page.textContent(".unit b")) === "kg am Gewichtsblock");
      await page.fill("#kgIn", "65"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      const st = await stored(page);
      const vol = await tp(page, () => { const h = window.__tp.state.history.at(-1); return h.exercises.reduce((a, x) => a + x.sets.reduce((b, t) => b + window.__tp.setVol(x, t), 0), 0); });
      ok("Volumen = 40×10×2 Seiten×2 Sätze + 160×10 + 65×10 = 3850 kg", vol === 3850, "berechnet: " + vol);
      ok("Zusammenfassung zeigt 3,9 t", (await page.textContent("#app")).includes("3,9"));
      ok("Einheit wird mit dem Training gespeichert", st.history[0].exercises.map(x => x.u).join("") === "stb");
      ok("Zusammenfassung bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }

    // ===== 4. Individuelle Gewichtsschritte =====
    section("4. Individuelle Gewichtsschritte");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }])] });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]");
      await page.click("[data-a=devFilt][data-k=brust]"); await page.click("[data-a=editDev][data-id=hs-chest]");
      await page.click("[data-a=devSet][data-k=step][data-v='1.25']"); await page.click("[data-a=devSave]"); await page.click("[data-a=devsDone]");
      ok("Schritt dauerhaft gespeichert", (await stored(page)).dev["hs-chest"].step === 1.25);
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      ok("Progression nutzt eigenen Schritt (40 → 41,25 kg pro Seite)", (await page.inputValue("#kgIn")) === "41,25");
      await page.click("[data-a=adj][data-k=kg][data-d='1']");
      ok("Plus-Taste erhöht um 1,25 kg", (await page.inputValue("#kgIn")) === "42,5");
      await ctx.close();
    }

    // ===== 5. Nicht vorhandenes Gerät =====
    section("5. Nicht vorhandenes Gerät im Studio");
    {
      const { ctx, page } = await open(null);
      await page.click("[data-a=openDevs]"); await page.click("[data-a=devFilt][data-k=brust]");
      await page.click("[data-a=editDev][data-id=hs-chest]"); await page.click("[data-a=devSet][data-k=off][data-v=true]");
      await page.click("[data-a=devSave]"); await page.click("[data-a=devsDone]");
      await page.click("[data-a=createPlan]");
      const plan = (await stored(page)).plan;
      const all = plan.days.flatMap(d => d.items.map(i => i.exId));
      ok("Neuer Plan enthält das Gerät nicht", !all.includes("hs-chest"), all.join(","));
      ok("Kein Gerät doppelt an einem Tag", plan.days.every(d => new Set(d.items.map(i => i.exId)).size === d.items.length));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(OLD_V2);
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=devFilt][data-k=brust]");
      await page.click("[data-a=editDev][data-id=hs-chest]"); await page.click("[data-a=devSet][data-k=off][data-v=true]");
      await page.click("[data-a=devSave]"); await page.click("[data-a=devsDone]");
      const st = await stored(page);
      ok("Bestehender Plan bleibt unverändert", st.plan.days[0].items[0].exId === "hs-chest");
      ok("Historie bleibt unverändert", st.history[0].exercises[0].exId === "hs-chest" && st.history[0].exercises[0].sets.length === 3);
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay]"); await page.click("[data-a=openPicker]"); await page.click("#pickMuscle [data-k=brust]");
      const picks = await page.$$eval(".sheet [data-a=pick]", a => a.map(x => ({ id: x.dataset.id, on: x.getAttribute("aria-pressed") === "true", t: x.textContent })));
      const chest = picks.find(x => x.id === "hs-chest");
      ok("Geräteauswahl: nicht vorhandenes Gerät nur sichtbar, weil es schon im Tag ist (mit Hinweis)", !!chest && chest.on && chest.t.includes("nicht im Studio") && picks.length > 1 && picks.every(x => x.id === "hs-chest" || !x.t.includes("nicht im Studio")));      await ctx.close();
    }

    // ===== 6. Gerätetausch im laufenden Training =====
    section("6. Gerätetausch bei laufendem Training");
    {
      const plan = JSON.parse(JSON.stringify(PLAN_SMALL));
      const { ctx, page } = await open({ plan, dev: { "hs-decline": { off: true } } });
      await page.click("[data-a=start]"); await page.click(".actions3 [data-a=openSwap]");
      const alts = await page.$$eval(".sheet [data-a=swap]", a => a.map(x => x.dataset.id));
      ok("Tauschliste ohne nicht vorhandenes Gerät", !alts.includes("hs-decline") && alts.length > 0, alts.join(","));
      await page.click(".sheet [data-a=swap][data-id=hs-incline]");
      ok("Nur heute: Übung im Training getauscht", (await page.textContent("h1")).includes("Schräge Brustpresse"));
      ok("Nur heute: Plan unverändert", (await stored(page)).plan.days[0].items[0].exId === "hs-chest");
      await page.fill("#kgIn", "30"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Nach dem ersten Satz kein Tausch mehr möglich (Knopf ausgeblendet)", !(await page.$(".actions3 [data-a=openSwap]")));
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const st = await stored(page);
      ok("Gespeichertes Training enthält das neue Gerät", st.history[0].exercises[0].exId === "hs-incline");
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      await page.click(".actions3 [data-a=openSwap]"); await page.click("[data-a=swapMode][data-v='1']");
      await page.click(".sheet [data-a=swap][data-id=hs-widechest]");
      ok("Auch im Plan: Plan dauerhaft geändert", (await stored(page)).plan.days[0].items[0].exId === "hs-widechest");
      await ctx.close();
    }

    // ===== 7. Progression =====
    section("7. Progressionsregeln (makeEntry)");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const run = (sets, opts = {}) => tp(page, ([sets, opts]) => {
        const T = window.__tp;
        T.state.history = (opts.extra || []).concat([{ id: "x", dayId: "d1", day: "T", date: new Date().toISOString(), durationSec: 1,
          exercises: [{ exId: "hs-chest", name: "c", u: opts.u || "s", sets }] }]);
        T.state.dev = opts.dev || {};
        const e = T.makeEntry({ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 });
        return { mode: e.mode, why: e.why, kg: e.sets.map(s => s.kg), reps: e.sets.map(s => s.reps) };
      }, [sets, opts]);
      let r = await run([{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }, { kg: 40, reps: 12 }]);
      ok("Alle Wdh. erreicht → +1 Schritt (42,5)", r.mode === "up" && r.kg.every(k => k === 42.5), JSON.stringify(r));
      ok("Begründung mit Zahlen", /alle 3 Sätze mit 12 Wdh\. bei 40 kg pro Seite.*42,5 kg pro Seite \(\+2,5 kg\)/.test(r.why), r.why);
      r = await run([{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }, { kg: 40, reps: 12, f: "h" }]);
      ok("Alle Wdh., letzter Satz schwer → keine Steigerung", r.mode === "hold" && r.kg.every(k => k === 40), JSON.stringify(r));
      r = await run([{ kg: 40, reps: 10, f: "l" }, { kg: 40, reps: 10, f: "l" }, { kg: 40, reps: 9, f: "l" }]);
      ok("Alle Sätze leicht und ≥ Minimum → +1 Schritt", r.mode === "up" && r.kg[0] === 42.5);
      r = await run([{ kg: 40, reps: 10, f: "l" }, { kg: 40, reps: 10, f: "l" }, { kg: 40, reps: 9, f: "h" }]);
      ok("Leicht, aber letzter Satz schwer → keine Steigerung", r.mode === "hold");
      r = await run([{ kg: 40, reps: 6 }, { kg: 40, reps: 6 }, { kg: 40, reps: 5 }]);
      ok("Einmal alle unter Minimum → noch keine Reduktion", r.mode === "hold" && r.kg[0] === 40, JSON.stringify(r));
      r = await run([{ kg: 40, reps: 6 }, { kg: 40, reps: 6 }, { kg: 40, reps: 5 }], { extra: [hist("hs-chest", [{ kg: 40, reps: 7 }, { kg: 40, reps: 6 }, { kg: 40, reps: 6 }], 5, "s")] });
      ok("Zweimal in Folge unter Minimum → Reduktion (37,5)", r.mode === "down" && r.kg[0] === 37.5, JSON.stringify(r));
      r = await run([{ kg: 40, reps: 10 }, { kg: 40, reps: 9 }, { kg: 40, reps: 9 }]);
      ok("Sonst: Gewicht halten, +1 Wdh. als Ziel", r.mode === "keep" && r.kg.every(k => k === 40) && r.reps.join() === "11,10,10", JSON.stringify(r));
      r = await run([{ kg: null, reps: 12 }, { kg: 40, reps: 0 }], { extra: [hist("hs-chest", [{ kg: 35, reps: 12 }, { kg: 35, reps: 12 }, { kg: 35, reps: 12 }], 10, "s")] });
      ok("Ungültige Sätze werden ignoriert (frühere gültige Einheit zählt)", r.mode === "up" && r.kg[0] === 37.5, JSON.stringify(r));
      r = await run([{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], { dev: { "hs-chest": { load: "total" } } });
      ok("Andere Gewichtsangabe wird nicht verglichen", r.mode === "keep" && r.kg[0] === null && r.why.includes("Noch keine gültigen Werte"), JSON.stringify(r));
      r = await run([{ kg: 2.5, reps: 5 }, { kg: 2.5, reps: 5 }, { kg: 2.5, reps: 5 }], { extra: [hist("hs-chest", [{ kg: 2.5, reps: 5 }, { kg: 2.5, reps: 5 }, { kg: 2.5, reps: 5 }], 5, "s")] });
      ok("Reduktion nie unter 0 (kleinstes Gewicht bleibt)", r.mode === "hold" && r.kg[0] === 2.5, JSON.stringify(r));
      await ctx.close();
    }
    {
      // Progression im echten Ablauf: zweites Training
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=start]"); await finishAllSets(page, 40, 12);
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      const why2 = await page.getAttribute("#app .prog", "data-why");
      ok("Zweites Training: Steigerung mit Begründung sichtbar", why2.includes("Heute 42,5 kg pro Seite"), why2);
      ok("Zweites Training: Gewicht vorbelegt", (await page.inputValue("#kgIn")) === "42,5");
      await ctx.close();
    }

    // ===== 8. Fehlereingaben =====
    section("8. Fehlereingaben");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=start]");
      const tryDone = async (kg, reps) => { await page.fill("#kgIn", kg); await page.fill("#repsIn", reps); await page.click("[data-a=doneSet]");
        const done = (await stored(page)).session.list[0].sets[0].done; const err = await page.isVisible("#setErr") ? await page.textContent("#setErr") : ""; return { done, err }; };
      let r = await tryDone("", "10"); ok("Leeres Gewicht wird abgelehnt", !r.done && r.err.includes("Gewicht eintragen"), r.err);
      r = await tryDone("-5", "10"); ok("Negatives Gewicht wird abgelehnt", !r.done && r.err.includes("größer als 0"), r.err);
      r = await tryDone("0", "10"); ok("Gewicht 0 wird abgelehnt", !r.done && r.err.length > 0, r.err);
      r = await tryDone("40", "0"); ok("0 Wiederholungen werden abgelehnt", !r.done && r.err.includes("Wiederholungen"), r.err);
      r = await tryDone("40", "abc"); ok("Text als Wiederholungen wird abgelehnt", !r.done && r.err.includes("Wiederholungen"), r.err);
      r = await tryDone("40", "7,5"); ok("Kommazahl als Wiederholungen wird abgelehnt", !r.done && r.err.includes("Wiederholungen"), r.err);
      r = await tryDone("40", "101"); ok("Über 100 Wiederholungen werden abgelehnt", !r.done, r.err);
      r = await tryDone("2000", "10"); ok("Unrealistisches Gewicht wird abgelehnt", !r.done, r.err);
      r = await tryDone("42,5", "10"); ok("Gültige Eingabe mit Komma wird angenommen", r.done && (await stored(page)).session.list[0].sets[0].kg === 42.5);
      await page.click("[data-a=editSet]");
      for (let i = 0; i < 10; i++) await page.click("[data-a=setAdj][data-k=reps][data-d='-1']");
      await page.click("[data-a=setSave]");
      ok("Satz korrigieren auf 0 Wdh. wird abgelehnt", await page.isVisible("#setEditErr"));
      await page.click(".sheet [data-a=closeSheet]");
      await ctx.close();
    }

    // ===== 9. Sicherung und Wiederherstellung =====
    section("9. Sicherung und Wiederherstellung");
    {
      const data = JSON.parse(JSON.stringify(OLD_V2)); data.dev = { "hs-chest": { step: 1.25, sec: ["trizeps"] } };
      const { ctx, page } = await open(data);
      const before = await tp(page, () => JSON.parse(JSON.stringify(window.__tp.state)));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const after = await stored(page);
      for (const k of ["history", "dev", "notes", "weights", "custom", "plan"])
        ok(`Wiederhergestellt: ${k}`, JSON.stringify(after[k]) === JSON.stringify(before[k]));
      await ctx.close();
    }

    // ===== 10. Neustart während eines Trainings =====
    section("10. Neustart während eines Trainings");
    {
      const p = JSON.parse(JSON.stringify(PLAN_SMALL)); p.days[0].items[0].rest = 90;
      const { ctx, page } = await open({ plan: p });
      await page.click("[data-a=start]"); await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.reload();
      ok("Nach Neustart weiter im Training (Pause läuft)", await page.isVisible("#timer"));
      ok("Erledigter Satz bleibt erhalten", (await stored(page)).session.list[0].sets[0].done === true);
      await page.click("[data-a=skipRest]"); await page.click("[data-a=askStop]"); await page.click("[data-a=pauseT]");
      await page.reload();
      ok("Pausiertes Training nach Neustart auf der Startseite", await page.isVisible("[data-a=resumeT]"));
      await page.click("[data-a=resumeT]");
      ok("Fortsetzen öffnet den nächsten Satz", await page.isVisible("#kgIn") && (await page.textContent(".label")).includes("Übung"));
      await ctx.close();
    }

    // ===== 11. 360 px =====
    section("11. Darstellung bei 360 px (hell und dunkel)");
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }], 2, "s")], weights: [{ d: "2026-10-01", kg: 80 }, { d: "2026-11-01", kg: 79 }] }, { light });
      const views = [];
      views.push(["Heute", await noOverflow(page)]);
      await page.click("[data-a=tab][data-v=plan]"); views.push(["Training", await noOverflow(page)]);
      await page.click("[data-a=openSettings]"); views.push(["Einstellungen", await noOverflow(page)]);
      await page.click("[data-a=openDevs]"); views.push(["Geräte", await noOverflow(page)]);
      await page.click("[data-a=editDev] >> nth=0"); views.push(["Gerät bearbeiten", await noOverflow(page)]); await page.click("[data-a=devCancel]"); await page.click("[data-a=devsDone]");
      await page.click("[data-a=tab][data-v=plan]");
      await page.click("[data-a=editDay]"); views.push(["Tag", await noOverflow(page)]);
      await page.click("[data-a=tab][data-v=history]"); views.push(["Verlauf", await noOverflow(page)]);
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]"); views.push(["Training", await noOverflow(page)]);
      const p2 = await page.$("[data-a=doneSet]"); await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await p2.click();
      views.push(["Übung 2", await noOverflow(page)]);
      const bad = views.filter(v => !v[1]).map(v => v[0]);
      ok(`${light ? "Hell" : "Dunkel"}: kein seitliches Scrollen in ${views.length} Ansichten`, !bad.length, bad.join(", "));
      await ctx.close();
    }

    // ===== 12. Offline-Neustart =====
    section("12. Offline-Neustart (Service Worker)");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL }, { sw: true });
      await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await sleep(300);
      ok("Service Worker aktiv (Cache trainingsplan-v100)", await page.evaluate(async () => !!navigator.serviceWorker.controller && (await caches.keys()).includes("trainingsplan-v100")));
      await ctx.setOffline(true); await page.reload();
      ok("App startet offline mit gespeicherten Daten", await page.isVisible("[data-a=start]"));
      await ctx.close();
    }
    {
      // Start sofort aus dem Speicher; neue Version im Hintergrund → Hinweis auf „Heute“, nie im Training
      const sw = require("fs").readFileSync(require("path").join(__dirname, "..", "sw.js"), "utf8");
      ok("Service Worker: App-Seite sofort aus dem Speicher, kein Warten auf das Netz", sw.includes("staleWhileRevalidate") && !/setTimeout/.test(sw) && sw.includes('postMessage({ type: "update" })'));
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const upd = () => page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "update" } })));
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      await upd();
      ok("Neue Version während des Trainings: kein Hinweis, Training läuft weiter", !(await page.$("#updNote")) && await page.isVisible("#kgIn"));
      await page.click("[data-a=askStop]"); await page.click(".sheet [data-a=pauseT]").catch(() => {});
      await page.evaluate(() => { document.querySelector("#sheet-root").innerHTML = ""; });
      await page.click("[data-a=tab][data-v=home]");
      ok("Danach auf „Heute“: „Neue Version der App geladen“ mit „Neu laden“", (await page.textContent("#updNote")).includes("Neue Version") && !!(await page.$("#updNote [data-a=reloadApp]")) && !(await page.$("#updNote .btn.primary")));
      await Promise.all([page.waitForNavigation(), page.click("#updNote [data-a=reloadApp]")]);
      ok("„Neu laden“ lädt die App neu", !(await page.$("#updNote")));
      await ctx.close();
    }

    section("13. Frühere Einträge umstellen");
    {
      const { ctx, page } = await open(OLD_V2);
      ok("Hinweis „Gewicht pro Seite“ auf der Startseite", await page.isVisible("[data-a=hintUnitsOpen]"));
      await page.click("[data-a=hintUnitsOpen]");
      ok("Hinweis führt zu den Geräten und verschwindet danach", await page.isVisible(".sheet [data-a=devFilt]") && (await stored(page)).hints.units === true);
      await page.click("[data-a=devFilt][data-k=brust]"); await page.click("[data-a=editDev][data-id=hs-chest]");
      await page.click("[data-a=devSet][data-k=load][data-v=total]");
      ok("Formular zeigt Anzahl abweichender Einträge", (await page.textContent(".sheet")).includes("1 früherer Eintrag"));
      await page.click("[data-a=devRelabelAsk]"); await page.click("[data-a=devRelabel]");
      let st = await stored(page);
      ok("Einträge umgestellt, Zahlen unverändert", st.history[0].exercises[0].u === "t" && st.history[0].exercises[0].sets[0].kg === 40);
      ok("Gerät mit neuer Angabe gespeichert", st.dev["hs-chest"].load === "total");
      ok("Andere Geräte unverändert", st.history[0].exercises[1].u === "t" && st.history[0].exercises[2].u === "b");
      await page.click("[data-a=devCancel]"); await page.click("[data-a=devsDone]");
      await page.evaluate(() => { window.__tp.state.selDay = "d1"; }); await page.click("[data-a=start]");
      const why = await page.getAttribute("#app .prog", "data-why");
      ok("Progression nutzt die umgestellten Einträge (insgesamt)", why.includes("kg insgesamt") && (await page.inputValue("#kgIn")) === "45", why);
      await page.reload();
      ok("Hinweis bleibt nach Neustart ausgeblendet", !(await page.isVisible("[data-a=hintUnitsOpen]")));
      await ctx.close();
    }

    section("14. Lieblingsgeräte");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=devFilt][data-k=brust]");
      await page.click("[data-a=editDev][data-id=hs-widechest]"); await page.click("[data-a=devSet][data-k=fav][data-v=true]"); await page.click("[data-a=devSave]");
      let st = await stored(page);
      ok("Bevorzugt wird gespeichert", st.dev["hs-widechest"].fav === true && !st.dev["hs-widechest"].off);
      ok("Liste zeigt „Bevorzugt“ deutlich", (await page.textContent(".sheet [data-id=hs-widechest] .badge.fav")) === "Bevorzugt");
      await page.click("[data-a=devFilt][data-k=fav]");
      ok("Filter „Bevorzugt“ zeigt nur bevorzugte Geräte", (await page.$$eval(".sheet [data-a=editDev]", a => a.map(x => x.dataset.id))).join() === "hs-widechest");
      await page.click("[data-a=editDev][data-id=hs-widechest]"); await page.click("[data-a=devSet][data-k=off][data-v=true]"); await page.click("[data-a=devSave]");
      st = await stored(page);
      ok("„Bevorzugt“ und „im Studio“ unabhängig gespeichert", st.dev["hs-widechest"].fav === true && st.dev["hs-widechest"].off === true);
      await page.reload();
      const e = await tp(page, () => window.__tp.ex("hs-widechest"));
      ok("Nach Neustart wiederhergestellt", e.fav === true && e.off === true);
      ok("Bestehender Plan nicht automatisch geändert", (await stored(page)).plan.days[0].items[0].exId === "hs-chest");
      // Bevorzugt, aber nicht verfügbar: weder Tausch noch Plan
      await page.click("[data-a=start]"); await page.click(".actions3 [data-a=openSwap]");
      ok("Bevorzugtes, nicht vorhandenes Gerät nicht im Tausch", !(await page.$$eval(".sheet [data-a=swap]", a => a.map(x => x.dataset.id))).includes("hs-widechest"));
      const plan = await tp(page, () => window.__tp.generatePlan("aufbau", 3, "einsteiger", 90));
      ok("Bevorzugtes, nicht vorhandenes Gerät nicht im neuen Plan", !plan.days.some(d => d.items.some(i => i.exId === "hs-widechest")));
      await ctx.close();
    }

    section("15. Bewegungsmuster und Alternativen");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, dev: { "hs-decline": { fav: true } } });
      const rank = id => tp(page, id => { const r = window.__tp.rankAlternatives(id, new Set([id]));
        return { direct: r.direct.map(a => a.e.id), other: r.other.map(a => a.e.id), why: Object.fromEntries(r.direct.concat(r.other).map(a => [a.e.id, a.why])) }; }, id);
      const pats = await tp(page, () => window.__tp.allEx().filter(e => !e.id.startsWith("c-")).map(e => [e.id, e.pattern]));
      ok("Alle 60 Bibliotheksgeräte haben ein Bewegungsmuster", pats.length === 60 && pats.every(p => p[1]), pats.filter(p => !p[1]).join());
      let r = await rank("hs-chest");
      ok("Brustpresse: direkte Alternativen nur horizontales Drücken", r.direct.length > 0 && r.direct.every(id => ["hs-decline", "hs-widechest"].includes(id)), r.direct.join());
      ok("Bevorzugtes passendes Gerät steht oben", r.direct[0] === "hs-decline");
      ok("Incline Press = andere Übung mit anderem Schwerpunkt", r.other.includes("hs-incline") && r.why["hs-incline"].includes("anderer Belastungsschwerpunkt"), r.why["hs-incline"]);
      ok("Butterfly als ungeeignete direkte Alternative gekennzeichnet", r.other.includes("hs-fly") && r.why["hs-fly"].includes("Keine direkte Alternative"));
      ok("Erklärung behauptet keine Gleichheit", !Object.values(r.why).some(w => /identisch|gleichwertig|gleiche Belastung/i.test(w)));
      r = await rank("hs-lateral");
      ok("Schulterpresse ist kein direkter Ersatz für Seitheben", !r.direct.includes("hs-shoulder") && r.direct.length === 0);
      ok("Schulterpresse nur als andere Übung gekennzeichnet", r.other.includes("hs-shoulder") && r.why["hs-shoulder"].includes("Keine direkte Alternative"));
      r = await rank("hs-hack");
      ok("Hackenschmidt: Leg Extension ist keine direkte Alternative", !r.direct.includes("hs-legext") && r.other.includes("hs-legext"));
      ok("Hackenschmidt: direkte Alternativen sind kniebeugedominant", ["hs-legpress", "hs-isolegpress", "hs-vsquat"].every(id => r.direct.includes(id)));
      r = await rank("hs-legext");
      ok("Leg Extension hat keine direkte Alternative im Studio", r.direct.length === 0);
      // UI: kein direkter Ersatz für Seitheben
      await page.evaluate(() => { const T = window.__tp; T.state.plan.days[0].items[0].exId = "hs-lateral"; });
      await page.click("[data-a=start]"); await page.click(".actions3 [data-a=openSwap]");
      ok("Tausch-Fenster nennt fehlende direkte Alternative", await page.isVisible("#swapNoDirect"));
      ok("Tausch-Fenster bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }
    {
      // Eigenes Gerät mit Bewegungsmuster wird direkte Alternative
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=newDev]");
      await page.fill("#devName", "Brustpresse Halle 2"); await page.selectOption("#devPattern", "push_h"); await page.click("[data-a=devSave]");
      const st = await stored(page); const c = st.custom.find(x => x.name === "Brustpresse Halle 2");
      ok("Eigenes Gerät speichert Bewegungsmuster", c && c.pattern === "push_h");
      const direct = await tp(page, () => window.__tp.rankAlternatives("hs-chest", new Set(["hs-chest"])).direct.map(a => a.e.name));
      ok("Eigenes Gerät erscheint als direkte Alternative", direct.includes("Brustpresse Halle 2"));
      await ctx.close();
    }

    section("16. Gerätetausch und Gewichte");
    {
      const data = { plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 50, reps: 10 }, { kg: 50, reps: 10 }], 4, "s"), hist("hs-decline", [{ kg: 30, reps: 10 }, { kg: 30, reps: 9 }], 6, "s")] };
      const { ctx, page } = await open(data);
      await page.click("[data-a=start]");
      ok("Ausgangsgerät mit eigenem Gewicht (50)", (await page.inputValue("#kgIn")) === "50");
      await page.click(".actions3 [data-a=openSwap]");
      ok("Bekanntes Gerät zeigt eigenes letztes Gewicht", (await page.textContent(".sheet [data-id=hs-decline]")).includes("Zuletzt 30 kg pro Seite"));
      await page.click(".sheet [data-a=swap][data-id=hs-decline]");
      ok("Tausch zu bekanntem Gerät nutzt dessen Werte (30, nicht 50)", (await page.inputValue("#kgIn")) === "30");
      await page.click(".actions3 [data-a=openSwap]");
      ok("Nie genutztes Gerät: Hinweis Einstiegsgewicht", (await page.textContent(".sheet [data-id=hs-widechest]")).includes("Einstiegsgewicht"));
      await page.click(".sheet [data-a=swap][data-id=hs-widechest]");
      const why = await page.getAttribute("#app .prog", "data-why");
      ok("Nie genutztes Gerät: kein übertragenes Gewicht", (await page.inputValue("#kgIn")) === "" && why.includes("kontrollierbaren Einstiegsgewicht") && !why.includes("50"), why);
      await page.fill("#kgIn", "20"); await page.fill("#repsIn", "12"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const p = await tp(page, () => ({ wide: window.__tp.lastPerf("hs-widechest"), chest: window.__tp.lastPerf("hs-chest") }));
      ok("Neues Gerät hat eigene Werte, Ausgangsgerät unverändert", p.wide[0].kg === 20 && p.chest[0].kg === 50);
      await ctx.close();
    }

    section("17. Trainingsplanung mit Lieblingsgeräten");
    {
      const { ctx, page } = await open(null);
      const gen = (dev, days = 3) => tp(page, ([dev, days]) => { const T = window.__tp; T.state.dev = dev; return T.generatePlan("aufbau", days, "einsteiger", 90); }, [dev, days]);
      let plan = await gen({ "hs-widechest": { fav: true }, "hs-lat": { fav: true } });
      const push = plan.days[0].items.map(i => i.exId), pull = plan.days[1].items.map(i => i.exId);
      ok("Bevorzugtes Gerät ersetzt Vorlage gleicher Bewegung (Wide Chest statt Chest Press)", push.includes("hs-widechest") && !push.includes("hs-chest"), push.join());
      ok("Bevorzugter Latzug statt Front Latzug", pull.includes("hs-lat") && !pull.includes("hs-pulldown"), pull.join());
      const base = await gen({});
      const patList = async pl => tp(page, pl => pl.days.map(d => d.items.map(i => window.__tp.ex(i.exId).pattern).sort().join()), pl);
      ok("Mischung der Bewegungsmuster bleibt gleich", JSON.stringify(await patList(plan)) === JSON.stringify(await patList(base)));
      let dup = true;
      for (const days of [2, 3, 4]) for (const dev of [{}, { "hs-widechest": { fav: true }, "hs-chest": { off: true } }, { "hs-decline": { fav: true }, "hs-widechest": { fav: true } }, { "hs-vsquat": { fav: true }, "hs-legpress": { off: true } }]) {
        const pl = await gen(dev, days); if (!pl.days.every(d => new Set(d.items.map(i => i.exId)).size === d.items.length)) dup = false;
      }
      ok("Keine doppelten Geräte in 12 Plan-Varianten", dup);
      plan = await gen({ "hs-lateral": { off: true } });
      const pushL = plan.days[0].items.map(i => i.exId);
      ok("Fehlendes Seitheben wird nicht durch Schulterpresse doppelt ersetzt", !pushL.includes("hs-lateral") && pushL.filter(id => id === "hs-shoulder").length === 1);
      ok("Lücke wird gemeldet", plan.gaps.length === 1 && plan.gaps[0].name === "Seitheben");
      await page.evaluate(() => { window.__tp.state.dev = { "hs-lateral": { off: true } }; });
      await page.click("[data-a=createPlan]");
      ok("Hinweis nach dem Erstellen sichtbar", (await page.textContent(".sheet")).includes("Seitheben"));
      await page.click(".sheet [data-a=closeSheet]"); await page.click("[data-a=tab][data-v=plan]");
      ok("Hinweis bleibt im Plan sichtbar", await page.isVisible("#gapCard"));
      await page.click("[data-a=gapsDone]");
      ok("Hinweis lässt sich ausblenden", !(await page.isVisible("#gapCard")) && (await stored(page)).plan.gaps.length === 0);
      await ctx.close();
    }

    section("18. Kompatibilität (alte Daten, laufendes Training, Sicherung)");
    {
      const old = JSON.parse(JSON.stringify(OLD_V2)); old.v = 3; old.dev = { "hs-chest": { step: 1.25, load: "side" } }; old.hints = { units: true };
      old.session = { dayId: "d1", dayName: "Drücken", start: Date.now() - 600000, idx: 0, phase: "set", restEnd: 0, restTotal: 0,
        list: [{ key: "k1", itemId: "i1", exId: "hs-chest", u: "s", rmin: 8, rmax: 12, rest: 90, mode: "keep", why: "x", sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: false }] }] };
      const { ctx, page } = await open(old);
      const s = await tp(page, () => window.__tp.state);
      ok("Alte Geräteanpassung bleibt (Schritt 1,25), bevorzugt = nein", s.dev["hs-chest"].step === 1.25 && !s.dev["hs-chest"].fav);
      ok("Laufendes Training aus alter Version wird fortgesetzt", await page.isVisible("#kgIn") && s.session.list[0].sets[0].done === true);
      ok("Historie und Einheiten unverändert", s.history[0].exercises.map(x => x.u).join() === "s,t,b,t");
      await page.click("[data-a=askStop]"); await page.click("[data-a=pauseT]");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=devFilt][data-k=bizeps]");
      await page.click("[data-a=editDev][data-id=hs-curl]"); await page.click("[data-a=devSet][data-k=fav][data-v=true]"); await page.click("[data-a=devSave]"); await page.click("[data-a=devsDone]");
      await page.evaluate(() => { const T = window.__tp; T.state.custom.push({ id: "c-x", name: "Kabelzug", muscle: "trizeps", sec: [], type: "stack", pattern: "tri" }); T.state.plan.gaps = [{ day: "Drücken", name: "Seitheben", pattern: "lateral" }]; });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const st = await stored(page);
      ok("Sicherung: bevorzugtes Gerät", st.dev["hs-curl"].fav === true);
      ok("Sicherung: Bewegungsmuster eigener Geräte", st.custom.find(c => c.id === "c-x").pattern === "tri");
      ok("Sicherung: Planhinweise", st.plan.gaps.length === 1 && st.plan.gaps[0].pattern === "lateral");
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, dev: { "hs-decline": { fav: true } } }, { light });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]");
      const a = await noOverflow(page);
      await page.click("[data-a=editDev][data-id=hs-decline]"); const b = await noOverflow(page); await page.click("[data-a=devCancel]"); await page.click("[data-a=devsDone]");
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]"); await page.click(".actions3 [data-a=openSwap]"); const c = await noOverflow(page);
      ok(`${light ? "Hell" : "Dunkel"}: Geräteliste, Gerät, Tausch bei 360 px ohne seitliches Scrollen`, a && b && c);
      await ctx.close();
    }

    section("19. Oberfläche (Redesign)");
    for (const [w, h] of [[360, 740], [390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: "block" });
      await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } },
        [KEY, JSON.stringify({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 3, "s")] })]);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message));
      await page.goto(URL);
      const startBox = await page.locator("[data-a=start]").boundingBox();
      ok(`${w} px: „Training starten“ ohne Scrollen sichtbar`, startBox && startBox.y + startBox.height <= h);
      await page.click("[data-a=start]");
      const box = await page.locator("[data-a=doneSet]").boundingBox();
      ok(`${w} px: „Satz fertig“ fest im Daumenbereich`, box && box.y + box.height <= h && box.y > h * 0.75, JSON.stringify(box));
      ok(`${w} px: Tab-Leiste im Training ausgeblendet`, await page.isHidden("#tabs"));
      const sizes = await page.$$eval("[data-a=adj], [data-a=doneSet], [data-a=askStop], [data-a=openJump]", els => els.map(e => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); }));
      ok(`${w} px: Tap-Flächen im Training mindestens 44 px`, sizes.length >= 6 && sizes.every(s => s >= 44), sizes.join(","));
      const kgSize = await page.$eval("#kgIn", e => parseFloat(getComputedStyle(e).fontSize));
      ok(`${w} px: Gewicht in großer Schrift (≥ 56 px)`, kgSize >= 56, String(kgSize));
      await page.click("#app .prog");
      ok(`${w} px: Kurze Begründung öffnet die volle Erklärung`, (await page.textContent(".sheet")).includes("Heute 42,5 kg pro Seite"));
      await page.click(".sheet [data-a=closeSheet]");
      ok(`${w} px: Training ohne seitliches Scrollen`, await noOverflow(page));
      await ctx.close();
    }
    {
      const p2 = JSON.parse(JSON.stringify(PLAN_SMALL)); p2.days.push({ id: "d2", name: "Zweiter Tag", items: [{ id: "x1", exId: "hs-row", sets: 2, rmin: 8, rmax: 12, rest: 60 }] });
      const { ctx, page } = await open({ plan: p2, history: [hist("hs-legpress", [{ kg: 100, reps: 10 }, { kg: 100, reps: 10 }], 0.5, "t")] }, { light: true });   // 2 Sätze: ab da gilt der Muskel als belastet
      await page.click("[data-a=pickDay]");
      const bg = await page.$eval(".sheet", e => getComputedStyle(e).backgroundColor);
      ok("Hellmodus: Bottom-Sheet ist hell", isLightBg(bg), bg);
      await page.click(".sheet [data-a=selDay][data-id=d2]");
      ok("„Anderes Training wählen“ übernimmt den Tag", (await page.textContent(".hero-name")) === "Zweiter Tag");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=showRec]");
      ok("Erholungsdetails erst auf Tipp (Sheet mit Muskeln)", (await page.textContent(".sheet")).includes("Erholung") && await page.isVisible(".sheet .fig"));
      await page.click(".sheet [data-a=closeSheet]");
      await page.click("[data-a=tab][data-v=history]");
      ok("Verlauf: Häufigkeit und Bestwerte zuerst, Details eingeklappt", await page.isVisible(".kpi") && !(await page.isVisible("#discMuscle .body")));
      await page.click("#discMuscle summary");
      ok("Verlauf: Muskelbelastung aufklappbar", await page.isVisible("#discMuscle .mlist"));
      await ctx.close();
    }

    section("20. Intelligente Trainingsdauer");
    const PLAN60 = { goal: "aufbau", level: "fortgeschritten", minutes: 60, days: [{ id: "d1", name: "Oberkörper A", items: [
      ["hs-chest", 4, 90], ["hs-row", 4, 90], ["hs-shoulder", 3, 90], ["hs-pulldown", 3, 90], ["hs-curl", 3, 60], ["hs-dip", 3, 60]].map(([e, n, r], i) => ({ id: "i" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: r })) }] };
    const doSets = async (page, n, kg = "40", reps = "10") => { for (let i = 0; i < n; i++) { await page.fill("#kgIn", kg); await page.fill("#repsIn", reps); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]"); } };
    const liveSet = async (page, m) => { await page.click("[data-a=openJump]"); await page.click("[data-a=openTimeLive]"); await page.click(`[data-a=liveTimePick][data-m="${m}"]`); };
    {
      // 13. Dauerberechnung
      const { ctx, page } = await open({ plan: PLAN60 });
      const r = await tp(page, () => { const T = window.__tp; const it = { sets: 3, rmin: 8, rmax: 12, rest: 90 };
        return { one: T.estimateSec([it], { warm: false }), two: T.estimateSec([it, it], { warm: false }), warm: T.estimateSec([it]), TIME: T.TIME }; });
      ok("Dauer: 3 Sätze = 3 × 50 s + 2 Pausen (keine Pause nach dem letzten Satz)", r.one === 330, String(r.one));
      ok("Dauer: Gerätewechsel statt Satzpause zwischen Übungen", r.two === 330 * 2 + r.TIME.change, String(r.two));
      ok("Dauer: Aufwärmen vor dem ersten Satz eingerechnet", r.warm === 330 + r.TIME.warm);
      ok("Anzeige gerundet auf 5 Minuten", await tp(page, () => window.__tp.estMinutes(window.__tp.state.plan.days[0]) % 5 === 0));
      // 1.–3. Vor dem Start auf 30 Minuten
      const planBefore = canon(await tp(page, () => window.__tp.state.plan)); // geladener (normalisierter) Plan
      const pv = await tp(page, () => { const T = window.__tp, d = T.state.plan.days[0], r = T.previewDay(d, 30); return { fits: r.fits, est: r.estSec, ex: r.exCount, sets: r.setCount, lost: r.lost, kept: r.kept, full: r.fullMin, dropped: r.dropped.map(x => x.exId) }; });
      ok("1. 60-Minuten-Tag auf 30 Minuten verkürzt (passt, ≤ 30 Min.)", pv.fits && pv.est <= 1800 && pv.full >= 45, JSON.stringify(pv));
      ok("1. Weniger Übungen und Sätze als vorher (berechnet)", pv.ex < 6 && pv.sets < 20 && pv.sets >= 6);
      ok("2. Alle Muskelgruppen bleiben vertreten", pv.lost.length === 0 && ["brust", "ruecken", "schultern"].every(m => pv.kept.includes(m)), JSON.stringify(pv));
      ok("2. Grundübungen bleiben (Brustpresse, Rudern, Schulterpresse)", !pv.dropped.some(id => ["hs-chest", "hs-row", "hs-shoulder"].includes(id)), pv.dropped.join());
      await page.click("[data-a=openTime]"); await page.click("[data-a=timePick][data-m='30']");
      const txt = await page.textContent("#timePrev");
      ok("1. Vorschau nennt „x statt 6 Übungen“ und „y statt 20 Arbeitssätze“", txt.includes(`${pv.ex} statt 6 Übungen`) && txt.includes(`${pv.sets} statt 20 Arbeitssätze`), txt.slice(0, 160));
      await page.click("[data-a=timeApply]");
      ok("1. Startseite zeigt angepasste Einheit", (await page.textContent(".hero")).includes("Für heute auf 30 Min. angepasst"));
      ok("3. Dauerhafter Plan unverändert", canon((await stored(page)).plan) === planBefore);
      await page.click("[data-a=start]");
      let s = (await stored(page)).session;
      ok("1. Training startet mit angepasster Einheit", s.list.length === pv.ex && s.list.reduce((a, l) => a + l.sets.length, 0) === pv.sets && s.timeAdj.minutes === 30);
      ok("3. Plan auch nach dem Start unverändert, Anpassung verbraucht", canon((await stored(page)).plan) === planBefore && (await stored(page)).timeplan === null);
      await page.click("[data-a=askStop]"); await page.click("[data-a=askDiscard]"); await page.click("[data-a=stopDiscard]");
      // Originaltraining verwirft die Anpassung
      await page.click("[data-a=openTime]"); await page.click("[data-a=timePick][data-m='30']"); await page.click("[data-a=timeApply]");
      await page.click("[data-a=openTime]"); await page.click("[data-a=timePick][data-m='0']"); await page.click("[data-a=timeApply]");
      ok("„Originaltraining“ verwirft die Anpassung", (await stored(page)).timeplan === null && !(await page.textContent(".hero")).includes("angepasst"));
      ok("Zeit-Sheets ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }
    {
      // Schwerpunkt: Seitheben bleibt an einem Schultertag
      const { ctx, page } = await open({ plan: PLAN60 });
      const r = await tp(page, () => { const T = window.__tp;
        const d = { id: "s", name: "Schulter", items: [["hs-shoulder", 3], ["hs-lateral", 4], ["hs-reardelt", 3], ["hs-incline", 3], ["hs-triext", 3], ["hs-curl", 3]].map(([e, n], i) => ({ id: "s" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: 90 })) };
        const p = T.previewDay(d, 30); return { focus: p.focus, lat: p.keep.s1, fits: p.fits }; });
      ok("Schwerpunkt Schulter: Seitheben wird nicht pauschal gestrichen", r.fits && r.focus === "schultern" && r.lat >= 2, JSON.stringify(r));
      await ctx.close();
    }
    {
      // 4. Fehlende Geräte
      const { ctx, page } = await open({ plan: PLAN60, dev: { "hs-chest": { off: true }, "hs-curl": { off: true } } });
      const pv = await tp(page, () => { const r = window.__tp.previewDay(window.__tp.state.plan.days[0], 30); return { rep: r.replace, un: r.unavailable.map(i => i.exId), fits: r.fits }; });
      ok("4. Fehlendes Gerät durch gleiche Bewegung ersetzt", ["hs-decline", "hs-widechest"].includes(pv.rep.i0), JSON.stringify(pv));
      ok("4. Gerät ohne passenden Ersatz wird ausgelassen und genannt", pv.un.includes("hs-curl") && pv.fits);
      await page.click("[data-a=openTime]"); await page.click("[data-a=timePick][data-m='30']");
      ok("4. Vorschau nennt Ersatz und Auslassung", (await page.textContent("#timePrev")).includes("Ersetzt") && (await page.textContent("#timePrev")).includes("Armbeuger"));
      await page.click("[data-a=timeApply]"); await page.click("[data-a=start]");
      const st = await stored(page);
      ok("4. Training nutzt Ersatzgerät, Plan bleibt beim Original", st.session.list[0].exId === pv.rep.i0 && st.plan.days[0].items[0].exId === "hs-chest" && !st.session.list.some(l => l.exId === "hs-curl"));
      await ctx.close();
    }
    {
      // 5.–8., 12. Während des Trainings
      const { ctx, page } = await open({ plan: PLAN60 });
      await page.click("[data-a=start]"); await doSets(page, 2, "42,5", "11");
      let before = (await stored(page)).session;
      await liveSet(page, 15);
      ok("5. Vorschau zeigt, was entfällt, und dass erledigte Sätze bleiben", (await page.textContent(".sheet")).includes("Entfällt") && (await page.textContent(".sheet")).includes("2 erledigte Sätze bleiben gespeichert"));
      await page.click("[data-a=liveTimeApply]");
      let s = (await stored(page)).session;
      const doneSets = ss => ss.list.flatMap(l => l.sets.filter(t => t.done).map(t => l.key + ":" + t.kg + "x" + t.reps));
      ok("5. Auf 15 Minuten Restzeit verkürzt", s.timeAdj.minutes === 15 && await tp(page, () => window.__tp.remainingSec(window.__tp.state.session) <= 900 + 1));
      ok("6. Erledigte Sätze vollständig erhalten (Werte unverändert)", JSON.stringify(doneSets(s)) === JSON.stringify(doneSets(before)) && doneSets(s).length === 2);
      ok("7. Aktuelle Übung bleibt erhalten und aktiv", s.list[s.idx].key === before.list[0].key && s.list[s.idx].sets.some(t => !t.done));
      // 8. Mehrfach anpassen und Original wiederherstellen
      await liveSet(page, 30); await page.click("[data-a=liveTimeApply]");
      await liveSet(page, 10).catch(() => {}); await page.click(".sheet [data-a=closeSheet]");
      await liveSet(page, 0); await page.click("[data-a=liveTimeApply]");
      s = (await stored(page)).session;
      ok("8. Mehrfach angepasst, Original wiederhergestellt: 6 Übungen, 20 Sätze", s.list.length === 6 && s.list.reduce((a, l) => a + l.sets.length, 0) === 20 && (s.timeHidden || []).length === 0, `${s.list.length}/${s.list.reduce((a, l) => a + l.sets.length, 0)}`);
      ok("8. Keine doppelten erledigten Sätze nach Verlängern", doneSets(s).length === 2);
      ok("8. Zurückgeholte Übungen wieder an ursprünglicher Position", s.list.map(l => l.exId).join() === PLAN60.days[0].items.map(i => i.exId).join(), s.list.map(l => l.exId).join());
      // Manuell beendete Übung kehrt nicht zurück
      const dipIdx = s.list.findIndex(l => l.exId === "hs-dip");
      await page.click("[data-a=openJump]"); await page.click(`[data-a=jump][data-i2='${dipIdx}']`); await page.click("[data-a=openJump]"); await page.click("[data-a=endEx]");
      await liveSet(page, 15); await page.click("[data-a=liveTimeApply]");
      await liveSet(page, 0); await page.click("[data-a=liveTimeApply]");
      s = (await stored(page)).session;
      ok("8. Manuell beendete Übung kommt nicht ungefragt zurück", !s.list.concat(s.timeHidden || []).some(l => l.exId === "hs-dip"));
      // 12. Verkürzen und abschließen
      await liveSet(page, 15); await page.click("[data-a=liveTimeApply]");
      s = (await stored(page)).session;
      const kept = s.list.map(l => l.exId), hidden = (s.timeHidden || []).map(l => l.exId);
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const h = (await stored(page)).history.at(-1);
      ok("12. Nur absolvierte Übungen in der Historie", h.exercises.length === 1 && h.exercises[0].exId === "hs-chest" && h.exercises[0].sets.length === 2, JSON.stringify(h.exercises.map(x => x.exId)));
      ok("12. Ausgelassene Übungen nicht gespeichert", hidden.length > 0 && !h.exercises.some(x => hidden.includes(x.exId)));
      ok("Zusammenfassung zeigt „zeitlich angepasst“ und echte Werte", (await page.textContent("#app")).includes("zeitlich angepasst") && h.adj === 15);
      ok("Progression nutzt nur absolvierte Sätze", await tp(page, () => window.__tp.lastPerf("hs-row") === null && window.__tp.lastPerf("hs-chest").length === 2));
      await ctx.close();
    }
    {
      // 9.–11. Gerätetausch vor der Zeitänderung, Pause und Neustart
      const { ctx, page } = await open({ plan: PLAN60 });
      await page.click("[data-a=start]"); await page.click(".actions3 [data-a=openSwap]"); await page.click(".sheet [data-a=swap][data-id=hs-decline]");
      await doSets(page, 1);
      await liveSet(page, 20); await page.click("[data-a=liveTimeApply]");
      let s = (await stored(page)).session;
      ok("9. Getauschtes Gerät bleibt nach der Zeitänderung", s.list[0].exId === "hs-decline" && !s.list.concat(s.timeHidden).some(l => l.exId === "hs-chest") && s.list[0].sets[0].done);
      await page.click("[data-a=askStop]"); await page.click("[data-a=pauseT]");
      await sleep(1500); await page.reload();
      ok("10. Nach Pause und Neustart: Anpassung gespeichert", await page.isVisible("[data-a=resumeT]") && (await stored(page)).session.timeAdj.minutes === 20);
      await page.click("[data-a=resumeT]");
      s = (await stored(page)).session;
      const rem = await tp(page, () => { const T = window.__tp, s = T.state.session; const open = s.list.filter(l => l.sets.some(t => !t.done));
        const est = open.reduce((a, l, i) => { const n = l.sets.filter(t => !t.done).length; return a + n * (T.TIME.setBase + T.TIME.perRep * (l.rmin + l.rmax) / 2) + (n - 1) * l.rest + (i ? T.TIME.change : 0); }, 0);
        return { rem: T.remainingSec(s), est, elapsed: (Date.now() - s.start) / 1000 }; });
      ok("11. Restzeit nach dem Fortsetzen korrekt (ohne Pausendauer)", Math.abs(rem.rem - rem.est) < 1 && rem.rem <= 1200, JSON.stringify(rem));
      ok("11. Trainingsuhr zählt die Pausenzeit nicht mit", rem.elapsed < 60);
      await ctx.close();
    }
    {
      // 14. Keine realistische 10-Minuten-Einheit
      const strength = { goal: "kraft", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Kraft", items: [
        ["hs-chest", 3], ["hs-row", 3], ["hs-legpress", 3], ["hs-shoulder", 3]].map(([e, n], i) => ({ id: "i" + i, exId: e, sets: n, rmin: 4, rmax: 6, rest: 180 })) }] };
      const { ctx, page } = await open({ plan: strength });
      await page.click("[data-a=start]"); await page.fill("#kgIn", "60"); await page.fill("#repsIn", "5"); await page.click("[data-a=doneSet]");
      await liveSet(page, 10);
      ok("14. Ehrlicher Hinweis bei unrealistischer Zeit", await page.isVisible("#timeNoFit") && (await page.textContent("#timeNoFit")).includes("keine sinnvolle Resteinheit"));
      ok("14. Übernehmen gesperrt, realistische Alternative angeboten", await page.isDisabled("[data-a=liveTimeApply]") && (await page.$$("#timeNoFit [data-a=liveTimePick]")).length === 1);
      const restBefore = (await stored(page)).session.list.map(l => l.rest).join();
      await page.click("#timeNoFit [data-a=liveTimePick]");
      ok("14. Alternative passt und Pausen bleiben unverändert (180 s)", !(await page.isVisible("#timeNoFit")) && restBefore === "180,180,180,180");
      await ctx.close();
    }
    {
      // 15./16. Alte Daten und Sicherung
      const oldSession = { plan: PLAN60, v: 4, session: { dayId: "d1", dayName: "Oberkörper A", start: Date.now() - 300000, idx: 0, phase: "set",
        list: [{ key: "k1", itemId: "i0", exId: "hs-chest", u: "s", rmin: 8, rmax: 12, rest: 90, sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: false }] },
               { key: "k2", itemId: "i1", exId: "hs-row", u: "s", rmin: 8, rmax: 12, rest: 90, sets: [{ kg: 40, reps: 10, done: false }] }] } };
      const { ctx, page } = await open(oldSession);
      let s = (await stored(page)) || (await tp(page, () => window.__tp.state));
      const st = await tp(page, () => window.__tp.state);
      ok("15. Training aus Datenversion 4 lädt (ohne Zeitfelder)", st.session.list.length === 2 && Array.isArray(st.session.timeHidden) && st.session.timeAdj === null && st.timeplan === null);
      await liveSet(page, 10); await page.click("[data-a=liveTimeApply]").catch(() => {});
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      await page.click("[data-a=tab][data-v=home]");
      await page.click("[data-a=openTime]"); await page.click("[data-a=timePick][data-m='30']"); await page.click("[data-a=timeApply]");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      const before = await stored(page);
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const after = await stored(page);
      ok("16. Sicherung: Verlauf inkl. Zeitanpassung wiederhergestellt", canon(after.history) === canon(before.history) && after.history.at(-1).adj > 0, canon(after.history).slice(0, 200) + " | " + canon(before.history).slice(0, 200));
      ok("16. Sicherung: Anpassung für heute wiederhergestellt", JSON.stringify(after.timeplan) === JSON.stringify(before.timeplan) && after.timeplan.minutes === 30);
      await ctx.close();
    }
    for (const [w, light] of [[360, false], [360, true], [390, false], [390, true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, colorScheme: light ? "light" : "dark", serviceWorkers: "block" });
      await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan: PLAN60 })]);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message)); await page.goto(URL);
      const a = await noOverflow(page);
      await page.click("[data-a=openTime]"); await page.click("[data-a=timePick][data-m='30']"); const b = await noOverflow(page);
      const bg = await page.$eval(".sheet", e => getComputedStyle(e).backgroundColor);
      await page.click(".sheet [data-a=closeSheet]"); await page.click("[data-a=start]"); await liveSet(page, 15); const c = await noOverflow(page);
      ok(`17. ${w} px ${light ? "hell" : "dunkel"}: Heute, Zeit-Vorschau, Zeit im Training ohne seitliches Scrollen`, a && b && c);
      ok(`17. ${w} px ${light ? "hell" : "dunkel"}: Sheet in passender Farbe`, light ? isLightBg(bg) : !isLightBg(bg), bg);
      await ctx.close();
    }

    section("21. Progression 2.0");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      // run(sessions, item, dev): sessions = [{sets, planned?, rmin?, rmax?, daysAgo?, u?}] alt → neu
      const run = (sessions, item = {}, dev = {}) => tp(page, ([sessions, item, dev]) => {
        const T = window.__tp;
        T.state.dev = dev;
        T.state.history = sessions.map((s, i) => ({ id: "h" + i, dayId: "d1", day: "T", date: new Date(Date.now() - (s.daysAgo ?? (sessions.length - i) * 3) * 864e5).toISOString(), durationSec: 1,
          exercises: [Object.assign({ exId: "hs-chest", name: "c", u: s.u || "s", sets: s.sets }, s.planned ? { planned: s.planned } : {}, s.rmin ? { rmin: s.rmin, rmax: s.rmax } : {})] }));
        const e = T.makeEntry(Object.assign({ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, item));
        return { mode: e.mode, why: e.why, short: e.short, kg: e.sets.map(s => s.kg), reps: e.sets.map(s => s.reps) };
      }, [sessions, item, dev]);
      const S3 = (kg, reps, extra = {}) => reps.map((r, i) => Object.assign({ kg: Array.isArray(kg) ? kg[i] : kg, reps: r }, typeof extra === "function" ? extra(i) : extra));
      let r = await run([{ sets: S3(40, [12, 12, 12]), planned: 3, rmin: 8, rmax: 12 }]);
      ok("1. Drei vollständige Sätze am oberen Ziel → +1 Schritt", r.mode === "up" && r.kg.every(k => k === 42.5) && /alle 3 Sätze mit 12 Wdh\. bei 40 kg pro Seite\. Heute 42,5 kg pro Seite/.test(r.why), JSON.stringify(r));
      r = await run([{ sets: S3(40, [12, 12, 12], i => i === 2 ? { f: "h" } : {}), planned: 3 }]);
      ok("2. Letzter Satz schwer → Gewicht halten, mit Begründung", r.mode === "hold" && r.kg.every(k => k === 40) && r.why.includes("als schwer bewertet"), r.why);
      r = await run([{ sets: S3(40, [12, 12]), planned: 4 }], { sets: 4 });
      ok("3. 2 von 4 Sätzen mit 12 Wdh. → keine Steigerung", r.mode === "hold" && r.kg.every(k => k === 40) && r.why.includes("nur 2 von 4 Sätzen"), r.why);
      r = await run([{ sets: S3(40, [12, 12, 12, 12]), planned: 4 }, { sets: S3(40, [12, 12]), planned: 4 }], { sets: 4 });
      ok("3. Unvollständig, aber davor vollständig am Ziel → +1 Schritt", r.mode === "up" && r.kg[0] === 42.5 && r.why.includes("davor alle 4 Sätze"), r.why);
      r = await run([{ sets: S3(40, [12, 12]) }], { sets: 4 });
      ok("3. Ältere Einträge ohne Planung: weniger Sätze als heute geplant → halten", r.mode === "hold" && r.kg[0] === 40);
      r = await run([{ sets: S3([40, 45, 40], [12, 10, 9]), planned: 3 }]);
      ok("4. Unterschiedliche Gewichte → satzweise übernommen, keine pauschale Steigerung", r.mode === "hold" && JSON.stringify(r.kg) === "[40,45,40]" && !r.kg.includes(47.5) && r.why.includes("unterschiedliche Gewichte"), JSON.stringify(r));
      ok("4. Ziel je 1 Wdh. mehr pro Satz (gedeckelt am oberen Ziel)", JSON.stringify(r.reps) === "[12,11,10]", JSON.stringify(r.reps));
      r = await run([{ sets: S3(40, [12, 12, 12], i => i === 2 ? { rir: 0 } : {}), planned: 3 }]);
      ok("5. RIR 0 bei vollständiger Wiederholungszahl → Gewicht halten", r.mode === "hold" && r.kg[0] === 40 && r.why.includes("ohne Reserve"), r.why);
      r = await run([{ sets: S3(40, [12, 12, 12], { rir: 3 }), planned: 3 }]);
      ok("6. RIR 3 bei vollständiger Wiederholungszahl → +1 Schritt", r.mode === "up" && r.kg[0] === 42.5);
      r = await run([{ sets: S3(40, [10, 10, 9], { rir: 3 }), planned: 3 }]);
      ok("6. RIR ≥ 3 in allen Sätzen, Wdh. im Bereich → +1 Schritt mit Begründung", r.mode === "up" && r.why.includes("Reserve"), r.why);
      r = await run([{ sets: S3(40, [12, 12, 12]), planned: 3 }]);
      ok("7. Ohne RIR-Angabe: normale Regeln (fehlend ≠ RIR 0)", r.mode === "up");
      r = await run([{ sets: S3(40, [6, 6, 5], i => i === 2 ? { rir: 0 } : {}), planned: 3 }]);
      ok("Einzelner RIR-0-Satz unter Ziel führt nicht allein zur Reduktion", r.mode === "hold" && r.kg[0] === 40, r.why);
      r = await run([{ sets: S3(40, [7, 6, 6]), planned: 3 }, { sets: S3(40, [6, 6, 5], i => i === 2 ? { rir: 0 } : {}), planned: 3 }]);
      ok("Wiederholte Überforderung (zweimal unter Ziel) → Reduktion", r.mode === "down" && r.kg[0] === 37.5, r.why);
      r = await run([{ sets: S3(40, [12, 12, 12]), planned: 3, rmin: 8, rmax: 12 }], { rmin: 4, rmax: 6 });
      ok("Geänderter Wiederholungsbereich → Gewicht halten", r.mode === "hold" && r.kg[0] === 40 && r.why.includes("Wiederholungsbereich geändert"), r.why);
      r = await run([{ sets: S3(40, [12, 12, 12]), planned: 3 }], { sets: 4 });
      ok("Heute mehr Sätze geplant als zuletzt → halten", r.mode === "hold" && r.why.includes("4 statt 3 Sätze"), r.why);
      r = await run([{ sets: S3(40, [12, 12, 12]), planned: 3 }], {}, { "hs-chest": { load: "total" } });
      ok("10. Andere Gewichtsangabe (insgesamt statt pro Seite) wird nicht verglichen", r.mode === "keep" && r.kg[0] === null);
      r = await run([{ sets: S3(40, [8, 8, 8]), planned: 3 }, { sets: S3(40, [9, 9, 8]), planned: 3 }, { sets: S3(40, [10, 9, 9]), planned: 3 }]);
      ok("13. Wiederholungsfortschritt ohne Gewichtssteigerung: halten, Ziel +1 Wdh.", r.mode === "keep" && r.kg[0] === 40 && JSON.stringify(r.reps) === "[11,10,10]", JSON.stringify(r));
      // 12. Stillstand
      const pl = sessions => tp(page, sessions => { const T = window.__tp;
        T.state.history = sessions.map((s, i) => ({ id: "p" + i, dayId: "d1", day: "T", date: new Date(Date.now() - s.d * 864e5).toISOString(), durationSec: 1, adj: s.adj,
          exercises: [{ exId: "hs-chest", name: "c", u: "s", planned: s.planned || 3, sets: s.sets }] }));
        return T.plateau("hs-chest"); }, sessions);
      const flat = [28, 21, 14, 7, 1].map(d => ({ d, sets: S3(40, [10, 10, 10]) }));
      let p = await pl(flat);
      ok("12. Mehrere Wochen ohne Fortschritt erkannt (Wochen, Anzahl)", p && p.weeks >= 3 && p.n === 5, JSON.stringify(p));
      p = await pl([10, 7, 4, 1].map(d => ({ d, sets: S3(40, [10, 10, 10]) })));
      ok("12. Kein Stillstand bei zu kurzem Zeitraum (< 3 Wochen)", p === null);
      p = await pl([28, 14, 1].map(d => ({ d, sets: S3(40, [10, 10, 10]) })));
      ok("12. Kein Stillstand bei zu wenigen Einheiten", p === null);
      p = await pl([28, 21, 14, 7, 1].map((d, i) => ({ d, sets: S3(40, [8 + i, 8 + i, 8 + i]) })));
      ok("13. Wiederholungsfortschritt zählt als Fortschritt", p === null);
      p = await pl([28, 21, 14, 7, 1].map((d, i) => ({ d, sets: i % 2 ? S3(40, [10, 10]) : S3(40, [10, 10, 10]) })));
      ok("12. Unvollständige Einheiten zählen nicht für den Stillstand", p === null);
      p = await pl([28, 21, 14, 7, 1].map((d, i) => ({ d, sets: S3(40, [10, 10, 10], i === 4 ? { rir: 3 } : {}) })));
      ok("12. Mit Reserve trainiert: Hinweis „näher ans Limit“ statt Gerätewechsel", p && p.reserve === true);
      await ctx.close();
    }
    {
      // 12. Stillstand in der Oberfläche
      const S3 = (kg, reps) => reps.map(r => ({ kg, reps: r }));
      const histP = [28, 21, 14, 7, 1].map((d, i) => ({ id: "q" + i, dayId: "d1", day: "Test", date: new Date(Date.now() - d * 864e5).toISOString(), durationSec: 1,
        exercises: [{ exId: "hs-chest", name: "c", u: "s", planned: 2, sets: S3(40, [10, 10]) }] }));
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: histP });
      await page.click("[data-a=start]");
      ok("12. Training zeigt Stillstandshinweis mit Zeitraum und Optionen", (await page.textContent("#plateauHint")).includes("Wochen kein Fortschritt") && (await page.getAttribute("#plateauHint [data-a=showWhy]", "data-why")).includes("Möglich"));
      await page.click("[data-a=askStop]"); await page.click("[data-a=askDiscard]"); await page.click("[data-a=stopDiscard]");
      await page.click("[data-a=tab][data-v=history]"); await page.click("[data-a=showEx] >> nth=0");
      ok("1RM als Näherung gekennzeichnet", (await page.textContent(".sheet")).includes("1RM geschätzt") && (await page.textContent(".sheet")).includes("Näherung"));
      await ctx.close();
    }
    {
      // 8. Manuelle Änderung, RIR im Ablauf, 15. Neustart, 9. Tausch
      const p4 = JSON.parse(JSON.stringify(PLAN_SMALL)); p4.days[0].items[0].rest = 90; p4.days[0].items[0].sets = 3;
      const { ctx, page } = await open({ plan: p4, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 3, "s")] });
      await page.click("[data-a=start]");
      ok("8. Empfehlung vorbelegt (42,5)", (await page.inputValue("#kgIn")) === "42,5");
      await page.click("[data-a=adj][data-k=kg][data-d='-1']");
      ok("8. Manuelle Änderung hat Vorrang und wird gekennzeichnet", (await page.inputValue("#kgIn")) === "40" && (await page.textContent("#app .prog")).includes("Eigenes Gewicht"));
      await page.fill("#repsIn", "12"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=openRir]"); await page.click("[data-a=setRir][data-v='2']");
      ok("RIR-Angabe in der Pause gespeichert (am Satz)", (await stored(page)).session.list[0].sets[0].rir === 2 && (await page.textContent(".feel-q")).includes("Reserve 2"));
      ok("Leicht/Passt/Schwer bleibt unabhängig (keine Umrechnung)", (await stored(page)).session.list[0].sets[0].f === undefined);
      await page.reload();
      ok("15. Neustart: RIR, Sätze und Empfehlungsgrund bleiben erhalten", (await stored(page)).session.list[0].sets[0].rir === 2 && (await stored(page)).session.list[0].short.includes("+2,5"));
      await page.click("[data-a=skipRest]");
      await page.click("[data-a=editSet]"); await page.click("[data-a=editRir][data-v='']"); await page.click("[data-a=setSave]");
      ok("RIR lässt sich wieder auf „nicht bewertet“ setzen", (await stored(page)).session.list[0].sets[0].rir === undefined);
      await page.click("[data-a=editSet]"); await page.click("[data-a=editRir][data-v='0']"); await page.click("[data-a=setSave]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "12"); await page.click("[data-a=doneSet]"); await page.click("[data-a=skipRest]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "12"); await page.click("[data-a=doneSet]"); await page.click("[data-a=skipRest]");
      // 9. Tausch der nächsten Übung behält die geplante Satzanzahl
      await page.click(".actions3 [data-a=openSwap]"); await page.click(".sheet [data-a=swap] >> nth=0");
      const sw = (await stored(page)).session.list[1];
      ok("9. Gerätetausch: geplante Satzanzahl bleibt, eigene Werte des neuen Geräts", sw.planned === 1 && sw.exId !== "hs-legpress");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const h = (await stored(page)).history.at(-1).exercises[0];
      ok("Historie speichert Planung, Bereich und RIR satzweise", h.planned === 3 && h.rmin === 8 && h.rmax === 12 && h.sets[0].rir === 0 && h.sets[1].rir === undefined && h.sets.every(s => s.kg === 40));
      const next = await tp(page, () => window.__tp.makeEntry(window.__tp.state.plan.days[0].items[0]));
      ok("8. Nächste Empfehlung basiert auf tatsächlich gewähltem Gewicht (40 → 42,5)", next.mode === "up" && next.sets[0].kg === 42.5, next.why);
      await ctx.close();
    }
    {
      // 11. Unvollständig nach Zeitanpassung
      const p4 = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [
        { id: "i1", exId: "hs-chest", sets: 4, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-row", sets: 4, rmin: 8, rmax: 12, rest: 90 },
        { id: "i3", exId: "hs-shoulder", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "i4", exId: "hs-curl", sets: 3, rmin: 8, rmax: 12, rest: 60 }] }] };
      const { ctx, page } = await open({ plan: p4, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }, { kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 4, "s")] });
      await page.click("[data-a=start]");
      for (let i = 0; i < 2; i++) { await page.fill("#kgIn", "40"); await page.fill("#repsIn", "12"); await page.click("[data-a=doneSet]"); await page.click("[data-a=skipRest]"); }
      await page.click("[data-a=openJump]"); await page.click("[data-a=openTimeLive]"); await page.click("[data-a=liveTimePick][data-m='10']");
      if (await page.isVisible("#timeNoFit")) await page.click("#timeNoFit [data-a=liveTimePick]");
      await page.click("[data-a=liveTimeApply]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const h = (await stored(page)).history.at(-1).exercises.find(x => x.exId === "hs-chest");
      ok("11. Zeitlich gekürzte Einheit: 2 von 4 Sätzen gespeichert", h.planned === 4 && h.sets.length === 2);
      const next = await tp(page, () => window.__tp.makeEntry(window.__tp.state.plan.days[0].items[0]));
      ok("11. Danach keine Steigerung trotz 12 Wdh. (nur 2 von 4 Sätzen)", next.mode === "hold" && next.sets[0].kg === 40 && next.why.includes("nur 2 von 4"), next.why);
      await ctx.close();
    }
    {
      // 14. Alte Daten ohne RIR, 16. Export/Import mit neuen Feldern
      const { ctx, page } = await open(OLD_V2);
      const s = await tp(page, () => window.__tp.state);
      ok("14. Alte Daten: keine erfundenen RIR-Werte", s.history.every(h => h.exercises.every(x => x.sets.every(t => t.rir === undefined))));
      ok("14. Alte Daten: keine erfundene Planung", s.history[0].exercises.every(x => x.planned === undefined && x.rmin === undefined));
      await page.evaluate(() => { const T = window.__tp; T.state.history.push({ id: "n1", dayId: "d1", day: "Drücken", date: new Date().toISOString(), durationSec: 600,
        exercises: [{ exId: "hs-chest", name: "Brustpresse", u: "s", planned: 4, rmin: 8, rmax: 12, sets: [{ kg: 40, reps: 12, rir: 2 }, { kg: 40, reps: 11, f: "h", rir: 0 }] }] }); });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      const before = await tp(page, () => JSON.parse(JSON.stringify(window.__tp.state.history)));
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const after = (await stored(page)).history;
      ok("16. Export/Import: RIR, Planung, Bereich und Bewertung erhalten", canon(after) === canon(before) && after.at(-1).exercises[0].sets[1].rir === 0 && after.at(-1).exercises[0].planned === 4);
      await ctx.close();
    }
    for (const [w, light] of [[360, false], [360, true], [390, false], [390, true]]) {
      // 18. Darstellung der RIR-Eingabe
      const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, colorScheme: light ? "light" : "dark", serviceWorkers: "block" });
      const p2 = JSON.parse(JSON.stringify(PLAN_SMALL)); p2.days[0].items[0].rest = 90;
      await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan: p2 })]);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message)); await page.goto(URL);
      await page.click("[data-a=start]"); await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      const a = await noOverflow(page);
      await page.click("[data-a=openRir]"); const b = await noOverflow(page);
      const bg = await page.$eval(".sheet", e => getComputedStyle(e).backgroundColor);
      ok(`18. ${w} px ${light ? "hell" : "dunkel"}: Pause mit RIR und RIR-Sheet ohne seitliches Scrollen, passende Farben`, a && b && (light ? isLightBg(bg) : !isLightBg(bg)), bg);
      await ctx.close();
    }

    section("22. Übungswissen und Trainingswissen");
    {
      const now = Date.now(), H = (d, kg, reps) => ({ id: "w" + d, dayId: "d1", day: "Test", date: new Date(now - d * 864e5).toISOString(), durationSec: 1,
        exercises: [{ exId: "hs-chest", name: "c", u: "s", planned: 3, rmin: 8, rmax: 12, sets: reps.map(r => ({ kg, reps: r })) }] });
      const data = { plan: PLAN_SMALL, history: [H(40, 32.5, [12, 11, 10]), H(20, 37.5, [12, 11, 11]), H(3, 42.5, [10, 9, 9])],
        custom: [{ id: "c-k", name: "Kabelzug", muscle: "trizeps", sec: [], type: "stack", pattern: "tri" }] };
      const { ctx, page } = await open(data);
      const chk = await tp(page, () => { const T = window.__tp, ids = T.allEx().filter(e => !e.id.startsWith("c-")).map(e => e.id);
        const bad = []; const nonEmpty = s => typeof s === "string" && s.trim().length > 20;
        ids.forEach(id => { const g = T.GUIDE[id]; if (!g) { bad.push(id + ": fehlt"); return; }
          if (!g.main.length || !nonEmpty(g.why) || g.setup.length < 2 || g.steps.length < 3 || !nonEmpty(g.breath) || g.mistakes.length < 3 || !g.safety.length || g.tips.length < 2) bad.push(id + ": unvollständig");
          if (g.mistakes.some(m => !m[0] || !m[1])) bad.push(id + ": Fehler ohne Korrektur");
          (g.src || []).forEach(k => { if (!T.SOURCES[k]) bad.push(id + ": Quelle " + k); }); });
        T.ARTICLES.forEach(a => { if (!a.src.length) bad.push(a.id + ": ohne Quelle"); a.src.forEach(k => { if (!T.SOURCES[k]) bad.push(a.id + ": Quelle " + k); }); });
        Object.entries(T.SOURCES).forEach(([k, s]) => { if (!s.t || !s.j || !/^https:\/\//.test(s.url)) bad.push("Quelle " + k + " unvollständig"); });
        const txt = JSON.stringify([T.GUIDE, T.ARTICLES]);
        if (/TODO|lorem|xxx/i.test(txt)) bad.push("Platzhalter");
        return { n: ids.length, bad, arts: T.ARTICLES.length }; });
      ok("Alle 60 Geräte ausführlich beschrieben (Muskeln, Nutzen, Einstellung, ≥ 3 Ausführungsschritte, Atmung, ≥ 3 Fehler mit Korrektur, Sicherheit, ≥ 2 Tipps)", chk.n === 60 && !chk.bad.length, chk.bad.join("; "));
      ok("Jede zitierte Quelle existiert und ist vollständig verlinkt", !chk.bad.some(b => /Quelle/.test(b)));
      ok(`${chk.arts} Wissensartikel, jeder mit Quelle`, chk.arts >= 8);
      // Bibliothek
      await page.click("[data-a=tab][data-v=lib]");
      ok("Bibliothek listet alle Geräte inkl. eigener", (await page.$$("#libList [data-a=openEx]")).length === 61);
      await page.fill("#libQ", "Brust");
      const brust = await tp(page, () => window.__tp.allEx().filter(e => e.name.toLowerCase().includes("brust") || e.muscle === "brust").length);
      ok("Suche filtert (Name oder Muskel)", (await page.$$("#libList [data-a=openEx]")).length === brust && brust >= 5);
      await page.fill("#libQ", "");
      ok("Bibliothek bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=openEx][data-id=hs-seatcurl]");
      const seat = await page.textContent("#app");
      ok("Übungsseite zeigt alle Abschnitte", ["Warum diese Übung", "Einstellen", "Ausführung", "Häufige Fehler", "Sicherheit", "Hauptsächlich", "Tricks für dieses Gerät"].every(s => seat.includes(s)));
      ok("Studienaussage mit Quelle verlinkt (Beinbeuger sitzend)", (await page.$$eval("#app .srcs a", a => a.map(x => x.href))).some(h => h.includes("33009197")));
      ok("Ohne eigene Einträge: ehrlicher Hinweis statt erfundener Werte", (await page.textContent("#exStats")).includes("Noch keine Einträge"));
      ok("Allgemeine Sicherheit (Steckstift, Schmerz als Stoppsignal) nicht auf jeder Geräteseite, sondern über „Für alle Übungen“", !seat.includes("Stoppsignal") && !seat.includes("Steckstift vollständig") && !!(await page.$("[data-a=genTricks]")));
      ok("Nicht im Plan: ehrlicher Hinweis", (await page.textContent("#exPlan")).includes("In keinem Trainingstag"));
      await page.click("[data-a=exBack]");
      ok("Zurück führt zur Bibliothek", await page.isVisible("#libQ"));
      await page.click("[data-a=openEx][data-id=hs-chest]");
      const st = await page.textContent("#exStats");
      ok("Deine Werte aus echten Daten: 3 Einheiten, Bestwert 42,5, +10 kg seit Beginn", st.includes("3") && st.includes("42,5") && st.includes("+10") && st.includes("32,5"), st.slice(0, 200));
      ok("Übungsseite bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      const chestTxt = await page.textContent("#app");
      ok("Scheibengerät: keine allgemeinen Scheiben- oder Steckstift-Hinweise auf der Geräteseite", !chestTxt.includes("Scheiben vor dem ersten Satz") && !chestTxt.includes("Steckstift"));
      ok("„In deinem Plan“ zeigt Tag, Sätze und Wiederholungen aus dem Plan", (await page.textContent("#exPlan")).includes("Test: 2 × 8–12 Wdh."));
      const alts = await page.$$eval("#exAlt [data-a=openEx]", b => b.map(x => x.dataset.id));
      const exp = await tp(page, () => { const r = window.__tp.rankAlternatives("hs-chest", new Set()); return [...r.direct.slice(0, 4), ...r.other.slice(0, 3)].map(a => a.e.id); });
      ok("Alternativen: gleiche Auswahl wie beim Gerätetausch, direkte zuerst", alts.length > 0 && JSON.stringify(alts) === JSON.stringify(exp), alts.join());
      await page.click(`#exAlt [data-a=openEx][data-id=${alts[0]}]`);
      ok("Alternative öffnet ihre Übungsseite", (await page.textContent(".head .title")) === await tp(page, id => window.__tp.ex(id).name, alts[0]));
      await page.click("[data-a=exBack]");
      ok("Zurück führt weiter zur Bibliothek", await page.isVisible("#libQ"));
      await page.click("[data-a=openEx][data-id=c-k]");
      ok("Eigenes Gerät: Hinweis statt erfundener Anleitung", (await page.textContent("#app")).includes("keine ausführliche Anleitung"));
      // Wissen
      await page.click("[data-a=tab][data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]");
      ok("Trainingswissen listet alle Artikel", (await page.$$("[data-a=openArt]")).length === chk.arts);
      await page.click("[data-a=openArt][data-id=pause]");
      ok("Artikel zeigt Text und verlinkte Quelle", (await page.textContent("#app")).includes("3 Minuten") && (await page.$$eval(".srcs a", a => a.map(x => x.href))).some(h => h.includes("26605807")));
      ok("Artikel bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=artBack]");
      ok("Zurück führt zur Artikelliste", (await page.$$("[data-a=openArt]")).length === chk.arts);
      // Wissen: „So entscheidet die App“
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      ok("Wissen: „So entscheidet die App“ öffnet Hinweise und Regeln", (await page.textContent("#coachRules")).includes("So entscheidet die App") && await page.$eval("#tabs [data-v=lib]", b => b.classList.contains("on")));
      await page.click("[data-a=coachBack]");
      ok("Zurück führt zu den Artikeln", await page.isVisible("#wissenCoach"));
      // Übungsauswahl
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay]"); await page.click("[data-a=openPicker]");
      await page.click(".sheet [data-a=openGuideSheet][data-id=hs-row]");
      ok("Info in der Übungsauswahl öffnet die Anleitung", (await page.textContent(".sheet")).includes("Ausführung") && (await page.textContent(".sheet")).includes("Rudern"));
      await page.click(".sheet [data-a=guideBack]");
      ok("Zurück führt zur Übungsauswahl", await page.isVisible("#pickQ"));
      await page.click(".sheet [data-a=pick][data-id=hs-lowrow]");
      ok("Antippen nimmt das Gerät in den Tag auf (Häkchen)", (await page.getAttribute(".sheet [data-a=pick][data-id=hs-lowrow]", "aria-pressed")) === "true" && (await stored(page)).plan.days[0].items.some(i => i.exId === "hs-lowrow"));
      await page.click(".sheet [data-a=pick][data-id=hs-lowrow]");
      ok("Erneutes Antippen nimmt es wieder heraus", (await page.getAttribute(".sheet [data-a=pick][data-id=hs-lowrow]", "aria-pressed")) === "false" && !(await stored(page)).plan.days[0].items.some(i => i.exId === "hs-lowrow"));
      await page.click(".sheet [data-a=pick][data-id=hs-lowrow]");
      await page.keyboard.press("Escape");
      // Übung im Plan
      await page.click("[data-a=editItem] >> nth=0"); await page.click(".sheet [data-a=openGuideSheet]");
      ok("Übung im Plan: Anleitung erreichbar", (await page.textContent(".sheet")).includes("Häufige Fehler"));
      await page.click(".sheet [data-a=guideBack]");
      ok("Zurück führt zur Übung", await page.isVisible("[data-a=saveItem]"));
      await page.keyboard.press("Escape");
      // Training
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      await page.click(".actions3 [data-a=openDevInfo]"); await page.click(".sheet [data-a=openGuideSheet]");
      ok("Training: ausführliche Anleitung im Bottom-Sheet", (await page.textContent(".sheet")).includes("Warum diese Übung"));
      await page.click(".sheet [data-a=guideBack]");
      ok("Zurück führt zu „Gerät & Technik“", await page.isVisible("#noteT"));
      await page.keyboard.press("Escape");
      await page.click("[data-a=askStop]"); await page.click("[data-a=askDiscard]"); await page.click("[data-a=stopDiscard]");
      // Verlauf
      await page.click("[data-a=tab][data-v=history]"); await page.click("[data-a=showEx] >> nth=0");
      await page.click(".sheet [data-a=openEx]");
      ok("Verlauf: Gerätekurve führt zur Übungsseite", await page.isVisible("#exStats"));
      await page.click("[data-a=exBack]");
      ok("Zurück führt zum Verlauf", (await page.textContent("#app")).includes("Häufigkeit"));
      await ctx.close();
    }
    for (const [w, light] of [[360, false], [360, true], [390, false], [390, true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, colorScheme: light ? "light" : "dark", serviceWorkers: "block" });
      await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan: PLAN_SMALL })]);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message)); await page.goto(URL);
      const res = [];
      await page.click("[data-a=tab][data-v=lib]"); res.push(await noOverflow(page));
      for (const id of ["hs-chest", "hs-legpress", "hs-lateral", "hs-seatcalf"]) { await page.click(`[data-a=openEx][data-id=${id}]`); res.push(await noOverflow(page)); await page.click("[data-a=exBack]"); }
      await page.click("[data-a=tab][data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]");
      for (const a of ["volumen", "gesundheit"]) { await page.click(`[data-a=openArt][data-id=${a}]`); res.push(await noOverflow(page)); await page.click("[data-a=artBack]"); }
      ok(`${w} px ${light ? "hell" : "dunkel"}: Bibliothek, Übungsseiten und Artikel ohne seitliches Scrollen`, res.every(Boolean), res.join());
      await ctx.close();
    }

    section("23. Apple Health über Kurzbefehle");
    {
      // Daten: Feld wird nur bei true übernommen, Übergabe-Markierung bleibt erhalten
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const nz = await tp(page, () => { const T = window.__tp;
        const a = T.normalize({ history: [{ id: "x", day: "T", date: new Date().toISOString(), durationSec: 600, exercises: [], hk: true }] });
        const b = T.normalize({ health: "ja", history: [{ id: "y", day: "T", date: new Date().toISOString(), durationSec: 600, exercises: [], hk: 1 }] });
        const c = T.normalize({ health: true });
        return { off: a.health, hk: a.history[0].hk, bad: b.health, badHk: b.history[0].hk === undefined, on: c.health }; });
      ok("Standard aus; nur echtes „an“ wird übernommen; Übergabe-Markierung bleibt", nz.off === false && nz.hk === true && nz.bad === false && nz.badHk && nz.on === true, JSON.stringify(nz));
      // Übergabe: Startzeit = Ende minus Dauer (Ortszeit), Dauer in Minuten
      const pl = await tp(page, () => { const T = window.__tp, end = new Date(2026, 2, 10, 18, 2, 30);
        const h = { date: end.toISOString(), durationSec: 3125 };
        const url = T.healthUrl(h), pre = "shortcuts://run-shortcut?name=Trainingsplan%20Workout&input=text&text=";
        return { p: T.healthPayload(h), pre: url.startsWith(pre), back: JSON.parse(decodeURIComponent(url.slice(pre.length))),
          zero: T.healthPayload({ date: end.toISOString(), durationSec: 0 }) }; });
      ok("Startzeit aus Ende minus Dauer (18:02 − 52 Min. → 17:10), Dauer 52 Min.", pl.p.start === "2026-03-10 17:10" && pl.p.minuten === 52, JSON.stringify(pl.p));
      ok("Link nach Apple-Schema: Kurzbefehl „Trainingsplan Workout“, Daten als Text", pl.pre && pl.back.start === pl.p.start && pl.back.minuten === 52 && Object.keys(pl.back).length === 2);
      ok("Dauer nie 0 Minuten", pl.zero.minuten === 1);
      // Aus: keine Buttons
      await page.click("[data-a=start]"); await page.fill("#kgIn", "30"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      ok("Ausgeschaltet: kein Health-Button nach dem Training", (await page.textContent("#app")).includes("Training beendet") && !(await page.$("[data-a=sendHealth]")));
      await page.click(".actionbar [data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=history]"); await page.click("#discLog summary");
      ok("Ausgeschaltet: kein Health-Button im Verlauf", !(await page.$("[data-a=sendHealth]")));
      ok("Verlauf: „1 Eintrag“ statt „1 Einträge“", (await page.textContent("#discLog summary")).includes("1 Eintrag") && !(await page.textContent("#discLog summary")).includes("Einträge"));
      // Einschalten in den Einstellungen
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      ok("Einstellungen zeigen „Apple Health · Aus“", (await page.textContent("[data-a=openHealth]")).includes("Aus"));
      await page.click("[data-a=openHealth]");
      const sh = await page.textContent(".sheet");
      ok("Erklärung: was übertragen wird und was nicht", sh.includes("Startzeit und Dauer") && sh.includes("Keine Kalorien") && sh.includes("nicht an einen Server"));
      ok("Anleitung mit genauem Kurzbefehl-Namen und allen Schritten", sh.includes("Trainingsplan Workout") && sh.includes("Wörterbuch abrufen") && sh.includes("minuten") && sh.includes("Traditionelles Krafttraining") && (await page.$$(".sheet #hkSetup ol li")).length === 6);
      ok("Einstellungs-Sheet bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click(".sheet [data-a=setHealth][data-v='1']");
      ok("Einschalten wird gespeichert und angezeigt", (await stored(page)).health === true && await page.$eval(".sheet [data-a=setHealth][data-v='1']", b => b.classList.contains("on")) && (await page.textContent("[data-a=openHealth]")).includes("An"));
      await page.click(".sheet [data-a=closeSheet]");
      // Nach dem Training
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]"); await page.fill("#kgIn", "30"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const st = await stored(page), last = st.history[st.history.length - 1];
      const exp = await tp(page, h => window.__tp.healthPayload(h), last);
      ok("Eingeschaltet: Button nach dem Training mit genauer Angabe", await page.isVisible("#hkBox [data-a=sendHealth]") && (await page.textContent("#hkBox")).includes(`Start ${exp.start.slice(11)} Uhr, ${exp.minuten} Min.`));
      ok("Zusammenfassung bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("#hkBox [data-a=sendHealth]");
      const url1 = await tp(page, () => window.__tp.lastUrl);
      ok("Tippen übergibt genau dieses Training an den Kurzbefehl", url1 === await tp(page, h => window.__tp.healthUrl(h), last));
      ok("Training als übergeben markiert", (await stored(page)).history.find(h => h.id === last.id).hk === true && (await page.textContent("#hkBox [data-a=sendHealth]")).includes("übergeben"));
      await tp(page, () => { window.__tp.lastUrl = null; });
      await page.click("#hkBox [data-a=sendHealth]");
      ok("Zweites Tippen fragt nach (keine doppelten Einträge aus Versehen)", (await page.textContent(".sheet")).includes("Schon übergeben") && await tp(page, () => window.__tp.lastUrl) === null);
      await page.click(".sheet [data-a=sendHealth][data-force]");
      ok("„Trotzdem erneut senden“ übergibt erneut", await tp(page, () => window.__tp.lastUrl) === url1 && !(await page.$(".sheet")));
      // Verlauf: frühere Trainings nachtragen
      await page.click(".actionbar [data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=history]"); await page.click("#discLog summary");
      const btns = await page.$$eval("#discLog [data-a=sendHealth]", b => b.map(x => ({ id: x.dataset.id, t: x.textContent })));
      const first = st.history[0];
      ok("Verlauf: Button je Training, übergebene sind gekennzeichnet", btns.length === 2 && btns.find(b => b.id === last.id).t.includes("übergeben") && btns.find(b => b.id === first.id).t.includes("In Apple Health eintragen"), JSON.stringify(btns));
      await tp(page, () => { window.__tp.lastUrl = null; });
      await page.click(`#discLog [data-a=sendHealth][data-id="${first.id}"]`);
      ok("Verlauf: älteres Training wird mit seiner eigenen Zeit übergeben", await tp(page, () => window.__tp.lastUrl) === await tp(page, h => window.__tp.healthUrl(h), first) && (await stored(page)).history[0].hk === true);
      // Sicherung enthält die Einstellung
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt");
      ok("Sicherung enthält Einstellung und Markierungen", (() => { const d = JSON.parse(Buffer.from(code.slice(4), "base64").toString("utf8")); return d.health === true && d.history.every(h => h.hk === true); })());
      await page.click(".sheet [data-a=closeSheet]");
      // Ausschalten
      await page.click("[data-a=openHealth]"); await page.click(".sheet [data-a=setHealth][data-v='0']");
      await page.click(".sheet [data-a=closeSheet]"); await page.click("[data-a=tab][data-v=history]");
      ok("Ausschalten entfernt die Buttons wieder", (await stored(page)).health === false && !(await page.$("[data-a=sendHealth]")));
      await ctx.close();
    }
    {
      // Körpergewicht an Health
      const { ctx, page } = await open({ plan: PLAN_SMALL, health: true });
      const w = await tp(page, () => { const T = window.__tp;
        const n = T.normalize({ weights: [{ d: "2026-01-02", kg: 80, hk: true }, { d: "2026-01-03", kg: 81, hk: "ja" }] }).weights;
        return { u1: T.weightUrl(82.5), u2: T.weightUrl(80), u3: T.weightUrl(82.3), hk1: n[0].hk, hk2: n[1].hk }; });
      ok("Gewicht als ganze Gramm übergeben (keine Komma-/Punkt-Verwechslung)", w.u1 === "shortcuts://run-shortcut?name=Trainingsplan%20Gewicht&input=text&text=82500" && w.u2.endsWith("text=80000") && w.u3.endsWith("text=82300"), w.u1);
      ok("Gewicht: Übergabe-Markierung nur bei echtem true", w.hk1 === true && w.hk2 === undefined);
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openHealth]");
      const sh = await page.textContent(".sheet");
      ok("Anleitung für den Gewichts-Kurzbefehl", sh.includes("Trainingsplan Gewicht") && sh.includes("Kurzbefehleingabe ÷ 1000") && sh.includes("Health-Messung protokollieren") && (await page.$$(".sheet #hkSetupW ol li")).length === 4);
      await page.click(".sheet [data-a=closeSheet]");
      await page.click("[data-a=tab][data-v=history]"); await page.click("#discWeight summary");
      ok("Ohne heutigen Eintrag kein Gewichts-Button", !(await page.$("[data-a=sendWeight]")));
      await page.fill("#bwIn", "82,5"); await page.click("[data-a=addWeight]");
      ok("Nach dem Eintragen bleibt der Bereich offen, Button mit genauem Wert", await page.$eval("#discWeight", d => d.open) && (await page.textContent("#bwHk")).includes("82,5 kg") && await page.isVisible("#bwHk [data-a=sendWeight]"));
      await page.click("#bwHk [data-a=sendWeight]");
      ok("Gewicht wird übergeben und markiert", await tp(page, () => window.__tp.lastUrl) === w.u1 && (await stored(page)).weights[0].hk === true && (await page.textContent("#bwHk [data-a=sendWeight]")).includes("übergeben"));
      await tp(page, () => { window.__tp.lastUrl = null; });
      await page.click("#bwHk [data-a=sendWeight]");
      ok("Gewicht: zweites Tippen fragt nach", (await page.textContent(".sheet")).includes("Schon übergeben") && await tp(page, () => window.__tp.lastUrl) === null);
      await page.click(".sheet [data-a=sendWeight][data-force]");
      ok("Gewicht: „Trotzdem erneut senden“ übergibt erneut", await tp(page, () => window.__tp.lastUrl) === w.u1);
      await page.fill("#bwIn", "83"); await page.click("[data-a=addWeight]");
      ok("Geänderter Wert gilt als noch nicht übergeben", (await stored(page)).weights[0].hk === undefined && (await page.textContent("#bwHk")).includes("In Apple Health eintragen") && (await page.textContent("#bwHk")).includes("83 kg"));
      ok("Körpergewicht mit Health-Button bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openHealth]"); await page.click(".sheet [data-a=setHealth][data-v='0']");
      await page.click(".sheet [data-a=closeSheet]"); await page.click("[data-a=tab][data-v=history]"); await page.click("#discWeight summary");
      ok("Ausgeschaltet: kein Gewichts-Button", !(await page.$("[data-a=sendWeight]")) && await page.isVisible("#bwIn"));
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, health: true }, { light });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openHealth]");
      const a = await noOverflow(page);
      await page.keyboard.press("Escape").catch(() => {}); await page.goto(URL);
      await page.click("[data-a=start]"); await page.fill("#kgIn", "30"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      ok(`360 px ${light ? "hell" : "dunkel"}: Health-Einstellungen und Zusammenfassung ohne seitliches Scrollen`, a && await noOverflow(page));
      await ctx.close();
    }

    section("24. Apple Watch (parallel aufzeichnen)");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, health: true });
      const nz = await tp(page, () => { const T = window.__tp; return [T.normalize({}).watch, T.normalize({ watch: "ja" }).watch, T.normalize({ watch: true }).watch]; });
      ok("Standard aus; nur echtes „an“ wird übernommen", nz[0] === false && nz[1] === false && nz[2] === true);
      ok("Ausgeschaltet: keine Watch-Erinnerung auf „Heute“", !(await page.$("#watchHint")));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      ok("Einstellungen zeigen „Apple Watch · Aus“", (await page.textContent("[data-a=openWatch]")).includes("Aus"));
      await page.click("[data-a=openWatch]");
      const sh = await page.textContent(".sheet");
      ok("Ehrliche Erklärung und Anleitung (Training → Traditionelles Krafttraining → Beenden)", sh.includes("keine Web-Apps") && sh.includes("Traditionelles Krafttraining") && sh.includes("Beenden") && (await page.$$(".sheet ol.glist li")).length === 3);
      ok("Watch-Sheet bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click(".sheet [data-a=setWatch][data-v='1']");
      ok("Einschalten wird gespeichert und angezeigt", (await stored(page)).watch === true && await page.$eval(".sheet [data-a=setWatch][data-v='1']", b => b.classList.contains("on")) && (await page.textContent("[data-a=openWatch]")).includes("Zeichnet mit auf"));
      await page.click(".sheet [data-a=closeSheet]");
      await page.click("[data-a=openHealth]");
      ok("Health-Einstellungen erklären, warum die Trainings-Übergabe entfällt", await page.isVisible("#hkWatchNote"));
      await page.click(".sheet [data-a=closeSheet]");
      await page.click("[data-a=tab][data-v=home]");
      ok("Eingeschaltet: Erinnerung vor dem Start", (await page.textContent("#watchHint")).includes("Traditionelles Krafttraining"));
      ok("„Heute“ mit Erinnerung bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=start]"); await page.fill("#kgIn", "30"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      ok("Nach dem Training: Erinnerung ans Beenden auf der Watch", (await page.textContent("#watchEnd")).includes("Beenden"));
      ok("Keine Trainings-Übergabe an Health (kein Doppeleintrag)", !(await page.$("#hkBox")) && !(await page.$("[data-a=sendHealth]")));
      await page.click(".actionbar [data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=history]");
      ok("Verlauf: keine Trainings-Übergabe", !(await page.$("[data-a=sendHealth]")));
      await page.click("#discWeight summary"); await page.fill("#bwIn", "80"); await page.click("[data-a=addWeight]");
      ok("Körpergewicht lässt sich weiter übergeben", await page.isVisible("#bwHk [data-a=sendWeight]"));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openWatch]"); await page.click(".sheet [data-a=setWatch][data-v='0']"); await page.click(".sheet [data-a=closeSheet]");
      await page.click("[data-a=tab][data-v=history]");
      ok("Ausschalten: Trainings-Übergabe wieder da", (await stored(page)).watch === false && !!(await page.$("[data-a=sendHealth]")));
      await page.click("[data-a=tab][data-v=home]");
      ok("Ausschalten: keine Erinnerung mehr", !(await page.$("#watchHint")));
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, health: true, watch: true }, { light });
      const a = await noOverflow(page);
      await page.click("[data-a=start]"); await page.fill("#kgIn", "30"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      ok(`360 px ${light ? "hell" : "dunkel"}: „Heute“ und Zusammenfassung mit Watch ohne seitliches Scrollen`, a && await noOverflow(page) && await page.isVisible("#watchEnd"));
      await ctx.close();
    }

    section("25. Ernährung");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      // Daten aus USDA: Vollständigkeit und Stichproben gegen die Originalwerte
      const db = await tp(page, () => { const T = window.__tp, bad = [], ids = new Set();
        T.FOOD_DB.forEach(r => { const [id, n, cat, k, p, c, f] = r;
          if (!Number.isInteger(id) || ids.has(id)) bad.push("ID " + id); ids.add(id);
          if (!n || !T.FOOD_CAT[cat]) bad.push(id + " Name/Kategorie");
          if (![k, p, c, f].every(v => typeof v === "number" && v >= 0)) bad.push(id + " Werte");
          if (p + c + f > 100.5) bad.push(id + " Summe > 100 g"); });
        const g = id => T.FOOD_DB.find(r => r[0] === id);
        return { n: T.FOOD_DB.length, bad, oats: g(173904).slice(3, 7), chick: g(171077).slice(3, 7), banana: g(173944).slice(3, 7), egg: g(171287), oil: g(171413).slice(3, 7) }; });
      ok(`${db.n} Grundnahrungsmittel, alle vollständig und plausibel`, db.n === 232 && !db.bad.length, db.bad.join("; "));
      ok("Stichproben entsprechen USDA SR Legacy (Haferflocken, Hähnchenbrust, Banane, Olivenöl)",
        JSON.stringify(db.oats) === "[379,13.2,67.7,6.52]" && JSON.stringify(db.chick) === "[120,22.5,0,2.62]" && JSON.stringify(db.banana) === "[89,1.09,22.8,0.33]" && JSON.stringify(db.oil) === "[884,0,0,100]");
      ok("Portionen aus USDA (1 Ei ohne Schale = 50 g)", db.egg[8][0] === "1 Ei ohne Schale" && db.egg[8][1] === 50);
      // Berechnung
      const cg = await tp(page, () => { const T = window.__tp, n = { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "halten", kcal: null };
        return { m: T.calcGoals(n, 80), w: T.calcGoals(Object.assign({}, n, { sex: "w", goal: "auf" }), 80), ab: T.calcGoals(Object.assign({}, n, { goal: "ab" }), 80),
          own: T.calcGoals(Object.assign({}, n, { kcal: 2500 }), 80), young: T.calcGoals(Object.assign({}, n, { age: 16 }), 80),
          clean: [T.cleanNutr({ kcal: 500 }).kcal, T.cleanNutr({ pal: 3 }).pal, T.cleanNutr("x")] }; });
      ok("Mifflin-St Jeor: Mann, 30 J., 180 cm, 80 kg → 1.780 kcal Grundumsatz, × 1,55 = 2.759 kcal", cg.m.bmr === 1780 && cg.m.tdee === 2759 && cg.m.auto === 2760);
      ok("Frauen: − 161 statt + 5 (1.614 kcal); Aufbau + 10 % → 2.750 kcal", cg.w.bmr === 1614 && cg.w.auto === 2750);
      ok("Abnehmen − 15 % → 2.350 kcal; eigenes Ziel hat Vorrang", cg.ab.auto === 2350 && cg.own.kcal === 2500 && cg.own.auto === 2760);
      ok("Eiweiß 1,6 g/kg (128 g), obere Grenze 2,2 g/kg (176 g)", cg.m.prot === 128 && cg.m.protHi === 176);
      ok("Fett 20–35 % von 2.760 kcal (61–107 g), Kohlenhydrate als Rest (321–425 g), Ballaststoffe 25 g", cg.m.fatLo === 61 && cg.m.fatHi === 107 && cg.m.carbLo === 321 && cg.m.carbHi === 425 && cg.m.fib === 25, JSON.stringify(cg.m));
      ok("Unter 18 Jahren keine Berechnung (Formel für Erwachsene); ungültige Werte werden verworfen", cg.young === null && cg.clean[0] === null && cg.clean[1] === 1.55 && cg.clean[2] === null);
      // Tagebuch-Daten
      const cf = await tp(page, () => window.__tp.cleanFood({ "2026-01-02": [
        { id: "a", m: "f", n: "Hafer", src: "usda:173904", g: 50, per: { k: 379, p: 13.2, c: 67.7, f: 6.52 } },
        { id: "b", m: "x", n: "Schnell", g: null, abs: { k: 500, p: 20, c: 50, f: 20 } },
        { id: "c", m: "f", n: "kaputt", g: -5, per: { k: 100, p: 1, c: 1, f: 1 } },
        { id: "d", m: "f", n: "zu viel", g: 100, per: { k: 2000, p: 1, c: 1, f: 1 } }], "kein-datum": [{ id: "e", g: 1, per: {} }] }));
      ok("Tagebuch-Daten bereinigt: gültige Einträge bleiben, ungültige fallen weg", Object.keys(cf).length === 1 && cf["2026-01-02"].length === 2 && cf["2026-01-02"][1].m === "s");
      // Open Food Facts: Umrechnung und Plausibilität
      const of = await tp(page, () => { const T = window.__tp, base = { code: "4000000000001", product_name: "Test", brands: "A,B,C" };
        const get = p => { const k = T.offFood(p); return k; };
        return { kcal: get(Object.assign({}, base, { nutriments: { "energy-kcal_100g": 66, proteins_100g: 12, carbohydrates_100g: 4.1, fat_100g: 0.2 }, serving_quantity: 250 })),
          kj: T.offFood(Object.assign({}, base, { code: "4000000000002", nutriments: { "energy-kj_100g": 418.4, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 1 } })),
          noP: T.offFood(Object.assign({}, base, { code: "4000000000003", nutriments: { "energy-kcal_100g": 66, carbohydrates_100g: 4, fat_100g: 0 } })),
          sum: T.offFood(Object.assign({}, base, { code: "4000000000004", nutriments: { "energy-kcal_100g": 500, proteins_100g: 60, carbohydrates_100g: 60, fat_100g: 1 } })) }; });
      ok("Packungsangaben: kcal übernommen, kJ ÷ 4,184, unvollständige oder unmögliche Werte verworfen", of.kcal === "o:4000000000001" && of.kj === "o:4000000000002" && of.noP === null && of.sum === null);
      // Ansicht ohne Ziele
      await page.click("[data-a=tab][data-v=food]");
      ok("Tab „Essen“ öffnet die Ernährung, ohne Ziele mit Einladung zum Festlegen", await page.isVisible("#foodSetup") && (await page.textContent(".head")).includes("Heute"));
      ok("Vier Mahlzeiten", (await page.$$("[data-a=foodAdd]")).length === 4);
      ok("Ernährung bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      // Ziele festlegen
      await page.click("#foodSetup [data-a=openNutr]");
      await page.click("[data-a=nutrSave]");
      ok("Speichern ohne Angaben: verständlicher Hinweis", (await page.textContent("#nErr")).includes("Alter"));
      await page.fill("#nAge", "30"); await page.fill("#nCm", "180"); await page.fill("#nKg", "80");
      ok("Live-Berechnung im Formular", (await page.textContent("#nutrOut")).includes("1.780") && (await page.textContent("#nutrOut")).includes("2.760"));
      await page.click("[data-a=nSet][data-k=pal][data-v='1.85']");
      ok("Aktivität ändert den Bedarf (× 1,85 → 3.293 kcal)", (await page.textContent("#nutrOut")).includes("3.293") && await page.$eval("[data-a=nSet][data-k=pal][data-v='1.85'] .check", e => e.classList.contains("on")));
      await page.click("[data-a=nSet][data-k=pal][data-v='1.55']"); await page.click("[data-a=nSet][data-k=goal][data-v=auf]");
      const sh = await page.textContent(".sheet");
      ok("Rechenweg und Grenzen offen erklärt, mit Quellen", sh.includes("Mifflin-St Jeor") && sh.includes("498") && sh.includes("FAO") && sh.includes("Schwangerschaft") && sh.includes("20–35 % der Kalorien") && sh.includes("EFSA") && (await page.$$(".sheet .srcs a")).length === 8);
      ok("Ziele-Formular bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=nutrSave]");
      let st = await stored(page);
      ok("Ziele gespeichert; Gewicht im Verlauf eingetragen", st.nutr.age === 30 && st.nutr.goal === "auf" && st.weights.length === 1 && st.weights[0].kg === 80);
      ok("Übersicht: 3.030 kcal übrig, Eiweißziel 128 g", (await page.textContent("#foodSum")).includes("3.030") && (await page.textContent("#foodSum")).includes("128 g"));
      const mr = (await page.textContent("#macroRows")).replace(/\s+/g, " ");
      ok("Übersicht: Kohlenhydrate, Fett und Ballaststoffe mit Bereich bzw. Ziel", mr.replace(/ /g, "").includes("Kohlenhydrate0von364–479g") && mr.replace(/ /g, "").includes("Fett0von67–118g") && mr.replace(/ /g, "").includes("Ballaststoffe0von25g"), mr);
      // Grundnahrungsmittel hinzufügen
      await page.click("[data-a=foodAdd][data-m=f]");
      ok("Hinzufügen-Sheet ohne Suche: Hinweis auf Datenbank", (await page.textContent("#foodRes")).includes("232 Grundnahrungsmittel"));
      await page.fill("#foodQ", "hafer");
      ok("Suche findet Haferflocken", (await page.$$("#foodRes [data-a=foodPick]")).length >= 1 && (await page.textContent("#foodRes")).includes("379 kcal"));
      await page.click("[data-a=foodPick][data-k='u:173904']");
      ok("Mengen-Sheet zeigt Quelle mit FDC-ID", (await page.$eval(".sheet a[href*='fdc.nal.usda.gov']", a => a.href)).includes("173904"));
      await page.fill("#amtG", "80");
      ok("Live-Werte für 80 g: 303 kcal, 10,6 g Eiweiß, 54,2 g Kohlenhydrate, 5,2 g Fett", (await page.textContent("#amtOut")).replace(/\s+/g, "").includes("kcal303Eiweiß10,6gKohlenh.54,2gFett5,2g"));
      ok("Mengen-Sheet bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.fill("#amtG", "0"); await page.click("[data-a=foodSave]");
      ok("Menge 0 wird abgelehnt", await page.isVisible("#amtErr"));
      await page.fill("#amtG", "80"); await page.click("[data-a=foodSave]");
      st = await stored(page);
      const today = await tp(page, () => window.__tp.dkey());
      ok("Eintrag gespeichert (Werte je 100 g + Menge, Quelle)", st.food[today].length === 1 && st.food[today][0].g === 80 && st.food[today][0].per.k === 379 && st.food[today][0].src === "usda:173904");
      ok("Übersicht aktualisiert: 2.727 kcal übrig", (await page.textContent("#foodSum")).includes("2.727") && (await page.textContent("#app")).includes("Haferflocken"));
      // Portion
      await page.click("[data-a=foodAdd][data-m=s]"); await page.fill("#foodQ", "banane"); await page.click("[data-a=foodPick][data-k='u:173944']");
      ok("Portion vorausgewählt (1 mittelgroße Banane = 118 g → 105 kcal)", (await page.inputValue("#amtG")) === "118" && (await page.textContent("#amtOut")).includes("105"));
      await page.click("[data-a=amtSet][data-g='100']");
      ok("Schnellauswahl 100 g", (await page.inputValue("#amtG")) === "100" && (await page.textContent("#amtOut")).includes("89"));
      await page.click("[data-a=mealSet][data-m=f]"); await page.click("[data-a=foodSave]");
      ok("Mahlzeit im Mengen-Sheet änderbar (Banane beim Frühstück)", (await stored(page)).food[today][1].m === "f");
      // Bearbeiten und löschen
      const banId = (await stored(page)).food[today][1].id;
      await page.click(`[data-a=foodEdit][data-id="${banId}"]`);
      ok("Bearbeiten öffnet mit gespeicherter Menge", (await page.inputValue("#amtG")) === "100" && await page.isVisible("[data-a=foodDel]"));
      await page.fill("#amtG", "150"); await page.click("[data-a=foodSave]");
      ok("Menge geändert", (await stored(page)).food[today][1].g === 150);
      await page.click(`[data-a=foodEdit][data-id="${banId}"]`); await page.click("[data-a=foodDel]");
      ok("Eintrag gelöscht", (await stored(page)).food[today].length === 1);
      // Zuletzt verwendet
      await page.click("[data-a=foodAdd][data-m=m]");
      ok("Zuletzt verwendet zeigt Haferflocken", (await page.textContent("#foodRes")).includes("Zuletzt verwendet") && (await page.textContent("#foodRes")).includes("Haferflocken"));
      // Nur kcal
      await page.click("[data-a=quickOpen]"); await page.click("[data-a=quickSave]");
      ok("Nur kcal: ohne Kalorien Hinweis", await page.isVisible("#qkErr"));
      await page.fill("#qkN", "Kantine"); await page.fill("#qkK", "650"); await page.fill("#qkP", "35"); await page.click("[data-a=quickSave]");
      st = await stored(page);
      ok("Schnelleintrag gespeichert", st.food[today].some(e => e.n === "Kantine" && e.g === null && e.abs.k === 650 && e.abs.p === 35 && e.m === "m"));
      // Eigenes Lebensmittel mit Plausibilitätshinweis
      await page.click("[data-a=foodAdd][data-m=s]"); await page.click("[data-a=ownFoodOpen]");
      await page.fill("#ownN", "Riegel"); await page.fill("#ownK", "200"); await page.fill("#ownP", "30"); await page.fill("#ownC", "40"); await page.fill("#ownF", "20");
      ok("Hinweis, wenn kcal nicht zu Eiweiß/KH/Fett passen (4/4/9 → 460 kcal)", await page.isVisible("#ownHint") && (await page.textContent("#ownHint")).includes("460"));
      await page.fill("#ownK", "460");
      ok("Hinweis verschwindet bei stimmigen Werten", !(await page.isVisible("#ownHint")));
      await page.fill("#ownP", "70"); await page.click("[data-a=ownSave]");
      ok("Mehr als 100 g Nährstoffe je 100 g abgelehnt", (await page.textContent("#ownErr")).includes("100 g"));
      await page.fill("#ownP", "30"); await page.fill("#ownPl", "1 Riegel"); await page.fill("#ownPg", "50"); await page.click("[data-a=ownSave]");
      ok("Eigenes Lebensmittel gespeichert, Portion vorausgewählt", (await stored(page)).myFoods[0].n === "Riegel" && (await page.inputValue("#amtG")) === "50" && (await page.textContent("#amtOut")).includes("230"));
      await page.click("[data-a=foodSave]");
      // Online-Suche (Open Food Facts, simuliert)
      let mode = "ok";
      await page.route("https://world.openfoodfacts.org/**", route => {
        const u = route.request().url(), h = { "access-control-allow-origin": "*", "content-type": "application/json" };
        if (mode === "down") return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*", "content-type": "text/html" }, body: "<html>Page temporarily unavailable</html>" });
        if (u.includes("/cgi/search.pl")) return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ count: 3, products: [
          { code: "4061458014151", product_name: "Bio-Magerquark", brands: "Gut Bio,Aldi", nutriments: { "energy-kcal_100g": 66, proteins_100g: 12, carbohydrates_100g: 4.1, fat_100g: 0.2 }, serving_quantity: 250 },
          { code: "4000000000099", product_name: "Ohne Werte", nutriments: {} },
          { code: "4061458014151", product_name: "Doppelt", nutriments: { "energy-kcal_100g": 66, proteins_100g: 12, carbohydrates_100g: 4.1, fat_100g: 0.2 } }] }) });
        if (u.includes("/api/v2/product/4061458014151")) return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ status: 1, product: { code: "4061458014151", product_name: "Bio-Magerquark", brands: "Gut Bio", nutriments: { "energy-kcal_100g": 66, proteins_100g: 12, carbohydrates_100g: 4.1, fat_100g: 0.2 } } }) });
        if (u.includes("/api/v2/product/4000000000112")) return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ status: 1, product: { code: "4000000000112", product_name: "Halb", nutriments: { "energy-kcal_100g": 66 } } }) });
        return route.fulfill({ status: 404, headers: h, body: JSON.stringify({ status: 0, status_verbose: "product not found" }) });
      });
      await page.click("[data-a=foodAdd][data-m=f]");
      ok("Online-Suche erst mit Suchbegriff", await page.isDisabled("#offBtn"));
      await page.fill("#foodQ", "magerquark");
      ok("Lokal nicht gefunden: Hinweis auf Online-Suche", (await page.textContent("#foodRes")).includes("Online-Suche"));
      const reqs = []; page.on("request", r => { if (r.url().includes("openfoodfacts")) reqs.push(r.url()); });
      await page.click("#offBtn"); await page.waitForSelector("#offRes [data-a=foodPick]");
      ok("Online-Suche: nur vollständige Produkte, ohne Doppelte, mit Marke und Quellenhinweis",
        (await page.$$("#offRes [data-a=foodPick]")).length === 1 && (await page.textContent("#offRes")).includes("Gut Bio, Aldi") && (await page.textContent("#offRes")).includes("Open Food Facts"));
      ok("Suche auf in Deutschland verkaufte Produkte beschränkt", reqs.some(u => u.includes("cc=de") && u.includes("search_terms=magerquark")));
      await page.click("#offRes [data-a=foodPick]");
      ok("Packungs-Portion vorausgewählt (250 g → 165 kcal, 30 g Eiweiß)", (await page.inputValue("#amtG")) === "250" && (await page.textContent("#amtOut")).replace(/\s+/g, "").includes("kcal165Eiweiß30g"));
      await page.click("[data-a=foodSave]");
      ok("Online-Produkt gespeichert mit Quelle", (await stored(page)).food[today].some(e => e.src === "off:4061458014151" && e.g === 250));
      mode = "down"; await page.click("[data-a=foodAdd][data-m=f]"); await page.fill("#foodQ", "skyr"); await page.click("#offBtn");
      await page.waitForFunction(() => (document.querySelector("#offRes")?.textContent || "").includes("erneut"));
      ok("Server ausgelastet: verständliche Meldung mit Hinweis auf den Barcode", (await page.textContent("#offRes")).includes("nicht erreichbar") && (await page.textContent("#offRes")).includes("Barcode"));
      mode = "ok"; await page.keyboard.press("Escape");
      // Barcode
      await page.click("[data-a=foodAdd][data-m=f]"); await page.click("[data-a=barcodeOpen]");
      const bcFood = await tp(page, () => Object.values(window.__tp.state.food).flat().length);   // nichts davon darf einen Eintrag anlegen
      await page.fill("#bcIn", "123"); await page.click("[data-a=barcodeGo]");
      ok("Barcode: falsche Länge abgelehnt", (await page.textContent("#bcMsg")).includes("8, 12, 13 oder 14"));
      await page.fill("#bcIn", "4061458014152"); await page.click("[data-a=barcodeGo]");
      ok("Barcode: Tippfehler über die Prüfziffer erkannt, ohne Anfrage", (await page.textContent("#bcMsg")).includes("Prüfziffer"));
      await page.fill("#bcIn", "4000000000006"); await page.click("[data-a=barcodeGo]");
      await page.waitForFunction(() => (document.querySelector("#bcMsg")?.textContent || "").includes("Kein Produkt"));
      ok("Barcode: nicht gefunden → Hinweis auf eigenes Lebensmittel", (await page.textContent("#bcMsg")).includes("Lege es als eigenes Lebensmittel an") && (await tp(page, () => Object.values(window.__tp.state.food).flat().length)) === bcFood);
      await page.fill("#bcIn", "4000000000112"); await page.click("[data-a=barcodeGo]");
      await page.waitForFunction(() => (document.querySelector("#bcMsg")?.textContent || "").includes("ohne vollständige"));
      ok("Barcode: unvollständige Nährwerte werden nicht übernommen", (await page.textContent("#bcMsg")).includes("Produkt gefunden, aber ohne vollständige Nährwerte") && (await tp(page, () => Object.values(window.__tp.state.food).flat().length)) === bcFood);
      await page.fill("#bcIn", "4061458014151"); await page.click("[data-a=barcodeGo]");
      await page.waitForSelector("#amtG");
      ok("Barcode: gefunden → Mengen-Sheet", (await page.textContent(".sheet")).includes("Bio-Magerquark"));
      await page.keyboard.press("Escape");
      // Tage
      ok("Blättern in die Zukunft zum Planen (bis 14 Tage)", !(await page.isDisabled("[data-a=foodDay][data-d='1']")));
      await page.click("[data-a=foodDay][data-d='-1']");
      ok("Gestern: eigener, leerer Tag", (await page.textContent(".head")).includes("Gestern") && (await page.textContent("#foodSum")).includes("3.030"));
      await page.click("[data-a=foodAdd][data-m=a]"); await page.click("[data-a=quickOpen]"); await page.fill("#qkK", "700"); await page.click("[data-a=quickSave]");
      const yest = await tp(page, () => window.__tp.dkey(new Date(Date.now() - 864e5)));
      ok("Nachtragen für gestern", (await stored(page)).food[yest][0].abs.k === 700);
      await page.click("[data-a=foodDay][data-d='1']");
      ok("Zurück zu heute", (await page.textContent(".head")).includes("Heute"));
      ok("Letzte 7 Tage: Durchschnitt über Tage mit Einträgen", (await page.textContent("#app")).includes("an 2 Tagen mit Einträgen"));
      // Heute-Ansicht und Wissen
      await page.click("[data-a=tab][data-v=home]");
      const tt = await tp(page, () => window.__tp.dayTotals(window.__tp.dkey()));
      ok("„Heute“ zeigt Essen des Tages", (await page.textContent("#homeFood")).includes(`${Math.round(tt.k).toLocaleString("de-DE")} von 3.030 kcal`));
      await page.click("#homeFood");
      ok("Antippen öffnet die Ernährung", await page.isVisible("#foodSum"));
      await page.click("[data-a=openArt][data-id=eiweiss]");
      ok("Artikel „Eiweiß“ mit Quelle (Morton 2018)", (await page.textContent("#app")).includes("1,6 g") && (await page.$$eval(".srcs a", a => a.map(x => x.href))).some(h => h.includes("28698222")));
      await page.click("[data-a=artBack]");
      ok("Zurück zur Ernährung", await page.isVisible("#foodSum"));
      await page.click("[data-a=openArt][data-id=kalorien]");
      ok("Artikel „Kalorienbedarf“ mit 5 Quellen", (await page.$$(".srcs a")).length === 5);
      await page.click("[data-a=artBack]");
      ok("Ernährung mit Einträgen bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }
    {
      // Gewichtstrend
      const iso = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
      const nutr = { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null };
      const { ctx, page } = await open({ plan: PLAN_SMALL, nutr, weights: [{ d: iso(21), kg: 80 }, { d: iso(14), kg: 79.6 }, { d: iso(7), kg: 79.2 }, { d: iso(0), kg: 78.8 }] });
      const tr = await tp(page, () => window.__tp.weightTrend());
      ok("Gewichtstrend als Ausgleichsgerade (−0,4 kg/Woche ≈ −0,5 % pro Woche)", Math.abs(tr.pct - (-0.4 / 79.4 * 100)) < 0.01 && tr.days === 21 && tr.n === 4, JSON.stringify(tr));
      await page.click("[data-a=tab][data-v=food]");
      ok("Trend passt zum Ziel „Abnehmen“ (0,5–1 %)", (await page.textContent("#trendNote")).includes("passt") && (await page.textContent("#trendNote")).includes("−0,5 % pro Woche"));
      await tp(page, () => { const s = window.__tp.state; s.nutr.goal = "auf"; });
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=food]");
      ok("Gleicher Trend (−0,5 %) bei „Aufbauen“: „Du nimmst ab statt zu“, Hinweis zum Anpassen", (await page.textContent("#trendNote")).includes("Du nimmst ab statt zu.") && !(await page.textContent("#trendNote")).includes("langsamer zu") && (await page.textContent("#trendNote")).includes("passe dein Kalorienziel an"));
      const tm = await tp(page, () => { const f = window.__tp.trendMsg; return [f(0.1, "auf", true), f(0, "auf", true), f(-0.3, "auf", true), f(0.3, "ab", false), f(-0.2, "ab", false), f(-1.4, "ab", true), f(0.4, "halten", false), f(0.9, "auf", false)]; });
      ok("Trend-Satz nennt die Richtung richtig (auch wenn das Gewicht in die Gegenrichtung läuft)", JSON.stringify(tm) === JSON.stringify(["Du nimmst langsamer zu als geplant", "Du nimmst langsamer zu als geplant", "Du nimmst ab statt zu", "Du nimmst zu statt ab", "Du nimmst langsamer ab als geplant", "Du nimmst schneller ab als geplant", "Dein Gewicht steigt", "Du nimmst schneller zu als geplant"]), JSON.stringify(tm));
      await ctx.close();
      const p2 = await open({ plan: PLAN_SMALL, nutr, weights: [{ d: iso(5), kg: 80 }, { d: iso(0), kg: 79 }] });
      ok("Zu wenige Daten: kein Trend, sondern Erklärung", (await tp(p2.page, () => window.__tp.weightTrend())) === null);
      await p2.page.click("[data-a=tab][data-v=food]");
      ok("Erklärung, ab wann der Trend erscheint", (await p2.page.textContent("#app")).includes("Ab drei Einträgen über zwei Wochen"));
      await p2.ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, nutr: { sex: "w", age: 40, cm: 165, pal: 1.85, goal: "ab" }, weights: [{ d: new Date().toISOString().slice(0, 10), kg: 70 }] }, { light });
      await page.click("[data-a=tab][data-v=food]"); const a = await noOverflow(page);
      await page.click("[data-a=foodAdd][data-m=f]"); const b = await noOverflow(page);
      await page.click("[data-a=quickOpen]"); const c = await noOverflow(page);
      await page.keyboard.press("Escape"); await page.click("[data-a=openNutr]"); const d = await noOverflow(page);
      ok(`360 px ${light ? "hell" : "dunkel"}: Ernährung, Hinzufügen, Schnelleintrag und Ziele ohne seitliches Scrollen`, a && b && c && d);
      await ctx.close();
    }

    section("26. Barcode-Scan mit der Kamera");
    // Unabhängiger Test-Encoder nach den Bitmustern der Norm: L-Code, R = Komplement von L, G = R rückwärts
    const L_BITS = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
    const R_BITS = L_BITS.map(b => [...b].map(c => c === "1" ? "0" : "1").join("")), G_BITS = R_BITS.map(b => [...b].reverse().join(""));
    const PAR13 = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLG", "LGLGLL", "LGLGGL", "LGGLGL"];
    const eanBits = code => {
      let s = "101";
      if (code.length === 13) { for (let i = 0; i < 6; i++) s += (PAR13[+code[0]][i] === "L" ? L_BITS : G_BITS)[+code[i + 1]]; s += "01010"; for (let i = 7; i < 13; i++) s += R_BITS[+code[i]]; }
      else { for (let i = 0; i < 4; i++) s += L_BITS[+code[i]]; s += "01010"; for (let i = 4; i < 8; i++) s += R_BITS[+code[i]]; }
      return s + "101";
    };
    const scanLine = (bits, px, { noise = 0, spread = 0, quiet = 12 } = {}) => {
      const mods = "0".repeat(quiet) + bits + "0".repeat(quiet), out = new Array(mods.length * px).fill(215);
      for (let i = 0; i < mods.length; i++) if (mods[i] === "1") for (let k = -spread; k < px + spread; k++) { const x = i * px + k; if (x >= 0 && x < out.length) out[x] = 40; }
      let s = 12345;
      return out.map(v => { s = (s * 1103515245 + 12345) % 2147483648; return Math.max(0, Math.min(255, Math.round(v + (s / 2147483648 - 0.5) * 2 * noise))); });
    };
    const writeY4m = (file, bits, { w = 640, h = 480, px = 4, flip = false, blur = false, spread = 0, tilt = 0, noise = 0 } = {}) => {
      let Y = new Uint8Array(w * h).fill(230);
      if (bits) {
        const bw = bits.length * px, cx = w / 2, cy = h / 2, a = tilt * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), bh = h * 0.28;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const u = (x - cx) * ca + (y - cy) * sa + bw / 2, v = -(x - cx) * sa + (y - cy) * ca;     // gedrehte Koordinaten
          if (Math.abs(v) > bh / 2 || u < -spread || u >= bw + spread) continue;
          const i = Math.floor(u / px), f = u - i * px;
          const dark = (i >= 0 && i < bits.length && bits[i] === "1") || (spread && ((f < spread && bits[i - 1] === "1") || (f >= px - spread && bits[i + 1] === "1")));
          if (dark) Y[y * w + x] = 30;
        }
      }
      if (noise) { let s = 99; for (let i = 0; i < Y.length; i++) { s = (s * 1103515245 + 12345) % 2147483648; Y[i] = Math.max(0, Math.min(255, Math.round(Y[i] + (s / 2147483648 - 0.5) * 2 * noise))); } }
      if (blur) { const B = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += Y[yy * w + xx]; n++; } }
        B[y * w + x] = Math.round(s / n); } Y = B; }
      if (flip) Y = Y.reverse();
      const head = Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`);
      const frame = Buffer.concat([Buffer.from("FRAME\n"), Buffer.from(Y), Buffer.alloc(w * h / 4, 128), Buffer.alloc(w * h / 4, 128)]);
      require("fs").writeFileSync(file, Buffer.concat([head, frame, frame, frame, frame, frame]));
    };
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const gv = await tp(page, () => ["4006381333931", "3017620422003", "036000291452", "73513537", "4006381333932", "12345", "4061458014151"].map(c => window.__tp.gtinValid(c)));
      ok("Prüfziffer nach GS1: gültige EAN-13, UPC-A und EAN-8 erkannt, falsche abgelehnt", JSON.stringify(gv) === "[true,true,true,true,false,false,true]", JSON.stringify(gv));
      const cases = [["4006381333931", 3, {}], ["3017620422003", 2, { noise: 25 }], ["0036000291452", 4, { spread: 1 }], ["73513537", 3, {}], ["5000112637922", 5, { noise: 15, spread: 1 }]];
      const res = [];
      for (const [c, px, o] of cases) { const g = scanLine(eanBits(c), px, o); res.push(await tp(page, a => window.__tp.eanDecodeLine(a), g)); res.push(await tp(page, a => window.__tp.eanDecodeLine(a), [...g].reverse())); }
      ok("Decoder liest EAN-13, UPC-A und EAN-8 – auch verrauscht, mit verbreiterten Balken und auf dem Kopf", JSON.stringify(res) === JSON.stringify(cases.flatMap(([c]) => [c, c])), JSON.stringify(res));
      ok("Strichcode mit falscher Prüfziffer wird nicht gelesen", (await tp(page, a => window.__tp.eanDecodeLine(a), scanLine(eanBits("4006381333932"), 3))) === null);
      ok("Abgeschnittener Strichcode (ohne Ruhezone) wird nicht gelesen", (await tp(page, a => window.__tp.eanDecodeLine(a), scanLine(eanBits("4006381333931"), 3, { quiet: 1 }))) === null);
      const rnd = []; let s = 7; for (let i = 0; i < 1200; i++) { s = (s * 1103515245 + 12345) % 2147483648; rnd.push(s % 256); }
      ok("Zufälliges Bildrauschen ergibt keine Lesung", (await tp(page, a => window.__tp.eanDecodeLine(a), rnd)) === null);
      await page.click("[data-a=tab][data-v=food]"); await page.click("[data-a=foodAdd][data-m=f]"); await page.click("[data-a=barcodeOpen]");
      ok("Barcode-Sheet: Kamera-Scan als Hauptaktion", await page.isVisible(".sheet .btn.primary[data-a=scanStart]"));
      await page.click("[data-a=scanStart]");
      await page.waitForFunction(() => /Nummer/.test(document.querySelector("#scanMsg")?.textContent || ""), null, { timeout: 15000 });
      ok("Ohne Kamera(zugriff): verständliche Meldung statt Fehler", !(await tp(page, () => window.__tp.scanActive())));
      ok("Scanner-Ansicht bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click(".sh-head [data-a=scanCancel]");
      ok("„Abbrechen“ führt zur Barcode-Eingabe", await page.isVisible("#bcIn"));
      await ctx.close();
    }
    // Kamera-Simulation: Chromium liefert ein Video mit Strichcode als Kamerabild
    const camRun = async (file, fn) => {
      const cam = await chromium.launch({ args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${file}`] });
      const ctx = await cam.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: "block", permissions: ["camera"] });
      await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan: PLAN_SMALL })]);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message));
      try { await fn(page); } finally { await ctx.close(); await cam.close(); }
    };
    for (const [code, opt, label] of [["4006381333931", {}, "scharf"], ["3017620422003", { flip: true, blur: true, spread: 1 }, "unscharf, auf dem Kopf, verbreiterte Balken"],
      ["4061458014151", { px: 3, tilt: 8, noise: 20 }, "8° schräg, klein, verrauscht"], ["73513537", {}, "EAN-8"]]) {
      const file = path.join(require("os").tmpdir(), `tp-scan-${code}.y4m`); writeY4m(file, eanBits(code), opt);
      await camRun(file, async page => {
        const asked = [];
        await page.route("https://world.openfoodfacts.org/**", route => { asked.push(route.request().url());
          route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ status: 1, product: { code, product_name: "Testprodukt " + code, nutriments: { "energy-kcal_100g": 100, proteins_100g: 10, carbohydrates_100g: 10, fat_100g: 2 } } }) }); });
        await page.goto(URL);
        await page.click("[data-a=tab][data-v=food]"); await page.click("[data-a=foodAdd][data-m=f]"); await page.click("[data-a=barcodeOpen]"); await page.click("[data-a=scanStart]");
        const found = await page.waitForSelector("#amtG", { timeout: 20000 }).then(() => true).catch(() => false);
        ok(`Kamera-Scan (${label}): ${code} erkannt und nachgeschlagen`, found && asked.some(u => u.includes(`/product/${code}.json`)) && (await page.textContent(".sheet")).includes("Testprodukt " + code),
          found ? asked.join(" ") : await page.textContent("#scanMsg").catch(() => "kein Sheet"));
        ok(`Kamera nach dem Scan ausgeschaltet (${label})`, !(await tp(page, () => window.__tp.scanActive())) && !(await page.$("video")));
      });
    }
    {
      const file = path.join(require("os").tmpdir(), "tp-scan-leer.y4m"); writeY4m(file, null);
      await camRun(file, async page => {
        await page.goto(URL);
        await page.click("[data-a=tab][data-v=food]"); await page.click("[data-a=foodAdd][data-m=f]"); await page.click("[data-a=barcodeOpen]"); await page.click("[data-a=scanStart]");
        await page.waitForFunction(() => window.__tp.scanActive(), null, { timeout: 10000 });
        await page.waitForTimeout(1500);
        ok("Leeres Kamerabild: keine Falschlesung, Scanner läuft weiter", await tp(page, () => window.__tp.scanActive()) && !(await page.$("#amtG")));
        await page.keyboard.press("Escape");
        ok("Sheet schließen schaltet die Kamera aus", !(await tp(page, () => window.__tp.scanActive())));
      });
    }

    section("27. Wasser und „Wie am Vortag“");
    {
      const pad = n => String(n).padStart(2, "0"), dk = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const today = dk(new Date()), yest = dk(new Date(Date.now() - 864e5)), before = dk(new Date(Date.now() - 2 * 864e5));
      const E = (id, m, n, g, k, p) => ({ id, m, n, src: "usda:1", g, per: { k, p, c: 10, f: 1 } });
      const food = { [yest]: [E("y1", "f", "Haferflocken", 80, 379, 13.2), E("y2", "f", "Banane", 118, 89, 1.09), E("y3", "m", "Reis", 250, 130, 2.69)],
        [before]: [E("b1", "a", "Lachs", 150, 206, 22.1)] };
      const { ctx, page } = await open({ plan: PLAN_SMALL, food, water: { [yest]: 1500, "kaputt": 5, [before]: -3 } });
      const w = await tp(page, () => { const T = window.__tp; return { clean: T.state.water, none: T.waterGoal() }; });
      ok("Wasser-Daten bereinigt", JSON.stringify(Object.keys(w.clean)) === JSON.stringify([yest]) && w.clean[yest] === 1500);
      ok("Ohne Profil kein persönliches Trinkziel", w.none === null);
      await page.click("[data-a=tab][data-v=food]");
      ok("Ohne Profil: Spanne 1,6–2,0 L (EFSA)", (await page.textContent("#waterBox")).includes("0,0 L") && (await page.textContent("#waterBox")).includes("1,6–2,0 L") && await page.isDisabled("[data-a=water][data-ml='-250']"));
      await page.click("[data-a=water][data-ml='250']"); await page.click("[data-a=water][data-ml='250']"); await page.click("[data-a=water][data-ml='500']");
      ok("Gläser zählen: 2 × 250 ml + 500 ml = 1,0 L", (await page.textContent("#waterBox")).includes("1,0 L") && (await stored(page)).water[today] === 1000);
      await page.click("[data-a=water][data-ml='-250']");
      ok("Korrektur: − 250 ml → 0,75 L", (await page.textContent("#waterBox")).includes("0,75 L") && (await stored(page)).water[today] === 750);
      await page.click("[data-a=waterInfo]");
      const info = await page.textContent(".sheet");
      ok("Erklärung mit EFSA-Werten, Geltungsbereich und Quellen", info.includes("2,0 Liter") && info.includes("2,5 Liter") && info.includes("20–30 %") && info.includes("Hitze")
        && (await page.$$eval(".sheet .srcs a", a => a.map(x => x.href))).some(h => h.includes("10.2903/j.efsa.2010.1459")));
      await page.keyboard.press("Escape");
      // „Wie am Vortag“
      ok("„Wie am Vortag“ nur bei leeren Mahlzeiten mit Einträgen am Vortag", (await page.$$("[data-a=copyMeal]")).length === 2
        && (await page.textContent("[data-a=copyMeal][data-m=f]")).includes("2 Einträge, 408 kcal"));
      await page.click("[data-a=copyMeal][data-m=f]");
      let st = await stored(page);
      ok("Frühstück übernommen: gleiche Werte, neue Einträge", st.food[today].length === 2 && st.food[today].every(e => e.m === "f" && !["y1", "y2"].includes(e.id))
        && st.food[today][0].g === 80 && st.food[today][0].per.k === 379 && st.food[yest].length === 3);
      ok("Nach dem Übernehmen kein doppeltes Angebot", !(await page.$("[data-a=copyMeal][data-m=f]")) && (await page.textContent("#app")).includes("Haferflocken"));
      // Vergangener Tag: Wasser und Vortag beziehen sich auf den angezeigten Tag
      await page.click("[data-a=foodDay][data-d='-1']");
      ok("Gestern: eigener Wasserstand (1,5 L)", (await page.textContent("#waterBox")).includes("1,5 L"));
      ok("Gestern: „Wie am Vortag“ bezieht sich auf vorgestern", (await page.$$("[data-a=copyMeal]")).length === 1 && !!(await page.$("[data-a=copyMeal][data-m=a]")));
      await page.click("[data-a=foodDay][data-d='1']");
      // Mit Profil: persönliches Ziel
      await tp(page, () => { window.__tp.state.nutr = window.__tp.cleanNutr({ sex: "w", age: 30, cm: 165, pal: 1.55, goal: "halten" }); });
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=food]");
      ok("Frauen: Trinkziel 1,6 L", (await page.textContent("#waterBox")).includes("von 1,6 L") && (await tp(page, () => window.__tp.waterGoal())) === 1600);
      await tp(page, () => { window.__tp.state.nutr.sex = "m"; });
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=food]");
      ok("Männer: Trinkziel 2,0 L", (await page.textContent("#waterBox")).includes("von 2,0 L"));
      ok("Wasser und Vortag bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, water: {}, nutrOpt: { water: true } }, { light });
      await page.click("[data-a=tab][data-v=food]"); await page.click("[data-a=water][data-ml='500']");
      ok(`360 px ${light ? "hell" : "dunkel"}: Wasserbereich ohne seitliches Scrollen`, await noOverflow(page) && await page.isVisible("#waterBox"));
      await ctx.close();
    }

    section("28. Mehr Lebensmittel und „Meine Mahlzeiten“");
    {
      const pad = n => String(n).padStart(2, "0"), dk = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, today = dk(new Date());
      const E = (id, m, n, src, g, per) => ({ id, m, n, src, g, per });
      const food = { [today]: [E("a", "f", "Haferflocken", "usda:173904", 80, { k: 379, p: 13.2, c: 67.7, f: 6.52, fib: 10.1 }),
        E("b", "f", "Banane", "usda:173944", 118, { k: 89, p: 1.09, c: 22.8, f: 0.33, fib: 2.6 }),
        E("c", "m", "Reis, weiß (Langkorn), gekocht", "usda:168878", 250, { k: 130, p: 2.69, c: 28.2, f: 0.28 })] };
      const { ctx, page } = await open({ plan: PLAN_SMALL, food, meals: [{ n: "", items: [] }, { n: "Kaputt", items: [{ g: -1 }] }] });
      const db = await tp(page, () => { const T = window.__tp, g = id => T.FOOD_DB.find(r => r[0] === id);
        return { n: T.FOOD_DB.length, kohlrabi: g(168424).slice(3, 7), edamer: g(173419).slice(3, 7), kerne: g(170556).slice(3, 7), wurst: g(171620)[8], meals: T.state.meals.length,
          find: ["brezel", "sauerkraut", "rotkohl", "leberwurst", "kohlrabi", "emmentaler", "dinkel"].map(q => T.FOOD_DB.filter(r => r[1].toLowerCase().includes(q)).length) }; });
      ok("232 Grundnahrungsmittel aus USDA", db.n === 232);
      ok("Neue Stichproben entsprechen USDA (Kohlrabi, Edamer, Kürbiskerne; 1 Bratwurst = 85 g)",
        JSON.stringify(db.kohlrabi) === "[27,1.7,6.2,0.1]" && JSON.stringify(db.edamer) === "[357,25,1.43,28.6]" && JSON.stringify(db.kerne) === "[559,30.2,10.7,49]" && db.wurst[1] === 85);
      ok("Typische Lebensmittel auffindbar (Brezel, Sauerkraut, Rotkohl, Leberwurst, Kohlrabi, Emmentaler, Dinkel)", db.find.every(n => n >= 1), db.find.join());
      ok("Ungültige gespeicherte Mahlzeiten werden verworfen", db.meals === 0);
      await page.click("[data-a=tab][data-v=food]");
      ok("„Als Mahlzeit speichern“ ab zwei Einträgen", !!(await page.$("[data-a=mealSaveOpen][data-m=f]")) && !(await page.$("[data-a=mealSaveOpen][data-m=m]")));
      await page.click("[data-a=mealSaveOpen][data-m=f]");
      ok("Speichern zeigt Inhalt mit Mengen", (await page.textContent(".sheet")).includes("Haferflocken · 80 g") && (await page.inputValue("#mealN")) === "Mein Frühstück");
      await page.fill("#mealN", ""); await page.click("[data-a=mealSave]");
      ok("Ohne Namen: Hinweis", await page.isVisible("#mealErr"));
      await page.fill("#mealN", "Haferfrühstück"); await page.click("[data-a=mealSave]");
      let st = await stored(page);
      ok("Mahlzeit gespeichert (Lebensmittel, Mengen, Werte je 100 g)", st.meals.length === 1 && st.meals[0].n === "Haferfrühstück" && st.meals[0].items.length === 2
        && st.meals[0].items[0].g === 80 && st.meals[0].items[0].per.k === 379 && !("id" in st.meals[0].items[0]));
      await page.click("[data-a=foodAdd][data-m=s]");
      ok("„Meine Mahlzeiten“ oben im Hinzufügen-Sheet mit kcal", (await page.textContent("#foodRes")).includes("Meine Mahlzeiten") && (await page.textContent("#foodRes")).includes("Haferfrühstück") && (await page.textContent("#foodRes")).includes("408 kcal"));
      await page.fill("#foodQ", "hafer");
      ok("Suche findet auch gespeicherte Mahlzeiten", (await page.textContent("#foodRes")).includes("Haferfrühstück") && (await page.textContent("#foodRes")).includes("Haferflocken"));
      await page.click("[data-a=mealUse]");
      st = await stored(page);
      const snacks = st.food[today].filter(e => e.m === "s");
      ok("Ein Tipp fügt alle Lebensmittel mit Mengen ein (als Snack, neue Einträge)", snacks.length === 2 && snacks[0].g === 80 && snacks.every(e => !["a", "b"].includes(e.id)));
      ok("Übersicht zählt die eingefügte Mahlzeit mit", (await page.textContent("#app")).includes("Snacks") && (await page.textContent("#app")).includes("408 kcal"));
      await page.click("[data-a=foodAdd][data-m=a]"); await page.click("[data-a=mealDel]");
      ok("Löschen fragt nach", (await page.textContent(".sheet")).includes("Einträge im Tagebuch bleiben erhalten"));
      await page.click("[data-a=mealDelDo]");
      st = await stored(page);
      ok("Mahlzeit gelöscht, Tagebuch unverändert", st.meals.length === 0 && st.food[today].length === 5 && await page.isVisible("#foodQ"));
      ok("Hinzufügen-Sheet bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }

    section("29. Wochenrückblick");
    {
      const pad = n => String(n).padStart(2, "0"), dk = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const now = new Date(), mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(now.getDate() - (now.getDay() + 6) % 7);
      const at = (days, h) => { const d = new Date(mon); d.setDate(mon.getDate() + days); d.setHours(h, 0, 0, 0); return d.toISOString(); };
      const X = (exId, name, u, sets) => ({ exId, name, u, planned: sets.length, rmin: 8, rmax: 12, sets: sets.map(([kg, reps]) => ({ kg, reps })) });
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "d1", name: "Brust", items: [{ id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 0 }, { id: "i2", exId: "hs-fly", sets: 1, rmin: 8, rmax: 12, rest: 0 }] },
        { id: "d2", name: "Beine", items: [{ id: "i3", exId: "hs-legpress", sets: 1, rmin: 8, rmax: 12, rest: 0 }] },
        { id: "d3", name: "Rücken", items: [{ id: "i4", exId: "hs-row", sets: 2, rmin: 8, rmax: 12, rest: 0 }] }] };
      const history = [
        { id: "h0", dayId: "d1", day: "Brust", date: at(-21, 1), durationSec: 1800, exercises: [X("hs-chest", "Brustpresse", "s", [[40, 10], [40, 10]])] },
        { id: "h1", dayId: "d1", day: "Brust", date: at(-7, 1), durationSec: 1800, exercises: [X("hs-chest", "Brustpresse", "s", [[42.5, 10], [42.5, 10]])] },
        { id: "h2", dayId: "d1", day: "Brust", date: at(0, 1), durationSec: 2400, exercises: [X("hs-chest", "Brustpresse", "s", [[45, 8], [45, 8]]), X("hs-fly", "Butterfly", "b", [[30, 12]])] },
        { id: "h3", dayId: "d2", day: "Beine", date: at(0, 2), durationSec: 1200, exercises: [X("hs-legpress", "Beinpresse", "t", [[100, 10]])] }];
      const food = { [dk(mon)]: [{ id: "f1", m: "f", n: "Haferflocken", src: "usda:173904", g: 100, per: { k: 379, p: 13.2, c: 67.7, f: 6.52 } }] };
      const tue = new Date(mon); tue.setDate(mon.getDate() + 1);
      const data = { plan, history, food, water: { [dk(mon)]: 1500 }, nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "halten" },
        weights: [{ d: dk(mon), kg: 80.4 }, { d: dk(tue), kg: 80 }] };
      const { ctx, page } = await open(data);
      const ws = await tp(page, () => { const s = window.__tp.weekStats(0), p = window.__tp.weekStats(1); return { n: s.n, goal: s.goal, sets: s.sets, vol: s.vol, pvol: s.pvol, prs: s.prs, min: s.min, food: s.food, water: s.water, pprs: p.prs, pn: p.n }; });
      ok("Woche: 2 von 3 Trainings, 4 Sätze, 60 Min.", ws.n === 2 && ws.goal === 3 && ws.sets === 4 && ws.min === 60, JSON.stringify(ws));
      ok("Volumen nach derselben Regel wie im Verlauf (2 × 45 × 8 × 2 Seiten + 360 + 1.000 = 2.800 kg; Vorwoche 1.700 kg)", ws.vol === 2800 && ws.pvol === 1700);
      ok("Neue Bestwerte nur bei Steigerung gegenüber allem davor (Brustpresse 42,5 → 45; erstes Mal Butterfly zählt nicht)",
        ws.prs.length === 1 && ws.prs[0].kg === 45 && ws.prs[0].from === 42.5 && ws.pprs.length === 1 && ws.pprs[0].kg === 42.5 && ws.pprs[0].from === 40);
      ok("Ernährung und Wasser aus Tagen mit Einträgen", ws.food.n === 1 && Math.round(ws.food.k) === 379 && ws.food.hit === 0 && ws.water === 1500);
      ok("„Heute“ zeigt den Rückblick-Einstieg", (await page.textContent("#homeWeekSec")).includes("2 von 3") && await page.isVisible("#homeWeek"));
      await page.click("#homeWeek");
      const txt = await page.textContent("#app");
      ok("Rückblick: Trainings, Sätze, Volumen mit Vergleich zur Vorwoche (+65 %)", (await page.textContent("#weekTrain")).includes("2") && (await page.textContent("#weekTrain")).includes("+65 % zur Vorwoche"));
      ok("Bestwert mit vorherigem Wert", (await page.textContent("#weekTrain")).includes("vorher 42,5 kg") && (await page.textContent("#weekTrain")).includes("45 kg pro Seite"));
      ok("Hinweise ergeben sich aus den Zahlen", txt.includes("Noch 1 Training bis zum Wochenziel") && txt.includes("1 neuer Bestwert")
        && txt.includes("Eiweiß lag im Schnitt 115 g unter deinem Ziel von 128 g"));
      ok("Laufende Woche, Wochenziel offen: noch keine Bewertung der Sätze", !txt.includes("obwohl im Plan") && !txt.includes("Weniger Sätze als im Plan") && !(await page.$("#weekPlanLow")));
      ok("Ernährung: Ø kcal mit Ziel, Eiweißziel an 0 von 1 Tagen, Ø Wasser 1,5 L", (await page.textContent("#weekFood")).includes("379") && (await page.textContent("#weekFood")).includes("an 0 von 1 Tagen") && (await page.textContent("#weekFood")).includes("1,5"));
      ok("Gewicht: Veränderung der Woche mit ehrlichem Hinweis auf Schwankungen", (await page.textContent("#weekWeight")).includes("80,4 → 80 kg") && (await page.textContent("#weekWeight")).includes("−0,4 kg") && (await page.textContent("#weekWeight")).includes("Trend über mehrere Wochen"));
      ok("Link zum passenden Trainingswissen (Eiweiß)", !!(await page.$("#weekHints [data-a=openArt][data-id=eiweiss]")));
      ok("Rückblick bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=weekNav][data-d='1']");
      const prev = await page.textContent("#app");
      ok("Abgeschlossene Woche: geplante Muskeln ohne Satz, Plan unter Richtwert mit Weg zur Planprüfung", prev.includes("obwohl im Plan: Rücken, Beine vorn")
        && (await page.textContent("#weekPlanLow")).includes("Brust und Schultern: Dein Plan sieht weniger als 10 Sätze pro Woche vor") && !!(await page.$("#weekPlanLow [data-a=tab][data-v=plan]"))
        && !!(await page.$("#weekHints [data-a=openArt][data-id=volumen]")));
      await page.click("[data-a=weekNav][data-d='-1']");
      ok("Keine Zukunft: nächste Woche gesperrt", await page.isDisabled("[data-a=weekNav][data-d='-1']"));
      await page.click("[data-a=weekNav][data-d='1']");
      ok("Letzte Woche: 1 Training, Bestwert 40 → 42,5", (await page.textContent(".head")).includes("Letzte Woche") && (await page.textContent("#weekTrain")).includes("vorher 40 kg"));
      await page.click("[data-a=weekNav][data-d='-1']");
      await page.click("#weekHints [data-a=openArt][data-id=eiweiss]"); await page.click("[data-a=artBack]");
      ok("Artikel → zurück zum Rückblick", (await page.textContent(".head")).includes("Wochenrückblick"));
      await page.click("[data-a=weekBack]");
      ok("Zurück führt zu „Heute“", await page.isVisible("#homeWeek"));
      await page.click("[data-a=tab][data-v=history]"); await page.click("#histWeek");
      ok("Auch aus dem Verlauf erreichbar; zurück zum Verlauf", (await page.textContent(".head")).includes("Wochenrückblick"));
      await page.click("[data-a=weekBack]");
      ok("Zurück führt zum Verlauf", await page.isVisible("#histWeek"));
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 1)] }, { light });
      await page.click("#homeWeek");
      ok(`360 px ${light ? "hell" : "dunkel"}: Rückblick ohne seitliches Scrollen`, await noOverflow(page) && await page.isVisible("#weekTrain"));
      await ctx.close();
    }

    section("30. Intervallfasten");
    {
      const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
      const { ctx, page } = await open({ plan: PLAN_SMALL, fast: { s: ago(2), h: 17 }, fasts: [{ s: ago(50), e: ago(60), h: 16 }, { s: ago(40), e: ago(23), h: 16 }], fastH: 99 });
      const cl = await tp(page, () => { const s = window.__tp.state; return { fast: s.fast, n: s.fasts.length, h: s.fastH, fmt: window.__tp.fmtHM(16 * 3600e3 + 5 * 60e3) }; });
      ok("Ungültige Daten verworfen (Ziel 17 h, Ende vor Beginn, unbekannte Vorgabe)", cl.fast === null && cl.n === 1 && cl.h === 16);
      ok("Zeitformat: 16 h 5 min", cl.fmt === "16 h 5 min");
      await page.click("[data-a=tab][data-v=food]");
      const box = await page.textContent("#fastBox");
      ok("Fasten-Bereich mit Vorgaben 14:10 bis 20:4 und Vorsichtshinweis", (await page.$$("[data-a=fastPick]")).length === 4 && box.includes("16:8") && box.includes("Schwangerschaft") && box.includes("Diabetes"));
      ok("Letzte Fastenzeit mit Ergebnis", (await page.textContent("#fastLast")).includes("17 h 0 min") && (await page.textContent("#fastLast")).includes("Ziel erreicht"));
      await page.click("[data-a=fastPick][data-h='18']");
      ok("Vorgabe wählbar und gespeichert", (await stored(page)).fastH === 18 && (await page.textContent("[data-a=fastStart]")).includes("18 Stunden"));
      await page.click("[data-a=fastStart]");
      let st = await stored(page);
      ok("Start: läuft mit 18 h Ziel", st.fast && st.fast.h === 18 && Math.abs(Date.now() - new Date(st.fast.s)) < 10000 && (await page.textContent("#fastNow")).includes("0 h 0 min von 18 h"));
      ok("Restzeit und Zielzeit angezeigt", (await page.textContent("#fastBox")).includes("noch 18 h 0 min") || (await page.textContent("#fastBox")).includes("noch 17 h 59 min"));
      // Startzeit ändern: zwei Stunden zurück
      const two = new Date(Date.now() - 2 * 3600e3), hhmm = `${String(two.getHours()).padStart(2, "0")}:${String(two.getMinutes()).padStart(2, "0")}`;
      await page.click("[data-a=fastEdit]"); await page.fill("#fastT", hhmm); await page.click("[data-a=fastEditSave]");
      st = await stored(page);
      const el = (Date.now() - new Date(st.fast.s)) / 3600e3;
      ok("Startzeit geändert (vor 2 Stunden)", el > 1.95 && el < 2.05 && (await page.textContent("#fastNow")).includes("2 h"));
      const later = new Date(Date.now() + 2 * 3600e3), hh2 = `${String(later.getHours()).padStart(2, "0")}:${String(later.getMinutes()).padStart(2, "0")}`;
      await page.click("[data-a=fastEdit]"); await page.fill("#fastT", hh2); await page.click("[data-a=fastEditSave]");
      st = await stored(page);
      const el2 = (Date.now() - new Date(st.fast.s)) / 3600e3;
      ok("Uhrzeit nach jetzt gilt als Vortag (vor 22 Stunden)", el2 > 21.9 && el2 < 22.1 && (await page.textContent("#fastBox")).includes("Ziel erreicht"));
      await page.click("[data-a=fastEnd]");
      st = await stored(page);
      ok("Beenden speichert die Fastenzeit", st.fast === null && st.fasts.length === 2 && st.fasts[1].h === 18 && (await page.textContent("#fastLast")).includes("22 h") && (await page.textContent("#fastLast")).includes("Ziel erreicht"));
      ok("Statistik der letzten Fastenzeiten", (await page.textContent("#fastLast")).includes("2 von 2 der letzten Fastenzeiten mit erreichtem Ziel"));
      await page.click("[data-a=fastStart]"); await page.click("[data-a=fastEnd]");
      ok("Versehentlicher Start (unter 1 Minute) wird nicht gespeichert", (await stored(page)).fasts.length === 2);
      await page.click("#fastBox [data-a=openArt]");
      const art = await page.textContent("#app");
      ok("Artikel: ehrliche Einordnung mit Quellen und Vorsichtshinweis", art.includes("nicht besser als eine tägliche Kalorienreduktion") && art.includes("0,6 kg") && art.includes("Essstörungen")
        && (await page.$$eval(".srcs a", a => a.map(x => x.href))).some(h => h.includes("30583725")) && (await page.$$(".srcs a")).length === 2);
      await page.click("[data-a=artBack]");
      ok("Zurück zur Ernährung", await page.isVisible("#fastBox"));
      ok("Fasten-Bereich bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      // Wochenrückblick
      await page.click("[data-a=tab][data-v=history]");
      await tp(page, () => { const s = window.__tp.state; s.history.push({ id: "x", dayId: "d1", day: "Test", date: new Date().toISOString(), durationSec: 60, exercises: [] }); });
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=history]"); await page.click("#histWeek");
      const fw = await page.textContent("#weekFast").catch(() => "");
      const expect = await tp(page, () => { const s = window.__tp.weekStats(0); return s.fasts; });
      ok("Wochenrückblick zählt Fastenzeiten der Woche", expect && fw.includes(`${expect.n} ${expect.n === 1 ? "Fastenzeit" : "Fastenzeiten"}, davon ${expect.hit} mit erreichtem Ziel`), fw);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, fast: { s: new Date(Date.now() - 16.5 * 3600e3).toISOString(), h: 16 } });
      await page.click("[data-a=tab][data-v=food]");
      ok("Laufendes Fasten übersteht Neuladen; Ziel erreicht nach 16,5 h", (await page.textContent("#fastNow")).includes("16 h 30 min") && (await page.textContent("#fastBox")).includes("Ziel erreicht"));
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, fast: { s: new Date(Date.now() - 5 * 3600e3).toISOString(), h: 20 } }, { light });
      await page.click("[data-a=tab][data-v=food]");
      ok(`360 px ${light ? "hell" : "dunkel"}: laufendes Fasten ohne seitliches Scrollen`, await noOverflow(page) && await page.isVisible("#fastNow"));
      await ctx.close();
    }

    section("31. Aufbau der App: ein Zweck, klare Bereiche");
    {
      const pr = [hist("hs-chest", [{ kg: 40, reps: 10 }], 9, "s"), hist("hs-chest", [{ kg: 42.5, reps: 10 }, { kg: 42.5, reps: 10 }], 2, "s")];   // 2 Sätze: Brust gilt als belastet
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: pr, hints: { units: true } });
      const tabs = await page.$$eval("#tabs button", b => b.map(x => [x.dataset.v, x.textContent.trim()]));
      ok("Fünf Bereiche: Heute, Plan, Wissen, Essen, Fortschritt", JSON.stringify(tabs) === JSON.stringify([["home", "Heute"], ["plan", "Plan"], ["lib", "Wissen"], ["food", "Essen"], ["history", "Fortschritt"]]), JSON.stringify(tabs));
      const home = await page.textContent("#app");
      ok("„Heute“ ohne Ballast: keine Erholung, kein Bestwert, kein Artikel, keine Übungsliste", !(await page.$("#app [data-a=showRec]")) && !(await page.$("#homeBest")) && !(await page.$("#homeArt")) && !(await page.$("#todayPlan")) && home.length > 0);
      await page.click("#exBtn");
      ok("„2 Übungen ›“ öffnet die Übungen mit Gewichten (42,5 kg pro Seite)", (await page.textContent(".sheet #todayPlan")).includes("Brustpresse") && (await page.textContent(".sheet #todayPlan")).includes("42,5 kg pro Seite"));
      await page.keyboard.press("Escape");
      ok("Wochenrückblick über „Diese Woche“ erreichbar", await page.isVisible("#homeWeek"));
      await page.click("[data-a=tab][data-v=plan]");
      const plan = await page.textContent("#app");
      ok("„Plan“: Trainingstage, Geräte im Studio und Erholung, keine Datensicherung oder Bibliothek dazwischen", (await page.textContent(".head")).includes("Mein Plan") && !!(await page.$("#app [data-a=showRec]"))
        && !!(await page.$("#app #devsRow")) && !(await page.$("#app [data-a=exportData]")) && !plan.includes("Übungen & Wissen"));
      await page.click("[data-a=openSettings]");
      const set = await page.textContent("#app");
      ok("Zahnrad öffnet alle Einstellungen an einem Ort", ["Geräte verwalten", "Wasser zählen", "Intervallfasten", "Apple Health", "Apple Watch", "Neuen Plan erstellen", "Sicherung erstellen", "Sicherung wiederherstellen"].every(s => set.includes(s))
        && await page.$eval("#tabs [data-v=plan]", b => b.classList.contains("on")));
      ok("Einstellungen bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      // Essen: Wasser und Fasten nur auf Wunsch
      await page.click("[data-a=tab][data-v=food]");
      ok("„Essen“: Titel „Essen“, Wasser und Fasten standardmäßig aus, mit Hinweis", (await page.textContent(".head .title")) === "Essen" && !(await page.$("#waterBox")) && !(await page.$("#fastBox"))
        && (await page.textContent("#optHint")).includes("Wasser zählen und Intervallfasten"));
      await page.click("#optHint [data-a=openSettings]");
      await page.click("#optWater [data-a=nOpt][data-v='1']"); await page.click("#optFast [data-a=nOpt][data-v='1']");
      ok("Einschalten wird gespeichert", JSON.stringify((await stored(page)).nutrOpt) === '{"water":true,"fast":true}');
      await page.click("[data-a=tab][data-v=food]");
      ok("Danach erscheinen Wasser und Fasten", await page.isVisible("#waterBox") && await page.isVisible("#fastBox") && !(await page.$("#optHint")));
      await page.click("[data-a=fastStart]");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("#optFast [data-a=nOpt][data-v='0']");
      await page.click("[data-a=tab][data-v=food]");
      ok("Laufendes Fasten bleibt sichtbar, auch wenn ausgeschaltet (zum Beenden)", await page.isVisible("#fastBox [data-a=fastEnd]"));
      // Wissen
      await page.click("[data-a=tab][data-v=lib]");
      ok("„Wissen“: Übungen mit Umschalter zu den Artikeln", await page.isVisible("#libQ") && await page.isVisible("#wissenSeg"));
      await page.click("#wissenSeg [data-v=wissen]");
      const art = await page.textContent("#app");
      ok("Artikel nach Training, Ernährung und Gesundheit geordnet", art.includes("Training") && art.includes("Ernährung") && art.includes("Gesundheit") && await page.$eval("#tabs [data-v=lib]", b => b.classList.contains("on")));
      await page.click("[data-a=openArt][data-id=eiweiss]"); await page.click("[data-a=artBack]");
      ok("Artikel → zurück zur Artikelliste im Bereich „Wissen“", await page.isVisible("#wissenSeg") && await page.$eval("#tabs [data-v=lib]", b => b.classList.contains("on")));
      await page.click("[data-a=tab][data-v=history]");
      ok("„Fortschritt“: Wochenrückblick oben", (await page.textContent(".head .title")) === "Fortschritt" && await page.isVisible("#histWeek"));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, water: { "2026-01-01": 500 } });
      ok("Wer Wasser schon genutzt hat, behält es eingeschaltet", (await tp(page, () => window.__tp.state.nutrOpt.water)) === true);
      await tp(page, () => { window.__tp.state.nutrOpt.water = false; });
      const n = await tp(page, () => window.__tp.normalize(JSON.parse(JSON.stringify(window.__tp.state))).nutrOpt.water);
      ok("Bewusst ausgeschaltet bleibt ausgeschaltet, auch mit alten Daten", n === false);
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL }, { light });
      const r = [];
      for (const v of ["home", "plan", "lib", "food", "history"]) { await page.click(`[data-a=tab][data-v=${v}]`); r.push(await noOverflow(page)); }
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); r.push(await noOverflow(page));
      ok(`360 px ${light ? "hell" : "dunkel"}: alle fünf Bereiche und Einstellungen ohne seitliches Scrollen`, r.every(Boolean), r.join());
      await ctx.close();
    }

    section("32. Buddy: Termine, Plan B, Plan-Check, Sprachbegleitung");
    {
      const pad = n => String(n).padStart(2, "0"), wd = d => (d.getDay() + 6) % 7;
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const cs = await tp(page, () => { const c = window.__tp.cleanSched; return [c({ days: [4, 0, 0, 9], time: "18:30" }), c({ days: [], time: "18:00" }), c({ days: [1], time: "25:00" })]; });
      ok("Termine bereinigt (Tage sortiert, doppelte und ungültige entfernt)", JSON.stringify(cs[0].days) === "[0,4]" && cs[0].planB === "next" && cs[1] === null && cs[2] === null);
      ok("Ohne Termine: Buddy schlägt feste Trainingstage vor", (await page.textContent("#buddy")).includes("Noch keine festen Trainingstage") && await page.isVisible("#buddy [data-a=openSched]"));
      await page.click("#buddy [data-a=openSched]");
      ok("Vorschlag passt zum Plan (1 Trainingstag)", (await page.$$("#schedDays .chip.on")).length === 1 && (await page.textContent(".sheet")).includes("1 Trainingstag pro Woche"));
      // heute und morgen auswählen, 23:59
      const today = wd(new Date()), tomorrow = (today + 1) % 7;
      for (const d of [0, 1, 2, 3, 4, 5, 6]) { const on = await page.$eval(`#schedDays [data-d='${d}']`, b => b.classList.contains("on")); if (on !== (d === today || d === tomorrow)) await page.click(`#schedDays [data-d='${d}']`); }
      await page.fill("#schedTime", "23:59"); await page.click("#schedB [data-v=short]"); await page.click("[data-a=schedSave]");
      let st = await stored(page);
      ok("Termine gespeichert (heute und morgen, 23:59, Plan B Kurzversion)", JSON.stringify(st.sched.days) === JSON.stringify([today, tomorrow].sort((a, b) => a - b)) && st.sched.time === "23:59" && st.sched.planB === "short");
      ok("Nach dem Speichern: Angebot für den Kalender", (await page.textContent(".sheet")).includes("In den Kalender eintragen") && (await page.textContent(".sheet")).includes("30 Minuten vorher"));
      await page.click(".sheet [data-a=schedIcs]");
      const ics = await tp(page, () => window.__tp.lastIcs), n = new Date(), ymd = `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}`, codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
      ok("Kalenderdatei: wöchentliche Serie an den gewählten Tagen, erster Termin heute 23:59, Erinnerung 30 Min. vorher",
        ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.includes(`DTSTART:${ymd}T235900`) && ics.includes("RRULE:FREQ=WEEKLY;BYDAY=") && [today, tomorrow].every(d => ics.includes(codes[d]))
        && ics.includes("TRIGGER:-PT30M") && ics.includes("SUMMARY:Training") && ics.includes("Plan B: Kurzversion mit 30 Minuten") && ics.trim().endsWith("END:VCALENDAR"), ics.slice(0, 300));
      await page.keyboard.press("Escape");
      ok("Buddy nennt den heutigen Termin", (await page.textContent("#buddy")).includes("Heute um 23:59: Test") && (await page.textContent("#buddySched")).includes("23:59"));
      // Termin vorbei (nur wenn es spät genug ist)
      const hNow = new Date().getHours();
      if (hNow >= 2) {
        await tp(page, () => { const s = window.__tp.state, d = new Date(Date.now() - 2 * 3600e3); s.sched.time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; });
        await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=home]");
        ok("Termin verpasst: Buddy bietet Plan B an (30-Min.-Version)", (await page.textContent("#buddy")).includes("Dein Termin war um") && (await page.textContent("#buddy")).includes("Plan B: die 30-Minuten-Version"));
        await page.click("#buddy [data-a=openTime30]");
        ok("Plan B öffnet die Zeitanpassung mit 30 Minuten", (await page.textContent(".sheet")).includes("30") && !!(await page.$(".sheet [data-a=timeApply]")));
        await page.keyboard.press("Escape");
      }   // vor 2 Uhr nachts läge „vor 2 Stunden“ am Vortag; denselben Fall prüft Abschnitt E-runde3 mit fester Uhr zu jeder Zeit
      // Training: Termine und Buddy-Check
      await page.click("[data-a=tab][data-v=plan]");
      const curT = await tp(page, () => window.__tp.state.sched.time);
      ok("„Training“ zeigt die Termine mit Plan B", (await page.textContent("#schedRow")).includes(curT) && (await page.textContent("#schedRow")).includes("Kurzversion"));
      const pc = await tp(page, () => window.__tp.planCheck());
      const pcTxt = await page.textContent("#planCheck");
      ok("Planprüfung findet fehlende Muskelgruppen (Rücken fehlt)", pcTxt.includes("Planprüfung") && /Rücken\s*fehlt im Plan/.test(pcTxt) && pc.out.some(o => o.m === "ruecken" && o.v === 0));
      ok("Wochenmenge rechnet mit der Zahl der Termine (2 Termine bei 1 Trainingstag)", pc.per === 2 && pcTxt.includes("2 Termine pro Woche"));
      await page.click("#planCheck [data-a=checkFix][data-m=ruecken]");
      ok("„Übung hinzufügen“ öffnet den Tag mit der Geräteauswahl für Rücken", await page.isVisible("#pickQ") && (await page.getAttribute("#pickMuscle", "data-v")) === "ruecken");
      await page.click(".sheet [data-a=pick][data-id=hs-row]"); await page.keyboard.press("Escape");
      ok("Übung landet im Plan", (await stored(page)).plan.days[0].items.some(i => i.exId === "hs-row"));
      // Artikel
      await page.click("[data-a=tab][data-v=plan]"); await page.click("#schedRow"); await page.click(".sheet [data-a=openArt][data-id=termine]");
      const art = await page.textContent("#app");
      ok("Artikel „Warum feste Termine helfen“ mit 4 Quellen, Plan B und Gewohnheitsdauer", art.includes("Plan B") && art.includes("18 bis 254 Tage") && art.includes("nicht nennenswert zurück")
        && (await page.$$(".srcs a")).length === 4 && (await page.$$eval(".srcs a", a => a.map(x => x.href))).some(h => h.includes("17437199.2011.560095")));
      await page.click("[data-a=artBack]");
      ok("Zurück zum Training", await page.isVisible("#schedRow"));
      await page.click("#schedRow"); await page.click(".sheet [data-a=schedDel]");
      ok("Termine lassen sich entfernen", (await stored(page)).sched === null && (await page.textContent("#schedRow")).includes("Noch keine festen Termine"));
      await ctx.close();
    }
    {
      // Heute erledigt; lange Pause
      const done = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 9 }], 0, "s")] });
      ok("Nach dem Training: „Heute erledigt“ mit Sätzen", (await done.page.textContent("#buddy")).includes("Heute erledigt") && (await done.page.textContent("#buddy")).includes("2 Sätze"));
      await done.ctx.close();
      const gap = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 9, "s")] });
      ok("Nach 9 Tagen Pause: Buddy schlägt die Kurzversion vor", (await gap.page.textContent("#buddy")).includes("Seit 9 Tagen kein Training") && await gap.page.isVisible("#buddy [data-a=openTime30]"));
      await gap.ctx.close();
    }
    {
      // Buddy-Check: ausgewogen, zu viel, zu lang
      const bal = { goal: "aufbau", level: "einsteiger", minutes: null, days: [
        { id: "a", name: "Drücken", items: [{ id: "a1", exId: "hs-chest", sets: 10, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Ziehen", items: [{ id: "b1", exId: "hs-row", sets: 10, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "c", name: "Beine", items: [{ id: "c1", exId: "hs-legpress", sets: 10, rmin: 8, rmax: 12, rest: 90 }, { id: "c2", exId: "hs-seatcurl", sets: 8, rmin: 8, rmax: 12, rest: 90 }, { id: "c3", exId: "hs-hipthrust", sets: 5, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan: bal });
      await page.click("[data-a=tab][data-v=plan]");
      ok("Ausgewogener Plan: Planprüfung bestätigt, nichts darunter", (await page.textContent("#planCheck")).includes("Alle großen Muskelgruppen sind dabei") && !(await page.$("#lowNote")));
      await tp(page, () => { const p = window.__tp.state.plan; p.days[0].items.push({ id: "a2", exId: "hs-incline", sets: 10, rmin: 8, rmax: 12, rest: 90 }, { id: "a3", exId: "hs-fly", sets: 5, rmin: 8, rmax: 12, rest: 90 }); p.minutes = 30; });
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=plan]");
      const t = await page.textContent("#planCheck");
      ok("Zu viel und zu lang: Brust über dem Richtwert, Tag länger als das Zeitbudget", /Brust\s*25 Sätze pro Woche – über dem Richtwert von 10–20/.test(t) && t.includes("bei 30 Min. Zeitbudget"));
      ok("Training mit Buddy-Check bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }
    {
      // Sprachbegleitung
      const plan = JSON.parse(JSON.stringify(PLAN_SMALL)); plan.days[0].items[0].rest = 60;
      const { ctx, page } = await open({ plan, voice: true, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 5, "s")] });
      await page.click("[data-a=start]");
      let said = await tp(page, () => window.__tp.said || []);
      ok("Start: Ansage mit Übung, Satz, Gewicht und Wiederholungen", said.some(x => x.startsWith("Los geht's. Brustpresse. Satz 1 von 2.") && x.includes("Kilo pro Seite") && x.includes("8 bis 12 Wiederholungen")), said.join(" | "));
      await page.fill("#kgIn", "45"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      said = await tp(page, () => window.__tp.said);
      ok("Neuer Bestwert wird angesagt (45 > 40)", said.includes("Neuer Bestwert: 45 Kilo."));
      await tp(page, () => { window.__tp.state.session.restEnd = Date.now() + 10500; });
      await page.waitForFunction(() => (window.__tp.said || []).includes("Noch zehn Sekunden."), null, { timeout: 5000 }).catch(() => {});
      ok("Pausenende wird angekündigt („Noch zehn Sekunden.“)", (await tp(page, () => window.__tp.said)).includes("Noch zehn Sekunden."));
      await page.click("[data-a=skipRest]");
      said = await tp(page, () => window.__tp.said);
      ok("Nach der Pause: nächster Satz", said[said.length - 1].startsWith("Satz 2 von 2."));
      await page.click("[data-a=voiceToggle]");
      ok("Sprachbegleitung im Training abschaltbar", (await stored(page)).voice === false && !(await page.$eval("[data-a=voiceToggle]", b => b.classList.contains("on"))));
      await page.click("[data-a=voiceToggle]");
      ok("… und wieder einschaltbar", (await stored(page)).voice === true && (await tp(page, () => window.__tp.said)).includes("Sprachbegleitung an."));
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      said = await tp(page, () => window.__tp.said);
      ok("Ende: „Training geschafft. Mit neuem Bestwert.“", said[said.length - 1] === "Training geschafft. Mit neuem Bestwert.");
      await page.click(".actionbar [data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      ok("Einstellungen: Termine und Sprachbegleitung", (await page.textContent("#app")).includes("Trainingstermine") && await page.isVisible("#optVoice .switch[data-a=voiceSet][aria-checked=true]"));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=start]");
      ok("Ohne Einschalten keine Ansagen", ((await tp(page, () => window.__tp.said)) || []).length === 0);
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, sched: { days: [0, 2, 4], time: "18:00", planB: "next" } }, { light });
      const a = await noOverflow(page) && await page.isVisible("#buddy");
      await page.click("#buddySched"); const b = await noOverflow(page);
      await page.keyboard.press("Escape"); await page.click("[data-a=tab][data-v=plan]"); const c = await noOverflow(page);
      ok(`360 px ${light ? "hell" : "dunkel"}: Buddy, Termine und Buddy-Check ohne seitliches Scrollen`, a && b && c);
      await ctx.close();
    }

    section("33. Ziele und „Dein Warum“");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const cg = await tp(page, () => { const c = window.__tp.cleanGoals; const ok1 = { kind: "kraft", exId: "hs-chest", target: 50, start: 40, startDate: "2026-01-01T10:00:00Z" };
        return [c([ok1, { kind: "x", target: 50, start: 0 }, { kind: "kraft", exId: "hs-chest", target: 0, start: 0 }, { kind: "gewicht", target: 20, start: 80 }, { kind: "gewicht", target: 75, start: 80, date: "kein Datum" }, null]),
          c(Array.from({ length: 14 }, () => ok1)).length, c("x")]; });
      ok("Ziele bereinigt (ungültige Art, Ziel 0 und Gewicht unter 30 kg entfernt, ungültiges Datum geleert)", cg[0].length === 2 && cg[0][0].u === "t" && cg[0][1].kind === "gewicht" && cg[0][1].date === null && cg[1] === 10 && Array.isArray(cg[2]) && cg[2].length === 0, JSON.stringify(cg[0]));
      await ctx.close();
    }
    {
      // Kraftziel mit Tempo aus den letzten Wochen: 40 → 42,5 → 45 kg pro Seite in drei Wochen
      const { ctx, page } = await open({ plan: PLAN_SMALL, voice: true, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 20, "s"), hist("hs-chest", [{ kg: 42.5, reps: 10 }], 13, "s"), hist("hs-chest", [{ kg: 45, reps: 9 }, { kg: 45, reps: 8 }], 6, "s")] });
      await page.click("[data-a=tab][data-v=history]");
      ok("Fortschritt: Bereich „Deine Ziele“ mit Einladung", await page.isVisible("#goals") && (await page.textContent("#goals")).includes("Noch keine Ziele") && await page.isVisible("#whyAdd"));
      await page.click("#goals [data-a=goalAdd]");
      ok("Neues Ziel: zuletzt trainiertes Gerät vorgewählt, Bestwert angezeigt", (await page.$eval("#gEx", s => s.value)) === "hs-chest" && (await page.textContent("#gBest")).includes("Dein Bestwert: 45 kg pro Seite"));
      await page.selectOption("#gEx", "hs-legpress");
      ok("Gerät gewechselt: ohne Eintrag kein Bestwert, Einheit passt", (await page.textContent("#gBest")).includes("Noch kein Eintrag") && (await page.textContent("label[for=gTarget]")).includes("kg insgesamt"));
      await page.selectOption("#gEx", "hs-chest");
      await page.fill("#gTarget", "40"); await page.click("[data-a=goalSave]");
      ok("Ziel unter dem Bestwert wird abgelehnt", await page.isVisible("#gErr") && (await page.textContent("#gErr")).includes("über deinem Bestwert von 45 kg"));
      await page.fill("#gTarget", "50"); await page.click("[data-a=goalSave]");
      let st = await stored(page);
      ok("Kraftziel gespeichert (Start 45, Ziel 50 kg pro Seite)", st.goals.length === 1 && st.goals[0].kind === "kraft" && st.goals[0].exId === "hs-chest" && st.goals[0].u === "s" && st.goals[0].start === 45 && st.goals[0].target === 50 && !st.goals[0].done && !await page.$(".sheet"));
      const gs = await tp(page, () => { const s = window.__tp.goalStatus(window.__tp.state.goals[0]); return { cur: s.cur, pct: s.pct, left: s.left, days: s.eta ? (s.eta - Date.now()) / 864e5 : null }; });
      ok("Schätzung aus dem Tempo: 2,5 kg pro Woche → 5 kg in etwa 14 Tagen", gs.cur === 45 && gs.pct === 0 && gs.left === 5 && gs.days !== null && Math.abs(gs.days - 14) < 0.5, JSON.stringify(gs));
      const gt = await page.textContent("#goals");
      ok("Zielzeile: Stand, Rest und Schätzung mit Hinweis auf den Trainingsstand", gt.includes("Brustpresse") && gt.includes("45 → 50 kg pro Seite") && gt.includes("Noch 5 kg") && gt.includes("bei deinem Tempo etwa") && gt.includes("hängt vom Trainingsstand ab"));
      await page.click("[data-a=tab][data-v=home]");
      ok("Buddy: „Heute dran: Brustpresse – noch 5 kg bis 50 kg pro Seite“", (await page.textContent("#buddy")).includes("Heute dran: Brustpresse – noch 5 kg bis 50 kg pro Seite"));
      await page.click("[data-a=tab][data-v=history]"); await page.click("#whyAdd");
      ok("Warum: Hinweis mit Quelle (Teixeira 2012)", (await page.textContent(".sheet")).includes("Teixeira PJ") && (await page.textContent(".sheet")).includes("Beobachtungsstudien"));
      await page.fill("#whyIn", "  Fit bleiben für meine Familie  "); await page.click("[data-a=whySave]");
      ok("Warum gespeichert und angezeigt", (await stored(page)).why === "Fit bleiben für meine Familie" && (await page.textContent("#whyLine")).includes("„Fit bleiben für meine Familie“"));
      await page.click("[data-a=tab][data-v=home]");
      ok("Buddy erinnert nach 6 Tagen Pause an das Warum", (await page.textContent("#buddy")).includes("Dein Warum: „Fit bleiben für meine Familie“"));
      await page.click("[data-a=tab][data-v=history]"); await page.click("#goals [data-a=goalEdit]");
      ok("Bearbeiten: Gerät fest, Zielgewicht vorausgefüllt", (await page.textContent(".sheet")).includes("Ziel bearbeiten") && await page.$eval("#gEx", s => s.disabled) && (await page.$eval("#gTarget", i => i.value)) === "50");
      await page.fill("#gTarget", "47,5"); await page.fill("#gDate", "2099-12-31"); await page.click("[data-a=goalSave]");
      st = await stored(page);
      ok("Ziel geändert (47,5 kg, Zieldatum)", st.goals.length === 1 && st.goals[0].target === 47.5 && st.goals[0].date === "2099-12-31" && st.goals[0].start === 45);
      ok("Zieldatum mit Einordnung („auf Kurs“)", (await page.textContent("#goals")).includes("Zieldatum 31. Dezember") && (await page.textContent("#goals")).includes("(auf Kurs)"));
      for (const light of [false, true]) {
        await page.emulateMedia({ colorScheme: light ? "light" : "dark" });
        const a = await noOverflow(page); await page.click("#goals [data-a=goalAdd]"); const b = await noOverflow(page); await page.keyboard.press("Escape");
        ok(`360 px ${light ? "hell" : "dunkel"}: Ziele und Zielformular ohne seitliches Scrollen`, a && b);
      }
      // Ziel im Training erreichen
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      await page.fill("#kgIn", "47,5"); await page.fill("#repsIn", "8"); await page.click("[data-a=doneSet]");
      if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      st = await stored(page);
      const said = await tp(page, () => window.__tp.said);
      ok("Zusammenfassung: „Ziel erreicht“ mit Start und Ziel", await page.isVisible("#goalDone") && (await page.textContent("#goalDone")).includes("45 → 47,5 kg pro Seite") && (await page.textContent("#goalDone")).includes("Geschafft"));
      ok("Ziel als erreicht gespeichert, Ansage „Training geschafft. Ziel erreicht!“", !!st.goals[0].done && said[said.length - 1] === "Training geschafft. Ziel erreicht!", said.slice(-2).join(" | "));
      await page.click(".actionbar [data-a=tab][data-v=home]");
      ok("Buddy feiert das Ziel", (await page.textContent("#buddy")).includes("Ziel erreicht: 47,5 kg pro Seite – Brustpresse"));
      await page.click("[data-a=tab][data-v=history]");
      ok("Erreichtes Ziel in der Liste („Erreicht am …“)", (await page.textContent("#goals")).includes("Erreicht am"));
      await page.reload();
      await page.click("[data-a=tab][data-v=history]");
      ok("Nach Neuladen: Ziel und Warum bleiben erhalten, kein zweites „erreicht“", (await stored(page)).goals[0].done === st.goals[0].done && (await page.textContent("#whyLine")).includes("Fit bleiben"));
      await page.click("#goals [data-a=goalEdit]"); await page.click("[data-a=goalDel]");
      ok("Ziel gelöscht", (await stored(page)).goals.length === 0 && (await page.textContent("#goals")).includes("Noch keine Ziele"));
      await ctx.close();
    }
    {
      // Körpergewicht: −1,7 kg in drei Wochen, Ziel 78 kg
      const pad = n => String(n).padStart(2, "0"), dd = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=tab][data-v=history]"); await page.click("#goals [data-a=goalAdd]"); await page.click("#gKind [data-v=gewicht]");
      ok("Körpergewicht ohne Einträge: Hinweis auf Fortschritt → Körpergewicht", (await page.textContent(".sheet")).includes("Trag zuerst dein Gewicht"));
      await page.fill("#gTarget", "78"); await page.click("[data-a=goalSave]");
      ok("… und Speichern wird abgelehnt", await page.isVisible("#gErr") && ((await stored(page)).goals || []).length === 0);
      await page.keyboard.press("Escape");
      await tp(page, w => { window.__tp.state.weights = w; }, [[21, 82], [14, 81.4], [7, 80.9], [1, 80.3]].map(([n, kg]) => ({ d: dd(n), kg })));
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=history]");
      await page.click("#goals [data-a=goalAdd]"); await page.click("#gKind [data-v=gewicht]");
      ok("Aktuelles Gewicht angezeigt", (await page.textContent(".sheet")).includes("Aktuell: 80,3 kg"));
      await page.fill("#gTarget", "78"); await page.click("[data-a=goalSave]");
      const st = await stored(page);
      const gs = await tp(page, () => { const s = window.__tp.goalStatus(window.__tp.state.goals[0]); return { pct: s.pct, left: s.left, days: s.eta ? (s.eta - Date.now()) / 864e5 : null, reached: s.reached }; });
      ok("Gewichtsziel gespeichert (Start 80,3, Ziel 78) mit Schätzung aus dem Gewichtsverlauf", st.goals[0].kind === "gewicht" && st.goals[0].start === 80.3 && st.goals[0].target === 78 && !gs.reached && Math.abs(gs.left - 2.3) < 1e-9 && gs.days > 14 && gs.days < 60, JSON.stringify(gs));
      ok("Zielzeile Körpergewicht", (await page.textContent("#goals")).includes("Körpergewicht") && (await page.textContent("#goals")).includes("80,3 → 78 kg"));
      await tp(page, d => { window.__tp.state.weights.push({ d, kg: 77.9 }); }, dd(0));
      await page.click("[data-a=tab][data-v=home]");
      ok("Gewicht erreicht: Buddy meldet es", (await page.textContent("#buddy")).includes("Ziel erreicht: 78 kg – Körpergewicht") && !!(await stored(page)).goals[0].done);
      await ctx.close();
    }
    {
      // Gerät auf „insgesamt“ umgestellt: Ziel zieht mit
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3, "s")], goals: [{ id: "g1", kind: "kraft", exId: "hs-chest", u: "s", target: 50, start: 40, startDate: new Date().toISOString() }] });
      const r = await tp(page, () => { const T = window.__tp; T.state.history.forEach(h => h.exercises.forEach(x => { x.u = "t"; })); return T.goalStatus(T.state.goals[0]).cur; });
      ok("Ziel ohne passende Einträge fällt auf den Startwert zurück", r === 40);
      await ctx.close();
    }

    section("34. Der Buddy denkt mit");
    const cpad = n => String(n).padStart(2, "0"), cday = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${cpad(d.getMonth() + 1)}-${cpad(d.getDate())}`; };
    const cmon = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d; })();
    // Termin in Woche w vor der laufenden, Wochentag wd (0 = Mo), Ende um hh:mm
    const at = (w, wd, hh = 19, mm = 0) => { const d = new Date(cmon); d.setDate(cmon.getDate() - w * 7 + wd); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
    const PPL = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
      { id: "a", name: "Drücken", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a2", exId: "hs-shoulder", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
      { id: "b", name: "Ziehen", items: [{ id: "b1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "b2", exId: "hs-pulldown", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
      { id: "c", name: "Beine", items: [{ id: "c1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "c2", exId: "hs-seatcurl", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "c3", exId: "hs-hipthrust", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
    const S3 = (kg, reps) => [0, 1, 2].map(() => ({ kg, reps }));
    const H = (dayId, date, exs, dur = 3600) => ({ id: "h" + Math.random(), dayId, day: { a: "Drücken", b: "Ziehen", c: "Beine" }[dayId], date, durationSec: dur, exercises: exs.map(([exId, sets, u]) => ({ exId, name: exId, u, sets })) });
    {
      // Vorschau auf „Heute“ = dieselben Vorschläge wie beim Start
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 3, "s"), hist("hs-legpress", [{ kg: 100, reps: 10 }], 3, "t")] });
      ok("„Heute“ zeigt keine Übungsliste, sondern „3 Übungen ›“", !(await page.$("#todayPlan")) && (await page.textContent("#exBtn")).includes("3 Übungen"));
      await page.click("#exBtn");
      const rows = await page.$$eval("#todayPlan .li", els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
      ok("Heute: „Dein Training heute“ mit Gewicht, Wiederholungen und Begründung je Übung", rows.length === 3 && rows[0].includes("Brustpresse") && rows[0].includes("2 × 42,5 kg pro Seite") && rows[0].includes("8–12 Wdh.") && rows[0].includes("+2,5 kg")
        && rows[1].includes("1 × 100 kg insgesamt · Ziel 11 Wdh.") && rows[1].includes("+1 Wdh.") && rows[2].includes("Gewicht wählen") && rows[2].includes("neu"), rows.join(" | "));
      await page.click("#todayPlan [data-a=prevWhy][data-n='0']");
      ok("Antippen zeigt die Begründung, „Zurück“ zur Liste", (await page.textContent(".sheet")).includes("Letztes Mal alle 2 Sätze mit 12 Wdh.") && (await page.textContent(".sheet")).includes("So steigert die App"));
      await page.click(".sheet [data-a=openPreview]");
      ok("… zurück in der Übungsliste", (await page.$$(".sheet #todayPlan .li")).length === 3);
      await page.keyboard.press("Escape"); await page.click("[data-a=start]");
      const kg = await tp(page, () => window.__tp.state.session.list.map(l => l.sets[0].kg));
      ok("Training übernimmt genau die Vorschau (42,5 / 100 / leer)", kg[0] === 42.5 && kg[1] === 100 && kg[2] === null, JSON.stringify(kg));
      await finishAllSets(page, 45, 12);
      const nt = await page.textContent("#nextTime");
      ok("Nach dem Training: „Nächstes Mal“ aus diesem Training (47,5 kg pro Seite, +2,5 kg)", nt.includes("Brustpresse") && nt.includes("47,5 kg pro Seite") && nt.includes("+2,5 kg") && nt.includes("So entscheidet die App"), nt.replace(/\s+/g, " ").slice(0, 300));
      await ctx.close();
    }
    {
      // 3 Wochen Pause an einem Gerät: keine Steigerung (Regel der App)
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 25, "s")] });
      await page.click("#exBtn"); const row = (await page.textContent("#todayPlan .li")).replace(/\s+/g, " ");
      await page.click("#todayPlan [data-a=prevWhy][data-n='0']");
      ok("Nach 25 Tagen Pause an der Chest Press: halten statt steigern, mit Begründung", row.includes("2 × 40 kg pro Seite") && row.includes("halten") && (await page.textContent(".sheet")).includes("vor 25 Tagen") && (await page.textContent(".sheet")).includes("Regel der App"), row);
      await ctx.close();
    }
    {
      // Neuer, von der App erzeugter Plan: keine Widersprüche zwischen Plan und Buddy-Check
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp, out = [];
        for (const g of ["aufbau", "kraft", "fit"]) for (const n of [2, 3, 4]) for (const lv of ["einsteiger", "fortgeschritten"]) {
          T.state.plan = T.generatePlan(g, n, lv, 60); const c = T.planCheck().out;
          out.push({ k: `${g}/${n}/${lv}`, ins: T.insights().length, miss: c.filter(x => x.kind === "low" && x.v === 0).length, time: c.filter(x => x.kind === "time").length,
            maxSets: Math.max(...T.state.plan.days.flatMap(d => d.items.map(i => i.sets))) }); }
        return out; });
      ok("App-Pläne: keine fehlende Muskelgruppe, kein Tag über dem Zeitbudget, keine Buddy-Hinweise", r.every(x => x.miss === 0 && x.time === 0 && x.ins === 0), JSON.stringify(r.filter(x => x.miss || x.time || x.ins)));
      ok("App-Pläne: Einsteiger höchstens 3, Fortgeschrittene höchstens 5 Sätze pro Übung", r.every(x => x.maxSets <= (x.k.endsWith("einsteiger") ? 3 : 5)));
      const ms = await tp(page, () => { const T = window.__tp; T.state.plan = T.generatePlan("aufbau", 4, "fortgeschritten", 60); return T.planCheck().out.length; });
      ok("4 Tage, Fortgeschritten: alle Muskelgruppen im Richtwert", ms === 0);
      const full = await tp(page, () => { const T = window.__tp; T.state.sched = null; return [2, 3].map(n => { T.state.plan = T.generatePlan("aufbau", n, "fortgeschritten", 90); return T.planCheck().out.filter(x => x.kind === "low").map(x => x.m); }); });
      ok("2 und 3 Tage, Fortgeschritten, 90 Min.: alle großen Muskelgruppen im Richtwert (auch über mittrainierte Muskeln aufgefüllt)", full.every(a => !a.length), JSON.stringify(full));
      const two = await tp(page, () => window.__tp.generatePlan("aufbau", 2, "einsteiger", 60).days[1].items.map(i => i.exId));
      ok("2-Tage-Plan: Po mit eigener Übung (Hüftheben) statt nur mittrainiert", two.includes("hs-hipthrust"), two.join());
      await ctx.close();
    }
    {
      // Seltener als geplant (2 statt 3 pro Woche, montags und donnerstags) → 2-Tage-Plan vorschlagen; gelernte Trainingszeiten
      const history = []; let k = 0;
      // Kein Training von heute: sonst meldet der Buddy montags und donnerstags ab 19 Uhr „Heute erledigt“ statt der gelernten Zeiten (der Test hing an der Uhrzeit)
      for (let w = 5; w >= 0; w--) for (const wd of [0, 3]) { if (new Date(at(w, wd)) > new Date() || new Date(at(w, wd)).toDateString() === new Date().toDateString()) continue; const d = ["a", "b", "c"][k++ % 3]; history.push(H(d, at(w, wd), [[{ a: "hs-chest", b: "hs-pulldown", c: "hs-legpress" }[d], S3(40 + k, 10), d === "a" ? "s" : "t"]])); }
      const { ctx, page } = await open({ plan: PPL, history });
      const ins = await tp(page, () => window.__tp.insights().map(x => x.id));
      ok("Häufigkeit: „Im Schnitt 2 von 3 Trainings pro Woche“ mit Zählung je Tag", ins.includes("freq:3>2") && (await page.textContent("#coach")).includes("Im Schnitt 2 von 3 Trainings pro Woche") && /Drücken \d×, Ziehen \d× und Beine \d×/.test(await page.textContent("#coach")), ins.join(","));
      ok("Buddy hat die Trainingszeiten gelernt: montags und donnerstags gegen 18:00", (await page.textContent("#buddy")).includes("Du trainierst meistens montags und donnerstags gegen 18:00"));
      await page.click("#buddy [data-a=schedLearned]");
      const on = await page.$$eval("#schedDays .chip.on", e => e.map(x => x.dataset.d));
      ok("… „Als Termine übernehmen“ füllt Mo, Do und 18:00 vor", JSON.stringify(on) === '["0","3"]' && (await page.inputValue("#schedTime")) === "18:00");
      await page.keyboard.press("Escape");
      await page.click("#coach [data-a=coachPlan]");
      ok("Vorschau des 2-Tage-Plans (Ganzkörper A/B)", (await page.textContent(".sheet")).includes("Plan mit 2 Tagen") && (await page.textContent(".sheet")).includes("Ganzkörper A") && (await page.textContent(".sheet")).includes("Ganzkörper B"));
      await page.click("[data-a=coachPlanApply]");
      let st = await stored(page);
      ok("Übernommen: 2 Tage, vorheriger Plan gesichert", st.plan.days.length === 2 && st.prevPlan && st.prevPlan.plan.days.length === 3 && st.prevPlan.why.includes("3 → 2 Trainingstage"));
      ok("Hinweis verschwindet nach dem Übernehmen", !(await tp(page, () => window.__tp.insights().map(x => x.id))).includes("freq:3>2"));
      await page.reload();
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      ok("Hinweise (aus Wissen): Änderung mit „Rückgängig“", await page.isVisible("#undoPlan") && (await page.textContent("#undoPlan")).includes("3 → 2 Trainingstage"));
      await page.click("[data-a=coachUndo]");
      st = await stored(page);
      ok("Rückgängig stellt den 3-Tage-Plan wieder her", st.plan.days.length === 3 && st.plan.days[0].id === "a" && !st.prevPlan);
      ok("So entscheidet die App: alle Regeln offen gelegt", (await page.textContent("#coachRules")).includes("72 Stunden") && (await page.textContent("#coachRules")).includes("3 Wochen oder länger") && (await page.textContent("#coachRules")).includes("ohne deine Bestätigung"));
      for (const light of [false, true]) {
        await page.emulateMedia({ colorScheme: light ? "light" : "dark" });
        const a = await noOverflow(page); await page.click("[data-a=coachBack]"); const b = await noOverflow(page); await page.click("[data-a=tab][data-v=home]"); const c = await noOverflow(page);
        ok(`360 px ${light ? "hell" : "dunkel"}: Analyse, Fortschritt und Heute mit Vorschau ohne seitliches Scrollen`, a && b && c);
        await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      }
      await ctx.close();
    }
    {
      // Stillstand an der Row → Gerät mit gleichem Bewegungsmuster vorschlagen
      const history = [28, 21, 14, 7, 2].map(n => H("b", new Date(Date.now() - n * 864e5).toISOString(), [["hs-row", S3(50, 9), "s"]]));
      const { ctx, page } = await open({ plan: PPL, history });
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      const card = await page.$("[data-ins='plateau:hs-row']");
      const txt = card ? (await card.textContent()).replace(/\s+/g, " ") : "";
      ok("Stillstand erkannt: „Rudern: Stillstand seit 4 Wochen“, 5 Einheiten", txt.includes("Rudern: Stillstand seit 4 Wochen") && txt.includes("5 vollständige Einheiten"), txt.slice(0, 200));
      const to = await page.getAttribute("[data-ins='plateau:hs-row'] [data-a=coachSwap]", "data-to");
      await page.click("[data-ins='plateau:hs-row'] [data-a=coachSwap]");
      const st = await stored(page), ids = st.plan.days.flatMap(d => d.items.map(i => i.exId));
      ok("Tausch mit einem Tipp: Row ersetzt, Sätze bleiben, Änderung gesichert", !!to && !ids.includes("hs-row") && ids.includes(to) && st.plan.days[1].items[0].sets === 3 && st.prevPlan.why.includes("wegen Stillstand"));
      await page.click("[data-a=coachUndo]");
      ok("… und rückgängig", (await stored(page)).plan.days[1].items[0].exId === "hs-row");
      await ctx.close();
    }
    {
      // Beine 15 Tage nicht dran, seitdem 3 andere Trainings
      const history = [H("c", new Date(Date.now() - 15 * 864e5).toISOString(), [["hs-legpress", S3(100, 10), "t"]]),
        H("a", new Date(Date.now() - 10 * 864e5).toISOString(), [["hs-chest", S3(40, 10), "s"]]), H("b", new Date(Date.now() - 7 * 864e5).toISOString(), [["hs-pulldown", S3(40, 10), "t"]]),
        H("a", new Date(Date.now() - 3 * 864e5).toISOString(), [["hs-chest", S3(40, 10), "s"]])];
      const { ctx, page } = await open({ plan: PPL, history });
      ok("„Beine seit 15 Tagen nicht dran“ mit Begründung", (await page.textContent("#coach")).includes("Beine seit 15 Tagen nicht dran") && (await page.textContent("#coach")).includes("Seitdem 3 andere Trainings"));
      await page.click("#coach [data-a=coachDay]");
      ok("„Heute Beine“ wählt den Tag", (await page.textContent(".hero-name")).includes("Beine") && !(await page.textContent("#app")).includes("seit 15 Tagen nicht dran"));
      await ctx.close();
    }
    {
      // Termine: Mittwoch fällt immer aus, Mo und Fr klappen
      const history = []; for (let w = 4; w >= 1; w--) for (const wd of [0, 4]) history.push(H(wd ? "b" : "a", at(w, wd), [[wd ? "hs-pulldown" : "hs-chest", S3(40, 10), wd ? "t" : "s"]]));
      const { ctx, page } = await open({ plan: PPL, history, sched: { id: "s", days: [0, 2, 4], time: "18:00", planB: "next", since: new Date(Date.now() - 50 * 864e5).toISOString() } });
      const hits = await tp(page, () => window.__tp.schedHits());
      ok("Termin-Treffer je Wochentag (Mo 4/4, Mi 0/4, Fr 4/4)", JSON.stringify(hits) === JSON.stringify({ 0: [4, 4], 2: [0, 4], 4: [4, 4] }), JSON.stringify(hits));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      const t = (await page.textContent("[data-ins='wday:2']")).replace(/\s+/g, " ");
      ok("„Mittwochs klappt es selten“: 0 von 4, an den anderen Tagen 8 von 8", t.includes("Mittwochs klappt es selten") && t.includes("0 von 4 Terminen am Mittwoch") && t.includes("8 von 8"), t.slice(0, 200));
      await page.click("[data-ins='wday:2'] [data-a=openSched]");
      ok("… „Termine ändern“ öffnet die Termine", (await page.textContent(".sheet")).includes("Trainingstermine"));
      await ctx.close();
    }
    {
      // Dauer, Ernährung, Eiweiß, Ziel, was gut läuft, Ausblenden
      const history = [30, 24, 17, 10, 4].map((n, i) => H("a", new Date(Date.now() - n * 864e5).toISOString(), [["hs-chest", S3(40 + i * 2.5, 10), "s"], ["hs-shoulder", S3(30, 10), "s"]], 4800));
      const { ctx, page } = await open({ plan: Object.assign({}, PLAN_SMALL, { minutes: 60 }), history, nutr: { sex: "m", age: 34, cm: 180, pal: 1.55, goal: "auf", kcal: null },
        weights: [[25, 80.2], [18, 80.1], [11, 80.0], [4, 80.1]].map(([n, kg]) => ({ d: cday(n), kg })),
        goals: [{ id: "g1", kind: "kraft", exId: "hs-shoulder", u: "s", target: 40, start: 30, startDate: new Date(Date.now() - 40 * 864e5).toISOString(), date: cday(2) }] });
      await tp(page, days => { const s = window.__tp.state; days.forEach(d => { s.food[d] = [{ id: "f" + d, m: "m", n: "Test", src: "", g: null, abs: { k: 2200, p: 60, c: 280, f: 70 } }]; }); }, [1, 2, 3, 4, 5].map(cday));
      const L = await tp(page, () => window.__tp.insights().map(x => [x.id, x.title, x.text]));
      const get = id => L.find(x => x[0].startsWith(id)) || ["", "", ""];
      ok("Dauer: „im Schnitt 80 Min.“ bei 60 Min. Zeitbudget", get("dur")[1] === "Deine Trainings dauern im Schnitt 80 Min." && get("dur")[2].includes("Geplant sind 60 Min."), JSON.stringify(get("dur")));
      ok("Ernährung: „Du nimmst langsamer zu als geplant“ (±0 % pro Woche, Ziel 0,25–0,5 %)", get("trend:auf")[1] === "Du nimmst langsamer zu als geplant" && get("trend:auf")[2].includes("±0 % pro Woche") && get("trend:auf")[2].includes("0,25–0,5 % mehr pro Woche"), JSON.stringify(get("trend")));
      ok("Eiweiß: „im Schnitt 60 g pro Tag“, Ziel 128 g, 5 erfasste Tage", get("prot")[1] === "Eiweiß: im Schnitt 60 g pro Tag" && get("prot")[2].includes("128 g") && get("prot")[2].includes("an 5 erfassten Tagen"), JSON.stringify(get("prot")));
      ok("Ziel mit verstrichenem Datum", get("goal:g1")[1] === "Schulterpresse: Zieldatum verstrichen");
      ok("Was gut läuft: „Mehr Gewicht an 1 von 2 Geräten“ (Chest Press 40 → 50, +25 %)", get("good")[1] === "Mehr Gewicht an 1 von 2 Geräten" && get("good")[2].includes("40 → 50 kg pro Seite") && get("good")[2].includes("+25 %"), JSON.stringify(get("good")));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=home]");
      ok("Heute: ein Hinweis, Link zu allen", (await page.$$("#coach .ins")).length === 1 && (await page.textContent("#coach")).includes("Alle"));
      const first = await page.getAttribute("#coach .ins", "data-ins");
      await page.click("#coach .insd summary"); await page.click("#coach .ins [data-a=coachHide]"); // „Ausblenden“ steht in der aufgeklappten Erklärung
      ok("Ausblenden: Hinweis weg und gespeichert", !(await page.$(`#coach [data-ins='${first}']`)) && !!(await stored(page)).coachOff[first]);
      await page.click("#coach [data-a=openCoach]");
      ok("Analyse: „1 ausgeblendet – wieder zeigen“", (await page.textContent("#app")).includes("1 ausgeblendet – wieder zeigen") && !!(await page.$("#coachGood")));
      await page.click("[data-a=coachShowAll]");
      ok("… wieder eingeblendet", !!(await page.$(`[data-ins='${first}']`)) && Object.keys((await stored(page)).coachOff).length === 0);
      await page.click(`[data-ins='dur:60'] [data-a=coachMinutes]`);
      ok("„Zeitbudget 90 Min.“ übernommen", (await stored(page)).plan.minutes === 90);
      await page.click(`[data-ins='trend:auf'] [data-a=openNutr]`);
      ok("„Kalorienziel anpassen“ öffnet das Ernährungsziel", await page.isVisible(".sheet"));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, prevPlan: { at: "kaputt", plan: {} }, coachOff: { "x": "2000-01-01T00:00:00Z", "y": new Date().toISOString() } });
      const st = await tp(page, () => ({ p: window.__tp.state.prevPlan, o: window.__tp.state.coachOff }));
      ok("Ungültige Planänderung verworfen, alte Ausblendungen aufgeräumt", st.p === null && Object.keys(st.o).join() === "y");
      await ctx.close();
    }

    section("35. Satz-Coach im Training");
    {
      const plan = JSON.parse(JSON.stringify(PLAN_SMALL)); plan.days[0].items[0].sets = 3; plan.days[0].items[0].rest = 60;
      const { ctx, page } = await open({ plan, voice: true, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3, "s")] });
      await page.click("[data-a=start]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Satz im Ziel (10 bei 8–12): kein Vorschlag", !(await page.$("#setAdv")));
      await page.click("[data-a=feel][data-f=l]");
      ok("„Leicht“ unter dem oberen Ziel: weiterhin kein Vorschlag", !(await page.$("#setAdv")));
      await page.click("[data-a=skipRest]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "15"); await page.click("[data-a=doneSet]");
      const t = await page.textContent("#setAdv");
      ok("15 Wdh. (Ziel 8–12): „Mehr Gewicht?“ mit 42,5 kg für den letzten Satz", t.includes("Mehr Gewicht?") && t.includes("15 Wdh. bei 40 kg – über deinem Ziel von 8–12") && t.includes("Für den letzten Satz: 42,5 kg pro Seite (+2,5 kg)"), t.replace(/\s+/g, " "));
      const said = await tp(page, () => window.__tp.said);
      ok("Sprachbegleitung nennt Bestwert (15 statt höchstens 10 Wdh.) und Vorschlag", said[said.length - 2] === "Neuer Bestwert: 15 Wiederholungen mit 40 Kilo." && said[said.length - 1] === "Vorschlag: mehr Gewicht, 42,5 Kilo.", said.slice(-2).join(" | "));
      ok("360 px: Pause mit Vorschlag ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=advApply]");
      let sets = await tp(page, () => window.__tp.state.session.list[0].sets.map(x => x.kg));
      ok("Übernommen: restlicher Satz 42,5 kg, Vorschlag verschwindet", JSON.stringify(sets) === "[40,40,42.5]" && !(await page.$("#setAdv")) && (await page.textContent(".next")).includes("42,5"));
      await page.click("[data-a=skipRest]");
      await page.fill("#repsIn", "11"); await page.click("[data-a=doneSet]");
      if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      await finishAllSets(page, 100, 10);
      const h = (await stored(page)).history.pop(), cx = h.exercises.find(x => x.exId === "hs-chest");
      ok("Im Verlauf gekennzeichnet: im Training angepasst", cx.adv === true && JSON.stringify(cx.sets.map(x => x.kg)) === "[40,40,42.5]");
      ok("Nächstes Mal: alle Sätze mit 42,5 kg statt wieder 40", (await page.textContent("#nextTime")).includes("42,5 kg pro Seite") && (await page.textContent("#nextTime")).includes("im Training angepasst"));
      await page.click(".actionbar [data-a=tab][data-v=home]");
      await page.click("#exBtn"); const row = (await page.textContent("#todayPlan .li")).replace(/\s+/g, " ");
      ok("Vorschau: 3 × 42,5 kg, Kennzeichen +2,5 kg", row.includes("3 × 42,5 kg pro Seite") && row.includes("+2,5 kg"), row);
      await ctx.close();
    }
    {
      const plan = JSON.parse(JSON.stringify(PLAN_SMALL)); plan.days[0].items[0].sets = 3; plan.days[0].items[0].rest = 60;
      const { ctx, page } = await open({ plan, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3, "s")] });
      await page.click("[data-a=start]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "5"); await page.click("[data-a=doneSet]");
      ok("5 Wdh. (Ziel 8–12): „Weniger Gewicht?“ mit 37,5 kg für die restlichen 2 Sätze", (await page.textContent("#setAdv")).includes("Weniger Gewicht?") && (await page.textContent("#setAdv")).includes("die restlichen 2 Sätze: 37,5 kg"));
      await page.click("[data-a=advSkip]");
      ok("„So lassen“: Vorschlag weg, Gewicht unverändert", !(await page.$("#setAdv")) && JSON.stringify(await tp(page, () => window.__tp.state.session.list[0].sets.map(x => x.kg))) === "[40,40,40]");
      await page.click("[data-a=feel][data-f=h]");
      ok("… und bleibt weg, auch nach einer Bewertung", !(await page.$("#setAdv")));
      await page.click("[data-a=skipRest]");
      await page.fill("#repsIn", "12"); await page.click("[data-a=doneSet]"); await page.click("[data-a=feel][data-f=l]");
      ok("Am oberen Ziel und „leicht“: Vorschlag +2,5 kg", (await page.textContent("#setAdv")).includes("am oberen Ziel und „leicht“"));
      await page.click("[data-a=skipRest]");
      await page.fill("#repsIn", "20"); await page.click("[data-a=doneSet]");
      ok("Letzter Satz einer Übung: kein Vorschlag mehr", !(await page.$("#setAdv")));
      await ctx.close();
    }
    {
      // Pyramide ohne Satz-Coach bleibt satzweise (keine pauschale Steigerung)
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 45, reps: 10 }], 3, "s")] });
      await page.click("#exBtn"); await page.click("#todayPlan [data-a=prevWhy][data-n='0']");
      ok("Unterschiedliche Gewichte ohne Anpassung im Training: weiter satzweise", (await page.textContent(".sheet")).includes("Gewichte satzweise übernommen"));
      await ctx.close();
    }

    section("36. Tricks je Gerät und kürzere Anleitung");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Mix", items: [
        { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-curl", sets: 3, rmin: 8, rmax: 12, rest: 60 },
        { id: "i3", exId: "hs-seatcurl", sets: 2, rmin: 8, rmax: 12, rest: 60 }] }] };
      const { ctx, page } = await open({ plan, hints: { units: true } });
      const tr = await tp(page, () => { const T = window.__tp, devs = T.allEx().filter(e => !e.id.startsWith("c-")), all = devs.flatMap(e => T.tricksFor(e).map(k => ({ id: e.id, t: k.t, short: k.short, s: k.s })));
        const dup = f => Object.entries(all.reduce((a, k) => { (a[k[f]] = a[k[f]] || []).push(k.id); return a; }, {})).filter(([, v]) => v.length > 1).map(([k, v]) => `${k} (${v.join(", ")})`);
        const it = (exId, sets = 3) => ({ exId, sets: Array.from({ length: sets }, () => ({})) });
        return { n: devs.map(e => T.tricksFor(e).length), dupT: dup("t"), dupShort: dup("short"), dupS: dup("s"), gen: T.GEN_TRICKS.map(k => k.t),
          generic: all.filter(k => ["Nah ans Limit", "Dehnung mitnehmen", "Pause nicht zu knapp", "Einstellung merken", "Drop-Satz spart Zeit"].includes(k.t)).length,
          seat: T.tricksFor(T.ex("hs-seatcurl"))[0].s, curl: T.tricksFor(T.ex("hs-curl"))[1].s, inc: T.tricksFor(T.ex("hs-incline"))[0].s, seatWhy: T.GUIDE["hs-seatcurl"].why, incWhy: T.GUIDE["hs-incline"].why,
          now: [T.trickNow(it("hs-chest"), 0).t, T.trickNow(it("hs-chest"), 1).t, T.trickNow(it("hs-chest"), 2).t], custom: T.tricksFor({ id: "c-x" }).length }; });
      ok("Jedes der 60 Geräte hat eigene Tricks (mindestens einen)", tr.n.length === 60 && tr.n.every(n => n >= 1), JSON.stringify(tr.n));
      ok("Kein Trick steht bei zwei Geräten (Titel, Kurztext und Erklärung jeweils einmalig)", !tr.dupT.length && !tr.dupShort.length && !tr.dupS.length, [...tr.dupT, ...tr.dupShort, ...tr.dupS].join(" | "));
      ok("Allgemeine Grundsätze nicht mehr bei den Geräten, sondern einmal gesammelt", tr.generic === 0 && tr.gen.includes("Nah ans Limit") && tr.gen.includes("Drop-Satz am Steckgewicht"));
      ok("Studienbelege einmal pro Seite: Armbeuger im Trick (+12,4 %), Beinbeuger sitzend und Schräge Brustpresse unter „Warum“ statt doppelt im Trick", tr.curl.includes("+12,4 %") && tr.seatWhy.includes("Studie") && tr.incWhy.includes("45°") && !tr.seat.includes("%") && !tr.inc.includes("45°"));
      ok("Im Training wechseln die Tricks des Geräts von Satz zu Satz", tr.now[0] !== tr.now[1] && tr.now[2] === tr.now[0], JSON.stringify(tr.now));
      const ov = await tp(page, () => { const T = window.__tp, STOP = new Set("der die das und oder nicht mit ohne auf zu zur zum im in an am den dem des ein eine einen einer bis so dass wie auch nur noch dann wenn beim bei vor nach über unter du dich dir sich es ist sind wird werden bleibt bleiben kurz sehr mehr weniger etwas leicht ganz voll halten".split(" "));
        const words = s => new Set(s.toLowerCase().replace(/[^a-zäöüß ]/g, " ").split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)).map(w => w.replace(/(en|er|es|e|n|s)$/, "")));
        const sim = (a, b) => { const A = words(a), B = words(b); let i = 0; A.forEach(w => B.has(w) && i++); return i / Math.max(1, Math.min(A.size, B.size)); };
        const out = [];
        for (const e of T.allEx().filter(x => !x.id.startsWith("c-"))) { const g = T.GUIDE[e.id];
          const items = [...(T.TIPS[e.id] || []), g.why, ...g.setup, ...g.steps, ...g.mistakes.map(([f, k]) => f + " – " + k), ...g.tips.filter(x => !T.GENERIC_TIPS.has(x))];
          T.tricksFor(e).forEach(k => items.forEach(s => { const v = sim(k.short + " " + k.s, s); if (v >= 0.7) out.push(`${e.id}: ${k.t} ~ ${s.slice(0, 60)}`); })); }
        return out; });
      ok("Kein Trick wiederholt, was auf derselben Geräteseite schon steht", ov.length === 0, ov.slice(0, 4).join(" | "));
      ok("Eigene Geräte ohne erfundene Tricks", tr.custom === 0);
      const ab = await tp(page, () => Object.values(window.__tp.ABOUT_X));
      ok("Jedes Gerät hat eine eigene Kurzbeschreibung (60, keine doppelt)", ab.length === 60 && new Set(ab).size === 60);
      await page.click("[data-a=tab][data-v=lib]");
      const subs = await page.$$eval("#app .group .li .s", e => e.map(x => x.textContent.trim()));
      ok("Übungsliste: keine Beschreibung doppelt", subs.length >= 28 && new Set(subs).size === subs.length, subs.slice(0, 6).join(" | "));
      await page.click("[data-a=openEx][data-id=hs-legpress]");
      const alts = await page.$$eval("#app .group .li .s", e => e.map(x => x.textContent.trim()).filter(Boolean));
      ok("Alternativen: jede mit eigener Beschreibung, nichts wortgleich", alts.length >= 3 && new Set(alts).size === alts.length && !alts.some(s => s.includes("Widerstandsverlauf")), alts.join(" | "));
      await page.click("[data-a=exBack]");
      await page.click("[data-a=tab][data-v=home]");
      await page.click("[data-a=start]");
      ok("Training: Trick der Brustpresse für den ersten Satz", (await page.textContent("#trickNow")).includes("Halt die Ellbogen knapp unter Schulterhöhe"));
      ok("360 px: Training mit Trick ohne seitliches Scrollen", await noOverflow(page));
      await page.click("#trickNow");
      ok("Antippen: Tricks der Brustpresse, der aktuelle aufgeklappt", (await page.textContent(".sheet")).includes("Tricks: Brustpresse") && await page.isVisible(".sheet details[data-trick=x0][open]") && (await page.$$(".sheet details.trk")).length === 2);
      await page.click(".sheet [data-a=genTricks]");
      ok("„Für alle Übungen“: Grundsätze mit Quelle, einmal gesammelt", (await page.textContent(".sheet")).includes("Nah ans Limit") && (await page.textContent(".sheet")).includes("Robinson"));
      await page.click(".sheet [data-a=genTricksBack]");
      ok("Zurück zu den Tricks des Geräts", (await page.textContent(".sheet")).includes("Tricks: Brustpresse"));
      await page.keyboard.press("Escape");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      ok("Zweiter Satz: der andere Trick der Brustpresse", (await page.textContent("#trickNow")).includes("Halt hinten eine Sekunde, dann drück"));
      await page.click(".tool[data-a=openDevInfo]");
      ok("Gerät & Technik: So geht's und die zwei Tricks des Geräts", (await page.textContent(".sheet")).includes("So geht's") && (await page.$$("#devTricks details.trk")).length === 2);
      await page.click("text=Ausführliche Anleitung");
      const g = await page.textContent(".sheet");
      ok("Anleitung: „Tricks für dieses Gerät“, getrennte Seiten als Eigenschaft, Details eingeklappt", await page.isVisible("text=Tricks für dieses Gerät") && await page.isVisible("#isoNote") && !(await page.$(".sheet .gdet[open]")));
      ok("„Weitere Tipps“ ohne die bei vielen Geräten gleichen Texte", !g.includes("Beide Arme bewegen sich unabhängig voneinander") && !g.includes("Einarmig trainieren: Den freien Arm"));
      await page.click(".sheet .gdet summary >> text=Häufige Fehler");
      ok("„Häufige Fehler“ aufklappen zeigt Fehler mit Korrektur", await page.isVisible("text=Nutz den ganzen Weg, solange er schmerzfrei ist."));
      for (const light of [false, true]) { await page.emulateMedia({ colorScheme: light ? "light" : "dark" }); ok(`360 px ${light ? "hell" : "dunkel"}: Anleitung ohne seitliches Scrollen`, await noOverflow(page)); }
      await ctx.close();
    }

    section("37. Hindernisse: warum ein Training ausfällt");
    const mday = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const mwd = n => (new Date(Date.now() - n * 864e5).getDay() + 6) % 7;
    const WDL = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const cm = await tp(page, () => window.__tp.cleanMisses([{ d: "2026-01-05", r: "zeit" }, { d: "2026-01-05", r: "lust" }, { d: "kaputt", r: "zeit" }, { d: "2026-01-06", r: "x" }, null, { d: "2026-01-07", r: "krank" }]));
      ok("Gründe bereinigt: ungültige Daten und Gründe weg, ein Eintrag pro Tag", JSON.stringify(cm) === JSON.stringify([{ d: "2026-01-05", r: "zeit" }, { d: "2026-01-07", r: "krank" }]), JSON.stringify(cm));
      await ctx.close();
    }
    {
      // Termin vor 2 Tagen verpasst, danach kein Training → der Buddy fragt nach
      const sched = { id: "s", days: [mwd(2)], time: "18:00", planB: "next", since: mday(20) + "T00:00:00.000Z" };
      const { ctx, page } = await open({ plan: PLAN_SMALL, sched, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 9, "s")] });
      ok("Buddy fragt: „Was war am … los?“ mit sechs Gründen", (await page.textContent("#missAsk")).includes(`Was war am ${WDL[mwd(2)]} los?`) && (await page.$$("#missAsk .chip")).length === 6);
      ok("360 px: Frage ohne seitliches Scrollen", await noOverflow(page));
      await page.click("#missAsk [data-a=missSkip]");
      ok("„Nicht jetzt“: Frage weg, gemerkt", !(await page.$("#missAsk")) && (await stored(page)).missSkip === mday(2));
      await tp(page, () => { window.__tp.state.missSkip = null; }); await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=home]");
      await page.click("#missAsk [data-a=missSet][data-r=zeit]");
      const st = await stored(page);
      ok("Grund gespeichert, Frage verschwindet", JSON.stringify(st.misses) === JSON.stringify([{ d: mday(2), r: "zeit" }]) && !(await page.$("#missAsk")));
      await page.reload();
      ok("Nach Neuladen keine zweite Frage zum selben Tag", !(await page.$("#missAsk")) && (await stored(page)).misses.length === 1);
      await ctx.close();
    }
    {
      // Am Folgetag nachgeholt → keine Frage
      const sched = { id: "s", days: [mwd(2)], time: "18:00", planB: "next", since: mday(20) + "T00:00:00.000Z" };
      const { ctx, page } = await open({ plan: PLAN_SMALL, sched, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 1, "s")] });
      ok("Plan B hat geklappt (am Tag danach trainiert): keine Nachfrage", !(await page.$("#missAsk")) && (await tp(page, () => window.__tp.missToAsk())) === null);
      await ctx.close();
    }
    {
      // Heute absagen (Termin heute, Uhrzeit noch nicht erreicht)
      const sched = { id: "s", days: [mwd(0)], time: "23:59", planB: "next", since: mday(20) + "T00:00:00.000Z" };
      const { ctx, page } = await open({ plan: PLAN_SMALL, sched, why: "Fit bleiben" });
      ok("Am Termintag: „Heute fällt aus“ als Link", await page.isVisible("#buddy [data-a=missToday]"));
      await page.click("#buddy [data-a=missToday]");
      ok("Sheet mit den sechs Gründen", (await page.textContent(".sheet")).includes("Heute fällt aus") && (await page.$$(".sheet [data-a=missSet]")).length === 6);
      await page.click(".sheet [data-a=missSet][data-r=krank]");
      let b = await page.textContent("#buddy");
      ok("Krank: Buddy wünscht gute Besserung, kein Plan B, kein Drängen", b.includes("Heute fällt aus.") && b.includes("gute Besserung") && !b.includes("Plan B") && !b.includes("Kurzversion") && !(await page.$("#missAsk")));
      await page.click("#buddy [data-a=missUndo]");
      ok("„Doch trainieren“: Absage zurückgenommen", (await stored(page)).misses.length === 0 && (await page.textContent("#buddy")).includes("Heute um 23:59"));
      await page.click("#buddy [data-a=missToday]"); await page.click(".sheet [data-a=missSet][data-r=lust]");
      b = await page.textContent("#buddy");
      ok("Keine Lust: Buddy nennt dein Warum und bietet die Kurzversion an", b.includes("Keine Lust – kommt vor. Dein Warum: „Fit bleiben“.") && await page.isVisible("#buddy [data-a=openTime30]"));
      ok("Heute kein Training gezählt, Absage gespeichert", (await stored(page)).misses[0].d === mday(0) && (await stored(page)).misses[0].r === "lust");
      await ctx.close();
    }
    {
      // Krank vor 2 Tagen ohne Termine: kein „Seit 10 Tagen kein Training“
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 10, "s")], misses: [{ d: mday(2), r: "krank" }] });
      const b = await page.textContent("#buddy");
      ok("Nach Krankheit: „Erst mal gesund werden“ statt Vorwurf", b.includes("Erst mal gesund werden.") && b.includes(WDL[mwd(2)]) && !b.includes("kein Training") && !(await page.$("#missAsk")));
      await ctx.close();
    }
    {
      // Ohne Termine, 8 Tage Pause: einmal pro Woche nachfragen
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 8, "s")] });
      ok("Ohne Termine nach 8 Tagen: „Was hält dich gerade vom Training ab?“", (await page.textContent("#missAsk")).includes("Was hält dich gerade vom Training ab?"));
      await page.click("#missAsk [data-a=missSet][data-r=zeit]");
      const b = await page.textContent("#buddy");
      ok("Antwort „Keine Zeit“: Buddy bietet heute die Kurzversion an", b.includes("Heute Pause.") && b.includes("Kurzversion") && await page.isVisible("#buddy [data-a=openTime30]") && (await stored(page)).misses[0].d === mday(0));
      await ctx.close();
    }
    {
      // Analyse: häufigstes Hindernis, Plan B passend; krank zählt nicht
      const sched = { id: "s", days: [mwd(3)], time: "19:00", planB: "next", since: mday(40) + "T00:00:00.000Z" };
      const misses = [{ d: mday(3), r: "zeit" }, { d: mday(10), r: "zeit" }, { d: mday(17), r: "lust" }, { d: mday(24), r: "krank" }];
      const { ctx, page } = await open({ plan: PLAN_SMALL, sched, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 30, "s")], misses });
      const L = await tp(page, () => window.__tp.insights().filter(x => x.id.startsWith("barrier")).map(x => [x.id, x.title, x.text, x.act[0].l]));
      ok("Analyse: „Dein häufigstes Hindernis: Keine Zeit“, 2 von 4 Ausfällen (krank zählt nicht als Hindernis), Plan B Kurzversion", L.length === 1 && L[0][0] === "barrier:zeit" && L[0][2].includes("2 von 4 Ausfällen in 6 Wochen") && L[0][3] === "Plan B: Kurzversion", JSON.stringify(L));
      const hits = await tp(page, () => { const T = window.__tp, a = T.schedHits(); const keep = T.state.misses; T.state.misses = []; const b = T.schedHits(); T.state.misses = keep; return [a, b]; });
      const tot = h => Object.values(h).reduce((s, v) => s + v[1], 0);
      ok("Termin-Treffer: der kranke Tag zählt nicht als verpasst", tot(hits[0]) === tot(hits[1]) - 1, JSON.stringify(hits));
      await tp(page, () => { window.__tp.state.sched.planB = "short"; window.__tp.state.misses = [{ d: window.__tp.state.misses[0].d, r: "muede" }, { d: window.__tp.state.misses[1].d, r: "muede" }]; });
      const L2 = await tp(page, () => window.__tp.insights().filter(x => x.id.startsWith("barrier")).map(x => x.text));
      ok("Zu müde bei Abendtermin: Hinweis auf früheren Termin", L2.length === 1 && L2[0].includes("Dein Termin liegt um 19:00") && L2[0].includes("Kurzversion"), JSON.stringify(L2));
      await tp(page, () => { window.__tp.state.misses = [{ d: window.__tp.state.misses[0].d, r: "krank" }, { d: window.__tp.state.misses[1].d, r: "weg" }]; });
      ok("Nur krank und unterwegs: kein Hindernis-Hinweis", (await tp(page, () => window.__tp.insights().filter(x => x.id.startsWith("barrier")).length)) === 0);
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      ok("So entscheidet die App: Regel „Hindernisse“", (await page.textContent("#coachRules")).includes("Krank, verletzt oder unterwegs zählt nicht als verpasst"));
      await ctx.close();
    }

    {
      // Trainingsfreier Tag: Ziel-Hinweis für das nächste Training statt „Heute ist … dran“; Ausfall als Fakt und in der Woche
      const sched = { id: "s", days: [mwd(-1)], time: "18:00", planB: "next", since: mday(20) + "T00:00:00.000Z" };
      const { ctx, page } = await open({ plan: PLAN_SMALL, sched, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 2, "s")], misses: [{ d: mday(1), r: "zeit" }],
        goals: [{ id: "g1", kind: "kraft", exId: "hs-chest", u: "s", target: 50, start: 40, startDate: mday(2) + "T10:00:00.000Z" }] });
      const b = await page.textContent("#buddy");
      ok("Trainingsfrei: „Beim nächsten Mal: Brustpresse – noch 10 kg bis 50 kg pro Seite“, kein „Heute ist … dran“", b.includes("Heute ist trainingsfrei") && b.includes("Beim nächsten Mal: Brustpresse – noch 10 kg bis 50 kg pro Seite") && !b.includes("Heute ist die"), b.replace(/\s+/g, " "));
      ok("Gestriger Ausfall als Fakt: „… ausgefallen – keine Zeit“", b.includes(`${WDL[mwd(1)]} ausgefallen – keine Zeit`));
      ok("Wochenleiste: ausgefallener Tag markiert", mwd(1) > mwd(0) ? true : (await page.$$(".week .dot.miss")).length === 1);
      ok("Übungen hinter „N Übungen ›“, nicht als Liste auf „Heute“", !(await page.$("#todayPlan")) && await page.isVisible("#exBtn"));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      ok("Ohne Verlauf keine Liste auf „Heute“", !(await page.$("#todayPlan")));
      await ctx.close();
    }

    section("38. Vorausdenken im Training");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 15, days: [{ id: "d1", name: "Drücken", items: [
        { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 120 }, { id: "i2", exId: "hs-shoulder", sets: 3, rmin: 8, rmax: 12, rest: 120 }, { id: "i3", exId: "hs-lateral", sets: 3, rmin: 8, rmax: 12, rest: 120 }] }] };
      const { ctx, page } = await open({ plan, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 3, "s")] });
      await page.click("[data-a=start]");
      const rm = await tp(page, () => [document.getElementById("remain").textContent, window.__tp.remainMin(window.__tp.state.session)]);
      ok("Kopfzeile zeigt die geschätzte Restzeit unter der Uhr", rm[0] === `≈ ${rm[1]} Min.` && rm[1] >= 20, JSON.stringify(rm));
      const wu = await page.textContent("#warmup");
      ok("Vor dem ersten Satz: zwei Aufwärmsätze (50 % und 75 % von 42,5 kg, auf Schritte gerundet)", wu.includes("Erst aufwärmen") && wu.includes("22,5 × 10") && wu.includes("32,5 × 5") && wu.includes("nicht eintragen") && wu.includes("Danach 42,5 kg pro Seite"), wu.replace(/\s+/g, " "));
      await page.click("[data-a=warmDone]");
      ok("„Aufgewärmt“ blendet den Schritt aus und merkt es in der Sitzung", !(await page.$("#warmup")) && (await stored(page)).session.warmDone === true);
      await page.fill("#kgIn", "42,5"); await page.fill("#repsIn", "11"); await page.click("[data-a=doneSet]");
      ok("Pause: derselbe Satz vom letzten Mal zum Vergleich (40 × 12), darüber der Bestwert statt „heute mehr“", (await page.textContent("#vsLast")) === "Letztes Mal Satz 1: 40 × 12" && (await page.textContent("#livePr")).includes("42,5 kg pro Seite – mehr Gewicht als je zuvor"));
      const th = await page.textContent("#timeHint");
      ok("Zeitbudget 15 Min. deutlich überschritten: Angebot zu kürzen, mit Zahlen", th.includes("über deinem Zeitbudget") && th.includes("Geplant 15 Min.") && th.includes("Auf 15 Min. kürzen"), th.replace(/\s+/g, " "));
      ok("360 px: Pause mit Vergleich und Zeit-Hinweis ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=timeHintOff]");
      ok("„Egal, weiter“: Hinweis weg und bleibt weg", !(await page.$("#timeHint")) && (await stored(page)).session.timeHintOff === true);
      await page.click("[data-a=skipRest]"); await page.fill("#repsIn", "11"); await page.click("[data-a=doneSet]");
      ok("… auch nach dem nächsten Satz", !(await page.$("#timeHint")) && !(await page.$("#warmup")));
      await ctx.close();
    }
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 15, days: [{ id: "d1", name: "Drücken", items: [
        { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 120 }, { id: "i2", exId: "hs-shoulder", sets: 3, rmin: 8, rmax: 12, rest: 120 }, { id: "i3", exId: "hs-lateral", sets: 3, rmin: 8, rmax: 12, rest: 120 }] }] };
      const { ctx, page } = await open({ plan });
      await page.click("[data-a=start]");
      ok("Ohne bekanntes Gewicht kein Aufwärm-Vorschlag", !(await page.$("#warmup")));
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("#timeHint [data-a=timeFit]");
      const st = await stored(page), sets = st.session.list.reduce((a, l) => a + l.sets.length, 0);
      ok("„Auf 15 Min. kürzen“: Rest gekürzt, erledigter Satz bleibt, Anpassung vermerkt", st.session.timeAdj && st.session.timeAdj.minutes === 15 && sets < 9 && st.session.list[0].sets.filter(s => s.done).length === 1 && !(await page.$("#timeHint")), `${sets} Sätze`);
      ok("Restzeit passt jetzt ins Budget", (await tp(page, () => (Date.now() - window.__tp.state.session.start) / 60000 + window.__tp.remainingSec(window.__tp.state.session) / 60)) <= 15.5);
      await ctx.close();
    }
    {
      // Vier Wochen Pause an einem Gerät: ein Schritt leichter
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 30, "s")] });
      await page.click("#exBtn"); const row = (await page.textContent("#todayPlan .li")).replace(/\s+/g, " ");
      await page.click("#todayPlan [data-a=prevWhy][data-n='0']");
      ok("Nach 30 Tagen: 37,5 statt 40 kg, als Regel der App begründet", row.includes("2 × 37,5 kg pro Seite") && row.includes("−2,5 kg") && (await page.textContent(".sheet")).includes("Nach vier Wochen Pause ein Schritt leichter") && (await page.textContent(".sheet")).includes("Regel der App"), row);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 25, "s")] });
      await page.click("#exBtn");
      ok("Bei 25 Tagen weiterhin nur halten", (await page.textContent("#todayPlan .li")).replace(/\s+/g, " ").includes("2 × 40 kg pro Seite"));
      await page.keyboard.press("Escape");
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      ok("So entscheidet die App: Regel „Vorausdenken im Training“ und Wiedereinstieg", (await page.textContent("#coachRules")).includes("Vorausdenken im Training") && (await page.textContent("#coachRules")).includes("ab 4 Wochen ein Schritt leichter"));
      await ctx.close();
    }

    section("39. Wochenplan voraus");
    {
      const PPL3 = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Drücken", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Ziehen", items: [{ id: "b1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "c", name: "Beine", items: [{ id: "c1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const w0 = mwd(0), schedDays = [w0, w0 + 1, w0 + 2].filter(d => d <= 6);           // heute und die nächsten Tage dieser Woche
      const sched = { id: "s", days: schedDays, time: "23:59", planB: "next", since: mday(20) + "T00:00:00.000Z" };
      const { ctx, page } = await open({ plan: PPL3, sched, history: [] });
      const labels = await page.$$eval(".week .wp", els => els.map(e => e.textContent));
      const expect = Array(7).fill(""); ["Drücken", "Ziehen", "Beine"].forEach((n, i) => { if (schedDays[i] !== undefined) expect[schedDays[i]] = n; });
      ok("Wochenleiste: kommende Termine mit dem Trainingstag laut Ablauf (Drücken, Ziehen, Beine)", JSON.stringify(labels) === JSON.stringify(expect), JSON.stringify([labels, expect]));
      const wl = await page.textContent("#weekLeft");
      ok("„Noch diese Woche: Drücken, Ziehen, Beine“", wl.includes("Noch diese Woche: Drücken, Ziehen, Beine"), wl);
      ok("Countdown bis zum Termin heute", /In (\d+ Std\.|\d+ Min\.)/.test(await page.textContent("#buddy")) && (await page.textContent("#buddy")).includes("· ca. "), await page.textContent("#buddy"));
      ok("360 px: Wochenleiste mit Namen ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }
    {
      // Drücken heute erledigt: Name unter dem heutigen Tag, Rest der Woche rückt weiter
      const PPL3 = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Drücken", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Ziehen", items: [{ id: "b1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "c", name: "Beine", items: [{ id: "c1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const w0 = mwd(0), later = [w0 + 1, w0 + 2].filter(d => d <= 6);
      const sched = { id: "s", days: [w0, ...later], time: "23:59", planB: "next", since: mday(20) + "T00:00:00.000Z" };
      const h = { id: "h1", dayId: "a", day: "Drücken", date: new Date().toISOString(), durationSec: 1800, exercises: [{ exId: "hs-chest", name: "x", u: "s", sets: [{ kg: 40, reps: 10 }] }] };
      const { ctx, page } = await open({ plan: PPL3, sched, history: [h] });
      const labels = await page.$$eval(".week .wp", els => els.map(e => e.textContent + (e.classList.contains("done") ? "*" : "")));
      const expect = Array(7).fill(""); expect[w0] = "Drücken*"; ["Ziehen", "Beine"].forEach((n, i) => { if (later[i] !== undefined) expect[later[i]] = n; });
      ok("Erledigter Tag markiert, kommende Termine rücken im Ablauf weiter (Ziehen, Beine)", JSON.stringify(labels) === JSON.stringify(expect), JSON.stringify([labels, expect]));
      ok("„Noch diese Woche: Ziehen, Beine“", (await page.textContent("#weekLeft")).includes("Noch diese Woche: Ziehen, Beine"));
      await ctx.close();
    }
    {
      // Ohne Termine: keine Tageszuordnung, aber „Noch diese Woche“ mit Hinweis; Wochenziel erreicht → keine Zeile
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [] });
      ok("Ohne Termine keine Namen unter den Tagen, aber „Noch diese Woche: Test – ohne feste Termine …“", (await page.$$eval(".week .wp", els => els.every(e => !e.textContent))) && (await page.textContent("#weekLeft")).includes("Noch diese Woche: Test – ohne feste Termine"));
      await tp(page, () => { window.__tp.state.history.push({ id: "h", dayId: "d1", day: "Test", date: new Date().toISOString(), durationSec: 600, exercises: [{ exId: "hs-chest", name: "x", u: "s", sets: [{ kg: 40, reps: 10 }] }] }); });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=home]");
      ok("Wochenziel erreicht: keine „Noch diese Woche“-Zeile, erledigter Tag trägt seinen Namen", !(await page.$("#weekLeft")) && (await page.$$eval(".week .wp.done", els => els.map(e => e.textContent))).join() === "Test");
      await ctx.close();
    }

    section("40. Ein Zweck, keine Widersprüche");
    {
      const { ctx, page } = await open(null);
      const on = async () => page.$$eval("#setupDays .chip.on", e => e.map(x => x.dataset.d).join(","));
      ok("Einrichtung fragt die Trainingstage (Vorschlag Mo, Mi, Fr) und die Uhrzeit", (await on()) === "0,2,4" && (await page.textContent("#setupDaysTxt")).includes("3 Tage · Drücken · Ziehen · Beine") && await page.isVisible("#setupTime"));
      await page.click("#setupDays [data-d='1']");
      ok("Vierter Tag → 4-Tage-Plan", (await on()) === "0,1,2,4" && (await page.textContent("#setupDaysTxt")).includes("4 Tage · Oberkörper A"));
      for (const d of ["1", "2", "4"]) await page.click(`#setupDays [data-d='${d}']`);
      await page.click("[data-a=createPlan]");
      ok("Ein Tag: Hinweis „Bitte 2 bis 4 Tage wählen“, kein Plan", (await page.textContent("#setupDaysTxt")).includes("Bitte 2 bis 4 Tage wählen") && !(await stored(page) || {}).plan);
      for (const d of ["2", "4"]) await page.click(`#setupDays [data-d='${d}']`);
      await page.fill("#setupTime", "07:30"); await page.click("[data-a=createPlan]");
      const st = await stored(page);
      ok("Plan und Termine in einem Schritt (Mo, Mi, Fr um 07:30, Plan B: nächster Tag)", st.plan.days.length === 3 && JSON.stringify(st.sched.days) === "[0,2,4]" && st.sched.time === "07:30" && st.sched.planB === "next");
      const b = await page.textContent("#buddy");
      ok("„Heute“ fragt nicht noch einmal nach Trainingstagen", !b.includes("Noch keine festen Trainingstage") && (await page.textContent("#buddySched")).includes("Mo, Mi, Fr · 07:30"));
      ok("Neuer Nutzer: kein Hinweis „Gewicht pro Seite“, keine Erholung, keine Artikelzeile", !(await page.$("[data-a=hintUnitsOpen]")) && !(await page.$("[data-a=showRec]")) && !(await page.$("#homeArt")));
      await page.click("[data-a=tab][data-v=plan]");
      const pc = await page.textContent("#planCheck");
      ok("Planprüfung kritisiert den eigenen Plan nicht: keine „+ Übung“-Alarme, Erklärung statt Warnung", !(await page.$("#planCheck [data-a=checkFix]")) && pc.includes("Alle großen Muskelgruppen sind dabei") && (await page.textContent("#lowNote")).includes("Einsteiger-Pläne starten mit höchstens 3 Sätzen pro Übung"));
      ok("Training-Tab ohne Erholungskarte, wenn alles erholt ist", !(await page.$("[data-a=showRec]")));
      await page.click("[data-a=tab][data-v=history]");
      const f = await page.textContent("#app");
      ok("Fortschritt ohne Verlauf: keine Null-Werte (Volumen, Muskelbelastung, Kalender) und keine zweite Hinweis-Seite", !f.includes("Trainingsvolumen") && !f.includes("Muskelbelastung") && !f.includes("Kalender") && !(await page.$("#histCoach")) && !f.includes("Buddy-Analyse"));
      for (const light of [false, true]) { await page.emulateMedia({ colorScheme: light ? "light" : "dark" }); await page.click("[data-a=tab][data-v=home]"); const a1 = await noOverflow(page); await page.click("[data-a=tab][data-v=plan]"); const a2 = await noOverflow(page);
        ok(`360 px ${light ? "hell" : "dunkel"}: Heute und Training ohne seitliches Scrollen`, a1 && a2); }
      await ctx.close();
    }
    {
      // Frage nach dem Grund und Hinweis gleichzeitig: nur eine Karte
      const sched = { id: "s", days: [mwd(2)], time: "18:00", planB: "next", since: mday(40) + "T00:00:00.000Z" };
      const history = [28, 21, 14, 9].map(n => hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], n, "s"));
      const { ctx, page } = await open({ plan: PLAN_SMALL, sched, history });
      const hasIns = (await tp(page, () => window.__tp.insights().length)) > 0;
      ok("Frage und Hinweis gleichzeitig fällig: nur die Frage steht auf „Heute“", hasIns && await page.isVisible("#missAsk") && !(await page.$("#coach")));
      await page.click("#missAsk [data-a=missSet][data-r=zeit]");
      ok("Nach der Antwort rückt der Hinweis nach", await page.isVisible("#coach") && !(await page.$("#missAsk")));
      await ctx.close();
    }

    section("41. Alles auf Deutsch, neue Muskelkarte");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [{ id: "h", dayId: "d1", day: "Push", date: new Date(Date.now() - 2 * 864e5).toISOString(), durationSec: 1800,
        exercises: [{ exId: "hs-chest", name: "Iso-Lateral Chest Press", sets: [{ kg: 40, reps: 10 }] }] }] });
      const L = await tp(page, () => window.__tp.allEx().filter(e => !e.id.startsWith("c-")).map(e => [e.id, e.name, e.label]));
      ok("Alle 60 Geräte mit deutschem Namen, Bezeichnung am Gerät getrennt gespeichert", L.length === 60 && L.every(([, n, l]) => n && l && n !== l && !/Press|Row|Curl|Raise|Squat|Pulldown|Delt|Fly\b|Crunch|Thrust|Extension|Dip\b/.test(n)), JSON.stringify(L.filter(([, n]) => /Press|Row|Curl/.test(n))));
      ok("Gewicht pro Seite bleibt an der Gerätebezeichnung (Brustpresse: pro Seite, Beinpresse: insgesamt)", await tp(page, () => window.__tp.unitOf(window.__tp.ex("hs-chest")) === "s" && window.__tp.unitOf(window.__tp.ex("hs-legpress")) === "t" && window.__tp.unitOf(window.__tp.ex("hs-legext")) === "s"));
      const st = await tp(page, () => window.__tp.state);
      ok("Gespeicherte Einträge auf Deutsch umgestellt (Gerät und Trainingstag „Push“ → „Drücken“)", st.history[0].exercises[0].name === "Brustpresse" && st.history[0].day === "Drücken");
      await page.click("[data-a=tab][data-v=lib]"); await page.fill("#libQ", "chest press");
      ok("Suche findet auch die Bezeichnung am Gerät (chest press → Brustpresse)", (await page.textContent("#app")).includes("Brustpresse"));
      await page.fill("#libQ", ""); await page.click("[data-a=openEx][data-id=hs-row]");
      ok("Geräteseite: deutscher Name, darunter „Am Gerät steht: Iso-Lateral Row“", (await page.textContent(".head .title")) === "Rudern" && (await page.textContent("#exLabel")) === "Am Gerät steht: Iso-Lateral Row");
      ok("Anleitung: Bewegungsanimation statt Muskelkarte, Hauptmuskel rot", !!(await page.$("#gMotion svg.motion")) && !(await page.$(".gfig .fig")) && (await page.$$eval("#gMotion svg [stroke='var(--mhot)'], #gMotion svg [fill='var(--mhot)']", e => e.length)) >= 1);
      await page.click("[data-a=exBack]");
      const thumbs = await page.$$eval("#libList .thumbbox svg.motion", e => e.length);
      ok("Übungsliste: kleines Bild der Bewegung je Gerät (ohne Animation)", thumbs === 60 && !(await page.$("#libList svg.motion[data-anim]")), String(thumbs));
      for (const light of [false, true]) { await page.emulateMedia({ colorScheme: light ? "light" : "dark" }); ok(`360 px ${light ? "hell" : "dunkel"}: Übungsliste mit Vorschaubildern ohne seitliches Scrollen`, await noOverflow(page)); }
      await ctx.close();
    }

    section("42. Keine wortgleichen Texte bei verschiedenen Geräten");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const G = window.__tp.GUIDE, seen = {}, dup = [];
        const add = (k, s, id) => { const key = k + "|" + s; if (seen[key] && seen[key] !== id) dup.push(`${k}: ${s} (${seen[key]}, ${id})`); seen[key] = seen[key] || id; };
        for (const [id, g] of Object.entries(G)) { g.setup.forEach(s => add("Einstellen", s, id)); g.steps.forEach(s => add("Ausführung", s, id));
          g.mistakes.forEach(([, k]) => add("Korrektur", k, id)); g.safety.forEach(s => add("Sicherheit", s, id)); }
        return dup; });
      ok("Einstellen, Ausführung, Korrekturen und gerätebezogene Sicherheit: kein Satz bei zwei Geräten", r.length === 0, r.slice(0, 5).join(" | "));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-row]"); await page.$$eval("details", d => d.forEach(x => x.open = true));
      const t1 = await page.textContent("#app");
      ok("Geräteseite ohne allgemeine Atmung, Schmerz- und Scheibenhinweise und ohne Modellhinweis", !t1.includes("Beim Ziehen ausatmen") && !t1.includes("Schmerz ist ein Stoppsignal") && !t1.includes("Scheiben vor dem ersten Satz prüfen") && !t1.includes("Modellgeneration"));
      await page.click("[data-a=genTricks]");
      const g = await page.textContent(".sheet");
      ok("„Für alle Übungen“: Atmung, Sicherheit an jedem Gerät und Modellhinweis einmal gesammelt", g.includes("Beim Ziehen ausatmen") && g.includes("Schmerz ist ein Stoppsignal") && g.includes("Scheiben vor dem ersten Satz prüfen") && g.includes("Modellgeneration"));
      await page.click(".sheet [data-a=genTricksBack]");
      ok("„Zurück“ schließt das Blatt, wenn es von der Geräteseite kam", !(await page.$(".sheet")));
      await page.click("[data-a=tab][data-v=plan]");
      ok("Planprüfung statt „Plan-Check“", (await page.textContent("#planCheck")).includes("Planprüfung") && !(await page.textContent("#app")).includes("Plan-Check"));
      await ctx.close();
    }

    section("43. Trainingsbildschirm auf kleinen iPhones");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 45, days: [{ id: "d1", name: "Ziehen", items: [{ id: "i1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-pulldown", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const H = n => ({ id: "h" + n, dayId: "d1", day: "Ziehen", date: new Date(Date.now() - n * 864e5).toISOString(), durationSec: 2700, exercises: [{ exId: "hs-row", name: "Rudern", u: "s", planned: 3, rmin: 8, rmax: 12, sets: [0, 1, 2].map(() => ({ kg: 50, reps: 9 })) }] });
      const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, serviceWorkers: "block" });
      await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan, hints: { units: true }, history: [28, 21, 14, 7, 2].map(H) })]);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message)); await page.goto(URL);
      await page.click("[data-a=start]");
      const pos = await page.evaluate(() => { const r = id => document.getElementById(id) && document.getElementById(id).getBoundingClientRect(); const bar = document.querySelector(".actionbar").getBoundingClientRect();
        return { warm: r("warmup") && r("warmup").top, kg: r("kgIn").top, reps: r("repsIn").bottom, bar: bar.top, trick: !!document.getElementById("trickNow") }; });
      ok("375 × 667: Aufwärmen steht vor den Eingabefeldern, Gewicht und Wiederholungen ohne Scrollen über „Satz fertig“", pos.warm < pos.kg && pos.reps <= pos.bar, JSON.stringify(pos));
      ok("Solange das Aufwärmen offen ist, kein zusätzlicher Trick", !pos.trick);
      ok("Stillstand als eine Zeile mit „Gerät tauschen“, Einzelheiten unter „Warum?“", (await page.textContent("#plateauHint")).replace(/\s+/g, " ").trim().length < 90 && await page.isVisible("#plateauHint [data-a=openSwap]"));
      await page.click("[data-a=warmDone]");
      ok("Nach dem Aufwärmen erscheint der Trick des Geräts", await page.isVisible("#trickNow") && !(await page.$("#warmup")));
      ok("375 px: ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }

    section("44. Datensicherung");
    {
      const six = [20, 16, 12, 9, 6, 3].map(d => hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], d, "s"));
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: six });
      const ins = await tp(page, () => window.__tp.insights().find(x => x.id === "backup"));
      ok("6 Trainings ohne Sicherung: Hinweis mit „Jetzt sichern“", !!ins && ins.title === "6 Trainings, noch keine Sicherung" && ins.act[0].a === "backupFile");
      ok("Auf „Heute“ als Hinweis", (await page.textContent("#coach")).includes("noch keine Sicherung"));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      ok("Regel der Erinnerung steht unter „So entscheidet die App“", (await page.textContent("#coachRules")).includes("5 Trainings dazugekommen und mindestens 14 Tage"));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      ok("Einstellungen: „Noch keine · 6 Trainings ungesichert“ und Hinweis zum Speicher", (await page.textContent("#backupLine")).includes("6 Trainings ungesichert") && (await page.textContent("#persistInfo")).includes("nur in diesem Browser"));
      await page.click("[data-a=exportData]");
      ok("Sicherung erstellen: Datei zuerst, Text eingeklappt", await page.isVisible(".sheet [data-a=backupFile]") && !(await page.isVisible("#expTxt")) && (await page.textContent(".sheet")).includes("In Dateien sichern"));
      // Ohne Teilen-Menü (Desktop-Chromium): Download der Datei
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click(".sheet [data-a=backupFile]")]);
      const fp = await dl.path(), file = JSON.parse(require("fs").readFileSync(fp, "utf8"));
      const today = await tp(page, () => window.__tp.dkey());
      ok("Datei „trainingsplan-sicherung-JJJJ-MM-TT.json“ mit allen Trainings", dl.suggestedFilename() === `trainingsplan-sicherung-${today}.json` && file.app === "trainingsplan" && file.data.history.length === 6 && !("session" in file.data));
      let st = await stored(page);
      ok("Zeitpunkt der Sicherung gespeichert und in der Datei enthalten", !!st.backupAt && file.data.backupAt === st.backupAt);
      ok("Bestätigung im Sheet, Hinweis verschwindet", (await page.textContent("#bkMsg")).includes("Heruntergeladen") && !(await tp(page, () => window.__tp.insights().some(x => x.id === "backup"))));
      await page.click(".sheet >> text=Schließen");
      ok("Einstellungen: „Zuletzt am … · aktuell“", (await page.textContent("#backupLine")).includes("aktuell"));
      // Teilen-Menü (iPhone): abgebrochen → keine Sicherung vermerkt, geteilt → vermerkt
      await page.evaluate(() => { localStorage.setItem("trainingsplan-v2", JSON.stringify(Object.assign(JSON.parse(localStorage.getItem("trainingsplan-v2")), { backupAt: null })));
        navigator.canShare = () => true; navigator.share = () => Promise.reject(new DOMException("abgebrochen", "AbortError")); });
      await page.evaluate(() => { window.__tp.state.backupAt = null; });
      await page.click("[data-a=exportData]"); await page.click(".sheet [data-a=backupFile]"); await page.waitForTimeout(150);
      ok("Teilen abgebrochen: nichts als gesichert vermerkt", (await stored(page)).backupAt === null);
      await page.evaluate(() => { navigator.share = d => { window.__tp.shared = d.files[0].name; return Promise.resolve(); }; });
      await page.click(".sheet [data-a=backupFile]"); await page.waitForTimeout(150);
      ok("Teilen-Menü bekommt die Datei, danach „Gesichert“", (await tp(page, () => window.__tp.shared)).startsWith("trainingsplan-sicherung-") && !!(await stored(page)).backupAt && (await page.textContent("#bkMsg")).includes("Gesichert"));
      // Als Text kopieren
      await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL.match(/^https?:\/\/[^/]+/)[0] });
      await page.click(".sheet [data-a=closeSheet]"); const prev = (await stored(page)).backupAt; await page.waitForTimeout(5); await page.click("[data-a=exportData]");
      await page.click("#codeDet summary");
      const code = await page.inputValue("#expTxt");
      await page.click("[data-a=copyExp]"); await page.waitForTimeout(150);
      ok("Text kopieren: beginnt mit TP1:, gilt als Sicherung", code.startsWith("TP1:") && (await page.textContent("#bkMsg")).includes("Kopiert") && (await stored(page)).backupAt > prev);
      ok("360 px: Sicherung ohne seitliches Scrollen", await noOverflow(page));
      await page.keyboard.press("Escape");
      // Wiederherstellen aus Datei: weniger Trainings als auf dem Gerät → erst nachfragen
      const small = JSON.stringify({ app: "trainingsplan", format: 1, at: new Date().toISOString(), data: { plan: PLAN_SMALL, history: six.slice(0, 2), backupAt: new Date(Date.now() - 864e5).toISOString() } });
      await page.click("[data-a=importOpen]");
      await page.setInputFiles("#impFile", { name: "trainingsplan-sicherung.json", mimeType: "application/json", buffer: Buffer.from(small) });
      await page.waitForSelector("[data-a=restoreConfirm]");
      ok("Sicherung mit weniger Trainings: Warnung „gehen 4 verloren“, noch nichts ersetzt", (await page.textContent("#impMsg")).includes("4 verloren") && (await stored(page)).history.length === 6);
      await page.click("[data-a=restoreConfirm]");
      st = await stored(page);
      ok("Nach Bestätigung ersetzt, Hinweis auf „Heute“", st.history.length === 2 && (await page.textContent("#homeNote")).includes("Sicherung wiederhergestellt: 2 Trainings"));
      await page.click("[data-a=tab][data-v=history]"); await page.click("[data-a=tab][data-v=home]");
      ok("Hinweis verschwindet beim Wechsel der Ansicht", !(await page.$("#homeNote")));
      // Ungültige Datei, gleich große Sicherung ohne Rückfrage, Textcode weiterhin möglich
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=importOpen]");
      await page.setInputFiles("#impFile", { name: "foto.json", mimeType: "application/json", buffer: Buffer.from("{\"x\":1}") });
      await page.waitForFunction(() => document.getElementById("impMsg").textContent.includes("keine Sicherung"));
      ok("Fremde Datei wird abgelehnt, Daten bleiben", (await stored(page)).history.length === 2);
      await page.setInputFiles("#impFile", { name: "s.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ app: "trainingsplan", format: 1, data: { plan: PLAN_SMALL, history: six } })) });
      // Vom Wiederherstellen eben liegt schon eine Kopie des Stands davor auf dem Gerät: sie wird nur nach Rückfrage ersetzt
      await page.waitForSelector("[data-a=restoreOverCopy]");
      ok("Sicherung mit mehr Trainings: keine Rückfrage wegen der Trainings – aber zur vorhandenen Kopie, die sonst still ersetzt würde", (await page.textContent("#impMsg")).includes("Es gibt schon eine Kopie") && !(await page.$("[data-a=restoreConfirm]")) && (await stored(page)).history.length === 2);
      await page.click("[data-a=restoreOverCopy]");
      await page.waitForSelector("#homeNote");
      ok("… nach der Bestätigung wiederhergestellt", (await stored(page)).history.length === 6);
      await ctx.close();
    }
    {
      // Erinnerung erst nach 5 neuen Trainings und 14 Tagen (Regel der App)
      const H = [30, 25, 20, 9, 6, 4, 3, 2, 1].map(d => hist("hs-chest", [{ kg: 40, reps: 10 }], d, "s"));
      const r = async (backupDays, hh = H) => { const { ctx, page } = await open({ plan: PLAN_SMALL, history: hh, backupAt: new Date(Date.now() - backupDays * 864e5).toISOString() });
        const x = await tp(page, () => window.__tp.insights().find(i => i.id === "backup")); await ctx.close(); return x; };
      const a = await r(10), b = await r(22), c = await r(22, H.slice(2, 3).concat(H.slice(-3)));
      ok("Sicherung vor 10 Tagen, 6 Trainings seitdem: noch keine Erinnerung", !a);
      ok("Sicherung vor 22 Tagen, 7 Trainings seitdem: Erinnerung mit Datum", !!b && b.title === "7 Trainings seit der letzten Sicherung" && b.text.includes("Letzte Sicherung"));
      ok("Sicherung vor 22 Tagen, aber erst 4 Trainings seitdem: keine Erinnerung", !c);
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: H, backupAt: "kaputt" });
      ok("Ungültiges Sicherungsdatum wird verworfen", (await tp(page, () => window.__tp.state.backupAt)) === null);
      await ctx.close();
    }
    {
      // „Nächstes Mal“ bei gleichem Gewicht: Ziel-Wiederholungen statt doppelt „+1 Wdh.“
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [{ id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 0 }] }] };
      const { ctx, page } = await open({ plan, history: [hist("hs-chest", [{ kg: 40, reps: 9 }, { kg: 40, reps: 9 }], 3, "s")] });
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      await finishAllSets(page, 40, 10);
      const nt = (await page.textContent("#nextTime")).replace(/\s+/g, " ");
      ok("Nächstes Mal: „Ziel 11/11 Wdh.“ mit Abzeichen „+1 Wdh.“, keine Dopplung", nt.includes("Ziel 11/11 Wdh.") && nt.includes("+1 Wdh.") && !nt.includes("Ziel +1"), nt.slice(0, 200));
      await ctx.close();
    }

    section("45. Plan und Wochenrückblick bewerten gleich");
    {
      // Planprüfung: Grund je Muskel – nur mittrainiert (mit „+ Übung“), Zeitbudget, Satzgrenze
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await tp(page, () => { const T = window.__tp; T.state.sched = null; T.state.plan = T.generatePlan("aufbau", 3, "fortgeschritten", 90);
        T.state.plan.days.forEach(d => { d.items = d.items.filter(i => !["hs-hipthrust", "hs-kneelcurl"].includes(i.exId)); d.items.forEach(i => { if (i.exId === "hs-seatcurl") i.sets = 5; }); }); });
      await page.click("[data-a=tab][data-v=history]"); await page.click("[data-a=tab][data-v=plan]");
      let low = await page.textContent("#lowNote");
      ok("Ohne Hüftheben: Po mit Grund „nur mittrainiert“ (einmal) und „+ Übung für Po“", low.includes("Po 5.") && low.split("nur mittrainiert").length === 2 && low.includes("Po: nur mittrainiert, das zählt halb") && (await page.textContent("#planCheck [data-a=checkFix]")).includes("+ Übung für Po"));
      ok("Satzgrenze als Regel der App benannt", low.includes("Beine hinten: mehr als 5 Sätze pro Übung plant die App nicht (Regel der App)"));
      await page.click("#planCheck [data-a=checkFix]");
      ok("„+ Übung für Po“ öffnet die Auswahl mit Po-Übungen", (await page.textContent(".sheet")).includes("Hüftheben"));
      await page.keyboard.press("Escape");
      await tp(page, () => { const T = window.__tp; T.state.plan = T.generatePlan("aufbau", 3, "fortgeschritten", 45); });
      await page.click("[data-a=tab][data-v=history]"); await page.click("[data-a=tab][data-v=plan]");
      low = await page.textContent("#lowNote");
      ok("45 Min.: Grund ist das Zeitbudget, keine „+ Übung“-Aufforderung", low.includes("Mehr passt nicht in dein Zeitbudget von 45 Min.") && !(await page.$("#planCheck [data-a=checkFix]")));
      await ctx.close();
    }
    {
      // Wochenrückblick: weniger Sätze als im Plan nur für große Muskelgruppen; kleine Muskeln werden nicht bemängelt
      const plan = { goal: "aufbau", level: "fortgeschritten", minutes: 90, days: [
        { id: "a", name: "Oben", items: [{ id: "a1", exId: "hs-chest", sets: 5, rmin: 8, rmax: 12, rest: 90 }, { id: "a2", exId: "hs-incline", sets: 5, rmin: 8, rmax: 12, rest: 90 },
          { id: "a3", exId: "hs-row", sets: 5, rmin: 8, rmax: 12, rest: 90 }, { id: "a4", exId: "hs-pulldown", sets: 5, rmin: 8, rmax: 12, rest: 90 }, { id: "a5", exId: "hs-shoulder", sets: 5, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Unten", items: [{ id: "b1", exId: "hs-legpress", sets: 5, rmin: 8, rmax: 12, rest: 90 }, { id: "b2", exId: "hs-legext", sets: 5, rmin: 8, rmax: 12, rest: 90 },
          { id: "b3", exId: "hs-seatcurl", sets: 5, rmin: 8, rmax: 12, rest: 90 }, { id: "b4", exId: "hs-kneelcurl", sets: 5, rmin: 8, rmax: 12, rest: 90 }, { id: "b5", exId: "hs-hipthrust", sets: 5, rmin: 8, rmax: 12, rest: 90 }] }] };
      const now = new Date(), mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(now.getDate() - (now.getDay() + 6) % 7 - 7);
      const at = (d, h) => { const x = new Date(mon); x.setDate(mon.getDate() + d); x.setHours(h); return x.toISOString(); };
      const S = (n, kg) => Array.from({ length: n }, () => ({ kg, reps: 10 }));
      const X = (exId, n) => ({ exId, name: exId, u: "t", planned: 5, rmin: 8, rmax: 12, sets: S(n, 40) });
      const history = [
        { id: "w1", dayId: "a", day: "Oben", date: at(0, 18), durationSec: 3600, exercises: ["hs-chest", "hs-incline", "hs-row", "hs-pulldown", "hs-shoulder"].map(e => X(e, 5)) },
        { id: "w2", dayId: "b", day: "Unten", date: at(3, 18), durationSec: 3600, exercises: [X("hs-legpress", 5), X("hs-legext", 5), X("hs-seatcurl", 1), X("hs-kneelcurl", 1), X("hs-hipthrust", 5)] }];
      const { ctx, page } = await open({ plan, history });
      await page.evaluate(() => { window.__tp.state.sched = null; });
      await page.click("#homeWeek"); await page.click("[data-a=weekNav][data-d='1']");
      const txt = (await page.textContent("#weekHints")).replace(/\s+/g, " ");
      ok("Weniger als im Plan: „Beine hinten 4,5 statt 12,5“", txt.includes("Weniger Sätze als im Plan: Beine hinten 4,5 statt 12,5"), txt);
      ok("Bizeps, Trizeps und Waden werden nicht bemängelt (wie in der Planprüfung)", !/Bizeps|Trizeps|Waden/.test(txt));
      ok("Kein Satz „Unter dem Zielbereich“ mehr, der den eigenen Plan kritisiert", !txt.includes("Unter dem Zielbereich"));
      await ctx.close();
    }

    section("46. Fortschritt zählt auch Wiederholungen");
    {
      const H4 = (d, exs) => ({ id: "p" + d, dayId: "d1", day: "Test", date: new Date(Date.now() - d * 864e5).toISOString(), durationSec: 2400, exercises: exs });
      const X = (exId, u, kg, reps) => ({ exId, name: exId, u, sets: reps.map(r => ({ kg, reps: r })) });
      const history = [
        H4(28, [X("hs-chest", "s", 40, [8, 8]), X("hs-legpress", "t", 100, [10, 10]), X("hs-row", "s", 50, [10, 10])]),
        H4(21, [X("hs-chest", "s", 40, [9, 8]), X("hs-legpress", "t", 105, [8, 8]), X("hs-row", "s", 50, [9, 8])]),
        H4(14, [X("hs-chest", "s", 40, [10, 9]), X("hs-legpress", "t", 105, [10, 9]), X("hs-row", "s", 47.5, [10, 10])]),
        H4(7, [X("hs-chest", "s", 40, [11, 10]), X("hs-legpress", "t", 110, [8, 8]), X("hs-row", "s", 47.5, [12, 11])])];
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [
        { id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 0 }, { id: "i2", exId: "hs-legpress", sets: 2, rmin: 8, rmax: 12, rest: 0 }] }] };
      const { ctx, page } = await open({ plan, history, backupAt: new Date().toISOString() });
      await page.click("[data-a=tab][data-v=history]");
      const row = async id => (await page.textContent(`[data-a=showEx][data-id=${id}]`)).replace(/\s+/g, " ");
      ok("Gleiches Gewicht, mehr Wiederholungen: „+3 Wdh.“ statt „±0“, Bestwert 40 kg × 11", (await row("hs-chest")).includes("+3 Wdh.") && (await row("hs-chest")).includes("× 11"));
      ok("Mehr Gewicht: „+10 kg“", (await row("hs-legpress")).includes("+10 kg"));
      ok("Weniger Gewicht wird ehrlich gezeigt: „−2,5 kg“ (grau) statt „±0“", (await row("hs-row")).includes("−2,5 kg") && await page.$eval("[data-a=showEx][data-id=hs-row] .delta", e => e.classList.contains("zero")));
      await page.click("[data-a=showEx][data-id=hs-chest]");
      ok("Gerätekurve: „Seit Beginn +3 Wdh.“ mit Datum der ersten Einheit", (await page.textContent("#sinceStart")).replace(/\s+/g, " ").includes("+3 Wdh.") && (await page.textContent("#sinceStart")).includes("seit"));
      ok("Gerätekurve: Wiederholungen über jedem Punkt (8, 9, 10, 11)", JSON.stringify(await page.$$eval(".sheet .repLbl", a => a.map(e => e.textContent))) === '["8","9","10","11"]');
      ok("360 px: Gerätekurve ohne seitliches Scrollen", await noOverflow(page));
      await page.keyboard.press("Escape"); await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      const sets = async list => { for (const [kg, r] of list) { if (!(await page.$("[data-a=doneSet]"))) break; await page.fill("#kgIn", String(kg)); await page.fill("#repsIn", String(r)); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]"); } };
      await sets([[40, 12], [40, 11], [110, 9], [110, 8]]);
      let pr = (await page.textContent("#prList")).replace(/\s+/g, " ");
      ok("Nach dem Training: Wiederholungsrekord „12 Wdh. mit 40 kg pro Seite, vorher höchstens 11“ (+1 Wdh.)", pr.includes("12 Wdh. mit 40 kg pro Seite, vorher höchstens 11") && pr.includes("+1 Wdh."), pr);
      ok("… und an der Beinpresse „9 Wdh. mit 110 kg insgesamt, vorher höchstens 8“", pr.includes("9 Wdh. mit 110 kg insgesamt, vorher höchstens 8"));
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      await sets([[42.5, 8], [42.5, 8], [110, 7], [110, 7]]);
      pr = (await page.textContent("#prList")).replace(/\s+/g, " ");
      ok("Mehr Gewicht zählt als Bestwert, weniger Wiederholungen als zuvor nicht", pr.includes("Brustpresse") && pr.includes("Mehr Gewicht als je zuvor") && !pr.includes("Beinpresse"), pr);
      await ctx.close();
    }

    section("47. Bestwert sofort im Training");
    {
      const H2 = (d, exs) => ({ id: "q" + d, dayId: "d1", day: "Test", date: new Date(Date.now() - d * 864e5).toISOString(), durationSec: 2400, exercises: exs });
      const X = (exId, u, kg, reps) => ({ exId, name: exId, u, sets: reps.map(r => ({ kg, reps: r })) });
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [
        { id: "i1", exId: "hs-chest", sets: 4, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-fly", sets: 2, rmin: 8, rmax: 12, rest: 60 }] }] };
      const { ctx, page } = await open({ plan, voice: true, backupAt: new Date().toISOString(),
        history: [H2(14, [X("hs-chest", "s", 40, [10, 9, 9])]), H2(7, [X("hs-chest", "s", 40, [11, 10, 9])])] });
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      const set = async (kg, r) => { await page.fill("#kgIn", String(kg)); await page.fill("#repsIn", String(r)); await page.click("[data-a=doneSet]"); };
      await set(40, 12);
      ok("Pause nach 40 × 12: „Neuer Bestwert: 12 Wdh. mit 40 kg pro Seite – vorher höchstens 11.“", (await page.textContent("#livePr")).includes("Neuer Bestwert: 12 Wdh. mit 40 kg pro Seite – vorher höchstens 11."));
      ok("Keine Dopplung mit „heute mehr“ in der Zeile darunter", !(await page.textContent("#vsLast")).includes("heute mehr"));
      ok("Sprachbegleitung sagt den Wiederholungsrekord an", (await tp(page, () => window.__tp.said || [])).includes("Neuer Bestwert: 12 Wiederholungen mit 40 Kilo."));
      await page.click("[data-a=skipRest]"); await set(40, 12);
      ok("Gleiche Leistung im zweiten Satz: kein zweiter Bestwert", !(await page.$("#livePr")) && (await page.textContent("#vsLast")).includes("heute mehr"));
      await page.click("[data-a=skipRest]"); await set(42.5, 8);
      ok("Mehr Gewicht: „Neuer Bestwert: 42,5 kg pro Seite – mehr Gewicht als je zuvor.“", (await page.textContent("#livePr")).includes("Neuer Bestwert: 42,5 kg pro Seite – mehr Gewicht als je zuvor."));
      await page.click("[data-a=skipRest]"); await set(42.5, 7);
      ok("Weniger Wiederholungen mit demselben Gewicht: kein Bestwert", !(await page.$("#livePr")));
      await page.click("[data-a=skipRest]"); await set(30, 10);
      // Butterfly hat zwei Sätze: nach dem ersten kommt die Pause (dort stünde ein Bestwert) – nicht das Ende des Trainings
      ok("Erstes Mal an einem Gerät: in der Pause danach kein Bestwert, auch nicht angesagt", !!(await page.$("[data-a=skipRest]")) && !(await page.$("#livePr")) && (await page.textContent("#app")).includes("Butterfly")
        && !(await tp(page, () => (window.__tp.said || []).some(s => s.includes("30 Kilo")))));
      await ctx.close();
    }

    section("48. Vergangenes Training korrigieren, Tippfehler-Schutz");
    {
      const day = (id, daysAgo, exs, extra) => Object.assign({ id, dayId: "d1", day: "Drücken", date: new Date(Date.now() - daysAgo * 864e5).toISOString(), durationSec: 3000, exercises: exs }, extra || {});
      const H = [day("a1", 6, [{ exId: "hs-chest", name: "Brustpresse", u: "s", sets: [{ kg: 40, reps: 10 }, { kg: 40, reps: 9 }] }, { exId: "hs-fly", name: "Butterfly", u: "b", sets: [{ kg: 30, reps: 12 }] }]),
        day("a2", 2, [{ exId: "hs-chest", name: "Brustpresse", u: "s", sets: [{ kg: 400, reps: 10, rir: 2 }, { kg: 42.5, reps: 9 }] }], { hk: true })];
      const goals = [{ id: "g1", kind: "kraft", exId: "hs-chest", u: "s", start: 40, target: 50, done: new Date().toISOString() }];
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: H, goals, health: true });
      await page.click("[data-a=tab][data-v=history]"); await page.click("#discLog summary");
      ok("Letzte Trainings: Eintrag lässt sich öffnen", !!(await page.$("#discLog [data-a=histOpen][data-id=a2]")) && (await page.textContent("#discLog")).includes("Antippen zum Korrigieren oder Löschen"));
      ok("Health-Knopf bleibt in der Liste", !!(await page.$("#discLog [data-a=sendHealth][data-id=a2]")));
      await page.click("#discLog [data-a=histOpen][data-id=a2]");
      const sh = (await page.textContent(".sheet")).replace(/\s+/g, " ");
      ok("Sheet zeigt Übung, Gewichtsangabe und Sätze als „400×10“", sh.includes("Brustpresse") && sh.includes("kg pro Seite") && sh.includes("400×10") && sh.includes("42,5×9") && sh.includes("2 Sätze"));
      await page.click('.sheet [data-a=histSet][data-x="0"][data-i2="0"]');
      ok("Satz öffnen: Eingabefelder mit den gespeicherten Werten", (await page.inputValue("#hsKg")) === "400" && (await page.inputValue("#hsReps")) === "10");
      await page.fill("#hsKg", "0"); await page.click("[data-a=histSetSave]");
      ok("Ungültiges Gewicht: Fehlermeldung, nichts gespeichert", (await page.textContent("#hsErr")).includes("größer als 0") && (await stored(page)).history[1].exercises[0].sets[0].kg === 400);
      await page.fill("#hsKg", "40"); await page.fill("#hsReps", "10,5"); await page.click("[data-a=histSetSave]");
      ok("Halbe Wiederholung wird abgelehnt", (await page.textContent("#hsErr")).includes("Wiederholungen"));
      await page.fill("#hsReps", "10"); await page.click("[data-a=histSetSave]");
      let st = await stored(page), s0 = st.history[1].exercises[0].sets[0];
      ok("Korrektur gespeichert, Reserve bleibt erhalten", s0.kg === 40 && s0.reps === 10 && s0.rir === 2 && (await page.textContent("#histMsg")).includes("Satz 1 gespeichert: 40 × 10"));
      ok("Ziel, das nur der Tippfehler erreicht hatte, ist wieder offen", !st.goals[0].done);
      ok("Bestwert neu berechnet, Liste bleibt aufgeklappt", (await page.textContent(".section .group")).includes("42,5 kg pro Seite × 9") && await page.evaluate(() => document.getElementById("discLog").open));
      await page.click('.sheet [data-a=histSet][data-x="0"][data-i2="0"]'); await page.click("[data-a=histSetSave]");
      ok("Unverändert speichern: keine Meldung", !(await page.$("#histMsg")));
      await page.click('.sheet [data-a=histSet][data-x="0"][data-i2="1"]'); await page.click("[data-a=histSetDel]");
      st = await stored(page);
      ok("Satz löschen", st.history[1].exercises[0].sets.length === 1 && (await page.textContent("#histMsg")).includes("Satz gelöscht"));
      await page.click('.sheet [data-a=histSet][data-x="0"][data-i2="0"]');
      ok("Letzter Satz eines Trainings: kein „Satz löschen“, dafür „Training löschen“", !(await page.$("[data-a=histSetDel]")));
      ok("360 px: kein seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=histBack]"); await page.click("[data-a=histDel]");
      const dt = (await page.textContent(".sheet")).replace(/\s+/g, " ");
      ok("Löschen fragt nach, nennt Tag, Datum, Sätze und Apple Health", dt.includes("„Drücken“ vom") && dt.includes("1 Satz") && dt.includes("Apple Health bleibt"));
      await page.click(".sheet [data-a=histBack]");
      ok("Abbrechen führt zurück zum Training", (await page.textContent(".sheet")).includes("Training löschen") && (await stored(page)).history.length === 2);
      await page.click("[data-a=histDel]"); await page.click("[data-a=histDelDo]");
      st = await stored(page);
      ok("Training gelöscht, Hinweis oben", st.history.length === 1 && st.history[0].id === "a1" && (await page.textContent("#histNote")).includes("gelöscht") && !(await page.$(".sheet")));
      ok("Zähler und Liste aktualisiert", (await page.textContent(".head .cap")).includes("1 Training") && (await page.textContent("#discLog summary")).includes("1 Eintrag"));
      await page.click('#discLog [data-a=histOpen][data-id=a1]'); await page.click('.sheet [data-a=histSet][data-x="1"][data-i2="0"]'); await page.click("[data-a=histSetDel]");
      st = await stored(page);
      ok("Letzten Satz einer Übung löschen entfernt die Übung", st.history[0].exercises.length === 1 && st.history[0].exercises[0].exId === "hs-chest");
      await page.click(".sheet .sh-head [data-a=closeSheet]"); await page.click("[data-a=tab][data-v=home]");
      await page.click("[data-a=tab][data-v=history]");
      ok("Hinweis verschwindet beim Wechsel der Ansicht", !(await page.$("#histNote")));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      ok("Regel steht unter „So entscheidet die App“", (await page.textContent("#coachRules")).includes("Mehr als doppelt so viel Gewicht"));
      await ctx.close();
    }
    {
      // Tippfehler-Schutz im Training (Regel der App)
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [{ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 0 }, { id: "i2", exId: "hs-fly", sets: 1, rmin: 8, rmax: 12, rest: 0 }] }] };
      const { ctx, page } = await open({ plan, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3, "s")] });
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      const isDone = i => tp(page, i => window.__tp.state.session.list[0].sets[i].done, i);
      await page.fill("#kgIn", "400"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Mehr als doppelt so viel wie bisher: Nachfrage, Satz noch offen", (await page.textContent("#setErr")).includes("400 kg pro Seite? Bisher höchstens 40 kg") && !(await isDone(0)));
      await page.fill("#kgIn", "40"); await page.click("[data-a=doneSet]");
      ok("Korrigiert auf 40: ohne Nachfrage gespeichert", await isDone(0));
      await page.fill("#kgIn", "85"); await page.fill("#repsIn", "5"); await page.click("[data-a=doneSet]");
      ok("85 kg: Nachfrage", !(await isDone(1)));
      await page.click("[data-a=doneSet]");
      ok("Zweites Tippen bestätigt", await isDone(1));
      await page.fill("#kgIn", "85"); await page.fill("#repsIn", "5"); await page.click("[data-a=doneSet]");
      ok("Gleiches Gewicht im nächsten Satz: keine erneute Nachfrage", await isDone(2));
      await page.fill("#kgIn", "200"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Erstes Mal an einem Gerät: keine Nachfrage (kein Vergleichswert)", !(await page.$("[data-a=doneSet]")) || !(await page.textContent("#setErr").catch(() => "")).includes("Bisher"));
      await ctx.close();
    }

    section("49. Vergessenes Training: richtige Dauer und richtiges Datum");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [{ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 0 }] }] };
      // Training starten, einen Satz machen, dann die Uhr im Speicher zurückdrehen und neu laden
      const setup = async (mod, keepOpen) => {
        const { ctx, page } = await open({ plan, history: [] });
        await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
        await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
        await page.evaluate(([k, m]) => { const d = JSON.parse(localStorage.getItem(k)), n = Date.now(); Object.assign(d.session, Object.fromEntries(Object.entries(m).map(([a, v]) => [a, v === null ? null : n - v * 60000]))); localStorage.setItem(k, JSON.stringify(d)); }, [KEY, mod]);
        await page.reload(); return { ctx, page };
      };
      let { ctx, page } = await setup({ start: 180, lastAt: 150 });
      let st = await stored(page);
      ok("2,5 Std. ohne Satz: beim Öffnen pausiert, „Heute“ statt Training", !(await page.$("[data-a=doneSet]")) && !!(await page.$("[data-a=resumeT]")) && st.session.paused === st.session.lastAt && st.session.autoPaused === true);
      ok("Karte erklärt es und nennt den letzten Satz", (await page.textContent("#autoPaused")).includes("über 30 Minuten kein Satz") && /letzter Satz (heute|gestern) \d\d:\d\d Uhr/.test(await page.textContent(".hero")));
      await page.click("[data-a=askStop]");
      ok("Beenden-Sheet ohne „Pausieren“", (await page.textContent(".sheet")).includes("Training beenden?") && !(await page.$(".sheet [data-a=pauseT]")));
      await page.click("[data-a=stopSave]");
      st = await stored(page); let h = st.history.at(-1);
      ok("Gespeichert mit dem Zeitpunkt des letzten Satzes und 30 Min. Dauer", Math.abs(new Date(h.date) - (Date.now() - 150 * 60000)) < 15000 && Math.abs(h.durationSec - 1800) < 15, `${h.date} ${h.durationSec}`);
      await ctx.close();

      ({ ctx, page } = await setup({ start: 180, lastAt: 150 }));
      await page.click("[data-a=resumeT]");
      const el = await tp(page, () => (Date.now() - window.__tp.state.session.start) / 60000);
      ok("Fortsetzen: Uhr zeigt nur die Trainingszeit (30 Min.), nicht die Lücke", Math.abs(el - 30) < 0.5 && !!(await page.$("[data-a=doneSet]")), String(el));
      await ctx.close();

      ({ ctx, page } = await setup({ start: 40, lastAt: 10 }));
      ok("10 Min. ohne Satz: Training läuft weiter", !!(await page.$("[data-a=doneSet]")) && !(await stored(page)).session.paused);
      // Zurück in die App nach über 30 Minuten (App lag im Hintergrund)
      await page.evaluate(() => { window.__tp.state.session.lastAt = Date.now() - 40 * 60000; document.dispatchEvent(new Event("visibilitychange")); });
      ok("Rückkehr in die App nach 40 Min.: pausiert, „Heute“", !!(await page.$("[data-a=resumeT]")) && !!(await page.$("#autoPaused")));
      await ctx.close();

      // Selbst pausiert, erst am nächsten Tag beendet
      ({ ctx, page } = await setup({ start: 20 * 60 + 30, lastAt: 20 * 60 + 2, paused: 20 * 60 }));
      ok("Selbst pausiert: kein Hinweis auf automatische Pause", !(await page.$("#autoPaused")) && !!(await page.$("[data-a=resumeT]")));
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      h = (await stored(page)).history.at(-1);
      ok("Am Folgetag beendet: Datum der Pause, Dauer bis zur Pause (30 Min.)", Math.abs(new Date(h.date) - (Date.now() - 20 * 3600000)) < 15000 && Math.abs(h.durationSec - 1800) < 15, `${h.date} ${h.durationSec}`);
      await ctx.close();
    }
    {
      // Datum und Dauer im Verlauf korrigieren
      const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
      const ld = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const H = [{ id: "b1", dayId: "d1", day: "Test", date: new Date(Date.now() - 3 * 864e5).toISOString(), durationSec: 3000, exercises: [{ exId: "hs-chest", name: "Brustpresse", u: "s", sets: [{ kg: 40, reps: 10 }] }] },
        { id: "b2", dayId: "d1", day: "Test", date: new Date().toISOString(), durationSec: 86400, exercises: [{ exId: "hs-chest", name: "Brustpresse", u: "s", sets: [{ kg: 40, reps: 10 }] }] }];
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: H });
      await page.click("[data-a=tab][data-v=history]"); await page.click("#discLog summary"); await page.click("#discLog [data-a=histOpen][data-id=b2]");
      ok("Sheet zeigt die falsche Dauer (1440 Min.)", (await page.textContent(".sheet")).includes("1440 Min."));
      await page.click("[data-a=histMeta]");
      ok("Datum und Dauer: Felder mit den gespeicherten Werten", (await page.inputValue("#hmDate")) === ld(now) && (await page.inputValue("#hmMin")) === "1440");
      await page.click("[data-a=histMetaSave]");
      ok("Über 300 Min.: Fehlermeldung", (await page.textContent("#hmErr")).includes("1 bis 300"));
      await page.fill("#hmMin", "55"); await page.fill("#hmDate", ld(new Date(Date.now() + 2 * 864e5))); await page.click("[data-a=histMetaSave]");
      ok("Datum in der Zukunft: Fehlermeldung", (await page.textContent("#hmErr")).includes("Zukunft"));
      await page.fill("#hmDate", ld(y)); await page.click("[data-a=histMetaSave]");
      const st = await stored(page), b2 = st.history.find(x => x.id === "b2");
      ok("Gespeichert: 55 Min., Vortag, Uhrzeit bleibt", b2.durationSec === 3300 && ld(new Date(b2.date)) === ld(y) && new Date(b2.date).getHours() === now.getHours() && (await page.textContent("#histMsg")).includes("Datum und Dauer gespeichert"));
      ok("Verlauf bleibt nach Datum sortiert", st.history.map(x => x.id).join() === "b1,b2");
      await page.click("[data-a=histMeta]"); await page.fill("#hmDate", ld(new Date(Date.now() - 5 * 864e5))); await page.click("[data-a=histMetaSave]");
      ok("Vor ein älteres Training verschoben: Reihenfolge angepasst", (await stored(page)).history.map(x => x.id).join() === "b2,b1");
      ok("360 px: kein seitliches Scrollen", await noOverflow(page));
      await page.click(".sheet .sh-head [data-a=closeSheet]"); await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=tab][data-v=wissen]"); await page.click("#wissenCoach");
      ok("Regel steht unter „So entscheidet die App“", (await page.textContent("#coachRules")).includes("Über 30 Minuten ohne Satz"));
      await ctx.close();
    }

    section("50. Life Fitness");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const lf = await tp(page, () => window.__tp.allEx().filter(e => e.brand === "lf").map(e => ({ id: e.id, off: e.off })));
      ok("24 Life-Fitness-Geräte, ab Werk „nicht im Studio“", lf.length === 24 && lf.every(e => e.off));
      const gp = await tp(page, () => [2, 3, 4].flatMap(n => ["einsteiger", "fortgeschritten"].flatMap(l => window.__tp.generatePlan("aufbau", n, l, 60).days.flatMap(d => d.items.map(i => i.exId)))));
      ok("Plan-Assistent nimmt sie erst, wenn sie im Studio sind", !gp.some(id => id.startsWith("lf-")));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("#libBrand [data-k=lf]");
      const subs = await page.$$eval("#libList .li .s", e => e.map(x => x.textContent.trim()));
      ok("Übungen: Filter „Life Fitness“ zeigt nur diese, mit Marke in der Zeile", subs.length === 24 && subs.every(s => s.startsWith("Life Fitness · ") && s.includes("nicht im Studio")));
      await page.click("#libBrand [data-k=alle]"); await page.fill("#libQ", "pushdown");
      ok("Suche „pushdown“ findet Trizepsdrücken am Kabel", (await page.textContent("#libList")).includes("Trizepsdrücken am Kabel"));
      await page.fill("#libQ", ""); await page.click("[data-a=openEx][data-id=lf-tripress]");
      const pg = (await page.textContent("#app")).replace(/\s+/g, " ");
      ok("Geräteseite: „Am Gerät steht: Life Fitness Triceps Press“, Griffarten erklärt", (await page.textContent("#exLabel")) === "Am Gerät steht: Life Fitness Triceps Press" && pg.includes("Dip-Griffe"));
      ok("360 px: kein seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=exBack]"); await page.click("[data-a=openEx][data-id=lf-pushdown]");
      await page.$$eval("details", d => d.forEach(x => x.open = true));
      const pd = (await page.textContent("#app")).replace(/\s+/g, " ");
      ok("Trizepsdrücken am Kabel: Studie über Kopf vs. Arm am Körper mit Quelle", pd.includes("+20 % statt +14 %") && pd.includes("Maeo"));
      // Meine Geräte: Filter und alle auf einmal ins Studio
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]");
      await page.click(".sheet [data-a=devFilt][data-k=lf]");
      ok("Meine Geräte: Filter „Life Fitness“ mit „Alle ins Studio“", (await page.$$(".sheet .group .li")).length === 24 && await page.isVisible("#devBulk"));
      await page.click("#devBulk [data-v=on]");
      ok("Alle ins Studio", !(await tp(page, () => window.__tp.allEx().some(e => e.brand === "lf" && e.off))));
      await page.reload();
      ok("Bleibt nach dem Neuladen gespeichert", !(await tp(page, () => window.__tp.allEx().some(e => e.brand === "lf" && e.off))));
      // Gleiche Übungsart der anderen Marke: zuerst als Alternative, nie doppelt im Plan
      const r = await tp(page, () => window.__tp.rankAlternatives("hs-seatcurl", new Set(["hs-seatcurl"])));
      ok("Alternative zum Beinbeuger sitzend: der von Life Fitness zuerst", r.direct[0].e.id === "lf-seatcurl" && r.direct[0].why.startsWith("Gleiche Übungsart am Gerät von Life Fitness"));
      const twins = await tp(page, () => { const T = window.__tp, out = [];
        for (const n of [2, 3, 4]) for (const l of ["einsteiger", "fortgeschritten"]) for (const m of [45, 60, 90]) {
          const ids = T.generatePlan("aufbau", n, l, m).days.flatMap(d => d.items.map(i => T.ex(i.exId)));
          ids.forEach((a, i) => ids.slice(i + 1).forEach(b => { if (a.id !== b.id && (a.twin === b.id || b.twin === a.id)) out.push(a.id + "+" + b.id); })); }
        return out; });
      ok("Kein Plan enthält dieselbe Übungsart von beiden Marken", twins.length === 0, twins.slice(0, 4).join());
      await page.evaluate(() => { window.__tp.state.dev["hs-dip"] = { off: true }; });
      const slot = await tp(page, () => window.__tp.generatePlan("aufbau", 3, "einsteiger", 60).days[0].items.map(i => i.exId));
      ok("Trizepsdrücken von Hammer Strength fehlt: Plan nimmt das von Life Fitness", slot.includes("lf-tripress") && !slot.includes("hs-dip"), slot.join());
      await ctx.close();
    }

    section("51. Trainingsbereich");
    {
      const { ctx, page } = await open(undefined);
      await page.evaluate(k => { const T = window.__tp, plan = T.generatePlan("aufbau", 3, "fortgeschritten", 60);
        localStorage.setItem(k, JSON.stringify({ plan, hints: { units: true }, backupAt: new Date().toISOString(), sched: { days: [0, 2, 4], time: "18:00", planB: "next" } })); }, KEY);
      await page.reload();
      // Kein Sheet ragt bei 360 px über den Rand (waagerecht scrollbare Filterleisten ausgenommen)
      const fits = () => page.evaluate(() => { const sh = document.querySelector(".sheet"); if (!sh) return false;
        return sh.scrollWidth <= sh.clientWidth && ![...sh.querySelectorAll("*")].some(el => { const r = el.getBoundingClientRect(); return r.width && !el.closest(".chips") && (r.right > innerWidth + 0.5 || r.left < -0.5); }); });
      const close = () => page.evaluate(() => { document.querySelector("#sheet-root").innerHTML = ""; });
      const bad = [];
      await page.click("[data-a=tab][data-v=plan]");
      ok("Trainingstage zeigen Gerätebilder statt einer Namensliste (Namen als Vorlesetext)", await page.$$eval(".day-row", r => r.length > 0 && r.every(x => x.querySelector(".tstrip .tb svg") && x.querySelector(".sr-only").textContent.length > 3)));
      await page.click("[data-a=openSched]"); if (!(await fits())) bad.push("Termine"); await close();
      await page.click("[data-a=editDay]"); await page.click("[data-a=editItem]"); if (!(await fits())) bad.push("Übung bearbeiten");
      const it = (await page.textContent(".sheet")).replace(/\s+/g, " ");
      ok("Übung bearbeiten: Pause als 0:45 bis 3:00, „Deine Einstellung“", ["0:45", "1:00", "1:30", "2:00", "3:00"].every(x => it.includes(x)) && !/\d m\b/.test(it) && it.includes("Deine Einstellung") && !it.includes("Geräte-Einstellung"));
      await close();
      await page.click("[data-a=openPicker]"); if (!(await fits())) bad.push("Übung hinzufügen"); await close();
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=openDevs]"); if (!(await fits())) bad.push("Meine Geräte");
      await page.click(".sheet [data-a=editDev]"); if (!(await fits())) bad.push("Gerät"); await close();
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      await page.click(".actions3 [data-a=openSwap]"); if (!(await fits())) bad.push("Gerät tauschen"); await close();
      await page.click(".tool[data-a=openDevInfo]"); if (!(await fits())) bad.push("Gerät & Technik"); await close();
      if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=feel][data-f=l]");
      const feel = await page.evaluate(() => { const on = getComputedStyle(document.querySelector(".seg.feel button.on")).backgroundColor, main = getComputedStyle(document.querySelector(".actionbar .btn.primary")).backgroundColor; return on !== main; });
      ok("„Leicht / Passt / Schwer“: Auswahl neutral, Akzentfarbe nur für die Hauptaktion", feel);
      await page.click("text=Satz korrigieren"); if (!(await fits())) bad.push("Satz ändern"); await close();
      await page.click("[data-a=openJump]"); if (!(await fits())) bad.push("Übungen");
      const jl = await page.textContent(".sheet");
      ok("Übungsliste: Hinweis einmal statt „antippen = jetzt“ in jeder Zeile", !jl.includes("antippen = jetzt") && jl.split("Übung antippen, um sie jetzt zu machen.").length === 2);
      await page.click("[data-a=openTimeLive]"); if (!(await fits())) bad.push("Zeit anpassen"); await close();
      await page.click("[data-a=skipRest]");
      ok("Nach dem ersten Satz: „Gerät tauschen“ ausgeblendet statt ausgegraut", !(await page.$(".actions3 [data-a=openSwap]")) && !(await page.$("[disabled][data-a=openSwap]")));
      await page.click(".tool[data-a=openDevInfo]");
      ok("Gerät & Technik erklärt, warum nicht mehr getauscht werden kann", (await page.textContent("#noSwap")).includes("vor dem ersten Satz"));
      await close();
      await page.click("[data-a=askStop]"); if (!(await fits())) bad.push("Unterbrechen");
      ok("360 px: alle Sheets im Trainingsbereich passen in die Breite", bad.length === 0, bad.join(", "));
      await page.click("[data-a=stopSave]");
      ok("Zusammenfassung: Dauer in „Min.“", /Dauer\s*\d+\s*Min\./.test((await page.textContent("#app")).replace(/\s+/g, " ")));
      await ctx.close();
    }

    section("52. Geräte auswählen, Tag gezielt starten");
    {
      const H = [hist("hs-chest", [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 3, "s")];
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: H, dev: { "lf-pushdown": { off: false } } });
      await page.click("[data-a=tab][data-v=plan]");
      ok("Tab „Training“: Geräte im Studio direkt erreichbar", (await page.textContent("#devsRow")).includes("von 60"));
      await page.click("[data-a=editDay]");
      const day = (await page.textContent("#app")).replace(/\s+/g, " ");
      ok("Trainingstag: „Test starten“ und je Gerät das Gewicht fürs nächste Mal", (await page.textContent("#dayStart")).includes("Test starten") && day.includes("2 × 42,5 kg pro Seite") && day.includes("Pause"));
      // Geräteauswahl
      await page.click("[data-a=openPicker]");
      const caps = await page.$$eval("#pickList .cap", e => e.map(x => x.textContent));
      ok("Geräteauswahl: nach Muskel gruppiert mit Anzahl, Bezeichnung am Gerät sichtbar", caps.length >= 8 && caps[0].startsWith("Brust · ") && caps[1].startsWith("Rücken · ") && caps.every(c => /^.+ · \d+$/.test(c)) && (await page.textContent(".sheet [data-a=pick][data-id=hs-row]")).includes("Iso-Lateral Row"));
      ok("Bereits im Tag: mit Häkchen", (await page.getAttribute(".sheet [data-a=pick][data-id=hs-chest]", "aria-pressed")) === "true");
      await page.fill("#pickQ", "pushdown");
      ok("Suche „pushdown“ findet das Kabelgerät", (await page.$$eval(".sheet [data-a=pick]", a => a.map(x => x.dataset.id))).join() === "lf-pushdown");
      await page.fill("#pickQ", ""); await page.click(".sheet [data-a=pickFilter][data-k=lf]");
      ok("Filter „Life Fitness“: nur Geräte dieser Marke", (await page.$$eval(".sheet [data-a=pick]", a => a.map(x => x.dataset.id))).every(id => id.startsWith("lf-")));
      await page.click(".sheet [data-a=pickAll]");
      ok("Nicht vorhandene Geräte lassen sich einblenden", (await page.$$(".sheet [data-a=pick]")).length === 24 && (await page.textContent(".sheet [data-a=pick][data-id=lf-legcurl]")).includes("nicht im Studio"));
      await page.click(".sheet [data-a=pick][data-id=lf-legcurl]");
      let st = await stored(page);
      ok("Einplanen eines nicht vorhandenen Geräts nimmt es ins Studio auf", st.dev["lf-legcurl"].off === false && st.plan.days[0].items.some(i => i.exId === "lf-legcurl"));
      await page.click(".sheet .sh-head [data-a=closeSheet]");
      ok("Tag zeigt das neue Gerät, „Gewicht beim ersten Mal wählen“", (await page.textContent("#dayItems")).includes("Beinbeuger liegend") && (await page.textContent("#dayItems")).includes("Gewicht beim ersten Mal wählen"));
      // Meine Geräte: Häkchen direkt in der Liste, Liste bleibt an ihrer Stelle
      await page.click("[data-a=tab][data-v=plan]"); await page.click("#devsRow");
      await page.waitForTimeout(350); // Sheet-Animation (0,24 s) abwarten, sonst misst der Test eine Zwischenposition
      await page.$eval(".sheet [data-a=devToggle][data-id=hs-legext]", el => el.scrollIntoView({ block: "center" }));
      const top = await page.evaluate(() => document.querySelector(".sheet").scrollTop);
      await page.click(".sheet [data-a=devToggle][data-id=hs-legext]");
      ok("Meine Geräte: ein Tipp aufs Häkchen nimmt das Gerät aus dem Studio", (await stored(page)).dev["hs-legext"].off === true && (await page.getAttribute(".sheet [data-a=devToggle][data-id=hs-legext]", "aria-pressed")) === "false");
      ok("Liste springt dabei nicht nach oben", Math.abs((await page.evaluate(() => document.querySelector(".sheet").scrollTop)) - top) < 2);
      await page.click(".sheet [data-a=devToggle][data-id=hs-legext]");
      ok("Zweiter Tipp nimmt es wieder auf", (await stored(page)).dev["hs-legext"].off === false);
      await page.click(".sheet [data-a=devsDone]");
      // Genau diesen Tag starten
      await page.click("[data-a=editDay]"); await page.click("#dayStart");
      ok("„Test starten“ startet das Training dieses Tages (mit zwei Tagen: Abschnitt E-runde3)", !!(await page.$("[data-a=doneSet]")) && (await tp(page, () => window.__tp.state.session.dayId)) === "d1");
      await page.click("[data-a=askStop]"); await page.click("[data-a=pauseT]");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay]");
      ok("Läuft schon ein Training: „Training fortsetzen“ statt neu starten", (await page.textContent("#dayStart")).includes("fortsetzen"));
      await page.click("#dayStart");
      ok("Fortsetzen führt ins Training", !!(await page.$("[data-a=doneSet]")) && !(await tp(page, () => window.__tp.state.session.paused)));
      await ctx.close();
    }

    section("53. Gerät im Training dazunehmen");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3, "s")] });
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      await page.click("[data-a=openJump]");
      ok("Übungsliste im Training: „+ Gerät dazunehmen“", await page.isVisible("#sesAddBtn"));
      await page.click("#sesAddBtn");
      const sh = (await page.textContent(".sheet")).replace(/\s+/g, " ");
      ok("Geräteauswahl im Training: kommt nach der aktuellen Übung, „Nur heute“ voreingestellt", sh.includes("Gerät dazunehmen") && sh.includes("direkt nach der aktuellen Übung") && (await page.textContent("#pickPlanSeg .on")) === "Nur heute");
      ok("Geräte, die schon im Training sind: mit Häkchen und gesperrt", await page.isDisabled(".sheet [data-a=pickSes][data-id=hs-chest]"));
      await page.click(".sheet [data-a=pickAll]").catch(() => {});
      await page.click(".sheet [data-a=pickSes][data-id=lf-pushdown]");
      let s = await tp(page, () => window.__tp.state.session.list.map(l => l.exId));
      ok("Neues Gerät steht direkt nach der aktuellen Übung", s[0] === "hs-chest" && s[1] === "lf-pushdown" && s.length === 4, s.join());
      let st = await stored(page);
      ok("Nur heute: Plan unverändert, Gerät aber ins Studio übernommen", !st.plan.days[0].items.some(i => i.exId === "lf-pushdown") && st.dev["lf-pushdown"].off === false);
      ok("Zurück in der Übungsliste, neues Gerät sichtbar", (await page.textContent(".sheet")).includes("Trizepsdrücken am Kabel") && await page.isVisible("#sesAddBtn"));
      // Auch in den Trainingstag übernehmen
      await page.click("#sesAddBtn"); await page.click("#pickPlanSeg [data-v='1']");
      await page.click(".sheet [data-a=pickSes][data-id=hs-row]");
      st = await stored(page); s = await tp(page, () => window.__tp.state.session.list.map(l => ({ id: l.exId, item: l.itemId })));
      const row = s.find(x => x.id === "hs-row"), planRow = st.plan.days[0].items.find(i => i.exId === "hs-row");
      ok("„Auch in Test“: Gerät landet im Trainingstag und im Training", !!planRow && !!row && row.item === planRow.id && s[1].id === "hs-row");
      ok("360 px: Auswahl im Training passt in die Breite", await (async () => { await page.click("#sesAddBtn"); const r = await page.evaluate(() => { const sh = document.querySelector(".sheet"); return sh.scrollWidth <= sh.clientWidth; }); await page.click(".sheet [data-a=pickSesBack]"); return r; })());
      // Training mit dem neuen Gerät beenden: es steht im Verlauf
      await page.click("[data-a=jump][data-i2='1']");
      await page.fill("#kgIn", "50"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const h = (await stored(page)).history.at(-1);
      ok("Gespeichert: das dazugenommene Gerät steht im Verlauf", h.exercises.some(x => x.exId === "hs-row" && x.sets[0].kg === 50));
      await ctx.close();
    }

    section("54. Bewegungsanimationen");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [{ id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 60 }, { id: "i2", exId: "hs-legpress", sets: 1, rmin: 8, rmax: 12, rest: 60 }] }] };
      const { ctx, page } = await open({ plan, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3, "s")] });
      const cov = await tp(page, () => { const T = window.__tp; return T.allEx().filter(e => !e.id.startsWith("c-")).filter(e => !T.motSpec(e.id)).map(e => e.id); });
      ok("Alle 60 Geräte haben eine Bewegungsanimation", cov.length === 0, cov.join());
      const cust = await tp(page, () => { const T = window.__tp; T.state.custom.push({ id: "c-k", name: "Kabelzug", muscle: "trizeps", sec: [], type: "stack", pattern: "tri" }); return !!T.motSpec("c-k"); });
      ok("Eigenes Gerät mit Bewegungsmuster bekommt die passende Animation", cust);
      ok("„Heute“: Geräte des Tages nacheinander, mit Name", (await page.textContent(".hero-mot .mcap")).includes("1/2 · Brustpresse") && !!(await page.$(".hero-mot svg[data-cycle]")));
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      const a1 = await page.$eval(".mot-btn svg .mfig", g => g.innerHTML); await page.waitForTimeout(700);
      const a2 = await page.$eval(".mot-btn svg .mfig", g => g.innerHTML);
      ok("Training: Animation neben dem Gerätenamen bewegt sich", a1 !== a2);
      await page.click(".mot-btn");
      ok("Antippen öffnet „Gerät & Technik“ mit großer Animation und Hinweis „Gerät vereinfacht“", !!(await page.$(".sheet .gmot svg.motion[data-anim]")) && (await page.textContent(".sheet .gmot .mnote")).includes("Gerät vereinfacht"));
      await page.click(".sheet .sh-head [data-a=closeSheet]");
      ok("360 px: Animation verdrängt die Eingabe nicht (kein seitliches Scrollen)", await noOverflow(page));
      // Pause vor einem anderen Gerät: Bewegung der nächsten Übung
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Pause vor einem neuen Gerät zeigt dessen Bewegung", !!(await page.$("[data-a=skipRest]")) && !!(await page.$(".next-mot svg.motion[data-anim]")) && (await page.textContent(".next")).includes("Beinpresse"));
      await ctx.close();
    }
    {
      // Level 3/4: Muskeln, Gerät, Tempo, Atmung, Steuerung
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const m = await tp(page, () => { const T = window.__tp, chest = T.motionSvg("hs-chest", { p: 1 }), lf = T.motionSvg("lf-chest", { p: 1 });
        return { glow: chest.includes('stroke="var(--mhot)" stroke-width="6"'), sec: /fill="var\(--mhot\)" fill-opacity="0\.4\d?"/.test(chest), plate: chest.includes('r="9" fill="var(--mpad)"'),
          lfPlate: lf.includes('r="9" fill="var(--mpad)"'), lfStack: (lf.match(/<rect [^>]*height="4.8"/g) || []).length === 6,
          press: [0, 500, 1800, 2500].map(ms => T.motState(ms).st).join(), squat: [0, 1000, 2600, 3200].map(ms => T.motState(ms, true).st).join(),
          downSpecs: ["hs-vsquat", "hs-hack", "hs-beltsquat", "hs-smith", "lf-smith"].every(id => T.motSpec(id).down) && !T.motSpec("hs-legpress").down }; });
      ok("Muskeln: Hauptmuskel leuchtet, mittrainierte Muskeln blass", m.glow && m.sec);
      ok("Gerät: Scheiben am Hebel bei Scheibengeräten, Steckgewicht mit Plattenstapel statt Scheiben", m.plate && !m.lfPlate && m.lfStack);
      ok("Tempo: Drücken zügig hin, langsam zurück; Kniebeugen erst langsam runter, dann zügig hoch", m.press === "start,con,turn,ecc" && m.squat === "start,ecc,turn,con" && m.downSpecs, m.press + " | " + m.squat);
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-chest]");
      const cues = new Set(); for (let i = 0; i < 10; i++) { cues.add((await page.textContent("#gMotion .mcue-t")).trim()); await page.waitForTimeout(420); }
      ok("Anleitung: Hinweis wechselt mit der Phase (Drücken · ausatmen, Langsam zurück · einatmen)", [...cues].some(c => c.startsWith("Drücken · zügig · ausatmen")) && [...cues].some(c => c.startsWith("Langsam zurück · 2 s · einatmen")), [...cues].join(" | "));
      await page.click("#gMotion [data-a=motPlay]");
      const s1 = await page.$eval("#gMotion svg .mfig", g => g.innerHTML); await page.waitForTimeout(500); const s2 = await page.$eval("#gMotion svg .mfig", g => g.innerHTML);
      ok("Pause hält die Bewegung an, Knopf heißt dann „Abspielen“", s1 === s2 && (await page.textContent("#gMotion [data-a=motPlay]")) === "Abspielen");
      await page.$eval("#gMotion .mscrub", r => { r.value = "250"; r.dispatchEvent(new Event("input", { bubbles: true })); }); await page.waitForTimeout(200);
      ok("Schieberegler zeigt die Bewegung Schritt für Schritt", (await page.textContent("#gMotion .mcue-t")).startsWith("Drücken") && (await page.$eval("#gMotion svg .mfig", g => g.innerHTML)) !== s2);
      await page.click("#gMotion [data-a=motPlay]"); await page.click("#gMotion [data-a=motSlow]");
      ok("Zeitlupe lässt sich ein- und ausschalten", (await page.getAttribute("#gMotion [data-a=motSlow]", "aria-pressed")) === "true");
      await page.setViewportSize({ width: 360, height: 740 });
      ok("360 px: Hinweis und Steuerung passen in die Breite", await noOverflow(page));
      await ctx.close();
    }
    {
      // „Bewegung reduzieren“: keine Animation, Start blass und Ende kräftig
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.emulateMedia({ reducedMotion: "reduce" }); await page.reload();
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-row]");
      ok("Bewegung reduzieren: Anleitung zeigt Start und Ende ohne Animation, ohne Tempo-Steuerung", !(await page.$("svg.motion[data-anim]")) && (await page.$$("#gMotion svg g[opacity]")).length === 1 && !(await page.$("#gMotion .mctl")));
      await ctx.close();
    }

    section("55. Lebensmittel: Supermärkte, Marken, Fast Food");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const fd = await tp(page, () => { const T = window.__tp, bad = [];
        T.FAST_DB.forEach(([id, n, k, p, c, f]) => { if (!Number.isInteger(id) || !n || ![k, p, c, f].every(v => typeof v === "number" && v >= 0) || p + c + f > 100.5) bad.push(id); });
        const bm = T.FAST_DB.find(r => r[0] === 170720);
        return { n: T.FAST_DB.length, bad, bm, q1: T.offQuery("skyr lidl"), q2: T.offQuery("ja! milch rewe"), q3: T.offQuery("sucuk") }; });
      ok("34 Fast-Food-Produkte aus USDA, alle vollständig", fd.n === 34 && !fd.bad.length, fd.bad.join());
      ok("Stichprobe Big Mac wie USDA SR Legacy (257 kcal, 11,8 E, 20,1 K, 15 F je 100 g; 1 Stück = 219 g)", JSON.stringify(fd.bm.slice(2, 6)) === "[257,11.8,20.1,15]" && fd.bm[7][1] === 219);
      ok("„Skyr Lidl“ sucht Skyr bei Lidl-Eigenmarken (Milbona, Pilos …)", fd.q1.startsWith("skyr brands_tags:(") && fd.q1.includes("milbona") && fd.q1.includes("pilos") && !/\blidl brands/.test(fd.q1));
      ok("„ja! milch rewe“: Rewe-Marken als Filter, „ja“ nicht doppelt im Suchtext", fd.q2.startsWith("milch brands_tags:(") && fd.q2.includes(" OR ja OR ") && fd.q3 === "sucuk");
      let asked = [];
      await page.route("**/api/food**", route => { asked.push(decodeURIComponent(route.request().url()));
        route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ hits: [
          { code: "1", product_name: "Sucuk", brands: ["Yayla"], countries_tags: ["en:germany"], nutriments: { "energy-kcal_100g": 377, proteins_100g: 15, carbohydrates_100g: 0.5, fat_100g: 35 } },
          { code: "2", product_name: "Sucuk", brands: ["Yayla"], countries_tags: ["en:germany"], nutriments: { "energy-kcal_100g": 377, proteins_100g: 15, carbohydrates_100g: 0.5, fat_100g: 35 } },
          { code: "3", product_name: "Sucuk Spezial", brands: ["Ausland"], countries_tags: ["en:russia"], nutriments: { "energy-kcal_100g": 300, proteins_100g: 20, carbohydrates_100g: 1, fat_100g: 24 } },
          { code: "4", product_name: "Sucuk am Stück", brands: ["Kamar"], nutriments: { "energy-kcal_100g": 372, proteins_100g: 18, carbohydrates_100g: 0.7, fat_100g: 33 } },
          { code: "5", product_name: "Ohne Werte", nutriments: {} }] }) }); });
      await page.click("[data-a=tab][data-v=food]"); await page.click("[data-a=foodAdd][data-m=m]");
      ok("Hinweis: Fast Food und Supermarkt-Suche", (await page.textContent("#foodRes")).includes("34 Fast-Food-Produkte") && (await page.textContent("#foodRes")).includes("Skyr Lidl"));
      await page.fill("#foodQ", "mcdonalds");
      ok("„mcdonalds“ findet die McDonald's-Produkte lokal (Schreibweise egal)", (await page.$$eval("#foodRes [data-a=foodPick] .t", e => e.map(x => x.textContent))).filter(t => t.includes("McDonald's")).length === 12);
      await page.fill("#foodQ", "big mac");
      const bigmac = (await page.textContent("#foodRes")).replace(/\s+/g, " ");
      ok("„big mac“ findet den Big Mac mit kcal, Eiweiß, Kohlenhydraten und Fett", bigmac.includes("Big Mac (McDonald's)") && bigmac.includes("257 kcal · E 11,8 · K 20,1 · F 15 g je 100 g"));
      await page.click("#foodRes [data-a=foodPick]");
      ok("Big Mac: Portion vorausgewählt (219 g → 563 kcal), Hinweis auf US-Rezeptur", (await page.inputValue("#amtG")) === "219" && (await page.textContent("#amtOut")).replace(/\s+/g, "").includes("kcal563") && (await page.textContent(".sheet")).includes("US-Rezeptur"));
      await page.keyboard.press("Escape"); await page.click("[data-a=foodAdd][data-m=m]");
      asked = []; await page.fill("#foodQ", "sucuk");
      await page.waitForSelector("#offRes [data-a=foodPick]", { timeout: 5000 }).catch(() => {});
      const rows = await page.$$eval("#offRes [data-a=foodPick]", e => e.map(x => x.textContent.replace(/\s+/g, " ").trim()));
      ok("Online-Suche startet beim Tippen von selbst (über /api/food)", asked.some(u => u.includes("/api/food?q=sucuk")));
      ok("Gleiches Produkt nur einmal, ohne unvollständige, Ausland zuletzt", rows.length === 3 && rows[0].includes("Yayla") && rows[1].includes("Kamar") && rows[2].includes("Ausland"), rows.join(" | "));
      asked = []; await page.fill("#foodQ", "skyr lidl"); await page.waitForTimeout(900);
      ok("„Skyr Lidl“: Anfrage mit Lidl-Eigenmarken", asked.some(u => u.includes("brands_tags:(lidl OR milbona")));
      await ctx.close();
      const swSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "sw.js"), "utf8");
      ok("Service Worker speichert Suchergebnisse nicht zwischen (/api/ immer aus dem Netz)", swSrc.includes('url.pathname.startsWith("/api/")'));
      const api = require(require("path").join(__dirname, "..", "api", "food.js"));
      const res = await new Promise(resolve => { const r = { setHeader() {}, status(c) { this.c = c; return this; }, json(o) { resolve({ c: this.c, o }); } }; api({ query: { q: "x" } }, r); });
      ok("Server-Funktion lehnt zu kurze Suchbegriffe ab, ohne Open Food Facts zu fragen", res.c === 400);
    }

    section("56. Mehr Beingeräte");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const lg = await tp(page, () => { const T = window.__tp, E = id => { const e = T.ex(id); return [e.name, e.muscle, e.type, e.label, e.brand, e.twin || "", !!e.off, e.pattern, T.unitOf(e)].join("|"); };
        const ids = ["hs-beltsquat", "hs-smith", "hs-legcurl", "hs-abductor", "hs-adductor", "lf-adductor", "lf-smith"];
        const fig = T.figure({ innen: "red" }, "x", "innen");
        return { rows: Object.fromEntries(ids.map(id => [id, E(id)])), twins: ["lf-legcurl", "lf-abductor"].map(id => T.ex(id).twin), innen: T.MUSCLES.innen,
          glute: T.ex("hs-hipthrust").label, mot: ids.every(id => !!T.motSpec(id)), figOk: fig.includes('style="fill:red"') && fig.includes("viewBox=\"16 88"),
          check: T.planCheck().out.some(x => x.m === "innen") };
      });
      ok("Neue Beingeräte von Hammer Strength (im Studio) und Life Fitness (zunächst nicht im Studio)", JSON.stringify(lg.rows) === JSON.stringify({
        "hs-beltsquat": "Hüftgurt-Kniebeuge|beinev|plate|Belt Squat|hs||false|squat|t",
        "hs-smith": "Kniebeuge Multipresse|beinev|plate|Smith Machine|hs||false|squat|t",
        "hs-legcurl": "Beinbeuger liegend|beineh|plate|Iso-Lateral Leg Curl|hs||false|knee_flex|s",
        "hs-abductor": "Abduktoren|po|stack|Hip Abduction|hs||false|abd|b",
        "hs-adductor": "Adduktoren|innen|stack|Hip Adduction|hs||false|add|b",
        "lf-adductor": "Adduktoren|innen|stack|Hip Adduction|lf|hs-adductor|true|add|b",
        "lf-smith": "Kniebeuge Multipresse|beinev|plate|Signature Series Smith Machine|lf|hs-smith|true|squat|t" }), JSON.stringify(lg.rows));
      ok("Gleiche Übungsart bei beiden Marken verknüpft (Beinbeuger liegend, Abduktoren)", lg.twins.join() === "hs-legcurl,hs-abductor");
      ok("Neue Muskelgruppe „Beine innen“ mit eigener Fläche in der Muskelkarte, ohne Pflicht in der Planprüfung", lg.innen === "Beine innen" && lg.figOk && !lg.check);
      ok("Hüftheben heißt am Gerät „Glute Drive“, alle neuen Geräte haben eine Bewegungsanimation", lg.glute === "Glute Drive" && lg.mot);
      await page.click("[data-a=tab][data-v=lib]");
      await page.fill("#libQ", "hip thrust");
      ok("Suche „hip thrust“ findet das Hüftheben", (await page.$$eval("#libList [data-a=openEx]", e => e.map(x => x.dataset.id))).join() === "hs-hipthrust");
      await page.fill("#libQ", "multipresse");
      ok("Suche „Multipresse“ findet beide Multipressen", (await page.$$eval("#libList [data-a=openEx]", e => e.map(x => x.dataset.id))).sort().join() === "hs-smith,lf-smith");
      await page.fill("#libQ", "beine innen");
      ok("Suche nach der Muskelgruppe „Beine innen“ zeigt die Adduktoren", (await page.$$eval("#libList [data-a=openEx]", e => e.map(x => x.dataset.id))).sort().join() === "hs-adductor,lf-adductor");
      await page.fill("#libQ", ""); await page.click("[data-a=openEx][data-id=hs-beltsquat]");
      const g = (await page.textContent(".page")).replace(/\s+/g, " ");
      ok("Hüftgurt-Kniebeuge: Anleitung mit Gurt, Bezeichnung am Gerät, Animation", g.includes("Belt Squat") && g.includes("Gurt eng um die Hüfte") && !!(await page.$("#gMotion svg.motion")));
      await ctx.close();
    }

    section("57. Fehlende Muskelgruppe verständlich");
    {
      const I = (id, exId, sets) => ({ id, exId, sets, rmin: 8, rmax: 12, rest: 60 });
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "o", name: "Oberkörper", items: [I("o1", "hs-chest", 2), I("o2", "hs-row", 2), I("o3", "hs-shoulder", 2)] },
        { id: "u", name: "Tag 2", items: [I("u1", "hs-legpress", 4), I("u2", "hs-legext", 4), I("u3", "hs-calf", 4)] }] };
      const { ctx, page } = await open({ plan });
      const home = (await page.textContent("#app")).replace(/\s+/g, " ");
      ok("Karte: „Im Plan fehlt: Beine hinten“, sagt was das ist und welches Gerät passt", home.includes("Im Plan fehlt: Beine hinten") && home.includes("Keine deiner Übungen trainiert die Oberschenkelrückseite. Passend: Beinbeuger – sitzend, liegend oder kniend.") && !home.includes("weder als Hauptmuskel"), home.slice(0, 300));
      await page.click("[data-a=checkFix][data-m=beineh]");
      const st = await tp(page, () => ({ day: window.__tp.state.editDay }));
      ok("„+ Gerät wählen“ öffnet den Beintag (nicht den kürzeren Oberkörper-Tag) mit Beinbeugern", st.day === "u" && (await page.getAttribute("#pickMuscle", "data-v")) === "beineh" && (await page.textContent(".sheet")).includes("Beinbeuger sitzend"));
      await ctx.close();
    }

    section("58. Gestaltung: eine Hauptaktion, Skala je Satz, Desktop-Leiste");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, weights: [{ d: "2026-01-01", kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "auf", kcal: null } });
      const ins = await page.$("#coach .ins");
      ok("Hinweiskarte: Signalpunkt, Aktionen neutral (Akzentfarbe nur für „Training starten“)", !ins || !(await page.$("#coach .ins .btn.primary")));
      ok("„Heute“: genau eine Fläche in Akzentfarbe (Hauptaktion)", (await page.$$("#app .btn.primary")).length === 1);
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      const tk = await page.$eval(".t-top .bar.ticks", b => getComputedStyle(b).getPropertyValue("--n").trim());
      ok("Training: Fortschritt als Skala mit einem Strich je Satz (4 Sätze)", tk === "4", tk);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-chest]");
      ok("Unter der Animation steht, dass das Gerät vereinfacht ist (Schema, kein genaues Modell)", (await page.textContent("#gMotion .mnote")).includes("Gerät vereinfacht"));
      ok("Übungsseite: Bewegung direkt unter dem Titel, vor „Deine Werte“", await page.evaluate(() => !!(document.querySelector("#gMotion").compareDocumentPosition(document.querySelector("#exStats")) & Node.DOCUMENT_POSITION_FOLLOWING)));
      await page.setViewportSize({ width: 1280, height: 800 });
      const nav = await page.$eval("nav.tabs", n => { const r = n.getBoundingClientRect(); return { l: r.left, w: r.width, h: r.height }; });
      ok("Ab 1024 px: Navigation als Leiste links über die ganze Höhe", nav.l === 0 && nav.w < 120 && nav.h >= 800, JSON.stringify(nav));
      await ctx.close();
    }

    {
      // Kontrast nach WCAG 2.2 AA (Text ≥ 4,5:1) für die Farbtokens in beiden Designs
      const res = [];
      for (const light of [false, true]) {
        const { ctx, page } = await open({ plan: PLAN_SMALL }, { light });
        res.push(await page.evaluate(lightMode => {
          const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
          const lum = h => { h = h.replace("#", ""); const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
          const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
          const bad = [];
          for (const fg of ["--text", "--text-2", "--text-3", "--accent-ink", "--ok", "--warn", "--bad"]) for (const bg of ["--bg", "--raise", "--raise-2", "--sheet"]) {
            const r = cr(v(fg), v(bg)); if (r < 4.5) bad.push(`${fg} auf ${bg}: ${r.toFixed(2)}`); }
          for (const bg of ["--accent", "--accent-stripe", "--accent-press"]) { const onA = cr(v("--on-accent"), v(bg)); if (onA < 4.5) bad.push(`Schrift auf ${bg}: ${onA.toFixed(2)}`); }
          return { lightMode, bad };
        }, light));
        await ctx.close();
      }
      ok("Kontrast: alle Textfarben ≥ 4,5:1 auf allen Flächen, auch Schrift auf beiden Warnstreifen der Hauptknöpfe (dunkel und hell)", res.every(r => !r.bad.length), JSON.stringify(res));
    }

    {
      // Struktur für Screenreader: ein <main>, genau eine Überschrift erster Ebene je Ansicht, Sheets mit Namen
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const h1 = async () => page.$$eval("main h1", e => e.map(x => x.textContent.trim()));
      const views = {};
      views.heute = await h1();
      await page.click("[data-a=tab][data-v=plan]"); views.training = await h1();
      await page.click("[data-a=tab][data-v=lib]"); views.wissen = await h1();
      await page.click("[data-a=openEx][data-id=hs-chest]"); views.uebung = await h1();
      await page.click("[data-a=tab][data-v=food]"); views.essen = await h1();
      await page.click("[data-a=tab][data-v=history]"); views.fortschritt = await h1();
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      views.satz = await h1();
      await page.click("[data-a=openJump]");
      const dlg = await page.$eval(".sheet[role=dialog]", s => { const id = s.getAttribute("aria-labelledby"); return id && document.getElementById(id) ? document.getElementById(id).textContent.trim() : null; });
      ok("Hauptbereich als <main>, je Ansicht genau eine Überschrift erster Ebene", !!(await page.$("main#app")) && Object.values(views).every(v => v.length === 1) && views.heute[0] === "Heute" && views.satz[0] === "Brustpresse", JSON.stringify(views));
      ok("Sheet als Dialog mit Namen aus seiner Überschrift", dlg === "Übungen", String(dlg));
      await ctx.close();
    }

    section("59. Scheibenrechner");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Beine", items: [{ id: "i1", exId: "hs-legpress", sets: 2, rmin: 8, rmax: 12, rest: 60 }, { id: "i2", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 60 }, { id: "i3", exId: "hs-fly", sets: 2, rmin: 8, rmax: 12, rest: 60 }] }] };
      const history = [{ id: "h", dayId: "d1", day: "Beine", date: new Date(Date.now() - 3 * 864e5).toISOString(), durationSec: 2000, exercises: [
        { exId: "hs-legpress", name: "x", u: "t", planned: 2, rmin: 8, rmax: 12, sets: [{ kg: 95, reps: 8 }, { kg: 95, reps: 8 }] }, { exId: "hs-chest", name: "x", u: "s", planned: 2, rmin: 8, rmax: 12, sets: [{ kg: 41, reps: 8 }, { kg: 41, reps: 8 }] }] }];
      const { ctx, page } = await open({ plan, history });
      const pc = await tp(page, () => { const T = window.__tp; return { a: T.platesOf(47.5, T.PLATE_SIZES), b: T.platesOf(41, [20, 10, 5]), c: T.platesOf(0, T.PLATE_SIZES) }; });
      ok("Rechner: 47,5 kg je Seite = 25 + 20 + 2,5; 41 kg mit 20/10/5 = 20 + 20, Rest 1 kg", JSON.stringify(pc.a) === '{"plates":[25,20,2.5],"rest":0}' && JSON.stringify(pc.b) === '{"plates":[20,20],"rest":1}' && pc.c.plates.length === 0, JSON.stringify(pc));
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      const tx = s => s.replace(/\s+/g, "");
      ok("Beinpresse (kg insgesamt): 95 kg → pro Seite 25 + 20 + 2,5", tx(await page.textContent("#platesTxt")) === "ProSeite25202,5", await page.textContent("#platesTxt"));
      await page.click("[data-a=adj][data-k=kg][data-d='1']");
      ok("Gewicht + Schritt: Anzeige folgt sofort (100 kg → 25 + 25)", tx(await page.textContent("#platesTxt")) === "ProSeite2525");
      await page.fill("#kgIn", "0"); await page.dispatchEvent("#kgIn", "input");
      ok("0 kg: keine Scheiben", tx(await page.textContent("#platesTxt")) === "");
      await page.fill("#kgIn", "100"); await page.dispatchEvent("#kgIn", "input");
      await page.fill("#repsIn", "8"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      await page.fill("#repsIn", "8"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      ok("Brustpresse (kg pro Seite): 41 kg → 25 + 15 + 1 kg nicht aufteilbar", tx(await page.textContent("#platesTxt")).startsWith("ProSeite2515") && (await page.textContent("#platesTxt")).includes("1 kg nicht aufteilbar"), await page.textContent("#platesTxt"));
      await page.fill("#repsIn", "8"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      await page.fill("#repsIn", "8"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      ok("Steckgewicht (Butterfly): kein Scheibenrechner", !(await page.$("#platesTxt")) && (await page.textContent("h1")).includes("Butterfly"));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
      await page.click("#optPlates [data-a=plateToggle][data-v='25']"); await page.click("#optPlates [data-a=plateToggle][data-v='15']");
      const st = await stored(page);
      ok("Einstellungen → Studio: Scheiben im Studio abwählbar (ohne 25 und 15)", JSON.stringify(st.plates) === "[20,10,5,2.5,1.25]" && (await page.getAttribute("#optPlates [data-v='25']", "aria-pressed")) === "false");
      const r = await tp(page, () => window.__tp.platesHtml(window.__tp.ex("hs-chest"), 40).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      ok("Rechner nutzt nur die vorhandenen Scheiben (40 kg → 20 + 20)", r === "Pro Seite 20 20", r);
      await ctx.close();
    }

    {
      // Gewichtsart klar: Scheiben je Seite (Iso-Lateral), Scheiben insgesamt, Steckgewicht, Seilzug
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const g = await tp(page, () => { const T = window.__tp; return ["hs-chest", "hs-legpress", "hs-fly", "lf-pushdown", "hs-lat"].map(id => T.loadShort(T.ex(id)) + "|" + T.loadTxt(T.ex(id))); });
      ok("Gewichtsart je Gerät: Brustpresse Scheiben je Seite, Beinpresse Scheiben insgesamt, Butterfly Steckgewicht, Kabel/Latzug Seilzug", JSON.stringify(g) === JSON.stringify(["Scheiben je Seite|Scheiben, pro Seite", "Scheiben|Scheiben, insgesamt", "Steckgewicht|Steckgewicht", "Seilzug|Seilzug, Steckgewicht", "Seilzug|Seilzug, Steckgewicht"]), JSON.stringify(g));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay]"); await page.click("[data-a=openPicker]");
      ok("Geräteauswahl zeigt die Gewichtsart in jeder Zeile", (await page.textContent(".sheet [data-a=pick][data-id=hs-chest]")).includes("Scheiben je Seite") && (await page.textContent(".sheet [data-a=pick][data-id=hs-fly]")).includes("Steckgewicht"));
      await ctx.close();
    }

    section("60. Tagesplan: Training, Schritte, Essen, Kalorienbilanz");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Drücken", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Ziehen", items: [{ id: "b1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan, weights: [{ d: dk(0), kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null },
        sched: { days: [0, 1, 2, 3, 4, 5, 6], time: "18:00", planB: "next" }, stepGoal: 8000, dayPlan: { [dk(1)]: { steps: 12000 }, "kaputt": { steps: 5 }, [dk(2)]: { steps: -3 } },
        food: { [dk(0)]: [{ id: "x", m: "m", n: "Reis", src: "usda:168878", g: 300, per: { k: 130, p: 2.7, c: 28, f: .3 } }] } });
      const r = await tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        const e0 = T.dayEnergy(k(0)), e1 = T.dayEnergy(k(1));
        return { p0: T.plannedOn(k(0)), p1: T.plannedOn(k(1)), p2: T.plannedOn(k(2)), e0, e1, s: [T.stepsOn(k(0)), T.stepsOn(k(1)), T.stepsOn(k(2))], sl: T.stepLenCm(), dp: Object.keys(T.state.dayPlan) }; });
      ok("Training je Tag laut Terminen und Ablauf: heute Drücken, morgen Ziehen, übermorgen Drücken", r.p0.name === "Drücken" && r.p1.name === "Ziehen" && r.p2.name === "Drücken" && !r.p0.done);
      ok("Schritte: Tagesziel überschreibt das Standardziel, ungültige Einträge verworfen", JSON.stringify(r.s) === "[8000,12000,8000]" && r.dp.length === 1, JSON.stringify(r.s) + " " + JSON.stringify(r.dp));
      const tk = Math.round(2.5 * 80 * r.p0.min / 60);
      // Gehen nach Ludlow & Weyand 2016 bei 1,3 m/s und 1,80 m: (3,85 + 5,97 × 1,69 / 1,8) × 5 / 78 ≈ 0,606 kcal je kg und km
      ok("Verbrauch heute: 2.759 (1.780 × 1,55) + Krafttraining 2,5 MET netto + Schritte über 5.000 (3.000 × 75 cm = 2,25 km → 109 kcal)",
        r.sl === 75 && r.e0.G.tdee === 2759 && r.e0.trainKcal === tk && r.e0.stepKcal === 291 && r.e0.stepExtra === 109 && r.e0.total === 2759 + tk + 109 && r.e0.intake === 390 && r.e0.balance === 390 - r.e0.total, JSON.stringify(r.e0));
      ok("Morgen 12.000 Schritte: 9 km, 436 kcal beim Gehen, davon 255 über 5.000", r.e1.stepKcal === 436 && r.e1.stepExtra === 255, JSON.stringify(r.e1));
      const mod = await tp(page, () => { const T = window.__tp; T.state.nutr.pal = 1.85; const k = new Date(), e = T.dayEnergy(`${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, "0")}-${String(k.getDate()).padStart(2, "0")}`); T.state.nutr.pal = 1.55; return e; });
      ok("„Mäßig aktiv“: Bewegung im Faktor enthalten, nichts doppelt gezählt", mod.extra === 0 && mod.total === mod.G.tdee);
      // Bedienung
      await page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`);
      ok("Tag in der Wochenleiste öffnet den Tagesplan", (await page.textContent("main h1")) === "Heute" && (await page.textContent("#tagTrain")).includes("Drücken") && (await page.textContent("#tagBal")).includes("Defizit bisher"));
      await page.click("[data-a=tagDay][data-d='1']");
      ok("Nächster Tag: Morgen, Ziehen, 12.000 Schritte", (await page.textContent("main h1")) === "Morgen" && (await page.textContent("#tagTrain")).includes("Ziehen") && (await page.textContent("#tagStepsOut")) === "12.000");
      await page.click("[data-a=tagStep][data-d='1000']");
      ok("+ 1.000 Schritte gespeichert", (await stored(page)).dayPlan[dk(1)].steps === 13000);
      await page.click("[data-a=tagStepDefault]");
      const st = await stored(page);
      ok("„… als Ziel für jeden Tag“ setzt das Standardziel", st.stepGoal === 13000 && !st.dayPlan[dk(1)]);
      await page.click("[data-a=tagFood]");
      ok("„Essen planen“ öffnet Essen für morgen („Geplant · Morgen“), Planen bis 14 Tage voraus", (await page.textContent(".head")).includes("Geplant · Morgen") && !(await page.$("[data-a=foodDay][data-d='1'][disabled]")) && !(await page.$("#waterBox")));
      for (let i = 0; i < 14; i++) await page.click("[data-a=foodDay][data-d='1']").catch(() => {});
      ok("Weiter als 14 Tage geht nicht", !!(await page.$("[data-a=foodDay][data-d='1'][disabled]")));
      ok("Tagesplan bei 360 px ohne seitliches Scrollen", await (async () => { await page.click("[data-a=tab][data-v=home]"); await page.click("#homeTag"); return noOverflow(page); })());
      await ctx.close();
    }

    section("61. Tagesplan: gegangene Schritte und Wochenleiste");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const wd = (new Date().getDay() + 6) % 7; // Montag = 0
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Drücken", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Ziehen", items: [{ id: "b1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const per = { k: 100, p: 0, c: 25, f: 0 };
      const { ctx, page } = await open({ plan, weights: [{ d: dk(0), kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null },
        sched: { days: [0, 1, 2, 3, 4, 5, 6], time: "18:00", planB: "next" }, stepGoal: 8000,
        dayPlan: { [dk(-1)]: { steps: 10000, act: 6000 }, [dk(0)]: { act: 3000 }, [dk(2)]: { act: 4000 }, "x": { act: 5 }, [dk(-2)]: { act: -1 } },
        food: { [dk(-1)]: [{ id: "f1", m: "m", n: "Testessen", src: "usda:1", g: 2000, per }], [dk(1)]: [{ id: "f2", m: "m", n: "Testessen", src: "usda:1", g: 1500, per }] } });
      const r = await tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        return { dp: JSON.parse(JSON.stringify(T.state.dayPlan)), y: T.dayEnergy(k(-1)), t: T.dayEnergy(k(0)), f: T.dayEnergy(k(2)), a2: T.actOn(k(2)),
          e1: T.dayEnergy(k(1)) }; });
      ok("Gegangene Schritte gespeichert, ungültige verworfen; künftige zählen nicht als gegangen",
        Object.keys(r.dp).length === 3 && r.dp[dk(-1)].act === 6000 && r.dp[dk(-1)].steps === 10000 && r.dp[dk(0)].act === 3000 && r.a2 === null && r.f.steps === 8000, JSON.stringify(r.dp));
      ok("Gestern: gegangen 6.000 statt Ziel 10.000 → 4,5 km, 218 kcal beim Gehen, 36 kcal über 5.000; Bilanz −795",
        r.y.steps === 6000 && r.y.plan === 10000 && r.y.act === 6000 && r.y.stepKcal === 218 && r.y.stepExtra === 36 && r.y.total === 2795 && r.y.intake === 2000 && r.y.balance === -795, JSON.stringify(r.y));
      ok("Heute 3.000 gegangen: unter 5.000, also nichts extra", r.t.steps === 3000 && r.t.stepExtra === 0 && r.t.stepKcal === 109, JSON.stringify(r.t));
      ok("Startseite: Tagesplan zeigt die gegangenen Schritte", (await page.textContent("#homeTag")).includes("3.000 Schritte gegangen"));
      // Bedienung: heute
      await page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`);
      ok("Heute: Feld „Heute gegangen“ mit 3.000, 38 % vom Ziel", (await page.inputValue("#tagAct")) === "3.000" && (await page.textContent("label[for=tagAct]")) === "Heute gegangen"
        && (await page.textContent("#tagStepInfo")).includes("Gegangen") && (await page.textContent("#tagStepInfo")).includes("38 % vom Ziel"));
      await page.fill("#tagAct", "6.500");
      ok("Eingabe 6.500: gespeichert, Anzeige und Bilanz sofort neu, Fokus bleibt im Feld",
        (await stored(page)).dayPlan[dk(0)].act === 6500 && (await page.textContent("#tagStepInfo")).includes("81 % vom Ziel")
        && (await page.textContent("#tagBalIn")).includes("gegangen") && (await page.evaluate(() => document.activeElement.id)) === "tagAct");
      await page.fill("#tagAct", "");
      ok("Feld leeren entfernt den Eintrag", !(await stored(page)).dayPlan[dk(0)] && (await page.textContent("#tagStepInfo")).includes("Geplant"));
      // Wochenleiste
      const strip = await page.$$eval(".tagweek .d", b => b.map(x => ({ d: x.dataset.d, on: x.getAttribute("aria-pressed"), dis: x.disabled })));
      ok("Wochenleiste: 7 Tage, heute gewählt", strip.length === 7 && strip.filter(x => x.on === "true").length === 1 && strip.find(x => x.on === "true").d === dk(0), JSON.stringify(strip));
      const exp = await tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        const mon = s => { const x = new Date(s + "T12:00"); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x.toDateString(); };
        const days = [-1, 1].filter(n => mon(k(n)) === mon(k(0)));
        return { n: days.length, bal: days.reduce((s, n) => s + T.dayEnergy(k(n)).balance, 0) }; });
      const sumTxt = (await page.textContent("#tagWeekSum")).replace(/\s+/g, " ");
      ok("Wochenbilanz: Tage mit Essen ohne heute, Summe stimmt", sumTxt.includes(`Woche ohne heute · ${exp.n} ${exp.n === 1 ? "Tag" : "Tage"} mit Essen`) && sumTxt.includes(`${exp.bal <= 0 ? "Defizit" : "Überschuss"} ≈ ${(Math.round(Math.abs(exp.bal) / 10) * 10).toLocaleString("de-DE")} kcal`), sumTxt + " / " + JSON.stringify(exp));
      // Anderen Tag der Woche wählen: Sonntag → Samstag (gestern), sonst morgen
      if (wd === 6) {
        await page.click(`.tagweek [data-d="${dk(-1)}"]`);
        ok("Tag in der Wochenleiste wählen: Gestern, Feld „Gegangen“ mit 6.000", (await page.textContent("main h1")) === "Gestern" && (await page.inputValue("#tagAct")) === "6.000" && (await page.textContent("label[for=tagAct]")) === "Gegangen");
      } else {
        await page.click(`.tagweek [data-d="${dk(1)}"]`);
        ok("Tag in der Wochenleiste wählen: Morgen, ohne Feld „gegangen“", (await page.textContent("main h1")) === "Morgen" && !(await page.$("#tagAct")));
        await page.click("[data-a=tagDay][data-d='-1']"); await page.click("[data-a=tagDay][data-d='-1']");
        ok("Zurück zu gestern: Feld „Gegangen“ mit 6.000", (await page.textContent("main h1")) === "Gestern" && (await page.inputValue("#tagAct")) === "6.000");
      }
      ok("Gestern: Ziel 10.000 bleibt neben den gegangenen Schritten", (await page.textContent("#tagStepsOut")) === "10.000");
      await page.click("[data-a=tagStepDefault]");
      const st = await stored(page);
      ok("Ziel als Standard übernehmen lässt die gegangenen Schritte stehen", st.stepGoal === 10000 && JSON.stringify(st.dayPlan[dk(-1)]) === '{"act":6000}', JSON.stringify(st.dayPlan));
      // Tage außerhalb des Bereichs (7 Tage zurück bis 14 voraus) sind gesperrt
      await page.click("[data-a=tagDay][data-d='1']"); // von gestern zurück zu heute (montags liegt gestern in der Vorwoche)
      for (let i = 0; i < (wd ? 7 : 14); i++) await page.click(`[data-a=tagDay][data-d='${wd ? -1 : 1}']`);
      const dis = await page.$$eval(".tagweek .d:disabled", b => b.length);
      ok("Wochenleiste: Tage außerhalb des Planbereichs gesperrt", dis === (wd ? wd : 6), String(dis));
      await page.setViewportSize({ width: 320, height: 640 });
      await page.click(`.tagweek [data-d="${wd ? dk(-7) : dk(14)}"]`).catch(() => {});
      ok("Tagesplan mit Wochenleiste bei 320 px ohne seitliches Scrollen", await noOverflow(page), await overflowers(page));
      await ctx.close();
    }

    section("62. Tagesplan: Training je Tag ändern (anderes Training oder Ruhetag)");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const it = (id, exId) => [{ id, exId, sets: 3, rmin: 8, rmax: 12, rest: 90 }];
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Drücken", items: it("a1", "hs-chest") }, { id: "b", name: "Ziehen", items: it("b1", "hs-row") }, { id: "c", name: "Beine", items: it("c1", "hs-legpress") }] };
      const { ctx, page } = await open({ plan, weights: [{ d: dk(0), kg: 80 }],
        sched: { days: [0, 1, 2, 3, 4, 5, 6], time: "23:59", planB: "next", since: new Date().toISOString() },
        dayPlan: { [dk(5)]: { train: "zzz" }, [dk(6)]: { train: 7 } } });
      const names = () => tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        return [0, 1, 2, 3, 4].map(n => { const p = T.plannedOn(k(n)); return p ? p.name : "-"; }).join(","); });
      ok("Ohne Änderung: Ablauf an jedem Termin", (await names()) === "Drücken,Ziehen,Beine,Drücken,Ziehen", await names());
      const bad = await tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        return { p5: T.plannedOn(k(5)), dp: JSON.parse(JSON.stringify(T.state.dayPlan)) }; });
      ok("Ungültige Änderungen: Text bleibt, Zahl verworfen; unbekanntes Training fällt auf den Ablauf zurück", bad.p5 && bad.p5.dayId !== "zzz" && bad.dp[dk(5)].train === "zzz" && !bad.dp[dk(6)], JSON.stringify(bad));
      // Morgen Beine statt Ziehen
      await page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`);
      await page.click("[data-a=tagDay][data-d='1']");
      ok("Tagesplan morgen: Auswahl aller Trainingstage und Ruhetag, aktuelles markiert",
        (await page.$$("#tagTrainPick [data-a=tagTrain]")).length === 4 && (await page.getAttribute("#tagTrainPick [data-v=b]", "aria-pressed")) === "true");
      await page.click("#tagTrainPick [data-v=c]");
      ok("Morgen Beine: gespeichert, als geändert markiert, danach geht der Ablauf mit Drücken weiter",
        (await stored(page)).dayPlan[dk(1)].train === "c" && (await page.textContent("#tagTrain")).includes("geändert") && (await names()) === "Drücken,Beine,Drücken,Ziehen,Beine", await names());
      // Übermorgen Ruhetag
      await page.click("[data-a=tagDay][data-d='1']");
      await page.click("#tagTrainPick [data-v=rest]");
      ok("Übermorgen Ruhetag: kein Training, Ablauf rückt einen Tag weiter", (await names()) === "Drücken,Beine,-,Drücken,Ziehen" && (await page.textContent("#tagTrain")).includes("Ruhetag – von dir geplant"), await names());
      ok("Termin-Logik: übermorgen ist kein Trainingstag mehr", await tp(page, () => { const T = window.__tp, x = new Date(Date.now() + 2 * 864e5); return !T.isTrainDate(x); }));
      await page.click("[data-a=tagTrainAuto]");
      ok("„Zurück zum Ablauf“ entfernt die Änderung", !(await stored(page)).dayPlan[dk(2)] && (await names()) === "Drücken,Beine,Drücken,Ziehen,Beine", await names());
      // Wahl wie im Ablauf speichert nichts
      await page.click("#tagTrainPick [data-v=a]");
      ok("Training wählen, das ohnehin dran ist: keine Änderung gespeichert", !(await stored(page)).dayPlan[dk(2)]);
      // Heute ändern: Startseite zeigt das gewählte Training
      for (let i = 0; i < 2; i++) await page.click("[data-a=tagDay][data-d='-1']");
      await page.click("#tagTrainPick [data-v=b]");
      await page.click("[data-a=tab][data-v=home]");
      ok("Heute Ziehen gewählt: Startseite schlägt Ziehen vor", (await page.textContent(".hero-name")) === "Ziehen" && (await tp(page, () => window.__tp.nextDay().name)) === "Ziehen");
      // Heute Ruhetag: Startseite sagt trainingsfrei und nennt das nächste Training (morgen Beine)
      await page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`);
      await page.click("#tagTrainPick [data-v=rest]");
      // Termine seit drei Tagen: ein ausgefallener Termin davor darf den geplanten Ruhetag nicht zu „heute nachholen“ machen
      await tp(page, () => { window.__tp.state.sched.since = new Date(Date.now() - 3 * 864e5).toISOString(); });
      await page.click("[data-a=tab][data-v=home]");
      const homeTxt = (await page.textContent("main")).replace(/\s+/g, " ");
      ok("Heute Ruhetag: „Heute ist trainingsfrei“, nächstes Training morgen Beine, kein „heute nachholen“", homeTxt.includes("Heute ist trainingsfrei") && homeTxt.includes("morgen um 23:59 – Beine") && !homeTxt.includes("heute nachholen") && (await page.textContent(".hero-name")) === "Beine", homeTxt.slice(0, 300));
      await tp(page, () => { window.__tp.state.sched.since = new Date().toISOString(); });
      // „Anderes Training wählen“ auf der Startseite ersetzt die Änderung für heute
      await page.click("[data-a=pickDay]"); await page.click("[data-a=selDay][data-id=a]");
      ok("„Anderes Training wählen“ ersetzt die Änderung für heute", !((await stored(page)).dayPlan[dk(0)] || {}).train && (await page.textContent(".hero-name")) === "Drücken");
      // Vergangene Tage: keine Auswahl; geplanter Ruhetag zählt nicht als verpasst
      const miss = await tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        T.state.sched.since = new Date(Date.now() - 4 * 864e5).toISOString(); T.state.dayPlan[k(-1)] = { train: "rest" };
        const r = T.missToAsk(); T.state.sched.since = new Date().toISOString(); delete T.state.dayPlan[k(-1)]; return r; });
      ok("Geplanter Ruhetag gilt nicht als verpasster Termin (gefragt wird nach dem Tag davor)", miss && miss.d === dk(-2), JSON.stringify(miss));
      await page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`); await page.click("[data-a=tagDay][data-d='-1']");
      ok("Gestern: keine Auswahl", !(await page.$("#tagTrainPick")));
      await page.setViewportSize({ width: 320, height: 640 });
      await page.click("[data-a=tagDay][data-d='1']"); await page.click("[data-a=tagDay][data-d='1']");
      ok("Auswahl bei 320 px ohne seitliches Scrollen", !!(await page.$("#tagTrainPick")) && await noOverflow(page));
      await ctx.close();
      // Ohne feste Termine keine Auswahl
      const o2 = await open({ plan, weights: [{ d: dk(0), kg: 80 }] });
      await o2.page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`);
      ok("Ohne feste Termine: keine Auswahl, Hinweis auf Termine", !(await o2.page.$("#tagTrainPick")) && (await o2.page.textContent("#tagTrain")).includes("Ohne feste Termine"));
      await o2.ctx.close();
    }

    section("63. Tagesplan: Wochenansicht");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const wd = (new Date().getDay() + 6) % 7; // Montag = 0
      const it = (id, exId) => [{ id, exId, sets: 3, rmin: 8, rmax: 12, rest: 90 }];
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Drücken", items: it("a1", "hs-chest") }, { id: "b", name: "Ziehen", items: it("b1", "hs-row") }] };
      const per = { k: 100, p: 0, c: 25, f: 0 };
      const { ctx, page } = await open({ plan, weights: [{ d: dk(0), kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null },
        sched: { days: [0, 1, 2, 3, 4, 5, 6], time: "23:59", planB: "next", since: new Date().toISOString() }, stepGoal: 8000, dayPlan: { [dk(0)]: { act: 5000 } },
        food: { [dk(-1)]: [{ id: "f1", m: "m", n: "Testessen", src: "usda:1", g: 2000, per }], [dk(1)]: [{ id: "f2", m: "m", n: "Testessen", src: "usda:1", g: 1500, per }] } });
      await page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`);
      ok("Tagesplan: Umschalter Tag/Woche, Tag gewählt", (await page.getAttribute("#tagSeg [data-v=tag]", "aria-pressed")) === "true" && (await page.getAttribute("#tagSeg [data-v=woche]", "aria-pressed")) === "false");
      await page.click("#tagSeg [data-v=woche]");
      const rows = await page.$$eval("#tagWeekList .li", b => b.map(x => ({ d: x.dataset.d, t: x.textContent.replace(/\s+/g, " ").trim(), dis: x.disabled })));
      const row = n => rows.find(r => r.d === dk(n));
      ok("Woche: Titel, 7 Tage von Montag an", (await page.textContent("main h1")) === "Woche" && rows.length === 7 && new Date(rows[0].d + "T12:00").getDay() === 1, JSON.stringify(rows.map(r => r.d)));
      ok("Heute: „Heute“, gegangene Schritte, Training", row(0).t.includes("Heute") && row(0).t.includes("5.000 Schritte gegangen") && row(0).t.includes("Drücken") && row(0).t.includes("kein Essen eingetragen"), row(0).t);
      const e = await tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        return { m: T.dayEnergy(k(1)).balance, g: T.dayEnergy(k(-1)).balance }; });
      const other = wd === 6 ? { n: -1, kc: "2.000 kcal gegessen", bal: e.g } : { n: 1, kc: "1.500 kcal geplant", bal: e.m };
      ok("Anderer Tag mit Essen: Kalorien und Bilanz in der Zeile", row(other.n).t.includes(other.kc) && row(other.n).t.includes(`${other.bal <= 0 ? "Defizit" : "Überschuss"} ≈ ${(Math.round(Math.abs(other.bal) / 10) * 10).toLocaleString("de-DE")}`), row(other.n).t);
      // Zeile antippen öffnet den Tag
      await page.click(`#tagWeekList [data-d="${dk(other.n)}"]`);
      ok("Zeile antippen öffnet den Tag", (await page.textContent("main h1")) === (other.n === 1 ? "Morgen" : "Gestern") && (await page.getAttribute("#tagSeg [data-v=tag]", "aria-pressed")) === "true");
      // Wochen blättern bis an den Rand des Planbereichs
      await page.click("#tagSeg [data-v=woche]");
      await page.click(`#tagWeekList [data-d="${dk(0)}"]`); await page.click("#tagSeg [data-v=woche]");
      await page.click("[data-a=tagDay][data-d='1']"); await page.click("[data-a=tagDay][data-d='1']");
      const fwd = await page.$$eval("#tagWeekList .li:disabled", b => b.length);
      ok("Zwei Wochen weiter: Tage nach dem Planbereich gesperrt, „Nächste Woche“ aus", fwd === 6 - wd && !!(await page.$("[data-a=tagDay][data-d='1'][disabled]")), String(fwd));
      for (let i = 0; i < 3; i++) await page.click("[data-a=tagDay][data-d='-1']");
      const back = await page.$$eval("#tagWeekList .li:disabled", b => b.length);
      ok("Eine Woche zurück: Tage vor dem Planbereich gesperrt, „Vorherige Woche“ aus", back === wd && !!(await page.$("[data-a=tagDay][data-d='-1'][disabled]")), String(back));
      ok("Wochenansicht bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      // Von der Startseite öffnet sich immer der Tag
      await page.click("[data-a=tab][data-v=home]"); await page.click(`.week [data-a=openTag][data-d="${dk(0)}"]`);
      ok("Von der Startseite: Tagesansicht", (await page.textContent("main h1")) === "Heute");
      await ctx.close();
    }

    section("64. Essen: Tag auf andere Tage kopieren");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const e = (id, m, n, g) => ({ id, m, n, src: "usda:1", g, per: { k: 100, p: 10, c: 10, f: 2 } });
      const { ctx, page } = await open({ plan: PLAN_SMALL, nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null }, weights: [{ d: dk(0), kg: 80 }],
        food: { [dk(0)]: [e("a", "f", "Haferflocken", 200), e("b", "m", "Reis", 300)], [dk(2)]: [e("c", "a", "Brot", 100)] } });
      await page.click("[data-a=tab][data-v=food]");
      await page.click("#foodCopy");
      const chips = await page.$$eval("#copyDays [data-a=copyTgt]", b => b.map(x => ({ d: x.dataset.d, t: x.textContent })));
      ok("Kopieren: 14 Zieltage (bis 14 Tage voraus, ohne den Tag selbst), vorhandene Einträge angezeigt",
        chips.length === 14 && !chips.some(c => c.d === dk(0)) && chips.find(c => c.d === dk(2)).t.includes("· 1") && (await page.textContent(".sheet")).includes("2 Einträge · 500 kcal von heute"), JSON.stringify(chips.slice(0, 3)));
      ok("Ohne Auswahl: Kopieren aus", !!(await page.$("[data-a=copyDo][disabled]")));
      await page.click(`#copyDays [data-d="${dk(1)}"]`); await page.click(`#copyDays [data-d="${dk(2)}"]`);
      ok("Zwei Tage gewählt: „Auf 2 Tage kopieren“, „Behalten“ voreingestellt",
        (await page.textContent("[data-a=copyDo]")) === "Auf 2 Tage kopieren" && (await page.getAttribute("#copyMode [data-v=add]", "aria-pressed")) === "true" && (await page.getAttribute(`#copyDays [data-d="${dk(1)}"]`, "aria-pressed")) === "true");
      await page.click("[data-a=copyDo]");
      let st = await stored(page);
      const ids = new Set([...st.food[dk(0)], ...st.food[dk(1)], ...st.food[dk(2)]].map(x => x.id));
      ok("Kopiert: morgen 2 Einträge, übermorgen 1 + 2, eigene IDs, Quelle unverändert",
        st.food[dk(1)].length === 2 && st.food[dk(2)].length === 3 && st.food[dk(2)][0].n === "Brot" && st.food[dk(0)].length === 2 && ids.size === 7 && (await page.textContent("#foodNote")).includes("Auf 2 Tage kopiert"));
      await page.click("[data-a=copyUndo]");
      st = await stored(page);
      ok("Rückgängig: Zieltage wie vorher", !st.food[dk(1)] && st.food[dk(2)].length === 1 && (await page.textContent("#foodNote")).includes("rückgängig gemacht"));
      // Ersetzen
      await page.click("#foodCopy"); await page.click(`#copyDays [data-d="${dk(2)}"]`); await page.click("#copyMode [data-v=replace]"); await page.click("[data-a=copyDo]");
      st = await stored(page);
      ok("Ersetzen: übermorgen genau die 2 Einträge von heute", st.food[dk(2)].length === 2 && st.food[dk(2)].map(x => x.n).join() === "Haferflocken,Reis");
      // Rückgängig nach späterer Änderung verweigert
      await page.click("#foodCopy"); await page.click(`#copyDays [data-d="${dk(3)}"]`); await page.click("[data-a=copyDo]");
      await tp(page, () => { const k = new Date(Date.now() + 3 * 864e5), key = `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, "0")}-${String(k.getDate()).padStart(2, "0")}`; window.__tp.state.food[key].pop(); });
      await page.click("[data-a=copyUndo]");
      const n3 = await tp(page, () => { const k = new Date(Date.now() + 3 * 864e5), key = `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, "0")}-${String(k.getDate()).padStart(2, "0")}`; return window.__tp.state.food[key].length; });
      ok("Rückgängig nach späterer Änderung: nichts überschrieben, Hinweis", n3 === 1 && (await page.textContent("#foodNote")).includes("Nicht mehr rückgängig"));
      // Hinweis verschwindet beim Tageswechsel; Tag ohne Einträge hat keinen Knopf
      await page.click("[data-a=foodDay][data-d='1']");
      ok("Tageswechsel: Hinweis weg; Tag ohne Einträge: kein Kopieren-Knopf", !(await page.$("#foodNote")) && !(await page.$("#foodCopy")));
      await page.click("[data-a=foodDay][data-d='-1']");
      await page.setViewportSize({ width: 320, height: 640 }); await page.click("#foodCopy"); await page.waitForTimeout(350);
      ok("Kopieren-Sheet bei 320 px ohne seitliches Scrollen", await noOverflow(page) && await page.evaluate(() => { const s = document.querySelector(".sheet"); return s.scrollWidth <= s.clientWidth; }));
      await ctx.close();
    }

    section("65. Tagesplan: Cardio (Crosstrainer, Fahrrad-Ergometer, Rudergerät)");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const seed = { plan: PLAN_SMALL, weights: [{ d: dk(0), kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null },
        dayPlan: { [dk(0)]: { cardio: [{ t: "cross", i: "m", min: 30 }, { t: "zzz", i: "m", min: 30 }, { t: "bike", i: "v", min: 7.5 }, { t: "row", i: "v", min: 500 }, { t: "row", i: "x", min: 20 }] } } };
      const { ctx, page } = await open(seed);
      const r = await tp(page, () => { const T = window.__tp, x = new Date(), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
        const C = T.CARDIO, kc = (t, i, min) => T.cardioKcalOf({ t, i, min }, 80);
        return { dp: JSON.parse(JSON.stringify(T.state.dayPlan[k])), E: T.dayEnergy(k),
          met: Object.entries(C).map(([id, c]) => id + ":" + Object.values(c.lv).map(l => l.met + "/" + l.code).join(",")).join(" "),
          kc: [kc("cross", "m", 30), kc("cross", "v", 20), kc("bike", "m", 20), kc("bike", "v", 20), kc("row", "m", 60), kc("row", "v", 30)] }; });
      ok("MET-Werte und Codes wie im Compendium 2024", r.met === "cross:5/02048,9/02049 bike:5/01216,6/01220 row:5/02071,7.3/02070", r.met);
      ok("Verbrauch netto (MET − 1) × kg × Stunden bei 80 kg: 160, 213, 107, 133, 320, 252 kcal", JSON.stringify(r.kc) === "[160,213,107,133,320,252]", JSON.stringify(r.kc));
      ok("Ungültige Einträge verworfen (unbekanntes Gerät, halbe Minuten, über 300 Min., unbekannte Stufe)", JSON.stringify(r.dp) === '{"cardio":[{"t":"cross","i":"m","min":30}]}', JSON.stringify(r.dp));
      ok("Tagesverbrauch: 2.759 + 160 kcal Cardio", r.E.cardioKcal === 160 && r.E.cardioMin === 30 && r.E.total === 2919 && r.E.extra === 160, JSON.stringify(r.E));
      await page.click("#homeTag");
      const sec = (await page.textContent("#tagCardio")).replace(/\s+/g, " ");
      ok("Tagesplan: Abschnitt Cardio mit Eintrag und Kalorien, Zeile in der Bilanz", sec.includes("Crosstrainer · 30 Min.") && sec.includes("≈ 160 kcal") && sec.includes("+ Cardio eintragen")
        && (await page.textContent("#tagBalIn")).replace(/\s+/g, " ").includes("Cardio · 30 Min.+ 160 kcal"), sec);
      // Hinzufügen
      await page.click("[data-a=tagCardioOpen]");
      ok("Sheet: Crosstrainer, mäßig, 20 Min. voreingestellt → ≈ 107 kcal, 5,0 MET mit Quelle",
        (await page.textContent(".sheet h2")) === "Cardio eintragen" && (await page.textContent("#cardioMinOut")) === "20 Min." && (await page.textContent("#cardioKcal")).includes("≈ 107 kcal")
        && (await page.textContent("#cardioDesc")) === "Crosstrainer, mäßige Anstrengung: 5,0 MET (Compendium 2024)");
      await page.click("#cardioType [data-v=bike]");
      const b1 = await page.textContent("#cardioKcal"); await page.click("#cardioLv [data-v=v]");
      ok("Fahrrad-Ergometer: 60 Watt ≈ 107 kcal, 90–100 Watt ≈ 133 kcal (6,0 MET)", b1.includes("≈ 107 kcal") && (await page.textContent("#cardioKcal")).includes("≈ 133 kcal")
        && (await page.textContent("#cardioDesc")).includes("90–100 Watt, mäßige bis hohe Anstrengung: 6,0 MET") && (await page.textContent("#cardioLv")).replace(/\s+/g, "") === "60Watt90–100Watt");
      await page.click("#cardioType [data-v=row]"); await page.click("[data-a=cardioMin][data-d='5']"); await page.click("[data-a=cardioMin][data-d='5']");
      ok("Rudergerät anstrengend, 30 Min.: ≈ 252 kcal (7,3 MET)", (await page.textContent("#cardioMinOut")) === "30 Min." && (await page.textContent("#cardioKcal")).includes("≈ 252 kcal") && (await page.textContent("#cardioDesc")).includes("7,3 MET"));
      await page.click("[data-a=cardioAdd]");
      let st = await stored(page);
      ok("Hinzugefügt und gespeichert; Bilanz zählt beide (60 Min., + 412 kcal)", JSON.stringify(st.dayPlan[dk(0)].cardio[1]) === '{"t":"row","i":"v","min":30}'
        && (await page.textContent("#tagBalIn")).replace(/\s+/g, " ").includes("Cardio · 60 Min.+ 412 kcal") && !(await page.$(".sheet")));
      // Grenzen der Dauer
      await page.click("[data-a=tagCardioOpen]"); for (let i = 0; i < 3; i++) await page.click("[data-a=cardioMin][data-d='-5']");
      ok("Dauer mindestens 5 Min.", (await page.textContent("#cardioMinOut")) === "5 Min." && !!(await page.$("[data-a=cardioMin][data-d='-5'][disabled]")));
      await page.setViewportSize({ width: 320, height: 640 }); await page.waitForTimeout(350);
      ok("Cardio-Sheet bei 320 px ohne seitliches Scrollen", await noOverflow(page) && await page.evaluate(() => { const s = document.querySelector(".sheet"); return s.scrollWidth <= s.clientWidth; }));
      await page.click("[data-a=closeSheet].btn"); await page.setViewportSize({ width: 360, height: 780 });
      // Wochenliste
      await page.click("#tagSeg [data-v=woche]");
      ok("Wochenansicht nennt Cardio", (await page.textContent(`#tagWeekList [data-d="${dk(0)}"]`)).includes("Cardio 60 Min."));
      await page.click("#tagSeg [data-v=tag]");
      // Entfernen
      await page.click("[data-a=tagCardioDel][data-n='0']");
      st = await stored(page);
      ok("Entfernen: nur das Rudergerät bleibt", st.dayPlan[dk(0)].cardio.length === 1 && st.dayPlan[dk(0)].cardio[0].t === "row");
      await page.click("[data-a=tagCardioDel][data-n='0']");
      ok("Letzten Eintrag entfernen räumt den Tag auf", !(await stored(page)).dayPlan[dk(0)] && !(await page.textContent("#tagBalIn")).includes("Cardio ·"));
      // Morgen planen
      await page.click("[data-a=tagDay][data-d='1']"); await page.click("[data-a=tagCardioOpen]");
      ok("Morgen: „Cardio planen“", (await page.textContent(".sheet h2")) === "Cardio planen");
      await page.click("[data-a=cardioAdd]");
      ok("Für morgen geplant", JSON.stringify((await stored(page)).dayPlan[dk(1)]) === '{"cardio":[{"t":"cross","i":"m","min":20}]}');
      // Höchstens 6 Einträge
      await tp(page, () => { const T = window.__tp, x = new Date(Date.now() + 864e5), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
        T.state.dayPlan[k].cardio = Array.from({ length: 6 }, () => ({ t: "bike", i: "m", min: 10 })); });
      await page.click("[data-a=tagDay][data-d='-1']"); await page.click("[data-a=tagDay][data-d='1']");
      ok("Sechs Einträge: kein weiterer möglich", (await page.$$("[data-a=tagCardioDel]")).length === 6 && !(await page.$("[data-a=tagCardioOpen]")));
      // „Mäßig aktiv“: im Faktor enthalten
      const mod = await tp(page, () => { const T = window.__tp, x = new Date(Date.now() + 864e5), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
        T.state.nutr.pal = 1.85; const e = T.dayEnergy(k); return e; });
      await page.click("[data-a=tagDay][data-d='-1']"); await page.click("[data-a=tagDay][data-d='1']");
      ok("„Mäßig aktiv“: Cardio nicht doppelt gezählt, Hinweis nennt Cardio", mod.extra === 0 && mod.total === mod.G.tdee && mod.cardioKcal === 318 && (await page.textContent("#tagBalIn")).includes("Training, Cardio und Schritte sind in deinem Aktivitätsfaktor schon enthalten"), JSON.stringify(mod));
      await page.click("#tagBal ~ details summary");
      ok("Rechenweg nennt die Cardio-Werte und die Quelle", await page.evaluate(() => { const d = document.querySelector("details.disc"); return d.textContent.includes("Crosstrainer 5,0 MET") && d.textContent.includes("Rudergerät 5,0 MET") && d.textContent.includes("7,3 MET") && d.textContent.includes("2024 Adult Compendium"); }));
      await ctx.close();
      // Ohne Ziele: Einträge möglich, Kalorien fehlen mit Hinweis
      const o2 = await open({ plan: PLAN_SMALL });
      await o2.page.click("#homeTag"); await o2.page.click("[data-a=tagCardioOpen]");
      const hint = await o2.page.textContent("#cardioKcal"); await o2.page.click("[data-a=cardioAdd]");
      ok("Ohne Ziele: Eintrag ohne Kalorien, Hinweis auf die Ziele", hint.includes("fehlen deine Ziele") && (await o2.page.textContent("#tagCardio")).includes("Crosstrainer · 20 Min.") && !(await o2.page.textContent("#tagCardio")).includes("kcal"));
      await o2.ctx.close();
    }

    section("66. Startseite: „Angepasst“ nur beim Vorschlag der App, nicht bei selbst gewähltem Training");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const it = (id, exId) => [{ id, exId, sets: 4, rmin: 8, rmax: 12, rest: 90 }];
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Brust A", items: it("a1", "hs-chest") }, { id: "b", name: "Brust B", items: it("b1", "hs-fly") }, { id: "c", name: "Beine", items: it("c1", "hs-legpress") }] };
      const history = [{ id: "h1", dayId: "a", day: "Brust A", date: new Date(Date.now() - 20 * 3600e3).toISOString(), durationSec: 2400,
        exercises: [{ exId: "hs-chest", name: "hs-chest", u: "s", planned: 4, rmin: 8, rmax: 12, sets: Array.from({ length: 4 }, () => ({ kg: 40, reps: 10 })) }] }];
      // Uhrzeit fest auf 12:00, damit das letzte Training (vor 20 Stunden) sicher gestern liegt
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: "dark", serviceWorkers: "block" });
      const noon = new Date(); noon.setHours(12, 0, 0, 0); await ctx.clock.install({ time: noon });
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message));
      await page.goto(URL);
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify({ plan, history: [Object.assign({}, history[0], { date: new Date(noon.getTime() - 20 * 3600e3).toISOString() })], hints: { units: true },
        backupAt: noon.toISOString(), sched: { days: [0, 1, 2, 3, 4, 5, 6], time: "23:59", planB: "next", since: noon.toISOString() } })]);
      await page.reload();
      const read = async () => ({ cap: await page.textContent(".hero-meta .cap"), name: await page.textContent(".hero-name"), txt: (await page.textContent(".hero")).replace(/\s+/g, " ") });
      let h = await read();
      ok("Vorschlag der App: Brust nicht erholt → „Angepasst“, Beine, mit Begründung", h.cap === "Angepasst" && h.name === "Beine" && h.txt.includes("Heute lieber Beine, Brust B danach"), JSON.stringify(h));
      const kToday = await page.evaluate(() => { const x = new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; });
      await page.click(`.week [data-a=openTag][data-d="${kToday}"]`);
      ok("Tagesplan zeigt für heute denselben Vorschlag (Beine)", (await page.textContent("#tagTrain .t")) === "Beine" && (await page.getAttribute("#tagTrainPick [data-v=c]", "aria-pressed")) === "true");
      await page.click("#tagTrainPick [data-v=b]"); await page.click("[data-a=tab][data-v=home]");
      h = await read();
      ok("Im Tagesplan Brust B gewählt: kein „Angepasst“, keine fremde Begründung", h.cap !== "Angepasst" && h.name === "Brust B" && !h.txt.includes("Heute lieber"), JSON.stringify(h));
      await page.click(`.week [data-a=openTag][data-d="${kToday}"]`); await page.click("[data-a=tagTrainAuto]"); await page.click("[data-a=tab][data-v=home]");
      h = await read();
      ok("Zurück zum Ablauf: wieder der Vorschlag mit Begründung", h.cap === "Angepasst" && h.name === "Beine", JSON.stringify(h));
      await page.click("[data-a=pickDay]"); await page.click("[data-a=selDay][data-id=b]");
      h = await read();
      ok("„Anderes Training wählen“ → Brust B: kein „Angepasst“ (vorher erst nach Neuladen richtig)", h.cap !== "Angepasst" && h.name === "Brust B" && !h.txt.includes("Heute lieber"), JSON.stringify(h));
      await ctx.close();
    }

    section("67. Tagesplan: Tagesziel und Ausgleich");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const e = (id, g) => [{ id, m: "m", n: "Testessen", src: "usda:1", g, per: { k: 100, p: 0, c: 25, f: 0 } }];
      const { ctx, page } = await open({ plan: PLAN_SMALL, weights: [{ d: dk(0), kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null }, stepGoal: 8000,
        food: { [dk(0)]: e("f0", 2700), [dk(1)]: e("f1", 1500), [dk(-1)]: e("f2", 2600) } });
      const txt = async id => (await page.$(id)) ? (await page.textContent(id)).replace(/\s+/g, " ").trim() : null;
      const rerender = async () => { await page.click("[data-a=tagDay][data-d='1']"); await page.click("[data-a=tagDay][data-d='-1']"); };
      ok("Startseite: Zeile „Tagesplan“ nennt den Abstand zum Tagesziel statt „Defizit bisher“", (await page.textContent("#homeTag")).includes("≈ 240 kcal über dem Tagesziel") && !(await page.textContent("#homeTag")).includes("Defizit"), await page.textContent("#homeTag"));
      await page.click("#homeTag");
      // Verbrauch 2.759 + 109 (Schritte) = 2.868, Tagesziel 2.868 − 409 = 2.459, gegessen 2.700 → 241 darüber
      ok("Heute über dem Ziel: ≈ 240 kcal über dem Tagesziel (geschätzt, auf 10 kcal gerundet), Rechenweg genau dabei", (await txt("#tagGoal")) === "≈ 240 kcal über deinem Tagesziel." && (await txt("#tagGoalHow")) === "Tagesziel 2.459 kcal = Verbrauch 2.868 − 409 kcal („Abnehmen“).", (await txt("#tagGoal")) + " | " + (await txt("#tagGoalHow")));
      // 241 kcal: 241 / (0,6061 × 80 × 0,75 m / 1000) ≈ 6.627 → 6.700 Schritte; 241 / (4 × 80 / 60) ≈ 45,2 → 50 Min.
      ok("Ausgleich: weniger essen, ≈ 6.700 Schritte mehr oder ≈ 50 Min. Crosstrainer", (await txt("#tagComp")) === "Ausgleich: ≈ 240 kcal weniger essen oder ≈ 6.700 Schritte mehr oder ≈ 50 Min. Crosstrainer (mäßig).", await txt("#tagComp"));
      await page.fill("#tagAct", "14.700"); // 9.700 Schritte über 5.000 → + 353 kcal, Tagesziel 2.703
      ok("Gegangene Schritte eingetragen: Zeile rechnet sofort neu (noch 3 kcal: „ungefähr auf deinem Tagesziel“), Ausgleich weg", (await txt("#tagGoal")) === "Du liegst ungefähr auf deinem Tagesziel." && !(await page.$("#tagComp")), await txt("#tagGoal"));
      await page.fill("#tagAct", "");
      await page.click("[data-a=tagDay][data-d='1']");
      ok("Morgen geplant 1.500 kcal: 959 kcal unter dem Tagesziel (angezeigt ≈ 960)", (await txt("#tagGoal")) === "Geplant: ≈ 960 kcal unter deinem Tagesziel.", await txt("#tagGoal"));
      await page.click("[data-a=tagDay][data-d='1']");
      ok("Übermorgen ohne Essen: „Zu deinem Ziel passen an diesem Tag ≈ 2.460 kcal“ (2.459)", (await txt("#tagGoal")) === "Zu deinem Ziel passen an diesem Tag ≈ 2.460 kcal.", await txt("#tagGoal"));
      for (let i = 0; i < 3; i++) await page.click("[data-a=tagDay][data-d='-1']");
      ok("Gestern 2.600 kcal: 141 kcal über dem Tagesziel (angezeigt ≈ 140), kein Ausgleich für vergangene Tage", (await txt("#tagGoal")) === "≈ 140 kcal über deinem Tagesziel." && !(await page.$("#tagComp")), await txt("#tagGoal"));
      await page.click("[data-a=tagDay][data-d='-1']");
      ok("Vorgestern ohne Essen: nur der Rechenweg", !(await page.$("#tagGoal")) && !!(await page.$("#tagGoalHow")));
      for (let i = 0; i < 2; i++) await page.click("[data-a=tagDay][data-d='1']");
      // Sehr viel über dem Ziel: unrealistische Vorschläge entfallen
      await tp(page, () => { const T = window.__tp, x = new Date(), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; T.state.food[k][0].g = 4500; });
      await rerender();
      ok("2.041 kcal darüber: nur „weniger essen“ (über 15.000 Schritte oder 90 Min. schlägt die App nicht vor)", (await txt("#tagComp")) === "Ausgleich: ≈ 2.040 kcal weniger essen.", await txt("#tagComp"));
      // „Mäßig aktiv“: Bewegung im Faktor, kein Ausgleich über Bewegung
      await tp(page, () => { const T = window.__tp, x = new Date(), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; T.state.food[k][0].g = 3000; T.state.nutr.pal = 1.85; });
      await rerender();
      ok("„Mäßig aktiv“ (Verbrauch 3.293, Ziel 2.800): 200 kcal darüber, ohne Ausgleichsvorschlag", (await txt("#tagGoal")) === "≈ 200 kcal über deinem Tagesziel." && !(await page.$("#tagComp")) && (await txt("#tagGoalHow")) === "Tagesziel 2.800 kcal = Verbrauch 3.293 − 493 kcal („Abnehmen“).", (await txt("#tagGoal")) + " | " + (await txt("#tagGoalHow")));
      // Aufbauen: Ziel über dem Verbrauch, kein Ausgleich
      await tp(page, () => { const T = window.__tp, x = new Date(), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; T.state.food[k][0].g = 3300; T.state.nutr.pal = 1.55; T.state.nutr.goal = "auf"; });
      await rerender();
      ok("„Aufbauen“: Tagesziel 3.139 kcal = Verbrauch 2.868 + 271, 161 kcal darüber (angezeigt ≈ 160), kein Ausgleich", (await txt("#tagGoal")) === "≈ 160 kcal über deinem Tagesziel." && !(await page.$("#tagComp")) && (await txt("#tagGoalHow")) === "Tagesziel 3.139 kcal = Verbrauch 2.868 + 271 kcal („Aufbauen“).", (await txt("#tagGoal")) + " | " + (await txt("#tagGoalHow")));
      await tp(page, () => { window.__tp.state.nutr.goal = "halten"; });
      await rerender();
      ok("„Halten“: Tagesziel gleich Verbrauch", (await txt("#tagGoalHow")) === "Tagesziel 2.868 kcal = Verbrauch 2.868 kcal („Halten“).", await txt("#tagGoalHow"));
      await page.setViewportSize({ width: 320, height: 640 });
      await tp(page, () => { const T = window.__tp, x = new Date(), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; T.state.nutr.goal = "ab"; T.state.food[k][0].g = 2700; });
      await rerender();
      ok("Mit Ausgleichszeile bei 320 px ohne seitliches Scrollen", !!(await page.$("#tagComp")) && await noOverflow(page));
      await ctx.close();
    }

    section("68. Plan: Trainingstag 1:1 kopieren");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Drücken", items: [{ id: "a1", exId: "hs-chest", sets: 4, rmin: 6, rmax: 10, rest: 120 }, { id: "a2", exId: "hs-fly", sets: 2, rmin: 12, rmax: 15, rest: 60 }] },
        { id: "b", name: "Ziehen", items: [{ id: "b1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "c", name: "Leer", items: [] }] };
      const { ctx, page } = await open({ plan });
      const strip = items => JSON.stringify(items.map(({ id, ...r }) => r));
      const sig = items => items.map(i => [i.exId, i.sets, i.rmin, i.rmax, i.rest].join("/")).join(), A = "hs-chest/4/6/10/120,hs-fly/2/12/15/60";
      const openDay = async id => { await page.click("[data-a=tab][data-v=plan]"); await page.click(`[data-a=editDay][data-id="${id}"]`); };
      await openDay("c");
      ok("Leerer Tag: kein „Tag kopieren“", !(await page.$("#dayCopy")));
      await openDay("a"); await page.click("#dayCopy");
      const rows = await page.$$eval("#dayCopyList .li", b => b.map(x => x.textContent.replace(/\s+/g, " ").trim()));
      ok("Sheet: neuer Tag, „Ziehen“ (1 Gerät wird ersetzt), „Leer“ (noch leer); Quelle nicht als Ziel",
        rows.length === 3 && rows[0].includes("Neuer Trainingstag") && rows[0].includes("„Drücken (Kopie)“") && rows[1].includes("Ziehen") && rows[1].includes("1 Gerät wird ersetzt") && rows[2].includes("noch leer")
        && (await page.textContent(".sheet")).includes("2 Geräte mit Reihenfolge, Sätzen, Wiederholungen und Pausen"), JSON.stringify(rows));
      await page.click("[data-a=dayCopyDo][data-to=new]");
      let st = await stored(page), nd = st.plan.days[3];
      const ids = st.plan.days.flatMap(d => d.items.map(i => i.id));
      ok("Als neuer Tag: am Ende angelegt, Geräte 1:1 (Reihenfolge, Sätze, Wdh., Pausen), eigene IDs, Quelle unverändert",
        st.plan.days.length === 4 && nd.name === "Drücken (Kopie)" && sig(nd.items) === A && strip(nd.items) === strip(st.plan.days[0].items) && sig(st.plan.days[0].items) === A && new Set(ids).size === ids.length
        && (await page.textContent("main h1")) === "Mein Plan" && (await page.textContent("#planNote")).includes("als neuer Tag „Drücken (Kopie)“ angelegt"), JSON.stringify(nd));
      await page.click("[data-a=dayCopyUndo]");
      st = await stored(page);
      ok("Rückgängig entfernt den neuen Tag", st.plan.days.length === 3 && (await page.textContent("#planNote")).includes("rückgängig gemacht"));
      // In vorhandenen Tag: erst nachfragen, dann ersetzen
      await openDay("a"); await page.click("#dayCopy"); await page.click("[data-a=dayCopyAsk][data-to=b]");
      ok("Vorhandener Tag mit Geräten: Nachfrage nennt, was ersetzt wird", (await page.textContent(".sheet")).replace(/\s+/g, " ").includes("Das Gerät in „Ziehen“ wird durch die 2 Geräte aus „Drücken“ ersetzt. Der Name „Ziehen“ bleibt") && (await stored(page)).plan.days[1].items.length === 1);
      await tp(page, () => { window.__tp.state.timeplan = { dayId: "b", date: "2000-01-01", minutes: 30, keep: {}, replace: {}, ex: 1, sets: 1, est: 10 }; });
      await page.click("[data-a=dayCopyDo][data-to=b]");
      st = await stored(page);
      ok("Ersetzt: „Ziehen“ hat die Geräte von „Drücken“ 1:1, Name bleibt, alte Zeit-Anpassung verworfen",
        st.plan.days[1].name === "Ziehen" && sig(st.plan.days[1].items) === A && strip(st.plan.days[1].items) === strip(st.plan.days[0].items) && st.plan.days[1].items[0].id !== "a1" && !st.timeplan && (await page.textContent("#planNote")).includes("„Drücken“ nach „Ziehen“ kopiert"));
      await page.click("[data-a=dayCopyUndo]");
      st = await stored(page);
      ok("Rückgängig stellt „Ziehen“ wieder her", st.plan.days[1].items.length === 1 && st.plan.days[1].items[0].id === "b1" && sig(st.plan.days[1].items) === "hs-row/3/8/12/90");
      // Leerer Zieltag: ohne Nachfrage
      await openDay("a"); await page.click("#dayCopy"); await page.click("[data-a=dayCopyDo][data-to=c]");
      st = await stored(page);
      ok("Leerer Zieltag: direkt kopiert", sig(st.plan.days[2].items) === A && !(await page.$(".sheet")));
      // Rückgängig nach späterer Änderung verweigert
      await tp(page, () => { window.__tp.state.plan.days[2].items.pop(); });
      await page.click("[data-a=dayCopyUndo]");
      ok("Rückgängig nach späterer Änderung: nichts überschrieben, Hinweis", (await tp(page, () => window.__tp.state.plan.days[2].items.length)) === 1 && (await page.textContent("#planNote")).includes("Nicht mehr rückgängig"));
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=tab][data-v=plan]");
      ok("Hinweis verschwindet beim Verlassen", !(await page.$("#planNote")));
      await page.setViewportSize({ width: 320, height: 640 }); await openDay("a"); await page.click("#dayCopy"); await page.waitForTimeout(350);
      ok("Sheet bei 320 px ohne seitliches Scrollen", await noOverflow(page) && await page.evaluate(() => { const s = document.querySelector(".sheet"); return s.scrollWidth <= s.clientWidth; }));
      await ctx.close();
    }

    section("69. Tagesplan: Tag 1:1 auf andere Tage kopieren (Training, Cardio, Schritte, Essen)");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const it = (id, exId) => [{ id, exId, sets: 3, rmin: 8, rmax: 12, rest: 90 }];
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Drücken", items: it("a1", "hs-chest") }, { id: "b", name: "Ziehen", items: it("b1", "hs-row") }, { id: "c", name: "Beine", items: it("c1", "hs-legpress") }] };
      const e = (id, n, g) => ({ id, m: "m", n, src: "usda:1", g, per: { k: 100, p: 10, c: 10, f: 2 } });
      const seed = { plan, weights: [{ d: dk(0), kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "ab", kcal: null }, stepGoal: 8000,
        sched: { days: [0, 1, 2, 3, 4, 5, 6], time: "23:59", planB: "next", since: new Date().toISOString() },
        dayPlan: { [dk(1)]: { train: "c", steps: 12000, cardio: [{ t: "cross", i: "m", min: 30 }] }, [dk(4)]: { steps: 12000 } },
        food: { [dk(1)]: [e("x1", "Reis", 300), e("x2", "Huhn", 200)], [dk(3)]: [e("y1", "Brot", 100)] } };
      const { ctx, page } = await open(seed);
      await page.click("#homeTag"); await page.click("[data-a=tagDay][data-d='1']");
      await page.click("#tagCopy");
      const parts = await page.$$eval("#tagCopyParts [data-a=tagCopyPart]", b => b.map(x => x.textContent + "|" + x.getAttribute("aria-pressed")));
      const tg = await page.$$eval("#tagCopyDays [data-a=tagCopyTgt]", b => b.map(x => x.dataset.d));
      ok("Sheet: Training, Cardio, Schritte-Ziel und Essen wählbar und vorgewählt; 14 Zieltage ohne den Tag selbst",
        JSON.stringify(parts) === JSON.stringify(["Training: Beine|true", "Cardio: 30 Min.|true", "Schritte-Ziel: 12.000|true", "Essen: 500 kcal|true"]) && tg.length === 14 && !tg.includes(dk(1)) && tg[0] === dk(0), JSON.stringify(parts));
      ok("Ohne Zieltag: Kopieren aus", !!(await page.$("[data-a=tagCopyDo][disabled]")));
      await page.click(`#tagCopyDays [data-d="${dk(2)}"]`); await page.click(`#tagCopyDays [data-d="${dk(3)}"]`);
      await page.click("[data-a=tagCopyDo]");
      let st = await stored(page);
      const fids = [dk(1), dk(2), dk(3)].flatMap(k => st.food[k].map(x => x.id));
      ok("Kopiert auf 2 Tage: Training, Schritte und Cardio gleich; Essen 1:1 (vorhandenes ersetzt), eigene IDs",
        canon(st.dayPlan[dk(2)]) === canon(seed.dayPlan[dk(1)]) && canon(st.dayPlan[dk(3)]) === canon(seed.dayPlan[dk(1)])
        && st.food[dk(2)].map(x => x.n).join() === "Reis,Huhn" && st.food[dk(3)].map(x => x.n).join() === "Reis,Huhn" && new Set(fids).size === 6
        && (await page.textContent("#tagNote")).includes("Auf 2 Tage kopiert"), JSON.stringify(st.dayPlan));
      const names = await tp(page, () => { const T = window.__tp, k = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
        return [1, 2, 3].map(n => T.plannedOn(k(n)).name).join(); });
      ok("Kalender zeigt an allen drei Tagen Beine", names === "Beine,Beine,Beine", names);
      await page.click("[data-a=tagCopyUndo]");
      st = await stored(page);
      ok("Rückgängig: Zieltage wie vorher (auch das ersetzte Essen)", !st.dayPlan[dk(2)] && !st.dayPlan[dk(3)] && !st.food[dk(2)] && st.food[dk(3)].length === 1 && st.food[dk(3)][0].id === "y1" && (await page.textContent("#tagNote")).includes("rückgängig gemacht"));
      // Nur Training und Cardio
      await page.click("#tagCopy"); await page.click("#tagCopyParts [data-k=food]"); await page.click("#tagCopyParts [data-k=steps]");
      await page.click(`#tagCopyDays [data-d="${dk(5)}"]`); await page.click("[data-a=tagCopyDo]");
      st = await stored(page);
      ok("Nur Training und Cardio gewählt: Schritte und Essen bleiben unberührt", canon(st.dayPlan[dk(5)]) === canon({ train: "c", cardio: [{ t: "cross", i: "m", min: 30 }] }) && !st.food[dk(5)]);
      await page.click("#tagCopy"); for (const k of ["train", "cardio", "steps", "food"]) await page.click(`#tagCopyParts [data-k=${k}]`);
      await page.click(`#tagCopyDays [data-d="${dk(6)}"]`);
      ok("Nichts gewählt: Kopieren aus", (await page.textContent("[data-a=tagCopyDo]")) === "Nichts gewählt" && !!(await page.$("[data-a=tagCopyDo][disabled]")));
      await page.click("[data-a=closeSheet].btn");
      // Ruhetag und Standard-Schrittziel kopieren: übermorgen (Ruhetag, 8.000) → Tag 4 (hatte 12.000 Schritte)
      await page.click("[data-a=tagDay][data-d='1']"); await page.click("#tagTrainPick [data-v=rest]"); await page.click("#tagCopy");
      const p2 = await page.$$eval("#tagCopyParts [data-a=tagCopyPart]", b => b.map(x => x.textContent));
      await page.click(`#tagCopyDays [data-d="${dk(4)}"]`); await page.click("[data-a=tagCopyDo]");
      st = await stored(page);
      ok("Ruhetag kopiert; Schritte-Ziel wie Standard entfernt das abweichende Tagesziel", JSON.stringify(p2) === JSON.stringify(["Ruhetag", "Schritte-Ziel: 8.000"]) && JSON.stringify(st.dayPlan[dk(4)]) === '{"train":"rest"}', JSON.stringify(p2) + JSON.stringify(st.dayPlan[dk(4)]));
      // Rückgängig nach späterer Änderung verweigert
      await tp(page, () => { const T = window.__tp, x = new Date(Date.now() + 4 * 864e5), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; T.state.dayPlan[k].steps = 5000; });
      await page.click("[data-a=tagCopyUndo]");
      ok("Rückgängig nach späterer Änderung: nichts überschrieben, Hinweis", (await tp(page, () => { const T = window.__tp, x = new Date(Date.now() + 4 * 864e5), k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; return T.state.dayPlan[k].train; })) === "rest"
        && (await page.textContent("#tagNote")).includes("Nicht mehr rückgängig"));
      await page.click("[data-a=tagDay][data-d='1']");
      ok("Hinweis verschwindet beim Tageswechsel", !(await page.$("#tagNote")));
      await page.setViewportSize({ width: 320, height: 640 }); await page.click("[data-a=tagDay][data-d='-1']"); await page.click("[data-a=tagDay][data-d='-1']"); await page.click("#tagCopy"); await page.waitForTimeout(350);
      ok("Sheet bei 320 px ohne seitliches Scrollen", await noOverflow(page) && await page.evaluate(() => { const s = document.querySelector(".sheet"); return s.scrollWidth <= s.clientWidth; }));
      await ctx.close();
      // Erledigtes Training als Quelle; ohne Termine kein Training im Angebot; Tag ohne Inhalt: kein Knopf
      const hist = [{ id: "h1", dayId: "b", day: "Ziehen", date: new Date(Date.now() - 864e5).toISOString(), durationSec: 1800, exercises: [{ exId: "hs-row", name: "hs-row", u: "s", planned: 3, rmin: 8, rmax: 12, sets: [{ kg: 40, reps: 10 }] }] }];
      const o2 = await open({ plan, history: hist, sched: seed.sched });
      await o2.page.click("#homeTag"); await o2.page.click("[data-a=tagDay][data-d='-1']"); await o2.page.click("#tagCopy");
      ok("Gestern trainiert (Ziehen): als Training kopierbar", JSON.stringify(await o2.page.$$eval("#tagCopyParts [data-a=tagCopyPart]", b => b.map(x => x.textContent))) === '["Training: Ziehen"]');
      await o2.ctx.close();
      const o3 = await open({ plan, dayPlan: { [dk(0)]: { cardio: [{ t: "row", i: "m", min: 20 }] } } });
      await o3.page.click("#homeTag"); await o3.page.click("#tagCopy");
      const p3 = await o3.page.$$eval("#tagCopyParts [data-a=tagCopyPart]", b => b.map(x => x.textContent)); await o3.page.click("[data-a=closeSheet].btn");
      await o3.page.click("[data-a=tagDay][data-d='1']");
      ok("Ohne feste Termine: nur Cardio im Angebot; Tag ohne Inhalt hat keinen Kopieren-Knopf", JSON.stringify(p3) === '["Cardio: 20 Min."]' && !(await o3.page.$("#tagCopy")));
      await o3.ctx.close();
    }

    section("70. Ohne Essens-Einträge keine Bilanz-Zahl; Wochenvergleich erst, wenn er etwas aussagt");
    {
      const dk = n => { const x = new Date(Date.now() + n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
      const { ctx, page } = await open({ plan: PLAN_SMALL, weights: [{ d: dk(0), kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "auf", kcal: null } });
      const txt = async id => (await page.$(id)) ? (await page.textContent(id)).replace(/\s+/g, " ").trim() : null;
      // Aufbauen: Verbrauch 2.759, Ziel 3.030 → Tagesziel 3.030
      ok("Startseite ohne Einträge: „Tagesziel ≈ 3.030 kcal“, kein „Defizit“", (await txt("#homeTag")).includes("Tagesziel ≈ 3.030 kcal") && !(await txt("#homeTag")).includes("Defizit"), await txt("#homeTag"));
      await page.click("#homeTag");
      ok("Heute ohne Einträge: „Noch nichts eingetragen“, keine Defizit-Zahl, Tagesziel genannt", (await txt("#tagNoFood")) === "Noch nichts eingetragen." && !(await page.$("#tagBalNum")) && !(await txt("#tagBalIn")).includes("Defizit") && (await txt("#tagGoal")) === "Noch ≈ 3.030 kcal bis zu deinem Tagesziel.", await txt("#tagBalIn"));
      await page.click("[data-a=tagDay][data-d='-1']");
      ok("Gestern ohne Einträge: „Kein Essen eingetragen – keine Bilanz“", (await txt("#tagNoFood")) === "Kein Essen eingetragen – keine Bilanz." && !(await page.$("#tagBalNum")) && !(await txt("#tagBalIn")).includes("Defizit"));
      await page.click("[data-a=tagDay][data-d='1']"); await page.click("[data-a=tagDay][data-d='1']");
      ok("Morgen ohne Plan: „Noch kein Essen geplant“ und was zum Ziel passt", (await txt("#tagNoFood")) === "Noch kein Essen geplant." && (await txt("#tagGoal")) === "Zu deinem Ziel passen an diesem Tag ≈ 3.030 kcal.");
      await ctx.close();
      // Wochenrückblick: laufende Woche ohne Minus-Vergleich, abgeschlossene Woche mit
      const X = (kg, n) => ({ exId: "hs-chest", name: "Brustpresse", u: "s", planned: n, rmin: 8, rmax: 12, sets: Array.from({ length: n }, () => ({ kg, reps: 10 })) });
      const H = (id, days, n) => ({ id, dayId: "d1", day: "Test", date: new Date(Date.now() - days * 864e5).toISOString(), durationSec: 1800, exercises: [X(40, n)] });
      const o2 = await open({ plan: PLAN_SMALL, history: [H("h1", 14, 4), H("h2", 7, 2)] });
      await o2.page.click("#homeWeek");
      ok("Laufende Woche, noch kein Training: kein „−100 % zur Vorwoche“", !(await o2.page.textContent("#weekTrain")).includes("zur Vorwoche"), await o2.page.textContent("#weekTrain"));
      await o2.page.click("[data-a=weekNav][data-d='1']");
      ok("Abgeschlossene Woche: Vergleich bleibt (−50 % zur Vorwoche)", (await o2.page.textContent("#weekTrain")).includes("−50 % zur Vorwoche"), await o2.page.textContent("#weekTrain"));
      await o2.ctx.close();
    }

    section("71. Ziel „Kraft“: Wiederholungen je Übungsart");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp;
        const sig = goal => T.generatePlan(goal, 3, "einsteiger", 90).days.flatMap(d => d.items.map(it => `${T.isIso(it.exId) ? "iso" : "grund"}:${it.rmin}-${it.rmax}:${it.rest}`));
        const f = (g, id) => { const x = T.rangeFor(g, id); return `${x.rmin}-${x.rmax}/${x.rest}`; };
        return { kraft: sig("kraft"), aufbau: sig("aufbau"), fit: sig("fit"),
          rf: [f("kraft", "hs-lateral"), f("kraft", "hs-seatcurl"), f("kraft", "hs-calf"), f("kraft", "hs-chest"), f("kraft", "hs-legpress"), f("kraft", "hs-dip"), f("aufbau", "hs-lateral"), f("fit", "hs-lateral"), f("kraft", "gibt-es-nicht")] }; });
      const iso = r.kraft.filter(x => x.startsWith("iso")), grund = r.kraft.filter(x => x.startsWith("grund"));
      ok("Kraft-Plan: Grundübungen 4–6 Wdh. mit 180 oder 150 s Pause", grund.length >= 4 && grund.every(x => /^grund:4-6:(180|150)$/.test(x)), JSON.stringify(grund));
      ok("Kraft-Plan: Übungen mit einem Gelenk 8–12 Wdh. mit 90 oder 60 s Pause", iso.length >= 2 && iso.every(x => /^iso:8-12:(90|60)$/.test(x)), JSON.stringify(iso));
      ok("Muskelaufbau und Fitness unverändert: alle Übungen 8–12 bzw. 12–15", r.aufbau.every(x => /:8-12:/.test(x)) && r.fit.every(x => /:12-15:/.test(x)));
      ok("Regel je Gerät: Seitheben, Beinbeuger, Wadenheben 8–12/90; Brustpresse, Beinpresse, Dips 4–6/180; andere Ziele und unbekannte Geräte wie bisher",
        JSON.stringify(r.rf) === JSON.stringify(["8-12/90", "8-12/90", "8-12/90", "4-6/180", "4-6/180", "4-6/180", "8-12/90", "12-15/60", "4-6/180"]), JSON.stringify(r.rf));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=newPlan]");
      const a0 = await page.textContent("#setupRange");
      await page.click("[data-a=setup][data-k=goal][data-val=kraft]");
      ok("Plan-Assistent nennt bei „Kraft“ beide Startwerte, bei „Muskelaufbau“ nur einen",
        !a0.includes("einem Gelenk") && (await page.textContent("#setupRange")) === "Startwerte der App: 4–6 Wiederholungen · 180 s Pause. Übungen mit nur einem Gelenk (z. B. Seitheben, Beinbeuger): 8–12 · 90 s", await page.textContent("#setupRange"));
      ok("Bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
      // Gerät zu einem Kraft-Plan hinzufügen
      const plan = { goal: "kraft", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [{ id: "i1", exId: "hs-chest", sets: 3, rmin: 4, rmax: 6, rest: 180 }] }] };
      const o2 = await open({ plan });
      await o2.page.click("[data-a=tab][data-v=plan]"); await o2.page.click("[data-a=editDay]"); await o2.page.click("[data-a=openPicker]");
      await o2.page.click("#pickMuscle [data-k=schultern]"); await o2.page.click(".sheet [data-a=pick][data-id=hs-lateral]");
      const st = await stored(o2.page), added = st.plan.days[0].items.find(i => i.exId === "hs-lateral");
      ok("Seitheben zu einem Kraft-Plan hinzugefügt: 8–12 Wdh., 90 s", !!added && added.rmin === 8 && added.rmax === 12 && added.rest === 90, JSON.stringify(st.plan.days[0].items));
      await o2.ctx.close();
    }

    section("72. Training: „Gewicht finden“ an einem neuen Gerät");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const card = async () => (await page.$("#findKg")) ? (await page.textContent("#findKg")).replace(/\s+/g, " ").trim() : null;
      const btn = async d => ({ t: (await page.textContent(`#findKg [data-a=findSet][data-d=${d}]`)).replace(/\s+/g, " ").trim(), dis: await page.isDisabled(`#findKg [data-a=findSet][data-d=${d}]`) });
      const kgs = () => tp(page, () => window.__tp.state.session.list[0].sets.map(t => t.kg).join());
      await page.click("[data-a=start]");
      ok("Neues Gerät: Karte „Gewicht finden“ mit Probe über die halbe Wiederholungszahl (6 bei 8–12), kein Aufwärm-Hinweis",
        (await card()).includes("Gewicht finden") && (await card()).includes("Stell ein leichtes Gewicht ein") && (await card()).includes("6 Wiederholungen zur Probe") && !(await page.$("#warmup")), await card());
      await page.fill("#kgIn", "20");
      const b1 = [await btn("up"), await btn("ok"), await btn("down")];
      ok("Gewicht eingetragen: Probe 1 mit 20 kg; „Zu leicht“ → 30 kg (+50 %), „Zu schwer“ → 15 kg (−25 %); Fokus bleibt im Feld",
        (await card()).includes("Probe 1") && (await card()).includes("6 Wiederholungen mit 20 kg. Passt, wenn danach noch etwa 6 gingen") && b1[0].t === "Zu leicht→ 30 kg" && b1[2].t === "Zu schwer→ 15 kg" && b1[1].t === "Passtweiter"
        && (await page.evaluate(() => document.activeElement.id)) === "kgIn" && !(await page.$("#warmup")), JSON.stringify(b1));
      await page.click("#findKg [data-d=up]");
      ok("„Zu leicht“: 30 kg für alle offenen Sätze, Probe 2; zurück ginge es in die Mitte (25 kg)", (await page.inputValue("#kgIn")) === "30" && (await kgs()) === "30,30" && (await card()).includes("Probe 2") && (await btn("up")).t === "Zu leicht→ 45 kg" && (await btn("down")).t === "Zu schwer→ 25 kg", await card());
      await page.click("#findKg [data-d=up]"); await page.click("#findKg [data-d=down]");
      ok("45 kg zu schwer: Mitte zwischen 30 und 45 → 37,5 kg; danach 42,5 oder 35", (await page.inputValue("#kgIn")) === "37,5" && (await btn("up")).t === "Zu leicht→ 42,5 kg" && (await btn("down")).t === "Zu schwer→ 35 kg", await card());
      await page.click("#findKg [data-d=down]");
      const b5 = await btn("up");
      ok("35 kg: kein Schritt mehr bis 37,5 → „Zu leicht“ aus", (await page.inputValue("#kgIn")) === "35" && b5.dis && b5.t === "Zu leicht–" && (await card()).includes("Probe 5"), JSON.stringify(b5));
      await page.reload(); if (await page.$("[data-a=toTrain]")) await page.click("[data-a=toTrain]"); else if (await page.$("[data-a=resumeT]")) await page.click("[data-a=resumeT]");
      const f = await tp(page, () => window.__tp.state.session.list[0].find);
      ok("Suche übersteht Neuladen (zu leicht 30, zu schwer 37,5, 4 Proben)", f && f.lo === 30 && f.hi === 37.5 && f.n === 4 && (await card()).includes("Probe 5"), JSON.stringify(f));
      await page.click("#findKg [data-d=ok]");
      const s1 = await tp(page, () => { const s = window.__tp.state.session; return { off: s.list[0].findOff, warm: s.warmDone, done: s.list[0].sets.filter(t => t.done).length, hist: window.__tp.state.history.length }; });
      ok("„Passt“: Karte weg, 35 kg bleiben, kein Aufwärm-Hinweis mehr, Proben nicht gespeichert", !(await page.$("#findKg")) && (await page.inputValue("#kgIn")) === "35" && s1.off === true && s1.warm === true && s1.done === 0 && s1.hist === 0 && !(await page.$("#warmup")), JSON.stringify(s1));
      await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      ok("Zweiter Satz am selben Gerät: keine Karte", !(await page.$("#findKg")));
      await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      ok("Nächstes neues Gerät: Karte wieder da", (await page.textContent("h1")).includes("Beinpresse") && (await card()).includes("Stell ein leichtes Gewicht ein"), await card());
      await page.click("[data-a=findOff]");
      ok("„Ich kenne mein Gewicht“ schließt die Karte", !(await page.$("#findKg")));
      await ctx.close();
      // Rechenregel direkt
      const o2 = await open({ plan: PLAN_SMALL });
      const fn = await tp(o2.page, () => { const f = window.__tp.findNext, j = (find, st, kg) => { const r = f({ find }, { step: st }, kg); return `${r.up}/${r.down}${r.downFinal ? "!" : ""}`; };
        return [j({}, 2.5, 2.5), j({}, 5, 10), j({ lo: 30, hi: null }, 2.5, 32.5), j({ lo: null, hi: 40 }, 5, 35), j({ lo: 20, hi: 60 }, 5, 40), j({}, 1.25, 5)]; });
      ok("Regel: kleinster Schritt nach unten gesperrt; Mitte zwischen zu leicht und zu schwer; ohne Platz zurück auf das leichtere Gewicht",
        JSON.stringify(fn) === JSON.stringify(["5/null", "15/5", "50/30!", "null/25", "50/30", "7.5/3.75"]), JSON.stringify(fn));
      await o2.ctx.close();
      // Gerät mit eigenen Werten: keine Karte, Aufwärm-Hinweis wie bisher
      const o3 = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3, "s")] });
      await o3.page.click("[data-a=start]");
      ok("Gerät mit eigenen Werten: keine Karte, Aufwärm-Hinweis wie bisher", !(await o3.page.$("#findKg")) && !!(await o3.page.$("#warmup")));
      await o3.ctx.close();
      // Kraft: Probe mit 3 Wiederholungen; 320 px
      const o4 = await open({ plan: { goal: "kraft", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [{ id: "i1", exId: "hs-legpress", sets: 2, rmin: 4, rmax: 6, rest: 0 }] }] } });
      await o4.page.setViewportSize({ width: 320, height: 640 });
      await o4.page.click("[data-a=start]"); await o4.page.fill("#kgIn", "60");
      ok("4–6 Wiederholungen: Probe mit 3; bei 320 px ohne seitliches Scrollen", (await o4.page.textContent("#findKg")).includes("3 Wiederholungen mit 60 kg. Passt, wenn danach noch etwa 3 gingen") && await noOverflow(o4.page));
      await o4.ctx.close();
    }

    section("73. Latzug mit Griffvarianten; lebendige Geräteauswahl");
    {
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Ziehen", items: [
        { id: "i1", exId: "hs-pulldown", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan, history: [hist("hs-lat", [{ kg: 55, reps: 10 }], 3, "b")], dev: { "hs-lat": { fav: true } } });
      const v = await tp(page, () => { const T = window.__tp, ids = ["hs-lat", "hs-lat-wide", "hs-lat-close", "hs-lat-under"];
        return ids.map(id => { const e = T.ex(id), g = T.GUIDE[id]; return { id, name: e.name, label: e.label, off: !!e.off, pat: e.pattern, load: T.loadShort(e), src: (g.src || []).join(), why: g.why, about: T.ABOUT_X[id], tricks: T.tricksFor(e).length }; }); });
      ok("Vier Latzug-Varianten: Latzug, breit, eng, Untergriff – alle im Studio, vertikales Ziehen, Seilzug, mit eigener Kurzbeschreibung und eigenem Trick",
        v.map(x => x.name).join() === "Latzug,Latzug breit,Latzug eng,Latzug Untergriff" && v.every(x => !x.off && x.pat === "pull_v" && x.load === "Seilzug" && x.label === "Lat Pulldown" && x.tricks >= 1) && new Set(v.map(x => x.about)).size === 4, JSON.stringify(v.map(x => [x.name, x.load, x.pat, x.off])));
      ok("Aussagen zu den Griffen mit Quelle: breit → Andersen 2014 (77 statt 80 kg, Aktivität ähnlich), Untergriff → Lusk 2010 (Rückenmuskel weniger aktiv, Bizeps gleich)",
        v[1].src === "andersen2014" && v[1].why.includes("77 statt 80 kg") && v[1].why.includes("ähnlich aktiv") && v[3].src === "lusk2010" && v[3].why.includes("weniger aktiv als im Obergriff") && v[3].why.includes("beim Bizeps gab es keinen Unterschied") && v[2].src === "", JSON.stringify(v.map(x => x.src)));
      const srcOk = await tp(page, () => { const S = window.__tp.SOURCES; return [S.lusk2010.url, S.andersen2014.url, S.lusk2010.j, S.andersen2014.j]; });
      ok("Quellen mit Zeitschrift und PubMed-Link", srcOk.join("|") === "https://pubmed.ncbi.nlm.nih.gov/20543740/|https://pubmed.ncbi.nlm.nih.gov/24662157/|J Strength Cond Res 2010;24(7):1895–1900|J Strength Cond Res 2014;28(4):1135–1142", srcOk.join("|"));
      // Geräteauswahl
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay]"); await page.click("[data-a=openPicker]");
      const chips = await page.$$eval("#pickMuscle [data-a=pickMuscle]", b => b.map(x => x.textContent.replace(/\s+/g, " ").trim()));
      ok("Muskel-Filter als Chips mit Anzahl (Alle 36, Brust 5, Rücken 9 …)", chips[0] === "Alle36" && chips[1] === "Brust5" && chips[2] === "Rücken9" && (await page.getAttribute("#pickMuscle [data-k=alle]", "aria-pressed")) === "true", chips.join());
      ok("Kopfzeile nennt Geräte und Dauer des Tages", (await page.textContent("#pickCount")).includes("2 Geräte im Tag · ≈") && (await page.textContent("#pickCount")).includes("Min."));
      await page.click("#pickMuscle [data-k=ruecken]");
      const rows = await page.$$eval(".sheet .pick-row", r => r.map(x => ({ id: x.querySelector("[data-a=pick]").dataset.id, on: x.classList.contains("on"), svg: !!x.querySelector(".pick-thumb svg.motion"), anim: !!x.querySelector(".pick-thumb svg.motion[data-anim]"), t: x.textContent.replace(/\s+/g, " ") })));
      ok("Rücken: 9 Geräte, bevorzugter Latzug zuerst, alle vier Latzug-Varianten dabei", rows.length === 9 && rows[0].id === "hs-lat" && ["hs-lat-wide", "hs-lat-close", "hs-lat-under"].every(id => rows.some(r => r.id === id)) && (await page.textContent("#pickList .cap")) === "Rücken · 9", rows.map(r => r.id).join());
      ok("Jede Zeile mit Bild der Bewegung; gewählte Geräte bewegen sich, die anderen stehen still", rows.every(r => r.svg) && rows.filter(r => r.anim).map(r => r.id).sort().join() === "hs-pulldown,hs-row" && rows.filter(r => r.on).length === 2, JSON.stringify(rows.map(r => [r.id, r.anim])));
      const lat = rows.find(r => r.id === "hs-lat"), wide = rows.find(r => r.id === "hs-lat-wide");
      ok("Zeile zeigt Beschreibung, Bezeichnung am Gerät, Gewichtsart und den letzten eigenen Wert", lat.t.includes("Latziehen an der Stange, Steckgewicht") && lat.t.includes("Lat Pulldown · Seilzug · zuletzt 55 kg") && lat.t.includes("Bevorzugt") && wide.t.includes("Breiter Obergriff an der langen Stange") && !wide.t.includes("zuletzt"), lat.t + " | " + wide.t);
      await page.click(".sheet [data-a=pick][data-id=hs-lat-close]");
      const st = await stored(page);
      ok("Antippen nimmt „Latzug eng“ auf: im Tag, Bild bewegt sich, Zähler steigt", st.plan.days[0].items.some(i => i.exId === "hs-lat-close") && !!(await page.$(".sheet [data-a=pick][data-id=hs-lat-close] svg.motion[data-anim]")) && (await page.textContent("#pickCount")).includes("3 Geräte im Tag") && (await page.getAttribute("#pickMuscle", "data-v")) === "ruecken");
      await page.fill("#pickQ", "v-griff");
      ok("Suche „v-griff“ findet „Latzug eng“", (await page.$$eval(".sheet [data-a=pick]", a => a.map(x => x.dataset.id))).join() === "hs-lat-close");
      await page.fill("#pickQ", "");
      await page.setViewportSize({ width: 320, height: 640 }); await page.waitForTimeout(200);
      ok("Geräteauswahl bei 320 px ohne seitliches Scrollen", await noOverflow(page) && await page.evaluate(() => { const s = document.querySelector(".sheet"); return s.scrollWidth <= s.clientWidth; }));
      await page.setViewportSize({ width: 360, height: 780 });
      await page.click("[data-a=closeSheet].btn");
      // Meine Geräte mit Bild
      await page.click("[data-a=tab][data-v=plan]"); await page.click("#devsRow");
      const dv = await page.$$eval(".sheet .dev-row", r => ({ n: r.length, svg: r.filter(x => x.querySelector(".thumbbox svg.motion")).length }));
      ok("„Meine Geräte“: jede Zeile mit Bild, 36 von 60 im Studio", dv.n === 60 && dv.svg === 60 && (await page.textContent("#devCount")).includes("36 von 60"), JSON.stringify(dv));
      await page.click("[data-a=devsDone]");
      // Gerät tauschen: mehr Auswahl, mit Bild
      await page.click("[data-a=editDay]"); await page.click("#dayStart"); await page.click("[data-a=findOff]"); await page.click("[data-a=openSwap]");
      const sw = await page.$$eval("#swapDirect [data-a=swap]", r => r.map(x => ({ id: x.dataset.id, anim: !!x.querySelector(".thumbbox svg.motion[data-anim]") })));
      ok("„Latziehen zur Brust besetzt?“: Latzug und die Griffvarianten, die noch nicht im Training sind, als direkte Alternativen mit bewegtem Bild",
        ["hs-lat", "hs-lat-wide", "hs-lat-under"].every(id => sw.some(r => r.id === id)) && !sw.some(r => r.id === "hs-lat-close") && sw[0].id === "hs-lat" && sw.every(r => r.anim), JSON.stringify(sw));
      await ctx.close();
    }

    section("74. Übungen am Kabelzug; Texte in einfacher Sprache");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const ids = ["lf-ohtri", "lf-cablecurl", "lf-facepull", "lf-cablelat", "lf-cablefly"];
      const v = await tp(page, ids => { const T = window.__tp;
        return ids.map(id => { const e = T.ex(id), g = T.GUIDE[id]; return { name: e.name, brand: e.brand, off: !!e.off, label: e.label, load: T.loadShort(e), pat: e.pattern, m: e.muscle, src: (g.src || []).join(), why: g.why }; }); }, ids);
      ok("Fünf Übungen am Kabelzug: Life Fitness, ab Werk nicht im Studio, Gewichtsart Seilzug",
        v.map(x => x.name).join() === "Trizepsstrecken über Kopf,Armbeuger am Kabel,Zug zum Gesicht,Seitheben am Kabel,Butterfly am Kabel" && v.every(x => x.brand === "lf" && x.off && x.load === "Seilzug" && x.label === "Dual Adjustable Pulley"), JSON.stringify(v.map(x => [x.name, x.load, x.off])));
      ok("Muskel und Bewegung je Übung: Trizeps, Bizeps, Schultern (hinten), Schultern (seitlich), Brust", v.map(x => x.m + "/" + x.pat).join() === "trizeps/tri,bizeps/bi,schultern/rear,schultern/lateral,brust/fly", v.map(x => x.m + "/" + x.pat).join());
      ok("Studienaussage nur beim Trizepsstrecken über Kopf (Maeo 2023: +20 % statt +14 %)", v[0].src === "tri2023" && v[0].why.includes("+20 % statt +14 %") && v.slice(1).every(x => x.src === "" && !/Studie/.test(x.why)), JSON.stringify(v.map(x => x.src)));
      const mot = await tp(page, ids => { const T = window.__tp, d = document.createElement("div");
        return ids.map(id => { d.innerHTML = T.motionSvg(id, { p: 1 }); const s = d.querySelector("svg"); return { ok: !!s, box: s && s.getAttribute("viewBox"), lines: s ? s.querySelectorAll("line").length : 0 }; }); }, ids);
      ok("Jede Übung mit eigener Zeichnung", mot.every(m => m.ok), JSON.stringify(mot));
      await page.click("[data-a=tab][data-v=lib]"); await page.fill("#libQ", "face pull");
      const hit = await page.$$eval("#libList [data-a=openEx]", a => a.map(x => x.dataset.id));
      ok("Suche „face pull“ findet „Zug zum Gesicht“", hit.join() === "lf-facepull", hit.join());
      await page.click("[data-a=openEx][data-id=lf-facepull]");
      const pg = (await page.textContent("#app")).replace(/\s+/g, " ");
      ok("Seite der Übung: Schritte, Trick und Gewichtsart", pg.includes("Zieh das Seil zur Stirn, die Ellbogen gehen hoch und nach außen.") && pg.includes("Zeig am Ende mit den Daumen hinter dich") && pg.includes("Seilzug") && !!(await page.$("#gMotion svg.motion")), pg.slice(0, 200));
      ok("Bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      // Einfache Sprache
      const txt = await tp(page, () => { const T = window.__tp, bad = [], JARGON = /Drehachse|Bewegungsmuster|Übersetzung beachten|Widerstandsverlauf|Raste\b/;
        for (const e of T.allEx().filter(x => !x.id.startsWith("c-"))) {
          const tips = T.TIPS[e.id] || [];
          if (tips.length !== 3) bad.push(e.id + ": " + tips.length + " Schritte");
          tips.forEach(s => { if (!/^[A-ZÄÖÜ]/.test(s) || !/[.!]$/.test(s)) bad.push(e.id + ": kein ganzer Satz – " + s); if (s.length > 130) bad.push(e.id + ": zu lang – " + s); if (JARGON.test(s)) bad.push(e.id + ": Fachwort – " + s); });
          T.tricksFor(e).forEach(k => { if (JARGON.test(k.t + k.short + k.s)) bad.push(e.id + ": Fachwort im Trick – " + k.t); if (k.short.length > 75) bad.push(e.id + ": Trick-Zeile zu lang – " + k.short);
            if (k.s.split(/(?<=[.!?])\s+/).length > 3) bad.push(e.id + ": Trick-Erklärung über drei Sätze – " + k.t); });
        }
        return bad; });
      ok("„So geht's“: je Gerät drei ganze Sätze, höchstens 130 Zeichen, ohne Fachwörter wie „Drehachse“", txt.filter(x => !/Trick/.test(x)).length === 0, txt.filter(x => !/Trick/.test(x)).slice(0, 4).join(" | "));
      ok("Tricks: Anweisung in einer kurzen Zeile, Erklärung in höchstens drei Sätzen, ohne Fachwörter", txt.filter(x => /Trick/.test(x)).length === 0, txt.filter(x => /Trick/.test(x)).slice(0, 4).join(" | "));
      await ctx.close();
    }

    section("75. Zeichnungen: Figur von vorn oder hinten am Gerät, arbeitende Muskeln rot");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp, cs = getComputedStyle(document.documentElement);
        const one = (id, p) => { const s = T.motionSvg(id, { p }); return { fig: T.motSpec(id).v === "fig", box: /viewBox="0 0 160 120"/.test(s), hot: (s.match(/fill="var\(--mhot\)"/g) || []).length, frame: s.includes("var(--mframe)"), pad: s.includes("var(--mpad)"),
          lines: (s.match(/<line /g) || []).length, len: s.length, scale: s.includes('scale(.825)') }; };
        const ids = ["hs-fly", "lf-fly", "hs-reardelt", "lf-reardelt", "hs-lateral", "lf-lateral", "lf-cablefly", "lf-cablelat"];
        return { v: Object.fromEntries(ids.map(id => [id, one(id, 1)])), open: T.motionSvg("hs-fly", { p: 0 }) !== T.motionSvg("hs-fly", { p: 1 }),
          side: T.motSpec("hs-chest").v || "side", hot: cs.getPropertyValue("--mhot").trim(), frame: cs.getPropertyValue("--mframe").trim(), pad: cs.getPropertyValue("--mpad").trim(),
          oldGone: typeof T.motSpec("hs-fly").A.h === "number" && T.motSpec("hs-fly").A.ua === undefined }; });
      const V = r.v, ids = Object.keys(V);
      ok("Butterfly, hintere Schulter, Seitheben und die Kabel-Varianten nutzen die neue Figur von vorn oder hinten", ids.every(id => V[id].fig && V[id].box && V[id].len > 3000) && r.oldGone, JSON.stringify(ids.filter(id => !V[id].fig)));
      ok("Arbeitende Muskeln rot (eigene Farbe, nicht mehr Akzentgelb); Start- und Endstellung unterscheiden sich", ids.every(id => V[id].hot >= 1) && r.open && /^#[0-9A-F]{6}$/i.test(r.hot), JSON.stringify([r.hot, ids.map(id => V[id].hot)]));
      ok("Gerät mit hellem Rahmen und dunklen Polstern; Geräte im Sitzen mit Polster, Kabel-Übungen im Stehen ohne",
        ["hs-fly", "hs-reardelt", "hs-lateral"].every(id => V[id].frame && V[id].pad && !V[id].scale) && V["lf-cablefly"].scale && V["lf-cablelat"].scale && V["lf-cablefly"].frame, JSON.stringify(V["lf-cablefly"]));
      ok("Seile: Butterfly am Kabel mit zwei, Seitheben am Kabel mit einem", V["lf-cablefly"].lines >= 2 && V["lf-cablelat"].lines >= 1);
      ok("Übrige Geräte bleiben in der Seitenansicht", r.side === "side");
      const lat = await tp(page, () => { const T = window.__tp, ids = ["hs-lat-close", "hs-lat-under", "hs-lat", "hs-lat-wide"];
        const hands = id => { const s = T.motionSvg(id, { p: 1 }); return { back: T.motSpec(id).back === true, g: T.motSpec(id).pull.g, box: /viewBox="-16 -26 192 144"/.test(s), hot: (s.match(/var\(--mhot\)/g) || []).length };
        };
        return { v: ids.map(hands), still: T.motSpec("hs-fly").still, diff: T.motionSvg("hs-lat", { p: 0 }) !== T.motionSvg("hs-lat", { p: 1 }), wideVsStd: T.motionSvg("hs-lat", { p: 1 }) !== T.motionSvg("hs-lat-wide", { p: 1 }) }; });
      ok("Latzug von hinten, Bildausschnitt mit Platz über dem Kopf, Rücken rot", lat.v.every(x => x.back && x.box && x.hot >= 2) && lat.diff, JSON.stringify(lat.v));
      ok("Jede Latzug-Variante mit eigener Griffbreite: eng < Untergriff < Standard < breit", lat.v.map(x => x.g).join() === "4.5,15,23,31" && lat.wideVsStd, lat.v.map(x => x.g).join());
      ok("Standbild des Butterfly zeigt die geöffnete Stellung", lat.still === .3);
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-fly]");
      ok("Butterfly-Seite: Zeichnung von vorn, Hinweis nennt Rot", !!(await page.$("#gMotion svg.motion[viewBox='0 0 160 120']")) && (await page.textContent("#gMotion .mnote")).includes("rot arbeitet, blassrot hilft mit"));
      ok("Butterfly-Seite bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
      // Farben in beiden Designs gesetzt
      for (const light of [false, true]) {
        const o = await open({ plan: PLAN_SMALL }, { light });
        const c = await tp(o.page, () => { const cs = getComputedStyle(document.documentElement); return ["--mhot", "--mframe", "--mpad"].map(k => cs.getPropertyValue(k).trim()); });
        ok(`${light ? "Hell" : "Dunkel"}: Farben für Muskel, Rahmen und Polster gesetzt`, c.every(x => /^#[0-9A-F]{6}$/i.test(x)) && c[1] !== c[2], c.join());
        await o.ctx.close();
      }
    }

    section("76. Seitenansicht im neuen Stil, Abduktoren und Adduktoren von vorn");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp, ids = T.allEx().map(x => x.id).filter(id => T.motSpec(id));
        const side = ids.filter(id => !T.motSpec(id).v), hip = ["hs-abductor", "lf-abductor", "hs-adductor", "lf-adductor"];
        const S = id => T.motionSvg(id, { p: 1 });
        return { n: ids.length, nSide: side.length, views: [...new Set(ids.map(id => T.motSpec(id).v || "side"))].sort().join(),
          style: side.filter(id => { const s = S(id); return !s.includes("var(--mframe)") || !s.includes("var(--mpad)") || /fill="var\(--mgear\)"/.test(s); }),
          edges: (S("hs-chest").match(/stroke-opacity="\.24" stroke-width="\.55"/g) || []).length,
          stack: S("lf-chest").includes('fill="var(--mframe)" fill-opacity=".55"'),
          towers: ["lf-pushdown", "lf-ohtri", "lf-cablecurl", "lf-facepull"].filter(id => !/r="3\.6" fill="var\(--mframe\)"/.test(S(id))),
          hip: hip.map(id => { const sp = T.motSpec(id), a = T.motionSvg(id, { p: 0 }), b = S(id);
            return { id, fig: sp.v === "fig", rig: sp.rig, A: sp.A.l, B: sp.B.l, box: /viewBox="0 0 160 120"/.test(b), diff: a !== b, hot: (b.match(/fill="var\(--mhot\)"/g) || []).length }; }) }; });
      ok("Alle 60 Geräte gezeichnet: Seitenansicht oder Figur, keine Draufsicht mehr", r.n === 60 && r.views === "fig,side" && r.nSide === 44, `${r.n} ${r.views} ${r.nSide}`);
      ok("Seitenansicht: heller Rahmen, dunkle Polster und Scheiben bei allen 44 Geräten", r.style.length === 0, r.style.join());
      ok("Ruhende Muskeln mit feiner Kontur, damit man sie erkennt", r.edges >= 6, String(r.edges));
      ok("Steckgewicht mit hellem Gehäuse wie in den Bildern von vorn", r.stack);
      ok("Kabelzug im Stehen: Turm mit Rolle statt frei schwebender Rolle", r.towers.length === 0, r.towers.join());
      const H = Object.fromEntries(r.hip.map(x => [x.id, x]));
      ok("Abduktoren und Adduktoren: Figur von vorn, Start und Ende verschieden", r.hip.every(x => x.fig && x.box && x.diff), JSON.stringify(r.hip));
      ok("Abduktoren öffnen die Knie (Polster außen), Adduktoren schließen sie (Polster innen)",
        ["hs-abductor", "lf-abductor"].every(id => H[id].rig === "abd" && H[id].B > H[id].A) && ["hs-adductor", "lf-adductor"].every(id => H[id].rig === "add" && H[id].B < H[id].A));
      ok("Arbeitender Muskel rot: seitliches Gesäß bzw. Innenseite der Oberschenkel, je Bein", r.hip.every(x => x.hot >= 2), r.hip.map(x => x.hot).join());
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-abductor]");
      ok("Seite der Abduktoren: Zeichnung von vorn, bei 360 px ohne seitliches Scrollen", !!(await page.$("#gMotion svg.motion[viewBox='0 0 160 120']")) && await noOverflow(page));
      await ctx.close();
    }

    section("77. Realistische Figur und Ausführung: Muskel wird kürzer und länger, Richtung");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp, ids = T.allEx().map(x => x.id).filter(id => T.motSpec(id));
        const S = (id, p) => T.motionSvg(id, { p });
        // Breite des roten Muskelbauchs: größte Ausdehnung der Pfade mit voller Muskelfarbe
        const hotW = s => { const d = document.createElementNS("http://www.w3.org/2000/svg", "svg"); d.style.cssText = "position:absolute;left:-9999px;width:400px;height:300px"; d.innerHTML = s.replace(/^<svg[^>]*>|<\/svg>$/g, ""); document.body.appendChild(d);
          let a = 0; d.querySelectorAll('path[fill="var(--mhot)"]').forEach(x => { if (+x.getAttribute("fill-opacity") > .55) { const L = x.getTotalLength(), q = [];
            for (let i = 0; i < 80; i++) { const pt = x.getPointAtLength(L * i / 80); q.push([pt.x, pt.y]); }
            let s = 0; q.forEach((u, i) => { const v = q[(i + 1) % q.length]; s += u[0] * v[1] - v[0] * u[1]; }); a += Math.abs(s) / 2; } }); d.remove(); return a; };
        const wrong = []; for (const id of ids) { const sp = T.motSpec(id); if (sp.v) continue; for (const k in sp.B) if (sp.A[k] != null && Math.abs(sp.B[k] - sp.A[k]) > 180 && k !== "ua") wrong.push(id + ":" + k); }
        const st = { p: 1 }, side = ids.filter(id => !T.motSpec(id).v);
        return { curves: side.every(id => (S(id, 1).match(/C[\d.-]/g) || []).length > 60), head: side.every(id => /fill="var\(--mbody2\)"/.test(S(id, 1))),
          bic0: hotW(S("hs-curl", 0)), bic1: hotW(S("hs-curl", 1)), quad0: hotW(S("hs-legext", 0)), quad1: hotW(S("hs-legext", 1)),
          arrows: ids.filter(id => !/class="marrow"/.test(S(id, 1))), wrong: [...new Set(wrong)],
          cue: ["start", "con", "turn", "ecc"].map(s => T.musCue(T.motSpec("hs-chest"), T.ex("hs-chest"), s)),
          cueDown: ["start", "ecc", "turn", "con"].map(s => T.musCue(T.motSpec("hs-vsquat"), T.ex("hs-vsquat"), s)) }; });
      ok("Seitenansicht: Körper aus weichen Umrissen (Muskelwölbungen, Kopf im Profil mit Haaren) bei allen 44 Geräten", r.curves && r.head);
      ok("Muskel wird beim Verkürzen dicker: Bizeps beim Armbeugen, vorderer Oberschenkel beim Beinstrecken", r.bic1 > r.bic0 * 1.05 && r.quad1 > r.quad0 * 1.05, [r.bic0, r.bic1, r.quad0, r.quad1].map(Math.round).join());
      ok("Pfeil zeigt die Bewegungsrichtung bei allen 60 Geräten", r.arrows.length === 0, r.arrows.join());
      ok("Kein Gelenk dreht falsch herum (Beinbeuger, Hüftheben, Trizeps über Kopf korrigiert)", r.wrong.length === 0, r.wrong.join());
      ok("Muskel je Phase: gedehnt, wird kürzer, fest angespannt, wird langsam länger",
        r.cue.join("|") === "Brustmuskel gedehnt|Brustmuskel wird kürzer und spannt an|Brustmuskel kurz und fest angespannt|Brustmuskel bleibt gespannt und wird langsam länger", r.cue.join("|"));
      ok("Kniebeuge: oben kurz, runter länger, unten gedehnt, hoch kürzer",
        r.cueDown.join("|") === "Oberschenkel vorn kurz|Oberschenkel vorn bleibt gespannt und wird langsam länger|Oberschenkel vorn gedehnt|Oberschenkel vorn wird kürzer und spannt an", r.cueDown.join("|"));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-chest]");
      const lines = new Set(), hs = new Set();
      for (const v of [50, 250, 450, 750]) { await page.$eval("#gMotion .mscrub", (x, v) => { x.value = String(v); x.dispatchEvent(new Event("input", { bubbles: true })); }, v); await page.waitForTimeout(120);
        lines.add(await page.textContent("#gMotion .mcue-m")); hs.add(Math.round((await page.$eval("#gMotion .mcue", e => e.getBoundingClientRect().height)))); }
      ok("Geräteseite: Zeile zum Muskel wechselt mit der Phase, ohne dass die Seite springt", lines.size === 4 && hs.size === 1, [...lines].join(" | ") + " " + [...hs].join());
      ok("Geräteseite mit Muskelzeile bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
      // Bewegung reduzieren: Start und Ende still, darunter der Ablauf in einem Satz
      const o = await open({ plan: PLAN_SMALL }, { reducedMotion: "reduce" });
      await o.page.click("[data-a=tab][data-v=lib]"); await o.page.click("[data-a=openEx][data-id=hs-curl]");
      const still = await o.page.$eval("#gMotion", e => ({ anim: !!e.querySelector("svg[data-anim]"), line: (e.querySelector(".mcue-m.still") || {}).textContent || "" }));
      ok("„Bewegung reduzieren“: Ablauf des Muskels als Satz unter dem Bild", !still.anim && still.line === "Bizeps: hin kürzer, zurück langsam länger", JSON.stringify(still));
      await o.ctx.close();
    }

    section("78. 3D-Ansicht: Figur und Gerät im Raum, drehbar");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL }, { v3: true, light: true });
      const r = await tp(page, () => { const T = window.__tp, ids = T.allEx().map(x => x.id).filter(id => T.motSpec(id)), bad = [];
        for (const id of ids) { const sp = T.motSpec(id), e = T.ex(id); try { const y = T.m3Yaw(sp, e), a = T.m3Draw(sp, { p: 0, act: 1 }, e, y), b = T.m3Draw(sp, { p: 1, act: 1 }, e, y), c = T.m3Draw(sp, { p: 1, act: 1 }, e, y + 90);
          if (a.length < 2000 || a === b || b === c || /NaN|Infinity/.test(a + b + c) || !/var\(--mhot\)/.test(b) || !/class="marrow"/.test(b)) bad.push(id); } catch (err) { bad.push(id + ":" + err.message); } }
        const box = T.m3Box(T.motSpec("hs-fly"), T.ex("hs-fly")).split(" ").map(Number);
        return { n: ids.length, bad, box: box[2] / box[3] }; });
      ok("Alle 60 Geräte in 3D: Start und Ende verschieden, Blickwinkel ändert das Bild, roter Muskel und Pfeil, keine Rechenfehler", r.n === 60 && r.bad.length === 0, r.bad.join());
      ok("3D-Bildausschnitt im Seitenverhältnis 4:3 (bleibt beim Drehen gleich)", Math.abs(r.box - 4 / 3) < .01, String(r.box));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-chest]"); await page.waitForTimeout(300);
      ok("Geräteseite zeigt 3D (Standard), Knopf „2D“ zum Umschalten", !!(await page.$("#gMotion svg.motion[data-v3]")) && (await page.textContent("#gMotion [data-a=mot3d]")) === "2D");
      const y0 = await page.getAttribute("#gMotion svg.motion", "data-yaw"), bb = await page.$eval("#gMotion svg.motion", s => { const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(bb.x, bb.y); await page.mouse.down(); await page.mouse.move(bb.x + 60, bb.y, { steps: 4 }); await page.mouse.up();
      const y1 = await page.getAttribute("#gMotion svg.motion", "data-yaw");
      ok("Ziehen dreht die 3D-Ansicht", +y1 > +y0 + 30, y0 + " → " + y1);
      // Mit WebGL zeichnet three.js auf eine Leinwand über dem SVG, sonst läuft die gezeichnete 3D-Ansicht
      await page.waitForTimeout(1500);
      const gl = await page.evaluate(() => !!document.querySelector("#gMotion canvas.m3gl") && document.querySelector("#gMotion svg.motion").dataset.gl === "1");
      const f1 = await page.$eval("#gMotion svg .mfig", g => g.innerHTML); await page.waitForTimeout(500); const f2 = await page.$eval("#gMotion svg .mfig", g => g.innerHTML);
      ok("3D-Animation läuft (WebGL-Leinwand oder gezeichnet)", gl || f1 !== f2, String(gl));
      // Leinwand liegt genau über dem SVG (Lage aus den Bildschirmmaßen, SVG hat kein offsetLeft)
      const pos = await page.evaluate(() => { const c = document.querySelector("#gMotion canvas.m3gl"); if (!c) return null; const s = document.querySelector("#gMotion svg.motion").getBoundingClientRect(), q = c.getBoundingClientRect();
        return { d: Math.max(Math.abs(s.x - q.x), Math.abs(s.y - q.y), Math.abs(s.width - q.width)), css: c.style.left + "/" + c.style.top }; });
      ok("WebGL-Leinwand deckt das SVG genau ab", !pos || (pos.d < 1.5 && !/undefined/.test(pos.css)), JSON.stringify(pos));
      await page.click("#gMotion [data-a=mot3d]");
      ok("Umschalten auf 2D bleibt gespeichert", !(await page.$("#gMotion svg.motion[data-v3]")) && (await page.evaluate(() => localStorage.getItem("tp-3d"))) === "0"
        && await page.evaluate(() => { const c = document.querySelector("#gMotion canvas.m3gl"); return !c || c.style.display === "none"; }));
      await page.click("#gMotion [data-a=mot3d]");
      ok("Geräteseite mit 3D bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }

    section("79. Ausführung wie am Gerät, Körpermaße");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        // Hebel bleibt gleich lang: Abstand Drehpunkt–Hand über die ganze Bewegung (Brustpresse, Rudern, Schulterpresse)
        const lever = id => { const sp = T.motSpec(id), rig = T.mRig(sp), L = [0, .25, .5, .75, 1].map(q => d(rig.pv, T.mJoints(sp, T.mPose(sp, q)).hand)); return Math.max(...L) - Math.min(...L); };
        // Beinpresse: Fußmitte läuft auf einer Geraden (Schiene)
        const rail = id => { const sp = T.motSpec(id), P = [0, .25, .5, .75, 1].map(q => { const j = T.mJoints(sp, T.mPose(sp, q)); return [(j.ank[0] + j.toe[0]) / 2, (j.ank[1] + j.toe[1]) / 2]; });
          const a = P[0], b = P[4], L = d(a, b); return Math.max(...P.map(q => Math.abs((b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1])) / L)); };
        // Glieder behalten ihre Länge
        const seg = id => { const sp = T.motSpec(id), out = []; for (const q of [0, .5, 1]) { const j = T.mJoints(sp, T.mPose(sp, q)); out.push(d(j.sho, j.elb), d(j.elb, j.hand), d(j.hip, j.knee), d(j.knee, j.ank)); } return out; };
        return { lev: ["hs-chest", "hs-row", "hs-shoulder", "lf-chest"].map(lever), rail: ["hs-legpress", "lf-legpress"].map(rail), seg: seg("hs-chest").concat(seg("hs-legpress")) }; });
      ok("Griff läuft auf dem Kreisbogen um den Drehpunkt, der Hebel bleibt gleich lang", r.lev.every(x => x < .3), r.lev.map(x => x.toFixed(2)).join());
      ok("Beinpresse: Fußplatte läuft gerade auf der Schiene", r.rail.every(x => x < .3), r.rail.map(x => x.toFixed(2)).join());
      ok("Ober- und Unterschenkel behalten ihre Länge (39,5 / 39)", r.seg.filter((x, i) => i % 4 >= 2).every((x, i) => Math.abs(x - [39.5, 39][i % 2]) < .3), r.seg.map(x => x.toFixed(1)).join());
      // Feste Regeln für jede Phase jeder Seitenansicht (Gliedlängen, Ellbogen und Knie im natürlichen Bereich, Füße nicht im Boden,
      // Füße bleiben bei Sitzgeräten stehen, Hebel gleich lang, Drehpunkt nicht im Rumpf, Scheiben über dem Boden)
      const chk = await tp(page, () => { const T = window.__tp, out = []; for (const e of T.allEx()) { const sp = T.motSpec(e.id); if (!sp || sp.v) continue; sp._stackOnly = e.type === "stack"; const f = T.motCheck(sp); if (f.length) out.push(e.id + ": " + f.join("; ")); } return out; });
      ok("Bewegungsprüfung: alle Seitenansichten in 11 Stellungen ohne Befund", chk.length === 0, chk.slice(0, 4).join(" | "));
      await ctx.close();
    }

    section("80. 3D-Prüfung, Kontaktstellen, Herstellerwinkel");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), Q = [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1];
        // 3D-Regeln für alle Geräte: Hand hält etwas, kein Geräteteil im Körper, kein Teil schwebt
        const bad = []; for (const e of T.allEx()) { const sp = T.motSpec(e.id); if (!sp) continue; const f = T.m3Check(sp, e); if (f.length) bad.push(e.id + ": " + f[0]); }
        // Prüfung erkennt Fehler: ein Teil ohne Verbindung schwebt, eines am Boden nicht
        const fl = T.m3Float([{ t: "ball", c: [0, 30, 0], r: 2 }, { t: "cap", A: [0, -44, 0], B: [0, 10, 0], rA: 1.6, rB: 1.6 }], -44).length;
        // Gegenproben: Unterarm durch den Rumpf wird erkannt; Hebel, der durch einen festen Kasten schwenkt, wird erkannt
        const J0 = T.m3Pose(T.motSpec("hs-chest"), 0), Jb = JSON.parse(JSON.stringify(J0)); Jb.haR = [0, 25, 0]; Jb.elR = [10, 30, 14];
        const self = [T.m3Self(J0).length, T.m3Self(Jb).length], bx = { t: "box", c: [0, 0, 0], ax: [5, 0, 0], ay: [0, 5, 0], az: [0, 0, 5] };
        const cross = T.m3Cross([[bx, { t: "cap", A: [-20, 20, 0], B: [-20, 30, 0], rA: 1.5, rB: 1.5 }], [bx, { t: "cap", A: [-10, 0, 0], B: [10, 0, 0], rA: 1.5, rB: 1.5 }]]).length;
        // Seilzug: zwischen Hand und Rolle bleibt Seil
        const cab = ["lf-pushdown", "lf-ohtri", "lf-cablecurl", "lf-facepull"].map(id => { const sp = T.motSpec(id); return Math.min(...[0, .25, .5, .75, 1].map(q => d(T.mJoints(sp, T.mPose(sp, q)).hand, sp.cable))); });
        // Multipresse: Stange auf einer Geraden, 7° zur Senkrechten (Hersteller)
        const sm = T.motSpec("hs-smith"), H = Q.map(q => T.mJoints(sm, T.mPose(sm, q)).hand), sDeg = Math.atan2(Math.abs(H[10][0] - H[0][0]), Math.abs(H[10][1] - H[0][1])) * 180 / Math.PI;
        const sDev = Math.max(...H.map(h => Math.abs((H[10][0] - H[0][0]) * (H[0][1] - h[1]) - (H[0][0] - h[0]) * (H[10][1] - H[0][1])) / d(H[0], H[10])));
        // Hackenschmidt: Schulterpolster auf 45°, parallel zum Rücken; Beinpresse: Fußplatte auf 45°
        const hk = T.motSpec("hs-hack"), eff = (sp, fx, q) => { const P = T.mPose(sp, q); return T.mEff(fx, T.mJoints(sp, P), P); }, h0 = eff(hk, "sho", 0), h1 = eff(hk, "sho", 1), j0 = T.mJoints(hk, T.mPose(hk, 0));
        const hDeg = Math.atan2(Math.abs(h1[1] - h0[1]), Math.abs(h1[0] - h0[0])) * 180 / Math.PI, back = Math.atan2(j0.hip[1] - j0.sho[1], j0.hip[0] - j0.sho[0]), path = Math.atan2(h1[1] - h0[1], h1[0] - h0[0]);
        const lp = T.motSpec("hs-legpress"), l0 = eff(lp, "foot", 0), l1 = eff(lp, "foot", 1), lDeg = Math.atan2(Math.abs(l1[1] - l0[1]), Math.abs(l1[0] - l0[0])) * 180 / Math.PI;
        // Hüftgurt-Kniebeuge: Hebel gleich lang, Kette höchstens 15° schräg, Scheiben vorn vor den Zehen, Drehpunkt hinten
        const bs = T.motSpec("hs-beltsquat"); T.motBox(bs); const B = Q.map(q => { const j = T.mJoints(bs, T.mPose(bs, q)); return { j, b: T.mBelt(bs, j) }; });
        const bL = B.map(x => d(x.b.P, x.b.A)), chain = Math.max(...B.map(x => Math.abs(Math.atan2(x.b.A[0] - x.b.B[0], x.b.A[1] - x.b.B[1])) * 180 / Math.PI));
        // Kontaktstellen auf der Körperoberfläche (Mitte des Polsters: Dicke des Körperteils + Polsterradius quer zur Gliedachse)
        const segD = (q, a, b) => { const ab = [b[0] - a[0], b[1] - a[1]], L2 = ab[0] ** 2 + ab[1] ** 2, f = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / L2)); return d(q, [a[0] + ab[0] * f, a[1] + ab[1] * f]); };
        const pad = (id, fx, seg) => { const sp = T.motSpec(id), P = T.mPose(sp, .5), j = T.mJoints(sp, P); return segD(T.mEff(fx, j, P), j[seg[0]], j[seg[1]]); };
        return { n: T.allEx().filter(e => T.motSpec(e.id)).length, bad, fl, self, cross, cab, sDeg, sDev, hDeg, par: Math.abs(back - path) * 180 / Math.PI, lDeg, bL: Math.max(...bL) - Math.min(...bL), chain,
          front: B.every(x => x.b.H[0] > x.j.toe[0] && x.b.P[0] < x.j.hip[0]), pads: [pad("hs-legext", "shin", ["knee", "ank"]), pad("hs-seatcurl", "heel", ["knee", "ank"]), pad("hs-seatcalf", "knee", ["hip", "knee"])] }; });
      ok("3D-Prüfung: bei allen 60 Geräten hält die Hand etwas, kein Geräteteil im Körper, kein Teil schwebt, keine Durchdringung von Körper oder Teilen", r.n === 60 && r.bad.length === 0, r.bad.slice(0, 3).join(" | "));
      ok("3D-Prüfung erkennt schwebende Teile (Gegenprobe)", r.fl === 1, String(r.fl));
      ok("Körper durchdringt sich nicht: Gegenprobe Unterarm im Rumpf wird erkannt", r.self[0] === 0 && r.self[1] > 0, JSON.stringify(r.self));
      ok("Bewegte Teile durch feste Teile: Gegenprobe wird erkannt", r.cross > 0, String(r.cross));
      ok("Seilzüge: zwischen Hand und Umlenkrolle bleibt immer Seil (mind. 15)", r.cab.every(x => x >= 15), r.cab.map(x => x.toFixed(0)).join());
      ok("Multipresse: Stange läuft gerade, 7° zur Senkrechten (Herstellerangabe)", Math.abs(r.sDeg - 7) < .5 && r.sDev < .3, r.sDeg.toFixed(1) + "° / " + r.sDev.toFixed(2));
      ok("Hackenschmidt: Schulterpolster auf 45°, parallel zum Rückenpolster (Herstellerangabe)", Math.abs(r.hDeg - 45) < 1 && r.par < 1, r.hDeg.toFixed(1) + "° / " + r.par.toFixed(1));
      ok("Beinpresse: Fußplatte auf 45° (Herstellerangabe)", Math.abs(r.lDeg - 45) < 1, r.lDeg.toFixed(1) + "°");
      ok("Hüftgurt-Kniebeuge: Hebel gleich lang, Kette höchstens 15° schräg, Scheiben vorn, Drehpunkt hinten", r.bL < .3 && r.chain <= 15 && r.front, r.bL.toFixed(2) + " / " + r.chain.toFixed(1) + "° / " + r.front);
      ok("Polster liegen auf der Körperoberfläche, nicht in der Gliedachse (Abstand 7–10)", r.pads.every(x => x > 7 && x < 10), r.pads.map(x => x.toFixed(1)).join());
      await ctx.close();
    }

    section("81. Wissen: gut kombinieren");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const r = await tp(page, () => { const T = window.__tp, bad = [];
        // Partner: immer Gegenspieler-Muster, nie das Gerät selbst, nie „nicht im Studio“
        for (const e of T.allEx()) { const pats = T.ANTAG[e.pattern] || []; for (const x of T.comboPartners(e)) if (x.id === e.id || x.off || !pats.includes(x.pattern)) bad.push(e.id + "→" + x.id); }
        const pat = id => T.comboPartners(T.ex(id)).map(x => x.pattern);
        return { bad, chest: pat("hs-chest"), sho: pat("hs-shoulder"), curl: pat("hs-curl"), ext: pat("hs-legext"), abd: pat("hs-abductor"), calf: pat("hs-calf").length }; });
      ok("Supersatz-Partner sind immer Gegenspieler aus dem eigenen Studio", r.bad.length === 0, r.bad.slice(0, 4).join());
      ok("Gegenspieler-Paare: Brustpresse–Rudern, Schulterpresse–Latziehen, Bizeps–Trizeps, Beinstrecker–Beinbeuger, Abduktor–Adduktor",
        r.chest[0] === "pull_h" && r.sho[0] === "pull_v" && ["tri", "dip"].includes(r.curl[0]) && r.ext[0] === "knee_flex" && r.abd[0] === "add" && r.calf === 0, JSON.stringify(r));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-chest]"); await page.waitForTimeout(200);
      const s = await page.evaluate(() => { const c = document.getElementById("exCombo"); return c ? { part: c.querySelectorAll("#comboPart [data-a=openEx]").length, same: !!c.querySelector("#comboSame"), order: !!c.querySelector("#comboOrder"), src: c.querySelectorAll(".srcs li").length, txt: c.innerText } : null; });
      ok("Geräteseite: Abschnitt „Gut kombinieren“ mit Partnergeräten, Hinweis zu gleichem Muskel und Reihenfolge, zwei Quellen", !!s && s.part > 0 && s.same && s.order && s.src === 2, JSON.stringify(s && { ...s, txt: undefined }));
      ok("Keine unbelegten Erfolgsversprechen im Abschnitt", !!s && !/garantiert|maximal|beste[sn]? Ergebnis|doppelt/i.test(s.txt));
      await page.click("#comboPart [data-a=openEx]"); await page.waitForTimeout(200);
      ok("Tippen auf ein Partnergerät öffnet dessen Seite", /Rudern/.test(await page.textContent(".exhead h1")));
      await page.click("[data-a=exBack]"); await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-calf]"); await page.waitForTimeout(200);
      ok("Ohne Gegenspieler-Gerät: ehrlicher Hinweis mit Namen des Gegenspielers", /Schienbeinmuskel/.test(await page.textContent("#comboNone")));
      ok("Geräteseite mit „Gut kombinieren“ bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }

    section("82. Supersatz im Plan und im Training");
    {
      const SS = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Test", items: [
        { id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 60, ss: "i2" },
        { id: "i2", exId: "hs-row", sets: 2, rmin: 8, rmax: 12, rest: 75 },
        { id: "i3", exId: "hs-legext", sets: 1, rmin: 8, rmax: 12, rest: 0, ss: "i9" }] }] };
      const { ctx, page } = await open({ plan: SS });
      const r = await tp(page, () => { const T = window.__tp, d = T.state.plan.days[0];
        const a = d.items.map(i => Object.assign({}, i)), b = a.map(i => { const c = Object.assign({}, i); delete c.ss; return c; });
        return { ss: d.items.map(i => i.ss || ""), withSS: T.estimateSec(a), without: T.estimateSec(b) }; });
      ok("Ungültige Verbindung (Partner nicht direkt dahinter) wird beim Laden entfernt", r.ss.join() === "i2,,", r.ss.join());
      // Zeitmodell: Satz 15 + 3,5 × 10 = 50 s; ohne Supersatz 120 + (2×50+60) + 120 + (2×50+75) + 120 + 50 = 745;
      // mit: 120 + 2×(50+20+50) + 75 + 120 + 50 = 605
      ok("Zeitschätzung: Supersatz als ein Block (Wechsel 20 s, Pause erst nach beiden)", r.without === 745 && r.withSS === 605, r.without + " / " + r.withSS);
      await page.click("[data-a=start]"); await page.waitForTimeout(100);
      ok("Training: Hinweis „Supersatz 1/2 – danach sofort Rudern“", /Supersatz 1\/2/.test(await page.textContent("#ssNote")) && /Rudern/.test(await page.textContent("#ssNote")));
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); await page.waitForTimeout(100);
      const sw = await tp(page, () => { const s = window.__tp.state.session; return { total: s.restTotal, sw: s.ssSwitch, ex: s.list[s.idx].exId }; });
      ok("Nach Satz 1: kurzer Wechsel (20 s) zum Partnergerät, nicht die volle Pause", sw.total === 20 && sw.sw === true && sw.ex === "hs-row" && /Wechsel/.test(await page.textContent(".rest")) && (await page.textContent("[data-a=skipRest]")) === "Bin am Gerät", JSON.stringify(sw));
      ok("Wechsel: „Wie war Satz 1?“ bleibt erhalten", !!(await page.$(".feel-q")));
      await page.click("[data-a=skipRest]"); await page.waitForTimeout(100);
      ok("Partnergerät: „Supersatz 2/2 – danach Pause“", /Supersatz 2\/2/.test(await page.textContent("#ssNote")) && /Pause/.test(await page.textContent("#ssNote")));
      await page.fill("#kgIn", "50"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); await page.waitForTimeout(100);
      const ps = await tp(page, () => { const s = window.__tp.state.session; return { total: s.restTotal, sw: !!s.ssSwitch, ex: s.list[s.idx].exId }; });
      ok("Nach dem Partner: normale Pause (75 s), danach zurück zur Brustpresse", ps.total === 75 && !ps.sw && ps.ex === "hs-chest" && /Supersatz: zurück zu/.test(await page.textContent(".next")), JSON.stringify(ps));
      await page.click("[data-a=skipRest]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); await page.click("[data-a=skipRest]");
      await page.fill("#kgIn", "50"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); await page.waitForTimeout(100);
      const nx = await tp(page, () => { const s = window.__tp.state.session; return { total: s.restTotal, ex: s.list[s.idx].exId }; });
      ok("Beide fertig: weiter zur nächsten Übung (Beinstrecker)", nx.ex === "hs-legext" && nx.total === 75, JSON.stringify(nx));
      ok("Training mit Supersatz bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await ctx.close();
    }
    {
      const SS2 = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag A", items: [
        { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-legext", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "i3", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan: SS2 });
      // Wissen → Gut kombinieren: Partner im selben Tag verbinden
      await page.click("[data-a=tab][data-v=lib]"); await page.click("[data-a=openEx][data-id=hs-chest]"); await page.waitForTimeout(150);
      ok("Wissen: Knopf „In „Tag A“ mit Rudern verbinden“", /Tag A/.test(await page.textContent("#ssLinkBtn")));
      await page.click("#ssLinkBtn"); await page.waitForTimeout(150);
      const st = await stored(page), it = st.plan.days[0].items;
      ok("Verbinden stellt Rudern direkt hinter die Brustpresse und verbindet beide", it.map(i => i.exId).join() === "hs-chest,hs-row,hs-legext" && it[0].ss === it[1].id, it.map(i => i.exId + (i.ss ? "→" + i.ss : "")).join());
      ok("Danach steht dort „verbunden“", /verbunden/.test(await page.textContent("#ssLinked")));
      // Tagesansicht: Kennzeichnung, Geräte-Sheet: Schalter, Verschieben löst
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay][data-id=d1]"); await page.waitForTimeout(150);
      const day = await tp(page, () => ({ b: [...document.querySelectorAll("#dayItems .badge.ssb")].map(x => x.textContent), note: !!document.getElementById("ssDayNote") }));
      ok("Tagesansicht: „Supersatz 1/2“ und „2/2“ mit Hinweis", day.b.join() === "Supersatz 1/2,Supersatz 2/2" && day.note, JSON.stringify(day));
      await page.click("#dayItems [data-a=moveItem][data-i2='2']"); await page.waitForTimeout(100);
      const mv = (await stored(page)).plan.days[0].items;
      ok("Verschieben löst die Verbindung (keine ungewollten Paare)", mv.every(i => !i.ss), mv.map(i => i.exId + (i.ss ? "→" : "")).join());
      await page.click("#dayItems [data-a=editItem][data-i2='0']"); await page.waitForTimeout(100);
      ok("Geräte-Sheet: Schalter „Mit … als Supersatz“, Hinweis bei gleichem Muskel nur wenn nötig", !!(await page.$("#ssField [data-a=ssToggle]")));
      await page.click("#ssField [data-a=ssToggle]"); await page.click("[data-a=saveItem]"); await page.waitForTimeout(100);
      const tg = (await stored(page)).plan.days[0].items;
      ok("Schalter verbindet mit der nächsten Übung", tg[0].ss === tg[1].id, tg.map(i => i.ss || "").join());
      // Tag kopieren: Verbindung zeigt auf die neuen Kopien
      const cp = await tp(page, () => { const T = window.__tp; T.dayCopyDoFn("new"); const d = T.state.plan.days.at(-1); return { ok: d.items[0].ss === d.items[1].id, ids: d.items.map(i => i.id + ">" + (i.ss || "")) }; });
      ok("Tag kopieren: Supersatz zeigt auf die neuen Geräte-Einträge", cp.ok, JSON.stringify(cp.ids));
      await ctx.close();
    }

    section("83. iOS-Navigation und Bedienung");
    {
      const P = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Oberkörper", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a2", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Beine", items: [{ id: "b1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan: P }, { tabmem: true });
      const nav = () => tp(page, () => { const n = document.getElementById("navbar"); return { hidden: n.hidden, back: (n.querySelector(".nb-back") || {}).textContent || "", t: n.querySelector(".nb-t").textContent,
        sc: n.classList.contains("scrolled"), r: n.querySelectorAll(".nb-r [data-a]").length, headBack: !!document.querySelector("#app .head button.link:not(.nb-back)") }; });
      await page.click("[data-a=tab][data-v=plan]");
      let n = await nav();
      ok("Startseite eines Tabs: Leiste ohne Zurück, Einstellungen rechts oben, großer Titel im Inhalt", !n.hidden && !n.back && n.r === 1 && n.t === "Mein Plan" && !n.sc, JSON.stringify(n));
      await page.click("[data-a=editDay][data-id=a]"); n = await nav();
      ok("Unterseite: „‹ Plan“ links in der Leiste, kein zweiter Zurück-Link im Inhalt", n.back.trim() === "Plan" && !n.headBack && n.t === "Oberkörper", JSON.stringify(n));
      ok("Löschen steht als rote Zeile unten, nicht oben in der Leiste", await page.isVisible("#app .group [data-a=delDay].danger") && !(await page.$("#navbar [data-a=delDay]")));
      ok("Trainingstag bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })());
      // Tab-Verlauf: anderer Tab und zurück → wieder auf der Unterseite; Tippen auf den aktiven Tab → Startseite
      await page.click("nav.tabs [data-v=lib]"); await page.click("nav.tabs [data-v=plan]");
      ok("Tab-Verlauf: zurück im Tab „Training“ steht wieder der Trainingstag", await tp(page, () => window.__tp.state && !!document.getElementById("dayStart")));
      await page.click("nav.tabs [data-v=plan]");
      ok("Aktiven Tab nochmals antippen: zurück zur Startseite des Tabs", !(await page.$("#dayStart")) && !!(await page.$("[data-a=editDay][data-id=a]")));
      // Großer Titel → kleiner Titel in der Leiste beim Scrollen; Zurück stellt die Scrollposition wieder her
      await page.click("nav.tabs [data-v=lib]"); await page.evaluate(() => window.scrollTo(0, 900)); await sleep(80);
      n = await nav();
      ok("Beim Scrollen erscheint der kleine Titel „Wissen“ in der Leiste (mit Hintergrund)", n.sc && n.t === "Wissen", JSON.stringify(n));
      const y0 = await page.evaluate(() => window.scrollY);
      const id = await page.evaluate(() => { const b = [...document.querySelectorAll("[data-a=openEx]")].find(x => { const r = x.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 100; }); return b && b.dataset.id; });
      await page.click(`[data-a=openEx][data-id="${id}"]`); await sleep(50);
      ok("Geräteseite öffnet oben", (await page.evaluate(() => window.scrollY)) === 0);
      await page.click("#navbar .nb-back"); await sleep(50);
      const y1 = await page.evaluate(() => window.scrollY);
      ok("Zurück: Liste wieder an derselben Stelle", Math.abs(y1 - y0) < 2, y0 + " → " + y1);
      // Tippen auf den aktiven Tab an der Startseite: nach oben
      await page.click("nav.tabs [data-v=lib]"); await sleep(50);
      ok("Aktiver Tab an der Startseite: nach oben", (await page.evaluate(() => window.scrollY)) === 0);
      await ctx.close();
    }
    {
      // Übergang und Wischgeste (Bewegung für diesen Test eingeschaltet)
      const P = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Oberkörper", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan: P }, { extra: { "tp-anim": "1" } });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay][data-id=a]");
      const mid = await tp(page, () => ({ layers: document.querySelectorAll(".navlayer").length, anim: document.body.classList.contains("nav-anim") }));
      await sleep(600);
      const after = await tp(page, () => ({ layers: document.querySelectorAll(".navlayer").length, anim: document.body.classList.contains("nav-anim") }));
      ok("Neue Seite schiebt sich herein (alte und neue Seite als Ebenen), danach ist alles wieder normal", mid.layers === 2 && mid.anim && after.layers === 0 && !after.anim, JSON.stringify([mid, after]));
      const cdp = await ctx.newCDPSession(page), T = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      await T("touchStart", 6, 400); for (let x = 20; x <= 260; x += 30) { await T("touchMove", x, 402); await sleep(16); }
      const sw = await tp(page, () => ({ layers: document.querySelectorAll(".navlayer").length }));
      await T("touchEnd"); await sleep(500);
      ok("Wischen vom linken Rand: vorige Seite liegt darunter, Loslassen führt zurück", sw.layers === 2 && !!(await page.$("[data-a=editDay][data-id=a]")) && !(await page.$("#dayStart")), JSON.stringify(sw));
      await page.click("[data-a=editDay][data-id=a]"); await sleep(600);
      await T("touchStart", 6, 400); await sleep(120); await T("touchMove", 40, 401); await sleep(150); await T("touchMove", 70, 402); await sleep(150); await T("touchEnd"); await sleep(500);
      ok("Kurzes, langsames Wischen: bleibt auf der Seite", !!(await page.$("#dayStart")) && (await tp(page, () => document.querySelectorAll(".navlayer").length)) === 0);
      // Sheet: Abbrechen | Titel | Fertig, Stepper, Schalter, Herunterziehen schließt
      await page.click("#dayItems [data-a=editItem][data-i2='0']");
      const hd = await tp(page, () => { const h = document.querySelector(".sheet .sh-head"); return { l: h.querySelector(".sh-l").textContent, la: h.querySelector(".sh-l").dataset.a, t: h.querySelector("h2").textContent, r: h.querySelector("[data-a=saveItem]").textContent }; });
      ok("Geräte-Sheet: „Abbrechen“ links, Name in der Mitte, „Fertig“ rechts", hd.l === "Abbrechen" && hd.la === "closeSheet" && hd.t === "Brustpresse" && hd.r === "Fertig", JSON.stringify(hd));
      await page.click(".sheet .ustep [data-k=sets][data-d='1']");
      ok("Stepper − | + ändert den Wert in der Zeile", (await page.textContent(".sheet .step-row .sv")) === "4");
      await page.click(".sheet .sh-l"); await sleep(50);
      ok("Abbrechen verwirft die Änderung", (await stored(page)).plan.days[0].items[0].sets === 3);
      await page.click("#dayItems [data-a=editItem][data-i2='0']");
      const g = await page.$eval(".sheet .grab", e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await T("touchStart", g.x, g.y); for (let d = 20; d <= 260; d += 40) { await T("touchMove", g.x, g.y + d); await sleep(16); } await T("touchEnd"); await sleep(400);
      ok("Sheet am Griff herunterziehen schließt es", !(await page.$(".sheet")));
      // Gerät bearbeiten: iOS-Schalter
      await page.click("#dayItems [data-a=editItem][data-i2='0']"); await page.click(".sheet [data-a=editDev]");
      const swi = await page.$$eval(".sheet .switch", b => b.map(x => x.getAttribute("role") + ":" + x.getAttribute("aria-checked")));
      await page.click(".sheet .switch[data-k=fav]");
      const sw2 = await page.$eval(".sheet .switch[data-k=fav]", b => b.getAttribute("aria-checked"));
      ok("Gerät: „Bevorzugt“ und „In meinem Studio“ als Schalter, Tippen schaltet um", swi.join() === "switch:false,switch:true" && sw2 === "true", swi.join() + " / " + sw2);
      await page.click(".sheet [data-a=devCancel]");
      // Löschen: Aktionsblatt mit roter Option und getrenntem Abbrechen
      await page.click("#app [data-a=delDay]");
      const as = await tp(page, () => { const s = document.querySelector(".sheet.as"); return s && { q: s.querySelector(".as-t").textContent, d: s.querySelector(".as-btn.danger").textContent, c: s.querySelector(".as-cancel").textContent }; });
      ok("Tag löschen: Aktionsblatt (Frage, rote Option, darunter Abbrechen)", !!as && as.q === "Tag löschen?" && as.d === "Tag löschen" && as.c === "Abbrechen", JSON.stringify(as));
      await page.click(".sheet.as .as-cancel");
      ok("Abbrechen lässt den Tag stehen", !(await page.$(".sheet")) && (await stored(page)).plan.days.length === 1);
      await ctx.close();
    }
    {
      // Wischen nach links zum Löschen, Formular-Sheets mit Abbrechen/Speichern oben, gefülltes Tab-Symbol
      const P = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Oberkörper", items: [
        { id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a2", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a3", exId: "hs-shoulder", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan: P });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay][data-id=a]");
      const cdp = await ctx.newCDPSession(page), T = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const row = async i => page.$eval(`#dayItems .li[data-i2='${i}']`, e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width * .7, y: b.y + b.height / 2 }; });
      let r = await row(1); await T("touchStart", r.x, r.y); for (let d = 10; d <= 100; d += 15) { await T("touchMove", r.x - d, r.y); await sleep(20); } await T("touchEnd"); await sleep(350);
      const sw = await tp(page, () => { const b = document.querySelector(".swipe-del"); return b && { t: b.textContent, a: b.dataset.a, l: b.getAttribute("aria-label") }; });
      ok("Nach links wischen zeigt „Löschen“ hinter der Zeile", !!sw && sw.t === "Löschen" && sw.a === "delItemAt" && sw.l === "Rudern löschen", JSON.stringify(sw));
      ok("Wischen öffnet nicht das Geräte-Sheet", !(await page.$(".sheet")));
      await page.click(".swipe-del"); await sleep(100);
      ok("„Löschen“ entfernt genau diese Zeile", (await stored(page)).plan.days[0].items.map(i => i.id).join() === "a1,a3");
      r = await row(0); await T("touchStart", r.x, r.y); for (let d = 10; d <= 70; d += 15) { await T("touchMove", r.x - d, r.y); await sleep(20); } await T("touchEnd"); await sleep(350);
      const o = await row(1); await T("touchStart", o.x, o.y); await T("touchEnd"); await sleep(350);
      ok("Tippen auf eine andere Zeile schließt nur das Wischmenü", !(await page.$(".swipe-del")) && !(await page.$(".sheet")) && (await stored(page)).plan.days[0].items.length === 2);
      // Formular-Sheet: Speichern oben rechts, Abbrechen oben links
      await page.click("nav.tabs [data-v=plan]"); await page.click("[data-a=openSched]");
      const fh = await tp(page, () => { const h = document.querySelector(".sheet > .sh-head"); return h && { l: (h.querySelector(".sh-l") || {}).textContent, r: (h.querySelector("[data-a=schedSave]") || {}).textContent, bottom: [...document.querySelectorAll(".sheet .btn.primary")].length }; });
      ok("Formular-Sheet (Termine): „Abbrechen“ links und „Speichern“ rechts im Kopf, kein Knopf mehr unten", !!fh && fh.l === "Abbrechen" && fh.r === "Speichern" && fh.bottom === 0, JSON.stringify(fh));
      await page.click(".sheet .sh-l");
      ok("Gefülltes Symbol für den aktiven Tab „Fortschritt“", await (async () => { await page.click("nav.tabs [data-v=history]"); return page.$eval("nav.tabs button.on svg .fill", e => getComputedStyle(e).fill !== "none"); })());
      await ctx.close();
    }

    section("84. Inhalt liegt auf Karten (wie in iOS-Apps)");
    {
      // Regel: Auf dem grauen Seitengrund steht kein Text frei – außer Titel, Abschnittsüberschrift, Beitext (.foot) und Bedienelementen.
      // Ausgenommen sind nur Training und Zusammenfassung (Vollbild-Aufgabe ohne Navigationsleiste, wie die Trainings-App).
      const freeText = page => page.evaluate(() => {
        const pg = document.querySelector("#app .page"); if (!pg) return ["(keine Seite)"];
        const bg = getComputedStyle(document.body).backgroundColor, clear = c => !c || c === "rgba(0, 0, 0, 0)" || c === "transparent" || c === bg;
        const onCard = el => { for (let e = el; e && e !== pg; e = e.parentElement) { const cs = getComputedStyle(e); if (!clear(cs.backgroundColor) || cs.backgroundImage !== "none") return true; } return false; };
        const exempt = el => el.closest(".head,.section-head,.foot,.cap,.label,button,a,label,summary,.exhero,.actionbar,h1,h2,h3");
        const out = [], seen = new Set(), w = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.textContent.trim().length < 2) continue; const el = n.parentElement; if (!el || !el.getClientRects().length) continue;
          if (exempt(el) || onCard(el)) continue; const blk = el.closest("p,li,div,section") || el; if (seen.has(blk)) continue; seen.add(blk);
          out.push(`${blk.tagName.toLowerCase()}${blk.id ? "#" + blk.id : ""}.${String(blk.className).split(" ")[0]} „${blk.textContent.trim().replace(/\s+/g, " ").slice(0, 40)}“`); }
        return out; });
      const D = n => new Date(Date.now() - n * 864e5).toISOString(), S3 = (kg, r) => [{ kg, reps: r }, { kg, reps: r }, { kg, reps: r - 1 }];
      const Hh = (dayId, day, n, exs) => ({ id: "h" + n, dayId, day, date: D(n), durationSec: 2900, exercises: exs.map(([exId, kg, r]) => ({ exId, name: exId, u: "s", planned: 3, rmin: 8, rmax: 12, sets: S3(kg, r) })) });
      const dkN = n => { const d = new Date(Date.now() - n * 864e5); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      const st = { plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
          { id: "a", name: "Oberkörper", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a2", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
          { id: "b", name: "Beine", items: [{ id: "b1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 120 }, { id: "b2", exId: "hs-calf", sets: 3, rmin: 10, rmax: 15, rest: 60 }] }] },
        history: [Hh("a", "Oberkörper", 23, [["hs-chest", 37.5, 10]]), Hh("b", "Beine", 20, [["hs-legpress", 115, 10]]), Hh("a", "Oberkörper", 16, [["hs-chest", 40, 10]]), Hh("b", "Beine", 13, [["hs-legpress", 120, 10]]),
          Hh("a", "Oberkörper", 9, [["hs-chest", 40, 10]]), Hh("b", "Beine", 6, [["hs-legpress", 120, 10]]), Hh("a", "Oberkörper", 3, [["hs-chest", 42.5, 10], ["hs-row", 52.5, 10]]), Hh("b", "Beine", 1, [["hs-legpress", 125, 10]])],
        weights: [{ d: dkN(30), kg: 82.4 }, { d: dkN(14), kg: 81.9 }, { d: dkN(2), kg: 81.6 }], sched: { days: [0, 2, 4], time: "18:00", planB: "next" },
        nutr: { sex: "m", age: 34, cm: 181, kg: 81.6, pal: "mid", goal: "hold" }, nutrOpt: { water: true, fast: true }, why: "Fit bleiben",
        food: { [dkN(0)]: [{ id: "f1", m: "fr", n: "Haferflocken", g: 80, src: "x", per: { k: 372, p: 13.5, c: 58.7, f: 7, fib: 10 } }, { id: "f2", m: "fr", n: "Milch", g: 200, src: "x", per: { k: 64, p: 3.3, c: 4.8, f: 3.5, fib: 0 } }] } };
      for (const light of [true, false]) {
        const { ctx, page } = await open(st, { light });
        const res = {}, visit = async (name, steps) => { for (const sel of steps) await page.click(sel); await page.$$eval("#app details", d => d.forEach(x => x.open = true)); await sleep(60); res[name] = await freeText(page); };
        await visit("Heute", ["nav.tabs [data-v=home]"]);
        await visit("Tagesplan", [".week [data-a=openTag]"]);
        await visit("Tagesplan Woche", ["#tagSeg [data-v=woche]"]);
        await visit("Training", ["nav.tabs [data-v=plan]"]);
        await visit("Trainingstag", ["[data-a=editDay][data-id=a]"]);
        await visit("Einstellungen", ["nav.tabs [data-v=plan]", "[data-a=openSettings]"]);
        await visit("Übungen", ["nav.tabs [data-v=lib]"]);
        await visit("Geräteseite", ["[data-a=openEx][data-id=hs-chest]"]);
        await visit("Geräteseite ohne Gegenspieler", ["nav.tabs [data-v=lib]", "[data-a=openEx][data-id=hs-calf]"]);
        await visit("Artikel-Liste", ["nav.tabs [data-v=lib]", "#wissenSeg [data-v=wissen]"]);
        await visit("Artikel", ["[data-a=openArt]"]);
        await visit("Essen", ["nav.tabs [data-v=food]"]);
        await visit("Fortschritt", ["nav.tabs [data-v=history]"]);
        await visit("Wochenrückblick", ["#histWeek"]);
        await visit("Hinweise", ["nav.tabs [data-v=home]", "[data-a=openCoach]"]);
        const bad = Object.entries(res).filter(([, l]) => l.length).map(([v, l]) => `${v}: ${l.slice(0, 3).join(" | ")}`);
        ok(`${light ? "Hell" : "Dunkel"}: in ${Object.keys(res).length} Ansichten steht kein Text frei auf dem Seitengrund`, Object.keys(res).length === 15 && !bad.length, bad.slice(0, 4).join(" · "));
        if (light) { // Gegenprobe: Die Prüfung findet frei stehenden Text wirklich
          await page.evaluate(() => { const p = document.createElement("p"); p.id = "probe"; p.textContent = "Frei stehender Probetext"; document.querySelector("#app .page").appendChild(p); });
          const pr = await freeText(page);
          ok("Gegenprobe: ein frei eingefügter Absatz wird gemeldet", pr.length === 1 && pr[0].includes("Probetext"), pr.join());
          ok("Ansichten mit Karten bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const bad2 = [];
            for (const sel of ["nav.tabs [data-v=home]", "nav.tabs [data-v=history]", "nav.tabs [data-v=food]"]) { await page.click(sel); await page.$$eval("#app details", d => d.forEach(x => x.open = true)); if (!(await noOverflow(page))) bad2.push(sel + " " + await overflowers(page)); }
            if (bad2.length) console.log("    " + bad2.join(" · ")); return !bad2.length; })());
        }
        await ctx.close();
      }
    }
    {
      // Natives Gefühl: Bedienelemente nicht markierbar, Eingaben ab 16 px (sonst zoomt iOS beim Antippen), Statusleiste passend zum Design
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const n = await tp(page, () => { const us = e => { const c = getComputedStyle(e); return c.userSelect || c.webkitUserSelect; };
        return { tab: us(document.querySelector("nav.tabs button")), btn: us(document.querySelector("#app .btn")), title: us(document.querySelector("#app .title")),
          ta: getComputedStyle(document.documentElement).touchAction, meta: (document.querySelector("meta[name=apple-mobile-web-app-status-bar-style]") || {}).content,
          theme: [...document.querySelectorAll("meta[name=theme-color]")].map(m => m.media + "=" + m.content).join(";") }; });
      ok("Knöpfe, Tabs und Titel lassen sich nicht markieren; kein Doppeltipp-Zoom", n.tab === "none" && n.btn === "none" && n.title === "none" && n.ta === "manipulation", JSON.stringify(n));
      ok("Statusleiste folgt dem Design (hell: dunkle Schrift auf hellem Grund, dunkel: helle Schrift auf Schwarz)", n.meta === "default" && /light\)=#F2F2F7/.test(n.theme) && /dark\)=#000000/.test(n.theme), JSON.stringify(n));
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=importOpen]");
      const small = await page.$$eval("input, textarea, select", els => els.filter(e => e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.tagName));
      ok("Eingabefelder mindestens 16 px (kein Zoom beim Antippen)", small.length === 0, small.join());
      await ctx.close();
    }

    section("85. Zeigen statt schreiben: Symbole, Ringe, Bilder");
    {
      const D = n => new Date(Date.now() - n * 864e5).toISOString(), S3 = (kg, r) => [{ kg, reps: r }, { kg, reps: r }, { kg, reps: r - 1 }];
      const Hh = (dayId, day, n, exs) => ({ id: "h" + n, dayId, day, date: D(n), durationSec: 2900, exercises: exs.map(([exId, kg, r]) => ({ exId, name: exId, u: "s", planned: 3, rmin: 8, rmax: 12, sets: S3(kg, r) })) });
      const dkN = n => { const d = new Date(Date.now() - n * 864e5); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      const st = { plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
          { id: "a", name: "Oberkörper", items: ["hs-chest", "hs-row", "hs-shoulder", "hs-pulldown", "hs-fly", "hs-incline", "hs-dip"].map((exId, i) => ({ id: "a" + i, exId, sets: 3, rmin: 8, rmax: 12, rest: 90 })) },
          { id: "b", name: "Beine", items: [{ id: "b1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 120 }] }, { id: "c", name: "Leer", items: [] }] },
        history: [Hh("a", "Oberkörper", 23, [["hs-chest", 37.5, 10]]), Hh("b", "Beine", 20, [["hs-legpress", 115, 10]]), Hh("a", "Oberkörper", 16, [["hs-chest", 40, 10]]), Hh("b", "Beine", 13, [["hs-legpress", 120, 10]]),
          Hh("a", "Oberkörper", 9, [["hs-chest", 40, 10]]), Hh("b", "Beine", 6, [["hs-legpress", 120, 10]]), Hh("a", "Oberkörper", 3, [["hs-chest", 42.5, 10]]), Hh("b", "Beine", 1, [["hs-legpress", 125, 10]])],
        weights: [{ d: dkN(2), kg: 81.6 }], sched: { days: [0, 2, 4], time: "18:00", planB: "next" }, nutr: { sex: "m", age: 34, cm: 181, kg: 81.6, pal: "mid", goal: "hold" },
        food: { [dkN(0)]: [{ id: "f1", m: "fr", n: "Haferflocken", g: 80, src: "x", per: { k: 372, p: 13.5, c: 58.7, f: 7, fib: 10 } }, { id: "f2", m: "mi", n: "Hähnchenbrust", g: 200, src: "x", per: { k: 110, p: 23, c: 0, f: 1.5, fib: 0 } }] } };
      const { ctx, page } = await open(st, { light: true });
      const num = s => +String(s).replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "");
      // Heute: Ringe statt Textzeilen
      const h = await tp(page, () => { const T = window.__tp, c = document.getElementById("homeTag"), q = s => c.querySelector(s), tt = T.dayTotals(T.dkey());
        const vis = [...c.querySelectorAll(".rb")].map(x => x.textContent).join(" "), srT = c.querySelector(".sr-only"), cs = getComputedStyle(srT);
        return { card: c.classList.contains("rings"), kp: +q("[data-r=kcal] .rg").dataset.p, kb: q("[data-r=kcal] b").textContent, kc: q("[data-r=kcal] small").textContent,
          pp: +q("[data-r=prot] .rg").dataset.p, pc: q("[data-r=prot] small").textContent, pb: q("[data-r=prot] b").textContent, k: tt.k, p: tt.p,
          sr: srT.textContent, hidden: parseFloat(cs.width) <= 1 && cs.position === "absolute", visLen: vis.length }; });
      const rest = num(h.kb), goalP = num(h.pc);
      ok("Heute: Karte mit Ringen für Kalorien und Eiweiß statt zwei Textzeilen", h.card && h.kc === "kcal übrig" && /von \d+ g Eiweiß/.test(h.pc) && num(h.pb) === Math.round(h.p), JSON.stringify(h));
      ok("Ringe zeigen den richtigen Anteil (gegessen ÷ Tagesziel, Eiweiß ÷ Ziel)", Math.abs(h.kp - Math.round(h.k / (h.k + rest) * 100)) <= 1 && h.pp === Math.round(Math.min(1, h.p / goalP) * 100), `${h.kp} / ${h.pp}`);
      ok("Der frühere Satz bleibt als Vorlesetext, ist aber nicht sichtbar", /Noch ≈ [\d.]+ kcal bis zum Tagesziel/.test(h.sr) && h.hidden, h.sr);
      const b = await tp(page, () => { const w = document.getElementById("homeWeekSec"), m = w.textContent.match(/(\d+) von (\d+)/);
        return { ring: +w.querySelector(".rg").dataset.p, exp: Math.round(Math.min(1, m[1] / m[2]) * 100), on: document.querySelectorAll("#buddySched .mw i.on").length, sched: document.getElementById("buddySched").textContent,
          chips: [...document.querySelectorAll("#buddy .fchip")].every(c => c.querySelector("svg, .mw")), streak: !!document.querySelector("#streak .sym"), food: !!document.querySelector("#homeFood .ico") }; });
      ok("Wochenziel als Ring; Termine als sieben Punkte (3 gefüllt) mit Uhrzeit", b.ring === b.exp && b.on === 3 && b.sched.includes("Termine: Mo, Mi, Fr · 18:00"), JSON.stringify(b));
      ok("Fakten als Chips mit Symbol, Zeilen mit Symbolkachel", b.chips && b.food, JSON.stringify(b));
      // Hinweis auf „Heute“: Erklärtext eingeklappt, Titel antippen klappt auf; auf der Hinweise-Seite offen
      const c0 = await page.$eval("#coach .insd", d => d.open); await page.click("#coach .insd summary"); const c1 = await page.$eval("#coach .insd", d => d.open);
      await page.click("#coach [data-a=openCoach]").catch(() => {});
      const c2 = await page.$$eval("#coachTips .insd, #coachGood .insd", d => d.length > 0 && d.every(x => x.open));
      ok("Hinweis auf „Heute“ zeigt nur den Titel, Antippen klappt die Erklärung auf; Hinweise-Seite zeigt sie offen", c0 === false && c1 === true && c2, [c0, c1, c2].join());
      // Training: Gerätebilder, Mini-Woche, Muskelbalken
      await page.click("nav.tabs [data-v=plan]");
      const pl = await tp(page, () => { const T = window.__tp, rows = [...document.querySelectorAll(".day-row")], c = T.planCheck(), ms = T.muscleSets(T.state.plan, c.per);
        const f = v => String(Math.round(v * 2) / 2).replace(".", ",");
        return { tb: rows.map(r => r.querySelectorAll(".tstrip .tb svg").length), more: rows.map(r => (r.querySelector(".tmore") || {}).textContent || ""), names: rows[0].querySelector(".sr-only").textContent,
          empty: rows[2].textContent.includes("Noch keine Übungen"), on: document.querySelectorAll("#schedRow .mw i.on").length, sched: document.getElementById("schedRow").textContent,
          bars: [...document.querySelectorAll("#planBars .mrow")].map(r => r.dataset.m + "=" + r.querySelector(".num").textContent).join(), exp: T.MAJOR.map(m => m + "=" + f(ms[m] || 0)).join(),
          low: document.getElementById("lowNote") ? document.getElementById("lowNote").open : null }; });
      ok("Trainingstage: bis zu 5 Gerätebilder, der Rest als „+2“; Namen als Vorlesetext; leerer Tag mit Hinweis", pl.tb.join() === "5,1,0" && pl.more[0] === "+2" && pl.names.startsWith("Brustpresse · Rudern") && pl.empty, JSON.stringify(pl));
      ok("Termine-Zeile: sieben Punkte, 3 gefüllt; Tage, Uhrzeit und Plan B als Vorlesetext", pl.on === 3 && pl.sched.includes("Mo, Mi, Fr · 18:00 · Plan B: nächster Tag"), pl.sched);
      ok("Planprüfung: Balken je großer Muskelgruppe mit den Werten aus dem Plan; Begründung eingeklappt", pl.bars === pl.exp && pl.low === false, pl.bars + " ≠ " + pl.exp);
      ok("Training bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); if (!r) console.log("    " + await overflowers(page)); return r; })());
      // Einstellungen: Symbolkacheln, Werte rechts
      await page.click("[data-a=openSettings]");
      const se = await tp(page, () => ({ rows: document.querySelectorAll("#app .group > .li").length, ico: document.querySelectorAll("#app .group > .li > .ico").length,
        undef: [...document.querySelectorAll(".sym")].filter(x => !x.children.length).length, img: document.querySelectorAll("#app img, #app use").length }));
      ok("Einstellungen: jede Zeile mit eigenem Symbol (inline gezeichnet, keine fremden Bilder)", se.rows >= 10 && se.ico === se.rows && se.undef === 0 && se.img === 0, JSON.stringify(se));
      ok("Einstellungen bei 320 px ohne seitliches Scrollen", await noOverflow(page), await overflowers(page));
      await page.setViewportSize({ width: 360, height: 780 });
      // Essen: Kalorienring und 7-Tage-Diagramm
      await page.click("nav.tabs [data-v=food]");
      const fo = await tp(page, () => { const T = window.__tp, t = T.dayTotals(T.dkey()), s = document.getElementById("foodSum"), stats = [...s.querySelectorAll(".kr-side .num")].map(x => x.textContent);
        return { p: +s.querySelector(".kr-ring .rg").dataset.p, k: t.k, stats, bars: document.querySelectorAll("#food7 .d7-b").length, zero: document.querySelectorAll("#food7 .d7-b.zero").length, cur: document.querySelectorAll("#food7 .d7-b.cur:not(.zero)").length,
          goal: !!document.querySelector("#food7 .d7-goal"), label: document.getElementById("food7").getAttribute("aria-label"), all: document.getElementById("app").textContent }; });
      const goalK = num(fo.stats[1]);
      ok("Essen: Kalorienring mit Anteil gegessen ÷ Ziel, daneben „Gegessen“ und „Ziel“", num(fo.stats[0]) === Math.round(fo.k) && fo.p === Math.round(Math.min(1, fo.k / goalK) * 100), JSON.stringify([fo.p, fo.stats]));
      ok("Letzte 7 Tage als Balken mit Ziellinie (6 Tage ohne Eintrag, heute gefüllt); Durchschnitt bleibt als Vorlesetext", fo.bars === 7 && fo.zero === 6 && fo.cur === 1 && fo.goal && /Ziel [\d.]+ kcal/.test(fo.label) && fo.all.includes("an 1 Tag mit Einträgen"), JSON.stringify([fo.bars, fo.zero, fo.cur, fo.label]));
      ok("Essen bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); if (!r) console.log("    " + await overflowers(page)); await page.setViewportSize({ width: 360, height: 780 }); return r; })());
      // Wochenrückblick: Statussymbole
      await page.click("nav.tabs [data-v=history]"); await page.click("#histWeek");
      ok("Wochenrückblick „Auf einen Blick“: jede Zeile mit Statussymbol", await page.$$eval("#weekHints .symlist li", li => li.length > 0 && li.every(x => x.querySelector("svg.sym") && x.querySelector("span").textContent.length > 5)));
      await ctx.close();
    }

    section("86. Grundstruktur: Plan bauen → Start tippen → die App führt durch");
    {
      // Erster Start: Die App sagt, wofür sie da ist, und bietet zwei Wege an
      const { ctx, page } = await open(null, { intro: true });
      const i0 = await tp(page, () => ({ title: document.querySelector("#app h1").textContent, steps: [...document.querySelectorAll("#intro .steps3 li .t")].map(x => x.textContent).join(" → "),
        btns: [...document.querySelectorAll("#intro .actionbar .btn")].map(b => b.textContent.trim() + (b.classList.contains("primary") ? "*" : "")).join(" | "), tabs: document.getElementById("tabs").hidden }));
      ok("Erster Start: drei Schritte „Plan bauen → Start tippen → Dranbleiben“, noch keine Tab-Leiste", i0.title === "Dein Trainingsplan" && i0.steps === "Plan bauen → Start tippen → Dranbleiben" && i0.tabs, JSON.stringify(i0));
      ok("Zwei Wege: „Plan selbst bauen“ (Hauptweg) und „Plan vorschlagen lassen“", i0.btns === "Plan selbst bauen* | Plan vorschlagen lassen", i0.btns);
      ok("Einstieg bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 568 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })());
      await page.click("[data-a=setupForm]");
      ok("„Plan vorschlagen lassen“ zeigt erst jetzt die Fragen; „‹ Zurück“ führt zum Einstieg", await page.isVisible("[data-a=createPlan]") && (await page.textContent("#navbar .nb-back")).trim() === "Zurück" && !(await page.$("[data-a=emptyPlan]")));
      await page.click("#navbar .nb-back");
      ok("Zurück: wieder der Einstieg", await page.isVisible("#intro [data-a=emptyPlan]"));
      // Weg 1: selbst bauen – Tag, Geräte wählen, Start
      await page.click("[data-a=emptyPlan]");
      const d0 = await tp(page, () => ({ tab: document.querySelector("#tabs button.on").textContent.trim(), title: document.getElementById("dayName").value, add: !!document.querySelector("#app [data-a=openPicker]"), tabsOn: !document.getElementById("tabs").hidden }));
      ok("Selbst bauen: „Tag 1“ im Bereich „Plan“, bereit für Geräte", d0.tab === "Plan" && d0.title === "Tag 1" && d0.add && d0.tabsOn, JSON.stringify(d0));
      await page.click("#app [data-a=openPicker]"); await page.click(".sheet [data-a=pick][data-id=hs-chest]"); await page.click(".sheet [data-a=pick][data-id=hs-row]"); await page.click(".sheet .sh-head [data-a=closeSheet]");
      const d1 = await tp(page, () => ({ n: document.querySelectorAll("#dayItems .li").length, thumbs: document.querySelectorAll("#dayItems .dthumb svg").length, nums: [...document.querySelectorAll("#dayItems .dthumb i")].map(x => x.textContent).join(), start: document.getElementById("dayStart").textContent.trim() }));
      ok("Tag zeigt die gewählten Geräte mit Bild und Reihenfolge, darüber „Tag 1 starten“", d1.n === 2 && d1.thumbs === 2 && d1.nums === "1,2" && d1.start === "Tag 1 starten", JSON.stringify(d1));
      await page.click("#navbar .nb-back");
      const pl = await tp(page, () => { const ids = [...document.querySelectorAll("#app .page > section")].map(s => s.id), row = document.querySelector(".day-row");
        return { title: document.querySelector("#app h1").textContent, ids: ids.join(), play: row.querySelector("[data-a=startDayId]").getAttribute("aria-label"), more: [...document.querySelectorAll("#planMore .li")].map(l => l.id || l.dataset.a).join(),
          open: document.getElementById("planCheckBox").open, status: document.getElementById("planStatus").textContent }; });
      ok("„Mein Plan“ in fester Reihenfolge: Trainingstage → Rund um den Plan → Planprüfung", pl.title === "Mein Plan" && pl.ids === "planDays,planMore,planCheck", pl.ids);
      ok("„Rund um den Plan“: Termine und Geräte als Zeilen in einer Liste", pl.more.startsWith("schedRow,devsRow"), pl.more);
      ok("Planprüfung als eine Karte mit Status; bei fehlenden Muskelgruppen aufgeklappt", pl.open === true && /Punkte? zu prüfen/.test(pl.status), JSON.stringify([pl.open, pl.status]));
      ok("Jeder Trainingstag hat ▶ zum direkten Start", pl.play === "Tag 1 starten");
      await page.click(".day-row [data-a=startDayId]");
      const s1 = await tp(page, () => { const s = window.__tp.state.session; return { on: !!s, day: s && s.dayName, ex: s && s.list.map(l => l.exId).join(), train: document.body.classList.contains("training"), done: !!document.querySelector("[data-a=doneSet]") }; });
      ok("▶ startet das Training dieses Tages: die App führt durch die gewählten Geräte", s1.on && s1.day === "Tag 1" && s1.ex === "hs-chest,hs-row" && s1.train && s1.done, JSON.stringify(s1));
      await page.click("[data-a=askStop]"); await page.click(".sheet [data-a=pauseT]");
      await page.click("nav.tabs [data-v=plan]");
      ok("Läuft schon ein Training, steht in der Tagesliste kein zweites ▶", !(await page.$(".day-row [data-a=startDayId]")) && !!(await page.$(".day-row .chev")));
      await ctx.close();
    }
    {
      // Weg 2: vorschlagen lassen; Planprüfung ohne echte Punkte ist zugeklappt
      const { ctx, page } = await open(null, { intro: true });
      await page.click("[data-a=setupForm]"); await page.click("[data-a=createPlan]"); await page.keyboard.press("Escape");
      const st = await stored(page);
      ok("Vorschlag: Plan mit 3 Trainingstagen und Terminen", !!st.plan && st.plan.days.length === 3 && !!st.sched);
      await page.click("nav.tabs [data-v=plan]");
      const pc = await tp(page, () => ({ open: document.getElementById("planCheckBox").open, status: document.getElementById("planStatus").textContent, rows: document.querySelectorAll(".day-row [data-a=startDayId]").length }));
      ok("Planprüfung ohne echte Punkte: zugeklappt, Status in einer Zeile; 3 Tage mit ▶", pc.open === false && pc.status.length > 5 && pc.rows === 3, JSON.stringify(pc));
      ok("„Mein Plan“ bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); if (!r) console.log("    " + await overflowers(page)); await page.setViewportSize({ width: 360, height: 780 }); return r; })());
      await ctx.close();
    }
    {
      // Heute: feste Reihenfolge, Wochenkopf führt zum Rückblick, Hinweis kompakt
      const hi = [hist("hs-chest", [{ kg: 40, reps: 10 }], 9, "s"), hist("hs-chest", [{ kg: 42.5, reps: 10 }], 2, "s")];
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: hi, hints: { units: true } });
      const h = await tp(page, () => { const kids = [...document.querySelectorAll("#app .page > *")].map(e => e.id || e.className.split(" ")[0]);
        const ins = document.querySelector("#coach .insd"); return { kids: kids.join(), week: document.getElementById("homeWeek").tagName + ":" + document.getElementById("homeWeek").textContent.trim(), day: document.querySelector("#homeDay h2").textContent,
          insOpen: ins ? ins.open : null, hideVisible: ins ? !!(ins.querySelector("[data-a=coachHide]") && ins.querySelector("[data-a=coachHide]").getClientRects().length) : null }; });
      const order = h.kids.split(",").filter(k => ["hero", "coach", "section", "homeDay"].includes(k)).join();
      ok("„Heute“ in fester Reihenfolge: Training → Hinweis → Diese Woche → Mein Tag", /^hero,(coach,)?section,homeDay$/.test(order), h.kids);
      ok("Die Überschrift „Diese Woche ›“ führt zum Wochenrückblick (keine eigene Zeile mehr)", h.week === "BUTTON:Diese Woche›" && !(await page.$("#app .group #homeWeek")), h.week);
      const hideVis = await page.isVisible("#coach .insd [data-a=coachHide]").catch(() => false);
      ok("Hinweis kompakt: Erklärung und „Ausblenden“ erst nach Antippen", h.insOpen === null || (h.insOpen === false && hideVis === false), JSON.stringify([h.insOpen, hideVis]));
      await page.click("#homeWeek");
      ok("Antippen öffnet den Wochenrückblick", (await page.textContent("#app h1")) === "Diese Woche" && await page.isVisible("#weekHints"));
      await ctx.close();
    }

    section("87. Gleiche Regeln in allen Bereichen; Plan bauen");
    {
      const P = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Oberkörper", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Beine", items: [{ id: "b1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "c", name: "Rücken", items: [{ id: "c1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan: P, history: [Object.assign(hist("hs-chest", [{ kg: 40, reps: 10 }], 6, "s"), { dayId: "a", day: "Oberkörper" })] });
      const next0 = await page.textContent(".hero-name");
      // Titel = Bereich, Einstellungen von jedem Bereich aus, zurück zur Herkunft
      const res = [];
      for (const [v, title, back] of [["home", "Heute", "Heute"], ["plan", "Mein Plan", "Plan"], ["lib", "Wissen", "Wissen"], ["food", "Essen", "Essen"], ["history", "Fortschritt", "Fortschritt"]]) {
        await page.click(`nav.tabs [data-v=${v}]`);
        const t1 = await page.textContent("#app h1"), gear = await page.$$eval("#navbar .nb-r [data-a=openSettings]", b => b.length);
        await page.click("#navbar [data-a=openSettings]");
        const b1 = (await page.textContent("#navbar .nb-back")).trim(), on = await page.$eval("#tabs button.on", b => b.dataset.v);
        await page.click("#navbar .nb-back");
        const t2 = await page.textContent("#app h1");
        res.push(`${v}:${t1 === title && gear === 1 && b1 === back && on === v && t2 === title ? "ok" : [t1, gear, b1, on, t2].join("/")}`);
      }
      ok("Jeder Bereich: Titel = Bereich, Zahnrad oben rechts, Einstellungen führen zurück zum Bereich", res.every(r => r.endsWith(":ok")), res.join(" "));
      await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]");
      ok("Artikel: derselbe Titel „Wissen“, Umschalter „Geräte | Artikel“", (await page.textContent("#app h1")) === "Wissen" && (await page.textContent("#wissenSeg")).replace(/\s+/g, "") === "GeräteArtikel");
      // Geräteliste filtert wie die Geräteauswahl: Muskel-Chips mit Anzahl
      await page.click("#wissenSeg [data-v=lib]");
      const m0 = await tp(page, () => ({ all: document.querySelector("#libMuscle [data-k=alle] .n").textContent, brust: document.querySelector("#libMuscle [data-k=brust] .n").textContent, rows: document.querySelectorAll("#libList [data-a=openEx]").length }));
      await page.click("#libMuscle [data-k=brust]");
      const m1 = await tp(page, () => ({ rows: document.querySelectorAll("#libList [data-a=openEx]").length, heads: [...document.querySelectorAll("#libList h2")].map(h => h.textContent).join(), on: document.querySelector("#libMuscle [data-k=brust]").getAttribute("aria-pressed") }));
      ok("Wissen → Geräte: Muskel-Chips mit Anzahl wie in der Geräteauswahl; „Brust“ zeigt nur Brustgeräte", +m0.all === m0.rows && m1.rows === +m0.brust && m1.heads === "Brust" && m1.on === "true", JSON.stringify([m0, m1]));
      await page.click("#libBrand [data-k=lf]");
      const m2 = await tp(page, () => ({ rows: document.querySelectorAll("#libList [data-a=openEx]").length, n: document.querySelector("#libMuscle [data-k=brust] .n").textContent }));
      ok("Marke und Muskel wirken zusammen, die Anzahl stimmt", m2.rows === +m2.n && m2.rows > 0 && m2.rows < m1.rows, JSON.stringify(m2));
      await page.click("#libMuscle [data-k=alle]"); await page.click("#libBrand [data-k=alle]");
      // Hinweise: Regeln aufklappbar statt Textwand
      await page.click("#wissenSeg [data-v=wissen]"); await page.click("#wissenCoach");
      const ru = await tp(page, () => { const d = [...document.querySelectorAll("#ruleList details")]; return { n: d.length, open: d.filter(x => x.open).length, txt: document.getElementById("coachRules").textContent.includes("72 Stunden") }; });
      await page.click("#ruleList details summary");
      ok("„So entscheidet die App“: Regeln als aufklappbare Liste, Inhalt bleibt vollständig", ru.n >= 8 && ru.open === 0 && ru.txt && await page.$eval("#ruleList details", d => d.open), JSON.stringify(ru));
      // Plan bauen: Tag umbenennen sichtbar, Trainingstage ordnen
      await page.click("nav.tabs [data-v=plan]"); await page.click("[data-a=editDay][data-id=a]");
      await page.click("[data-a=dayRename]");
      const foc = await page.evaluate(() => document.activeElement && document.activeElement.id);
      await page.keyboard.type("Brust und Arme");
      ok("Tagesseite: Stift neben dem Namen setzt den Cursor ins Namensfeld und markiert den Namen; Eintippen benennt um", foc === "dayName" && (await stored(page)).plan.days[0].name === "Brust und Arme");
      await page.click("#navbar .nb-back");
      ok("Mein Plan: „Ordnen“ bei mehr als einem Tag", await page.isVisible("#dayOrder"));
      await page.click("#dayOrder");
      const o0 = await page.$$eval("#dayOrderList .li .t", e => e.map(x => x.textContent).join());
      await page.click("#dayOrderList [data-a=dayMove][data-i2='2'][data-d='-1']");
      const o1 = await tp(page, () => ({ sheet: [...document.querySelectorAll("#dayOrderList .li .t")].map(x => x.textContent).join(), plan: [...document.querySelectorAll(".day-row .t")].map(x => x.textContent).join(),
        up0: document.querySelector("#dayOrderList [data-i2='0'][data-d='-1']").disabled, down2: document.querySelector("#dayOrderList [data-i2='2'][data-d='1']").disabled, foot: document.querySelector(".sheet .foot").textContent }));
      const st = await stored(page);
      ok("Ordnen: Rücken eins nach oben → Brust und Arme, Rücken, Beine; Liste dahinter und Speicher folgen", o0 === "Brust und Arme,Beine,Rücken" && o1.sheet === "Brust und Arme,Rücken,Beine" && o1.plan === o1.sheet && st.plan.days.map(d => d.id).join() === "a,c,b" && o1.up0 && o1.down2, JSON.stringify(o1));
      ok("Erklärt, wofür die Reihenfolge gilt, mit Kennzeichnung „Regel der App“", o1.foot.includes("nächste Tag in dieser Liste") && o1.foot.includes("Regel der App"));
      await page.click(".sheet .sh-head [data-a=closeSheet]"); await page.click("nav.tabs [data-v=home]");
      ok("Die Reihenfolge wirkt: Nach dem zuletzt trainierten Tag war „Beine“ dran, jetzt „Rücken“", next0 === "Beine" && (await page.textContent(".hero-name")) === "Rücken", next0 + " → " + await page.textContent(".hero-name"));
      ok("Ordnen-Sheet und Tagesseite bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 640 }); await page.click("nav.tabs [data-v=plan]"); await page.click("#dayOrder"); const a = await noOverflow(page);
        await page.click(".sheet .sh-head [data-a=closeSheet]"); await page.click("[data-a=editDay][data-id=a]"); const b = await noOverflow(page); return a && b; })());
      await ctx.close();
    }
    {
      // Nur ein Trainingstag: kein „Ordnen“
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("nav.tabs [data-v=plan]");
      ok("Ein Trainingstag: kein „Ordnen“", !(await page.$("#dayOrder")));
      await ctx.close();
    }

    section("88. Neuer Trainingstag (leer oder Vorschlag); Datum am Ort des Nutzers");
    {
      const P = { goal: "kraft", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Beine", items: [{ id: "a1", exId: "hs-legpress", sets: 3, rmin: 4, rmax: 6, rest: 180 }] }] };
      const { ctx, page } = await open({ plan: P, dev: { "hs-hack": { off: true } } });
      await page.click("nav.tabs [data-v=plan]"); await page.click("#addDayRow");
      const sh = await tp(page, () => ({ title: document.querySelector(".sheet h2").textContent, cancel: (document.querySelector(".sheet .sh-l") || {}).textContent, empty: document.querySelector("#addEmpty .t").textContent,
        tpl: [...document.querySelectorAll("#addTpl .li .t")].map(x => x.textContent).join(), thumbs: [...document.querySelectorAll("#addTpl .li")].every(l => l.querySelector(".tstrip svg") && l.querySelector(".sr-only").textContent.length > 5),
        foot: document.querySelector(".sheet .foot").textContent }));
      ok("„Trainingstag hinzufügen“: Fenster mit „Leerer Tag“ und sechs Vorschlägen mit Gerätebildern", sh.title === "Neuer Trainingstag" && sh.cancel === "Abbrechen" && sh.empty === "Leerer Tag" && sh.tpl === "Drücken,Ziehen,Beine,Oberkörper,Unterkörper,Ganzkörper" && sh.thumbs, JSON.stringify(sh));
      ok("Erklärt die Herkunft: Geräte aus dem Studio, Startwerte der App für das Ziel", sh.foot.includes("aus deinem Studio") && sh.foot.includes("Startwerte der App") && sh.foot.includes("Kraft"));
      ok("Fenster bei 320 px ohne seitliches Scrollen", await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })());
      await page.click("#addTpl [data-a=addDayTpl][data-k='2']");
      const st = await stored(page), nd = st.plan.days[1];
      const info = await tp(page, () => ({ title: document.getElementById("dayName").value, rows: document.querySelectorAll("#dayItems .li").length, sheet: !!document.querySelector(".sheet") }));
      ok("Vorschlag „Beine“: neuer Tag „Beine 2“ (Name war vergeben), öffnet sich zum Ändern", st.plan.days.length === 2 && nd.name === "Beine 2" && info.title === "Beine 2" && info.rows === nd.items.length && !info.sheet, JSON.stringify(info));
      ok("Nur Geräte aus dem eigenen Studio (Hackenschmidt ist abgewählt), keines doppelt", nd.items.length >= 4 && !nd.items.some(i => i.exId === "hs-hack") && new Set(nd.items.map(i => i.exId)).size === nd.items.length, nd.items.map(i => i.exId).join());
      const iso = await tp(page, ids => ids.map(id => window.__tp.isIso(id)), nd.items.map(i => i.exId));
      ok("Startwerte passen zum Ziel Kraft: Grundübungen 4–6 Wdh., Übungen mit einem Gelenk 8–12", nd.items.every((it, i) => iso[i] ? it.rmin === 8 && it.rmax === 12 : it.rmin === 4 && it.rmax === 6) && nd.items.every(it => it.sets >= 2 && it.sets <= 3), JSON.stringify(nd.items.map((i, k) => [i.exId, iso[k], i.rmin, i.rmax, i.sets])));
      const est = await tp(page, () => window.__tp.estimateSec(window.__tp.state.plan.days[1].items) / 60);
      ok("Der Vorschlag passt ins Zeitbudget (60 Min.)", est <= 60, String(est));
      await page.click("#navbar .nb-back"); await page.click("#addDayRow"); await page.click("#addEmpty");
      const st2 = await stored(page);
      ok("„Leerer Tag“: neuer Tag ohne Geräte, bereit zum Auswählen", st2.plan.days.length === 3 && st2.plan.days[2].items.length === 0 && st2.plan.days[2].name === "Tag 3" && await page.isVisible("#app [data-a=openPicker]"));
      await page.click("#navbar .nb-back"); await page.click("#addDayRow"); await page.click(".sheet .sh-l");
      ok("Abbrechen legt keinen Tag an", (await stored(page)).plan.days.length === 3 && !(await page.$(".sheet")));
      await ctx.close();
    }
    {
      // Körpergewicht: gespeichert wird das Datum am Ort des Nutzers, nicht das UTC-Datum.
      // Zeitzone so gewählt, dass sich beide Daten in diesem Moment sicher unterscheiden (unabhängig von der Uhrzeit des Testlaufs)
      const tz = new Date().getUTCHours() >= 11 ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, timezoneId: tz, serviceWorkers: "block" });
      await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); localStorage.setItem("tp-intro", "0"); localStorage.setItem("tp-tabmem", "0"); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan: PLAN_SMALL })]);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message)); await page.goto(URL);
      const d = await page.evaluate(() => { const n = new Date(), p = x => String(x).padStart(2, "0"); return { local: `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`, utc: n.toISOString().slice(0, 10) }; });
      await page.click("nav.tabs [data-v=history]"); await page.click("#discWeight summary"); await page.fill("#bwIn", "81,5"); await page.click("[data-a=addWeight]");
      const w = (await stored(page)).weights;
      ok("Gewicht eintragen speichert unter dem Datum am Ort (hier weicht es vom UTC-Datum ab)", d.local !== d.utc && w.length === 1 && w[0].d === d.local && w[0].kg === 81.5, JSON.stringify([tz, d, w]));
      ok("Die Karte erkennt den Eintrag von heute", (await page.getAttribute("#bwIn", "placeholder")).includes("Heute: 81,5"), await page.getAttribute("#bwIn", "placeholder"));
      await ctx.close();
    }


    // ===================== Erweiterungen: je Erweiterung ein eigener Abschnitt zwischen ihren Marken =====================
    // @ext:hilfe:test:start
    section("E-hilfe. Hilfe (Einstellungen → Hilfe)");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("nav.tabs [data-v=food]"); await page.click("#navbar [data-a=openSettings]");
      ok("Einstellungen: Abschnitt „App“ mit der Zeile „Hilfe“", (await page.textContent("#setApp")).includes("Hilfe") && await page.isVisible("#row-hilfe .ico"));
      await page.click("#row-hilfe");
      const h = await tp(page, () => ({ title: document.querySelector("#app h1").textContent, back: document.querySelector("#navbar .nb-back").textContent.trim(), tab: document.querySelector("#tabs button.on").dataset.v,
        steps: document.querySelectorAll("#app .steps3 li").length, n: document.querySelectorAll("#hilfeList details").length, open: document.querySelectorAll("#hilfeList details[open]").length, exp: window.__tp.HILFE.length }));
      ok("Hilfe: eigene Unterseite mit „‹ Einstellungen“, drei Schritten und allen Fragen (zugeklappt); der Bereich bleibt „Essen“", h.title === "Hilfe" && h.back === "Einstellungen" && h.tab === "food" && h.steps === 3 && h.n === h.exp && h.n >= 6 && h.open === 0, JSON.stringify(h));
      await page.click("#hilfeList details summary");
      ok("Frage antippen zeigt die Antwort", await page.$eval("#hilfeList details", d => d.open && d.querySelector("p").textContent.length > 20));
      await page.$$eval("#hilfeList details", d => d.forEach(x => x.open = true));
      ok("Hilfe: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", (await freeTextOn(page)).length === 0 && await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })(), (await freeTextOn(page)).join(" | "));
      await page.click("#navbar .nb-back");
      ok("Zurück führt zu den Einstellungen", (await page.textContent("#app h1")) === "Einstellungen");
      await ctx.close();
    }
    {
      // Speicher der Erweiterungen: unbekannte Bereiche fallen weg, die Sicherung enthält state.x
      const { ctx, page } = await open({ plan: PLAN_SMALL, x: { gibtesnicht: { a: 1 }, __proto__: { b: 2 } } });
      const x = await tp(page, () => ({ keys: Object.keys(window.__tp.state.x).join(), known: Object.keys(window.__tp.EXT.clean).join(), clean: typeof window.__tp.extClean }));
      ok("Erweiterungs-Speicher: nur bekannte Bereiche bleiben erhalten", !x.keys.includes("gibtesnicht") && x.keys === x.known && x.clean === "function", JSON.stringify(x));
      await ctx.close();
    }
    // @ext:hilfe:test:end
    // ── Abstand hilfe/test 1 ──
    // ── Abstand hilfe/test 2 ──
    // ── Abstand hilfe/test 3 ──
    // @ext:meilensteine:test:start
    section("E-meilensteine. Meilensteine (Fortschritt → Meilensteine)");
    {
      // Hilfen für diesen Abschnitt. Daten als Ortszeit 12 Uhr: Kalendertag und Woche stimmen in jeder Zeitzone des Testrechners
      const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
      const tr = (date, exs, sec = 60, id) => ({ id: id || "ms" + Math.random(), dayId: "d1", day: "Test", date, durationSec: sec, exercises: exs.map(([exId, u, sets]) => ({ exId, name: exId, u, sets })) });
      const S = (kg, reps, n = 1) => Array.from({ length: n }, () => ({ kg, reps }));
      const de = iso => { const d = new Date(iso), p = x => String(x).padStart(2, "0"); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; };
      // 26 Trainings an 26 Tagen in Folge ab Montag, 6. Januar 2025. Jedes: ein Satz 50 kg × 10 „pro Seite“ = 1.000 kg und genau 1 Stunde.
      // Die ersten vier an je einem anderen Gerät, ab dem fünften immer am selben fünften Gerät.
      const DEV = ["hs-chest", "hs-row", "hs-legpress", "hs-fly"];
      const H26 = Array.from({ length: 26 }, (_, i) => tr(at(2025, 1, 6 + i), [[DEV[i] || "hs-pulldown", "s", S(50, 10)]], 3600, "m" + (i + 1)));
      // k Wochen vor heute, gleicher Wochentag, 12 Uhr: liegt unabhängig von Wochentag und Uhrzeit des Testlaufs in der k-ten Woche vor der laufenden
      const weeksAgo = k => { const d = new Date(); d.setDate(d.getDate() - 7 * k); d.setHours(12, 0, 0, 0); return d.toISOString(); };
      const calc = (page, H, goal) => tp(page, ([h, g]) => { const r = window.__tp.meilensteine.calc(h, g), o = { v: r.v };
        for (const k in r.got) o[k] = r.got[k].map(x => x.n + "@" + x.at).join(" "); return o; }, [H, goal]);
      const marks = (H, list) => list.map(([n, i]) => n + "@" + H[i - 1].date).join(" ");   // Stufe n, erreicht mit dem i-ten Training
      const card = (page, k) => tp(page, key => { const c = document.getElementById("ms-" + key), q = s => (c.querySelector(s) || { textContent: "" }).textContent.replace(/\s+/g, " ").trim();
        return { num: q(".num"), sub: q(".sub"), cnt: q(".ms-cnt"), next: q(".ms-next"), more: q(".ms-more"), bar: c.querySelector(".mfill").style.width, aria: c.querySelector(".mtrack").getAttribute("aria-label"),
          got: [...c.querySelectorAll(".ms-got .badge")].map(b => b.textContent).join(" | ") }; }, k);
      const rowVal = page => page.textContent("#histMore #row-meilensteine .val");
      const newRows = page => tp(page, () => { const s = document.getElementById("msNew"); return s ? s.querySelector("h2").textContent + ": " + [...s.querySelectorAll(".li")].map(l => l.querySelector(".t").textContent + " (" + l.querySelector(".s").textContent + ")").join(" | ") : ""; });
      const train = async page => { await page.click("[data-a=start]"); await finishAllSets(page, 40, 10); };   // PLAN_SMALL: 2×40×10 pro Seite + 40×10 + 40×10 = 2.400 kg, 3 Geräte

      {
        // ---- Rechnung (ohne Oberfläche): von Hand nachgerechnete Verläufe ----
        const { ctx, page } = await open({ plan: PLAN_SMALL });
        const r = await calc(page, H26, 1);
        ok("Stufen der App: Trainings 1–500, Wochen in Folge 2–52, Tonnen 10–1.000, Stunden 5–250, Geräte 5–40", await tp(page, () => window.__tp.meilensteine.MS.map(m => m.k + ":" + m.steps.join(",")).join(" ")) ===
          "tr:1,5,10,25,50,100,150,200,300,500 wk:2,4,8,12,26,52 ton:10,25,50,100,250,500,1000 std:5,10,25,50,100,250 ger:5,10,20,30,40");
        ok("26 Trainings: Stufen 1, 5, 10 und 25 erreicht – jede am Tag des Trainings, mit dem sie erreicht wurde (25 = Tag des 25. Trainings)", r.v.tr === 26 && r.tr === marks(H26, [[1, 1], [5, 5], [10, 10], [25, 25]]) && de(H26[24].date) === "30.01.2025", JSON.stringify(r.tr));
        ok("Bewegtes Gewicht: 26 × 50 kg × 10 × 2 Seiten = 26,0 t („pro Seite“ zählt beide Seiten); 10 t mit dem 10., 25 t mit dem 25. Training", r.v.ton === 260 && r.ton === marks(H26, [[10, 10], [25, 25]]), JSON.stringify([r.v.ton, r.ton]));
        ok("Trainingszeit: 26 × 1 Stunde = 26,0 Std.; 5, 10 und 25 Stunden mit dem 5., 10. und 25. Training", r.v.std === 260 && r.std === marks(H26, [[5, 5], [10, 10], [25, 25]]), JSON.stringify([r.v.std, r.std]));
        ok("Geräte: 5 verschiedene, Stufe 5 mit dem 5. Training (dem ersten am fünften Gerät)", r.v.ger === 5 && r.ger === marks(H26, [[5, 5]]), JSON.stringify([r.v.ger, r.ger]));
        ok("Wochen in Folge, Ziel 1: vier Wochen (6. bis 31. Januar) → beste Serie 4; Stufe 2 am Montag der 2. Woche (8. Training), Stufe 4 am Montag der 4. Woche (22. Training)", r.v.wk === 4 && r.wk === marks(H26, [[2, 8], [4, 22]]), JSON.stringify([r.v.wk, r.wk]));
        const r7 = await calc(page, H26, 7), r8 = await calc(page, H26, 8);
        ok("Ziel 7 je Woche: drei volle Wochen, die vierte hat nur 5 Trainings → beste Serie 3, Stufe 2 am Sonntag der 2. Woche (14. Training); Ziel 8: nie erreicht", r7.v.wk === 3 && r7.wk === marks(H26, [[2, 14]]) && r8.v.wk === 0 && r8.wk === "", JSON.stringify([r7.v.wk, r7.wk, r8.v.wk]));
        const rr = await calc(page, H26.slice().reverse(), 1);
        ok("Die Reihenfolge im Speicher spielt keine Rolle: gerechnet wird nach Datum", canon(rr) === canon(r));

        // Tonnen: Gewichtsangabe je Gerät und die Schwelle. 3×60×10×2 Seiten = 3.600; 2×200×8 insgesamt = 3.200 (ungültige Sätze zählen nicht); 4×80×10 am Block = 3.200 → genau 10.000 kg
        const T = last => [tr(at(2025, 3, 3), [["hs-chest", "s", S(60, 10, 3)], ["hs-row", "s", [{ kg: null, reps: 5 }]]]),
          tr(at(2025, 3, 5), [["hs-legpress", "t", [...S(200, 8, 2), { kg: null, reps: 8 }, { kg: 100, reps: 0 }]]]),
          tr(at(2025, 3, 7), [["hs-fly", "b", [...S(80, 10, 3), { kg: last, reps: 10 }]]])];
        const t10 = await calc(page, T(80), 1), t99 = await calc(page, T(79), 1);
        ok("3.600 kg (pro Seite, beide Seiten) + 3.200 kg (insgesamt) + 3.200 kg (am Block) = genau 10,0 t → Stufe 10 t mit dem dritten Training", t10.v.ton === 100 && t10.ton === "10@" + T(80)[2].date, JSON.stringify([t10.v.ton, t10.ton]));
        ok("10 kg weniger (9.990 kg) → 9,9 t, die Stufe ist nicht erreicht (abgerundet, nie aufgerundet)", t99.v.ton === 99 && t99.ton === "");
        ok("Ein Gerät ohne gültigen Satz zählt nicht als trainiert: 3 Geräte", t10.v.ger === 3 && t10.v.tr === 3);
        // Stunden: 5 × 3.600 s = genau 5,0 Std.; eine Sekunde weniger → 4,9
        const Z = sec => [1, 2, 3, 4, 5].map(i => tr(at(2025, 4, i), [["hs-chest", "s", S(40, 10)]], i === 5 ? sec : 3600));
        const z5 = await calc(page, Z(3600), 1), z4 = await calc(page, Z(3599), 1);
        ok("5 × 60 Minuten = genau 5,0 Std. → Stufe 5 Std. mit dem fünften Training; 1 Sekunde weniger → 4,9 Std., nicht erreicht", z5.v.std === 50 && z5.std === "5@" + Z(3600)[4].date && z4.v.std === 49 && z4.std === "", JSON.stringify([z5.v.std, z5.std, z4.v.std]));

        // Wochen in Folge mit Ziel 2: Woche 1 (Mo 6.1., Do 9.1.), Woche 2 (13., 16.), Woche 3 nur ein Training (20.), Woche 4 (27., 30.), Woche 5 (3., 5., 7.2.), Woche 6 (10., 13.), Woche 7 (17., 20.)
        const W = [[1, 6], [1, 9], [1, 13], [1, 16], [1, 20], [1, 27], [1, 30], [2, 3], [2, 5], [2, 7], [2, 10], [2, 13], [2, 17], [2, 20]].map(([m, d]) => tr(at(2025, m, d), [["hs-chest", "s", S(40, 10)]]));
        const w2 = await calc(page, W, 2), w3 = await calc(page, W, 3), w1 = await calc(page, W, 1);
        ok("Ziel 2: Serie 2 (Wochen 1–2), Lücke in Woche 3, dann Serie 4 (Wochen 4–7) → beste Serie 4; Stufe 2 am 16. Januar, Stufe 4 am 20. Februar (jeweils das zweite Training der Woche)",
          w2.v.wk === 4 && w2.wk === "2@" + at(2025, 1, 16) + " 4@" + at(2025, 2, 20), JSON.stringify([w2.v.wk, w2.wk]));
        ok("Ziel 3: nur Woche 5 erreicht es → beste Serie 1, keine Stufe; Ziel 1: sieben Wochen in Folge → Stufen 2 (13. Januar) und 4 (27. Januar)", w3.v.wk === 1 && w3.wk === "" && w1.v.wk === 7 && w1.wk === "2@" + at(2025, 1, 13) + " 4@" + at(2025, 1, 27), JSON.stringify([w3.v.wk, w1.v.wk, w1.wk]));
        // Wochengrenze: Sonntag spätabends und Montag kurz nach Mitternacht sind zwei Wochen; Montag bis Sonntag ist eine
        const g1 = await calc(page, [tr(at(2025, 1, 12, 23, 0), [["hs-chest", "s", S(40, 10)]]), tr(at(2025, 1, 13, 0, 30), [["hs-chest", "s", S(40, 10)]])], 1);
        const g2 = await calc(page, [tr(at(2025, 1, 13, 0, 30), [["hs-chest", "s", S(40, 10)]]), tr(at(2025, 1, 19, 23, 0), [["hs-chest", "s", S(40, 10)]])], 1);
        ok("Die Woche beginnt am Montag um 0 Uhr: So. 23:00 + Mo. 0:30 = zwei Wochen in Folge; Mo. 0:30 + So. 23:00 = eine Woche", g1.v.wk === 2 && g1.wk.startsWith("2@") && g2.v.wk === 1 && g2.wk === "", JSON.stringify([g1.v.wk, g2.v.wk]));
        const e = await calc(page, [], 1);
        ok("Leerer Verlauf: alle Reihen bei 0, keine Stufe", canon(e.v) === canon({ tr: 0, wk: 0, ton: 0, std: 0, ger: 0 }) && ["tr", "wk", "ton", "std", "ger"].every(k => e[k] === ""));
        await ctx.close();
      }
      {
        // ---- Zeile in „Fortschritt“ und Unterseite mit den 26 Trainings (PLAN_SMALL hat einen Trainingstag → Wochenziel 1) ----
        const { ctx, page } = await open({ plan: PLAN_SMALL, history: H26 });
        await page.click("nav.tabs [data-v=history]");
        // 4 (Trainings) + 2 (Wochen) + 2 (Tonnen) + 3 (Stunden) + 1 (Geräte) = 12
        ok("Fortschritt: Zeile „Meilensteine“ mit Symbol in der Liste oben, rechts „12 erreicht“", (await page.textContent("#histMore #row-meilensteine .t")) === "Meilensteine" && await page.isVisible("#histMore #row-meilensteine .ico") && (await rowVal(page)) === "12 erreicht", await rowVal(page));
        await page.click("#row-meilensteine");
        const h = await tp(page, () => ({ h1: [...document.querySelectorAll("#app h1")].map(x => x.textContent).join("|"), sub: document.querySelector("#app .head").textContent.replace(/\s+/g, " "), back: document.querySelector("#navbar .nb-back").textContent.trim(),
          tab: document.querySelector("#tabs button.on").dataset.v, cards: [...document.querySelectorAll("#msList .card")].map(c => c.id).join(), foot: document.querySelector("#msList .foot").textContent }));
        ok("Unterseite „Meilensteine“ mit „‹ Fortschritt“, genau einer Überschrift und „12 von 34 Stufen erreicht“; fünf Karten in fester Reihenfolge", h.h1 === "Meilensteine" && h.back === "Fortschritt" && h.tab === "history" && h.sub.includes("12 von 34 Stufen erreicht") && h.cards === "ms-tr,ms-wk,ms-ton,ms-std,ms-ger", JSON.stringify(h));
        ok("Kennzeichnung „Stufen der App“; erklärt, was das Datum einer Stufe ist", h.foot.includes("Stufen der App") && h.foot.includes("Tag des Trainings, mit dem die Stufe erreicht wurde"));
        const c = { tr: await card(page, "tr"), wk: await card(page, "wk"), ton: await card(page, "ton"), std: await card(page, "std"), ger: await card(page, "ger") };
        ok("Trainings: 26, „Noch 24 Trainings bis 50“, Balken 26/50 = 52 %, 4 von 10 Stufen mit Datum (25 am 30.01.2025)", c.tr.num === "26" && c.tr.sub === "Trainings insgesamt" && c.tr.next === "Noch 24 Trainings bis 50" && c.tr.bar === "52%" && c.tr.aria === "26 von 50" && c.tr.cnt === "4 von 10 Stufen"
          && c.tr.got === "1 · 06.01.2025 | 5 · 10.01.2025 | 10 · 15.01.2025 | 25 · 30.01.2025", JSON.stringify(c.tr));
        ok("Bewegtes Gewicht: 26,0 Tonnen, „Noch 24,0 t bis 50 t“, Stufen 10 t (15.01.) und 25 t (30.01.); erklärt die Rechnung", c.ton.num === "26,0" && c.ton.sub === "Tonnen insgesamt" && c.ton.next === "Noch 24,0 t bis 50 t" && c.ton.bar === "52%" && c.ton.cnt === "2 von 7 Stufen"
          && c.ton.got === "10 t · 15.01.2025 | 25 t · 30.01.2025" && c.ton.more.includes("Gewicht × Wiederholungen") && c.ton.more.includes("beide Seiten"), JSON.stringify(c.ton));
        ok("Trainingszeit: 26,0 Stunden, „Noch 24,0 Std. bis 50 Std.“, Stufen 5, 10 und 25 Std.", c.std.num === "26,0" && c.std.sub === "Stunden insgesamt" && c.std.next === "Noch 24,0 Std. bis 50 Std." && c.std.cnt === "3 von 6 Stufen"
          && c.std.got === "5 Std. · 10.01.2025 | 10 Std. · 15.01.2025 | 25 Std. · 30.01.2025", JSON.stringify(c.std));
        ok("Geräte: 5 verschiedene, „Noch 5 Geräte bis 10“, Balken 50 %, Stufe 5 am 10.01.2025", c.ger.num === "5" && c.ger.sub === "verschiedene Geräte trainiert" && c.ger.next === "Noch 5 Geräte bis 10" && c.ger.bar === "50%" && c.ger.cnt === "1 von 5 Stufen" && c.ger.got === "5 · 10.01.2025", JSON.stringify(c.ger));
        ok("Wochen in Folge: aktuell 0 (die Serie ist lange vorbei), beste Serie 4, nächste Stufe 8; Stufen 2 (13.01.) und 4 (27.01.); nennt das Wochenziel und woher es kommt", c.wk.num === "0" && c.wk.sub === "Wochen aktuell · beste Serie: 4" && c.wk.next === "Nächste Stufe: 8 Wochen in Folge" && c.wk.bar === "0%"
          && c.wk.cnt === "2 von 6 Stufen" && c.wk.got === "2 · 13.01.2025 | 4 · 27.01.2025" && c.wk.more.includes("Wochenziel: 1 Training pro Woche") && c.wk.more.includes("Zahl deiner Trainingstage mit Geräten"), JSON.stringify(c.wk));
        ok("Meilensteine: kein Text frei auf dem Seitengrund; bei 320 px ohne seitliches Scrollen", (await freeTextOn(page)).length === 0 && await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })(), (await freeTextOn(page)).join(" | "));
        await page.click("#navbar .nb-back");
        ok("Zurück führt zu „Fortschritt“", (await page.textContent("#app h1")) === "Fortschritt");
        // Zwischenspeicher: Zeile und Unterseite werden mehrfach gezeichnet, gerechnet wird einmal
        await page.click("nav.tabs [data-v=home]"); await page.click("nav.tabs [data-v=history]");
        ok("Die Zeile rechnet nicht bei jedem Zeichnen neu: Fortschritt dreimal und die Unterseite einmal gezeichnet, genau eine Berechnung", (await tp(page, () => window.__tp.meilensteine.runs())) === 1 && (await rowVal(page)) === "12 erreicht", String(await tp(page, () => window.__tp.meilensteine.runs())));
        // Korrektur im Verlauf: Der Satz des 10. Trainings war 50 × 10 pro Seite (1.000 kg). Mit 40 × 10 (800 kg) sind es nach 10 Trainings nur 9,8 t –
        // die Stufe 10 t fällt auf das 11. Training (10,8 t), die Stufe 25 t wird erst mit dem 26. erreicht (25,8 t); insgesamt 25,8 t
        await page.click("#discLog summary"); await page.click("#discLog [data-a=histOpen][data-id=m10]"); await page.click('.sheet [data-a=histSet][data-x="0"][data-i2="0"]');
        await page.fill("#hsKg", "40"); await page.click("[data-a=histSetSave]"); await page.click(".sheet .sh-head [data-a=closeSheet]");
        await page.click("#row-meilensteine");
        const k = await card(page, "ton");
        ok("Ein korrigierter Satz wirkt sofort (Zahl der Trainings unverändert): 25,8 t, Stufe 10 t jetzt am 16.01., Stufe 25 t am 31.01.", k.num === "25,8" && k.next === "Noch 24,2 t bis 50 t" && k.got === "10 t · 16.01.2025 | 25 t · 31.01.2025" && (await tp(page, () => window.__tp.meilensteine.runs())) === 2, JSON.stringify(k));
        // Training löschen: ohne das 26. Training sind es 25 Trainings, 24,8 t (Stufe 25 t fällt weg) und 25 Stunden
        await page.click("#navbar .nb-back"); if (!(await page.evaluate(() => document.getElementById("discLog").open))) await page.click("#discLog summary");
        await page.click("#discLog [data-a=histOpen][data-id=m26]"); await page.click("[data-a=histDel]"); await page.click("[data-a=histDelDo]");
        ok("Training gelöscht: Die Stufe 25 t ist nicht mehr erreicht → „11 erreicht“", (await rowVal(page)) === "11 erreicht", await rowVal(page));
        await page.click("#row-meilensteine");
        const d = { tr: await card(page, "tr"), ton: await card(page, "ton"), std: await card(page, "std") };
        ok("Danach: 25 Trainings („Noch 25 Trainings bis 50“), 24,8 t („Noch 0,2 t bis 25 t“), 25,0 Std.", d.tr.num === "25" && d.tr.next === "Noch 25 Trainings bis 50" && d.tr.cnt === "4 von 10 Stufen" && d.ton.num === "24,8" && d.ton.next === "Noch 0,2 t bis 25 t" && d.ton.cnt === "1 von 7 Stufen"
          && d.std.num === "25,0" && d.std.cnt === "3 von 6 Stufen", JSON.stringify(d));
        await ctx.close();
      }
      {
        // ---- Wochen in Folge, bezogen auf heute: je ein Training vor 9, 8, 7, 6, 5 Wochen (Serie 5), Lücke vor 4 Wochen, dann vor 3, 2, 1 Wochen (Serie 3, läuft noch) ----
        const HW = [9, 8, 7, 6, 5, 3, 2, 1].map(k => tr(weeksAgo(k), [["hs-chest", "s", S(40, 10)]], 1800));
        const { ctx, page } = await open({ plan: PLAN_SMALL, history: HW });
        await page.click("nav.tabs [data-v=history]"); await page.click("#row-meilensteine");
        const w = await card(page, "wk");
        ok("Aktuell 3 Wochen in Folge, beste Serie 5 → Stufen 2 und 4 erreicht (Daten: Trainings vor 8 und vor 6 Wochen), „Noch 5 Wochen bis 8“, Balken 3/8 = 37,5 %", w.num === "3" && w.sub === "Wochen aktuell · beste Serie: 5" && w.next === "Noch 5 Wochen bis 8" && w.bar === "37.5%" && w.cnt === "2 von 6 Stufen"
          && w.got === `2 · ${de(HW[1].date)} | 4 · ${de(HW[3].date)}`, JSON.stringify(w));
        // 8 Trainings (Stufen 1 und 5), 8 × 800 kg = 6,4 t, 8 × 30 Min. = 4,0 Std., 1 Gerät
        const o = { tr: await card(page, "tr"), ton: await card(page, "ton"), std: await card(page, "std"), ger: await card(page, "ger") };
        ok("Dazu: 8 Trainings („Noch 2 Trainings bis 10“), 6,4 t („Noch 3,6 t bis 10 t“), 4,0 Std. („Noch 1,0 Std. bis 5 Std.“), 1 Gerät („Noch 4 Geräte bis 5“)", o.tr.num === "8" && o.tr.next === "Noch 2 Trainings bis 10" && o.ton.num === "6,4" && o.ton.next === "Noch 3,6 t bis 10 t"
          && o.std.num === "4,0" && o.std.next === "Noch 1,0 Std. bis 5 Std." && o.ger.num === "1" && o.ger.sub === "Gerät trainiert" && o.ger.next === "Noch 4 Geräte bis 5" && o.ger.got === "", JSON.stringify(o));
        // Zweiter Trainingstag im Plan → Wochenziel 2: Keine Woche hat zwei Trainings
        await tp(page, () => { const s = window.__tp.state; s.plan.days.push({ id: "d2", name: "Zwei", items: [{ id: "j1", exId: "hs-row", sets: 2, rmin: 8, rmax: 12, rest: 0 }] }); });
        await page.click("#navbar .nb-back"); await page.click("#row-meilensteine");
        const w2 = await card(page, "wk");
        ok("Wochenziel folgt dem Plan: mit zwei Trainingstagen gilt 2 pro Woche → keine Woche erreicht es, Stand 0, „Erste Stufe: 2 Wochen in Folge“", w2.num === "0" && w2.sub === "Wochen aktuell · beste Serie: 0" && w2.next === "Erste Stufe: 2 Wochen in Folge" && w2.got === "" && w2.cnt === "0 von 6 Stufen"
          && w2.more.includes("Wochenziel: 2 Trainings pro Woche"), JSON.stringify(w2));
        await ctx.close();
      }
      {
        // ---- Leerer Zustand; ein kaputter gespeicherter Wert stört nicht (die Erweiterung speichert nichts) ----
        const { ctx, page } = await open({ plan: PLAN_SMALL, x: { meilensteine: "Unsinn" } });
        await page.click("nav.tabs [data-v=history]");
        ok("Ohne Training: Zeile „Meilensteine“ mit „0 erreicht“", (await rowVal(page)) === "0 erreicht");
        await page.click("#row-meilensteine");
        const e = await tp(page, () => ({ sub: document.querySelector("#app .head").textContent.replace(/\s+/g, " "), nums: [...document.querySelectorAll("#msList .num")].map(x => x.textContent).join(" "), next: [...document.querySelectorAll("#msList .ms-next")].map(x => x.textContent).join(" | "),
          bars: [...document.querySelectorAll("#msList .mfill")].map(x => x.style.width).join(), got: document.querySelectorAll("#msList .ms-got").length, x: Object.keys(window.__tp.state.x).includes("meilensteine") }));
        ok("Leerer Zustand: alle Reihen bei 0 mit der ersten Stufe als Ziel, keine Marken, kurzer freundlicher Hinweis", e.sub.includes("Noch kein Training. Dein erstes bringt die erste Stufe.") && e.nums === "0 0 0,0 0,0 0"
          && e.next === "Erste Stufe: 1 Training | Erste Stufe: 2 Wochen in Folge | Erste Stufe: 10 Tonnen | Erste Stufe: 5 Stunden | Erste Stufe: 5 Geräte" && e.bars === "0%,0%,0%,0%,0%" && e.got === 0 && !e.x, JSON.stringify(e));
        ok("Leerer Zustand: kein Text frei auf dem Seitengrund; bei 320 px ohne seitliches Scrollen", (await freeTextOn(page)).length === 0 && await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })(), (await freeTextOn(page)).join(" | "));
        // Das erste Training über die Oberfläche: bringt die Stufe „1 Training“ – und nur sie (2,4 t, 3 Geräte, erste Woche)
        await page.click("nav.tabs [data-v=home]"); await train(page);
        ok("Zusammenfassung nach dem ersten Training: Abschnitt „Neuer Meilenstein“ mit genau einer Zeile „1 Training“", (await newRows(page)) === "Neuer Meilenstein: 1 Training (insgesamt)" && await page.isVisible("#msNew .ico"), await newRows(page));
        ok("Die Zeilen des Abschnitts liegen auf einer Karte (kein freier Text); die Zusammenfassung passt bei 320 px", !(await freeTextOn(page)).some(t => t.includes("1 Training") || t.includes("„insgesamt")) && await tp(page, () => !!document.querySelector("#msNew > .group > .li")) && await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })(), (await freeTextOn(page)).join(" | "));
        await page.click("[data-a=tab][data-v=home]");
        await page.reload(); await page.click("nav.tabs [data-v=history]");
        ok("Nach dem Neuladen: „1 erreicht“ (alles kommt aus dem gespeicherten Verlauf)", (await rowVal(page)) === "1 erreicht", await rowVal(page));
        await page.click("#row-meilensteine");
        const one = await card(page, "tr"), day = de((await stored(page)).history[0].date), ton = await card(page, "ton"), ger = await card(page, "ger");
        ok("Unterseite: 1 Training, „Noch 4 Trainings bis 5“, Marke „1“ mit dem Datum dieses Trainings; 2,4 t; 3 Geräte", one.num === "1" && one.sub === "Training insgesamt" && one.next === "Noch 4 Trainings bis 5" && one.bar === "20%" && one.got === "1 · " + day
          && ton.num === "2,4" && ton.next === "Noch 7,6 t bis 10 t" && ger.num === "3" && ger.next === "Noch 2 Geräte bis 5", JSON.stringify([one, ton, ger]));
        await ctx.close();
      }
      {
        // ---- Zusammenfassung: Abschnitt genau dann, wenn das gerade beendete Training eine Stufe überschreitet ----
        // Vorher je Training 1.000 kg und 1 Minute am selben Gerät, alle im Januar 2025; das neue Training bringt 2.400 kg und zwei weitere Geräte
        const old = n => H26.slice(0, n).map(h => Object.assign({}, h, { durationSec: 60, exercises: [{ exId: "hs-chest", name: "hs-chest", u: "s", sets: S(50, 10) }] }));
        const after = async history => { const { ctx, page } = await open({ plan: PLAN_SMALL, history }); await train(page);
          const r = { rows: await newRows(page), n: (await stored(page)).history.length, calc: await tp(page, () => window.__tp.meilensteine.neu(window.__tp.state.history.at(-1)).map(x => x.m.k + x.n).join()), fit: await noOverflow(page) }; await ctx.close(); return r; };
        const a5 = await after(old(4));
        ok("4 Trainings + 1: das fünfte bringt „5 Trainings“ – genau eine Zeile", a5.n === 5 && a5.rows === "Neuer Meilenstein: 5 Trainings (insgesamt)" && a5.calc === "tr5", JSON.stringify(a5));
        const a6 = await after(old(5));
        ok("5 Trainings + 1: das sechste überschreitet keine Stufe (6 Trainings, 7,4 t) → kein Abschnitt", a6.n === 6 && a6.rows === "" && a6.calc === "", JSON.stringify(a6));
        const a10 = await after(old(9));
        ok("9 Trainings mit 9,0 t + 1: das zehnte bringt „10 Trainings“ und mit 11,4 t auch „10 Tonnen“ → „Neue Meilensteine“ mit zwei Zeilen", a10.n === 10 && a10.rows === "Neue Meilensteine: 10 Trainings (insgesamt) | 10 Tonnen (Gewicht bewegt, insgesamt)" && a10.calc === "tr10,ton10" && a10.fit, JSON.stringify(a10));
        const aw = await after([tr(weeksAgo(1), [["hs-chest", "s", S(50, 10)]])]);
        ok("Ein Training in der letzten Woche + 1 heute (Wochenziel 1): „2 Wochen in Folge“ – 2 Trainings sind keine Stufe", aw.n === 2 && aw.rows === "Neuer Meilenstein: 2 Wochen in Folge (mit erreichtem Wochenziel)" && aw.calc === "wk2", JSON.stringify(aw));
      }
    }
    // @ext:meilensteine:test:end
    // ── Abstand meilensteine/test 1 ──
    // ── Abstand meilensteine/test 2 ──
    // ── Abstand meilensteine/test 3 ──
    // @ext:masse:test:start
    section("E-masse. Körpermaße (Fortschritt → Körpermaße)");
    {
      // Hilfen dieses Abschnitts. Erwartete Datumstexte werden hier unabhängig von der App gebildet.
      const p2 = n => String(n).padStart(2, "0");
      const dAgo = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
      const MONAT = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
      const tagTxt = iso => { const [y, m, d] = iso.split("-").map(Number); return `${d}. ${MONAT[m - 1]}${y === new Date().getFullYear() ? "" : " " + y}`; };
      const zurSeite = async page => { await page.click("nav.tabs [data-v=history]"); await page.click("#row-masse"); };
      // Zeilen der Liste: Name, Unterzeilen (geschützte Leerzeichen wie normale gelesen), Punkte der Verlaufslinie
      const zeilen = page => tp(page, () => Object.fromEntries([...document.querySelectorAll("#masseList .li")].map(li => { const g = s => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim(), pl = li.querySelector("svg.masse-spark polyline");
        return [li.dataset.k, { name: g(li.querySelector(".t").textContent), s: [...li.querySelectorAll(".s")].map(x => g(x.textContent)), svg: !!li.querySelector("svg.masse-spark"), pts: pl ? pl.getAttribute("points") : null, dots: li.querySelectorAll("svg.masse-spark circle").length }]; })));
      const blatt = page => tp(page, () => { const g = s => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim(), q = s => document.querySelector("#sheet-root " + s), ch = q("svg.masse-chart");
        return { open: !!q(".sheet"), as: !!q(".sheet.as"), title: q(".sh-head h2") ? g(q(".sh-head h2").textContent) : null, left: q(".sh-head .sh-l") ? g(q(".sh-head .sh-l").textContent) : null, right: q(".sh-head [data-a=masseSave]") ? g(q(".sh-head [data-a=masseSave]").textContent) : null,
          label: q("label[for=masseIn]") ? g(q("label[for=masseIn]").textContent) : null, ph: q("#masseIn") ? g(q("#masseIn").getAttribute("placeholder")) : null, val: q("#masseIn") ? q("#masseIn").value : null, err: q("#masseErr") ? !q("#masseErr").hidden : null, errTxt: q("#masseErr") ? g(q("#masseErr").textContent) : null,
          big: q("#masseCard .kpi") ? g(q("#masseCard .kpi .num").textContent) + " " + g(q("#masseCard .kpi .sub").textContent) : null, delta: q("#masseDelta") ? g(q("#masseDelta").textContent) : null, today: q("#masseToday") ? g(q("#masseToday").textContent) : null,
          chart: ch ? { pts: ch.querySelector("polyline").getAttribute("points"), labels: [...ch.querySelectorAll("text")].map(t => t.textContent), dots: ch.querySelectorAll("circle").length, aria: g(ch.getAttribute("aria-label")) } : null,
          rows: [...document.querySelectorAll("#masseEntries .li")].map(li => g(li.querySelector(".t").textContent) + " = " + g(li.querySelector(".val").textContent)),
          delMin: Math.min(...[...document.querySelectorAll("#masseEntries [data-a=masseDel]")].map(b => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))),
          delAria: q("#masseEntries [data-a=masseDel]") ? g(q("#masseEntries [data-a=masseDel]").getAttribute("aria-label")) : null, wide: q(".sheet") ? q(".sheet").scrollWidth <= q(".sheet").clientWidth : null,
          asT: q(".as-t") ? g(q(".as-t").textContent) : null, asM: q(".as-m") ? g(q(".as-m").textContent) : null, asB: [...document.querySelectorAll("#sheet-root .as-btn")].map(b => g(b.textContent)).join("|") }; });
      const masse = async page => (await tp(page, () => window.__tp.state.x.masse));

      {
        // Leerer Zustand: Zeile in Fortschritt, Unterseite, leeres Sheet, Zurück
        const { ctx, page } = await open({ plan: PLAN_SMALL });
        await page.click("nav.tabs [data-v=history]");
        const r = await tp(page, () => { const el = document.querySelector("#histMore #row-masse"); return el && { t: el.querySelector(".t").textContent, val: !!el.querySelector(".val"), ico: !!el.querySelector(".ico svg") }; });
        ok("Fortschritt: Zeile „Körpermaße“ mit Symbol in der Liste oben – ohne Wert, solange nichts eingetragen ist", !!r && r.t === "Körpermaße" && !r.val && r.ico, JSON.stringify(r));
        await page.click("#row-masse");
        const s = await tp(page, () => ({ h1: [...document.querySelectorAll("#app h1")].map(h => h.textContent).join("|"), back: document.querySelector("#navbar .nb-back").textContent.trim(), tab: document.querySelector("#tabs button.on").dataset.v,
          empty: document.querySelector("#masseEmpty") ? document.querySelector("#masseEmpty").textContent.trim() : "", emptySym: !!document.querySelector("#masseEmpty svg"), foot: document.querySelector("#app .foot").textContent, limit: !!document.querySelector("#masseLimit"),
          minH: Math.min(...[...document.querySelectorAll("#masseList .li")].map(x => x.getBoundingClientRect().height)), store: JSON.stringify(window.__tp.state.x.masse) }));
        const z = await zeilen(page);
        ok("Unterseite „Körpermaße“ mit „‹ Fortschritt“, der Bereich bleibt Fortschritt; genau eine Überschrift", s.h1 === "Körpermaße" && s.back === "Fortschritt" && s.tab === "history", JSON.stringify(s));
        ok("Leerer Zustand: Karte mit Symbol und Hinweis, darunter die sechs Maße ohne Werte und ohne Linien; Zeilen mindestens 44 px hoch",
          s.empty.startsWith("Noch keine Maße eingetragen.") && s.emptySym && Object.keys(z).join() === "brust,taille,huefte,oberarm,oberschenkel,wade" && Object.values(z).map(x => x.name).join() === "Brust,Taille,Hüfte,Oberarm,Oberschenkel,Wade"
          && Object.values(z).every(x => !x.s.length && !x.svg) && s.minH >= 44 && s.store === '{"e":[]}' && !s.limit, JSON.stringify([s, z]));
        ok("Messhinweis als Beitext, ohne Aussagen über gesunde Werte", s.foot.includes("Immer an derselben Stelle und zur gleichen Tageszeit messen") && !/gesund|Risiko|normal|ideal|sollte/i.test(await page.textContent("#app .page")), s.foot);
        ok("Leerer Zustand: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, (await freeTextOn(page)).join(" | "));
        await page.setViewportSize({ width: 320, height: 640 });
        ok("Leerer Zustand: 320 px ohne seitliches Scrollen", await noOverflow(page), await overflowers(page));
        await page.click("#masse-huefte");
        const b = await blatt(page);
        ok("Maß antippen öffnet das Sheet: Titel „Hüfte“, Feld „Heute in cm“, links „Abbrechen“, rechts „Speichern“; ohne Einträge weder Karte noch Diagramm noch Liste",
          b.open && b.title === "Hüfte" && b.label === "Heute in cm" && b.left === "Abbrechen" && b.right === "Speichern" && b.big === null && b.chart === null && !b.rows.length && b.err === false && b.val === "", JSON.stringify(b));
        ok("Leeres Sheet: 320 px ohne seitliches Scrollen", b.wide && await noOverflow(page), await overflowers(page));
        await page.click("#sheet-root .sh-head .sh-l");
        ok("„Abbrechen“ schließt das Sheet, nichts ist gespeichert", !(await blatt(page)).open && (await masse(page)).e.length === 0);
        await page.setViewportSize({ width: 360, height: 780 });
        await page.click("#navbar .nb-back");
        ok("Zurück führt zu „Fortschritt“", (await page.textContent("#app h1")) === "Fortschritt" && await page.isVisible("#row-masse"));
        await ctx.close();
      }
      {
        // Eintragen über die Oberfläche: Prüfung der Eingabe, Speichern, Neuladen, gleicher Tag ersetzt
        const { ctx, page } = await open({ plan: PLAN_SMALL });
        await zurSeite(page); await page.click("#masse-taille");
        const bad = [];
        for (const v of ["", "abc", "9,9", "250,1", "300", "84,5 cm", "-84", "8 4"]) {
          await page.fill("#masseIn", v); await page.click("[data-a=masseSave]");
          const b = await blatt(page); if (!(b.open && b.err && b.errTxt === "Bitte eine Zahl zwischen 10 und 250 eingeben." && (await masse(page)).e.length === 0)) bad.push(v);
        }
        ok("Ungültige Eingaben (leer, Text, 9,9, 250,1, 300, mit Einheit, negativ) zeigen den Fehlertext, das Sheet bleibt offen, nichts wird gespeichert", bad.length === 0, JSON.stringify(bad));
        ok("Fehlertext ist sichtbar und steht im Sheet", await page.isVisible("#masseErr"));
        await page.fill("#masseIn", "84");
        ok("Beim Weitertippen verschwindet der Fehlertext", (await blatt(page)).err === false);
        await page.fill("#masseIn", "84,5"); await page.click("[data-a=masseSave]");
        const heute = await tp(page, () => window.__tp.dkey());
        let e = (await stored(page)).x.masse.e;
        ok("„84,5“ speichern: ein Eintrag { heute, taille, 84.5 }, das Sheet schließt", canon(e) === canon([{ d: heute, k: "taille", cm: 84.5 }]) && !(await blatt(page)).open, JSON.stringify(e));
        let z = await zeilen(page);
        ok("Liste: Taille zeigt „84,5 cm · <heute>“ ohne Veränderung, als Verlauf nur ein Punkt; die anderen Maße „Noch kein Eintrag“; die Karte für den leeren Zustand ist weg",
          canon(z.taille.s) === canon([`84,5 cm · ${tagTxt(heute)}`]) && z.taille.svg && z.taille.pts === null && z.taille.dots === 1 && ["brust", "huefte", "oberarm", "oberschenkel", "wade"].every(k => canon(z[k].s) === canon(["Noch kein Eintrag"]) && !z[k].svg) && !(await page.$("#masseEmpty")), JSON.stringify(z));
        await page.reload(); await page.click("nav.tabs [data-v=history]");
        ok("Nach dem Neuladen: Fortschritt zeigt „1 Maß“", (await page.textContent("#row-masse .val")).replace(/ /g, " ") === "1 Maß", await page.textContent("#row-masse"));
        await page.click("#row-masse"); z = await zeilen(page);
        ok("Nach dem Neuladen ist der Eintrag noch da", canon(z.taille.s) === canon([`84,5 cm · ${tagTxt(heute)}`]) && canon((await masse(page)).e) === canon([{ d: heute, k: "taille", cm: 84.5 }]), JSON.stringify(z.taille));
        await page.click("#masse-taille");
        let b = await blatt(page);
        ok("Sheet mit einem Eintrag: großer Wert „84,5 cm · <heute>“, Hinweis „Heute schon eingetragen“, noch kein Diagramm und keine Veränderung, ein Eintrag in der Liste",
          b.big === `84,5 cm · ${tagTxt(heute)}` && b.today === "Heute schon eingetragen: 84,5 cm. Ein neuer Wert ersetzt ihn." && b.ph === "Heute: 84,5 cm" && b.chart === null && b.delta === null && canon(b.rows) === canon([`${tagTxt(heute)} = 84,5 cm`]), JSON.stringify(b));
        await page.fill("#masseIn", "83.94"); await page.click("[data-a=masseSave]");
        e = (await stored(page)).x.masse.e;
        ok("Gleicher Tag: der neue Wert ersetzt den alten (weiter genau ein Eintrag); „83.94“ wird auf 83,9 gerundet", canon(e) === canon([{ d: heute, k: "taille", cm: 83.9 }]) && (await zeilen(page)).taille.s[0] === `83,9 cm · ${tagTxt(heute)}`, JSON.stringify(e));
        await page.click("#masse-oberarm"); await page.fill("#masseIn", "36"); await page.click("[data-a=masseSave]");
        await page.click("#masse-brust"); await page.fill("#masseIn", "102,5"); await page.click("[data-a=masseSave]");
        e = (await stored(page)).x.masse.e;
        ok("Andere Maße am selben Tag sind eigene Einträge, gespeichert in der Reihenfolge der Liste (Brust, Taille, Oberarm)", canon(e) === canon([{ d: heute, k: "brust", cm: 102.5 }, { d: heute, k: "taille", cm: 83.9 }, { d: heute, k: "oberarm", cm: 36 }]), JSON.stringify(e));
        await page.click("#navbar .nb-back");
        ok("Fortschritt zählt die Maße mit Einträgen: „3 Maße“", (await page.textContent("#row-masse .val")).replace(/ /g, " ") === "3 Maße", await page.textContent("#row-masse"));
        await ctx.close();
      }
      {
        // Zweiter und dritter Wert an anderen Tagen (vorbefüllt): Veränderung, Verlaufslinie, Diagramm, Löschen mit Rückfrage
        // Von Hand gerechnet: 85,5 − 87 = −1,5; 84,5 − 87 = −2,5; 103,5 − 102 = +1,5; 58 − 58 = 0
        const d40 = dAgo(40), d10 = dAgo(10), d5 = dAgo(5);
        const { ctx, page } = await open({ plan: PLAN_SMALL, x: { masse: { e: [{ d: d40, k: "taille", cm: 87 }, { d: d10, k: "taille", cm: 85.5 }, { d: d40, k: "brust", cm: 102 }, { d: d5, k: "brust", cm: 103.5 },
          { d: d5, k: "wade", cm: 38.2 }, { d: "2020-10-03", k: "oberschenkel", cm: 58 }, { d: d10, k: "oberschenkel", cm: 58 }] } } });
        await page.click("nav.tabs [data-v=history]");
        ok("Fortschritt: Wert „4 Maße“ (Maße mit mindestens einem Eintrag)", (await page.textContent("#row-masse .val")).replace(/ /g, " ") === "4 Maße", await page.textContent("#row-masse"));
        await page.click("#row-masse");
        let z = await zeilen(page);
        ok("Veränderung gegenüber dem ersten Eintrag mit deutschem Komma und Vorzeichen: Brust „+1,5 cm seit …“, Taille „−1,5 cm seit …“",
          canon(z.brust.s) === canon([`103,5 cm · ${tagTxt(d5)}`, `+1,5 cm seit ${tagTxt(d40)}`]) && canon(z.taille.s) === canon([`85,5 cm · ${tagTxt(d10)}`, `−1,5 cm seit ${tagTxt(d40)}`]), JSON.stringify([z.brust, z.taille]));
        ok("Gleicher Wert: „Unverändert seit 3. Oktober 2020“ (Datum aus einem anderen Jahr mit Jahreszahl); ein einzelner Eintrag ohne Veränderung; ohne Eintrag „Noch kein Eintrag“",
          canon(z.oberschenkel.s) === canon([`58 cm · ${tagTxt(d10)}`, "Unverändert seit 3. Oktober 2020"]) && canon(z.wade.s) === canon([`38,2 cm · ${tagTxt(d5)}`]) && canon(z.huefte.s) === canon(["Noch kein Eintrag"]), JSON.stringify([z.oberschenkel, z.wade, z.huefte]));
        // Verlaufslinie 52 × 26: links x = 4, rechts x = 48; größter Wert y = 5, kleinster y = 21
        ok("Verlaufslinie in der Zeile: zwei Einträge = Linie von (4|5) nach (48|21), gleiche Werte = waagerecht in der Mitte, ein Eintrag = nur Punkt, kein Eintrag = nichts",
          z.taille.pts === "4.0,5.0 48.0,21.0" && z.brust.pts === "4.0,21.0 48.0,5.0" && z.oberschenkel.pts === "4.0,13.0 48.0,13.0" && z.wade.pts === null && z.wade.dots === 1 && !z.huefte.svg, JSON.stringify(z));
        ok("Gefüllte Seite: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, (await freeTextOn(page)).join(" | "));
        await page.setViewportSize({ width: 320, height: 640 });
        ok("Gefüllte Seite: 320 px ohne seitliches Scrollen", await noOverflow(page), await overflowers(page));
        await page.setViewportSize({ width: 360, height: 780 });
        await page.click("#masse-taille");
        let b = await blatt(page);
        ok("Sheet „Taille“ mit zwei Einträgen: „85,5 cm · …“, „−1,5 cm seit …“, Diagramm mit zwei Punkten, Platzhalter „Zuletzt: 85,5 cm“, Einträge neueste zuerst",
          b.big === `85,5 cm · ${tagTxt(d10)}` && b.delta === `−1,5 cm seit ${tagTxt(d40)}` && !!b.chart && b.chart.pts === "38.0,12.0 310.0,106.0" && b.ph === "Zuletzt: 85,5 cm" && b.today === null
          && canon(b.rows) === canon([`${tagTxt(d10)} = 85,5 cm`, `${tagTxt(d40)} = 87 cm`]), JSON.stringify(b));
        await page.fill("#masseIn", "84,5"); await page.click("[data-a=masseSave]");
        const heute = await tp(page, () => window.__tp.dkey());
        z = await zeilen(page);
        // 30 von 40 Tagen = 0,75 der Breite: x = 4 + 0,75 · 44 = 37; 85,5 liegt bei (85,5 − 84,5) / 2,5 = 0,4 der Höhe: y = 21 − 0,4 · 16 = 14,6
        ok("Neuer Wert von heute (84,5): Veränderung „−2,5 cm seit …“ (84,5 − 87), Verlaufslinie mit drei Punkten nach Datum und Wert",
          canon(z.taille.s) === canon([`84,5 cm · ${tagTxt(heute)}`, `−2,5 cm seit ${tagTxt(d40)}`]) && z.taille.pts === "4.0,5.0 37.0,14.6 48.0,21.0", JSON.stringify(z.taille));
        ok("Gespeichert sind drei Einträge für die Taille, nach Datum geordnet", canon((await stored(page)).x.masse.e.filter(x => x.k === "taille")) === canon([{ d: d40, k: "taille", cm: 87 }, { d: d10, k: "taille", cm: 85.5 }, { d: heute, k: "taille", cm: 84.5 }]));
        await page.click("#masse-taille");
        b = await blatt(page);
        // Diagramm 320 × 132: x von 38 bis 310 (0,75 · 272 = 204 → 242), y von 106 (kleinster) bis 12 (größter): 106 − 0,4 · 94 = 68,4
        const kurz = iso => { const [y, m, d] = iso.split("-").map(Number); return `${d}.${m}.${y === new Date().getFullYear() ? "" : String(y).slice(-2)}`; };
        ok("Liniendiagramm: Punkte (38|12), (242|68,4), (310|106); Beschriftung größter und kleinster Wert (87 und 84,5), erstes und letztes Datum",
          !!b.chart && b.chart.pts === "38.0,12.0 242.0,68.4 310.0,106.0" && canon(b.chart.labels) === canon(["87", "84,5", kurz(d40), kurz(heute)]) && b.chart.dots === 3
          && b.chart.aria === `Verlauf Taille: 87 cm am ${tagTxt(d40)}, 84,5 cm am ${tagTxt(heute)}`, JSON.stringify(b.chart));
        ok("Löschknöpfe mindestens 44 × 44 px und mit Beschriftung", b.delMin >= 44 && b.delAria === `Eintrag vom ${tagTxt(heute)} löschen`, JSON.stringify([b.delMin, b.delAria]));
        await page.setViewportSize({ width: 320, height: 640 });
        ok("Gefülltes Sheet: 320 px ohne seitliches Scrollen", (await blatt(page)).wide && await noOverflow(page), await overflowers(page));
        await page.setViewportSize({ width: 360, height: 780 });
        // Löschen: erst Rückfrage, „Abbrechen“ ändert nichts
        await page.fill("#masseIn", "90");
        await page.click(`#masseEntries [data-a=masseDel][data-d="${d10}"]`);
        b = await blatt(page);
        ok("Löschen fragt nach: „Eintrag löschen?“ mit Maß, Wert und Datum, „Löschen“ und „Abbrechen“; noch ist nichts gelöscht",
          b.as && b.asT === "Eintrag löschen?" && b.asM === `Taille: 85,5 cm vom ${tagTxt(d10)}.` && b.asB === "Löschen|Abbrechen" && (await masse(page)).e.length === 8, JSON.stringify(b));
        await page.click("#sheet-root .as-cancel");
        b = await blatt(page);
        ok("„Abbrechen“ in der Rückfrage: zurück im Sheet, der Eintrag ist noch da, die begonnene Eingabe „90“ auch", b.open && !b.as && b.title === "Taille" && b.rows.length === 3 && b.val === "90" && (await masse(page)).e.length === 8, JSON.stringify(b));
        await page.click(`#masseEntries [data-a=masseDel][data-d="${d10}"]`); await page.click("#sheet-root [data-a=masseDelDo]");
        b = await blatt(page);
        ok("„Löschen“ entfernt genau diesen Eintrag; das Sheet zeigt die übrigen zwei, Veränderung und Diagramm rechnen neu",
          canon((await stored(page)).x.masse.e.filter(x => x.k === "taille")) === canon([{ d: d40, k: "taille", cm: 87 }, { d: heute, k: "taille", cm: 84.5 }]) && (await masse(page)).e.length === 7
          && b.open && !b.as && canon(b.rows) === canon([`${tagTxt(heute)} = 84,5 cm`, `${tagTxt(d40)} = 87 cm`]) && b.delta === `−2,5 cm seit ${tagTxt(d40)}` && b.chart.pts === "38.0,12.0 310.0,106.0", JSON.stringify(b));
        ok("Die Liste dahinter ist schon aktualisiert", (await zeilen(page)).taille.pts === "4.0,5.0 48.0,21.0");
        await page.click(`#masseEntries [data-a=masseDel][data-d="${d40}"]`); await page.click("#sheet-root [data-a=masseDelDo]");
        b = await blatt(page);
        ok("Bleibt nur ein Eintrag, gibt es keine Veränderung und kein Diagramm mehr", b.rows.length === 1 && b.delta === null && b.chart === null && b.big === `84,5 cm · ${tagTxt(heute)}`, JSON.stringify(b));
        await page.click(`#masseEntries [data-a=masseDel][data-d="${heute}"]`); await page.click("#sheet-root [data-a=masseDelDo]");
        b = await blatt(page);
        ok("Letzten Eintrag gelöscht: Sheet ohne Karte und Liste, die Zeile zeigt „Noch kein Eintrag“", b.open && b.big === null && !b.rows.length && canon((await zeilen(page)).taille.s) === canon(["Noch kein Eintrag"]), JSON.stringify(b));
        await page.click("#sheet-root .sh-head .sh-l");
        await page.reload(); await page.click("nav.tabs [data-v=history]");
        ok("Löschen übersteht das Neuladen: keine Einträge für die Taille, Fortschritt zeigt „3 Maße“", (await masse(page)).e.every(x => x.k !== "taille") && (await masse(page)).e.length === 5 && (await page.textContent("#row-masse .val")).replace(/ /g, " ") === "3 Maße", JSON.stringify(await masse(page)));
        await ctx.close();
      }
      {
        // Kaputter Speicher stürzt nicht ab
        const { ctx, page } = await open({ plan: PLAN_SMALL, x: { masse: "Unsinn" } });
        await zurSeite(page);
        ok("Kaputter Speicher („Unsinn“): die Seite öffnet sich im leeren Zustand", (await page.textContent("#app h1")) === "Körpermaße" && await page.isVisible("#masseEmpty") && canon(await masse(page)) === canon({ e: [] }));
        await page.click("#masse-wade"); await page.fill("#masseIn", "38"); await page.click("[data-a=masseSave]");
        ok("… und Eintragen funktioniert danach", (await stored(page)).x.masse.e.length === 1 && (await stored(page)).x.masse.e[0].cm === 38);
        await ctx.close();
      }
      {
        // Strenge Prüfung des Speichers beim Start: nur gültige Einträge bleiben, sortiert, je Maß und Tag einer (der spätere), eine Nachkommastelle
        const roh = { fremd: 1, e: [{ d: "2026-03-02", k: "taille", cm: 84.56 }, { d: "2026-03-01", k: "wade", cm: 38 }, { d: "2026-03-02", k: "brust", cm: 100, extra: "x" }, { d: "2026-03-02", k: "taille", cm: 83 },
          { d: "2026-03-03", k: "huefte", cm: 95.25 }, { d: "2026-03-02", k: "bauch", cm: 80 }, { d: "2026-02-30", k: "taille", cm: 80 }, { d: "2.3.2026", k: "taille", cm: 80 }, { d: 20260304, k: "taille", cm: 80 },
          { d: "2026-03-04", k: "taille", cm: 9.9 }, { d: "2026-03-04", k: "taille", cm: 250.1 }, { d: "2026-03-04", k: "taille", cm: "84" }, { d: "2026-03-04", k: "taille", cm: null }, { d: "2026-03-04", k: "taille" },
          null, "x", 5, [], { d: "2026-03-05", k: "oberschenkel", cm: 250 }, { d: "2026-03-05", k: "oberarm", cm: 10 }] };
        const soll = [{ d: "2026-03-01", k: "wade", cm: 38 }, { d: "2026-03-02", k: "brust", cm: 100 }, { d: "2026-03-02", k: "taille", cm: 83 }, { d: "2026-03-03", k: "huefte", cm: 95.3 }, { d: "2026-03-05", k: "oberarm", cm: 10 }, { d: "2026-03-05", k: "oberschenkel", cm: 250 }];
        const { ctx, page } = await open({ plan: PLAN_SMALL, x: { masse: roh } });
        ok("Speicher wird beim Start streng geprüft: unbekannte Maße, falsche Daten, Werte außerhalb 10–250 und Fremdes fallen weg; doppelte Tage: der spätere Eintrag zählt; sortiert nach Datum", canon(await masse(page)) === canon({ e: soll }), JSON.stringify(await masse(page)));
        const c = await tp(page, () => { const T = window.__tp.masse, C = x => JSON.stringify(T.clean(x));
          const viele = []; for (let i = 0; i < T.LIMIT + 5; i++) { const d = new Date(2020, 0, 1 + Math.floor(i / 6), 12); viele.push({ d: window.__tp.dkey(d), k: T.MASSE[i % 6][0], cm: 50 + (i % 100) / 10 }); }
          const big = T.clean({ e: viele.slice().reverse() }).e;
          return { leer: [undefined, null, "Unsinn", 7, [], {}, { e: "x" }, { e: [NaN, Infinity] }, { e: [{ d: "2026-03-04", k: "taille", cm: NaN }, { d: "2026-03-04", k: "taille", cm: Infinity }] }].map(C).join(""),
            limit: T.LIMIT, n: big.length, first: big[0], last: big[big.length - 1], sorted: big.every((x, i) => !i || big[i - 1].d <= x.d), keys: T.MASSE.map(m => m[0]).join() }; });
        ok("clean: jeder unbrauchbare Wert ergibt { e: [] }", c.leer === '{"e":[]}'.repeat(9), c.leer);
        ok("clean: höchstens 2000 Einträge – von 2005 fallen die fünf ältesten weg, die neuesten bleiben",
          c.limit === 2000 && c.n === 2000 && canon(c.first) === canon({ d: "2020-01-01", k: "wade", cm: 50.5 }) && canon(c.last) === canon({ d: "2020-11-30", k: "brust", cm: 50.4 }) && c.sorted && c.keys === "brust,taille,huefte,oberarm,oberschenkel,wade", JSON.stringify(c));
        // Eingabe lesen: Komma oder Punkt, kaufmännisch auf eine Nachkommastelle, nur 10–250
        const P = await tp(page, v => v.map(x => window.__tp.masse.parse(x)), ["84,5", "84.5", "84", " 84,5 ", "84,55", "84,54", "84,549", "84,95", "10", "250", "250,0", "249,96", "84,", "084,5",
          "9,99", "250,01", "0", "", "abc", "84,5 cm", "-84", "1e2", "84,5,1", ",5", "1000", null]);
        ok("Eingabe lesen: „84,5“ und „84.5“ = 84,5; „84,55“ → 84,6; „84,54“ → 84,5; „84,95“ → 85; „249,96“ → 250; Grenzen 10 und 250 gelten; alles andere ist ungültig",
          canon(P) === canon([84.5, 84.5, 84, 84.5, 84.6, 84.5, 84.5, 85, 10, 250, 250, 250, 84, 84.5, null, null, null, null, null, null, null, null, null, null, null, null]), JSON.stringify(P));
        // Veränderung und Punkte mit festen Daten (unabhängig vom Tag des Testlaufs)
        const R = await tp(page, () => { const T = window.__tp.masse, g = s => s.replace(/ /g, " "), y = new Date().getFullYear(), E = (d, cm) => ({ d, k: "taille", cm });
          return { a: g(T.change([E("2020-10-03", 87), E("2020-11-14", 84.5)])), b: g(T.change([E(`${y}-01-01`, 35), E(`${y}-01-02`, 36.5)])), c: g(T.change([E("2020-10-03", 58), E("2021-10-03", 58)])), d: T.change([E("2020-10-03", 58)]), e: T.change([]),
            f: g(T.change([E("2020-01-05", 86.8), E("2020-01-06", 85.9)])), h: g(T.change([E("2020-01-05", 80), E("2020-01-06", 99), E("2020-01-07", 81)])), i: g(T.change([E("2020-01-05", 84.1), E("2020-01-06", 84.4)])),
            raw: T.change([E("2020-10-03", 87), E("2020-11-14", 84.5)]), day: g(T.day("2020-02-29")), dayNow: g(T.day(`${y}-03-01`)),
            pts: T.pts([E("2024-01-01", 80), E("2024-01-11", 90), E("2024-01-21", 85)], 0, 100, 50, 10, 80, 90).map(q => q.join(",")).join(" "),
            sommer: T.pts([E("2024-03-01", 80), E("2024-03-11", 90), E("2024-04-10", 85)], 0, 100, 50, 10, 80, 90).map(q => q[0]).join(" ") }; });
        ok("Veränderung: „−2,5 cm seit 3. Oktober 2020“, „+1,5 cm seit 1. Januar“ (laufendes Jahr ohne Jahreszahl), gleich = „Unverändert seit …“, weniger als zwei Einträge = leer",
          R.a === "−2,5 cm seit 3. Oktober 2020" && R.b === "+1,5 cm seit 1. Januar" && R.c === "Unverändert seit 3. Oktober 2020" && R.d === "" && R.e === "", JSON.stringify(R));
        ok("Veränderung: ohne Rundungsreste (85,9 − 86,8 = „−0,9 cm“, 84,4 − 84,1 = „+0,3 cm“); es zählen nur erster und letzter Eintrag (80 … 81 = „+1 cm“)",
          R.f === "−0,9 cm seit 5. Januar 2020" && R.i === "+0,3 cm seit 5. Januar 2020" && R.h === "+1 cm seit 5. Januar 2020", JSON.stringify(R));
        ok("Zahl und Einheit sowie das Datum brechen nicht um (geschützte Leerzeichen); „29. Februar 2020“ und „1. März“", R.raw === "−2,5 cm seit 3. Oktober 2020" && R.day === "29. Februar 2020" && R.dayNow === "1. März", JSON.stringify(R));
        ok("Punkte der Linie: waagerecht nach Tagen (0, 10, 20 Tage → 0, 50, 100), senkrecht nach Wert (80, 90, 85 → 50, 10, 30); Zeitumstellung verschiebt nichts (10 von 40 Tagen → 25)",
          R.pts === "0.0,50.0 50.0,10.0 100.0,30.0" && R.sommer === "0.0 25.0 100.0", JSON.stringify(R));
        await ctx.close();
      }
      {
        // Obergrenze in der Oberfläche: Hinweis kurz vor der Grenze; ist sie erreicht, fällt für einen neuen Eintrag der älteste weg
        const K = ["brust", "taille", "huefte", "oberarm", "oberschenkel", "wade"], e = [];
        for (let i = 0; i < 2000; i++) e.push({ d: dAgo(400 - Math.floor(i / 6)), k: K[i % 6], cm: 60 + (i % 50) / 10 });
        const { ctx, page } = await open({ plan: PLAN_SMALL, x: { masse: { e } } });
        await zurSeite(page);
        const t = (await page.textContent("#masseLimit")).replace(/ /g, " ");
        ok("Kurz vor und an der Obergrenze steht ein Hinweis: „2.000 von höchstens 2.000 Einträgen gespeichert (Regel der App)“", t.startsWith("2.000 von höchstens 2.000 Einträgen gespeichert (Regel der App).") && (await freeTextOn(page)).length === 0, t);
        // Langes Sheet (334 Einträge für die Brust): nach der Rückfrage steht es wieder an derselben Stelle
        await page.click("#masse-brust");
        const top0 = await tp(page, () => { const sh = document.querySelector("#sheet-root .sheet"); sh.scrollTop = sh.scrollHeight; return sh.scrollTop; });
        await page.click(`#masseEntries [data-a=masseDel][data-d="${dAgo(400)}"]`); await page.click("#sheet-root .as-cancel");
        const top1 = await tp(page, () => ({ top: document.querySelector("#sheet-root .sheet").scrollTop, n: document.querySelectorAll("#masseEntries .li").length }));
        ok("Langes Sheet: alle 334 Einträge in der Liste; nach „Abbrechen“ in der Rückfrage steht es wieder an derselben Stelle", top1.n === 334 && top0 > 5000 && Math.abs(top1.top - top0) <= 2, JSON.stringify([top0, top1]));
        await page.click("#sheet-root .sh-head .sh-l");
        await page.click("#masse-wade"); await page.fill("#masseIn", "40"); await page.click("[data-a=masseSave]");
        const heute = await tp(page, () => window.__tp.dkey()), s = (await stored(page)).x.masse.e;
        ok("An der Obergrenze: der neue Eintrag ist gespeichert, es bleiben 2000, der älteste (Brust vor 400 Tagen) ist weggefallen",
          s.length === 2000 && canon(s[s.length - 1]) === canon({ d: heute, k: "wade", cm: 40 }) && canon(s[0]) === canon({ d: dAgo(400), k: "taille", cm: 60.1 }), JSON.stringify([s.length, s[0], s[s.length - 1]]));
        await ctx.close();
      }
      {
        // Datum am Ort des Nutzers, nicht UTC (Zeitzone so gewählt, dass sich beide Daten in diesem Moment sicher unterscheiden)
        const tz = new Date().getUTCHours() >= 11 ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
        const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, timezoneId: tz, serviceWorkers: "block" });
        await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); localStorage.setItem("tp-intro", "0"); localStorage.setItem("tp-tabmem", "0"); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan: PLAN_SMALL })]);
        const page = await ctx.newPage(); page.on("pageerror", err => allErrors.push(err.message)); await page.goto(URL);
        const d = await page.evaluate(() => { const n = new Date(), p = x => String(x).padStart(2, "0"); return { local: `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`, utc: n.toISOString().slice(0, 10) }; });
        await zurSeite(page); await page.click("#masse-brust"); await page.fill("#masseIn", "101"); await page.click("[data-a=masseSave]");
        const s = (await stored(page)).x.masse.e;
        ok("Der Eintrag bekommt das Datum am Ort (hier weicht es vom UTC-Datum ab)", d.local !== d.utc && s.length === 1 && s[0].d === d.local && s[0].cm === 101, JSON.stringify([tz, d, s]));
        await page.click("#masse-brust");
        ok("Das Sheet erkennt den Eintrag von heute", ((await page.getAttribute("#masseIn", "placeholder")) || "").replace(/ /g, " ") === "Heute: 101 cm", await page.getAttribute("#masseIn", "placeholder"));
        await ctx.close();
      }
    }
    // @ext:masse:test:end
    // ── Abstand masse/test 1 ──
    // ── Abstand masse/test 2 ──
    // ── Abstand masse/test 3 ──
    // @ext:rueckblick:test:start
    section("E-rueckblick. Rückblick auf Monat und Jahr (Fortschritt → Monat und Jahr)");
    {
      // Fester Verlauf über einen Jahreswechsel; Zeiten ohne Zeitzone = Uhrzeit am Ort
      const E = (exId, u, sets) => ({ exId, name: exId, u, planned: sets.length, rmin: 8, rmax: 12, sets: sets.map(([kg, reps]) => ({ kg, reps })) });
      const Hh = (id, date, sec, exs) => ({ id, dayId: "d1", day: "Test", date, durationSec: sec, exercises: exs });
      const history = [
        Hh("r1", "2025-11-03T12:00:00", 1800, [E("hs-chest", "s", [[40, 10], [40, 10]])]),
        Hh("r2", "2025-11-12T12:00:00", 2400, [E("hs-chest", "s", [[40, 12]]), E("hs-row", "s", [[50, 10]])]),
        Hh("r3", "2025-12-01T12:00:00", 3000, [E("hs-chest", "s", [[45, 8]]), E("hs-row", "s", [[50, 10]])]),
        Hh("r4", "2025-12-15T12:00:00", 3600, [E("hs-chest", "s", [[45, 10]]), E("hs-legpress", "t", [[100, 10]])]),
        Hh("r5", "2025-12-31T23:30:00", 1800, [E("hs-row", "s", [[55, 8]])]),
        Hh("r6", "2026-01-01T00:30:00", 1200, [E("hs-legpress", "t", [[110, 10]])]),
        Hh("r7", "2026-03-10T12:00:00", 1800, [E("hs-chest", "s", [[45, 10]])])];
      const weights = [{ d: "2025-12-02", kg: 84 }, { d: "2025-12-20", kg: 83.2 }, { d: "2026-01-05", kg: 83 }];
      const { ctx, page } = await open({ plan: PLAN_SMALL, history, weights }, { light: true });
      const st = (mode, y, m) => tp(page, ([mode, y, m]) => { const T = window.__tp, s = T.rbStats(T.state.history, T.state.weights, mode, y, m, new Date(2026, 5, 15));
        return { n: s.n, sec: s.sec, vol: s.vol, pw: s.perWeek, wd: s.wd.join(""), mon: s.mon.join(""), recs: s.recs.map(r => `${r.exId}:${r.from}>${r.to}${r.u}`).join(), top: s.top.map(t => `${t.exId}:${t.n}`).join(), w: s.weight ? `${s.weight.from}>${s.weight.to}:${s.weight.diff}` : "" }; }, [mode, y, m]);
      const dez = await st("m", 2025, 11), nov = await st("m", 2025, 10), jan = await st("m", 2026, 0), feb = await st("m", 2026, 1), y25 = await st("y", 2025, 0), y26 = await st("y", 2026, 0);
      ok("Dezember 2025: 3 Trainings, 140 Min., 4.500 kg bewegt („pro Seite“ zählt doppelt), 0,7 pro Woche; Silvester 23:30 gehört noch dazu", dez.n === 3 && dez.sec === 8400 && dez.vol === 4500 && dez.pw === .7 && dez.wd === "2010000", JSON.stringify(dez));
      ok("November 2025: 2 Trainings, 70 Min., 3.560 kg, 0,5 pro Woche, Montag und Mittwoch", nov.n === 2 && nov.sec === 4200 && nov.vol === 3560 && nov.pw === .5 && nov.wd === "1010000", JSON.stringify(nov));
      ok("Bestwerte im Dezember: Brustpresse 40 → 45, Rudern 50 → 55; das erste Training an der Beinpresse zählt nicht; im November keine", dez.recs === "hs-chest:40>45s,hs-row:50>55s" && nov.recs === "", JSON.stringify([dez.recs, nov.recs]));
      ok("Am häufigsten im Dezember: Brustpresse 2, Rudern 2, Beinpresse 1", dez.top === "hs-chest:2,hs-row:2,hs-legpress:1", dez.top);
      ok("Januar 2026: Neujahr 0:30 zählt zum Januar; Bestwert Beinpresse 100 → 110; Februar leer", jan.n === 1 && jan.sec === 1200 && jan.vol === 1100 && jan.wd === "0001000" && jan.recs === "hs-legpress:100>110t" && feb.n === 0 && feb.top === "", JSON.stringify([jan, feb]));
      ok("Körpergewicht: Dezember 84 → 83,2 (−0,8); mit nur einem Eintrag im Januar keine Angabe", dez.w === "84>83.2:-0.8" && jan.w === "" && y25.w === "84>83.2:-0.8", JSON.stringify([dez.w, jan.w, y25.w]));
      ok("Jahr 2025: 5 Trainings, 210 Min., 8.060 kg, November 2 und Dezember 3; ohne Vorjahr keine Bestwerte", y25.n === 5 && y25.sec === 12600 && y25.vol === 8060 && y25.mon === "000000000023" && y25.recs === "" && y25.pw === .1, JSON.stringify(y25));
      ok("Laufendes Jahr (Stichtag 15. Juni): 2 Trainings in 166 Tagen = 0,1 pro Woche; Bestwert nur an der Beinpresse", y26.n === 2 && y26.pw === .1 && y26.mon === "101000000000" && y26.recs === "hs-legpress:100>110t", JSON.stringify(y26));
      const fm = await tp(page, () => { const T = window.__tp; return [T.rbDur(8400), T.rbDur(1200), T.rbDur(3600), T.rbVol(4500), T.rbVol(940), T.rbVol(8060)].join("|"); });
      ok("Schreibweise: „2 Std. 20 Min.“, „20 Min.“, „1 Std.“, „4,5 t“, unter einer Tonne „940 kg“, „8,1 t“", fm === "2 Std. 20 Min.|20 Min.|1 Std.|4,5 t|940 kg|8,1 t", fm);
      // Oberfläche
      await page.click("nav.tabs [data-v=history]");
      ok("Fortschritt: Zeile „Monat und Jahr“", (await page.textContent("#histMore")).includes("Monat und Jahr") && await page.isVisible("#row-rueckblick .ico"));
      await page.click("#row-rueckblick");
      const v0 = await tp(page, () => ({ title: document.querySelector("#app h1").textContent, back: document.querySelector("#navbar .nb-back").textContent.trim(), per: document.querySelector("#rbTitle").textContent, next: document.querySelector("#rbNav [data-v='1']").disabled, empty: !!document.querySelector("#rbEmpty") }));
      const nowName = await page.evaluate(() => new Date().toLocaleDateString("de-DE", { month: "long", year: "numeric" }));
      ok("Rückblick öffnet beim laufenden Monat (ohne Training: Hinweis-Karte); weiter in die Zukunft geht es nicht", v0.title === "Rückblick" && v0.back === "Fortschritt" && v0.per === nowName && v0.next && v0.empty, JSON.stringify([v0, nowName]));
      await tp(page, () => window.__tp.rbGo("m", 2025, 11));
      const v1 = await tp(page, () => ({ per: document.querySelector("#rbTitle").textContent, grid: [...document.querySelectorAll("#rbGrid .card")].map(c => c.textContent.replace(/\s+/g, " ").trim()),
        wd: document.querySelector("#rbWd").getAttribute("aria-label"), recs: [...document.querySelectorAll("#rbRecs .li")].map(l => l.textContent.replace(/\s+/g, " ").trim()), top: [...document.querySelectorAll("#rbTop .li")].map(l => l.textContent.replace(/\s+/g, " ").trim()),
        w: document.querySelector("#rbWeight").textContent.replace(/\s+/g, " ").trim(), thumbs: document.querySelectorAll("#rbTop svg").length }));
      ok("Dezember 2025 mit Vergleich zum November: +1 Training, +1 Std. 10 Min., +940 kg, +0,2 pro Woche", v1.per === "Dezember 2025" && v1.grid[0].includes("3") && v1.grid[0].includes("+1 gegenüber November") && v1.grid[1].includes("2 Std. 20 Min.") && v1.grid[1].includes("+1 Std. 10 Min. gegenüber November") && v1.grid[2].includes("4,5 t") && v1.grid[2].includes("+940 kg gegenüber November") && v1.grid[3].includes("0,7") && v1.grid[3].includes("+0,2 gegenüber November"), JSON.stringify(v1.grid));
      ok("Wochentage, Bestwerte („40 → 45 kg pro Seite“), häufigste Geräte mit Bild und Körpergewicht stehen da", v1.wd.startsWith("Montag: 2, Dienstag: 0, Mittwoch: 1") && v1.recs.length === 2 && v1.recs[0].includes("40 → 45 kg pro Seite") && v1.recs[1].includes("50 → 55 kg pro Seite") && v1.top.length === 3 && v1.top[0].includes("2 Trainings") && v1.top[2].includes("1 Training") && v1.thumbs === 3 && v1.w.includes("84 → 83,2 kg") && v1.w.includes("−0,8 kg"), JSON.stringify(v1));
      await page.click("#rbNav [data-v='-1']");
      const v2 = await tp(page, () => ({ per: document.querySelector("#rbTitle").textContent, prev: document.querySelector("#rbNav [data-v='-1']").disabled, cmp: document.querySelector("#rbGrid").textContent.includes("gegenüber"), recs: !!document.querySelector("#rbRecs") }));
      ok("‹ führt zum November 2025: erster Zeitraum, davor geht es nicht weiter; ohne Vormonat kein Vergleich und keine Bestwerte", v2.per === "November 2025" && v2.prev && !v2.cmp && !v2.recs, JSON.stringify(v2));
      await page.click("#rbNav [data-v='1']"); await page.click("#rbNav [data-v='1']");
      const v3 = await tp(page, () => ({ per: document.querySelector("#rbTitle").textContent, grid: document.querySelector("#rbGrid").textContent.replace(/\s+/g, " ") }));
      ok("› › führt über den Jahreswechsel zum Januar 2026: „−2 gegenüber Dezember“", v3.per === "Januar 2026" && v3.grid.includes("−2 gegenüber Dezember") && v3.grid.includes("20 Min."), JSON.stringify(v3));
      await page.click("#rbNav [data-v='1']");
      ok("Februar 2026: Hinweis-Karte statt leerer Diagramme", (await page.textContent("#rbTitle")) === "Februar 2026" && await page.isVisible("#rbEmpty") && !(await page.$("#rbGrid")) && !(await page.$("#rbWd")));
      await page.click("#rbMode [data-v=y]");
      const v4 = await tp(page, () => ({ per: document.querySelector("#rbTitle").textContent, on: document.querySelector("#rbMode [data-v=y]").classList.contains("on"), mon: document.querySelector("#rbMon").getAttribute("aria-label"), bars: document.querySelectorAll("#rbMon > div").length }));
      ok("„Jahr“ zeigt 2026 mit zwölf Monatsbalken (Januar 1, März 1)", v4.per === "2026" && v4.on && v4.bars === 12 && v4.mon.startsWith("Januar: 1, Februar: 0, März: 1"), JSON.stringify(v4));
      await page.click("#rbNav [data-v='-1']");
      const v5 = await tp(page, () => ({ per: document.querySelector("#rbTitle").textContent, prev: document.querySelector("#rbNav [data-v='-1']").disabled, n: document.querySelector("#rbN").textContent, mon: document.querySelector("#rbMon").getAttribute("aria-label") }));
      ok("2025: 5 Trainings, November 2 und Dezember 3; davor gibt es nichts", v5.per === "2025" && v5.prev && v5.n === "5" && v5.mon.endsWith("November: 2, Dezember: 3"), JSON.stringify(v5));
      ok("Rückblick: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, JSON.stringify(await freeTextOn(page)));
      await page.setViewportSize({ width: 320, height: 640 });
      const ov1 = await noOverflow(page) && (await overflowers(page)).length === 0;
      await tp(page, () => window.__tp.rbGo("m", 2025, 11));
      ok("Rückblick bei 320 px ohne seitliches Scrollen (Jahr und Monat)", ov1 && await noOverflow(page) && (await overflowers(page)).length === 0, JSON.stringify(await overflowers(page)));
      await page.click("#navbar .nb-back");
      ok("Zurück führt zu Fortschritt", (await page.textContent("#app h1")) === "Fortschritt");
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("nav.tabs [data-v=history]"); await page.click("#row-rueckblick");
      const e = await tp(page, () => ({ txt: document.querySelector("#rbEmpty").textContent, prev: document.querySelector("#rbNav [data-v='-1']").disabled, next: document.querySelector("#rbNav [data-v='1']").disabled }));
      ok("Ohne Verlauf: freundlicher Hinweis, beide Pfeile gesperrt", e.txt.includes("Nach deinem ersten Training") && e.prev && e.next, JSON.stringify(e));
      await ctx.close();
    }
    // @ext:rueckblick:test:end
    // ── Abstand rueckblick/test 1 ──
    // ── Abstand rueckblick/test 2 ──
    // ── Abstand rueckblick/test 3 ──
    // @ext:werkzeuge:test:start
    section("E-werkzeuge. Rechner (Wissen → Nachschlagen → Rechner)");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL }, { light: true });
      // Rechenkern mit von Hand nachgerechneten Werten
      const c = await tp(page, () => { const T = window.__tp, all = [25, 20, 15, 10, 5, 2.5, 1.25];
        return { a: T.wzPlates(42.5, "s", all), b: T.wzPlates(42.5, "s", [20, 10, 5, 2.5, 1.25]), c: T.wzPlates(40, "t", all), d: T.wzPlates(43, "s", all), e: T.wzPlates(41, "t", [20, 10, 5]),
          m5: T.wzMax(100, 5), m1: T.wzMax(100, 1), m12: T.wzMax(60, 12), m13: T.wzMax(60, 13), m0: T.wzMax(60, 0), mf: T.wzMax(60, 2.5), pct: T.wzPct(100), pct2: T.wzPct(116.5),
          app: Math.round(T.e1rm({ kg: 100, reps: 5 }) * 2) / 2, app1: T.e1rm({ kg: 100, reps: 1 }) }; });
      ok("Scheiben: 42,5 kg pro Seite = 25 + 15 + 2,5; ohne 25er und 15er = 20 + 20 + 2,5", c.a.plates.join() === "25,15,2.5" && c.a.rest === 0 && c.b.plates.join() === "20,20,2.5" && c.b.rest === 0, JSON.stringify([c.a, c.b]));
      ok("Scheiben: 40 kg insgesamt = 20 je Seite", c.c.per === 20 && c.c.plates.join() === "20" && c.c.total === 40, JSON.stringify(c.c));
      ok("Geht nicht auf: 43 kg pro Seite → 42,5 kg möglich, 0,5 kg übrig; 41 kg insgesamt mit 20/10/5 → 40 kg, 0,5 kg je Seite übrig", c.d.done === 42.5 && c.d.rest === .5 && c.d.total === 42.5 && c.e.done === 20 && c.e.rest === .5 && c.e.total === 40, JSON.stringify([c.d, c.e]));
      ok("Höchstgewicht: 100 kg × 5 = 116,5 (100 × 7/6 = 116,67, auf 0,5 kg gerundet) wie in „Kraft & Bestwerte“; 1 Wiederholung = das Gewicht; 60 × 12 = 84", c.m5 === 116.5 && c.app === 116.5 && c.m1 === 100 && c.app1 === 100 && c.m12 === 84, JSON.stringify(c));
      ok("Höchstgewicht nur für 1–12 ganze Wiederholungen", c.m13 === null && c.m0 === null && c.mf === null);
      ok("Prozente von 100 kg: 90/80/70/60/50; von 116,5 kg auf 2,5 kg gerundet: 105/92,5/82,5/70/57,5", c.pct.map(x => x[1]).join() === "90,80,70,60,50" && c.pct2.map(x => x[1]).join() === "105,92.5,82.5,70,57.5", JSON.stringify([c.pct, c.pct2]));
      // Oberfläche
      await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]");
      ok("Wissen → Nachschlagen: Zeile „Rechner“", (await page.textContent("#libMore")).includes("Rechner") && await page.isVisible("#row-werkzeuge .ico"));
      await page.click("#row-werkzeuge");
      const h = await tp(page, () => ({ title: document.querySelector("#app h1").textContent, back: document.querySelector("#navbar .nb-back").textContent.trim(), tab: document.querySelector("#tabs button.on").dataset.v, empty: document.querySelector("#wzPlatesOut").textContent, nan: document.querySelector("#app").textContent.includes("NaN") }));
      ok("Rechner: eigene Unterseite mit „‹ Wissen“, leer mit Hinweis statt Zahlen", h.title === "Rechner" && h.back === "Wissen" && h.tab === "lib" && h.empty.includes("Gewicht eingeben") && !h.nan, JSON.stringify(h));
      await page.fill("#wzKgIn", "42,5");
      const chips = () => page.$$eval("#wzChips .pl", e => e.map(x => x.textContent).join(" "));
      ok("Eingabe mit Komma: Scheiben erscheinen sofort, das Feld behält den Fokus", (await chips()) === "25 15 2,5" && await page.evaluate(() => document.activeElement.id === "wzKgIn"), await chips());
      await page.click("#wzSeite [data-v=t]");
      ok("„Insgesamt“ halbiert: 42,5 kg insgesamt = 21,25 je Seite = 20 + 1,25", (await chips()) === "20 1,25" && await page.$eval("#wzSeite [data-v=t]", b => b.classList.contains("on") && b.getAttribute("aria-pressed") === "true"), await chips());
      await page.fill("#wzKgIn", "43");
      ok("Geht nicht auf: Hinweis mit dem nächsten Gewicht darunter (42,5 kg insgesamt)", (await page.textContent("#wzRest")).includes("0,25 kg pro Seite bleiben übrig") && (await page.textContent("#wzRest")).includes("42,5 kg insgesamt"), await page.textContent("#wzPlatesOut"));
      // dieselbe Rechnung wie die Anzeige im Training
      const same = await tp(page, () => { const T = window.__tp; return [42.5, 61.25, 100, 7.5].every(kg => JSON.stringify(T.wzPlates(kg, "s").plates) === JSON.stringify(T.platesOf(kg, T.state.plates || [25, 20, 15, 10, 5, 2.5, 1.25]).plates)); });
      ok("Scheiben wie im Training (dieselbe Funktion)", same);
      await page.fill("#wzWIn", "100"); await page.fill("#wzRIn", "5");
      ok("Höchstgewicht: „≈ 116,5 kg“; die Prozente nutzen die Schätzung", (await page.textContent("#wzMaxVal")) === "≈ 116,5 kg" && (await page.textContent("#wzPctFrom")).includes("116,5 kg (Schätzung oben)") && (await page.$$eval("#wzPctOut .wz-pct b", e => e.map(x => x.textContent).join())) === "105 kg,92,5 kg,82,5 kg,70 kg,57,5 kg", await page.textContent("#wzPctOut"));
      await page.fill("#wzMaxIn", "100");
      ok("Eigenes Höchstgewicht hat Vorrang: 90/80/70/60/50 kg", (await page.textContent("#wzPctFrom")).includes("100 kg (deine Eingabe)") && (await page.$$eval("#wzPctOut .wz-pct b", e => e.map(x => x.textContent).join())) === "90 kg,80 kg,70 kg,60 kg,50 kg");
      await page.fill("#wzRIn", "20"); await page.fill("#wzKgIn", "abc"); await page.fill("#wzMaxIn", "-5");
      const bad = await page.textContent("#app");
      ok("Ungültige Eingaben: Hinweise statt Zahlen, kein NaN", !bad.includes("NaN") && !bad.includes("≈") && bad.includes("1 bis 12") && !(await page.$("#wzChips")) && !(await page.$(".wz-pct")), bad.slice(0, 300));
      await page.fill("#wzKgIn", "42,5"); await page.fill("#wzRIn", "5"); await page.fill("#wzMaxIn", "");
      ok("Rechner: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, JSON.stringify(await freeTextOn(page)));
      await page.setViewportSize({ width: 320, height: 640 });
      ok("Rechner bei 320 px ohne seitliches Scrollen", await noOverflow(page) && (await overflowers(page)).length === 0);
      await page.click("#navbar .nb-back");
      ok("Zurück führt zu Wissen", (await page.textContent("#app h1")) === "Wissen");
      await ctx.close();
    }
    {
      // Scheiben aus den Einstellungen gelten auch im Rechner
      const { ctx, page } = await open({ plan: PLAN_SMALL, plates: [20, 10, 5, 2.5, 1.25] });
      const ld = await tp(page, () => ({ days: window.__tp.state.plan ? window.__tp.state.plan.days.length : 0, plates: (window.__tp.state.plates || []).join() }));
      ok("Gespeicherte Scheibenauswahl: Plan und Auswahl werden beim Start geladen (vorher startete die App dann leer)", ld.days === 1 && ld.plates === "20,10,5,2.5,1.25", JSON.stringify(ld));
      await page.click("#navbar [data-a=openSettings]"); await page.click("[data-a=plateToggle][data-v='1.25']");
      await page.reload(); await page.waitForSelector("#app h1");
      const ld2 = await tp(page, () => ({ days: window.__tp.state.plan ? window.__tp.state.plan.days.length : 0, plates: (window.__tp.state.plates || []).join(), raw: !!JSON.parse(localStorage.getItem("trainingsplan-v2")).plan }));
      ok("Scheibe in den Einstellungen abwählen und neu laden: der Plan ist noch da", ld2.days === 1 && ld2.plates === "20,10,5,2.5" && ld2.raw, JSON.stringify(ld2));
      await page.click("#navbar [data-a=openSettings]"); await page.click("[data-a=plateToggle][data-v='1.25']");
      await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]"); await page.click("#row-werkzeuge");
      await page.fill("#wzKgIn", "42,5");
      ok("Ohne 25er und 15er im Studio: 20 + 20 + 2,5; die Fußzeile nennt die vorhandenen Scheiben", (await page.$$eval("#wzChips .pl", e => e.map(x => x.textContent).join(" "))) === "20 20 2,5" && (await page.textContent("#wzAvail")).includes("20 · 10 · 5 · 2,5 · 1,25 kg"), await page.textContent("#wzAvail"));
      await ctx.close();
    }
    // @ext:werkzeuge:test:end
    // ── Abstand werkzeuge/test 1 ──
    // ── Abstand werkzeuge/test 2 ──
    // ── Abstand werkzeuge/test 3 ──
    // @ext:glossar:test:start
    section("E-glossar. Begriffe (Wissen → Artikel → Nachschlagen → Begriffe)");
    {
      // Inhalt: Anzahl, Eindeutigkeit, Längen, Verweise, Wortwahl, Sortierung, Suche
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const G = await tp(page, () => window.__tp.GLOSSAR);
      const dup = a => a.filter((v, i) => a.indexOf(v) !== i);
      const norm = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
      ok("Begriffe: mindestens 40 Einträge, jeder Schlüssel und jeder Begriff genau einmal", G.length >= 40 && !dup(G.map(x => x.k)).length && !dup(G.map(x => norm(x.t))).length && G.every(x => /^[a-z0-9]+$/.test(x.k) && x.t.trim()),
        `${G.length} · ${dup(G.map(x => x.k)).concat(dup(G.map(x => norm(x.t)))).join()}`);
      const badD = G.filter(x => typeof x.d !== "string" || x.d.trim().length < 20 || x.d.length > 240 || !/\.$/.test(x.d)).map(x => `${x.k}:${String(x.d).length}`);
      ok("Jede Erklärung ist ein ganzer Satz mit höchstens 240 Zeichen; keine zwei Erklärungen sind gleich", !badD.length && !dup(G.map(x => norm(x.d))).length, badD.concat(dup(G.map(x => norm(x.d)))).join(" | "));
      const badA = G.filter(x => typeof x.a !== "string" || x.a.length > 200 || (x.a && !/[.)]$/.test(x.a)) || /^in der app/i.test(x.a)).map(x => `${x.k}:${String(x.a).length}`);
      ok("„In der App“: höchstens 200 Zeichen, kein Satz doppelt; mindestens 30 Begriffe haben einen", !badA.length && !dup(G.map(x => x.a).filter(Boolean)).length && G.filter(x => x.a).length >= 30, `${badA.join()} · ${G.filter(x => x.a).length}`);
      const keys = new Set(G.map(x => x.k));
      const badS = G.filter(x => !Array.isArray(x.s) || x.s.length > 3 || dup(x.s).length || x.s.some(k => !keys.has(k) || k === x.k)).map(x => x.k);
      ok("„Siehe auch“: höchstens drei Verweise, jeder führt zu einem anderen vorhandenen Begriff", !badS.length && G.filter(x => x.s.length).length >= 40, badS.join());
      const BAD = ["garantiert", "beweist", "bewiesen", "am besten", "optimal", "effektiv", "wirksam", "schneller", "stärker", "mehr muskeln", "wunder"];
      const hitBad = G.flatMap(x => BAD.filter(w => `${x.t} ${x.d} ${x.a}`.toLowerCase().includes(w)).map(w => `${x.k}: ${w}`));
      ok("Keine Erfolgsversprechen: Wörter wie „garantiert“, „beweist“, „am besten“ kommen in keinem Eintrag vor", !hitBad.length, hitBad.join(" | "));

      // Sortierung von Hand: Ä steht bei A, Ö bei O, Ü bei U; reine Zeichenfolge-Sortierung würde Umlaute hinter Z stellen
      const grp = await tp(page, () => window.__tp.glossarGroups(["Zebra", "Übung", "Öl", "Untergriff", "Ober", "Agonist", "Äpfel", "1RM"]));
      ok("Deutsche Sortierung: Umlaute unter dem Grundbuchstaben (Ä bei A, Ö bei O, Ü bei U), Ziffern unter „#“",
        JSON.stringify(grp) === JSON.stringify([["#", ["1RM"]], ["A", ["Agonist", "Äpfel"]], ["O", ["Ober", "Öl"]], ["U", ["Übung", "Untergriff"]], ["Z", ["Zebra"]]]), JSON.stringify(grp));

      // Suche (Funktion): erwartete Treffer unabhängig von der App berechnet
      const find = q => tp(page, q => window.__tp.glossarFind(q), q);
      const expect = w => G.filter(x => norm(`${x.t} ${x.d} ${x.a}`).includes(w)).map(x => x.k);
      const fSatz = await find("satz"), fUb = await find("ubung");
      ok("Suche „satz“ findet mehrere Begriffe, darunter Satz, Arbeitssatz, Aufwärmsatz, Satzpause und Supersatz – und nur solche mit „satz“ im Text",
        ["satz", "arbeitssatz", "aufwaermsatz", "satzpause", "supersatz"].every(k => fSatz.includes(k)) && fSatz.length < G.length && fSatz.join() === expect("satz").join(), fSatz.join());
      ok("Suche „ubung“ findet Begriffe mit „Übung“ (Übung, Mehrgelenksübung, Eingelenksübung); „UBUNG“, „Übung“ und „uebung“ finden dasselbe",
        ["uebung", "mehrgelenk", "eingelenk"].every(k => fUb.includes(k)) && fUb.join() === expect("ubung").join() && [await find("UBUNG"), await find("Übung"), await find("uebung"), await find("  ÜBUNG ")].every(r => r.join() === fUb.join()), fUb.join());
      ok("Suche: „eiweiss“ findet „Eiweiß“, „1rm“ das Höchstgewicht, „protein“ das Eiweiß, „rir“ die Wiederholungen in Reserve",
        (await find("eiweiss")).includes("eiweiss") && (await find("1rm")).includes("rm1") && (await find("protein")).includes("eiweiss") && (await find("rir")).includes("rir"));
      const fTwo = await find("pro seite");
      ok("Mehrere Wörter müssen alle vorkommen: „pro seite“ findet „Pro Seite und insgesamt“, aber weniger als „seite“ allein", fTwo.includes("proseite") && fTwo.length <= (await find("seite")).length && fTwo.every(k => expect("pro").includes(k) && expect("seite").includes(k)), fTwo.join());
      ok("Suche „xyz123“ findet nichts; leere Suche und nur Leerzeichen zeigen alle Begriffe", (await find("xyz123")).length === 0 && (await find("")).length === G.length && (await find("   ")).length === G.length);
      await ctx.close();
    }
    {
      // Seite: Zeile am richtigen Platz, Liste, Aufklappen, Suchen, „Siehe auch“, Zurück
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      const G = await tp(page, () => window.__tp.GLOSSAR), by = Object.fromEntries(G.map(x => [x.k, x]));
      const norm = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
      await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]");
      const row = await tp(page, () => { const r = document.querySelector("#libMore .group #row-glossar"); return r && { h: document.querySelector("#libMore h2").textContent, t: r.querySelector(".t").textContent, v: r.querySelector(".val").textContent, ico: !!r.querySelector(".ico") }; });
      ok("Wissen → Artikel: unter „Nachschlagen“ steht die Zeile „Begriffe“ mit Symbol und Anzahl", !!row && row.h === "Nachschlagen" && row.t === "Begriffe" && row.v === String(G.length) && row.ico, JSON.stringify(row));
      await page.click("#row-glossar");
      const snap = () => tp(page, () => { const q = document.getElementById("glQ"), st = document.getElementById("glStatus");
        return { title: document.querySelector("#app h1").textContent, h1: document.querySelectorAll("#app h1").length, back: document.querySelector("#navbar .nb-back").textContent.trim(), tab: document.querySelector("#tabs button.on").dataset.v,
          q: q.value, foc: document.activeElement === q, pos: q.selectionStart, same: q.__same === 1, status: st.hidden ? null : st.textContent, empty: !!document.getElementById("glEmpty"),
          groups: [...document.querySelectorAll("#glList section")].map(s => [s.querySelector("h2").textContent, [...s.querySelectorAll("summary")].map(x => x.textContent)]),
          open: [...document.querySelectorAll("#glList details[open]")].map(d => d.dataset.k) }; });
      let v = await snap();
      const terms = v.groups.flatMap(g => g[1]);
      ok("Begriffe: eigene Unterseite mit „‹ Wissen“, genau einer Überschrift, leerem Suchfeld und allen Begriffen (zugeklappt); der Bereich bleibt „Wissen“",
        v.title === "Begriffe" && v.h1 === 1 && v.back === "Wissen" && v.tab === "lib" && v.q === "" && v.status === null && terms.length === G.length && v.open.length === 0 && (await page.textContent("#app .sub")).startsWith(`${G.length} Wörter`), JSON.stringify({ ...v, groups: terms.length }));
      const letters = v.groups.map(g => g[0]);
      ok("Alphabetisch in Gruppen nach Anfangsbuchstaben: Buchstaben aufsteigend, jeder Begriff unter seinem Grundbuchstaben, Begriffe ohne Rücksicht auf Umlaute geordnet",
        letters.every((l, i) => /^[A-Z]$/.test(l) && (!i || letters[i - 1] < l)) && v.groups.every(([l, a]) => a.every(t => norm(t).charAt(0).toUpperCase() === l)) && terms.every((t, i) => !i || norm(terms[i - 1]) < norm(t)), JSON.stringify(v.groups).slice(0, 300));
      const U = (v.groups.find(g => g[0] === "U") || [])[1] || [], Hh = (v.groups.find(g => g[0] === "H") || [])[1] || [];
      ok("Umlaute stehen beim Grundbuchstaben: „Übung“ unter U vor „Untergriff“, „Höchstgewicht …“ unter H vor „Hypertrophie“; erster Begriff „Agonist“, letzter „Wiederholungsbereich“",
        U.join("|") === "Übung|Untergriff" && Hh.length === 2 && Hh[0].startsWith("Höchstgewicht") && Hh[1] === "Hypertrophie" && terms[0] === "Agonist" && terms[terms.length - 1] === "Wiederholungsbereich", JSON.stringify([U, Hh, terms[0], terms[terms.length - 1]]));
      ok("Begriffe: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, (await freeTextOn(page)).join(" | "));

      // Aufklappen zeigt Erklärung, „In der App“ und „Siehe auch“
      await page.click("#gl-satz summary");
      const it = await tp(page, () => { const d = document.getElementById("gl-satz"), p = [...d.querySelectorAll(".gdet-in p")]; return { open: d.open, vis: p[0].getBoundingClientRect().height > 0, d: p[0].textContent, a: p[1].textContent, see: [...d.querySelectorAll("[data-a=glossarGo]")].map(b => b.textContent), lab: d.querySelector(".gl-see .cap").textContent }; });
      ok("Begriff antippen klappt die Erklärung auf: Erklärung, „In der App: …“ und „Siehe auch“ mit den Namen der verwandten Begriffe",
        it.open && it.vis && it.d === by.satz.d && it.a === `In der App: ${by.satz.a}` && it.lab === "Siehe auch" && it.see.join("|") === by.satz.s.map(k => by[k].t).join("|"), JSON.stringify(it));
      ok("Begriff ohne Bezug zur App zeigt keinen Satz „In der App“", await tp(page, () => !document.querySelector("#gl-konz .gl-app") && !!document.querySelector("#gl-satz .gl-app")) && by.konz.a === "");
      await page.click("#gl-satz summary");
      ok("Nochmal antippen klappt wieder zu", !(await page.$eval("#gl-satz", d => d.open)));
      await page.click("#gl-satz summary");

      // Suchen: nur die Liste wird neu gezeichnet – das Feld bleibt dasselbe Element, Fokus und Cursor bleiben
      await page.click("#glQ"); await tp(page, () => { document.getElementById("glQ").__same = 1; });
      await page.keyboard.type("satz");
      v = await snap();
      const exp = await tp(page, () => window.__tp.glossarFind("satz").length);
      ok("Tippen im Suchfeld filtert sofort: „satz“ zeigt nur Treffer, darunter die Trefferzahl", exp >= 5 && v.groups.flatMap(g => g[1]).length === exp && v.status === `${exp} Treffer` && v.groups.flatMap(g => g[1]).includes("Supersatz") && !v.groups.flatMap(g => g[1]).includes("Agonist"), JSON.stringify([exp, v.status]));
      ok("Das Suchfeld behält beim Tippen Fokus und Cursor (dasselbe Feld, nicht neu gezeichnet)", v.foc && v.same && v.q === "satz" && v.pos === 4, JSON.stringify([v.foc, v.same, v.q, v.pos]));
      ok("Ein von Hand aufgeklappter Begriff bleibt beim Filtern offen", v.open.join() === "satz", v.open.join());
      await page.keyboard.press("Home"); await page.keyboard.type("super");
      v = await snap();
      ok("Tippen mitten im Text: Der Cursor bleibt an seiner Stelle („super“ vor „satz“ → Cursor nach dem 5. Zeichen)", v.foc && v.same && v.q === "supersatz" && v.pos === 5 && v.groups.flatMap(g => g[1]).includes("Supersatz"), JSON.stringify([v.q, v.pos, v.foc]));
      await page.fill("#glQ", "Muskelkater");
      v = await snap();
      ok("Bleibt genau ein Treffer, ist er gleich aufgeklappt („1 Treffer“)", v.groups.length === 1 && v.groups[0][1].join() === "Muskelkater" && v.open.join() === "kater" && v.status === "1 Treffer", JSON.stringify(v.groups) + v.status);
      await page.fill("#glQ", "ubung");
      v = await snap();
      ok("„ubung“ im Suchfeld zeigt „Übung“, „Mehrgelenksübung“ und „Eingelenksübung“", ["Übung", "Mehrgelenksübung", "Eingelenksübung"].every(t => v.groups.flatMap(g => g[1]).includes(t)), JSON.stringify(v.groups));

      // Kein Treffer
      await page.fill("#glQ", "xyz123");
      v = await snap();
      const em = await tp(page, () => { const e = document.getElementById("glEmpty"), st = document.getElementById("glStatus"); return { txt: e.querySelector("p").textContent, btn: e.querySelector("button").textContent, card: e.classList.contains("card"), n: document.querySelectorAll("#glList details").length, sr: st.classList.contains("sr-only"), st: st.textContent }; });
      ok("Kein Treffer („xyz123“): kurzer Hinweis auf einer Karte mit „Suche löschen“, keine Liste; zum Vorlesen „Kein Treffer“",
        v.empty && em.card && em.n === 0 && em.txt.includes("„xyz123“") && em.txt.startsWith("Kein Begriff") && em.btn === "Suche löschen" && em.sr && em.st === "Kein Treffer", JSON.stringify(em));
      ok("Kein Treffer: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, (await freeTextOn(page)).join(" | "));
      await page.fill("#glQ", `<b id="glX">x</b>"`);
      ok("Eingegebener Text wird nur als Text gezeigt (kein HTML)", await tp(page, () => !document.getElementById("glX") && document.querySelector("#glEmpty p").textContent.includes(`<b id="glX">x</b>"`)));
      await page.click("#glEmpty [data-a=glossarClear]");
      v = await snap();
      ok("„Suche löschen“ leert das Feld, zeigt wieder alle Begriffe und setzt den Cursor ins Feld", v.q === "" && v.foc && v.status === null && !v.empty && v.groups.flatMap(g => g[1]).length === G.length, JSON.stringify([v.q, v.foc, v.status]));

      // „Siehe auch“ springt zum Begriff und klappt ihn auf
      await page.click("#gl-satz [data-a=glossarGo][data-k=arbeitssatz]"); await sleep(150);
      const j = await tp(page, () => { const d = document.getElementById("gl-arbeitssatz"), r = d.getBoundingClientRect(), nb = document.getElementById("navbar").getBoundingClientRect().bottom; return { open: d.open, top: Math.round(r.top - nb), inView: r.top >= nb - 1 && r.top < innerHeight / 2, foc: document.activeElement === d.querySelector("summary"), from: document.getElementById("gl-satz").open }; });
      ok("„Siehe auch“ → „Arbeitssatz“: Der Begriff ist aufgeklappt, steht oben im Bild unter der Leiste und hat den Fokus; der Ausgangsbegriff bleibt offen", j.open && j.inView && j.foc && j.from, JSON.stringify(j));
      await page.fill("#glQ", "deload");
      v = await snap();
      ok("Suche „deload“: genau ein Treffer („Entlastungswoche (Deload)“)", v.groups.flatMap(g => g[1]).join() === "Entlastungswoche (Deload)" && v.open.join() === "deload", JSON.stringify(v.groups));
      await page.click("#gl-deload [data-a=glossarGo][data-k=plateau]"); await sleep(150);
      v = await snap();
      ok("„Siehe auch“ zu einem Begriff außerhalb der Treffer leert die Suche und klappt ihn auf („Plateau“)", v.q === "" && v.status === null && v.groups.flatMap(g => g[1]).length === G.length && v.open.includes("plateau") && !v.open.includes("deload") && v.open.includes("satz") && v.open.includes("arbeitssatz"), JSON.stringify([v.q, v.open]));

      // Neuzeichnen der Seite behält Suche und aufgeklappte Begriffe; Öffnen über die Zeile beginnt frisch
      await page.fill("#glQ", "griff"); await page.click("#gl-obergriff summary");
      await tp(page, () => window.__tp.EXT.views.glossar());
      v = await snap();
      ok("Wird die Seite neu gezeichnet, bleiben Suchtext und aufgeklappte Begriffe erhalten", v.q === "griff" && v.open.includes("obergriff") && v.status === `${v.groups.flatMap(g => g[1]).length} Treffer` && !v.groups.flatMap(g => g[1]).includes("Agonist"), JSON.stringify([v.q, v.open, v.status]));

      // 320 px, alles aufgeklappt: kein seitliches Scrollen, Tippflächen groß genug, kein freier Text
      await page.fill("#glQ", ""); await page.$$eval("#glList details", d => d.forEach(x => x.open = true));
      await page.setViewportSize({ width: 320, height: 640 });
      const small = await tp(page, () => ({ taps: [...document.querySelectorAll("#glList summary, #glList [data-a=glossarGo], #glQ")].filter(e => e.getBoundingClientRect().height < 44).length,
        wide: [...document.querySelectorAll("#glList *")].filter(e => e.getBoundingClientRect().right > innerWidth + .5).length, n: document.querySelectorAll("#glList details[open]").length }));
      ok("Begriffe bei 320 px, alle aufgeklappt: kein seitliches Scrollen, nichts ragt hinaus, alle Tippflächen mindestens 44 px hoch", await noOverflow(page) && small.taps === 0 && small.wide === 0 && small.n === G.length, JSON.stringify(small) + " " + await overflowers(page));
      ok("Begriffe aufgeklappt: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, (await freeTextOn(page)).join(" | "));
      await page.fill("#glQ", "xyz123");
      ok("Kein Treffer bei 320 px: kein seitliches Scrollen", await noOverflow(page), await overflowers(page));
      await page.setViewportSize({ width: 360, height: 780 });

      // Zurück und frisch öffnen
      await page.click("#navbar .nb-back");
      ok("Zurück führt zu Wissen → Artikel", (await page.textContent("#app h1")) === "Wissen" && await page.isVisible("#row-glossar") && await page.$eval("#wissenSeg [data-v=wissen]", b => b.classList.contains("on")));
      await page.click("#row-glossar");
      v = await snap();
      ok("Erneut über die Zeile geöffnet: leere Suche, alles zugeklappt, alle Begriffe", v.q === "" && v.open.length === 0 && v.groups.flatMap(g => g[1]).length === G.length, JSON.stringify([v.q, v.open]));
      await ctx.close();
    }
    {
      // Kein gespeicherter Zustand: Ein kaputter gespeicherter Wert stört nicht und fällt weg; die Seite funktioniert auch ganz ohne Daten, im hellen Design und nach dem Neuladen
      const { ctx, page } = await open({ plan: PLAN_SMALL, x: { glossar: "Unsinn" } }, { light: true });
      const n = await tp(page, () => window.__tp.GLOSSAR.length);
      await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]"); await page.click("#row-glossar");
      await page.fill("#glQ", "split"); await page.click("#gl-split summary");
      const mem = await tp(page, () => ({ x: Object.keys(window.__tp.state.x), clean: Object.keys(window.__tp.EXT.clean), ls: Object.keys(localStorage).filter(k => /gloss|begriff/i.test(k)) }));
      ok("Kaputter gespeicherter Wert (x.glossar = „Unsinn“): Die Seite funktioniert; die Begriffe haben keinen Speicher, der Wert fällt weg, kein eigener Schlüssel",
        (await page.textContent("#app h1")) === "Begriffe" && await page.$eval("#gl-split", d => d.open) && !mem.x.includes("glossar") && !mem.clean.includes("glossar") && !mem.ls.length, JSON.stringify(mem));
      await page.reload();
      await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]"); await page.click("#row-glossar");
      ok("Nach dem Neuladen: alle Begriffe, leere Suche, nichts aufgeklappt (helles Design)", await tp(page, n => document.querySelectorAll("#glList details").length === n && !document.querySelector("#glList details[open]") && document.getElementById("glQ").value === "", n) && (await freeTextOn(page)).length === 0);
      await ctx.close();
      const e = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [] } });
      await e.page.click("nav.tabs [data-v=lib]"); await e.page.click("#wissenSeg [data-v=wissen]"); await e.page.click("#row-glossar");
      await e.page.click("#gl-agonist summary");
      ok("Leerer Plan ohne Trainingstage und ohne Verlauf: Zeile und Seite sind da, Begriffe lassen sich aufklappen (das Lexikon braucht keine Daten)",
        await tp(e.page, n => document.querySelector("#app h1").textContent === "Begriffe" && document.querySelectorAll("#glList details").length === n && document.getElementById("gl-agonist").open, n));
      await e.ctx.close();
    }
    {
      // Was unter „In der App“ steht, stimmt: Bezeichnungen in „…“ kommen in der App vor, Zahlen folgen den Regeln der App (von Hand nachgerechnet)
      const p = JSON.parse(JSON.stringify(PLAN_SMALL)); p.days[0].items[0].rest = 90;
      const same = d => hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], d, "s");
      const { ctx, page } = await open({ plan: p, history: [27, 22, 17, 13, 9, 6].map(same) });
      const G = await tp(page, () => window.__tp.GLOSSAR), by = Object.fromEntries(G.map(x => [x.k, x]));
      const src = require("fs").readFileSync(path.join(ROOT, "index.html"), "utf8"), a0 = src.indexOf("// @ext:glossar:js:start"), a1 = src.indexOf("// @ext:glossar:js:end");
      const app = src.slice(0, a0) + src.slice(a1);
      const quoted = [...new Set(G.flatMap(x => (x.a.match(/„[^“]+“/g) || []).map(q => q.slice(1, -1).replace(/ …$/, ""))))];
      const missing = quoted.filter(q => !app.includes(q));
      ok("Jede Bezeichnung in „…“ unter „In der App“ steht so auch in der App (außerhalb der Begriffe)", a0 > 0 && a1 > a0 && quoted.length >= 25 && !missing.length, `${quoted.length} · fehlt: ${missing.join(" | ")}`);
      const has = (k, ...parts) => parts.every(s => by[k].a.includes(s));

      const f = await tp(page, () => { const T = window.__tp, r = (g, id) => { const x = T.rangeFor(g, id); return `${x.rmin}–${x.rmax}`; }, all = T.allEx(), iso = all.filter(e => /Iso-Lateral/.test(e.label || ""));
        const goals = (o, kg = 80) => T.calcGoals(Object.assign({ sex: "m", age: 30, cm: 180, pal: 1.55, goal: "halten", kcal: 2700 }, o), kg);
        return { aufbau: r("aufbau", "hs-chest"), kraft: r("kraft", "hs-chest"), kraftIso: r("kraft", "hs-legext"), fit: r("fit", "hs-chest"), labels: ["aufbau", "kraft", "fit"].map(g => T.rangeFor(g, "hs-chest").label),
          plans: [2, 3, 4].map(n => T.generatePlan("aufbau", n, "einsteiger", 60).days.map(d => d.name).join("|")), perRep: T.TIME.perRep,
          vol: [T.setVol({ exId: "hs-chest", u: "s" }, { kg: 40, reps: 10 }), T.setVol({ exId: "hs-chest", u: "t" }, { kg: 40, reps: 10 })],
          steps: [...new Set(all.map(e => e.step))].sort((a, b) => a - b), iso: iso.length, isoSide: iso.filter(e => e.type === "plate" && e.load === "side").length,
          names: ["Latzug breit", "Latzug eng", "Rudern Untergriff", "Latzug Untergriff", "Brustpresse", "Beinstrecker"].filter(nm => !all.some(e => e.name === nm)),
          g: goals({}), bmr: [goals({}).bmr, goals({ sex: "w" }).bmr, goals({ age: 31 }).bmr, goals({ cm: 190 }).bmr, goals({}, 90).bmr],
          plateau: T.plateau("hs-chest"), entry: (e => ({ mode: e.mode, sets: e.sets.map(t => `${t.kg}×${t.reps}`).join() }))(T.makeEntry({ id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 90 })) }; });
      ok("Wiederholungsbereich: Startwerte der App wie genannt – Muskelaufbau 8–12, Kraft 4–6 (Grundübung), Fitness & Straffung 12–15; Kraft an einer Eingelenksübung 8–12",
        f.aufbau === "8–12" && f.kraft === "4–6" && f.fit === "12–15" && f.kraftIso === "8–12" && f.labels.join("|") === "Muskelaufbau|Kraft|Fitness & Straffung"
        && has("wdhbereich", "Muskelaufbau 8–12", "Kraft 4–6", "Fitness & Straffung 12–15") && has("eingelenk", "8–12 statt 4–6") && has("maxkraft", "4–6"), JSON.stringify(f));
      ok("Split: Planvorschlag für 2 Tage Ganzkörper A/B, für 3 Tage Drücken/Ziehen/Beine, für 4 Tage Ober- und Unterkörper – wie in den Begriffen genannt",
        f.plans.join(" · ") === "Ganzkörper A|Ganzkörper B · Drücken|Ziehen|Beine · Oberkörper A|Unterkörper A|Oberkörper B|Unterkörper B" && has("split", "2 Tage Ganzkörper", "3 Tage Drücken/Ziehen/Beine", "4 Tage Ober- und Unterkörper") && has("ganzkoerper", "2 Tage") && has("ppl", "3 Tage") && has("okuk", "4 Tage"), f.plans.join(" · "));
      ok("Volumen: 40 kg × 10 zählt „pro Seite“ 800 kg (beide Seiten), „insgesamt“ 400 kg; Tempo: 3,5 Sekunden je Wiederholung", f.vol.join() === "800,400" && f.perRep === 3.5 && has("tempo", "3,5 Sekunden") && has("proseite", "das Doppelte"), JSON.stringify([f.vol, f.perRep]));
      ok("Geräte: Gewichtsschritte nur 1,25, 2,5, 5 oder 10 kg; alle Geräte mit „Iso-Lateral“ sind auf „pro Seite“ eingestellt; die als Beispiel genannten Geräte gibt es",
        f.steps.every(s => [1.25, 2.5, 5, 10].includes(s)) && f.iso >= 10 && f.isoSide === f.iso && !f.names.length && has("schritt", "1,25, 2,5, 5 oder 10 kg"), JSON.stringify([f.steps, f.iso, f.isoSide, f.names]));
      // 80 kg, 2.700 kcal: Eiweiß 80 × 1,6 = 128 g; Fett 2.700 × 0,20 ÷ 9 = 60 g bis 2.700 × 0,35 ÷ 9 = 105 g; Kohlenhydrate (2.700 − 128 × 4 − 105 × 9) ÷ 4 = 310,75 → 311 g bis (2.700 − 512 − 540) ÷ 4 = 412 g
      ok("Ernährung: 80 kg und 2.700 kcal ergeben 128 g Eiweiß (1,6 g je kg), 60–105 g Fett (20–35 %, 9 kcal je g) und 311–412 g Kohlenhydrate (der Rest, 4 kcal je g)",
        f.g.prot === 128 && f.g.fatLo === 60 && f.g.fatHi === 105 && f.g.carbLo === 311 && f.g.carbHi === 412 && has("eiweiss", "1,6 g je kg", "4 kcal") && has("fett", "20–35 %", "9 kcal") && has("kh", "4 kcal"), JSON.stringify(f.g));
      // Mann, 30 Jahre, 180 cm, 80 kg: 10 × 80 + 6,25 × 180 − 5 × 30 + 5 = 1.780 kcal; Frau −161 statt +5 = 1.614; 31 Jahre 1.775; 190 cm 1.842,5 → 1.843; 90 kg 1.880. Erhaltungsbedarf 1.780 × 1,55 = 2.759
      ok("Grundumsatz hängt von Gewicht, Größe, Alter und Geschlecht ab (1.780 · Frau 1.614 · 31 Jahre 1.775 · 190 cm 1.843 · 90 kg 1.880); Erhaltungsbedarf = Grundumsatz × Aktivitätsfaktor (1.780 × 1,55 = 2.759)",
        f.bmr.join() === "1780,1614,1775,1843,1880" && f.g.tdee === 2759 && has("grundumsatz", "Gewicht, Größe, Alter und Geschlecht") && has("gesamtumsatz", "Grundumsatz × Aktivitätsfaktor"), JSON.stringify([f.bmr, f.g.tdee]));
      ok("Steigerung: Letztes Mal 40 kg × 10/10 bei Ziel 8–12 → gleiches Gewicht, Ziel 11 Wiederholungen (erst mehr Wiederholungen)", f.entry.mode === "keep" && f.entry.sets === "40×11,40×11", JSON.stringify(f.entry));
      ok("Stillstand: 6 vollständige Einheiten über 3 Wochen ohne Fortschritt werden gemeldet", !!f.plateau && f.plateau.n === 6 && f.plateau.weeks === 3 && has("plateau", "mindestens 4 vollständigen Einheiten", "mindestens 3 Wochen"), JSON.stringify(f.plateau));

      // Häufigkeit: 6 Trainings in den letzten 4 Wochen ÷ 4 = 1,5 pro Woche
      await page.click("nav.tabs [data-v=history]");
      ok("Häufigkeit: 6 Trainings in 4 Wochen → „1,5 Trainings pro Woche · letzte 4 Wochen“", (await page.textContent("#app .kpi")).replace(/\s+/g, " ").includes("1,5Trainings pro Woche · letzte 4 Wochen") && has("haeufigkeit", "letzten 4 Wochen"), await page.textContent("#app .kpi"));
      // 1RM geschätzt: 40 × (1 + 10 ÷ 30) = 53,33 → auf halbe kg gerundet 53,5
      const rm = async () => { await page.click("[data-a=showEx][data-id=hs-chest]"); const t = await tp(page, () => [...document.querySelectorAll("#sheet-root .stat")].map(s => s.textContent.replace(/\s+/g, " ").trim()).find(s => s.startsWith("1RM geschätzt")) || ""); await page.keyboard.press("Escape"); await sleep(350); return t; };
      const rm1 = await rm();
      ok("1RM geschätzt: 40 kg × 10 → 40 × (1 + 10 ÷ 30) = 53,3 → „≈53,5 kg“ (unter Kraft & Bestwerte → Gerät antippen)", rm1.includes("≈53,5 kg") && has("rm1", "Gewicht × (1 + Wiederholungen ÷ 30)", "höchstens 12"), rm1);

      // Im Trainingstag: Pause 45 Sekunden bis 3 Minuten, „Wiederholungen ab/bis“, Supersatz mit dem Gerät direkt darunter
      await page.click("nav.tabs [data-v=plan]"); await page.click("[data-a=editDay]"); await page.click("#dayItems [data-a=editItem][data-i2='0']"); await sleep(100);
      const sh = await tp(page, () => ({ rest: [...document.querySelectorAll(".sheet [data-a=draftRest]")].map(b => +b.dataset.s), txt: document.querySelector(".sheet").textContent, ss: (document.querySelector("#ssField .t") || {}).textContent, next: window.__tp.ex(window.__tp.state.plan.days[0].items[1].exId).name }));
      ok("Gerät im Trainingstag: Pause von 45 Sekunden bis 3 Minuten, „Wiederholungen ab“ und „bis“, „Supersatz mit“ dem Gerät direkt darunter",
        sh.rest[0] === 45 && sh.rest[sh.rest.length - 1] === 180 && sh.rest.every((s, i) => !i || s > sh.rest[i - 1]) && sh.txt.includes("Wiederholungen ab") && sh.txt.includes("Wiederholungen bis") && sh.ss === `Supersatz mit ${sh.next}` && has("satzpause", "45 Sekunden bis 3 Minuten"), JSON.stringify([sh.rest, sh.ss]));
      await page.keyboard.press("Escape"); await sleep(350);

      // Im Training: Aufwärmsätze etwa 50 % × 10 und 75 % × 5 (40 kg → 20 und 30), „Übung 1 von 3“, „Satz fertig“, Reserve 0 bis 4+
      await page.click("nav.tabs [data-v=home]"); await page.click("[data-a=start]");
      const tr = await tp(page, () => ({ warm: (document.getElementById("warmup") || {}).textContent || "", lab: document.querySelector("#app .ex-head .label").textContent, done: document.querySelector("[data-a=doneSet]").textContent, kg: document.getElementById("kgIn").value, plates: !!document.getElementById("platesTxt") }));
      ok("Training: Vor dem ersten Satz mit 40 kg schlägt die App „20 × 10, dann 30 × 5“ zum Aufwärmen vor (50 % und 75 %), nicht einzutragen",
        tr.kg === "40" && tr.warm.includes("20 × 10, dann 30 × 5") && tr.warm.includes("nicht eintragen") && has("aufwaermsatz", "50 % des Gewichts × 10", "75 % × 5"), JSON.stringify(tr));
      ok("Training: „Übung 1 von 3“ über dem Gerät, Knopf „Satz fertig“, am Scheibengerät die Scheiben „Pro Seite“", tr.lab.startsWith("Übung 1 von 3") && tr.done === "Satz fertig" && tr.plates, JSON.stringify(tr));
      await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      const link = await page.textContent("[data-a=openRir]");
      await page.click("[data-a=openRir]");
      const rir = await tp(page, () => [...document.querySelectorAll("#rirSeg button")].map(b => b.textContent).join(" "));
      ok("Pause: „Reserve angeben“ bietet 0 bis 4+", link.trim() === "Reserve angeben" && rir === "0 1 2 3 4+" && has("rir", "0 bis 4+") && has("versagen", "der 0"), `${link} · ${rir}`);
      await page.keyboard.press("Escape"); await sleep(350);
      await page.click("[data-a=askStop]"); await page.click("[data-a=askDiscard]"); await page.click("[data-a=stopDiscard]");

      // Regeln mit geänderten Werten: letztes Training 40 kg × 12/12 → ein Gewichtsschritt (2,5 kg) mehr, weiter am unteren Ende: 42,5 × 8
      const up = await tp(page, () => { const T = window.__tp, H = T.state.history; H[H.length - 1].exercises[0].sets = [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }];
        const e = T.makeEntry({ id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 90 }); return { mode: e.mode, sets: e.sets.map(t => `${t.kg}×${t.reps}`).join(), step: T.ex("hs-chest").step }; });
      ok("Doppelte Progression: In allen Sätzen das obere Ende (40 kg × 12/12) → ein Gewichtsschritt mehr und unten weiter: 42,5 kg × 8", up.mode === "up" && up.step === 2.5 && up.sets === "42.5×8,42.5×8" && has("doppelt", "in allen Sätzen das obere Ende", "einen Gewichtsschritt mehr"), JSON.stringify(up));
      // 1RM mit mehr als 12 Wiederholungen: 40 kg × 15 → gerechnet mit 12: 40 × (1 + 12 ÷ 30) = 56 (ohne Grenze wären es 60)
      await tp(page, () => { const H = window.__tp.state.history; H[H.length - 1].exercises[0].sets = [{ kg: 40, reps: 15 }, { kg: 40, reps: 15 }]; });
      await page.click("nav.tabs [data-v=history]");
      const rm2 = await rm();
      ok("1RM geschätzt rechnet mit höchstens 12 Wiederholungen: 40 kg × 15 → 40 × (1 + 12 ÷ 30) = „≈56 kg“", rm2.includes("≈56 kg"), rm2);
      // Stillstand: Grenzen 4 Einheiten und 3 Wochen (Tage vor heute)
      const pl = await tp(page, () => { const T = window.__tp, now = Date.now(), one = JSON.stringify(T.state.history[0]);
        const at = days => { T.state.history = days.map((d, i) => Object.assign(JSON.parse(one), { id: "p" + i, date: new Date(now - d * 864e5).toISOString() })); const r = T.plateau("hs-chest"); return r ? `${r.n}/${r.weeks}` : "–"; };
        return [at([27, 20, 13, 6]), at([27, 13, 6]), at([26, 20, 13, 6]), at([20, 15, 10, 5])]; });
      ok("Stillstand: 4 Einheiten über genau 3 Wochen werden gemeldet; 3 Einheiten oder weniger als 3 Wochen (20 und 15 Tage) nicht", pl.join(" ") === "4/3 – – –", pl.join(" "));
      await ctx.close();
    }
    // @ext:glossar:test:end
    // ── Abstand glossar/test 1 ──
    // ── Abstand glossar/test 2 ──
    // ── Abstand glossar/test 3 ──
    // @ext:muskeln:test:start
    section("E-muskeln. Muskeln (Wissen → Artikel → Nachschlagen → Muskeln)");
    {
      // Fester Plan, von Hand nachgerechnet (Hauptmuskel voll, mittrainierte halb; ohne Termine jeder Tag einmal pro Woche):
      //   Oberkörper:       Brustpresse 3 (Brust; Trizeps, Schultern) · Rudern 4 (Rücken; Bizeps, Schultern) · Schulterpresse 3 (Schultern; Trizeps) · Armbeuger 2 (Bizeps)
      //   Beine:            Beinpresse 4 (Beine vorn; Po) · Beinbeuger sitzend 3 (Beine hinten) · Hüftheben 3 (Po; Beine hinten)
      //   Brust und Rücken: Butterfly 3 (Brust; Schultern) · Schräge Brustpresse 4 (Brust; Schultern, Trizeps) · Latzug 5 (Rücken; Bizeps) · Trizepsdrücken 2 (Trizeps; Brust, Schultern)
      //   Brust 3+3+4+1 = 11 · Rücken 4+5 = 9 · Schultern 1,5+2+3+1,5+2+1 = 11 · Bizeps 2+2+2,5 = 6,5 · Trizeps 1,5+1,5+2+2 = 7
      //   Beine vorn 4 · Beine hinten 3+1,5 = 4,5 · Po 2+3 = 5 · Bauch, Beine innen, Waden 0
      const mi = (id, exId, sets) => ({ id, exId, sets, rmin: 8, rmax: 12, rest: 90 });
      const MK_PLAN = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Oberkörper", items: [mi("a1", "hs-chest", 3), mi("a2", "hs-row", 4), mi("a3", "hs-shoulder", 3), mi("a4", "hs-curl", 2)] },
        { id: "b", name: "Beine", items: [mi("b1", "hs-legpress", 4), mi("b2", "hs-seatcurl", 3), mi("b3", "hs-hipthrust", 3)] },
        { id: "c", name: "Brust und Rücken", items: [mi("c1", "hs-fly", 3), mi("c2", "hs-incline", 4), mi("c3", "hs-lat", 5), mi("c4", "hs-dip", 2)] }] };
      const MK_SETS = { brust: "11", ruecken: "9", schultern: "11", bizeps: "6,5", trizeps: "7", bauch: "0", beinev: "4", beineh: "4,5", innen: "0", po: "5", waden: "0" };
      // Geräte der App je Hauptmuskel, in der Geräteliste gezählt (zusammen 60)
      const MK_DEVS = { brust: 8, ruecken: 11, schultern: 8, bizeps: 3, trizeps: 6, bauch: 2, beinev: 10, beineh: 5, innen: 2, po: 3, waden: 2 };
      // Verlauf mit festen Abständen in Kalendertagen (12 Uhr am Ort – unabhängig von der Uhrzeit des Testlaufs):
      // vor 9 Tagen Oberkörper, vor 4 Tagen Beine, vor 2 Tagen Brust und Rücken
      const noonAgo = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
      const mh = (n, dayId, day, exs) => ({ id: "mh" + n, dayId, day, date: noonAgo(n).toISOString(), durationSec: 1800, exercises: exs.map(([exId, name]) => ({ exId, name, sets: [{ kg: 20, reps: 10 }, { kg: 20, reps: 10 }] })) });
      const MK_HIST = [mh(9, "a", "Oberkörper", [["hs-chest", "Brustpresse"], ["hs-row", "Rudern"]]), mh(4, "b", "Beine", [["hs-legpress", "Beinpresse"], ["hs-hipthrust", "Hüftheben"]]),
        mh(2, "c", "Brust und Rücken", [["hs-lat", "Latzug"], ["hs-dip", "Trizepsdrücken"]])];
      const dateTxt = n => { const d = noonAgo(n); return d.toLocaleDateString("de-DE", { day: "numeric", month: "long" }) + (d.getFullYear() === new Date().getFullYear() ? "" : " " + d.getFullYear()); };
      const near = (a, b) => Math.abs(a - b) < 1e-6, pct = s => parseFloat((/width:\s*([\d.]+)%/.exec(s) || [])[1]), left = s => parseFloat((/left:\s*([\d.]+)%/.exec(s) || [])[1]);
      // Übersicht auslesen: je Muskel Name, Zahl rechts, Unterzeile und die Balken-Stile
      const readOverview = page => tp(page, () => { const T = window.__tp, q = s => document.querySelector(s), rows = {};
        document.querySelectorAll("#mkList .li").forEach(l => { const v = l.querySelector(".val"), b = l.querySelector(".mband"), f = l.querySelector(".mfill");
          rows[l.dataset.m] = { name: l.querySelector(".t").textContent, val: v ? v.firstChild.textContent : null, sr: v ? v.querySelector(".sr-only").textContent : null, sub: l.querySelector(".s").textContent.trim(), band: b ? b.getAttribute("style") : null, fill: f ? f.getAttribute("style") : null, h: l.getBoundingClientRect().height }; });
        return { title: q("#app h1").textContent, h1: document.querySelectorAll("#app h1").length, back: q("#navbar .nb-back").textContent.trim(), tab: q("#tabs button.on").dataset.v, rows, order: [...document.querySelectorAll("#mkList .li")].map(l => l.dataset.m).join(),
          keys: Object.keys(T.MUSCLES).join(), names: Object.values(T.MUSCLES).join(), ms: T.state.plan ? T.muscleSets(T.state.plan, T.planCheck().per) : null,
          devs: Object.fromEntries(Object.keys(T.MUSCLES).map(m => [m, T.allEx().filter(e => e.muscle === m).length])), head: q("#mkList h2").textContent, foot: q("#mkListFoot").textContent,
          topFoot: q("#mkTopFoot") ? q("#mkTopFoot").textContent : null, legend: q("#mkLegend") ? q("#mkLegend").textContent : null, empty: q("#mkEmpty") ? q("#mkEmpty").textContent : null, figLabel: q("#mkTop svg.fig").getAttribute("aria-label"),
          shades: [...new Set([...document.querySelectorAll("#mkTop .fig .m")].map(e => e.style.fillOpacity ? `${e.style.fill} ${e.style.fillOpacity}` : "grau"))].sort().join(" | ") }; });
      // Detailseite auslesen
      const readDetail = page => tp(page, () => { const q = s => document.querySelector(s), txt = s => q(s) ? q(s).textContent.trim().replace(/\s+/g, " ") : null, ids = s => [...document.querySelectorAll(s)].map(l => l.dataset.id).join();
        const hot = [...document.querySelectorAll("#mkOne .fig .m")].filter(e => e.getAttribute("style"));
        return { title: txt("#app h1"), h1: document.querySelectorAll("#app h1").length, back: txt("#navbar .nb-back"), tab: q("#tabs button.on").dataset.v, sets: txt("#mkSets"), dayN: txt("#mkDayN"), stat: txt("#mkStat"), band: txt("#mkBand"),
          bar: q("#mkStat .mfill") ? [q("#mkStat .mband").getAttribute("style"), q("#mkStat .mfill").getAttribute("style")] : null,
          days: [...document.querySelectorAll("#mkInPlan .mk-day")].map(x => ({ id: x.dataset.day, cap: x.querySelector(".cap").textContent, rows: [...x.querySelectorAll(".li")].map(l => `${l.dataset.id}: ${l.querySelector(".t").textContent} – ${l.querySelector(".s").textContent}`), pics: [...x.querySelectorAll(".li")].every(l => l.dataset.a === "openEx" && l.querySelector(".thumbbox svg")) })),
          rule: txt("#mkRule"), none: txt("#mkNone"), never: txt("#mkNever"), lastT: txt("#mkLastT"), lastS: txt("#mkLastS"), rec: txt("#mkRec"), recVal: q("#mkRec .val") ? q("#mkRec .val").textContent.trim() : null, recW: q("#mkRec .mfill") ? q("#mkRec .mfill").getAttribute("style") : null,
          main: ids("#mkMain .li"), sup: ids("#mkSup .li"), mainCap: txt("#mkMain .cap"), supCap: txt("#mkSup .cap"), hasSup: !!q("#mkSup"),
          figLabel: q("#mkOne svg.fig").getAttribute("aria-label"), hot: hot.length, hotAll: hot.every(e => e.getAttribute("style") === "fill:var(--mhot)"), parts: document.querySelectorAll("#mkOne .fig .m").length }; });
      const at320 = async page => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page), who = r ? "" : await overflowers(page); await page.setViewportSize({ width: 360, height: 780 }); return { r, who }; };

      {
        const { ctx, page } = await open({ plan: MK_PLAN, history: MK_HIST });
        const state0 = await tp(page, () => JSON.stringify(window.__tp.state));
        await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]");
        const row = await tp(page, () => { const r = document.querySelector("#libMore #row-muskeln"); return r && { h: document.querySelector("#libMore h2").textContent, t: r.querySelector(".t").textContent, ico: !!r.querySelector(".ico svg"), hgt: r.getBoundingClientRect().height }; });
        ok("Wissen → Artikel: unter „Nachschlagen“ steht die Zeile „Muskeln“ mit Symbolkachel", !!row && row.h === "Nachschlagen" && row.t === "Muskeln" && row.ico && row.hgt >= 44, JSON.stringify(row));
        await page.click("#row-muskeln");
        const ov = await readOverview(page);
        ok("Muskeln: eigene Unterseite mit „‹ Wissen“, genau eine Überschrift, der Bereich bleibt „Wissen“", ov.title === "Muskeln" && ov.h1 === 1 && ov.back === "Wissen" && ov.tab === "lib", JSON.stringify([ov.title, ov.h1, ov.back, ov.tab]));
        ok("Liste: alle elf Muskelgruppen in der Reihenfolge der App, jede Zeile mindestens 44 px hoch", ov.order === ov.keys && ov.order.split(",").length === 11 && Object.values(ov.rows).map(r => r.name).join() === ov.names && Object.values(ov.rows).every(r => r.h >= 44), ov.order);
        ok("Sätze pro Woche von Hand nachgerechnet: Brust 11, Rücken 9, Schultern 11, Bizeps 6,5, Trizeps 7, Beine vorn 4, Beine hinten 4,5, Po 5; Bauch, Beine innen und Waden 0",
          Object.keys(MK_SETS).every(m => ov.rows[m].val === MK_SETS[m]), JSON.stringify(Object.fromEntries(Object.keys(ov.rows).map(m => [m, ov.rows[m].val]))));
        ok("… und gleich muscleSets der App; die Zahl hat einen Vorlesetext „Sätze pro Woche“", Object.keys(MK_SETS).every(m => String(ov.ms[m]).replace(".", ",") === ov.rows[m].val && ov.rows[m].sr.trim() === "Sätze pro Woche"), JSON.stringify(ov.ms));
        ok("Zahl der Geräte je Muskel: von Hand gezählt (Brust 8, Rücken 11, … zusammen 60) und gleich der Geräteliste der App",
          Object.keys(MK_DEVS).every(m => ov.devs[m] === MK_DEVS[m] && ov.rows[m].sub.endsWith(`${MK_DEVS[m]} Geräte`)) && Object.values(MK_DEVS).reduce((a, b) => a + b, 0) === 60, JSON.stringify(ov.devs));
        ok("Muskel ohne Sätze im Plan: sachlich „Kommt im Plan nicht vor“ (Bauch, Beine innen, Waden) – bei den anderen nicht",
          ["bauch", "innen", "waden"].every(m => ov.rows[m].sub === `Kommt im Plan nicht vor · ${MK_DEVS[m]} Geräte`) && ["brust", "ruecken", "po"].every(m => ov.rows[m].sub === `${MK_DEVS[m]} Geräte`), JSON.stringify([ov.rows.bauch.sub, ov.rows.brust.sub]));
        // Richtwert der App für Muskelaufbau: 10–20 Sätze, Maßstab 26 (= 20 × 1,3). Heller Bereich von 10/26 = 38,46 % an, 38,46 % breit.
        // Brust 11/26 = 42,31 % (im Richtwert: grün), Rücken 9/26 = 34,62 % (darunter: blau), Bauch 0 %
        const R = ov.rows;
        ok("Balken gegen den Richtwert: heller Bereich 10–20 von 26 (38,46 % + 38,46 %); Brust 42,31 % grün, Rücken 34,62 % blau, Bauch leer",
          Object.values(R).every(r => near(left(r.band), 1000 / 26) && near(pct(r.band), 1000 / 26)) && near(pct(R.brust.fill), 1100 / 26) && R.brust.fill.includes("var(--ok)") && near(pct(R.ruecken.fill), 900 / 26) && R.ruecken.fill.includes("var(--accent)") && pct(R.bauch.fill) === 0,
          JSON.stringify([R.brust.band, R.brust.fill, R.ruecken.fill, R.bauch.fill]));
        ok("Überschrift und Beitext nennen Zählweise und „Richtwert der App“ wie die Planprüfung; die Gerätezahl ist erklärt",
          ov.head === "Sätze pro Woche im Plan" && ov.foot.includes("Sätze pro Woche: Hauptmuskel voll, mittrainierte halb gezählt, jeder Tag einmal pro Woche.") && ov.foot.includes("Heller Bereich: Richtwert der App für Muskelaufbau, 10–20 Sätze.") && ov.foot.includes("Geräte: alle in der App mit diesem Hauptmuskel."), ov.foot);
        // Figur: Deckkraft 25 % + 75 % × Sätze/20. 11 → 0,66 · 9 → 0,59 · 7 → 0,51 · 6,5 → 0,49 · 5 → 0,44 · 4,5 → 0,42 · 4 → 0,4; ohne Sätze grau
        ok("Figur: mehr Sätze = kräftiger (11 → 0,66 · 9 → 0,59 · 7 → 0,51 · 6,5 → 0,49 · 5 → 0,44 · 4,5 → 0,42 · 4 → 0,4), Muskeln ohne Sätze bleiben grau",
          ov.shades === ["grau"].concat(["0.4", "0.42", "0.44", "0.49", "0.51", "0.59", "0.66"].map(o => `var(--mhot) ${o}`)).join(" | "), ov.shades);
        ok("Figur hat Legende, Beitext („volle Farbe ab 20 Sätzen“) und einen Vorlesetext mit den Zahlen",
          ov.legend.includes("Nicht im Plan") && ov.legend.includes("Kräftiger = mehr Sätze") && ov.topFoot === "Farbe: Sätze pro Woche im Plan. Volle Farbe ab 20 Sätzen." && ov.figLabel.startsWith("Sätze pro Woche im Plan: Brust 11, Rücken 9, Schultern 11, Bizeps 6,5"), JSON.stringify([ov.legend, ov.topFoot, ov.figLabel]));
        const free1 = await freeTextOn(page), w1 = await at320(page);
        ok("Übersicht: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", free1.length === 0 && w1.r, free1.join(" | ") + w1.who);

        // Detailseite Brust: Oberkörper (Brustpresse 3) = 3 Sätze; Brust und Rücken (Butterfly 3 + Schräge Brustpresse 4 + Trizepsdrücken 2 halb = 1) = 8 Sätze; „Beine“ fehlt
        await page.click("#mk-brust");
        const d = await readDetail(page);
        ok("Muskel antippen öffnet die Detailseite: Titel „Brust“, „‹ Zurück“, Bereich „Wissen“, nur die Brust ist in der Figur hervorgehoben",
          d.title === "Brust" && d.h1 === 1 && d.back === "Zurück" && d.tab === "lib" && d.figLabel === "Brust an der Figur hervorgehoben" && d.hot >= 1 && d.hot < d.parts && d.hotAll, JSON.stringify([d.title, d.back, d.tab, d.figLabel, d.hot, d.parts]));
        ok("Im Plan: 11 Sätze pro Woche an 2 von 3 Trainingstagen, Richtwert 10–20 als „Richtwert der App“ gekennzeichnet, Balken wie in der Übersicht",
          d.sets === "11" && d.dayN === "2" && d.stat.includes("Richtwert 10–20") && d.stat.includes("von 3") && d.band === "Heller Bereich: Richtwert der App für Muskelaufbau." && d.bar[0] === R.brust.band && d.bar[1] === R.brust.fill, JSON.stringify([d.stat, d.bar]));
        ok("Im Plan: die richtigen Tage und Geräte – Oberkörper 3 Sätze (Brustpresse), Brust und Rücken 8 Sätze (Butterfly 3, Schräge Brustpresse 4, Trizepsdrücken 2 zählt halb); „Beine“ fehlt",
          d.days.length === 2 && d.days[0].id === "a" && d.days[0].cap === "Oberkörper · 3 Sätze" && d.days[0].rows.join(" | ") === "hs-chest: Brustpresse – 3 Sätze · Hauptmuskel"
          && d.days[1].id === "c" && d.days[1].cap === "Brust und Rücken · 8 Sätze" && d.days[1].rows.join(" | ") === "hs-fly: Butterfly – 3 Sätze · Hauptmuskel | hs-incline: Schräge Brustpresse – 4 Sätze · Hauptmuskel | hs-dip: Trizepsdrücken – 2 Sätze · mittrainiert, zählt halb", JSON.stringify(d.days));
        ok("Jede Zeile zeigt das Gerätebild und führt zum Gerät; die Zählweise steht darunter", d.days.every(x => x.pics) && d.rule === "Sätze pro Woche: Hauptmuskel voll, mittrainierte halb gezählt, jeder Tag einmal pro Woche.", d.rule);
        // Zuletzt trainiert: Brust war vor 9 Tagen Hauptmuskel (Brustpresse) und vor 2 Tagen mittrainiert (Trizepsdrücken) → das jüngste Training zählt
        const recB = await tp(page, () => window.__tp.mkRecovery().brust);
        ok("Zuletzt trainiert (Brust): das jüngste Training zählt – vor 2 Tagen, „Brust und Rücken“, Trizepsdrücken, als „mittrainiert“ benannt",
          d.lastT === `${dateTxt(2)} · vor 2 Tagen` && d.lastS === "Training „Brust und Rücken“ · Trizepsdrücken · mittrainiert", JSON.stringify([d.lastT, d.lastS]));
        ok("Erholung: die Stufe aus recovery() der App (keine Prozentzahl), als „Schätzung der App“ gekennzeichnet", d.recVal === (recB >= 85 ? "Erholt" : recB >= 45 ? "Teilweise" : "Belastet") && !d.rec.includes("%") && d.rec.includes("Schätzung der App") && d.rec.startsWith("Erholung"), JSON.stringify([d.rec, recB]));
        ok("Geräte in der App: erst „Hauptsächlich“ (8, Geräte im Studio zuerst), dann „Unterstützend“ (2) – benannt wie auf der Geräteseite",
          d.mainCap === "Hauptsächlich · 8" && d.main === "hs-chest,hs-incline,hs-decline,hs-widechest,hs-fly,lf-chest,lf-fly,lf-cablefly" && d.supCap === "Unterstützend · 2" && d.sup === "hs-dip,lf-tripress", JSON.stringify([d.mainCap, d.main, d.supCap, d.sup]));
        const marks = await tp(page, () => Object.fromEntries(["hs-chest", "hs-decline", "lf-chest", "hs-dip"].map(id => [id, document.querySelector(`#mkDevs .li[data-id="${id}"] .s`).textContent])));
        ok("Geräte aus dem Plan sind mit „Im Plan“ markiert, abgewählte mit „nicht im Studio“", marks["hs-chest"].startsWith("Im Plan · ") && marks["hs-dip"].startsWith("Im Plan · ") && !marks["hs-decline"].includes("Im Plan") && marks["lf-chest"].endsWith("· nicht im Studio") && !marks["lf-chest"].includes("Im Plan"), JSON.stringify(marks));
        const free2 = await freeTextOn(page), w2 = await at320(page);
        ok("Detailseite: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", free2.length === 0 && w2.r, free2.join(" | ") + w2.who);

        // Erholung öffnet das Erholungs-Fenster der App
        await page.click("#mkRec");
        ok("Die Zeile „Erholung“ öffnet das Erholungs-Fenster der App", (await page.textContent(".sheet h2")) === "Erholung");
        await page.click(".sheet .sh-head [data-a=closeSheet]");
        // Zum Gerät und zurück zur Muskel-Seite
        await page.click("#mkInPlan .li[data-id=hs-fly]");
        const g = await tp(page, () => ({ title: document.querySelector("#app h1").textContent, tab: document.querySelector("#tabs button.on").dataset.v }));
        await page.click("#navbar .nb-back");
        ok("Gerätezeile öffnet die Geräteseite (Butterfly); Zurück führt wieder zur Muskel-Seite „Brust“", g.title === "Butterfly" && g.tab === "lib" && (await page.textContent("#app h1")) === "Brust" && await page.isVisible("#mkInPlan"), JSON.stringify(g));

        // Rücken: vor 2 Tagen Hauptmuskel am Latzug. 12 Uhr vor zwei Tagen liegt 36–60 Stunden zurück → 50–83 % von 72 Stunden → immer „Teilweise“
        await page.click("#navbar .nb-back");
        ok("Zurück führt zur Übersicht „Muskeln“", (await page.textContent("#app h1")) === "Muskeln" && await page.isVisible("#mkList"));
        await page.click("#mk-ruecken");
        const dr = await readDetail(page);
        ok("Zuletzt trainiert (Rücken): vor 2 Tagen am Latzug als Hauptmuskel; Erholung „Teilweise“",
          dr.title === "Rücken" && dr.lastT === `${dateTxt(2)} · vor 2 Tagen` && dr.lastS === "Training „Brust und Rücken“ · Latzug" && dr.recVal === "Teilweise" && dr.rec.includes("Schätzung der App"), JSON.stringify([dr.lastT, dr.lastS, dr.rec]));
        ok("Rücken im Plan: 9 Sätze an 2 Tagen – Oberkörper 4 (Rudern), Brust und Rücken 5 (Latzug)",
          dr.sets === "9" && dr.dayN === "2" && dr.days.map(x => `${x.cap}: ${x.rows.join(" | ")}`).join(" || ") === "Oberkörper · 4 Sätze: hs-row: Rudern – 4 Sätze · Hauptmuskel || Brust und Rücken · 5 Sätze: hs-lat: Latzug – 5 Sätze · Hauptmuskel", JSON.stringify(dr.days));
        // Beine vorn: vor 4 Tagen an der Beinpresse → länger als 72 Stunden her → 100 %, „Erholt“
        await page.click("#navbar .nb-back"); await page.click("#mk-beinev");
        const dv = await readDetail(page);
        ok("Zuletzt trainiert (Beine vorn): vor 4 Tagen, Training „Beine“, Beinpresse; Erholung „Erholt“",
          dv.lastT === `${dateTxt(4)} · vor 4 Tagen` && dv.lastS === "Training „Beine“ · Beinpresse" && dv.recVal === "Erholt" && /width:\s*100%/.test(dv.recW) && dv.rec.includes("Schätzung der App"), JSON.stringify([dv.lastT, dv.lastS, dv.rec, dv.recW]));
        // Schultern: nur halbe Sätze an zwei Tagen – Oberkörper 1,5 + 2 + 3 = 6,5; Brust und Rücken 1,5 + 2 + 1 = 4,5
        await page.click("#navbar .nb-back"); await page.click("#mk-schultern");
        const ds = await readDetail(page);
        ok("Schultern im Plan: Oberkörper 6,5 Sätze (Brustpresse und Rudern halb, Schulterpresse voll), Brust und Rücken 4,5 Sätze (alles halb) – zusammen 11",
          ds.sets === "11" && ds.days.map(x => x.cap).join(" | ") === "Oberkörper · 6,5 Sätze | Brust und Rücken · 4,5 Sätze" && ds.days[0].rows.join(" | ") === "hs-chest: Brustpresse – 3 Sätze · mittrainiert, zählt halb | hs-row: Rudern – 4 Sätze · mittrainiert, zählt halb | hs-shoulder: Schulterpresse – 3 Sätze · Hauptmuskel", JSON.stringify(ds.days));
        // Muskel ohne Sätze und ohne Training: Waden
        await page.click("#navbar .nb-back"); await page.click("#mk-waden");
        const dw = await readDetail(page), freeW = await freeTextOn(page);
        ok("Muskel ohne Sätze (Waden): „Kommt im Plan nicht vor.“ – ohne Wertung, ohne Kennzahlen und ohne Aufforderung", dw.none === "Kommt im Plan nicht vor." && dw.sets === null && dw.days.length === 0 && dw.rule === null && !(await page.$("#mkInPlan button")), JSON.stringify([dw.none, dw.sets]));
        ok("… ohne Training im Verlauf: Hinweis statt Datum, keine Erholungszeile; Geräte: Wadenheben stehend und sitzend, kein Abschnitt „Unterstützend“",
          dw.never === "Im Verlauf steht noch kein Training für Waden." && dw.lastT === null && dw.rec === null && dw.main === "hs-calf,hs-seatcalf" && dw.mainCap === "Hauptsächlich · 2" && !dw.hasSup && freeW.length === 0, JSON.stringify([dw.never, dw.main, freeW]));
        // Zurück: Detailseite → Übersicht → Wissen (Artikel)
        await page.click("#navbar .nb-back");
        const b1 = await page.textContent("#app h1");
        await page.click("#navbar .nb-back");
        const b2 = await tp(page, () => ({ title: document.querySelector("#app h1").textContent, seg: document.querySelector("#wissenSeg .on").textContent, row: !!document.querySelector("#row-muskeln") }));
        ok("Zurück führt von der Detailseite zur Übersicht und von dort zu Wissen → Artikel", b1 === "Muskeln" && b2.title === "Wissen" && b2.seg === "Artikel" && b2.row, JSON.stringify([b1, b2]));
        // Die Geräteseite der App behält ihren üblichen Rückweg
        await page.click("#wissenSeg [data-v=lib]"); await page.click("#libList .li[data-id=hs-chest]"); await page.click("#navbar .nb-back");
        ok("Geräteseite aus der Geräteliste: Zurück führt weiter zur Geräteliste", await page.isVisible("#libList") && (await page.textContent("#app h1")) === "Wissen");
        // Balken wie in der Planprüfung: dieselben Stile und Zahlen für die sechs großen Muskelgruppen
        await page.click("nav.tabs [data-v=plan]");
        const pb = await tp(page, () => Object.fromEntries([...document.querySelectorAll("#planBars .mrow")].map(r => [r.dataset.m, { band: r.querySelector(".mband").getAttribute("style"), fill: r.querySelector(".mfill").getAttribute("style"), val: r.querySelector(".num").textContent }])));
        ok("Richtwert-Balken wie in der Planprüfung: gleicher heller Bereich, gleiche Länge, gleiche Farbe und gleiche Zahl (Brust, Rücken, Schultern, Beine vorn, Beine hinten, Po)",
          Object.keys(pb).join() === "brust,ruecken,schultern,beinev,beineh,po" && Object.keys(pb).every(m => pb[m].band === R[m].band && pb[m].fill === R[m].fill && pb[m].val === R[m].val), JSON.stringify([pb.brust, R.brust]));
        ok("Nur Anzeige: Plan, Verlauf und alle anderen Daten bleiben unverändert; die Erweiterung speichert nichts", (await tp(page, () => JSON.stringify(window.__tp.state))) === state0 && !("muskeln" in (await tp(page, () => window.__tp.state.x))));
        await ctx.close();
      }
      {
        // Mit festen Terminen zählt die Planprüfung Termine pro Woche: 6 Termine bei 3 Trainingstagen = jeder Tag zweimal.
        // Brust 22 (über 20: orange, 22/26 = 84,62 %), Rücken 18 (im Richtwert), Beine vorn 8 (darunter), Bizeps 13
        const { ctx, page } = await open({ plan: MK_PLAN, history: [], sched: { days: [0, 1, 2, 3, 4, 5], time: "18:00", planB: "next" } });
        const openMk = async () => { await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]"); await page.click("#row-muskeln"); };
        await openMk();
        const ov = await readOverview(page), R = ov.rows;
        ok("Feste Termine (6 pro Woche, 3 Trainingstage): alle Werte doppelt – Brust 22, Rücken 18, Bizeps 13, Beine vorn 8",
          R.brust.val === "22" && R.ruecken.val === "18" && R.bizeps.val === "13" && R.beinev.val === "8" && R.bauch.val === "0" && ov.foot.includes("6 Termine pro Woche"), JSON.stringify([R.brust.val, R.ruecken.val, R.bizeps.val, R.beinev.val, ov.foot]));
        ok("Über dem Richtwert: Balken orange (Brust 22/26 = 84,62 %), im Richtwert grün (Rücken 18), darunter blau (Beine vorn 8); Brust in der Figur mit voller Farbe",
          near(pct(R.brust.fill), 2200 / 26) && R.brust.fill.includes("var(--warn)") && R.ruecken.fill.includes("var(--ok)") && R.beinev.fill.includes("var(--accent)") && ov.shades.includes("var(--mhot) 1"), JSON.stringify([R.brust.fill, R.ruecken.fill, R.beinev.fill, ov.shades]));
        await page.click("#mk-brust");
        const d = await readDetail(page);
        ok("Detailseite erklärt die Rechnung: Tage zusammen 11 Sätze, bei 6 Terminen und 3 Trainingstagen 22 pro Woche",
          d.sets === "22" && d.days.map(x => x.cap).join(" | ") === "Oberkörper · 3 Sätze | Brust und Rücken · 8 Sätze" && d.rule === "Sätze pro Woche: Hauptmuskel voll, mittrainierte halb gezählt, 6 Termine pro Woche. Die Tage zusammen ergeben 11 Sätze. Bei 6 Terminen pro Woche und 3 Trainingstagen sind das 22 pro Woche.", d.rule);
        await page.click("nav.tabs [data-v=plan]");
        const pb = await tp(page, () => Object.fromEntries([...document.querySelectorAll("#planBars .mrow")].map(r => [r.dataset.m, { band: r.querySelector(".mband").getAttribute("style"), fill: r.querySelector(".mfill").getAttribute("style"), val: r.querySelector(".num").textContent }])));
        ok("… und die Balken stimmen auch mit Terminen mit der Planprüfung überein", Object.keys(pb).length === 6 && Object.keys(pb).every(m => pb[m].band === R[m].band && pb[m].fill === R[m].fill && pb[m].val === R[m].val), JSON.stringify([pb.brust, R.brust]));
        // 4 Termine bei 3 Trainingstagen: Brust 11 × 4/3 = 14,67 → auf halbe Sätze 14,5 („rund“); Rücken 9 × 4/3 = 12 (glatt)
        await tp(page, () => { window.__tp.state.sched.days = [0, 1, 3, 5]; });
        await openMk();
        const ov4 = await readOverview(page);
        await page.click("#mk-brust");
        const d4 = await readDetail(page);
        await page.click("#navbar .nb-back"); await page.click("#mk-ruecken");
        const d4r = await readDetail(page);
        ok("4 Termine bei 3 Trainingstagen: Brust 11 × 4/3 = 14,67 → „14,5“ und im Text „rund 14,5“; Rücken 9 × 4/3 = 12 ohne „rund“",
          ov4.rows.brust.val === "14,5" && ov4.rows.ruecken.val === "12" && d4.sets === "14,5" && d4.rule.endsWith("Die Tage zusammen ergeben 11 Sätze. Bei 4 Terminen pro Woche und 3 Trainingstagen sind das rund 14,5 pro Woche.")
          && d4r.sets === "12" && d4r.rule.endsWith("Die Tage zusammen ergeben 9 Sätze. Bei 4 Terminen pro Woche und 3 Trainingstagen sind das 12 pro Woche."), JSON.stringify([ov4.rows.brust.val, d4.rule, d4r.rule]));
        // Ziel „Kraft“ ohne Termine: Richtwert der App 6–12, Maßstab 15,6. Brust 11/15,6 = 70,51 % (im Richtwert), Beine vorn 4 (darunter); volle Farbe ab 12 → Brust 25 + 75 × 11/12 = 93,75 → 0,94
        await tp(page, () => { window.__tp.state.sched = null; window.__tp.state.plan.goal = "kraft"; });
        await openMk();
        const ovK = await readOverview(page);
        ok("Ziel „Kraft“: Richtwert der App 6–12 wie in der Planprüfung – heller Bereich 6/15,6 = 38,46 %, Brust 11/15,6 = 70,51 % grün, Beine vorn 4 blau; Figur mit voller Farbe ab 12",
          near(left(ovK.rows.brust.band), 600 / 15.6) && near(pct(ovK.rows.brust.fill), 1100 / 15.6) && ovK.rows.brust.fill.includes("var(--ok)") && ovK.rows.beinev.fill.includes("var(--accent)")
          && ovK.foot.includes("Richtwert der App für Kraft, 6–12 Sätze.") && ovK.topFoot === "Farbe: Sätze pro Woche im Plan. Volle Farbe ab 12 Sätzen." && ovK.shades.includes("var(--mhot) 0.94"), JSON.stringify([ovK.rows.brust, ovK.foot, ovK.shades]));
        await ctx.close();
      }
      {
        // Leerer Plan (ein Tag ohne Übungen), kaputter gespeicherter Wert, eigenes Gerät mit Sonderzeichen, Verlauf nur mit einem gelöschten Gerät
        const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Leer", items: [] }] }, x: { muskeln: "Unsinn" },
          custom: [{ id: "c-mk1", name: "Wade <b>X</b> & Co", muscle: "waden", sec: ["bauch"], type: "plate" }], history: [mh(1, "a", "Alt", [["c-geloescht", "Gelöschtes Gerät"]])] });
        await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]"); await page.click("#row-muskeln");
        const ov = await readOverview(page), free1 = await freeTextOn(page), w1 = await at320(page);
        ok("Leerer Plan: Die Übersicht öffnet sich trotz kaputtem gespeichertem Wert; Hinweis statt Legende, graue Figur, keine Balken und keine Zahlen",
          ov.title === "Muskeln" && ov.empty === "Dein Plan hat noch keine Übungen. Mit Übungen im Plan zeigt die Figur die Sätze pro Woche je Muskel." && ov.legend === null && ov.topFoot === null && ov.shades === "grau" && Object.values(ov.rows).every(r => r.val === null && r.band === null), JSON.stringify([ov.empty, ov.legend, ov.shades]));
        ok("Leerer Plan: Liste „Muskelgruppen“ mit der Zahl der Geräte (Waden mit dem eigenen Gerät 3), ohne „Kommt im Plan nicht vor“",
          ov.head === "Muskelgruppen" && ov.order.split(",").length === 11 && ov.rows.brust.sub === "8 Geräte" && ov.rows.waden.sub === "3 Geräte" && ov.foot === "Geräte: alle in der App mit diesem Hauptmuskel.", JSON.stringify([ov.head, ov.rows.waden.sub, ov.foot]));
        ok("Leerer Plan: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", free1.length === 0 && w1.r, free1.join(" | ") + w1.who);
        await page.click("#mk-bauch");
        const d = await readDetail(page), free2 = await freeTextOn(page), w2 = await at320(page);
        const cust = await tp(page, () => { const l = document.querySelector('#mkSup .li[data-id="c-mk1"]'); return l && { t: l.querySelector(".t").textContent, b: !!l.querySelector(".t b"), ph: !!l.querySelector(".thumbbox.mk-noth svg") }; });
        ok("Detailseite bei leerem Plan (Bauch): „Kommt im Plan nicht vor.“, kein Training im Verlauf, Geräte der App bleiben sichtbar",
          d.title === "Bauch" && d.none === "Kommt im Plan nicht vor." && d.never === "Im Verlauf steht noch kein Training für Bauch." && d.main === "hs-ab,lf-ab" && d.sup === "c-mk1" && d.supCap === "Unterstützend · 1", JSON.stringify([d.none, d.never, d.main, d.sup]));
        ok("Eigenes Gerät: Name wird als Text gezeigt (kein HTML), ohne Bild steht ein Platzhalter", !!cust && cust.t === "Wade <b>X</b> & Co" && !cust.b && cust.ph, JSON.stringify(cust));
        ok("Detailseite bei leerem Plan: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", free2.length === 0 && w2.r, free2.join(" | ") + w2.who);
        // Gelöschtes eigenes Gerät im Verlauf: sein Muskel ist nicht mehr bekannt → zählt für keinen Muskel als „zuletzt trainiert“
        const lasts = await tp(page, () => Object.keys(window.__tp.MUSCLES).filter(m => window.__tp.mkLast(m)).join());
        ok("Ein gelöschtes Gerät im Verlauf zählt für keinen Muskel als „zuletzt trainiert“", lasts === "", lasts);
        ok("Kaputter gespeicherter Wert: Die Erweiterung legt keinen Speicherbereich an", !("muskeln" in (await tp(page, () => window.__tp.state.x))));
        // Neu laden: nichts gespeichert, die Seite öffnet sich wieder
        await page.reload();
        await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]"); await page.click("#row-muskeln"); await page.click("#mk-waden");
        const dr = await readDetail(page);
        ok("Nach dem Neuladen öffnen sich Übersicht und Detailseite wieder (Waden: eigenes Gerät unter „Hauptsächlich“)", dr.title === "Waden" && dr.main === "hs-calf,hs-seatcalf,c-mk1" && dr.mainCap === "Hauptsächlich · 3", JSON.stringify([dr.title, dr.main]));
        // Ganz ohne Plan (die App zeigt dann sonst die Planerstellung): beide Ansichten zeichnen ohne Fehler
        const np = await tp(page, () => { const T = window.__tp; T.state.plan = null; T.EXT.views.muskeln(); const a = document.querySelector("#mkEmpty").textContent, rows = document.querySelectorAll("#mkList .li").length;
          T.EXT.views.muskel(); return { a, rows, b: document.querySelector("#mkNone").textContent, h: document.querySelector("#app h1").textContent }; });
        ok("Ohne Plan: Übersicht und Detailseite zeigen „Du hast noch keinen Plan.“", np.a.startsWith("Du hast noch keinen Plan.") && np.rows === 11 && np.b === "Du hast noch keinen Plan." && np.h === "Waden", JSON.stringify(np));
        await ctx.close();
      }
      {
        // Abstand in Kalendertagen über die Zeitumstellung hinweg (Berlin, 29. März 2026: der Tag hat 23 Stunden) und über den Jahreswechsel
        const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, timezoneId: "Europe/Berlin", serviceWorkers: "block" });
        await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); localStorage.setItem("tp-intro", "0"); localStorage.setItem("tp-tabmem", "0"); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify({ plan: PLAN_SMALL })]);
        const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message)); await page.goto(URL);
        const a = await tp(page, () => { const f = window.__tp.mkAgo; return [f("2026-03-27T12:00:00+01:00", new Date("2026-03-30T08:00:00+02:00")), f("2026-03-29T01:30:00+01:00", new Date("2026-03-30T08:00:00+02:00")),
          f("2026-03-30T06:00:00+02:00", new Date("2026-03-30T23:30:00+02:00")), f("2025-12-31T23:30:00+01:00", new Date("2026-01-01T00:10:00+01:00")), f("2026-10-23T12:00:00+02:00", new Date("2026-10-26T08:00:00+01:00"))]; });
        ok("Abstand in Kalendertagen stimmt über die Zeitumstellung: 27. → 30. März „vor 3 Tagen“, 29. → 30. März „gestern“, gleicher Tag „heute“, Silvester → Neujahr „gestern“, 23. → 26. Oktober „vor 3 Tagen“",
          a.join(" | ") === "vor 3 Tagen | gestern | heute | gestern | vor 3 Tagen", a.join(" | "));
        await ctx.close();
      }
    }
    // @ext:muskeln:test:end
    // ── Abstand muskeln/test 1 ──
    // ── Abstand muskeln/test 2 ──
    // ── Abstand muskeln/test 3 ──
    // @ext:plaene:test:start
    section("E-plaene. Meine Pläne (Plan → Meine Pläne)");
    {
      const it = (id, exId, sets, extra) => Object.assign({ id, exId, sets, rmin: 8, rmax: 12, rest: 90 }, extra || {});
      // Von Hand gezählt: 2 Tage · hs-chest, hs-row, hs-legpress = 3 verschiedene Geräte (hs-chest an beiden Tagen zählt einmal) · 3 + 2 + 4 + 1 = 10 Sätze
      const P2 = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "da", name: "Oben", items: [it("a1", "hs-chest", 3), it("a2", "hs-row", 2)] },
        { id: "db", name: "Unten", items: [it("b1", "hs-legpress", 4), it("b2", "hs-chest", 1)] }], gaps: [] };
      // Geänderter Stand: 3 Tage (einer leer) · hs-chest, hs-fly = 2 Geräte · 5 + 2 = 7 Sätze
      const P3 = { goal: "kraft", level: "einsteiger", minutes: 45, days: [
        { id: "da", name: "Oben neu", items: [it("a1", "hs-chest", 5)] }, { id: "db", name: "Unten", items: [] }, { id: "neu", name: "Neu", items: [it("n1", "hs-fly", 2)] }], gaps: [] };
      const IDOK = /^[A-Za-z0-9_-]{1,24}$/;
      const plnGo = async page => { await page.click("nav.tabs [data-v=plan]"); await page.click("#row-plaene"); };
      const today = page => tp(page, () => ({ key: window.__tp.dkey(), txt: new Date().toLocaleDateString("de-DE", { day: "numeric", month: "long" }) }));
      const mem = page => tp(page, () => JSON.parse(JSON.stringify(window.__tp.state)));
      const lst = async page => (await mem(page)).x.plaene.list;
      const at320 = async page => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; };
      const code = o => "TP1:" + Buffer.from(JSON.stringify(o), "utf8").toString("base64");
      // Kopf eines Formular-Fensters bei 320 px: kleinster Abstand zwischen den Texten „Abbrechen“, Titel und Aktion (unter 0 = sie überlappen)
      const headGap = async page => { await page.setViewportSize({ width: 320, height: 640 });
        const g = await tp(page, () => { const h = document.querySelector(".sheet .sh-head"), box = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
          const l = box(h.querySelector(".sh-l")), t = box(h.querySelector("h2")), b = box(h.querySelector(".btn:not(.sh-l)")); return Math.min(t.left - l.right, b.left - t.right); });
        await page.setViewportSize({ width: 360, height: 780 }); return g; };
      // Aktionsblatt: Titel, Text und Knöpfe (rote mit „!“)
      const asheet = page => tp(page, () => { const s = document.querySelector(".sheet.as"); return s ? { t: s.querySelector(".as-t").textContent, m: (s.querySelector(".as-m") || {}).textContent || "",
        btn: [...s.querySelectorAll(".as-btn")].map(b => b.textContent + (b.classList.contains("danger") ? "!" : "")).join("|") } : { t: "", m: "", btn: "" }; });
      {
        // Zeile, Unterseite, leerer Zustand, sichern, Neuladen
        const { ctx, page } = await open({ plan: P2, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 9 }], 3, "s")], weights: [{ d: "2026-10-01", kg: 80 }], notes: { "hs-chest": "Sitz 4" } });
        await page.click("nav.tabs [data-v=plan]");
        const row = await tp(page, () => { const r = document.querySelector("#planMore .group #row-plaene"); return r && { t: r.querySelector(".t").textContent, val: !!r.querySelector(".val"), ico: !!r.querySelector(".ico svg") }; });
        ok("Plan → „Rund um den Plan“: Zeile „Meine Pläne“ mit Symbol, ohne Zahl, solange nichts gesichert ist", !!row && row.t === "Meine Pläne" && !row.val && row.ico, JSON.stringify(row));
        await page.click("#row-plaene");
        const v = await tp(page, () => ({ title: document.querySelector("#app h1").textContent, h1: document.querySelectorAll("#app h1").length, back: document.querySelector("#navbar .nb-back").textContent.trim(), tab: document.querySelector("#tabs button.on").dataset.v,
          nums: [...document.querySelectorAll("#plnNow .stat")].map(s => s.querySelector(".cap").textContent + " " + s.querySelector(".num").textContent).join(), thumbs: document.querySelectorAll("#plnNow .tstrip svg").length,
          state: document.getElementById("plnState").textContent, empty: !!document.getElementById("plnEmpty"), list: !!document.getElementById("plnList"), paste: document.getElementById("plnPaste").textContent, prim: document.querySelectorAll("#app .btn.primary").length }));
        ok("Unterseite „Meine Pläne“ mit „‹ Plan“ und einer Überschrift; der Bereich bleibt „Plan“", v.title === "Meine Pläne" && v.h1 === 1 && v.back === "Plan" && v.tab === "plan", JSON.stringify(v));
        ok("Karte „Aktueller Plan“: 2 Tage, 3 verschiedene Geräte, 10 Sätze (von Hand gezählt), dazu drei Gerätebilder", v.nums === "Tage 2,Geräte 3,Sätze 10" && v.thumbs === 3 && v.prim === 1, JSON.stringify(v));
        ok("Leerer Zustand: Hinweiskarte statt Liste, „Noch nicht gesichert.“, Einfügen bleibt erreichbar", v.empty && !v.list && v.state === "Noch nicht gesichert." && v.paste === "Plan aus Text einfügen", JSON.stringify(v));
        ok("Leere Seite: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", (await freeTextOn(page)).length === 0 && await at320(page), (await freeTextOn(page)).join(" | "));
        const d = await today(page);
        await page.click("#plnSave");
        const sh = await tp(page, () => ({ title: document.querySelector(".sheet h2").textContent, cancel: (document.querySelector(".sheet .sh-l") || {}).textContent, val: document.getElementById("plnNameIn").value,
          okTxt: (document.querySelector(".sheet .sh-head [data-a=plnSaveDo]") || {}).textContent }));
        ok("„Aktuellen Plan sichern“ fragt nach dem Namen, Vorschlag „Plan vom <heute>“", sh.title === "Plan sichern" && sh.cancel === "Abbrechen" && sh.okTxt === "Speichern" && sh.val === `Plan vom ${d.txt}`, JSON.stringify(sh));
        const g1 = await headGap(page);
        // Breitere Schrift (andere Geräte, andere Systemschrift): Titel und Knöpfe dürfen sich auch dann nicht überlappen
        await page.addStyleTag({ content: ".sheet .sh-head .btn{letter-spacing:.09em} .sheet .sh-head h2{letter-spacing:.07em}" });
        const g1w = await headGap(page);
        ok("Fensterkopf bei 320 px auch mit deutlich breiterer Schrift ohne Überlappung", g1w >= 4, String(g1w));
        await page.evaluate(() => document.head.lastElementChild.remove());
        ok("Fenster „Plan sichern“ bei 320 px: Titel und Knöpfe überlappen nicht, kein seitliches Scrollen", g1 >= 4 && await at320(page), String(g1));
        await page.fill("#plnNameIn", "   "); await page.click("[data-a=plnSaveDo]");
        ok("Leerer Name: Fehlertext, nichts wird gesichert", await page.isVisible("#plnErr") && (await lst(page)).length === 0 && !!(await page.$(".sheet")));
        await page.fill("#plnNameIn", "Sommer");
        ok("Weitertippen blendet den Fehlertext aus", await page.isHidden("#plnErr"));
        await page.click("[data-a=plnSaveDo]");
        const L1 = (await stored(page)).x.plaene.list;
        ok("Sichern legt eine Kopie des Plans an: Name, Datum von heute, Tage und Geräte wie im Plan", L1.length === 1 && L1[0].name === "Sommer" && L1[0].saved === d.key && IDOK.test(L1[0].id) && canon(L1[0].plan) === canon(P2) && !(await page.$(".sheet")), JSON.stringify(L1));
        const li = await tp(page, () => { const r = document.querySelector("#plnList .li"); return { n: document.querySelectorAll("#plnList .li").length, t: r.querySelector(".t").textContent, s: [...r.querySelectorAll(".s")].map(x => x.textContent).join("|"),
          badge: (r.querySelector(".badge") || {}).textContent, state: document.getElementById("plnState").textContent, note: (document.getElementById("plnNote") || {}).textContent, count: document.getElementById("plnCount").textContent }; });
        ok("Der Plan erscheint in der Liste: Name, „2 Tage · 3 Geräte“, gesichert am heutigen Tag, Marke „Aktuell“", li.n === 1 && li.t === "Sommer" && li.s === `2 Tage · 3 Geräte|Gesichert am ${d.txt}` && li.badge === "Aktuell" && li.count === "1 von 12", JSON.stringify(li));
        ok("Die Karte nennt den Stand („Gesichert als „Sommer“.“), oben steht die Meldung", li.state === "Gesichert als „Sommer“." && li.note === "„Sommer“ gesichert.", JSON.stringify(li));
        await page.reload();
        await page.click("nav.tabs [data-v=plan]");
        ok("Nach dem Neuladen zeigt die Zeile die Anzahl 1", (await page.textContent("#row-plaene .val")) === "1");
        await page.click("#row-plaene");
        const L2 = await lst(page);
        ok("Der gesicherte Plan übersteht das Neuladen", L2.length === 1 && canon(L2) === canon(L1) && (await page.textContent("#plnList .li .t")) === "Sommer" && !(await page.$("#plnNote")), JSON.stringify(L2));
        ok("Gefüllte Seite: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", (await freeTextOn(page)).length === 0 && await at320(page), (await freeTextOn(page)).join(" | "));
        await page.click("#navbar .nb-back");
        ok("Zurück führt zum Plan", (await page.textContent("#app h1")) === "Mein Plan");
        await ctx.close();
      }
      {
        // Plan ändern → Laden stellt den gesicherten Stand her; Rückfrage; „vorher sichern“; Verlauf bleibt
        const { ctx, page } = await open({ plan: P3, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3, "s"), hist("hs-row", [{ kg: 30, reps: 8 }], 1, "s")], weights: [{ d: "2026-10-01", kg: 80 }], notes: { "hs-chest": "Sitz 4" },
          selDay: "neu", timeplan: { dayId: "neu", date: "2026-01-01", minutes: 30, keep: { n1: 1 }, replace: {} }, prevPlan: { at: "2026-10-01T10:00:00.000Z", why: "Test", plan: P2 },
          sched: { id: "t1", days: [0, 2, 4], time: "18:00", planB: "next", since: "2026-01-01T10:00:00.000Z" },
          dayPlan: { "2099-01-05": { train: "neu" }, "2099-01-06": { train: "rest" }, "2099-01-07": { train: "da", steps: 5000 } },
          x: { plaene: { list: [{ id: "s1", name: "Alt", saved: "2001-03-04", plan: P2 }] } } });
        const before = await mem(page), d = await today(page);
        await plnGo(page);
        const li = await tp(page, () => { const r = document.querySelector("#plnList .li"); return { s: [...r.querySelectorAll(".s")].map(x => x.textContent).join("|"), badge: !!r.querySelector(".badge"), state: document.getElementById("plnState").textContent,
          nums: [...document.querySelectorAll("#plnNow .stat .num")].map(x => x.textContent).join() }; });
        ok("Geänderter Plan: 3 Tage, 2 Geräte, 7 Sätze; „Noch nicht gesichert.“; der gesicherte Plan ist nicht „Aktuell“ und zeigt sein Datum mit Jahr", li.nums === "3,2,7" && li.state === "Noch nicht gesichert." && !li.badge && li.s === "2 Tage · 3 Geräte|Gesichert am 4. März 2001", JSON.stringify(li));
        await page.click("#plnList [data-id=s1]");
        const as = await asheet(page);
        ok("Antippen öffnet das Aktionsblatt: Laden, Umbenennen, Duplizieren, Als Text teilen, Löschen (rot), Abbrechen", as.t === "Alt" && as.m.includes("2 Tage · 3 Geräte") && as.btn === "Laden|Umbenennen|Duplizieren|Als Text teilen|Löschen!|Abbrechen", JSON.stringify(as));
        await page.click(".sheet.as [data-a=plnLoadAsk]");
        const q = await asheet(page);
        ok("„Laden“ fragt nach und sagt, was passiert: Der aktuelle Plan wird ersetzt; Verlauf, Gewichte und Notizen bleiben", q.t === "„Alt“ laden?" && q.m.includes("Dein aktueller Plan wird ersetzt") && q.m.includes("noch nicht gesichert") && q.m.includes("Verlauf, Gewichte und Notizen bleiben erhalten"), JSON.stringify(q));
        ok("Angeboten wird „Vorher sichern und laden“, daneben „Ohne Sichern laden“ (rot) und „Abbrechen“", q.btn === "Vorher sichern und laden|Ohne Sichern laden!|Abbrechen", q.btn);
        await page.click(".sheet.as .as-cancel");
        ok("Abbrechen ändert nichts", canon((await mem(page)).plan) === canon(P3) && (await lst(page)).length === 1 && !(await page.$(".sheet")));
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnLoadAsk]"); await page.click(".sheet.as [data-a=plnLoadKeep]");
        const st = await stored(page), L = st.x.plaene.list;
        ok("Laden stellt den gesicherten Stand her: Tage, Geräte, Sätze, Wiederholungen und Pausen wie gesichert", canon(st.plan) === canon(P2), JSON.stringify(st.plan));
        ok("„Vorher sichern“ legt einen zweiten Eintrag mit dem bisherigen Plan an (oben, „Plan vom <heute>“)", L.length === 2 && L[0].name === `Plan vom ${d.txt}` && L[0].saved === d.key && canon(L[0].plan) === canon(P3) && L[1].id === "s1" && canon(L[1].plan) === canon(P2), JSON.stringify(L.map(e => [e.id, e.name, e.saved])));
        ok("Verlauf, Gewichte und Notizen bleiben unverändert", st.history.length === 2 && canon(st.history) === canon(before.history) && canon(st.weights) === canon(before.weights) && canon(st.notes) === canon(before.notes) && st.notes["hs-chest"] === "Sitz 4");
        ok("Was auf Tage des alten Plans zeigte, ist gelöst: gewähltes Training, Zeitanpassung, „Rückgängig“ einer Planänderung", before.selDay === "neu" && !!before.timeplan && !!before.prevPlan && st.selDay === null && st.timeplan === null && st.prevPlan === null, JSON.stringify([st.selDay, st.timeplan, st.prevPlan]));
        ok("Tagesplan: Der Verweis auf den entfallenen Tag ist weg; Ruhetag, ein weiter vorhandener Tag und die Termine bleiben", !st.dayPlan["2099-01-05"] && st.dayPlan["2099-01-06"].train === "rest" && st.dayPlan["2099-01-07"].train === "da" && st.dayPlan["2099-01-07"].steps === 5000 && canon(st.sched) === canon(before.sched), JSON.stringify(st.dayPlan));
        const pv = await tp(page, () => ({ h1: document.querySelector("#app h1").textContent, note: (document.getElementById("planNote") || {}).textContent || "", undo: !!document.querySelector("#planNote [data-a=dayCopyUndo]"), sheet: !!document.querySelector(".sheet"),
          days: [...document.querySelectorAll("#planDays .day-row .t")].map(x => x.textContent).join() }));
        ok("Danach steht man auf der Plan-Seite: geladener Plan und eine Meldung, die beide Schritte nennt", pv.h1 === "Mein Plan" && pv.days === "Oben,Unten" && pv.note.includes("Plan „Alt“ geladen.") && pv.note.includes(`als „Plan vom ${d.txt}“ gesichert`) && !pv.undo && !pv.sheet, JSON.stringify(pv));
        await page.click("#row-plaene");
        const a2 = await tp(page, () => ({ rows: [...document.querySelectorAll("#plnList .li")].map(r => r.querySelector(".t").textContent + ":" + ((r.querySelector(".badge") || {}).textContent || "")).join("|"), state: document.getElementById("plnState").textContent }));
        ok("Der geladene Plan ist in der Liste als „Aktuell“ markiert, die Karte nennt ihn", a2.rows === `Plan vom ${d.txt}:|Alt:Aktuell` && a2.state === "Gesichert als „Alt“.", JSON.stringify(a2));
        await page.click("#plnSave");
        ok("Der Namensvorschlag weicht aus, wenn es ihn schon gibt („… 2“)", (await page.inputValue("#plnNameIn")) === `Plan vom ${d.txt} 2`, await page.inputValue("#plnNameIn"));
        await page.click(".sheet .sh-l");
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnLoadAsk]");
        const q2 = await asheet(page);
        ok("Den aktuellen Plan noch einmal laden: Hinweis statt Rückfrage", q2.m === "Das ist schon dein aktueller Plan." && q2.btn === "OK", JSON.stringify(q2));
        await page.click(".sheet.as .as-cancel");
        await page.click("#plnList .li >> nth=0"); await page.click(".sheet.as [data-a=plnLoadAsk]");
        const q3 = await asheet(page);
        ok("Steht der aktuelle Plan schon unverändert in der Liste, wird nur „Laden“ angeboten", q3.m.includes("Er ist als „Alt“ gesichert.") && q3.btn === "Laden|Abbrechen", JSON.stringify(q3));
        await page.click(".sheet.as [data-a=plnLoadDo]");
        const st2 = await stored(page);
        ok("Zurückwechseln: Der vorher gesicherte Stand ist wieder da, die Liste bleibt bei zwei Einträgen, der Verlauf bleibt", canon(st2.plan) === canon(P3) && st2.x.plaene.list.length === 2 && canon(st2.history) === canon(before.history), JSON.stringify(st2.plan));
        await ctx.close();
      }
      {
        // Umbenennen, Duplizieren, Löschen
        const { ctx, page } = await open({ plan: P3, x: { plaene: { list: [{ id: "s1", name: "Alt", saved: "2001-03-04", plan: P2 }, { id: "s2", name: "Zweiter", saved: "2001-03-05", plan: PLAN_SMALL }] } } });
        const d = await today(page);
        await plnGo(page);
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnRenameOpen]");
        const g2 = await headGap(page);
        ok("Umbenennen: Fenster mit dem bisherigen Namen im Feld; bei 320 px überlappt im Kopf nichts", (await page.inputValue("#plnNameIn")) === "Alt" && (await page.textContent(".sheet h2")) === "Neuer Name" && g2 >= 4, String(g2));
        await page.fill("#plnNameIn", ""); await page.click("[data-a=plnRenameDo]");
        ok("Leerer Name wird abgelehnt, der alte bleibt", await page.isVisible("#plnErr") && (await lst(page))[0].name === "Alt");
        await page.fill("#plnNameIn", "  Größe & Kraft 💪  "); await page.click("[data-a=plnRenameDo]");
        const r1 = (await stored(page)).x.plaene.list;
        ok("Umbenennen speichert den neuen Namen (Umlaute, Emoji, ohne Leerzeichen am Rand); sonst ändert sich nichts", r1.length === 2 && r1[0].name === "Größe & Kraft 💪" && r1[0].id === "s1" && r1[0].saved === "2001-03-04" && canon(r1[0].plan) === canon(P2)
          && (await page.textContent("#plnList [data-id=s1] .t")) === "Größe & Kraft 💪" && !(await page.$(".sheet")), JSON.stringify(r1[0]));
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnDup]");
        const r2 = (await stored(page)).x.plaene.list;
        ok("Duplizieren legt direkt darunter eine Kopie an: „… (Kopie)“, gleicher Plan, eigenes Kürzel, Datum von heute", r2.length === 3 && r2[1].name === "Größe & Kraft 💪 (Kopie)" && r2[1].id !== "s1" && IDOK.test(r2[1].id) && r2[1].saved === d.key && canon(r2[1].plan) === canon(P2) && r2[2].id === "s2"
          && (await page.$$eval("#plnList .li .t", x => x.map(e => e.textContent).join("|"))) === "Größe & Kraft 💪|Größe & Kraft 💪 (Kopie)|Zweiter", JSON.stringify(r2.map(e => e.name)));
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnDup]");
        ok("Eine zweite Kopie bekommt einen eigenen Namen („… (Kopie) 2“)", (await lst(page))[1].name === "Größe & Kraft 💪 (Kopie) 2");
        const fr = await tp(page, () => [window.__tp.plnFree("x".repeat(40), " (Kopie)"), window.__tp.plnFree("💪".repeat(50))]);
        ok("Lange Namen werden für den Zusatz gekürzt (32 + 8 = 40 Zeichen); gekürzt wird nach Zeichen, kein Emoji wird zerschnitten", fr[0] === "x".repeat(32) + " (Kopie)" && fr[1] === "💪".repeat(40), JSON.stringify(fr));
        await page.click("#plnList [data-id=s2]"); await page.click(".sheet.as [data-a=plnDelAsk]");
        const q = await asheet(page);
        ok("Löschen fragt nach und nennt den Plan", q.t === "Plan löschen?" && q.m.includes("„Zweiter“") && q.btn === "Löschen!|Abbrechen", JSON.stringify(q));
        await page.click(".sheet.as .as-cancel");
        ok("Abbrechen löscht nichts", (await lst(page)).length === 4 && !(await page.$(".sheet")));
        await page.click("#plnList [data-id=s2]"); await page.click(".sheet.as [data-a=plnDelAsk]"); await page.click(".sheet.as [data-a=plnDelDo]");
        const st3 = await stored(page), r3 = st3.x.plaene.list;
        ok("Bestätigen entfernt genau diesen Plan; der aktuelle Plan bleibt", r3.length === 3 && !r3.some(e => e.id === "s2") && canon(st3.plan) === canon(P3) && !(await page.$("#plnList [data-id=s2]")) && (await page.textContent("#plnNote")) === "„Zweiter“ gelöscht.", JSON.stringify(r3.map(e => e.name)));
        await page.reload();
        ok("Gelöscht bleibt gelöscht, umbenannt bleibt umbenannt (nach dem Neuladen)", (await lst(page)).map(e => e.name).join("|") === "Größe & Kraft 💪|Größe & Kraft 💪 (Kopie) 2|Größe & Kraft 💪 (Kopie)");
        await ctx.close();
      }
      {
        // Grenze: höchstens 12 Pläne
        const many = Array.from({ length: 14 }, (_, i) => ({ id: "m" + i, name: "Plan " + (i + 1), saved: "2001-03-04", plan: PLAN_SMALL }));
        const { ctx, page } = await open({ plan: P2, x: { plaene: { list: many } } });
        await plnGo(page);
        const f = await tp(page, () => ({ n: window.__tp.state.x.plaene.list.length, last: window.__tp.state.x.plaene.list[11].name, max: window.__tp.PLN_MAX, rows: document.querySelectorAll("#plnList .li").length, count: document.getElementById("plnCount").textContent,
          dis: document.getElementById("plnSave").disabled, state: document.getElementById("plnState").textContent }));
        ok("Grenze 12: Von 14 gespeicherten Einträgen bleiben die ersten 12", f.n === 12 && f.max === 12 && f.last === "Plan 12" && f.rows === 12 && f.count === "12 von 12", JSON.stringify(f));
        ok("Volle Liste: „Aktuellen Plan sichern“ ist gesperrt, die Karte sagt, warum", f.dis && f.state === "Alle 12 Plätze sind belegt. Lösche zuerst einen Plan.", JSON.stringify(f));
        await page.click("#plnList [data-id=m0]"); await page.click(".sheet.as [data-a=plnDup]");
        const q = await asheet(page);
        ok("Duplizieren bei voller Liste: Hinweis, nichts kommt dazu", q.t === "Kein Platz mehr" && q.m.includes("Alle 12 Plätze sind belegt") && q.btn === "OK" && (await lst(page)).length === 12, JSON.stringify(q));
        await page.click(".sheet.as .as-cancel");
        await page.click("#plnPaste"); await page.fill("#plnCodeIn", code({ app: "trainingsplan", typ: "plan", v: 1, name: "Neu", plan: P3 })); await page.click("[data-a=plnPasteDo]");
        ok("Einfügen bei voller Liste: Fehlertext im Fenster, nichts kommt dazu", await page.isVisible("#plnErr") && (await page.textContent("#plnErr")).includes("Alle 12 Plätze sind belegt") && (await lst(page)).length === 12 && !!(await page.$(".sheet #plnCodeIn")));
        await page.click(".sheet .sh-l");
        await page.click("#plnList [data-id=m0]"); await page.click(".sheet.as [data-a=plnLoadAsk]");
        const q2 = await asheet(page);
        ok("Laden bei voller Liste und ungesichertem Plan: klare Warnung statt „vorher sichern“", q2.m.includes("Er ist nicht gesichert und geht dabei verloren") && q2.m.includes("alle 12 Plätze sind belegt") && q2.btn === "Trotzdem laden!|Abbrechen", JSON.stringify(q2));
        await page.click(".sheet.as [data-a=plnLoadDo]");
        const st = await stored(page);
        ok("„Trotzdem laden“ lädt den Plan, die Liste bleibt bei 12", canon(st.plan.days) === canon(PLAN_SMALL.days) && st.x.plaene.list.length === 12 && (await page.textContent("#row-plaene .val")) === "12", JSON.stringify(st.plan.days));
        await ctx.close();
      }
      {
        // Läuft oder pausiert ein Training, bleibt der Plan, wie er ist
        const ses = { dayId: "da", dayName: "Oben", start: Date.now() - 300000, paused: Date.now() - 60000, idx: 0, phase: "set",
          list: [{ key: "k1", itemId: "a1", exId: "hs-chest", u: "s", rmin: 8, rmax: 12, rest: 90, sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: false }] }] };
        const { ctx, page } = await open({ plan: P2, session: ses, x: { plaene: { list: [{ id: "s1", name: "Alt", saved: "2001-03-04", plan: P2 }, { id: "s2", name: "Zweiter", saved: "2001-03-05", plan: PLAN_SMALL }] } } });
        await plnGo(page);
        ok("Während eines Trainings sagt die Seite, dass sich kein Plan laden lässt", !!(await mem(page)).session && (await page.textContent("#plnSaved .foot")).includes("Solange ein Training läuft, lässt sich kein Plan laden."));
        await page.click("#plnList [data-id=s2]"); await page.click(".sheet.as [data-a=plnLoadAsk]");
        const q = await asheet(page);
        ok("„Laden“ ist gesperrt: „Erst das laufende Training beenden.“", q.t === "Training läuft" && q.m === "Erst das laufende Training beenden." && q.btn === "OK", JSON.stringify(q));
        await tp(page, () => { window.__tp.EXT.actions.plnLoadDo(); window.__tp.EXT.actions.plnLoadKeep(); });
        const m1 = await mem(page);
        ok("Auch ein direkter Aufruf lädt nichts: Plan, Liste und Training unverändert", canon(m1.plan) === canon(P2) && m1.x.plaene.list.length === 2 && !!m1.session && (await page.textContent("#app h1")) === "Meine Pläne");
        await page.click(".sheet.as .as-cancel");
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnDelAsk]");
        const q2 = await asheet(page);
        await tp(page, () => window.__tp.EXT.actions.plnDelDo());
        ok("Der gesicherte Stand des aktuellen Plans lässt sich währenddessen nicht löschen", q2.m === "Erst das laufende Training beenden." && q2.btn === "OK" && (await lst(page)).length === 2, JSON.stringify(q2));
        await page.click(".sheet.as .as-cancel");
        await page.click("#plnList [data-id=s2]"); await page.click(".sheet.as [data-a=plnDelAsk]"); await page.click(".sheet.as [data-a=plnDelDo]");
        ok("Ein anderer gesicherter Plan lässt sich löschen, Sichern bleibt möglich", (await lst(page)).map(e => e.id).join() === "s1" && !(await page.$eval("#plnSave", b => b.disabled)));
        await ctx.close();
      }
      {
        // Als Text teilen und wieder einfügen (Rundreise), kaputte Texte
        const PX = { goal: "kraft", level: "fortgeschritten", minutes: 90, days: [
          { id: "r1", name: "Rücken & Füße 🦵", items: [it("x1", "hs-row", 4, { ss: "x2" }), it("x2", "hs-chest", 3), it("x3", "c-eig", 2)] },
          { id: "r2", name: "Öl „süß“ <b>fett</b>", items: [it("y1", "hs-legpress", 5, { rmin: 4, rmax: 6, rest: 180, ss: "y2" }), it("y2", "c-eig", 1)] }], gaps: [] };
        const NAME = "Übung macht den Meister 💪 – Größe";
        const { ctx, page } = await open({ plan: P2, custom: [{ id: "c-eig", name: "Eigenes Gerät", muscle: "brust", sec: [], type: "plate" }], x: { plaene: { list: [{ id: "s1", name: NAME, saved: "2001-03-04", plan: PX }] } } });
        await plnGo(page);
        // Zwischenablage und Teilen-Menü für den Test ersetzen (unabhängig von der Umgebung)
        await tp(page, () => { Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
          Object.defineProperty(navigator, "clipboard", { value: { writeText: t => { window.__clip = t; return Promise.resolve(); } }, configurable: true }); });
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnShareOpen]");
        const sh = await tp(page, () => ({ title: document.querySelector(".sheet h2").textContent, ro: document.getElementById("plnCodeOut").readOnly, code: document.getElementById("plnCodeOut").value, share: !!document.querySelector(".sheet [data-a=plnShare]"),
          own: (document.getElementById("plnOwn") || {}).textContent || "", txt: document.querySelector(".sheet").textContent }));
        const payload = JSON.parse(Buffer.from(sh.code.slice(4), "base64").toString("utf8"));
        ok("„Als Text teilen“ zeigt „TP1:“ + Base64 von JSON (UTF-8): Name und Plan, kein Verlauf", sh.title === "Plan teilen" && sh.ro && sh.code.startsWith("TP1:") && /^[A-Za-z0-9+/]+={0,2}$/.test(sh.code.slice(4)) && payload.name === NAME && payload.typ === "plan"
          && canon(payload.plan.days) === canon(PX.days) && Object.keys(payload).sort().join() === "app,name,plan,typ,v" && sh.txt.includes("keine Trainings"), JSON.stringify(Object.keys(payload)));
        ok("Hinweis auf das selbst angelegte Gerät im Plan; ohne Teilen-Menü des Geräts gibt es nur „Kopieren“", sh.own.startsWith("Ein selbst angelegtes Gerät ist dabei.") && !sh.share, sh.own);
        await page.click(".sheet [data-a=plnCopy]"); await sleep(60);
        ok("„Kopieren“ legt den Text in die Zwischenablage und meldet es", (await tp(page, () => window.__clip)) === sh.code && (await page.textContent("#plnShareMsg")) === "Kopiert." && await page.isVisible("#plnShareMsg"));
        await tp(page, () => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("nein")) }, configurable: true }));
        await page.click(".sheet [data-a=plnCopy]"); await sleep(60);
        const sel = await tp(page, () => { const t = document.getElementById("plnCodeOut"); return { act: document.activeElement === t, a: t.selectionStart, b: t.selectionEnd, n: t.value.length, msg: document.getElementById("plnShareMsg").textContent }; });
        ok("Verweigert der Browser die Zwischenablage, wird der Text markiert und die Meldung sagt es", sel.act && sel.a === 0 && sel.b === sel.n && sel.msg.includes("Der Text ist markiert"), JSON.stringify(sel));
        await tp(page, () => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
        await page.click(".sheet [data-a=plnCopy]"); await sleep(60);
        ok("Auch ganz ohne Zwischenablage: markieren statt Fehler", (await page.textContent("#plnShareMsg")).includes("Der Text ist markiert"));
        await page.click(".sheet .sh-head [data-a=closeSheet]");
        await tp(page, () => Object.defineProperty(navigator, "share", { value: d => { window.__shared = d; return Promise.resolve(); }, configurable: true }));
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnShareOpen]"); await page.click(".sheet [data-a=plnShare]"); await sleep(60);
        ok("Gibt es das Teilen-Menü, reicht „Teilen …“ denselben Text weiter", canon(await tp(page, () => window.__shared)) === canon({ text: sh.code }));
        await page.click(".sheet .sh-head [data-a=closeSheet]");
        await page.click("#plnPaste");
        const g3 = await headGap(page);
        ok("„Plan aus Text einfügen“ öffnet ein Fenster mit Textfeld und „Hinzufügen“; bei 320 px überlappt im Kopf nichts", (await page.textContent(".sheet h2")) === "Einfügen" && await page.isVisible("#plnCodeIn") && (await page.textContent(".sheet .sh-head [data-a=plnPasteDo]")) === "Hinzufügen" && g3 >= 4 && await at320(page), String(g3));
        await page.fill("#plnCodeIn", "  " + sh.code.slice(0, 40) + "\n" + sh.code.slice(40) + " \n"); await page.click("[data-a=plnPasteDo]");
        const st = await stored(page), L = st.x.plaene.list;
        ok("Rundreise: Einfügen ergibt denselben Plan (Umlaute, Emoji, Supersatz, eigenes Gerät) – auch mit Zeilenumbruch im Text", L.length === 2 && L[0].name === NAME + " 2" && L[0].id !== "s1" && canon(L[0].plan) === canon(PX) && canon(L[1].plan) === canon(PX), JSON.stringify(L[0]));
        ok("Eingefügt heißt nicht geladen: Der aktuelle Plan bleibt; die Meldung nennt 2 Tage und 4 Geräte", canon(st.plan) === canon(P2) && (await page.textContent("#plnNote")) === `„${NAME} 2“ eingefügt: 2 Tage · 4 Geräte.` && !(await page.$(".sheet")), await page.textContent("#plnNote"));
        // Auf einem anderen Gerät gibt es das eigene Gerät nicht
        const { ctx: c2, page: p2 } = await open({ plan: PLAN_SMALL });
        await plnGo(p2); await p2.click("#plnPaste"); await p2.fill("#plnCodeIn", sh.code); await p2.click("[data-a=plnPasteDo]");
        const m2 = await mem(p2), e2 = m2.x.plaene.list[0];
        const want = [{ id: "r1", name: PX.days[0].name, items: [PX.days[0].items[0], PX.days[0].items[1]] }, { id: "r2", name: PX.days[1].name, items: [it("y1", "hs-legpress", 5, { rmin: 4, rmax: 6, rest: 180 })] }];
        ok("Auf einem anderen Gerät: gleicher Name, gleiche Tage; das dort unbekannte Gerät fällt weg, der Supersatz mit ihm löst sich", m2.x.plaene.list.length === 1 && e2.name === NAME && e2.plan.goal === "kraft" && e2.plan.level === "fortgeschritten" && e2.plan.minutes === 90 && canon(e2.plan.days) === canon(want), JSON.stringify(e2.plan.days));
        ok("Die Meldung nennt, was ankam (2 Tage · 3 Geräte) und was weggelassen wurde; der Plan dort bleibt", (await p2.textContent("#plnNote")) === `„${NAME}“ eingefügt: 2 Tage · 3 Geräte. Ein Gerät gibt es in dieser App nicht – es wurde weggelassen.` && canon(m2.plan.days) === canon(PLAN_SMALL.days), await p2.textContent("#plnNote"));
        await c2.close();
        // Kaputte Texte
        const bad = { "falscher Anfang": "XP1:" + sh.code.slice(4), "ohne Anfang": sh.code.slice(4), "kaputtes Base64": "TP1:@@@@", "abgeschnitten": sh.code.slice(0, -7), "abgeschnitten (Viererblock)": sh.code.slice(0, -8),
          "kein JSON": "TP1:" + Buffer.from("kein json").toString("base64"), "JSON ohne days": code({ app: "trainingsplan", typ: "plan", v: 1, name: "x", plan: { goal: "aufbau" } }), "JSON ohne Plan": code({ app: "trainingsplan", typ: "plan", v: 1, name: "x" }),
          "andere Art": code({ app: "trainingsplan", typ: "sonstwas", v: 1, plan: P2 }), "andere App": code({ app: "fremd", typ: "plan", v: 1, plan: P2 }), "andere Version": code({ app: "trainingsplan", typ: "plan", v: 2, plan: P2 }),
          "ohne Trainingstag": code({ app: "trainingsplan", typ: "plan", v: 1, name: "x", plan: { days: [] } }), "nur unbrauchbare Tage": code({ app: "trainingsplan", typ: "plan", v: 1, plan: { days: [5, { items: "x" }] } }), "Liste statt Objekt": code([1, 2]),
          "zu groß": "TP1:" + "A".repeat(60000), "leer": "   ", "Sicherung der App": code({ plan: P2, history: [] }) };
        const res = await tp(page, bad => Object.fromEntries(Object.entries(bad).map(([k, v]) => { const r = window.__tp.plnParse(v); return [k, r.ok ? "ok" : r.err]; })), bad);
        ok("Kaputte Texte werden abgelehnt, jeder mit einem Fehlertext", Object.keys(res).length === 17 && Object.values(res).every(v => v !== "ok" && v.length > 15), JSON.stringify(res));
        ok("Die Fehlertexte nennen den Grund: Anfang, beschädigt, kein Plan, kein Trainingstag, zu lang, Sicherung", res["falscher Anfang"].includes("beginnt mit TP1:") && res["ohne Anfang"].includes("beginnt mit TP1:") && res["kaputtes Base64"].includes("beschädigt") && res["abgeschnitten"].includes("beschädigt")
          && res["abgeschnitten (Viererblock)"].includes("beschädigt") && res["kein JSON"].includes("beschädigt") && res["JSON ohne days"] === "Der Text enthält keinen Plan." && res["JSON ohne Plan"] === "Der Text enthält keinen Plan." && res["andere Art"] === "Der Text enthält keinen Plan."
          && res["ohne Trainingstag"] === "Der Text enthält keinen Trainingstag." && res["nur unbrauchbare Tage"] === "Der Text enthält keinen Trainingstag." && res["zu groß"].includes("zu lang (mehr als 60.000 Zeichen)") && res["Sicherung der App"].includes("Sicherung der ganzen App"), JSON.stringify(res));
        await page.click("#plnPaste"); await page.fill("#plnCodeIn", bad["JSON ohne days"]); await page.click("[data-a=plnPasteDo]");
        const m3 = await mem(page);
        ok("Im Fenster: Fehlertext erscheint, das Fenster bleibt offen, nichts wird verändert", await page.isVisible("#plnErr") && (await page.textContent("#plnErr")) === "Der Text enthält keinen Plan." && !!(await page.$(".sheet #plnCodeIn")) && m3.x.plaene.list.length === 2 && canon(m3.plan) === canon(P2));
        await page.fill("#plnCodeIn", bad["zu groß"]); await page.click("[data-a=plnPasteDo]");
        ok("Zu großer Text (über 60 000 Zeichen): abgelehnt, nichts wird verändert", (await page.textContent("#plnErr")).includes("zu lang") && (await lst(page)).length === 2);
        // Fremder Text mit Unsinn und HTML: Werte werden begrenzt, Kennungen neu vergeben, nichts wird als HTML ausgeführt
        const evil = code({ app: "trainingsplan", typ: "plan", v: 1, name: "<img src=x onerror=window.__pwn=1>" + "N".repeat(66), plan: { goal: "constructor", level: "x", minutes: 99999, gaps: [{ day: "<img>", name: "<img>" }], days: [
          { id: "\"><img src=x onerror=window.__pwn=1>", name: "<img src=x onerror=window.__pwn=1>", items: [{ id: "a b", exId: "hs-chest", sets: 99, rmin: 0, rmax: -3, rest: 9999, ss: "dup" }, { id: "dup", exId: "hs-row" }, { id: "dup", exId: "gibt-es-nicht", sets: 3 }, { exId: "__proto__" }, "x", null] },
          { id: "zweiter", name: 5, items: "nein" }, 7] } });
        const ev = await tp(page, c => window.__tp.plnParse(c), evil);
        const ei = ev.ok ? ev.plan.days[0].items : [];
        // Von Hand: Sätze 99 → 10, Wiederholungen 0/−3 → 1–1, Pause 9999 → 600; zweites Gerät ohne Angaben → 3 Sätze, 8–8, 90 s; Minuten 99999 → 300
        ok("Fremder Text: Name auf 40 Zeichen gekürzt, Ziel und Werte auf erlaubte Bereiche begrenzt, unbekannte Geräte weggelassen", ev.ok && [...ev.name].length === 40 && ev.plan.goal === "aufbau" && ev.plan.level === "einsteiger" && ev.plan.minutes === 300 && ev.plan.gaps.length === 0 && ev.plan.days.length === 1 && ev.dropped === 2
          && ei.length === 2 && canon(ei.map(i => [i.exId, i.sets, i.rmin, i.rmax, i.rest])) === canon([["hs-chest", 10, 1, 1, 600], ["hs-row", 3, 8, 8, 90]]), JSON.stringify(ev));
        ok("Fremder Text: Kennungen mit unerlaubten Zeichen werden neu vergeben, der Supersatz zeigt weiter auf das folgende Gerät", ev.ok && IDOK.test(ev.plan.days[0].id) && ei.every(i => IDOK.test(i.id)) && ei[0].id !== "a b" && ei[1].id === "dup" && ei[0].ss === "dup" && !ei[1].ss, JSON.stringify(ei));
        await page.fill("#plnCodeIn", evil); await page.click("[data-a=plnPasteDo]");
        await page.click("#plnList .li >> nth=0");
        const t1 = (await asheet(page)).t;
        await page.click(".sheet.as [data-a=plnLoadAsk]"); await page.click(".sheet.as [data-a=plnLoadDo]");
        const pw = await tp(page, () => ({ pwn: window.__pwn, img: document.querySelectorAll("#app img, #sheet img").length, day: document.querySelector("#planDays .day-row .t").textContent, note: document.getElementById("planNote").textContent }));
        ok("Namen aus fremdem Text erscheinen als Text, nicht als HTML (Liste, Aktionsblatt, Plan-Seite)", t1.startsWith("<img src=x") && pw.pwn === undefined && pw.img === 0 && pw.day === "<img src=x onerror=window.__pwn=1>" && pw.note.includes("<img src=x"), JSON.stringify(pw));
        await ctx.close();
      }
      {
        // Kaputter Speicher
        const { ctx, page } = await open({ plan: PLAN_SMALL, x: { plaene: "Unsinn" } });
        await plnGo(page);
        ok("Kaputter Speicher („Unsinn“): leere Liste, die Seite funktioniert", (await tp(page, () => JSON.stringify(window.__tp.state.x.plaene))) === "{\"list\":[]}" && await page.isVisible("#plnEmpty") && (await page.textContent("#app h1")) === "Meine Pläne");
        await ctx.close();
        const junk = [null, 5, "x", [], { name: "Ohne Plan", saved: "2001-03-04" }, { name: "Plan ist Text", saved: "2001-03-04", plan: "x" }, { name: "Ohne days", saved: "2001-03-04", plan: { goal: "aufbau" } }, { name: "", saved: "2001-03-04", plan: P2 },
          { name: "   ", saved: "2001-03-04", plan: P2 }, { name: "x".repeat(41), saved: "2001-03-04", plan: P2 }, { name: 7, saved: "2001-03-04", plan: P2 }, { name: "Datum falsch", saved: "2001-02-31", plan: P2 }, { name: "Datum fehlt", plan: P2 },
          { id: "gut", name: "  Gut  ", saved: "2001-03-04", plan: P2, mehr: 1 }, { id: "gut", name: "x".repeat(40), saved: "2001-03-05", plan: { days: [{ id: "z", name: "Z", items: [{ exId: "hs-chest" }, "kaputt"] }] } }, { id: "<b>", name: "Drei", saved: "2001-03-06", plan: P3 }];
        const { ctx: c2, page: p2 } = await open({ plan: PLAN_SMALL, x: { plaene: { list: junk, sonst: 1 } } });
        const J = (await mem(p2)).x.plaene, jl = J.list;
        ok("Kaputte Einträge fallen weg (13 von 16): ohne Plan, ohne Tage-Liste, Name leer oder über 40 Zeichen, Datum ungültig", Object.keys(J).join() === "list" && jl.length === 3 && jl.map(e => e.name).join("|") === `Gut|${"x".repeat(40)}|Drei`, JSON.stringify(jl.map(e => [e.id, e.name])));
        ok("Gültige Einträge bleiben: Name ohne Leerzeichen am Rand, nur bekannte Felder, eindeutiges Kürzel, Plan durch die Prüfung der App", jl.length === 3 && Object.keys(jl[0]).join() === "id,name,saved,plan" && jl[0].id === "gut" && canon(jl[0].plan) === canon(P2) && jl[1].id !== "gut" && IDOK.test(jl[1].id) && IDOK.test(jl[2].id)
          && jl[1].plan.goal === "aufbau" && jl[1].plan.days[0].items.length === 1 && jl[1].plan.days[0].items[0].sets === 3 && canon(jl[2].plan) === canon(P3), JSON.stringify(jl.map(e => e.id)));
        await plnGo(p2);
        ok("Die Seite zeigt die drei gültigen Pläne, kein Text frei auf dem Seitengrund, 320 px ohne seitliches Scrollen", (await p2.$$eval("#plnList .li", r => r.length)) === 3 && (await freeTextOn(p2)).length === 0 && await at320(p2), (await freeTextOn(p2)).join(" | "));
        await c2.close();
        // Plan ohne Trainingstag: nichts zu sichern
        const { ctx: c3, page: p3 } = await open({ plan: { goal: "aufbau", level: "einsteiger", days: [] } });
        await plnGo(p3);
        const z = await tp(p3, () => ({ nums: [...document.querySelectorAll("#plnNow .stat .num")].map(x => x.textContent).join(), state: document.getElementById("plnState").textContent, dis: document.getElementById("plnSave").disabled, strip: !!document.querySelector("#plnNow .tstrip") }));
        ok("Plan ohne Trainingstag: 0 · 0 · 0, „Aktuellen Plan sichern“ ist gesperrt und die Karte sagt, warum", z.nums === "0,0,0" && z.dis && !z.strip && z.state === "Dein Plan hat noch keinen Trainingstag.", JSON.stringify(z));
        await c3.close();
      }
      {
        // Sicherung der App nimmt die Pläne mit
        const list = [{ id: "s1", name: "Größe 💪", saved: "2001-03-04", plan: P2 }, { id: "s2", name: "Zweiter", saved: "2001-03-05", plan: P3 }];
        const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3, "s")], x: { plaene: { list } } });
        const before = (await mem(page)).x.plaene;
        await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]"); await page.click("[data-a=exportData]");
        const bk = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
        ok("Die Sicherung der App enthält die gesicherten Pläne", before.list.length === 2 && canon(before.list) === canon(list) && canon(JSON.parse(Buffer.from(bk.slice(4), "base64").toString("utf8")).x.plaene) === canon(before));
        await page.evaluate(() => localStorage.clear()); await page.reload();
        await page.click("[data-a=createPlan]");
        ok("Nach dem Löschen aller Daten ist die Liste leer", (await lst(page)).length === 0);
        await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openSettings]");
        await page.click("[data-a=importOpen]"); await page.fill("#impTxt", bk); await page.click("[data-a=importDo]");
        const after = await stored(page);
        ok("„Sicherung wiederherstellen“ bringt die Pläne zurück (Rundreise)", canon(after.x.plaene) === canon(before) && canon(after.plan.days) === canon(PLAN_SMALL.days) && after.history.length === 1, JSON.stringify(after.x));
        await plnGo(page);
        ok("… und sie stehen wieder in der Liste", (await page.$$eval("#plnList .li .t", x => x.map(e => e.textContent).join("|"))) === "Größe 💪|Zweiter");
        // Ein Plan-Text ist keine Sicherung: „Sicherung wiederherstellen“ nimmt ihn nicht an
        const pc = await tp(page, () => window.__tp.plnCode(window.__tp.state.x.plaene.list[0]));
        await page.click("#navbar .nb-back"); await page.click("[data-a=openSettings]"); await page.click("[data-a=importOpen]"); await page.fill("#impTxt", pc); await page.click("[data-a=importDo]");
        ok("Ein Plan-Text wird unter „Sicherung wiederherstellen“ abgelehnt, nichts geht verloren", (await page.textContent("#impMsg")).includes("ungültig") && canon((await mem(page)).x.plaene) === canon(before) && (await mem(page)).history.length === 1);
        await ctx.close();
      }
      {
        // Ohne aktuellen Plan (die Seite ist dann nur über einen direkten Aufruf erreichbar): kein Absturz, Laden macht den Plan zum aktuellen
        const { ctx, page } = await open({ plan: null, x: { plaene: { list: [{ id: "s1", name: "Alt", saved: "2001-03-04", plan: P2 }] } } });
        await tp(page, () => { document.body.insertAdjacentHTML("beforeend", "<button id=\"tOpen\" data-a=\"openExt\" data-v=\"plaene\" hidden>x</button>"); document.getElementById("tOpen").click(); });
        ok("Ohne aktuellen Plan: Hinweiskarte statt Kennzahlen, die Liste ist da", await page.isVisible("#plnNoPlan") && !(await page.$("#plnSave")) && (await page.$$eval("#plnList .li", r => r.length)) === 1 && (await freeTextOn(page)).length === 0, (await freeTextOn(page)).join(" | "));
        await page.click("#plnList [data-id=s1]"); await page.click(".sheet.as [data-a=plnLoadAsk]");
        const q = await asheet(page);
        await page.click(".sheet.as [data-a=plnLoadDo]");
        ok("Laden ohne aktuellen Plan: Rückfrage ohne „wird ersetzt“, danach ist der Plan da", q.m.startsWith("Er wird dein aktueller Plan.") && q.btn === "Laden|Abbrechen" && canon((await stored(page)).plan) === canon(P2) && (await page.textContent("#app h1")) === "Mein Plan", JSON.stringify(q));
        await ctx.close();
      }
    }
    {
      // Neuer Plan ersetzt einen vorhandenen nie ohne Sicherung
      const days = [{ id: "m1", name: "Mein Tag A", items: [{ id: "i1", exId: "hs-chest", sets: 5, rmin: 6, rmax: 8, rest: 150 }] }, { id: "m2", name: "Mein Tag B", items: [{ id: "i2", exId: "hs-row", sets: 4, rmin: 8, rmax: 12, rest: 90 }] }];
      const { ctx, page } = await open({ plan: { goal: "kraft", level: "fortgeschritten", minutes: 60, days }, history: [hist("hs-chest", [{ kg: 60, reps: 6 }], 2)], prevPlan: { at: new Date().toISOString(), why: "x", plan: { goal: "aufbau", level: "einsteiger", days: [{ id: "o", name: "Alt", items: [] }] } } });
      await page.click("#navbar [data-a=openSettings]"); await page.click("[data-a=newPlan]");
      ok("Plan vorschlagen bei vorhandenem Plan: Hinweis, dass der bisherige unter „Meine Pläne“ gesichert wird", (await page.textContent("#setupKeep")).includes("wird vorher unter Plan → „Meine Pläne“ gesichert"));
      await page.click("[data-a=createPlan]");
      if (await page.$(".sheet [data-a=closeSheet]")) await page.click(".sheet [data-a=closeSheet]");
      const a1 = await tp(page, () => { const T = window.__tp, L = T.state.x.plaene.list; return { now: T.state.plan.days.map(d => d.name).join(), kept: L.map(e => e.plan.days.map(d => `${d.name}:${d.items.map(i => i.exId + "x" + i.sets).join("+")}`).join("|")).join(" / "), name: L[0] && L[0].name, prev: T.state.prevPlan, hist: T.state.history.length }; });
      ok("„Plan erstellen“: neuer Plan steht, der bisherige liegt vollständig unter „Meine Pläne“, altes „Rückgängig“ ist weg, Verlauf unverändert", !a1.now.includes("Mein Tag") && a1.kept === "Mein Tag A:hs-chestx5|Mein Tag B:hs-rowx4" && a1.name.startsWith("Plan vom ") && a1.prev === null && a1.hist === 1, JSON.stringify(a1));
      await page.click("#navbar [data-a=openSettings]"); await page.click("[data-a=newPlan]"); await page.click("[data-a=emptyPlan]");
      const a2 = await tp(page, () => { const T = window.__tp; return { now: T.state.plan.days.map(d => d.name + ":" + d.items.length).join(), n: T.state.x.plaene.list.length }; });
      ok("„Lieber selbst zusammenstellen“: auch der Vorschlag wird vorher gesichert (jetzt 2 gesicherte Pläne), dann leerer „Tag 1“", a2.now === "Tag 1:0" && a2.n === 2, JSON.stringify(a2));
      // Kein Platz mehr: Rückfrage statt stillem Verlust
      await tp(page, () => { const T = window.__tp; T.state.plan = JSON.parse(JSON.stringify(T.state.x.plaene.list[1].plan)); T.state.plan.days[0].name = "Unikat";
        while (T.state.x.plaene.list.length < T.PLN_MAX) T.state.x.plaene.list.push({ id: "f" + T.state.x.plaene.list.length, name: "Voll " + T.state.x.plaene.list.length, saved: "2026-01-01", plan: JSON.parse(JSON.stringify(T.state.x.plaene.list[0].plan)) }); });
      await page.click("nav.tabs [data-v=home]"); await page.click("#navbar [data-a=openSettings]"); await page.click("[data-a=newPlan]");
      const note = await page.textContent("#setupKeep");
      await page.click("[data-a=emptyPlan]");
      const q = await tp(page, () => ({ sheet: document.querySelector(".sheet") ? document.querySelector(".sheet").textContent : "", plan: window.__tp.state.plan.days[0].name }));
      ok("Alle 12 Plätze belegt: Hinweis auf der Seite und Rückfrage „Plan ersetzen?“; ohne Bestätigung bleibt der Plan", note.includes("kein Platz mehr") && q.sheet.includes("Plan ersetzen?") && q.sheet.includes("Trotzdem ersetzen") && q.plan === "Unikat", JSON.stringify(q).slice(0, 200));
      await page.click("[data-a=planOverDo]");
      ok("„Trotzdem ersetzen“ ersetzt dann", (await tp(page, () => window.__tp.state.plan.days.map(d => d.name + ":" + d.items.length).join())) === "Tag 1:0");
      await ctx.close();
    }
    // @ext:plaene:test:end
    // ── Abstand plaene/test 1 ──
    // ── Abstand plaene/test 2 ──
    // ── Abstand plaene/test 3 ──
    // @ext:aussehen:test:start
    section("E-aussehen. Aussehen (Einstellungen → Aussehen)");
    {
      // Farben, wie der Browser sie wirklich rechnet: Hilfselement mit der Variable, daraus Kontrast nach WCAG
      const probe = page => tp(page, () => { const T = window.__tp, R = document.documentElement;
        const col = v => { const d = document.createElement("div"); d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c.match(/[\d.]+/g).slice(0, 3).map(Number); };
        const lum = c => { const [r, g, b] = c.map(x => x / 255).map(x => x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return .2126 * r + .7152 * g + .0722 * b; };
        const con = (a, b) => { const x = lum(col(a)), y = lum(col(b)); return Math.round((Math.max(x, y) + .05) / (Math.min(x, y) + .05) * 100) / 100; };
        return { theme: R.getAttribute("data-theme"), accent: R.getAttribute("data-accent"), bg: col("var(--bg)").join(), acc: col("var(--accent)").join(),
          inkBg: con("var(--accent-ink)", "var(--bg)"), inkCard: con("var(--accent-ink)", "var(--raise)"), inkSheet: con("var(--accent-ink)", "var(--raise-2)"), onAcc: con("var(--on-accent)", "var(--accent)"),
          metas: [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content).join(), saved: JSON.stringify(T.state.x.aussehen) }; });
      const LIGHT = "242,242,247", DARK = "0,0,0";
      const { ctx, page } = await open({ plan: PLAN_SMALL }, { light: true });
      await page.click("#navbar [data-a=openSettings]");
      ok("Einstellungen: Zeile „Aussehen“ zeigt „Automatisch“", (await page.textContent("#row-aussehen")).includes("Aussehen") && (await page.textContent("#row-aussehen")).includes("Automatisch"));
      await page.click("#row-aussehen");
      const p0 = await probe(page);
      ok("Standard: kein Attribut gesetzt, Akzent #0071E3, Seite folgt dem Gerät (hell)", (await page.textContent("#app h1")) === "Aussehen" && p0.theme === null && p0.accent === null && p0.acc === "0,113,227" && p0.bg === LIGHT && p0.metas === "#F2F2F7,#000000", JSON.stringify(p0));
      await page.click("#ausModus [data-v=dunkel]");
      const p1 = await probe(page);
      ok("„Dunkel“ bei hellem Gerät: dunkler Seitengrund, Statusleiste schwarz, Auswahl markiert und gespeichert", p1.theme === "dark" && p1.bg === DARK && p1.metas === "#000000,#000000" && p1.saved === '{"modus":"dunkel","akzent":"blau"}' && await page.$eval("#ausModus [data-v=dunkel]", b => b.classList.contains("on") && b.getAttribute("aria-pressed") === "true"), JSON.stringify(p1));
      await page.reload(); await page.waitForSelector("#app h1");
      const p2 = await probe(page);
      await page.click("#navbar [data-a=openSettings]");
      ok("Nach dem Neuladen gilt „Dunkel“ sofort; die Zeile zeigt „Dunkel“", p2.theme === "dark" && p2.bg === DARK && (await page.textContent("#row-aussehen")).includes("Dunkel"), JSON.stringify(p2));
      await page.click("#row-aussehen");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.click("#ausModus [data-v=hell]");
      const p3 = await probe(page);
      ok("„Hell“ bei dunklem Gerät: heller Seitengrund, Statusleiste hell", p3.theme === "light" && p3.bg === LIGHT && p3.metas === "#F2F2F7,#F2F2F7", JSON.stringify(p3));
      await page.click("#ausModus [data-v=system]");
      const p4 = await probe(page);
      await page.emulateMedia({ colorScheme: "light" });
      const p5 = await probe(page);
      ok("„Automatisch“ folgt wieder dem Gerät (dunkel, dann hell); die Statusleiste hat ihre Ausgangswerte", p4.theme === null && p4.bg === DARK && p5.bg === LIGHT && p5.metas === "#F2F2F7,#000000", JSON.stringify([p4, p5]));
      // Jede Akzentfarbe in beiden Designs: Schrift in Akzentfarbe auf Seitengrund, Karte und Sheet sowie weiße Schrift auf dem gefüllten Knopf
      const bad = [];
      for (const [k] of await tp(page, () => window.__tp.AUS_AKZ)) for (const m of ["hell", "dunkel"]) {
        await tp(page, a => window.__tp.ausSet(a), { akzent: k, modus: m });
        const p = await probe(page);
        if (!(p.inkBg >= 4.5 && p.inkCard >= 4.5 && p.inkSheet >= 4.5 && p.onAcc >= 4.5) || (k === "blau") !== (p.accent === null)) bad.push([k, m, p.inkBg, p.inkCard, p.inkSheet, p.onAcc, p.accent]);
      }
      ok("Sechs Akzentfarben, hell und dunkel: Kontrast überall mindestens 4,5 : 1; Blau bleibt der Standard ohne Attribut", bad.length === 0 && (await tp(page, () => window.__tp.AUS_AKZ.length)) === 6, JSON.stringify(bad));
      await tp(page, () => window.__tp.ausSet({ akzent: "blau", modus: "system" }));
      await page.click("#ausAkzent [data-v=gruen]");
      const p6 = await probe(page);
      ok("Farbfeld antippen: Grün ist gewählt, benannt und gespeichert; die Vorschau zeigt die Farbe", p6.accent === "gruen" && p6.acc === "28,129,57" && p6.saved === '{"modus":"system","akzent":"gruen"}' && (await page.textContent("#ausAkzName")) === "Grün" && await page.$eval("#ausAkzent [data-v=gruen]", b => b.getAttribute("aria-pressed") === "true") && await page.isVisible("#ausDemo .btn"), JSON.stringify(p6));
      ok("Aussehen: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, JSON.stringify(await freeTextOn(page)));
      await page.setViewportSize({ width: 320, height: 640 });
      ok("Aussehen bei 320 px ohne seitliches Scrollen, Farbfelder mindestens 44 px breit", await noOverflow(page) && await page.$$eval("#ausAkzent .aus-sw", b => b.every(x => x.getBoundingClientRect().width >= 44 && x.getBoundingClientRect().height >= 44)));
      // Zustand wird ersetzt (z. B. Sicherung, Daten gelöscht): das Aussehen passt sich beim nächsten Zeichnen an
      await tp(page, () => { const T = window.__tp; T.state.x = {}; T.extClean(); });
      await page.click("#navbar .nb-back");
      await page.waitForFunction(() => document.documentElement.getAttribute("data-accent") === null);
      ok("Ohne gespeicherte Wahl gilt wieder der Standard", (await probe(page)).acc === "0,113,227" && (await page.textContent("#app h1")) === "Einstellungen");
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, x: { aussehen: { modus: "lila", akzent: 7 } } });
      const s = await tp(page, () => ({ saved: JSON.stringify(window.__tp.state.x.aussehen), theme: document.documentElement.getAttribute("data-theme"), accent: document.documentElement.getAttribute("data-accent") }));
      ok("Kaputter Speicher: Standard „Automatisch“ und Blau", s.saved === '{"modus":"system","akzent":"blau"}' && s.theme === null && s.accent === null, JSON.stringify(s));
      await ctx.close();
    }
    // @ext:aussehen:test:end
    // ── Abstand aussehen/test 1 ──
    // ── Abstand aussehen/test 2 ──
    // ── Abstand aussehen/test 3 ──
    // @ext:export:test:start
    section("E-export. Als Tabelle exportieren (Einstellungen → Plan und Daten)");
    {
      // Feste Daten, feste Zeitzone und – wo der heutige Tag in den Dateinamen eingeht – feste Uhr:
      // Die erwarteten Zeilen sind von Hand gerechnet und hängen weder von Tag und Uhrzeit noch vom Ort des Testlaufs ab
      const NOW = "2026-12-31T23:30:00.000Z", TODAY = "2027-01-01";   // in Berlin (Winterzeit, +1 h) ist es dann schon der 01.01.2027, 00:30 Uhr
      const BOM = "\uFEFF", fsx = require("fs");
      const expOpen = async (data, tz = "Europe/Berlin", at = null) => {
        const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: "dark", timezoneId: tz, serviceWorkers: "block" });
        if (at) await ctx.clock.install({ time: new Date(at) });   // die Uhr der Seite beginnt bei „at“ und läuft von dort normal weiter
        await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); localStorage.setItem("tp-3d", "0"); localStorage.setItem("tp-intro", "0"); localStorage.setItem("tp-tabmem", "0"); sessionStorage.setItem("seeded", "1"); } }, [KEY, JSON.stringify(data)]);
        const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push(e.message));
        page.on("console", m => { if (m.type() === "error" && !(m.text().startsWith("Failed to load resource") && /openfoodfacts\.org|\/api\/food/.test(m.location().url || ""))) allErrors.push(m.text()); });
        await page.goto(URL); return { ctx, page };
      };
      const toExport = async page => { await page.click("nav.tabs [data-v=plan]"); await page.click("#navbar [data-a=openSettings]"); await page.click("#row-export"); };
      const fileOf = async dl => fsx.readFileSync(await dl.path());
      // Kleiner CSV-Leser (Semikolon, Anführungszeichen verdoppelt, Zeilenende CRLF) – liest, was ein Tabellenprogramm lesen würde
      const csvRead = txt => { const rows = []; let row = [], f = "", q = false; txt = txt.replace(/^\uFEFF/, "");
        for (let i = 0; i < txt.length; i++) { const c = txt[i];
          if (q) { if (c === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
          else if (c === '"' && f === "") q = true;
          else if (c === ";") { row.push(f); f = ""; }
          else if (c === "\r" && txt[i + 1] === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; }
          else f += c; }
        if (f !== "" || row.length) { row.push(f); rows.push(row); }
        return rows; };
      const T1 = { id: "t1", dayId: "d1", day: "Oberkörper", date: "2026-03-01T23:30:00.000Z", durationSec: 1800, exercises: [
        { exId: "hs-chest", name: "Brustpresse", u: "s", sets: [{ kg: 42.5, reps: 10 }, { kg: 45, reps: 8 }, { kg: 41.25, reps: 3 }] }] };
      const T2 = { id: "t2", dayId: "d2", day: "Beine", date: "2026-07-15T16:05:00.000Z", durationSec: 1500, exercises: [
        { exId: "hs-legpress", name: "Beinpresse", u: "t", sets: [{ kg: 160, reps: 9 }, { kg: 41.25, reps: 3 }] },
        { exId: "c-beuger", name: "Beinbeuger", u: "b", sets: [{ kg: 37.5, reps: 12 }, { kg: null, reps: 5 }] }] };
      const HEAD_T = "Datum;Uhrzeit;Trainingstag;Gerät;Satz;Gewicht (kg);Gewichtsangabe;Wiederholungen;Bewegtes Gewicht (kg)";
      // Europe/Berlin: 01.03. 23:30 UTC = 02.03. 00:30 (Winterzeit, +1 h) · 15.07. 16:05 UTC = 15.07. 18:05 (Sommerzeit, +2 h)
      // Bewegtes Gewicht: pro Seite ×2 → 42,5×10×2 = 850 · 45×8×2 = 720 · 41,25×3×2 = 247,5; gesamt ×1 → 160×9 = 1440 · 41,25×3 = 123,75 · 37,5×12 = 450; ohne Gewicht 0
      const rowsT = (chest, leg) => [
        `02.03.2026;00:30;Oberkörper;${chest};1;42,5;pro Seite;10;850`,
        `02.03.2026;00:30;Oberkörper;${chest};2;45;pro Seite;8;720`,
        `02.03.2026;00:30;Oberkörper;${chest};3;41,25;pro Seite;3;247,5`,
        `15.07.2026;18:05;Beine;${leg};1;160;gesamt;9;1440`,
        `15.07.2026;18:05;Beine;${leg};2;41,25;gesamt;3;123,75`,
        "15.07.2026;18:05;Beine;Beinbeuger;1;37,5;gesamt;12;450",
        "15.07.2026;18:05;Beine;Beinbeuger;2;;gesamt;5;0"];
      const WEIGHTS = [{ d: "2026-11-08", kg: 81.9 }, { d: "2026-11-01", kg: 82.4 }, { d: "2026-11-15", kg: 81 }];
      const CSV_W = BOM + ["Datum;Gewicht (kg)", "01.11.2026;82,4", "08.11.2026;81,9", "15.11.2026;81"].join("\r\n") + "\r\n";
      // Haferflocken 80 g: 372×0,8 = 297,6 kcal · 13,5×0,8 = 10,8 · 58,7×0,8 = 46,96 → 47 · 7×0,8 = 5,6;  Reis 250 g: 130×2,5 = 325 · 2,6×2,5 = 6,5 · 28×2,5 = 70 · 0,4×2,5 = 1
      const FOOD = { "2026-11-18": [{ id: "f3", m: "m", n: "Reis; gekocht", src: "", g: 250, per: { k: 130, p: 2.6, c: 28, f: 0.4 } }],
        "2026-11-17": [{ id: "f2", m: "a", n: "Pizza", src: "", g: null, abs: { k: 850, p: 30, c: 100, f: 35 } },
          { id: "f1", m: "f", n: "Haferflocken", src: "", g: 80, per: { k: 372, p: 13.5, c: 58.7, f: 7 } }] };
      const CSV_F = BOM + ["Datum;Mahlzeit;Lebensmittel;Menge (g);Kalorien (kcal);Eiweiß (g);Kohlenhydrate (g);Fett (g)",
        "17.11.2026;Frühstück;Haferflocken;80;297,6;10,8;47;5,6", "17.11.2026;Abendessen;Pizza;;850;30;100;35", '18.11.2026;Mittagessen;"Reis; gekocht";250;325;6,5;70;1'].join("\r\n") + "\r\n";
      {
        // Reine Funktionen (Zustand → Text), ohne Download
        const { ctx, page } = await expOpen({ plan: PLAN_SMALL });
        const csv = await tp(page, s => window.__tp.csvExport.trainings(s), { history: [T2, T1] });
        const lines = csv.slice(1).split("\r\n");
        ok("Trainings: Kopfzeile auf Deutsch mit Semikolon", lines[0] === HEAD_T, lines[0]);
        const want = rowsT("Brustpresse", "Beinpresse");
        ok("Trainings: eine Zeile je Satz, Zeile für Zeile (älteste zuerst, Dezimalkomma, Datum und Uhrzeit am Ort)", lines.length === 9 && lines[8] === "" && want.every((w, i) => lines[i + 1] === w), JSON.stringify(lines));
        const vol = await tp(page, () => [window.__tp.setVol({ u: "s" }, { kg: 42.5, reps: 10 }), window.__tp.setVol({ u: "t" }, { kg: 160, reps: 9 }), window.__tp.setVol({ u: "b" }, { kg: 37.5, reps: 12 }), window.__tp.setVol({ u: "b" }, { kg: null, reps: 5 })]);
        ok("„pro Seite“ zählt beim bewegten Gewicht doppelt – dieselben Werte wie setVol", vol.join() === "850,1440,450,0" && lines[1].endsWith(";pro Seite;10;850") && lines[4].endsWith(";gesamt;9;1440"), vol.join());
        ok("Datei beginnt mit BOM, jede Zeile endet mit CRLF, kein einzelnes LF", csv.charCodeAt(0) === 0xFEFF && csv.endsWith("\r\n") && !/[^\r]\n/.test(csv) && csv.split("\r\n").length === 9 && !csv.slice(1).includes(BOM));
        ok("Datum am Ort, nicht UTC: 01.03. 23:30 UTC steht in Berlin unter dem 02.03.", lines[1].startsWith("02.03.2026;00:30;") && !csv.includes("01.03.2026"));
        // Escaping
        const esc1 = { history: [{ id: "e1", day: "Brust; Rücken", date: "2026-03-01T23:30:00.000Z", exercises: [
          { exId: "c-1", name: 'Presse "neu"', u: "t", sets: [{ kg: 50, reps: 5 }] }, { exId: "c-2", name: "Zug\noben", u: "t", sets: [{ kg: 20, reps: 10 }] }] }] };
        const e = await tp(page, s => window.__tp.csvExport.trainings(s), esc1), er = csvRead(e);
        ok("Semikolon, Anführungszeichen und Zeilenumbruch stehen in Anführungszeichen, Anführungszeichen verdoppelt",
          e === BOM + [HEAD_T, '02.03.2026;00:30;"Brust; Rücken";"Presse ""neu""";1;50;gesamt;5;250', '02.03.2026;00:30;"Brust; Rücken";"Zug\noben";1;20;gesamt;10;200'].join("\r\n") + "\r\n", JSON.stringify(e));
        ok("Zurückgelesen: je Zeile 9 Felder, Texte unverändert", er.length === 3 && er.every(r => r.length === 9) && er[1][2] === "Brust; Rücken" && er[1][3] === 'Presse "neu"' && er[2][3] === "Zug\noben" && er[2][8] === "200", JSON.stringify(er));
        // Formel-Schutz
        const f = await tp(page, () => { const c = window.__tp.csvExport.cell; return ["=1+1", "+49 Zug", "-Zug", "@heim", "\tTab", "\rX", "=A1;B", "Zug - eng", "1=1", "", null].map(c); });
        ok("Formel-Schutz: Text, der mit = + - @ Tab oder CR beginnt, bekommt einen Apostroph davor", canon(f) === canon(["'=1+1", "'+49 Zug", "'-Zug", "'@heim", "'\tTab", "\"'\rX\"", "\"'=A1;B\"", "Zug - eng", "1=1", "", ""]), JSON.stringify(f));
        const fx = await tp(page, () => { const x = window.__tp.csvExport;
          return { t: x.trainings({ history: [{ day: "=1+1", date: "2026-03-01T23:30:00.000Z", exercises: [{ exId: "c-1", name: "@SUMME(A1)", u: "s", sets: [{ kg: 10, reps: 5 }] }] }] }),
            f: x.essen({ food: { "2026-01-05": [{ m: "f", n: "=HYPERLINK(A1)", g: null, abs: { k: 1, p: 0, c: 0, f: 0 } }] } }),
            n: [x.numCell(-2.5), x.numCell(1234.5), x.numCell(0.126), x.numCell(7), x.numCell(null), x.numCell(NaN)], w: x.gewicht({ weights: [{ d: "2026-01-05", kg: -1.5 }] }) }; });
        ok("Trainingstag „=1+1“ und Gerät „@SUMME(A1)“ kommen entschärft in die Datei", fx.t.split("\r\n")[1] === "02.03.2026;00:30;'=1+1;'@SUMME(A1);1;10;pro Seite;5;100" && fx.f.split("\r\n")[1] === "05.01.2026;Frühstück;'=HYPERLINK(A1);;1;0;0;0", JSON.stringify([fx.t, fx.f]));
        ok("Zahlen der App bleiben Zahlen: negativ ohne Apostroph, Dezimalkomma, kein Tausenderpunkt, leer bei fehlendem Wert", canon(fx.n) === canon(["-2,5", "1234,5", "0,13", "7", "", ""]) && fx.w.split("\r\n")[1] === "05.01.2026;-1,5", JSON.stringify(fx));
        // Körpergewicht und Essen
        const w = await tp(page, s => window.__tp.csvExport.gewicht(s), { weights: WEIGHTS });
        ok("Körpergewicht: Datum und kg, nach Datum sortiert", w === CSV_W, JSON.stringify(w));
        const fd = await tp(page, s => window.__tp.csvExport.essen(s), { food: FOOD });
        ok("Essen: Tage aufsteigend, Mahlzeiten in ihrer Reihenfolge, Werte aus Menge × Angabe je 100 g; ohne gespeicherte Menge bleibt das Feld leer", fd === CSV_F, JSON.stringify(fd));
        // Körpermaße (Erweiterung „masse“): nur gültige Einträge, defensiv gelesen
        const m = await tp(page, () => { const x = window.__tp.csvExport;
          return [x.masse({ x: { masse: { e: [{ d: "2026-11-17", k: "taille", cm: 88 }, { d: "2026-11-10", k: "=taille", cm: 88.5 }, { d: "kaputt", k: "x", cm: 1 }, { d: "2026-11-11", k: "x", cm: "viel" }, null] } } }),
            x.masse({ x: { masse: "Unsinn" } }), x.masse({}), x.masse(null)]; });
        ok("Körpermaße: Datum, Maß, cm; kaputte Einträge fallen weg, fehlende Erweiterung ergibt nur die Kopfzeile",
          m[0] === BOM + ["Datum;Maß;Wert (cm)", "10.11.2026;'=taille;88,5", "17.11.2026;Taille;88"].join("\r\n") + "\r\n" && m.slice(1).every(x => x === BOM + "Datum;Maß;Wert (cm)\r\n"), JSON.stringify(m));
        const mn = await tp(page, () => window.__tp.csvExport.masse({ x: { masse: { e: [["brust", 101], ["taille", 84.5], ["huefte", 98], ["oberarm", 36.5], ["oberschenkel", 58], ["wade", 38.25], ["hals", 40], ["constructor", 50]].map(([k, cm]) => ({ d: "2026-10-03", k, cm })) } } }));
        ok("Körpermaße: die sechs Maße mit deutschem Namen (Hüfte mit Umlaut); ein unbekannter Schlüssel bleibt, wie er gespeichert ist",
          mn === BOM + ["Datum;Maß;Wert (cm)", "03.10.2026;Brust;101", "03.10.2026;Taille;84,5", "03.10.2026;Hüfte;98", "03.10.2026;Oberarm;36,5", "03.10.2026;Oberschenkel;58", "03.10.2026;Wade;38,25", "03.10.2026;hals;40", "03.10.2026;constructor;50"].join("\r\n") + "\r\n", JSON.stringify(mn));
        const bad = await tp(page, () => { const x = window.__tp.csvExport; return [x.trainings(null), x.trainings({ history: "x" }), x.trainings({ history: [null, { exercises: "x" }, { date: "kaputt", day: "A", exercises: [{ exId: "c-9", sets: [{ kg: 5, reps: 2 }] }] }] }), x.gewicht({ weights: [null, { d: "x", kg: 80 }, { d: "2026-01-05", kg: "80" }] }), x.essen({ food: { "2026-01-05": "x", x: [], "2026-01-06": [null, { g: 5 }, { g: null }] } })].map(t => t.split("\r\n").length - 2); });
        ok("Kaputte Eingaben stürzen nicht ab: nur Kopfzeile bzw. nur gültige Zeilen", bad.join() === "0,0,1,0,0", bad.join());
        ok("Dateiname „trainingsplan-<art>-JJJJ-MM-TT.csv“ mit dem Datum am Ort (Berlin: 01.03. 23:30 UTC → 02.03.)", await tp(page, () => window.__tp.csvExport.kinds.map(k => window.__tp.csvExport.fileName(k, new Date("2026-03-01T23:30:00.000Z"))).join()) ===
          "trainingsplan-trainings-2026-03-02.csv,trainingsplan-koerpergewicht-2026-03-02.csv,trainingsplan-essen-2026-03-02.csv,trainingsplan-koerpermasse-2026-03-02.csv");
        await ctx.close();
      }
      {
        // Anderer Ort, anderes Datum: Kiritimati liegt 14 Stunden vor UTC
        const { ctx, page } = await expOpen({ plan: PLAN_SMALL }, "Pacific/Kiritimati");
        const r = await tp(page, s => ({ csv: window.__tp.csvExport.trainings(s), name: window.__tp.csvExport.fileName("essen", new Date("2026-07-15T16:05:00.000Z")) }), { history: [T1, T2] });
        const l = r.csv.split("\r\n");
        ok("Kiritimati (+14 h): 02.03. 13:30 und 16.07. 06:05 statt der UTC-Daten; Dateiname mit dem 16.07.", l[1].startsWith("02.03.2026;13:30;") && l[4].startsWith("16.07.2026;06:05;") && r.name === "trainingsplan-essen-2026-07-16.csv", JSON.stringify([l[1], l[4], r.name]));
        await ctx.close();
      }
      {
        // Oberfläche mit Daten: Zeile in den Einstellungen, Unterseite, Download der drei Dateien, Teilen-Menü.
        // Die Uhr der Seite steht auf Silvester 23:30 UTC: In Berlin ist schon der 01.01.2027 – dieses Datum (am Ort) gehört in die Dateinamen, nicht das UTC-Datum
        const { ctx, page } = await expOpen({ plan: PLAN_SMALL, custom: [{ id: "c-beuger", name: "Beinbeuger", muscle: "beineh", sec: [], type: "stack" }], history: [T1, T2], weights: WEIGHTS, food: FOOD }, "Europe/Berlin", NOW);
        const clk = await page.evaluate(() => ({ utc: new Date().toISOString().slice(0, 10), local: window.__tp.dkey() }));
        ok("Uhr der Seite: am Ort der 01.01.2027, nach UTC noch der 31.12.2026", clk.local === TODAY && clk.utc === "2026-12-31", JSON.stringify(clk));
        await page.click("nav.tabs [data-v=plan]"); await page.click("#navbar [data-a=openSettings]");
        const row = await tp(page, () => { const r = document.getElementById("row-export"), sib = [...r.parentElement.children];
          return { sec: r.closest("section").querySelector("h2").textContent, t: r.querySelector(".t").textContent, ico: !!r.querySelector(".ico svg"), after: sib.indexOf(r) > sib.findIndex(x => x.textContent.includes("Sicherung wiederherstellen")), rows: document.querySelectorAll("[id=row-export]").length }; });
        ok("Einstellungen → „Plan und Daten“: genau eine Zeile „Als Tabelle exportieren“ mit Symbol, nach den Sicherungen", row.sec === "Plan und Daten" && row.t === "Als Tabelle exportieren" && row.ico && row.after && row.rows === 1, JSON.stringify(row));
        const before = await page.evaluate(k => localStorage.getItem(k), KEY);
        await page.click("#row-export");
        const v = await tp(page, () => ({ h1: [...document.querySelectorAll("#app h1")].map(x => x.textContent).join("|"), back: document.querySelector("#navbar .nb-back").textContent.trim(), tab: document.querySelector("#tabs button.on").dataset.v,
          rows: [...document.querySelectorAll("#expList .li")].map(l => { const b = l.querySelector("button"), r = b.getBoundingClientRect(); return [l.querySelector(".t").textContent, l.querySelector(".s").textContent, b.disabled, b.getAttribute("aria-label"), r.width >= 44 && r.height >= 44].join("/"); }),
          foot: document.querySelector("#expList + .foot").textContent, msgHidden: document.getElementById("expMsg").hidden, primary: document.querySelectorAll("#app .btn.primary").length }));
        ok("Unterseite „Als Tabelle exportieren“ mit „‹ Einstellungen“, genau einer Überschrift; der Bereich bleibt „Plan“", v.h1 === "Als Tabelle exportieren" && v.back === "Einstellungen" && v.tab === "plan", JSON.stringify(v));
        ok("Drei Zeilen mit Anzahl und je einem Knopf (mind. 44 px, mit Namen für die Sprachausgabe)", canon(v.rows) === canon(["Trainings/2 Trainings · 7 Sätze/false/Trainings exportieren/true", "Körpergewicht/3 Einträge/false/Körpergewicht exportieren/true", "Essen/3 Einträge an 2 Tagen/false/Essen exportieren/true"]), JSON.stringify(v.rows));
        ok("Beitext: Die Dateien entstehen auf dem Gerät, die App lädt nichts hoch; noch keine Meldung", v.foot === "Die Dateien entstehen auf diesem Gerät. Die App lädt nichts hoch." && v.msgHidden, v.foot);
        const nm = await tp(page, () => ({ chest: window.__tp.ex("hs-chest").name, leg: window.__tp.ex("hs-legpress").name }));
        // Ohne Teilen-Menü (Desktop-Chromium): Download
        const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exp-trainings [data-a=expCsv]")]);
        const buf = await fileOf(dl), txt = buf.toString("utf8");
        ok("Trainings: Download „trainingsplan-trainings-2027-01-01.csv“ – das Datum am Ort, nicht das UTC-Datum", dl.suggestedFilename() === "trainingsplan-trainings-2027-01-01.csv", dl.suggestedFilename());
        ok("Die Datei beginnt mit den BOM-Bytes EF BB BF und enthält Kopfzeile und alle 7 Sätze, Zeile für Zeile", buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF && txt === BOM + [HEAD_T].concat(rowsT(nm.chest, nm.leg)).join("\r\n") + "\r\n", JSON.stringify(txt));
        ok("Meldung nennt die Datei; sie ist ohne Scrollen zu sehen, die Seite bleibt stehen", await page.isVisible("#expMsg") && (await page.textContent("#expMsg")) === `Heruntergeladen: trainingsplan-trainings-${TODAY}.csv` && (await page.evaluate(() => scrollY)) === 0, await page.textContent("#expMsg"));
        const [dlW] = await Promise.all([page.waitForEvent("download"), page.click("#exp-koerpergewicht [data-a=expCsv]")]);
        ok("Körpergewicht: Datei „trainingsplan-koerpergewicht-…csv“ mit den drei Einträgen", dlW.suggestedFilename() === `trainingsplan-koerpergewicht-${TODAY}.csv` && (await fileOf(dlW)).toString("utf8") === CSV_W);
        const [dlF] = await Promise.all([page.waitForEvent("download"), page.click("#exp-essen [data-a=expCsv]")]);
        ok("Essen: Datei „trainingsplan-essen-…csv“ mit den drei Einträgen", dlF.suggestedFilename() === `trainingsplan-essen-${TODAY}.csv` && (await fileOf(dlF)).toString("utf8") === CSV_F, (await fileOf(dlF)).toString("utf8"));
        ok("Der Export speichert nichts: Zustand unverändert, kein eigener Speicherbereich", (await page.evaluate(k => localStorage.getItem(k), KEY)) === before && !(await tp(page, () => "export" in window.__tp.state.x)));
        await page.$$eval("#expInfo details", d => d.forEach(x => x.open = true));
        const info = await page.textContent("#expInfo");
        ok("„Zu den Dateien“: Spalten je Datei, bewegtes Gewicht, Format", info.includes(HEAD_T.split(";").join(", ")) && info.includes("Gewicht × Wiederholungen") && info.includes("Semikolon") && info.includes("UTF-8") && !info.includes("Körpermaße"), info);
        ok("„Zu den Dateien“: Uhrzeit = Ende des Trainings, Einträge über „Nur kcal“, Weg der Datei (Teilen-Menü, sonst Download)", (await page.$$("#expInfo details")).length === 4 && info.includes("Die Uhrzeit ist das Ende des Trainings.")
          && info.includes("Einträge über „Nur kcal“ haben keine Menge.") && info.includes("stehen als 0 in der Datei") && info.includes("Ohne eingetragenes Gewicht steht dort 0.") && info.includes("„In Dateien sichern“") && info.includes("Ohne Teilen-Menü lädt der Browser die Datei herunter."), info);
        ok("Kein Text frei auf dem Seitengrund (mit Meldung und aufgeklappten Fragen)", (await freeTextOn(page)).length === 0, (await freeTextOn(page)).join(" | "));
        await page.setViewportSize({ width: 320, height: 640 });
        ok("320 px: ohne seitliches Scrollen, kein Text abgeschnitten", await noOverflow(page) && await tp(page, () => [...document.querySelectorAll("#app .t, #app .s, #expMsg")].every(x => x.scrollWidth <= x.clientWidth + 1)), await overflowers(page));
        // Navigationsleiste beim Scrollen: Der lange Titel und „‹ Einstellungen“ haben nebeneinander keinen Platz
        const navState = () => tp(page, () => { const n = document.getElementById("navbar"), t = n.querySelector(".nb-t"), r = document.createRange(); r.selectNodeContents(t);
          return { scrolled: n.classList.contains("scrolled"), title: t.textContent, cut: t.scrollWidth > t.clientWidth + 1, label: getComputedStyle(n.querySelector(".nb-back span")).opacity,
            free: r.getBoundingClientRect().left >= n.querySelector(".nb-chev").getBoundingClientRect().right, back: n.querySelector(".nb-back").textContent.trim() }; });
        await page.evaluate(() => window.scrollTo(0, 400)); await page.waitForTimeout(400);
        const nb1 = await navState();
        ok("320 px, gescrollt: Der kleine Titel steht ungekürzt in der Navigationsleiste, vom Zurück-Knopf bleibt nur der Pfeil – nichts überdeckt sich", nb1.scrolled && nb1.title === "Als Tabelle exportieren" && !nb1.cut && nb1.label === "0" && nb1.free && nb1.back === "Einstellungen", JSON.stringify(nb1));
        await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400);
        const nb0 = await navState();
        ok("Wieder oben: „‹ Einstellungen“ steht ausgeschrieben da", !nb0.scrolled && nb0.label === "1" && nb0.back === "Einstellungen", JSON.stringify(nb0));
        await page.setViewportSize({ width: 360, height: 780 });
        // Teilen-Menü (iPhone): abgebrochen → nichts; geteilt → Datei an das Menü; Fehler → Download als Rückfall
        let dls = 0; page.on("download", () => dls++);
        await page.evaluate(() => { navigator.canShare = () => true; navigator.share = () => Promise.reject(new DOMException("abgebrochen", "AbortError")); });
        await page.click("#exp-koerpergewicht [data-a=expCsv]"); await page.waitForTimeout(200);
        ok("Teilen abgebrochen: keine Datei, keine Meldung", dls === 0 && await page.isHidden("#expMsg"));
        await page.evaluate(() => { navigator.share = async d => { const f = d.files[0]; window.__tp.sharedCsv = { n: d.files.length, name: f.name, type: f.type, bytes: [...new Uint8Array(await f.arrayBuffer())] }; }; });
        await page.click("#exp-koerpergewicht [data-a=expCsv]"); await page.waitForTimeout(200);
        const sh = await tp(page, () => window.__tp.sharedCsv);
        ok("Teilen-Menü bekommt genau die CSV-Datei (mit BOM), danach „Exportiert: …“ – kein Download", sh.n === 1 && sh.name === `trainingsplan-koerpergewicht-${TODAY}.csv` && sh.type === "text/csv" && Buffer.from(sh.bytes).equals(Buffer.from(CSV_W, "utf8")) && sh.bytes.slice(0, 3).join() === "239,187,191"
          && (await page.textContent("#expMsg")) === `Exportiert: trainingsplan-koerpergewicht-${TODAY}.csv` && dls === 0, JSON.stringify([sh.name, sh.type, dls]));
        await page.evaluate(() => { navigator.share = () => Promise.reject(new Error("geht nicht")); });
        const [dlR] = await Promise.all([page.waitForEvent("download"), page.click("#exp-essen [data-a=expCsv]")]);
        await page.waitForTimeout(100);
        ok("Teilen schlägt fehl: Rückfall auf den Download", dlR.suggestedFilename() === `trainingsplan-essen-${TODAY}.csv` && (await fileOf(dlR)).toString("utf8") === CSV_F && (await page.textContent("#expMsg")).startsWith("Heruntergeladen: "));
        await page.evaluate(() => { navigator.canShare = () => false; });
        const [dlN] = await Promise.all([page.waitForEvent("download"), page.click("#exp-trainings [data-a=expCsv]")]);
        ok("Teilen-Menü nimmt keine Dateien: Download", dlN.suggestedFilename() === `trainingsplan-trainings-${TODAY}.csv`);
        await page.click("#navbar .nb-back");
        ok("Zurück führt zu den Einstellungen", (await page.textContent("#app h1")) === "Einstellungen");
        await page.click("#row-export");
        ok("Wieder geöffnet: die alte Meldung ist weg", await page.isHidden("#expMsg"));
        await ctx.close();
      }
      {
        // Leerer Zustand: nichts zu exportieren
        const { ctx, page } = await open({ plan: PLAN_SMALL }, { light: true });
        await toExport(page);
        const e = await tp(page, () => [...document.querySelectorAll("#expList .li")].map(l => [l.querySelector(".t").textContent, l.querySelector(".s").textContent, l.querySelector("button").disabled, !!l.querySelector(".ico svg")].join("/")));
        ok("Ohne Daten: drei Zeilen mit „Noch keine Einträge“, jeder Knopf deaktiviert", canon(e) === canon(["Trainings/Noch keine Einträge/true/true", "Körpergewicht/Noch keine Einträge/true/true", "Essen/Noch keine Einträge/true/true"]), JSON.stringify(e));
        let dls = 0; page.on("download", () => dls++);
        await tp(page, () => { const b = document.querySelector("#exp-trainings button"); b.click(); return window.__tp.EXT.actions.expCsv(b); });
        await page.waitForTimeout(200);
        ok("Ohne Daten entsteht keine Datei und keine Meldung", dls === 0 && await page.isHidden("#expMsg"));
        await page.$$eval("#expInfo details", d => d.forEach(x => x.open = true));
        ok("Leer: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", (await freeTextOn(page)).length === 0 && await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })(), (await freeTextOn(page)).join(" | "));
        await ctx.close();
      }
      {
        // Körpermaße erscheinen nur, wenn die Erweiterung „masse“ Daten abgelegt hat (hier zur Laufzeit eingesetzt)
        const { ctx, page } = await expOpen({ plan: PLAN_SMALL }, "Europe/Berlin", NOW);
        await toExport(page);
        ok("Ohne Körpermaße gibt es die Zeile nicht", !(await page.$("#exp-koerpermasse")) && (await page.$$("#expList .li")).length === 3);
        await page.click("#navbar .nb-back");
        await tp(page, () => { window.__tp.state.x.masse = { e: [{ d: "2026-11-17", k: "taille", cm: 88 }, { d: "2026-11-10", k: "huefte", cm: 101.5 }] }; });
        await page.click("#row-export");
        ok("Mit Körpermaßen: vierte Zeile „Körpermaße“ mit Anzahl", (await page.$$("#expList .li")).length === 4 && (await page.textContent("#exp-koerpermasse .s")) === "2 Einträge" && !(await page.$eval("#exp-koerpermasse button", b => b.disabled)));
        await page.$$eval("#expInfo details", d => d.forEach(x => x.open = true));
        ok("Mit Körpermaßen nennt „Was steht in den Dateien?“ auch deren Spalten", (await page.textContent("#expInfo")).includes("Körpermaße – eine Zeile je Eintrag: Datum, Maß, Wert (cm)."), await page.textContent("#expInfo"));
        // Kleiner Bildschirm (320 × 568), Fragen wieder zugeklappt: Die vierte Zeile und die Meldung liegen zunächst unter der Tab-Leiste
        await page.$$eval("#expInfo details", d => d.forEach(x => x.open = false));
        await page.setViewportSize({ width: 320, height: 568 }); await page.evaluate(() => window.scrollTo(0, 0));
        const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exp-koerpermasse [data-a=expCsv]")]);
        ok("Körpermaße: Datei „trainingsplan-koerpermasse-2027-01-01.csv“ mit Datum, Maß (deutscher Name) und cm", dl.suggestedFilename() === `trainingsplan-koerpermasse-${TODAY}.csv` && (await fileOf(dl)).toString("utf8") === BOM + ["Datum;Maß;Wert (cm)", "10.11.2026;Hüfte;101,5", "17.11.2026;Taille;88"].join("\r\n") + "\r\n", (await fileOf(dl)).toString("utf8"));
        await page.waitForTimeout(150);
        const vis = await tp(page, () => { const r = id => document.getElementById(id).getBoundingClientRect(), m = r("expMsg");
          return { txt: document.getElementById("expMsg").textContent, top: Math.round(m.top), bottom: Math.round(m.bottom), tabs: Math.round(r("tabs").top), nav: Math.round(r("navbar").bottom), y: Math.round(scrollY) }; });
        ok("320 × 568: Die Meldung ist nach dem Export zu sehen – die Seite rückt so weit hoch, dass sie über der Tab-Leiste liegt", vis.txt === `Heruntergeladen: trainingsplan-koerpermasse-${TODAY}.csv` && vis.y > 0 && vis.bottom <= vis.tabs && vis.top >= vis.nav, JSON.stringify(vis));
        await page.setViewportSize({ width: 360, height: 780 });
        await page.$$eval("#expInfo details", d => d.forEach(x => x.open = true));
        ok("Körpermaße: kein Text frei auf dem Seitengrund, bei 320 px ohne seitliches Scrollen", (await freeTextOn(page)).length === 0 && await (async () => { await page.setViewportSize({ width: 320, height: 640 }); const r = await noOverflow(page); await page.setViewportSize({ width: 360, height: 780 }); return r; })(), (await freeTextOn(page)).join(" | "));
        await ctx.close();
      }
      {
        // Kaputte Speicherbereiche: Der Export hat keinen eigenen Speicher und liest fremde Bereiche defensiv
        const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3, "s")], x: { export: "Unsinn", masse: "Unsinn" } });
        await toExport(page);
        ok("Kaputter Speicher stürzt nicht ab: Seite öffnet sich, Trainings sind exportierbar", (await page.textContent("#app h1")) === "Als Tabelle exportieren" && (await page.textContent("#exp-trainings .s")) === "1 Training · 1 Satz" && !(await page.$("#exp-koerpermasse")) && !(await tp(page, () => "export" in window.__tp.state.x)));
        await ctx.close();
      }
      {
        // Echter Ablauf mit fester Uhr (Berlin, 01.01.2027 ab 00:30 Uhr): Gewicht, „Nur kcal“-Eintrag und Training entstehen über die Oberfläche –
        // so, wie die App sie wirklich speichert – und stehen danach in den Dateien. Nach UTC wäre es noch der 31.12.2026.
        const { ctx, page } = await expOpen({ plan: PLAN_SMALL }, "Europe/Berlin", NOW);
        await page.click("nav.tabs [data-v=history]"); await page.click("#discWeight summary"); await page.fill("#bwIn", "81,5"); await page.click("[data-a=addWeight]");
        await page.click("nav.tabs [data-v=food]"); await page.click("[data-a=foodAdd][data-m=a]"); await page.click("[data-a=quickOpen]"); await page.fill("#qkK", "700"); await page.click("[data-a=quickSave]");
        await page.click("nav.tabs [data-v=home]"); await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
        await finishAllSets(page, 40, 10);
        await page.click("[data-a=tab][data-v=home]");
        const nm = await tp(page, () => ({ chest: window.__tp.ex("hs-chest").name, leg: window.__tp.ex("hs-legpress").name, fly: window.__tp.ex("hs-fly").name }));
        await toExport(page);
        const subs = await page.$$eval("#expList .li .s", l => l.map(x => x.textContent));
        ok("Nach echtem Training, Gewicht und Essen: Anzahl je Zeile (Einzahl)", canon(subs) === canon(["1 Training · 4 Sätze", "1 Eintrag", "1 Eintrag an 1 Tag"]), JSON.stringify(subs));
        const [dlT] = await Promise.all([page.waitForEvent("download"), page.click("#exp-trainings [data-a=expCsv]")]);
        const tl = (await fileOf(dlT)).toString("utf8").split("\r\n");
        // Brustpresse zählt pro Seite: 40 × 10 × 2 = 800; Beinpresse (insgesamt) und Butterfly (Gewichtsblock): 40 × 10 = 400. Die Minute läuft mit, daher 00:3x
        ok("Echtes Training in der Datei: Datum am Ort (01.01.2027), Uhrzeit des Endes, Einheit je Gerät, bewegtes Gewicht",
          tl.length === 6 && tl[0] === BOM + HEAD_T && tl[5] === "" && canon(tl.slice(1, 5).map(l => l.replace(/^(01\.01\.2027;00:3)\d;/, "$1x;"))) === canon([
            `01.01.2027;00:3x;Test;${nm.chest};1;40;pro Seite;10;800`, `01.01.2027;00:3x;Test;${nm.chest};2;40;pro Seite;10;800`,
            `01.01.2027;00:3x;Test;${nm.leg};1;40;gesamt;10;400`, `01.01.2027;00:3x;Test;${nm.fly};1;40;gesamt;10;400`]), JSON.stringify(tl));
        const [dlW] = await Promise.all([page.waitForEvent("download"), page.click("#exp-koerpergewicht [data-a=expCsv]")]);
        ok("Eingetragenes Gewicht in der Datei unter dem Datum am Ort", dlW.suggestedFilename() === `trainingsplan-koerpergewicht-${TODAY}.csv` && (await fileOf(dlW)).toString("utf8") === BOM + "Datum;Gewicht (kg)\r\n01.01.2027;81,5\r\n", (await fileOf(dlW)).toString("utf8"));
        const [dlF] = await Promise.all([page.waitForEvent("download"), page.click("#exp-essen [data-a=expCsv]")]);
        ok("„Nur kcal“-Eintrag in der Datei: ohne Menge, leer gelassene Nährwerte als 0 – wie im Beitext beschrieben", (await fileOf(dlF)).toString("utf8") === BOM + CSV_F.slice(1).split("\r\n")[0] + "\r\n01.01.2027;Abendessen;Schnell eingetragen;;700;0;0;0\r\n", (await fileOf(dlF)).toString("utf8"));
        await ctx.close();
      }
    }
    // @ext:export:test:end
    // ── Abstand export/test 1 ──
    // ── Abstand export/test 2 ──
    // ── Abstand export/test 3 ──
    // @ext:artikel:test:start
    // @ext:artikel:test:end
    // ── Abstand artikel/test 1 ──
    // ── Abstand artikel/test 2 ──
    // ── Abstand artikel/test 3 ──
    // @ext:sicherheit:test:start
    section("E-sicherheit. Datensicherheit: unlesbarer Speicher, Wiederherstellen");
    {
      const raw = (store, extra = {}) => browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: "block", acceptDownloads: true }).then(async ctx => {
        await ctx.addInitScript(([st, ex]) => { if (!sessionStorage.getItem("seeded")) { for (const k in st) localStorage.setItem(k, st[k]); for (const k in ex) localStorage.setItem(k, ex[k]); sessionStorage.setItem("seeded", "1"); } }, [store, Object.assign({ "tp-intro": "0", "tp-3d": "0", "tp-tabmem": "0" }, extra)]);
        const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push("sicherheit: " + e.message)); await page.goto(URL); await page.waitForSelector("#app h1"); return { ctx, page }; });
      const good = JSON.stringify({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3)], session: null });
      const broken = good.slice(0, good.length - 40);   // abgeschnittenes JSON
      // 1. Unlesbarer Speicher: Kopie bleibt, Hinweis sichtbar, Weiterarbeiten überschreibt sie nicht
      const a = await raw({ [KEY]: broken });
      const a1 = await tp(a.page, k => ({ warn: !document.getElementById("loadWarn").hidden, txt: document.getElementById("loadWarnTxt").textContent, copy: localStorage.getItem(k + "-unlesbar"), n: window.__tp.state.history.length, drop: document.getElementById("badDropBtn").hidden }), KEY);
      ok("Unlesbarer Speicher: Hinweis sichtbar („nicht gelöscht“), der Rohtext liegt unverändert als Kopie auf dem Gerät", a1.warn && a1.txt.includes("nicht gelöscht") && a1.copy === broken && a1.n === 0 && a1.drop, JSON.stringify({ warn: a1.warn, n: a1.n }));
      await a.page.click("[data-a=createPlan]");
      if (await a.page.$(".sheet [data-a=closeSheet]")) await a.page.click(".sheet [data-a=closeSheet]");
      const a2 = await tp(a.page, k => ({ copy: localStorage.getItem(k + "-unlesbar"), now: JSON.parse(localStorage.getItem(k)).plan.days.length }), KEY);
      ok("Danach einen Plan erstellen: die neuen Daten werden gespeichert, die Kopie der alten bleibt unangetastet", a2.copy === broken && a2.now >= 2);
      const [dl] = await Promise.all([a.page.waitForEvent("download"), a.page.click("#loadWarn [data-a=badSave]")]);
      const fs = require("fs"), file = fs.readFileSync(await dl.path(), "utf8");
      ok("„Kopie als Datei sichern“ lädt genau den Rohtext herunter", file === broken && /^trainingsplan-kopie-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
      await a.ctx.close();
      // 2. Kopie ist wieder lesbar und es gibt nichts Eigenes: wird übernommen
      const b = await raw({ [KEY + "-unlesbar"]: good });
      const b1 = await tp(b.page, k => ({ n: window.__tp.state.history.length, plan: !!window.__tp.state.plan, copy: localStorage.getItem(k + "-unlesbar"), saved: JSON.parse(localStorage.getItem(k) || "{}").history, warn: !document.getElementById("loadWarn").hidden, note: (document.getElementById("homeNote") || {}).textContent || "" }), KEY);
      ok("Wieder lesbare Kopie ohne eigene neue Daten: wird beim Start übernommen und gespeichert, die Kopie verschwindet, Meldung „wieder da“", b1.n === 1 && b1.plan && b1.copy === null && b1.saved.length === 1 && !b1.warn && b1.note.includes("wieder da"), JSON.stringify(b1).slice(0, 200));
      await b.ctx.close();
      // 3. Es gibt inzwischen eigene Daten: nichts wird ersetzt, die Kopie bleibt bis zum Löschen
      const mine = JSON.stringify({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 50, reps: 8 }], 1), hist("hs-chest", [{ kg: 50, reps: 9 }], 0)], session: null });
      const c = await raw({ [KEY]: mine, [KEY + "-unlesbar"]: good });
      const c1 = await tp(c.page, k => ({ n: window.__tp.state.history.length, copy: !!localStorage.getItem(k + "-unlesbar"), warn: !document.getElementById("loadWarn").hidden, txt: document.getElementById("loadWarnTxt").textContent, drop: !document.getElementById("badDropBtn").hidden }), KEY);
      ok("Eigene Daten vorhanden: sie bleiben (2 Trainings), die Kopie wird nicht eingespielt, Hinweis mit „Kopie löschen“", c1.n === 2 && c1.copy && c1.warn && c1.txt.includes("Kopie älterer Daten") && c1.drop, JSON.stringify(c1).slice(0, 200));
      await c.page.click("#loadWarn [data-a=badDrop]"); await c.page.click("[data-a=badDropDo]");
      const c2 = await tp(c.page, k => ({ copy: localStorage.getItem(k + "-unlesbar"), warn: !document.getElementById("loadWarn").hidden, n: window.__tp.state.history.length }), KEY);
      ok("„Kopie löschen“ fragt nach und entfernt nur die Kopie", c2.copy === null && !c2.warn && c2.n === 2);
      await c.ctx.close();
    }
    {
      // Wiederherstellen: laufendes Training und neuere Trainings sind geschützt
      const old = { plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 30, reps: 10 }], 90), hist("hs-chest", [{ kg: 30, reps: 11 }], 80)], session: null };
      const code = "TP1:" + Buffer.from(unescape(encodeURIComponent(JSON.stringify(old))), "binary").toString("base64");
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 5), hist("hs-chest", [{ kg: 40, reps: 11 }], 1)] });
      await page.click("[data-a=start]");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "12"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=pauseT]");
      await page.click("#navbar [data-a=openSettings]"); await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const r1 = await tp(page, () => ({ msg: document.getElementById("impMsg").textContent, ses: !!window.__tp.state.session, done: window.__tp.state.session.list[0].sets.filter(s => s.done).length, n: window.__tp.state.history.length, btn: !!document.querySelector("[data-a=restoreConfirm]") }));
      ok("Sicherung einspielen bei pausiertem Training: gesperrt mit Hinweis, das Training und sein erledigter Satz bleiben", r1.msg.includes("Erst das laufende Training beenden") && r1.ses && r1.done === 1 && r1.n === 2 && !r1.btn, JSON.stringify(r1));
      await ctx.close();
      const two = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 5), hist("hs-chest", [{ kg: 40, reps: 11 }], 1)] });
      await two.page.click("#navbar [data-a=openSettings]"); await two.page.click("[data-a=importOpen]"); await two.page.fill("#impTxt", code); await two.page.click("[data-a=importDo]");
      const r2 = await tp(two.page, () => ({ msg: document.getElementById("impMsg").textContent, n: window.__tp.state.history.map(h => h.exercises[0].sets[0].kg).join(), btn: !!document.querySelector("[data-a=restoreConfirm]") }));
      ok("Gleich viele Trainings, aber auf dem Gerät neuere: Rückfrage statt stillem Ersetzen", r2.msg.includes("neuere Trainings") && r2.n === "40,40" && r2.btn, JSON.stringify(r2));
      await two.page.click("[data-a=restoreConfirm]");
      ok("„Trotzdem ersetzen“ spielt die Sicherung dann ein", (await tp(two.page, () => window.__tp.state.history.map(h => h.exercises[0].sets[0].kg).join())) === "30,30");
      await two.ctx.close();
    }
    // @ext:sicherheit:test:end
    // ── Abstand sicherheit/test 1 ──
    // ── Abstand sicherheit/test 2 ──
    // ── Abstand sicherheit/test 3 ──
    // @ext:runde2:test:start
    section("E-runde2. Offene Datenfehler aus der Bestandsaufnahme");
    const R2iso = n => new Date(Date.now() - n * 864e5).toISOString();
    const R2E = (exId, u, sets) => ({ exId, name: exId, u, planned: sets.length, rmin: 8, rmax: 12, sets: sets.map(([kg, reps]) => ({ kg, reps })) });
    const R2H = (id, n, dayId, exs) => ({ id, dayId, day: "Tag", date: R2iso(n), durationSec: 1800, exercises: exs });
    {
      // A. Gewichtsangabe umstellen („Frühere Einträge umstellen“) während eines laufenden Trainings
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag A", items: [{ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan, history: [R2H("t1", 6, "d1", [R2E("hs-chest", "s", [[40, 10], [40, 10], [40, 9]]), R2E("hs-row", "s", [[30, 10], [30, 10], [30, 9]])])] });
      await page.click("[data-a=start]");
      await page.click("[data-a=openDevInfo]"); await page.click(".sheet [data-a=editDev]");
      await page.click(".sheet [data-a=devSet][data-k=load][data-v=total]");
      await page.click("[data-a=devRelabelAsk]"); await page.click("[data-a=devRelabel]"); await page.click(".sheet [data-a=devSave]");
      if (await page.$(".sheet [data-a=closeSheet]")) await page.click(".sheet [data-a=closeSheet]");
      const a1 = await tp(page, () => { const T = window.__tp, x = T.state.session.list[0]; return { u: x.u, dev: T.unitOf(T.ex("hs-chest")), hist: T.state.history[0].exercises[0].u, sets: x.sets.map(s => s.kg + "x" + s.reps).join(",") }; });
      ok("Umstellen im laufenden Training: auch die heutige Übung zählt jetzt „insgesamt“, Vorschlag aus den umgestellten Einträgen", a1.u === "t" && a1.dev === "t" && a1.hist === "t" && a1.sets.startsWith("40x"), JSON.stringify(a1));
      await page.fill("#kgIn", "80"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      await page.click("[data-a=askStop]"); await page.click("[data-a=stopSave]");
      const a2 = await tp(page, () => window.__tp.state.history.map(h => h.exercises.filter(x => x.exId === "hs-chest").map(x => x.u + ":" + x.sets.map(s => s.kg + "x" + s.reps).join("/")).join()).join(" | "));
      ok("… und wird mit „insgesamt“ gespeichert (vorher mit der alten Angabe „pro Seite“)", a2 === "t:40x10/40x10/40x9 | t:80x10", a2);
      await ctx.close();
    }
    {
      // B + C. Gerätetausch aus dem Hinweis „Stillstand“: kein doppeltes Gerät; „Rückgängig“ verwirft keine späteren Änderungen
      const hist = [28, 21, 14, 7, 2].map((n, k) => R2H("p" + k, n, "a", [R2E("hs-row", "s", [[50, 9], [50, 9], [50, 9]])]));
      const dayA = { id: "a", name: "Tag A", items: [{ id: "a1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a2", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] };
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [dayA] }, history: hist });
      // Die Alternative, die der Hinweis vorher vorschlug (nur gegen Tag A geprüft), kommt in Tag B dazu
      const X = await tp(page, () => window.__tp.rankAlternatives("hs-row", new Set(["hs-row", "hs-chest"])).direct[0].e.id);
      await tp(page, ([k, x, a]) => { const T = window.__tp; T.state.plan.days = [a, { id: "b", name: "Tag B", items: [{ id: "b1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "b2", exId: x, sets: 3, rmin: 8, rmax: 12, rest: 90 }] }]; localStorage.setItem(k, JSON.stringify(T.state)); }, [KEY, X, dayA]);
      await page.reload(); await page.waitForSelector("#app h1");
      await page.click("nav.tabs [data-v=lib]"); await page.click("#wissenSeg [data-v=wissen]"); await page.click("#wissenCoach");
      const to = await page.getAttribute("[data-ins='plateau:hs-row'] [data-a=coachSwap]", "data-to");
      await page.click("[data-ins='plateau:hs-row'] [data-a=coachSwap]");
      const c1 = await tp(page, () => window.__tp.state.plan.days.map(d => d.items.map(i => i.exId)));
      const dup = c1.some(ids => new Set(ids).size !== ids.length);
      ok("Tausch aus dem Hinweis: Ziel ist ein Gerät, das in keinem betroffenen Tag schon steht; kein Tag hat ein Gerät doppelt", !!to && to !== X && !dup && !c1.flat().includes("hs-row"), JSON.stringify({ X, to, c1 }));
      ok("Direkt danach: „Rückgängig“ ist möglich", await page.isVisible("#undoPlan [data-a=coachUndo]") && !(await page.$("#undoStale")));
      await tp(page, () => { const T = window.__tp; T.state.plan.days[0].items[1].sets = 5; T.save(); });
      await page.click("[data-a=coachBack]"); await page.click("#wissenCoach");
      const b1 = await tp(page, () => ({ stale: !!document.getElementById("undoStale"), undo: !!document.querySelector("#undoPlan [data-a=coachUndo]"), txt: (document.getElementById("undoPlan") || {}).textContent || "" }));
      ok("Plan danach von Hand geändert: kein „Rückgängig“ mehr, sondern der Hinweis, dass es die Änderung verwerfen würde", b1.stale && !b1.undo && b1.txt.includes("seitdem geändert"), JSON.stringify(b1).slice(0, 200));
      const b2 = await tp(page, () => { const T = window.__tp; return { stale: T.prevPlanStale(), sets: T.state.plan.days[0].items[1].sets }; });
      await page.click("#undoPlan [data-a=coachKeep]");
      ok("„Ausblenden“ entfernt den Hinweis; die Handänderung bleibt", b2.stale && b2.sets === 5 && !(await page.$("#undoPlan")) && (await tp(page, () => window.__tp.state.plan.days[0].items[1].sets)) === 5);
      await ctx.close();
    }
    {
      // B. Älterer gespeicherter Stand ohne Vergleichswert: Rückgängig gilt als nicht mehr sicher
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Neu", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const { ctx, page } = await open({ plan, prevPlan: { at: new Date().toISOString(), why: "alt", plan: { goal: "aufbau", level: "einsteiger", days: [{ id: "o", name: "Alt", items: [{ id: "o1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] } } });
      await tp(page, () => window.__tp.go ? 0 : 0);
      const o = await tp(page, () => window.__tp.prevPlanStale());
      ok("Gespeichertes „Rückgängig“ ohne Vergleichswert (ältere Fassung) wird nicht mehr ausgeführt", o === true);
      await ctx.close();
    }
    {
      // D. „Zeit für heute“ und danach den Tag bearbeiten
      const items = [["hs-chest", 4], ["hs-row", 4], ["hs-shoulder", 3], ["hs-pulldown", 3], ["hs-curl", 3], ["hs-dip", 3]].map(([e, n], i) => ({ id: "i" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: 90 }));
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "fortgeschritten", minutes: 60, days: [{ id: "d1", name: "Oberkörper A", items }] } });
      await page.click("[data-a=openTime]"); await page.click("[data-a=timePick][data-m='30']"); await page.click("[data-a=timeApply]");
      const d0 = await tp(page, () => !!window.__tp.state.timeplan);
      await page.click("nav.tabs [data-v=plan]"); await page.click("[data-a=editDay][data-id=d1]"); await page.click("[data-a=openPicker]");
      await page.fill("#pickQ", "Hüftheben").catch(() => {});
      const pickId = await tp(page, () => { const b = [...document.querySelectorAll(".sheet [data-a=pick]")].find(x => !window.__tp.state.plan.days[0].items.some(i => i.exId === x.dataset.id)); return b ? b.dataset.id : null; });
      await page.click(`.sheet [data-a=pick][data-id="${pickId}"]`);
      const d1 = await tp(page, () => { const T = window.__tp, day = T.state.plan.days[0], tp = T.state.timeplan, r = T.previewDay(day, 30);
        return { tp: !!tp, keys: tp ? day.items.every(i => i.id in tp.keep) : null, ex: tp ? tp.ex === r.exCount && tp.sets === r.setCount : null, n: day.items.length }; });
      ok("Gerät hinzugefügt, während „Zeit für heute“ gilt: die Anpassung wird mit denselben 30 Min. neu berechnet und kennt das neue Gerät", d0 && d1.n === 7 && (d1.tp ? d1.keys && d1.ex : true), JSON.stringify(d1));
      await ctx.close();
    }
    {
      // E. „Gerät tauschen“ bietet keine Geräte an, die zeitbedingt ausgeblendet sind oder im Plantag stehen
      const items = [["hs-legpress", 3], ["hs-hack", 3], ["hs-legext", 3], ["hs-seatcurl", 3], ["hs-hipthrust", 3], ["hs-calf", 3]].map(([e, n], i) => ({ id: "l" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: 90 }));
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "L", name: "Beine", items }] } });
      await page.click("[data-a=start]");
      await page.click("[data-a=openJump]"); await page.click("[data-a=openTimeLive]"); await page.click(`[data-a=liveTimePick][data-m="20"]`); await page.click("[data-a=liveTimeApply]");
      if (await page.$(".sheet [data-a=closeSheet]")) await page.click(".sheet [data-a=closeSheet]");
      const hidden = await tp(page, () => (window.__tp.state.session.timeHidden || []).map(x => x.exId));
      await page.click(".actions3 [data-a=openSwap]");
      const alts = await page.$$eval(".sheet [data-a=swap]", a => a.map(x => x.dataset.id));
      const planIds = items.map(i => i.exId);
      ok("„Gerät tauschen“ nach „Zeit anpassen“: kein ausgeblendetes Gerät und kein Gerät des Plantags in der Auswahl", hidden.length > 0 && alts.length > 0 && !alts.some(id => hidden.includes(id) || planIds.includes(id)), JSON.stringify({ hidden, alts }));
      await ctx.close();
    }
    {
      // F. Erholung: Einträge ohne gültigen Satz und gelöschte Geräte zählen nicht
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [R2H("f1", .2, "d1", [R2E("hs-chest", "s", [[0, 10], [40, 0]]), R2E("c-geloescht", "t", [[50, 10]])])] });
      const f = await tp(page, () => { const r = window.__tp.recovery(); return { brust: Math.round(r.brust), min: Math.round(Math.min(...Object.values(r))), known: window.__tp.devKnown("c-geloescht") }; });
      ok("Erholung: ein Eintrag nur mit ungültigen Sätzen und ein gelöschtes Gerät belasten keinen Muskel (Brust 100 statt fast 0)", f.brust === 100 && f.min === 100 && f.known === false, JSON.stringify(f));
      await ctx.close();
    }
    {
      // G. Zwei Fenster: der ältere überschreibt das Training aus dem neueren nicht
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: "block" });
      await ctx.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) { localStorage.setItem(k, v); localStorage.setItem("tp-intro", "0"); localStorage.setItem("tp-3d", "0"); localStorage.setItem("tp-tabmem", "0"); } }, [KEY, JSON.stringify({ plan: PLAN_SMALL, history: [], session: null })]);
      const pa = await ctx.newPage(), pb = await ctx.newPage();
      for (const pg of [pa, pb]) { pg.on("pageerror", e => allErrors.push("runde2-tabs: " + e.message)); await pg.goto(URL); await pg.waitForSelector("#app h1"); }
      await pb.click("[data-a=start]"); await finishAllSets(pb, 40, 10);
      await pa.waitForFunction(() => window.__tp.state.history.length === 1, null, { timeout: 5000 }).catch(() => {});
      const g1 = await tp(pa, () => ({ n: window.__tp.state.history.length, note: (document.getElementById("homeNote") || {}).textContent || "" }));
      await tp(pa, () => { window.__tp.state.stepGoal = 9000; window.__tp.save(); });
      const g2 = await tp(pa, k => JSON.parse(localStorage.getItem(k)).history.length, KEY);
      ok("Zwei Fenster: das andere Fenster übernimmt das dort beendete Training (mit Hinweis) und überschreibt es beim nächsten Speichern nicht", g1.n === 1 && g1.note.includes("anderen Fenster") && g2 === 1, JSON.stringify({ g1, g2 }));
      await ctx.close();
    }
    {
      // H. Planprüfung: „jeder Tag passt in dein Zeitbudget“ nur, wenn die Schätzung im Budget liegt.
      // Alle großen Muskelgruppen sind dabei (sonst erschiene der Satz gar nicht); das Budget liegt 2–3 Min. unter der Schätzung –
      // unter der Schwelle, ab der die Prüfung einen Punkt meldet.
      const items = [["hs-chest", 3], ["hs-row", 3], ["hs-shoulder", 3], ["hs-legpress", 3], ["hs-seatcurl", 3], ["hs-hipthrust", 3]].map(([e, n], i) => ({ id: "h" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: 90 }));
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 90, days: [{ id: "d1", name: "Ganzkörper", items }] } });
      const est = await tp(page, k => { const T = window.__tp, e = T.estimateSec(T.state.plan.days[0].items) / 60; T.state.plan.minutes = Math.floor(e) - 2; localStorage.setItem(k, JSON.stringify(T.state)); return e; }, KEY);
      await page.reload(); await page.waitForSelector("#app h1");
      await page.click("nav.tabs [data-v=plan]");
      await page.$eval("#planCheckBox", d => d.open = true);
      const h = await tp(page, () => ({ txt: document.getElementById("planCheck").textContent.replace(/\s+/g, " "), note: (document.getElementById("planTimeNote") || {}).textContent || "", min: window.__tp.state.plan.minutes, rows: document.querySelectorAll("#planCheck .group .li").length }));
      ok("Planprüfung: ein Tag 2–3 Min. über dem Zeitbudget heißt nicht „passt“, sondern wird mit seiner Schätzung genannt", h.rows === 0 && est > h.min && h.txt.includes("Alle großen Muskelgruppen sind dabei") && !h.txt.includes("jeder Tag passt in dein Zeitbudget") && h.note.includes("Ganzkörper ≈") && h.note.includes(`${h.min} Min.`), JSON.stringify({ est, ...h }).slice(0, 300));
      await ctx.close();
    }
    {
      // I + J. Vorschlag: Pausenregel bei uneinheitlichen Sätzen; Begründungstexte
      const it = { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 };
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag", items: [it] }] };
      const cases = {
        pause: [R2H("x", 200, "d1", [R2E("hs-chest", "s", [[40, 12], [42.5, 10], [42.5, 9]])])],
        kappe: [R2H("x", 3, "d1", [R2E("hs-chest", "s", [[40, 14], [40, 12], [40, 9]])])],
        ohnePlan: [R2H("x", 3, "d1", [Object.assign(R2E("hs-chest", "s", [[40, 12], [40, 12]]), { planned: undefined })])] };
      const res = {};
      for (const [k, history] of Object.entries(cases)) {
        const { ctx, page } = await open({ plan, history });
        res[k] = await tp(page, i => { const e = window.__tp.makeEntry(i); return { mode: e.mode, sets: e.sets.map(s => s.kg + "x" + s.reps).join(" "), why: e.why }; }, it);
        await ctx.close();
      }
      ok("200 Tage Pause nach uneinheitlichen Sätzen: je Satz ein Schritt leichter, ohne „+1 Wdh.“, als Regel der App", res.pause.mode === "down" && res.pause.sets === "37.5x12 40x10 40x9" && res.pause.why.includes("200 Tagen") && res.pause.why.includes("Regel der App"), JSON.stringify(res.pause));
      ok("Begründung nennt die tatsächlichen Ziele („Ziel heute 12/12/10 Wdh.“, höchstens 12) statt „je 1 Wdh. mehr“", res.kappe.sets === "40x12 40x12 40x10" && res.kappe.why.includes("Ziel heute 12/12/10 Wdh.") && res.kappe.why.includes("höchstens 12"), JSON.stringify(res.kappe));
      ok("Eintrag ohne gespeicherte Satzzahl: keine Behauptung „nur 2 von 3 Sätzen“", !res.ohnePlan.why.includes("nur 2 von 3") && res.ohnePlan.why.includes("Heute 3 statt 2 Sätze"), JSON.stringify(res.ohnePlan));
    }
    {
      // K. Letzten Satz des Trainings in der Zusammenfassung bewerten
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag", items: [{ id: "i1", exId: "hs-chest", sets: 2, rmin: 8, rmax: 12, rest: 0 }] }] };
      const { ctx, page } = await open({ plan, history: [R2H("k", 4, "d1", [R2E("hs-chest", "s", [[40, 12], [40, 12]])])] });
      await page.click("[data-a=start]"); await finishAllSets(page, 42.5, 12);
      const k1 = await tp(page, () => ({ box: !!document.getElementById("lastFeel"), txt: (document.getElementById("lastFeel") || {}).textContent || "", next: (document.getElementById("nextTime") || {}).textContent || "" }));
      ok("Zusammenfassung fragt „Wie war der letzte Satz?“ (die Pause mit dieser Frage gibt es nach dem letzten Satz nicht)", k1.box && k1.txt.includes("42,5 × 12") && k1.next.includes("+2,5"), JSON.stringify(k1).slice(0, 240));
      await page.click("#lastFeel [data-f=h]");
      const k2 = await tp(page, () => { const H = window.__tp.state.history, x = H[H.length - 1].exercises[0]; return { f: x.sets.map(s => s.f || "-").join(""), on: document.querySelector("#lastFeel [data-f=h]").classList.contains("on"), next: document.getElementById("nextTime").textContent }; });
      ok("„Schwer“ wird am letzten Satz gespeichert und der Vorschlag fürs nächste Mal sofort angepasst (keine Steigerung)", k2.f.endsWith("h") && k2.on && !k2.next.includes("+2,5") && k2.next.toLowerCase().includes("halten"), JSON.stringify(k2).slice(0, 240));
      await ctx.close();
    }
    {
      // Nachbesserung: „Auf Standard zurücksetzen“ im Training – Sperre nach dem ersten Satz, sonst Neuberechnung
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag A", items: [{ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const seed = { plan, dev: { "hs-chest": { load: "total" } }, history: [R2H("r1", 5, "d1", [R2E("hs-chest", "t", [[80, 10], [80, 10], [80, 9]])])] };
      const reset = async page => { await page.click("[data-a=openDevInfo]"); await page.click(".sheet [data-a=editDev]"); await page.click(".sheet [data-a=devReset]"); };
      let { ctx, page } = await open(seed);
      await page.click("[data-a=start]"); await reset(page);
      if (await page.$(".sheet [data-a=closeSheet]")) await page.click(".sheet [data-a=closeSheet]");
      const r1 = await tp(page, () => { const T = window.__tp, x = T.state.session.list[0]; return { dev: T.unitOf(T.ex("hs-chest")), u: x.u, kg: x.sets.map(s => s.kg).join("/") }; });
      ok("Zurücksetzen vor dem ersten Satz: die heutige Übung folgt der Standard-Angabe „pro Seite“, ohne Gewicht aus den „insgesamt“-Einträgen", r1.dev === "s" && r1.u === "s" && !r1.kg.includes("80"), JSON.stringify(r1));
      await ctx.close();
      ({ ctx, page } = await open(seed));
      await page.click("[data-a=start]"); await page.fill("#kgIn", "80"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      await reset(page);
      const r2 = await tp(page, () => { const T = window.__tp; return { dev: T.unitOf(T.ex("hs-chest")), u: T.state.session.list[0].u, err: (document.getElementById("devErr") || {}).textContent || "" }; });
      ok("Zurücksetzen nach dem ersten Satz: gesperrt mit Erklärung, Gewichtsangabe bleibt „insgesamt“", r2.dev === "t" && r2.u === "t" && r2.err.includes("erst, wenn das heutige Training"), JSON.stringify(r2));
      await ctx.close();
    }
    {
      // Nachbesserung: Gewichtsangabe umstellen nach „Zeit anpassen“ – gekürzte Sätze bleiben gekürzt und kommen zurück
      const items = [["hs-chest", 5], ["hs-row", 5], ["hs-shoulder", 5], ["hs-pulldown", 5], ["hs-curl", 5]].map(([e, n], i) => ({ id: "t" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: 90 }));
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "fortgeschritten", minutes: 90, days: [{ id: "d1", name: "Lang", items }] } });
      await page.click("[data-a=start]");
      await page.click("[data-a=openJump]"); await page.click("[data-a=openTimeLive]"); await page.click(`[data-a=liveTimePick][data-m="30"]`); await page.click("[data-a=liveTimeApply]");
      if (await page.$(".sheet [data-a=closeSheet]")) await page.click(".sheet [data-a=closeSheet]");
      const before = await tp(page, () => { const x = window.__tp.state.session.list.find(l => l.exId === "hs-chest"); return x.sets.length + "+" + (x.trim || []).length; });
      await page.click("[data-a=openDevInfo]"); await page.click(".sheet [data-a=editDev]"); await page.click(".sheet [data-a=devSet][data-k=load][data-v=total]"); await page.click(".sheet [data-a=devSave]");
      if (await page.$(".sheet [data-a=closeSheet]")) await page.click(".sheet [data-a=closeSheet]");
      const after = await tp(page, () => { const x = window.__tp.state.session.list.find(l => l.exId === "hs-chest"); return { n: x.sets.length + "+" + (x.trim || []).length, u: x.u }; });
      ok("Umstellen nach „Zeit anpassen“: die gekürzten Sätze bleiben erhalten (vorher fielen sie weg)", before.endsWith("+0") === false && after.n === before && after.u === "t", JSON.stringify({ before, after }));
      await ctx.close();
    }
    {
      // Nachbesserung: zwei Fenster – offenes Fenster (Sheet), Tag-Bearbeitung und Zusammenfassung bleiben
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: "block" });
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag A", items: [{ id: "i1", exId: "hs-chest", sets: 1, rmin: 8, rmax: 12, rest: 0 }, { id: "i2", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      await ctx.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) { localStorage.setItem(k, v); localStorage.setItem("tp-intro", "0"); localStorage.setItem("tp-3d", "0"); localStorage.setItem("tp-tabmem", "0"); } }, [KEY, JSON.stringify({ plan, history: [R2H("w1", 3, "d1", [R2E("hs-chest", "s", [[40, 10]])])], session: null })]);
      const pa = await ctx.newPage(), pb = await ctx.newPage();
      for (const pg of [pa, pb]) { pg.on("pageerror", e => allErrors.push("runde2-tabs2: " + e.message)); await pg.goto(URL); await pg.waitForSelector("#app h1"); }
      await pa.click("nav.tabs [data-v=plan]"); await pa.click("[data-a=editDay][data-id=d1]"); await pa.click("[data-a=editItem][data-i2='1']");
      await pa.click(".sheet [data-a=draft][data-k=sets][data-d='1']");
      await tp(pb, () => { window.__tp.state.stepGoal = 8000; window.__tp.save(); });
      await pa.waitForFunction(() => window.__tp.state.stepGoal === 8000, null, { timeout: 5000 }).catch(() => {});
      const w1 = await tp(pa, () => ({ sheet: !!document.querySelector(".sheet [data-a=saveItem]"), nav: document.querySelector("#navbar") ? document.querySelector("#navbar").textContent : "", day: window.__tp.state.editDay }));
      await pa.click(".sheet [data-a=saveItem]");
      const w2 = await tp(pa, k => ({ sets: JSON.parse(localStorage.getItem(k)).plan.days[0].items[1].sets, goal: JSON.parse(localStorage.getItem(k)).stepGoal }), KEY);
      ok("Zweites Fenster speichert, während hier ein Gerät bearbeitet wird: das Fenster bleibt offen, die Tag-Bearbeitung bleibt, „Fertig“ speichert die Änderung zusammen mit der von dort", w1.sheet && w1.day === "d1" && w2.sets === 4 && w2.goal === 8000, JSON.stringify({ w1, w2 }));
      await pa.click("nav.tabs [data-v=home]"); await pa.click("[data-a=start]"); await finishAllSets(pa, 42.5, 12);
      await tp(pb, () => { window.__tp.state.stepGoal = 9000; window.__tp.save(); });
      await pa.waitForFunction(() => window.__tp.state.stepGoal === 9000, null, { timeout: 5000 }).catch(() => {});
      const w3 = await tp(pa, () => ({ last: !!document.getElementById("lastFeel"), h1: document.querySelector("#app h1").textContent }));
      await pa.click("#lastFeel [data-f=h]").catch(() => {});
      const w4 = await tp(pa, k => { const H = JSON.parse(localStorage.getItem(k)).history; return H[H.length - 1].exercises.map(x => x.sets.map(s => s.f || "-").join("")).join("|"); }, KEY);
      ok("Zweites Fenster speichert, während hier die Zusammenfassung offen ist: sie bleibt, und die Bewertung des letzten Satzes wird gespeichert", w3.last && w3.h1 === "Tag A" && w4.endsWith("h"), JSON.stringify({ w3, w4 }));
      await ctx.close();
    }
    {
      // Nachbesserung: Gerät zweimal im Tag – die Frage nach dem letzten Satz meint den wirklich letzten
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag", items: [{ id: "a", exId: "hs-chest", sets: 1, rmin: 6, rmax: 12, rest: 0 }, { id: "b", exId: "hs-row", sets: 1, rmin: 6, rmax: 12, rest: 0 }, { id: "c", exId: "hs-chest", sets: 1, rmin: 6, rmax: 12, rest: 0 }] }] };
      const { ctx, page } = await open({ plan });
      await page.click("[data-a=start]");
      for (const [kg, r] of [["40", "10"], ["30", "10"], ["55", "6"]]) { await page.fill("#kgIn", kg); await page.fill("#repsIn", r); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]"); }
      const d1 = await page.textContent("#lastFeel");
      await page.click("#lastFeel [data-f=h]");
      const d2 = await tp(page, () => { const H = window.__tp.state.history; return H[H.length - 1].exercises.map(x => x.exId + ":" + x.sets.map(s => s.kg + "x" + s.reps + (s.f || "")).join("/")).join(" | "); });
      ok("Gerät zweimal im Tag: die Frage nennt 55 × 6 und „Schwer“ landet an diesem Satz", d1.includes("55 × 6") && d2 === "hs-chest:40x10 | hs-row:30x10 | hs-chest:55x6h", JSON.stringify({ d1: d1.slice(0, 80), d2 }));
      await ctx.close();
    }
    {
      // Nachbesserung: nach einem „Nur heute“-Tausch ist das geplante Gerät wieder wählbar
      const items = [["hs-legpress", 3], ["hs-legext", 3]].map(([e, n], i) => ({ id: "q" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: 90 }));
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "L", name: "Beine", items }] } });
      await page.click("[data-a=start]"); await page.click(".actions3 [data-a=openSwap]");
      const first = await page.getAttribute(".sheet #swapDirect [data-a=swap]", "data-id");
      await page.click(`.sheet [data-a=swap][data-id="${first}"]`);
      await page.click(".actions3 [data-a=openSwap]");
      const alts = await page.$$eval(".sheet [data-a=swap]", a => a.map(x => x.dataset.id));
      ok("Nach einem Tausch „Nur heute“ lässt sich zum geplanten Gerät zurücktauschen; ein anderes Gerät des Tages wird nicht angeboten", alts.includes("hs-legpress") && !alts.includes("hs-legext") && !alts.includes(first), JSON.stringify({ first, alts }));
      await ctx.close();
    }
    {
      // Nachbesserung: Texte – Planprüfung, Ziel-Begründung, Pausenregel, älteres „Rückgängig“, Bewertung
      const it = { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 };
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag", items: [it] }] };
      const run = async history => { const { ctx, page } = await open({ plan, history }); const e = await tp(page, i => { const x = window.__tp.makeEntry(i); return { mode: x.mode, sets: x.sets.map(s => s.kg + "x" + s.reps).join(" "), why: x.why, short: x.short }; }, it); await ctx.close(); return e; };
      const n1 = await run([R2H("x", 3, "d1", [R2E("hs-chest", "s", [[40, 10], [40, 9], [40, 6]])])]);
      ok("Ziel unter dem unteren Wert angehoben (10/9/6 → 11/10/8): neutral „im Bereich 8–12“ statt „je 1 mehr“", n1.why.includes("Ziel heute 11/10/8 Wdh. (im Bereich 8–12)") && !n1.why.includes("je 1 mehr"), n1.why);
      const n2 = await run([R2H("x", 3, "d1", [R2E("hs-chest", "s", [[40, 10], [40, 9], [40, 9]])])]);
      ok("Echt je eine Wiederholung mehr (10/9/9 → 11/10/10): „je 1 mehr als zuletzt“ ohne „höchstens“", n2.why.includes("Ziel heute 11/10/10 Wdh.: je 1 mehr als zuletzt.") && !n2.why.includes("höchstens"), n2.why);
      const n3 = await run([R2H("x", 30, "d1", [R2E("hs-chest", "s", [[2.5, 12], [5, 10], [5, 9]])])]);
      ok("Pause nach uneinheitlichen Sätzen, ein Satz schon am kleinsten Gewicht: „in 2 von 3 Sätzen“ statt „je Satz“", n3.mode === "down" && n3.sets.startsWith("2.5x") && n3.short.includes("in 2 von 3 Sätzen") && n3.why.includes("in 2 von 3 Sätzen"), JSON.stringify(n3));
      const n4 = await run([R2H("x", 30, "d1", [R2E("hs-chest", "s", [[1.25, 12], [2.5, 10]])])]);
      ok("Alle Sätze schon am kleinsten Gewicht: keine Reduktion behauptet, Gewicht halten", n4.mode === "hold" && n4.short.includes("Gewicht halten") && !n4.why.includes("leichter zum"), JSON.stringify(n4));
      const old = await open({ plan, prevPlan: { at: new Date().toISOString(), why: "alt", plan: { goal: "aufbau", level: "einsteiger", days: [{ id: "o", name: "Alt", items: [{ id: "o1", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] } } });
      await old.page.click("nav.tabs [data-v=lib]"); await old.page.click("#wissenSeg [data-v=wissen]"); await old.page.click("#wissenCoach");
      const ot = await old.page.textContent("#undoStale");
      ok("Älteres „Rückgängig“ ohne Vergleichswert: die Karte behauptet nicht, der Plan sei geändert worden", ot.includes("älteren Version der App") && !ot.includes("Du hast den Plan seitdem geändert"), ot);
      await old.ctx.close();
      const items = [["hs-chest", 3], ["hs-row", 3], ["hs-shoulder", 3], ["hs-legpress", 3], ["hs-seatcurl", 3], ["hs-hipthrust", 3]].map(([e, n], i) => ({ id: "h" + i, exId: e, sets: n, rmin: 8, rmax: 12, rest: 90 }));
      const pc = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 90, days: [{ id: "d1", name: "Ganzkörper", items }] } });
      await tp(pc.page, k => { const T = window.__tp, e = T.estimateSec(T.state.plan.days[0].items) / 60; T.state.plan.minutes = Math.ceil(e) - 1; localStorage.setItem(k, JSON.stringify(T.state)); }, KEY);
      await pc.page.reload(); await pc.page.waitForSelector("#app h1"); await pc.page.click("nav.tabs [data-v=plan]");
      const note = await pc.page.textContent("#planTimeNote");
      const mins = await tp(pc.page, () => window.__tp.state.plan.minutes);
      ok("Zeitbudget-Hinweis knapp darüber: genannte Minuten liegen über dem Budget, kein doppelter Punkt", note.startsWith("Etwas über") && note.includes(`Ganzkörper ≈ ${mins + 1} Min.`) && !note.includes(".."), note);
      await pc.ctx.close();
    }
    {
      // Ehrlichkeit: Erholung erst ab 2 Sätzen, Anzeige in Stufen statt Prozent, Begründung als Schätzung
      const one = [R2H("e1", 1 / 24, "d1", [R2E("hs-chest", "s", [[40, 10]])])], many = [R2H("e2", 1 / 24, "d1", [R2E("hs-chest", "s", [[40, 10], [40, 10], [40, 10]])])];
      const recOf = async history => { const { ctx, page } = await open({ plan: PLAN_SMALL, history }); const r = await tp(page, () => { const x = window.__tp.recovery(); return { brust: Math.round(x.brust), tri: Math.round(x.trizeps) }; }); return { ctx, page, r }; };
      const a = await recOf(one); await a.ctx.close();
      const b = await recOf(many);
      ok("Erholung: ein einzelner Satz belastet keinen Muskel; drei Sätze vor einer Stunde schon (Brust kaum erholt); mittrainiert zählt halb: Trizeps mit 1,5 gezählten Sätzen bleibt erholt", a.r.brust === 100 && b.r.brust <= 2 && b.r.tri === 100, JSON.stringify([a.r, b.r]));
      await b.page.click("nav.tabs [data-v=plan]");
      const row = await b.page.textContent("[data-a=showRec]");
      await b.page.click("[data-a=showRec]");
      const sh = await b.page.textContent(".sheet");
      ok("Erholung im Plan und im Fenster: Stufen („Belastet“, „Erholt“) statt Prozentzahlen, als Schätzung der App gekennzeichnet", row.includes("Schätzung der App") && sh.includes("Belastet") && sh.includes("Erholt") && !/\d\s?%/.test(sh) && sh.includes("ab 2 Sätzen"), sh.slice(0, 200));
      await b.ctx.close();
    }
    {
      // Ehrlichkeit: Stillstand nicht melden, wenn das Gewicht nach einer Reduktion wieder steigt
      const prog = [28, 21, 14, 7, 1].map((n, k) => R2H("s" + k, n, "d1", [R2E("hs-chest", "s", [[50, 40, 42.5, 45, 47.5][k], 10].map(() => null) && [[[50, 40, 42.5, 45, 47.5][k], 10], [[50, 40, 42.5, 45, 47.5][k], 10], [[50, 40, 42.5, 45, 47.5][k], 10]])]));
      const flat = [28, 21, 14, 7, 1].map((n, k) => R2H("f" + k, n, "d1", [R2E("hs-chest", "s", [[45, 10], [45, 10], [45, 10]])]));
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag", items: [{ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const pl = async history => { const { ctx, page } = await open({ plan, history }); const r = await tp(page, () => !!window.__tp.insights().find(x => x.id === "plateau:hs-chest")); await ctx.close(); return r; };
      const p1 = await pl(prog), p2 = await pl(flat);
      ok("Stillstand: 50 → 40 → 42,5 → 45 → 47,5 kg ist kein Stillstand; fünfmal 45 kg schon", !p1 && p2, JSON.stringify([p1, p2]));
    }
    {
      // Ehrlichkeit: Sicherungszeile „aktuell“ nur ohne Änderungen; nachgetragene Trainings zählen nach dem Eintragszeitpunkt
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [R2H("b1", 3, "d1", [R2E("hs-chest", "s", [[40, 10]])])] });
      await page.click("#navbar [data-a=openSettings]"); await page.click("[data-a=backupOpen]").catch(() => {});
      await tp(page, () => { window.__tp.markBackup(new Date().toISOString()); });
      await page.click("nav.tabs [data-v=home]"); await page.click("#navbar [data-a=openSettings]");
      const l1 = await page.textContent("#backupLine");
      await tp(page, () => { const T = window.__tp; T.state.weights.push({ d: T.dkey(), kg: 80 }); T.save(); });
      await page.click("nav.tabs [data-v=home]"); await page.click("#navbar [data-a=openSettings]");
      const l2 = await page.textContent("#backupLine");
      await tp(page, () => { const T = window.__tp, d = new Date(Date.now() - 5 * 864e5).toISOString(); T.commitTraining({ id: "nt1", dayId: "d1", day: "Test", date: d, durationSec: 0, nt: true, exercises: [{ exId: "hs-chest", name: "x", u: "s", planned: 1, rmin: 8, rmax: 12, sets: [{ kg: 40, reps: 10 }] }] }); T.save(); });
      await page.click("nav.tabs [data-v=home]"); await page.click("#navbar [data-a=openSettings]");
      const l3 = await page.textContent("#backupLine");
      await page.reload(); await page.waitForSelector("#app h1"); await page.click("#navbar [data-a=openSettings]");
      const l4 = await page.textContent("#backupLine");
      ok("Sicherungszeile: direkt nach der Sicherung „aktuell“; nach einem neuen Gewicht „seitdem geändert“; ein für vor 5 Tagen nachgetragenes Training zählt als neu (auch nach Neuladen)", l1.includes("aktuell") && l2.includes("seitdem geändert") && !l2.includes("aktuell") && l3.includes("seitdem 1 Training") && l4.includes("seitdem 1 Training"), JSON.stringify([l1, l2, l3, l4]));
      await ctx.close();
      const old = await open({ plan: PLAN_SMALL, history: [R2H("b2", 3, "d1", [R2E("hs-chest", "s", [[40, 10]])])], backupAt: new Date(Date.now() - 864e5).toISOString() });
      await old.page.click("#navbar [data-a=openSettings]");
      const l5 = await old.page.textContent("#backupLine");
      ok("Sicherung aus einer älteren Fassung (ohne Fingerabdruck): keine Behauptung „aktuell“, sondern „keine neuen Trainings“", l5.includes("keine neuen Trainings") && !l5.includes("aktuell"), l5);
      await old.ctx.close();
    }
    {
      // Ehrlichkeit: Kalorienbilanz zählt alle Trainings des Tages; Bilanz gerundet mit ≈
      const two = [Object.assign(R2H("k1", 0, "d1", [R2E("hs-chest", "s", [[40, 10]])]), { durationSec: 1800, date: new Date(new Date().setHours(9, 0, 0, 0)).toISOString() }),
        Object.assign(R2H("k2", 0, "d1", [R2E("hs-row", "s", [[40, 10]])]), { durationSec: 2700, date: new Date(new Date().setHours(10, 0, 0, 0)).toISOString() })];
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: two, nutr: { cm: 180, age: 35, sex: "m", pal: 1.55, goal: "halten" }, weights: [{ d: (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)(new Date()), kg: 80 }] });
      const e = await tp(page, () => { const T = window.__tp, x = T.dayEnergy(T.dkey()); return x ? { min: x.tr.min, kcal: x.trainKcal, n: x.tr.n } : null; });
      ok("Kalorienbilanz: zwei Trainings am Tag (30 + 45 Min.) zählen zusammen 75 Min., 250 kcal (2,5 × 80 kg × 75/60)", e && e.min === 75 && e.kcal === 250 && e.n === 2, JSON.stringify(e));
      await ctx.close();
    }
    {
      // Nachbesserung Ehrlichkeit: Stillstand-Ausnahme nur nach einer Reduktion
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag", items: [{ id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }] }] };
      const S3 = (kg, r) => r.map(x => [kg, x]);
      const mk = rows => rows.map((sets, k) => R2H("q" + k, (rows.length - k) * 7, "d1", [R2E("hs-chest", "s", sets)]));
      const cases = { schwankt: mk([S3(50, [10, 10, 10]), S3(50, [9, 9, 8]), S3(50, [10, 9, 9]), S3(50, [10, 10, 10])]), zurueck: mk([S3(50, [10, 10, 10]), S3(50, [10, 10, 10]), S3(47.5, [10, 10, 10]), S3(50, [8, 8, 8]), S3(50, [9, 9, 9])]) };
      const res = {};
      for (const [k, history] of Object.entries(cases)) { const { ctx, page } = await open({ plan, history }); res[k] = await tp(page, () => !!window.__tp.insights().find(x => x.id === "plateau:hs-chest")); await ctx.close(); }
      ok("Stillstand bleibt erkannt bei schwankenden Wiederholungen (50 kg: 10/9/10/10) und bei Rückkehr aufs alte Gewicht ohne es zu übertreffen", res.schwankt && res.zurueck, JSON.stringify(res));
    }
    {
      // Nachbesserung Ehrlichkeit: Fingerabdruck unabhängig von Fassung und Bedien-Quittungen
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [R2H("z1", 3, "d1", [R2E("hs-chest", "s", [[40, 10], [40, 10]])])], weights: [{ d: "2026-11-01", kg: 80 }] });
      const z = await tp(page, () => { const T = window.__tp, a = T.dataSig();
        T.EXT.clean.neuTest = () => ({ an: false, liste: [] }); T.extClean(); const b = T.dataSig();   // „Update“: neue Erweiterung mit Standardwerten
        T.state.missSkip = "2026-11-20"; T.state.history[0].hk = true; T.state.weights[0].hk = true; T.state.history[0].exercises[0].name = "Anderer Name"; const c = T.dataSig();
        T.state.weights.push({ d: "2026-11-02", kg: 79 }); const d = T.dataSig(); delete T.EXT.clean.neuTest; return { same1: a === b, same2: a === c, diff: a !== d }; });
      ok("Fingerabdruck: gleich nach einer neuen Erweiterung mit Standardwerten, nach „Nicht jetzt“, Übergabe an Health und anderem Gerätenamen; anders nach einem neuen Gewicht", z.same1 && z.same2 && z.diff, JSON.stringify(z));
      await ctx.close();
    }
    {
      // Nachbesserung Ehrlichkeit: Plural bei Muskelnamen
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "a", name: "Schultertag", items: [{ id: "a1", exId: "hs-shoulder", sets: 4, rmin: 8, rmax: 12, rest: 90 }] }, { id: "b", name: "Beine", items: [{ id: "b1", exId: "hs-legpress", sets: 4, rmin: 8, rmax: 12, rest: 90 }] }] };
      const history = [Object.assign(R2H("p1", 4, "b", [R2E("hs-legpress", "t", [[100, 10], [100, 10]])]), { day: "Beine" }), Object.assign(R2H("p2", 3, "a", [R2E("hs-shoulder", "s", [[20, 10], [20, 10], [20, 10]])]), { day: "Schultertag" }), Object.assign(R2H("p3", 3.5, "b", [R2E("hs-legpress", "t", [[100, 10], [100, 10]])]), { day: "Beine" }), Object.assign(R2H("p4", 1 / 24, "a", [R2E("hs-shoulder", "s", [[20, 10], [20, 10], [20, 10]])]), { day: "Schultertag" })];
      const { ctx, page } = await open({ plan, history: history.slice(0, 3).concat([Object.assign(R2H("p5", 1 / 24, "b", [R2E("hs-shoulder", "s", [[20, 10], [20, 10], [20, 10]])]), { day: "Beine" })]) });   // nur Schultern belastet
      const g = await tp(page, () => { window.__tp.nextDay(); return document.querySelector(".hero") ? document.querySelector(".hero").textContent.replace(/\s+/g, " ") : ""; });
      await page.click("nav.tabs [data-v=plan]");
      const row = await page.textContent("[data-a=showRec]");
      ok("Muskelnamen im Plural: „Schultern erholen sich noch“ bzw. „sind … nicht erholt“, nie „Schultern erholt sich“ oder „ist Schultern“", row.includes("Schultern erholen sich noch") && g.includes("sind Schultern noch nicht erholt"), JSON.stringify({ row, g: g.slice(0, 200) }));
      await ctx.close();
    }
    {
      // Nachbesserung Ehrlichkeit: Tagesplan – ohne Dauer keine kcal; zwei Trainings, eines ohne Dauer
      const d0 = new Date(); d0.setHours(9, 0, 0, 0); const d1 = new Date(); d1.setHours(10, 0, 0, 0);
      const two = [Object.assign(R2H("t1", 0, "d1", [R2E("hs-chest", "s", [[40, 10]])]), { day: "Oberkörper", durationSec: 3000, date: d0.toISOString() }), Object.assign(R2H("t2", 0, "d1", [R2E("hs-row", "s", [[40, 10]])]), { day: "Beine", durationSec: 0, nt: true, date: d1.toISOString() })];
      const today = (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)(new Date());
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: two, nutr: { cm: 180, age: 35, sex: "m", pal: 1.55, goal: "halten" }, weights: [{ d: today, kg: 80 }] });
      await page.click("#homeTag");
      const tt = (await page.textContent("#tagTrain")).replace(/\s+/g, " ");
      ok("Tagesplan: zwei Trainings, eines ohne Dauer – „50 Min. (1 von 2 mit Dauer)“ statt die Minuten beiden zuzuschreiben", tt.includes("Oberkörper + Beine") && tt.includes("50 Min. (1 von 2 mit Dauer)"), tt.slice(0, 200));
      await ctx.close();
      const one = await open({ plan: PLAN_SMALL, history: [Object.assign(R2H("t3", 0, "d1", [R2E("hs-chest", "s", [[40, 10]])]), { durationSec: 0, nt: true, date: d0.toISOString() })], nutr: { cm: 180, age: 35, sex: "m", pal: 1.55, goal: "halten" }, weights: [{ d: today, kg: 80 }] });
      await one.page.click("#homeTag");
      const t1 = (await one.page.textContent("#tagTrain")).replace(/\s+/g, " ");
      ok("Tagesplan: Training ohne Dauer zeigt „ohne Dauer“ und keine kcal-Schätzung", t1.includes("ohne Dauer") && !t1.includes("kcal"), t1.slice(0, 160));
      await one.ctx.close();
    }
    // @ext:runde2:test:end
    // ── Abstand runde2/test 1 ──
    // ── Abstand runde2/test 2 ──
    // ── Abstand runde2/test 3 ──
    // @ext:runde3:test:start
    section("E-runde3. Restliche Befunde: Datengrundlage, Planung, Datensicherheit");
    const R3iso = n => new Date(Date.now() - n * 864e5).toISOString();
    const R3E = (exId, u, sets, extra) => Object.assign({ exId, name: exId, u, planned: sets.length, rmin: 8, rmax: 12, sets: sets.map(([kg, reps, f]) => Object.assign({ kg, reps }, f ? { f } : {})) }, extra || {});
    const R3H = (id, n, dayId, exs) => ({ id, dayId, day: "Tag", date: R3iso(n), durationSec: 1800, exercises: exs });
    const R3plan = items => ({ goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag A", items }] });
    const R3it = (id, exId, sets = 3) => ({ id, exId, sets, rmin: 8, rmax: 12, rest: 90 });
    const R3code = o => "TP1:" + Buffer.from(unescape(encodeURIComponent(JSON.stringify(o))), "binary").toString("base64");
    // Eigener Kontext mit frei gesetztem Speicher (auch ohne Plan, mit weiteren Schlüsseln, fester Uhr oder einem Skript vor dem Start)
    const R3raw = async (store, o = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: "block", acceptDownloads: true });
      if (o.noon) { const noon = new Date(); noon.setHours(12, 0, 0, 0); await ctx.clock.install({ time: noon }); }
      if (o.at) await ctx.clock.install({ time: o.at });
      await ctx.addInitScript(([st, ex]) => { if (!sessionStorage.getItem("seeded")) { for (const k in st) localStorage.setItem(k, st[k]); for (const k in ex) localStorage.setItem(k, ex[k]); sessionStorage.setItem("seeded", "1"); } },
        [store, Object.assign({ "tp-intro": "0", "tp-3d": "0", "tp-tabmem": "0" }, o.extra || {})]);
      if (o.init) await ctx.addInitScript(o.init);
      const page = await ctx.newPage(); page.on("pageerror", e => allErrors.push("runde3: " + e.message)); await page.goto(URL); await page.waitForSelector("#app h1"); return { ctx, page };
    };
    {
      // A1. Datengrundlage jedes Vorschlags
      const mk = hs => ({ plan: R3plan([R3it("i1", "hs-chest")]), history: hs });
      const basis = async hs => { const { ctx, page } = await open(mk(hs)); const r = await tp(page, () => { const T = window.__tp, e = T.makeEntry(T.state.plan.days[0].items[0]); return { b: e.basis, kg: e.recKg }; }); await ctx.close(); return r; };
      const s3 = [[40, 10], [40, 10], [40, 9]];
      const b0 = await basis([]);
      ok("Ohne Verlauf: „Datengrundlage: keine … leitet deshalb kein Gewicht ab“ – und es gibt auch kein Gewicht", b0.b.startsWith("Datengrundlage: keine.") && b0.b.includes("leitet deshalb kein Gewicht ab") && b0.kg === null, JSON.stringify(b0));
      const b1 = await basis([R3H("a", 3, "d1", [R3E("hs-chest", "s", s3)])]);
      ok("Eine Einheit vor 3 Tagen: „1 vergleichbare Einheit … die letzte vor 3 Tagen. Sicherheit: gering – erst eine Einheit (Einschätzung der App)“", b1.b === "Datengrundlage: 1 vergleichbare Einheit an diesem Gerät; die letzte vor 3 Tagen. Sicherheit: gering – erst eine Einheit (Einschätzung der App).", b1.b);
      const b3 = await basis([R3H("a", 10, "d1", [R3E("hs-chest", "s", s3)]), R3H("b", 6, "d1", [R3E("hs-chest", "s", s3)]), R3H("c", 2, "d1", [R3E("hs-chest", "s", s3)])]);
      ok("Drei Einheiten in 10 Tagen: „3 vergleichbare Einheiten …, davon 3 in den letzten 6 Wochen; die letzte vor 2 Tagen. Sicherheit: gut“", b3.b === "Datengrundlage: 3 vergleichbare Einheiten an diesem Gerät, davon 3 in den letzten 6 Wochen; die letzte vor 2 Tagen. Sicherheit: gut (Einschätzung der App).", b3.b);
      const b2 = await basis([R3H("a", 40, "d1", [R3E("hs-chest", "s", s3)]), R3H("b", 18, "d1", [R3E("hs-chest", "s", s3)])]);
      ok("Zwei Einheiten, die letzte vor 18 Tagen: Sicherheit „mittel – die letzte Einheit ist 18 Tage her“", b2.b.includes("2 vergleichbare Einheiten") && b2.b.includes("davon 2 in den letzten 6 Wochen") && b2.b.includes("Sicherheit: mittel – die letzte Einheit ist 18 Tage her"), b2.b);
      const b4 = await basis([R3H("a", 60, "d1", [R3E("hs-chest", "s", s3)]), R3H("b", 30, "d1", [R3E("hs-chest", "s", s3)])]);
      ok("Zwei Einheiten, die letzte vor 30 Tagen: Sicherheit „gering“", b4.b.includes("davon 1 in den letzten 6 Wochen") && b4.b.includes("Sicherheit: gering – die letzte Einheit ist 30 Tage her"), b4.b);
      const b5 = await basis([R3H("a", 9, "d1", [R3E("hs-chest", "t", s3)]), R3H("b", 5, "d1", [R3E("hs-chest", "t", s3)]), R3H("c", 2, "d1", [R3E("hs-chest", "s", s3)])]);
      ok("Einträge mit anderer Gewichtsangabe zählen nicht zur Datengrundlage (2 × „insgesamt“, 1 × „pro Seite“ → 1 Einheit)", b5.b.includes("1 vergleichbare Einheit"), b5.b);
      // Im Training: „Warum?“ zeigt die Datengrundlage – auch nach dem Neuladen
      const { ctx, page } = await open(mk([R3H("a", 10, "d1", [R3E("hs-chest", "s", s3)]), R3H("b", 6, "d1", [R3E("hs-chest", "s", s3)]), R3H("c", 2, "d1", [R3E("hs-chest", "s", s3)])]));
      await page.click("[data-a=start]"); if (await page.$("[data-a=warmDone]")) await page.click("[data-a=warmDone]");
      await page.click("[data-a=showWhy]");
      const w1 = await page.textContent(".sheet");
      ok("Im Training: „Warum?“ nennt Begründung, Datengrundlage und Sicherheit", w1.includes("Letztes Mal") && (await page.textContent("#whyBasis")).includes("3 vergleichbare Einheiten") && w1.includes("Sicherheit: gut") && w1.includes("Du kannst jederzeit abweichen"), w1.slice(0, 300));
      await page.keyboard.press("Escape"); await page.reload(); await page.waitForSelector("[data-a=showWhy]"); await page.click("[data-a=showWhy]");
      ok("… auch nach dem Neuladen im laufenden Training", (await page.textContent("#whyBasis")).includes("3 vergleichbare Einheiten"));
      await page.keyboard.press("Escape"); await page.click("[data-a=askStop]"); await page.click("[data-a=stopDiscard]").catch(() => {});
      await ctx.close();
      // Ohne Verlauf: das ganze Fenster widerspricht sich nicht
      const n0 = await open(mk([]));
      await n0.page.click("[data-a=start]"); if (await n0.page.$("[data-a=warmDone]")) await n0.page.click("[data-a=warmDone]");
      await n0.page.click("[data-a=showWhy]");
      const w0 = await n0.page.textContent(".sheet");
      ok("Neues Gerät: Fenster heißt „Warum kein Vorschlag?“, nennt „Datengrundlage: keine“ und behauptet nicht, ein Vorschlag beruhe auf der letzten Einheit", w0.includes("Warum kein Vorschlag?") && w0.includes("Datengrundlage: keine") && !w0.includes("Der Vorschlag beruht") && !(await n0.page.$("#whyFoot")), w0.slice(0, 300));
      await n0.ctx.close();
      // Kalendertage statt 24-Stunden-Blöcke: feste Uhr, heute 17:00
      const now = new Date(); now.setHours(17, 0, 0, 0);
      const ago = (days, h, m = 0) => { const d = new Date(now); d.setDate(d.getDate() - days); d.setHours(h, m, 0, 0); return d.toISOString(); };
      const Hc = (id, iso, sets = s3) => ({ id, dayId: "d1", day: "Tag", date: iso, durationSec: 1800, exercises: [R3E("hs-chest", "s", sets)] });
      const top = [[40, 12], [40, 12], [40, 12]];
      const cal = async (hs, fn) => { const c = await R3raw({ [KEY]: JSON.stringify(mk(hs)) }, { at: now }); const r = await tp(c.page, fn || (() => { const T = window.__tp; return T.makeEntry(T.state.plan.days[0].items[0]).basis; })); await c.ctx.close(); return r; };
      const c1 = await cal([Hc("a", ago(1, 19))]);
      ok("Gestern 19 Uhr trainiert, jetzt 17 Uhr (22 Stunden): „die letzte gestern“ (vorher „heute“)", c1.includes("die letzte gestern."), c1);
      const c7 = await cal([Hc("a", ago(7, 19))]);
      ok("Vor genau einer Woche um 19 Uhr: „vor 7 Tagen“ (vorher „vor 6 Tagen“)", c7.includes("die letzte vor 7 Tagen."), c7);
      const c15 = await cal([Hc("a", ago(30, 20)), Hc("b", ago(20, 20)), Hc("c", ago(15, 20))]);
      ok("Drei Einheiten, die letzte vor 15 Kalendertagen am Abend: nicht „gut“ (Regel: höchstens 14 Tage), sondern „mittel – die letzte Einheit ist 15 Tage her“", c15.includes("vor 15 Tagen") && c15.includes("Sicherheit: mittel – die letzte Einheit ist 15 Tage her"), c15);
      const c14 = await cal([Hc("a", ago(30, 20)), Hc("b", ago(20, 20)), Hc("c", ago(14, 23, 30))]);
      ok("… bei 14 Kalendertagen (auch spät abends): „gut“", c14.includes("vor 14 Tagen") && c14.includes("Sicherheit: gut"), c14);
      const cg = await cal([Hc("a", ago(40, 20), top), Hc("b", ago(21, 20), top)], () => { const T = window.__tp, e = T.makeEntry(T.state.plan.days[0].items[0]); return { why: e.why, basis: e.basis, mode: e.mode }; });
      ok("Pausenregel und Datengrundlage rechnen beide in Kalendertagen: nach 21 Kalendertagen (erst 20 Tage und 21 Stunden) hält die App das Gewicht und nennt in beiden Texten 21 Tage", cg.mode === "hold" && cg.why.includes("vor 21 Tagen") && cg.basis.includes("ist 21 Tage her") && !(cg.why + cg.basis).includes("20 Tage"), JSON.stringify(cg));
      // Nachtrag für einen früheren Tag: alles bezieht sich auf den gewählten Tag und sagt das
      const cn = await cal([Hc("a", ago(11, 18, 30)), Hc("b", ago(3, 18)), Hc("c", ago(1, 18))], () => { const T = window.__tp, d = new Date(Date.now() - 10 * 864e5); d.setHours(12, 0, 0, 0);
        return T.makeEntry(T.state.plan.days[0].items[0], { at: d.getTime() }).basis; });
      ok("Nachtrag für den Tag vor 10 Tagen: nur die Einheit davor zählt – „1 vergleichbare Einheit an diesem Gerät vor dem gewählten Tag; die letzte am Tag davor“", cn === "Datengrundlage: 1 vergleichbare Einheit an diesem Gerät vor dem gewählten Tag; die letzte am Tag davor. Sicherheit: gering – erst eine Einheit (Einschätzung der App).", cn);
    }
    {
      // A2. Dasselbe Gerät zweimal in einem Training: alle Sätze zählen
      const { ctx, page } = await open({ plan: R3plan([R3it("i1", "hs-chest")]), history: [R3H("a", 3, "d1", [R3E("hs-chest", "s", [[40, 12], [40, 12], [40, 12]]), R3E("hs-chest", "s", [[50, 8], [50, 8], [50, 8]])])] });
      const d = await tp(page, () => { const T = window.__tp, c = T.compSessions("hs-chest", "s"), e = T.makeEntry(T.state.plan.days[0].items[0]);
        return { n: c.length, sets: c[0].sets.length, uni: c[0].uniform, planned: c[0].planned, last: T.lastPerf("hs-chest").length, why: e.why, mode: e.mode }; });
      ok("Gerät doppelt im Training: eine Einheit mit allen 6 Sätzen (vorher zählten nur die ersten 3)", d.n === 1 && d.sets === 6 && d.uni === false && d.planned === 6 && d.last === 6, JSON.stringify(d));
      ok("… der Vorschlag behauptet nicht mehr „alle 3 Sätze mit 12 Wdh. bei 40 kg“ und steigert nicht pauschal", !d.why.includes("alle 3 Sätze") && d.mode !== "up" && d.why.includes("50"), d.why);
      await ctx.close();
    }
    {
      // A3. Nachtragen: Begründung je Gerät, kein Bestwert für unverändert übernommene Vorschläge, Satzgefühl
      const plan = R3plan([R3it("i1", "hs-row")]);
      const history = [R3H("a", 9, "d1", [R3E("hs-row", "s", [[50, 11], [50, 11], [50, 10]])]), R3H("b", 4, "d1", [R3E("hs-row", "s", [[50, 12], [50, 12], [50, 12]])])];
      const { ctx, page } = await open({ plan, history });
      await page.click("#ntHome");
      ok("Nachtragen: Vorschlag mit Steigerung (52,5 × 8) und „Warum?“ am Gerät", (await page.textContent(".nt-x[data-x='0'] .hx-sets")).includes("52,5 × 8") && await page.isVisible(".nt-x[data-x='0'] .nt-why"));
      await page.click(".nt-x[data-x='0'] .nt-why");
      const w = await page.textContent(".sheet");
      ok("„Warum?“ beim Nachtragen: Begründung und Datengrundlage (2 Einheiten, die letzte vor 4 Tagen, Sicherheit mittel)", w.includes("Letztes Mal alle 3 Sätze mit 12 Wdh.") && w.includes("2 vergleichbare Einheiten") && w.includes("die letzte vor 4 Tagen") && w.includes("Sicherheit: mittel"), w.slice(0, 400));
      await page.keyboard.press("Escape"); await page.waitForSelector(".sheet", { state: "detached" }).catch(() => {});
      await page.click("#ntSave"); await page.waitForSelector("#sumCap");
      const s1 = await tp(page, () => ({ pr: !!document.getElementById("prList"), note: (document.getElementById("sugPrNote") || {}).textContent || "", kg: window.__tp.state.history[2].exercises[0].sets.map(t => t.kg).join() }));
      ok("„Wie geplant“ gespeichert: 52,5 kg stehen im Verlauf, aber die Zusammenfassung feiert keinen Bestwert für den Vorschlag der App", s1.kg === "52.5,52.5,52.5" && !s1.pr && s1.note.includes("Kein Bestwert gemeldet für Rudern") && s1.note.includes("unverändert übernommen"), JSON.stringify(s1));
      const wk1 = await tp(page, () => ({ sug: window.__tp.state.history[2].exercises[0].sug, prs: window.__tp.weekStats(0).prs.length, saved: JSON.parse(localStorage.getItem("trainingsplan-v2")).history[2].exercises[0].sug }));
      ok("… auch der Wochenrückblick meldet dafür keinen Bestwert; das Training trägt das Kennzeichen „Vorschlag übernommen“ dauerhaft", wk1.sug === true && wk1.saved === true && wk1.prs === 0, JSON.stringify(wk1));
      await page.reload(); await page.waitForSelector("#app h1");
      ok("… das Kennzeichen übersteht das Neuladen", (await tp(page, () => window.__tp.state.history[2].exercises[0].sug)) === true && (await tp(page, () => window.__tp.weekStats(0).prs.length)) === 0);
      // Im Verlauf korrigiert: ab dann sind es eigene Werte
      const hid = await tp(page, () => window.__tp.state.history[2].id);
      await page.click("[data-a=tab][data-v=history]"); await tp(page, () => { const d = document.getElementById("discLog"); if (d) d.open = true; });
      await page.click(`#discLog [data-a=histOpen][data-id="${hid}"]`); await page.click('.sheet [data-a=histSet][data-x="0"][data-i2="2"]');
      await page.fill("#hsReps", "7"); await page.click("[data-a=histSetSave]");
      const wk2 = await tp(page, () => ({ sug: window.__tp.state.history[2].exercises[0].sug, reps: window.__tp.state.history[2].exercises[0].sets[2].reps, prs: window.__tp.weekStats(0).prs.length }));
      ok("Satz im Verlauf korrigiert (8 → 7 Wdh.): das Kennzeichen entfällt, der Wochenrückblick zählt den Bestwert jetzt", wk2.sug === undefined && wk2.reps === 7 && wk2.prs === 1, JSON.stringify(wk2));
      await ctx.close();
      // Rückblick „Monat“: mit einem Vergleichswert aus einem früheren Monat
      const rb = await open({ plan, history: [R3H("z", 60, "d1", [R3E("hs-row", "s", [[50, 12], [50, 12], [50, 12]])]), R3H("y", 4, "d1", [R3E("hs-row", "s", [[50, 12], [50, 12], [50, 12]])])] });
      await rb.page.click("#ntHome"); await rb.page.click("#ntSave"); await rb.page.waitForSelector("#sumCap");
      const rb1 = await tp(rb.page, () => { const T = window.__tp, d = new Date(), n = () => T.rbStats(T.state.history, T.state.weights, "m", d.getFullYear(), d.getMonth()).recs.length;
        const x = T.state.history[2].exercises[0], a = n(); delete x.sug; const b = n(); x.sug = true; return { kg: x.sets[0].kg, mit: a, ohne: b }; });
      ok("Rückblick „Monat“: der übernommene Vorschlag (52,5 kg) steht nicht unter „Neue Bestwerte“ – ohne das Kennzeichen stünde er dort", rb1.kg === 52.5 && rb1.mit === 0 && rb1.ohne === 1, JSON.stringify(rb1));
      await rb.ctx.close();
      // Nur geöffnet und bestätigt oder nur ein Gefühl gewählt: bleibt ein übernommener Vorschlag
      const same = await open({ plan, history });
      await same.page.click("#ntHome"); await same.page.click("#ntMode [data-v=edit]");
      await same.page.click(".nt-x[data-x='0'] [data-a=ntSet][data-i2='0']"); await same.page.click("[data-a=ntSetSave]"); await same.page.waitForSelector("#ntKg", { state: "detached" });
      await same.page.click(".nt-x[data-x='0'] [data-a=ntSet][data-i2='2']"); await same.page.click("#ntFeel [data-f=m]"); await same.page.click("[data-a=ntSetSave]"); await same.page.waitForSelector("#ntKg", { state: "detached" });
      const lab = await same.page.textContent(".nt-x[data-x='0'] .nt-st"), pill = await same.page.textContent(".nt-x[data-x='0'] [data-a=ntSet][data-i2='2']");
      ok("Satz nur geöffnet und bestätigt, Gefühl „Passt“ gewählt: Zeile bleibt „Vorschlag“ mit „Warum?“, das Gefühl steht sichtbar am Satz", lab.includes("Vorschlag") && lab.includes("Warum?") && pill.includes("52,5 × 8") && pill.includes("passt"), lab + " | " + pill);
      await same.page.click("#ntSave"); await same.page.waitForSelector("#sumCap");
      const s3b = await tp(same.page, () => ({ pr: !!document.getElementById("prList"), note: !!document.getElementById("sugPrNote"), f: window.__tp.state.history[2].exercises[0].sets[2].f }));
      ok("… gespeichert mit Gefühl, aber ohne gefeierten Bestwert (vorher galt das als „geändert“ und die 52,5 kg der App wurden gefeiert)", !s3b.pr && s3b.note && s3b.f === "m", JSON.stringify(s3b));
      await same.ctx.close();
      // Nur ein Gefühl gewählt, dann das Datum geändert: es gilt der Vorschlag für den neuen Tag, das Gefühl bleibt am Satz
      const lday = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
      const fe = await open({ plan, history });
      await fe.page.click("#ntHome"); await fe.page.click("#ntMode [data-v=edit]");
      await fe.page.click(".nt-x[data-x='0'] [data-a=ntSet][data-i2='2']"); await fe.page.click("#ntFeel [data-f=m]"); await fe.page.click("[data-a=ntSetSave]"); await fe.page.waitForSelector("#ntKg", { state: "detached" });
      await fe.page.fill("#ntDate", lday(6)); await fe.page.waitForFunction(d => window.__tp.state.x.nachtrag.d === d, lday(6));
      const fe1 = await tp(fe.page, () => { const x = window.__tp.state.x.nachtrag.list[0]; return { sets: x.sets.map(t => t.kg + "x" + t.reps + (t.f || "")).join(), lab: document.querySelector(".nt-x[data-x='0'] .nt-st").textContent }; });
      ok("Gefühl „Passt“ gewählt, Datum auf vor 6 Tagen: Vorschlag für diesen Tag (50 × 12/12/11 aus der Einheit davor), nicht die 52,5 kg von heute; das Gefühl bleibt", fe1.sets === "50x12,50x12,50x11m" && fe1.lab.includes("Vorschlag"), JSON.stringify(fe1));
      await fe.ctx.close();
      // Eigene Werte an einem Gerät, das der andere Trainingstag nicht hat: nach dem Zurückwechseln wieder da
      const sw = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag A", items: [R3it("i1", "hs-row")] }, { id: "d2", name: "Tag B", items: [R3it("i2", "hs-legpress")] }] }, history });
      await sw.page.click("#ntHome"); await sw.page.click("#ntDays [data-id=d1]"); await sw.page.click("#ntMode [data-v=edit]");
      await sw.page.click(".nt-x[data-x='0'] [data-a=ntSet][data-i2='0']"); await sw.page.fill("#ntKg", "60"); await sw.page.fill("#ntReps", "8"); await sw.page.click("[data-a=ntSetSave]"); await sw.page.waitForSelector("#ntKg", { state: "detached" });
      await sw.page.click("#ntDays [data-id=d2]"); await sw.page.waitForFunction(() => window.__tp.state.x.nachtrag.dayId === "d2");
      await sw.page.click("#ntDays [data-id=d1]"); await sw.page.waitForFunction(() => window.__tp.state.x.nachtrag.dayId === "d1");
      const sw1 = await tp(sw.page, () => { const x = window.__tp.state.x.nachtrag.list[0]; return x.exId + ":" + x.sets.map(t => t.kg + "x" + t.reps).join(); });
      ok("Trainingstag gewechselt und zurück: die eigenen 60 × 8 am Rudern sind wieder da (vorher verworfen)", sw1 === "hs-row:60x8,52.5x8,52.5x8", sw1);
      await sw.ctx.close();
      // Entwurf von vorgestern, heute geöffnet: Begründung und Datengrundlage beziehen sich auf den gewählten Tag
      const stale = await open({ plan, history, x: { nachtrag: { d: lday(2), dayId: "d1", mode: "plan", min: "", built: lday(2), list: [{ exId: "hs-row", u: "s", rmin: 8, rmax: 12, planned: 3, short: "", why: "alt", basis: "Datengrundlage: 2 vergleichbare Einheiten an diesem Gerät, davon 2 in den letzten 6 Wochen; die letzte vor 2 Tagen. Sicherheit: mittel (Einschätzung der App).", on: true,
        sug: [{ kg: 52.5, reps: 8 }, { kg: 52.5, reps: 8 }, { kg: 52.5, reps: 8 }], sets: [{ kg: 52.5, reps: 8 }, { kg: 52.5, reps: 8 }, { kg: 52.5, reps: 8 }] }] } } });
      await stale.page.click("#ntHome"); await stale.page.click(".nt-x[data-x='0'] .nt-why");
      const st1 = await stale.page.textContent("#whyBasis");
      ok("Entwurf von vorgestern, heute geöffnet: die Datengrundlage wird neu gerechnet und nennt den gewählten Tag („vor dem gewählten Tag … 2 Tage davor“)", st1.includes("vor dem gewählten Tag") && st1.includes("die letzte 2 Tage davor") && !st1.includes("vor 2 Tagen"), st1);
      await stale.page.keyboard.press("Escape");
      // Nachtrag für einen Tag, an dem später am Tag schon ein Training steht: es zählt zur Datengrundlage
      const sd = await tp(stale.page, () => { const T = window.__tp, d = new Date(Date.now() - 12 * 864e5); d.setHours(18, 0, 0, 0);
        T.state.history.unshift({ id: "abend", dayId: "d1", day: "Tag", date: d.toISOString(), durationSec: 1800, exercises: [{ exId: "hs-row", name: "x", u: "s", sets: [{ kg: 45, reps: 10 }, { kg: 45, reps: 10 }, { kg: 45, reps: 10 }] }] });
        const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; return T.ntBuild("d1", dk).list[0].basis; });
      ok("Nachtrag für einen Tag, an dem um 18 Uhr schon ein Training steht: „1 vergleichbare Einheit … am selben Tag“ statt „keine“", sd.includes("1 vergleichbare Einheit") && sd.includes("am selben Tag"), sd);
      await stale.ctx.close();
      // Selbst eingetragen: Bestwert wird gemeldet; Satzgefühl wird gespeichert und wirkt auf den nächsten Vorschlag
      const two = await open({ plan, history });
      await two.page.click("#ntHome"); await two.page.click("#ntMode [data-v=edit]"); await two.page.click(".nt-x[data-x='0'] [data-a=ntSet][data-i2='2']");
      ok("Satz-Fenster: „Wie war der Satz?“ mit Leicht, Passt, Schwer – nichts vorgewählt", (await two.page.$$eval("#ntFeel button", b => b.map(x => x.textContent + ":" + x.getAttribute("aria-pressed")).join())) === "Leicht:false,Passt:false,Schwer:false");
      await two.page.click("#ntFeel [data-f=l]"); await two.page.click("#ntFeel [data-f=l]");
      ok("Erneutes Antippen nimmt die Auswahl wieder weg", (await two.page.$$("#ntFeel .on")).length === 0);
      await two.page.click("#ntFeel [data-f=h]"); await two.page.fill("#ntKg", "55"); await two.page.fill("#ntReps", "12"); await two.page.click("[data-a=ntSetSave]");
      await two.page.waitForSelector("#ntKg", { state: "detached" });
      const feels = () => tp(two.page, () => window.__tp.state.x.nachtrag.list[0].sets.map(t => t.kg + "x" + t.reps + (t.f || "-")).join());
      ok("Entwurf merkt sich das Gefühl am Satz", (await feels()) === "52.5x8-,52.5x8-,55x12h", await feels());
      // „Für alle 3 Sätze“ am ersten Satz: Gewicht und Wiederholungen für alle, das „schwer“ des dritten Satzes bleibt und wandert nicht
      await two.page.click(".nt-x[data-x='0'] [data-a=ntSet][data-i2='0']"); await two.page.fill("#ntKg", "55"); await two.page.fill("#ntReps", "12"); await two.page.click("[data-a=ntSetAll]");
      await two.page.waitForSelector("#ntKg", { state: "detached" });
      ok("„Für alle 3 Sätze“ überträgt nur Gewicht und Wiederholungen: das Gefühl bleibt am dritten Satz (vorher wurde es still gelöscht)", (await feels()) === "55x12-,55x12-,55x12h", await feels());
      await two.page.reload(); await two.page.waitForSelector("#ntHome"); await two.page.click("#ntHome"); await two.page.waitForSelector("#ntSave");
      ok("… auch nach dem Neuladen", (await feels()) === "55x12-,55x12-,55x12h");
      // Datum korrigieren: eigene Eingaben bleiben, die Zeile bleibt „geändert“
      const yd = await tp(two.page, () => { const d = new Date(Date.now() - 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
      await two.page.fill("#ntDate", yd);
      await two.page.waitForFunction(d => window.__tp.state.x.nachtrag.d === d, yd);
      ok("Datum auf gestern geändert: die eigenen Werte samt Gefühl bleiben stehen (vorher: still durch neue Vorschläge ersetzt)", (await feels()) === "55x12-,55x12-,55x12h" && (await two.page.textContent(".nt-x[data-x='0'] .nt-st")).includes("geändert"), await feels());
      await two.page.click("#ntSave"); await two.page.waitForSelector("#sumCap");
      const s2 = await tp(two.page, () => { const T = window.__tp, h = T.state.history[2], it = T.state.plan.days[0].items[0], e = T.makeEntry(it);
        const f = h.exercises[0].sets[2].f; delete h.exercises[0].sets[2].f; const noFeel = T.makeEntry(it).mode; h.exercises[0].sets[2].f = f;
        return { pr: (document.getElementById("prList") || {}).textContent || "", note: !!document.getElementById("sugPrNote"), sug: h.exercises[0].sug, sets: h.exercises[0].sets.map(t => t.kg + "x" + t.reps + (t.f || "")).join(), mode: e.mode, why: e.why, noFeel, wk: T.weekStats(new Date().getDay() === 1 ? 1 : 0).prs.length }; });   // das Training liegt auf gestern – montags also in der Vorwoche
      ok("Selbst eingetragene 55 kg: Bestwert wird gemeldet (Zusammenfassung und Wochenrückblick), kein Kennzeichen „Vorschlag übernommen“", s2.pr.includes("Rudern") && s2.pr.includes("55") && !s2.note && s2.sug === undefined && s2.wk === 1, JSON.stringify(s2));
      ok("Alle drei Sätze 55 × 12 am oberen Ziel, der letzte „schwer“: keine Steigerung – ohne das Gefühl würde die App steigern", s2.sets === "55x12,55x12,55x12h" && s2.mode === "hold" && /schwer/.test(s2.why) && s2.noFeel === "up", JSON.stringify(s2));
      await two.ctx.close();
    }
    {
      // B1. Planvorschlag: harte Regeln über ein Raster (Ziel × Tage × Stufe × Zeit), auch mit abgewählten Geräten
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3)] });
      const grid = await tp(page, () => { const T = window.__tp, R = [], H0 = JSON.stringify(T.state.history);
        const run = tag => { for (const g of ["aufbau", "kraft", "fitness"]) for (const n of [2, 3, 4]) for (const lv of ["einsteiger", "fortgeschritten"]) for (const m of [30, 45, 60, 90]) {
          T.state.sched = null; const pl = T.generatePlan(g, n, lv, m), ms = T.muscleSets(pl);
          R.push({ k: [tag, g, n, lv, m].join("/"), miss: T.MAJOR.filter(x => !ms[x]).join(), over: pl.days.filter(d => T.estimateSec(d.items) / 60 > m).length, small: pl.days.filter(d => d.items.length < 3).length,
            dup: pl.days.filter(d => new Set(d.items.map(i => i.exId)).size !== d.items.length).length, off: pl.days.flatMap(d => d.items).filter(i => T.ex(i.exId).off).length, sets: pl.days.flatMap(d => d.items).filter(i => i.sets < 2 || i.sets > 5).length }); } };
        run("alle");
        ["hs-legpress", "hs-seatcurl", "hs-chest", "hs-row"].forEach(id => { T.state.dev[id] = Object.assign({}, T.state.dev[id] || {}, { off: true }); });
        run("ohne4");
        return { R, hist: JSON.stringify(T.state.history) === H0 }; });
      const bad = f => grid.R.filter(f).map(x => x.k + (x.miss ? ":" + x.miss : ""));
      ok("144 Planvorschläge: kein Gerät außerhalb des Studios, kein Gerät doppelt im Tag", grid.R.length === 144 && !bad(x => x.off || x.dup).length, bad(x => x.off || x.dup).join(" "));
      ok("… kein Tag über der gewählten Trainingszeit (30, 45, 60, 90 Min.), jeder Tag mit mindestens 3 Geräten, 2 bis 5 Sätze je Gerät", !bad(x => x.over || x.small || x.sets).length, bad(x => x.over || x.small || x.sets).join(" "));
      ok("… keine große Muskelgruppe fehlt – auch bei 30 Minuten (vorher fehlte dort in 8 von 72 Plänen die Oberschenkelrückseite)", !bad(x => x.k.startsWith("alle") && x.miss).length, bad(x => x.k.startsWith("alle") && x.miss).join(" "));
      ok("… der Verlauf bleibt beim Erzeugen unberührt", grid.hist);
      const short = await tp(page, () => { const T = window.__tp; ["hs-legpress", "hs-seatcurl", "hs-chest", "hs-row"].forEach(id => { T.state.dev[id].off = false; }); return T.generatePlan("kraft", 2, "einsteiger", 30).days.map(d => d.items.map(i => i.exId).join()); });
      ok("Kraft, 2 Tage, 30 Min.: Tag B behält Hüftheben statt einer zweiten Kniebeuge-Bewegung (vorher: Hackenschmidt, Oberschenkelrückseite fehlte)", short[0] === "hs-chest,hs-row,hs-legpress" && short[1] === "hs-incline,hs-pulldown,hs-hipthrust", JSON.stringify(short));
      const d60 = await tp(page, () => window.__tp.generatePlan("aufbau", 3, "einsteiger", 60).days.map(d => d.items.length).join());
      ok("Mit genug Zeit bleibt die Vorlage vollständig (Aufbau, 3 Tage, 60 Min.: 5, 6 und 6 Geräte)", d60 === "5,6,6", d60);
      // Planprüfung: über dem Richtwert nur durch Mittrainiertes → Hinweis statt „Punkt zu prüfen“
      await tp(page, k => { const T = window.__tp; T.state.sched = null; T.state.plan = T.generatePlan("kraft", 3, "einsteiger", 60); localStorage.setItem(k, JSON.stringify(T.state)); }, KEY);
      await page.reload(); await page.waitForSelector("#app h1"); await page.click("[data-a=tab][data-v=plan]");
      const pc = await tp(page, () => { const T = window.__tp, hi = T.planCheck().out.filter(x => x.kind === "high");
        return { hi: hi.map(x => x.m + ":" + x.v + ":" + x.main).join(), status: document.getElementById("planStatus").textContent, soft: (document.getElementById("planSoftHigh") || {}).textContent || "", rows: document.querySelectorAll("#planCheck .group .li").length }; });
      ok("Frischer Kraft-Plan: Schultern liegen nur durch Mittrainiertes über dem Richtwert – kein „Punkt zu prüfen“, sondern eine Erklärung mit den Zahlen", pc.hi === "schultern:13.5:6" && pc.rows === 0 && pc.status === "Schultern über dem Richtwert – durch Mittrainiertes" && pc.soft.includes("Schultern: 13,5 Sätze pro Woche bei einem Richtwert von 6–12") && pc.soft.includes("Davon 7,5 mittrainiert (zählen halb), eigene Übungen 6") && pc.soft.includes("Bis 25 % über dem Richtwert"), JSON.stringify(pc));
      // Mit 4 Terminen bei 2 Trainingstagen liegt der Wert weit über dem Richtwert: bleibt ein Punkt
      await tp(page, k => { const T = window.__tp; T.state.plan = T.generatePlan("kraft", 2, "einsteiger", 60); T.state.sched = { id: "s", days: [0, 2, 4, 5], time: "18:00", planB: "next", since: new Date().toISOString() }; localStorage.setItem(k, JSON.stringify(T.state)); }, KEY);
      await page.reload(); await page.waitForSelector("#app h1"); await page.click("[data-a=tab][data-v=plan]");
      const pc2 = await tp(page, () => ({ status: document.getElementById("planStatus").textContent, open: document.getElementById("planCheckBox").open, rows: [...document.querySelectorAll("#planCheck .group .li .t")].map(e => e.textContent).join(), max: Math.max(...window.__tp.planCheck().out.filter(x => x.kind === "high").map(x => x.v)) }));
      ok("2 Trainingstage, 4 Termine: weit über dem Richtwert bleibt ein „Punkt zu prüfen“ und die Planprüfung klappt auf (keine Verharmlosung)", /Punkte? zu prüfen/.test(pc2.status) && pc2.open && pc2.rows.includes("Schultern") && pc2.max > 15, JSON.stringify(pc2));
      await ctx.close();
    }
    {
      // B2. „Steht in meinem Studio“: nichts still setzen; abgewählte Geräte im Plan kennzeichnen
      const { ctx, page } = await open({ plan: R3plan([R3it("i1", "hs-chest"), R3it("i2", "hs-row")]), history: [], dev: { "lf-fly": { off: true }, "hs-row": { off: true } } });
      await page.click("[data-a=tab][data-v=plan]");
      const p0 = await tp(page, () => ({ status: document.getElementById("planStatus").textContent, row: (document.querySelector("#planCheck [data-off='hs-row']") || {}).textContent || "" }));
      ok("Planprüfung nennt ein Gerät im Plan, das als „nicht im Studio“ markiert ist", p0.row.includes("Rudern") && p0.row.includes("nicht im Studio · Tag A") && /Punkt/.test(p0.status), JSON.stringify(p0));
      await page.click("[data-a=editDay]");
      ok("Tagesansicht: Kennzeichen „nicht im Studio“ am Gerät (nur dort)", (await page.$$eval("#dayItems .off-b", e => e.map(x => x.closest(".li").dataset.label).join())) === "Rudern");
      await page.click("[data-a=openPicker]"); await page.click(".sheet [data-a=pickAll]");
      ok("Geräteauswahl: Butterfly (Life Fitness) steht als „nicht im Studio“ da", (await page.textContent(".sheet [data-a=pick][data-id=lf-fly]")).includes("nicht im Studio"));
      await page.click(".sheet [data-a=pick][data-id=lf-fly]");
      const k1 = await tp(page, () => ({ off: window.__tp.ex("lf-fly").off, inDay: window.__tp.state.plan.days[0].items.some(i => i.exId === "lf-fly"), txt: document.querySelector(".sheet [data-a=pick][data-id=lf-fly]").textContent }));
      ok("Antippen nimmt es in den Tag und sagt sichtbar: „jetzt als ‚im Studio‘ markiert“", k1.off === false && k1.inDay && k1.txt.includes("jetzt als „im Studio“ markiert"), JSON.stringify(k1));
      await page.click(".sheet [data-a=pick][data-id=lf-fly]");
      const k2 = await tp(page, () => ({ off: window.__tp.ex("lf-fly").off, inDay: window.__tp.state.plan.days[0].items.some(i => i.exId === "lf-fly") }));
      ok("Gleich wieder herausgenommen: die Markierung ist wieder „nicht im Studio“ (vorher blieb sie still gesetzt)", k2.off === true && !k2.inDay && (await stored(page)).dev["lf-fly"].off === true, JSON.stringify(k2));
      await page.click(".sheet [data-a=pick][data-id=lf-fly]"); await page.keyboard.press("Escape"); await page.waitForSelector(".sheet", { state: "detached" }).catch(() => {});
      ok("Eingeplant und Auswahl geschlossen: das Gerät gilt als im Studio und steht ohne Kennzeichen im Tag", (await stored(page)).dev["lf-fly"].off === false && (await page.$$eval("#dayItems .off-b", e => e.length)) === 1);
      await ctx.close();
      // Gerät steht an Tag B und ist bewusst „nicht im Studio“: versehentliches Antippen in Tag A und Zurücknehmen lässt die Markierung, wie sie war
      const two = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Tag A", items: [R3it("i1", "hs-chest")] }, { id: "d2", name: "Tag B", items: [R3it("i2", "hs-row")] }] }, history: [], dev: { "hs-row": { off: true } } });
      await two.page.click("[data-a=tab][data-v=plan]"); await two.page.click("[data-a=editDay][data-id=d1]"); await two.page.click("[data-a=openPicker]"); await two.page.click(".sheet [data-a=pickAll]");
      await two.page.click(".sheet [data-a=pick][data-id=hs-row]"); await two.page.click(".sheet [data-a=pick][data-id=hs-row]");
      ok("… die Markierung „nicht im Studio“ des Geräts an Tag B bleibt erhalten (vorher dauerhaft gelöscht)", (await stored(two.page)).dev["hs-row"].off === true && (await stored(two.page)).plan.days[0].items.length === 1);
      await two.ctx.close();
    }
    {
      // C1. Sicherung wiederherstellen ohne vorher einen Plan anzulegen
      const bak = { plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 5)], session: null };
      const a = await R3raw({}, { extra: { "tp-intro": "1" } });
      ok("Erster Start: „Schon eine Sicherung? Wiederherstellen“ steht auf dem Einstieg", await a.page.isVisible("#introRestore") && (await a.page.textContent("#introRestore")).includes("Wiederherstellen"));
      await a.page.click("#introRestore"); await a.page.fill("#impTxt", R3code(bak)); await a.page.click("[data-a=importDo]");
      await a.page.waitForSelector("#homeNote");
      const a1 = await tp(a.page, k => ({ n: window.__tp.state.history.length, days: window.__tp.state.plan.days.length, note: document.getElementById("homeNote").textContent, prev: localStorage.getItem(k + "-vor-wiederherstellen"), tabs: !document.getElementById("tabs").hidden }), KEY);
      ok("Sicherung vom Einstieg aus eingespielt: Plan und Training sind da, ohne Wegwerf-Plan; keine Kopie eines leeren Stands", a1.n === 1 && a1.days === 1 && a1.note.includes("Sicherung wiederhergestellt") && !a1.note.includes("Kopie") && a1.prev === null && a1.tabs, JSON.stringify(a1));
      await a.ctx.close();
      const b = await R3raw({});
      ok("Auch im Formular „Plan vorschlagen“ (ohne Plan): Link zum Wiederherstellen", await b.page.isVisible("#setupRestore"));
      await b.page.click("#setupRestore");
      ok("… er öffnet das Fenster; der Text nennt, was ersetzt wird, und verspricht ohne eigene Daten keine Kopie", (await b.page.textContent("#impMsg")).includes("Plan, Verlauf, Essen, Gewichte und Einstellungen") && !(await b.page.textContent("#impMsg")).includes("Kopie"));
      await b.ctx.close();
      const c = await open({ plan: PLAN_SMALL, history: [] });
      await c.page.click("#navbar [data-a=openSettings]"); await c.page.click("[data-a=newPlan]"); await c.page.waitForSelector("[data-a=createPlan]");
      ok("Mit vorhandenem Plan zeigt das Formular den Link nicht (dafür gibt es die Zeile in den Einstellungen)", !(await c.page.$("#setupRestore")));
      await c.ctx.close();
    }
    {
      // C6. Wiederherstellen lässt sich zurückholen: der Stand von vorher bleibt als Kopie
      const old = { plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 30, reps: 10 }], 90), { id: "alt1" })], session: null };
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 40, reps: 10 }], 5), { id: "neu1" }), Object.assign(hist("hs-chest", [{ kg: 40, reps: 11 }], 1), { id: "neu2" })], weights: [{ d: "2026-10-01", kg: 82.4 }] });
      const ids = () => tp(page, () => window.__tp.state.history.map(h => h.id).join());
      await page.click("#navbar [data-a=openSettings]");
      ok("Ohne Wiederherstellen gibt es keine Zeile „Stand vor dem Wiederherstellen“", !(await page.$("#row-prev")));
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", R3code(old)); await page.click("[data-a=importDo]"); await page.click("[data-a=restoreConfirm]");
      await page.waitForSelector("#homeNote");
      const u1 = await tp(page, k => ({ note: document.getElementById("homeNote").textContent, prev: JSON.parse(localStorage.getItem(k + "-vor-wiederherstellen")).data.history.map(h => h.id).join() }), KEY);
      ok("Nach dem Wiederherstellen: der Stand von vorher liegt als Kopie auf dem Gerät, der Hinweis sagt wo", (await ids()) === "alt1" && u1.prev === "neu1,neu2" && u1.note.includes("14 Tage als Kopie unter Plan → Einstellungen"), JSON.stringify(u1));
      await page.click("#navbar [data-a=openSettings]"); await page.click("#row-prev");
      ok("Einstellungen → „Stand vor dem Wiederherstellen“: 2 Trainings, noch 14 Tage", (await page.textContent("#prevInfo")).includes("2 Trainings") && (await page.textContent("#prevInfo")).includes("noch 14 Tage"), await page.textContent("#prevInfo"));
      await page.click("[data-a=restoreUndoDo]"); await page.waitForSelector("#homeNote");
      const u2 = await tp(page, k => ({ w: window.__tp.state.weights.length, prev: JSON.parse(localStorage.getItem(k + "-vor-wiederherstellen")).data.history.map(h => h.id).join(), saved: JSON.parse(localStorage.getItem(k)).history.map(h => h.id).join() }), KEY);
      ok("„Diesen Stand zurückholen“: die 2 neueren Trainings und das Gewicht sind wieder da und gespeichert; der eingespielte Stand ist jetzt die Kopie", (await ids()) === "neu1,neu2" && u2.w === 1 && u2.saved === "neu1,neu2" && u2.prev === "alt1", JSON.stringify(u2));
      await page.click("#navbar [data-a=openSettings]"); await page.click("#row-prev"); await page.click("[data-a=restoreUndoDrop]");
      ok("„Kopie löschen“ entfernt nur die Kopie", (await tp(page, k => localStorage.getItem(k + "-vor-wiederherstellen"), KEY)) === null && !(await page.$("#row-prev")) && (await ids()) === "neu1,neu2");
      // Kopie verfällt nach 14 Tagen
      const gone = await tp(page, k => { localStorage.setItem(k + "-vor-wiederherstellen", JSON.stringify({ at: new Date(Date.now() - 15 * 864e5).toISOString(), data: window.__tp.state })); const a = window.__tp.prevCopy(); return [a, localStorage.getItem(k + "-vor-wiederherstellen")]; }, KEY);
      ok("Eine 15 Tage alte Kopie gilt nicht mehr und wird entfernt (Regel der App: 14 Tage)", gone[0] === null && gone[1] === null);
      await ctx.close();
      // Zweites Wiederherstellen: die vorhandene Kopie wird nicht still überschrieben
      const dev = { plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 40, reps: 10 }], 5), { id: "neu1" })] };
      const PK = KEY + "-vor-wiederherstellen", copyIds = pg => tp(pg, k => { const r = localStorage.getItem(k); return r ? JSON.parse(r).data.history.map(h => h.id).join() : null; }, PK);
      const restore = async (pg, o) => { await pg.click("#navbar [data-a=openSettings]"); await pg.click("[data-a=importOpen]"); await pg.fill("#impTxt", R3code(o)); await pg.click("[data-a=importDo]"); if (await pg.$("[data-a=restoreConfirm]")) await pg.click("[data-a=restoreConfirm]"); };
      const s2 = await open(dev);
      await restore(s2.page, old); await s2.page.waitForSelector("#homeNote");
      const other = { plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 35, reps: 10 }], 60), { id: "zwei1" })], session: null };
      await restore(s2.page, other);
      const q1 = await tp(s2.page, () => ({ msg: document.getElementById("impMsg").textContent, btn: [...document.querySelectorAll("#impConfirm [data-a]")].map(b => b.dataset.a).join(), ids: window.__tp.state.history.map(h => h.id).join() }));
      ok("Zweites Wiederherstellen: Rückfrage „Es gibt schon eine Kopie … wird ersetzt“ – bis dahin bleiben Stand und Kopie unverändert", q1.msg.includes("Es gibt schon eine Kopie") && q1.btn === "restoreOverCopy" && q1.ids === "alt1" && (await copyIds(s2.page)) === "neu1", JSON.stringify(q1));
      await s2.page.click("[data-a=restoreOverCopy]"); await s2.page.waitForSelector("#homeNote");
      ok("„Kopie ersetzen und wiederherstellen“: neuer Stand eingespielt, der Stand davor ist jetzt die Kopie", (await tp(s2.page, () => window.__tp.state.history.map(h => h.id).join())) === "zwei1" && (await copyIds(s2.page)) === "alt1");
      await s2.ctx.close();
      // Speicher reicht nicht für die Kopie (setItem wirft nur für diesen Schlüssel): nicht still ersetzen, ältere Kopie bleibt
      const failCopy = pg => tp(pg, k => { const orig = Storage.prototype.setItem; window.__r3orig = orig; Storage.prototype.setItem = function (key, v) { if (key === k) throw new DOMException("voll", "QuotaExceededError"); return orig.call(this, key, v); }; }, PK);
      const s3 = await open(dev, { extra: { [PK]: JSON.stringify({ at: new Date().toISOString(), data: { plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 20, reps: 10 }], 200), { id: "uralt" })] } }) } });
      await failCopy(s3.page);
      await s3.page.click("#navbar [data-a=openSettings]"); await s3.page.click("[data-a=importOpen]"); await s3.page.fill("#impTxt", R3code(old)); await s3.page.click("[data-a=importDo]"); await s3.page.click("[data-a=restoreConfirm]"); await s3.page.click("[data-a=restoreOverCopy]");
      const q2 = await tp(s3.page, () => ({ msg: document.getElementById("impMsg").textContent, btn: [...document.querySelectorAll("#impConfirm [data-a]")].map(b => b.dataset.a).join(), ids: window.__tp.state.history.map(h => h.id).join(), saved: JSON.parse(localStorage.getItem("trainingsplan-v2")).history.map(h => h.id).join() }));
      ok("Kopie lässt sich nicht schreiben: Meldung „reicht der Speicher nicht“, der Stand ist unverändert, die ältere Kopie ist noch da (vorher: gelöscht)", q2.msg.includes("reicht der Speicher nicht") && q2.btn === "restoreNoCopy" && q2.ids === "neu1" && q2.saved === "neu1" && (await copyIds(s3.page)) === "uralt", JSON.stringify(q2));
      await s3.page.click("[data-a=restoreNoCopy]"); await s3.page.waitForSelector("#homeNote");
      const q3 = await tp(s3.page, () => ({ ids: window.__tp.state.history.map(h => h.id).join(), note: document.getElementById("homeNote").textContent }));
      ok("„Ohne Kopie ersetzen“ spielt ein, verspricht keine Kopie und lässt die ältere Kopie stehen", q3.ids === "alt1" && !q3.note.includes("Kopie") && (await copyIds(s3.page)) === "uralt", JSON.stringify(q3));
      // Zurückholen, wenn der jetzige Stand nicht als Kopie abgelegt werden kann: nachfragen statt ersetzen
      await s3.page.click("#navbar [data-a=openSettings]"); await s3.page.click("#row-prev"); await s3.page.click("[data-a=restoreUndoDo]");
      const q4 = await tp(s3.page, () => ({ msg: document.getElementById("prevMsg").textContent, btn: !!document.querySelector("#prevConfirm [data-force='1']"), ids: window.__tp.state.history.map(h => h.id).join() }));
      ok("Zurückholen ohne Platz für die Kopie: Meldung und „Ohne Kopie zurückholen“ – nichts ist geändert (vorher: still ersetzt)", q4.msg.includes("reicht der Speicher nicht") && q4.btn && q4.ids === "alt1" && (await copyIds(s3.page)) === "uralt", JSON.stringify(q4));
      await s3.ctx.close();
      // Zurückholen bei pausiertem Training ist gesperrt
      const s4 = await open(Object.assign({}, dev, { session: { dayId: "d1", dayName: "Test", start: Date.now() - 6e5, paused: Date.now() - 1000, idx: 0, phase: "set", list: [{ key: "k1", itemId: "i1", exId: "hs-chest", rmin: 8, rmax: 12, rest: 90, u: "s", planned: 2, sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: false }] }] } }),
        { extra: { [PK]: JSON.stringify({ at: new Date().toISOString(), data: old }) } });
      await s4.page.click("#navbar [data-a=openSettings]"); await s4.page.click("#row-prev"); await s4.page.click("[data-a=restoreUndoDo]");
      const q5 = await tp(s4.page, () => ({ msg: document.getElementById("prevMsg").textContent, ids: window.__tp.state.history.map(h => h.id).join(), done: window.__tp.state.session.list[0].sets.filter(t => t.done).length }));
      ok("Zurückholen bei pausiertem Training: gesperrt mit Hinweis, Stand und erledigter Satz bleiben", q5.msg.includes("Erst das laufende Training beenden") && q5.ids === "neu1" && q5.done === 1, JSON.stringify(q5));
      await s4.ctx.close();
      // Auch ohne Training, Essen oder Gewicht gibt es etwas Eigenes (eigenes Gerät, Studio-Auswahl): dann entsteht eine Kopie
      const s5 = await open({ plan: null, history: [], custom: [{ id: "c-1", name: "Mein Gerät", muscle: "ruecken", sec: [], type: "plate" }], dev: { "hs-chest": { off: true } } });
      await s5.page.click("#setupRestore"); await s5.page.fill("#impTxt", R3code(old)); await s5.page.click("[data-a=importDo]"); await s5.page.waitForSelector("#homeNote");
      const q6 = await tp(s5.page, k => { const r = localStorage.getItem(k); return r ? JSON.parse(r).data.custom.map(c => c.name).join() : null; }, PK);
      ok("Stand nur mit eigenem Gerät und Studio-Auswahl: bekommt vor dem Ersetzen ebenfalls eine Kopie (vorher keine)", q6 === "Mein Gerät", String(q6));
      await s5.ctx.close();
      // Kopie lässt sich schreiben, der neue Stand aber nicht (zusammen zu groß): alles wird zurückgerollt – Stand im Fenster, Speicher und die ältere Kopie
      const s6 = await open(dev, { extra: { [PK]: JSON.stringify({ at: new Date().toISOString(), data: { plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 20, reps: 10 }], 200), { id: "uralt" })] } }) } });
      await s6.page.click("#navbar [data-a=openSettings]"); await s6.page.click("[data-a=importOpen]"); await s6.page.fill("#impTxt", R3code(old)); await s6.page.click("[data-a=importDo]"); await s6.page.click("[data-a=restoreConfirm]");
      await tp(s6.page, k => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (key, v) { if (key === k) throw new DOMException("voll", "QuotaExceededError"); return orig.call(this, key, v); }; }, KEY);
      await s6.page.click("[data-a=restoreOverCopy]");
      const q7 = await tp(s6.page, () => ({ msg: document.getElementById("impMsg").textContent, btn: [...document.querySelectorAll("#impConfirm [data-a]")].map(b => b.dataset.a).join(), mem: window.__tp.state.history.map(h => h.id).join(), saved: JSON.parse(localStorage.getItem("trainingsplan-v2")).history.map(h => h.id).join() }));
      ok("Neuer Stand lässt sich nach dem Ablegen der Kopie nicht speichern: Stand im Fenster und im Speicher unverändert, die ältere Kopie liegt wieder da, die App fragt nach", q7.msg.includes("reicht der Speicher nicht") && q7.btn === "restoreNoCopy" && q7.mem === "neu1" && q7.saved === "neu1" && (await copyIds(s6.page)) === "uralt", JSON.stringify(q7));
      await s6.ctx.close();
      // Leerer Stand (z. B. nach einer leeren Sicherung), aber es gibt eine Kopie: Zurückholen ist auch ohne Plan erreichbar
      const s7 = await R3raw({ [PK]: JSON.stringify({ at: new Date().toISOString(), data: dev }) }, { extra: { "tp-intro": "1" } });
      ok("Ohne Plan, aber mit Kopie: der Einstieg bietet „Stand vor dem Wiederherstellen zurückholen“", await s7.page.isVisible("#introUndo"));
      await s7.page.click("#introUndo"); await s7.page.click("[data-a=restoreUndoDo]"); await s7.page.waitForSelector("#homeNote");
      const q8 = await tp(s7.page, k => ({ ids: window.__tp.state.history.map(h => h.id).join(), copy: localStorage.getItem(k), note: document.getElementById("homeNote").textContent }), PK);
      ok("… zurückgeholt; von dem leeren Stand bleibt keine Kopie zurück", q8.ids === "neu1" && q8.copy === null && !q8.note.includes("Kopie"), JSON.stringify(q8));
      await s7.ctx.close();
    }
    {
      // C2. Daten aus einer neueren Fassung der App werden nicht überschrieben
      const newer = JSON.stringify({ v: 8, plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 40, reps: 10 }], 3), { id: "n1", neuAmTraining: 5 })], session: null, neuesFeld: { a: 1 }, x: { neueErweiterung: { b: 2 } } });
      const a = await R3raw({ [KEY]: newer });
      const n1 = await tp(a.page, () => ({ warn: !document.getElementById("newerWarn").hidden, txt: document.getElementById("newerWarn").textContent, n: window.__tp.state.history.length, v: window.__tp.DATA_V }));
      ok("Gespeicherte Daten mit höherer Fassung (v 8 > 7): Hinweis „aus einer neueren Fassung … speichert … keine Änderungen“, die Daten werden angezeigt", n1.warn && n1.txt.includes("neueren Fassung") && n1.txt.includes("Neu laden") && n1.n === 1 && n1.v === 7, JSON.stringify(n1));
      await a.page.click("[data-a=start]");
      const blk = await tp(a.page, () => ({ txt: (document.getElementById("newerBlockTxt") || {}).textContent || "", ses: window.__tp.state.session }));
      ok("Training starten ist dann gesperrt: „Erst neu laden … ein Training wäre danach verloren“ (vorher lief es durch und war nach dem Neuladen weg)", blk.txt.includes("kann nichts speichern") && blk.ses === null, JSON.stringify(blk));
      await a.page.keyboard.press("Escape"); await a.page.waitForSelector(".sheet", { state: "detached" }).catch(() => {});
      await a.page.click("#ntHome");
      ok("Nachtragen ebenso", !!(await a.page.$("#newerBlockTxt")) && (await a.page.textContent("#app h1")) !== "Training nachtragen");
      await a.page.keyboard.press("Escape"); await a.page.waitForSelector(".sheet", { state: "detached" }).catch(() => {});
      await a.page.click("#navbar [data-a=openSettings]"); await a.page.click("[data-a=importOpen]"); await a.page.fill("#impTxt", JSON.stringify({ plan: PLAN_SMALL, history: [] })); await a.page.click("[data-a=importDo]");
      const rs = await tp(a.page, k => ({ msg: document.getElementById("impMsg").textContent, prev: localStorage.getItem(k + "-vor-wiederherstellen"), n: window.__tp.state.history.length }), KEY);
      ok("Wiederherstellen wird abgelehnt und legt keine Kopie an (vorher: „wiederhergestellt“ gemeldet, obwohl nichts gespeichert wurde)", rs.msg.includes("neueren Fassung") && rs.prev === null && rs.n === 1, JSON.stringify(rs));
      await a.page.keyboard.press("Escape"); await a.page.waitForSelector(".sheet", { state: "detached" }).catch(() => {});
      await a.page.click("[data-a=tab][data-v=plan]"); await a.page.click("[data-a=editDay]"); await a.page.fill("#dayName", "Umbenannt"); await a.page.keyboard.press("Tab");
      await tp(a.page, () => { window.__tp.state.why = "x"; window.__tp.save(); });
      ok("… beim Bedienen bleibt der Speicher Zeichen für Zeichen unverändert (vorher fielen unbekannte Felder beim ersten Speichern weg)", (await tp(a.page, k => localStorage.getItem(k), KEY)) === newer);
      const pa = await R3raw({ [KEY]: JSON.stringify({ v: 8, plan: PLAN_SMALL, history: [], session: { dayId: "d1", dayName: "Test", start: Date.now() - 6e5, paused: Date.now() - 1000, idx: 0, phase: "set", list: [{ key: "k1", itemId: "i1", exId: "hs-chest", rmin: 8, rmax: 12, rest: 90, u: "s", planned: 2, sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: false }] }] } }) });
      await pa.page.click("[data-a=resumeT]");
      ok("Pausiertes Training fortsetzen ist bei Daten einer neueren Fassung ebenfalls gesperrt", !!(await pa.page.$("#newerBlockTxt")) && (await tp(pa.page, () => !!window.__tp.state.session.paused)) && !(await pa.page.$("[data-a=doneSet]")));
      await pa.ctx.close();
      ok("Nach einer nicht gespeicherten Änderung sagt der Hinweis das", (await a.page.textContent("#newerWarnTxt")).includes("ist nicht gespeichert und geht beim Neuladen verloren"));
      await a.page.click("#newerWarn [data-a=reloadAsk]");
      ok("„Neu laden“ fragt dann erst nach", (await a.page.textContent("#newerWarn [data-a=reloadAsk]")).includes("Ungespeichertes geht verloren") && (await tp(a.page, () => window.__tp.state.why)) === "x");
      await a.ctx.close();
      const b = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3)] });
      ok("Gleiche Fassung: kein Hinweis", await tp(b.page, () => document.getElementById("newerWarn").hidden));
      await b.page.click("#navbar [data-a=openSettings]"); await b.page.click("[data-a=importOpen]"); await b.page.fill("#impTxt", newer); await b.page.click("[data-a=importDo]");
      const n2 = await tp(b.page, () => ({ msg: document.getElementById("impMsg").textContent, kg: window.__tp.state.history[0].exercises[0].sets[0].kg, id: window.__tp.state.history[0].id }));
      ok("Sicherung aus einer neueren Fassung: wird nicht eingespielt, mit Begründung", n2.msg.includes("neueren Fassung") && n2.id !== "n1", JSON.stringify(n2));
      await b.page.keyboard.press("Escape");
      const before = await tp(b.page, k => localStorage.getItem(k), KEY);
      await tp(b.page, ([k, v]) => window.dispatchEvent(new StorageEvent("storage", { key: k, newValue: v })), [KEY, newer]);
      await tp(b.page, () => { window.__tp.state.why = "y"; window.__tp.save(); });
      ok("Ein anderes Fenster mit neuerer Fassung hat gespeichert: Hinweis erscheint, dieses Fenster speichert nichts mehr darüber", (await tp(b.page, () => !document.getElementById("newerWarn").hidden)) && (await tp(b.page, k => localStorage.getItem(k), KEY)) === before);
      await b.ctx.close();
    }
    {
      // C3. Auffangnetz: wirft eine Ansicht, ersetzt die Rettungsseite nur diese Ansicht; unerwartete Zustände des laufenden Trainings
      const ses = sets => ({ dayId: "d1", dayName: "Test", start: Date.now() - 6e5, idx: 0, phase: "set", list: [{ key: "k1", itemId: "i1", exId: "hs-chest", rmin: 8, rmax: 12, rest: 90, u: "s", mode: "keep", why: "", planned: 2, sets }] });
      // Schalter für die Tests: ist window.__boom gesetzt, wirft die nächste Stelle, die eine Zahl zweistellig schreibt (Datum, Uhrzeit) – genau einmal.
      // Scharfstellen und Antippen laufen in einem Zug, damit der Sekundentakt der Trainingsuhr nicht dazwischenkommt.
      const boom = () => { const orig = String.prototype.padStart; String.prototype.padStart = function (...a) { if (window.__boom) { window.__boom = 0; throw new Error("Test: Ansicht wirft"); } return orig.apply(this, a); }; };
      const boomClick = (pg, sel) => tp(pg, q => { window.__boom = 1; document.querySelector(q).click(); }, sel);
      const state = JSON.stringify({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3)], session: null });
      const a = await R3raw({ [KEY]: state }, { init: boom });
      await a.page.click("nav.tabs [data-v=history]"); await boomClick(a.page, "nav.tabs [data-v=home]");
      const r1 = await tp(a.page, () => ({ h1: document.querySelector("#app h1").textContent, txt: (document.getElementById("rescue") || {}).textContent || "", tabs: document.getElementById("tabs").hidden, btn: [...document.querySelectorAll("#rescue [data-a]")].map(b => b.dataset.a).join() }));
      ok("Wirft die Ansicht „Heute“, steht dort „Diese Seite lässt sich nicht anzeigen“ – Daten nicht gelöscht, mit technischem Hinweis; die Leiste unten bleibt", r1.h1 === "Diese Seite lässt sich nicht anzeigen" && r1.txt.includes("nicht gelöscht") && r1.txt.includes("Test: Ansicht wirft") && r1.tabs === false, JSON.stringify(r1));
      ok("… mit: Daten sichern, neu laden, Einstellungen", r1.btn === "rescueSave,reloadApp,openSettings", r1.btn);
      const [dl] = await Promise.all([a.page.waitForEvent("download"), a.page.click("[data-a=rescueSave]")]);
      const file = require("fs").readFileSync(await dl.path(), "utf8");
      ok("„Daten als Datei sichern“ lädt den gespeicherten Stand unverändert herunter", file === state && /^trainingsplan-daten-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
      await a.page.click("nav.tabs [data-v=plan]");
      ok("Die anderen Bereiche bleiben erreichbar: „Plan“ öffnet sich normal (vorher sperrte die Rettungsseite die ganze App aus)", !(await a.page.$("#rescue")) && (await a.page.textContent("#app")).includes("Test"));
      await a.ctx.close();
      // Im laufenden Training: beenden und speichern funktioniert wirklich; verwerfen erst beim zweiten Tipp
      const run = JSON.stringify({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }], 3)], session: ses([{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: false }]) });
      const t = await R3raw({ [KEY]: run }, { init: boom });
      await boomClick(t.page, "[data-a=voiceToggle]");
      const r2 = await tp(t.page, () => ({ h1: document.querySelector("#app h1").textContent, btn: [...document.querySelectorAll("#rescue [data-a]")].map(b => b.dataset.a).join() }));
      ok("Wirft die Trainingsansicht: „Das Training lässt sich nicht anzeigen“ mit „Zur Startseite“, beenden und speichern, verwerfen", r2.h1 === "Das Training lässt sich nicht anzeigen" && r2.btn === "rescueSave,reloadApp,tab,rescueFinish,rescueDrop", JSON.stringify(r2));
      await t.page.click("[data-a=rescueFinish]"); await t.page.waitForSelector("#sumCap");
      const r3 = await tp(t.page, k => ({ mem: window.__tp.state.history.length, ses: window.__tp.state.session, st: JSON.parse(localStorage.getItem(k)), sets: window.__tp.state.history[1].exercises[0].sets.length }), KEY);
      ok("„Laufendes Training beenden und speichern“: der erledigte Satz steht im Verlauf und ist gespeichert, das Training ist beendet", r3.mem === 2 && r3.ses === null && r3.st.history.length === 2 && r3.st.session === null && r3.sets === 1, JSON.stringify({ mem: r3.mem, sets: r3.sets }));
      await t.ctx.close();
      const d = await R3raw({ [KEY]: run }, { init: boom });
      await boomClick(d.page, "[data-a=voiceToggle]"); await d.page.click("[data-a=rescueDrop]");
      ok("„Verwerfen“ fragt erst nach – beim ersten Tipp bleibt das Training erhalten", (await d.page.textContent("[data-a=rescueDrop]")).includes("Wirklich verwerfen?") && JSON.parse(await tp(d.page, k => localStorage.getItem(k), KEY)).session !== null);
      await d.page.click("[data-a=rescueDrop]"); await d.page.waitForSelector("[data-a=start]");
      const r4 = await tp(d.page, k => ({ ses: window.__tp.state.session, st: JSON.parse(localStorage.getItem(k)).session, n: window.__tp.state.history.length, h1: document.querySelector("#app h1").textContent }), KEY);
      ok("Zweiter Tipp: das Training ist verworfen (auch im Speicher), der Verlauf unberührt, die App zeigt wieder „Heute“", r4.ses === null && r4.st === null && r4.n === 1 && r4.h1 === "Heute", JSON.stringify(r4));
      await d.ctx.close();
      const b = await R3raw({ [KEY]: JSON.stringify({ plan: PLAN_SMALL, history: [], session: Object.assign(ses([{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: true }]), { phase: "rest", restEnd: Date.now() + 6e4, restTotal: 90,
        list: [{ key: "k1", itemId: "i1", exId: "hs-chest", rmin: 8, rmax: 12, rest: 90, u: "s", planned: 2, sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: true }] }, { key: "k2", itemId: "i2", exId: "hs-legpress", rmin: 8, rmax: 12, rest: 90, u: "s", planned: 1, sets: [{ kg: 100, reps: 10, done: false }] }] }) }) });
      const r5 = await tp(b.page, () => ({ phase: window.__tp.state.session.phase, idx: window.__tp.state.session.idx }));
      if (await b.page.$("[data-a=warmDone]")) await b.page.click("[data-a=warmDone]");
      await b.page.fill("#kgIn", "100"); await b.page.fill("#repsIn", "10"); await b.page.click("[data-a=doneSet]"); await b.page.waitForSelector("#sumCap");
      ok("Laufendes Training in der Pause, aktuelle Übung ohne offenen Satz: die App startet bei der nächsten offenen Übung, „Satz fertig“ funktioniert und das Training lässt sich beenden", !(await b.page.$("#rescue")) && r5.phase === "set" && r5.idx === 1 && (await tp(b.page, () => window.__tp.state.history.length)) === 1, JSON.stringify(r5));
      await b.ctx.close();
      const c = await R3raw({ [KEY]: JSON.stringify({ plan: PLAN_SMALL, history: [], session: Object.assign(ses([{ kg: 40, reps: 10, done: false }]), { list: [{ key: "k0", exId: "hs-row", sets: [null] }, { key: "k1", exId: "hs-chest", rmin: 8, rmax: 12, rest: 90, u: "s", sets: [{ kg: 40, reps: 10, done: false }] }] }) }) });
      ok("Übung im laufenden Training ohne gültigen Satz wird beim Laden entfernt, der Rest läuft weiter", !(await c.page.$("#rescue")) && (await tp(c.page, () => window.__tp.state.session.list.map(x => x.exId).join())) === "hs-chest");
      await c.ctx.close();
    }
    {
      // C4. Wochenziel: Termine pro Woche, sonst Tage mit Geräten
      const days = [{ id: "d1", name: "A", items: [R3it("i1", "hs-chest")] }, { id: "d2", name: "B", items: [R3it("i2", "hs-row")] }, { id: "d3", name: "C", items: [R3it("i3", "hs-legpress")] }];
      const H = [Object.assign(hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 0), { date: new Date(Date.now() - 2000).toISOString() }), Object.assign(hist("hs-row", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 0), { dayId: "d2", date: new Date(Date.now() - 1000).toISOString() })];
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days }, history: H, sched: { id: "s1", days: [0, 3], time: "18:00", planB: "next", since: R3iso(40) } });
      const g1 = await tp(page, () => ({ g: window.__tp.weekGoal(), txt: document.getElementById("homeWeekSec").textContent }));
      ok("3 Trainingstage, 2 Termine pro Woche, 2 Trainings diese Woche: Wochenziel 2 – „2 von 2“ (vorher „2 von 3“, nie erreichbar)", g1.g === 2 && g1.txt.includes("2 von 2"), JSON.stringify(g1));
      const g2 = await tp(page, () => { const T = window.__tp; T.state.sched = null; const a = T.weekGoal(); T.state.plan.days.push({ id: "d4", name: "Leer", items: [] }); const b = T.weekGoal(); T.state.plan.days = []; return [a, b, T.weekGoal()]; });
      ok("Ohne Termine: Zahl der Tage mit Geräten (3); ein leerer Tag zählt nicht mit; mindestens 1", g2.join() === "3,3,1", g2.join());
      await ctx.close();
      const two = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days }, history: H, sched: { id: "s1", days: [0, 3], time: "18:00", planB: "next", since: R3iso(40) } });
      await two.page.click("#homeWeek");
      ok("Wochenrückblick: „2 / 2“ und „Wochenziel erreicht“", (await two.page.textContent("#app")).includes("Wochenziel erreicht: 2 von 2 Trainings"));
      await two.page.click("nav.tabs [data-v=lib]"); await two.page.click("#wissenSeg [data-v=wissen]"); await two.page.click("#wissenCoach");
      const rules = await two.page.textContent("#coachRules");
      ok("„So entscheidet die App“ legt die Regeln „Wochenziel“ und „Datengrundlage“ offen", rules.includes("Wochenziel") && rules.includes("die Zahl deiner Termine pro Woche") && rules.includes("Datengrundlage") && rules.includes("gut ab 3 Einheiten in 6 Wochen") && rules.includes("Abstände zählen in Kalendertagen"));
      await two.ctx.close();
      // Mehr Termine als Trainingstage: Ring, „Noch diese Woche“ und Meilenstein-Text nennen dasselbe Ziel
      const four = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: days.slice(0, 2) }, history: [H[0]], sched: { id: "s1", days: [0, 1, 3, 4], time: "23:59", planB: "next", since: R3iso(40) } });
      const w4 = await tp(four.page, () => ({ g: window.__tp.weekGoal(), ring: document.getElementById("homeWeekSec").textContent, left: (document.getElementById("weekLeft") || {}).textContent || "" }));
      ok("2 Trainingstage, 4 Termine, 1 Training: „1 von 4“ und „Noch diese Woche“ nennt 3 Trainings im Wechsel (vorher nur 2)", w4.g === 4 && w4.ring.includes("1 von 4") && /Noch diese Woche: B, A, B/.test(w4.left), JSON.stringify(w4));
      await four.page.click("[data-a=tab][data-v=history]"); await four.page.click("#row-meilensteine");
      const mt = await four.page.textContent("#ms-wk");
      ok("Meilensteine „Wochen in Folge“ erklären das Ziel richtig: „4 Trainings pro Woche (Zahl deiner Termine pro Woche)“ (vorher „Zahl der Trainingstage in deinem Plan“)", mt.includes("Wochenziel: 4 Trainings pro Woche (Zahl deiner Termine pro Woche)"), mt.slice(-200));
      await four.ctx.close();
    }
    {
      // C5. Training mit Datum in der Zukunft (z. B. aus einer Sicherung)
      const fut = Object.assign(hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 0), { date: new Date(Date.now() + 3 * 864e5).toISOString(), day: "Zukunft" });
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-legpress", [{ kg: 100, reps: 10 }, { kg: 100, reps: 10 }], 10), fut] });
      const f1 = await tp(page, () => { const r = window.__tp.recovery(); return { brust: r.brust, beinev: r.beinev }; });
      ok("Ein Training mit Datum in 3 Tagen belastet die Erholung noch nicht (vorher: Brust tagelang „nicht erholt“)", f1.brust === 100 && f1.beinev === 100, JSON.stringify(f1));
      const f2 = await tp(page, () => { const T = window.__tp, e = T.makeEntry({ id: "x", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 });
        return { basis: e.basis, kg: e.recKg, last: T.lastPerf("hs-chest"), week: document.getElementById("homeWeekSec").textContent, wk: T.weekStats(0).n }; });
      ok("… es zählt auch nicht für Vorschlag und Datengrundlage („keine“), nicht für „Letztes Mal“ und nicht für die Woche (0 Trainings)", f2.basis.startsWith("Datengrundlage: keine") && f2.kg === null && f2.last === null && /0 von/.test(f2.week) && f2.wk === 0, JSON.stringify(f2));
      await page.click("[data-a=tab][data-v=history]");
      ok("Fortschritt weist darauf hin: Datum in der Zukunft, mit dem Weg zur Korrektur", (await page.textContent("#histFuture")).includes("„Zukunft“ hat ein Datum in der Zukunft") && (await page.textContent("#histFuture")).includes("zählt es erst ab diesem Tag") && (await page.textContent("#histFuture")).includes("Datum oder Dauer ändern"), await page.textContent("#histFuture").catch(() => ""));
      await ctx.close();
      // Mit fester Uhr (12:00): Eintrag heute 14:00 – zählt weder für die Serie noch als „erledigt“ im Wochenplan
      const noonT = new Date(); noonT.setHours(12, 0, 0, 0);
      const fu = await R3raw({ [KEY]: JSON.stringify({ plan: PLAN_SMALL, history: [Object.assign(hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 0), { date: new Date(noonT.getTime() + 2 * 3600e3).toISOString() })] }) }, { noon: true });
      const f3 = await tp(fu.page, () => { const T = window.__tp, m = new Date(); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - (m.getDay() + 6) % 7); const p = T.plannedOn(T.dkey());
        return { streak: T.weekStreak(m, 1), done: !!(p && p.done), ring: document.getElementById("homeWeekSec").textContent, buddy: document.getElementById("buddy").textContent.includes("Heute erledigt") }; });
      ok("Eintrag in 2 Stunden: keine Serie, der Tag gilt nicht als erledigt, „0 von 1“, kein „Heute erledigt“", f3.streak === 0 && !f3.done && /0 von 1/.test(f3.ring) && !f3.buddy, JSON.stringify(f3));
      await fu.ctx.close();
      const ok2 = await open({ plan: PLAN_SMALL, history: [hist("hs-legpress", [{ kg: 100, reps: 10 }, { kg: 100, reps: 10 }], 10)] });
      await ok2.page.click("[data-a=tab][data-v=history]");
      ok("Ohne solche Einträge kein Hinweis", !(await ok2.page.$("#histFuture")));
      await ok2.ctx.close();
    }
    {
      // C7. Speichern schlägt fehl: die Zusammenfassung sagt es
      const { ctx, page } = await open({ plan: R3plan([R3it("i1", "hs-row")]), history: [R3H("a", 4, "d1", [R3E("hs-row", "s", [[50, 10], [50, 10], [50, 10]])])] });
      await page.click("#ntHome");
      await tp(page, k => { const orig = Storage.prototype.setItem; window.__r3orig = orig; Storage.prototype.setItem = function (key, v) { if (key === k) throw new DOMException("voll", "QuotaExceededError"); return orig.call(this, key, v); }; }, KEY);
      await page.click("#ntSave"); await page.waitForSelector("#sumCap");
      const q1 = await tp(page, k => ({ sum: (document.getElementById("sumUnsaved") || {}).textContent || "", warn: !document.getElementById("saveWarn").hidden, btn: !!document.querySelector("#saveWarn [data-a=backupFile]"), stored: JSON.parse(localStorage.getItem(k)).history.length, mem: window.__tp.state.history.length }), KEY);
      ok("Speicher voll beim Speichern eines Trainings: Zusammenfassung sagt „Noch nicht gespeichert“ und bietet die Datei-Sicherung an", q1.sum.includes("Noch nicht gespeichert") && q1.sum.includes("Jetzt als Datei sichern") && q1.warn && q1.btn && q1.stored === 1 && q1.mem === 2, JSON.stringify(q1));
      await tp(page, () => { Storage.prototype.setItem = window.__r3orig; window.__tp.save(); });
      ok("Klappt das Speichern wieder, verschwindet der Hinweis oben", (await tp(page, k => document.getElementById("saveWarn").hidden && JSON.parse(localStorage.getItem(k)).history.length === 2, KEY)) === true);
      await ctx.close();
      const fine = await open({ plan: R3plan([R3it("i1", "hs-row")]), history: [R3H("a", 4, "d1", [R3E("hs-row", "s", [[50, 10], [50, 10], [50, 10]])])] });
      await fine.page.click("#ntHome"); await fine.page.click("#ntSave"); await fine.page.waitForSelector("#sumCap");
      ok("Normal gespeichertes Training: kein „Noch nicht gespeichert“", !(await fine.page.$("#sumUnsaved")) && (await tp(fine.page, () => document.getElementById("saveWarn").hidden)));
      // Im laufenden Training: der Hinweis sagt, dass die Datei das Training erst nach dem Beenden enthält
      await fine.page.click("[data-a=tab][data-v=home]"); await fine.page.click("[data-a=start]");
      await tp(fine.page, k => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (key, v) { if (key === k) throw new DOMException("voll", "QuotaExceededError"); return orig.call(this, key, v); }; window.__tp.save(); }, KEY);
      ok("Speichern schlägt im laufenden Training fehl: Hinweis nennt „Das laufende Training steht erst nach dem Beenden in der Datei“", (await fine.page.textContent("#saveWarnTxt")).includes("Das laufende Training steht erst nach dem Beenden in der Datei") && (await tp(fine.page, () => !document.getElementById("saveWarn").hidden)));
      await fine.ctx.close();
    }
    {
      // D. Vorher leere oder uhrzeitabhängige Prüfungen
      const days = [{ id: "d1", name: "Erster", items: [R3it("i1", "hs-chest", 1)] }, { id: "d2", name: "Zweiter", items: [R3it("i2", "hs-row", 1)] }];
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days }, history: [] });
      const nd = await tp(page, () => window.__tp.nextDay().id);
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay][data-id=d2]"); await page.click("#dayStart");
      const st = await tp(page, () => ({ day: window.__tp.state.session.dayId, ex: window.__tp.state.session.list.map(x => x.exId).join() }));
      ok("Plan mit zwei Tagen: „Zweiter starten“ startet genau den zweiten Tag, obwohl laut Wechsel der erste dran wäre", nd === "d1" && st.day === "d2" && st.ex === "hs-row", JSON.stringify({ nd, st }));
      await ctx.close();
      // Termin verpasst – mit fester Uhr (12:00), unabhängig von der Uhrzeit des Testlaufs
      const a = await R3raw({ [KEY]: JSON.stringify({ plan: PLAN_SMALL, history: [], backupAt: new Date().toISOString(), sched: { id: "s1", days: [0, 1, 2, 3, 4, 5, 6], time: "10:00", planB: "short", since: R3iso(30) } }) }, { noon: true });
      const bt = await a.page.textContent("#buddy");
      ok("Termin um 10:00, jetzt 12:00: Buddy bietet Plan B an (30-Minuten-Version)", bt.includes("Dein Termin war um 10:00") && bt.includes("Plan B: die 30-Minuten-Version"), bt.slice(0, 200));
      await a.ctx.close();
    }
    // @ext:runde3:test:end
    // ── Abstand runde3/test 1 ──
    // ── Abstand runde3/test 2 ──
    // ── Abstand runde3/test 3 ──
    // @ext:nachtrag:test:start
    section("E-nachtrag. Training nachtragen (ohne Live-Modus)");
    {
      const iso = n => new Date(Date.now() - n * 864e5).toISOString();
      const lday = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
      const E = (exId, sets) => ({ exId, name: exId, u: "s", planned: sets.length, rmin: 8, rmax: 12, sets: sets.map(([kg, reps]) => ({ kg, reps })) });
      const plan = { goal: "aufbau", level: "einsteiger", minutes: 60, days: [
        { id: "a", name: "Oberkörper", items: [{ id: "a1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a2", exId: "hs-row", sets: 3, rmin: 8, rmax: 12, rest: 90 }, { id: "a3", exId: "hs-shoulder", sets: 2, rmin: 8, rmax: 12, rest: 90 }] },
        { id: "b", name: "Beine", items: [{ id: "b1", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 120 }] }] };
      const history = [
        { id: "h1", dayId: "a", day: "Oberkörper", date: iso(7), durationSec: 2700, exercises: [E("hs-chest", [[40, 10], [40, 10], [40, 9]]), E("hs-row", [[50, 12], [50, 12], [50, 12]])] },
        { id: "h2", dayId: "b", day: "Beine", date: iso(4), durationSec: 2400, exercises: [E("hs-legpress", [[100, 10], [100, 10], [100, 10]])] }];
      const { ctx, page } = await open({ plan, history }, { light: true });
      const pills = xi => page.$$eval(`.nt-x[data-x="${xi}"] .hx-sets .set-pill:not(.nt-add)`, e => e.map(x => x.textContent).join(" | "));
      const stat = xi => page.$eval(`.nt-x[data-x="${xi}"] .nt-st`, e => e.textContent);
      const hist = () => tp(page, () => window.__tp.state.history.map(h => ({ id: h.id, nt: !!h.nt, dayId: h.dayId, sec: h.durationSec, skip: (h.skip || []).join(), d: h.date, ex: h.exercises.map(x => `${x.exId}:${x.planned}:${x.sets.map(s => s.kg + "x" + s.reps).join("/")}`).join(" ") })));
      ok("Heute: unter „Training starten“ steht „Schon trainiert? Nachtragen“", await page.isVisible("#ntHome") && (await page.textContent("#ntHome")).includes("Nachtragen"));
      await page.click("#ntHome");
      const v0 = await tp(page, () => { const T = window.__tp, dr = T.state.x.nachtrag, d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const day = T.state.plan.days.find(x => x.id === dr.dayId), live = day.items.map(it => T.makeEntry(it).sets.map(s => ({ kg: s.kg, reps: s.reps })));
        return { title: document.querySelector("#app h1").textContent, back: document.querySelector("#navbar .nb-back").textContent.trim(), tab: document.querySelector("#tabs button.on").dataset.v, date: document.querySelector("#ntDate").value === today && dr.d === today,
          day: dr.dayId, next: T.nextDay().id, chip: document.querySelector("#ntDays .chip.on").textContent, mode: document.querySelector("#ntMode .on").dataset.v, same: JSON.stringify(dr.list.map(x => x.sets)) === JSON.stringify(live), session: T.state.session }; });
      ok("Nachtragen: eigene Seite mit „‹ Heute“, Datum heute, als Trainingstag der nächste laut Plan, Auswahl „Wie geplant“; kein Live-Training wird gestartet", v0.title === "Training nachtragen" && v0.back === "Heute" && v0.tab === "home" && v0.date && v0.day === v0.next && v0.day === "a" && v0.chip === "Oberkörper" && v0.mode === "plan" && v0.session === null, JSON.stringify(v0));
      ok("Die Vorschläge sind genau die des Live-Modus (dieselbe Funktion): Brustpresse 40 × 11 | 40 × 11 | 40 × 10, Rudern 52,5 × 8", v0.same && (await pills(0)) === "40 × 11 | 40 × 11 | 40 × 10" && (await pills(1)) === "52,5 × 8 | 52,5 × 8 | 52,5 × 8", JSON.stringify([await pills(0), await pills(1)]));
      ok("Werte sind als Vorschlag gekennzeichnet; in „Wie geplant“ nicht antippbar", (await stat(0)).includes("3 Sätze · pro Seite · Vorschlag") && (await page.textContent("#ntHint")).includes("Vorschläge der App") && (await page.$$("#ntList button.set-pill")).length === 0);
      ok("Gerät ohne Verlauf: „? × 12“ statt eines erfundenen Gewichts, mit Hinweis", (await pills(2)) === "? × 12 | ? × 12" && (await page.textContent(".nt-x[data-x='2'] .nt-miss")).includes("Noch kein Gewicht bekannt") && (await page.textContent("#ntErr")).includes("Schulterpresse: Gewicht fehlt."), await page.textContent("#ntErr"));
      await page.click("#ntSave");
      ok("Ohne Gewicht lässt sich nicht speichern: Verlauf unverändert, Seite bleibt", (await hist()).length === 2 && (await page.textContent("#app h1")) === "Training nachtragen" && await page.isVisible("#ntErr"));
      // Werte ändern
      await page.click("#ntMode [data-v=edit]");
      await page.click(".nt-x[data-x='2'] [data-a=ntSet]");
      await page.fill("#ntKg", "0"); await page.click("[data-a=ntSetSave]");
      ok("Satz-Fenster: 0 kg wird abgelehnt, das Fenster bleibt offen", await page.isVisible("#ntSetErr") && (await page.textContent("#ntSetErr")).includes("größer als 0") && (await page.textContent("#ntSetFor")).includes("Schulterpresse"));
      await page.fill("#ntKg", "30"); await page.fill("#ntReps", "10"); await page.click("[data-a=ntSetAll]");
      await page.waitForSelector("#ntKg", { state: "detached" });
      ok("„Für alle 2 Sätze“: Schulterpresse 30 × 10 | 30 × 10, gekennzeichnet als „geändert“; der Fehler ist weg", (await pills(2)) === "30 × 10 | 30 × 10" && (await stat(2)).includes("geändert") && !(await page.isVisible("#ntErr")), JSON.stringify([await pills(2), await stat(2)]));
      // Teilweise
      await page.click("#ntMode [data-v=teil]");
      await page.click(".nt-x[data-x='1'] .switch");
      await page.click(".nt-x[data-x='0'] [data-a=ntSet][data-i2='2']"); await page.click("[data-a=ntSetDel]");
      await page.waitForSelector("#ntKg", { state: "detached" });
      ok("„Teilweise“: Rudern ausgeschaltet = „ausgelassen“, dritter Satz Brustpresse entfernt → „2 Geräte · 4 Sätze“", (await stat(1)) === "ausgelassen" && (await page.$eval(".nt-x[data-x='1'] .switch", b => b.getAttribute("aria-checked"))) === "false" && (await pills(0)) === "40 × 11 | 40 × 11" && (await page.textContent("#ntSum")) === "2 Geräte · 4 Sätze", JSON.stringify([await stat(1), await pills(0), await page.textContent("#ntSum")]));
      // Entwurf übersteht einen Neustart
      await page.reload(); await page.waitForSelector("#ntHome"); await page.click("#ntHome");
      ok("Neustart mitten im Nachtrag: der Entwurf ist noch da (Auswahl, Änderungen, ausgelassenes Gerät)", (await page.$eval("#ntMode .on", b => b.dataset.v)) === "teil" && (await pills(2)) === "30 × 10 | 30 × 10" && (await stat(1)) === "ausgelassen" && (await pills(0)) === "40 × 11 | 40 × 11" && (await hist()).length === 2);
      await page.fill("#ntMin", "abc");
      const e1 = await page.textContent("#ntErr");
      await page.fill("#ntMin", "");
      ok("Dauer ist freiwillig: „abc“ wird abgelehnt, leer ist erlaubt", e1.includes("1 bis 300 Minuten") && !(await page.isVisible("#ntErr")), e1);
      await page.click("#ntSave");
      const h1 = await hist(), n1 = h1[h1.length - 1];
      const s1 = await tp(page, () => ({ cap: document.querySelector("#sumCap").textContent, dur: document.querySelector("#sumDur").textContent, txt: document.querySelector("#app").textContent, draft: window.__tp.state.x.nachtrag, session: window.__tp.state.session }));
      ok("Speichern: Eintrag im Verlauf mit genau den bestätigten Sätzen, geplanter Satzzahl, „nachgetragen“ und dem ausgelassenen Gerät; Dauer 0 statt einer Schätzung", h1.length === 3 && n1.nt && n1.dayId === "a" && n1.sec === 0 && n1.skip === "hs-row" && n1.ex === "hs-chest:3:40x11/40x11 hs-shoulder:2:30x10/30x10", JSON.stringify(n1));
      ok("Zusammenfassung wie nach dem Live-Training: „Training nachgetragen“, Dauer „–  nicht erfasst“, Bestwert Brustpresse (11 statt 10 Wdh.), erstes Mal Schulterpresse zählt nicht; Entwurf gelöscht", s1.cap.startsWith("Training nachgetragen") && s1.dur.includes("–") && s1.dur.includes("nicht erfasst") && s1.txt.includes("Neue Bestwerte") && s1.txt.includes("11 Wdh. mit 40 kg") && s1.draft === null && s1.session === null, JSON.stringify(s1.cap + s1.dur));
      await page.click(".actionbar [data-a=tab][data-v=home]");
      const c1 = await tp(page, () => { const T = window.__tp, it = T.state.plan.days[0].items[0], e = T.makeEntry(it); return { next: T.nextDay().id, n: T.compSessions("hs-chest").length, short: e.short, sets: e.sets.map(s => s.kg + "x" + s.reps).join("/"), buddy: document.querySelector("#buddy").textContent }; });
      ok("Danach rechnet alles mit dem Eintrag: nächster Trainingstag „Beine“, „Heute erledigt … 4 Sätze.“ ohne Minuten, Vorschlag fürs nächste Mal aus den nachgetragenen Sätzen (2 von 3 → Gewicht halten)", c1.next === "b" && c1.n === 2 && c1.short.includes("unvollständig") && c1.sets === "40x11/40x11/40x11" && c1.buddy.includes("Heute erledigt") && c1.buddy.includes("4 Sätze.") && !c1.buddy.includes("Min."), JSON.stringify(c1));
      // Verlauf: Anzeige und Korrektur
      await page.click("nav.tabs [data-v=history]"); await page.click("#discLog summary");
      const row = await page.textContent("#discLog .li");
      await page.click("#discLog [data-a=histOpen]");
      const sh = await page.textContent(".sheet");
      ok("Fortschritt → Letzte Trainings: „ohne Dauer“; im Eintrag „nachgetragen“ und „Ausgelassen: Rudern“", row.includes("ohne Dauer") && !row.includes("1 Min.") && sh.includes("nachgetragen") && (await page.textContent("#histSkip")) === "Ausgelassen: Rudern", row.slice(0, 120));
      await page.click("[data-a=histMeta]");
      const mv = await page.inputValue("#hmMin");
      await page.click("[data-a=histMetaSave]");
      const k0 = (await hist()).find(h => h.nt).sec;
      await page.click("[data-a=histMeta]"); await page.fill("#hmMin", "55"); await page.click("[data-a=histMetaSave]");
      ok("Datum oder Dauer ändern: ohne erfasste Dauer ist das Feld leer und darf leer bleiben; 55 Min. lassen sich nachtragen", mv === "" && k0 === 0 && (await hist()).find(h => h.nt).sec === 3300, JSON.stringify([mv, k0]));
      await page.click(".sheet .sh-head [data-a=closeSheet]");
      // Früherer Tag: Vorschläge aus dem Verlauf davor, Eintrag rückt an seinen Platz
      await page.click("#row-nachtrag");
      const b0 = await tp(page, () => ({ back: document.querySelector("#navbar .nb-back").textContent.trim(), same: document.querySelector("#ntSame") ? document.querySelector("#ntSame").textContent : "" }));
      ok("Fortschritt → „Training nachtragen“: „‹ Fortschritt“; Hinweis, dass heute schon „Oberkörper“ eingetragen ist", b0.back === "Fortschritt" && b0.same.includes("Oberkörper"), JSON.stringify(b0));
      await page.click("#ntDays [data-id=a]");
      await page.fill("#ntDate", lday(10));
      const p10 = await pills(0);
      await page.fill("#ntDate", lday(5));
      const p5 = [await pills(0), await pills(1), await pills(2)];
      ok("Datum vor allen Trainings: kein Gewicht bekannt („?“). Datum vor fünf Tagen: Vorschlag nur aus dem Training davor (40 × 11 | 40 × 11 | 40 × 10), nicht aus dem von heute", p10 === "? × 12 | ? × 12 | ? × 12" && p5[0] === "40 × 11 | 40 × 11 | 40 × 10" && p5[1] === "52,5 × 8 | 52,5 × 8 | 52,5 × 8" && p5[2] === "? × 12 | ? × 12", JSON.stringify([p10, p5]));
      const tomorrow = lday(-1);
      await page.fill("#ntDate", tomorrow);
      ok("Ein Datum in der Zukunft wird nicht angenommen", (await page.inputValue("#ntDate")) === lday(5) && (await page.textContent("#ntErr")).includes("Zukunft") && (await tp(page, () => window.__tp.state.x.nachtrag.d)) === lday(5));
      await page.click("#ntMode [data-v=teil]"); await page.click(".nt-x[data-x='2'] .switch"); await page.fill("#ntMin", "45"); await page.click("#ntSave");
      const h2 = await hist(), sorted = h2.every((h, i) => i === 0 || new Date(h2[i - 1].d) <= new Date(h.d));
      const c2 = await tp(page, () => { const T = window.__tp; return { n: T.compSessions("hs-chest").map(s => s.sets.length).join(), last: T.makeEntry(T.state.plan.days[0].items[0]).sets.map(s => s.kg + "x" + s.reps).join("/"), sum: document.querySelector("#app").textContent.includes("Rudern") }; });
      ok("Nachtrag für einen früheren Tag: steht im Verlauf an seinem Platz (nach Datum geordnet, zwischen den beiden alten), 45 Min. gespeichert", h2.length === 4 && sorted && h2[1].nt && h2[1].sec === 2700 && h2[1].skip === "hs-shoulder" && h2[1].ex === "hs-chest:3:40x11/40x11/40x10 hs-row:3:52.5x8/52.5x8/52.5x8" && h2[0].id === "h1" && h2[2].id === "h2", JSON.stringify(h2.map(h => [h.id.slice(0, 3), h.nt, h.d.slice(0, 10)])));
      ok("Der Vorschlag fürs nächste Training richtet sich weiter nach dem jüngsten Training (heute), nicht nach dem zuletzt eingetippten", c2.n === "3,3,2" && c2.last === "40x11/40x11/40x11", JSON.stringify(c2));
      // Laden und Sicherung behalten die Kennzeichen
      const rt = await tp(page, () => { const T = window.__tp, n = T.normalize(JSON.parse(JSON.stringify(T.state))); return n.history.map(h => `${h.nt ? "nt" : "-"}:${(h.skip || []).join()}`).join(" "); });
      await page.reload(); await page.waitForSelector("#app h1");
      const rl = (await hist()).map(h => `${h.nt ? "nt" : "-"}:${h.skip}`).join(" ");
      ok("Laden behält „nachgetragen“ und die ausgelassenen Geräte (normalize und Neustart)", rt === "-: nt:hs-shoulder -: nt:hs-row" && rl === rt, JSON.stringify([rt, rl]));
      // Aussehen
      await page.click("#ntHome"); await page.click("#ntMode [data-v=teil]");
      ok("Nachtragen: kein Text frei auf dem Seitengrund", (await freeTextOn(page)).length === 0, JSON.stringify(await freeTextOn(page)));
      await page.setViewportSize({ width: 320, height: 640 });
      ok("Nachtragen bei 320 px ohne seitliches Scrollen", await noOverflow(page) && (await overflowers(page)).length === 0, JSON.stringify(await overflowers(page)));
      await page.click("#navbar .nb-back");
      ok("Zurück führt zu Heute; der Entwurf bleibt liegen, im Verlauf ändert sich nichts", (await page.textContent("#app h1")) === "Heute" && (await hist()).length === 4 && (await tp(page, () => !!window.__tp.state.x.nachtrag)));
      await ctx.close();
    }
    {
      // Kaputter Entwurf im Speicher: unmögliche Werte werden zu „unbekannt“ und lassen sich nicht speichern
      const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const { ctx, page } = await open({ plan: PLAN_SMALL, x: { nachtrag: { d: today, dayId: "d1", mode: "quatsch", min: 5, list: [{ exId: "hs-chest", u: "s", sets: [{ kg: -5, reps: 1000 }, "x", { kg: "40", reps: 10 }] }, 7] } } });
      const dr = await tp(page, () => window.__tp.state.x.nachtrag);
      ok("Kaputter Entwurf: negative oder unmögliche Werte gelten als unbekannt, fremde Einträge fallen weg", dr && dr.mode === "plan" && dr.min === "" && dr.list.length === 1 && JSON.stringify(dr.list[0].sets) === '[{"kg":null,"reps":null},{"kg":null,"reps":10}]', JSON.stringify(dr));
      await page.click("#ntHome"); await page.click("#ntSave");
      ok("… und er lässt sich so nicht speichern", (await tp(page, () => window.__tp.state.history.length)) === 0 && await page.isVisible("#ntErr"));
      const e = await tp(page, () => { const T = window.__tp, base = { d: T.state.x.nachtrag.d, dayId: "d1", mode: "edit", min: "", list: [{ exId: "hs-chest", u: "s", rmin: 8, rmax: 12, planned: 1, on: true, sets: [{ kg: 40, reps: 10 }] }] };
        const w = o => T.ntErr(JSON.parse(JSON.stringify(Object.assign({}, base, o)))); return [w({}), w({ min: "0" }), w({ min: "301" }), w({ min: "60" }), w({ d: "2999-01-01" }), w({ list: [Object.assign({}, base.list[0], { on: false })] }), w({ list: [Object.assign({}, base.list[0], { sets: [{ kg: 40, reps: null }] })] })]; });
      ok("Prüfung vor dem Speichern: gültig; Dauer 0 und 301 nein, 60 ja; Zukunft nein; ohne Gerät nein; fehlende Wiederholungen nein", e[0] === "" && e[1].includes("Dauer") && e[2].includes("Dauer") && e[3] === "" && e[4].includes("Zukunft") && e[5].includes("Mindestens ein Gerät") && e[6].includes("Wiederholungen"), JSON.stringify(e));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "x", name: "Leer", items: [] }] } });
      const none = !(await page.$("#ntHome"));
      await page.click("nav.tabs [data-v=history]");
      ok("Ohne Trainingstag mit Geräten gibt es keinen Nachtrag (weder auf „Heute“ noch unter Fortschritt)", none && !(await page.$("#row-nachtrag")));
      await ctx.close();
    }
    {
      // Ungeordnet gespeicherter Verlauf (z. B. aus einer Sicherung): beim Laden nach Datum geordnet, das jüngste Training ist maßgeblich
      const iso = n => new Date(Date.now() - n * 864e5).toISOString();
      const X = (id, n, sets) => ({ id, dayId: "d1", day: "Test", date: iso(n), durationSec: 1800, exercises: [{ exId: "hs-chest", name: "x", u: "s", planned: 3, rmin: 8, rmax: 12, sets: sets.map(([kg, reps]) => ({ kg, reps })) }] });
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [X("neu", 2, [[45, 8], [45, 8], [45, 7]]), X("alt", 20, [[40, 12], [40, 12], [40, 12]])] });
      const o = await tp(page, () => { const T = window.__tp, e = T.makeEntry(T.state.plan.days[0].items[0]); return { ids: T.state.history.map(h => h.id).join(), sets: e.sets.map(s => s.kg + "x" + s.reps).join(" "), why: e.why }; });
      ok("Ungeordneter Verlauf wird beim Laden nach Datum geordnet; der Vorschlag kommt aus dem jüngsten Training (45 kg, je 1 Wdh. mehr), nicht aus dem zuletzt gespeicherten (40 kg)", o.ids === "alt,neu" && o.sets.startsWith("45x9 45x9") && !o.sets.includes("40x") && o.why.includes("45 kg"), JSON.stringify(o));
      await ctx.close();
    }
    {
      // Live-Training und Nachtrag nutzen dieselbe Speicherstelle: ein Live-Training landet weiter am Ende des Verlaufs
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: [hist("hs-chest", [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }], 3)] });
      await page.click("[data-a=start]");
      await finishAllSets(page, 40, 10);
      const li = await tp(page, () => { const H = window.__tp.state.history; return { n: H.length, last: !H[H.length - 1].nt && H[H.length - 1].exercises[0].sets.length, first: H[0].exercises[0].sets.length, sorted: new Date(H[0].date) <= new Date(H[1].date) }; });
      ok("Live-Training: Eintrag am Ende des Verlaufs, nicht als „nachgetragen“ gekennzeichnet", li.n === 2 && li.last >= 1 && li.sorted, JSON.stringify(li));
      await ctx.close();
    }
    // @ext:nachtrag:test:end
    // ── Abstand nachtrag/test 1 ──
    // ── Abstand nachtrag/test 2 ──
    // ── Abstand nachtrag/test 3 ──

    section("89. Konsole");
    ok("Keine JavaScript-Fehler in allen Tests", allErrors.length === 0, allErrors.slice(0, 3).join(" | "));
  } catch (e) {
    fail++; console.log("\n✗ Testlauf abgebrochen: " + (e && e.message ? e.message.split("\n")[0] : e));
  } finally {
    await browser.close(); server.kill();
    console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
    process.exit(fail ? 1 : 0);
  }
})();
