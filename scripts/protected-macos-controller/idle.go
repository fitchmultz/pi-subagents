package main

import (
	"context"
	"errors"
	"strings"

	"github.com/google/go-github/v88/github"
)

// drainIdle settles an acquired request the server canceled before any job
// started. busy:false is NOT idle authority: native closes the still-held
// pre-job gate, proves no Worker/capture/ACK and the exact official idle
// incarnation, then stops and reobserves only that owned listener. Any race or
// unknown native/remote state retains the slot, and so does any job fact
// accepted meanwhile (noJobFacts): an exact-runner start after the
// cancellation was conveyed is a contradiction, never a new job.
func (c *controller) drainIdle(a slot) error {
	proof := a.Terminal
	if proof == nil || !proof.NoJob || !proof.RegistrationAbsent {
		if a.AcquireIntent == nil {
			return retained(canceledNoJobCode)
		}
		proof = &terminalProof{NoJob: true, RequestID: a.AcquireIntent.RunnerRequestID, Canceled: true, RunnerID: a.RunnerID, RunnerName: a.RunnerName, RunID: a.AcquireIntent.WorkflowRunID}
		if err := a.noJobFacts(proof); err != nil {
			return err
		}
		if err := c.drainRegistration(a, proof); err != nil {
			return err
		}
	} else if err := a.noJobFacts(proof); err != nil {
		return err
	}
	return c.settleNoJob(a, proof)
}

// drainRegistration stops the proved idle listener through native, then
// removes the exact owned offline registration and journals the no-job proof.
func (c *controller) drainRegistration(a slot, proof *terminalProof) error {
	ctx, cancel := operationContext(context.Background())
	runner, err := c.runner(ctx, a)
	cancel()
	if err != nil {
		return err
	}
	if runner != nil && runner.GetBusy() {
		return retained("actual owned runner busy; idle drain prohibited")
	}
	native, err := c.nativeCall(a, "drain", func(req *nativeRequest) { req.Terminal = proof })
	if err != nil {
		return err
	}
	if !native.TransportEnded || native.SourceVerified {
		return retained("idle listener transport/consumers not actually ended")
	}
	if err := c.freshNoJob(a, proof); err != nil {
		return err
	}
	ctx, cancel = operationContext(context.Background())
	defer cancel()
	if err := c.removeOffline(ctx, a, func(*github.Runner) error { return c.freshNoJob(a, proof) }); err != nil {
		return err
	}
	proof.RegistrationAbsent = true
	return c.commitNoJob(a, proof, func(current *slot) { current.Terminal = proof })
}

const canceledNoJobCode = "idle drain requires exact authenticated canceled acquisition and no assignment"

// canceledNoJob is the canceled no-job invariant: the exact authenticated
// cancellation of request is still the slot's only job fact.
func (a slot) canceledNoJob(request int64) error {
	canceled := a.Completion
	if canceled == nil {
		canceled = a.IntentCanceled
	}
	if a.Assignment != nil || a.Source != nil || a.Veto != nil || a.AcquireIntent == nil || canceled == nil || !strings.EqualFold(canceled.Result, "canceled") || canceled.RunnerRequestID != a.AcquireIntent.RunnerRequestID || canceled.RunnerRequestID != request {
		return retained(canceledNoJobCode)
	}
	return nil
}

// noJobFacts re-validates a no-job proof against the slot: a job fact accepted
// since the proof retains the slot instead of deleting, disposing or freeing.
func (a slot) noJobFacts(proof *terminalProof) error {
	if proof.InterruptedUnassigned {
		return a.unassigned()
	}
	return a.canceledNoJob(proof.RequestID)
}

// freshNoJob reads the current slot, e.g. as the final veto before a DELETE.
func (c *controller) freshNoJob(a slot, proof *terminalProof) error {
	fresh, err := c.current(a.OperationID)
	if err != nil {
		return err
	}
	return fresh.noJobFacts(proof)
}

// commitNoJob applies change only in the same journal transaction that
// re-validates the fresh slot against the no-job proof.
func (c *controller) commitNoJob(a slot, proof *terminalProof, change func(*slot)) error {
	return c.journal.active(a.OperationID, func(current *slot) error {
		if err := current.noJobFacts(proof); err != nil {
			return err
		}
		change(current)
		return nil
	})
}

// settleNoJob has native dispose the operation under the journaled no-job
// proof, then records disposed only while the fresh slot still agrees.
func (c *controller) settleNoJob(a slot, proof *terminalProof) error {
	reply, err := c.nativeCall(a, "settle", func(req *nativeRequest) { req.Terminal = proof })
	if err != nil {
		return err
	}
	if !reply.Disposed || !reply.TransportEnded || reply.SourceVerified || reply.VetoVerified || reply.InterruptedUnassigned != proof.InterruptedUnassigned {
		return retained("native no-job disposal missing or falsely claims source qualification")
	}
	return c.commitNoJob(a, proof, func(current *slot) { current.Phase = "disposed" })
}

// interruptedIdle reports native's proof that, after protocol EOF, it stopped
// only a known idle listener and observed its actual transport end.
func interruptedIdle(r *nativeReply) bool {
	return r.InterruptedUnassigned && r.TransportEnded && r.Phase == "idle-interrupted" && !r.SourceVerified && !r.VetoVerified && r.Capture == nil && r.Veto == nil
}

// unassigned rejects any journaled fact contradicting native's no-job EOF
// interruption: a job, source, terminal signal, cancellation or veto.
func (a slot) unassigned() error {
	if a.Assignment != nil || a.Source != nil || a.Completion != nil || a.IntentCanceled != nil || a.CancelConveyed || a.Veto != nil || (a.Terminal != nil && !a.Terminal.InterruptedUnassigned) || a.RunnerID <= 0 || (a.ReturnedName != "" && a.ReturnedName != a.RunnerName) {
		return retained("native interrupted-unassigned contradicts journaled runner facts")
	}
	return nil
}

// recordInterrupted durably enters recovery only while Go's slot agrees no job
// reached this runner.
func (c *controller) recordInterrupted(a slot) error {
	return c.journal.active(a.OperationID, func(current *slot) error {
		if err := current.unassigned(); err != nil {
			return err
		}
		current.Phase = "interrupted"
		return nil
	})
}

func (c *controller) capacityWanted() bool {
	return capacityWanted(c.journal.snapshot(), c.stopping.Load())
}

// reclaimUnneeded ends a launched, unassigned slot whose capacity current
// facts no longer want (no acquired demand and no assigned job without a
// running runner, or drain/shutdown) through native's existing known-idle EOF
// recovery. The same live owner gets protocol EOF once, and its actual exit is
// awaited; native stops only a root-proved idle listener, the next owner's
// capture reports the interruption, and recordInterrupted/settleInterrupted
// dispose of the slot. EOF is sent under dispatchMu and startMu, so a
// completion or start accepted before it keeps the slot, and one accepted
// after it contradicts the recovery. A busy, assigned or unknown native
// lifetime keeps its owner alive: the slot waits, never freed by statistics.
func (c *controller) reclaimUnneeded(operation string) (bool, error) {
	n := c.native
	if n == nil || n.poisoned || n.outstanding() != nil {
		return false, nil
	}
	if !n.closed {
		c.dispatchMu.Lock()
		c.startMu.Lock()
		s := c.journal.snapshot()
		a := s.Active
		unneeded := a != nil && a.OperationID == operation && a.Phase == "launched" && a.Terminal == nil && a.unassigned() == nil && !capacityWanted(s, c.stopping.Load())
		var err error
		if unneeded {
			err = n.closeInput()
		}
		c.startMu.Unlock()
		c.dispatchMu.Unlock()
		if !unneeded || err != nil {
			return unneeded, err
		}
	}
	ctx, cancel := operationContext(context.Background())
	defer cancel()
	if err := n.finish(ctx); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return true, waitingFor("native owner exit pending after idle EOF")
		}
		return true, errors.Join(retained("native owner exit failed"), err)
	}
	c.native = nil
	return true, nil
}

// settleInterrupted removes only the exact owned, explicitly non-busy offline
// registration after native re-proves the interruption, then has native
// dispose the operation. The acquired intent is kept: no request was canceled
// or completed, so release marks nothing complete.
func (c *controller) settleInterrupted(a slot) error {
	if err := a.unassigned(); err != nil {
		return err
	}
	proof := a.Terminal
	if proof == nil {
		status, err := c.nativeCall(a, "status", nil)
		if err != nil {
			return err
		}
		if !interruptedIdle(status) {
			return retained("native interrupted-unassigned proof missing or changed")
		}
		proof = &terminalProof{InterruptedUnassigned: true, NoJob: true, RunnerID: a.RunnerID, RunnerName: a.RunnerName}
		ctx, cancel := operationContext(context.Background())
		defer cancel()
		if err := c.removeOffline(ctx, a, func(runner *github.Runner) error {
			if runner.GetBusy() {
				return retained("owned runner busy contradicts native idle interruption")
			}
			return c.freshNoJob(a, proof)
		}); err != nil {
			return err
		}
		proof.RegistrationAbsent = true
		if err := c.commitNoJob(a, proof, func(current *slot) { current.Terminal = proof }); err != nil {
			return err
		}
	}
	return c.settleNoJob(a, proof)
}
