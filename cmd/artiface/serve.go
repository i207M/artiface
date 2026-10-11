package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"artiface/internal/config"
	"artiface/internal/ignore"
	"artiface/internal/server"
	"artiface/internal/sshvault"
	"artiface/internal/storage"
	"artiface/web"
)

func serve(filename string, output io.Writer, initial config.Config, mode string) error {
	if mode != "" && mode != "personal" && mode != "team" {
		return errors.New("mode must be personal or team")
	}
	disableSSH := false
	if value := os.Getenv("ARTIFACE_DISABLE_SSH"); value != "" {
		var err error
		disableSSH, err = strconv.ParseBool(value)
		if err != nil {
			return errors.New("ARTIFACE_DISABLE_SSH must be true or false")
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := loadOrCreateConfig(filename, initial, output)
	if err != nil {
		return err
	}
	if mode != "" {
		cfg.Mode = mode
	}
	if err := config.CleanupSSHCredentials(filename); err != nil {
		fmt.Fprintln(output, "Warning: could not remove an unused SSH credential revision.")
	}
	if err := ignore.EnsureDefaults(filename); err != nil {
		fmt.Fprintf(output, "Warning: could not initialize %s: %v\n", ignore.Filename, err)
	}
	assets, err := web.Assets()
	if err == nil {
		_, err = fs.Stat(assets, "index.html")
	}
	if err != nil {
		return fmt.Errorf("frontend assets are unavailable; from the source directory run 'npm --prefix web install && npm --prefix web run build', then rebuild artiface: %w", err)
	}
	credentials := sshvault.NewRuntime(cfg.SSHCredentials, disableSSH)
	defer credentials.Close()
	store := storage.NewWithSSH(credentials.DialSFTP)
	defer store.Close()
	app, err := server.New(cfg, store, assets, server.WithConfigFile(filename), server.WithSSHCredentials(credentials))
	if err != nil {
		return fmt.Errorf("initialize application: %w", err)
	}
	defer app.Close()
	origin, _ := cfg.Origins()
	listener, err := listenAddress(cfg.Listen)
	if err != nil {
		return fmt.Errorf("bind application listener: %w", err)
	}
	defer listener.Close()
	appServer := newHTTPServer(app.Handler())
	if _, err := fmt.Fprintf(output, "Artiface: %s\nMode: %s\nConfiguration: %s\n", origin, cfg.ModeName(), filename); err != nil {
		return err
	}
	if credentials.Disabled() {
		fmt.Fprintln(output, "SSH connectivity is disabled for this run. Local projects remain available.")
	} else if credentials.Locked() {
		fmt.Fprintln(output, "SSH credentials are locked. Sign in as the personal owner or at /admin/ to unlock them.")
	}
	return serveHTTP(ctx, stop, appServer, listener)
}

func listenAddress(address string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	network := "tcp4"
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		network = "tcp6"
	}
	return net.Listen(network, address)
}

func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func serveHTTP(ctx context.Context, stop context.CancelFunc, appServer *http.Server, listener net.Listener) error {
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- appServer.Serve(listener)
	}()

	var serveErr error
	stopped := false
	select {
	case <-ctx.Done():
		// A second signal can immediately terminate a stalled shutdown.
		stop()
	case serveErr = <-serveErrors:
		stopped = true
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var result error
	if err := appServer.Shutdown(shutdownCtx); err != nil {
		appServer.Close()
		result = fmt.Errorf("shut down HTTP: %w", err)
	}
	if !stopped {
		serveErr = <-serveErrors
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		result = errors.Join(result, fmt.Errorf("serve HTTP: %w", serveErr))
	}
	return result
}
