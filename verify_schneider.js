const io = require('socket.io-client');
const SERVER_URL = 'http://localhost:3000';

const waitFor = (socket, event) => new Promise(resolve => socket.once(event, resolve));

async function runTest() {
    console.log('Starting Schneider Verification Test...');
    const p1 = io(SERVER_URL);
    const p2 = io(SERVER_URL);

    // Setup Room
    p1.emit('createRoom', { name: 'SchneiderTester' });
    const { roomId } = await waitFor(p1, 'roomCreated');
    console.log(`Room: ${roomId}`);

    p2.emit('joinRoom', { roomId, playerName: 'Opponent' });

    // Wait for start
    const [start1, start2] = await Promise.all([
        waitFor(p1, 'gameStart'),
        waitFor(p2, 'gameStart')
    ]);

    // We assume the server is running with a FIXED DECK for this test
    // P1 should receive low cards (Jacks)
    // P2 should receive... well, P1 will start.

    // Sequence:
    // P1 closes Talon immediately.
    // P1 plays 5 cards.
    // P2 plays 5 cards.
    // P1 wins all 5 tricks but gets < 66 pts.
    // Result: P1 loses. P2 wins with 0 tricks. P2 gets 3 Bummerl.

    console.log('Game Started. P1 Hand:', start1.hand.map(c => c.rank).join(','));

    // Step 1: P1 Closes Talon
    console.log('P1 Closing Talon...');
    p1.emit('closeTalon');
    await waitFor(p1, 'talonClosed');
    console.log('Talon Closed.');

    // Step 2: Play 5 tricks
    // We need P1 to win every trick.
    // P1 has J, J, J, J, Q? (Mock deck needed)

    // Simple helper to play round
    async function playTrick(card1, card2) {
        p1.emit('playCard', card1);
        await waitFor(p1, 'moveMade'); // P1 played
        p2.emit('playCard', card2);
        const res = await waitFor(p1, 'trickCompleted');
        console.log(`Trick Winner: ${res.winnerId === p1.id ? 'P1' : 'P2'}`);
        return res;
    }

    // This script relies on manual interaction or a PREDICTABLE deck.
    // I will just wait for the Round Over and print the result.
    // I'll define a set of moves based on the "Low Point Deck" I'll inject.
    // Deck: 
    // P1: J-H, J-D, J-S, J-C, Q-H (Total 2+2+2+2+3 = 11 pts)
    // P2: Q-D, Q-S, Q-C, K-H, K-D (Total 3+3+3+4+4 = 17 pts)
    // P1 plays J-H, P2 plays Q-D (Winner P1? No, P2 wins if suit mismatch? No color constraint?)
    // Wait, Closed Talon = Strict Rules.
    // So P2 must follow suit.
    // P1 leads J-H. P2 has K-H. P2 MUST play K-H. P2 WINS trick.
    // Wait, we need P1 to WIN all tricks.
    // So P1 needs HIGH cards but LOW value? Impossible. A is 11.
    // P1 needs to win against P2.
    // P1 needs TRUMPS.
    // If Trump is Hearts. P1 has H-A, H-10... High points.
    // How to win trick with Low points?
    // P1 plays J-H (Trump). P2 plays something else (Has no hearts).
    // P1 wins (2 pts + x).
    // Can P1 have 5 Trumps?
    // J, Q, K, 10, A. Total 2+3+4+10+11 = 30 pts.
    // P2 throws non-trumps.
    // P1 wins 5 tricks.
    // Total points = 30 + (all P2 cards).
    // P2 cards max points: A(11)*4 is impossible (1 A is trump).
    // Remaining Aces: D-A, S-A, C-A (33).
    // 30 + 33 = 63.
    // 63 < 66.
    // YES!
    // So P1 needs: 5 Trumps (J, Q, K, 10, A).
    // P2 needs: 3 Aces + other stuff.
    // P1 closes.
    // Play:
    // P1: J-H (Trump). P2: D-A. P1 wins (2+11=13).
    // P1: Q-H. P2: S-A. P1 wins (3+11=14).
    // P1: K-H. P2: C-A. P1 wins (4+11=15).
    // P1: 10-H. P2: 10-D. P1 wins (10+10=20).
    // P1: A-H. P2: K-D. P1 wins (11+4=15).
    // Total: 13+14+15+20+15 = 77 ?? 
    // Wait my math. 
    // 13+14=27. +15=42. +20=62. +15=77.
    // P1 made 77 points. Reached 66. P1 WINS.
    // So my "Low Point Victory" strategy is hard.
    // Need P2 to throw LOW cards.
    // P2: J-D, J-S, J-C, Q-D, Q-S.
    // Points thrown: 2+2+2+3+3 = 12.
    // P1 Trumps: 30.
    // Total: 42. < 66.
    // RESULT: P1 wins 5 tricks. Points 42.
    // P1 Closed. P1 Failed (42 < 66).
    // P1 Loses.
    // P2 has 0 tricks.
    // SCHNEIDER!

    // Required Hand Setup:
    // P1: [J-H, Q-H, K-H, 10-H, A-H] (All Trumps)
    // P2: [J-D, J-S, J-C, Q-D, Q-S] (Trash)
    // Trump Suit: HEARTS.

    // We will hardcode this play sequence in the script.

    // Play 1
    console.log('Play 1: JH vs JD');
    await playTrick({ rank: 'J', suit: 'HEARTS' }, { rank: 'J', suit: 'DIAMONDS' });

    // Play 2
    console.log('Play 2: QH vs JS');
    await playTrick({ rank: 'Q', suit: 'HEARTS' }, { rank: 'J', suit: 'SPADES' });

    // Play 3
    console.log('Play 3: KH vs JC');
    await playTrick({ rank: 'K', suit: 'HEARTS' }, { rank: 'J', suit: 'CLUBS' });

    // Play 4
    console.log('Play 4: 10H vs QD');
    await playTrick({ rank: '10', suit: 'HEARTS' }, { rank: 'Q', suit: 'DIAMONDS' });

    // Play 5
    console.log('Play 5: AH vs QS');

    // For the last one, wait for Round Over too
    p1.emit('playCard', { rank: 'A', suit: 'HEARTS' });
    await waitFor(p1, 'moveMade');
    p2.emit('playCard', { rank: 'Q', suit: 'SPADES' });

    const roundOver = await waitFor(p1, 'roundOver');
    console.log('Round Over Result:', roundOver);

    if (roundOver.bummerlLoss === 3) {
        console.log('✅ SUCCESS! Bummerl Loss is 3 (Schneider).');
    } else {
        console.log(`❌ FAILED. Bummerl Loss is ${roundOver.bummerlLoss} (Expected 3).`);
    }

    p1.disconnect();
    p2.disconnect();
}

runTest().catch(console.error);
