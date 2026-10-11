package ignore

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"unicode/utf8"
)

const Filename = ".artifaceignore"

var (
	ErrConflict = errors.New("ignore file changed; reload before saving")
	ErrDisabled = errors.New("editing ignore rules requires an existing configuration file")
	ErrUnsafe   = errors.New("configuration and ignore files must be regular files without links")
	fileMu      sync.RWMutex
)

type Document struct {
	Content  string `json:"content"`
	Revision string `json:"revision"`
	Path     string `json:"path"`
	Editable bool   `json:"editable"`
}

func document(content, filename string, exists, editable bool) Document {
	state := "missing\x00"
	if exists {
		state = "file\x00"
	}
	hash := sha256.Sum256([]byte(state + content))
	return Document{Content: content, Revision: hex.EncodeToString(hash[:]), Path: filename, Editable: editable}
}

// Load never creates a file.
// A configured path with no actual config file behaves like disabled persistence.
func Load(configFile string) (Document, error) {
	fileMu.RLock()
	defer fileMu.RUnlock()
	dir, filename, err := directoryFor(configFile)
	if errors.Is(err, ErrDisabled) {
		return document(DefaultContent, filename, false, false), nil
	}
	if err != nil {
		return Document{}, err
	}
	defer dir.Close()
	doc, _, err := readDocument(dir, filename)
	return doc, err
}

func directoryFor(configFile string) (*os.File, string, error) {
	if configFile == "" {
		return nil, "", ErrDisabled
	}
	absolute, err := filepath.Abs(configFile)
	if err != nil {
		return nil, "", err
	}
	filename := filepath.Join(filepath.Dir(absolute), Filename)
	if absolute == filename {
		return nil, filename, ErrUnsafe
	}
	dir, err := openDirectory(filepath.Dir(absolute))
	if errors.Is(err, os.ErrNotExist) {
		return nil, filename, ErrDisabled
	}
	if err != nil {
		return nil, filename, err
	}
	// Inspect metadata only; no password or other configuration bytes are read.
	file, err := openAt(dir, filepath.Base(absolute), os.O_RDONLY, 0)
	if err != nil {
		dir.Close()
		if errors.Is(err, os.ErrNotExist) {
			err = ErrDisabled
		}
		return nil, filename, err
	}
	info, err := file.Stat()
	file.Close()
	if err == nil {
		err = checkPath(info, false)
	}
	if err != nil {
		dir.Close()
		return nil, filename, err
	}
	return dir, filename, nil
}

func readDocument(dir *os.File, filename string) (Document, os.FileInfo, error) {
	file, err := openAt(dir, Filename, os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return document(DefaultContent, filename, false, true), nil, nil
	}
	if err != nil {
		return Document{}, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Document{}, nil, err
	}
	if err := checkPath(info, false); err != nil {
		return Document{}, nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, MaxContentBytes+1))
	if err != nil {
		return Document{}, nil, err
	}
	if len(data) > MaxContentBytes || !utf8.Valid(data) {
		return Document{}, nil, errors.New("ignore file must be UTF-8 and at most 64 KiB")
	}
	return document(string(data), filename, true, true), info, nil
}

// EnsureDefaults atomically creates the sibling ignore file with mode 0600
// when it is missing, leaving existing content (including empty files) intact.
func EnsureDefaults(configFile string) error {
	_, err := save(configFile, DefaultContent, "", true)
	return err
}

// Save atomically replaces only the sibling ignore file with mode 0600.
// Saves serialize across threads/processes and recheck content and identity.
// As with config.Update, noncooperating external writers must avoid the final
// check/rename window; creation uses an exclusive hard link to avoid that race.
func Save(configFile, content, revision string) (Document, error) {
	return save(configFile, content, revision, false)
}

func save(configFile, content, revision string, createOnly bool) (Document, error) {
	if _, err := Compile(content); err != nil {
		return Document{}, err
	}
	fileMu.Lock()
	defer fileMu.Unlock()
	dir, filename, err := directoryFor(configFile)
	if err != nil {
		return Document{}, err
	}
	defer dir.Close()
	if err := lockDirectory(dir); err != nil {
		return Document{}, err
	}
	before, original, err := readDocument(dir, filename)
	if err != nil {
		return Document{}, err
	}
	if createOnly && original != nil {
		return before, nil
	}
	if !createOnly && (revision == "" || before.Revision != revision) {
		return Document{}, ErrConflict
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Document{}, err
	}
	temp := ".artiface-ignore-" + hex.EncodeToString(random[:])
	file, err := openAt(dir, temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return Document{}, err
	}
	defer removeAt(dir, temp)
	defer file.Close()
	if _, err := io.WriteString(file, content); err != nil {
		return Document{}, err
	}
	if err := file.Sync(); err != nil {
		return Document{}, err
	}
	if err := file.Close(); err != nil {
		return Document{}, err
	}
	current, info, err := readDocument(dir, filename)
	if err != nil || current.Revision != before.Revision ||
		original != nil && (info == nil || !os.SameFile(original, info)) {
		return Document{}, ErrConflict
	}
	if err := installAt(dir, temp, original == nil); err != nil {
		return Document{}, err
	}
	if err := dir.Sync(); err != nil {
		return Document{}, err
	}
	return document(content, filename, true, true), nil
}
