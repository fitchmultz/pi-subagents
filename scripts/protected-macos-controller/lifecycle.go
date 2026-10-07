package main

import (
	"context"
	"errors"
	"time"

	"github.com/actions/scaleset"
	"github.com/google/go-github/v88/github"
)

func operationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 30*time.Second)
}

// worker owns the single physical slot. It stops only when shutdown finds no
// owned slot, or when the journal itself can no longer record lifecycle state.
func (c *controller) worker() {
	defer close(c.workerDone)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.wake:
		case <-ticker.C:
		}
		// A sticky write failure ends the owner even with no slot: an idle
		// journal never writes again, so control alone would never surface it.
		if err := c.journal.failure(); err != nil {
			c.workerErr = err
			return
		}
		if err := c.control(); err != nil {
			c.workerErr = err
			return
		}
		c.adjustCapacity()
		s := c.journal.snapshot()
		if s.Active == nil {
			if c.stopping.Load() {
				return
			}
			continue
		}
		if err := c.step(*s.Active); err != nil {
			c.workerErr = err
			return
		}
	}
}

// step advances the exact journaled operation once. Lifecycle failures become
// the slot's diagnostic and are retried; uncertainty never releases the slot,
// cancels native lifetimes or triggers a demand scan. Only a journal failure
// is returned, because nothing can then be recorded safely.
func (c *controller) step(a slot) error {
	if err := c.advance(a); err != nil {
		if saveErr := c.journal.retain(a.OperationID, err); saveErr != nil {
			return errors.Join(err, saveErr)
		}
		return nil
	}
	current := c.journal.snapshot().Active
	if current == nil || current.OperationID != a.OperationID || current.Diagnostic == nil {
		return nil
	}
	if current.Diagnostic.Kind == "retained" && current.Phase == a.Phase {
		// A same-phase wait (no capture yet, live transport) is not certainty:
		// only an actual phase advance or release clears retained uncertainty.
		return nil
	}
	return c.journal.active(a.OperationID, func(current *slot) error {
		current.Diagnostic, current.LatestDiagnostic = nil, nil
		return nil
	})
}

func (c *controller) phase(a slot, phase string) error {
	return c.journal.active(a.OperationID, func(current *slot) error { current.Phase = phase; return nil })
}

// current re-reads the active slot after a wait so decisions use fresh state.
func (c *controller) current(operation string) (slot, error) {
	a := c.journal.snapshot().Active
	if a == nil || a.OperationID != operation {
		return slot{}, retained("active operation identity changed")
	}
	return *a, nil
}

func (c *controller) advance(a slot) error {
	switch a.Phase {
	case "preparing":
		reply, err := c.nativeCall(a, "prepare", nil)
		if err != nil {
			return err
		}
		if !reply.Prepared {
			return retained("native preparation not proved")
		}
		return c.phase(a, "prepared")
	case "prepared":
		if a.Completion != nil || a.IntentCanceled != nil || !c.capacityWanted() {
			return c.disposeUnlaunched(a) // No JIT was ever requested.
		}
		return c.mintJIT(a)
	case "jit-intent":
		return c.mintJIT(a)
	case "jit-lost":
		return c.disposeUnlaunched(a)
	case "launched", "bound":
		return c.observe(a)
	case "interrupted":
		return c.settleInterrupted(a)
	case "settling":
		return c.settleAssigned(a)
	case "veto-settling":
		return c.settleVeto(a)
	case "disposed":
		return c.release(a)
	default:
		return retained("unknown durable lifecycle phase")
	}
}

// mintJIT treats jit-intent as possible server-side registration: the exact
// SDK name lookup always precedes any mint, and completed demand never mints.
func (c *controller) mintJIT(a slot) error {
	if a.Phase != "jit-intent" {
		if err := c.phase(a, "jit-intent"); err != nil {
			return err
		}
	}
	ctx, cancel := operationContext(context.Background())
	defer cancel()
	scaleSetID := c.journal.snapshot().ScaleSetID
	existing, err := c.api.scale.GetRunnerByName(ctx, a.RunnerName)
	if err != nil {
		return err
	}
	if existing != nil {
		if existing.ID <= 0 || existing.Name != a.RunnerName || existing.RunnerScaleSetID != scaleSetID {
			return retained("JIT recovery returned foreign registration")
		}
		return c.journal.active(a.OperationID, func(current *slot) error { current.RunnerID = existing.ID; current.Phase = "jit-lost"; return nil })
	}
	fresh, err := c.current(a.OperationID)
	if err != nil {
		return err
	}
	if fresh.Completion != nil || fresh.IntentCanceled != nil || !c.capacityWanted() {
		// Authenticated absence: no registration exists, so nothing was minted.
		return c.disposeUnlaunched(fresh)
	}
	jit, err := c.api.scale.GenerateJitRunnerConfig(ctx, &scaleset.RunnerScaleSetJitRunnerSetting{Name: a.RunnerName, WorkFolder: "_work"}, scaleSetID)
	if err != nil {
		return err
	}
	if jit == nil || jit.Runner == nil {
		return retained("JIT returned no runner identity")
	}
	defer func() { jit.EncodedJITConfig = "" }()
	// Durably preserve the ACTUAL returned identity before any later assertions.
	if err := c.journal.active(a.OperationID, func(current *slot) error {
		current.RunnerID = jit.Runner.ID
		current.ReturnedName = jit.Runner.Name
		current.Phase = "jit-lost"
		return nil
	}); err != nil {
		return err
	}
	if jit.Runner.ID <= 0 || jit.Runner.Name != a.RunnerName || jit.Runner.RunnerScaleSetID != scaleSetID || jit.EncodedJITConfig == "" {
		return retained("JIT identity mismatch")
	}
	fresh, err = c.current(a.OperationID)
	if err != nil {
		return err
	}
	return c.launch(fresh, jit.EncodedJITConfig)
}

func (c *controller) launch(a slot, encoded string) error {
	status, err := c.nativeCall(a, "status", nil)
	if err != nil {
		return err
	}
	if status.Launched || status.InterruptedUnassigned {
		return c.phase(a, "launched")
	}
	ctx, cancel := operationContext(context.Background())
	defer cancel()
	runner, err := c.runner(ctx, a)
	if err != nil {
		return err
	}
	if runner == nil {
		return c.disposeUnlaunched(a)
	}
	if runner.GetBusy() {
		return retained("unlaunched registration is unexpectedly busy")
	}
	var labels []string
	for _, label := range runner.Labels {
		labels = append(labels, label.GetName())
	}
	if !sameLabels(labels, requiredLabels) {
		return retained("registered runner labels mismatch")
	}
	reply, err := c.nativeCall(a, "launch", func(req *nativeRequest) { req.JIT = encoded })
	if err != nil {
		return err
	}
	if !reply.Launched {
		return retained("native listener launch not acknowledged")
	}
	return c.phase(a, "launched")
}

func (c *controller) runner(ctx context.Context, a slot) (*github.Runner, error) {
	if err := repositoryAccess(ctx, c.api.github); err != nil {
		return nil, err
	}
	runner, _, err := c.api.github.Actions.GetRunner(ctx, "fitchmultz", "pi-subagents", int64(a.RunnerID))
	if err != nil {
		var response *github.ErrorResponse
		if !errors.As(err, &response) || response.Response.StatusCode != 404 {
			return nil, err
		}
		// A repository 404 alone is not absence: require actual authenticated SDK
		// admin lookup of our exact unique runner name to agree.
		existing, lookupErr := c.api.scale.GetRunnerByName(ctx, a.RunnerName)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if existing != nil {
			return nil, waitingFor("SDK registration not yet published through REST")
		}
		return nil, nil
	}
	if runner.GetID() != int64(a.RunnerID) || runner.GetName() != a.RunnerName {
		return nil, retained("REST registration identity mismatch")
	}
	if runner.Busy == nil {
		// GetBusy reads a missing field as false: never DELETE or treat as idle.
		return nil, retained("REST registration busy state missing")
	}
	return runner, nil
}

// removeOffline deletes the exact owned registration once REST shows it
// explicitly non-busy and offline. check, when set, vetoes the DELETE from the
// observed registration and the fresh slot read just before dispatch. Any due
// App installation-token refresh completes before that check, so the DELETE
// cannot wait on authentication after it; connection, DNS, TLS, network,
// client and server waits still follow the check, and GitHub offers no
// conditional runner DELETE.
func (c *controller) removeOffline(ctx context.Context, a slot, check func(*github.Runner) error) error {
	runner, err := c.runner(ctx, a)
	if err != nil || runner == nil {
		return err
	}
	if err := c.api.appTokenReady(ctx); err != nil {
		return err
	}
	if check != nil {
		if err := check(runner); err != nil {
			return err
		}
	}
	if runner.GetBusy() || runner.GetStatus() != "offline" {
		return waitingFor("owned registration not yet offline; never busy DELETE")
	}
	if _, err := c.api.github.Actions.RemoveRunner(ctx, "fitchmultz", "pi-subagents", int64(a.RunnerID)); err != nil {
		return err
	}
	runner, err = c.runner(ctx, a)
	if err != nil {
		return err
	}
	if runner != nil {
		return waitingFor("registration deletion not yet absent")
	}
	return nil
}

func (c *controller) disposeUnlaunched(a slot) error {
	status, err := c.nativeCall(a, "status", nil)
	if err != nil {
		return err
	}
	if status.Launched || status.InterruptedUnassigned {
		return c.phase(a, "launched")
	}
	// Native saves the SDK-returned runner ID before launch assertions, so pre-JIT
	// disposal must carry Go's authenticated absence proof for that exact identity.
	// No run/job/source exists yet; those fields stay zero.
	var terminal *terminalProof
	if a.RunnerID > 0 {
		if a.ReturnedName != "" && a.ReturnedName != a.RunnerName {
			return retained("foreign returned runner identity retained")
		}
		ctx, cancel := operationContext(context.Background())
		defer cancel()
		if err := c.removeOffline(ctx, a, nil); err != nil {
			return err
		}
		terminal = &terminalProof{RunnerID: a.RunnerID, RunnerName: a.RunnerName, RegistrationAbsent: true}
	}
	reply, err := c.nativeCall(a, "settle", func(req *nativeRequest) { req.Terminal = terminal })
	if err != nil {
		return err
	}
	if !reply.Disposed || reply.SourceVerified || reply.VetoVerified {
		return retained("unlaunched native resource disposal not proved")
	}
	return c.phase(a, "disposed")
}

func (c *controller) observe(a slot) error {
	switch {
	case a.CancelConveyed || (a.Assignment == nil && a.Source == nil && (a.Completion != nil || a.IntentCanceled != nil)):
		// Once a cancellation reached native, a later start is a contradiction
		// that drainIdle retains rather than reinterpreting as a live job.
		return c.drainIdle(a)
	case a.Source != nil && a.Phase != "bound":
		// A pending bind resumes before any new capture.
		return c.bindSource(a)
	case a.Source != nil && a.Completion != nil:
		return c.phase(a, "settling")
	case a.Source != nil:
		return c.observeBound(a)
	case a.Assignment != nil && a.Completion != nil:
		return c.lateCompletion(a)
	}
	if reclaimed, err := c.reclaimUnneeded(a.OperationID); reclaimed || err != nil {
		return err
	}
	if !a.Ready {
		ctx, cancel := operationContext(context.Background())
		runner, err := c.runner(ctx, a)
		cancel()
		if err != nil {
			return err
		}
		if runner != nil && runner.GetStatus() == "online" {
			if err := c.journal.active(a.OperationID, func(current *slot) error { current.Ready = true; return nil }); err != nil {
				return err
			}
		}
	}
	reply, err := c.nativeCall(a, "capture", nil)
	if err != nil {
		return err
	}
	if interruptedIdle(reply) {
		return c.recordInterrupted(a)
	}
	if reply.Veto != nil {
		return c.recordVeto(a, *reply.Veto)
	}
	if reply.Capture == nil {
		return nil
	}
	if a.Assignment == nil {
		return waitingFor("official hook captured before SDK job start")
	}
	return c.freezeSource(a, reply.Capture)
}

// observeBound waits for the bound job to end. The SDK completion is only a
// signal and may be lost with an expired session (a new session replays
// statistics, not job messages), so actual native transport exit also starts
// settlement through the same REST terminal, registration and native proofs.
func (c *controller) observeBound(a slot) error {
	status, err := c.nativeCall(a, "status", nil)
	if err != nil {
		return err
	}
	if !status.TransportEnded {
		return nil // The official listener still owns the acknowledged job.
	}
	return c.phase(a, "settling")
}

// freezeSource resolves authenticated source metadata, then publishes it only
// if no completion was accepted meanwhile. Bind is built from fresh state.
func (c *controller) freezeSource(a slot, capture *nativeCapture) error {
	hook, err := capture.context(a)
	if err != nil {
		return err
	}
	ctx, cancel := operationContext(context.Background())
	defer cancel()
	binding, err := resolveSource(ctx, c.api.github, a, hook)
	if err != nil {
		return err
	}
	binding.OperationID = a.OperationID
	binding.ContextHash = capture.ContextHash
	binding.RunnerVersion = capture.RunnerVersion
	binding.WorkerSHA256 = capture.WorkerSHA256
	if err := c.journal.active(a.OperationID, func(current *slot) error {
		if current.Completion != nil {
			return retained("completion accepted before source freeze")
		}
		if current.Assignment == nil || !sameRequest(current.Assignment.JobMessageBase, a.Assignment.JobMessageBase) {
			return retained("assignment changed during source resolution")
		}
		current.Source = binding
		return nil
	}); err != nil {
		return err
	}
	fresh, err := c.current(a.OperationID)
	if err != nil {
		return err
	}
	return c.bindSource(fresh)
}

func (c *controller) bindSource(a slot) error {
	bound, err := c.nativeCall(a, "bind", func(req *nativeRequest) { req.Binding = a.Source })
	if errors.Is(err, errNativeRetained) {
		// Native refused acknowledgment (e.g. a completion closed capture first).
		return c.lateCompletion(a)
	}
	if err != nil {
		return err
	}
	if bound.Phase != "bound" {
		return retained("native pre-job source acknowledgment not proved")
	}
	return c.phase(a, "bound")
}

// lateCompletion handles a job that ended before native acknowledged source.
// Only an authenticated deterministic native veto is settled; else retain.
func (c *controller) lateCompletion(a slot) error {
	reply, err := c.nativeCall(a, "status", nil)
	if err != nil {
		return err
	}
	if reply.Veto != nil {
		return c.recordVeto(a, *reply.Veto)
	}
	return retained("job ended before native source acknowledgment")
}

func (c *controller) settleAssigned(a slot) error {
	status, err := c.nativeCall(a, "status", nil)
	if err != nil {
		return err
	}
	if !status.TransportEnded {
		return waitingFor("official listener transport still live")
	}
	ctx, cancel := operationContext(context.Background())
	defer cancel()
	terminal, err := completedJob(ctx, c.api.github, a)
	if err != nil {
		return err
	}
	if err := c.journal.active(a.OperationID, func(current *slot) error { current.Terminal = terminal; return nil }); err != nil {
		return err
	}
	if err := c.removeOffline(ctx, a, nil); err != nil {
		return err
	}
	terminal.RegistrationAbsent = true
	reply, err := c.nativeCall(a, "settle", func(req *nativeRequest) { req.Binding = a.Source; req.Terminal = terminal })
	if err != nil {
		return err
	}
	if !reply.Disposed || !reply.SourceVerified || !reply.TransportEnded {
		return retained("native terminal/source/disposal certainty missing")
	}
	return c.disposed(a, terminal)
}

// disposed records the proved terminal, including registration absence, with
// the disposal itself.
func (c *controller) disposed(a slot, terminal *terminalProof) error {
	return c.journal.active(a.OperationID, func(current *slot) error {
		current.Terminal, current.Phase = terminal, "disposed"
		return nil
	})
}

// release ends native ownership with one EOF and the actual owner exit, then
// frees the slot. Only exactly observed terminal requests become ineligible;
// unlaunched and interrupted-unassigned recovery keep their acquired demand
// for the next slot.
func (c *controller) release(a slot) error {
	if c.native != nil {
		ctx, cancel := operationContext(context.Background())
		defer cancel()
		if err := c.native.finish(ctx); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return waitingFor("native owner exit pending")
			}
			return errors.Join(retained("native owner exit failed"), err)
		}
		c.native = nil
	}
	return c.journal.update(func(s *state) error {
		current := s.Active
		if current == nil || current.OperationID != a.OperationID {
			return retained("disposed slot changed")
		}
		if current.Terminal != nil && current.Terminal.NoJob {
			// A job fact accepted while the owner exited retains the slot: capacity
			// is never freed, nor a request completed, from a no-job proof.
			if err := current.noJobFacts(current.Terminal); err != nil {
				return err
			}
		}
		if current.Completion != nil {
			markCompleted(s, current.Completion.RunnerRequestID)
		}
		if current.Terminal != nil {
			markCompleted(s, current.Terminal.RequestID)
			if current.Source != nil {
				// Native verified this exact bound request's authenticated terminal.
				markCompleted(s, current.Source.RequestID)
			}
		}
		s.LastDisposition = disposition(*current)
		s.LastTerminal = current.Terminal
		if current.RunnerID > 0 {
			// A later job fact for this disposed runner is a known late
			// contradiction (recordStarted), not an unknown runner.
			s.ReleasedRunners = append(s.ReleasedRunners, runnerIdentity{ID: current.RunnerID, Name: current.RunnerName})
			if len(s.ReleasedRunners) > maxReleasedRunners {
				s.ReleasedRunners = s.ReleasedRunners[len(s.ReleasedRunners)-maxReleasedRunners:]
			}
		}
		s.Active = nil
		s.StatisticsStale = true
		admit(s, c.stopping.Load())
		return nil
	})
}

func disposition(a slot) string {
	switch {
	case a.Veto != nil:
		return "guard-vetoed-failure"
	case a.Source != nil:
		return "source-consistent-settlement"
	case a.Terminal != nil && a.Terminal.InterruptedUnassigned:
		return "interrupted-unassigned-recovery"
	case a.Terminal != nil && a.Terminal.NoJob:
		return "canceled-unassigned"
	default:
		return "unlaunched-recovery"
	}
}
