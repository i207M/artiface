package sshvault

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"reflect"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type Runtime struct {
	mu       sync.RWMutex
	envelope *Envelope
	bundle   Bundle
	check    map[string]ssh.HostKeyCallback
	unlocked bool
	closed   bool
	disabled bool // Immutable startup policy, independent of saved credentials.
	pending  map[string]pendingHostKey
	active   map[*clientChain]string
}

func NewRuntime(envelope *Envelope, disabled bool) *Runtime {
	return &Runtime{envelope: envelope, disabled: disabled, pending: make(map[string]pendingHostKey), active: make(map[*clientChain]string)}
}

func (r *Runtime) Disabled() bool { return r.disabled }

func (r *Runtime) Locked() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.envelope != nil && !r.unlocked
}

func (r *Runtime) Matches(envelope *Envelope) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return reflect.DeepEqual(r.envelope, envelope)
}

// Unlock never retains the admin password or its encryption key.
func (r *Runtime) Unlock(password string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return os.ErrClosed
	}
	if r.disabled || r.unlocked || r.envelope == nil {
		return nil
	}
	bundle, err := Open(r.envelope, password)
	if err != nil {
		return err
	}
	check := map[string]ssh.HostKeyCallback{}
	for id, data := range bundle.KnownHosts {
		callback, err := hostKeyCallback(data)
		if err != nil {
			bundle.Clear()
			return err
		}
		check[id] = callback
	}
	r.bundle, r.check, r.unlocked = bundle, check, true
	return nil
}

// Rewrap only replaces encrypted bytes; existing connections and decrypted
// material are unchanged after a successful admin password rotation.
func (r *Runtime) Rewrap(previous, envelope *Envelope) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// An out-of-process import still needs a restart. Do not label an older
	// decrypted bundle as current just because its password was then changed.
	if reflect.DeepEqual(r.envelope, previous) {
		r.envelope = envelope
		clear(r.pending)
	}
}

func (r *Runtime) Close() {
	r.mu.Lock()
	r.closed = true
	r.bundle.Clear()
	r.check = nil
	clear(r.pending)
	chains := make([]*clientChain, 0, len(r.active))
	for chain := range r.active {
		chains = append(chains, chain)
	}
	r.mu.Unlock()
	for _, chain := range chains {
		chain.Close()
	}
}

// The standard OpenSSH known_hosts verifier supports hashed names, revocation,
// and host certificates. Its file API needs a transient public-key file; no
// private keys or passwords are written out during unlock or connection setup.
func hostKeyCallback(data string) (ssh.HostKeyCallback, error) {
	file, err := os.CreateTemp("", ".artiface-host-keys-*")
	if err != nil {
		return nil, errors.New("could not prepare imported host-key checks")
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = io.WriteString(file, data); err == nil {
		err = file.Close()
	}
	if err != nil {
		return nil, errors.New("could not prepare imported host-key checks")
	}
	check, err := knownhosts.New(file.Name())
	if err != nil {
		return nil, errors.New("imported known_hosts data is invalid")
	}
	return check, nil
}

func CheckKnownHosts(data string) error {
	_, err := hostKeyCallback(data)
	return err
}

type clientChain struct {
	client  *ssh.Client
	mu      sync.Mutex
	clients []*ssh.Client
	pending net.Conn
	closed  bool
	cancel  context.CancelFunc
	onClose func()
	once    sync.Once
}

func (c *clientChain) Close() {
	c.once.Do(func() {
		if c.cancel != nil {
			c.cancel()
		}
		c.mu.Lock()
		c.closed = true
		clients, pending := c.clients, c.pending
		c.clients, c.pending = nil, nil
		c.mu.Unlock()
		// Close the physical transport first so forwarded-channel writers
		// cannot hold shutdown behind a stalled jump host.
		for _, client := range clients {
			_ = client.Close()
		}
		if pending != nil {
			_ = pending.Close()
		}
		if c.onClose != nil {
			c.onClose()
		}
	})
}

func (c *clientChain) setPending(conn net.Conn) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		_ = conn.Close()
		return os.ErrClosed
	}
	c.pending = conn
	return nil
}

func (c *clientChain) addClient(client *ssh.Client) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		_ = client.Close()
		return os.ErrClosed
	}
	c.pending = nil
	c.clients = append(c.clients, client)
	// Only connect writes this pointer; consumers receive the chain after
	// connection setup finishes. Close acts on clients under the mutex.
	c.client = client
	return nil
}

// connect copies authentication objects while holding the credential lock, but
// performs network I/O without it so a slow host cannot block local/admin work.
func (r *Runtime) connect(ctx context.Context, target string) (*clientChain, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r.disabled {
		return nil, ErrDisabled
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, os.ErrClosed
	}
	if r.envelope != nil && !r.unlocked {
		r.mu.Unlock()
		return nil, ErrLocked
	}
	type hop struct {
		address string
		config  *ssh.ClientConfig
	}
	var hops []hop
	profiles, err := r.bundle.chain(target)
	if err != nil {
		r.mu.Unlock()
		return nil, err
	}
	envelope := r.envelope
	for _, p := range profiles {
		var auth []ssh.AuthMethod
		var signers []ssh.Signer
		for _, id := range p.Keys {
			signer, err := ssh.ParsePrivateKey(r.bundle.Keys[id])
			if err != nil {
				r.mu.Unlock()
				return nil, errors.New("could not read an imported private key")
			}
			signers = append(signers, signer)
		}
		if len(signers) > 0 {
			auth = append(auth, ssh.PublicKeys(signers...))
		}
		if len(p.Password) > 0 {
			auth = append(auth, ssh.Password(string(p.Password)))
		}
		check := r.check[p.KnownHosts]
		baseCheck := check
		alias := p.HostKeyAlias
		if alias != "" {
			// OpenSSH's HostKeyAlias replaces the hostname used for trust checks.
			address := alias
			if _, _, err := net.SplitHostPort(address); err != nil {
				address = net.JoinHostPort(alias, "22")
			}
			check = func(_ string, remote net.Addr, key ssh.PublicKey) error {
				return baseCheck(address, remote, key)
			}
		}
		check = r.confirmHostKey(target, p, envelope, check)
		hops = append(hops, hop{p.Address(), &ssh.ClientConfig{
			User: p.User, Auth: auth, HostKeyCallback: check,
			Timeout: 10 * time.Second,
		}})
	}
	ctx, cancel := context.WithCancel(ctx)
	chain := &clientChain{cancel: cancel}
	chain.onClose = func() {
		r.mu.Lock()
		delete(r.active, chain)
		r.mu.Unlock()
	}
	r.active[chain] = target
	r.mu.Unlock()
	stopChain := context.AfterFunc(ctx, chain.Close)
	success := false
	defer func() {
		// Successful SFTP transports outlive the request which created them;
		// the storage pool owns cancellation after this setup phase.
		stopChain()
		if !success {
			chain.Close()
		}
	}()
	for _, hop := range hops {
		var conn net.Conn
		if chain.client == nil {
			conn, err = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 15 * time.Second}).DialContext(ctx, "tcp", hop.address)
		} else {
			conn, err = chain.client.DialContext(ctx, "tcp", hop.address)
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, errors.New("SSH connection failed; check the saved address and jump hosts")
		}
		if err := chain.setPending(conn); err != nil {
			return nil, err
		}
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
		connection, channels, requests, handshakeErr := ssh.NewClientConn(conn, hop.address, hop.config)
		stop()
		if handshakeErr != nil {
			_ = conn.Close()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			var confirmation *HostKeyError
			if errors.As(handshakeErr, &confirmation) {
				return nil, confirmation
			}
			if errors.Is(handshakeErr, ErrHostKeyExpired) {
				return nil, ErrHostKeyExpired
			}
			return nil, errors.New("SSH authentication or host-key verification failed; check the saved credentials and trusted host keys")
		}
		if err = ctx.Err(); err != nil {
			_ = connection.Close()
			return nil, err
		}
		_ = conn.SetDeadline(time.Time{})
		if err := chain.addClient(ssh.NewClient(connection, channels, requests)); err != nil {
			return nil, err
		}
	}
	if !r.Matches(envelope) {
		return nil, ErrHostKeyExpired
	}
	success = true
	return chain, nil
}

type subsystem struct {
	chain   *clientChain
	session *ssh.Session
	input   io.WriteCloser
	output  io.Reader
}

func (s *subsystem) Read(p []byte) (int, error)  { return s.output.Read(p) }
func (s *subsystem) Write(p []byte) (int, error) { return s.input.Write(p) }
func (s *subsystem) Close() error                { s.chain.Close(); return nil }

func (r *Runtime) DialSFTP(ctx context.Context, target string) (io.ReadWriteCloser, error) {
	chain, err := r.connect(ctx, target)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, chain.Close)
	defer stop()
	session, err := chain.client.NewSession()
	if err != nil {
		chain.Close()
		return nil, errors.New("SSH could not open a session")
	}
	input, err := session.StdinPipe()
	if err != nil {
		chain.Close()
		return nil, err
	}
	output, err := session.StdoutPipe()
	if err != nil {
		chain.Close()
		return nil, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		chain.Close()
		return nil, err
	}
	if err = session.RequestSubsystem("sftp"); err != nil {
		chain.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("SSH server did not accept SFTP")
	}
	if ctx.Err() != nil {
		chain.Close()
		return nil, ctx.Err()
	}
	go func() { _, _ = io.Copy(io.Discard, stderr) }()
	return &subsystem{chain, session, input, output}, nil
}

func (r *Runtime) Run(ctx context.Context, target, command string, output io.Writer) error {
	chain, err := r.connect(ctx, target)
	if err != nil {
		return err
	}
	defer chain.Close()
	stop := context.AfterFunc(ctx, chain.Close)
	defer stop()
	session, err := chain.client.NewSession()
	if err != nil {
		return errors.New("SSH could not open a command session")
	}
	session.Stdout, session.Stderr = output, io.Discard
	return session.Run(command)
}
