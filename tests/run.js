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
      ok("Neue Felder mit Standardwerten (dev = {}, v = 3)", JSON.stringify(s.dev) === "{}" && s.v === 3);
      await page.click("[data-a=selDay]").catch(() => {}); // löst Speichern aus
      await page.click("[data-a=tab][data-v=plan]"); await page.click("[data-a=tab][data-v=home]");
      await page.evaluate(() => { window.__tp.state.selDay = "d1"; });
      await page.click("[data-a=start]"); await page.click("[data-a=askStop]"); await page.click("[data-a=askDiscard]"); await page.click("[data-a=stopDiscard]");
      const st = await stored(page);
      ok("Nach dem Speichern: Verlauf und Einheiten dauerhaft im Speicher", st.history.length === 1 && st.history[0].exercises[0].u === "s" && st.v === 3);
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
      ok("Alle unter Minimum → Reduktion (37,5)", r.mode === "down" && r.kg[0] === 37.5, JSON.stringify(r));
      r = await run([{ kg: 40, reps: 10 }, { kg: 40, reps: 9 }, { kg: 40, reps: 9 }]);
      ok("Sonst: Gewicht halten, +1 Wdh. als Ziel", r.mode === "keep" && r.kg.every(k => k === 40) && r.reps.join() === "11,10,10", JSON.stringify(r));
      r = await run([{ kg: null, reps: 12 }, { kg: 40, reps: 0 }], { extra: [hist("hs-chest", [{ kg: 35, reps: 12 }, { kg: 35, reps: 12 }], 10, "s")] });
      ok("Ungültige Sätze werden ignoriert (frühere gültige Einheit zählt)", r.mode === "up" && r.kg[0] === 37.5, JSON.stringify(r));
      r = await run([{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], { dev: { "hs-chest": { load: "total" } } });
      ok("Andere Gewichtsangabe wird nicht verglichen", r.mode === "keep" && r.kg[0] === null && r.why.includes("Noch keine gültigen Werte"), JSON.stringify(r));
      r = await run([{ kg: 2.5, reps: 5 }, { kg: 2.5, reps: 5 }]);
      ok("Reduktion nie unter 0 (kleinstes Gewicht bleibt)", r.mode === "hold" && r.kg[0] === 2.5, JSON.stringify(r));
      await ctx.close();
    }
    {
      // Progression im echten Ablauf: zweites Training
      const { ctx, page } = await open({ plan: PLAN_SMALL });
      await page.click("[data-a=start]"); await finishAllSets(page, 40, 12);
      await page.click("[data-a=tab][data-v=home]"); await page.click("[data-a=start]");
      const why2 = await page.textContent("#app .reason");
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
      ok("Service Worker aktiv (Cache trainingsplan-v4)", await page.evaluate(async () => !!navigator.serviceWorker.controller && (await caches.keys()).includes("trainingsplan-v4")));
      await ctx.setOffline(true); await page.reload();
      ok("App startet offline mit gespeicherten Daten", await page.isVisible("[data-a=start]"));
      await ctx.close();
    }

    section("13. Konsole");
    ok("Keine JavaScript-Fehler in allen Tests", allErrors.length === 0, allErrors.slice(0, 3).join(" | "));
  } catch (e) {
    fail++; console.log("\n✗ Testlauf abgebrochen: " + (e && e.message ? e.message.split("\n")[0] : e));
  } finally {
    await browser.close(); server.kill();
    console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
    process.exit(fail ? 1 : 0);
  }
})();
