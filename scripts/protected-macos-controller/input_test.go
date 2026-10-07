package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestBlockedNativeInputResumesOriginalLaunchThenEOFWaitsSameOwner(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	j, own := testJournal(t)
	for _, name := range []string{"block-start", "hold-exit"} {
		if err := os.WriteFile(filepath.Join(j.root, name), []byte("hold"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	a := newSlot()
	a.Phase = "jit-lost" // Launch is journaled as possibly delivered before stdin write.
	if err := j.update(func(s *state) error { s.Active = a; return nil }); err != nil {
		t.Fatal(err)
	}
	c := &controller{journal: j, config: config{Node: executable, Helper: "-test.run=^$", NativeState: j.root}}
	own(func() error { return endNative(j.root, c.native) })
	if err := c.nativeOwner(); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, filepath.Join(j.root, "start-held"))
	jit := strings.Repeat("fixture-not-secret", 20000) // Larger than the pipe buffer.
	if err := c.dispatch(a.OperationID, "launch", func(req *nativeRequest) { req.JIT = jit }); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if _, err := c.native.await(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked stdin ignored caller deadline: %v", err)
	}
	if err := c.native.send(nativeRequest{OperationID: a.OperationID, Action: "status"}, func() {}, func() bool { return false }); err == nil {
		t.Fatal("new input bypassed pending launch")
	}
	if err := os.WriteFile(filepath.Join(j.root, "release"), []byte("release"), 0600); err != nil {
		t.Fatal(err)
	}
	// Production recovery of jit-lost issues status; the original launch must be
	// completed and consumed first, without a resend.
	if err := c.advance(*j.snapshot().Active); err != nil {
		t.Fatal(err)
	}
	count, err := os.ReadFile(filepath.Join(j.root, "launch-count"))
	if err != nil || string(count) != "1" || j.snapshot().Active.Phase != "launched" {
		t.Fatalf("original launch not resumed exactly once: %q %v", count, err)
	}
	if actions := nativeActions(t, j.root); !slices.Equal(actions, []string{"launch", "status"}) {
		t.Fatalf("launch resent or reordered: %v", actions)
	}

	// EOF is sent once; a deadline leaves the same owner running and a later
	// finish resumes waiting for its actual exit.
	short, shortCancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer shortCancel()
	if err := c.native.finish(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("owner exit not awaited: %v", err)
	}
	waitForFile(t, filepath.Join(j.root, "eof-received"))
	if err := os.WriteFile(filepath.Join(j.root, "release-exit"), []byte("release"), 0600); err != nil {
		t.Fatal(err)
	}
	resumed, resumeCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer resumeCancel()
	if err := c.native.finish(resumed); err != nil {
		t.Fatalf("resumed finish did not observe actual owner exit: %v", err)
	}

	// A poisoned live owner (reply identity mismatch) gets EOF once and is
	// retained until its actual exit; only then does a new owner start.
	for _, name := range []string{"eof-received", "release-exit"} {
		if err := os.Remove(filepath.Join(j.root, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(j.root, "bad-reply"), []byte("mismatch once"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := c.nativeCall(*a, "status", nil); classify(err).Code != "native reply identity mismatch; retain" {
		t.Fatalf("mismatched reply accepted: %v", err)
	}
	poisoned := c.native
	for range 2 {
		if _, err := c.nativeCall(*a, "status", nil); !errors.Is(err, errNativeUnusable) || c.native != poisoned {
			t.Fatalf("poisoned live owner replaced or reused: %v", err)
		}
	}
	waitForFile(t, filepath.Join(j.root, "eof-received"))
	select {
	case <-poisoned.done:
		t.Fatal("EOF freed an owner still settling")
	default:
	}
	if err := os.WriteFile(filepath.Join(j.root, "release-exit"), []byte("release"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-poisoned.done:
	case <-time.After(3 * time.Second):
		t.Fatal("poisoned owner did not exit after EOF")
	}
	reply, err := c.nativeCall(*a, "status", nil)
	if err != nil || reply.Phase != "status" || c.native == poisoned {
		t.Fatalf("exited poisoned owner not replaced: %+v %v", reply, err)
	}
	if actions := nativeActions(t, j.root); !slices.Equal(actions, []string{"launch", "status", "status", "status"}) {
		t.Fatalf("poisoned owner received another request: %v", actions)
	}
}
