package server

import (
	"context"
	"net/http"
	"time"

	"artiface/internal/config"
	"artiface/internal/storage"
)

type sourceSelection struct {
	Host   string  `json:"host"`
	Target *string `json:"target"`
	Kind   string  `json:"kind"`
}

func sourceKind(host config.Host) string {
	if host.Kind == "" {
		return "ssh"
	}
	return host.Kind
}

// Append a virtual local entry without changing existing source order or IDs.
func withLocalSource(hosts []config.Host) []config.Host {
	used := map[string]bool{}
	for _, host := range hosts {
		if host.Kind == "local" {
			return hosts
		}
		used[host.ID] = true
	}
	id := "local"
	if used[id] {
		id = config.UniqueID("local", "server-machine", used)
	}
	return append(hosts, config.Host{ID: id, Label: "localhost", Kind: "local", Roots: []config.Root{}})
}

func selectSource(hosts []config.Host, selection sourceSelection) (config.Host, error) {
	if selection.Kind != "" && selection.Kind != "local" && selection.Kind != "ssh" {
		return config.Host{}, errHostTarget
	}
	available := withLocalSource(append([]config.Host(nil), hosts...))
	for _, host := range available {
		if selection.Host != "" {
			if host.ID != selection.Host {
				continue
			}
		} else if selection.Kind == "local" {
			if host.Kind != "local" {
				continue
			}
		} else if selection.Target == nil || host.Target != *selection.Target || host.Kind == "local" {
			continue
		}
		if selection.Target != nil && host.Target != *selection.Target ||
			selection.Kind != "" && selection.Kind != sourceKind(host) {
			return config.Host{}, errHostTarget
		}
		return host, nil
	}
	if selection.Host != "" || selection.Kind == "local" || selection.Target == nil {
		return config.Host{}, errHostTarget
	}
	used := map[string]bool{}
	for _, host := range available {
		used[host.ID] = true
	}
	target := *selection.Target
	return config.Host{ID: config.UniqueID("ssh", target, used), Label: target, Target: target,
		Kind: selection.Kind, Roots: []config.Root{}}, nil
}

func persistSource(cfg *config.Config, selected config.Host) {
	if selected.Kind == "local" {
		cfg.HideLocalSource = false
	}
	for _, host := range cfg.Hosts {
		if host.ID == selected.ID {
			return
		}
	}
	cfg.Hosts = append(cfg.Hosts, selected)
}

func (a *App) folders(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		sourceSelection
		Path string `json:"path"`
	}
	if !decode(w, r, &body) {
		return
	}
	browser, ok := a.store.(storage.FolderBrowser)
	if !ok {
		storageError(w, storage.ErrUnsupported)
		return
	}
	selected, err := selectSource(a.hostSnapshot(), body.sourceSelection)
	if err == nil {
		err = a.validateSource(selected)
	}
	if err != nil {
		setupError(w, err)
		return
	}
	if !a.sshAvailable(w, selected.Target) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	listing, err := browser.BrowseFolders(ctx, selected.Target, body.Path)
	if err != nil {
		storageError(w, err)
		return
	}
	if listing.Entries == nil {
		listing.Entries = []storage.Entry{}
	}
	respond(w, http.StatusOK, listing)
}
