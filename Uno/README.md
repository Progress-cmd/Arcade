# Uno en ligne

Jeu de cartes de 2 à 6 joueurs, en PHP simple, sans base de données.
104 cartes : 4 couleurs avec les nombres 1 à 9 deux fois chacun, et dans chaque couleur deux Passe, deux Inversion et deux +2 ; plus 4 Jokers et 4 Jokers +4. Chacun reçoit 7 cartes ; à son tour, on pose une carte de même couleur, même nombre ou même symbole que celle de la défausse (ou un Joker, en choisissant la couleur), ou on pioche (on peut alors poser la carte piochée si elle convient, ou la garder). Passe : le suivant passe son tour ; Inversion : le sens change (à deux, on rejoue) ; +2 : le suivant doit poser un autre +2 (la pénalité s'ajoute et passe au joueur d'après), sinon il pioche toutes les cartes accumulées et passe son tour ; Joker +4 : le suivant pioche 4 cartes et passe son tour. On ne peut pas terminer sur une carte noire (Joker ou Joker +4). Le premier qui pose sa dernière carte gagne la manche et marque la valeur des cartes restées dans les mains adverses (nombres : leur valeur ; cartes spéciales : 10 ; Jokers : 20).

## Installation

- PHP 8.1 ou plus récent, sans extension particulière (`mbstring` conseillée).
- Copier le dossier sur l'hébergement. Le dossier `data/games/` doit être accessible en écriture par PHP.
- Test en local : `php -S localhost:8000` dans ce dossier puis ouvrir http://localhost:8000 (ou depuis le dossier parent, puis http://localhost:8000/Uno/). Ne pas passer `index.php` en argument : il servirait de routeur pour toutes les requêtes.

## Comment ça marche

- `index.php` : accueil et table de jeu.
- `api.php` : API JSON (créer, rejoindre, lancer, poser, piocher, passer, rejouer…).
- `lib/game.php` : moteur et règles, côté serveur, qui valide chaque coup.
- `assets/` : interface (CSS et JS, sans dépendance). On joue en touchant une carte de sa main, ou la pioche. L'interface n'indique pas quelles cartes peuvent être posées : c'est au joueur de le voir.
- Les parties sont stockées dans `data/games/<CODE>.json`, avec verrouillage de fichier. Elles sont supprimées après 3 jours d'inactivité.
- Le créateur de la partie (l'hôte) la lance quand au moins 2 joueurs sont assis. Les visiteurs suivants regardent en spectateurs.
- Les joueurs se synchronisent en interrogeant le serveur environ toutes les secondes. Chaque joueur est identifié par un jeton stocké dans son navigateur.
- Un joueur absent depuis plus d'une minute peut être retiré de la partie par les autres (en touchant son nom), pour ne pas bloquer la table.
- Annonce « Uno ! » : qui n'a plus qu'une carte doit l'annoncer avec le bouton (pendant son tour avec deux cartes, ou après). Un adversaire qui appuie sur le même bouton avant l'annonce, après un délai de 3 secondes, lui fait piocher 2 cartes de pénalité.
- Si plus rien ne peut être pioché et que personne ne peut jouer pendant un tour complet, la main la plus légère gagne la manche (cas très rare).

Les dossiers `data/` et `lib/` contiennent un `.htaccess` qui en interdit l'accès direct sous Apache. Sous Nginx, ajoutez une règle `deny all` équivalente.
