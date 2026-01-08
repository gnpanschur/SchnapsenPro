const Player = require('./Player');

class Room {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = []; // Array of Player objects
        this.gameState = 'LOBBY'; // LOBBY, WAITING_FOR_PLAYER, DEALING, PLAYER_TURN, WAITING_FOR_RECONNECT, GAME_OVER
        this.dealerIndex = 0; // Track who is dealing (0 or 1)
        this.turnIndex = (this.dealerIndex + 1) % 2; // Vorhand (non-dealer) starts
        this.deck = [];
        this.talon = [];
        this.trumpCard = null;
        this.trumpSuit = null; // Persist trump suit
        this.activeSuit = null; // For color constraint when talon is empty
        this.currentTrick = [];
        this.announcements = []; // Store announcements: { socketId, suit, type, timestamp }
        this.isTalonClosed = false;
    }

    announce(socketId, suit) {
        const playerIndex = this.players.findIndex(p => p.socketId === socketId);
        if (playerIndex !== this.turnIndex) return { valid: false, message: 'Nicht dein Zug!' };

        const player = this.players[playerIndex];

        // Can only announce if trick is empty (start of turn)
        if (this.currentTrick.length > 0) return { valid: false, message: 'Darf nur zu Beginn des Zuges angesagt werden!' };

        // Check if player has King and Queen of suit
        const hasKing = player.hand.some(c => c.suit === suit && c.rank === 'K');
        const hasQueen = player.hand.some(c => c.suit === suit && c.rank === 'Q');

        if (!hasKing || !hasQueen) return { valid: false, message: 'Du brauchst König und Dame der Farbe!' };

        // Points
        const isTrump = suit === this.trumpSuit;
        const points = isTrump ? 40 : 20;

        if (player.tricks.length > 0) {
            player.points += points;
        } else {
            player.pendingPoints += points;
        }

        // Set constraint: Must play one of the marriage cards
        player.constraint = { type: 'MUST_PLAY_MARRIAGE', suit: suit };

        // Check for instant win
        if (player.points >= 66) {
            const result = this.endRound(player, this.players.find(p => p.socketId !== player.socketId), []);
            this.announcements.push({
                socketId,
                suit,
                type: isTrump ? '40' : '20',
                timestamp: Date.now()
            });
            return { valid: true, points, type: isTrump ? '40' : '20', gameState: result };
        }

        this.announcements.push({
            socketId,
            suit,
            type: isTrump ? '40' : '20',
            timestamp: Date.now()
        });

        return { valid: true, points, type: isTrump ? '40' : '20', gameState: null };
    }

    exchangeTrump(socketId) {
        const playerIndex = this.players.findIndex(p => p.socketId === socketId);
        if (playerIndex !== this.turnIndex) return { valid: false, message: 'Nicht dein Zug!' };

        const player = this.players[playerIndex];

        // Conditions: 
        // 1. Trick empty (start of turn)
        // 2. Talon not empty
        // 3. Player has Trump Jack (Unter)

        if (this.currentTrick.length > 0) return { valid: false, message: 'Darf nur zu Beginn des Zuges getauscht werden!' };
        if (this.talon.length === 0) return { valid: false, message: 'Talon darf nicht leer sein!' };

        const trumpJackIndex = player.hand.findIndex(c => c.suit === this.trumpSuit && c.rank === 'J');
        if (trumpJackIndex === -1) return { valid: false, message: 'Du brauchst den Trumpf-Buben (Unter)!' };

        // Execute Exchange
        const jackCard = player.hand[trumpJackIndex];
        const oldTrump = this.trumpCard; // currently open card

        // Swap behavior: 
        // Hand gets oldTrump. 
        // this.trumpCard gets jackCard.

        player.hand[trumpJackIndex] = oldTrump;
        this.trumpCard = jackCard;

        return {
            valid: true,
            newTrumpCard: this.trumpCard,
            exchangedCard: oldTrump // The card the player received
        };
    }

    playCard(socketId, card) {
        const playerIndex = this.players.findIndex(p => p.socketId === socketId);
        if (playerIndex !== this.turnIndex) return { valid: false, message: 'Not your turn' };

        const player = this.players[playerIndex];
        const cardIndex = player.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);

        if (cardIndex === -1) return { valid: false, message: 'Card not in hand' };

        // Check constraint
        if (player.constraint) {
            if (player.constraint.type === 'MUST_PLAY_MARRIAGE') {
                if (card.suit !== player.constraint.suit || (card.rank !== 'K' && card.rank !== 'Q')) {
                    return { valid: false, message: 'Du musst König oder Dame der angesagten Farbe spielen!' };
                }
                // Fulfilled
                player.constraint = null;
            }
        }

        // Strict Rules Check (Farb- und Stichzwang)
        // Applies if Talon is empty OR closed
        if ((this.talon.length === 0 || this.isTalonClosed) && this.currentTrick.length === 1) {
            const leadCard = this.currentTrick[0].card;

            // 1. Must Follow Suit (Farbzwang)
            const hasLeadSuit = player.hand.some(c => c.suit === leadCard.suit);
            if (hasLeadSuit) {
                if (card.suit !== leadCard.suit) {
                    return { valid: false, message: 'Farbzwang: Du musst die angespielte Farbe bedienen!' };
                }
                // Stichzwang (Must win if possible) - Implicit in standard strict rules
                // If following suit, try to play a higher card
                const canBeatInSuit = player.hand.some(c => c.suit === leadCard.suit && c.value > leadCard.value);
                if (canBeatInSuit) {
                    if (card.value <= leadCard.value) {
                        // He played the suit, but a lower card, even though he had a higher one?
                        // Standard Schnapsen Strict Rule: "Du musst stechen, wenn du kannst."
                        return { valid: false, message: 'Stichzwang: Du musst den Stich machen!' };
                    }
                }
            } else {
                // 2. Must Trump (Trumpfzwang)
                const hasTrump = player.hand.some(c => c.suit === this.trumpSuit);
                if (hasTrump) {
                    if (card.suit !== this.trumpSuit) {
                        return { valid: false, message: 'Trumpfzwang: Du musst trumpfen!' };
                    }
                    // Win strict rule for trumps too?
                    // Usually yes: If opponent played trump, you must beat it if possible.
                    // But if opponent led non-trump and you have no suit, you must play ANY trump (which wins).
                    // If opponent Led Trump: handled by hasLeadSuit logic above.
                }
                // 3. If neither, play anything.
            }
        }

        // Remove card
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        this.currentTrick.push({ playerId: player.id, socketId: player.socketId, card: playedCard });

        // Switch turn for next move if trick not complete
        if (this.currentTrick.length === 1) {
            this.turnIndex = (this.turnIndex + 1) % 2;
            return {
                valid: true,
                action: 'MOVE_MADE',
                playedCard,
                nextTurn: this.players[this.turnIndex].socketId
            };
        } else {
            // Trick complete
            return this.resolveTrick();
        }
    }

    resolveTrick() {
        const c1 = this.currentTrick[0];
        const c2 = this.currentTrick[1];

        // Determine winner
        // If c2 follows suit of c1
        let winnerSocketId = c1.socketId; // Default: leader wins

        if (c2.card.suit === c1.card.suit) {
            if (c2.card.value > c1.card.value) {
                winnerSocketId = c2.socketId;
            }
        } else if (c2.card.suit === this.trumpSuit) {
            // c2 trumped c1
            winnerSocketId = c2.socketId;
        }

        const winnerIndex = this.players.findIndex(p => p.socketId === winnerSocketId);
        const winner = this.players[winnerIndex];

        // Calculate points
        const points = c1.card.value + c2.card.value;
        winner.points += points;
        winner.tricks.push([...this.currentTrick]);

        if (winner.pendingPoints > 0) {
            winner.points += winner.pendingPoints;
            winner.pendingPoints = 0;
        }

        const trickCards = [...this.currentTrick];
        this.currentTrick = [];

        // Capture First Trick for Winner if not yet set
        if (!winner.firstTrick) {
            winner.firstTrick = [...trickCards];
        }

        // Check for 66 points
        if (winner.points >= 66) {
            return this.endRound(winner, this.players.find(p => p.socketId !== winner.socketId), trickCards);
        }

        // Winner leads next
        this.turnIndex = winnerIndex;

        // Deal new cards if talon not empty and NOT CLOSED
        let dealtCards = {};
        if (this.talon.length > 0 && !this.isTalonClosed) {
            // Winner draws first
            const card1 = this.talon.shift();
            winner.hand.push(card1);
            dealtCards[winner.socketId] = card1;

            // Loser draws second
            const loserIndex = (winnerIndex + 1) % 2;
            const loser = this.players[loserIndex];

            let card2;
            if (this.talon.length > 0) {
                card2 = this.talon.shift();
            } else {
                card2 = this.trumpCard; // Last card is trump
                this.trumpCard = null; // Picked up
            }
            loser.hand.push(card2);
            dealtCards[loser.socketId] = card2;
        }

        // Check if hands are empty (Game Over)
        // Case 1: Talon empty/exhausted (Standard) -> Last trick winner wins
        // Case 2: Talon CLOSED (Special) -> Closer loses if they haven't reached 66

        const isGameEnd = winner.hand.length === 0 && (this.talon.length === 0 || this.isTalonClosed);

        if (isGameEnd) {
            let roundWinner = winner;
            let roundLoser = this.players.find(p => p.socketId !== winner.socketId);

            if (this.isTalonClosed) {
                // If closed, the closer MUST have won by now (reached 66).
                // If we are here, the closer FAILED.
                if (this.talonCloser === winner.socketId) {
                    // Winner of last trick was the closer, but didn't reach 66? Closer LOSES.
                    roundWinner = roundLoser;
                    roundLoser = this.players.find(p => p.socketId !== roundWinner.socketId);
                } else {
                    // Winner of last trick was NOT the closer. Closer (loser) failed.
                    // roundWinner is already correct (the non-closer).
                }
            } else if (this.talon.length === 0 && this.trumpCard === null) {
                // Normal end: Last trick wins
                // roundWinner is already set to winner of last trick
            }

            return this.endRound(roundWinner, roundLoser, trickCards);
        }

        return {
            valid: true,
            action: 'TRICK_COMPLETE',
            trickCards,
            winnerId: winner.socketId,
            points, // Points of this trick
            winnerTotalPoints: winner.points, // Total points of winner
            loserTotalPoints: this.players.find(p => p.socketId !== winner.socketId).points, // Total points of loser
            dealtCards,
            winnerFirstTrick: winner.firstTrick, // Send winner's first trick (might be same as before or new)
            talonSize: this.talon.length + (this.trumpCard ? 1 : 0),
            isTalonClosed: this.isTalonClosed
        };
    }

    closeTalon(socketId) {
        const playerIndex = this.players.findIndex(p => p.socketId === socketId);
        if (playerIndex !== this.turnIndex) {
            return { valid: false, message: 'Nicht dein Zug!' };
        }

        if (this.talon.length === 0) {
            return { valid: false, message: 'Talon ist leer!' };
        }

        if (this.isTalonClosed) {
            return { valid: false, message: 'Talon ist bereits zu!' };
        }

        this.isTalonClosed = true;
        this.talonCloser = socketId;

        return {
            valid: true,
            message: 'Talon zugedreht!',
            closer: socketId
        };
    }

    resetRound() {
        this.gameState = 'DEALING';
        // Alternate Dealer
        this.dealerIndex = (this.dealerIndex + 1) % 2;
        // Non-Dealer (Vorhand) starts
        this.turnIndex = (this.dealerIndex + 1) % 2;

        this.players.forEach(p => p.resetForNewGame());
        this.deck = [];
        this.talon = [];
        this.trumpCard = null;
        this.trumpSuit = null;
        this.activeSuit = null;
        this.currentTrick = [];
        this.isTalonClosed = false;
        this.talonCloser = null;
        this.announcements = [];
        this.startRound();
    }

    generateDeck() {
        const suits = ['HEARTS', 'DIAMONDS', 'SPADES', 'CLUBS'];
        const ranks = [
            { name: 'A', value: 11 },
            { name: '10', value: 10 },
            { name: 'K', value: 4 },
            { name: 'Q', value: 3 },
            { name: 'J', value: 2 }
        ];

        this.deck = [];
        for (const suit of suits) {
            for (const rank of ranks) {
                this.deck.push({
                    suit: suit,
                    rank: rank.name,
                    value: rank.value
                });
            }
        }
    }

    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards() {
        // Deal 3 cards to each player
        for (let i = 0; i < 2; i++) {
            this.players[i].hand.push(...this.deck.splice(0, 3));
        }

        // Deal 2 cards to each player
        for (let i = 0; i < 2; i++) {
            this.players[i].hand.push(...this.deck.splice(0, 2));
        }

        // Next card is trump
        this.trumpCard = this.deck.shift();
        this.trumpSuit = this.trumpCard.suit;

        // Remaining is talon
        this.talon = [...this.deck];
        this.deck = []; // Clear deck as it's now in talon
    }

    startRound() {
        this.generateDeck();
        this.shuffleDeck();
        this.dealCards();
        this.gameState = 'PLAYER_TURN';
        // this.turnIndex = 0; // Don't reset here, handled in resetRound or initially
    }

    addPlayer(player) {
        if (this.players.length >= 2) return false;
        this.players.push(player);
        return true;
    }

    removePlayer(socketId) {
        this.players = this.players.filter(p => p.socketId !== socketId);
    }

    getPlayer(socketId) {
        return this.players.find(p => p.socketId === socketId);
    }

    isEmpty() {
        return this.players.length === 0;
    }

    isFull() {
        return this.players.length === 2;
    }

    endRound(winner, loser, trickCards) {
        this.gameState = 'ROUND_OVER';

        // Calculate Game Points (Bummerl)
        // Standard Schnapsen:
        // 3 points if loser has 0 points (Schneider/Schwarz in this context usually treated same for points or 3)
        // 2 points if loser has < 33 points
        // 1 point otherwise

        // Special case: Closed Talon
        // If the WINNER closed the talon, normal rules usually apply or better.
        // If the LOSER closed the talon (and failed), the WINNER gets higher points (usually 2 or 3).
        // Let's implement standard first:

        let bummerlLoss = 1;
        if (loser.points === 0) {
            bummerlLoss = 3;
        } else if (loser.points < 33) {
            bummerlLoss = 2;
        }

        // Check if Loser closed the talon (and thus failed)
        // In Schnapsen: If you close and lose, opponent gets 2 points (or 3 if you have 0? No, usually fixed penalty).
        // Let's stick to standard logic: If talon closer loses, they lose big.
        if (this.isTalonClosed && this.talonCloser === loser.socketId) {
            // Creating a penalty logic: Winner gets max points usually, e.g. 3.
            // Or at least 2.
            bummerlLoss = Math.max(bummerlLoss, 2);

            // Special Rule: If Opponent (Winner) has 0 tricks, it's Schneider -> 3 Bummerl
            if (winner.tricks.length === 0) {
                bummerlLoss = 3;
            }

            if (loser.points === 0) bummerlLoss = 3;
        }

        winner.bummerlPoints += bummerlLoss;
        // Loser Bummerl stays same

        // Check Match Over
        let matchOver = false;
        if (winner.bummerlPoints >= 7) {
            matchOver = true;
            this.gameState = 'GAME_OVER';
        }

        return {
            valid: true,
            action: 'ROUND_OVER',
            winnerId: winner.socketId,
            bummerlLoss,
            winnerBummerl: winner.bummerlPoints,
            loserBummerl: loser.bummerlPoints,
            winnerTotalPoints: winner.points,
            loserTotalPoints: loser.points,
            trickCards,
            matchOver
        };
    }
    resetMatch() {
        this.resetRound();
        this.players.forEach(p => {
            p.bummerlPoints = 0;
        });
    }
}

module.exports = Room;
