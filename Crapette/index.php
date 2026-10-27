<?php
declare(strict_types=1);
// Sans « / » final (…/Phase10), les chemins relatifs (assets/, api.php) pointeraient vers le dossier parent
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!str_ends_with($path, '/') && !str_ends_with($path, '.php')) {
    $query = $_SERVER['QUERY_STRING'] ?? '';
    header('Location: ' . $path . '/' . ($query !== '' ? "?$query" : ''), true, 301);
    exit;
}
$gameId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string)($_GET['g'] ?? '')));
$asset = fn(string $f) => "assets/$f?v=" . filemtime(__DIR__ . "/assets/$f");
?><!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b3d26">
<title>Crapette — jeu de cartes à deux en ligne</title>
<meta name="description" content="Jouez à la Crapette en ligne contre un ami : créez une partie et partagez le lien.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='14' y='6' width='72' height='88' rx='10' fill='%23fffdf7' stroke='%23b8963e' stroke-width='4'/><text x='50' y='68' font-size='48' text-anchor='middle' fill='%23c0392b'>♥</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= $asset('style.css') ?>">
</head>
<body data-game="<?= htmlspecialchars($gameId) ?>">

<!-- ============ ACCUEIL ============ -->
<div id="lobby" class="lobby" hidden>
  <a class="site-link" href="../">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>Tous les jeux
  </a>
  <div class="lobby-card">
    <div class="lobby-deco" aria-hidden="true">
      <span class="mini-card red">A<i>♥</i></span>
      <span class="mini-card">R<i>♠</i></span>
      <span class="mini-card red">D<i>♦</i></span>
    </div>
    <h1 class="logo">Crapette</h1>
    <p class="tagline">Le grand classique des jeux de patience… à deux, et en ligne.</p>

    <form id="createForm" class="lobby-form">
      <label for="nameInput">Votre pseudo</label>
      <input id="nameInput" name="name" maxlength="20" autocomplete="nickname" placeholder="Ex. : Mamie Jeanne" required>
      <button class="btn btn-gold btn-lg" type="submit">Créer une partie</button>
    </form>

    <div class="sep"><span>ou rejoindre avec un code</span></div>

    <form id="joinCodeForm" class="join-row">
      <input id="codeInput" maxlength="6" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Code de la partie">
      <button class="btn btn-ghost" type="submit">Rejoindre</button>
    </form>

    <button class="link-btn" type="button" data-open="rulesModal">Comment jouer ?</button>
  </div>
</div>

<!-- ============ PARTIE ============ -->
<div id="app" class="app" hidden>
  <header class="topbar">
    <a class="brand" href="./" title="Accueil">Crapette</a>
    <div class="scoreboard" id="scoreboard"></div>
    <div class="status-pill" id="statusPill"></div>
    <div class="top-actions">
      <button class="icon-btn" id="shareBtn" title="Inviter un ami" aria-label="Inviter un ami">
        <svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>
      </button>
      <button class="icon-btn" id="chatBtn" title="Discussion" aria-label="Discussion">
        <svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>
        <span class="badge" id="chatBadge" hidden></span>
      </button>
      <button class="icon-btn" id="soundBtn" title="Son" aria-label="Activer/couper le son">
        <svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path class="wave" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/><path class="mute" d="m16 9 6 6m0-6-6 6"/></svg>
      </button>
      <button class="icon-btn" data-open="rulesModal" title="Règles" aria-label="Règles">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/></svg>
      </button>
      <button class="icon-btn" id="menuBtn" title="Menu" aria-label="Menu">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
      </button>
      <div class="menu" id="menu" hidden>
        <button id="resignBtn">Abandonner la partie</button>
        <a href="./">Accueil de la Crapette</a>
        <a href="../">Tous les jeux</a>
      </div>
    </div>
  </header>

  <main id="table" class="table">
    <section class="zone opp" id="zoneOpp"></section>
    <section class="board" id="board"></section>
    <section class="zone me" id="zoneMe"></section>
  </main>

  <div id="toasts" class="toasts" aria-live="polite"></div>

  <aside id="chat" class="chat" hidden>
    <div class="chat-head"><strong>Discussion</strong><button class="icon-btn sm" id="chatClose" aria-label="Fermer">✕</button></div>
    <div class="chat-log" id="chatLog"></div>
    <form class="chat-form" id="chatForm">
      <input id="chatInput" maxlength="200" placeholder="Votre message…" autocomplete="off">
      <button class="btn btn-gold" type="submit">Envoyer</button>
    </form>
  </aside>
</div>

<!-- ============ FENÊTRES ============ -->
<div class="modal" id="joinModal" hidden>
  <form class="modal-box" id="joinForm">
    <h2>Rejoindre la partie</h2>
    <p class="muted" id="joinInfo"></p>
    <label for="joinName">Votre pseudo</label>
    <input id="joinName" maxlength="20" autocomplete="nickname" required>
    <button class="btn btn-gold btn-lg" type="submit">S'asseoir à la table</button>
    <button class="link-btn" type="button" id="watchBtn">Regarder seulement</button>
  </form>
</div>

<div class="modal" id="waitModal" hidden>
  <div class="modal-box center">
    <div class="spinner-cards" aria-hidden="true"><span></span><span></span><span></span></div>
    <h2>En attente d'un adversaire</h2>
    <p class="muted">Envoyez ce lien à la personne avec qui vous voulez jouer :</p>
    <div class="share-box">
      <input id="shareLink" readonly>
      <button class="btn btn-gold" id="copyLink">Copier</button>
    </div>
    <p class="muted small">Code de la partie : <strong class="code" id="shareCode"></strong></p>
  </div>
</div>

<div class="modal" id="endModal" hidden>
  <div class="modal-box center">
    <div class="trophy" id="endIcon"></div>
    <h2 id="endTitle"></h2>
    <p class="muted" id="endText"></p>
    <button class="btn btn-gold btn-lg" id="rematchBtn">Revanche !</button>
    <button class="link-btn" type="button" id="endClose">Voir la table</button>
  </div>
</div>

<div class="modal" id="rulesModal" hidden>
  <div class="modal-box rules">
    <button class="icon-btn sm close" data-close aria-label="Fermer">✕</button>
    <h2>Règles de la Crapette</h2>
    <p>On joue avec <strong>un jeu de tarot complet (78 cartes)</strong> : 4 enseignes de 14 cartes (As, 2 à 10, Valet, Cavalier, Dame, Roi), 21 atouts et l'Excuse. Chaque joueur reçoit un talon de 35 cartes. Le premier qui se débarrasse de <strong>toutes ses cartes</strong> (talon, défausse et carte retournée) gagne.</p>
    <h3>La table</h3>
    <ul>
      <li><strong>Talon</strong> : vos cartes, face cachée. On en retourne une à la fois.</li>
      <li><strong>Défausse</strong> : la carte retournée que vous ne jouez pas y termine, et votre tour avec. Quand le talon est vide, la défausse est <strong>mélangée</strong> pour le reformer. Vous pouvez prendre la carte du dessus de votre défausse, ou de celle de votre adversaire, pour la poser sur une maison au centre si elle s'y enchaîne.</li>
      <li><strong>8 maisons</strong> (4 à gauche, 4 à droite) : une carte chacune au départ, <strong>face cachée</strong>. Au début de chaque tour, vous devez d’abord retourner une de ces cartes (tant qu’il en reste) en la touchant. Une maison encore cachée est bloquée : on ne la déplace pas et on ne pose rien dessus. On y descend en alternant les couleurs (8♠ sur 9♥, Cavalier sur Dame). Les atouts se posent entre eux, en descendant (atout 6 sur atout 7). Une maison vide accepte n'importe quelle carte. <strong>Une suite ne se casse pas</strong> : si 4, 3 et 2 sont empilés, on ne peut déplacer que toute la suite d'un bloc, sur une maison dont la carte accepte celle du bas de la suite (ou sur la défausse adverse). Il n'y a pas de fondations : toutes les cartes se posent dans les maisons. <strong>Quand une maison est complète</strong> (du Roi à l'As, ou de l'atout 21 à l'atout 1), elle est retirée du jeu et la maison redevient libre.</li>
      <li><strong>L'Excuse</strong> est un joker : elle se pose sur n'importe quelle carte, et n'importe quelle carte se pose sur elle.</li>
    </ul>
    <h3>Déroulement d'un tour</h3>
    <ul>
      <li>Déplacez autant de cartes que vous voulez d'une maison à l'autre.</li>
      <li>Touchez votre talon pour retourner une carte. Si vous la jouez, vous pouvez en retourner une autre. Sinon, posez-la sur votre défausse : votre tour est fini… sauf si elle continue la suite de votre défausse (un 3 rouge sur votre 4 noir) : dans ce cas, vous continuez à jouer.</li>
      <li><strong>Chargez l'adversaire</strong> : vous pouvez poser une carte sur sa défausse en suivant la même règle que les maisons (une valeur en dessous, couleurs alternées : 2♠ sur 3♥).</li>
    </ul>
    <h3>Les fautes… et « Crapette ! »</h3>
    <ul>
      <li>On ne retourne pas son talon tant qu'un coup est possible (sur une maison ou sur la défausse adverse).</li>
      <li>On ne défausse pas une carte retournée qui pouvait être jouée.</li>
      <li>Si votre adversaire a commis une de ces fautes, criez <strong>« Crapette ! »</strong> au début de votre tour, <strong>avant votre premier coup</strong>. Il reçoit alors 3 cartes de votre talon. Si vous vous trompez, c'est une « fausse crapette ».</li>
    </ul>
    <h3>Commandes</h3>
    <ul>
      <li>Glissez-déposez une carte, ou touchez-la puis touchez sa destination. Le jeu ne vous montre pas où la carte peut aller : à vous de voir !</li>
    </ul>
  </div>
</div>

<script src="<?= $asset('app.js') ?>"></script>
</body>
</html>
