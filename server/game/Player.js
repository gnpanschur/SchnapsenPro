class Player {
    constructor(socketId, name, playerId) {
        this.socketId = socketId;
        this.name = name;
        this.id = playerId; // Persistent ID
        this.hand = [];
        this.tricks = []; // Won tricks
        this.points = 0; // Current game points (66 limit)
        this.bummerlPoints = 0; // Game points (Bummerl), counts 0 to 7
        this.matchWins = 0; // Total matches won (persists across rounds, resets per session)
        this.connected = true;
        this.connected = true;
        this.reconnectTimer = null;
        this.pendingPoints = 0; // Points from marriage announcements that are waiting for a trick
        this.firstTrick = null; // Stores the first trick won by this player
        this.constraint = null; // { type: 'MUST_PLAY_MARRIAGE', suit: 'HEARTS' }
    }

    resetForNewGame() {
        this.hand = [];
        this.tricks = [];
        this.points = 0;
        this.pendingPoints = 0;
        this.firstTrick = null;
        this.constraint = null;
    }
}

module.exports = Player;
