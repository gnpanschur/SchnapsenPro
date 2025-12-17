class Player {
    constructor(socketId, name, playerId) {
        this.socketId = socketId;
        this.name = name;
        this.id = playerId; // Persistent ID
        this.hand = [];
        this.tricks = []; // Won tricks
        this.points = 0; // Current game points (66 limit)
        this.bummerlPoints = 0; // Game points (Bummerl), counts 0 to 7
        this.connected = true;
        this.connected = true;
        this.reconnectTimer = null;
        this.constraint = null; // { type: 'MUST_PLAY_MARRIAGE', suit: 'HEARTS' }
    }

    resetForNewGame() {
        this.hand = [];
        this.tricks = [];
        this.points = 0;
    }
}

module.exports = Player;
