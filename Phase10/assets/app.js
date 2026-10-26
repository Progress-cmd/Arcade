/* Phase 10 — client : rendu de la table, interactions, synchronisation par polling. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const COLORS = { R: 'rouge', B: 'bleu', G: 'vert', Y: 'jaune' };
  const COLOR_ORDER = { R: 0, B: 1, G: 2, Y: 3, W: 4, S: 5 };
  const isWild = (c) => c.c === 'W';
  const cardName = (c) => (c.c === 'W' ? 'Joker' : c.c === 'S' ? 'Passe' : `${c.n} ${COLORS[c.c]}`);
  const groupLabel = (type, n) => (type === 'set' ? `Groupe de ${n}` : type === 'run' ? `Suite de ${n}` : `${n} d'une couleur`);
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* stockage indisponible */ } },
  };

  const S = {
    game: document.body.dataset.game || '',
    token: '',
    seat: -1,
    st: null,        // dernier état reçu du serveur
    v: 0,
    sel: new Set(),  // cartes sélectionnées dans la main
    stage: [],       // cartes préparées pour la phase : une liste d'identifiants par combinaison
    stageRound: 0,
    sort: store.get('p10.sort') || 'num',
    busy: false,
    lastEvent: null, lastChat: null, unread: 0,
    scoreSeen: -1, autoScore: false,
    pollTimer: null,
    cw: 70,
    sound: store.get('p10.sound') !== 'off',
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ====================================================================
     Réseau
     ==================================================================== */

  async function api(action, data = {}) {
    const res = await fetch('api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, game: S.game, token: S.token, ...data }),
    });
    let j;
    try { j = await res.json(); } catch { throw new Error('Réponse invalide du serveur.'); }
    if (j.error) throw new Error(j.error);
    return j;
  }

  async function poll() {
    clearTimeout(S.pollTimer);
    if (!S.busy) {
      try {
        const j = await api('state', { v: S.v });
        if (j.same) updateOnline(j.online);
        else applyState(j.state);
      } catch (e) { /* coupure réseau passagère : on réessaie */ }
    }
    S.pollTimer = setTimeout(poll, document.hidden ? 4000 : 900);
  }

  async function action(name, data = {}) {
    if (S.busy) return false;
    S.busy = true;
    try {
      const j = await api(name, data);
      applyState(j.state, true);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      sound('error');
      return false;
    } finally {
      S.busy = false;
    }
  }

  /* ====================================================================
     Démarrage
     ==================================================================== */

  function showLobby(error) {
    $('#lobby').hidden = false;
    $('#app').hidden = true;
    $('#nameInput').value = store.get('p10.name') || '';
    if (error) toast(error, 'error');
  }

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#nameInput').value.trim();
    if (!name) return;
    store.set('p10.name', name);
    const btn = e.submitter || $('#createForm button');
    btn.disabled = true;
    try {
      const j = await api('create', { name });
      store.set('p10.t.' + j.game, j.token);
      location.href = '?g=' + j.game;
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  $('#joinCodeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length === 6) location.href = '?g=' + code;
    else toast('Le code fait 6 caractères.', 'error');
  });

  async function enterGame() {
    S.token = store.get('p10.t.' + S.game) || '';
    $('#app').hidden = false;
    layout();
    let j;
    try {
      j = await api('state', { v: 0 });
    } catch (e) {
      showLobby(e.message);
      return;
    }
    const st = j.state;
    applyState(st);
    if (st.seat < 0 && st.status === 'waiting' && st.players.length < 6) {
      // Une place est libre : on propose de s'asseoir
      $('#joinInfo').textContent = `${st.players[0].name} vous invite à une partie de Phase 10.`;
      $('#joinName').value = store.get('p10.name') || '';
      $('#joinModal').hidden = false;
      $('#joinName').focus();
      return;
    }
    poll();
  }

  $('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#joinName').value.trim();
    if (!name) return;
    store.set('p10.name', name);
    try {
      const j = await api('join', { name });
      if (j.seat >= 0) {
        S.token = j.token;
        store.set('p10.t.' + S.game, j.token);
      } else {
        toast('La partie a déjà commencé : vous la regardez en spectateur.', 'info');
      }
      $('#joinModal').hidden = true;
      applyState(j.state);
      poll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#watchBtn').addEventListener('click', () => {
    $('#joinModal').hidden = true;
    poll();
  });

  /* ====================================================================
     Application d'un nouvel état
     ==================================================================== */

  function applyState(st, fromAction = false) {
    if (S.st && st.v < S.v) return;
    if (S.busy && !fromAction) return;
    const prev = S.st;
    S.st = st;
    S.v = st.v;
    S.seat = st.seat;
    syncSelection();

    render();
    handleEvents(st.events, !prev);
    handleChat(st.chat, !prev);
    handleModals(!prev);
    if (prev && st.lastMove && JSON.stringify(st.lastMove) !== JSON.stringify(prev.lastMove)) sound('card');
  }

  /** Sélection et préparation de la phase : on oublie les cartes qui ne sont plus en main. */
  function syncSelection() {
    const v = S.st;
    const reqLen = mePlayer() ? v.phases[mePlayer().phase - 1].req.length : 0;
    if (S.stageRound !== v.round || S.stage.length !== reqLen || !mePlayer() || mePlayer().laid) {
      S.stage = Array.from({ length: reqLen }, () => []);
      S.stageRound = v.round;
    }
    const inHand = new Set(v.hand.map((c) => c.id));
    S.stage = S.stage.map((ids) => ids.filter((id) => inHand.has(id)));
    for (const id of [...S.sel]) if (!inHand.has(id) || staged(id) >= 0) S.sel.delete(id);
  }

  function updateOnline(online) {
    if (!S.st) return;
    S.st.online = online;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('offline', !online[+c.dataset.p]));
  }

  /* ====================================================================
     Règles (miroir de lib/game.php, pour guider le joueur)
     ==================================================================== */

  const mePlayer = () => (S.st && S.seat >= 0 ? S.st.players[S.seat] : null);
  const playing = () => S.st && S.st.status === 'playing' && mePlayer() && !mePlayer().out;
  const myTurn = () => playing() && S.st.turn === S.seat;
  const myPhaseReq = () => S.st.phases[mePlayer().phase - 1].req;
  const cardById = (id) => S.st.hand.find((c) => c.id === id);
  const staged = (id) => S.stage.findIndex((ids) => ids.includes(id));

  /** Message d'erreur si les cartes ne forment pas la combinaison demandée, sinon null. */
  function groupError(type, min, cards) {
    if (cards.length < min) return `Il manque ${min - cards.length} carte${min - cards.length > 1 ? 's' : ''}`;
    if (cards.some((c) => c.c === 'S')) return 'Pas de carte Passe';
    const nat = cards.filter((c) => !isWild(c));
    if (!nat.length) return 'Au moins une vraie carte';
    if (type === 'set' && nat.some((c) => c.n !== nat[0].n)) return 'Même nombre exigé';
    if (type === 'color' && nat.some((c) => c.c !== nat[0].c)) return 'Même couleur exigée';
    if (type === 'run') {
      const ns = nat.map((c) => c.n);
      if (cards.length > 12) return '12 cartes au plus';
      if (new Set(ns).size !== ns.length) return 'Nombre en double';
      if (Math.max(...ns) - Math.min(...ns) >= cards.length) return 'Ce n\'est pas une suite';
    }
    return null;
  }

  const stageReady = () => myPhaseReq().every(([t, n], i) => !groupError(t, n, S.stage[i].map(cardById)));

  function sortedHand() {
    const hand = S.st.hand.filter((c) => staged(c.id) < 0);
    const num = (c) => (c.c === 'W' ? 13 : c.c === 'S' ? 14 : c.n);
    const by = S.sort === 'color'
      ? (a, b) => COLOR_ORDER[a.c] - COLOR_ORDER[b.c] || a.n - b.n
      : (a, b) => num(a) - num(b) || COLOR_ORDER[a.c] - COLOR_ORDER[b.c];
    return hand.sort((a, b) => by(a, b) || (a.id < b.id ? -1 : 1));
  }

  /* ====================================================================
     Rendu
     ==================================================================== */

  const table = $('#table');

  function cardEl(c) {
    const n = el('div', 'card c-' + c.c);
    n.dataset.id = c.id;
    const R = c.c === 'W' ? 'J' : c.c === 'S' ? '⊘' : c.n === 6 || c.n === 9 ? `<u>${c.n}</u>` : String(c.n);
    const mid = c.c === 'W' ? '<b>★</b><small>Joker</small>' : c.c === 'S' ? '<b>⊘</b><small>Passe</small>' : `<b>${R}</b>`;
    n.innerHTML = `<span class="ci tl">${R}</span><span class="pip">${mid}</span><span class="ci br">${R}</span>`;
    n.title = cardName(c);
    return n;
  }

  const backEl = () => el('div', 'card back');
  const AVATAR = ['#3b74c4', '#cf3b4d', '#2a9d55', '#d59a12', '#8b4fd1', '#1aa3a3'];

  function renderPlayers() {
    const v = S.st;
    const box = $('#players');
    box.innerHTML = '';
    v.players.forEach((pl, p) => {
      const chip = el('div', 'chip');
      chip.dataset.loc = 'hand:' + p;
      chip.dataset.p = p;
      chip.classList.toggle('active', v.status === 'playing' && v.turn === p);
      chip.classList.toggle('me', p === S.seat);
      chip.classList.toggle('out', pl.out);
      chip.classList.toggle('offline', !(v.online && v.online[p]));
      const av = el('div', 'avatar', pl.name.charAt(0).toUpperCase());
      av.style.setProperty('--av', AVATAR[p % AVATAR.length]);
      av.append(el('span', 'dot'));
      const body = el('div', 'chip-body');
      const nm = el('div', 'name', pl.name);
      if (p === S.seat) nm.append(el('span', 'you', ' (vous)'));
      body.append(nm);
      const meta = el('div', 'chip-meta');
      if (pl.out) meta.append(el('span', '', 'a quitté la partie'));
      else if (v.status !== 'waiting') {
        // « Phase 4 ✓ », abrégé en « P4 ✓ » sur petit écran
        const ph = el('span', 'ph' + (pl.laid ? ' done' : ''));
        ph.innerHTML = `P<span class="lbl">hase </span>${pl.phase}${pl.laid ? ' ✓' : ''}`;
        meta.append(ph);
        meta.append(el('span', 'nb', `🂠 ${pl.cards}`));
        meta.append(el('span', 'pts', `${pl.score} pts`));
      }
      body.append(meta);
      chip.append(av, body);
      if (pl.skip) chip.append(el('span', 'tag skip', 'Passe'));
      else if (v.status === 'playing' && v.dealer === p) chip.append(el('span', 'tag', 'Donne'));
      chip.title = pl.out ? pl.name : `${pl.name} — phase ${pl.phase} : ${v.phases[pl.phase - 1].label}`;
      box.append(chip);
    });
  }

  function renderCenter() {
    const v = S.st;
    const box = $('#center');
    box.innerHTML = '';
    const canDraw = myTurn() && v.stage === 'draw';

    const deck = el('div', 'slot deck');
    deck.dataset.loc = 'deck';
    deck.dataset.label = 'Talon';
    if (v.deck) deck.append(backEl(), el('span', 'count', String(v.deck))); else deck.classList.add('empty');
    deck.classList.toggle('can-draw', canDraw);
    deck.title = 'Piocher dans le talon';

    const disc = el('div', 'slot discard');
    disc.dataset.loc = 'discard';
    disc.dataset.label = 'Défausse';
    const top = v.discard.top;
    if (top) {
      const c = cardEl(top);
      if (v.discard.n > 1) c.classList.add('deep');
      disc.append(c);
    } else disc.classList.add('empty');
    disc.classList.toggle('can-draw', canDraw && !!top && top.c !== 'S');
    disc.title = myTurn() && v.stage === 'play' ? 'Défausser la carte sélectionnée' : 'Prendre la carte de la défausse';

    const goal = el('div', 'goal');
    const pl = mePlayer();
    if (pl && !pl.out && v.status !== 'waiting') {
      goal.append(el('span', 'goal-n', `Phase ${pl.phase}`));
      goal.append(el('span', 'goal-t', v.phases[pl.phase - 1].label));
      if (pl.laid) goal.append(el('span', 'goal-ok', 'Posée ✓ — complétez les combinaisons'));
      goal.classList.toggle('done', pl.laid);
    } else if (v.status !== 'waiting') {
      goal.append(el('span', 'goal-n', `Manche ${v.round}`), el('span', 'goal-t', 'Vous regardez la partie'));
    }
    box.append(deck, disc, goal);
  }

  function renderGroups() {
    const v = S.st;
    const box = $('#groups');
    box.innerHTML = '';
    if (!v.groups.length) {
      if (v.status === 'playing') box.append(el('div', 'groups-empty', 'Aucune phase posée pour le moment.'));
      return;
    }
    const byOwner = new Map();
    v.groups.forEach((g, k) => {
      if (!byOwner.has(g.owner)) byOwner.set(g.owner, []);
      byOwner.get(g.owner).push([g, k]);
    });
    for (const [owner, list] of byOwner) {
      const block = el('div', 'owner');
      const head = el('div', 'owner-name', v.players[owner].name);
      head.style.setProperty('--av', AVATAR[owner % AVATAR.length]);
      const row = el('div', 'owner-groups');
      for (const [g, k] of list) {
        const n = el('div', 'grp');
        n.dataset.loc = 'grp:' + k;
        const fan = el('div', 'fan');
        g.cards.forEach((c) => fan.append(cardEl(c)));
        n.append(fan, el('span', 'grp-label', g.type === 'run' ? `Suite ${g.start}–${g.start + g.cards.length - 1}`
          : g.type === 'set' ? `Groupe de ${g.n}` : `Couleur ${COLORS[g.c]}`));
        row.append(n);
      }
      block.append(head, row);
      box.append(block);
    }
  }

  function renderMine() {
    const v = S.st;
    const box = $('#mine');
    box.innerHTML = '';
    const pl = mePlayer();
    if (!pl || pl.out || v.status === 'waiting') return;

    // Cases de préparation de la phase
    if (!pl.laid && v.status === 'playing') {
      const stage = el('div', 'stage');
      myPhaseReq().forEach(([t, n], i) => {
        const z = el('div', 'zone');
        z.dataset.loc = 'stage:' + i;
        const cards = S.stage[i].map(cardById);
        const err = groupError(t, n, cards);
        z.classList.toggle('ok', !err);
        const lab = el('div', 'zone-label');
        lab.append(el('b', '', groupLabel(t, n)), el('span', '', cards.length ? (err || 'Prêt ✓') : 'Touchez pour y placer la sélection'));
        const fan = el('div', 'fan');
        cards.forEach((c) => fan.append(cardEl(c)));
        z.append(lab, fan);
        stage.append(z);
      });
      box.append(stage);
    }

    // Boutons
    const bar = el('div', 'actions');
    if (myTurn() && v.stage === 'play') {
      if (!pl.laid) {
        const lay = el('button', 'btn btn-gold btn-small', 'Poser la phase');
        lay.disabled = !stageReady();
        lay.onclick = layPhase;
        bar.append(lay);
      }
      const dis = el('button', 'btn btn-light btn-small', 'Défausser');
      dis.disabled = S.sel.size !== 1;
      dis.title = 'Défausser la carte sélectionnée et finir son tour';
      dis.onclick = () => discardSelected();
      bar.append(dis);
    } else if (myTurn()) {
      bar.append(el('span', 'hint', 'Piochez : touchez le talon ou la défausse'));
    }
    const sort = el('button', 'btn btn-ghost-light btn-small', S.sort === 'num' ? 'Trier par couleur' : 'Trier par nombre');
    sort.onclick = () => { S.sort = S.sort === 'num' ? 'color' : 'num'; store.set('p10.sort', S.sort); render(); };
    bar.append(sort);
    if (S.sel.size > 1) {
      const none = el('button', 'link-btn', 'Désélectionner');
      none.onclick = () => { S.sel.clear(); render(); };
      bar.append(none);
    }
    // Écran peu haut : les boutons vont dans la colonne de gauche, sous l'objectif
    (table.classList.contains('wide') ? $('#center') : box).append(bar);

    // Main
    const hand = el('div', 'hand');
    hand.dataset.loc = 'myhand';
    for (const c of sortedHand()) {
      const n = cardEl(c);
      n.classList.add('in-hand');
      if (S.sel.has(c.id)) n.classList.add('selected');
      hand.append(n);
    }
    box.append(hand);
  }

  /** Cartes en éventail : main du joueur, combinaisons et cases de phase. */
  function placeFans() {
    const hand = table.querySelector('.hand');
    if (hand) {
      const cards = [...hand.children];
      const W = hand.clientWidth, cw = S.cw, n = cards.length;
      const step = n > 1 ? Math.min(cw * 1.06, (W - cw) / (n - 1)) : 0;
      const x0 = Math.max(0, (W - cw - step * (n - 1)) / 2);
      cards.forEach((c, k) => { c.style.left = x0 + k * step + 'px'; c.style.zIndex = k + 1; });
    }
    table.querySelectorAll('.fan').forEach((fan) => {
      const cards = [...fan.children];
      const gw = S.cw * 0.6, step = gw * 0.42;
      fan.style.width = (cards.length ? gw + step * (cards.length - 1) : gw) + 'px';
      cards.forEach((c, k) => { c.style.left = k * step + 'px'; c.style.zIndex = k + 1; });
    });
  }

  function renderTopbar() {
    const v = S.st;
    let text = '', mine = false;
    if (v.status === 'waiting') text = 'En attente des joueurs…';
    else if (v.status === 'scoring') text = `Fin de la manche ${v.round}`;
    else if (v.status === 'finished') text = winnersText(v) + ' !';
    else if (myTurn()) {
      mine = true;
      text = v.stage === 'draw' ? 'Piochez une carte' : mePlayer().laid ? 'Complétez ou défaussez' : 'Posez votre phase ou défaussez';
    } else text = `Tour de ${v.players[v.turn].name}…`;
    const pill = $('#statusPill');
    pill.innerHTML = '';
    pill.append(el('span', mine ? 'mine' : '', text));
  }

  function winnersText(v) {
    const names = v.winners.map((s) => v.players[s].name);
    if (names.length === 1 && v.winners[0] === S.seat) return 'Vous avez gagné';
    return names.join(' et ') + (names.length > 1 ? ' gagnent' : ' gagne');
  }

  function render() {
    if (!S.st) return;
    const snap = snapshot();
    renderTopbar();
    renderPlayers();
    renderCenter();
    renderGroups();
    renderMine();
    placeFans();
    animateFrom(snap);
  }

  /* ---------- Animations FLIP ---------- */

  function snapshot() {
    const m = new Map();
    table.querySelectorAll('.card[data-id]').forEach((n) => m.set(n.dataset.id, n.getBoundingClientRect()));
    return m;
  }

  function animateFrom(snap) {
    const lm = S.st.lastMove;
    table.querySelectorAll('.card[data-id]').forEach((n) => {
      let r0 = snap.get(n.dataset.id);
      if (!r0 && lm) {
        // Carte nouvelle : elle vient du talon, de la défausse ou de la main d'un autre joueur
        const src = lm.from === 'deck' || lm.from === 'discard' ? lm.from : lm.p !== S.seat ? lm.from : null;
        const s = src && table.querySelector(`[data-loc="${src}"]`);
        if (s) r0 = s.getBoundingClientRect();
      }
      if (!r0) return;
      const r1 = n.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      n.animate(
        [{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 500 }, { transform: 'none', zIndex: 500 }],
        { duration: 300, easing: 'cubic-bezier(.2, .8, .25, 1)' },
      );
      if (!snap.has(n.dataset.id)) n.classList.add('flash');
    });
  }

  /* ====================================================================
     Interactions : toucher une carte, puis sa destination
     ==================================================================== */

  function layPhase() {
    if (!stageReady()) return;
    action('lay', { groups: S.stage }).then((ok) => { if (ok) sound('phase'); });
  }

  function discardSelected(target) {
    const id = [...S.sel][0];
    const card = id && cardById(id);
    if (!card) { toast('Sélectionnez la carte à défausser.', 'error', 2000); return; }
    const others = S.st.players.map((pl, p) => [pl, p]).filter(([pl, p]) => p !== S.seat && !pl.out);
    // Une carte Passe : on choisit qui passe son tour (sauf s'il n'y a qu'un adversaire, ou si c'est la dernière carte)
    if (card.c === 'S' && target === undefined && others.length > 1 && S.st.hand.length > 1) {
      const list = $('#skipList');
      list.innerHTML = '';
      for (const [pl, p] of others) {
        const b = el('button', 'btn btn-gold', pl.name);
        if (pl.skip) { b.disabled = true; b.title = 'Passe déjà son prochain tour'; }
        b.onclick = () => { $('#skipModal').hidden = true; discardSelected(p); };
        list.append(b);
      }
      $('#skipModal').hidden = false;
      return;
    }
    S.sel.clear();
    action('discard', { card: id, target: target ?? null });
  }

  function onTap(e) {
    if (!S.st || S.seat < 0) return;
    unlockAudio();
    const v = S.st;
    const cardN = e.target.closest('.card[data-id]');
    const spot = e.target.closest('[data-loc]');
    const loc = spot ? spot.dataset.loc : '';

    // Carte de la main : sélectionner / désélectionner (possible à tout moment, pour préparer sa phase)
    if (cardN && loc === 'myhand') {
      const id = cardN.dataset.id;
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      render();
      return;
    }
    // Carte d'une case de phase : elle revient dans la main
    if (loc.startsWith('stage:')) {
      const i = +loc.slice(6);
      if (cardN && !S.sel.size) {
        S.stage[i] = S.stage[i].filter((id) => id !== cardN.dataset.id);
      } else if (S.sel.size) {
        S.stage = S.stage.map((ids) => ids.filter((id) => !S.sel.has(id)));
        S.stage[i].push(...S.sel);
        S.sel.clear();
      } else {
        toast('Sélectionnez d\'abord des cartes de votre main.', 'info', 2200);
        return;
      }
      render();
      return;
    }
    if (loc === 'deck' || loc === 'discard') {
      if (!myTurn()) { if (playing()) toast("Ce n'est pas votre tour.", 'error', 1800); return; }
      if (v.stage === 'draw') action('draw', { from: loc });
      else if (loc === 'discard') discardSelected();
      return;
    }
    if (loc.startsWith('grp:')) {
      if (!myTurn() || v.stage !== 'play') { if (playing()) toast(myTurn() ? "Piochez d'abord une carte." : "Ce n'est pas votre tour.", 'error', 1800); return; }
      if (!mePlayer().laid) { toast("Posez d'abord votre phase pour compléter les combinaisons.", 'error', 2600); return; }
      if (S.sel.size !== 1) { toast('Sélectionnez une seule carte à ajouter.', 'error', 2200); return; }
      const r = spot.getBoundingClientRect();
      const end = e.clientX < r.left + r.width / 2 ? 'lo' : 'hi';
      const id = [...S.sel][0];
      S.sel.clear();
      action('hit', { card: id, group: +loc.slice(4), end });
      return;
    }
    if (loc.startsWith('hand:')) {
      const p = +loc.slice(5);
      const pl = v.players[p];
      if (p !== S.seat && !pl.out && v.status !== 'waiting' && !(v.online && v.online[p])
          && confirm(`${pl.name} semble absent. Le retirer de la partie pour continuer sans lui ?`)) {
        action('kick', { target: p });
      }
    }
  }
  table.addEventListener('click', onTap);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal[data-dismiss]').forEach((m) => (m.hidden = true));
      $('#menu').hidden = true;
      if (S.sel.size) { S.sel.clear(); render(); }
    }
  });

  /* ====================================================================
     Événements, discussion, fenêtres
     ==================================================================== */

  function handleEvents(evs, initial) {
    const maxId = evs.length ? evs[evs.length - 1].id : 0;
    if (initial || S.lastEvent === null) { S.lastEvent = maxId; return; }
    for (const ev of evs) {
      if (ev.id <= S.lastEvent) continue;
      switch (ev.kind) {
        case 'turn':
          if (ev.seat === S.seat) { toast('À vous de jouer !', 'turn', 2200); sound('turn'); }
          break;
        case 'phase':
          if (ev.seat !== S.seat) { toast(ev.text, 'phase', 3500); sound('phase'); }
          break;
        case 'skipped':
          toast(ev.seat === S.seat ? ev.text.replace(/à [^.]+\.$/, 'à vous !') : ev.text, 'skip', 3500);
          if (ev.seat === S.seat) sound('buzz');
          break;
        case 'skip': if (ev.seat !== S.seat) toast(ev.text, 'skip', 2500); break;
        case 'join': toast(ev.text, 'info', 3000); sound('turn'); break;
        case 'hand': case 'win': break; // géré par la fenêtre des scores
        case 'deal': toast(ev.text, 'info', 3000); break;
        default: toast(ev.text, 'info', 3000);
      }
    }
    S.lastEvent = maxId;
  }

  function handleChat(chat, initial) {
    const maxId = chat.length ? chat[chat.length - 1].id : 0;
    const isNew = (m) => S.lastChat !== null && m.id > S.lastChat;
    const fresh = initial ? [] : chat.filter((m) => isNew(m) && m.p !== S.seat);
    S.lastChat = maxId;
    renderChat();
    if (!fresh.length) return;
    if ($('#chat').hidden) {
      S.unread += fresh.length;
      updateBadge();
      for (const m of fresh) toast(`💬 ${S.st.players[m.p]?.name ?? ''} : ${m.text}`, 'info', 4000);
    }
    sound('msg');
  }

  function renderChat() {
    const log = $('#chatLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = '';
    const chat = S.st ? S.st.chat : [];
    if (!chat.length) log.append(el('div', 'empty', 'Aucun message pour le moment.'));
    for (const m of chat) {
      const d = el('div', 'msg' + (m.p === S.seat ? ' mine' : ''));
      d.append(el('b', '', S.st.players[m.p]?.name ?? ''), document.createTextNode(m.text));
      log.append(d);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function updateBadge() {
    const b = $('#chatBadge');
    b.hidden = !S.unread;
    b.textContent = S.unread > 9 ? '9+' : String(S.unread);
  }

  function handleModals(initial) {
    const v = S.st;
    // Salle d'attente
    const wait = v.status === 'waiting' && S.seat >= 0;
    $('#waitModal').hidden = !wait;
    if (wait) {
      $('#shareLink').value = shareUrl();
      $('#shareCode').textContent = v.id;
      const list = $('#seatList');
      list.innerHTML = '';
      v.players.forEach((pl, p) => {
        const li = el('li', '', pl.name + (p === S.seat ? ' (vous)' : '') + (p === 0 ? ' — hôte' : ''));
        li.style.setProperty('--av', AVATAR[p % AVATAR.length]);
        list.append(li);
      });
      const host = S.seat === 0;
      $('#startBtn').hidden = !host;
      $('#startBtn').disabled = v.players.length < 2;
      $('#waitHint').textContent = host
        ? (v.players.length < 2 ? 'Il faut au moins 2 joueurs pour commencer.' : `${plural(v.players.length, 'joueur')} à table : vous pouvez lancer !`)
        : `En attente que ${v.players[0].name} lance la partie…`;
    }
    $('#waitModal').querySelector('.spinner-cards').hidden = S.seat === 0 && v.players.length > 1;

    // Fin de manche ou de partie : la fenêtre des scores s'ouvre une fois
    const modal = $('#scoreModal');
    if ((v.status === 'scoring' || v.status === 'finished') && v.lastHand && S.scoreSeen !== v.lastHand.round) {
      S.scoreSeen = v.lastHand.round;
      S.autoScore = true;
      fillScores();
      modal.hidden = false;
      if (!initial) sound(v.status === 'finished' ? (v.winners.includes(S.seat) ? 'win' : 'buzz') : 'turn');
    } else if (v.status === 'playing' && S.autoScore) {
      // Quelqu'un a lancé la manche suivante : on ferme la fenêtre ouverte automatiquement
      S.autoScore = false;
      modal.hidden = true;
    } else if (!modal.hidden) {
      fillScores();
    }
  }

  function fillScores() {
    const v = S.st;
    const lh = v.lastHand;
    const ended = v.status === 'scoring' || v.status === 'finished';
    const icon = $('#scoreIcon'), title = $('#scoreTitle'), text = $('#scoreText');
    if (v.status === 'finished') {
      const won = v.winners.includes(S.seat);
      icon.textContent = won ? '🏆' : '🎴';
      title.textContent = S.seat < 0 || !won ? winnersText(v) + ' !' : 'Victoire !';
      text.textContent = won ? 'Vous avez réussi la phase 10 avec le meilleur score.' : 'La phase 10 est réussie : la partie est terminée.';
    } else if (ended) {
      icon.textContent = '🃏';
      title.textContent = `Fin de la manche ${lh.round}`;
      text.textContent = `${v.players[lh.out].name} n'a plus de cartes.`;
    } else {
      icon.textContent = '📋';
      title.textContent = 'Scores';
      text.textContent = `Manche ${v.round} en cours. Le score compte les points de pénalité : le plus bas est le meilleur.`;
    }

    const res = new Map(ended && lh ? lh.results.map((r) => [r.p, r]) : []);
    const tbl = $('#scoreTable');
    tbl.innerHTML = '<thead><tr><th>Joueur</th><th>Phase</th>' + (res.size ? '<th>Manche</th>' : '') + '<th>Total</th></tr></thead>';
    const body = el('tbody');
    const rows = v.players.map((pl, p) => [pl, p]).sort(([a], [b]) => a.out - b.out || b.phase - a.phase || a.score - b.score);
    for (const [pl, p] of rows) {
      const tr = el('tr', (p === S.seat ? 'me' : '') + (v.winners.includes(p) ? ' winner' : '') + (pl.out ? ' out' : ''));
      tr.append(el('td', 'nm', pl.name));
      const r = res.get(p);
      tr.append(el('td', 'ph', pl.out ? '—' : r ? (r.done ? `${r.phase} ✓` : `${r.phase} ✗`) : String(pl.phase)));
      if (res.size) tr.append(el('td', 'pts', r ? (r.points ? '+' + r.points : '0') : '—'));
      tr.append(el('td', 'tot', String(pl.score)));
      body.append(tr);
    }
    tbl.append(body);

    const nb = $('#nextBtn');
    const seated = S.seat >= 0 && !mePlayer().out;
    nb.hidden = !seated || !ended;
    nb.textContent = v.status === 'finished' ? 'Nouvelle partie' : `Manche suivante`;
  }

  $('#nextBtn').addEventListener('click', async () => {
    const ok = await action(S.st.status === 'finished' ? 'rematch' : 'next');
    if (ok) $('#scoreModal').hidden = true;
  });
  $('#scoresBtn').addEventListener('click', () => {
    if (!S.st) return;
    S.autoScore = false;
    fillScores();
    $('#scoreModal').hidden = false;
  });
  $('#startBtn').addEventListener('click', () => action('start'));

  /* ---------- Barre du haut ---------- */

  const shareUrl = () => location.origin + location.pathname + '?g=' + S.game;

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const i = $('#shareLink'); i.value = text; i.select();
      try { return document.execCommand('copy'); } catch { return false; }
    }
  }

  $('#copyLink').addEventListener('click', async () => {
    if (await copy(shareUrl())) { $('#copyLink').textContent = 'Copié !'; setTimeout(() => ($('#copyLink').textContent = 'Copier'), 1600); }
  });

  $('#shareBtn').addEventListener('click', async () => {
    const url = shareUrl();
    if (navigator.share) {
      try { await navigator.share({ title: 'Une partie de Phase 10 ?', text: 'Viens jouer à Phase 10 avec moi !', url }); return; }
      catch { /* partage annulé */ }
    }
    if (await copy(url)) toast('Lien de la partie copié !', 'info', 2000);
  });

  $('#chatBtn').addEventListener('click', () => {
    const c = $('#chat');
    c.hidden = !c.hidden;
    if (!c.hidden) {
      S.unread = 0; updateBadge();
      const log = $('#chatLog'); log.scrollTop = log.scrollHeight;
      if (S.seat >= 0 && matchMedia('(pointer: fine)').matches) $('#chatInput').focus();
    }
  });
  $('#chatClose').addEventListener('click', () => ($('#chat').hidden = true));
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const i = $('#chatInput');
    const text = i.value.trim();
    if (!text || S.seat < 0) return;
    i.value = '';
    try { const j = await api('chat', { text }); applyState(j.state, true); }
    catch (err) { toast(err.message, 'error'); i.value = text; }
  });

  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
  $('#leaveBtn').addEventListener('click', async () => {
    $('#menu').hidden = true;
    if (!S.st || S.seat < 0 || mePlayer().out) return;
    if (!confirm('Quitter la partie ? Les autres joueurs continueront sans vous.')) return;
    if (await action('leave') && S.st.status === 'waiting') {
      store.del('p10.t.' + S.game);
      location.href = './';
    }
  });

  const soundBtn = $('#soundBtn');
  soundBtn.classList.toggle('off', !S.sound);
  soundBtn.addEventListener('click', () => {
    S.sound = !S.sound;
    store.set('p10.sound', S.sound ? 'on' : 'off');
    soundBtn.classList.toggle('off', !S.sound);
    if (S.sound) { unlockAudio(); sound('card'); }
  });

  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => ($('#' + b.dataset.open).hidden = false)));
  document.querySelectorAll('.modal[data-dismiss]').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
  });


  /* ---------- Toasts ---------- */

  function toast(text, kind = 'info', ms = 3200) {
    const box = $('#toasts');
    const t = el('div', 'toast t-' + kind, text);
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
  }

  /* ====================================================================
     Sons (synthétisés, aucun fichier)
     ==================================================================== */

  let actx = null;
  function unlockAudio() {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { actx = null; }
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  function tone(freq, start, dur, type = 'sine', vol = 0.15) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, actx.currentTime + start);
    g.gain.setValueAtTime(0.0001, actx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol, actx.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + start + dur);
    o.connect(g).connect(actx.destination);
    o.start(actx.currentTime + start);
    o.stop(actx.currentTime + start + dur + 0.05);
  }

  function sound(kind) {
    if (!S.sound || !actx || actx.state !== 'running') return;
    try {
      if (kind === 'card') {
        const len = actx.sampleRate * 0.07;
        const buf = actx.createBuffer(1, len, actx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
        f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 0.8;
        g.gain.value = 0.5;
        src.buffer = buf;
        src.connect(f).connect(g).connect(actx.destination);
        src.start();
      } else if (kind === 'turn') { tone(660, 0, 0.18); tone(990, 0.12, 0.3); }
      else if (kind === 'msg') tone(880, 0, 0.12, 'sine', 0.08);
      else if (kind === 'error') tone(180, 0, 0.18, 'square', 0.05);
      else if (kind === 'phase') [392, 523, 659].forEach((f, i) => tone(f, i * 0.09, 0.3, 'triangle', 0.14));
      else if (kind === 'buzz') { tone(220, 0, 0.25, 'sawtooth', 0.08); tone(165, 0.2, 0.4, 'sawtooth', 0.08); }
      else if (kind === 'win') [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.35, 'triangle', 0.14));
    } catch { /* audio indisponible */ }
  }

  /* ====================================================================
     Mise en page responsive : taille des cartes selon l'écran
     ==================================================================== */

  function layout() {
    const W = window.innerWidth, H = window.innerHeight - $('.topbar').offsetHeight;
    // Écran peu haut (téléphone couché) : talon à gauche, pour garder de la hauteur à la main
    const wide = H < 560 && W > H * 1.2;
    // Hauteur à loger, en largeurs de carte : talon 1,45 + combinaisons 0,9 + phase 0,9 + main 1,7 (+ ~140 px fixes)
    const cw = wide ? Math.min((W - 180) / 7.5, (H - 172) / 3.45) : Math.min((W - 24) / 6.4, (H - 150) / 5.6);
    S.cw = Math.floor(Math.max(36, Math.min(cw, 96)));
    document.documentElement.style.setProperty('--cw', S.cw + 'px');
    table.classList.toggle('wide', wide);
    if (S.st) render();
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 80); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.st) poll(); });

  /* ---------- Go ---------- */
  if (S.game) enterGame(); else showLobby();
})();
