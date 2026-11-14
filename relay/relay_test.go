package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakePusher struct {
	sent chan PushMessage
	mu   sync.Mutex
	err  error
}

func (f *fakePusher) Send(_ context.Context, msg PushMessage) error {
	f.sent <- msg
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.err
}

func (f *fakePusher) setErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

type testRelay struct {
	t      *testing.T
	server *Server
	http   *httptest.Server
	store  *Store
	pusher *fakePusher
}

func newTestRelay(t *testing.T, maxHosts int) *testRelay {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	pusher := &fakePusher{sent: make(chan PushMessage, 16)}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := NewServer(Config{MaxHosts: maxHosts, PushAckTimeout: 100 * time.Millisecond}, store, pusher, log)
	hs := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		server.Close()
		hs.Close()
		store.Close()
	})
	return &testRelay{t: t, server: server, http: hs, store: store, pusher: pusher}
}

func (r *testRelay) dial(path, token string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	header := http.Header{}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.http.URL, "http")+path, &websocket.DialOptions{HTTPHeader: header})
	if conn != nil {
		conn.SetReadLimit(maxEnvelopeBytes)
		r.t.Cleanup(func() { conn.CloseNow() })
	}
	return conn, resp, err
}

func (r *testRelay) mustDial(path, token string) *websocket.Conn {
	r.t.Helper()
	conn, _, err := r.dial(path, token)
	if err != nil {
		r.t.Fatalf("dial %s: %v", path, err)
	}
	return conn
}

func read(t *testing.T, c *websocket.Conn) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return typ, data
}

func readJSON(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	typ, data := read(t, c)
	if typ != websocket.MessageText {
		t.Fatalf("expected text frame, got binary")
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func write(t *testing.T, c *websocket.Conn, typ websocket.MessageType, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.Write(ctx, typ, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func writeJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	data, _ := json.Marshal(v)
	write(t, c, websocket.MessageText, data)
}

func expectClose(t *testing.T, c *websocket.Conn, code websocket.StatusCode) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, _, err := c.Read(ctx)
		if err == nil {
			continue
		}
		if got := websocket.CloseStatus(err); got != code {
			t.Fatalf("expected close %d, got %d (%v)", code, got, err)
		}
		return
	}
}

func envelope(header map[string]any, payload string) []byte {
	h, _ := json.Marshal(header)
	out := make([]byte, 4+len(h)+len(payload))
	binary.BigEndian.PutUint32(out, uint32(len(h)))
	copy(out[4:], h)
	copy(out[4+len(h):], payload)
	return out
}

// connectHost opens /ws/host and syncs devices; the pong proves the sync was processed.
func (r *testRelay) connectHost(hostID, token string, devices []syncedDevice) *websocket.Conn {
	r.t.Helper()
	host := r.mustDial("/ws/host?hostId="+hostID, token)
	writeJSON(r.t, host, map[string]any{"type": "relay.devices", "devices": devices})
	writeJSON(r.t, host, map[string]any{"type": "ping", "ts": 1})
	if m := readJSON(r.t, host); m["type"] != "pong" {
		r.t.Fatalf("expected pong, got %v", m)
	}
	return host
}

func TestHostTrustOnFirstUseAndHostLimit(t *testing.T) {
	r := newTestRelay(t, 1)
	r.connectHost("host_a", "token-a", nil)

	wrong := r.mustDial("/ws/host?hostId=host_a", "token-b")
	expectClose(t, wrong, closeUnauthorized)

	other := r.mustDial("/ws/host?hostId=host_b", "token-c")
	expectClose(t, other, closeUnauthorized)

	again := r.connectHost("host_a", "token-a", nil)
	writeJSON(t, again, map[string]any{"type": "ping"})
	if m := readJSON(t, again); m["type"] != "pong" {
		t.Fatalf("expected pong, got %v", m)
	}
}

func TestRoutingIdentityAndRevocation(t *testing.T) {
	r := newTestRelay(t, 4)
	devices := []syncedDevice{{DeviceID: "dev_1", TokenHash: hashToken("tok-1")}}
	host := r.connectHost("host_a", "token-a", devices)

	bad := r.mustDial("/ws/client?hostId=host_a&deviceId=dev_1", "tok-wrong")
	expectClose(t, bad, closeUnauthorized)

	client := r.mustDial("/ws/client?hostId=host_a&deviceId=dev_1", "tok-1")
	if m := readJSON(t, client); m["type"] != "relay.host_state" || m["online"] != true {
		t.Fatalf("unexpected host state %v", m)
	}
	if m := readJSON(t, host); m["type"] != "relay.device_state" || m["deviceId"] != "dev_1" || m["state"] != "online" {
		t.Fatalf("unexpected device state %v", m)
	}

	up := envelope(map[string]any{"v": 1, "hostId": "host_a", "deviceId": "dev_1", "kind": "control", "msgId": "m1"}, "sealed-up")
	write(t, client, websocket.MessageBinary, up)
	if typ, data := read(t, host); typ != websocket.MessageBinary || string(data) != string(up) {
		t.Fatalf("host got %q", data)
	}
	down := envelope(map[string]any{"v": 1, "hostId": "host_a", "deviceId": "dev_1", "kind": "control", "msgId": "m1"}, "sealed-down")
	write(t, host, websocket.MessageBinary, down)
	if typ, data := read(t, client); typ != websocket.MessageBinary || string(data) != string(down) {
		t.Fatalf("client got %q", data)
	}

	spoof := envelope(map[string]any{"v": 1, "hostId": "host_a", "deviceId": "dev_other", "kind": "control"}, "x")
	write(t, client, websocket.MessageBinary, spoof)
	expectClose(t, client, websocket.StatusPolicyViolation)
	if m := readJSON(t, host); m["state"] != "offline" {
		t.Fatalf("expected offline, got %v", m)
	}

	client = r.mustDial("/ws/client?hostId=host_a&deviceId=dev_1", "tok-1")
	readJSON(t, client)
	readJSON(t, host)
	revoked := []syncedDevice{{DeviceID: "dev_1", TokenHash: hashToken("tok-1"), Revoked: true}}
	writeJSON(t, host, map[string]any{"type": "relay.devices", "devices": revoked})
	expectClose(t, client, closeUnauthorized)
	if m := readJSON(t, host); m["state"] != "offline" {
		t.Fatalf("expected offline after revoke, got %v", m)
	}
	again := r.mustDial("/ws/client?hostId=host_a&deviceId=dev_1", "tok-1")
	expectClose(t, again, closeUnauthorized)
}

func TestPairingPipe(t *testing.T) {
	r := newTestRelay(t, 4)
	exp := strconv.FormatInt(time.Now().Add(time.Minute).UnixMilli(), 10)

	expired := r.mustDial("/ws/pair?role=host&hostId=host_a&pairingId=p_old&exp=1", "token-a")
	expectClose(t, expired, closeExpired)

	if _, resp, err := r.dial("/ws/pair?role=device&pairingId=p_1", ""); err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown pairing, got %v", err)
	}

	host := r.mustDial("/ws/pair?role=host&hostId=host_a&pairingId=p_1&exp="+exp, "token-a")
	var device *websocket.Conn
	for deadline := time.Now().Add(2 * time.Second); device == nil; {
		conn, resp, err := r.dial("/ws/pair?role=device&pairingId=p_1", "")
		switch {
		case err == nil:
			device = conn
		case resp != nil && resp.StatusCode == http.StatusNotFound && time.Now().Before(deadline):
			time.Sleep(20 * time.Millisecond)
		default:
			t.Fatalf("device dial: %v", err)
		}
	}
	if _, resp, err := r.dial("/ws/pair?role=device&pairingId=p_1", ""); err == nil || resp == nil || resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 for second device, got %v", err)
	}

	write(t, device, websocket.MessageText, []byte(`{"type":"pair.hello"}`))
	if _, data := read(t, host); string(data) != `{"type":"pair.hello"}` {
		t.Fatalf("host got %s", data)
	}
	write(t, host, websocket.MessageText, []byte(`{"type":"pair.accept"}`))
	host.Close(websocket.StatusNormalClosure, "")
	if _, data := read(t, device); string(data) != `{"type":"pair.accept"}` {
		t.Fatalf("device got %s", data)
	}
	expectClose(t, device, websocket.StatusNormalClosure)
}

func TestFCMTokenEndpointAndPushDecisions(t *testing.T) {
	r := newTestRelay(t, 4)
	devices := []syncedDevice{{DeviceID: "dev_1", TokenHash: hashToken("tok-1")}}
	host := r.connectHost("host_a", "token-a", devices)

	post := func(token string) int {
		req, _ := http.NewRequest(http.MethodPost, r.http.URL+"/api/devices/fcm-token",
			strings.NewReader(`{"hostId":"host_a","deviceId":"dev_1","fcmToken":"fcm-1"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := post("tok-wrong"); code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", code)
	}
	if code := post("tok-1"); code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", code)
	}

	hinted := func(kind, requestID, category string) []byte {
		return envelope(map[string]any{
			"v": 1, "hostId": "host_a", "deviceId": "dev_1", "kind": kind, "channelId": "ch_1", "streamEpoch": 2, "seq": 9,
			"pushHint": map[string]any{"category": category, "requestId": requestID, "collapseKey": "ck", "pendingCount": 1, "cipherSummary": "c"},
		}, "")
	}
	expectPush := func(requestID string) PushMessage {
		t.Helper()
		select {
		case msg := <-r.pusher.sent:
			if msg.Data["requestId"] != requestID {
				t.Fatalf("expected push for %s, got %v", requestID, msg.Data)
			}
			return msg
		case <-time.After(2 * time.Second):
			t.Fatalf("no push for %s", requestID)
		}
		return PushMessage{}
	}
	expectNoPush := func() {
		t.Helper()
		select {
		case msg := <-r.pusher.sent:
			t.Fatalf("unexpected push %v", msg.Data)
		case <-time.After(300 * time.Millisecond):
		}
	}

	// Offline device: push-only frame pushes at once.
	write(t, host, websocket.MessageBinary, hinted("push", "r1", "approval"))
	msg := expectPush("r1")
	want := map[string]string{"hostId": "host_a", "deviceId": "dev_1", "channelId": "ch_1", "streamEpoch": "2", "seq": "9",
		"category": "approval", "pendingCount": "1", "cipherSummary": "c", "collapseKey": "ck"}
	for k, v := range want {
		if msg.Data[k] != v {
			t.Fatalf("data[%s] = %q, want %q", k, msg.Data[k], v)
		}
	}
	if msg.Token != "fcm-1" || !msg.HighPriority || msg.TTL != time.Hour || msg.CollapseKey != "ck" {
		t.Fatalf("unexpected push message %+v", msg)
	}

	client := r.mustDial("/ws/client?hostId=host_a&deviceId=dev_1", "tok-1")
	readJSON(t, client)
	readJSON(t, host)

	// Foreground and acknowledged: no push.
	write(t, host, websocket.MessageBinary, hinted("session", "r2", "approval"))
	read(t, client)
	writeJSON(t, client, map[string]any{"type": "relay.ack", "requestId": "r2"})
	expectNoPush()

	// Foreground without ack: push after the ack timeout.
	write(t, host, websocket.MessageBinary, hinted("session", "r3", "done"))
	read(t, client)
	if msg := expectPush("r3"); msg.HighPriority || msg.TTL != 10*time.Minute {
		t.Fatalf("done should be normal priority: %+v", msg)
	}

	// Foreground and connected: a push-only frame is left to the app's own resync.
	write(t, host, websocket.MessageBinary, hinted("push", "r4", "approval"))
	expectNoPush()

	// Background: push immediately even though the frame was delivered.
	writeJSON(t, client, map[string]any{"type": "relay.app_state", "state": "background"})
	writeJSON(t, client, map[string]any{"type": "ping"})
	readJSON(t, client)
	r.pusher.setErr(ErrTokenInvalid)
	write(t, host, websocket.MessageBinary, hinted("session", "r5", "ask"))
	expectPush("r5")
	deadline := time.Now().Add(2 * time.Second)
	for {
		token, err := r.store.FCMToken(context.Background(), "host_a", "dev_1")
		if err != nil {
			t.Fatal(err)
		}
		if token == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("rejected FCM token was not cleared")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestStoreDeviceSyncKeepsFCMTokenOnlyForSameToken(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	sync := func(hash string, revoked bool) {
		if err := store.ReplaceDevices(ctx, "h", []syncedDevice{{DeviceID: "d", TokenHash: hash, Revoked: revoked}}); err != nil {
			t.Fatal(err)
		}
	}
	token := func() string {
		v, err := store.FCMToken(ctx, "h", "d")
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	a, b := hashToken("a"), hashToken("b")
	sync(a, false)
	if err := store.SetFCMToken(ctx, "h", "d", "fcm"); err != nil {
		t.Fatal(err)
	}
	sync(a, false)
	if token() != "fcm" {
		t.Fatal("same token re-sync dropped the FCM token")
	}
	sync(b, false)
	if token() != "" {
		t.Fatal("re-paired device kept the old FCM token")
	}
	_ = store.SetFCMToken(ctx, "h", "d", "fcm2")
	sync(b, true)
	if token() != "" {
		t.Fatal("revoked device kept its FCM token")
	}
	if err := store.ReplaceDevices(ctx, "h", nil); err != nil {
		t.Fatal(err)
	}
	if ok, _ := store.AuthenticateDevice(ctx, "h", "d", b); ok {
		t.Fatal("removed device still authenticates")
	}
}

func TestFCMPusherHTTP(t *testing.T) {
	var mu sync.Mutex
	var responses []func(w http.ResponseWriter)
	var bodies []map[string]any
	fcm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		next := responses[0]
		responses = responses[1:]
		mu.Unlock()
		next(w)
	}))
	respond := func(fns ...func(http.ResponseWriter)) {
		mu.Lock()
		defer mu.Unlock()
		responses = fns
	}
	defer fcm.Close()
	p := &FCMPusher{client: fcm.Client(), endpoint: fcm.URL}
	status := func(code int, body string) func(http.ResponseWriter) {
		return func(w http.ResponseWriter) {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(body))
		}
	}
	msg := PushMessage{Token: "t", Data: map[string]string{"k": "v"}, HighPriority: true, CollapseKey: "ck", TTL: time.Hour}

	respond(status(503, ""), status(200, "{}"))
	if err := p.Send(context.Background(), msg); err != nil {
		t.Fatalf("retry after 503 failed: %v", err)
	}
	mu.Lock()
	android := bodies[1]["message"].(map[string]any)["android"].(map[string]any)
	mu.Unlock()
	if android["priority"] != "HIGH" || android["ttl"] != "3600s" || android["collapse_key"] != "ck" {
		t.Fatalf("unexpected android config %v", android)
	}

	respond(status(404, `{"error":{"status":"NOT_FOUND"}}`))
	if err := p.Send(context.Background(), msg); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("404 should invalidate the token, got %v", err)
	}
	respond(status(400, `{"error":{"message":"The registration token is not a valid FCM registration token","details":[{"errorCode":"INVALID_ARGUMENT"}]}}`))
	if err := p.Send(context.Background(), msg); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("invalid token 400 should invalidate the token, got %v", err)
	}
	respond(status(400, `{"error":{"message":"Invalid JSON payload"}}`))
	if err := p.Send(context.Background(), msg); err == nil || errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("payload 400 must not invalidate the token, got %v", err)
	}
}

func TestParseEnvelopeHeader(t *testing.T) {
	good := envelope(map[string]any{"v": 1, "hostId": "h", "deviceId": "d", "kind": "session", "seq": 3}, "payload")
	h, err := parseEnvelopeHeader(good)
	if err != nil || h.Kind != "session" || *h.Seq != 3 {
		t.Fatalf("parse good: %+v %v", h, err)
	}
	bad := [][]byte{
		{0, 0, 0},
		{0, 0, 0, 0},
		{0, 0, 0, 50, '{'},
		envelope(map[string]any{"v": 2, "hostId": "h", "deviceId": "d", "kind": "session"}, ""),
		envelope(map[string]any{"v": 1, "hostId": "h/../x", "deviceId": "d", "kind": "session"}, ""),
		envelope(map[string]any{"v": 1, "hostId": "h", "deviceId": "d", "kind": "session", "pushHint": map[string]any{"category": "approval"}}, ""),
	}
	for i, frame := range bad {
		if _, err := parseEnvelopeHeader(frame); err == nil {
			t.Fatalf("bad frame %d accepted", i)
		}
	}
}
