import * as nodeCrypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const SALT_LEN = 32;
const IV_LEN = 12;
const ITERATIONS = 200_000;
const DIGEST = 'sha256';

export interface EncryptedFile {
    v: 1;
    salt: string;
    iv: string;
    tag: string;
    data: string;
}

function toHex(bytes: Uint8Array | Buffer): string {
    return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) {
        arr[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return arr;
}

export function encryptData(plaintext: string, password: string): EncryptedFile {
    const salt = nodeCrypto.randomBytes(SALT_LEN);
    const iv = nodeCrypto.randomBytes(IV_LEN);
    const key = nodeCrypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
    const cipher = nodeCrypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
        v: 1,
        salt: toHex(salt),
        iv: toHex(iv),
        tag: toHex(cipher.getAuthTag()),
        data: toHex(encrypted)
    };
}

export function decryptData(payload: EncryptedFile, password: string): string {
    const salt = fromHex(payload.salt);
    const iv = fromHex(payload.iv);
    const tag = fromHex(payload.tag);
    const data = fromHex(payload.data);
    const key = nodeCrypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
    const decipher = nodeCrypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

export function isEncryptedFile(obj: unknown): obj is EncryptedFile {
    return typeof obj === 'object' && obj !== null
        && (obj as EncryptedFile).v === 1
        && typeof (obj as EncryptedFile).salt === 'string';
}

export function deriveHash(password: string, salt: string): string {
    const saltBytes = new TextEncoder().encode(salt);
    return toHex(nodeCrypto.pbkdf2Sync(password, saltBytes, ITERATIONS, 32, DIGEST));
}
