package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func xmlText(value string) string {
	var text strings.Builder
	_ = xml.EscapeText(&text, []byte(value))
	return text.String()
}

func install(c config, sourceConfig string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	binary, err := os.ReadFile(executable)
	if err != nil {
		return err
	}
	rawConfig, err := os.ReadFile(sourceConfig)
	if err != nil {
		return err
	}
	bin := filepath.Join(c.Root, "protected-macos-controller")
	destinationConfig := filepath.Join(c.Root, "config.json")
	// The plist is only staged in the private root: launchd never sees it until
	// the reviewed-source owner separately activates it.
	staging := filepath.Join(c.Root, "launchd")
	hash := sha256.Sum256([]byte(c.Root))
	label := "com.fitchmultz.protected-macos-" + hex.EncodeToString(hash[:6])
	plistPath := filepath.Join(staging, label+".plist")
	// No replacement of existing deployments.
	for _, path := range []string{bin, destinationConfig, staging} {
		if path == sourceConfig {
			return errors.New("install from configuration outside destination root")
		}
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			return errors.New("installation destination already exists; preserve working deployment")
		}
	}
	for _, filename := range []string{"stdout.log", "stderr.log"} {
		f, err := os.OpenFile(filepath.Join(c.Root, filename), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	if err := atomicWrite(bin, binary); err != nil {
		return err
	}
	if err := os.Chmod(bin, 0700); err != nil {
		return err
	}
	if err := atomicWrite(destinationConfig, rawConfig); err != nil {
		return err
	}
	if err := os.Mkdir(staging, 0700); err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array><string>%s</string><string>run</string><string>--config</string><string>%s</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>%s</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, xmlText(label), xmlText(bin), xmlText(destinationConfig), xmlText(filepath.Join(c.Root, "stdout.log")), xmlText(filepath.Join(c.Root, "stderr.log")))
	if err := atomicWrite(plistPath, []byte(plist)); err != nil {
		return err
	}
	fmt.Printf(`Staged INACTIVE nonroot user LaunchAgent: %s
No API, runner or service activation performed; nothing was written to ~/Library/LaunchAgents.
Owner activation, after reviewing the staged plist:
  cp -n %s "$HOME/Library/LaunchAgents/%s.plist"
  launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/%s.plist"
`, plistPath, shellQuote(plistPath), label, label)
	return nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
