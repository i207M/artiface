package storage

import (
	"encoding/binary"
	"errors"
	"io"
	"sync"
)

const (
	maxPacketBytes    = 256 * 1024
	maxDirectoryBytes = 16 * 1024 * 1024
	sftpNamePacket    = 104
)

// listingReader checks framed SFTP replies before pkg/sftp accumulates ReadDir
// results.
// It does not issue requests or interpret file data.
// The packet cap matches pkg/sftp's own cap; the byte cap also bounds long names.
type listingReader struct {
	reader io.Reader
	packet []byte

	mu         sync.Mutex
	remaining  int
	listing    bool
	countNames bool
	bytes      int
	err        error
}

// Each exclusive lease gets its own cumulative listing budget.
// Packet parsing continues on the same reader, so only budget state is reset.
func (r *listingReader) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.remaining, r.bytes = 0, 0
	r.listing, r.countNames = false, false
}

func (r *listingReader) limit(entries int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listing = true
	r.countNames = true
	// Servers may include "." and "..", which pkg/sftp excludes from results.
	r.remaining = entries + 2
}

func (r *listingReader) endDirectory() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.countNames = false
}

func (r *listingReader) failure() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.err
}

func (r *listingReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if len(r.packet) == 0 {
		if err := r.nextPacket(); err != nil {
			return 0, err
		}
	}
	n := copy(p, r.packet)
	r.packet = r.packet[n:]
	return n, nil
}

func (r *listingReader) nextPacket() error {
	var header [4]byte
	if _, err := io.ReadFull(r.reader, header[:]); err != nil {
		return err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > maxPacketBytes {
		return errors.New("storage: invalid SFTP packet size")
	}
	packet := make([]byte, int(size)+len(header))
	copy(packet, header[:])
	if _, err := io.ReadFull(r.reader, packet[4:]); err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.listing {
		r.bytes += len(packet)
		if r.countNames && packet[4] == sftpNamePacket {
			if size < 9 {
				return errors.New("storage: invalid SFTP name packet")
			}
			count := binary.BigEndian.Uint32(packet[9:13])
			if uint64(count) > uint64(r.remaining) {
				r.err = ErrTooLarge
				return r.err
			}
			r.remaining -= int(count)
		}
		if r.bytes > maxDirectoryBytes {
			r.err = ErrTooLarge
			return r.err
		}
	}
	r.packet = packet
	return nil
}
