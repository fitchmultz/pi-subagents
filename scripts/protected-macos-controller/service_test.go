package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"slices"
	"testing"
	"time"
)

// The service exit boundary: an unrecoverable journal failure stops the worker
// and becomes run's error after SDK closure, with or without an owned slot (an
// idle failure comes from the actual scale-set publication write); a recorded
// lifecycle wait does not poison a clean shutdown.
func TestRunExitIdentityFollowsWorkerJournalFailure(t *testing.T) {
	for _, mode := range []string{"clean-shutdown", "journal-failure", "idle-journal-failure"} {
		t.Run(mode, func(t *testing.T) {
			broken := mode != "clean-shutdown"
			f := newSDKFixture(t)
			c := newFixtureController(t, f)
			a := newSlot()
			a.Phase = "disposed"
			a.Diagnostic = &diagnostic{Code: "native reply pending", Kind: "waiting"}
			if mode == "idle-journal-failure" {
				a = nil
			}
			if err := c.journal.update(func(s *state) error { s.Active = a; return nil }); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if broken {
				if err := os.Chmod(c.journal.root, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(c.journal.root, 0700) })
			} else {
				cancel() // Owner shutdown request: settle, then exit.
			}
			c.notify()
			run := f.goOwned(cancel, func() error { return c.run(ctx) })
			var err error
			select {
			case <-run.done:
				err = run.err
			case <-time.After(20 * time.Second):
				t.Fatal("service did not exit")
			}
			if broken {
				var saved state
				if !errors.Is(err, fs.ErrPermission) {
					t.Fatalf("journal failure hidden from service exit: %v", err)
				}
				if readErr := readJSON(c.journal.root+"/controller.json", &saved); readErr != nil || (a == nil) != (saved.Active == nil) || (a != nil && saved.Active.OperationID != a.OperationID) {
					t.Fatalf("failed journal changed slot ownership: %v %+v", readErr, saved.Active)
				}
				return
			}
			if err != nil || c.journal.snapshot().Active != nil {
				t.Fatalf("clean shutdown poisoned by an earlier wait: %v", err)
			}
		})
	}
}

// Keeper: the production owner serves two acquired serial jobs on ONE actual
// SDK session whose empty polls are nil long-poll timeouts. After a release
// the cached count that observed the own runner blocks admission and capacity;
// actual SDK scale-set reads keep a foreign registration blocking and a fresh
// zero admits the next job, with no new session supplying statistics.
func TestRunServesSerialJobsOnOneSessionFromFreshRegistrationStatistics(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	writeCaptureTemplate(t, c.journal.root)
	f.push(1, job("JobAvailable", 101, nil), job("JobAvailable", 102, nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run := f.goOwned(cancel, func() error { return c.run(ctx) })
	eventually := func(what string, cond func() bool) {
		t.Helper()
		for deadline := time.Now().Add(20 * time.Second); !cond(); time.Sleep(5 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("%s not observed: %+v", what, c.journal.snapshot())
			}
		}
	}
	// serve completes one job; foreign registrations are counted from its completion on.
	serve := func(request int64, message, runnerID, foreign int) {
		t.Helper()
		var a *slot
		eventually("launched slot", func() bool {
			a = c.journal.snapshot().Active
			return a != nil && a.Phase == "launched" && a.AcquireIntent.RunnerRequestID == request
		})
		if a.RunnerID != runnerID {
			t.Fatalf("slot for %d not on its own registration: %+v", request, a)
		}
		f.push(message, job("JobStarted", request, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName}))
		eventually("bound slot", func() bool { a := c.journal.snapshot().Active; return a != nil && a.Phase == "bound" })
		f.view(func() { f.foreign = foreign })
		f.push(message+1, job("JobCompleted", request, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName, "result": "succeeded"}))
		eventually("settled release", func() bool {
			s := c.journal.snapshot()
			return s.Active == nil && slices.Contains(s.CompletedRequests, request)
		})
	}
	serve(101, 2, 701, 1)
	var mark, reads int
	f.view(func() { mark, reads = len(f.capacities), f.scaleSetGets })
	since := func(base *int, count func() int) func() bool {
		return func() bool { n := 0; f.view(func() { n = count() - *base }); return n >= 2 }
	}
	eventually("nil polls after release", since(&mark, func() int { return len(f.capacities) }))
	f.view(func() {
		if held := f.capacities[mark:]; slices.ContainsFunc(held, func(c string) bool { return c != "0" }) {
			t.Errorf("capacity advertised while registration blocks admission: %v", held)
		}
	})
	if out := ownerStatus(t, c.config); out["availableCapacity"] != 0.0 || out["admission"] != "blocked-registered-runner" || out["listenerUp"] != true || out["occupied"] != false {
		t.Errorf("status claims capacity while registration blocks admission: %v", out)
	}
	eventually("repeated scale-set reads on nil polls", since(&reads, func() int { return f.scaleSetGets }))
	s := c.journal.snapshot()
	f.view(func() {
		if s.Active != nil || s.Admission != "blocked-registered-runner" || f.jitCalls != 1 || len(f.acquireCalls) != 1 || len(f.registered) != 0 {
			t.Fatalf("foreign registration waived or own runner present: %+v jit=%d acquire=%v registered=%v", s, f.jitCalls, f.acquireCalls, f.registered)
		}
	})
	// A zero count from a scale set without the exact owned labels is not
	// evidence: the block holds and the refresh failure is visible.
	f.view(func() { f.foreign, f.scaleSetBad, reads = 0, true, f.scaleSetGets })
	eventually("scale-set reads with foreign labels", since(&reads, func() int { return f.scaleSetGets }))
	s = c.journal.snapshot()
	if want := (diagnostic{"statistics-refresh: scale-set statistics labels or counts invalid", "retained"}); s.Active != nil || s.Admission != "blocked-registered-runner" || !s.ListenerUp || s.Listener == nil || *s.Listener != want {
		t.Fatalf("invalid scale-set identity unblocked admission or hid the failure: %+v", s)
	}
	f.view(func() { f.scaleSetBad = false })
	serve(102, 4, 702, 0)
	eventually("capacity after fresh zero", func() bool {
		last := ""
		f.view(func() { last = f.capacities[len(f.capacities)-1] })
		return last == "1"
	})
	s = c.journal.snapshot()
	f.view(func() {
		if s.Admission != "" || s.Listener != nil || s.LastTerminal == nil || !s.LastTerminal.RegistrationAbsent || s.LastDisposition != "source-consistent-settlement" || !slices.Equal(s.CompletedRequests, []int64{101, 102}) || !slices.Equal(f.deleted, []int{701, 702}) || f.jitCalls != 2 || f.sessions != 1 {
			t.Fatalf("serial jobs not served on one session: %+v deleted=%v jit=%d sessions=%d", s, f.deleted, f.jitCalls, f.sessions)
		}
	})
	cancel()
	select {
	case <-run.done:
		if run.err != nil {
			t.Fatalf("clean shutdown after serial jobs: %v", run.err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("service did not exit")
	}
}

// ownerStatus reads the actual status command's sanitized output.
func ownerStatus(t *testing.T, c config) map[string]any {
	t.Helper()
	out, err := os.CreateTemp(t.TempDir(), "status")
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	stdout := os.Stdout
	os.Stdout = out
	err = status(c)
	os.Stdout = stdout
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(out.Name())
	var result map[string]any
	if err != nil || json.Unmarshal(raw, &result) != nil {
		t.Fatalf("status output unreadable: %v %s", err, raw)
	}
	return result
}
