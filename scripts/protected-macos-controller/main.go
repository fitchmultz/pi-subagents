package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

const help = `Protected Mac SDK controller (nonroot, repository scoped, capacity one)
Usage: protected-macos-controller COMMAND --config /absolute/private/config.json

Commands:
  run       Start official SDK listener and resume durable owned lifecycle.
  status    Read local sanitized state; never implies live runner readiness.
  drain     Request no new acquisition; keep current job alive until settlement.
  recover   Request automatic reconciliation/resume; never force-delete state.
  install   Copy this executable/config into the private root and STAGE an
            inactive LaunchAgent plist under <root>/launchd (never activated).

Examples:
  protected-macos-controller install --config "$HOME/.config/protected-macos/config.json"
  protected-macos-controller status --config "$HOME/.config/protected-macos/config.json"
  protected-macos-controller drain --config "$HOME/.config/protected-macos/config.json"

Install NEVER activates the service, writes ~/Library/LaunchAgents or accesses
GitHub. The reviewed-source owner activates separately with the two commands
install prints (cp -n of the staged plist, then launchctl bootstrap gui/$(id -u)).
Host awake/network/login, FileVault and usable keychain context are real
availability ceilings, not 24/7.
Credentials use a private0600 JSON file: {"pat":"..."} OR
{"appId":123,"clientId":"...","installationId":456,"privateKey":"PEM..."}.
No credential/JIT value belongs in argv, logs, guest baseline or public artifacts.
Exit0 completed local command;1 unavailable/retained failure;2 invalid usage.
`

type usageError struct{ cause error }

func (e usageError) Error() string { return e.cause.Error() }
func (e usageError) Unwrap() error { return e.cause }

func main() {
	if err := executeCLI(os.Args[1:]); err != nil {
		// Actual original errors stay owned in memory/private native diagnostics.
		// SDK HTTP error strings can contain bodies/tokens: never print them here.
		fmt.Fprintln(os.Stderr, "Protected Mac controller command failed; owned state retained. Check private configuration/native diagnostics.")
		var usage usageError
		if errors.As(err, &usage) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

func executeCLI(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Print(help)
		return nil
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "absolute owned private configuration file")
	flags.Usage = func() { fmt.Fprint(flags.Output(), help) }
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return usageError{err}
	}
	if *configPath == "" || flags.NArg() != 0 {
		return usageError{errors.New("missing --config or unexpected arguments")}
	}
	c, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	switch command {
	case "status":
		return status(c)
	case "drain", "recover":
		bytes, _ := json.Marshal(map[string]string{"action": command})
		return atomicWrite(filepath.Join(c.Root, "control.json"), bytes)
	case "install":
		return install(c, *configPath)
	case "run":
		j, err := openJournal(c.Root)
		if err != nil {
			return err
		}
		defer j.guard.Close()
		api, err := clients(c, j)
		if err != nil {
			return err
		}
		owner := &controller{journal: j, config: c, api: api, wake: make(chan struct{}, 1), workerDone: make(chan struct{})}
		return owner.run(context.Background())
	default:
		return usageError{errors.New("unknown command")}
	}
}

func status(c config) error {
	var s state
	if err := readJSON(filepath.Join(c.Root, "controller.json"), &s); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// The listener fields are this journal's last local observation, not live readiness.
	capacity := 0
	if s.ListenerUp {
		capacity = availableCapacity(s, false)
	}
	result := map[string]any{"repository": repository, "configuredMaxRunners": 1, "availableCapacity": capacity, "listenerUp": s.ListenerUp, "listenerFailure": s.Listener, "draining": s.Drain, "scaleSetId": s.ScaleSetID, "localJournalOnly": true, "readiness": "local journal, not live readiness", "initialized": s.Version == 1, "availability": "requires awake/networked logged-in host and usable keychain; not live-qualified", "inFlightDemand": len(s.Acquisitions), "admission": s.Admission, "demandRejection": s.DemandRejection, "control": s.Control}
	lateStarts := 0
	for _, entry := range s.Acquisitions {
		if entry.LateStartRunner > 0 {
			lateStarts++
		}
	}
	// Requests the server reported started on an already released runner.
	result["lateStartDemand"] = lateStarts
	if s.Active != nil {
		result["occupied"] = true
		result["phase"] = s.Active.Phase
		result["operationId"] = s.Active.OperationID
		result["runnerId"] = s.Active.RunnerID
		result["readinessObserved"] = s.Active.Ready
		// Go-owned static code and waiting/transient/retained kind only.
		result["diagnostic"] = s.Active.Diagnostic
		result["latestDiagnostic"] = s.Active.LatestDiagnostic
	} else {
		result["occupied"] = false
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
