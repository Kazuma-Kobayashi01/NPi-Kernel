package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	sendQueueSize      = 256
	idleTimeout        = 60 * time.Second
	writeTimeout       = 10 * time.Second
	maxTextBytes       = 64 << 10
	maxPairTextBytes   = 16 << 10
	maxPairingTTL      = 10 * time.Minute
	maxPairingsPerHost = 4
	maxPairings        = 256
	maxFCMTokenBytes   = 4096

	closeReplaced     websocket.StatusCode = 4000
	closeUnauthorized websocket.StatusCode = 4401
	closeConflict     websocket.StatusCode = 4409
	closeExpired      websocket.StatusCode = 4410
)

type Config struct {
	MaxHosts       int
	PushAckTimeout time.Duration
}

type deviceKey struct{ hostID, deviceID string }

type ackKey struct {
	deviceKey
	requestID string
}

// Server routes binary envelopes between one host and its devices, pipes pairing
// handshakes, and turns unacknowledged push hints into FCM messages.
type Server struct {
	cfg     Config
	store   *Store
	pusher  Pusher
	log     *slog.Logger
	baseCtx context.Context
	stop    context.CancelFunc

	mu        sync.Mutex
	hosts     map[string]*peer
	clients   map[deviceKey]*peer
	pairings  map[string]*pairing
	ackTimers map[ackKey]*time.Timer
}

type pairing struct {
	id     string
	hostID string
	ctx    context.Context
	cancel context.CancelFunc
	host   *peer
	device *peer
}

// NewServer wires the hub. pusher may be nil (push disabled).
func NewServer(cfg Config, store *Store, pusher Pusher, log *slog.Logger) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{
		cfg:       cfg,
		store:     store,
		pusher:    pusher,
		log:       log,
		baseCtx:   ctx,
		stop:      cancel,
		hosts:     map[string]*peer{},
		clients:   map[deviceKey]*peer{},
		pairings:  map[string]*pairing{},
		ackTimers: map[ackKey]*time.Timer{},
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /ws/host", s.handleHost)
	mux.HandleFunc("GET /ws/client", s.handleClient)
	mux.HandleFunc("GET /ws/pair", s.handlePair)
	mux.HandleFunc("POST /api/devices/fcm-token", s.handleFCMToken)
	return mux
}

// Close disconnects every peer and stops pending push timers.
func (s *Server) Close() {
	s.mu.Lock()
	var peers []*peer
	for _, p := range s.hosts {
		peers = append(peers, p)
	}
	for _, p := range s.clients {
		peers = append(peers, p)
	}
	for _, pr := range s.pairings {
		peers = append(peers, pr.host)
		if pr.device != nil {
			peers = append(peers, pr.device)
		}
	}
	for k, t := range s.ackTimers {
		t.Stop()
		delete(s.ackTimers, k)
	}
	s.mu.Unlock()
	for _, p := range peers {
		p.close(websocket.StatusGoingAway, "relay shutting down")
	}
	s.stop()
}

// ---- peers ----

type queued struct {
	typ  websocket.MessageType
	data []byte
}

type peer struct {
	conn       *websocket.Conn
	ctx        context.Context
	cancel     context.CancelFunc
	send       chan queued
	hostID     string
	deviceID   string
	tokenHash  string
	background atomic.Bool
	closeOnce  sync.Once
	closing    atomic.Bool
}

func newPeer(parent context.Context, conn *websocket.Conn, hostID, deviceID string) *peer {
	ctx, cancel := context.WithCancel(parent)
	p := &peer{conn: conn, ctx: ctx, cancel: cancel, send: make(chan queued, sendQueueSize), hostID: hostID, deviceID: deviceID}
	go p.writeLoop()
	return p
}

func (p *peer) writeLoop() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case m := <-p.send:
			ctx, cancel := context.WithTimeout(p.ctx, writeTimeout)
			err := p.conn.Write(ctx, m.typ, m.data)
			cancel()
			if err != nil {
				p.close(websocket.StatusGoingAway, "write failed")
				return
			}
		}
	}
}

// enqueue never blocks: a peer that cannot keep up is disconnected and resyncs on reconnect.
func (p *peer) enqueue(typ websocket.MessageType, data []byte) bool {
	select {
	case p.send <- queued{typ, data}:
		return true
	default:
		p.close(websocket.StatusTryAgainLater, "slow consumer")
		return false
	}
}

func (p *peer) sendJSON(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	p.enqueue(websocket.MessageText, data)
}

// close starts a graceful close without blocking the caller.
func (p *peer) close(code websocket.StatusCode, reason string) {
	if p.closing.Swap(true) {
		return
	}
	go p.closeNow(code, reason)
}

// closeNow performs the close handshake (bounded by the library) once.
func (p *peer) closeNow(code websocket.StatusCode, reason string) {
	p.closeOnce.Do(func() {
		_ = p.conn.Close(code, reason)
		p.cancel()
	})
}

// readLoop feeds messages to handle until the connection ends, the peer is idle
// for longer than idle, or handle reports a protocol violation.
func (s *Server) readLoop(p *peer, idle time.Duration, handle func(websocket.MessageType, []byte) error) {
	for {
		ctx, cancel := context.WithTimeout(p.ctx, idle)
		typ, data, err := p.conn.Read(ctx)
		cancel()
		if err != nil {
			return
		}
		if err := handle(typ, data); err != nil {
			s.log.Info("closing peer on protocol violation", "host", p.hostID, "device", p.deviceID, "err", err)
			p.close(websocket.StatusPolicyViolation, truncate(err.Error(), 120))
			return
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func bearer(r *http.Request) string {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return strings.TrimSpace(token)
}

// accept upgrades without an Origin check: every endpoint authenticates with a bearer
// token, which browsers cannot attach to WebSocket requests.
func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
}

// ---- wire messages (text frames) ----

type controlMessage struct {
	Type      string          `json:"type"`
	Ts        json.RawMessage `json:"ts,omitempty"`
	Devices   []syncedDevice  `json:"devices,omitempty"`
	State     string          `json:"state,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
}

type pongMessage struct {
	Type string          `json:"type"`
	Ts   json.RawMessage `json:"ts,omitempty"`
}

type deviceStateMessage struct {
	Type     string `json:"type"`
	DeviceID string `json:"deviceId"`
	State    string `json:"state"`
}

type hostStateMessage struct {
	Type   string `json:"type"`
	Online bool   `json:"online"`
}

func deviceState(deviceID string, online bool) deviceStateMessage {
	state := "offline"
	if online {
		state = "online"
	}
	return deviceStateMessage{Type: "relay.device_state", DeviceID: deviceID, State: state}
}

// ---- host: /ws/host?hostId= ----

func (s *Server) handleHost(w http.ResponseWriter, r *http.Request) {
	hostID := r.URL.Query().Get("hostId")
	token := bearer(r)
	conn, err := accept(w, r)
	if err != nil {
		return
	}
	if !idPattern.MatchString(hostID) || token == "" {
		_ = conn.Close(closeUnauthorized, "unauthorized")
		return
	}
	ok, err := s.store.AuthenticateHost(r.Context(), hostID, hashToken(token), s.cfg.MaxHosts)
	if err != nil {
		s.log.Error("authenticate host", "host", hostID, "err", err)
		_ = conn.Close(websocket.StatusInternalError, "internal error")
		return
	}
	if !ok {
		_ = conn.Close(closeUnauthorized, "unauthorized")
		return
	}
	conn.SetReadLimit(maxEnvelopeBytes)
	p := newPeer(s.baseCtx, conn, hostID, "")

	s.mu.Lock()
	old := s.hosts[hostID]
	s.hosts[hostID] = p
	var online []*peer
	for key, c := range s.clients {
		if key.hostID == hostID {
			online = append(online, c)
		}
	}
	s.mu.Unlock()
	if old != nil {
		old.close(closeReplaced, "replaced by a newer connection")
	}
	for _, c := range online {
		p.sendJSON(deviceState(c.deviceID, true))
		c.sendJSON(hostStateMessage{Type: "relay.host_state", Online: true})
	}
	s.log.Info("host connected", "host", hostID)

	defer s.dropHost(p)
	s.readLoop(p, idleTimeout, func(typ websocket.MessageType, data []byte) error {
		if typ == websocket.MessageText {
			return s.onHostText(p, data)
		}
		h, err := parseEnvelopeHeader(data)
		if err != nil {
			return err
		}
		if h.HostID != hostID {
			return errors.New("envelope hostId does not match the connection")
		}
		s.routeToDevice(h, data)
		return nil
	})
}

func (s *Server) dropHost(p *peer) {
	p.close(websocket.StatusNormalClosure, "")
	s.mu.Lock()
	if s.hosts[p.hostID] != p {
		s.mu.Unlock()
		return
	}
	delete(s.hosts, p.hostID)
	var online []*peer
	for key, c := range s.clients {
		if key.hostID == p.hostID {
			online = append(online, c)
		}
	}
	s.mu.Unlock()
	for _, c := range online {
		c.sendJSON(hostStateMessage{Type: "relay.host_state", Online: false})
	}
	s.log.Info("host disconnected", "host", p.hostID)
}

func (s *Server) onHostText(p *peer, data []byte) error {
	if len(data) > maxTextBytes {
		return errors.New("control message too large")
	}
	var m controlMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("malformed control message: %w", err)
	}
	switch m.Type {
	case "ping":
		p.sendJSON(pongMessage{Type: "pong", Ts: m.Ts})
	case "relay.devices":
		return s.syncDevices(p.hostID, m.Devices)
	}
	return nil
}

func (s *Server) syncDevices(hostID string, devices []syncedDevice) error {
	byID := make(map[string]syncedDevice, len(devices))
	for _, d := range devices {
		if !idPattern.MatchString(d.DeviceID) || len(d.TokenHash) != 64 {
			return fmt.Errorf("invalid device entry %q", d.DeviceID)
		}
		byID[d.DeviceID] = d
	}
	ctx, cancel := context.WithTimeout(s.baseCtx, 10*time.Second)
	defer cancel()
	if err := s.store.ReplaceDevices(ctx, hostID, devices); err != nil {
		s.log.Error("replace devices", "host", hostID, "err", err)
		return nil
	}
	s.mu.Lock()
	var cut []*peer
	for key, c := range s.clients {
		if key.hostID != hostID {
			continue
		}
		d, ok := byID[key.deviceID]
		if !ok || d.Revoked || !hashesEqual(d.TokenHash, c.tokenHash) {
			cut = append(cut, c)
		}
	}
	s.mu.Unlock()
	for _, c := range cut {
		c.close(closeUnauthorized, "device revoked")
	}
	s.log.Info("devices synced", "host", hostID, "count", len(devices), "disconnected", len(cut))
	return nil
}

// routeToDevice forwards a host frame and decides whether its push hint needs FCM.
func (s *Server) routeToDevice(h envelopeHeader, frame []byte) {
	key := deviceKey{h.HostID, h.DeviceID}
	s.mu.Lock()
	c := s.clients[key]
	s.mu.Unlock()
	if h.Kind == "push" {
		// The device has no session on the host. A foreground app reconnects and resyncs by itself.
		if h.PushHint != nil && (c == nil || c.background.Load()) {
			s.schedulePush(key, h, false)
		}
		return
	}
	delivered := c != nil && c.enqueue(websocket.MessageBinary, frame)
	if h.PushHint != nil {
		s.schedulePush(key, h, delivered && !c.background.Load())
	}
}

// ---- device: /ws/client?hostId=&deviceId= ----

func (s *Server) handleClient(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key := deviceKey{q.Get("hostId"), q.Get("deviceId")}
	token := bearer(r)
	conn, err := accept(w, r)
	if err != nil {
		return
	}
	if !idPattern.MatchString(key.hostID) || !idPattern.MatchString(key.deviceID) || token == "" {
		_ = conn.Close(closeUnauthorized, "unauthorized")
		return
	}
	tokenHash := hashToken(token)
	ok, err := s.store.AuthenticateDevice(r.Context(), key.hostID, key.deviceID, tokenHash)
	if err != nil {
		s.log.Error("authenticate device", "host", key.hostID, "device", key.deviceID, "err", err)
		_ = conn.Close(websocket.StatusInternalError, "internal error")
		return
	}
	if !ok {
		_ = conn.Close(closeUnauthorized, "unauthorized")
		return
	}
	conn.SetReadLimit(maxEnvelopeBytes)
	p := newPeer(s.baseCtx, conn, key.hostID, key.deviceID)
	p.tokenHash = tokenHash

	s.mu.Lock()
	old := s.clients[key]
	s.clients[key] = p
	host := s.hosts[key.hostID]
	s.mu.Unlock()
	if old != nil {
		old.close(closeReplaced, "replaced by a newer connection")
	}
	p.sendJSON(hostStateMessage{Type: "relay.host_state", Online: host != nil})
	if host != nil {
		host.sendJSON(deviceState(key.deviceID, true))
	}

	defer s.dropClient(p)
	s.readLoop(p, idleTimeout, func(typ websocket.MessageType, data []byte) error {
		if typ == websocket.MessageText {
			return s.onClientText(p, data)
		}
		h, err := parseEnvelopeHeader(data)
		if err != nil {
			return err
		}
		if h.HostID != key.hostID || h.DeviceID != key.deviceID {
			return errors.New("envelope identity does not match the connection")
		}
		s.mu.Lock()
		host := s.hosts[key.hostID]
		s.mu.Unlock()
		if host != nil {
			host.enqueue(websocket.MessageBinary, data)
		}
		return nil
	})
}

func (s *Server) dropClient(p *peer) {
	p.close(websocket.StatusNormalClosure, "")
	key := deviceKey{p.hostID, p.deviceID}
	s.mu.Lock()
	if s.clients[key] != p {
		s.mu.Unlock()
		return
	}
	delete(s.clients, key)
	host := s.hosts[p.hostID]
	s.mu.Unlock()
	if host != nil {
		host.sendJSON(deviceState(p.deviceID, false))
	}
}

func (s *Server) onClientText(p *peer, data []byte) error {
	if len(data) > maxTextBytes {
		return errors.New("control message too large")
	}
	var m controlMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("malformed control message: %w", err)
	}
	switch m.Type {
	case "ping":
		p.sendJSON(pongMessage{Type: "pong", Ts: m.Ts})
	case "relay.app_state":
		switch m.State {
		case "foreground":
			p.background.Store(false)
		case "background":
			p.background.Store(true)
		default:
			return fmt.Errorf("unknown app state %q", m.State)
		}
	case "relay.ack":
		s.ack(ackKey{deviceKey{p.hostID, p.deviceID}, m.RequestID})
	}
	return nil
}

// ---- push ----

// schedulePush sends now, or after the ack timeout unless the device acknowledges requestId first.
func (s *Server) schedulePush(key deviceKey, h envelopeHeader, waitForAck bool) {
	ak := ackKey{key, h.PushHint.RequestID}
	s.mu.Lock()
	if old := s.ackTimers[ak]; old != nil {
		old.Stop()
		delete(s.ackTimers, ak)
	}
	if waitForAck {
		var t *time.Timer
		t = time.AfterFunc(s.cfg.PushAckTimeout, func() {
			s.mu.Lock()
			if s.ackTimers[ak] != t {
				s.mu.Unlock()
				return
			}
			delete(s.ackTimers, ak)
			s.mu.Unlock()
			s.sendPush(key, h)
		})
		s.ackTimers[ak] = t
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	go s.sendPush(key, h)
}

func (s *Server) ack(ak ackKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.ackTimers[ak]; t != nil {
		t.Stop()
		delete(s.ackTimers, ak)
	}
}

func (s *Server) sendPush(key deviceKey, h envelopeHeader) {
	if s.pusher == nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.baseCtx, 30*time.Second)
	defer cancel()
	token, err := s.store.FCMToken(ctx, key.hostID, key.deviceID)
	if err != nil {
		s.log.Error("load fcm token", "host", key.hostID, "device", key.deviceID, "err", err)
		return
	}
	if token == "" {
		return
	}
	hint := h.PushHint
	data := map[string]string{
		"v":            "1",
		"hostId":       key.hostID,
		"deviceId":     key.deviceID,
		"category":     hint.Category,
		"requestId":    hint.RequestID,
		"collapseKey":  hint.CollapseKey,
		"pendingCount": strconv.Itoa(hint.PendingCount),
	}
	if h.ChannelID != "" {
		data["channelId"] = h.ChannelID
	}
	if h.StreamEpoch != nil {
		data["streamEpoch"] = strconv.FormatInt(*h.StreamEpoch, 10)
	}
	if h.Seq != nil {
		data["seq"] = strconv.FormatInt(*h.Seq, 10)
	}
	if hint.CipherSummary != "" {
		data["cipherSummary"] = hint.CipherSummary
	}
	high := hint.Category == "approval" || hint.Category == "ask"
	ttl := 10 * time.Minute
	if high {
		ttl = time.Hour
	}
	err = s.pusher.Send(ctx, PushMessage{Token: token, Data: data, HighPriority: high, CollapseKey: hint.CollapseKey, TTL: ttl})
	switch {
	case errors.Is(err, ErrTokenInvalid):
		s.log.Info("fcm token rejected; clearing", "host", key.hostID, "device", key.deviceID)
		if err := s.store.ClearFCMToken(ctx, key.hostID, key.deviceID, token); err != nil {
			s.log.Error("clear fcm token", "err", err)
		}
	case err != nil:
		s.log.Warn("fcm send failed", "host", key.hostID, "device", key.deviceID, "err", err)
	}
}

// ---- POST /api/devices/fcm-token ----

func (s *Server) handleFCMToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HostID   string `json:"hostId"`
		DeviceID string `json:"deviceId"`
		FCMToken string `json:"fcmToken"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
		!idPattern.MatchString(body.HostID) || !idPattern.MatchString(body.DeviceID) || len(body.FCMToken) > maxFCMTokenBytes {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	token := bearer(r)
	if token == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ok, err := s.store.AuthenticateDevice(r.Context(), body.HostID, body.DeviceID, hashToken(token))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := s.store.SetFCMToken(r.Context(), body.HostID, body.DeviceID, body.FCMToken); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- pairing: /ws/pair ----

// handlePair pipes text frames between `role=host` (bearer = host token) and the one
// `role=device` socket that names the same pairingId. Pairings live in memory only.
func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	pairingID := q.Get("pairingId")
	switch q.Get("role") {
	case "host":
		s.handlePairHost(w, r, pairingID)
	case "device":
		s.handlePairDevice(w, r, pairingID)
	default:
		http.Error(w, "role must be host or device", http.StatusBadRequest)
	}
}

func (s *Server) handlePairHost(w http.ResponseWriter, r *http.Request, pairingID string) {
	q := r.URL.Query()
	hostID := q.Get("hostId")
	token := bearer(r)
	expMs, expErr := strconv.ParseInt(q.Get("exp"), 10, 64)
	conn, err := accept(w, r)
	if err != nil {
		return
	}
	if !idPattern.MatchString(hostID) || !idPattern.MatchString(pairingID) || token == "" {
		_ = conn.Close(closeUnauthorized, "unauthorized")
		return
	}
	ok, err := s.store.AuthenticateHost(r.Context(), hostID, hashToken(token), s.cfg.MaxHosts)
	if err != nil || !ok {
		_ = conn.Close(closeUnauthorized, "unauthorized")
		return
	}
	ttl := time.Until(time.UnixMilli(expMs))
	if expErr != nil || ttl <= 0 {
		_ = conn.Close(closeExpired, "pairing expired")
		return
	}
	ttl = min(ttl, maxPairingTTL)

	s.mu.Lock()
	perHost := 0
	for _, pr := range s.pairings {
		if pr.hostID == hostID {
			perHost++
		}
	}
	if _, exists := s.pairings[pairingID]; exists || perHost >= maxPairingsPerHost || len(s.pairings) >= maxPairings {
		s.mu.Unlock()
		_ = conn.Close(closeConflict, "pairing rejected")
		return
	}
	ctx, cancel := context.WithTimeout(s.baseCtx, ttl)
	conn.SetReadLimit(maxPairTextBytes)
	p := newPeer(ctx, conn, hostID, "")
	pr := &pairing{id: pairingID, hostID: hostID, ctx: ctx, cancel: cancel, host: p}
	s.pairings[pairingID] = pr
	s.mu.Unlock()

	defer s.endPairing(pr)
	s.readLoop(p, ttl, func(typ websocket.MessageType, data []byte) error {
		if typ != websocket.MessageText {
			return errors.New("pairing carries text frames only")
		}
		s.mu.Lock()
		device := pr.device
		s.mu.Unlock()
		if device != nil {
			device.enqueue(websocket.MessageText, data)
		}
		return nil
	})
}

func (s *Server) handlePairDevice(w http.ResponseWriter, r *http.Request, pairingID string) {
	s.mu.Lock()
	pr := s.pairings[pairingID]
	taken := pr != nil && pr.device != nil
	s.mu.Unlock()
	if pr == nil {
		http.Error(w, "unknown pairing", http.StatusNotFound)
		return
	}
	if taken {
		http.Error(w, "pairing in progress", http.StatusConflict)
		return
	}
	conn, err := accept(w, r)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxPairTextBytes)
	p := newPeer(pr.ctx, conn, pr.hostID, "")
	s.mu.Lock()
	if s.pairings[pairingID] != pr || pr.device != nil {
		s.mu.Unlock()
		p.close(closeConflict, "pairing in progress")
		return
	}
	pr.device = p
	s.mu.Unlock()

	defer s.endPairing(pr)
	s.readLoop(p, maxPairingTTL, func(typ websocket.MessageType, data []byte) error {
		if typ != websocket.MessageText {
			return errors.New("pairing carries text frames only")
		}
		pr.host.enqueue(websocket.MessageText, data)
		return nil
	})
}

// endPairing closes both sides once either side leaves. Queued frames are flushed first.
func (s *Server) endPairing(pr *pairing) {
	s.mu.Lock()
	if s.pairings[pr.id] == pr {
		delete(s.pairings, pr.id)
	}
	device := pr.device
	s.mu.Unlock()
	go func() {
		if device != nil {
			flushQueue(device)
		}
		flushQueue(pr.host)
		if device != nil {
			device.closeNow(websocket.StatusNormalClosure, "pairing finished")
		}
		pr.host.closeNow(websocket.StatusNormalClosure, "pairing finished")
		pr.cancel()
	}()
}

// flushQueue waits briefly for a peer's outgoing queue to drain.
func flushQueue(p *peer) {
	deadline := time.Now().Add(2 * time.Second)
	for len(p.send) > 0 && time.Now().Before(deadline) && p.ctx.Err() == nil {
		time.Sleep(10 * time.Millisecond)
	}
}
