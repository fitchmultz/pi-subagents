package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestActualSDKCompletionACKWhileNativePrepareRemainsOwned(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	if err := os.WriteFile(filepath.Join(c.journal.root, "block-prepare"), []byte("hold actual process"), 0600); err != nil {
		t.Fatal(err)
	}
	native, err := startNative(c.config)
	if err != nil {
		t.Fatal(err)
	}
	c.native = native
	defer func() { _ = os.WriteFile(filepath.Join(c.journal.root, "release"), []byte("release"), 0600) }()
	f.push(1, job("JobAvailable", 101, nil))
	f.view(func() {
		f.queue = append(f.queue, fixtureMessage{id: 2, waitFor: "prepare-published", jobs: []map[string]any{job("JobCompleted", 101, map[string]any{"runnerId": 0, "runnerName": "", "result": "canceled"})}})
	})
	f.goOwned(func() { c.stopping.Store(true); c.notify() }, func() error { c.worker(); return c.workerErr })
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	active := c.journal.snapshot().Active
	f.view(func() {
		if f.acks != 2 || f.jitCalls != 0 || active == nil || active.IntentCanceled == nil || active.Phase != "preparing" {
			t.Fatalf("listener blocked completion/ACK behind native work: ACK=%d JIT=%d active=%+v", f.acks, f.jitCalls, active)
		}
	})
	select {
	case <-native.done:
		t.Fatal("listener cancellation killed owned native process")
	default:
	}
	c.stopping.Store(true)
	if err := os.WriteFile(filepath.Join(c.journal.root, "release"), []byte("release"), 0600); err != nil {
		t.Fatal(err)
	}
	c.notify()
	select {
	case <-c.workerDone:
	case <-time.After(15 * time.Second):
		t.Fatal("canceled preregistration did not settle and drain")
	}
	if s := c.journal.snapshot(); s.Active != nil || s.LastDisposition != "unlaunched-recovery" || c.workerErr != nil {
		t.Fatalf("proved native disposal did not release capacity: %+v %v", s, c.workerErr)
	}
	f.view(func() {
		if f.jitCalls != 0 {
			t.Fatal("canceled request minted a JIT")
		}
	})
}

// Keeper: a completion arriving while a stale bind frame (built without it)
// is blocked entering a non-reading native owner is published and ACKed
// promptly; the blocked frame is abandoned unterminated, so native never acts
// on it. Recovery rebuilds bind from the journal, carrying the completion.
func TestActualSDKCompletionAbortsBlockedStaleFrameBeforeACK(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	started := startedSlot(t, f, c)
	files := make([]sourceFile, 2000) // Larger than the pipe buffer.
	for i := range files {
		files[i] = sourceFile{Path: fmt.Sprintf("src/file-%04d.ts", i), Mode: "100644", SHA: strings.Repeat("c", 40)}
	}
	if err := c.journal.active(started.OperationID, func(a *slot) error {
		a.Source = &sourceBinding{Repository: repository, RequestID: 101, RunnerID: a.RunnerID, RunnerName: a.RunnerName, Files: files}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stale := *c.journal.snapshot().Active
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.native.finish(ctx); err != nil {
		t.Fatal(err)
	}
	c.native = nil
	if err := os.Remove(filepath.Join(c.journal.root, "stdin-read")); err != nil { // The exited owner's.
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(c.journal.root, "block-start"), []byte("hold before reading input"), 0600); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.WriteFile(filepath.Join(c.journal.root, "release"), []byte("release"), 0600) }()
	if err := c.nativeOwner(); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, filepath.Join(c.journal.root, "start-held"))
	// The first exchange of production bindSource, built without a completion.
	if err := c.dispatch(stale.OperationID, "bind", func(req *nativeRequest) { req.Binding = stale.Source }); err != nil {
		t.Fatal(err)
	}
	f.push(3, job("JobCompleted", 101, map[string]any{"runnerId": stale.RunnerID, "runnerName": stale.RunnerName, "result": "canceled"}))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatalf("completion poll/ACK blocked behind native input: %v", err)
	}
	if _, err := os.Stat(filepath.Join(c.journal.root, "stdin-read")); err == nil || c.journal.snapshot().Active.Completion == nil {
		t.Fatal("completion was not published while native still held its input")
	}
	if err := os.WriteFile(filepath.Join(c.journal.root, "release"), []byte("release"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.bindSource(stale); classify(err).Code != "native request frame aborted for an accepted SDK fact" {
		t.Fatalf("stale frame not abandoned: %v", err)
	}
	poisoned := c.native
	if _, err := c.nativeCall(stale, "status", nil); !errors.Is(err, errNativeUnusable) {
		t.Fatalf("poisoned owner not closed: %v", err)
	}
	select {
	case <-poisoned.done: // Native rejects the unterminated frame at EOF.
	case <-time.After(3 * time.Second):
		t.Fatal("owner with an unterminated frame did not exit")
	}
	err := c.advance(*c.journal.snapshot().Active)
	if d := classify(err); d.Code != "job ended before native source acknowledgment" {
		t.Fatalf("recovery did not carry the accepted completion: %v", err)
	}
	actions := nativeActions(t, c.journal.root)
	if slices.Contains(actions, "bind") || !slices.Contains(actions, "bind+completion") || c.journal.snapshot().Active.Phase == "bound" {
		t.Fatalf("native acted on a frame built without the accepted completion: %v", actions)
	}
}
