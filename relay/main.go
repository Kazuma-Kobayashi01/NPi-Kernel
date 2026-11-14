// npi-relay routes NPi Remote Connect traffic between a host (`npi remote start --relay`)
// and its paired phones. Payloads are end-to-end encrypted; the Relay only reads
// routing headers, authenticates bearer tokens by hash, and sends FCM wake-ups.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("relay stopped", "err", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	_, port, err := net.SplitHostPort(env("RELAY_LISTEN", ":8787"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run(log *slog.Logger) error {
	maxHosts, err := strconv.Atoi(env("RELAY_MAX_HOSTS", "16"))
	if err != nil || maxHosts < 1 {
		return errors.New("RELAY_MAX_HOSTS must be a positive integer")
	}
	ackTimeout, err := time.ParseDuration(env("RELAY_PUSH_ACK_TIMEOUT", "2s"))
	if err != nil || ackTimeout <= 0 {
		return errors.New("RELAY_PUSH_ACK_TIMEOUT must be a positive duration")
	}
	store, err := OpenStore(env("RELAY_DB", "/data/relay.db"))
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer store.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var pusher Pusher
	if path := os.Getenv("RELAY_FCM_CREDENTIALS"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read FCM credentials: %w", err)
		}
		fcm, err := NewFCMPusher(context.Background(), data)
		if err != nil {
			return fmt.Errorf("FCM credentials: %w", err)
		}
		pusher = fcm
		log.Info("push enabled")
	} else {
		log.Warn("RELAY_FCM_CREDENTIALS not set; push disabled")
	}

	relay := NewServer(Config{MaxHosts: maxHosts, PushAckTimeout: ackTimeout}, store, pusher, log)
	httpServer := &http.Server{
		Addr:              env("RELAY_LISTEN", ":8787"),
		Handler:           relay.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.ListenAndServe() }()
	log.Info("relay listening", "addr", httpServer.Addr)

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}
	relay.Close()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}
