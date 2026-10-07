package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"sync/atomic"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

var errAcquisitionHeld = errors.New("acquisition held during retained slot uncertainty")

type controller struct {
	journal    *journal
	config     config
	api        apiClients
	session    *scaleset.MessageSessionClient
	listener   *listener.Listener
	listenerMu sync.Mutex
	// dispatchMu orders SDK completion publication against native request
	// frames. dispatch locks it and the writer releases it when its write
	// returns, so a request either carries an accepted completion, was fully
	// written before that completion was journaled, or was aborted unterminated.
	// It is never held across a native reply wait or an SDK call.
	dispatchMu sync.Mutex
	// completionWaiting counts Scale calls waiting on dispatchMu to publish a
	// completion; a blocked frame write aborts rather than delay them.
	completionWaiting atomic.Int32
	// startMu orders SDK JobStarted publication against no-job drain/settle
	// frames, as dispatchMu does for completions: such a frame is validated
	// against the current slot and written while it is held, so an exact-runner
	// start is either durable before the frame (and vetoes it), published after
	// the whole frame is in the native pipe, or the frame is aborted
	// unterminated. Other frames never hold it, so starts never wait on them.
	startMu      sync.Mutex
	startWaiting atomic.Int32
	wake         chan struct{}
	workerDone   chan struct{}
	// workerErr is written once by the worker before it closes workerDone.
	workerErr error
	native    *nativeSession
	stopping  atomic.Bool
}

func (c *controller) notify() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *controller) Scale(ctx context.Context, msg *scaleset.RunnerScaleSetMessage) error {
	// Only an SDK completion changes native request content. Its publication waits
	// for dispatchMu: any frame built without it is fully written first, or is
	// aborted unterminated within one frameSlice when native is not reading.
	// A start, which contradicts a no-job proof, waits for startMu the same way,
	// but only behind no-job drain/settle frames. Other messages never wait on
	// native input.
	// ponytail: ANY completion, even for an unrelated request, aborts a blocked
	// frame and poisons the native owner (fail-closed, never an unterminated or
	// late request). Narrowing needs a proven relevant-completion snapshot and
	// ordering design; build it if unrelated-completion stalls are observed.
	completions := msg != nil && len(msg.JobCompletedMessages) > 0
	starts := msg != nil && len(msg.JobStartedMessages) > 0
	if completions {
		c.completionWaiting.Add(1)
		c.dispatchMu.Lock()
		c.completionWaiting.Add(-1)
	}
	if starts {
		c.startWaiting.Add(1)
		c.startMu.Lock()
		c.startWaiting.Add(-1)
	}
	err := c.journal.update(func(s *state) error { return acceptMessage(s, msg, c.stopping.Load()) })
	if starts {
		c.startMu.Unlock()
	}
	if completions {
		c.dispatchMu.Unlock()
	}
	if err != nil {
		return err
	}
	if err := c.acquirePending(ctx); err != nil {
		return err
	}
	if msg == nil {
		c.refreshStatistics(ctx)
	}
	c.adjustCapacity()
	c.notify()
	return nil // The actual SDK ACK follows this durable publication, not VM completion.
}

// statisticsBlocked reports a free slot that cached statistics cannot admit:
// they count a registration, or predate the last release.
func statisticsBlocked(s state, stopping bool) bool {
	return s.Active == nil && !s.Drain && !stopping && (s.Statistics.TotalRegisteredRunners > 0 || s.StatisticsStale)
}

// refreshStatistics replaces cached statistics that block a free slot, on a
// nil long poll. The SDK's nil poll carries no statistics and a session's
// initial statistics arrive once, so a released own runner would otherwise stay
// counted, and old demand stay admissible, for the session's lifetime. The
// actual SDK scale-set read counts only for the exact owned identity and
// labels; a positive count is never subtracted. A failed or invalid read keeps
// the block, is recorded as the listener diagnostic and is retried on the next
// nil poll. Only Scale writes statistics and the listener calls it serially,
// so no older observation can overwrite a newer one; the worker cannot admit
// while no slot exists.
func (c *controller) refreshStatistics(ctx context.Context) {
	s := c.journal.snapshot()
	if ctx.Err() != nil || !statisticsBlocked(s, c.stopping.Load()) {
		return
	}
	apiCtx, cancel := operationContext(ctx)
	defer cancel()
	fresh, err := c.api.scale.GetRunnerScaleSetByID(apiCtx, s.ScaleSetID)
	if err == nil {
		err = validScaleSetStatistics(fresh, s.ScaleSetID)
	}
	if err == nil {
		err = c.journal.update(func(s *state) error {
			if statisticsBlocked(*s, c.stopping.Load()) {
				observeStatistics(s, *fresh.Statistics)
				admit(s, c.stopping.Load())
			}
			return nil
		})
	}
	if err != nil {
		d := classify(err)
		d.Code = "statistics-refresh: " + d.Code
		c.setListener(true, &d)
		return
	}
	c.setListener(true, nil)
}

func validScaleSetStatistics(ss *scaleset.RunnerScaleSet, id int) error {
	if ss == nil || ss.ID != id || ss.Name != scaleSetName || ss.Statistics == nil {
		return retained("scale-set statistics identity not proved")
	}
	labels := make([]string, len(ss.Labels))
	for i, label := range ss.Labels {
		labels[i] = label.Name
	}
	if !sameLabels(labels, requiredLabels) || !validStatistics(*ss.Statistics) {
		return retained("scale-set statistics labels or counts invalid")
	}
	return nil
}

// validStatistics rejects every negative count admission, demand retirement
// or the registration block reads, from any statistics source.
func validStatistics(stats scaleset.RunnerScaleSetStatistic) bool {
	return stats.TotalRegisteredRunners >= 0 && stats.TotalAssignedJobs >= 0 && stats.TotalRunningJobs >= 0 && stats.TotalAvailableJobs >= 0 && stats.TotalAcquiredJobs >= 0
}

// acceptMessage durably records one SDK message (or a nil long-poll timeout)
// and re-evaluates admission from the journal and cached statistics. The
// message's statistics are always current, also on a redelivered body, so they
// are applied first; a redelivered body's lifecycle and offers are not re-run.
// Statistics applied before the message's own effects never erase demand the
// message itself adds.
func acceptMessage(s *state, msg *scaleset.RunnerScaleSetMessage, stopping bool) error {
	if msg != nil {
		duplicate, err := recordReceipt(s, msg)
		if err != nil {
			return err
		}
		observeStatistics(s, *msg.Statistics)
		if !duplicate {
			s.DemandRejection = ""
			if err := recordLifecycle(s, msg); err != nil {
				return err
			}
			if !s.Drain && !stopping {
				recordAvailable(s, msg.JobAvailableMessages)
			}
		}
	}
	retarget(s)
	admit(s, stopping)
	return nil
}

// observeStatistics applies current SDK statistics. The SDK documents them as
// always current, with TotalAssignedJobs counting waiting and running jobs.
// With nothing acquired or assigned to this scale set, earlier acquired or
// ambiguous requests were canceled or reassigned while unobserved, so their
// bookkeeping is retired, also while a slot is active. Offered-only demand
// stays; the active slot, its intent and every terminal proof are untouched,
// and nothing is marked complete.
func observeStatistics(s *state, stats scaleset.RunnerScaleSetStatistic) {
	s.Statistics, s.StatisticsStale = stats, false
	if stats.TotalAssignedJobs == 0 && stats.TotalAcquiredJobs == 0 {
		s.Acquisitions = slices.DeleteFunc(s.Acquisitions, func(a acquisition) bool { return a.Acquired || a.Attempts > 0 })
	}
}

// recordReceipt reports whether this exact delivery (message ID and body) was
// already accepted. Statistics are excluded: the SDK refreshes them on every
// redelivery of an unacknowledged message.
func recordReceipt(s *state, msg *scaleset.RunnerScaleSetMessage) (bool, error) {
	if msg.Statistics == nil {
		return false, errors.New("SDK message missing authoritative statistics")
	}
	if !validStatistics(*msg.Statistics) {
		return false, errors.New("negative SDK statistics")
	}
	if msg.MessageID == listener.InitialMessageID {
		return false, nil
	}
	delivery := *msg
	delivery.Statistics = nil
	bytes, err := json.Marshal(delivery)
	if err != nil {
		return false, err
	}
	hash := sha256.Sum256(bytes)
	receipt := hex.EncodeToString(hash[:])
	if slices.Contains(s.Messages, receipt) {
		return true, nil
	}
	s.Messages = append(s.Messages, receipt)
	if len(s.Messages) > 128 {
		s.Messages = s.Messages[len(s.Messages)-128:]
	}
	return false, nil
}

// recordAvailable keeps every wanted JobAvailable, including whole batches and
// demand arriving while the physical slot is occupied. Acquisition happens
// server-side immediately; the slot is admitted later from acquired demand.
// Invalid or foreign entries are explicitly not acquired.
func recordAvailable(s *state, available []*scaleset.JobAvailable) {
	for _, job := range available {
		if job == nil {
			s.DemandRejection = "rejected-invalid-demand"
			continue
		}
		addDemand(s, job, false)
	}
}

// addDemand journals one valid, not yet tracked request. A request observed
// complete earlier is reopened: a non-duplicate offer or assignment is new
// server demand (a canceled attempt may be requeued), not live capacity.
// The journal's private input bound is the only size limit (journal.update).
func addDemand(s *state, job *scaleset.JobAvailable, acquired bool) {
	if findAcquisition(s, job.RunnerRequestID) >= 0 {
		return
	}
	if validateJobBase(job.JobMessageBase) != nil {
		s.DemandRejection = "rejected-invalid-demand"
		return
	}
	s.CompletedRequests = slices.DeleteFunc(s.CompletedRequests, func(id int64) bool { return id == job.RunnerRequestID })
	s.Acquisitions = append(s.Acquisitions, acquisition{Job: job, Acquired: acquired})
}

// capacityWanted reports whether current facts want the single physical slot:
// acquired demand not contradicted by a late start, or actual SDK statistics
// showing an assigned job without a running runner. Drain and shutdown want
// none. Statistics decide demand only; they never prove native idleness.
func capacityWanted(s state, stopping bool) bool {
	return !s.Drain && !stopping && (nextDemand(&s) != nil || s.Statistics.TotalAssignedJobs > s.Statistics.TotalRunningJobs)
}

// admit creates the single physical slot only while capacity is wanted.
func admit(s *state, stopping bool) {
	s.Admission = ""
	if s.Active != nil || !capacityWanted(*s, stopping) {
		return
	}
	if s.Statistics.TotalRegisteredRunners > 0 {
		// Aggregate counts cannot prove whose registration they include: wait for
		// fresh statistics showing none, never subtract a released own runner.
		s.Admission = "blocked-registered-runner"
		return
	}
	if s.StatisticsStale {
		// Old demand may have been canceled while the slot was occupied: admit
		// only after current statistics have reconciled it.
		s.Admission = "awaiting-current-statistics"
		return
	}
	s.Active = newSlot()
	s.Active.AcquireIntent = nextDemand(s)
}

// retarget moves a canceled or late-started (contradicted), not yet conveyed
// intent to other demand GitHub may assign to this runner: acquired, or
// attempted with a lost response. It runs after all message and acquisition
// effects.
func retarget(s *state) {
	a := s.Active
	// An interrupted slot keeps its intent and any cancellation as the
	// contradiction that retains it.
	if a == nil || a.AcquireIntent == nil || a.CancelConveyed || a.Assignment != nil || a.Completion != nil || a.Phase == "interrupted" || (a.Terminal != nil && a.Terminal.InterruptedUnassigned) {
		return
	}
	if i := findAcquisition(s, a.AcquireIntent.RunnerRequestID); a.IntentCanceled == nil && (i < 0 || s.Acquisitions[i].LateStartRunner == 0) {
		return
	}
	for _, entry := range s.Acquisitions {
		if (entry.Acquired || entry.Attempts > 0) && entry.LateStartRunner == 0 {
			job := *entry.Job
			a.AcquireIntent, a.IntentCanceled = &job, nil
			return
		}
	}
	if a.IntentCanceled == nil {
		// Without other demand a late-started intent is dropped: the slot serves
		// whatever GitHub assigns, never the contradicted request.
		a.AcquireIntent = nil
	}
}

func findAcquisition(s *state, request int64) int {
	return slices.IndexFunc(s.Acquisitions, func(a acquisition) bool { return a.Job.RunnerRequestID == request })
}

// nextDemand returns the oldest server-acquired request not contradicted by a
// late start on a released runner.
func nextDemand(s *state) *scaleset.JobAvailable {
	for _, entry := range s.Acquisitions {
		if entry.Acquired && entry.LateStartRunner == 0 {
			job := *entry.Job
			return &job
		}
	}
	return nil
}

// markCompleted records exactly observed terminal requests and ends their
// in-flight acquisition. Nothing else makes a request ineligible.
func markCompleted(s *state, request int64) {
	if request <= 0 {
		return
	}
	s.Acquisitions = slices.DeleteFunc(s.Acquisitions, func(a acquisition) bool { return a.Job.RunnerRequestID == request })
	if slices.Contains(s.CompletedRequests, request) {
		return
	}
	s.CompletedRequests = append(s.CompletedRequests, request)
	if len(s.CompletedRequests) > 128 {
		s.CompletedRequests = s.CompletedRequests[len(s.CompletedRequests)-128:]
	}
}

func sameRequest(a, b scaleset.JobMessageBase) bool {
	return a.RunnerRequestID == b.RunnerRequestID && a.WorkflowRunID == b.WorkflowRunID && a.JobID == b.JobID && a.OwnerName == b.OwnerName && a.RepositoryName == b.RepositoryName
}

func recordLifecycle(s *state, msg *scaleset.RunnerScaleSetMessage) error {
	for _, assigned := range msg.JobAssignedMessages {
		if assigned == nil {
			return errors.New("nil SDK assigned job")
		}
		if i := findAcquisition(s, assigned.RunnerRequestID); i >= 0 {
			if !sameRequest(assigned.JobMessageBase, s.Acquisitions[i].Job.JobMessageBase) {
				return errors.New("assigned acquisition identity changed")
			}
			// A (re)assignment is current server demand, also after a late start.
			s.Acquisitions[i].Acquired, s.Acquisitions[i].LateStartRunner = true, 0
			continue
		}
		// Assignment to this scale set is acquired demand, including a reassigned
		// request whose earlier attempt was canceled.
		addDemand(s, &scaleset.JobAvailable{JobMessageBase: assigned.JobMessageBase}, true)
	}
	for _, started := range msg.JobStartedMessages {
		if err := recordStarted(s, started); err != nil {
			return err
		}
	}
	for _, completed := range msg.JobCompletedMessages {
		if err := recordCompletion(s, completed); err != nil {
			return err
		}
	}
	return nil
}

// ownedRunner reports the exact durable runner identity of the active slot.
// It is checked before request history: one request may be canceled and
// requeued, and only the runner identity says this slot is affected.
func ownedRunner(s *state, id int, name string) bool {
	return s.Active != nil && s.Active.RunnerID > 0 && id == s.Active.RunnerID && name == s.Active.RunnerName
}

func recordStarted(s *state, started *scaleset.JobStarted) error {
	if started == nil {
		return errors.New("nil SDK started job")
	}
	if !ownedRunner(s, started.RunnerID, started.RunnerName) {
		if slices.Contains(s.CompletedRequests, started.RunnerRequestID) {
			return nil
		}
		if slices.Contains(s.ReleasedRunners, runnerIdentity{ID: started.RunnerID, Name: started.RunnerName}) {
			return recordLateStart(s, started)
		}
		return errors.New("started runner is not the durable owned slot")
	}
	if err := validateJobBase(started.JobMessageBase); err != nil {
		return err
	}
	a := s.Active
	if a.Assignment != nil && !sameRequest(a.Assignment.JobMessageBase, started.JobMessageBase) {
		return errors.New("ephemeral runner received conflicting assignment")
	}
	a.Assignment = started
	if !a.CancelConveyed {
		// The canceled intent never reached native closure: this exact start wins.
		// Once conveyed, the start is kept as a contradiction that retains the slot.
		a.IntentCanceled = nil
	}
	return nil
}

// recordLateStart keeps a delayed start for a runner this owner already
// disposed of as a durable contradiction on its request: not a new assignment,
// completion or cancellation, and no reason to refuse the SDK message. The
// request is not served again until reconciled (LateStartRunner).
func recordLateStart(s *state, started *scaleset.JobStarted) error {
	if err := validateJobBase(started.JobMessageBase); err != nil {
		return err
	}
	addDemand(s, &scaleset.JobAvailable{JobMessageBase: started.JobMessageBase}, true)
	i := findAcquisition(s, started.RunnerRequestID)
	if i < 0 || !sameRequest(s.Acquisitions[i].Job.JobMessageBase, started.JobMessageBase) {
		return errors.New("late start request identity mismatch")
	}
	s.Acquisitions[i].Acquired, s.Acquisitions[i].LateStartRunner = true, started.RunnerID
	return nil
}

// recordCompletion handles one exact SDK terminal. A completion is only a
// settlement signal for the slot; it never proves native disposal.
// A completion is also the exact server terminal that reconciles a late start.
func recordCompletion(s *state, completed *scaleset.JobCompleted) error {
	if completed == nil {
		return errors.New("nil SDK completion")
	}
	request := completed.RunnerRequestID
	a := s.Active
	switch {
	case ownedRunner(s, completed.RunnerID, completed.RunnerName):
		expected := a.Assignment
		if expected != nil && !sameRequest(expected.JobMessageBase, completed.JobMessageBase) {
			return errors.New("completion assignment identity mismatch")
		}
		if completed.OwnerName != "fitchmultz" || completed.RepositoryName != "pi-subagents" {
			return errors.New("completion repository identity mismatch")
		}
		a.Completion = completed
	case slices.Contains(s.CompletedRequests, request):
		return nil
	case a != nil && a.Assignment == nil && a.Completion == nil && a.IntentCanceled == nil && a.AcquireIntent != nil && request == a.AcquireIntent.RunnerRequestID && completed.RunnerID == 0 && completed.RunnerName == "":
		if !sameRequest(a.AcquireIntent.JobMessageBase, completed.JobMessageBase) {
			return errors.New("canceled acquisition identity mismatch")
		}
		// The admitted request ended before any job started on this runner;
		// retarget decides after every effect of this message and acquisition.
		// Only a terminal naming no runner is such a cancellation: one naming
		// another (e.g. released) runner is that runner's job, request
		// bookkeeping below, never this runner's no-job authority.
		a.IntentCanceled = completed
	case findAcquisition(s, request) >= 0:
		if !sameRequest(s.Acquisitions[findAcquisition(s, request)].Job.JobMessageBase, completed.JobMessageBase) {
			return errors.New("acquired request completion identity mismatch")
		}
	default:
		return nil
	}
	markCompleted(s, request)
	return nil
}

// acquirePending passes every wanted, not yet acquired request to the actual
// SDK AcquireJobs. Attempts are durable before the call so a lost response is
// never mistaken for an explicit first-attempt rejection.
func (c *controller) acquirePending(ctx context.Context) error {
	s := c.journal.snapshot()
	if s.Drain || c.stopping.Load() {
		return nil // Drain/shutdown requests no new acquisition.
	}
	var ids []int64
	for _, entry := range s.Acquisitions {
		if !entry.Acquired {
			ids = append(ids, entry.Job.RunnerRequestID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	err := c.journal.update(func(s *state) error {
		if s.Active != nil && s.Active.Diagnostic != nil && s.Active.Diagnostic.Kind == "retained" {
			// No demand acquisition while the native slot is uncertain. Offers stay
			// journaled; a later poll acquires them once progress clears it.
			return errAcquisitionHeld
		}
		for i := range s.Acquisitions {
			if slices.Contains(ids, s.Acquisitions[i].Job.RunnerRequestID) {
				s.Acquisitions[i].Attempts++
			}
		}
		return nil
	})
	if errors.Is(err, errAcquisitionHeld) {
		return nil
	}
	if err != nil {
		return err
	}
	apiCtx, cancel := operationContext(ctx)
	defer cancel()
	got, err := c.session.AcquireJobs(apiCtx, ids)
	if err != nil {
		return err // Intent survives response loss; replay uses the SAME requests.
	}
	for _, id := range got {
		if !slices.Contains(ids, id) {
			return errors.New("SDK acquired an unrequested identity")
		}
	}
	return c.journal.update(func(s *state) error {
		s.Acquisitions = slices.DeleteFunc(s.Acquisitions, func(entry acquisition) bool {
			id := entry.Job.RunnerRequestID
			// Only a first-attempt omission is an explicit rejection. After a lost
			// response an omission is ambiguous: JobAssigned, a later acquisition
			// or the server's exact completion must resolve it.
			return !entry.Acquired && slices.Contains(ids, id) && !slices.Contains(got, id) && entry.Attempts == 1
		})
		for i := range s.Acquisitions {
			if slices.Contains(got, s.Acquisitions[i].Job.RunnerRequestID) {
				s.Acquisitions[i].Acquired = true
			}
		}
		retarget(s)
		admit(s, c.stopping.Load())
		return nil
	})
}
