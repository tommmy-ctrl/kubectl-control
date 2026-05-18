package ui

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
	"kubectl-control/pkg/config"
	"github.com/google/uuid"
)

func ShowEditCluster(window fyne.Window, store *config.Store, password string, cluster *config.ClusterProfile, onSave func()) {
	isNew := cluster == nil

	nameEntry := widget.NewEntry()
	nameEntry.SetPlaceHolder("e.g. Production Cluster")

	kubeconfigEntry := widget.NewMultiLineEntry()
	kubeconfigEntry.SetPlaceHolder("Paste kubeconfig YAML here...")
	kubeconfigEntry.Wrapping = fyne.TextWrapOff

	terminalEntry := widget.NewEntry()
	terminalEntry.SetPlaceHolder("Leave empty for system default, or e.g. 'gnome-terminal', 'powershell'")

	if !isNew {
		nameEntry.SetText(cluster.Name)
		kubeconfigEntry.SetText(cluster.KubeconfigData)
		terminalEntry.SetText(cluster.TerminalCommand)
	}

	form := &widget.Form{
		Items: []*widget.FormItem{
			{Text: "Name", Widget: nameEntry},
			{Text: "Kubeconfig", Widget: kubeconfigEntry},
			{Text: "Terminal Override", Widget: terminalEntry},
		},
		OnCancel: func() {
			onSave() // Go back to dashboard without saving
		},
		OnSubmit: func() {
			if nameEntry.Text == "" || kubeconfigEntry.Text == "" {
				dialog.ShowInformation("Error", "Name and Kubeconfig cannot be empty", window)
				return
			}

			if isNew {
				newCluster := config.ClusterProfile{
					ID:              uuid.New().String(),
					Name:            nameEntry.Text,
					KubeconfigData:  kubeconfigEntry.Text,
					TerminalCommand: terminalEntry.Text,
				}
				store.Clusters = append(store.Clusters, newCluster)
			} else {
				// Update existing
				for i, c := range store.Clusters {
					if c.ID == cluster.ID {
						store.Clusters[i].Name = nameEntry.Text
						store.Clusters[i].KubeconfigData = kubeconfigEntry.Text
						store.Clusters[i].TerminalCommand = terminalEntry.Text
						break
					}
				}
			}

			err := config.Save(store, password)
			if err != nil {
				dialog.ShowError(err, window)
				return
			}

			onSave() // Refresh dashboard
		},
	}

	title := "Add New Cluster"
	if !isNew {
		title = "Edit Cluster"
	}

	content := container.NewVBox(
		widget.NewLabelWithStyle(title, fyne.TextAlignCenter, fyne.TextStyle{Bold: true}),
		form,
	)

	window.SetContent(content)
}
