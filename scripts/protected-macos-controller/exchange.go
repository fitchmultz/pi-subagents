package main

import (
	"context"
	"errors"
	"time"
)

// The native exchange: every request is built from the current journal and
// performed through the single actual native owner, ordered against SDK
// completion and start publication (see dispatch).

func nativeDeadline(action string) time.Duration {
	switch action {
	case "prepare", "drain", "settle":
		return 20 * time.Minute
	default:
		return 30 * time.Second
	}
}

// nativeCall performs one action through the single native owner. A still
// outstanding exchange for a different action is consumed and validated first
// (never resent); the same action resumes its original exchange.
func (c *controller) nativeCall(a slot, action string, modify func(*nativeRequest)) (*nativeReply, error) {
	ctx, cancel := context.WithTimeout(context.Background(), nativeDeadline(action))
	defer cancel()
	if err := c.nativeOwner(); err != nil {
		return nil, err
	}
	if prior := c.native.outstanding(); prior != nil && (prior.OperationID != a.OperationID || prior.Action != action) {
		// The late reply answers only its original request; native state, not this
		// result, is reconciled by the new action.
		if _, err := c.awaitNative(ctx); err != nil && !errors.Is(err, errNativeRetained) {
			return nil, err
		}
		if err := c.nativeOwner(); err != nil {
			return nil, err
		}
	}
	if c.native.outstanding() == nil {
		if err := c.dispatch(a.OperationID, action, modify); err != nil {
			return nil, err
		}
	}
	reply, err := c.awaitNative(ctx)
	if err != nil || !reply.InterruptedUnassigned {
		return reply, err
	}
	// Recheck fresh state after the wait: an accepted job fact contradicts the
	// native no-job interruption on every path, not only recovery.
	fresh, err := c.current(a.OperationID)
	if err != nil {
		return nil, err
	}
	return reply, fresh.unassigned()
}

// nativeOwner keeps the same live owner. A new owner starts only after the
// actual old process exited with no consumable outstanding reply. A poisoned
// live owner gets EOF once and is retained until its actual exit.
func (c *controller) nativeOwner() error {
	if c.native != nil {
		select {
		case <-c.native.done:
			if c.native.outstanding() == nil || c.native.poisoned {
				c.native = nil
			}
		default:
			if c.native.poisoned {
				if err := c.native.closeInput(); err != nil {
					return errors.Join(errNativeUnusable, err)
				}
				return errNativeUnusable
			}
		}
	}
	if c.native == nil {
		native, err := startNative(c.config)
		if err != nil {
			return err
		}
		c.native = native
	}
	return nil
}

func (c *controller) awaitNative(ctx context.Context) (*nativeReply, error) {
	reply, err := c.native.await(ctx)
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, waitingFor("native reply pending")
	}
	return reply, err
}

// dispatch builds the request from the CURRENT journal under dispatchMu and
// keeps it locked until the native writer returns. The linearization point is
// that return: Scale publishes a completion only while holding dispatchMu, so
// a frame either carries an accepted completion, was fully in the native pipe
// before the completion became durable (and therefore before its SDK ACK), or
// was abandoned unterminated, which native never acts on. A no-job drain or
// settle frame also holds startMu, so the same holds for an exact-runner start
// contradicting its proof. A waiting completion (or, for a no-job frame, start)
// aborts a blocked write within one frameSlice, so it never waits on native.
func (c *controller) dispatch(operation, action string, modify func(*nativeRequest)) error {
	c.dispatchMu.Lock()
	holdStarts := action == "drain" || action == "settle"
	if holdStarts {
		c.startMu.Lock()
	}
	unlock := func() {
		if holdStarts {
			c.startMu.Unlock()
		}
		c.dispatchMu.Unlock()
	}
	req, err := c.request(operation, action, modify)
	if err != nil {
		unlock()
		return err
	}
	if holdStarts && (req.Terminal == nil || !req.Terminal.NoJob) {
		c.startMu.Unlock() // No start contradicts this frame.
		holdStarts = false
	}
	noJob := holdStarts
	return c.native.send(req, unlock, func() bool {
		return c.completionWaiting.Load() > 0 || (noJob && c.startWaiting.Load() > 0)
	})
}

// request builds a native request from the current journal, then applies
// modify. A pure intent cancellation reaches native only with a no-job
// drain/settle, and is durably marked conveyed in the same journal transaction
// that builds the frame. Every no-job proof the final frame carries must still
// hold for the current slot, so a contradicted proof never reaches native.
func (c *controller) request(operation, action string, modify func(*nativeRequest)) (nativeRequest, error) {
	var req nativeRequest
	build := func(s *state) error {
		a := s.Active
		if a == nil || a.OperationID != operation {
			return retained("active operation identity changed")
		}
		req = nativeRequest{OperationID: a.OperationID, Action: action, RunnerName: a.RunnerName, RunnerID: a.RunnerID, Repository: repository, ScaleSetID: s.ScaleSetID, Completion: a.Completion}
		if modify != nil {
			modify(&req)
		}
		if a.Phase == "interrupted" {
			// Under dispatchMu: a completion accepted meanwhile is a contradiction,
			// never a cancellation to convey.
			return a.unassigned()
		}
		if action == "drain" || action == "settle" {
			if req.Completion == nil && a.Assignment == nil && a.IntentCanceled != nil {
				req.Completion = a.IntentCanceled
				a.CancelConveyed = true
			}
			if action == "drain" && req.Completion == nil {
				return retained("idle drain lacks an accepted cancellation")
			}
		}
		if req.Terminal != nil && req.Terminal.NoJob {
			return a.noJobFacts(req.Terminal)
		}
		return nil
	}
	if action == "drain" || action == "settle" {
		return req, c.journal.update(build)
	}
	s := c.journal.snapshot()
	return req, build(&s)
}
