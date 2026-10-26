<?php
declare(strict_types=1);

/*
 * Liste des jeux. Pour en ajouter un, ajoutez une entrée :
 *  - dir     : dossier du jeu (lien vers dir/)
 *  - name    : nom affiché
 *  - pitch   : une phrase de présentation
 *  - players : nombre de joueurs (ex. « 2 joueurs »)
 *  - time    : durée indicative d'une partie
 *  - kind    : catégorie (Cartes, Plateau, Lettres…)
 *  - theme   : couleurs de la vignette [clair, foncé]
 *  - cover   : HTML de l'illustration (facultatif, sinon la première lettre du nom)
 */
$games = [
    [
        'dir'     => 'Crapette',
        'name'    => 'Crapette',
        'pitch'   => 'Le grand classique des jeux de patience, à deux et en ligne. Avec un jeu de tarot et, surtout, le droit de crier « Crapette ! ».',
        'players' => '2 joueurs',
        'time'    => '20–40 min',
        'kind'    => 'Cartes',
        'theme'   => ['#1f7d4e', '#072a1b'],
        'cover'   => '<span class="pc red">A<i>♥</i></span><span class="pc">R<i>♠</i></span><span class="pc red">D<i>♦</i></span>',
    ],
];

// Le jeu n'apparaît que si son dossier existe.
$games = array_values(array_filter($games, fn($g) => is_dir(__DIR__ . '/' . $g['dir'])));
$e = fn(string $s) => htmlspecialchars($s, ENT_QUOTES);
$asset = fn(string $f) => "assets/$f?v=" . filemtime(__DIR__ . "/assets/$f");
?><!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14111c">
<title>La Salle de Jeux — jeux en ligne entre amis</title>
<meta name="description" content="Des jeux de société à jouer en ligne avec vos proches : créez une partie, envoyez le lien, c'est parti.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='10' y='10' width='80' height='80' rx='18' fill='%23fbf7ec' stroke='%23b48a35' stroke-width='5'/><circle cx='32' cy='32' r='8' fill='%231c1b22'/><circle cx='50' cy='50' r='8' fill='%23c1272d'/><circle cx='68' cy='68' r='8' fill='%231c1b22'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= $asset('home.css') ?>">
</head>
<body>

<header class="hero">
  <div class="dice" aria-hidden="true">
    <span class="die d1"><i></i><i></i><i></i></span>
    <span class="die d2"><i></i><i></i><i></i><i></i><i></i></span>
  </div>
  <p class="eyebrow">Jeux en ligne entre amis</p>
  <h1 class="title">La Salle <em>de</em> Jeux</h1>
  <p class="lead">Choisissez un jeu, créez une partie et envoyez le lien à qui vous voulez. Pas d'inscription, pas de téléchargement&nbsp;: on s'assoit et on joue.</p>
</header>

<main class="wrap">
  <h2 class="section-title"><span><?= count($games) > 1 ? 'Les jeux' : 'Le jeu' ?></span></h2>

  <ul class="games">
<?php foreach ($games as $g): [$c1, $c2] = $g['theme']; ?>
    <li>
      <a class="game" href="<?= $e(rawurlencode($g['dir'])) ?>/" style="--c1: <?= $e($c1) ?>; --c2: <?= $e($c2) ?>">
        <div class="cover" aria-hidden="true">
          <?= $g['cover'] ?? '<span class="letter">' . $e(mb_substr($g['name'], 0, 1)) . '</span>' ?>
        </div>
        <div class="body">
          <span class="kind"><?= $e($g['kind']) ?></span>
          <h3><?= $e($g['name']) ?></h3>
          <p><?= $e($g['pitch']) ?></p>
          <ul class="meta">
            <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2a5 5 0 0 1 5 4.8"/></svg><?= $e($g['players']) ?></li>
            <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg><?= $e($g['time']) ?></li>
          </ul>
          <span class="play">Jouer <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
        </div>
      </a>
    </li>
<?php endforeach; ?>
    <li class="soon" aria-label="D'autres jeux arrivent bientôt">
      <div class="soon-inner">
        <span class="soon-icon" aria-hidden="true">+</span>
        <strong>D'autres jeux arrivent</strong>
        <span>La table est mise, les prochains invités ne vont pas tarder.</span>
      </div>
    </li>
  </ul>

  <section class="how">
    <h2 class="section-title"><span>Comment ça marche</span></h2>
    <ol class="steps">
      <li><b>1</b><strong>Choisissez un jeu</strong><span>et créez une partie avec votre pseudo.</span></li>
      <li><b>2</b><strong>Envoyez le lien</strong><span>ou le code de la partie à la personne avec qui vous jouez.</span></li>
      <li><b>3</b><strong>Jouez&nbsp;!</strong><span>Sur ordinateur, tablette ou téléphone, où que vous soyez.</span></li>
    </ol>
  </section>
</main>

<footer class="foot">
  <p>La Salle de Jeux · <?= date('Y') ?></p>
</footer>

</body>
</html>
