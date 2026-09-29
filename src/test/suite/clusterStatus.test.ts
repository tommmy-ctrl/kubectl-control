import * as assert from 'assert';
import { runLimited } from '../../clusterStatus';

suite('clusterStatus', () => {
    test('runLimited: never more than `limit` workers in flight, all items processed', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const done: number[] = [];
        await runLimited([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async n => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(r => setTimeout(r, 5));
            done.push(n);
            inFlight--;
        });
        assert.strictEqual(maxInFlight, 3);
        assert.deepStrictEqual(done.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test('runLimited: a failing worker does not stop the others', async () => {
        const done: number[] = [];
        await runLimited([1, 2, 3], 2, async n => {
            if (n === 2) { throw new Error('boom'); }
            done.push(n);
        });
        assert.deepStrictEqual(done.sort(), [1, 3]);
    });

    test('runLimited: empty list resolves immediately', async () => {
        await runLimited([], 3, async () => { throw new Error('must not run'); });
    });
});
