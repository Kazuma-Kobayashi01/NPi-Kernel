package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2/google"
)

// ErrTokenInvalid means FCM will never accept this registration token again.
var ErrTokenInvalid = errors.New("fcm registration token is invalid")

type PushMessage struct {
	Token        string
	Data         map[string]string
	HighPriority bool
	CollapseKey  string
	TTL          time.Duration
}

type Pusher interface {
	Send(ctx context.Context, msg PushMessage) error
}

// FCMPusher sends data messages through the FCM HTTP v1 API.
type FCMPusher struct {
	client   *http.Client
	endpoint string
}

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

// NewFCMPusher builds a pusher from a Firebase service-account JSON key.
func NewFCMPusher(ctx context.Context, serviceAccountJSON []byte) (*FCMPusher, error) {
	var meta struct {
		ProjectID string `json:"project_id"`
	}
	if err := json.Unmarshal(serviceAccountJSON, &meta); err != nil || meta.ProjectID == "" {
		return nil, errors.New("service account JSON has no project_id")
	}
	cfg, err := google.JWTConfigFromJSON(serviceAccountJSON, fcmScope)
	if err != nil {
		return nil, fmt.Errorf("parse service account: %w", err)
	}
	client := cfg.Client(ctx)
	client.Timeout = 15 * time.Second
	return &FCMPusher{
		client:   client,
		endpoint: "https://fcm.googleapis.com/v1/projects/" + meta.ProjectID + "/messages:send",
	}, nil
}

func (p *FCMPusher) Send(ctx context.Context, msg PushMessage) error {
	android := map[string]any{
		"priority": "NORMAL",
		"ttl":      strconv.Itoa(int(msg.TTL/time.Second)) + "s",
	}
	if msg.HighPriority {
		android["priority"] = "HIGH"
	}
	if msg.CollapseKey != "" {
		android["collapse_key"] = msg.CollapseKey
	}
	body, err := json.Marshal(map[string]any{
		"message": map[string]any{"token": msg.Token, "data": msg.Data, "android": android},
	})
	if err != nil {
		return err
	}
	const maxAttempts = 3
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := p.client.Do(req)
		var status int
		var respBody []byte
		var retryAfter time.Duration
		if err == nil {
			status = resp.StatusCode
			respBody, _ = io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			resp.Body.Close()
			if seconds, convErr := strconv.Atoi(resp.Header.Get("Retry-After")); convErr == nil {
				retryAfter = time.Duration(seconds) * time.Second
			}
		}
		switch {
		case err == nil && status >= 200 && status < 300:
			return nil
		case err == nil && status == http.StatusNotFound:
			return ErrTokenInvalid
		case err == nil && status == http.StatusBadRequest:
			if isInvalidTokenError(respBody) {
				return ErrTokenInvalid
			}
			return fmt.Errorf("fcm rejected message: %s", strings.TrimSpace(string(respBody)))
		case err == nil && status != http.StatusTooManyRequests && status < 500:
			return fmt.Errorf("fcm status %d: %s", status, strings.TrimSpace(string(respBody)))
		}
		// Transport error, 429, or 5xx: retry with backoff.
		if attempt == maxAttempts {
			if err != nil {
				return err
			}
			return fmt.Errorf("fcm status %d after %d attempts", status, attempt)
		}
		if retryAfter == 0 {
			retryAfter = time.Duration(attempt) * time.Second
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(retryAfter):
		}
	}
}

func isInvalidTokenError(body []byte) bool {
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		return false
	}
	for _, d := range parsed.Error.Details {
		if d.ErrorCode == "UNREGISTERED" {
			return true
		}
	}
	return strings.Contains(strings.ToLower(parsed.Error.Message), "registration token")
}
