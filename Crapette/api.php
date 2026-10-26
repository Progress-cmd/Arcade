<?php
declare(strict_types=1);

require __DIR__ . '/lib/game.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(array $data): never
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function clean_name(mixed $name): string
{
    $name = trim(preg_replace('/\s+/u', ' ', (string)$name) ?? '');
    $name = mb_substr($name, 0, 20);
    if ($name === '') throw new GameError('Choisissez un pseudo.');
    return $name;
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') throw new GameError('Méthode non autorisée.');
    $in = json_decode(file_get_contents('php://input') ?: '', true);
    if (!is_array($in)) throw new GameError('Requête invalide.');

    ensure_data_dir();
    $action = (string)($in['action'] ?? '');
    $id = strtoupper((string)($in['game'] ?? ''));
    $token = (string)($in['token'] ?? '');

    switch ($action) {
        case 'create':
            $name = clean_name($in['name'] ?? '');
            if (random_int(1, 20) === 1) cleanup_old_games();
            $id = new_game_id();
            $token = bin2hex(random_bytes(16));
            $g = new_game($id, $name, $token);
            add_event($g, "$name a créé la partie.", 'info', 0);
            game_save_new($g);
            touch_presence($id, 0);
            reply(['game' => $id, 'token' => $token, 'seat' => 0]);

        case 'join':
            $g = game_read($id);
            $seat = seat_of($g, $token);
            if ($seat < 0 && $g['players'][1] === null) {
                $name = clean_name($in['name'] ?? '');
                $token = bin2hex(random_bytes(16));
                $g = game_update($id, function (array &$g) use ($name, $token) {
                    if ($g['players'][1] !== null) throw new GameError('La partie vient d\'être complétée.');
                    $g['players'][1] = new_player($name, $token);
                    add_event($g, "$name a rejoint la partie.", 'info', 1);
                    deal($g);
                });
                $seat = 1;
            }
            touch_presence($id, $seat);
            reply(['game' => $id, 'token' => $seat >= 0 ? $token : '', 'seat' => $seat, 'state' => public_view($g, $seat)]);

        case 'state':
            $g = game_read($id);
            $seat = seat_of($g, $token);
            touch_presence($id, $seat);
            if ((int)($in['v'] ?? 0) === $g['v']) {
                reply(['same' => true, 'v' => $g['v'], 'online' => presence($id)]);
            }
            reply(['state' => public_view($g, $seat)]);

        case 'move':
        case 'draw':
        case 'flip':
        case 'pass':
        case 'crapette':
        case 'resign':
        case 'rematch':
        case 'chat':
            $seat = -1;
            $g = game_update($id, function (array &$g) use ($action, $token, $in, &$seat) {
                $seat = seat_of($g, $token);
                if ($seat < 0) throw new GameError('Vous ne participez pas à cette partie.');
                match ($action) {
                    'move' => act_move($g, $seat, (string)($in['from'] ?? ''), (string)($in['to'] ?? '')),
                    'draw' => act_draw($g, $seat),
                    'flip' => act_flip($g, $seat, (string)($in['loc'] ?? '')),
                    'pass' => act_pass($g, $seat),
                    'crapette' => act_crapette($g, $seat),
                    'resign' => act_resign($g, $seat),
                    'rematch' => act_rematch($g, $seat),
                    'chat' => act_chat($g, $seat, (string)($in['text'] ?? '')),
                };
            });
            touch_presence($id, $seat);
            reply(['state' => public_view($g, $seat)]);

        default:
            throw new GameError('Action inconnue.');
    }
} catch (GameError $e) {
    reply(['error' => $e->getMessage()]);
} catch (Throwable $e) {
    http_response_code(500);
    error_log('[crapette] ' . $e);
    reply(['error' => 'Erreur interne du serveur.']);
}
