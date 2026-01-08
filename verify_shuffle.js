const Room = require('./server/game/Room');
const Player = require('./server/game/Player');

console.log('--- Shuffle Verification ---');

function runTest(iteration) {
    const room = new Room('TEST-' + iteration);
    const p1 = new Player('socket1', 'Alice', 'p1');
    const p2 = new Player('socket2', 'Bob', 'p2');

    room.addPlayer(p1);
    room.addPlayer(p2);

    room.startRound();

    console.log(`[Iteration ${iteration}]`);
    console.log('Alice Hand:', p1.hand.map(c => `${c.suit}-${c.rank}`).join(', '));
    console.log('Bob Hand:  ', p2.hand.map(c => `${c.suit}-${c.rank}`).join(', '));
    console.log('Trump:     ', `${room.trumpCard.suit}-${room.trumpCard.rank}`);
    console.log('--------------------------------');
}

runTest(1);
runTest(2);
runTest(3);
