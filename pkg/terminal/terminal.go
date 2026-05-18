package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"kubectl-control/pkg/config"
)

// Launch creates a temp kubeconfig and starts a terminal session
func Launch(cluster config.ClusterProfile) error {
	// Create a secure temporary file for the kubeconfig
	tempDir := os.TempDir()
	tempFile, err := os.CreateTemp(tempDir, fmt.Sprintf("kubeconfig-%s-*.yaml", cluster.ID))
	if err != nil {
		return fmt.Errorf("failed to create temp kubeconfig: %w", err)
	}

	kubeconfigPath := tempFile.Name()

	// Ensure the temp file is only readable by the user
	err = os.Chmod(kubeconfigPath, 0600)
	if err != nil {
		return fmt.Errorf("failed to set permissions on temp file: %w", err)
	}

	_, err = tempFile.WriteString(cluster.KubeconfigData)
	if err != nil {
		tempFile.Close()
		return fmt.Errorf("failed to write kubeconfig data: %w", err)
	}
	tempFile.Close()

	// Launch the terminal
	err = startTerminal(cluster.TerminalCommand, kubeconfigPath)
	if err != nil {
		return fmt.Errorf("failed to launch terminal: %w", err)
	}

	return nil
}

func startTerminal(customCmd string, kubeconfigPath string) error {
	var cmd *exec.Cmd

	if runtime.GOOS == "windows" {
		exe := "cmd.exe"
		args := []string{"/c", "start", "cmd.exe"}
		if customCmd != "" {
			// If custom command is specified, try to run it directly
			exe = customCmd
			args = []string{}
		}
		cmd = exec.Command(exe, args...)
	} else if runtime.GOOS == "linux" {
		// Try custom command first
		if customCmd != "" {
			cmd = exec.Command(customCmd)
		} else {
			// Try to find common terminal emulators
			terminals := []string{"gnome-terminal", "konsole", "xfce4-terminal", "xterm", "alacritty", "kitty"}
			var foundTerm string
			for _, t := range terminals {
				if _, err := exec.LookPath(t); err == nil {
					foundTerm = t
					break
				}
			}

			if foundTerm == "" {
				return fmt.Errorf("no suitable terminal emulator found. Please specify one in the cluster settings")
			}

			cmd = exec.Command(foundTerm)
		}
	} else if runtime.GOOS == "darwin" { // macOS
		if customCmd != "" {
			cmd = exec.Command("open", "-a", customCmd)
		} else {
			cmd = exec.Command("open", "-a", "Terminal")
		}
	} else {
		return fmt.Errorf("unsupported operating system")
	}

	// Set the environment variables, specifically KUBECONFIG
	env := os.Environ()
	env = append(env, fmt.Sprintf("KUBECONFIG=%s", kubeconfigPath))
	cmd.Env = env

	// Start the command asynchronously (don't wait for it to finish)
	err := cmd.Start()
	if err != nil {
		return err
	}

	return nil
}
