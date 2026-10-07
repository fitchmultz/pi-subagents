package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestInstallStagesInactivePlistOnlyInPrivateRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(t.TempDir(), "config-input.json")
	if err := os.WriteFile(input, []byte(`{"version":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := install(config{Root: root}, input); err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(home); err != nil || len(entries) != 0 {
		t.Fatalf("install wrote outside the private root (launchd would load it): %v %v", entries, err)
	}
	plists, err := filepath.Glob(filepath.Join(root, "launchd", "*.plist"))
	if err != nil || len(plists) != 1 {
		t.Fatalf("staged plist missing: %v %v", plists, err)
	}
	plist := plists[0]
	for path, mode := range map[string]os.FileMode{filepath.Join(root, "launchd"): 0700, plist: 0600, filepath.Join(root, "config.json"): 0600, filepath.Join(root, "protected-macos-controller"): 0700} {
		if st, err := os.Stat(path); err != nil || st.Mode().Perm() != mode {
			t.Fatalf("%s not private %o: %v", filepath.Base(path), mode, err)
		}
	}
	// Parse with the platform plist tool, not the generator.
	raw, err := exec.Command("/usr/bin/plutil", "-convert", "json", "-o", "-", plist).Output()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Label            string
		ProgramArguments []string
		RunAtLoad        bool
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(root, "protected-macos-controller"), "run", "--config", filepath.Join(root, "config.json")}
	if !slices.Equal(parsed.ProgramArguments, want) || parsed.Label+".plist" != filepath.Base(plist) || !strings.HasPrefix(parsed.Label, "com.fitchmultz.protected-macos-") || !parsed.RunAtLoad {
		t.Fatalf("staged service definition wrong: %+v", parsed)
	}
	before, err := os.ReadFile(plist)
	if err != nil {
		t.Fatal(err)
	}
	if err := install(config{Root: root}, input); err == nil {
		t.Fatal("second install replaced the working deployment")
	}
	if after, err := os.ReadFile(plist); err != nil || string(after) != string(before) {
		t.Fatal("refused install modified the staged plist")
	}
}
