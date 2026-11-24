# Pier

Pier est un cockpit de bureau pour l'agent de code [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) :
plusieurs sessions Pi en onglets, chacune pilotée en direct (stream, steer, Stop), et **supervisée par défaut** :
tout outil qui écrit ou exécute attend votre accord.

Écrit en Rust avec egui, Pier reste léger : environ 90 Mo de RAM au repos (mesure : `tools/measure-ram.ps1`).

## Ce que fait Pier

- **Onglets** : un process `pi --mode rpc` par onglet. Les onglets en arrière-plan continuent de tourner.
- **Dossier de projet** : Pier démarre sans dossier ; vous en ouvrez un, ou un dossier récent.
- **Approbations** : chaque appel d'outil qui n'est pas en lecture seule s'affiche avec la commande entière, un
  avertissement si la cible sort du dossier de travail, et un refus automatique après 60 s.
- **Reprendre** une session Pi enregistrée, avec son historique. **Nommer** une session.
- **Presets** : modèle, niveau de réflexion, outils, dossier et consigne, lancés en un clic.
- **Modèle et réflexion** modifiables dans l'onglet, **jauge de contexte** et coût de la session.
- **Palette `/`** des commandes, modèles de prompt et skills de Pi.
- **Journal** JSONL par onglet : ouverture, runs, chaque approbation demandée et décidée.
- La barre des tâches clignote quand un onglet en arrière-plan attend une approbation ; Windows ne se met pas en
  veille pendant un run.

## Prérequis

- Windows 10 ou 11 (Pier utilise des Job Objects et l'API d'alimentation de Windows).
- Pi installé avec son installateur géré : `%USERPROFILE%\.pi\agent\bin\pi-launcher.js` et, si présent,
  `%LOCALAPPDATA%\pi-node\current\node.exe` (sinon `node` du PATH). Testé avec Pi 1.5.2.
- Rust stable récent (édition 2024).

## Lancer

```powershell
cargo run --release
```

Les arguments après `--` sont passés à chaque Pi, par exemple un modèle :

```powershell
cargo run --release -- --model openrouter/deepseek/deepseek-v4.1-flash
```

## Fichiers de Pier

Tous dans `%APPDATA%\pier\` :

| Fichier | Rôle |
|---|---|
| `presets.json` | Presets (créé avec un exemple par « Presets › Modifier les presets… »). Une clé inconnue, un niveau de réflexion invalide ou un dossier absent est signalé dans le menu. |
| `recent.json` | Dossiers de projet récents (10 au plus). |
| `journal\*.jsonl` | Un journal par onglet. Les arguments de lancement n'y sont jamais écrits. |
| `pier-approvals.ts` | L'extension d'approbation, embarquée dans l'exécutable et réécrite si elle change. |

Les conversations restent celles de Pi, dans ses propres dossiers de session.

## Sécurité

- Pi charge toujours l'extension de Pier (`-e`), même avec `--no-extensions`. Tant qu'elle ne s'est pas signalée,
  Pier refuse d'envoyer quoi que ce soit (« Non supervisé »).
- L'extension refuse par défaut : erreur, délai dépassé ou fenêtre fermée valent refus. Après votre accord, l'entrée
  de l'outil est gelée, pour qu'aucune autre extension ne la modifie.
- `read`, `grep`, `find` et `ls` passent sans accord seulement s'ils sont les outils d'origine de Pi.
- L'avertissement « hors du dossier de travail » est fiable pour `write` et `edit`, et **indicatif** pour `bash` et
  `powershell` (lu dans le texte de la commande). Ce n'est pas un bac à sable.
- Fermer un onglet ou quitter Pier arrête tout l'arbre de process de l'onglet (Job Object Windows).

## Tests

```powershell
cargo test                                  # tests unitaires, sans réseau
node --experimental-strip-types extension/check.mjs   # auto-test de l'extension (Node 22+)
```

Les tests live parlent au vrai Pi et à un vrai modèle (chaque test coûte un peu) :

```powershell
$env:PIER_TEST_MODEL = 'openrouter/deepseek/deepseek-v4.1-flash'
cargo test --test live -- --ignored --test-threads=1
```

Avant chaque commit : `cargo fmt`, `cargo clippy --all-targets`, `cargo test`, puis les tests live.

## Organisation du code

```
src/
  lib.rs              le cœur, sans egui
  pi/                 parler à Pi : process (Job Object, threads), protocol (types serde), sessions (sur disque)
  session/            le modèle : transcript (stream, historique, approbations), state, journal
  workspace.rs        les onglets : lancer, envoyer, Stop, fermer, ce qui doit prévenir l'utilisateur
  presets.rs, recent.rs, files.rs, awake.rs
  main.rs, app/       l'interface egui : elle dessine et demande, sans logique de session
extension/            l'extension Pi d'approbation et son auto-test
tests/live.rs         tests contre le vrai Pi
tools/                mesure de RAM
```

Règle : toute logique va dans le cœur, avec un test ; `app/` ne fait que dessiner.

## Limites connues

- Le texte des réponses n'est pas encore rendu en Markdown (passe d'interface à venir).
- Les dialogues d'extension autres que « confirmer » (choix, saisie, éditeur) sont refusés.
- Reprendre ne lit que le dossier de sessions par défaut de Pi.

## Licence

MIT, voir `LICENSE`.
