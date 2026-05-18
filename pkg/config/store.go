package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type ClusterProfile struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	KubeconfigData  string `json:"kubeconfig_data"`
	TerminalCommand string `json:"terminal_command"`
}

type Store struct {
	Clusters []ClusterProfile `json:"clusters"`
}

func getConfigFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".kubectl-control.enc"), nil
}

// Save writes the store encrypted to the config file
func Save(store *Store, password string) error {
	data, err := json.Marshal(store)
	if err != nil {
		return err
	}

	encryptedData, err := Encrypt(data, password)
	if err != nil {
		return err
	}

	filePath, err := getConfigFile()
	if err != nil {
		return err
	}

	return os.WriteFile(filePath, encryptedData, 0600)
}

// Load reads the store from the encrypted config file
func Load(password string) (*Store, error) {
	filePath, err := getConfigFile()
	if err != nil {
		return nil, err
	}

	encryptedData, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return &Store{Clusters: []ClusterProfile{}}, nil // Return empty store if not exists
		}
		return nil, err
	}

	data, err := Decrypt(encryptedData, password)
	if err != nil {
		return nil, err
	}

	var store Store
	if err := json.Unmarshal(data, &store); err != nil {
		return nil, err
	}

	return &store, nil
}

// Exists checks if the config file exists
func Exists() (bool, error) {
	filePath, err := getConfigFile()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
