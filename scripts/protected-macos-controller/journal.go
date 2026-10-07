package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/actions/scaleset"
	"github.com/google/uuid"
)

type slot struct {
	OperationID  string `json:"operationId"`
	RunnerName   string `json:"runnerName"`
	RunnerID     int    `json:"runnerId,omitempty"`
	ReturnedName string `json:"returnedName,omitempty"`
	Ready        bool   `json:"ready"`
	Phase        string `json:"phase"`
	// AcquireIntent is the server-acquired request this physical slot was
	// admitted for. GitHub may start any assigned request on the runner.
	AcquireIntent *scaleset.JobAvailable `json:"acquireIntent,omitempty"`
	Assignment    *scaleset.JobStarted   `json:"assignment,omitempty"`
	// Completion is the SDK terminal of the job on this exact runner.
	Completion *scaleset.JobCompleted `json:"completion,omitempty"`
	// IntentCanceled is the server's cancellation of AcquireIntent before any job
	// started on this runner. It is request bookkeeping, not a runner terminal:
	// other demand retargets the slot, and an exact-runner start supersedes it
	// until CancelConveyed records that a no-job drain/settle frame carried it.
	IntentCanceled *scaleset.JobCompleted `json:"intentCanceled,omitempty"`
	CancelConveyed bool                   `json:"cancelConveyed,omitempty"`
	Source         *sourceBinding         `json:"source,omitempty"`
	Diagnostic     *diagnostic            `json:"diagnostic,omitempty"`
	// LatestDiagnostic is the most recent lesser failure while a retained
	// Diagnostic stays sticky; only successful progress clears both.
	LatestDiagnostic *diagnostic    `json:"latestDiagnostic,omitempty"`
	Veto             *guardVeto     `json:"veto,omitempty"`
	Terminal         *terminalProof `json:"terminal,omitempty"`
}

// acquisition is one wanted SDK JobAvailable passed to AcquireJobs. It stays
// until an exact JobCompleted for its request is observed, so demand survives
// occupied slots, batches and unlaunched recovery without a local job queue.
type acquisition struct {
	Job      *scaleset.JobAvailable `json:"job"`
	Acquired bool                   `json:"acquired"`
	Attempts int                    `json:"attempts"`
	// LateStartRunner is a released runner the server reported starting this
	// request after its disposal: a durable contradiction, not new work. The
	// request is not served until an exact terminal, a reassignment or zero
	// statistics reconciles it.
	LateStartRunner int `json:"lateStartRunner,omitempty"`
}

// runnerIdentity is the exact SDK runner identity of a released slot.
type runnerIdentity struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// maxReleasedRunners bounds the released identities kept to recognize late
// job facts across serial releases.
const maxReleasedRunners = 32

type state struct {
	Version    int                              `json:"version"`
	Owner      string                           `json:"owner"`
	ScaleSetID int                              `json:"scaleSetId,omitempty"`
	Drain      bool                             `json:"drain"`
	Statistics scaleset.RunnerScaleSetStatistic `json:"statistics"`
	// StatisticsStale marks statistics observed before the last release; the
	// next slot waits for a current SDK observation.
	StatisticsStale   bool          `json:"statisticsStale,omitempty"`
	Acquisitions      []acquisition `json:"acquisitions,omitempty"`
	Active            *slot         `json:"active,omitempty"`
	CompletedRequests []int64       `json:"completedRequests,omitempty"`
	Messages          []string      `json:"messages,omitempty"`
	Admission         string        `json:"admission,omitempty"`
	// DemandRejection is the static reason some of the latest message's demand
	// was not acquired: invalid or foreign entries.
	DemandRejection string         `json:"demandRejection,omitempty"`
	Control         string         `json:"control,omitempty"`
	LastDisposition string         `json:"lastDisposition,omitempty"`
	LastTerminal    *terminalProof `json:"lastTerminal,omitempty"`
	// ReleasedRunners are the most recent disposed runner identities.
	ReleasedRunners []runnerIdentity `json:"releasedRunners,omitempty"`
	// ListenerUp and Listener are this process's last local observation of the
	// SDK listener; they are never live readiness.
	ListenerUp bool        `json:"listenerUp,omitempty"`
	Listener   *diagnostic `json:"listener,omitempty"`
}

type journal struct {
	mu     sync.Mutex
	root   string
	value  state
	guard  *os.File
	failed error
}

func openJournal(root string) (*journal, error) {
	if err := privatePath(root, true); err != nil {
		return nil, err
	}
	path := filepath.Join(root, "controller.guard")
	// O_CLOEXEC atomically: the guard belongs only to this Go process, never to
	// the independent native owner it executes (which outlives a cold exit).
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	guard := os.NewFile(uintptr(fd), path)
	fail := func(e error) (*journal, error) { guard.Close(); return nil, e }
	if err := privatePath(path, false); err != nil {
		return fail(err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail(fmt.Errorf("controller already owns guard: %w", err))
	}
	j := &journal{root: root, guard: guard, value: state{Version: 1, Owner: uuid.NewString()}}
	if err := readJSON(filepath.Join(root, "controller.json"), &j.value); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	if j.value.Version != 1 || uuid.Validate(j.value.Owner) != nil {
		return fail(errors.New("invalid journal identity"))
	}
	if err := j.update(func(*state) error { return nil }); err != nil {
		return fail(err)
	}
	return j, nil
}

func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".controller-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (j *journal) update(change func(*state) error) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.failed != nil {
		return j.failed
	}
	bytes, err := json.Marshal(j.value)
	if err != nil {
		return err
	}
	var next state
	if err = json.Unmarshal(bytes, &next); err != nil {
		return err
	}
	if err = change(&next); err != nil {
		return err
	}
	bytes, err = json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if len(bytes)+1 > maxPrivateJSON {
		// Nothing is published, so the failure is not sticky: the next owner
		// must always be able to read the journal back.
		return errors.New("journal state exceeds the private JSON input bound")
	}
	// Publish exactly the written content: the change may have stored
	// caller-owned pointers that the caller mutates after this returns.
	var durable state
	if err = json.Unmarshal(bytes, &durable); err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(j.root, "controller.json"), append(bytes, '\n')); err != nil {
		// A rename can have published despite a later directory-sync error.
		// Never overwrite that uncertain durable state from stale memory.
		j.failed = err
		return err
	}
	j.value = durable
	return nil
}

func (j *journal) snapshot() state {
	j.mu.Lock()
	defer j.mu.Unlock()
	bytes, _ := json.Marshal(j.value)
	var copy state
	_ = json.Unmarshal(bytes, &copy)
	return copy
}

// failure reports the sticky write failure that forbids any further update.
func (j *journal) failure() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.failed
}

func (j *journal) active(operation string, change func(*slot) error) error {
	return j.update(func(s *state) error {
		if s.Active == nil || s.Active.OperationID != operation {
			return errors.New("active operation identity changed")
		}
		return change(s.Active)
	})
}

func (j *journal) retain(operation string, err error) error {
	d := classify(err)
	return j.active(operation, func(a *slot) error {
		if a.Diagnostic != nil && a.Diagnostic.Kind == "retained" && d.Kind != "retained" {
			// A later wait or transient failure never replaces uncertainty.
			a.LatestDiagnostic = &d
			return nil
		}
		a.Diagnostic, a.LatestDiagnostic = &d, nil
		return nil
	})
}

func newSlot() *slot {
	id := uuid.NewString()
	return &slot{OperationID: id, RunnerName: "protected-" + id, Phase: "preparing"}
}
