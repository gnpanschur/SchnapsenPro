const express = require('express');
const http = require('http');
// Server restart trigger v1
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Basic route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

const { generateRoomCode } = require('./utils/roomCode');
const Room = require('./game/Room');
const Player = require('./game/Player');

// Room Manager (In-memory storage)
const rooms = new Map(); // roomId -> Room

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('createRoom', ({ name, playerId }) => {
        const roomId = generateRoomCode();
        const room = new Room(roomId);
        // Use client-provided playerId if available, else socket.id
        const pId = playerId || socket.id;
        const player = new Player(socket.id, name, pId);

        room.addPlayer(player);
        rooms.set(roomId, room);

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, playerId: pId });
        console.log(`Room ${roomId} created by ${name}`);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);

        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (room.isFull()) {
            socket.emit('error', 'Room is full');
            return;
        }

        const player = new Player(socket.id, playerName, socket.id);
        room.addPlayer(player);

        socket.join(roomId);
        socket.emit('roomJoined', { roomId, playerId: player.id });
        io.to(roomId).emit('playerJoined', { name: playerName });

        console.log(`${playerName} joined room ${roomId}`);

        if (room.isFull()) {
            const wasLobby = room.gameState === 'LOBBY';

            if (wasLobby) {
                room.startRound();
            }

            if (!wasLobby) {
                // Reconnect Scenario (Game was already running)
                // Send state ONLY to the connecting socket
                const p = room.getPlayer(socket.id);
                const opponent = room.players.find(op => op.socketId !== socket.id);

                socket.emit('gameStart', {
                    hand: p.hand,
                    trumpCard: room.trumpCard,
                    trumpSuit: room.trumpSuit,
                    talonSize: room.talon.length,
                    isMyTurn: room.players[room.turnIndex].socketId === p.socketId,
                    opponentName: opponent ? opponent.name : 'Gegner',
                    // Add scores to restore state
                    scores: {
                        myPoints: p.points,
                        myBummerl: p.bummerlPoints,
                        myMatchWins: p.matchWins,
                        oppPoints: opponent ? opponent.points : 0,
                        oppBummerl: opponent ? opponent.bummerlPoints : 0,
                        oppMatchWins: opponent ? opponent.matchWins : 0
                    },
                    announcements: room.announcements, // Send history
                    isTalonClosed: room.isTalonClosed,
                    myFirstTrick: p.firstTrick,
                    opponentFirstTrick: opponent ? opponent.firstTrick : null,
                    playerName: p.name // Send own name
                });
            } else {
                // Fresh Start for BOTH (wasLobby === true)
                room.players.forEach((player, index) => {
                    const opponent = room.players.find(op => op.socketId !== player.socketId);
                    io.to(player.socketId).emit('gameStart', {
                        hand: player.hand,
                        trumpCard: room.trumpCard,
                        trumpSuit: room.trumpSuit,
                        talonSize: room.talon.length,
                        isMyTurn: index === room.turnIndex,
                        opponentName: opponent ? opponent.name : 'Gegner',
                        myFirstTrick: null,
                        opponentFirstTrick: null,
                        scores: { // Initial scores
                            myPoints: 0,
                            myBummerl: 0,
                            myMatchWins: 0,
                            oppPoints: 0,
                            oppBummerl: 0,
                            oppMatchWins: 0
                        },
                        announcements: [], // Empty for new game
                        isTalonClosed: false,
                        playerName: player.name // Send own name
                    });
                });
                io.to(roomId).emit('gameStateUpdate', 'PLAYER_TURN');
            }
        }
    });

    socket.on('announce', (data) => {
        // Find room (same logic as playCard)
        let room;
        let roomId;
        for (const [id, r] of rooms.entries()) {
            if (r.getPlayer(socket.id)) {
                room = r;
                roomId = id;
                break;
            }
        }
        if (!room) return;

        const result = room.announce(socket.id, data.suit);

        if (!result.valid) {
            socket.emit('error', result.message);
            return;
        }

        // Emit announcement made
        io.to(roomId).emit('announcementMade', {
            socketId: socket.id,
            points: result.points,
            type: result.type,
            suit: data.suit
        });

        // Check for instant win
        if (result.gameState) {
            const r = result.gameState;
            // Emit round over logic (similar to end of playCard)
            io.to(roomId).emit('roundOver', {
                winnerId: r.winnerId,
                bummerlLoss: r.bummerlLoss,
                winnerBummerl: r.winnerBummerl,
                loserBummerl: r.loserBummerl,
                winnerMatchWins: r.winnerMatchWins,
                loserMatchWins: r.loserMatchWins,
                winnerTotalPoints: r.winnerTotalPoints,
                loserTotalPoints: r.loserTotalPoints,
                trickCards: r.trickCards,
                matchOver: r.matchOver
            });
        }
    });

    socket.on('exchangeTrump', () => {
        let room;
        let roomId;
        for (const [id, r] of rooms.entries()) {
            if (r.getPlayer(socket.id)) {
                room = r;
                roomId = id;
                break;
            }
        }
        if (!room) return;

        const result = room.exchangeTrump(socket.id);

        if (!result.valid) {
            socket.emit('error', result.message);
            return;
        }

        io.to(roomId).emit('trumpExchanged', {
            playerId: room.getPlayer(socket.id).id,
            socketId: socket.id,
            newTrumpCard: result.newTrumpCard
        });

        // Update swapper's hand
        socket.emit('handSwap', {
            newHand: room.getPlayer(socket.id).hand
        });
    });

    socket.on('playCard', (card) => {
        // Find room
        let room;
        let roomId;
        for (const [id, r] of rooms.entries()) {
            if (r.getPlayer(socket.id)) {
                room = r;
                roomId = id;
                break;
            }
        }

        if (!room) return;

        const result = room.playCard(socket.id, card);

        if (!result.valid) {
            socket.emit('error', result.message);
            return;
        }

        if (result.action === 'MOVE_MADE') {
            io.to(roomId).emit('moveMade', {
                playerId: result.playedCard.playerId, // Wait, playedCard object doesn't have playerId, it's just card data.
                // Correction: Room.js playCard returns { playedCard: cardObject }
                // We need to send who played it.
                socketId: socket.id,
                card: result.playedCard,
                nextTurn: result.nextTurn
            });
        } else if (result.action === 'TRICK_COMPLETE') {


            // Wait, if I emit moveMade, the client will render it.
            // But resolveTrick clears the trick.
            // I should emit moveMade for the second card, THEN emit trickCompleted after a delay or immediately and let client handle delay.

            // Let's re-examine Room.js logic.
            // resolveTrick returns trickCards. The last one is the one just played.
            const lastCard = result.trickCards[result.trickCards.length - 1];

            io.to(roomId).emit('moveMade', {
                socketId: socket.id,
                card: lastCard.card,
                nextTurn: null, // No turn yet, processing trick
                isTalonClosed: result.isTalonClosed // Added isTalonClosed
            });

            // Emit trick result
            setTimeout(() => {
                io.to(roomId).emit('trickCompleted', {
                    winnerId: result.winnerId,
                    trickCards: result.trickCards,
                    points: result.points,
                    winnerTotalPoints: result.winnerTotalPoints,
                    loserTotalPoints: result.loserTotalPoints,
                    talonSize: result.talonSize,
                    isTalonClosed: result.isTalonClosed, // Added isTalonClosed
                    winnerFirstTrick: result.winnerFirstTrick // Forward first trick info
                });

                // Deal new cards
                if (result.dealtCards) {
                    for (const [sId, c] of Object.entries(result.dealtCards)) {
                        io.to(sId).emit('handUpdate', { newCard: c });
                    }
                }
            }, 1000); // 1 second delay for visual clarity
        } else if (result.action === 'ROUND_OVER') {
            // Emit the last move first
            const lastCard = result.trickCards[result.trickCards.length - 1];
            io.to(roomId).emit('moveMade', {
                socketId: socket.id,
                card: lastCard.card,
                nextTurn: null
            });

            setTimeout(() => {
                io.to(roomId).emit('roundOver', {
                    winnerId: result.winnerId,
                    bummerlLoss: result.bummerlLoss,
                    winnerBummerl: result.winnerBummerl,
                    loserBummerl: result.loserBummerl,
                    winnerMatchWins: result.winnerMatchWins,
                    loserMatchWins: result.loserMatchWins,
                    winnerTotalPoints: result.winnerTotalPoints,
                    loserTotalPoints: result.loserTotalPoints,
                    trickCards: result.trickCards,
                    matchOver: result.matchOver
                });

                if (result.matchOver) {
                    // Handle match over logic if needed, or just let client show it
                } else {
                    // Wait for user to click "Neu geben"
                }
            }, 1000);
        }
    });

    socket.on('closeTalon', () => {
        let room;
        for (const [id, r] of rooms.entries()) {
            if (r.getPlayer(socket.id)) {
                room = r;
                break;
            }
        }
        if (!room) return;

        const result = room.closeTalon(socket.id);
        if (result.valid) {
            const player = room.getPlayer(socket.id);
            io.to(room.roomId).emit('talonClosed', {
                closerId: socket.id,
                closerName: player.name
            });
            console.log(`Player ${player.name} closed the talon in room ${room.roomId}`);
        } else {
            socket.emit('error', result.message);
        }
    });

    socket.on('startNextRound', () => {
        // Find room
        let room;
        let roomId;
        for (const [id, r] of rooms.entries()) {
            if (r.getPlayer(socket.id)) {
                room = r;
                roomId = id;
                break;
            }
        }

        if (!room) return;

        // Prevent double start if both click (simple debounce logic needed or verify state)
        if (room.gameState === 'PLAYER_TURN') {
            // Already started? Maybe just resend state to this socket if they missed it? 
            // Or assume reset needed.
            // Let's assume strict state check: Only start if ROUND_OVER
            // But if opponent already started it, it might be PLAYER_TURN.
            // So we should re-emit gameStart to THIS socket if game is running.
            const p = room.getPlayer(socket.id);
            socket.emit('gameStart', {
                hand: p.hand,
                trumpCard: room.trumpCard,
                trumpSuit: room.trumpSuit,
                talonSize: room.talon.length,
                isMyTurn: room.players[room.turnIndex].socketId === socket.id,
                opponentName: room.players.find(op => op.socketId !== socket.id).name,
                announcements: room.announcements,
                isTalonClosed: room.isTalonClosed
            });
            return;
        }

        room.resetRound();

        // Emit gameStart to each player with their specific data
        room.players.forEach(p => {
            io.to(p.socketId).emit('gameStart', {
                hand: p.hand,
                trumpCard: room.trumpCard,
                trumpSuit: room.trumpSuit,
                talonSize: room.talon.length, // use length directly
                isMyTurn: room.players[room.turnIndex].socketId === p.socketId,
                opponentName: room.players.find(op => op.socketId !== p.socketId).name,
                announcements: [], // Empty for new round
                isTalonClosed: false
            });
        });

        io.to(roomId).emit('gameStateUpdate', 'Neue Runde gestartet!');
    });

    socket.on('startRematch', () => {
        // Same room finding logic
        let room;
        let roomId;
        for (const [id, r] of rooms.entries()) {
            if (r.getPlayer(socket.id)) {
                room = r;
                roomId = id;
                break;
            }
        }
        if (!room) return;

        room.resetMatch();

        // Notify all players that a new match started
        room.players.forEach((player, index) => {
            const opponent = room.players.find(op => op.socketId !== player.socketId);
            io.to(player.socketId).emit('gameStart', {
                hand: player.hand,
                trumpCard: room.trumpCard,
                trumpSuit: room.trumpSuit,
                talonSize: room.talon.length,
                isMyTurn: index === room.turnIndex,
                opponentName: opponent ? opponent.name : 'Gegner',
                myFirstTrick: null,
                opponentFirstTrick: null,
                scores: {
                    myPoints: 0,
                    myBummerl: 0,
                    myMatchWins: player.matchWins,
                    oppPoints: 0,
                    oppBummerl: 0,
                    oppMatchWins: opponent ? opponent.matchWins : 0
                },
                announcements: [],
                isTalonClosed: false,
                playerName: player.name
            });
        });
        io.to(roomId).emit('gameStateUpdate', 'Neues Match gestartet!');
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Basic cleanup - find room and remove player
        for (const [roomId, room] of rooms.entries()) {
            const player = room.getPlayer(socket.id);
            if (player) {
                room.removePlayer(socket.id);
                io.to(roomId).emit('playerLeft', { name: player.name });
                if (room.isEmpty()) {
                    rooms.delete(roomId);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
