// Funkcja serwerowa losowania prezentów (Netlify Functions + Netlify Blobs).
// Przechowuje pomysły każdej osoby i wynik losowania. Nikomu nie pokazuje
// cudzych list – tylko osobie, która daną osobę wylosowała (po podaniu PIN-u).

import { getStore } from "@netlify/blobs";
import { createHash, randomInt } from "node:crypto";

// ===== USTAWIENIA =====

const BUDZET = 150; // zł

// Hasło organizatora (do resetu PIN-u i czyszczenia wszystkiego).
// ZMIEŃ je na swoje albo ustaw w Netlify zmienną środowiskową HASLO_ORGANIZATORA.
const HASLO_ORGANIZATORA = process.env.HASLO_ORGANIZATORA || "0506";

const OSOBY = [
  { id: "monika", imie: "Monika" },
  { id: "sebastian", imie: "Sebastian" },
  { id: "rafal", imie: "Rafał" },
  { id: "aldona", imie: "Aldona" },
  { id: "marta", imie: "Marta" },
  { id: "karol", imie: "Karol" },
];

// Pary, które nie mogą się wylosować – działa w obie strony.
const WYKLUCZENIA = [
  ["sebastian", "monika"],
  ["rafal", "aldona"],
  ["karol", "marta"],
];

// ===== LOGIKA =====

const magazyn = () => getStore({ name: "losowanie-prezentow", consistency: "strong" });
const klucz = (id) => `osoba-${id}`;
const KLUCZ_LOSOWANIA = "losowanie";

const hashPin = (id, pin) => createHash("sha256").update(`${id}:${pin}:prezenty`).digest("hex");
const odp = (dane, status = 200) =>
  Response.json(dane, { status, headers: { "cache-control": "no-store" } });
const blad = (tekst, status = 400) => odp({ blad: tekst }, status);

const zakazane = (kto, kogo) =>
  kto === kogo ||
  WYKLUCZENIA.some(([a, b]) => (a === kto && b === kogo) || (a === kogo && b === kto));

function wylosujPary() {
  const ids = OSOBY.map((o) => o.id);
  for (let proba = 0; proba < 10000; proba++) {
    const los = [...ids];
    for (let i = los.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [los[i], los[j]] = [los[j], los[i]];
    }
    if (ids.every((id, i) => !zakazane(id, los[i]))) {
      return Object.fromEntries(ids.map((id, i) => [id, los[i]]));
    }
  }
  throw new Error("Przy tych wykluczeniach nie da się nikogo wylosować.");
}

function czystePomysly(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((p) => String(p ?? "").trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 3);
}

async function wczytajWszystko(m) {
  const [wpisy, losowanie] = await Promise.all([
    Promise.all(OSOBY.map((o) => m.get(klucz(o.id), { type: "json" }))),
    m.get(KLUCZ_LOSOWANIA, { type: "json" }),
  ]);
  return { wpisy, losowanie };
}

async function sprawdzPin(m, osoba, pin) {
  const wpis = await m.get(klucz(osoba.id), { type: "json" });
  if (!wpis) return { wpis: null, ok: false };
  return { wpis, ok: wpis.pin === hashPin(osoba.id, pin) };
}

export default async (req) => {
  const m = magazyn();

  // Stan dla wszystkich: kto już wpisał i czy było losowanie (bez żadnych list).
  if (req.method === "GET") {
    const { wpisy, losowanie } = await wczytajWszystko(m);
    return odp({
      budzet: BUDZET,
      osoby: OSOBY.map((o, i) => ({ id: o.id, imie: o.imie, gotowe: !!wpisy[i] })),
      wylosowane: !!losowanie,
      czasLosowania: losowanie?.czas || null,
    });
  }

  if (req.method !== "POST") return blad("Nieobsługiwana metoda.", 405);

  let dane;
  try {
    dane = await req.json();
  } catch {
    return blad("Złe dane.");
  }
  const akcja = dane?.akcja;
  const osoba = OSOBY.find((o) => o.id === dane?.id);
  const pin = String(dane?.pin ?? "").trim();

  // Zapis lub zmiana własnych pomysłów.
  if (akcja === "zapisz") {
    if (!osoba) return blad("Nie ma takiej osoby.");
    if (!/^\d{4}$/.test(pin)) return blad("PIN to 4 cyfry.");
    const pomysly = czystePomysly(dane.pomysly);
    if (pomysly.length < 2) return blad("Wpisz co najmniej 2 pomysły.");

    const nowy = { pin: hashPin(osoba.id, pin), pomysly, czas: Date.now() };
    const istniejacy = await m.get(klucz(osoba.id), { type: "json" });
    if (istniejacy) {
      if (istniejacy.pin !== nowy.pin) return blad("Zły PIN.", 403);
      await m.setJSON(klucz(osoba.id), nowy);
    } else {
      const { modified } = await m.setJSON(klucz(osoba.id), nowy, { onlyIfNew: true });
      if (!modified) return blad("Ktoś właśnie zapisał listę tej osoby. Odśwież stronę.", 409);
    }
    return odp({ ok: true });
  }

  // Odczyt własnych pomysłów (do poprawienia).
  if (akcja === "moje") {
    if (!osoba) return blad("Nie ma takiej osoby.");
    const { wpis, ok } = await sprawdzPin(m, osoba, pin);
    if (!wpis) return blad("Ta osoba jeszcze nic nie wpisała.", 404);
    if (!ok) return blad("Zły PIN.", 403);
    return odp({ pomysly: wpis.pomysly });
  }

  // Losowanie – tylko raz i tylko gdy wszyscy wpisali pomysły.
  if (akcja === "losuj") {
    const { wpisy, losowanie } = await wczytajWszystko(m);
    if (losowanie) return odp({ ok: true });
    const brakuje = OSOBY.filter((o, i) => !wpisy[i]).map((o) => o.imie);
    if (brakuje.length) return blad(`Jeszcze nie wpisali pomysłów: ${brakuje.join(", ")}.`);
    await m.setJSON(
      KLUCZ_LOSOWANIA,
      { pary: wylosujPary(), czas: Date.now() },
      { onlyIfNew: true }
    );
    return odp({ ok: true });
  }

  // Sprawdzenie, kogo się wylosowało.
  if (akcja === "sprawdz") {
    if (!osoba) return blad("Nie ma takiej osoby.");
    const { wpis, ok } = await sprawdzPin(m, osoba, pin);
    if (!wpis) return blad("Ta osoba nie wpisała pomysłów.", 404);
    if (!ok) return blad("Zły PIN.", 403);
    const losowanie = await m.get(KLUCZ_LOSOWANIA, { type: "json" });
    if (!losowanie) return blad("Losowania jeszcze nie było.");
    const dlaId = losowanie.pary?.[osoba.id];
    const dla = OSOBY.find((o) => o.id === dlaId);
    if (!dla) return blad("Nie znalazłem Twojej osoby. Poproś organizatora o nowe losowanie.");
    const jegoWpis = await m.get(klucz(dla.id), { type: "json" });
    return odp({ dla: dla.imie, pomysly: jegoWpis?.pomysly || [], budzet: BUDZET });
  }

  // Narzędzia organizatora.
  if (akcja === "organizator") {
    if (String(dane?.haslo ?? "") !== HASLO_ORGANIZATORA) return blad("Złe hasło organizatora.", 403);

    if (dane.co === "nowyPin") {
      if (!osoba) return blad("Wybierz osobę.");
      if (!/^\d{4}$/.test(pin)) return blad("Nowy PIN to 4 cyfry.");
      const wpis = await m.get(klucz(osoba.id), { type: "json" });
      if (!wpis) return blad(`${osoba.imie} jeszcze nic nie wpisał(a) – nie ma czego zmieniać.`, 404);
      await m.setJSON(klucz(osoba.id), { ...wpis, pin: hashPin(osoba.id, pin) });
      return odp({ ok: true });
    }

    if (dane.co === "cofnijLosowanie") {
      await m.delete(KLUCZ_LOSOWANIA);
      return odp({ ok: true });
    }

    if (dane.co === "wyczysc") {
      for (const o of OSOBY) await m.delete(klucz(o.id));
      await m.delete(KLUCZ_LOSOWANIA);
      return odp({ ok: true });
    }

    return blad("Nieznane polecenie organizatora.");
  }

  return blad("Nieznana akcja.");
};

export const config = { path: "/api/losowanie" };
