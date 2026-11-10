#!/usr/bin/env node
// Automatisierte Tests für die Trainings-App.
// Start:  node tests/run.js
// Benötigt: Node, Playwright mit Chromium, python3 (für den lokalen Server). Testet index.html (vorher ./build.sh).
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8790;
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
    serviceWorkers: opts.sw ? "allow" : "block" });
  if (data !== undefined) {
    await ctx.addInitScript(([k, v, extra]) => {
      if (!sessionStorage.getItem("seeded")) {
        if (v !== null) localStorage.setItem(k, v);
        if (extra) for (const [ek, ev] of Object.entries(extra)) localStorage.setItem(ek, ev);
        sessionStorage.setItem("seeded", "1");
      }
    }, [KEY, data === null ? null : JSON.stringify(data), opts.extra || null]);
  }
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
      ok("Neue Felder mit Standardwerten (dev = {}, v = 6)", JSON.stringify(s.dev) === "{}" && s.v === 6);
      await page.click("[data-a=selDay]").catch(() => {}); // löst Speichern aus
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=home]");
      await page.evaluate(() => { window.__tp.state.selDay = "d1"; });
      await page.click("[data-a=start]"); await page.click("[data-a=askStop]"); await page.click("[data-a=askDiscard]"); await page.click("[data-a=stopDiscard]");
      const st = await stored(page);
      ok("Nach dem Speichern: Verlauf und Einheiten dauerhaft im Speicher", st.history.length === 1 && st.history[0].exercises[0].u === "s" && st.v === 6);
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
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay]"); await page.click("[data-a=openPicker]"); await page.selectOption("#pickMuscle", "brust");
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
      ok("Service Worker aktiv (Cache trainingsplan-v53)", await page.evaluate(async () => !!navigator.serviceWorker.controller && (await caches.keys()).includes("trainingsplan-v53")));
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
      ok("Alle 52 Bibliotheksgeräte haben ein Bewegungsmuster", pats.length === 52 && pats.every(p => p[1]), pats.filter(p => !p[1]).join());
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
      const { ctx, page } = await open({ plan: p2, history: [hist("hs-legpress", [{ kg: 100, reps: 10 }], 0.5, "t")] }, { light: true });
      await page.click("[data-a=pickDay]");
      const bg = await page.$eval(".sheet", e => getComputedStyle(e).backgroundColor);
      ok("Hellmodus: Bottom-Sheet ist hell", /255, 255, 255/.test(bg), bg);
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
      ok(`17. ${w} px ${light ? "hell" : "dunkel"}: Sheet in passender Farbe`, light ? /255, 255, 255/.test(bg) : !/255, 255, 255/.test(bg), bg);
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
      ok(`18. ${w} px ${light ? "hell" : "dunkel"}: Pause mit RIR und RIR-Sheet ohne seitliches Scrollen, passende Farben`, a && b && (light ? /255, 255, 255/.test(bg) : !/255, 255, 255/.test(bg)), bg);
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
      ok("Alle 52 Geräte ausführlich beschrieben (Muskeln, Nutzen, Einstellung, ≥ 3 Ausführungsschritte, Atmung, ≥ 3 Fehler mit Korrektur, Sicherheit, ≥ 2 Tipps)", chk.n === 52 && !chk.bad.length, chk.bad.join("; "));
      ok("Jede zitierte Quelle existiert und ist vollständig verlinkt", !chk.bad.some(b => /Quelle/.test(b)));
      ok(`${chk.arts} Wissensartikel, jeder mit Quelle`, chk.arts >= 8);
      // Bibliothek
      await page.click("[data-a=tab][data-v=lib]");
      ok("Bibliothek listet alle Geräte inkl. eigener", (await page.$$("#libList [data-a=openEx]")).length === 53);
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
      await page.fill("#bcIn", "123"); await page.click("[data-a=barcodeGo]");
      ok("Barcode: falsche Länge abgelehnt", (await page.textContent("#bcMsg")).includes("8, 12, 13 oder 14"));
      await page.fill("#bcIn", "4061458014152"); await page.click("[data-a=barcodeGo]");
      ok("Barcode: Tippfehler über die Prüfziffer erkannt, ohne Anfrage", (await page.textContent("#bcMsg")).includes("Prüfziffer"));
      await page.fill("#bcIn", "4000000000006"); await page.click("[data-a=barcodeGo]");
      await page.waitForFunction(() => (document.querySelector("#bcMsg")?.textContent || "").includes("Kein Produkt"));
      ok("Barcode: nicht gefunden → Hinweis auf eigenes Lebensmittel", true);
      await page.fill("#bcIn", "4000000000112"); await page.click("[data-a=barcodeGo]");
      await page.waitForFunction(() => (document.querySelector("#bcMsg")?.textContent || "").includes("ohne vollständige"));
      ok("Barcode: unvollständige Nährwerte werden nicht übernommen", true);
      await page.fill("#bcIn", "4061458014151"); await page.click("[data-a=barcodeGo]");
      await page.waitForSelector("#amtG");
      ok("Barcode: gefunden → Mengen-Sheet", (await page.textContent(".sheet")).includes("Bio-Magerquark"));
      await page.keyboard.press("Escape");
      // Tage
      ok("Kein Blättern in die Zukunft", await page.isDisabled("[data-a=foodDay][data-d='1']"));
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
      ok("Gleicher Trend bei „Aufbauen“: Hinweis zum Anpassen", (await page.textContent("#trendNote")).includes("langsamer zu") && (await page.textContent("#trendNote")).includes("passe dein Kalorienziel an"));
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
      const pr = [hist("hs-chest", [{ kg: 40, reps: 10 }], 9, "s"), hist("hs-chest", [{ kg: 42.5, reps: 10 }], 2, "s")];
      const { ctx, page } = await open({ plan: PLAN_SMALL, history: pr, hints: { units: true } });
      const tabs = await page.$$eval("#tabs button", b => b.map(x => [x.dataset.v, x.textContent.trim()]));
      ok("Fünf Bereiche: Heute, Training, Wissen, Essen, Fortschritt", JSON.stringify(tabs) === JSON.stringify([["home", "Heute"], ["plan", "Training"], ["lib", "Wissen"], ["food", "Essen"], ["history", "Fortschritt"]]), JSON.stringify(tabs));
      const home = await page.textContent("#app");
      ok("„Heute“ ohne Ballast: keine Erholung, kein Bestwert, kein Artikel, keine Übungsliste", !(await page.$("#app [data-a=showRec]")) && !(await page.$("#homeBest")) && !(await page.$("#homeArt")) && !(await page.$("#todayPlan")) && home.length > 0);
      await page.click("#exBtn");
      ok("„2 Übungen ›“ öffnet die Übungen mit Gewichten (42,5 kg pro Seite)", (await page.textContent(".sheet #todayPlan")).includes("Brustpresse") && (await page.textContent(".sheet #todayPlan")).includes("42,5 kg pro Seite"));
      await page.keyboard.press("Escape");
      ok("Wochenrückblick über „Diese Woche“ erreichbar", await page.isVisible("#homeWeek"));
      await page.click("[data-a=tab][data-v=plan]");
      const plan = await page.textContent("#app");
      ok("„Training“: Plan, Geräte im Studio und Erholung, keine Datensicherung oder Bibliothek dazwischen", (await page.textContent(".head")).includes("Training") && !!(await page.$("#app [data-a=showRec]"))
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
      } else ok("Termin verpasst (übersprungen: kurz nach Mitternacht)", true);
      // Training: Termine und Buddy-Check
      await page.click("[data-a=tab][data-v=plan]");
      const curT = await tp(page, () => window.__tp.state.sched.time);
      ok("„Training“ zeigt die Termine mit Plan B", (await page.textContent("#schedRow")).includes(curT) && (await page.textContent("#schedRow")).includes("Kurzversion"));
      const pc = await tp(page, () => window.__tp.planCheck());
      const pcTxt = await page.textContent("#planCheck");
      ok("Planprüfung findet fehlende Muskelgruppen (Rücken fehlt)", pcTxt.includes("Planprüfung") && /Rücken\s*fehlt im Plan/.test(pcTxt) && pc.out.some(o => o.m === "ruecken" && o.v === 0));
      ok("Wochenmenge rechnet mit der Zahl der Termine (2 Termine bei 1 Trainingstag)", pc.per === 2 && pcTxt.includes("2 Termine pro Woche"));
      await page.click("#planCheck [data-a=checkFix][data-m=ruecken]");
      ok("„Übung hinzufügen“ öffnet den Tag mit der Geräteauswahl für Rücken", await page.isVisible("#pickQ") && (await page.$eval("#pickMuscle", s => s.value)) === "ruecken");
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
      ok("Einstellungen: Termine und Sprachbegleitung", (await page.textContent("#app")).includes("Trainingstermine") && await page.isVisible("#optVoice [data-a=voiceSet][data-v='1'].on"));
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
      for (let w = 5; w >= 0; w--) for (const wd of [0, 3]) { if (new Date(at(w, wd)) > new Date()) continue; const d = ["a", "b", "c"][k++ % 3]; history.push(H(d, at(w, wd), [[{ a: "hs-chest", b: "hs-pulldown", c: "hs-legpress" }[d], S3(40 + k, 10), d === "a" ? "s" : "t"]])); }
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
      await page.click("#coach .ins [data-a=coachHide]");
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
      ok("Jedes der 52 Geräte hat eigene Tricks (mindestens einen)", tr.n.length === 52 && tr.n.every(n => n >= 1), JSON.stringify(tr.n));
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
      ok("Jedes Gerät hat eine eigene Kurzbeschreibung (52, keine doppelt)", ab.length === 52 && new Set(ab).size === 52);
      await page.click("[data-a=tab][data-v=lib]");
      const subs = await page.$$eval("#app .group .li .s", e => e.map(x => x.textContent.trim()));
      ok("Übungsliste: keine Beschreibung doppelt", subs.length >= 28 && new Set(subs).size === subs.length, subs.slice(0, 6).join(" | "));
      await page.click("[data-a=openEx][data-id=hs-legpress]");
      const alts = await page.$$eval("#app .group .li .s", e => e.map(x => x.textContent.trim()).filter(Boolean));
      ok("Alternativen: jede mit eigener Beschreibung, nichts wortgleich", alts.length >= 3 && new Set(alts).size === alts.length && !alts.some(s => s.includes("Widerstandsverlauf")), alts.join(" | "));
      await page.click("[data-a=exBack]");
      await page.click("[data-a=tab][data-v=home]");
      await page.click("[data-a=start]");
      ok("Training: Trick der Brustpresse für den ersten Satz", (await page.textContent("#trickNow")).includes("Ellbogen leicht unter Schulterhöhe führen"));
      ok("360 px: Training mit Trick ohne seitliches Scrollen", await noOverflow(page));
      await page.click("#trickNow");
      ok("Antippen: Tricks der Brustpresse, der aktuelle aufgeklappt", (await page.textContent(".sheet")).includes("Tricks: Brustpresse") && await page.isVisible(".sheet details[data-trick=x0][open]") && (await page.$$(".sheet details.trk")).length === 2);
      await page.click(".sheet [data-a=genTricks]");
      ok("„Für alle Übungen“: Grundsätze mit Quelle, einmal gesammelt", (await page.textContent(".sheet")).includes("Nah ans Limit") && (await page.textContent(".sheet")).includes("Robinson"));
      await page.click(".sheet [data-a=genTricksBack]");
      ok("Zurück zu den Tricks des Geräts", (await page.textContent(".sheet")).includes("Tricks: Brustpresse"));
      await page.keyboard.press("Escape");
      await page.fill("#kgIn", "40"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]"); if (await page.$("[data-a=skipRest]")) await page.click("[data-a=skipRest]");
      ok("Zweiter Satz: der andere Trick der Brustpresse", (await page.textContent("#trickNow")).includes("Hinten eine Sekunde halten"));
      await page.click(".tool[data-a=openDevInfo]");
      ok("Gerät & Technik: So geht's und die zwei Tricks des Geräts", (await page.textContent(".sheet")).includes("So geht's") && (await page.$$("#devTricks details.trk")).length === 2);
      await page.click("text=Ausführliche Anleitung");
      const g = await page.textContent(".sheet");
      ok("Anleitung: „Tricks für dieses Gerät“, getrennte Seiten als Eigenschaft, Details eingeklappt", await page.isVisible("text=Tricks für dieses Gerät") && await page.isVisible("#isoNote") && !(await page.$(".sheet .gdet[open]")));
      ok("„Weitere Tipps“ ohne die bei vielen Geräten gleichen Texte", !g.includes("Beide Arme bewegen sich unabhängig voneinander") && !g.includes("Einarmig trainieren: Den freien Arm"));
      await page.click(".sheet .gdet summary >> text=Häufige Fehler");
      ok("„Häufige Fehler“ aufklappen zeigt Fehler mit Korrektur", await page.isVisible("text=Den vollen Bewegungsumfang nutzen, solange er schmerzfrei ist."));
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
      ok("Alle 52 Geräte mit deutschem Namen, Bezeichnung am Gerät getrennt gespeichert", L.length === 52 && L.every(([, n, l]) => n && l && n !== l && !/Press|Row|Curl|Raise|Squat|Pulldown|Delt|Fly\b|Crunch|Thrust|Extension|Dip\b/.test(n)), JSON.stringify(L.filter(([, n]) => /Press|Row|Curl/.test(n))));
      ok("Gewicht pro Seite bleibt an der Gerätebezeichnung (Brustpresse: pro Seite, Beinpresse: insgesamt)", await tp(page, () => window.__tp.unitOf(window.__tp.ex("hs-chest")) === "s" && window.__tp.unitOf(window.__tp.ex("hs-legpress")) === "t" && window.__tp.unitOf(window.__tp.ex("hs-legext")) === "s"));
      const st = await tp(page, () => window.__tp.state);
      ok("Gespeicherte Einträge auf Deutsch umgestellt (Gerät und Trainingstag „Push“ → „Drücken“)", st.history[0].exercises[0].name === "Brustpresse" && st.history[0].day === "Drücken");
      await page.click("[data-a=tab][data-v=lib]"); await page.fill("#libQ", "chest press");
      ok("Suche findet auch die Bezeichnung am Gerät (chest press → Brustpresse)", (await page.textContent("#app")).includes("Brustpresse"));
      await page.fill("#libQ", ""); await page.click("[data-a=openEx][data-id=hs-row]");
      ok("Geräteseite: deutscher Name, darunter „Am Gerät steht: Iso-Lateral Row“", (await page.textContent(".head .title")) === "Rudern" && (await page.textContent("#exLabel")) === "Am Gerät steht: Iso-Lateral Row");
      ok("Anleitung: Bewegungsanimation statt Muskelkarte, Hauptmuskel orange", !!(await page.$("#gMotion svg.motion")) && !(await page.$(".gfig .fig")) && (await page.$$eval("#gMotion svg [stroke='var(--accent)'], #gMotion svg [fill='var(--accent)']", e => e.length)) >= 1);
      await page.click("[data-a=exBack]");
      const thumbs = await page.$$eval("#libList .thumbbox svg.motion", e => e.length);
      ok("Übungsliste: kleines Bild der Bewegung je Gerät (ohne Animation)", thumbs === 52 && !(await page.$("#libList svg.motion[data-anim]")), String(thumbs));
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
      await page.waitForSelector("#homeNote");
      ok("Sicherung mit mehr Trainings: ohne Rückfrage wiederhergestellt", (await stored(page)).history.length === 6);
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
        { id: "i1", exId: "hs-chest", sets: 4, rmin: 8, rmax: 12, rest: 90 }, { id: "i2", exId: "hs-fly", sets: 1, rmin: 8, rmax: 12, rest: 60 }] }] };
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
      ok("Erstes Mal an einem Gerät: kein Bestwert-Vergleich", !(await tp(page, () => (window.__tp.said || []).some(s => s.includes("30 Kilo")))));
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
      ok("19 Life-Fitness-Geräte, ab Werk „nicht im Studio“", lf.length === 19 && lf.every(e => e.off));
      const gp = await tp(page, () => [2, 3, 4].flatMap(n => ["einsteiger", "fortgeschritten"].flatMap(l => window.__tp.generatePlan("aufbau", n, l, 60).days.flatMap(d => d.items.map(i => i.exId)))));
      ok("Plan-Assistent nimmt sie erst, wenn sie im Studio sind", !gp.some(id => id.startsWith("lf-")));
      await page.click("[data-a=tab][data-v=lib]"); await page.click("#libBrand [data-k=lf]");
      const subs = await page.$$eval("#libList .li .s", e => e.map(x => x.textContent.trim()));
      ok("Übungen: Filter „Life Fitness“ zeigt nur diese, mit Marke in der Zeile", subs.length === 19 && subs.every(s => s.startsWith("Life Fitness · ") && s.includes("nicht im Studio")));
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
      ok("Meine Geräte: Filter „Life Fitness“ mit „Alle ins Studio“", (await page.$$(".sheet .group .li")).length === 19 && await page.isVisible("#devBulk"));
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
      ok("Trainingstage: Übungsnamen dürfen zwei Zeilen nutzen", await page.$$eval(".day-row .s", e => e.every(x => x.classList.contains("clamp2"))));
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
      ok("„Leicht / Passt / Schwer“: Auswahl neutral, Orange nur für die Hauptaktion", feel);
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
      ok("Tab „Training“: Geräte im Studio direkt erreichbar", (await page.textContent("#devsRow")).includes("von 52"));
      await page.click("[data-a=editDay]");
      const day = (await page.textContent("#app")).replace(/\s+/g, " ");
      ok("Trainingstag: „Test starten“ und je Gerät das Gewicht fürs nächste Mal", (await page.textContent("#dayStart")).includes("Test starten") && day.includes("2 × 42,5 kg pro Seite") && day.includes("Pause"));
      // Geräteauswahl
      await page.click("[data-a=openPicker]");
      const caps = await page.$$eval("#pickList .cap", e => e.map(x => x.textContent));
      ok("Geräteauswahl: nach Marke gruppiert, Bezeichnung am Gerät sichtbar", caps.join() === "Hammer Strength,Life Fitness" && (await page.textContent(".sheet [data-a=pick][data-id=hs-row]")).includes("Iso-Lateral Row"));
      ok("Bereits im Tag: mit Häkchen", (await page.getAttribute(".sheet [data-a=pick][data-id=hs-chest]", "aria-pressed")) === "true");
      await page.fill("#pickQ", "pushdown");
      ok("Suche „pushdown“ findet das Kabelgerät", (await page.$$eval(".sheet [data-a=pick]", a => a.map(x => x.dataset.id))).join() === "lf-pushdown");
      await page.fill("#pickQ", ""); await page.click(".sheet [data-a=pickFilter][data-k=lf]");
      ok("Filter „Life Fitness“: nur Geräte dieser Marke", (await page.$$eval(".sheet [data-a=pick]", a => a.map(x => x.dataset.id))).every(id => id.startsWith("lf-")));
      await page.click(".sheet [data-a=pickAll]");
      ok("Nicht vorhandene Geräte lassen sich einblenden", (await page.$$(".sheet [data-a=pick]")).length === 19 && (await page.textContent(".sheet [data-a=pick][data-id=lf-legcurl]")).includes("nicht im Studio"));
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
      ok("„Test starten“ startet genau diesen Tag", !!(await page.$("[data-a=doneSet]")) && (await tp(page, () => window.__tp.state.session.dayId)) === "d1");
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
      ok("Alle 52 Geräte haben eine Bewegungsanimation", cov.length === 0, cov.join());
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
        return { glow: chest.includes('stroke="var(--accent)" stroke-width="6"'), sec: /fill="var\(--accent\)" fill-opacity="0\.4\d?"/.test(chest), plate: chest.includes('r="9" fill="var(--mgear)"'),
          lfPlate: lf.includes('r="9" fill="var(--mgear)"'), lfStack: (lf.match(/<rect [^>]*height="4.8"/g) || []).length === 6,
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
      ok("„+ Gerät wählen“ öffnet den Beintag (nicht den kürzeren Oberkörper-Tag) mit Beinbeugern", st.day === "u" && (await page.$eval("#pickMuscle", s => s.value)) === "beineh" && (await page.textContent(".sheet")).includes("Beinbeuger sitzend"));
      await ctx.close();
    }

    section("58. Gestaltung: eine Hauptaktion, Skala je Satz, Desktop-Leiste");
    {
      const { ctx, page } = await open({ plan: PLAN_SMALL, weights: [{ d: "2026-01-01", kg: 80 }], nutr: { sex: "m", age: 30, cm: 180, pal: 1.55, goal: "auf", kcal: null } });
      const ins = await page.$("#coach .ins");
      ok("Hinweiskarte: Signalpunkt, Aktionen neutral (Orange nur für „Training starten“)", !ins || !(await page.$("#coach .ins .btn.primary")));
      ok("„Heute“: genau eine orange Fläche (Hauptaktion)", (await page.$$("#app .btn.primary")).length === 1);
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
          const onA = cr(v("--on-accent"), v("--accent")); if (onA < 4.5) bad.push(`Schrift auf Orange: ${onA.toFixed(2)}`);
          return { lightMode, bad };
        }, light));
        await ctx.close();
      }
      ok("Kontrast: alle Textfarben ≥ 4,5:1 auf allen Flächen, auch Schrift auf den orangen Knöpfen (dunkel und hell)", res.every(r => !r.bad.length), JSON.stringify(res));
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

    section("59. Konsole");
    ok("Keine JavaScript-Fehler in allen Tests", allErrors.length === 0, allErrors.slice(0, 3).join(" | "));
  } catch (e) {
    fail++; console.log("\n✗ Testlauf abgebrochen: " + (e && e.message ? e.message.split("\n")[0] : e));
  } finally {
    await browser.close(); server.kill();
    console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
    process.exit(fail ? 1 : 0);
  }
})();
