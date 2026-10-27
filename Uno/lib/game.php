<?php
declare(strict_types=1);

/*
 * Moteur de jeu de Uno — toute la logique et les règles côté serveur.
 * Une partie est un tableau PHP sérialisé en JSON dans data/games/<ID>.json.
 *
 * Paquet de 104 cartes :
 *  - 4 couleurs (rouge, bleu, vert, jaune), les nombres 1 à 9 deux fois chacun (72 cartes) ;
 *  - dans chaque couleur, deux Passe, deux Inversion et deux +2 (24 cartes) ;
 *  - 4 Jokers et 4 Jokers +4, sans couleur (8 cartes).
 *   Carte : ['id' => 'r5-2', 'c' => 'r', 'n' => 5], ['id' => 'bp2-1', 'c' => 'b', 'n' => 0, 'k' => 'p2']
 *           ou ['id' => 'w4-3', 'c' => 'w', 'n' => 0, 'k' => 'w4']
 *
 * Chacun reçoit 7 cartes ; une carte numérotée est retournée pour commencer la défausse.
 * Un tour : poser une carte de la couleur demandée, ou de même nombre ou même symbole que celle de
 * la défausse, ou un Joker (on choisit alors la couleur) ; sinon piocher.
 *   Passe : le joueur suivant passe son tour. Inversion : le sens du jeu change (à deux, rejouer).
 *   +2 : le suivant doit poser un autre +2 (la pénalité s'ajoute et passe au joueur d'après), sinon il
 *   pioche toutes les cartes accumulées et passe son tour. Joker +4 : il pioche 4 cartes et passe son tour.
 * On peut ensuite poser la carte piochée (si elle convient) ou la garder, ce qui termine le tour.
 * On ne peut pas terminer sur une carte noire (Joker ou Joker +4) : il faut alors piocher.
 * Le premier qui pose sa dernière carte gagne la manche et marque la valeur des cartes restées
 * dans les mains adverses (nombre : sa valeur ; Passe, Inversion, +2 : 10 ; Jokers : 20).
 *
 * Annonce « Uno ! » : qui n'a plus qu'une carte doit l'annoncer (dès son tour, avec encore deux
 * cartes en main, ou juste après avoir posé l'avant-dernière). Un adversaire qui l'attrape sans
 * annonce, passé un court délai, lui fait piocher 2 cartes de pénalité.
 */

const DATA_DIR = __DIR__ . '/../data/games';
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 6;
const HAND_SIZE = 7;
const COLORS = ['r' => 'rouge', 'b' => 'bleu', 'v' => 'vert', 'j' => 'jaune'];
const SPECIALS = ['skip' => 'Passe', 'rev' => 'Inversion', 'p2' => '+2'];
const WILDS = ['w' => 'Joker', 'w4' => 'Joker +4'];
const OFFLINE_KICK = 60;   // secondes d'absence avant de pouvoir retirer un joueur
const CALL_GRACE = 3;      // secondes laissées pour annoncer « Uno ! » avant de pouvoir être attrapé
const PENALTY = 2;         // cartes piochées par qui est attrapé sans annonce

class GameError extends RuntimeException {}

/* ---------- Cartes ---------- */

function card_name(array $c): string
{
    $k = $c['k'] ?? null;
    if ($k === null) return 'le ' . $c['n'] . ' ' . COLORS[$c['c']];
    if (isset(WILDS[$k])) return 'un ' . WILDS[$k];
    if ($k === 'p2') return 'un +2 ' . COLORS[$c['c']];
    // Passe et Inversion sont féminins : bleue, verte
    return 'une ' . SPECIALS[$k] . ' ' . COLORS[$c['c']] . (in_array($c['c'], ['b', 'v'], true) ? 'e' : '');
}

function new_deck(): array
{
    $deck = [];
    foreach (array_keys(COLORS) as $c) {
        for ($n = 1; $n <= 9; $n++) {
            for ($k = 1; $k <= 2; $k++) $deck[] = ['id' => "$c$n-$k", 'c' => $c, 'n' => $n];
        }
        foreach (array_keys(SPECIALS) as $s) {
            for ($k = 1; $k <= 2; $k++) $deck[] = ['id' => "$c$s-$k", 'c' => $c, 'n' => 0, 'k' => $s];
        }
    }
    foreach (array_keys(WILDS) as $w) {
        for ($k = 1; $k <= 4; $k++) $deck[] = ['id' => "$w-$k", 'c' => 'w', 'n' => 0, 'k' => $w];
    }
    return shuffled($deck);
}

/** Mélange de Fisher-Yates avec un générateur cryptographique. */
function shuffled(array $cards): array
{
    for ($i = count($cards) - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        [$cards[$i], $cards[$j]] = [$cards[$j], $cards[$i]];
    }
    return $cards;
}

function last(array $a): ?array { return $a ? $a[count($a) - 1] : null; }

/**
 * Une carte se pose sur la défausse si elle est de la couleur demandée ($color : celle du dessus,
 * ou celle choisie avec un Joker), du même nombre, du même symbole, ou si c'est un Joker.
 */
function fits(array $card, array $top, string $color): bool
{
    if ($card['c'] === 'w' || $card['c'] === $color) return true;
    if ($top['c'] === 'w') return false;
    return isset($card['k']) ? ($card['k'] === ($top['k'] ?? null)) : (!isset($top['k']) && $card['n'] === $top['n']);
}

function card_value(array $c): int
{
    return match (true) { !isset($c['k']) => $c['n'], $c['c'] === 'w' => 20, default => 10 };
}

function hand_value(array $hand): int
{
    return array_sum(array_map('card_value', $hand));
}

/* ---------- Création / donne ---------- */

function new_player(string $name, string $token): array
{
    return ['name' => $name, 'token' => $token, 'hand' => [], 'score' => 0, 'wins' => 0, 'out' => false, 'called' => false, 'oneAt' => 0];
}

function new_game(string $id, string $name, string $token): array
{
    return [
        'id' => $id, 'v' => 1, 'created' => time(), 'status' => 'waiting',
        'players' => [new_player($name, $token)],
        'deck' => [], 'discard' => [], 'color' => null, 'dir' => 1, 'pending' => 0,
        'turn' => 0, 'starter' => null, 'round' => 0, 'drawn' => null, 'passes' => 0,
        'lastResult' => null, 'winners' => [], 'lastMove' => null,
        'events' => [], 'eventSeq' => 0, 'chat' => [], 'chatSeq' => 0,
    ];
}

function add_event(array &$g, string $text, string $kind = 'info', ?int $seat = null): void
{
    $g['events'][] = ['id' => ++$g['eventSeq'], 'text' => $text, 'kind' => $kind, 'seat' => $seat];
    $g['events'] = array_slice($g['events'], -30);
}

/** Sièges des joueurs encore en jeu (ceux qui n'ont pas quitté la partie). */
function active_seats(array $g): array
{
    return array_keys(array_filter($g['players'], fn($pl) => !$pl['out']));
}

/** Joueur suivant (dans le sens du jeu) parmi ceux encore en jeu. */
function next_active(array $g, int $from): int
{
    $n = count($g['players']);
    for ($k = 1; $k <= $n; $k++) {
        $s = (($from + $k * $g['dir']) % $n + $n) % $n;
        if (!$g['players'][$s]['out']) return $s;
    }
    return $from;
}

function deal(array &$g): void
{
    $deck = new_deck();
    foreach ($g['players'] as &$pl) {
        $pl['hand'] = $pl['out'] ? [] : array_splice($deck, 0, HAND_SIZE);
        $pl['called'] = false;
        unset($pl);
    }
    // La première carte retournée est un nombre : les cartes spéciales repartent dans la pioche
    while (isset(last($deck)['k'])) array_unshift($deck, array_pop($deck));
    $g['discard'] = [array_pop($deck)];
    $g['color'] = $g['discard'][0]['c'];
    $g['deck'] = $deck;
    $g['dir'] = 1;
    $g['pending'] = 0;
    $g['drawn'] = null;
    $g['passes'] = 0;
    $g['winners'] = [];
    $g['status'] = 'playing';
    $g['round']++;
    // Celui qui commence change à chaque manche
    $seats = active_seats($g);
    $g['starter'] = $g['starter'] === null ? $seats[random_int(0, count($seats) - 1)] : next_active($g, $g['starter']);
    $g['lastMove'] = null;
    add_event($g, "Manche {$g['round']} : " . HAND_SIZE . ' cartes chacun.', 'deal');
    start_turn($g, $g['starter']);
}

/** Pioche une carte ; si la pioche est vide, on y remélange la défausse (sauf la carte du dessus). */
function draw_card(array &$g): ?array
{
    if (!$g['deck'] && count($g['discard']) > 1) {
        $top = array_pop($g['discard']);
        $g['deck'] = shuffled($g['discard']);
        $g['discard'] = [$top];
        add_event($g, 'La pioche est épuisée : la défausse est mélangée.', 'info');
    }
    return array_pop($g['deck']);
}

function can_draw(array $g): bool
{
    return $g['deck'] || count($g['discard']) > 1;
}

function start_turn(array &$g, int $p): void
{
    $g['turn'] = $p;
    $g['drawn'] = null;
    // Une annonce ne vaut que tant qu'on reste à une carte
    foreach ($g['players'] as &$pl) {
        if (count($pl['hand']) > 1) $pl['called'] = false;
        unset($pl);
    }
    add_event($g, 'Au tour de ' . $g['players'][$p]['name'] . '.', 'turn', $p);
}

/* ---------- Vérifications ---------- */

function require_turn(array $g, int $p): void
{
    if ($p < 0) throw new GameError('Vous êtes spectateur.');
    if ($g['status'] !== 'playing') throw new GameError("La manche n'est pas en cours.");
    if ($g['players'][$p]['out']) throw new GameError('Vous avez quitté la partie.');
    if ($g['turn'] !== $p) throw new GameError("Ce n'est pas votre tour.");
}

/* ---------- Actions ---------- */

function act_start(array &$g, int $p): void
{
    if ($p !== 0) throw new GameError("Seul l'hôte peut lancer la partie.");
    if ($g['status'] !== 'waiting') throw new GameError('La partie a déjà commencé.');
    if (count($g['players']) < 2) throw new GameError('Il faut au moins 2 joueurs.');
    add_event($g, 'La partie commence avec ' . count($g['players']) . ' joueurs !', 'info');
    deal($g);
}

/**
 * Poser la carte $id de sa main sur la défausse (après une pioche, seule la carte piochée peut l'être).
 * Pour un Joker, $color est la couleur choisie.
 */
function act_play(array &$g, int $p, string $id, string $color = ''): void
{
    require_turn($g, $p);
    if ($g['drawn'] !== null && $id !== $g['drawn']) {
        throw new GameError('Après avoir pioché, vous ne pouvez poser que la carte piochée.');
    }
    $pl = &$g['players'][$p];
    $k = array_search($id, array_column($pl['hand'], 'id'), true);
    if ($k === false) throw new GameError("Cette carte n'est pas dans votre main.");
    $card = $pl['hand'][$k];
    $top = last($g['discard']);
    if ($g['pending'] && ($card['k'] ?? null) !== 'p2') {
        throw new GameError("Posez un +2 pour renvoyer la pénalité, ou piochez {$g['pending']} cartes.");
    }
    if (!fits($card, $top, $g['color'])) {
        throw new GameError('Coup impossible : ' . card_name($card) . ' ne va pas sur ' . card_name($top)
            . ($top['c'] === 'w' ? ' (couleur demandée : ' . COLORS[$g['color']] . ')' : '') . '.');
    }
    // Une carte noire (Joker, Joker +4) ne peut pas être la dernière carte posée
    if ($card['c'] === 'w' && count($pl['hand']) === 1) {
        throw new GameError('On ne peut pas terminer sur une carte noire : piochez.');
    }
    if ($card['c'] === 'w' && !isset(COLORS[$color])) throw new GameError('Choisissez une couleur pour votre Joker.');
    array_splice($pl['hand'], $k, 1);
    $g['discard'][] = $card;
    $g['color'] = $card['c'] === 'w' ? $color : $card['c'];
    $g['passes'] = 0;
    $g['lastMove'] = ['id' => $card['id'], 'kind' => 'play', 'p' => $p];

    $left = count($pl['hand']);
    $name = $pl['name'];
    unset($pl);
    if ($left === 0) { win($g, $p); return; }
    if ($left === 1) $g['players'][$p]['oneAt'] = time();
    if ($card['c'] === 'w') add_event($g, "$name choisit le " . COLORS[$color] . '.', 'color', $p);

    // Effet de la carte
    $next = next_active($g, $p);
    switch ($card['k'] ?? null) {
        case 'skip':
            add_event($g, $g['players'][$next]['name'] . ' passe son tour.', 'effect', $next);
            start_turn($g, next_active($g, $next));
            return;
        case 'rev':
            $g['dir'] = -$g['dir'];
            // À deux, l'Inversion fait rejouer
            $two = count(active_seats($g)) === 2;
            add_event($g, 'Le sens du jeu change' . ($two ? ' : ' . $name . ' rejoue.' : '.'), 'effect', $p);
            start_turn($g, $two ? $p : next_active($g, $p));
            return;
        case 'p2':
            // Les +2 se cumulent : le suivant renvoie avec un +2, ou pioche le tout
            $g['pending'] += 2;
            add_event($g, $g['players'][$next]['name'] . " doit poser un +2 ou piocher {$g['pending']} cartes.", 'stack', $next);
            start_turn($g, $next);
            return;
        case 'w4':
            $got = give_cards($g, $next, 4);
            add_event($g, $g['players'][$next]['name'] . " pioche $got carte" . ($got > 1 ? 's' : '') . ' et passe son tour.', 'effect', $next);
            start_turn($g, next_active($g, $next));
            return;
    }
    start_turn($g, $next);
}

/** Fait piocher $n cartes au joueur $s (moins s'il n'y a plus rien à piocher) ; renvoie le nombre piochées. */
function give_cards(array &$g, int $s, int $n): int
{
    $got = 0;
    while ($got < $n && ($c = draw_card($g))) { $g['players'][$s]['hand'][] = $c; $got++; }
    return $got;
}

/** Piocher une carte : on pourra ensuite la poser (si elle convient) ou la garder. */
function act_draw(array &$g, int $p): void
{
    require_turn($g, $p);
    if ($g['drawn'] !== null) throw new GameError('Vous avez déjà pioché : posez la carte ou passez.');
    if ($g['pending']) {
        // On encaisse les +2 accumulés et le tour passe
        $got = give_cards($g, $p, $g['pending']);
        $g['pending'] = 0;
        $g['passes'] = 0;
        $g['lastMove'] = ['kind' => 'draw', 'p' => $p];
        add_event($g, $g['players'][$p]['name'] . " pioche $got carte" . ($got > 1 ? 's' : '') . ' et passe son tour.', 'effect', $p);
        start_turn($g, next_active($g, $p));
        return;
    }
    $card = draw_card($g);
    if (!$card) throw new GameError('Il ne reste rien à piocher : passez votre tour.');
    $g['players'][$p]['hand'][] = $card;
    $g['passes'] = 0;
    $g['lastMove'] = ['kind' => 'draw', 'p' => $p];
    // Le joueur décide lui-même s'il la pose : l'interface ne dit pas si elle convient
    $g['drawn'] = $card['id'];
}

/** Passer : on garde la carte piochée, ou il n'y a plus rien à piocher. */
function act_pass(array &$g, int $p): void
{
    require_turn($g, $p);
    if ($g['pending']) throw new GameError("Posez un +2 ou piochez {$g['pending']} cartes.");
    if ($g['drawn'] !== null) {
        start_turn($g, next_active($g, $p));
        return;
    }
    if (can_draw($g)) throw new GameError('Posez une carte ou piochez.');
    add_event($g, $g['players'][$p]['name'] . ' ne peut pas jouer et passe.', 'info', $p);
    // Table bloquée (pioche vide, personne n'a pu jouer pendant un tour complet) : la main la plus légère gagne
    if (++$g['passes'] >= count(active_seats($g))) {
        $best = null;
        foreach (active_seats($g) as $s) {
            if ($best === null || hand_value($g['players'][$s]['hand']) < hand_value($g['players'][$best]['hand'])) $best = $s;
        }
        add_event($g, 'Plus personne ne peut jouer : la main la plus légère l\'emporte.', 'info');
        win($g, $best, true);
        return;
    }
    start_turn($g, next_active($g, $p));
}

/**
 * Bouton « Uno ! » : annoncer sa dernière carte (avec une carte en main, ou deux pendant son tour),
 * sinon attraper un adversaire resté à une carte sans l'avoir annoncé.
 */
function act_uno(array &$g, int $p): void
{
    if ($p < 0) throw new GameError('Vous êtes spectateur.');
    if ($g['status'] !== 'playing') throw new GameError("La manche n'est pas en cours.");
    $pl = &$g['players'][$p];
    if ($pl['out']) throw new GameError('Vous avez quitté la partie.');
    $n = count($pl['hand']);
    if (!$pl['called'] && ($n === 1 || ($n === 2 && $g['turn'] === $p))) {
        $pl['called'] = true;
        add_event($g, $pl['name'] . ' : « Uno ! »', 'call', $p);
        return;
    }
    unset($pl);
    foreach ($g['players'] as $s => $t) {
        if ($s === $p || $t['out'] || $t['called'] || count($t['hand']) !== 1 || time() - $t['oneAt'] < CALL_GRACE) continue;
        $got = give_cards($g, $s, PENALTY);
        $g['lastMove'] = ['kind' => 'penalty', 'p' => $s];
        add_event($g, $g['players'][$p]['name'] . ' attrape ' . $t['name'] . ", qui n'a pas dit « Uno ! » : "
            . ($got ? "$got carte" . ($got > 1 ? 's' : '') . ' de pénalité.' : 'plus rien à piocher, ouf !'), 'penalty', $s);
        return;
    }
    throw new GameError('Rien à annoncer pour le moment.');
}

/** Le joueur $p gagne la manche : il marque la valeur des cartes restées dans les mains adverses. */
function win(array &$g, int $p, bool $blocked = false): void
{
    $cards = [];
    $points = 0;
    foreach ($g['players'] as $s => $pl) {
        if ($pl['out']) continue;
        $cards[$s] = count($pl['hand']);
        if ($s !== $p) $points += hand_value($pl['hand']);
    }
    $g['players'][$p]['score'] += $points;
    $g['players'][$p]['wins']++;
    $g['drawn'] = null;
    $g['lastResult'] = ['round' => $g['round'], 'winner' => $p, 'points' => $points, 'cards' => $cards, 'blocked' => $blocked];
    finish($g, [$p]);
}

function finish(array &$g, array $winners): void
{
    $g['status'] = 'finished';
    $g['winners'] = $winners;
    if ($winners) add_event($g, $g['players'][$winners[0]]['name'] . ' gagne la manche !', 'win', $winners[0]);
}

function act_rematch(array &$g, int $p): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($g['status'] !== 'finished') throw new GameError("La manche n'est pas terminée.");
    if (count(active_seats($g)) < 2) throw new GameError('Il faut au moins 2 joueurs pour rejouer.');
    add_event($g, $g['players'][$p]['name'] . ' relance une manche !', 'info', $p);
    deal($g);
}

/** Un joueur quitte la partie (ou en est retiré) : on continue sans lui, ses cartes retournent dans la pioche. */
function remove_player(array &$g, int $s, string $why): void
{
    if ($g['status'] === 'waiting') {
        array_splice($g['players'], $s, 1);
        add_event($g, $why, 'info');
        return;
    }
    $pl = &$g['players'][$s];
    $pl['out'] = true;
    if ($pl['hand']) $g['deck'] = shuffled(array_merge($g['deck'], $pl['hand']));
    $pl['hand'] = [];
    unset($pl);
    add_event($g, $why, 'info');
    $left = active_seats($g);
    if (count($left) < 2) {
        if ($g['status'] !== 'finished') {
            $g['lastResult'] = null;
            finish($g, $left);
        }
    } elseif ($g['status'] === 'playing' && $g['turn'] === $s) {
        start_turn($g, next_active($g, $s));
    }
}

function act_leave(array &$g, int $p): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($g['status'] === 'waiting' && $p === 0 && count($g['players']) > 1) {
        throw new GameError("L'hôte ne peut pas quitter une partie qui n'a pas commencé.");
    }
    remove_player($g, $p, $g['players'][$p]['name'] . ' quitte la partie.');
}

/** Retirer un joueur absent depuis un moment, pour ne pas bloquer la table. */
function act_kick(array &$g, int $p, int $target): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($target === $p || !isset($g['players'][$target]) || $g['players'][$target]['out']) throw new GameError('Joueur introuvable.');
    if ($g['status'] === 'waiting') throw new GameError("La partie n'a pas commencé.");
    if (seconds_offline($g, $target) < OFFLINE_KICK) {
        throw new GameError($g['players'][$target]['name'] . " est toujours là : patientez un peu.");
    }
    remove_player($g, $target, $g['players'][$target]['name'] . ' est absent et a été retiré de la partie.');
}

function act_chat(array &$g, int $p, string $text): void
{
    if ($p < 0) throw new GameError('Les spectateurs ne peuvent pas écrire.');
    $text = trim(preg_replace('/\s+/u', ' ', $text) ?? '');
    if ($text === '') return;
    $g['chat'][] = ['id' => ++$g['chatSeq'], 'p' => $p, 'text' => mb_substr($text, 0, 200)];
    $g['chat'] = array_slice($g['chat'], -60);
}

/* ---------- Vue envoyée au client (sans informations cachées) ---------- */

function public_view(array $g, int $seat): array
{
    $players = [];
    foreach ($g['players'] as $pl) {
        $players[] = ['name' => $pl['name'], 'cards' => count($pl['hand']), 'score' => $pl['score'], 'wins' => $pl['wins'], 'out' => $pl['out'],
                      'called' => $pl['called'] && count($pl['hand']) === 1];
    }
    $n = count($g['discard']);
    return [
        'id' => $g['id'], 'v' => $g['v'], 'seat' => $seat, 'status' => $g['status'],
        'players' => $players, 'hand' => $seat >= 0 ? $g['players'][$seat]['hand'] : [],
        'turn' => $g['turn'], 'round' => $g['round'],
        'deck' => count($g['deck']), 'canDraw' => can_draw($g), 'color' => $g['color'], 'dir' => $g['dir'], 'pending' => $g['pending'],
        // Les deux cartes du dessus de la défausse (celle du dessous sert au décor)
        'top' => $n ? $g['discard'][$n - 1] : null, 'under' => $n > 1 ? $g['discard'][$n - 2] : null, 'discard' => $n,
        // La carte piochée n'est révélée qu'à celui qui l'a piochée
        'drawn' => $seat === $g['turn'] ? $g['drawn'] : null, 'hasDrawn' => $g['drawn'] !== null,
        'lastResult' => $g['lastResult'], 'winners' => $g['winners'],
        'lastMove' => $g['lastMove'], 'events' => $g['events'], 'chat' => $g['chat'],
        'online' => presence($g),
    ];
}

/* ---------- Stockage fichier ---------- */

function valid_id(string $id): bool { return (bool)preg_match('/^[A-Z2-9]{6}$/', $id); }
function game_path(string $id): string { return DATA_DIR . "/$id.json"; }

function ensure_data_dir(): void
{
    if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0775, true) && !is_dir(DATA_DIR)) {
        throw new GameError('Impossible de créer le dossier de données.');
    }
}

function new_game_id(): string
{
    do {
        $id = '';
        for ($i = 0; $i < 6; $i++) $id .= ID_CHARS[random_int(0, strlen(ID_CHARS) - 1)];
    } while (file_exists(game_path($id)));
    return $id;
}

function game_save_new(array $g): void
{
    $fh = fopen(game_path($g['id']), 'x');
    if (!$fh) throw new GameError('Impossible de créer la partie.');
    fwrite($fh, json_encode($g, JSON_UNESCAPED_UNICODE));
    fclose($fh);
}

function game_read(string $id): array
{
    if (!valid_id($id) || !is_file(game_path($id))) throw new GameError('Partie introuvable.');
    $fh = fopen(game_path($id), 'r');
    flock($fh, LOCK_SH);
    $g = json_decode(stream_get_contents($fh), true);
    flock($fh, LOCK_UN);
    fclose($fh);
    if (!is_array($g)) throw new GameError('Partie illisible.');
    return $g;
}

/** Lit, modifie via $fn(&$g) et réécrit la partie sous verrou exclusif. */
function game_update(string $id, callable $fn): array
{
    if (!valid_id($id) || !is_file(game_path($id))) throw new GameError('Partie introuvable.');
    $fh = fopen(game_path($id), 'r+');
    flock($fh, LOCK_EX);
    try {
        $g = json_decode(stream_get_contents($fh), true);
        if (!is_array($g)) throw new GameError('Partie illisible.');
        $fn($g);
        $g['v']++;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($g, JSON_UNESCAPED_UNICODE));
        fflush($fh);
        return $g;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

function seat_of(array $g, string $token): int
{
    if ($token === '') return -1;
    foreach ($g['players'] as $i => $pl) {
        if (hash_equals($pl['token'], $token)) return $i;
    }
    return -1;
}

/* Présence : un fichier par joueur, touché à chaque requête (nommé par jeton, stable si les sièges bougent). */

function presence_file(string $id, string $token): string { return DATA_DIR . "/$id." . substr(hash('sha256', $token), 0, 12) . '.p'; }

function touch_presence(array $g, int $seat): void
{
    if ($seat >= 0) @touch(presence_file($g['id'], $g['players'][$seat]['token']));
}

function seconds_offline(array $g, int $seat): int
{
    $f = presence_file($g['id'], $g['players'][$seat]['token']);
    clearstatcache();
    return is_file($f) ? time() - filemtime($f) : PHP_INT_MAX;
}

function presence(array $g): array
{
    clearstatcache();
    return array_map(function ($pl) use ($g) {
        $f = presence_file($g['id'], $pl['token']);
        return is_file($f) && filemtime($f) > time() - 8;
    }, $g['players']);
}

/** Supprime les parties inactives depuis plus de 3 jours. */
function cleanup_old_games(): void
{
    foreach (glob(DATA_DIR . '/*') ?: [] as $f) {
        if (basename($f) !== '.htaccess' && filemtime($f) < time() - 3 * 86400) @unlink($f);
    }
}
