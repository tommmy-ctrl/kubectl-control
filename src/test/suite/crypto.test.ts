import * as assert from 'assert';
import { encryptData, decryptData, isEncryptedFile, deriveHash, deriveHashAsync } from '../../crypto';

suite('crypto', () => {
    test('encryptData/decryptData round-trip', async () => {
        const plaintext = 'hello kubernetes world';
        const password = 'supersecret';
        const payload = await encryptData(plaintext, password);
        const result = await decryptData(payload, password);
        assert.strictEqual(result, plaintext);
    });

    test('decryptData throws with wrong password', async () => {
        const payload = await encryptData('secret data', 'correct-password');
        await assert.rejects(decryptData(payload, 'wrong-password'));
    });

    test('isEncryptedFile returns true for valid payload', async () => {
        const payload = await encryptData('test', 'pw');
        assert.strictEqual(isEncryptedFile(payload), true);
    });

    test('isEncryptedFile returns false for plain object', () => {
        assert.strictEqual(isEncryptedFile({ foo: 'bar' }), false);
        assert.strictEqual(isEncryptedFile(null), false);
        assert.strictEqual(isEncryptedFile('string'), false);
    });

    test('deriveHashAsync yields exactly the same hash as deriveHash (existing lock passwords keep working)', async () => {
        assert.strictEqual(await deriveHashAsync('password', 'salt-value'), deriveHash('password', 'salt-value'));
        assert.strictEqual(await deriveHashAsync('ümlaut-pässwort', 'a1b2c3'), deriveHash('ümlaut-pässwort', 'a1b2c3'));
    });

    test('deriveHash is deterministic', () => {
        const h1 = deriveHash('password', 'salt-value');
        const h2 = deriveHash('password', 'salt-value');
        assert.strictEqual(h1, h2);
    });

    test('deriveHash differs for different passwords', () => {
        const h1 = deriveHash('password1', 'same-salt');
        const h2 = deriveHash('password2', 'same-salt');
        assert.notStrictEqual(h1, h2);
    });

    test('deriveHash differs for different salts', () => {
        const h1 = deriveHash('same-password', 'salt-a');
        const h2 = deriveHash('same-password', 'salt-b');
        assert.notStrictEqual(h1, h2);
    });
});
