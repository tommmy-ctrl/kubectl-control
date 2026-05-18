package config

import (
	"testing"
	"github.com/stretchr/testify/assert"
)

func TestEncryptDecrypt(t *testing.T) {
	password := "supersecret"
	data := []byte("hello world")

	encrypted, err := Encrypt(data, password)
	assert.NoError(t, err)
	assert.NotEqual(t, data, encrypted)

	decrypted, err := Decrypt(encrypted, password)
	assert.NoError(t, err)
	assert.Equal(t, data, decrypted)
}

func TestDecryptWrongPassword(t *testing.T) {
	password := "supersecret"
	wrongPassword := "wrong"
	data := []byte("hello world")

	encrypted, err := Encrypt(data, password)
	assert.NoError(t, err)

	_, err = Decrypt(encrypted, wrongPassword)
	assert.Error(t, err)
}
