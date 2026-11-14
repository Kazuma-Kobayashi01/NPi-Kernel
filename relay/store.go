package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// Store persists host token hashes (trust on first use), the device list each
// host syncs, and device FCM tokens. It never sees plaintext tokens.
type Store struct {
	db *sql.DB
}

type syncedDevice struct {
	DeviceID  string `json:"deviceId"`
	TokenHash string `json:"tokenHash"`
	Revoked   bool   `json:"revoked"`
}

const schema = `
CREATE TABLE IF NOT EXISTS hosts (
	host_id      TEXT PRIMARY KEY,
	token_hash   TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
	host_id    TEXT NOT NULL,
	device_id  TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	revoked    INTEGER NOT NULL,
	fcm_token  TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (host_id, device_id)
);`

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// One connection serialises transactions; the Relay's write rate is tiny.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func hashesEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// AuthenticateHost registers an unknown host (up to maxHosts) or checks the token hash of a known one.
func (s *Store) AuthenticateHost(ctx context.Context, hostID, tokenHash string, maxHosts int) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	var stored string
	err = tx.QueryRowContext(ctx, `SELECT token_hash FROM hosts WHERE host_id = ?`, hostID).Scan(&stored)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM hosts`).Scan(&count); err != nil {
			return false, err
		}
		if count >= maxHosts {
			return false, nil
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO hosts (host_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
			hostID, tokenHash, now, now); err != nil {
			return false, err
		}
	case err != nil:
		return false, err
	case !hashesEqual(stored, tokenHash):
		return false, nil
	default:
		if _, err := tx.ExecContext(ctx, `UPDATE hosts SET last_seen_at = ? WHERE host_id = ?`, now, hostID); err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}

// ReplaceDevices makes the stored device list of a host equal to devices. A device whose
// token changed or that is revoked loses its FCM token.
func (s *Store) ReplaceDevices(ctx context.Context, hostID string, devices []syncedDevice) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT device_id FROM devices WHERE host_id = ?`, hostID)
	if err != nil {
		return err
	}
	stale := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		stale[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	now := time.Now().Unix()
	for _, d := range devices {
		delete(stale, d.DeviceID)
		if _, err := tx.ExecContext(ctx, `
INSERT INTO devices (host_id, device_id, token_hash, revoked, fcm_token, updated_at)
VALUES (?, ?, ?, ?, NULL, ?)
ON CONFLICT (host_id, device_id) DO UPDATE SET
	fcm_token = CASE WHEN excluded.revoked = 0 AND devices.token_hash = excluded.token_hash THEN devices.fcm_token ELSE NULL END,
	token_hash = excluded.token_hash,
	revoked = excluded.revoked,
	updated_at = excluded.updated_at`,
			hostID, d.DeviceID, d.TokenHash, d.Revoked, now); err != nil {
			return err
		}
	}
	for id := range stale {
		if _, err := tx.ExecContext(ctx, `DELETE FROM devices WHERE host_id = ? AND device_id = ?`, hostID, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AuthenticateDevice reports whether the device is synced, active, and holds this token.
func (s *Store) AuthenticateDevice(ctx context.Context, hostID, deviceID, tokenHash string) (bool, error) {
	var stored string
	var revoked bool
	err := s.db.QueryRowContext(ctx, `SELECT token_hash, revoked FROM devices WHERE host_id = ? AND device_id = ?`,
		hostID, deviceID).Scan(&stored, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !revoked && hashesEqual(stored, tokenHash), nil
}

func (s *Store) SetFCMToken(ctx context.Context, hostID, deviceID, fcmToken string) error {
	var value any
	if fcmToken != "" {
		value = fcmToken
	}
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET fcm_token = ?, updated_at = ? WHERE host_id = ? AND device_id = ?`,
		value, time.Now().Unix(), hostID, deviceID)
	return err
}

// FCMToken returns "" when the device has no token.
func (s *Store) FCMToken(ctx context.Context, hostID, deviceID string) (string, error) {
	var token sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT fcm_token FROM devices WHERE host_id = ? AND device_id = ? AND revoked = 0`,
		hostID, deviceID).Scan(&token)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return token.String, err
}

// ClearFCMToken drops a token FCM rejected, unless the device already replaced it.
func (s *Store) ClearFCMToken(ctx context.Context, hostID, deviceID, fcmToken string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET fcm_token = NULL WHERE host_id = ? AND device_id = ? AND fcm_token = ?`,
		hostID, deviceID, fcmToken)
	return err
}
