package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInvalidSSHEnvironmentDoesNotInitializeConfiguration(t *testing.T) {
	t.Setenv("ARTIFACE_MODE", "personal")
	for _, value := range []string{"tru", "disabled", " false "} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("ARTIFACE_DISABLE_SSH", value)
			directory := filepath.Join(t.TempDir(), "state")
			err := run([]string{"serve", "--config", filepath.Join(directory, "config.json")}, nil, io.Discard, io.Discard)
			if err == nil || !strings.Contains(err.Error(), "ARTIFACE_DISABLE_SSH") {
				t.Fatalf("invalid SSH policy was accepted: %v", err)
			}
			if _, err := os.Stat(directory); !os.IsNotExist(err) {
				t.Fatal("invalid startup created configuration files")
			}
		})
	}
}

func TestListenAddressUsesConfiguredIPFamily(t *testing.T) {
	for _, ip := range []string{"127.0.0.2", "0.0.0.0", "::1", "::"} {
		t.Run(ip, func(t *testing.T) {
			if strings.Contains(ip, ":") {
				probe, err := net.Listen("tcp6", "[::1]:0")
				if err != nil {
					t.Skipf("IPv6 is unavailable on this host: %v", err)
				}
				probe.Close()
			}
			listener, err := listenAddress(net.JoinHostPort(ip, "0"))
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			got := listener.Addr().(*net.TCPAddr)
			if got.IP.String() != ip || got.Port == 0 {
				t.Fatalf("bound %s instead of %s", got, ip)
			}
		})
	}
}

func TestServeHTTPShutdown(t *testing.T) {
	for _, phase := range []string{"before serving", "after request"} {
		t.Run(phase, func(t *testing.T) {
			listener, err := listenAddress("127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			app := newHTTPServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, "ready")
			}))
			defer app.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if phase == "before serving" {
				cancel()
			}
			done := make(chan error, 1)
			go func() { done <- serveHTTP(ctx, cancel, app, listener) }()
			if phase == "after request" {
				client := &http.Client{Timeout: 3 * time.Second}
				defer client.CloseIdleConnections()
				response, err := client.Get("http://" + listener.Addr().String())
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(response.Body)
				response.Body.Close()
				if err != nil || string(body) != "ready" {
					t.Fatal("server did not handle its request")
				}
				cancel()
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("server shutdown stalled")
			}
			rebound, err := net.Listen("tcp4", listener.Addr().String())
			if err != nil {
				t.Fatalf("shutdown leaked its listener: %v", err)
			}
			rebound.Close()
		})
	}
}
