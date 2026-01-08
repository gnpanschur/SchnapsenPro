const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:3000';

function createClient(name) {
    return new Promise((resolve) => {
        const socket = io(SERVER_URL);
        socket.on('connect', () => {
            console.log(`[${name}] Connected: ${socket.id}`);
            resolve(socket);
        });
    });
}

async function runTest() {
    console.log('Starting Verification Test...');

    const p1 = await createClient('Player 1');
    const p2 = await createClient('Player 2');

    // Create Room
    console.log('[Step 1] Creating Room...');
    p1.emit('createRoom', { name: 'Tester 1' });

    let roomId;

    // Helper to wait for event
    const waitFor = (socket, event) => new Promise(resolve => {
        socket.once(event, resolve);
    });

    const roomData = await waitFor(p1, 'roomCreated');
    roomId = roomData.roomId;
    console.log(`[Step 1] Room Created: ${roomId}`);

    // Wait for Game Start - Parallel to avoid race conditions
    console.log('[Step 3] Waiting for Game Start...');
    const p1StartPromise = waitFor(p1, 'gameStart');
    const p2StartPromise = waitFor(p2, 'gameStart');

    // Join Room triggers the start
    p2.emit('joinRoom', { roomId, playerName: 'Tester 2' });

    const [p1Start, p2Start] = await Promise.all([p1StartPromise, p2StartPromise]);
    console.log('[Step 3] Game Started!');

    // P1 Hand
    let p1Hand = p1Start.hand;
    let p2Hand = p2Start.hand;
    let isP1Turn = p1Start.isMyTurn;

    // Listen for updates
    p1.on('moveMade', (data) => console.log(`[Game] Move Made by ${data.socketId === p1.id ? 'P1' : 'P2'}: ${data.card.rank}${data.card.suit}`));
    p1.on('trickCompleted', (data) => console.log(`[Game] Trick Completed. Winner: ${data.winnerId === p1.id ? 'P1' : 'P2'}`));
    p1.on('handUpdate', (data) => p1Hand.push(data.newCard));

    // Simulate "Closing Talon"
    // Requirement: It must be P1's turn (if P1 ends up starting)
    // If P2 starts, P2 plays a card, P1 wins/loses.
    // Let's force a scenario where we can close.
    // Only the player whose turn it is can close.

    const activeSocket = isP1Turn ? p1 : p2;
    const passiveSocket = isP1Turn ? p2 : p1;
    const activeName = isP1Turn ? 'Player 1' : 'Player 2';

    console.log(`[Step 4] Attempting to CLOSE TALON by ${activeName}...`);

    activeSocket.emit('closeTalon');

    // We expect 'talonClosed' event or 'error'
    const closeResult = await Promise.race([
        waitFor(p1, 'talonClosed').then(() => 'SUCCESS'),
        waitFor(activeSocket, 'error').then(msg => `ERROR: ${msg}`),
        new Promise(r => setTimeout(() => r('TIMEOUT'), 2000))
    ]);

    console.log(`[Step 4] Close Result: ${closeResult}`);

    if (closeResult === 'SUCCESS') {
        console.log('✅ Talon close handled without crash!');
    } else {
        console.log(`⚠️  Server returned error: ${closeResult}`);
    }

    // Step 5: Verify Strict Rules (Play after close)
    // Now that talon is closed, strict rules apply.
    // Active player (who closed it) must play a card.

    // Let's create a helper to wait for turn
    const waitForTurn = async (socket, name) => {
        // Check if we already received "moveMade" with nextTurn = socket.id
        // But we might have missed it if we weren't listening?
        // We will just listen for next one or assume turn if we just closed?
        // If I close, is it still my turn?
        // Room.js closeTalon logic does NOT change turn.
        // It just marks closed.
        return true;
    };

    console.log(`[Step 5] ${activeName} plays a card...`);
    // Pick a card from hand
    // We need to know which hand is which.
    const activeHand = isP1Turn ? p1Hand : p2Hand;
    if (activeHand.length === 0) {
        console.log('❌ Hand empty, cannot play!');
        return;
    }

    const cardToPlay = activeHand[0];
    console.log(`[Step 5] Playing ${cardToPlay.rank}${cardToPlay.suit}`);

    activeSocket.emit('playCard', cardToPlay);

    const moveData = await waitFor(p1, 'moveMade'); // Everyone gets this
    console.log(`[Step 5] Move accepted: ${moveData.card.rank}${moveData.card.suit}`);

    // Now Passive player must follow suit!
    const passiveHand = isP1Turn ? p2Hand : p1Hand;
    const ledSuit = cardToPlay.suit;

    // Find a card that VIOLATES strict rules (if possible)
    const wrongSuitCard = passiveHand.find(c => c.suit !== ledSuit && c.suit !== moveData.trumpSuit); // Simple check

    if (wrongSuitCard && passiveHand.some(c => c.suit === ledSuit)) {
        console.log(`[Step 6] Attempting REVOKE with ${wrongSuitCard.rank}${wrongSuitCard.suit} (Have ${ledSuit})...`);
        passiveSocket.emit('playCard', wrongSuitCard);

        const errorMsg = await waitFor(passiveSocket, 'error');
        console.log(`[Step 6] Expected Error received: ${errorMsg}`);
        if (errorMsg.includes('Farbzwang')) {
            console.log('✅ Strict Rule Check Passed: Farbzwang enforced.');
        } else {
            console.log('⚠️ Warning: Error message differ from expectation.');
        }

        // Now play correctly
        const correctCard = passiveHand.find(c => c.suit === ledSuit);
        console.log(`[Step 6] Correction: Playing valid card ${correctCard.rank}${correctCard.suit}...`);
        passiveSocket.emit('playCard', correctCard);
    } else {
        console.log('[Step 6] Cannot force revoke (no conflicting cards), playing whatever.');
        passiveSocket.emit('playCard', passiveHand[0]);
    }

    const trickResult = await waitFor(p1, 'trickCompleted');
    console.log(`[Step 7] Trick Complete! Winner: ${trickResult.winnerId === p1.id ? 'P1' : 'P2'}`);

    // Confirm NO new cards dealt (because talon closed)
    console.log(`[Step 7] Talon Size: ${trickResult.talonSize}`);
    console.log(`[Step 7] Dealt Cards: ${JSON.stringify(trickResult.dealtCards)}`);

    if (!trickResult.dealtCards || Object.keys(trickResult.dealtCards).length === 0) {
        console.log('✅ No cards dealt after closed talon (Correct).');
    } else {
        console.log('❌ ERROR: Cards were dealt!');
    }

    // Checking if connection is still alive
    if (p1.connected && p2.connected) {
        console.log('✅ Connections still active.');
    } else {
        console.log('❌ Connection lost!');
    }

    p1.disconnect();
    p2.disconnect();
    process.exit(0);
}

runTest().catch(console.error);
