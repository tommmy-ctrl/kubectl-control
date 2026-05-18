package main

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"kubectl-control/pkg/config"
	"kubectl-control/pkg/ui"
)

func main() {
	myApp := app.New()
	myWindow := myApp.NewWindow("Kubectl Control")
	myWindow.Resize(fyne.NewSize(800, 600))

	ui.ShowLoginScreen(myWindow, func(store *config.Store, password string) {
		ui.ShowDashboard(myWindow, store, password)
	})

	myWindow.ShowAndRun()
}
