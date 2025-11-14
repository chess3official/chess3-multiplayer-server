const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 4000;

/**
 * In-memory game store
 * gameId: {
 *   chess: Chess instance,
 *   players: { w: WebSocket | null, b: WebSocket | null },
 *   createdAt: number
 * }
 */
const games = new Map();

function generateGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function createGame(ws) {
  const gameId = generateGameId();
  const chess = new Chess();
  const game = {
    chess,
    players: { w: ws, b: null },
    createdAt: Date.now(),
  };
  games.set(gameId, game);

  ws._chessRole = { gameId, color: 'w' };

  safeSend(ws, {
    type: 'game_created',
    gameId,
    color: 'w',
    fen: chess.fen(),
  });
}

function joinGame(ws, gameId) {
  const game = games.get(gameId);
  if (!game) {
    safeSend(ws, {
      type: 'error',
      message: 'Game not found',
    });
    return;
  }

  let color = null;
  if (!game.players.b) {
    color = 'b';
    game.players.b = ws;
  } else if (!game.players.w) {
    color = 'w';
    game.players.w = ws;
  } else {
    safeSend(ws, {
      type: 'error',
      message: 'Game already has two players',
    });
    return;
  }

  ws._chessRole = { gameId, color };

  // Notify joining player
  safeSend(ws, {
    type: 'game_joined',
    gameId,
    color,
    fen: game.chess.fen(),
  });

  // Notify opponent that second player joined
  const oppColor = color === 'w' ? 'b' : 'w';
  const opp = game.players[oppColor];
  if (opp) {
    safeSend(opp, {
      type: 'opponent_joined',
      gameId,
      opponentColor: color,
    });
  }
}

function handleMove(ws, { gameId, from, to, promotion }) {
  const game = games.get(gameId);
  if (!game) {
    safeSend(ws, { type: 'error', message: 'Game not found' });
    return;
  }

  const role = ws._chessRole;
  if (!role || role.gameId !== gameId) {
    safeSend(ws, { type: 'error', message: 'You are not part of this game' });
    return;
  }

  const turnColor = game.chess.turn(); // 'w' or 'b'
  if (role.color !== turnColor) {
    safeSend(ws, { type: 'error', message: 'Not your turn' });
    return;
  }

  try {
    const move = game.chess.move({ from, to, promotion: promotion || 'q' });
    if (!move) {
      safeSend(ws, { type: 'error', message: 'Illegal move' });
      return;
    }

    const payload = {
      type: 'move_made',
      gameId,
      fen: game.chess.fen(),
      lastMove: move,
      turn: game.chess.turn(),
      isGameOver: game.chess.isGameOver(),
      isCheckmate: game.chess.isCheckmate(),
      isDraw: game.chess.isDraw(),
    };

    const { w, b } = game.players;
    safeSend(w, payload);
    safeSend(b, payload);
  } catch (err) {
    safeSend(ws, { type: 'error', message: 'Move error' });
  }
}

function cleanupConnection(ws) {
  const role = ws._chessRole;
  if (!role) return;

  const { gameId, color } = role;
  const game = games.get(gameId);
  if (!game) return;

  // Clear this socket from players
  if (game.players[color] === ws) {
    game.players[color] = null;
  }

  // If both players gone, delete game
  if (!game.players.w && !game.players.b) {
    games.delete(gameId);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      safeSend(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const { type } = msg;
    switch (type) {
      case 'create_game':
        createGame(ws);
        break;
      case 'join_game':
        if (!msg.gameId) {
          safeSend(ws, { type: 'error', message: 'Missing gameId' });
          return;
        }
        joinGame(ws, msg.gameId);
        break;
      case 'make_move':
        handleMove(ws, msg);
        break;
      default:
        safeSend(ws, { type: 'error', message: 'Unknown message type' });
    }
  });

  ws.on('close', () => {
    cleanupConnection(ws);
  });

  safeSend(ws, { type: 'connected', message: 'Connected to Chess3 multiplayer server' });
});

console.log(`Chess3 multiplayer WebSocket server listening on port ${PORT}`);
