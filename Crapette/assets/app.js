/* Crapette — client : rendu de la table, interactions, synchronisation par polling. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const SUITS = { S: '♠︎', H: '♥︎', D: '♦︎', C: '♣︎' };
  const RANKS = { 1: 'A', 11: 'V', 12: 'C', 13: 'D', 14: 'R' };
  const rankLabel = (r) => RANKS[r] || String(r);
  const isRed = (c) => c.s === 'H' || c.s === 'D';
  const cardName = (c) => (c.s === 'T' ? 'Atout ' + c.r : c.s === 'E' ? 'Excuse' : rankLabel(c.r) + SUITS[c.s]);
  const N_TAB = 8, ROWS = N_TAB / 2;
  const last = (a) => (a.length ? a[a.length - 1] : null);
  const parseLoc = (loc) => { const [t, i] = loc.split(':'); return [t, +i]; };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };

  const S = {
    game: document.body.dataset.game || '',
    token: '',
    seat: -1,
    st: null,        // dernier état confirmé par le serveur
    view: null,      // état affiché (peut contenir un coup optimiste)
    v: 0,
    sel: null, selTime: 0,
    busy: false,
    ptr: null,
    pending: null,   // état reçu pendant un glisser, appliqué au lâcher
    lastEvent: null, lastChat: null, unread: 0,
    endSeen: -1,
    pollTimer: null,
    cw: 80,
    sound: store.get('crap.sound') !== 'off',
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
    if (S.busy) return;
    S.busy = true;
    try {
      const j = await api(name, data);
      applyState(j.state, true);
    } catch (e) {
      toast(e.message, 'error');
      sound('error');
      S.view = S.st;
      render();
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
    $('#nameInput').value = store.get('crap.name') || '';
    if (error) toast(error, 'error');
  }

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#nameInput').value.trim();
    if (!name) return;
    store.set('crap.name', name);
    const btn = e.submitter || $('#createForm button');
    btn.disabled = true;
    try {
      const j = await api('create', { name });
      store.set('crap.t.' + j.game, j.token);
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
    S.token = store.get('crap.t.' + S.game) || '';
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
    if (st.seat < 0 && st.players[1] === null) {
      // Une place est libre : on propose de s'asseoir
      $('#joinInfo').textContent = `${st.players[0].name} vous invite à une partie de Crapette.`;
      $('#joinName').value = store.get('crap.name') || '';
      $('#joinModal').hidden = false;
      $('#joinName').focus();
      applyState(st);
      return;
    }
    applyState(st);
    poll();
  }

  $('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#joinName').value.trim();
    if (!name) return;
    store.set('crap.name', name);
    try {
      const j = await api('join', { name });
      if (j.seat >= 0) {
        S.token = j.token;
        store.set('crap.t.' + S.game, j.token);
      } else {
        toast('La partie est déjà complète : vous la regardez en spectateur.', 'info');
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
    if (S.ptr && S.ptr.dragging) { S.pending = st; return; }
    if (S.busy && !fromAction) return;
    const prev = S.st;
    S.st = st;
    S.view = st;
    S.v = st.v;
    S.seat = st.seat;
    if (S.sel && !isSource(S.sel)) S.sel = null;

    render();
    handleEvents(st.events, !prev);
    handleChat(st.chat, !prev);
    handleModals();
    if (prev && st.lastMove && JSON.stringify(st.lastMove) !== JSON.stringify(prev.lastMove)) sound('card');
  }

  function updateOnline(online) {
    if (!S.st) return;
    S.st.online = online;
    document.querySelectorAll('.avatar .dot').forEach((d) => {
      d.classList.toggle('on', !!online[+d.dataset.p]);
    });
  }

  /* ====================================================================
     Règles (miroir de lib/game.php, pour illuminer les coups possibles)
     ==================================================================== */

  const me = () => (S.seat >= 0 ? S.seat : 0);
  const myTurn = () => S.view && S.seat >= 0 && S.view.status === 'playing' && S.view.turn === S.seat;

  function topOf(v, loc) {
    const [t, i] = parseLoc(loc);
    switch (t) {
      case 'waste': return v.players[i].waste.top;
      case 'hand': return v.players[i].hand;
      case 'tab': return last(v.tableau[i]);
    }
    return null;
  }

  /** Descendant, couleurs alternées ; atouts entre eux ; l'Excuse va partout et accepte tout. */
  function canStack(card, top) {
    if (card.s === 'E' || top.s === 'E') return true;
    if (card.s === 'T' || top.s === 'T') return card.s === 'T' && top.s === 'T' && card.r === top.r - 1;
    return card.r === top.r - 1 && isRed(card) !== isRed(top);
  }

  function canPlace(v, card, loc) {
    const [t, i] = parseLoc(loc);
    const top = topOf(v, loc);
    switch (t) {
      case 'tab': return !top || (!top.back && canStack(card, top));
      case 'waste': return i !== S.seat && !!top && canStack(card, top);
    }
    return false;
  }

  function isSource(loc) {
    if (!myTurn()) return false;
    const [t, i] = parseLoc(loc);
    if (t === 'hand') return i === S.seat && !!S.view.players[i].hand;
    if (t === 'waste') return !!S.view.players[i]?.waste.top;   // les deux défausses
    if (t === 'tab') return S.view.tableau[i].length > 0 && !S.view.tableau[i][0].back;
    return false;
  }

  /** Une suite ne se casse pas : indice de la première carte de la suite du dessus d'une maison. */
  function runStart(pile) {
    let k = pile.length - 1;
    while (k > 0 && canStack(pile[k], pile[k - 1])) k--;
    return Math.max(k, 0);
  }

  /** Carte qui décide où va le coup : la carte retournée, ou le bas de la suite déplacée. */
  function movingCard(v, loc) {
    const [t, i] = parseLoc(loc);
    if (t === 'hand') return v.players[i].hand;
    if (t === 'waste') return v.players[i].waste.top;
    const pile = v.tableau[i];
    return pile.length && !pile[0].back ? pile[runStart(pile)] : null;
  }

  function targetsFor(from) {
    const v = S.view;
    const card = movingCard(v, from);
    if (!card) return [];
    const out = [];
    const opp = 1 - S.seat;
    const locs = [];
    for (let i = 0; i < N_TAB; i++) locs.push('tab:' + i);
    if (!from.startsWith('waste:')) locs.push('waste:' + opp);   // la carte d'une défausse ne va qu'au centre
    for (const l of locs) if (l !== from && canPlace(v, card, l)) out.push(l);
    if (from === 'hand:' + S.seat) out.push('waste:' + S.seat);
    return out;
  }

  /** Copie de l'état avec le coup déjà joué, pour un affichage instantané. */
  function optimisticMove(from, to) {
    const v = JSON.parse(JSON.stringify(S.st));
    const [ft, fi] = parseLoc(from);
    const [tt, ti] = parseLoc(to);
    let cards;
    if (ft === 'hand') { cards = [v.players[fi].hand]; v.players[fi].hand = null; }
    else cards = v.tableau[fi].splice(runStart(v.tableau[fi]));
    if (tt === 'tab') v.tableau[ti].push(...cards);
    else { const p = v.players[ti][tt]; p.n += cards.length; p.top = last(cards); }
    return v;
  }

  /* ====================================================================
     Rendu
     ==================================================================== */

  const table = $('#table');

  function faceEl(c) {
    if (c.s === 'T' || c.s === 'E') return trumpEl(c);
    const n = el('div', 'card' + (isRed(c) ? ' red' : '') + (c.r === 1 ? ' ace' : '') + (c.r > 10 ? ' court' : ''));
    n.dataset.id = c.id;
    const R = rankLabel(c.r), sym = SUITS[c.s];
    const pip = c.r > 10 ? `${R}<small>${sym}</small>` : sym;
    n.innerHTML = `<span class="ci tl">${R}<i>${sym}</i></span><span class="pip">${pip}</span>`
      + `<span class="ci br">${R}<i>${sym}</i></span><span class="ci tr">${R}<i>${sym}</i></span>`;
    n.title = cardName(c).replace('︎', '');
    return n;
  }

  /** Atouts (numéro) et Excuse (étoile), façon tarot. */
  function trumpEl(c) {
    const ex = c.s === 'E';
    const n = el('div', 'card trump' + (ex ? ' excuse' : ''));
    n.dataset.id = c.id;
    const R = ex ? '★' : c.r === 6 || c.r === 9 ? `<u>${c.r}</u>` : String(c.r);
    const mid = ex ? '<b>★</b><small>Excuse</small>' : `<b>${R}</b><small>Atout</small>`;
    n.innerHTML = `<span class="ci tl">${R}</span><span class="pip">${mid}</span>`
      + `<span class="ci br">${R}</span><span class="ci tr">${R}</span>`;
    n.title = cardName(c);
    return n;
  }

  const backEl = (owner, deep) => el('div', `card back b${owner}${deep ? ' deep' : ''}`);

  function slotEl(loc, kind, label) {
    const n = el('div', 'slot ' + kind);
    n.dataset.loc = loc;
    n.dataset.label = label;
    return n;
  }

  function countEl(n) { return el('span', 'count', String(n)); }

  function renderPlayerZone(zone, p, isMe) {
    const v = S.view;
    const pl = v.players[p];
    zone.innerHTML = '';
    zone.classList.toggle('active', v.status === 'playing' && v.turn === p);

    const info = el('div', 'info');
    const who = el('div', 'who');
    const av = el('div', 'avatar p' + p, pl ? pl.name.charAt(0).toUpperCase() : '?');
    const dot = el('span', 'dot' + (v.online && v.online[p] ? ' on' : ''));
    dot.dataset.p = p;
    av.append(dot);
    const nm = el('div', 'name', pl ? pl.name : 'En attente…');
    if (isMe && S.seat >= 0) nm.append(el('span', 'you', ' (vous)'));
    who.append(av, nm);
    info.append(who);

    if (pl) {
      const left = pl.stock + pl.waste.n + (pl.hand ? 1 : 0);
      const lc = el('div', 'left-count');
      lc.innerHTML = `Reste <b>${left}</b> carte${left > 1 ? 's' : ''}`;
      info.append(lc);
    }

    // Boutons d'action
    if (isMe && S.seat >= 0 && pl) {
      if (v.status === 'playing' && v.turn === S.seat) {
        if (pl.hand) {
          const b = el('button', 'btn btn-gold btn-small', 'Défausser');
          b.title = 'Poser la carte retournée sur votre défausse';
          b.onclick = () => doMove('hand:' + S.seat, 'waste:' + S.seat);
          info.append(b);
        } else if (!pl.stock && !pl.waste.n) {
          const b = el('button', 'btn btn-gold btn-small', 'Passer');
          b.onclick = () => action('pass');
          info.append(b);
        }
        // « Crapette ! » : au début de son tour, avant tout coup
        if (v.canCall && !pl.falseCall) {
          const b = el('button', 'crap-btn', 'Crapette !');
          b.title = "Votre adversaire a commis une faute pendant son tour ? Dénoncez-la avant de jouer !";
          b.onclick = () => { sound('call'); action('crapette'); };
          info.append(b);
        }
      } else if (v.status === 'finished') {
        const b = el('button', 'btn btn-gold btn-small', v.rematch[S.seat] ? 'Revanche demandée' : 'Revanche');
        b.disabled = v.rematch[S.seat];
        b.onclick = () => action('rematch');
        info.append(b);
      }
    }

    const piles = el('div', 'piles');
    if (pl) {
      // Talon
      const stock = slotEl('stock:' + p, 'stock', 'Talon');
      if (pl.stock) { stock.append(backEl(p, pl.stock > 1), countEl(pl.stock)); } else stock.classList.add('empty');
      if (isMe && myTurn() && !pl.hand && (pl.stock || pl.waste.n)) {
        stock.classList.add('can-draw');
        stock.title = 'Retourner une carte du talon';
      } else stock.title = 'Talon';

      // Carte retournée
      const hand = slotEl('hand:' + p, 'hand', 'Carte');
      if (pl.hand) hand.append(faceEl(pl.hand)); else hand.classList.add('empty');
      hand.title = 'Carte retournée du talon';

      // Défausse
      const waste = slotEl('waste:' + p, 'waste', 'Défausse');
      if (pl.waste.top) {
        const c = faceEl(pl.waste.top);
        if (pl.waste.n > 1) c.classList.add('deep');
        waste.append(c, countEl(pl.waste.n));
      } else waste.classList.add('empty');
      waste.title = 'Défausse';

      piles.append(stock, hand, waste);
    }
    zone.append(info, piles);
  }

  function renderBoard() {
    const v = S.view;
    const board = $('#board');
    board.innerHTML = '';
    const fans = [];
    for (let r = 0; r < ROWS; r++) {
      const row = el('div', 'row');
      const L = fanEl(r, 'left'), R = fanEl(ROWS + r, 'right');
      row.append(L, R);
      board.append(row);
      fans.push(L, R);
    }
    function fanEl(i, side) {
      const n = el('div', 'fan ' + side);
      n.dataset.loc = 'tab:' + i;
      n.append(el('div', 'base'));
      v.tableau[i].forEach((c) => n.append(c.back ? backEl(2, false) : faceEl(c)));
      return n;
    }
    if (v.removed) board.append(el('div', 'removed', `${v.removed} cartes retirées du jeu (suites complètes)`));
    // Position des cartes en éventail (calculée une fois la largeur connue)
    for (const fan of fans) {
      const cards = fan.querySelectorAll('.card');
      const W = fan.clientWidth, cw = S.cw, n = cards.length;
      const off = n > 1 ? Math.max(2, Math.min(cw * 0.3, (W - cw) / (n - 1))) : 0;
      const left = fan.classList.contains('left');
      cards.forEach((c, k) => {
        c.style.left = (left ? W - cw - k * off : k * off) + 'px';
        c.style.zIndex = k + 1;
      });
    }
  }

  function renderTopbar() {
    const v = S.view;
    const m = me(), o = 1 - m;
    const sb = $('#scoreboard');
    sb.innerHTML = '';
    const p0 = v.players[m], p1 = v.players[o];
    sb.append(
      el('span', 'nm', p0 ? p0.name : '—'),
      el('span', 'sc', `${v.scores[m]} – ${v.scores[o]}`),
      el('span', 'nm', p1 ? p1.name : '—'),
    );

    let text = '', mine = false;
    if (v.status === 'waiting') text = "En attente d'un adversaire…";
    else if (v.status === 'finished') text = v.winner === S.seat ? 'Vous avez gagné !' : `${v.players[v.winner].name} a gagné`;
    else if (myTurn()) {
      mine = true;
      text = v.mustFlip ? 'Retournez une carte des maisons' : 'À vous de jouer';
    } else text = `Tour de ${v.players[v.turn].name}…`;
    const pill = $('#statusPill');
    pill.innerHTML = '';
    pill.append(el('span', mine ? 'mine' : '', text));
  }

  function render(flipFrom) {
    if (!S.view) return;
    const snap = snapshot();
    if (flipFrom) for (const [k, r] of flipFrom) snap.set(k, r);
    renderTopbar();
    const m = me();
    renderPlayerZone($('#zoneOpp'), 1 - m, false);
    renderPlayerZone($('#zoneMe'), m, true);
    renderBoard();
    decorate();
    animateFrom(snap);
  }

  /** Classes d'interaction : cartes jouables, sélection, cibles. */
  function decorate() {
    if (myTurn() && S.view.mustFlip) {
      table.querySelectorAll('.fan .card.back').forEach((c) => c.classList.add('flippable'));
    } else if (myTurn()) {
      for (const loc of ['hand:' + S.seat, 'waste:' + S.seat, 'waste:' + (1 - S.seat), ...Array.from({ length: N_TAB }, (_, i) => 'tab:' + i)]) {
        if (!isSource(loc)) continue;
        const pile = table.querySelector(`[data-loc="${loc}"]`);
        const cards = pile ? [...pile.querySelectorAll('.card[data-id]')] : [];
        if (!cards.length) continue;
        // Dans une maison, toute la suite du dessus bouge d'un bloc
        const from = loc.startsWith('tab:') ? runStart(S.view.tableau[+loc.slice(4)]) : cards.length - 1;
        cards.slice(from).forEach((c) => c.classList.add('movable'));
      }
    }
    table.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
    table.querySelectorAll('.card.selected').forEach((n) => n.classList.remove('selected'));
    if (!S.sel) return;
    // Aucune aide : seules les cartes sélectionnées sont mises en valeur, pas les destinations
    const pile = table.querySelector(`[data-loc="${S.sel}"]`);
    if (pile) pile.querySelectorAll('.card.movable').forEach((c) => c.classList.add('selected'));
  }

  /* ---------- Animations FLIP ---------- */

  function snapshot() {
    const m = new Map();
    table.querySelectorAll('.card[data-id]').forEach((n) => m.set(n.dataset.id, n.getBoundingClientRect()));
    return m;
  }

  function animateFrom(snap) {
    const lm = S.view.lastMove;
    table.querySelectorAll('.card[data-id]').forEach((n) => {
      let r0 = snap.get(n.dataset.id);
      if (!r0 && lm && lm.id === n.dataset.id && lm.from.startsWith('stock:')) {
        const s = table.querySelector(`[data-loc="${lm.from}"]`);
        if (s) r0 = s.getBoundingClientRect();
      }
      if (!r0 && lm && lm.flip && lm.id === n.dataset.id) {
        // Carte des maisons qu'on vient de retourner
        n.animate([{ transform: 'rotateY(90deg)' }, { transform: 'none' }], { duration: 320, easing: 'ease-out' });
        n.classList.add('flash');
        return;
      }
      if (!r0) return;
      const r1 = n.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      n.animate(
        [{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 500 }, { transform: 'none', zIndex: 500 }],
        { duration: 280, easing: 'cubic-bezier(.2, .8, .25, 1)' },
      );
      if (!snap.has(n.dataset.id) || S.view.lastMove?.id === n.dataset.id) n.classList.add('flash');
    });
  }

  /* ====================================================================
     Interactions : glisser-déposer + toucher/toucher
     ==================================================================== */

  function select(loc) {
    S.sel = loc;
    S.selTime = performance.now();
    decorate();
  }
  function clearSel() {
    if (!S.sel) return;
    S.sel = null;
    decorate();
  }

  function doMove(from, to, flipFrom) {
    if (S.busy) return;
    S.sel = null;
    // Depuis la défausse, on ne connaît pas la carte du dessous : pas d'affichage anticipé
    if (from.startsWith('waste:')) { decorate(); action('move', { from, to }); return; }
    S.view = optimisticMove(from, to);
    render(flipFrom);
    action('move', { from, to });
  }

  function refuseMove() {
    toast('Coup impossible.', 'error', 1800);
    sound('error');
    clearSel();
  }

  function onTap(loc) {
    const m = S.seat;
    // Début de tour : il faut d'abord retourner une carte cachée des maisons
    if (myTurn() && S.view.mustFlip) {
      clearSel();
      if (loc.startsWith('tab:') && S.view.tableau[+loc.slice(4)][0]?.back) action('flip', { loc });
      else toast("Retournez d'abord une carte cachée des maisons.", 'error', 2200);
      return;
    }
    if (loc === 'stock:' + m) {
      clearSel();
      const pl = S.view.players[m];
      if (myTurn() && !pl.hand && (pl.stock || pl.waste.n)) action('draw');
      return;
    }
    if (S.sel) {
      if (loc === S.sel) { clearSel(); return; }
      if (targetsFor(S.sel).includes(loc)) doMove(S.sel, loc);
      else refuseMove();
      return;
    }
    if (isSource(loc)) select(loc);
    else clearSel();
  }

  table.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !S.view || S.seat < 0) return;
    unlockAudio();
    const pile = e.target.closest('[data-loc]');
    if (!pile) { clearSel(); return; }
    const loc = pile.dataset.loc;
    const card = e.target.closest('.card');
    const draggable = !!card && card.classList.contains('movable') && isSource(loc);
    S.ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, loc, card, draggable, dragging: false };
    if (draggable) table.setPointerCapture(e.pointerId);
  });

  table.addEventListener('pointermove', (e) => {
    const p = S.ptr;
    if (!p || p.id !== e.pointerId || !p.draggable) return;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      startDrag(p);
    }
    p.ghost.style.transform = `translate(${e.clientX - p.x}px, ${e.clientY - p.y}px)`;
    const over = dropTargetAt(e.clientX, e.clientY);
    // Surlignage neutre de l'emplacement survolé, qu'il accepte la carte ou non
    table.querySelectorAll('.drop-hover').forEach((n) => n !== over && n.classList.remove('drop-hover'));
    if (over && over.dataset.loc !== p.loc) over.classList.add('drop-hover');
  });

  function startDrag(p) {
    p.dragging = true;
    S.sel = p.loc;
    decorate();
    // Le fantôme contient toute la suite saisie, à sa place à l'écran
    const pile = table.querySelector(`[data-loc="${p.loc}"]`);
    p.run = [...pile.querySelectorAll('.card.movable')];
    p.ghost = el('div', 'ghost-run');
    for (const c of p.run) {
      const r = c.getBoundingClientRect();
      const g = c.cloneNode(true);
      g.classList.remove('selected', 'flash', 'movable');
      g.style.left = r.left + 'px';
      g.style.top = r.top + 'px';
      g.style.zIndex = '';
      p.ghost.append(g);
      c.classList.add('dragging');
    }
    document.body.append(p.ghost);
  }

  function dropTargetAt(x, y) {
    const n = document.elementFromPoint(x, y);
    return n ? n.closest('#table [data-loc]') : null;
  }

  function endPointer(e, cancelled) {
    const p = S.ptr;
    if (!p || p.id !== e.pointerId) return;
    S.ptr = null;
    if (p.dragging) {
      const over = cancelled ? null : dropTargetAt(e.clientX, e.clientY);
      const flip = new Map([...p.ghost.children].map((g) => [g.dataset.id, g.getBoundingClientRect()]));
      p.ghost.remove();
      p.run.forEach((c) => c.classList.remove('dragging'));
      const to = over && over.dataset.loc;
      if (S.pending) { const st = S.pending; S.pending = null; S.sel = null; applyState(st); }
      if (to && to !== p.loc && targetsFor(p.loc).includes(to)) {
        doMove(p.loc, to, flip);
      } else if (to && to !== p.loc) {
        refuseMove();
      } else {
        S.sel = null;
        decorate();
      }
      return;
    }
    if (!cancelled) {
      const n = document.elementFromPoint(e.clientX, e.clientY);
      const pile = n && n.closest('#table [data-loc]');
      if (pile) onTap(pile.dataset.loc);
    }
  }
  table.addEventListener('pointerup', (e) => endPointer(e, false));
  table.addEventListener('pointercancel', (e) => endPointer(e, true));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSel();
      document.querySelectorAll('.modal[data-dismiss], #rulesModal').forEach((m) => (m.hidden = true));
      $('#menu').hidden = true;
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
          if (ev.seat === S.seat) { toast('À vous de jouer ! Une faute à dénoncer ? Criez « Crapette ! » avant votre premier coup.', 'turn', 3500); sound('turn'); }
          break;
        case 'crapette':
          toast(ev.text.replace(/^Crapette ! /, ''), 'crapette', 6000);
          sound(ev.seat === S.seat ? 'win' : 'buzz');
          break;
        case 'false': toast(ev.text, 'false', 3500); sound('error'); break;
        case 'load': if (ev.seat !== S.seat) toast(ev.text, 'load', 3000); break;
        case 'win': break; // géré par la fenêtre de fin
        case 'deal': toast(ev.text, 'info', 3500); sound('turn'); break;
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

  function handleModals() {
    const v = S.st;
    const wait = v.status === 'waiting' && S.seat === 0;
    $('#waitModal').hidden = !wait;
    if (wait) {
      $('#shareLink').value = shareUrl();
      $('#shareCode').textContent = v.id;
    }

    const end = $('#endModal');
    if (v.status !== 'finished') { end.hidden = true; return; }
    const won = v.winner === S.seat;
    const winner = v.players[v.winner].name;
    $('#endIcon').textContent = S.seat < 0 ? '🃏' : won ? '🏆' : '🂠';
    $('#endTitle').textContent = S.seat < 0 ? `${winner} gagne !` : won ? 'Victoire !' : 'Défaite…';
    const m = me(), o = 1 - m;
    $('#endText').textContent = `Score : ${v.players[m].name} ${v.scores[m]} – ${v.scores[o]} ${v.players[o].name}`;
    const rb = $('#rematchBtn');
    rb.hidden = S.seat < 0;
    if (S.seat >= 0) {
      const mineAsked = v.rematch[S.seat], otherAsked = v.rematch[1 - S.seat];
      rb.disabled = mineAsked;
      rb.textContent = mineAsked ? `En attente de ${v.players[1 - S.seat].name}…` : otherAsked ? 'Accepter la revanche' : 'Revanche !';
    }
    if (S.endSeen !== v.round) {
      S.endSeen = v.round;
      end.hidden = false;
      sound(won ? 'win' : 'buzz');
    }
  }

  $('#rematchBtn').addEventListener('click', () => action('rematch'));
  $('#endClose').addEventListener('click', () => ($('#endModal').hidden = true));

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
      try { await navigator.share({ title: 'Une partie de Crapette ?', text: 'Viens jouer à la Crapette avec moi !', url }); return; }
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
  $('#resignBtn').addEventListener('click', () => {
    $('#menu').hidden = true;
    if (S.st?.status === 'playing' && S.seat >= 0 && confirm('Abandonner la partie ? Votre adversaire marquera le point.')) action('resign');
  });

  const soundBtn = $('#soundBtn');
  soundBtn.classList.toggle('off', !S.sound);
  soundBtn.addEventListener('click', () => {
    S.sound = !S.sound;
    store.set('crap.sound', S.sound ? 'on' : 'off');
    soundBtn.classList.toggle('off', !S.sound);
    if (S.sound) { unlockAudio(); sound('card'); }
  });

  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => ($('#' + b.dataset.open).hidden = false)));
  document.querySelectorAll('#rulesModal').forEach((m) => {
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
      else if (kind === 'call') { tone(520, 0, 0.1, 'triangle', 0.2); tone(780, 0.08, 0.18, 'triangle', 0.2); }
      else if (kind === 'buzz') { tone(220, 0, 0.25, 'sawtooth', 0.08); tone(165, 0.2, 0.4, 'sawtooth', 0.08); }
      else if (kind === 'win') [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.35, 'triangle', 0.14));
    } catch { /* audio indisponible */ }
  }

  /* ====================================================================
     Mise en page responsive : taille des cartes selon l'écran
     ==================================================================== */

  function layout() {
    const top = $('.topbar').offsetHeight;
    const W = window.innerWidth, H = window.innerHeight - top;
    // Disposition haute : adversaire / 4 rangées / moi. Disposition large : joueurs sur les côtés.
    const tall = Math.min((H - 24) / 9.6, (W - 24) / 5.6);
    const wide = Math.min((H - 24) / 6.3, (W - 40) / 10.6);
    const cap = (x) => Math.max(30, Math.min(x, 118));
    const useWide = cap(wide) > cap(tall) * 1.1;
    S.cw = Math.floor(cap(useWide ? wide : tall));
    document.documentElement.style.setProperty('--cw', S.cw + 'px');
    table.classList.toggle('wide', useWide);
    if (S.view) render();
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 80); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.st) poll(); });

  /* ---------- Go ---------- */
  if (S.game) enterGame(); else showLobby();
})();
