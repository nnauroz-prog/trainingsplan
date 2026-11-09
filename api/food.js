// Vercel-Funktion: Lebensmittelsuche über Open Food Facts (Suchschnittstelle search.openfoodfacts.org).
// Sie läuft auf dem Server, weil diese Schnittstelle keine Anfragen aus dem Browser anderer Seiten erlaubt (kein CORS).
// Weitergegeben werden nur der Suchbegriff und die Felder, die die App braucht. Keine Speicherung, keine Nutzerdaten.
const FIELDS = "code,product_name,product_name_de,brands,nutriments,serving_quantity,countries_tags";
const NUTR = ["energy-kcal_100g", "energy-kj_100g", "proteins_100g", "carbohydrates_100g", "fat_100g", "fiber_100g"];

module.exports = async (req, res) => {
  const q = String((req.query && req.query.q) || "").slice(0, 400).trim();
  if (q.length < 2) { res.status(400).json({ error: "Suchbegriff fehlt" }); return; }
  const url = "https://search.openfoodfacts.org/search?" + new URLSearchParams({ q, page_size: "40", langs: "de", fields: FIELDS });
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Trainingsplan-PWA/1.0 (https://trainingsplan-tawny.vercel.app)" }, signal: ctl.signal });
    if (!r.ok) { res.status(502).json({ error: "Open Food Facts antwortet mit " + r.status }); return; }
    const d = await r.json();
    const hits = (Array.isArray(d.hits) ? d.hits : []).map(h => ({
      code: h.code, product_name: h.product_name, product_name_de: h.product_name_de, brands: h.brands,
      serving_quantity: h.serving_quantity, countries_tags: h.countries_tags,
      nutriments: Object.fromEntries(NUTR.filter(k => h.nutriments && h.nutriments[k] != null).map(k => [k, h.nutriments[k]]))
    }));
    // Gleiche Suchen eine Stunde aus dem Vercel-Zwischenspeicher bedienen (schont Open Food Facts)
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ hits });
  } catch (e) {
    res.status(504).json({ error: "Open Food Facts nicht erreichbar" });
  } finally { clearTimeout(timer); }
};
