# Dexcom

La glycémie d’un capteur Dexcom (G6, G7, ONE+) partagée par
[Dexcom Share](https://www.dexcom.com/), dans Gladys, par le cloud de
Dexcom, avec le compte Dexcom de la personne qui porte le capteur.

**Pas un dispositif médical : ne jamais s’en servir pour une décision de traitement ; les alertes peuvent être en retard ou manquer.**

Gladys lit le cloud au rythme que vous choisissez, en passant par internet,
le téléphone qui reçoit le capteur et les serveurs de Dexcom : chacun peut
être en retard, en panne ou se tromper, et Gladys ne dit rien quand elle ne
peut pas lire. Gardez les alarmes des applications Dexcom et les conseils
de votre équipe soignante ; cette intégration n’ajoute que de la domotique
par-dessus (une lampe qui passe à l’orange, une notification), jamais une
alarme médicale.

- le compte devient un appareil Gladys : **glycémie** (mg/dL ou mmol/L),
  **tendance** (un nombre et la **flèche**) et **âge de la mesure**
  (minutes) ;
- une mesure plus ancienne que le délai choisi (15 minutes par défaut)
  **n’est jamais publiée comme actuelle** : seul son âge avance, et l’état
  de l’intégration le dit ;
- trois déclencheurs de scène : **Glycémie basse**, **Glycémie haute** et
  **Mesure trop ancienne**.

Lecture seule : Gladys ne change jamais rien chez Dexcom (alarmes, partage,
abonnés restent dans les applications).

> **Cette intégration n’a jamais été testée avec un vrai compte ou capteur Dexcom.**
> Cette première version a été écrite à partir de la bibliothèque
> [pydexcom](https://github.com/gagebenne/pydexcom) (MIT), portée en
> JavaScript, et testée seulement contre une fausse API Dexcom Share.
> Dites sur le forum Gladys ce qui marche et ce qui ne marche pas.

Intégration non officielle, sans lien avec Dexcom.

## Avant de commencer

Dans l’application Dexcom (G6, G7 ou ONE+) de la personne qui porte le
capteur, activez le **partage (Share)** et invitez **au moins un abonné**
(Dexcom Follow) : sans abonné, Dexcom Share ne publie rien. Le compte à
saisir dans Gladys est **celui de la personne qui porte le capteur**, pas
celui d’un abonné.

## Configuration

- **Nom d’utilisateur** : le nom d’utilisateur, l’adresse e-mail ou le
  numéro de téléphone (avec `+` et l’indicatif du pays) du compte Dexcom.
  L’identifiant de compte Dexcom (un UUID) est accepté aussi. Jamais écrit
  dans un journal.
- **Mot de passe** : gardé par Gladys dans sa base, jamais réaffiché,
  jamais écrit dans un journal, et envoyé seulement à l’API Dexcom Share de
  la région choisie (en https, certificat vérifié). Dexcom bloque un compte
  après plusieurs mauvais mots de passe : voir « Problèmes de connexion ».
- **Région du compte** : **hors des États-Unis** (France, Belgique, Suisse
  et le reste de l’Europe ; par défaut), **États-Unis** ou **Japon**. Une
  mauvaise région reçoit la même réponse qu’un mauvais mot de passe :
  vérifiez-la d’abord.
- **Rafraîchissement** : toutes les 5 minutes (par défaut), 10 ou 15
  minutes. Une requête par lecture (une connexion de temps en temps, quand
  la session expire). Le capteur envoie une mesure toutes les 5 minutes :
  lire plus souvent n’apporte rien.
- **Mesure plus à jour après** : 10, 15 (par défaut), 20, 30 minutes ou
  1 heure. Voir « Mesure à jour ou non ».
- **Unité de glycémie** : mg/dL (par défaut) ou mmol/L : l’unité de la
  fonction glycémie proposée par Découverte, et de la glycémie transmise
  aux déclencheurs de scène. Le cœur de Gladys n’a pas d’unité de
  glycémie : l’unité est écrite dans le nom de la fonction
  (`Glucose (mg/dL)`) et dans sa clé. La changer ajoute une fonction dans
  la nouvelle unité (mettez l’appareil à jour depuis Découverte) ; chaque
  fonction glycémie d’un appareil continue de recevoir ses valeurs, chacune
  dans sa propre unité. Les valeurs en mmol/L sont converties depuis les
  mg/dL (÷ 18,0156, une décimale) : elles peuvent différer de 0,1 de
  l’application.

Ouvrez ensuite l’onglet **Découverte** et créez l’appareil (nommé
« Dexcom » : renommez-le si vous voulez). Seul l’appareil créé reçoit ses
valeurs et déclenche les scènes.

## Ce que montre chaque fonction

- **Glycémie** (mg/dL ou mmol/L) : la dernière mesure du capteur, quand
  elle est à jour.
- **Tendance** (0 à 9, l’échelle de Dexcom et de pydexcom) : 1 hausse
  rapide (↑↑), 2 hausse (↑), 3 légère hausse (↗), 4 stable (→), 5 légère
  baisse (↘), 6 baisse (↓), 7 baisse rapide (↓↓), 8 tendance impossible à
  calculer (?), 9 tendance indisponible (-), 0 aucune (-).
- **Flèche de tendance** (fonction « Trend arrow », texte) : la même
  tendance en flèche.
- **Ancienneté de la mesure** (fonction « Measurement age », minutes) :
  l’âge de la dernière mesure, à chaque lecture. Quand Dexcom Share ne
  donne aucune mesure des dernières 24 heures, l’âge **continue de
  compter** depuis la dernière mesure reçue.
- **Pas d’historique par défaut** pour toutes les fonctions (données de
  santé) : Gladys ne garde que la dernière valeur. Vous pouvez activer
  l’historique fonction par fonction, en sachant que Gladys garde alors ces
  données de santé dans sa base et ses sauvegardes.

## Mesure à jour ou non

Une mesure est **à jour** quand elle a au plus le délai choisi (15 minutes
par défaut) et n’est pas datée dans le futur. Sinon (capteur terminé ou
retiré, téléphone hors de portée ou sans réseau, partage coupé…), elle
**n’est jamais publiée comme actuelle** : la glycémie, la tendance et la
flèche ne sont pas envoyées à Gladys (l’appareil garde sa dernière valeur,
avec sa date), seul l’**âge de la mesure** avance, et l’**état** de
l’intégration (page de configuration) dit que la mesure n’est plus à jour.
Les scènes peuvent utiliser l’âge (par exemple « âge > 15 ») ou le
déclencheur « Mesure trop ancienne ». Une mesure datée de plus de 5 minutes
dans le futur fait demander de vérifier l’horloge de Gladys.

## Déclencheurs de scène

**Glycémie basse** et **Glycémie haute** : choisissez l’appareil (ou tous)
et le seuil (**obligatoire**) : 54 / 70 / 80 mg/dL (basse), 180 / 250 /
300 mg/dL (haute). La scène démarre quand une nouvelle mesure **à jour**
passe sous (au-dessus de) ce seuil, à la lecture suivante. Une mesure
n’est prise que si l’intégration l’a vue pour la première fois dans le
délai choisi. **Une fois par passage** : de nouveau seulement après une
mesure revenue 5 mg/dL au-dessus (en dessous) du seuil, ou après au moins
une lecture manquée : quand le compte n’a pas été lu, ou que deux mesures
sont écartées, depuis plus de max(ce délai, rafraîchissement + 2 minutes).
Une glycémie basse ou haute déjà là au démarrage de l’intégration est
signalée à la première lecture (une alerte manquée est pire qu’une alerte
répétée) : un redémarrage de l’intégration peut la signaler une fois de
plus. Jamais pour une mesure qui n’est pas à jour, ni à une lecture où
l’horloge de Gladys a sauté. Variables : nom de l’appareil, glycémie,
unité, tendance, flèche, heure de la mesure (UTC).

**Mesure trop ancienne** : choisissez l’appareil (ou tous) et le délai
(**obligatoire** : 15 minutes à 4 heures). La scène démarre quand aucune
nouvelle mesure n’est arrivée depuis ce délai. Une fois par attente : une
nouvelle mesure le réarme. Jamais pour un délai déjà atteint au démarrage
de l’intégration, ni à une lecture après un saut d’horloge. **Rien n’est
signalé quand Dexcom Share lui-même ne peut pas être lu** (pas
d’internet, Dexcom en panne, compte arrêté) : surveillez l’état de la
connexion de l’intégration.

## Problèmes de connexion

- **Identifiants refusés** (ou mauvaise région) : un mauvais mot de passe
  essayé encore et encore bloque le compte. Gladys s’arrête donc
  **1 heure**, puis **6 heures**, puis **24 heures** après chaque nouveau
  refus, jamais en boucle. L’arrêt est gardé dans `/data` : un
  redémarrage, une reconnexion de Gladys et le bouton de test attendent
  aussi. Un essai encore en cours quand l’intégration s’arrête compte
  comme un refus. Enregistrer la configuration avec les mêmes identifiants
  fait **un** essai tout de suite par série de refus ; d’autres
  identifiants ou une autre région sont essayés tout de suite. Une lecture
  qui marche oublie les refus.
- **Compte bloqué par Dexcom** (trop d’essais) : même arrêt de 1 heure,
  6 heures puis 24 heures, pour ne pas prolonger le blocage. Vérifiez le
  mot de passe dans l’application Dexcom.
- **Session refusée** : Gladys ouvre **une** nouvelle session et relit une
  fois ; refusée de nouveau, la lecture échoue et sera refaite plus tard,
  jamais en boucle.
- **Dexcom Share surchargé** (HTTP 429) ou **erreur serveur** (HTTP 5xx
  sans code d’erreur connu) : toutes les requêtes sont suspendues, le temps
  que Dexcom demande, entre 1 minute et 6 heures, jamais moins que le
  rafraîchissement. La pause est gardée dans `/data`, même après un
  redémarrage, une reconnexion de Gladys ou une configuration enregistrée.
- **Réponse inattendue, Dexcom Share injoignable** (réseau, délai de 30 s,
  certificat) : nouvel essai après le rafraîchissement, puis le délai
  double jusqu’à 1 heure, même après un redémarrage (l’attente est gardée
  dans `/data`). L’intégration n’abandonne jamais.
- **Tester la connexion** relit et indique si la dernière mesure est à
  jour ; il ne raccourcit jamais un arrêt ni une pause.

## Vie privée

Les glycémies, les tendances, les heures des mesures, le nom
d’utilisateur, le mot de passe, l’identifiant du compte et celui de la
session ne sont jamais écrits dans un journal ni dans le volume `/data` de
l’intégration. `/data` ne garde qu’une courte empreinte des identifiants
(4 caractères, seulement pour voir qu’ils ont changé) avec la fin d’un
arrêt, d’une pause ou d’une attente. La session reste en mémoire. Comme le
fait pydexcom, l’identifiant de session part dans l’adresse de la requête
de lecture (en https) : l’intégration n’écrit jamais d’adresse dans ses
journaux. Gladys garde la dernière valeur de chaque fonction dans sa base
(et ses sauvegardes), et l’historique seulement si vous l’activez. Les
déclencheurs de scène transmettent la glycémie à vos scènes (pour écrire
une notification) : elle va alors là où vos scènes l’envoient.
L’identifiant externe de l’appareil est une empreinte non secrète de
l’identifiant du compte Dexcom (jamais l’identifiant lui-même). **Le nom
et la glycémie vont partout où vont les noms et valeurs des appareils** :
scènes, notifications, Gladys Plus, et les assistants et IA reliés à
Gladys (Google Home, Alexa, MCP…).

## Limites

- Un compte (un capteur) par intégration.
- Rien n’est commandé : ni les alarmes de l’application, ni le partage.
- Pas d’historique du capteur : seulement la dernière mesure des dernières
  24 heures.
- Jamais testée avec un vrai compte ou capteur : voir TODO.md dans le
  dépôt.
