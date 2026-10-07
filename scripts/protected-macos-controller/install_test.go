package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"howett.net/plist"
)

func TestInstallStagesInactivePlistOnlyInPrivateRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(t.TempDir(), `private & <root> "quoted" 'single' space`)
	if err := os.Mkdir(root, 0700); err != nil {
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
	plistPath := plists[0]
	for path, mode := range map[string]os.FileMode{filepath.Join(root, "launchd"): 0700, plistPath: 0600, filepath.Join(root, "config.json"): 0600, filepath.Join(root, "protected-macos-controller"): 0700} {
		if st, err := os.Stat(path); err != nil || st.Mode().Perm() != mode {
			t.Fatalf("%s not private %o: %v", filepath.Base(path), mode, err)
		}
	}
	before, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatal(err)
	}
	type serviceDefinition struct {
		Label            string
		ProgramArguments []string
		RunAtLoad        bool
	}
	// Decode the actual staged XML independently of the production encoder.
	var parsed serviceDefinition
	format, err := plist.Unmarshal(before, &parsed)
	if err != nil {
		t.Fatal(err)
	}
	if format != plist.XMLFormat {
		t.Fatalf("staged plist is not XML: format %d", format)
	}
	want := []string{filepath.Join(root, "protected-macos-controller"), "run", "--config", filepath.Join(root, "config.json")}
	if !slices.Equal(parsed.ProgramArguments, want) || parsed.Label+".plist" != filepath.Base(plistPath) || !strings.HasPrefix(parsed.Label, "com.fitchmultz.protected-macos-") || !parsed.RunAtLoad {
		t.Fatalf("staged service definition wrong: %+v", parsed)
	}
	if runtime.GOOS == "darwin" {
		// macOS must also accept the staged plist with its real platform tool.
		raw, err := exec.Command("/usr/bin/plutil", "-convert", "json", "-o", "-", plistPath).Output()
		if err != nil {
			t.Fatal(err)
		}
		var native serviceDefinition
		if err := json.Unmarshal(raw, &native); err != nil {
			t.Fatal(err)
		}
		if native.Label != parsed.Label || !slices.Equal(native.ProgramArguments, parsed.ProgramArguments) || native.RunAtLoad != parsed.RunAtLoad {
			t.Fatalf("platform plist semantics differ: native %+v, portable %+v", native, parsed)
		}
		t.Log("/usr/bin/plutil -convert json -o -: exit 0; native and portable service semantics agree")
	}
	if err := install(config{Root: root}, input); err == nil {
		t.Fatal("second install replaced the working deployment")
	}
	if after, err := os.ReadFile(plistPath); err != nil || string(after) != string(before) {
		t.Fatal("refused install modified the staged plist")
	}
}
