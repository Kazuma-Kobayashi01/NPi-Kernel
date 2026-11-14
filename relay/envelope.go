package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// Limits mirror packages/coding-agent/src/remote/protocol.ts.
const (
	maxEnvelopeBytes = 1 << 20
	maxHeaderBytes   = 64 << 10
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// pushHint is the plaintext notification signal a host attaches to a frame.
type pushHint struct {
	Category      string `json:"category"`
	RequestID     string `json:"requestId"`
	CollapseKey   string `json:"collapseKey"`
	PendingCount  int    `json:"pendingCount"`
	CipherSummary string `json:"cipherSummary,omitempty"`
}

// envelopeHeader is the plaintext routing header of a binary frame:
// `[4B headerLen BE][UTF-8 JSON header][payload]`. The payload is opaque to the Relay.
type envelopeHeader struct {
	V           int       `json:"v"`
	HostID      string    `json:"hostId"`
	DeviceID    string    `json:"deviceId"`
	Kind        string    `json:"kind"`
	ChannelID   string    `json:"channelId,omitempty"`
	StreamEpoch *int64    `json:"streamEpoch,omitempty"`
	Seq         *int64    `json:"seq,omitempty"`
	PushHint    *pushHint `json:"pushHint,omitempty"`
}

func parseEnvelopeHeader(frame []byte) (envelopeHeader, error) {
	var h envelopeHeader
	if len(frame) < 4 || len(frame) > maxEnvelopeBytes {
		return h, fmt.Errorf("invalid envelope length %d", len(frame))
	}
	headerLen := binary.BigEndian.Uint32(frame[:4])
	if headerLen == 0 || headerLen > maxHeaderBytes || int(headerLen) > len(frame)-4 {
		return h, fmt.Errorf("invalid envelope header length %d", headerLen)
	}
	if err := json.Unmarshal(frame[4:4+headerLen], &h); err != nil {
		return h, fmt.Errorf("invalid envelope header: %w", err)
	}
	if h.V != 1 || !idPattern.MatchString(h.HostID) || !idPattern.MatchString(h.DeviceID) || h.Kind == "" {
		return h, errors.New("envelope header is missing routing fields")
	}
	if h.PushHint != nil && (h.PushHint.Category == "" || h.PushHint.RequestID == "") {
		return h, errors.New("pushHint requires category and requestId")
	}
	return h, nil
}
