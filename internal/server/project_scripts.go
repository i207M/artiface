package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"artiface/internal/config"
)

// Bind consent to the source shown in the report, without overwriting unrelated
// settings or granting trust to a replacement folder with the same project ID.
func projectTrustRevision(host config.Host, root config.Root) string {
	host.Roots = []config.Root{root}
	data, _ := json.Marshal(host)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (a *App) allowProjectScripts(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		Host     string `json:"host"`
		Root     string `json:"root"`
		Revision string `json:"revision"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Host == "" || body.Root == "" || len(body.Revision) != 64 {
		fail(w, http.StatusBadRequest, "A project and its original revision are required")
		return
	}
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	cfg, err := config.Update(a.configFile, func(c *config.Config) error {
		for i := range c.Hosts {
			host := &c.Hosts[i]
			if host.ID != body.Host || host.Hidden {
				continue
			}
			for j := range host.Roots {
				root := &host.Roots[j]
				if root.ID != body.Root || root.Hidden {
					continue
				}
				if projectTrustRevision(*host, *root) != body.Revision {
					return config.ErrConflict
				}
				root.TrustedScripts = true
				return nil
			}
		}
		return config.ErrConflict
	})
	if err != nil {
		if errors.Is(err, config.ErrConflict) {
			fail(w, http.StatusConflict, "This project changed. Reload the report before allowing JavaScript.")
		} else {
			fail(w, http.StatusInternalServerError, "Could not save the project's script permission")
		}
		return
	}
	a.adoptSources(cfg)
	respond(w, http.StatusOK, map[string]bool{"trustedScripts": true})
}
