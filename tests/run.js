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
  plan: { goal: "aufbau", level: "einsteiger", minutes: 60, days: [{ id: "d1", name: "Push", items: [
    { id: "i1", exId: "hs-chest", sets: 3, rmin: 8, rmax: 12, rest: 90 },
    { id: "i2", exId: "hs-legpress", sets: 3, rmin: 8, rmax: 12, rest: 90 },
    { id: "i3", exId: "hs-fly", sets: 3, rmin: 8, rmax: 12, rest: 60 },
    { id: "i4", exId: "c-abc", sets: 3, rmin: 8, rmax: 12, rest: 60 }] }] },
  custom: [{ id: "c-abc", name: "Alte Rudermaschine", muscle: "ruecken", sec: [], type: "plate" }],
  notes: { "hs-chest": "Sitz 4" },
  history: [{ id: "h1", dayId: "d1", day: "Push", date: "2026-10-01T10:00:00.000Z", durationSec: 2400, exercises: [
    { exId: "hs-chest", name: "Iso-Lateral Chest Press", sets: [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }, { kg: 40, reps: 12, f: "m" }] },
    { exId: "hs-legpress", name: "Linear Leg Press", sets: [{ kg: 160, reps: 10 }, { kg: 160, reps: 9 }] },
    { exId: "hs-fly", name: "Pec Fly", sets: [{ kg: 65, reps: 12 }, { kg: null, reps: 12 }, { kg: 65, reps: 0 }] },
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
  page.on("console", m => { if (m.type() === "error") allErrors.push(m.text()); });
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
      ok("Einheit ergänzt: Pec Fly Gewichtsblock (b)", s.history[0].exercises[2].u === "b");
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
      const v1 = { days: [{ name: "Push", exercises: [{ name: "Iso-Lateral Chest Press", sets: 3, reps: 10, rest: 90 }, { name: "Mein Gerät", sets: 2, reps: 12, rest: 60 }] }] };
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
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]");
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const st = await stored(page);
      ok("Alter Sicherungscode wird importiert (Verlauf, Einheiten ergänzt)", st.history.length === 1 && st.history[0].exercises[1].u === "t" && st.notes["hs-chest"] === "Sitz 4");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=importOpen]");
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
      ok("Pec Fly zeigt „kg am Gewichtsblock“", (await page.textContent(".unit b")) === "kg am Gewichtsblock");
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
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openDevs]");
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
      await page.click("[data-a=setup][data-k=days][data-val='3']"); await page.click("[data-a=createPlan]");
      const plan = (await stored(page)).plan;
      const all = plan.days.flatMap(d => d.items.map(i => i.exId));
      ok("Neuer Plan enthält das Gerät nicht", !all.includes("hs-chest"), all.join(","));
      ok("Kein Gerät doppelt an einem Tag", plan.days.every(d => new Set(d.items.map(i => i.exId)).size === d.items.length));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(OLD_V2);
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=devFilt][data-k=brust]");
      await page.click("[data-a=editDev][data-id=hs-chest]"); await page.click("[data-a=devSet][data-k=off][data-v=true]");
      await page.click("[data-a=devSave]"); await page.click("[data-a=devsDone]");
      const st = await stored(page);
      ok("Bestehender Plan bleibt unverändert", st.plan.days[0].items[0].exId === "hs-chest");
      ok("Historie bleibt unverändert", st.history[0].exercises[0].exId === "hs-chest" && st.history[0].exercises[0].sets.length === 3);
      await page.click("[data-a=editDay]"); await page.click("[data-a=openPicker]"); await page.click("[data-a=pickFilter][data-k=brust]");
      const picks = await page.$$eval(".sheet [data-a=pick]", a => a.map(x => x.dataset.id));
      ok("Übungsauswahl blendet das Gerät aus", !picks.includes("hs-chest") && picks.length > 0);
      await ctx.close();
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
      ok("Nur heute: Übung im Training getauscht", (await page.textContent("h1")).includes("Incline"));
      ok("Nur heute: Plan unverändert", (await stored(page)).plan.days[0].items[0].exId === "hs-chest");
      await page.fill("#kgIn", "30"); await page.fill("#repsIn", "10"); await page.click("[data-a=doneSet]");
      ok("Nach dem ersten Satz kein Tausch mehr möglich", await page.isDisabled(".actions3 [data-a=openSwap]").catch(() => true));
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
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]");
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
      await page.click("[data-a=tab][data-v=plan]"); views.push(["Plan", await noOverflow(page)]);
      await page.click("[data-a=openDevs]"); views.push(["Geräte", await noOverflow(page)]);
      await page.click("[data-a=editDev] >> nth=0"); views.push(["Gerät bearbeiten", await noOverflow(page)]); await page.click("[data-a=devCancel]"); await page.click("[data-a=devsDone]");
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
      ok("Service Worker aktiv (Cache trainingsplan-v10)", await page.evaluate(async () => !!navigator.serviceWorker.controller && (await caches.keys()).includes("trainingsplan-v10")));
      await ctx.setOffline(true); await page.reload();
      ok("App startet offline mit gespeicherten Daten", await page.isVisible("[data-a=start]"));
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
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=devFilt][data-k=brust]");
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
      ok("Alle 28 Bibliotheksgeräte haben ein Bewegungsmuster", pats.length === 28 && pats.every(p => p[1]), pats.filter(p => !p[1]).join());
      let r = await rank("hs-chest");
      ok("Brustpresse: direkte Alternativen nur horizontales Drücken", r.direct.length > 0 && r.direct.every(id => ["hs-decline", "hs-widechest"].includes(id)), r.direct.join());
      ok("Bevorzugtes passendes Gerät steht oben", r.direct[0] === "hs-decline");
      ok("Incline Press = andere Übung mit anderem Schwerpunkt", r.other.includes("hs-incline") && r.why["hs-incline"].includes("anderer Belastungsschwerpunkt"), r.why["hs-incline"]);
      ok("Pec Fly als ungeeignete direkte Alternative gekennzeichnet", r.other.includes("hs-fly") && r.why["hs-fly"].includes("Keine direkte Alternative"));
      ok("Erklärung behauptet keine Gleichheit", !Object.values(r.why).some(w => /identisch|gleichwertig|gleiche Belastung/i.test(w)));
      r = await rank("hs-lateral");
      ok("Schulterpresse ist kein direkter Ersatz für Seitheben", !r.direct.includes("hs-shoulder") && r.direct.length === 0);
      ok("Schulterpresse nur als andere Übung gekennzeichnet", r.other.includes("hs-shoulder") && r.why["hs-shoulder"].includes("Keine direkte Alternative"));
      r = await rank("hs-hack");
      ok("Hack Squat: Leg Extension ist keine direkte Alternative", !r.direct.includes("hs-legext") && r.other.includes("hs-legext"));
      ok("Hack Squat: direkte Alternativen sind kniebeugedominant", ["hs-legpress", "hs-isolegpress", "hs-vsquat"].every(id => r.direct.includes(id)));
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
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=newDev]");
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
      ok("Bevorzugter Lat Pulldown statt Front Lat Pulldown", pull.includes("hs-lat") && !pull.includes("hs-pulldown"), pull.join());
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
      ok("Lücke wird gemeldet", plan.gaps.length === 1 && plan.gaps[0].name === "Lateral Raise");
      await page.evaluate(() => { window.__tp.state.dev = { "hs-lateral": { off: true } }; });
      await page.click("[data-a=createPlan]");
      ok("Hinweis nach dem Erstellen sichtbar", (await page.textContent(".sheet")).includes("Lateral Raise"));
      await page.click(".sheet [data-a=closeSheet]"); await page.click("[data-a=tab][data-v=plan]");
      ok("Hinweis bleibt im Plan sichtbar", await page.isVisible("#gapCard"));
      await page.click("[data-a=gapsDone]");
      ok("Hinweis lässt sich ausblenden", !(await page.isVisible("#gapCard")) && (await stored(page)).plan.gaps.length === 0);
      await ctx.close();
    }

    section("18. Kompatibilität (alte Daten, laufendes Training, Sicherung)");
    {
      const old = JSON.parse(JSON.stringify(OLD_V2)); old.v = 3; old.dev = { "hs-chest": { step: 1.25, load: "side" } }; old.hints = { units: true };
      old.session = { dayId: "d1", dayName: "Push", start: Date.now() - 600000, idx: 0, phase: "set", restEnd: 0, restTotal: 0,
        list: [{ key: "k1", itemId: "i1", exId: "hs-chest", u: "s", rmin: 8, rmax: 12, rest: 90, mode: "keep", why: "x", sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: false }] }] };
      const { ctx, page } = await open(old);
      const s = await tp(page, () => window.__tp.state);
      ok("Alte Geräteanpassung bleibt (Schritt 1,25), bevorzugt = nein", s.dev["hs-chest"].step === 1.25 && !s.dev["hs-chest"].fav);
      ok("Laufendes Training aus alter Version wird fortgesetzt", await page.isVisible("#kgIn") && s.session.list[0].sets[0].done === true);
      ok("Historie und Einheiten unverändert", s.history[0].exercises.map(x => x.u).join() === "s,t,b,t");
      await page.click("[data-a=askStop]"); await page.click("[data-a=pauseT]");
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openDevs]"); await page.click("[data-a=devFilt][data-k=bizeps]");
      await page.click("[data-a=editDev][data-id=hs-curl]"); await page.click("[data-a=devSet][data-k=fav][data-v=true]"); await page.click("[data-a=devSave]"); await page.click("[data-a=devsDone]");
      await page.evaluate(() => { const T = window.__tp; T.state.custom.push({ id: "c-x", name: "Kabelzug", muscle: "trizeps", sec: [], type: "stack", pattern: "tri" }); T.state.plan.gaps = [{ day: "Push", name: "Lateral Raise", pattern: "lateral" }]; });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]");
      await page.click("[data-a=importOpen]"); await page.fill("#impTxt", code); await page.click("[data-a=importDo]");
      const st = await stored(page);
      ok("Sicherung: bevorzugtes Gerät", st.dev["hs-curl"].fav === true);
      ok("Sicherung: Bewegungsmuster eigener Geräte", st.custom.find(c => c.id === "c-x").pattern === "tri");
      ok("Sicherung: Planhinweise", st.plan.gaps.length === 1 && st.plan.gaps[0].pattern === "lateral");
      await ctx.close();
    }
    for (const light of [false, true]) {
      const { ctx, page } = await open({ plan: PLAN_SMALL, dev: { "hs-decline": { fav: true } } }, { light });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=openDevs]");
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
      await page.click("[data-a=showRec]");
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
      ok("4. Vorschau nennt Ersatz und Auslassung", (await page.textContent("#timePrev")).includes("Ersetzt") && (await page.textContent("#timePrev")).includes("Biceps Curl"));
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
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      const before = await stored(page);
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]");
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
      ok("5. RIR 0 bei vollständiger Wiederholungszahl → Gewicht halten", r.mode === "hold" && r.kg[0] === 40 && r.why.includes("RIR 0"), r.why);
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
      ok("12. Training zeigt Stillstandshinweis mit Zeitraum und Optionen", (await page.textContent("#plateauHint")).includes("Wochen") && (await page.textContent("#plateauHint")).includes("Möglich"));
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
      ok("RIR-Angabe in der Pause gespeichert (am Satz)", (await stored(page)).session.list[0].sets[0].rir === 2 && (await page.textContent(".feel-q")).includes("RIR 2"));
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
      await page.evaluate(() => { const T = window.__tp; T.state.history.push({ id: "n1", dayId: "d1", day: "Push", date: new Date().toISOString(), durationSec: 600,
        exercises: [{ exId: "hs-chest", name: "c", u: "s", planned: 4, rmin: 8, rmax: 12, sets: [{ kg: 40, reps: 12, rir: 2 }, { kg: 40, reps: 11, f: "h", rir: 0 }] }] }); });
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=exportData]");
      const code = await page.inputValue("#expTxt"); await page.click(".sheet >> text=Schließen");
      const before = await tp(page, () => JSON.parse(JSON.stringify(window.__tp.state.history)));
      await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.click("[data-a=createPlan]"); await page.click("[data-a=tab][data-v=plan]");
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
          if (!g.main.length || !nonEmpty(g.why) || g.setup.length < 2 || g.steps.length < 3 || !nonEmpty(g.breath) || g.mistakes.length < 2 || !g.safety.length || !g.tips.length) bad.push(id + ": unvollständig");
          if (g.mistakes.some(m => !m[0] || !m[1])) bad.push(id + ": Fehler ohne Korrektur");
          (g.src || []).forEach(k => { if (!T.SOURCES[k]) bad.push(id + ": Quelle " + k); }); });
        T.ARTICLES.forEach(a => { if (!a.src.length) bad.push(a.id + ": ohne Quelle"); a.src.forEach(k => { if (!T.SOURCES[k]) bad.push(a.id + ": Quelle " + k); }); });
        Object.entries(T.SOURCES).forEach(([k, s]) => { if (!s.t || !s.j || !/^https:\/\//.test(s.url)) bad.push("Quelle " + k + " unvollständig"); });
        const txt = JSON.stringify([T.GUIDE, T.ARTICLES]);
        if (/TODO|lorem|xxx/i.test(txt)) bad.push("Platzhalter");
        return { n: ids.length, bad, arts: T.ARTICLES.length }; });
      ok("Alle 28 Geräte vollständig beschrieben (Muskeln, Nutzen, Einstellung, Ausführung, Atmung, Fehler mit Korrektur, Sicherheit, Tipps)", chk.n === 28 && !chk.bad.length, chk.bad.join("; "));
      ok("Jede zitierte Quelle existiert und ist vollständig verlinkt", !chk.bad.some(b => /Quelle/.test(b)));
      ok(`${chk.arts} Wissensartikel, jeder mit Quelle`, chk.arts >= 8);
      // Bibliothek
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=lib]");
      ok("Bibliothek listet alle Geräte inkl. eigener", (await page.$$("#libList [data-a=openEx]")).length === 29);
      await page.fill("#libQ", "Brust");
      const brust = await tp(page, () => window.__tp.allEx().filter(e => e.name.toLowerCase().includes("brust") || e.muscle === "brust").length);
      ok("Suche filtert (Name oder Muskel)", (await page.$$("#libList [data-a=openEx]")).length === brust && brust >= 5);
      await page.fill("#libQ", "");
      ok("Bibliothek bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=openEx][data-id=hs-seatcurl]");
      const seat = await page.textContent("#app");
      ok("Übungsseite zeigt alle Abschnitte", ["Warum diese Übung", "Einstellen", "Ausführung", "Atmung", "Häufige Fehler", "Sicherheit", "Tipps", "Hauptsächlich"].every(s => seat.includes(s)));
      ok("Studienaussage mit Quelle verlinkt (Beinbeuger sitzend)", (await page.$$eval("#app .srcs a", a => a.map(x => x.href))).some(h => h.includes("33009197")));
      ok("Ohne eigene Einträge: ehrlicher Hinweis statt erfundener Werte", (await page.textContent("#exStats")).includes("Noch keine Einträge"));
      await page.click("[data-a=exBack]");
      ok("Zurück führt zur Bibliothek", await page.isVisible("#libQ"));
      await page.click("[data-a=openEx][data-id=hs-chest]");
      const st = await page.textContent("#exStats");
      ok("Deine Werte aus echten Daten: 3 Einheiten, Bestwert 42,5, +10 kg seit Beginn", st.includes("3") && st.includes("42,5") && st.includes("+10") && st.includes("32,5"), st.slice(0, 200));
      ok("Übungsseite bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=exBack]"); await page.click("[data-a=openEx][data-id=c-k]");
      ok("Eigenes Gerät: Hinweis statt erfundener Anleitung", (await page.textContent("#app")).includes("keine ausführliche Anleitung"));
      // Wissen
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=wissen]");
      ok("Trainingswissen listet alle Artikel", (await page.$$("[data-a=openArt]")).length === chk.arts);
      await page.click("[data-a=openArt][data-id=pause]");
      ok("Artikel zeigt Text und verlinkte Quelle", (await page.textContent("#app")).includes("3 Minuten") && (await page.$$eval(".srcs a", a => a.map(x => x.href))).some(h => h.includes("26605807")));
      ok("Artikel bei 360 px ohne seitliches Scrollen", await noOverflow(page));
      await page.click("[data-a=artBack]");
      ok("Zurück führt zur Artikelliste", (await page.$$("[data-a=openArt]")).length === chk.arts);
      // Heute: Wissensbeitrag
      await page.click("[data-a=tab][data-v=home]"); await page.click("#homeArt");
      ok("Wissensbeitrag auf „Heute“ öffnet einen Artikel", await page.isVisible(".srcs"));
      await page.click("[data-a=artBack]");
      ok("Zurück führt zu „Heute“", await page.isVisible("[data-a=start]"));
      // Übungsauswahl
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=editDay]"); await page.click("[data-a=openPicker]");
      await page.click(".sheet [data-a=openGuideSheet][data-id=hs-row]");
      ok("Info in der Übungsauswahl öffnet die Anleitung", (await page.textContent(".sheet")).includes("Ausführung") && (await page.textContent(".sheet")).includes("Iso-Lateral Row"));
      await page.click(".sheet [data-a=guideBack]");
      ok("Zurück führt zur Übungsauswahl", await page.isVisible("#pickQ"));
      await page.click(".sheet [data-a=pick][data-id=hs-lowrow]");
      ok("Hinzufügen funktioniert weiter (mit Bestätigung)", (await page.textContent(".sheet [data-a=pick][data-id=hs-lowrow]")).includes("Hinzugefügt") && (await stored(page)).plan.days[0].items.some(i => i.exId === "hs-lowrow"));
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
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=lib]"); res.push(await noOverflow(page));
      for (const id of ["hs-chest", "hs-legpress", "hs-lateral", "hs-seatcalf"]) { await page.click(`[data-a=openEx][data-id=${id}]`); res.push(await noOverflow(page)); await page.click("[data-a=exBack]"); }
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=wissen]");
      for (const a of ["volumen", "gesundheit"]) { await page.click(`[data-a=openArt][data-id=${a}]`); res.push(await noOverflow(page)); await page.click("[data-a=artBack]"); }
      ok(`${w} px ${light ? "hell" : "dunkel"}: Bibliothek, Übungsseiten und Artikel ohne seitliches Scrollen`, res.every(Boolean), res.join());
      await ctx.close();
    }

    section("23. Konsole");
    ok("Keine JavaScript-Fehler in allen Tests", allErrors.length === 0, allErrors.slice(0, 3).join(" | "));
  } catch (e) {
    fail++; console.log("\n✗ Testlauf abgebrochen: " + (e && e.message ? e.message.split("\n")[0] : e));
  } finally {
    await browser.close(); server.kill();
    console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
    process.exit(fail ? 1 : 0);
  }
})();
