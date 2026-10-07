package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const repository = "fitchmultz/pi-subagents"
const repositoryURL = "https://github.com/" + repository
const scaleSetName = "protected-macos-arm64"

var requiredLabels = []string{"self-hosted", "macOS", "ARM64", scaleSetName}

type config struct {
	Version     int    `json:"version"`
	Root        string `json:"root"`
	NativeState string `json:"nativeState"`
	Node        string `json:"node"`
	Helper      string `json:"helper"`
	AuthFile    string `json:"authFile"`
}

type credentials struct {
	PAT            string `json:"pat,omitempty"`
	AppID          int64  `json:"appId,omitempty"`
	ClientID       string `json:"clientId,omitempty"`
	InstallationID int64  `json:"installationId,omitempty"`
	PrivateKey     string `json:"privateKey,omitempty"`
}

func privatePath(path string, directory bool) error {
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	native, ok := st.Sys().(*syscall.Stat_t)
	if !ok || int(native.Uid) != os.Getuid() || st.Mode().Perm()&0077 != 0 || st.IsDir() != directory || st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("not an owned private %s", filepath.Base(path))
	}
	if !directory && !st.Mode().IsRegular() {
		return errors.New("private input is not a regular file")
	}
	return nil
}

// maxPrivateJSON bounds every private JSON input, including the journal the
// next owner reads; journal.update refuses to publish anything larger.
const maxPrivateJSON = 2 << 20

func readJSON(path string, target any) error {
	if err := privatePath(path, false); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, maxPrivateJSON))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("trailing or oversized JSON input")
	}
	return nil
}

func loadConfig(path string) (config, error) {
	var c config
	if os.Getuid() == 0 {
		return c, errors.New("controller must run as a nonroot user")
	}
	if err := readJSON(path, &c); err != nil {
		return c, err
	}
	if c.Version != 1 {
		return c, errors.New("unsupported configuration version")
	}
	for _, p := range []string{c.Root, c.NativeState, c.Node, c.Helper, c.AuthFile} {
		if !filepath.IsAbs(p) || strings.ContainsAny(p, "\x00\r\n") {
			return c, errors.New("configuration paths must be absolute single-line paths")
		}
	}
	if err := privatePath(c.Root, true); err != nil {
		return c, err
	}
	for _, p := range []string{c.Node, c.Helper} {
		st, err := os.Stat(p)
		if err != nil {
			return c, err
		}
		if !st.Mode().IsRegular() || st.Mode().Perm()&0022 != 0 {
			return c, errors.New("trusted executable/source cannot be group or world writable")
		}
	}
	return c, nil
}
