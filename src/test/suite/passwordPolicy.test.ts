import * as assert from 'assert';
import { MIN_PASSWORD_LENGTH, validateNewPassword, isBelowMinimum } from '../../passwordPolicy';

suite('passwordPolicy', () => {
    test('minimum length is 12', () => {
        assert.strictEqual(MIN_PASSWORD_LENGTH, 12);
    });

    test('new passwords shorter than the minimum are rejected', () => {
        assert.ok(validateNewPassword(undefined));
        assert.ok(validateNewPassword(''));
        assert.ok(validateNewPassword('123456'));
        assert.ok(validateNewPassword('a'.repeat(11)));
    });

    test('new passwords of at least the minimum are accepted', () => {
        assert.strictEqual(validateNewPassword('a'.repeat(12)), undefined);
        assert.strictEqual(validateNewPassword('correct horse battery staple'), undefined);
    });

    test('isBelowMinimum flags existing short passwords', () => {
        assert.strictEqual(isBelowMinimum('secret'), true);
        assert.strictEqual(isBelowMinimum('a'.repeat(12)), false);
    });
});
