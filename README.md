# Foto Puzzle – Version 1.3.0

Bilderrätsel-App von Time Bandits für das iPad. Läuft nach der Einrichtung komplett offline.

## Inhalt
- `index.html`, `style.css`, `js/` – die App
- `sw.js` – sorgt für den Offline-Betrieb (speichert alle App-Dateien auf dem iPad)
- `manifest.webmanifest`, `assets/` – App-Name, Symbol, Logos

## Online stellen
1. Den kompletten Ordnerinhalt in ein GitHub-Repository legen und GitHub Pages einschalten.
2. Eigene Adresse `fotopuzzle.berlin-timebandits.de` bei GitHub Pages eintragen.
3. Bei IONOS für `fotopuzzle` einen CNAME-Eintrag auf `<konto>.github.io` setzen.

## Auf dem iPad einrichten
1. Safari öffnen → `https://fotopuzzle.berlin-timebandits.de`
2. Teilen-Symbol → „Zum Home-Bildschirm“
3. App einmal vom Home-Bildschirm öffnen (mit Internet). Unter Einstellungen steht dann „Offline-Betrieb: bereit“.

## Updates
Bei jeder Änderung die Versionsnummer in `sw.js` (VERSION) und `js/app.js` (APP_VERSION) erhöhen.
Das iPad lädt die neue Version, sobald die App mit Internet geöffnet wird – nie mitten im Spiel.
