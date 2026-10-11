// Package web contains the compiled browser application.
package web

import (
	"embed"
	"io/fs"
)

// Include the placeholder so the Go server also builds before npm run build.
//
//go:embed all:dist
var assets embed.FS

// Assets returns the application assets rooted at dist.
// Before a frontend build, index.html is absent and the server can show setup guidance.
func Assets() (fs.FS, error) {
	return fs.Sub(assets, "dist")
}
