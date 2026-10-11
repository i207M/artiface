GO ?= go
NPM ?= npm
ARTIFACE_BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

.PHONY: setup build web-build test browser-test smoke

setup:
	$(GO) mod download
	$(NPM) ci --prefix web

web-build:
	$(NPM) run build --prefix web

build: web-build
	mkdir -p bin
	$(GO) build -trimpath -ldflags="-X artiface/internal/buildinfo.BuildTime=$(ARTIFACE_BUILD_TIME)" -o bin/artiface ./cmd/artiface

test:
	$(GO) test -race ./...
	$(GO) vet ./...
	$(NPM) run typecheck --prefix web
	node scripts/pdf-cache-test.mjs
	node scripts/pdf-find-regression.mjs
	node scripts/image-view-regression.mjs
	node scripts/csv-test.mjs

browser-test:
	node scripts/ssh-host-key-regression.mjs
	node scripts/ssh-host-form-regression.mjs
	node scripts/ssh-removal-regression.mjs
	node scripts/file-refresh.mjs
	node scripts/copy-path-regression.mjs
	node scripts/git-browser-regression.mjs
	node scripts/reader-cache-regression.mjs
	node scripts/login-regression.mjs
	node scripts/markdown-reader.mjs
	node scripts/markdown-outline.mjs
	node scripts/popover-regression.mjs
	node scripts/sidebar-resize-regression.mjs
	node scripts/browse-paging-regression.mjs
	node scripts/folder-picker-regression.mjs
	node scripts/project-setup-regression.mjs
	node scripts/settings-drafts-regression.mjs
	node scripts/pdf-find-browser.mjs
	node scripts/pdf-navigation-regression.mjs
	node scripts/pdf-revalidation-regression.mjs
	node scripts/pdf-overview-regression.mjs
	node scripts/image-view-browser.mjs
	node scripts/source-highlight-regression.mjs
	node scripts/workspace-sources.mjs
	node scripts/reader-view.mjs
	node scripts/access-settings-regression.mjs

smoke: build
	python3 scripts/smoke.py --browser
	node scripts/team-smoke.mjs
	$(MAKE) browser-test
