# Release-Playbook: Beta → Prod

Dieses Dokument beschreibt den vollständigen Weg von einer Änderung bis zum
Marketplace-Release — und wie Beta-Builds bereitgestellt werden, **ohne** dass VS Code sie
automatisch aktualisiert.

## Überblick

```
feature/*  ──PR──▶  beta  ──(Promote-Workflow)──▶  main ──Tag vX.Y.Z──▶  Marketplace
                     │                                      │
            Push triggert beta-release.yml          Tag triggert release.yml
            → GitHub *Pre-Release* + .vsix          → GitHub Release + vsce publish
            (Sideload, KEIN Marketplace,              (Auto-Update für Nutzer)
             KEIN Auto-Update)
```

| Branch | Zweck | `package.json`-Version | Veröffentlichung | Auto-Update |
|--------|-------|------------------------|------------------|-------------|
| `feature/*` | Entwicklung | – | – | – |
| `beta` | Vorab-Integration / Tests | Ziel-Stable `X.Y.Z` | GitHub-**Pre-Release** (`.vsix`), Tag `beta-vX.Y.Z` | Nein — manuell per „Install from VSIX…" |
| `main` | Produktion | `X.Y.Z` | Marketplace + GitHub Release, Tag `vX.Y.Z` | Ja |

> **Warum kein Marketplace-Pre-Release-Kanal?** Der VS Code Marketplace kennt **keine**
> SemVer-Suffixe (`-beta.N`) und teilt sich für Pre-Release und Stable denselben Versionsraum.
> Das erzwingt entweder eine unübersichtliche Paritäts-Konvention (gerade/ungerade MINOR) oder
> Versionskollisionen. Wir vermeiden beides: **Betas laufen ausschließlich als GitHub-`.vsix`
> zum Sideload.** `package.json` trägt auf `beta` bereits die **Ziel-Stable-Version**; der Beta-
> Charakter steckt allein im Tag-Präfix `beta-v…`. Beim Promoten wird genau diese Version stable.

---

## 1. Beta-Build erzeugen

1. Änderungen auf einem `feature/*`-Branch entwickeln, PR nach `beta`.
2. Vor dem Merge müssen alle Gates grün sein (CI erzwingt das).
3. Auf `beta` die **Ziel-Stable-Version** in `package.json` setzen (ganz normales SemVer,
   ohne Suffix):
   ```bash
   npm version 1.3.0 --no-git-tag-version   # = die Version, die später stable wird
   git commit -am "chore: beta für 1.3.0"
   git push origin beta
   ```
   > Es gibt **keine** Paritäts- oder Suffix-Regel. Der Beta-Charakter steckt allein im
   > Tag-Präfix `beta-v…`, das der Workflow automatisch setzt.

4. Der Workflow [`beta-release.yml`](../.github/workflows/beta-release.yml) läuft automatisch:
   Gates → Build → **GitHub-Pre-Release** mit `.vsix` unter Tag `beta-vX.Y.Z`.
   **Kein** Marketplace-Publish.

### Beta testen (durch Nutzer/Tester)
Auf der GitHub-Release-Seite die `.vsix` des Pre-Releases herunterladen, dann in VS Code:
**Extensions ▸ „…" ▸ „Install from VSIX…"**. Diese Sideload-Installation bekommt **kein**
Auto-Update — für einen neuen Beta-Build erneut die aktuelle `.vsix` installieren.

Solange dieselbe Ziel-Stable-Version mehrere Beta-Runden braucht, bleibt `package.json`
gleich; jeder Push auf `beta` aktualisiert das `beta-vX.Y.Z`-Pre-Release. Erst das nächste
Feature-Ziel erhöht die Version wieder.

---

## 2. Beta → Prod promoten

### Variante A — Automatisch (empfohlen)
GitHub ▸ **Actions ▸ „Promote Beta → Prod" ▸ Run workflow** und die finale Version eingeben
(z. B. `1.3.0`).

Der Workflow [`promote.yml`](../.github/workflows/promote.yml):
1. merged `beta` in `main`,
2. setzt die Prod-Version in `package.json` (i. d. R. schon gleich),
3. pusht `main` und den Tag `v1.3.0`.

Der Tag triggert [`release.yml`](../.github/workflows/release.yml) → Marketplace-Publish + GitHub-Release.

> **Einmalige Einrichtung:** Tags, die der Standard-`GITHUB_TOKEN` pusht, lösen **keine** weiteren
> Workflows aus. Lege dafür ein Repo-Secret `RELEASE_PAT` an (Fine-grained PAT mit
> `contents: write`). Ohne dieses Secret musst du den Tag-Push manuell auslösen (siehe Variante B
> ab Schritt „Tag").

### Variante B — Manuell
```bash
git checkout main
git merge --no-ff beta
npm version 1.3.0 --no-git-tag-version --allow-same-version
git commit -am "chore(release): v1.3.0"
git push origin main
git tag v1.3.0
git push origin v1.3.0      # triggert release.yml
```

---

## 3. Benötigte Secrets

| Secret | Zweck | Workflow |
|--------|-------|----------|
| `VSCE_PAT` | Marketplace-Publish (`vsce publish`) — Pre-Release + Stable | `beta-release.yml`, `release.yml` |
| `RELEASE_PAT` | Tag-Push, der `release.yml` triggert (optional) | `promote.yml` |

`GITHUB_TOKEN` (automatisch) genügt für GitHub-Releases und Asset-Uploads.

> **`RELEASE_PAT`:** Nur nötig wenn du den Promote-Workflow vollautomatisch bis zum
> Marketplace-Push durchlaufen lassen willst. Ohne es: `promote.yml` merged und taggt, aber
> `release.yml` muss danach manuell via „Run workflow" gestartet werden. `VSCE_PAT` ist bereits
> vorhanden und deckt beide Kanäle ab.

---

## 4. Versionsregeln

Wir verwenden **striktes SemVer ohne Sonderregeln**. Es gibt keine gerade/ungerade-MINOR-
Konvention und keinen Marketplace-Pre-Release-Kanal mehr.

- **`package.json`-Version:** immer die **Ziel-Stable-Version** `X.Y.Z` (z. B. `1.3.0`).
  Auf `beta` und auf `main` trägt dieselbe geplante Version — der Unterschied liegt nur im Tag.
- **GitHub-Tags** trennen Beta und Stable:
  - **Stable:** `vX.Y.Z` (z. B. `v1.3.0`) — pusht `release.yml` → Marketplace-Publish + Auto-Update.
  - **Beta:** `beta-vX.Y.Z` (z. B. `beta-v1.3.0`) — erzeugt von `beta-release.yml`, nur GitHub-
    Pre-Release/`.vsix`. Beginnt nicht mit `v`, matcht also **nie** das `v*`-Trigger von
    `release.yml` und kann keinen Stable-Publish auslösen.
- **MINOR/PATCH** wie üblich: Feature → MINOR hoch, Bugfix → PATCH hoch, Breaking → MAJOR hoch.
- **CHANGELOG.md** pflegen: Der Marketplace zeigt ihn im „Changelog"-Tab an. Änderungen unter
  `## [Unreleased]` sammeln; beim Promoten wird daraus `## [X.Y.Z] – JJJJ-MM-TT`.

---

## 5. Vor jedem Prod-Release (Checkliste)

- [ ] Beta wurde getestet (Sideload-`.vsix`)
- [ ] `CHANGELOG.md` aktualisiert
- [ ] `/security-review` über den Diff sauber
- [ ] Alle CI-Gates auf `beta` grün
- [ ] Finale Version festgelegt (`X.Y.Z`)
