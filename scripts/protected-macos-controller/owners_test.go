package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/actions/scaleset"
	"github.com/google/go-github/v88/github"
)

func TestSourceResolverJoinsOpaqueSDKIdentityAndHistoricalPRMerge(t *testing.T) {
	base := strings.Repeat("a", 40)
	head := strings.Repeat("b", 40)
	merge := strings.Repeat("c", 40)
	tree := strings.Repeat("d", 40)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/fitchmultz/pi-subagents/actions/runs/55/attempts/2":
			fmt.Fprintf(w, `{"id":55,"run_attempt":2,"event":"pull_request","head_sha":"%s","repository":{"full_name":"fitchmultz/pi-subagents"}}`, head)
		case "/repos/fitchmultz/pi-subagents/actions/runs/55/attempts/2/jobs":
			fmt.Fprintf(w, `{"total_count":1,"jobs":[{"id":8009,"run_id":55,"run_attempt":2,"name":"Mac qualification","runner_id":701,"runner_name":"owned-runner","head_sha":"%s"}]}`, head)
		case "/repos/fitchmultz/pi-subagents/git/commits/" + merge:
			fmt.Fprintf(w, `{"sha":"%s","tree":{"sha":"%s"},"parents":[{"sha":"%s"},{"sha":"%s"}]}`, merge, tree, base, head)
		case "/repos/fitchmultz/pi-subagents/git/trees/" + tree:
			fmt.Fprintf(w, `{"sha":"%s","truncated":false,"tree":[{"path":"package.json","type":"blob","mode":"100644","sha":"%s"}]}`, tree, strings.Repeat("e", 40))
		case "/repos/fitchmultz/pi-subagents/git/commits/" + head:
			fmt.Fprintf(w, `{"sha":"%s","tree":{"sha":"%s"},"parents":[{"sha":"%s"}]}`, head, tree, base)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	url := server.URL + "/"
	api, err := github.NewClient(github.WithURLs(&url, &url))
	if err != nil {
		t.Fatal(err)
	}
	a := slot{RunnerID: 701, RunnerName: "owned-runner", Assignment: &scaleset.JobStarted{RunnerID: 701, RunnerName: "owned-runner", JobMessageBase: scaleset.JobMessageBase{RunnerRequestID: 101, WorkflowRunID: 55, JobID: "opaque-uuid-NOT8009", OwnerName: "fitchmultz", RepositoryName: "pi-subagents", EventName: "pull_request", JobDisplayName: "Mac qualification", JobWorkflowRef: "fitchmultz/pi-subagents/.github/workflows/ci.yml@refs/pull/162/merge", RequestLabels: []string{"self-hosted", "macOS", "ARM64", "protected-macos-arm64"}}}}
	hook := hookContext{Repository: repository, RunID: 55, Attempt: 2, Event: "pull_request", Ref: "refs/pull/162/merge", SHA: merge, PRNumber: 999, BaseSHA: strings.Repeat("f", 40), HeadSHA: head, Nonce: strings.Repeat("e", 64)}
	binding, err := resolveSource(context.Background(), api, a, hook)
	if err != nil {
		t.Fatal(err)
	}
	if binding.JobID != 8009 || binding.SDKJobID != "opaque-uuid-NOT8009" || binding.SHA != merge || binding.Tree != tree || binding.HeadSHA != head || binding.BaseSHA != base || binding.Attempt != 2 {
		t.Fatalf("incorrect authoritative join: %+v", binding)
	}
	for _, bad := range []hookContext{
		{Repository: repository, RunID: 55, Attempt: 2, Event: "pull_request", Ref: hook.Ref, SHA: head, PRNumber: 162, BaseSHA: base, HeadSHA: head, Nonce: hook.Nonce},
		{Repository: repository, RunID: 55, Attempt: 2, Event: "pull_request", Ref: "refs/pull/162/head", SHA: merge, PRNumber: 162, BaseSHA: head, HeadSHA: head, Nonce: hook.Nonce},
		{Repository: repository, RunID: 56, Attempt: 2, Event: "pull_request", Ref: hook.Ref, SHA: merge, PRNumber: 162, BaseSHA: base, HeadSHA: head, Nonce: hook.Nonce},
	} {
		if _, err := resolveSource(context.Background(), api, a, bad); err == nil {
			t.Fatal("forged/head-only/unassociated source accepted")
		}
	}
}

func TestJournalSingletonAtomicFailureAndProcessRestart(t *testing.T) {
	j, _ := testJournal(t)
	if _, err := openJournal(j.root); err == nil {
		t.Fatal("concurrent owner admitted")
	}
	sentinel := errors.New("original transaction failure")
	if err := j.update(func(s *state) error { s.Active = newSlot(); return sentinel }); !errors.Is(err, sentinel) {
		t.Fatal("original error identity lost")
	}
	if j.snapshot().Active != nil {
		t.Fatal("failed transaction published mutable partial state")
	}
	a := newSlot()
	a.Phase = "launched"
	if err := j.update(func(s *state) error { s.Active = a; return nil }); err != nil {
		t.Fatal(err)
	}
	// State the next owner could not read back (private JSON input is 2 MiB) is
	// never published, and refusing it is not a sticky journal failure.
	published, err := os.ReadFile(filepath.Join(j.root, "controller.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := j.update(func(s *state) error { s.Control = strings.Repeat("x", 2<<20); return nil }); err == nil {
		t.Fatal("unreadable journal state published")
	}
	if after, err := os.ReadFile(filepath.Join(j.root, "controller.json")); err != nil || string(after) != string(published) || j.failure() != nil || j.snapshot().Control != "" {
		t.Fatalf("oversized refusal changed or poisoned the journal: %v failure=%v", err, j.failure())
	}
	if err := j.update(func(s *state) error { s.Active.Phase = "launched"; return nil }); err != nil {
		t.Fatalf("journal unusable after refusing oversized state: %v", err)
	}
	_ = j.guard.Close()
	next, err := openJournal(j.root)
	if err != nil {
		t.Fatal(err)
	}
	defer next.guard.Close()
	if next.snapshot().Active.OperationID != a.OperationID || next.snapshot().Active.Phase != "launched" {
		t.Fatal("restart freed busy native slot")
	}
	st, err := os.Stat(filepath.Join(j.root, "controller.json"))
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatal("journal not private")
	}
}

func TestMain(m *testing.M) {
	if len(os.Args) >= 5 && os.Args[2] == "journal-fixture" {
		root := os.Args[4]
		j, err := openJournal(root)
		if err != nil {
			os.Exit(2)
		}
		a := newSlot()
		a.Phase = "bound"
		if err := j.update(func(s *state) error { s.Active = a; return nil }); err != nil {
			os.Exit(2)
		}
		var native *nativeSession
		if _, err := os.Stat(filepath.Join(root, "with-native")); err == nil {
			// The independent native owner, started exactly as production does.
			if native, err = startNative(config{Node: os.Args[0], Helper: "-test.run=^$", NativeState: root}); err != nil {
				os.Exit(2)
			}
		}
		_ = json.NewEncoder(os.Stdout).Encode(a)
		_, _ = bufio.NewReader(os.Stdin).ReadByte()
		runtime.KeepAlive(native) // Its input pipe stays open until this process ends.
		os.Exit(2)
	}
	if len(os.Args) >= 5 && os.Args[2] == "controller" {
		nativeProtocolFixture(os.Args[4])
		return
	}
	os.Exit(m.Run())
}

// Keeper: a cold Go exit releases the Go singleton guard for the next owner,
// also while the independent native owner it executed is still alive, and the
// durable busy slot is retained. Both fixture processes inherit the write end
// of a test-owned pipe; its EOF is their actual exit. The root is removed only
// after that join, and is otherwise retained for diagnosis.
func TestColdCrashReleasesKernelGuardButRetainsDurableBusySlot(t *testing.T) {
	for _, mode := range []string{"no-native-child", "live-native-child"} {
		t.Run(mode, func(t *testing.T) {
			root, err := os.MkdirTemp("", "pmc-cold-crash-") // Private (0700).
			if err != nil {
				t.Fatal(err)
			}
			end := func() error { return nil } // No fixture process yet.
			t.Cleanup(func() {
				if err := end(); err != nil {
					t.Errorf("%v; retained %s", err, root)
					return
				}
				if err := os.RemoveAll(root); err != nil {
					t.Error(err)
				}
			})
			withNative := mode == "live-native-child"
			if withNative {
				for _, name := range []string{"with-native", "hold-exit"} {
					if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			child := exec.Command(executable, "-test.run=^$", "journal-fixture", "--state", root)
			input, err := child.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			output, err := child.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			lifetime, held, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			child.ExtraFiles = []*os.File{held} // Not close-on-exec: the native owner inherits it too.
			err = child.Start()
			held.Close()
			if err != nil {
				lifetime.Close()
				t.Fatal(err)
			}
			// Only EOF proves exit; closing the read end must not count as a join.
			var lifetimeErr error
			exited := make(chan struct{})
			go func() {
				_, lifetimeErr = io.Copy(io.Discard, lifetime)
				close(exited)
			}()
			// End the fixture child, release a held native owner while its root
			// still exists, then join the actual exit of every process holding the pipe.
			end = func() error {
				defer lifetime.Close()
				if child.ProcessState == nil {
					_ = child.Process.Kill()
					_ = child.Wait()
				}
				if withNative {
					if err := os.WriteFile(filepath.Join(root, "release-exit"), []byte("release"), 0600); err != nil {
						return fmt.Errorf("native owner not released: %w", err)
					}
				}
				select {
				case <-exited:
					return lifetimeErr
				case <-time.After(10 * time.Second):
					return errors.New("fixture processes still alive")
				}
			}
			var published slot
			if err := json.NewDecoder(output).Decode(&published); err != nil {
				t.Fatal(err)
			}
			if published.Phase != "bound" || published.OperationID == "" {
				t.Fatal("child did not durably publish owned work")
			}
			if withNative {
				waitForFile(t, filepath.Join(root, "stdin-read")) // The native owner is running.
			}
			if _, err := openJournal(root); err == nil {
				t.Fatal("actual live process singleton bypassed")
			}
			if err := child.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := child.Wait(); err == nil {
				t.Fatal("controlled cold crash did not occur")
			}
			if withNative {
				// The native owner observed EOF and is still alive, held for release.
				waitForFile(t, filepath.Join(root, "eof-received"))
			}
			recovered, err := openJournal(root)
			if err != nil {
				t.Fatalf("Go guard not reacquirable after the cold exit: %v", err)
			}
			defer recovered.guard.Close()
			current := recovered.snapshot().Active
			if current == nil || current.OperationID != published.OperationID || current.Phase != "bound" {
				t.Fatal("cold crash freed occupied native slot")
			}
			select {
			case <-exited:
				if withNative {
					t.Fatal("native owner exited before the Go guard was reacquired")
				}
			default:
				if !withNative {
					<-exited // The killed fixture child was its only holder.
				}
			}
		})
	}
}

func nativeProtocolFixture(root string) {
	exists := func(name string) bool { _, err := os.Stat(filepath.Join(root, name)); return err == nil }
	waitFor := func(name string) {
		for !exists(name) {
			if !exists(".") { // Root removed: nothing will ever release this owner.
				os.Exit(2)
			}
			time.Sleep(time.Millisecond)
		}
	}
	publish := func(name, content string) {
		if os.WriteFile(filepath.Join(root, name), []byte(content), 0600) != nil {
			os.Exit(2)
		}
	}
	if exists("block-start") {
		publish("start-held", "actual child before input")
		waitFor("release")
	}
	log, err := os.OpenFile(filepath.Join(root, "actions"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(2)
	}
	launches := 0
	input := &publishOnRead{r: os.Stdin, publish: func() { publish("stdin-read", "native began reading requests") }}
	// Mirrors protocol-v1 native ownership: the SDK runner ID is saved before launch
	// assertions, so an unlaunched settle with that ID requires Go's absence proof.
	savedRunnerID, launched, savedRunnerName, savedOperation := 0, false, "", ""
	// noJob tracks what forbids native's EOF idle interruption: any capture,
	// bind, accepted completion or disposal.
	noJob := true
	reader := bufio.NewReader(input)
	for {
		// Protocol v1 acts only on newline-terminated frames; an unterminated
		// frame at EOF fails closed.
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if len(line) > 0 {
				os.Exit(2)
			}
			break
		}
		var req nativeRequest
		if json.Unmarshal(line, &req) != nil {
			os.Exit(2)
		}
		entry := req.Action
		if req.Completion != nil {
			entry += "+completion"
		}
		if _, err := fmt.Fprintln(log, entry); err != nil {
			os.Exit(2)
		}
		ok := true
		result := nativeReply{Prepared: true, Phase: req.Action, Launched: launched}
		noJob = noJob && req.Completion == nil && req.Action != "bind"
		// A durable idle interruption of this operation (written by an earlier
		// owner at EOF) answers capture and status with the proof; settle must
		// carry the exact interrupted terminal for the saved runner identity.
		if raw, err := os.ReadFile(filepath.Join(root, "idle-interrupted-"+req.OperationID)); err == nil {
			proof := nativeReply{Phase: "idle-interrupted", Launched: true, TransportEnded: true, InterruptedUnassigned: true}
			term, want := req.Terminal, fmt.Sprintf("%d %s", req.RunnerID, req.RunnerName)
			switch req.Action {
			case "capture", "status":
				result = proof
			case "settle":
				ok = term != nil && term.InterruptedUnassigned && term.NoJob && term.RegistrationAbsent && string(raw) == want && term.RunnerID == req.RunnerID && term.RunnerName == req.RunnerName && term.RequestID == 0 && term.RunID == 0 && term.Attempt == 0 && term.JobID == 0 && term.Conclusion == "" && !term.Canceled && !term.Vetoed && req.Binding == nil && req.Completion == nil
				result = proof
				result.Phase, result.Disposed = "disposed", true
			default:
				ok = false
			}
			_ = json.NewEncoder(os.Stdout).Encode(nativeEnvelope{Version: 1, ID: req.ID, OperationID: req.OperationID, OK: ok, Result: result})
			continue
		}
		switch req.Action {
		case "prepare":
			publish("prepare-published", "actual-process-prepare")
			if exists("block-prepare") {
				waitFor("release")
			}
		case "capture":
			if exists("block-capture") {
				publish("request-published", "actual-child-received")
				waitFor("release")
			}
			if raw, err := os.ReadFile(filepath.Join(root, "capture.json")); err == nil {
				var capture nativeCapture
				if json.Unmarshal(raw, &capture) != nil {
					os.Exit(2)
				}
				capture.OperationID, capture.RunnerName = req.OperationID, req.RunnerName
				result.Capture = &capture
				noJob = false
			}
		case "bind":
			// Protocol v1: an accepted SDK completion closes capture before any ACK.
			ok = req.Completion == nil && req.Binding != nil
			result.Phase = "bound"
		case "status":
			result.TransportEnded = launched && (req.Completion != nil || exists("listener-exited"))
			if result.TransportEnded {
				publish("transport-ended", "official listener exited")
			}
		case "drain":
			// Protocol v1: noJob proof before deletion, with the SDK completion attached.
			ok = req.Terminal != nil && req.Terminal.NoJob && req.Terminal.Canceled && !req.Terminal.RegistrationAbsent && req.Completion != nil
			if ok {
				publish("drain-published", "idle listener stopped")
			}
			result.TransportEnded = true
			result.Phase = "drained"
		case "settle":
			absent := req.Terminal != nil && req.Terminal.RegistrationAbsent
			switch {
			case launched:
				ok = absent
			case savedRunnerID > 0:
				ok = absent && req.Terminal.RunnerID == savedRunnerID && req.Terminal.RunnerName == req.RunnerName
			}
			result.Disposed = true
			result.TransportEnded = true
			result.SourceVerified = req.Binding != nil
			result.VetoVerified = req.Terminal != nil && req.Terminal.Vetoed
			result.Phase = "disposed"
			noJob = false
		case "launch":
			savedRunnerID, savedRunnerName, savedOperation = req.RunnerID, req.RunnerName, req.OperationID
			if exists("fail-launch") {
				ok = false
			} else {
				launches++
				publish("launch-count", fmt.Sprintf("%d", launches))
				launched = true
				result.Launched = true
			}
		}
		id := req.ID
		if exists("bad-reply") { // One-shot reply identity mismatch.
			_ = os.Remove(filepath.Join(root, "bad-reply"))
			id += 1000
		}
		_ = json.NewEncoder(os.Stdout).Encode(nativeEnvelope{Version: 1, ID: id, OperationID: req.OperationID, OK: ok, Result: result})
	}
	// EOF: where root proves the known idle listener ("eof-idle"), native stops
	// only it, observes the actual transport end and durably records the
	// interruption; nothing remote is deleted.
	if exists("eof-idle") && launched && noJob {
		publish("transport-ended", "known idle listener stopped at EOF")
		publish("idle-interrupted-"+savedOperation, fmt.Sprintf("%d %s", savedRunnerID, savedRunnerName))
	}
	// EOF: the owner may still be settling its own resources before exiting.
	if exists("hold-exit") {
		publish("eof-received", "stdin closed")
		waitFor("release-exit")
	}
	os.Exit(0)
}

// publishOnRead publishes once that the native child began reading stdin.
type publishOnRead struct {
	r       io.Reader
	publish func()
}

func (p *publishOnRead) Read(b []byte) (int, error) {
	if p.publish != nil {
		p.publish()
		p.publish = nil
	}
	return p.r.Read(b)
}

// waitForFile observes actual child publication; it is never ordering proof.
func waitForFile(t *testing.T, path string) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(time.Millisecond) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("actual child publication %s not observed", filepath.Base(path))
		}
	}
}

func TestNativeDeadlineConsumesOriginalReplyBeforeDifferentAction(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	j, own := testJournal(t)
	a := newSlot()
	a.Phase = "launched"
	if err := j.update(func(s *state) error { s.Active = a; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(j.root, "block-capture"), []byte("hold"), 0600); err != nil {
		t.Fatal(err)
	}
	c := &controller{journal: j, config: config{Node: executable, Helper: "-test.run=^$", NativeState: j.root}}
	own(func() error { return endNative(j.root, c.native) })
	if err := c.nativeOwner(); err != nil {
		t.Fatal(err)
	}
	if err := c.dispatch(a.OperationID, "capture", nil); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, filepath.Join(j.root, "request-published"))
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if _, err := c.native.await(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("native deadline lost error: %v", err)
	}
	select {
	case <-c.native.done:
		t.Fatal("deadline killed independent native owner")
	default:
	}
	if err := os.WriteFile(filepath.Join(j.root, "release"), []byte("release"), 0600); err != nil {
		t.Fatal(err)
	}
	// The production follow-on is a different action: the late capture reply
	// must be consumed by its own ID, never returned as the status result.
	reply, err := c.nativeCall(*a, "status", nil)
	if err != nil || reply.Phase != "status" {
		t.Fatalf("late capture reply treated as status: %+v %v", reply, err)
	}
	if actions := nativeActions(t, j.root); !slices.Equal(actions, []string{"capture", "status"}) {
		t.Fatalf("original exchange resent or reordered: %v", actions)
	}
}
