import * as assert from 'assert';
import { encryptData, decryptData, isEncryptedFile, deriveHash } from '../../crypto';

suite('crypto', () => {
    test('encryptData/decryptData round-trip', () => {
        const plaintext = 'hello kubernetes world';
        const password = 'supersecret';
        const payload = encryptData(plaintext, password);
        const result = decryptData(payload, password);
        assert.strictEqual(result, plaintext);
    });

    test('decryptData throws with wrong password', () => {
        const payload = encryptData('secret data', 'correct-password');
        assert.throws(() => decryptData(payload, 'wrong-password'));
    });

    test('isEncryptedFile returns true for valid payload', () => {
        const payload = encryptData('test', 'pw');
        assert.strictEqual(isEncryptedFile(payload), true);
    });

    test('isEncryptedFile returns false for plain object', () => {
        assert.strictEqual(isEncryptedFile({ foo: 'bar' }), false);
        assert.strictEqual(isEncryptedFile(null), false);
        assert.strictEqual(isEncryptedFile('string'), false);
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
