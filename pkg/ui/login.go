package ui

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
	"kubectl-control/pkg/config"
)

// ShowLoginScreen displays the login or setup screen depending on config existence
func ShowLoginScreen(window fyne.Window, onSuccess func(store *config.Store, password string)) {
	exists, err := config.Exists()
	if err != nil {
		dialog.ShowError(err, window)
		return
	}

	if exists {
		showPasswordPrompt(window, onSuccess)
	} else {
		showSetupPrompt(window, onSuccess)
	}
}

func showPasswordPrompt(window fyne.Window, onSuccess func(store *config.Store, password string)) {
	passwordEntry := widget.NewPasswordEntry()
	passwordEntry.SetPlaceHolder("Enter Master Password")

	var form *widget.Form
	form = &widget.Form{
		Items: []*widget.FormItem{
			{Text: "Password", Widget: passwordEntry},
		},
		OnSubmit: func() {
			pwd := passwordEntry.Text
			if pwd == "" {
				dialog.ShowInformation("Error", "Password cannot be empty", window)
				return
			}

			store, err := config.Load(pwd)
			if err != nil {
				dialog.ShowInformation("Error", "Incorrect password or corrupted data", window)
				return
			}

			onSuccess(store, pwd)
		},
	}

	content := container.NewVBox(
		widget.NewLabel("Enter your Master Password to unlock your configurations."),
		form,
	)

	window.SetContent(content)
}

func showSetupPrompt(window fyne.Window, onSuccess func(store *config.Store, password string)) {
	passwordEntry := widget.NewPasswordEntry()
	passwordEntry.SetPlaceHolder("Enter New Master Password")

	confirmEntry := widget.NewPasswordEntry()
	confirmEntry.SetPlaceHolder("Confirm Master Password")

	var form *widget.Form
	form = &widget.Form{
		Items: []*widget.FormItem{
			{Text: "Password", Widget: passwordEntry},
			{Text: "Confirm", Widget: confirmEntry},
		},
		OnSubmit: func() {
			pwd := passwordEntry.Text
			if pwd == "" {
				dialog.ShowInformation("Error", "Password cannot be empty", window)
				return
			}
			if pwd != confirmEntry.Text {
				dialog.ShowInformation("Error", "Passwords do not match", window)
				return
			}

			store := &config.Store{Clusters: []config.ClusterProfile{}}
			err := config.Save(store, pwd)
			if err != nil {
				dialog.ShowError(err, window)
				return
			}

			onSuccess(store, pwd)
		},
	}

	content := container.NewVBox(
		widget.NewLabel("Welcome! Set a Master Password to encrypt your configurations."),
		form,
	)

	window.SetContent(content)
}
