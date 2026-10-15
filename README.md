# pi-tui : le picker et Pier

Deux outils pour travailler avec **Pi**, un agent de code en ligne de commande, installé sur une VM Linux distante et utilisé depuis un PC portable.

- **Le picker** (`pi-dir-picker.py`, installé sur la VM sous `~/bin/pi-pick`) : un écran dans le terminal pour choisir un dossier et y lancer Pi.
- **Pier** (`client/`) : une application de bureau pour Windows, macOS et Linux. Elle réunit dans une fenêtre le terminal de la VM, l'envoi d'images et de fichiers à Pi, le partage de dossiers du PC et le suivi de ce que fait l'agent.

L'idée de départ : **l'agent tourne sur la VM, pas sur le portable.** Le portable n'est qu'une fenêtre sur la VM, comme un navigateur l'est pour Claude. On peut le fermer, l'éteindre, perdre le Wi-Fi : Pi continue.

---

## Sommaire

1. [Pourquoi ces outils](#1-pourquoi-ces-outils)
2. [Vue d'ensemble](#2-vue-densemble)
3. [Le picker](#3-le-picker)
4. [Pier](#4-pier)
5. [Sécurité](#5-sécurité)
6. [Installation](#6-installation)
7. [Utilisation au quotidien](#7-utilisation-au-quotidien)
8. [Coupures et reprise](#8-coupures-et-reprise)
9. [Fichiers et emplacements](#9-fichiers-et-emplacements)
10. [Tests](#10-tests)
11. [Limites connues et ce qui reste à vérifier](#11-limites-connues-et-ce-qui-reste-à-vérifier)
12. [Pistes pour la suite](#12-pistes-pour-la-suite)

---

## 1. Pourquoi ces outils

Sans eux, travailler avec Pi sur la VM, c'était :

1. se connecter en SSH ;
2. se déplacer de dossier en dossier avec `cd` ;
3. lancer `pi` ;
4. et, si la connexion coupait, perdre la session de Pi en cours.

Il restait trois problèmes que SSH ne règle pas :

- **Les images.** En SSH, on ne peut pas coller une capture d'écran dans Pi : le presse-papier est celui du portable, et Pi lit celui de la VM.
- **Les fichiers du portable.** Pi ne voit que la VM. Pour lui montrer un dossier du PC, il fallait le copier à la main.
- **Savoir ce que fait l'agent.** Pendant une longue tâche, rien ne montre ce qu'il lit, ce qu'il modifie, ni ce que ça coûte.

Le picker règle les deux premiers points de la liste, et Pier le reste.

### Pourquoi le dossier est choisi avant de lancer Pi

C'est la raison d'être du picker. Pi lit sa configuration, ses instructions (`AGENTS.md`) et sa mémoire **au démarrage**, et sa mémoire Hindsight est rangée **par nom de dossier**. Lancer Pi dans un dossier puis changer de dossier, ce serait le faire travailler avec le contexte d'un autre projet. Le dossier de travail est donc toujours fixé avant que Pi démarre.

---

## 2. Vue d'ensemble

```
   PC portable (Windows)                              VM Linux (Debian 13)
 ┌──────────────────────────┐   une connexion SSH   ┌────────────────────────────────┐
 │ Pier                   │ ◄───────────────────► │ pi-pick (le picker)            │
 │  · terminaux (xterm.js)  │   (par WireGuard,     │  · écran de choix des dossiers  │
 │  · Context, Activity,    │    bastion possible)  │  · API --api … (réponses JSON)  │
 │    Setup                 │                       │                                │
 │  · serveur SFTP pour les │                       │ tmux (serveur dédié)           │
 │    dossiers partagés     │                       │  └ une session par projet      │
 └──────────────────────────┘                       │     └ Pi, dans un bac à sable   │
                                                    │       (bubblewrap)             │
                                                    └────────────────────────────────┘
```

- **Une seule connexion SSH.** Les terminaux, les envois et les partages de Pier passent tous par elle : le mot de passe n'est demandé qu'une fois. Chaque terminal, appel ou partage y ouvre un « canal », et OpenSSH en limite le nombre par connexion (`MaxSessions`, 10 par défaut) : au-delà, la VM refuse, et Pier ouvre tout seul une connexion de plus (avec le mot de passe gardé en mémoire). Pour l'éviter, `MaxSessions 30` côté VM (voir [Réseau et chiffrement](#réseau-et-chiffrement)).
- **Aucun port ouvert sur la VM.** Pier lance le picker par SSH avec des options (`pi-pick --api …`), et le picker répond en JSON.
- **Une commande reste ouverte** (`pi-pick --api watch`) et envoie à Pier ce qui change, au moment où ça change : Pier n'interroge pas la VM en boucle.
- **Pi tourne dans tmux,** une session tmux par Pi, sur un serveur tmux réservé à Pier. Il survit donc aux coupures. **Plusieurs Pi peuvent tourner dans le même projet,** chacun dans sa conversation.
- **Pi tourne dans un bac à sable** (bubblewrap) : il ne voit que son projet.
- **Le picker est livré dans Pier.** Pier l'installe sur la VM et le met à jour lui-même : il n'y a que l'exe à utiliser.
- **Chaque prompt peut être annulé :** le projet est sauvegardé avant (points de restauration).
- **Tout est journalisé,** côté PC et côté VM, dans deux journaux qui se lisent côte à côte.

---

## 3. Le picker

Un programme Python d'un seul fichier, **sans dépendance** : uniquement la bibliothèque standard. Il s'utilise directement en SSH (`ssh pi`) et sert aussi de moteur à Pier.

### L'écran

- En haut, un logo ASCII et la version, si le terminal fait au moins 30 lignes.
- Le chemin courant, puis la liste des dossiers non cachés.
- Pour chaque dossier : la **branche git**, une **étoile** s'il y a des modifications non commitées, `↑2 ↓1` pour les commits d'avance et de retard sur le dépôt distant, et **`[pi]`** si un Pi y tourne.
- En haut de ton home, les **projets récents**.
- À partir de 110 colonnes, un **panneau d'aperçu** : derniers commits, présence de `AGENTS.md` ou `.pi`, début du README.
- En bas, le rappel des touches, qui s'adapte à la largeur.

### Les touches

| Touche | Action |
|---|---|
| `↑` `↓` (ou `k` `j`), `PgUp` `PgDn`, `Début` `Fin` | se déplacer |
| `→` / `Entrée` (ou `l`) | entrer dans le dossier |
| `←` / `Retour arrière` (ou `h`) | remonter |
| **`p`** | lancer Pi dans le dossier **sélectionné** |
| **`P`** | lancer Pi dans le dossier **courant** |
| `N` | lancer **un Pi de plus** dans la sélection, dans une nouvelle conversation |
| `c` | reprendre la dernière session de Pi (`--continue`) |
| `r` | choisir une ancienne session de Pi (`--resume`) |
| `x` | arrêter les Pi qui tournent dans la sélection |
| `/` | filtrer le dossier courant en tapant |
| `f` | chercher un dossier n'importe où dans le home |
| `n` | créer un dossier |
| `g` | cloner un dépôt git ici |
| `R` | renommer la sélection |
| `t` | trier par nom ou par activité récente |
| `s` | ouvrir un shell dans la sélection |
| `?` | aide |
| `q` / `Échap` | quitter (Échap efface d'abord un filtre ou une recherche) |

### Pi dans tmux

Quand tu lances Pi, le picker l'ouvre dans une **session tmux propre au projet**. Ce serveur tmux est réservé à Pier et ne touche pas à tes propres sessions.

- `Ctrl-b d` revient au picker, et **Pi continue de tourner**.
- `p` sur le projet te remet dans sa session (celle du Pi utilisé en dernier, s'il y en a plusieurs).
- **Plusieurs Pi par projet :** `N` en lance un autre, dans une nouvelle conversation (par exemple un pour le code, un pour la doc). La liste affiche alors `[pi 2]`, et la barre tmux `#2`. Chaque Pi écrit sa propre conversation : le picker lui donne lui-même son fichier de session (`--session`), et le note dans tmux, pour que Pier sache toujours quel Pi écrit quoi.
- La barre tmux est discrète et rappelle `ctrl-b d`. Elle affiche `[sandbox]` quand le bac à sable est actif.
- Si tmux n'est pas installé, le picker propose de l'installer (avec `sudo`, qui demande lui-même ton mot de passe), ou de lancer Pi sans tmux.
- Les **touches étendues** sont activées sur ce serveur tmux (`extended-keys`, au format `csi-u`, comme le recommande Pi) : Shift+Entrée fait bien un retour à la ligne dans Pi.
- **Ce serveur tmux a sa propre configuration,** écrite par le picker dans `~/.local/state/pi-dir-picker/tmux.conf` ; ton `~/.tmux.conf` n'est pas lu. Elle est réappliquée à chaque ouverture d'un Pi, aussi à un serveur lancé avant. Elle sert au chemin « ssh simple » (le picker dans Windows Terminal) : la souris est à tmux (la molette remonte dans l'historique que tmux garde, glisser sélectionne et copie), ce que tmux ou Pi copie arrive dans le presse-papier du terminal (OSC 52), et la barre du bas n'a que des couleurs de la palette (texte gris, sans fond).
- **Dans Pier, Pi ne passe pas par l'écran de tmux** (voir [Terminaux](#terminaux)) : Pier s'attache en « mode contrôle ». tmux garde Pi en vie mais ne dessine rien ; il transmet la sortie de Pi telle quelle, et c'est Pier qui l'affiche. Dans le picker lancé par Pier, `p` (et `N`, `c`, `r`) ouvre donc Pi **dans un onglet Pier** au lieu de s'y attacher lui-même.

### Pi en mode « regular » (recommandé)

Depuis la version 1.0, Pi démarre en mode « fullscreen » : il prend la souris, fait défiler et sélectionne lui-même, et affiche « Copied! » quand il copie. À travers SSH, chaque cran de molette fait alors redessiner tout l'écran par Pi sur la VM, ce qui n'est pas fluide, et sa sélection court-circuite celle de Pier. En mode **regular**, Pi écrit dans le terminal comme un programme ordinaire : la molette, la sélection et la copie sont celles de Pier. On perd la barre de défilement de Pi, sa recherche dans la conversation et le saut entre messages.

Dans `~/.pi/agent/settings.json` sur la VM :

```json
"tuiMode": "regular"
```

Pour revenir au mode fullscreen, `"tuiMode": "fullscreen"` (la molette y est plus régulière avec `"fullscreenWheelScrollLines": 3`).

### Le bac à sable

Par défaut, Pi tourne dans **bubblewrap**. Voir [Sécurité](#5-sécurité).

### La configuration

Optionnelle, dans `~/.config/pi-dir-picker/config.toml`. Un modèle commenté se trouve dans [config.example.toml](config.example.toml).

| Clé | Rôle | Défaut |
|---|---|---|
| `start` | dossier affiché en premier | `~` |
| `ignore` | noms de dossiers jamais listés ni cherchés | `[]` |
| `search_depth` | profondeur de la recherche `f` | `4` |
| `pi_command` | commande de Pi, avec ses arguments | `["pi"]` |
| `continue_args`, `resume_args` | arguments de `c` et `r` | `--continue`, `--resume` |
| `tmux` | lancer Pi dans tmux | `true` |
| `recent_count` | nombre de projets récents affichés | `8` |
| `preview` | panneau d'aperçu | `true` |
| `sandbox` | bac à sable bubblewrap | `true` |
| `sandbox_read`, `sandbox_write` | dossiers en plus, accessibles à Pi | `[]` |
| `checkpoints` | points de restauration avant chaque prompt | `true` |

Deux variables d'environnement existent aussi : `PI_BIN`, le chemin de Pi s'il n'est pas dans le PATH, et `PI_PICKER_SANDBOX=0`, qui désactive le bac à sable (la suite de tests s'en sert).

### L'API pour Pier

Le picker sert aussi de moteur à Pier. Il n'ouvre aucun port : Pier le lance par SSH avec `--api` et lit sa réponse JSON. L'API est versionnée (version 9 aujourd'hui) : Pier reconnaît un picker trop ancien et le met à jour.

| Commande | Rôle |
|---|---|
| `version`, `projects`, `list`, `ls` | état, projets récents et Pi lancés, contenu des dossiers |
| `paste-image`, `paste-file` | recevoir une image ou un fichier et le **taper** dans Pi (`@chemin`) |
| `upload-dir` | recevoir un dossier sous forme d'archive tar (copie) |
| `type` | taper du texte dans la zone de saisie de Pi, sans jamais appuyer sur Entrée |
| `context`, `contexts`, `remove`, `clear` | ce qui a été donné à un projet, et le retirer |
| `share-prepare`, `share-stop`, `shares`, `--share-serve` | partages en direct (sshfs) |
| `handoff`, `--download` | Hand off et Take back |
| `activity`, `diff` | ce que Pi lit et modifie, ses diffs, son coût |
| `setup`, `write-text` | instructions, ce que Pi lit au démarrage, sessions |
| `checkpoints`, `checkpoint`, `checkpoint-diff`, `restore` | points de restauration : liste, en créer un, ce qui a changé depuis, revenir en arrière |
| `log` | la fin du journal du picker |
| `stop DIR [SLOT]` | arrêter les Pi d'un projet, ou l'un d'eux |
| `watch` | reste ouverte : Pier écrit ce qu'il veut suivre, le picker répond par une ligne JSON à chaque changement |
| `--attach DIR [ARGS]` | ouvrir un Pi du projet : celui utilisé en dernier (ou un nouveau), `--new`, `--slot NOM` (un Pi qui tourne), `--continue` ou `--session FICHIER` (son Pi s'il tourne, sinon un nouveau Pi dessus) |
| `--attach-control DIR [ARGS]` | la même chose en mode contrôle de tmux, pour les onglets Pi de Pier |

**La commande `watch`.** Avant, chaque onglet de Pier redemandait son état toutes les 2,5 à 15 secondes, et chaque fois c'était une nouvelle commande SSH qui relançait Python. Maintenant, une seule commande reste ouverte pendant toute la connexion. Pier lui dit ce qu'il suit (les projets, l'activité d'une conversation, le Setup d'un projet, ses points de restauration, le contenu de Context, le journal), et elle ne renvoie une partie **que quand elle a changé**. Elle regarde d'abord la taille et la date des fichiers concernés : un Pi qui démarre, finit ou modifie un fichier se voit en une seconde, et rien ne circule quand rien ne bouge. Un onglet n'est suivi que tant qu'il est affiché. Les fichiers de conversation de Pi, qui grossissent sans cesse, ne sont relus qu'à partir de là où la lecture s'était arrêtée, et la liste des conversations de Setup n'est relue que pour les fichiers qui ont changé. Si la connexion tombe, Pier la rouvre tout seul.

---

## 4. Pier

Pier s'appelait **devbox** (le nom était déjà pris par un outil connu). Ce qui garde des données garde l'ancien nom, pour ne rien perdre : le dossier des réglages et des journaux (`app.devbox.client`), les préférences de l'interface, et sur la VM les points de restauration et l'historique des instructions (`.pi/devbox-history`).

Une application **Tauri** : la logique est en Rust, l'interface en HTML, CSS et JavaScript simples, sans framework. Le terminal est **xterm.js**, intégré à l'application. L'exécutable fait environ 6,5 Mo.

### Connexion

- **Premier lancement :** adresse, port, utilisateur, et un **bastion** facultatif (avec son propre port et son utilisateur).
- **Mot de passe :** demandé une fois, gardé **en mémoire seulement** et jamais écrit sur le disque. Il sert à se reconnecter tout seul si le PC s'est mis en veille.
- **Empreinte du serveur :** vérifiée comme le fait `ssh`. Au premier contact, Pier l'affiche pour que tu la confirmes. Si elle change ensuite, **la connexion est refusée avant que le mot de passe soit envoyé**.
- **Les réglages de connexion** se modifient depuis l'écran de connexion (« change connection »), pas depuis les Settings.

### Le picker, livré avec Pier

L'exe contient le picker (`pi-dir-picker.py`, intégré à la compilation). À chaque connexion, Pier compare la version de la VM à la sienne :

- **Le picker est absent** (première connexion) : Pier propose de l'installer, à l'endroit de la commande du picker (`~/bin/pi-pick` par défaut). Il ne faut sur la VM que Python 3.
- **Il est plus ancien** : Pier le met à jour tout seul, sauf si ce réglage est coupé dans les Settings. La barre du haut l'indique (`picker 3.9 installed`).
- **Il est plus récent que Pier** : Pier le signale, et propose quand même d'installer sa version.

L'installation est prudente : le nouveau fichier est écrit à côté, Pier vérifie qu'il démarre et qu'il annonce la bonne version, et seulement ensuite il remplace l'ancien, qui est gardé sous `pi-pick.previous`. Pier n'installe que si la commande du picker est un simple chemin (`~/bin/pi-pick`, `/opt/pi-pick`).

### L'espace de travail

Trois zones, **gauche, centre et droite**. Par défaut, pour rester simple, **les terminaux au centre et tous les panneaux d'un seul côté** (à droite ; Settings > Layout > **Panels** les met à gauche) :

- **Conversations** : toutes les conversations, de tous les projets, avec leurs Pi ;
- **Activity** : ce que fait le Pi en cours ;
- **Context** : ce qu'on lui a donné ;
- **Setup** : la configuration du projet.

L'onglet **Logs** est une option de diagnostic (Settings > Diagnostics > **Logs tab**). Une disposition plus ancienne prend celle-ci une fois ; **Reset layout** y revient. Ensuite n'importe quel onglet peut aller dans n'importe quelle zone :

- **La palette, Ctrl+Shift+K**, de partout, terminaux compris (ou **search** dans la barre du haut) : tape quelques lettres pour aller n'importe où.
  - **onglets et panneaux :** un onglet ouvert, ou un panneau fermé à rouvrir ;
  - **projets :** un nouveau Pi, la dernière conversation, ou sa configuration ;
  - **conversations :** reprendre n'importe laquelle ;
  - **réglages :** les Settings, un nouveau shell, les panneaux à gauche ou à droite, l'onglet Logs, un thème.

  ↑ ↓ pour choisir, Entrée pour y aller, Échap pour fermer.
- **Le +** d'une barre d'onglets propose un shell, un picker, et chaque panneau : à rouvrir s'il est fermé, ou à amener ici.
- **Déplacer un onglet :** le glisser sur une autre zone (un repère montre où il atterrit), son clic droit, ou les Settings.
- **La largeur des côtés** se règle en glissant la séparation ; elle est retenue pour chaque côté. Un double-clic sur la séparation remet la largeur habituelle.
- **Les onglets se partagent la barre :** leur nom se raccourcit (« … », le nom complet au survol) avant que la barre ne défile. L'onglet actif garde son nom entier, et seuls lui et celui sous la souris montrent ×. Tout le reste (renommer, déplacer, replier, fermer) est au clic droit.
- **Les côtés se replient** avec le bouton ‹/› ou le clic droit d'un onglet (Collapse this side). Un clic sur un onglet ne fait que l'afficher, il ne replie jamais le côté.
- **Le clic droit sur un onglet** propose :
  - **Rename** (le nom est retenu) ;
  - **Move** à gauche, au centre ou à droite ;
  - **Collapse this side** ;
  - pour un terminal, **New**, **Restart** et **Clear scrollback** ;
  - **Close** et **Close the other tabs here**.
- **Le picker** est l'onglet principal : il est épinglé et ne se ferme jamais.
- **L'onglet choisi est toujours entièrement visible :** dans un côté étroit, la barre d'onglets défile jusqu'à lui.
- **La disposition est retenue** d'une connexion à l'autre. « Reset layout » remet les onglets à leur place par défaut sans relancer les terminaux.
- **En haut**, Pier affiche le Pi utilisé en dernier (`pi · ~/work #2 · working`). Les onglets suivent son projet automatiquement.

### Terminaux

Ce sont de vrais terminaux sur la VM, qui passent par la connexion SSH déjà ouverte.

- **Coller une image dans le terminal où tourne Pi :** Ctrl+Shift+V (Ctrl+V en mode Windows) ; l'image part dans Pi, et le focus reste dans le terminal. Ailleurs dans la fenêtre, Ctrl+V suffit.
- **Shift+Entrée, Ctrl+Entrée et Alt+Entrée** arrivent jusqu'à Pi sans être confondus avec Entrée.
- **Fermer un onglet de terminal ne tue pas Pi,** qui continue dans tmux.
- **Copier-coller comme sous Linux** (par défaut) : **Ctrl+Shift+C** copie, **Ctrl+Shift+V** colle (texte, ou image envoyée à Pi), Shift+Insert colle aussi. **Ctrl+C** interrompt toujours le programme et **Ctrl+V** va au programme. Réglages (Settings > Terminals) :
  - les touches : mode Linux, ou mode Windows (Ctrl+C copie quand du texte est sélectionné, Ctrl+V colle) ;
  - la copie : **sélectionner puis Ctrl+Shift+C** (par défaut), ou **copier dès la sélection**.

  Une bulle en bas confirme chaque copie (« copied 42 characters »). Un texte collé ne s'exécute pas tout seul.
- **Le clic droit** ouvre le menu de Pier : Copy, Paste, Select all, Clear scrollback, Restart, New terminal. Aussi dans le tmux de Pi.
- **Ctrl+ et Ctrl-** grossissent ou réduisent le texte des terminaux, **Ctrl+0** revient à la taille par défaut.
- **Les onglets Pi parlent à tmux en « mode contrôle »** (`tmux -C`), comme iTerm2 sur Mac : tmux garde Pi en vie sur la VM (il survit aux coupures) mais ne dessine rien, il transmet la sortie de Pi telle quelle, et le terminal de Pier l'affiche comme si Pi tournait sur le PC. Avec Pi en mode regular, **toute la conversation est dans l'historique de Pier** : la molette la fait défiler sur le PC, sans aller-retour avec la VM, et la sélection, Ctrl+Shift+C et le menu du clic droit sont ceux de Pier. À l'ouverture, Pier fait redessiner Pi (deux tailles de suite), ce qui y remet la conversation déjà écrite. Pas de barre tmux dans ces onglets, mais **`Ctrl-b d` détache** comme dans tmux (l'onglet se ferme, Pi continue ; `Ctrl-b` suivi d'une autre touche arrive à Pi tel quel). Fermer l'onglet détache aussi. **Quand Pi se termine** (`Ctrl+D`, `/exit`), son onglet se ferme avec lui.
- **Quand Pi copie lui-même,** le texte arrive dans le presse-papier du PC : Pier accepte qu'un programme de la VM **écrive** dans le presse-papier, jamais qu'il le **lise**.
- **Un programme qui prend la souris** (Pi en mode fullscreen, `htop`…) reçoit les clics ; **Shift+glisser** sélectionne quand même dans Pier.
- **Réactifs comme un ssh normal :** la connexion désactive l'algorithme de Nagle, comme OpenSSH pour les sessions interactives (sinon chaque touche peut attendre jusqu'à 200 ms), et ce que la VM envoie d'un coup est remis au terminal en un seul message, au lieu d'un par paquet SSH. Avec les journaux détaillés, Pier note le temps de réponse de la VM aux touches (`ui.term-latency`, médiane et 90 %).
- **Dessinés par la carte graphique** (WebGL) : le défilement d'un long historique reste fluide. Sans WebGL, ou si la carte graphique perd son contexte, le terminal revient tout seul au rendu classique. Réglage dans Settings > Terminals.

### Onglet Context : tout ce qu'on donne à Pi

On donne quelque chose par **Ctrl+V**, par **glisser-déposer**, par les boutons **Add files… / Add a folder…**, ou par **Ctrl+Alt+V** depuis n'importe quelle application. Pier fait alors ce qu'il faut :

| Ce qu'on donne | Ce qui se passe |
|---|---|
| **Une image** | Copiée dans `.pi-images/` du projet et **tapée dans Pi** (`@.pi-images/…png`). Il ne reste qu'à écrire sa question. |
| **Un fichier** | Copié dans `.pi-files/` et tapé dans Pi. |
| **Un dossier** | Pier **demande** : <br>• **partager en direct, lecture seule** ; <br>• **partager en direct, lecture et écriture** ; <br>• **copier dans le projet** (une copie que Pi peut modifier sans toucher l'original, jusqu'à 200 Mo, sans `.git` ni `node_modules`). |

Les fichiers et dossiers copiés dans l'Explorateur Windows (Ctrl+C) se collent aussi.

Le panneau liste, **projet par projet**, tout ce qui a été donné : images (avec aperçu), fichiers, copies et partages. Chaque élément a :
- **mention**, qui le retape dans Pi ;
- un **×**, qui le retire. Pour une image, un fichier ou une copie, il est supprimé de la VM ; un partage s'arrête, et le dossier d'origine n'est jamais touché.

La liste est lue sur la VM : on la retrouve après une reconnexion. Les dossiers `.pi-images`, `.pi-files` et `.pi-shared` contiennent chacun un `.gitignore` avec `*`, pour ne rien commiter par accident sans toucher au `.gitignore` du projet.

### Les partages en direct

Le dossier reste **sur le PC**. La VM le voit **en direct** dans `.pi-shared/<nom>` du projet, et rien n'est copié.

- **Lecture seule** par défaut. Avec l'écriture autorisée, les modifications de Pi sont faites **directement dans les fichiers du PC** : ce n'est pas une synchronisation, ce sont les mêmes fichiers.
- **Le principe :** sshfs tourne sur la VM en mode « passif », et c'est Pier qui lui sert le dossier, par un petit serveur SFTP qui passe par la connexion SSH. Aucun port n'est ouvert.
- **Le serveur de Pier ne sert que ce dossier :** il refuse de remonter avec `..`, de suivre un lien qui sort du dossier, et les chemins Windows piégés (`C:x`, `a:b`, `..\`).
- **Le partage s'arrête** quand on clique sur ×, à la déconnexion, en quittant Pier, et, par défaut, quand le Pi du projet se termine.
- **Après une déconnexion,** les partages réapparaissent **en pause**, avec un bouton **resume**. Ils peuvent aussi reprendre tout seuls, selon les Settings.

### Hand off et Take back : Pi continue, PC éteint

Pi tourne sur la VM et n'a pas besoin du PC, **sauf pour les partages en direct**.

**Hand off** (bouton en haut) transforme chaque partage en direct en **copie sur la VM, exactement au même endroit**. Pi garde donc ses fichiers aux mêmes chemins, même au milieu d'une tâche :
- un partage en lecture seule devient une copie en lecture seule ;
- un partage en lecture et écriture devient une copie que Pi peut modifier.

Ensuite, Pier se déconnecte, et on peut éteindre le PC.

**Take back**, au retour, depuis Context :
- **download** enregistre la version de Pi dans un **nouveau dossier** à côté de l'original, `maquettes (from Pi)` : rien n'est écrasé ;
- **share live** remet le dossier d'origine en partage en direct, à la place de la copie ;
- **×** supprime la copie.

### Onglet Activity : ce que fait l'agent

Tout est lu dans le **journal de session de Pi**, qu'il écrit en direct (`~/.pi/agent/sessions/--<chemin du projet>--/*.jsonl`).

- **Activity :** les fichiers **en cours de lecture**, **lus**, **en cours de modification**, **modifiés**, en **échec**, ce qui a changé sur le disque sans passer par les outils de Pi (vu par git), et l'historique récent des actions.
- **L'état de l'agent :** en train de travailler, ou au repos.
- **Le coût de la session :** tokens en entrée, en sortie et en cache, coût en dollars, modèle.
- **Files :** l'arborescence avec les mêmes marques (◐ en lecture, ● lu, ✎ en modification, ✓ modifié, ! en échec) et l'état git.
- **Plusieurs Pi dans le projet :** une liste en haut choisit de quel Pi on suit le travail (par défaut, celui utilisé en dernier).
- **Un clic** sur un fichier modifié ouvre son **diff** dans un onglet : le diff git, et les modifications faites par Pi lui-même, même hors de git. **Un double-clic** mentionne le fichier dans Pi.
- **Ce qui n'est pas possible :** savoir ce que Pi **va** lire ensuite. Pi le décide au fur et à mesure.
- **Restore :** les points de restauration, voir ci-dessous.

### Points de restauration : annuler ce que Pi a fait

Le projet est sauvegardé **quand Pi démarre**, **à l'arrivée de chaque prompt** (avant que Pi agisse) et **quand Pi s'arrête de travailler**. L'onglet **Activity > Restore** liste ces points : « Pi started », « before “ajoute des tests” », « Pi finished working ».

- **Un clic sur un point** montre ce qui a changé depuis : fichiers modifiés (~), créés (+), supprimés (−).
- **diff** montre la différence d'un fichier entre ce point et maintenant ; **put back** le remet comme il était, **remove** supprime un fichier créé depuis.
- **Go back to 14:32** remet tout le projet dans l'état de ce point : les fichiers créés depuis sont supprimés, les autres retrouvent leur contenu.
- **Revenir en arrière se défait aussi :** avant chaque restauration, l'état actuel est lui-même sauvegardé (« before going back to 14:32 »).
- **Save a restore point now** en crée un à la main, avec un nom si on veut.
- Devbox refuse de restaurer **pendant que Pi travaille**. Pi n'est pas prévenu : dis-lui ce que tu as annulé.

Comment ça marche :
- Les points sont rangés **hors du projet**, dans un dépôt git à part par projet (`~/.local/state/pi-dir-picker/checkpoints/`). **Le git du projet n'est jamais touché**, et Pi, dans son bac à sable, ne voit pas ce dossier.
- git ne stocke chaque version d'un fichier qu'une fois : un point ne coûte que ce qui a changé. Les 50 derniers points sont gardés par projet.
- Ce dépôt ne lit aucune configuration git de l'utilisateur : aucun hook, filtre ou fsmonitor ne s'exécute.
- **Ne sont pas sauvegardés :** ce que le `.gitignore` exclut (node_modules, build, `.env`…), ce qui a été donné à Pi (`.pi-images`, `.pi-files`, les partages) et les fichiers de plus de 50 Mo.
- Un point identique au précédent ne fait pas doublon : il le remplace et reprend son nom. Chaque point de la liste est donc un état différent.
- La première question d'une **nouvelle** session est un cas à part : Pi n'écrit sa session qu'avec sa première réponse, au moment où ses outils démarrent. Cette question est donc rattachée au point « Pi started », qui contient bien l'état d'avant.

### Journaux : ce qui s'est passé, pour comprendre un problème

Pier et le picker écrivent chacun un journal, **une ligne par événement**, au même format et en heure UTC :

```
2026-10-12T14:32:01.123Z INFO  vm.paste-image req=7f3a-12 ms=41 sent=48213
2026-10-12T14:32:01.150Z INFO  api.paste-image pid=4242 req=7f3a-12 ms=22 saved=/home/leo/work/.pi-images/…
```

- **Côté PC** (`%LOCALAPPDATA%\app.devbox.client\logs\pier.log`) : connexion et reconnexions, chaque appel à la VM (durée, erreur), terminaux ouverts et fermés, partages, Hand off, installation du picker, erreurs de l'interface et chaque message d'erreur affiché.
- **Côté VM** (`~/.local/state/pi-dir-picker/picker.log`) : chaque commande de l'API, Pi qui démarre et s'arrête (avec son code de sortie), les points de restauration, les plantages **avec leur traceback**.
- **Un appel porte le même `req=…` dans les deux journaux :** on suit une action de bout en bout.
- **Jamais dans les journaux :** les mots de passe, ce qui est tapé dans un terminal, ce qui est tapé dans Pi (seulement sa longueur), le contenu des fichiers.
- **Detailed logs** (Settings) ajoute les lignes de détail, des deux côtés : les lectures répétées toutes les quelques secondes, les tailles de terminal, les étapes de la connexion SSH.
- Les journaux tournent à 5 Mo (PC) et 1 Mo (VM), en gardant 3 fichiers.

**L'onglet Logs** (à montrer dans Settings > Diagnostics > **Logs tab**) affiche les deux journaux en direct, **les plus récents en haut**, avec un filtre par niveau et par texte. **Copy a report** met dans le presse-papier un rapport complet : versions, connexion (jamais de mot de passe), réglages, et la fin des deux journaux. C'est ce qu'il faut envoyer quand quelque chose ne va pas.

### Onglet Conversations : le seul endroit des conversations

Toutes les conversations de Pi sur la VM, **regroupées par projet**. Le projet du Pi en cours vient en premier, marqué ●, et reste ouvert. Viennent ensuite les projets où un Pi tourne, puis les autres, du plus récent au plus ancien. Au-delà des trois premiers, un projet est replié ; **▾** le déplie, et Pier s'en souvient.

- **L'en-tête d'un projet :**
  - combien de Pi y tournent, combien de conversations, ses totaux (aujourd'hui, 7 jours) ;
  - **new** : un Pi de plus, dans une nouvelle conversation ;
  - **last** : reprend la dernière conversation ;
  - **setup** : ouvre sa configuration dans Setup.
- **Les Pi qui tournent**, d'abord : chacun avec sa conversation (Pi #1, Pi #2…, s'il travaille ou t'attend), **open** (son terminal) et **stop**. Un Pi qui vient de démarrer, sans encore de conversation, apparaît comme « *New conversation* ». **stop them all** quand il y en a plusieurs.
- **Quel Pi tient quelle conversation :** chaque Pi lancé par Pier le dit lui-même, même quand tu changes de conversation dans Pi (`/new`, `/resume`, `/fork`), et même avant sa première réponse. Pier le lance avec une petite extension (`--extension ~/.pi/pier/pier-session.ts`, rien n'est ajouté aux réglages de Pi). Elle écrit, à chaque changement, sa conversation et s'il travaille dans `~/.pi/pier/pis/<session tmux>.json`. Elle apparaît dans la liste des extensions au démarrage de Pi. Pour s'en passer : `track_sessions = false` dans la config du picker ; Pier devine alors comme avant.
- **Puis les conversations :** les épinglées (★), puis les plus récentes (5 ; **show all** pour le reste). Chacune affiche :
  - sa date et son nombre de messages ;
  - ce qu'elle a coûté : en dollars quand le modèle a un prix dans Pi, sinon en tokens (pour les 300 plus récentes) ;
  - sa catégorie.
- **Les actions :** **continue** démarre un Pi dessus. **⋯** permet de lui donner un **nom** et une **catégorie**, de l'**épingler** ou de l'**archiver** : elle sort des listes, mais reste trouvable par la recherche et avec la case **archived**. Pier garde ces réglages dans `~/.local/state/pi-dir-picker/labels.json` ; les fichiers de Pi ne sont pas touchés.
- **Reprise après coupure :** si la VM a redémarré pendant que Pi travaillait, le projet affiche un bandeau **continue where it stopped**.
- **La recherche** porte sur toutes les conversations de tous les projets (nom, question, catégorie), archivées comprises.

Pier lit le dossier des sessions de Pi (`~/.pi/agent/sessions`). La vue ne se met à jour que lorsqu'elle est affichée, au plus toutes les 5 secondes pendant que Pi travaille.

### Onglet Setup : la configuration d'un projet, comme dans Claude Projects

Pour Pi, **un projet est un dossier** : chaque session lancée dedans repart avec le même contexte. Cet onglet le rend visible et modifiable. Il suit le projet du Pi en cours (ou celui choisi dans sa liste, ou ouvert par **setup** dans Conversations). Une ligne en haut dit combien le projet a de conversations, avec **open them in Conversations**. Les conversations elles-mêmes sont dans Conversations.

- **Instructions (`AGENTS.md`)**, lues au début de chaque session. L'éditeur propose :
  - un **compteur de tokens** (ce texte est relu à chaque session) ;
  - **add a section ▾**, des blocs types à compléter : projet, commandes, conventions, git, langue, interdits ;
  - **let Pi write it** : Pi lit le projet et rédige lui-même son `AGENTS.md` ;
  - **earlier versions** : les 10 dernières versions, restaurables ;
  - **Ctrl+S** pour enregistrer.
- **What Pi reads at startup** : la liste exacte et ordonnée de ce que Pi charge :
  1. le `AGENTS.md` global de `~/.pi/agent` ;
  2. ceux des dossiers parents ;
  3. celui du projet.

  L'onglet indique aussi si le projet est **approuvé** dans Pi. Sans approbation, les fichiers de `.pi/` sont ignorés.
- **What Pi loads** : ce que Pi charge en plus de lui-même, les tiens (`~/.pi/agent`) et ceux du projet (`.pi/`) :
  - **Pi lui-même**, sa version et la dernière publiée, avec **update** quand une plus récente existe ;
  - les **packages** de `settings.json` (`npm:…`, `git:…` ou un chemin), avec leur version, ou « not installed ». Un package npm en retard a **update**, et **update all packages** apparaît quand il y en a plusieurs ;
  - les **extensions**, **skills** et **prompts** (leurs dossiers, et les chemins donnés dans `settings.json`) ;
  - les **serveurs MCP**, que Pi 1.x connecte lui-même : `~/.pi/agent/mcp.json` (les tiens) et `.pi/mcp.json` du projet (lu seulement si le projet est approuvé), avec leur type (stdio ou http) et s'ils sont coupés ;
  - le modèle par défaut.

  Les dernières versions sont demandées au registre npm depuis la VM, au plus toutes les 6 heures (`~/.local/state/pi-dir-picker/versions.json`). **update** ouvre un onglet « pi update » où tourne `pi update` (ou `pi update <package>`, `pi update --extensions`), visible du début à la fin. Si Pi a été installé pour tous les utilisateurs (`sudo npm install -g`, dans `/usr/local`), il ne peut pas se mettre à jour lui-même et donne la commande npm qui le ferait : l'onglet la montre et propose de la lancer avec `sudo` (sudo demande ton mot de passe dans ce terminal ; seule une commande de cette forme exacte, pour le paquet de Pi, est acceptée). Mieux vaut installer Pi pour ton compte, dans `~/.npm-global` (le picker l'y trouve et le bac à sable l'expose en lecture seule) : `pi update` marche alors sans sudo. Les Pi déjà lancés gardent leur version jusqu'à leur redémarrage. Pour ajouter un package ou un serveur MCP sur la VM : `pi install npm:…`, `pi mcp add …`.
- **Avancé :** `.pi/APPEND_SYSTEM.md` s'ajoute au prompt système de Pi, et `.pi/SYSTEM.md` le remplace (avec un avertissement).

### Notifications et raccourci

- **Notification Windows** quand un Pi passe de « working » à « idle », pour tous les Pi lancés. Rien ne s'affiche si Pier est déjà au premier plan.
- **Ctrl+Alt+V,** depuis n'importe quelle application : envoie à Pi l'image ou les fichiers du presse-papier.
- **Un seul Pier à la fois :** le relancer remet au premier plan celui qui tourne (même réduit dans la zone de notification) au lieu d'en ouvrir un second.
- **Fermer la fenêtre** laisse Pier dans la barre des tâches. Pour le quitter : clic droit sur l'icône, puis Quit.

### Settings (une fois connecté)

Un onglet par catégorie ; la fenêtre se rouvre sur le dernier onglet affiché.

- **Layout :** de quel côté vont les panneaux (Panels), l'emplacement de chaque onglet, et Reset layout.
- **Appearance :** thème et taille de police du terminal. Thèmes intégrés : Pier sombre/clair (ou « suivre le système »), One Dark, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha, Solarized sombre/clair, GitHub Light. Le thème colore toute l'interface **et** le terminal (16 couleurs ANSI comprises).
  - **Import a VS Code or Zed theme… :** prend le `.json` d'un thème VS Code (dossier `themes/` de l'extension, commentaires acceptés) ou Zed (zed.dev/themes, `~/.config/zed/themes` ; un fichier Zed peut contenir plusieurs thèmes, tous sont ajoutés). Les couleurs absentes sont déduites des autres.
  - **Customize… :** modifie chaque couleur avec aperçu en direct, puis l'enregistre sous un nom. Partir d'un thème intégré ou importé crée une copie ; un de tes thèmes est modifié sur place. « delete this theme » supprime un de tes thèmes.
- **Behavior :**
  - Ctrl+Alt+V ; si un autre programme l'utilise déjà, les Settings le disent ;
  - arrêter les partages quand le Pi du projet se termine ;
  - notifications ;
  - supprimer aussi, à la fin d'un Pi, ce qui lui a été donné ;
  - reprendre les partages après une reconnexion.
- **Terminals :** les touches de copier-coller, copier dès la sélection ou avec Ctrl+Shift+C, le focus qui suit la souris, le rendu par la carte graphique.
- **Picker :** sa version et celle de Pier, la mise à jour automatique (activée par défaut), et un bouton pour le réinstaller.
- **Diagnostics :** l'onglet **Logs** (montré ou non), les journaux détaillés, l'emplacement des journaux, **Copy a report**, **Save a report…**, et l'ouverture du dossier des journaux.

---

## 5. Sécurité

| Sujet | Ce qui est en place |
|---|---|
| **Mot de passe** | Gardé en mémoire uniquement, jamais écrit sur le disque. Il ne peut jamais finir dans une URL : les formulaires ne peuvent pas être soumis vers une adresse. |
| **Identité du serveur** | L'empreinte est vérifiée à chaque connexion, et une empreinte qui change bloque la connexion **avant** l'envoi du mot de passe. Le bastion est vérifié de la même façon. |
| **Réseau** | Aucun port ouvert sur la VM. Tout passe par SSH, à travers WireGuard. Voir [Réseau et chiffrement](#réseau-et-chiffrement). |
| **Bac à sable de Pi** | Avec bubblewrap, Pi voit le système en **lecture seule**. De ton home, il ne voit que le **projet**, `~/.pi`, les dossiers d'où Pi et Node s'exécutent et `~/.gitconfig`. Le reste (autres projets, `~/.ssh`…) est invisible. Ses processus sont isolés. Si bubblewrap manque, **Pi refuse de démarrer** au lieu de tourner sans protection. |
| **Clé Hindsight** | Lue par le picker et transmise à Pi par son environnement, jamais sur la ligne de commande, où les autres utilisateurs de la VM pourraient la lire. Le picker prévient si le fichier de la clé est lisible par d'autres. |
| **Dossiers partagés** | Confinés au dossier choisi : pas de `..`, pas de lien qui sort, pas de chemin Windows piégé. Lecture seule par défaut, et confirmation pour l'écriture. |
| **Archives reçues** (copies de dossiers) | Extraites avec le filtre de sécurité de Python : pas de chemin qui sort, pas de lien dangereux, pas de fichier spécial. Taille et nombre de fichiers plafonnés. |
| **git** | Appelé sans `core.fsmonitor`, sans programme de diff externe et sans `textconv`, que la configuration d'un dépôt piégé pourrait détourner. |
| **Ce que l'interface peut demander à la VM** | Seulement une liste fermée de commandes. Les arguments de Pi sont filtrés : seuls `--new`, `--continue`, `--session` avec un fichier de session et `--slot` avec un nom de session tmux sont acceptés. |
| **L'interface elle-même** | Aucun contenu distant : la page ne charge que ses propres fichiers (politique CSP stricte), et n'a accès qu'aux commandes de Pier, au choix de fichiers et aux notifications. |
| **Journaux** | Jamais de mot de passe, ni ce qui est tapé dans un terminal ou dans Pi. |
| **Commandes envoyées à la VM** | Chaque argument est entre guillemets pour le shell. Tous les chemins sont contrôlés pour rester dans le home. |

Points à connaître :
- **L'exécutable n'est pas signé :** Windows affiche un avertissement au premier lancement.
- **Le bac à sable masque `~/.ssh`,** donc Pi ne peut pas faire `git push` en SSH, sauf si on ajoute `sandbox_read = ["~/.ssh"]`. Pi pourrait alors lire les clés.

### Réseau et chiffrement

**Pas de TLS dans Pier, et c'est voulu.** Pier ne parle à la VM qu'en **SSH** : aucun serveur web, aucune API HTTP, aucun certificat à gérer. SSH chiffre et authentifie tout lui-même : terminaux, commandes, `watch`, fichiers envoyés, partages (sshfs passe dans la même connexion). Le seul TLS du système est celui de **Pi vers son fournisseur de modèle** (HTTPS, géré par Pi sur la VM).

**Les couches, de l'extérieur vers l'intérieur :**

1. **WireGuard** (ChaCha20-Poly1305, Curve25519) : la VM n'est joignable que par le tunnel.
2. **SSH**, dans le tunnel, avec ce que Pier accepte de négocier :

   | | Accepté | Refusé (même si le serveur le propose) |
   |---|---|---|
   | Échange de clés | **`mlkem768x25519-sha256`** en premier (hybride post-quantique, celui d'OpenSSH 9.9+ : Debian 13 le propose), puis `curve25519-sha256`, puis DH 4096/8192 bits | DH SHA-1, petits groupes DH, courbes NIST |
   | Clé du serveur | Ed25519, RSA avec SHA-2, ECDSA P-256/P-384 | **RSA avec SHA-1** (`ssh-rsa`) |
   | Chiffrement | ChaCha20-Poly1305, AES-256-GCM, AES-128-GCM | AES-CTR, AES-CBC, 3DES |
   | Intégrité | intégrée au chiffrement, ou HMAC-SHA2 « encrypt-then-MAC » | HMAC-SHA1, MAC non-ETM |
   | Compression | aucune | |

   La protection contre l'attaque **Terrapin** (« strict kex ») est active. Un serveur qui ne propose rien de cette liste est refusé **avant** l'envoi du mot de passe (vérifié par un test).
3. **L'empreinte du serveur**, épinglée au premier contact : un faux serveur sur le chemin ne reçoit jamais le mot de passe.
4. **Avec un bastion :** la connexion à la VM est chiffrée **de bout en bout à travers lui**. Le bastion fait passer des octets chiffrés : il ne voit ni le mot de passe de la VM, ni ce qui s'échange. Son empreinte est vérifiée de la même façon.

**Ce qui pourrait être mis en place sur la VM** (rien de tout cela ne demande de clé SSH) :

1. **N'accepter SSH que par WireGuard,** par le pare-feu plutôt que par `ListenAddress` : si le tunnel ne monte pas au démarrage, sshd ne se retrouve pas sans adresse, et on garde la console de l'hyperviseur. Avec nftables (adapter `wg0`) :

   ```
   # /etc/nftables.conf (extrait) : SSH (port 2222) seulement depuis le tunnel
   table inet filter {
     chain input {
       type filter hook input priority 0; policy drop;
       ct state established,related accept
       iif "lo" accept
       udp dport 51820 accept                 # WireGuard lui-même
       iifname "wg0" tcp dport 2222 accept   # SSH, par le tunnel seulement
       icmp type echo-request accept
       icmpv6 type { echo-request, nd-neighbor-solicit, nd-router-advert, nd-neighbor-advert } accept
     }
   }
   ```

   Ensuite `sudo systemctl enable --now nftables`. **À tester avec la console de la VM ouverte**, pour pouvoir revenir en arrière.

2. **Durcir sshd** avec un fichier à part, qui ne touche pas à la configuration de Debian :

   ```
   # /etc/ssh/sshd_config.d/50-pier.conf
   PermitRootLogin no
   AllowUsers leo
   MaxAuthTries 3
   LoginGraceTime 20
   MaxStartups 5:50:20
   # Pier ouvre un canal par terminal, appel ou partage : 10 (le défaut) ne suffit pas toujours.
   MaxSessions 30
   # Ce que Pier utilise, rien de plus : pas de redirection de ports, pas de X11.
   DisableForwarding yes
   PermitTunnel no
   # Les mêmes algorithmes que Pier.
   KexAlgorithms mlkem768x25519-sha256,sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org
   Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com
   MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
   HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256
   ```

   Vérifier avec `sudo sshd -t`, puis `sudo systemctl reload ssh`. `DisableForwarding` ne gêne pas Pier : les partages passent par une commande, pas par une redirection. **Sur un bastion, en revanche, ne pas le mettre** : c'est justement sa redirection qui mène à la VM.

3. **fail2ban** (`sudo apt install fail2ban`, la protection SSH est active par défaut) : bannit une adresse après quelques mots de passe faux. Utile surtout si SSH reste ouvert hors du tunnel ; derrière le seul WireGuard, seuls tes appareils peuvent essayer.

4. **Une clé partagée (`PresharedKey`) dans WireGuard,** pour chaque appareil (`wg genpsk`, la même valeur des deux côtés). Elle ajoute un chiffrement symétrique au tunnel : un trafic enregistré aujourd'hui resterait illisible même si Curve25519 tombait un jour face à un ordinateur quantique.

5. **Un deuxième facteur (code TOTP)** pour SSH, avec `libpam-google-authenticator`. **Pier ne le gère pas encore :** il répond aujourd'hui le mot de passe à toutes les questions cachées du serveur. Il faudrait qu'il demande le code à part (une petite évolution possible).

6. **Limiter où Pi peut envoyer des données.** Le bac à sable cache tes fichiers, mais Pi garde l'accès au réseau (il doit joindre son modèle). Une instruction piégée dans un fichier lu par Pi pourrait lui faire envoyer du code ailleurs. Parade possible : un proxy HTTPS avec une liste de domaines autorisés (celui du fournisseur, npm, GitHub…), et le pare-feu qui bloque le reste pour Pi. C'est plus lourd à mettre en place.

**Côté PC :**
- **Le mot de passe** reste en mémoire tant que Pier tourne (pour se reconnecter tout seul). On pourrait l'effacer de la mémoire dès qu'il n'est plus utile, au prix de le redemander à chaque coupure.
- **`known_hosts.json`** (les empreintes acceptées) est dans ton profil Windows, lisible par toi seul. Un programme malveillant sur le PC pourrait le modifier, mais il pourrait aussi lire ce que tu tapes : c'est hors de portée de Pier.
- **Pour distribuer Pier à d'autres :** signer l'exécutable (Authenticode) et publier son empreinte SHA-256, pour qu'ils sachent que c'est le bon. Le picker n'a pas besoin de signature à part : il est dans l'exe, et voyage par la connexion SSH vérifiée.


### Audit du 14 octobre 2026

Une relecture complète (sécurité côté PC, sécurité côté VM, stabilité, performance) a été faite, et ce qu'elle a confirmé corrigé (picker 4.11) :

- **git ne lance plus rien hors du bac à sable.** La config `.git/config` d'un projet est modifiable par Pi ; un filtre déclaré là s'exécutait quand Pier demandait `git status` ou un diff. Ces commandes git tournent maintenant elles-mêmes dans bubblewrap : le dépôt en lecture seule, le reste du dossier personnel caché, sans réseau.
- **Le bac à sable de Pi** :
  - n'expose plus tout `~/.local` (où sont les points de restauration et l'état du picker), seulement `~/.local/bin` et ses voisins de programmes ;
  - a son propre `/dev`, donc plus d'accès aux autres terminaux (`/dev/pts`) ;
  - cache `/run/user`, d'où le bus de session et systemd auraient pu lancer un programme dehors ;
  - refuse de tourner dans le dossier personnel lui-même ou dans `~/.ssh`, `~/.config`, `~/.local`, `~/bin`, `~/.pi` : un lien piégé dans un projet ne peut plus donner tout le dossier personnel à Pi. Ces dossiers ne sont plus proposés comme projets, et les ouvrir est refusé tout de suite, avec la raison, avant de lancer quoi que ce soit.
- **Les écritures du picker dans les dossiers de Pi** (instructions, historique, marques de partage, extension) passent par un fichier temporaire au nom imprévisible, et refusent un dossier remplacé par un lien vers ailleurs. Un fichier créé par une restauration est supprimé sans suivre de lien.
- **Ce que dit un Pi** (sa conversation) n'est accepté que si c'est un fichier de conversation de Pi : ni `/dev/zero`, ni un chemin piégé.
- **La mise à jour avec sudo** n'accepte que la commande npm exacte que Pi propose, vers `/usr`, `/usr/local` ou `/opt`, avec ses deux options habituelles.
- **Côté PC :**
  - **commandes :** elles passent en base64 et sont exécutées par `/bin/sh`. Un shell de connexion qui lit autrement les guillemets (fish) ne permet plus d'injection.
  - **presse-papier :** un programme de la VM ne peut le remplir (OSC 52) que juste après une touche tapée dans son onglet. Un lien affiché par un programme (OSC 8) n'est jamais ouvert, seulement copié.
  - **récupération d'une copie (take-back) :**
    - elle est plafonnée (600 Mo reçus, 2 Go dépliés) et écrite sur le disque au fur et à mesure, pas en mémoire ;
    - les liens et fichiers spéciaux sont ignorés ;
    - chaque fichier reçoit la marque « venu d'Internet », donc Windows avertit avant de l'ouvrir ou de l'exécuter.
  - **mémoire :** une réponse de la VM est limitée à 64 Mo, et une ligne de tmux à 8 Mo.
  - **empreintes :** « Trust » n'accepte que l'empreinte que Pier vient de voir.
  - **mot de passe :** il est oublié dès qu'on change d'adresse ou d'utilisateur.
  - **partage en direct :** il refuse ce qu'il ne peut pas vérifier, y compris un lien qui ne pointe nulle part.
  - **onglets Pi :** Pi ne peut plus imiter le message de Pier qui dit quel Pi un onglet montre.
- **Stabilité :**
  - **réveil du PC :** Pier se reconnecte tout seul, en réessayant jusqu'à 15 minutes, au lieu de renvoyer à l'écran de connexion. Les onglets Pi restent et se rattachent, et les partages repartent.
  - **connexion morte :** elle ne bloque plus l'application, grâce aux délais sur l'ouverture des canaux et la connexion. Un gros collage ne bloque plus les autres terminaux.
  - **Setup :** un texte non enregistré ne peut plus partir dans un autre projet.
  - **watch :** il ne redémarre plus en boucle.
  - **picker :** les montages sshfs morts sont vus et démontés. Un fichier illisible n'empêche plus les points de restauration, et une restauration ne perd plus son point.
- **Performance :**
  - **watch :** `git status` au plus toutes les 3 secondes par projet. Setup reconstruit au plus toutes les 3 secondes quand Pi travaille. Les dernières versions sont demandées à npm en arrière-plan.
  - **mémoire :** les appels d'outils de Pi sont gardés sous forme compacte.
  - **terminal :** le décodage du mode contrôle de tmux est linéaire, et le redimensionnement ne refait le terminal qu'une fois le geste fini.
  - **logs :** l'onglet n'est plus redessiné à chaque ligne.

**Ce qui reste, connu :**
- **`~/.pi` est commun à tous les projets** et modifiable par Pi. Un Pi manipulé dans un projet peut ajouter un package, une extension ou un serveur MCP que les Pi des autres projets chargeront, et `pi update` installe ces packages hors du bac à sable. Setup montre la liste des packages : regarde-la avant de mettre à jour.
- **Les appels ponctuels à la VM** (ouvrir un dossier, un diff) démarrent Python à chaque fois. On pourrait les faire passer par le watch.
- **Sans tmux**, un Pi lancé à la main dans le picker pourrait injecter des touches dans le terminal du picker (TIOCSTI). Pier lance toujours Pi dans tmux.
- **L'ordre des touches** très rapides n'est garanti que par l'ordre des appels. Un numéro de séquence le rendrait certain.

---

## 6. Installation

### Sur la VM

```bash
sudo apt install tmux bubblewrap sshfs git
```

**Le picker, Pier l'installe lui-même** à la première connexion, puis le tient à jour. Pour l'utiliser en SSH sans Pier avant cela, on peut le copier à la main (la VM utilise le port 2222 et le nom `pi-sh` défini dans `~/.ssh/config`) :

```powershell
scp C:\Users\leo\Downloads\pi-tui\pi-dir-picker.py pi-sh:bin/pi-pick
```

Python 3.12 ou plus récent est nécessaire, pour la réception de dossiers ; Debian 13 a Python 3.13. git sert aux points de restauration.

### Sur le PC : `~/.ssh/config`

```
Host pi pi-sh
    HostName 192.168.1.20
    Port 2222
    User leo
    ServerAliveInterval 60
    ServerAliveCountMax 3

Host pi
    RequestTTY force
    RemoteCommand /home/leo/bin/pi-pick
```

`ssh pi` ouvre le picker, et `ssh pi-sh` un shell normal (pour scp, rsync…). Avec un bastion, il suffit d'ajouter `ProxyJump bastion` sous `Host pi pi-sh`.

### Pier

L'exécutable compilé se trouve dans `client/src-tauri/target/release/pier.exe`. Il n'y a rien à installer : WebView2 est déjà présent sur Windows 10 et 11.

Pour le compiler (Rust et Visual Studio Build Tools, installés avec Chocolatey) :

```powershell
cd C:\Users\leo\Downloads\pi-tui\client\src-tauri
cargo tauri build --no-bundle
```

Il faut quitter Pier avant de recompiler : Windows interdit de remplacer un programme ouvert. Les versions pour macOS et Linux se construiront avec GitHub Actions.

---

## 7. Utilisation au quotidien

**Sans Pier, juste en SSH :**
1. `ssh pi` ouvre le picker.
2. Sélectionne un projet, puis `p` : Pi démarre dedans.
3. `Ctrl-b d` revient au picker, et Pi continue. `q` quitte.

**Avec Pier :**
1. Lance Pier, puis tape ton mot de passe.
2. Le picker s'ouvre au centre : `p` sur un projet.
3. Une capture d'écran (Win+Shift+S), puis Ctrl+V dans Pier : l'image est dans Pi, tu écris ta question.
4. Un dossier du PC à montrer ? Glisse-le dans Pier, puis « Share live, read-only ».
5. Suis le travail dans **Activity** ; clique sur un fichier modifié pour voir le diff.
6. Le soir, si la tâche est longue : **hand off**, puis éteins le PC.
7. Le lendemain : reconnecte-toi. Le résultat est dans **Activity**, et **Take back** se fait dans **Context**.

**Pour démarrer un nouveau projet :** onglet **Setup**, puis **let Pi write it** pour obtenir un premier `AGENTS.md`. Ajuste-le ensuite ; chaque session suivante en profitera.

---

## 8. Coupures et reprise

| Ce qui s'arrête | Conséquence | Que faire |
|---|---|---|
| **Le PC** (veille, batterie, Wi-Fi) | Pi continue sur la VM. Les partages en direct tombent et passent en pause. | Se reconnecter : `p` ou l'onglet `pi · projet` remet dans la conversation. Puis **resume** sur les partages. |
| **La VM** (courant, redémarrage) | Pi et tmux s'arrêtent. **La conversation est sauvegardée**, Pi l'écrit au fur et à mesure. Ce qui était en cours est perdu : la réponse en cours d'écriture, une commande lancée. | Le bandeau de **Setup** propose **Continue where it stopped**, ou `c` dans le picker (`--continue`). |
| **La connexion** pendant une longue tâche | Comme pour le PC. | Rien : Pier se reconnecte tout seul s'il a encore le mot de passe en mémoire. |

Conseil : travailler dans un dépôt git et laisser Pi commiter régulièrement. En cas de coupure, on revient au dernier état propre.

---

## 9. Fichiers et emplacements

**Sur la VM :**

| Chemin | Contenu |
|---|---|
| `~/bin/pi-pick` | le picker |
| `~/.config/pi-dir-picker/config.toml` | sa configuration (facultative) |
| `~/.local/state/pi-dir-picker/state.json` | projets récents, tri (lisible par toi seul) |
| `~/.local/state/pi-dir-picker/picker.log` | le journal du picker (`.1`, `.2` : les précédents) |
| `~/.local/state/pi-dir-picker/checkpoints/` | les points de restauration, un dépôt git par projet |
| `~/.local/state/pi-dir-picker/labels.json` | noms, catégories, conversations épinglées et archivées (Pier) |
| `~/.local/state/pi-dir-picker/versions.json` | dernières versions de Pi et des packages, demandées à npm au plus toutes les 6 heures |
| `~/.pi/pier/pier-session.ts` | l'extension que Pier donne à chaque Pi qu'il lance (`--extension`) |
| `~/.pi/pier/pis/<session tmux>.json` | ce que chaque Pi dit : sa conversation, s'il travaille (effacé quand il s'arrête) |
| `~/.local/state/pi-dir-picker/tmux.conf` | la configuration du serveur tmux des Pi (réécrite par le picker) |
| `~/bin/pi-pick.previous` | la version du picker d'avant la dernière mise à jour par Pier |
| `<projet>/.pi-images/`, `.pi-files/` | images, fichiers et copies envoyés (ignorés par git) |
| `<projet>/.pi-shared/` | partages en direct et copies issues d'un Hand off |
| `<projet>/.pi/devbox-history/` | anciennes versions des instructions |
| `<projet>/AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/SYSTEM.md` | le contexte de Pi pour ce projet |
| `~/.pi/agent/sessions/` | les sessions de Pi (lues par Activity et Conversations) |
| `~/.pi/hindsight.key` | la clé de mémoire Hindsight (à garder en `chmod 600`) |

**Sur le PC** (dossier de configuration de Pier, `%APPDATA%\app.devbox.client` sous Windows) :

| Fichier | Contenu |
|---|---|
| `settings.json` | adresse, port, utilisateur, bastion. **Jamais de mot de passe.** |
| `known_hosts.json` | les empreintes de serveurs acceptées |
| `shares.json` | les partages à retrouver (en pause, ou issus d'un Hand off) |

Le journal est dans `%LOCALAPPDATA%\app.devbox.client\logs\` (`pier.log`, puis `pier.1.log`, `pier.2.log`). Les préférences d'affichage (disposition, thème…) sont gardées par l'application elle-même.

**Dans ce dépôt :**

| Chemin | Rôle |
|---|---|
| `pi-dir-picker.py` | le picker et son API |
| `pi-dir-picker-tests.py` | la suite de tests, à lancer sur la VM, dans un vrai terminal tmux |
| `config.example.toml` | modèle de configuration du picker |
| `client/ui/` | l'interface de Pier : `index.html`, `style.css`, `themes.js`, xterm.js dans `vendor/` |
| `client/ui/js/` | son code, un fichier par partie : `core.js` (préférences, journal, outils), `vm.js` (l'état de la VM, reçu par `watch`), `connect.js`, `workspace.js` (les trois zones et leurs onglets), `prefs.js`, `terminal.js`, `context.js`, `project.js`, `diff.js`, `setup.js`, `logs.js`, `backend.js` (le côté Rust), `mock.js` (une fausse VM pour essayer l'interface dans un navigateur), `main.js` |
| `client/src-tauri/src/` | la partie Rust : `ssh.rs` (connexion, empreintes, bastion), `term.rs` (terminaux), `share.rs` (serveur SFTP des partages), `copy.rs` (archives de dossiers), `store.rs` (réglages), `clip.rs` (presse-papier), `journal.rs` (le journal), `picker.rs` (le picker intégré et son installation), `watch.rs` (la commande `watch`), `lib.rs` (tout le reste) |

---

## 10. Tests

- **Le picker :** 243 vérifications de la logique et de l'API, 42 pour plusieurs Pi par projet et `watch` (quel Pi rejoindre ou lancer, fichiers de session, `stop`, une conversation reprise par le bon Pi, `watch` qui n'envoie que les changements, voit un Pi qui s'arrête en une seconde, survit à une erreur et se termine avec la connexion), plus 56 pour les points de restauration (avec le vrai git : modifier, créer, supprimer, restaurer un fichier ou tout, annuler une restauration, noms piégés, gros fichiers, la surveillance d'une session de Pi simulée) et le journal (format, rotation, traceback d'un plantage, texte tapé jamais écrit). Elles tournent sur Windows avec un module curses simulé. Plus la suite `pi-dir-picker-tests.py`, à lancer **sur la VM** : elle pilote le picker dans un vrai terminal tmux et contrôle le vrai bac à sable bubblewrap, les points de restauration autour d'un vrai `--exec-pi`, et deux Pi dans un même projet avec le vrai tmux.

  ```powershell
  scp C:\Users\leo\Downloads\pi-tui\pi-dir-picker.py C:\Users\leo\Downloads\pi-tui\pi-dir-picker-tests.py pi-sh:pi-tui/
  ```

  ```powershell
  ssh -t pi-sh "python3 -B ~/pi-tui/pi-dir-picker-tests.py"
  ```

  Si `~/pi-tui` n'existe pas encore sur la VM, crée-le d'abord : `ssh pi-sh "mkdir -p ~/pi-tui"`.

- **Pier :** 44 tests Rust (`cargo test`), dont les onglets Pi en mode contrôle de tmux (décodage de `%output`, touches en octets bruts, tailles, fin) contre un serveur SSH local, le refus d'un serveur aux algorithmes anciens (sans que le mot de passe parte), dont `watch` contre un serveur SSH local (lignes coupées en deux paquets, aller-retour, fin). Nouveaux : le format du journal, sa rotation, l'heure UTC, le picker intégré (sa version d'API doit être celle de Pier, sinon la compilation des tests échoue), le script d'installation (refus des chemins piégés). Le script d'installation a aussi été essayé à la main avec `sh` : installation, mise à jour, fichier corrompu refusé, Python absent. Ils couvrent la connexion contre un vrai serveur SSH lancé en local : premier contact, mauvais mot de passe, empreinte changée, bastion. Ils couvrent aussi le partage de bout en bout (la VM simulée ne peut ni sortir du dossier ni écrire en lecture seule), le confinement des chemins, les archives et le filtrage des arguments de Pi.
- **L'interface** a été vérifiée dans un navigateur avec un faux backend (qui simule aussi `watch` et deux Pi) : agencement, glisser des onglets, menus, Context, Hand off, Setup, thèmes, petites largeurs, mise à jour du picker, Restore, Logs, rapport, plusieurs Pi.

---

## 11. Limites connues et ce qui reste à vérifier

**À vérifier sur la vraie VM** (testé seulement en local ou en simulation) :
- le vrai bac à sable bubblewrap, et l'accès aux dossiers partagés (sshfs) depuis ce bac à sable ;
- le démontage réel de sshfs lors d'un Hand off, pendant que Pi travaille ;
- la reprise réelle d'une session avec `--continue` et `--session` ;
- le Ctrl+V de fichiers copiés dans l'Explorateur, et les notifications Windows ;
- l'installation et la mise à jour du picker par Pier sur la vraie VM ;
- les points de restauration pendant une vraie session de Pi (en particulier le délai entre l'arrivée d'un prompt et la première modification de Pi) ;
- l'extension de suivi (`~/.pi/pier/pier-session.ts`) avec le vrai Pi 1.x, dans le bac à sable : conversation suivie après `/new`, `/resume`, `/fork`, et « working » qui retombe à la fin ;
- `pi update` lancé depuis Setup, et la demande des dernières versions au registre npm depuis la VM.

**Limites :**
- **Deux Pi qui modifient les mêmes fichiers** dans un projet se marchent dessus : rien ne l'empêche. Plusieurs Pi conviennent à des tâches séparées (le code et la doc). Les points de restauration du projet sont communs à ses Pi.
- **Un `/new` ou `/resume` tapé dans Pi** : chaque Pi lancé par Pier le dit lui-même (son extension). Sans elle (un Pi lancé avant, ou `track_sessions = false`), le picker devine en cherchant le fichier récent qu'aucun autre Pi ne tient ; deux Pi du même projet qui font un `/new` à la même seconde peuvent alors être confondus.
- **Le nom d'une très grosse conversation** (des images, des centaines de Mo) n'est cherché que dans ses 4 derniers Mo la première fois : un nom donné au début d'une telle conversation, jamais redonné, peut ne pas apparaître.
- **Ce que Pi va lire ensuite** ne peut pas être connu à l'avance.
- **Les fichiers lus ou modifiés par une commande bash** de Pi n'apparaissent que comme « changed on disk », par git.
- **Pas de notification quand Pier est éteint.**
- **Les partages en direct ont besoin du PC allumé.** Les copies et le Hand off, non.
- **Les points de restauration** ne couvrent ni les fichiers ignorés par git, ni ce qu'une commande de Pi a fait hors du projet (une base de données, un paquet installé, un `git push`).

---

## 12. Pistes pour la suite

- **Notification sur le téléphone** quand Pi a fini, envoyée par la VM elle-même (ntfy), donc même PC éteint.
- **SSH limité au tunnel WireGuard,** sshd durci, fail2ban, `PresharedKey` WireGuard : voir [Réseau et chiffrement](#réseau-et-chiffrement).
- **Deuxième facteur (TOTP)** dans Pier.
- **Versions macOS et Linux** construites par GitHub Actions, et signature de l'exécutable.
- **Plusieurs VM** enregistrées, au choix à la connexion.
- **Rapatrier les changements de Pi** d'une copie vers le dossier d'origine, avec un diff pour choisir, plutôt que télécharger une copie complète.
