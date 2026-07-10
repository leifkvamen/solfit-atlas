# SolFit Atlas

Trenings- og kostholdsapp for Atlas-ekspedisjonen 27. oktober – 7. november 2026.
15 ukers program: 86 → 76 kg, fjellklar kondis, media-klar overkropp.

## Struktur

- `index.html` — hele appen. Statisk, null dependencies, all data i localStorage.
- `withings-worker.js` — Cloudflare Worker som henter vekt fra Withings API (valgfritt).

## Deploy til Cloudflare Pages

1. Opprett nytt GitHub-repo `solfit-atlas` og push disse filene.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → velg repoet.
   - Build command: (tom) · Output directory: `/`
3. Custom domain: `fit.solpluss.no` (to klikk siden domenet allerede ligger i kontoen).
4. På iPhone: åpne siden i Safari → Del → «Legg til på Hjem-skjerm».

Hver push til `main` deployer automatisk.

## Withings-oppsett (valgfritt, ~30 min)

1. Registrer utviklerkonto + app på https://developer.withings.com
   - Callback URL: `https://<worker>.<konto>.workers.dev/callback`
2. Deploy `withings-worker.js` som Worker. Bind et KV namespace som `KV`.
3. Secrets: `WITHINGS_CLIENT_ID` og `WITHINGS_CLIENT_SECRET`.
4. Besøk `https://<worker>/auth` én gang og logg inn.
5. Lim Worker-URL inn i appen: Innstillinger → Worker-URL.

Etter dette: stå på vekta → tallet dukker opp i appen automatisk.

## Strava-oppsett (valgfritt, ~10 min)

Samme Worker og samme KV — bare to nye secrets og én godkjenning:

1. Lag API-app på https://www.strava.com/settings/api
   - Authorization Callback Domain: `<worker>.<konto>.workers.dev` (kun domenet, uten https/sti)
2. Secrets på Workeren: `STRAVA_CLIENT_ID` og `STRAVA_CLIENT_SECRET`.
3. Besøk `https://<worker>/strava/auth` én gang og godkjenn.

Etter dette: «Hent fra Strava»-listen dukker opp i loggskjemaene for langtur og kondis,
og fyller inn tid, distanse, høydemeter og puls automatisk. Fjell-siden viser
stigningstempo (hm/t), benchmark-utvikling og Toubkal-teller basert på turene.

## Skysync (valgfritt, gratis)

Samme Worker og samme KV. Sett en «Synk-kode» (minst 6 tegn) i appens innstillinger
på alle enheter — appen lagrer hele tilstanden i KV via `PUT /data?k=<kode>` og henter
den ved oppstart og når appen får fokus. Nyeste tidsstempel vinner.
Gratisplanen (1000 KV-skrivinger/dag) er langt mer enn nok.

## Programmet i korte trekk

| Fase  | Uker  | Fokus |
|-------|-------|-------|
| Base  | 1–4   | Aerob grunnmur, normal styrke, turer 1,5–2,5 t |
| Bygg  | 5–9   | 4×4-intervaller, sekk 8–10 kg, diet break uke 7 |
| Peak  | 10–14 | 1000–1400 hm, sekk 12 kg, deload uke 12 |
| Taper | 15    | Halvert volum, karbfylling fra torsdag |

Programstart: fredag 10. juli 2026.
Ukemal: Man Push · Tir Bein Fjell · Ons Sone 2 · Tor Pull · Fre Intervaller · Lør Langtur · Søn Hvile.
Kosthold: 2 måltider (16:30 + 20:00), 2300 kcal hverdager / 2600 turdag / 2100 hviledag, 175–185 g protein.
Benchmarks uke 3, 7, 11, 14 på fast rute.
