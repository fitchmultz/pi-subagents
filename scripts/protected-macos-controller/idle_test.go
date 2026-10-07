package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/actions/scaleset"
	"github.com/bradleyfalzon/ghinstallation/v2"
	"github.com/google/go-github/v88/github"
)

// appREST returns an actual go-github REST client authenticated by the actual
// ghinstallation App transport against the fixture, with a synthetic key.
func appREST(t *testing.T, f *sdkFixture) (*github.Client, *ghinstallation.Transport) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	transport, err := ghinstallation.New(f.server.Client().Transport, 1, 9, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	if err != nil {
		t.Fatal(err)
	}
	transport.BaseURL = f.server.URL
	url := f.server.URL + "/"
	rest, err := github.NewClient(github.WithHTTPClient(&http.Client{Transport: transport}), github.WithURLs(&url, &url))
	if err != nil {
		t.Fatal(err)
	}
	return rest, transport
}

// Keeper: a server-canceled acquisition with no job settles only through
// native drain, explicit busy:false offline DELETE and no-job settle. An
// exact-runner start the actual SDK listener accepts during the first
// registration read (before the drain frame), during the read before DELETE,
// while a prior native exchange delays the settle frame after the terminal was
// journaled, or during the held native owner exit before release, retains the
// slot: no contradicted drain/settle frame reaches native, nothing is deleted
// and nothing is freed as canceled-unassigned.
func TestCanceledAcquisitionDrainsNativeBeforeOfflineDeleteWithoutSource(t *testing.T) {
	for _, mode := range []string{"settles", "started-during-first-registration-read", "started-during-registration-read", "started-before-settle-dispatch", "started-during-owner-exit"} {
		t.Run(mode, func(t *testing.T) {
			f := newSDKFixture(t)
			c := newFixtureController(t, f)
			j := c.journal
			a := newSlot()
			a.Phase = "launched"
			a.RunnerID = 701
			base := scaleset.JobMessageBase{RunnerRequestID: 101, WorkflowRunID: 55, JobID: "opaque-idle", OwnerName: "fitchmultz", RepositoryName: "pi-subagents", JobWorkflowRef: "fitchmultz/pi-subagents/.github/workflows/ci.yml@refs/heads/main", RequestLabels: requiredLabels}
			a.AcquireIntent = &scaleset.JobAvailable{JobMessageBase: base}
			a.Completion = &scaleset.JobCompleted{Result: "canceled", RunnerID: 701, RunnerName: a.RunnerName, JobMessageBase: base}
			if err := j.update(func(s *state) error { s.Active = a; return nil }); err != nil {
				t.Fatal(err)
			}
			f.view(func() { f.registered[a.RunnerName] = 701 })
			// deliverStart has the actual SDK listener accept and ACK a start of
			// another request on this exact runner after the cancellation.
			deliverStart := func() {
				f.push(1, job("JobStarted", 102, map[string]any{"runnerId": 701, "runnerName": a.RunnerName}))
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			}
			settled := func() bool {
				return slices.ContainsFunc(nativeActions(t, j.root), func(a string) bool { return strings.HasPrefix(a, "settle") })
			}
			contradicted := diagnostic{"idle drain requires exact authenticated canceled acquisition and no assignment", "retained"}
			switch mode {
			case "started-during-first-registration-read":
				gate, reached := make(chan struct{}), make(chan struct{})
				f.view(func() {
					f.restGate, f.restReached, f.restGatePath = gate, reached, "GET /repos/fitchmultz/pi-subagents/actions/runners/701"
				})
				result := f.goOwned(nil, func() error { return c.advance(*j.snapshot().Active) })
				<-reached // The pre-drain busy read is in flight; no drain frame yet.
				deliverStart()
				close(gate)
				err := result.wait()
				s := j.snapshot()
				f.view(func() {
					if classify(err) != contradicted || len(nativeActions(t, j.root)) != 0 || len(f.deleted) != 0 || s.Active == nil || s.Active.Assignment == nil || s.Active.Terminal != nil {
						t.Fatalf("start accepted before the drain frame did not veto it: %v actions=%v deleted=%v %+v", err, nativeActions(t, j.root), f.deleted, s.Active)
					}
				})
				return
			case "started-before-settle-dispatch":
				// The drain and DELETE already happened: the no-job terminal is journaled.
				if err := j.active(a.OperationID, func(current *slot) error {
					current.Terminal = &terminalProof{NoJob: true, RequestID: 101, Canceled: true, RunnerID: 701, RunnerName: a.RunnerName, RunID: 55, RegistrationAbsent: true}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				f.view(func() { delete(f.registered, a.RunnerName) })
				// A prior exchange is outstanding at the native owner and its reply is held.
				if err := os.WriteFile(filepath.Join(j.root, "block-capture"), []byte("hold"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := c.nativeOwner(); err != nil {
					t.Fatal(err)
				}
				if err := c.dispatch(a.OperationID, "capture", nil); err != nil {
					t.Fatal(err)
				}
				waitForFile(t, filepath.Join(j.root, "request-published"))
				stale := *j.snapshot().Active // The worker's snapshot before the start.
				result := f.goOwned(nil, func() error { return c.advance(stale) })
				deliverStart()
				if err := os.WriteFile(filepath.Join(j.root, "release"), []byte("release"), 0600); err != nil {
					t.Fatal(err)
				}
				err := result.wait()
				s := j.snapshot()
				if actions := nativeActions(t, j.root); classify(err) != contradicted || !slices.Equal(actions, []string{"capture+completion"}) || s.Active == nil || s.Active.Assignment == nil || s.Active.Phase != "launched" {
					t.Fatalf("settle frame dispatched with a contradicted no-job proof: %v actions=%v %+v", err, actions, s.Active)
				}
				return
			case "started-during-registration-read":
				gate, reached := make(chan struct{}), make(chan struct{})
				f.view(func() {
					// The first read is the pre-drain busy check; hold the one before DELETE.
					f.restGate, f.restReached, f.restGatePath, f.restGateSkip = gate, reached, "GET /repos/fitchmultz/pi-subagents/actions/runners/701", 1
				})
				result := f.goOwned(nil, func() error { return c.advance(*j.snapshot().Active) })
				<-reached
				if _, err := os.Stat(filepath.Join(j.root, "drain-published")); err != nil {
					t.Fatal("registration read before DELETE held before the native drain")
				}
				deliverStart()
				close(gate)
				err := result.wait()
				s := j.snapshot()
				f.view(func() {
					if classify(err) != contradicted || len(f.deleted) != 0 || settled() || s.Active == nil || s.Active.Terminal != nil || s.Active.Assignment == nil {
						t.Fatalf("start accepted before DELETE did not retain the slot: %v deleted=%v %+v", err, f.deleted, s.Active)
					}
				})
				return
			case "started-during-owner-exit":
				if err := c.advance(*j.snapshot().Active); err != nil || j.snapshot().Active.Phase != "disposed" {
					t.Fatalf("idle drain did not reach disposal: %v", err)
				}
				if err := os.WriteFile(filepath.Join(j.root, "hold-exit"), []byte("hold"), 0600); err != nil {
					t.Fatal(err)
				}
				result := f.goOwned(nil, func() error { return c.advance(*j.snapshot().Active) })
				waitForFile(t, filepath.Join(j.root, "eof-received")) // Release awaits the actual owner exit.
				deliverStart()
				if err := os.WriteFile(filepath.Join(j.root, "release-exit"), []byte("release"), 0600); err != nil {
					t.Fatal(err)
				}
				err := result.wait()
				if s := j.snapshot(); classify(err) != contradicted || s.Active == nil || s.Active.OperationID != a.OperationID || len(s.CompletedRequests) != 0 || s.LastDisposition != "" {
					t.Fatalf("start during owner exit freed capacity or completed a request: %v %+v", err, s)
				}
				return
			}
			f.view(func() { f.runnerBusy = true })
			if err := c.advance(*j.snapshot().Active); err == nil {
				t.Fatal("busy registration was treated as idle")
			}
			untouched := func(why string) {
				f.view(func() {
					if _, err := os.Stat(filepath.Join(j.root, "drain-published")); err == nil || len(f.deleted) != 0 {
						t.Fatalf("%s runner reached native drain or registration deletion", why)
					}
				})
			}
			untouched("busy")
			// A missing or null REST busy field is not explicit idleness.
			f.view(func() { f.runnerBusy = false })
			for _, raw := range []string{"omit", "null"} {
				f.view(func() { f.busyRaw = raw })
				if err := c.advance(*j.snapshot().Active); classify(err) != (diagnostic{"REST registration busy state missing", "retained"}) {
					t.Fatalf("busy %s: %v", raw, err)
				}
				untouched("busy " + raw)
			}
			f.view(func() { f.busyRaw = "" })
			if err := c.advance(*j.snapshot().Active); err != nil {
				t.Fatal(err)
			}
			saved := j.snapshot().Active
			f.view(func() {
				if !slices.Equal(f.deleted, []int{701}) || saved.Phase != "disposed" || saved.Source != nil || saved.Terminal == nil || !saved.Terminal.NoJob || !saved.Terminal.RegistrationAbsent || saved.Terminal.RequestID != 101 || saved.Terminal.RunID != 55 {
					t.Fatalf("idle drain did not settle exact no-job identity: %+v", saved)
				}
			})
			if err := c.advance(*saved); err != nil {
				t.Fatal(err)
			}
			final := j.snapshot()
			if final.Active != nil || final.LastDisposition != "canceled-unassigned" {
				t.Fatalf("idle disposal mislabeled or retained capacity: %+v", final)
			}
		})
	}
}

// Keeper: a cold Go exit gives the actual native owner EOF while its launched
// listener is provably idle. Native records the interruption and exits; the
// next Go owner reattaches through a new native owner, and only an
// uncontradicted proof with an explicitly idle offline registration settles
// the slot, without completing or canceling the acquired request. A job fact
// accepted during the registration read, a due App token refresh or the held
// owner exit, or a cancellation with other acquired demand to retarget to,
// retains the slot. A late start for the released runner is ACKed as a
// durable contradiction that keeps its request unserved until its terminal.
// A later slot no actual demand or statistics (including running jobs) want,
// or one drained by the operator, exits by itself: before JIT through
// unlaunched disposal, once launched through the same native EOF recovery,
// and subsequent demand is served by a new slot.
func TestActualNativeIdleEOFReattachSettlesOnlyProvedUnassignedSlot(t *testing.T) {
	for _, mode := range []string{"recover", "assigned-before-reattach", "canceled-after-proof", "busy", "proof-lost", "started-during-registration-read", "started-during-app-token-refresh", "started-during-owner-exit", "late-start-after-release", "late-start-without-demand", "late-start-while-launched", "late-start-with-failed-terminal", "drain-reclaims-idle"} {
		t.Run(mode, func(t *testing.T) {
			f := newSDKFixture(t)
			old := newFixtureController(t, f)
			root := old.journal.root
			offers := []map[string]any{job("JobAvailable", 101, nil)}
			if mode == "canceled-after-proof" {
				offers = append(offers, job("JobAvailable", 102, nil)) // A real retarget candidate.
			}
			f.push(1, offers...)
			if err := f.deliver(t, old); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, old, "launched")
			if err := old.advance(*old.journal.snapshot().Active); err != nil || old.journal.snapshot().Active.Phase != "launched" {
				t.Fatalf("idle listener left its phase: %v", err)
			}
			if err := os.WriteFile(filepath.Join(root, "eof-idle"), []byte("root proves the known idle listener"), 0600); err != nil {
				t.Fatal(err)
			}
			// Cold Go exit: the native owner gets EOF, then the kernel guard is free.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := old.native.finish(ctx); err != nil {
				t.Fatal(err)
			}
			old.native = nil
			operation := old.journal.snapshot().Active.OperationID
			waitForFile(t, filepath.Join(root, "idle-interrupted-"+operation))
			f.view(func() {
				if len(f.deleted) != 0 || len(f.registered) != 1 {
					t.Fatal("native EOF interruption touched the registration")
				}
			})
			if err := old.journal.guard.Close(); err != nil {
				t.Fatal(err)
			}
			j, err := openJournal(root)
			if err != nil {
				t.Fatal(err)
			}
			f.own(func() error { _ = j.guard.Close(); return nil }) // Held until its owners ended.
			c := &controller{journal: j, api: old.api, config: old.config, wake: make(chan struct{}, 1), workerDone: make(chan struct{})}
			f.own(func() error { return endNative(root, c.native) })
			runner := c.journal.snapshot().Active
			settled := func() bool {
				return slices.ContainsFunc(nativeActions(t, root), func(a string) bool { return strings.HasPrefix(a, "settle") })
			}
			// untouched: the slot is retained for exactly why, nothing is deleted or settled.
			untouched := func(err error, why string) {
				s := c.journal.snapshot()
				f.view(func() {
					if classify(err) != (diagnostic{why, "retained"}) || len(f.deleted) != 0 || settled() || s.Active == nil || s.Active.OperationID != operation || s.Active.Terminal != nil {
						t.Fatalf("contradicted or unproved interruption settled: %v deleted=%v %+v", err, f.deleted, s.Active)
					}
				})
			}
			const contradicted = "native interrupted-unassigned contradicts journaled runner facts"
			// deliverStart has the actual SDK listener accept and ACK a JobStarted
			// for this exact runner, so the owner has processed it on return.
			deliverStart := func() {
				f.push(2, job("JobStarted", 101, map[string]any{"runnerId": runner.RunnerID, "runnerName": runner.RunnerName}))
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			}
			if mode == "assigned-before-reattach" {
				deliverStart()
				untouched(c.advance(*c.journal.snapshot().Active), contradicted)
				return
			}
			if err := c.advance(*c.journal.snapshot().Active); err != nil || c.journal.snapshot().Active.Phase != "interrupted" {
				t.Fatalf("native idle interruption not journaled: %v", err)
			}
			switch mode {
			case "canceled-after-proof":
				if s := c.journal.snapshot(); findAcquisition(&s, 102) < 0 || !s.Acquisitions[findAcquisition(&s, 102)].Acquired {
					t.Fatalf("retarget candidate 102 not actually acquired: %+v", s.Acquisitions)
				}
				f.push(2, job("JobCompleted", 101, map[string]any{"runnerId": 0, "runnerName": "", "result": "canceled"}))
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				if a := c.journal.snapshot().Active; a.IntentCanceled == nil || a.AcquireIntent.RunnerRequestID != 101 {
					t.Fatalf("interrupted slot's cancellation retargeted away: %+v", a)
				}
				untouched(c.advance(*c.journal.snapshot().Active), contradicted)
				return
			case "busy":
				f.view(func() { f.runnerBusy = true })
				untouched(c.advance(*c.journal.snapshot().Active), "owned runner busy contradicts native idle interruption")
				return
			case "proof-lost":
				if err := os.Remove(filepath.Join(root, "idle-interrupted-"+operation)); err != nil {
					t.Fatal(err)
				}
				untouched(c.advance(*c.journal.snapshot().Active), "native interrupted-unassigned proof missing or changed")
				return
			case "started-during-registration-read":
				gate, reached := make(chan struct{}), make(chan struct{})
				f.view(func() {
					f.restGate, f.restReached, f.restGatePath = gate, reached, fmt.Sprintf("GET /repos/fitchmultz/pi-subagents/actions/runners/%d", runner.RunnerID)
				})
				result := f.goOwned(nil, func() error { return c.advance(*c.journal.snapshot().Active) })
				<-reached // Recovery is inside the authenticated REST registration read.
				deliverStart()
				close(gate)
				untouched(result.wait(), contradicted)
				return
			case "started-during-app-token-refresh":
				// The REST client authenticates as a GitHub App whose installation
				// token is always due; the refresh after the registration read is held.
				c.api.github, c.api.app = appREST(t, f)
				gate, reached := make(chan struct{}), make(chan struct{})
				f.view(func() { f.restGate, f.restReached, f.shortTokens, f.armTokenGate = gate, reached, true, true })
				result := f.goOwned(nil, func() error { return c.advance(*c.journal.snapshot().Active) })
				<-reached
				deliverStart()
				close(gate)
				untouched(result.wait(), contradicted)
				return
			case "started-during-owner-exit":
				if err := os.WriteFile(filepath.Join(root, "hold-exit"), []byte("hold"), 0600); err != nil {
					t.Fatal(err)
				}
				advanceUntil(t, c, "disposed")
				result := f.goOwned(nil, func() error { return c.advance(*c.journal.snapshot().Active) })
				waitForFile(t, filepath.Join(root, "eof-received")) // Release awaits the actual owner exit.
				deliverStart()
				if err := os.WriteFile(filepath.Join(root, "release-exit"), []byte("release"), 0600); err != nil {
					t.Fatal(err)
				}
				err := result.wait()
				if s := c.journal.snapshot(); classify(err) != (diagnostic{contradicted, "retained"}) || s.Active == nil || s.Active.OperationID != operation || len(s.CompletedRequests) != 0 || s.LastDisposition != "" {
					t.Fatalf("contradiction during owner exit freed capacity or completed a request: %v %+v", err, s)
				}
				return
			}
			advanceUntil(t, c, "")
			s := c.journal.snapshot()
			wantTerminal := terminalProof{RunnerID: 701, RunnerName: runner.RunnerName, RegistrationAbsent: true, NoJob: true, InterruptedUnassigned: true}
			f.view(func() {
				if s.Active != nil || s.LastDisposition != "interrupted-unassigned-recovery" || s.LastTerminal == nil || *s.LastTerminal != wantTerminal || !settled() || !slices.Equal(f.deleted, []int{701}) {
					t.Fatalf("interruption not settled as exact no-job recovery: deleted=%v %+v", f.deleted, s)
				}
			})
			if len(s.CompletedRequests) != 0 || len(s.Acquisitions) != 1 || !s.Acquisitions[0].Acquired || slices.ContainsFunc(nativeActions(t, root), func(a string) bool { return strings.HasSuffix(a, "+completion") }) {
				t.Fatalf("recovery completed, canceled or dropped the acquired request: %+v", s)
			}
			if mode == "late-start-while-launched" || mode == "late-start-with-failed-terminal" || mode == "drain-reclaims-idle" {
				unneededLaunchedSlotExits(t, f, c, mode, runner.RunnerName)
				return
			}
			if strings.HasPrefix(mode, "late-start") {
				// The released runner's delayed start arrives, batched with new demand
				// or alone, while the session's statistics already admitted a slot for it.
				msgs := []map[string]any{job("JobStarted", 101, map[string]any{"runnerId": 701, "runnerName": runner.RunnerName})}
				coBatched := mode == "late-start-after-release"
				if coBatched {
					msgs = append(msgs, job("JobAvailable", 102, nil))
				}
				f.push(3, msgs...)
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatalf("late start for the released runner refused the SDK message: %v", err)
				}
				s := c.journal.snapshot()
				late, next := findAcquisition(&s, 101), findAcquisition(&s, 102)
				intent := func(a *slot) int64 {
					if a == nil || a.AcquireIntent == nil {
						return 0
					}
					return a.AcquireIntent.RunnerRequestID
				}
				// A slot may be admitted (the server still counts an assigned job),
				// but never for the contradicted request.
				servesLate := intent(s.Active) == 101
				f.view(func() {
					if late < 0 || s.Acquisitions[late].LateStartRunner != 701 || slices.Contains(s.CompletedRequests, 101) || (next >= 0) != coBatched || (coBatched && !s.Acquisitions[next].Acquired) || servesLate || len(f.queue) != 0 {
						t.Fatalf("late start not ACKed as an unserved contradiction: intent=%d %+v", intent(s.Active), s)
					}
				})
				admitted := intent(s.Active)
				if !coBatched {
					// The slot admitted for 101 now serves no demand: the server counts
					// 101 running elsewhere. It is disposed before any JIT.
					advanceUntil(t, c, "")
					f.view(func() {
						if s := c.journal.snapshot(); s.Active != nil || s.LastDisposition != "unlaunched-recovery" || f.jitCalls != 1 || len(f.registered) != 0 {
							t.Fatalf("unneeded preparing slot not disposed before JIT: jit=%d %+v", f.jitCalls, s)
						}
					})
				}
				// The exact server terminal for 101 from that runner reconciles it.
				f.push(4, job("JobCompleted", 101, map[string]any{"runnerId": 701, "runnerName": runner.RunnerName, "result": "canceled"}))
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				if s := c.journal.snapshot(); findAcquisition(&s, 101) >= 0 || !slices.Contains(s.CompletedRequests, 101) || intent(s.Active) != admitted || (s.Active != nil && s.Active.IntentCanceled != nil) {
					t.Fatalf("late-start bookkeeping not reconciled by its exact terminal: %+v", s)
				}
				if !coBatched {
					servesNext(t, f, c, 702)
				}
				return
			}
			// The server still assigns 101: the next real slot serves it.
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, c, "launched")
			f.view(func() {
				if a := c.journal.snapshot().Active; a.OperationID == operation || a.AcquireIntent.RunnerRequestID != 101 || a.RunnerID != 702 || f.jitCalls != 2 {
					t.Fatalf("kept acquired intent not re-admitted: %+v jit=%d", a, f.jitCalls)
				}
			})
		})
	}
}

// servesNext has new demand admit and launch a fresh slot on runner.
func servesNext(t *testing.T, f *sdkFixture, c *controller, runner int) {
	t.Helper()
	f.push(9, job("JobAvailable", 103, nil))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	advanceUntil(t, c, "launched")
	if a := c.journal.snapshot().Active; a == nil || a.AcquireIntent == nil || a.AcquireIntent.RunnerRequestID != 103 || a.RunnerID != runner {
		t.Fatalf("subsequent demand not served by a new slot on runner %d: %+v", runner, a)
	}
}

// unneededLaunchedSlotExits re-admits the kept request 101 to a launched slot
// on runner 702, then makes it unneeded: a late start of 101 on the released
// runner 701 (statistics now count it running), that start co-batched with
// the old runner's failed terminal, or an operator drain. The idle slot exits
// through the same native owner's EOF recovery without a fabricated
// cancellation or completion.
func unneededLaunchedSlotExits(t *testing.T, f *sdkFixture, c *controller, mode, releasedName string) {
	t.Helper()
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	advanceUntil(t, c, "launched")
	second := *c.journal.snapshot().Active
	if second.RunnerID != 702 || second.AcquireIntent == nil || second.AcquireIntent.RunnerRequestID != 101 {
		t.Fatalf("kept request not re-admitted to a launched slot: %+v", second)
	}
	// Acquired demand still wants the idle slot: it is not reclaimed.
	if err := c.advance(second); err != nil || c.native == nil || c.native.closed {
		t.Fatalf("wanted idle slot reclaimed: %v", err)
	}
	lateStart := job("JobStarted", 101, map[string]any{"runnerId": 701, "runnerName": releasedName})
	switch mode {
	case "drain-reclaims-idle":
		if err := os.WriteFile(filepath.Join(c.config.Root, "control.json"), []byte(`{"action":"drain"}`), 0600); err != nil {
			t.Fatal(err)
		}
		if err := c.control(); err != nil || !c.journal.snapshot().Drain {
			t.Fatalf("operator drain not applied: %v", err)
		}
	case "late-start-while-launched":
		f.push(3, lateStart)
	case "late-start-with-failed-terminal":
		f.push(3, lateStart, job("JobCompleted", 101, map[string]any{"runnerId": 701, "runnerName": releasedName, "result": "failed"}))
	}
	if mode != "drain-reclaims-idle" {
		if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
			t.Fatalf("late facts for the released runner refused: %v", err)
		}
		s := c.journal.snapshot()
		a, late := s.Active, findAcquisition(&s, 101)
		f.view(func() {
			if len(f.queue) != 0 || a == nil || a.OperationID != second.OperationID || a.IntentCanceled != nil || a.Completion != nil || a.Assignment != nil || s.Statistics.TotalRunningJobs != 1 && mode == "late-start-while-launched" {
				t.Fatalf("late facts not ACKed as request bookkeeping beside the idle slot: %+v", s)
			}
		})
		if mode == "late-start-while-launched" && (late < 0 || s.Acquisitions[late].LateStartRunner != 701 || a.AcquireIntent != nil) {
			t.Fatalf("late start not kept as unserved bookkeeping: %+v", s)
		}
		if mode == "late-start-with-failed-terminal" && (late >= 0 || !slices.Equal(s.CompletedRequests, []int64{101})) {
			t.Fatalf("old runner's actual terminal not request bookkeeping: %+v", s)
		}
	}
	// One step gives the same owner EOF and returns only after its actual exit.
	owner := c.native
	if err := c.advance(*c.journal.snapshot().Active); err != nil {
		t.Fatalf("unneeded idle slot not reclaimed: %v", err)
	}
	select {
	case <-owner.done:
	default:
		t.Fatal("reclaim returned before the native owner actually exited")
	}
	advanceUntil(t, c, "")
	s := c.journal.snapshot()
	want := terminalProof{RunnerID: 702, RunnerName: second.RunnerName, RegistrationAbsent: true, NoJob: true, InterruptedUnassigned: true}
	completed := []int64(nil)
	if mode == "late-start-with-failed-terminal" {
		completed = []int64{101}
	}
	f.view(func() {
		if s.Active != nil || s.LastDisposition != "interrupted-unassigned-recovery" || s.LastTerminal == nil || *s.LastTerminal != want || !slices.Equal(f.deleted, []int{701, 702}) || !slices.Equal(s.CompletedRequests, completed) {
			t.Fatalf("unneeded idle slot not disposed by exact EOF recovery: deleted=%v %+v", f.deleted, s)
		}
	})
	if slices.ContainsFunc(nativeActions(t, c.config.Root), func(a string) bool { return strings.HasSuffix(a, "+completion") }) {
		t.Fatal("reclaim conveyed a cancellation")
	}
	switch mode {
	case "drain-reclaims-idle":
		if i := findAcquisition(&s, 101); i < 0 || !s.Acquisitions[i].Acquired {
			t.Fatalf("drain dropped the acquired request: %+v", s)
		}
		if err := os.WriteFile(filepath.Join(c.config.Root, "control.json"), []byte(`{"action":"recover"}`), 0600); err != nil {
			t.Fatal(err)
		}
		if err := c.control(); err != nil {
			t.Fatal(err)
		}
		if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		advanceUntil(t, c, "launched")
		if a := c.journal.snapshot().Active; a == nil || a.AcquireIntent == nil || a.AcquireIntent.RunnerRequestID != 101 || a.RunnerID != 703 {
			t.Fatalf("recovered owner did not serve the kept request: %+v", a)
		}
	case "late-start-while-launched":
		// 101 still runs elsewhere: no phantom slot until its actual terminal.
		if s.Active != nil {
			t.Fatalf("slot admitted for a job running on another runner: %+v", s)
		}
		f.push(4, job("JobCompleted", 101, map[string]any{"runnerId": 701, "runnerName": releasedName, "result": "failed"}))
		if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if s := c.journal.snapshot(); s.Active != nil || !slices.Equal(s.CompletedRequests, []int64{101}) || findAcquisition(&s, 101) >= 0 {
			t.Fatalf("late request not reconciled by its actual terminal: %+v", s)
		}
		servesNext(t, f, c, 703)
	default:
		servesNext(t, f, c, 703)
	}
}
