package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"golang.org/x/crypto/pbkdf2"
	"io"
)

const (
	saltSize   = 16
	nonceSize  = 12
	iterations = 100000
	keySize    = 32
)

// Encrypt encrypts data using AES-GCM with a key derived from password
func Encrypt(data []byte, password string) ([]byte, error) {
	salt := make([]byte, saltSize)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}

	key := pbkdf2.Key([]byte(password), salt, iterations, keySize, sha256.New)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	ciphertext := aesgcm.Seal(nil, nonce, data, nil)

	// Result: salt + nonce + ciphertext
	result := append(salt, nonce...)
	result = append(result, ciphertext...)

	return result, nil
}

// Decrypt decrypts data using AES-GCM with a key derived from password
func Decrypt(data []byte, password string) ([]byte, error) {
	if len(data) < saltSize+nonceSize {
		return nil, errors.New("ciphertext too short")
	}

	salt := data[:saltSize]
	nonce := data[saltSize : saltSize+nonceSize]
	ciphertext := data[saltSize+nonceSize:]

	key := pbkdf2.Key([]byte(password), salt, iterations, keySize, sha256.New)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	plaintext, err := aesgcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, errors.New("incorrect password or corrupted data")
	}

	return plaintext, nil
}
