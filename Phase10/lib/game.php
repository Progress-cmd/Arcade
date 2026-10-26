<?php
declare(strict_types=1);

/*
 * Moteur de jeu de Phase 10 — toute la logique et les règles côté serveur.
 * Une partie est un tableau PHP sérialisé en JSON dans data/games/<ID>.json.
 *
 * Paquet de 108 cartes : les nombres 1 à 12 en 4 couleurs, en double (96 cartes),
 * 8 Jokers et 4 cartes Passe.
 *   Carte : ['id' => 'R7b', 'c' => couleur R|B|G|Y, ou W (Joker), ou S (Passe), 'n' => 1…12 (0 sinon)]
 *
 * Chaque joueur doit réaliser les 10 phases dans l'ordre, une par manche au mieux.
 * Un tour : piocher (talon ou défausse) → poser sa phase, puis compléter les combinaisons
 * posées sur la table → défausser une carte. La manche s'arrête dès qu'un joueur n'a plus
 * de cartes : les autres marquent des points de pénalité pour les cartes qui leur restent.
 *
 * Combinaisons posées ($g['groups']) :
 *   set   : cartes de même nombre ('n')          color : cartes de même couleur ('c')
 *   run   : suite de nombres qui se suivent, de 'start' à start + nombre de cartes - 1
 */

const DATA_DIR = __DIR__ . '/../data/games';
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 6;
const HAND_SIZE = 10;
const COLORS = ['R' => 'rouge', 'B' => 'bleu', 'G' => 'vert', 'Y' => 'jaune'];
const OFFLINE_KICK = 60;   // secondes d'absence avant de pouvoir retirer un joueur

/** Les 10 phases : combinaisons demandées [type, nombre minimum de cartes]. */
const PHASES = [
    1 => [['set', 3], ['set', 3]],
    2 => [['set', 3], ['run', 4]],
    3 => [['set', 4], ['run', 4]],
    4 => [['run', 7]],
    5 => [['run', 8]],
    6 => [['run', 9]],
    7 => [['set', 4], ['set', 4]],
    8 => [['color', 7]],
    9 => [['set', 5], ['set', 2]],
    10 => [['set', 5], ['set', 3]],
];

class GameError extends RuntimeException {}

/* ---------- Cartes ---------- */

function card_name(array $c): string
{
    return match ($c['c']) {
        'W' => 'un Joker',
        'S' => 'une carte Passe',
        default => 'le ' . $c['n'] . ' ' . COLORS[$c['c']],
    };
}

function is_wild(array $c): bool { return $c['c'] === 'W'; }

/** Points de pénalité d'une carte restée en main en fin de manche. */
function card_points(array $c): int
{
    return match (true) {
        $c['c'] === 'W' => 25,
        $c['c'] === 'S' => 15,
        $c['n'] >= 10 => 10,
        default => 5,
    };
}

function new_deck(): array
{
    $deck = [];
    foreach (array_keys(COLORS) as $c) {
        for ($n = 1; $n <= 12; $n++) {
            foreach (['a', 'b'] as $k) $deck[] = ['id' => "$c$n$k", 'c' => $c, 'n' => $n];
        }
    }
    for ($i = 1; $i <= 8; $i++) $deck[] = ['id' => "W$i", 'c' => 'W', 'n' => 0];
    for ($i = 1; $i <= 4; $i++) $deck[] = ['id' => "S$i", 'c' => 'S', 'n' => 0];
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

/* ---------- Phases ---------- */

function group_label(string $type, int $n): string
{
    return match ($type) {
        'set' => "groupe de $n",
        'run' => "suite de $n",
        'color' => "$n cartes d'une couleur",
    };
}

/** « 1 groupe de 3 + 1 suite de 4 », « 2 groupes de 4 »… */
function phase_label(int $phase): string
{
    $req = PHASES[$phase];
    if (count($req) === 2 && $req[0] === $req[1]) {
        return '2 ' . str_replace('groupe ', 'groupes ', group_label(...$req[0]));
    }
    return implode(' + ', array_map(fn($r) => ($r[0] === 'color' ? '' : '1 ') . group_label(...$r), $req));
}

/**
 * Construit une combinaison à partir de cartes, ou lève une GameError qui explique pourquoi
 * ce n'est pas possible. Les Jokers remplacent n'importe quelle carte ; une carte Passe
 * ne fait jamais partie d'une combinaison.
 */
function make_group(string $type, int $min, array $cards): array
{
    $what = group_label($type, $min);
    if (count($cards) < $min) throw new GameError("Il faut au moins $min cartes pour un $what.");
    if (array_filter($cards, fn($c) => $c['c'] === 'S')) {
        throw new GameError('Une carte Passe ne peut pas faire partie d\'une combinaison.');
    }
    $naturals = array_values(array_filter($cards, fn($c) => !is_wild($c)));
    $wilds = array_values(array_filter($cards, 'is_wild'));
    if (!$naturals) throw new GameError('Une combinaison doit contenir au moins une carte qui n\'est pas un Joker.');
    usort($naturals, fn($a, $b) => [$a['n'], $a['c']] <=> [$b['n'], $b['c']]);

    switch ($type) {
        case 'set':
            $n = $naturals[0]['n'];
            if (array_filter($naturals, fn($c) => $c['n'] !== $n)) {
                throw new GameError("Un groupe se fait avec des cartes de même nombre (et des Jokers).");
            }
            return ['type' => 'set', 'n' => $n, 'cards' => [...$naturals, ...$wilds]];

        case 'color':
            $c = $naturals[0]['c'];
            if (array_filter($naturals, fn($x) => $x['c'] !== $c)) {
                throw new GameError('Ces cartes doivent toutes être de la même couleur (Jokers compris).');
            }
            return ['type' => 'color', 'c' => $c, 'cards' => [...$naturals, ...$wilds]];

        case 'run':
            $len = count($cards);
            if ($len > 12) throw new GameError('Une suite compte au plus 12 cartes (de 1 à 12).');
            $byN = [];
            foreach ($naturals as $c) {
                if (isset($byN[$c['n']])) throw new GameError('Une suite ne peut pas contenir deux fois le même nombre.');
                $byN[$c['n']] = $c;
            }
            $minN = $naturals[0]['n'];
            $maxN = $naturals[count($naturals) - 1]['n'];
            // Premier nombre possible de la suite : les Jokers en trop vont de préférence à la fin
            $start = min($minN, 13 - $len);
            if ($start < max(1, $maxN - $len + 1)) throw new GameError('Ces cartes ne forment pas une suite.');
            $ordered = [];
            for ($v = $start; $v < $start + $len; $v++) $ordered[] = $byN[$v] ?? array_shift($wilds);
            return ['type' => 'run', 'start' => $start, 'cards' => $ordered];
    }
    throw new GameError('Combinaison inconnue.');
}

/* ---------- Création / donne ---------- */

function new_player(string $name, string $token): array
{
    return ['name' => $name, 'token' => $token, 'hand' => [], 'phase' => 1, 'laid' => false,
            'score' => 0, 'skip' => false, 'out' => false];
}

function new_game(string $id, string $name, string $token): array
{
    return [
        'id' => $id, 'v' => 1, 'created' => time(), 'status' => 'waiting',
        'players' => [new_player($name, $token)],
        'deck' => [], 'discard' => [], 'groups' => [],
        'turn' => 0, 'stage' => 'draw', 'dealer' => null, 'round' => 0,
        'lastHand' => null, 'winners' => [], 'lastMove' => null,
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
        $s = ($from + $k) % $n;
        if (!$g['players'][$s]['out']) return $s;
    }
    return $from;
}

function deal(array &$g): void
{
    $deck = new_deck();
    foreach ($g['players'] as &$pl) {
        $pl['hand'] = $pl['out'] ? [] : array_splice($deck, 0, HAND_SIZE);
        $pl['laid'] = false;
        $pl['skip'] = false;
        unset($pl);
    }
    $g['groups'] = [];
    $g['discard'] = [array_pop($deck)];
    $g['deck'] = $deck;
    $g['winners'] = [];
    $g['status'] = 'playing';
    $g['round']++;
    // Le donneur change à chaque manche ; c'est son voisin qui commence
    $g['dealer'] = $g['dealer'] === null ? active_seats($g)[random_int(0, count(active_seats($g)) - 1)]
                                         : next_active($g, $g['dealer']);
    $g['turn'] = $g['dealer'];
    $g['lastMove'] = null;
    add_event($g, "Manche {$g['round']} : " . $g['players'][$g['dealer']]['name'] . ' distribue.', 'deal');
    // Une carte Passe retournée au départ fait passer son tour au premier joueur
    if ($g['discard'][0]['c'] === 'S') $g['players'][next_active($g, $g['dealer'])]['skip'] = true;
    next_turn($g);
}

/** Passe la main au joueur suivant, en sautant ceux qui doivent passer leur tour. */
function next_turn(array &$g): void
{
    $p = $g['turn'];
    for ($guard = 0; $guard < 2 * MAX_PLAYERS; $guard++) {
        $p = next_active($g, $p);
        if (!$g['players'][$p]['skip']) break;
        $g['players'][$p]['skip'] = false;
        add_event($g, $g['players'][$p]['name'] . ' passe son tour.', 'skip', $p);
    }
    $g['turn'] = $p;
    $g['stage'] = 'draw';
    add_event($g, 'Au tour de ' . $g['players'][$p]['name'] . '.', 'turn', $p);
}

/* ---------- Vérifications ---------- */

function require_turn(array $g, int $p, string $stage): void
{
    if ($p < 0) throw new GameError('Vous êtes spectateur.');
    if ($g['status'] !== 'playing') throw new GameError("La manche n'est pas en cours.");
    if ($g['players'][$p]['out']) throw new GameError('Vous avez quitté la partie.');
    if ($g['turn'] !== $p) throw new GameError("Ce n'est pas votre tour.");
    if ($g['stage'] !== $stage) {
        throw new GameError($stage === 'draw' ? 'Vous avez déjà pioché.' : "Piochez d'abord une carte (talon ou défausse).");
    }
}

/** Retire de la main du joueur la carte demandée et la renvoie. */
function take_from_hand(array &$g, int $p, string $id): array
{
    foreach ($g['players'][$p]['hand'] as $k => $c) {
        if ($c['id'] === $id) {
            array_splice($g['players'][$p]['hand'], $k, 1);
            return $c;
        }
    }
    throw new GameError("Cette carte n'est pas dans votre main.");
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

function act_draw(array &$g, int $p, string $from): void
{
    require_turn($g, $p, 'draw');
    if ($from === 'discard') {
        $top = last($g['discard']);
        if (!$top) throw new GameError('La défausse est vide.');
        if ($top['c'] === 'S') throw new GameError('On ne peut pas prendre une carte Passe dans la défausse.');
        $card = array_pop($g['discard']);
    } elseif ($from === 'deck') {
        if (!$g['deck']) {
            // Talon épuisé : on mélange la défausse, sauf sa carte du dessus
            $top = array_pop($g['discard']);
            $g['deck'] = shuffled($g['discard']);
            $g['discard'] = $top ? [$top] : [];
            add_event($g, 'Le talon est épuisé : la défausse est mélangée.', 'info');
        }
        if (!$g['deck']) throw new GameError('Il ne reste plus de carte à piocher.');
        $card = array_pop($g['deck']);
    } else {
        throw new GameError('Pioche inconnue.');
    }
    $g['players'][$p]['hand'][] = $card;
    $g['stage'] = 'play';
    $g['lastMove'] = ['id' => $card['id'], 'from' => $from, 'to' => "hand:$p", 'p' => $p];
}

/** Poser sa phase : $groups contient, dans l'ordre de la phase, les identifiants de cartes de chaque combinaison. */
function act_lay(array &$g, int $p, array $groups): void
{
    require_turn($g, $p, 'play');
    $pl = $g['players'][$p];
    if ($pl['laid']) throw new GameError('Vous avez déjà posé votre phase.');
    $req = PHASES[$pl['phase']];
    if (count($groups) !== count($req)) throw new GameError('La phase ' . $pl['phase'] . ' demande : ' . phase_label($pl['phase']) . '.');

    $hand = array_column($pl['hand'], null, 'id');
    $seen = [];
    $made = [];
    foreach ($req as $k => [$type, $min]) {
        $cards = [];
        foreach ((array)$groups[$k] as $id) {
            $id = (string)$id;
            if (!isset($hand[$id]) || isset($seen[$id])) throw new GameError("Cette carte n'est pas dans votre main.");
            $seen[$id] = true;
            $cards[] = $hand[$id];
        }
        $made[] = make_group($type, $min, $cards) + ['owner' => $p];
    }
    foreach (array_keys($seen) as $id) take_from_hand($g, $p, $id);
    array_push($g['groups'], ...$made);
    $g['players'][$p]['laid'] = true;
    $g['lastMove'] = ['from' => "hand:$p", 'to' => 'groups', 'p' => $p];
    add_event($g, "{$pl['name']} pose la phase {$pl['phase']} !", 'phase', $p);
    if (!$g['players'][$p]['hand']) end_hand($g, $p);
}

/**
 * Compléter une combinaison posée (la sienne ou celle d'un autre) avec une carte, une fois sa
 * phase posée. Sur une suite, $end (« lo » ou « hi ») indique de quel côté poser un Joker.
 */
function act_hit(array &$g, int $p, string $id, int $k, string $end): void
{
    require_turn($g, $p, 'play');
    if (!$g['players'][$p]['laid']) throw new GameError("Posez d'abord votre phase avant de compléter des combinaisons.");
    if (!isset($g['groups'][$k])) throw new GameError('Combinaison introuvable.');
    $grp = &$g['groups'][$k];
    $card = null;
    foreach ($g['players'][$p]['hand'] as $c) if ($c['id'] === $id) $card = $c;
    if (!$card) throw new GameError("Cette carte n'est pas dans votre main.");
    if ($card['c'] === 'S') throw new GameError('Une carte Passe ne peut pas compléter une combinaison.');
    $nope = 'Coup impossible : ' . card_name($card) . ' ne va pas ici.';

    switch ($grp['type']) {
        case 'set':
            if (!is_wild($card) && $card['n'] !== $grp['n']) throw new GameError($nope);
            $grp['cards'][] = $card;
            break;
        case 'color':
            if (!is_wild($card) && $card['c'] !== $grp['c']) throw new GameError($nope);
            $grp['cards'][] = $card;
            break;
        case 'run':
            $len = count($grp['cards']);
            $canLo = $grp['start'] > 1;
            $canHi = $grp['start'] + $len <= 12;
            if (is_wild($card)) {
                if (!$canLo && !$canHi) throw new GameError('Cette suite est complète, de 1 à 12.');
                $side = ($end === 'lo' && $canLo) || !$canHi ? 'lo' : 'hi';
            } elseif ($canLo && $card['n'] === $grp['start'] - 1) {
                $side = 'lo';
            } elseif ($canHi && $card['n'] === $grp['start'] + $len) {
                $side = 'hi';
            } else {
                throw new GameError($nope);
            }
            if ($side === 'lo') { array_unshift($grp['cards'], $card); $grp['start']--; }
            else $grp['cards'][] = $card;
            break;
    }
    unset($grp);
    take_from_hand($g, $p, $id);
    $g['lastMove'] = ['id' => $id, 'from' => "hand:$p", 'to' => "grp:$k", 'p' => $p];
    if (!$g['players'][$p]['hand']) end_hand($g, $p);
}

/** Défausser une carte, ce qui termine le tour. Une carte Passe fait passer son tour au joueur $target. */
function act_discard(array &$g, int $p, string $id, ?int $target): void
{
    require_turn($g, $p, 'play');
    $card = null;
    foreach ($g['players'][$p]['hand'] as $c) if ($c['id'] === $id) $card = $c;
    if (!$card) throw new GameError("Cette carte n'est pas dans votre main.");

    if ($card['c'] === 'S' && count($g['players'][$p]['hand']) > 1) {
        $others = array_values(array_filter(active_seats($g), fn($s) => $s !== $p));
        if ($target === null && count($others) === 1) $target = $others[0];
        if ($target === null || !in_array($target, $others, true)) throw new GameError('Choisissez qui doit passer son tour.');
        if ($g['players'][$target]['skip']) throw new GameError($g['players'][$target]['name'] . ' doit déjà passer son tour.');
        $g['players'][$target]['skip'] = true;
        add_event($g, $g['players'][$p]['name'] . ' fait passer son tour à ' . $g['players'][$target]['name'] . '.', 'skipped', $target);
    }

    take_from_hand($g, $p, $id);
    $g['discard'][] = $card;
    $g['lastMove'] = ['id' => $id, 'from' => "hand:$p", 'to' => 'discard', 'p' => $p];
    if (!$g['players'][$p]['hand']) end_hand($g, $p);
    else next_turn($g);
}

/** Fin de manche : décompte des points, passage à la phase suivante, et peut-être fin de partie. */
function end_hand(array &$g, int $out): void
{
    $results = [];
    $champions = [];
    foreach ($g['players'] as $s => &$pl) {
        if ($pl['out']) continue;
        $points = array_sum(array_map('card_points', $pl['hand']));
        $pl['score'] += $points;
        $results[] = ['p' => $s, 'phase' => $pl['phase'], 'done' => $pl['laid'], 'points' => $points, 'cards' => count($pl['hand'])];
        if ($pl['laid']) {
            if ($pl['phase'] === 10) $champions[] = $s;
            else $pl['phase']++;
        }
        unset($pl);
    }
    $g['lastHand'] = ['round' => $g['round'], 'out' => $out, 'results' => $results];
    $g['stage'] = 'draw';
    add_event($g, $g['players'][$out]['name'] . ' n\'a plus de cartes : fin de la manche.', 'hand', $out);

    if ($champions) {
        // Parmi ceux qui ont réussi la phase 10, le plus petit score l'emporte
        $best = min(array_map(fn($s) => $g['players'][$s]['score'], $champions));
        finish($g, array_values(array_filter($champions, fn($s) => $g['players'][$s]['score'] === $best)));
    } else {
        $g['status'] = 'scoring';
    }
}

function finish(array &$g, array $winners): void
{
    $g['status'] = 'finished';
    $g['winners'] = $winners;
    $names = implode(' et ', array_map(fn($s) => $g['players'][$s]['name'], $winners));
    add_event($g, count($winners) > 1 ? "$names gagnent la partie, ex æquo !" : "$names gagne la partie !", 'win', $winners[0]);
}

function act_next(array &$g, int $p): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($g['status'] !== 'scoring') throw new GameError('La manche est déjà lancée.');
    deal($g);
}

function act_rematch(array &$g, int $p): void
{
    if ($p < 0 || $g['players'][$p]['out']) throw new GameError('Vous ne participez pas à cette partie.');
    if ($g['status'] !== 'finished') throw new GameError("La partie n'est pas terminée.");
    if (count(active_seats($g)) < 2) throw new GameError('Il faut au moins 2 joueurs pour rejouer.');
    foreach ($g['players'] as &$pl) { $pl['phase'] = 1; $pl['score'] = 0; unset($pl); }
    $g['lastHand'] = null;
    add_event($g, $g['players'][$p]['name'] . ' relance une partie !', 'info', $p);
    deal($g);
}

/** Un joueur quitte la partie (ou en est retiré) : on continue sans lui. */
function remove_player(array &$g, int $s, string $why): void
{
    if ($g['status'] === 'waiting') {
        array_splice($g['players'], $s, 1);
        add_event($g, $why, 'info');
        return;
    }
    $pl = &$g['players'][$s];
    $pl['out'] = true;
    $pl['hand'] = [];
    $pl['skip'] = false;
    unset($pl);
    add_event($g, $why, 'info');
    $left = active_seats($g);
    if (count($left) < 2) {
        if ($g['status'] !== 'finished') finish($g, $left);
    } elseif ($g['status'] === 'playing' && $g['turn'] === $s) {
        next_turn($g);
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
        $players[] = [
            'name' => $pl['name'], 'cards' => count($pl['hand']), 'phase' => $pl['phase'],
            'laid' => $pl['laid'], 'score' => $pl['score'], 'skip' => $pl['skip'], 'out' => $pl['out'],
        ];
    }
    // Une carte piochée dans le talon par un autre joueur reste secrète
    $lm = $g['lastMove'];
    if ($lm && ($lm['from'] ?? '') === 'deck' && $lm['p'] !== $seat) unset($lm['id']);
    $phases = [];
    foreach (PHASES as $n => $req) $phases[] = ['n' => $n, 'label' => phase_label($n), 'req' => $req];
    return [
        'id' => $g['id'], 'v' => $g['v'], 'seat' => $seat, 'status' => $g['status'],
        'players' => $players, 'hand' => $seat >= 0 ? $g['players'][$seat]['hand'] : [],
        'turn' => $g['turn'], 'stage' => $g['stage'], 'dealer' => $g['dealer'], 'round' => $g['round'],
        'deck' => count($g['deck']), 'discard' => ['n' => count($g['discard']), 'top' => last($g['discard'])],
        'groups' => $g['groups'], 'lastHand' => $g['lastHand'], 'winners' => $g['winners'],
        'phases' => $phases, 'lastMove' => $lm, 'events' => $g['events'], 'chat' => $g['chat'],
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
