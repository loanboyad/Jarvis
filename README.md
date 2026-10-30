# J.A.R.V.I.S. — assistant vocal PWA

Assistant vocal inspiré de Jarvis (Iron Man), optimisé pour Chrome sur Android.
Dites **« Jarvis »** (ou « Hey Jarvis »), posez votre question, et Jarvis vous répond à voix haute grâce à Claude.

- Mot d'activation en continu (Web Speech API, `fr-FR`)
- Réponses par l'API Claude via un proxy serveur : **la clé API n'est jamais exposée au navigateur**
- Historique de conversation conservé pendant la session
- Synthèse vocale française, voix grave réglable
- Interface hologramme cyan, réacteur arc animé selon l'état (veille, écoute, réflexion, réponse)
- PWA installable (manifest + service worker), plein écran

## Structure

```
public/            Application web (servie telle quelle)
  index.html       Interface
  styles.css       Style hologramme + animations du réacteur
  app.js           Reconnaissance vocale, synthèse vocale, dialogue
  sw.js            Service worker (cache de l'interface)
  manifest.json    Manifeste PWA
  icons/           Icônes de l'application
api/chat.js        Fonction serverless (Vercel) : POST /api/chat
lib/jarvis.js      Logique du proxy (personnalité, appel à Claude, erreurs)
server.js          Serveur Node autonome (local ou hébergeur Node)
```

## Utilisation

| Action | Effet |
| --- | --- |
| Toucher le réacteur (1re fois) | Initialise le micro et la voix (Chrome exige un geste) |
| « Jarvis » … puis votre demande | Jarvis s'active, écoute, puis répond |
| « Jarvis, quelle heure est-il ? » | Demande en une seule phrase |
| Après une réponse | Quelques secondes pour enchaîner **sans** redire « Jarvis » |
| Toucher le réacteur en veille | Activation manuelle |
| Toucher pendant qu'il parle | L'interrompt et vous écoute |
| « Jarvis, efface la conversation » | Remet l'historique à zéro |
| ⚙️ | Choix de la voix, débit, hauteur, code d'accès |

---

## Héberger gratuitement en HTTPS (Vercel) — étape par étape

Le micro ne fonctionne qu'en **HTTPS**. Vercel fournit gratuitement l'hébergement, le HTTPS et les fonctions serverless (pour le proxy).

### 1. Obtenir une clé API Anthropic

1. Allez sur <https://console.anthropic.com> et créez un compte.
2. Ajoutez un moyen de paiement / des crédits (l'API Claude est facturée à l'usage, quelques centimes pour de courtes conversations).
3. Menu **API Keys** › **Create Key**. Copiez la clé (`sk-ant-...`) et gardez-la secrète.

### 2. Mettre le code sur la branche principale

Vercel déploie en production la branche par défaut (`main`). Fusionnez la branche
`claude/jarvis-pwa-voice-assistant-xp0uz4` dans `main` (via une pull request sur GitHub).

### 3. Créer le projet Vercel

1. Allez sur <https://vercel.com> › **Sign Up** › **Continue with GitHub** (offre « Hobby », gratuite).
2. **Add New…** › **Project** › importez le dépôt `jarvis`.
3. *Framework Preset* : **Other**. Ne changez rien d'autre (le fichier `vercel.json` indique déjà que le site est dans `public/`).
4. Dépliez **Environment Variables** et ajoutez :
   - `ANTHROPIC_API_KEY` = votre clé `sk-ant-...` (obligatoire)
   - `JARVIS_ACCESS_TOKEN` = un mot de passe de votre choix (fortement conseillé : sans lui, quiconque connaît l'URL peut utiliser votre crédit)
5. Cliquez sur **Deploy**. Au bout d'une minute, vous obtenez une adresse du type `https://jarvis-xxxx.vercel.app` — déjà en HTTPS.

> Pour modifier une variable plus tard : *Project › Settings › Environment Variables*, puis *Deployments › ⋯ › Redeploy*.

### 4. Vérifier

Ouvrez l'adresse sur ordinateur dans Chrome : le réacteur doit s'afficher. Si vous avez défini
`JARVIS_ACCESS_TOKEN`, ouvrez ⚙️ et saisissez le même code d'accès.

## Ajouter Jarvis à l'écran d'accueil Android

1. Sur le téléphone, ouvrez l'adresse `https://jarvis-xxxx.vercel.app` dans **Google Chrome**.
2. Touchez le réacteur, puis **Autoriser** l'accès au micro.
3. Si vous utilisez un code d'accès : ⚙️ › *Code d'accès* › saisissez-le › *Fermer*.
4. Menu **⋮** (en haut à droite) › **Installer l'application** (ou **Ajouter à l'écran d'accueil** › **Installer**).
5. L'icône réacteur apparaît sur votre écran d'accueil. Lancez Jarvis depuis cette icône : il s'ouvre en plein écran, comme une vraie application.

### Pour une voix plus grave

Chrome sur Android utilise le moteur de synthèse du système :
**Paramètres › Système › Langues et saisie › Synthèse vocale** (le chemin varie selon les marques) ›
moteur **Google** › ⚙️ › **Installer les données vocales** › **Français (France)** › choisissez une voix masculine.
Ajustez ensuite la **hauteur** et le **débit** dans les réglages ⚙️ de Jarvis.

### Bon à savoir

- Jarvis n'écoute que lorsque l'application est **ouverte et au premier plan** (limite des navigateurs). L'écran reste allumé tant que l'app est affichée.
- La reconnaissance vocale de Chrome passe par les serveurs de Google : elle nécessite Internet.
- Sur Android, Chrome émet un petit bip à chaque redémarrage de l'écoute ; c'est normal. Pour le rendre discret, baissez le volume « Notifications ».
- En cas de refus du micro : icône à gauche de l'adresse (ou *Infos sur l'appli* pour la version installée) › **Autorisations** › **Micro** › Autoriser.

---

## Lancer en local

```bash
npm install
cp .env.example .env     # puis renseignez ANTHROPIC_API_KEY
npm start                # http://localhost:3000
```

`localhost` est considéré comme sécurisé par Chrome sur ordinateur ; pour tester sur le téléphone, utilisez le déploiement HTTPS.

## Autre hébergeur (Render, Railway, Fly.io…)

`server.js` est un serveur Node complet (interface + proxy) sans dépendance web :
commande de build `npm install`, commande de démarrage `npm start`, et les mêmes variables d'environnement.
(Sur l'offre gratuite de Render, le service se met en veille après inactivité : la première requête prend ~30 s.)

## Variables d'environnement

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Clé API Anthropic (obligatoire) | — |
| `JARVIS_ACCESS_TOKEN` | Code exigé par le proxy (en-tête `X-Jarvis-Token`) | désactivé |
| `JARVIS_MODEL` | Modèle Claude | `claude-opus-5-5` |
| `JARVIS_EFFORT` | Effort de réflexion (`low`, `medium`, `high`…) | `low` (réponses rapides) |
| `JARVIS_TIMEZONE` | Fuseau pour la date et l'heure connues de Jarvis | `Europe/Paris` |

Pour des réponses encore plus rapides et moins coûteuses, essayez `JARVIS_MODEL=claude-haiku-5-5`.

Le proxy active le repli automatique de l'API (`fallbacks: "default"`) : si le modèle décline une
requête, l'API la relance d'elle-même sur un modèle de repli.
