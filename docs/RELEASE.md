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
| `beta` | Vorab-Integration / Tests | `X.Y.Z-beta.N` | GitHub **Pre-Release** (.vsix) | **Nein** (Sideload) |
| `main` | Produktion | `X.Y.Z` | Marketplace + GitHub Release | Ja |

> **Warum kein Auto-Update bei Beta?** VS Code aktualisiert nur Extensions automatisch, die aus
> dem Marketplace installiert wurden. Eine manuell aus `.vsix` installierte Extension (Sideload)
> wird nie automatisch aktualisiert. Beta-Builds landen daher bewusst **nicht** im Marketplace.

---

## 1. Beta-Build erzeugen

1. Änderungen auf einem `feature/*`-Branch entwickeln, PR nach `beta`.
2. Vor dem Merge müssen alle Gates grün sein (CI erzwingt das).
3. Auf `beta` die Version auf eine `-beta`-Version setzen:
   ```bash
   npm version 1.1.0-beta.1 --no-git-tag-version
   git commit -am "chore: beta 1.1.0-beta.1"
   git push origin beta
   ```
4. Der Workflow [`beta-release.yml`](../.github/workflows/beta-release.yml) läuft automatisch:
   Gates → Build → `vsce package --pre-release` → **GitHub Pre-Release** `v1.1.0-beta.1` mit
   angehängter `.vsix`.

### Beta installieren (durch Tester)
```bash
code --install-extension kubectl-control-1.1.0-beta.1.vsix
```
oder in VS Code: **Extensions ▸ „…"-Menü ▸ Install from VSIX…**

Für die nächste Beta einfach die `-beta.N` hochzählen und erneut auf `beta` pushen.

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
| `VSCE_PAT` | Marketplace-Publish (`vsce publish`) | `release.yml` |
| `RELEASE_PAT` | Tag-Push, der `release.yml` triggert | `promote.yml` (optional) |

`GITHUB_TOKEN` (automatisch) genügt für GitHub-Releases und Asset-Uploads.

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
