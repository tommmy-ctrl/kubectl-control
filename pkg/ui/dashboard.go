package ui

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/widget"
	"kubectl-control/pkg/config"
	"kubectl-control/pkg/terminal"
)

type Dashboard struct {
	window   fyne.Window
	store    *config.Store
	password string
	list     *widget.List
}

func ShowDashboard(window fyne.Window, store *config.Store, password string) {
	d := &Dashboard{
		window:   window,
		store:    store,
		password: password,
	}
	d.render()
}

func (d *Dashboard) render() {
	d.list = widget.NewList(
		func() int {
			return len(d.store.Clusters)
		},
		func() fyne.CanvasObject {
			// Template for each row
			nameLabel := widget.NewLabel("Cluster Name")
			startBtn := widget.NewButton("Start Terminal", nil)
			editBtn := widget.NewButton("Edit", nil)
			deleteBtn := widget.NewButton("Delete", nil)

			return container.NewBorder(
				nil, nil, nil,
				container.NewHBox(startBtn, editBtn, deleteBtn),
				nameLabel,
			)
		},
		func(i widget.ListItemID, o fyne.CanvasObject) {
			cluster := d.store.Clusters[i]

			// Find components in the template
			border := o.(*fyne.Container)
			nameLabel := border.Objects[0].(*widget.Label)
			buttonsBox := border.Objects[1].(*fyne.Container)

			startBtn := buttonsBox.Objects[0].(*widget.Button)
			editBtn := buttonsBox.Objects[1].(*widget.Button)
			deleteBtn := buttonsBox.Objects[2].(*widget.Button)

			nameLabel.SetText(cluster.Name)

			startBtn.OnTapped = func() {
				err := terminal.Launch(cluster)
				if err != nil {
					dialog.ShowError(err, d.window)
				}
			}

			editBtn.OnTapped = func() {
				ShowEditCluster(d.window, d.store, d.password, &cluster, d.render)
			}

			deleteBtn.OnTapped = func() {
				dialog.ShowConfirm("Delete", "Are you sure you want to delete "+cluster.Name+"?", func(b bool) {
					if b {
						d.deleteCluster(i)
					}
				}, d.window)
			}
		},
	)

	addBtn := widget.NewButton("Add New Cluster", func() {
		ShowEditCluster(d.window, d.store, d.password, nil, d.render)
	})

	content := container.NewBorder(
		container.NewVBox(
			widget.NewLabelWithStyle("Your Kubernetes Clusters", fyne.TextAlignCenter, fyne.TextStyle{Bold: true}),
			layout.NewSpacer(),
		),
		container.NewPadded(addBtn),
		nil,
		nil,
		d.list,
	)

	d.window.SetContent(content)
}

func (d *Dashboard) deleteCluster(index int) {
	// Remove item
	d.store.Clusters = append(d.store.Clusters[:index], d.store.Clusters[index+1:]...)

	// Save
	err := config.Save(d.store, d.password)
	if err != nil {
		dialog.ShowError(err, d.window)
		return
	}

	// Re-render
	d.render()
}
