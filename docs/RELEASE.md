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
            (manuell installieren, KEIN Auto-Update)  (Auto-Update für Nutzer)
```

| Branch | Zweck | Version | Veröffentlichung | Auto-Update |
|--------|-------|---------|------------------|-------------|
| `feature/*` | Entwicklung | – | – | – |
| `beta` | Vorab-Integration / Tests | `X.Y.Z-beta.N` | Marketplace **Pre-Release** + GitHub-Asset | Nur für Nutzer, die „Switch to Pre-Release" aktiviert haben |
| `main` | Produktion | `X.Y.Z` | Marketplace + GitHub Release | Ja |

> **Wie funktioniert das Pre-Release im Marketplace?** VS Code Marketplace unterstützt seit v1.63
> native Pre-Release-Kanäle (`vsce publish --pre-release`). Nutzer der Stable-Version bekommen
> Pre-Releases **nicht automatisch** — sie müssen auf der Extension-Seite explizit
> **„Switch to Pre-Release Version"** klicken. Wer Pre-Release aktiviert hat, bekommt Updates
> automatisch. Promote auf Stable setzt alle zurück auf den Stable-Kanal.

---

## 1. Beta-Build erzeugen

1. Änderungen auf einem `feature/*`-Branch entwickeln, PR nach `beta`.
2. Vor dem Merge müssen alle Gates grün sein (CI erzwingt das).
3. Auf `beta` eine Version mit **ungeradem MINOR** setzen (Marketplace-Konvention):
   ```bash
   npm version 1.1.0 --no-git-tag-version   # ungerade Minor = Pre-Release
   git commit -am "chore: beta 1.1.0"
   git push origin beta
   ```
   > **Wichtig:** Der VS Code Marketplace akzeptiert **keine** SemVer-Suffixe wie `-beta.1`.
   > Pre-Release wird durch den `--pre-release`-Flag signalisiert.
   > Konvention: **ungerade MINOR** (1.1.x, 1.3.x) = Pre-Release, **gerade MINOR** (1.2.x, 1.4.x) = Stable.

4. Der Workflow [`beta-release.yml`](../.github/workflows/beta-release.yml) läuft automatisch:
   Gates → Build → `vsce publish --pre-release` → **Marketplace Pre-Release** + GitHub-Asset.

### Beta testen (durch Nutzer/Tester)
In VS Code: **Extensions → `kubectl-control` suchen → Extension-Seite öffnen →
„Switch to Pre-Release Version"** klicken. Ab jetzt kommen Beta-Updates automatisch.

Für den nächsten Beta-Build den PATCH erhöhen: `1.1.0` → `1.1.1` → `1.1.2` usw.

---

## 2. Beta → Prod promoten

### Variante A — Automatisch (empfohlen)
GitHub ▸ **Actions ▸ „Promote Beta → Prod" ▸ Run workflow** und die finale Version eingeben
(z. B. `1.1.0`, **ohne** `-beta`).

Der Workflow [`promote.yml`](../.github/workflows/promote.yml):
1. merged `beta` in `main`,
2. setzt die Prod-Version in `package.json`,
3. pusht `main` und den Tag `v1.1.0`.

Der Tag triggert [`release.yml`](../.github/workflows/release.yml) → Marketplace-Publish + GitHub-Release.

> **Einmalige Einrichtung:** Tags, die der Standard-`GITHUB_TOKEN` pusht, lösen **keine** weiteren
> Workflows aus. Lege dafür ein Repo-Secret `RELEASE_PAT` an (Fine-grained PAT mit
> `contents: write`). Ohne dieses Secret musst du den Tag-Push manuell auslösen (siehe Variante B
> ab Schritt „Tag").

### Variante B — Manuell
```bash
git checkout main
git merge --no-ff beta
npm version 1.1.0 --no-git-tag-version
git commit -am "chore(release): v1.1.0"
git push origin main
git tag v1.1.0
git push origin v1.1.0      # triggert release.yml
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

- **SemVer.** Beta: `X.Y.Z-beta.N`. Prod: `X.Y.Z`.
- `beta-release.yml` bricht ab, wenn die Version auf `beta` **kein** `-beta` enthält.
- `release.yml` ignoriert Tags mit `-` (Pre-Release) und published nie eine Beta in den Marketplace.

---

## 5. Vor jedem Prod-Release (Checkliste)

- [ ] Beta wurde getestet (Sideload-`.vsix`)
- [ ] `CHANGELOG.md` aktualisiert
- [ ] `/security-review` über den Diff sauber
- [ ] Alle CI-Gates auf `beta` grün
- [ ] Finale Version festgelegt (`X.Y.Z`)
