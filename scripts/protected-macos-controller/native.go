package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/actions/scaleset"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

type hookContext struct {
	Nonce      string `json:"nonce"`
	Repository string `json:"repository"`
	RunID      int64  `json:"runId"`
	Attempt    int    `json:"attempt"`
	Event      string `json:"event"`
	Ref        string `json:"ref"`
	SHA        string `json:"sha"`
	PRNumber   int    `json:"prNumber,omitempty"`
	BaseSHA    string `json:"baseSha,omitempty"`
	HeadSHA    string `json:"headSha,omitempty"`
}

type nativeCapture struct {
	OperationID   string `json:"operationID"`
	Nonce         string `json:"nonce"`
	ContextHash   string `json:"contextHash"`
	RunnerName    string `json:"runnerName"`
	RunnerVersion string `json:"runnerVersion"`
	WorkerSHA256  string `json:"workerSHA256"`
	Github        struct {
		Repository  string `json:"repository"`
		SHA         string `json:"sha"`
		Ref         string `json:"ref"`
		Event       string `json:"eventName"`
		RunID       int64  `json:"runId"`
		Attempt     int    `json:"attempt"`
		JobRef      string `json:"jobRef"`
		WorkflowRef string `json:"workflowRef"`
	} `json:"github"`
	PullRequest *struct {
		Number  int    `json:"number"`
		BaseSHA string `json:"baseSha"`
		HeadSHA string `json:"headSha"`
		BaseRef string `json:"baseRef"`
		HeadRef string `json:"headRef"`
	} `json:"pullRequest,omitempty"`
	HookIdentity struct {
		PID               int   `json:"pid"`
		UID               int   `json:"uid"`
		SID               int   `json:"sid"`
		BirthSeconds      int64 `json:"birthSeconds"`
		BirthMicroseconds int64 `json:"birthMicroseconds"`
	} `json:"hookIdentity"`
}

func (capture nativeCapture) context(a slot) (hookContext, error) {
	// ponytail: reviewed2.338.0 hook/DAP semantics only; extend alongside the
	// native FD, diagnostics and tamper proofs before admitting an upgrade.
	if capture.RunnerVersion != "2.338.0" || !digestID.MatchString(capture.WorkerSHA256) {
		return hookContext{}, errors.New("unreviewed actual runner Worker identity")
	}
	if capture.OperationID != a.OperationID || capture.RunnerName != a.RunnerName || !digestID.MatchString(capture.ContextHash) || !digestID.MatchString(capture.Nonce) || capture.HookIdentity.PID <= 0 || capture.HookIdentity.UID != 502 || capture.HookIdentity.SID <= 0 || capture.HookIdentity.BirthSeconds <= 0 {
		return hookContext{}, errors.New("native protected hook identity mismatch")
	}
	h := hookContext{Nonce: capture.Nonce, Repository: capture.Github.Repository, RunID: capture.Github.RunID, Attempt: capture.Github.Attempt, Event: capture.Github.Event, Ref: capture.Github.Ref, SHA: capture.Github.SHA}
	if capture.PullRequest != nil {
		h.PRNumber = capture.PullRequest.Number
		h.BaseSHA = capture.PullRequest.BaseSHA
		h.HeadSHA = capture.PullRequest.HeadSHA
	}
	return h, nil
}

type nativeRequest struct {
	Version     int                    `json:"version"`
	ID          int                    `json:"id"`
	OperationID string                 `json:"operationID"`
	Action      string                 `json:"action"`
	RunnerName  string                 `json:"runnerName,omitempty"`
	RunnerID    int                    `json:"runnerID,omitempty"`
	ScaleSetID  int                    `json:"scaleSetId,omitempty"`
	Repository  string                 `json:"repository,omitempty"`
	JIT         string                 `json:"jitConfig,omitempty"`
	Binding     *sourceBinding         `json:"binding,omitempty"`
	Terminal    *terminalProof         `json:"terminal,omitempty"`
	Completion  *scaleset.JobCompleted `json:"completion,omitempty"`
}

type nativeEnvelope struct {
	Version     int         `json:"version"`
	ID          int         `json:"id"`
	OperationID string      `json:"operationID"`
	OK          bool        `json:"ok"`
	Result      nativeReply `json:"result"`
	Error       *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
	Retained bool `json:"retained,omitempty"`
}

type nativeReply struct {
	Phase          string `json:"phase"`
	Prepared       bool   `json:"prepared,omitempty"`
	Launched       bool   `json:"launched,omitempty"`
	Disposed       bool   `json:"disposed,omitempty"`
	TransportEnded bool   `json:"transportEnded,omitempty"`
	SourceVerified bool   `json:"sourceVerified,omitempty"`
	VetoVerified   bool   `json:"vetoVerified,omitempty"`
	// InterruptedUnassigned is native's durable known-idle EOF recovery fact.
	InterruptedUnassigned bool           `json:"interruptedUnassigned,omitempty"`
	Veto                  *guardVeto     `json:"veto,omitempty"`
	Pending               bool           `json:"pending,omitempty"`
	Capture               *nativeCapture `json:"capture,omitempty"`
}

type nativeSession struct {
	input    *os.File
	replies  chan []byte
	done     chan struct{}
	waitErr  error
	poisoned bool
	nextID   int
	pending  *nativeRequest
	sendDone chan error
	sent     bool
	closed   bool
}

// errNativeRetained is a native ok:false reply: the owner kept its resources.
var errNativeRetained = retained("native operation retained; inspect private native diagnostics")

var errNativeUnusable = retained("native exchange unusable; retain until actual owner exit")

// errFrameAborted is a request frame abandoned part-written so an accepted
// completion (or a start contradicting a no-job frame) is never blocked behind
// a native reader. Native acts only on
// newline-terminated frames, so the owner is poisoned: EOF, then retained
// until its actual exit.
var errFrameAborted = retained("native request frame aborted for an accepted SDK fact")

// frameSlice bounds how long a blocked frame write holds completion publication.
const frameSlice = 50 * time.Millisecond

func startNative(c config) (*nativeSession, error) {
	cmd := exec.Command(c.Node, c.Helper, "controller", "--state", c.NativeState)
	// No host credential, SSH agent, shell startup, desktop or Pi environment.
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C", "LC_ALL=C"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// An owned pollable pipe (not StdinPipe) supports write deadlines.
	reader, input, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	cmd.Stdin = reader
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard // Native owner writes bounded private diagnostics; never echo JIT.
	if err := cmd.Start(); err != nil {
		input.Close()
		return nil, err
	}
	n := &nativeSession{input: input, replies: make(chan []byte, 1), done: make(chan struct{})}
	go func() {
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			n.replies <- append([]byte(nil), scanner.Bytes()...)
		}
		n.waitErr = errors.Join(scanner.Err(), cmd.Wait())
		close(n.done)
	}()
	return n, nil
}

// outstanding reports the one exchange already written (or being written) to
// the native owner whose reply has not been consumed.
func (n *nativeSession) outstanding() *nativeRequest { return n.pending }

// send commits one request to the native pipe. The write runs asynchronously;
// admitted runs exactly once: after the write returned (whole frame, failure
// or abort), or before returning an error when nothing was written.
func (n *nativeSession) send(req nativeRequest, admitted func(), abort func() bool) error {
	bytes, err := n.frame(req)
	if err != nil {
		admitted()
		return err
	}
	go func() {
		err := n.write(bytes, abort)
		admitted()
		clear(bytes)
		n.sendDone <- err
	}()
	return nil
}

// write commits the frame in short slices. While native is not reading, each
// slice asks abort whether a completion is waiting to publish; if so the
// frame is abandoned unterminated instead of holding that completion.
func (n *nativeSession) write(frame []byte, abort func() bool) error {
	for {
		if err := n.input.SetWriteDeadline(time.Now().Add(frameSlice)); err != nil {
			return err
		}
		written, err := n.input.Write(frame)
		frame = frame[written:]
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			return err
		}
		if abort() {
			return errFrameAborted
		}
	}
}

func (n *nativeSession) frame(req nativeRequest) ([]byte, error) {
	if n.poisoned || n.closed {
		return nil, errNativeUnusable
	}
	if n.pending != nil {
		return nil, retained("native response still pending; retain request ordering")
	}
	req.Version = 1
	n.nextID++
	req.ID = n.nextID
	bytes, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if len(bytes) > 1<<20 {
		return nil, retained("native request exceeds private NDJSON limit")
	}
	n.pending = &nativeRequest{ID: req.ID, Action: req.Action, OperationID: req.OperationID}
	n.sent = false
	n.sendDone = make(chan error, 1)
	framed := make([]byte, len(bytes)+1)
	copy(framed, bytes)
	framed[len(bytes)] = '\n'
	clear(bytes) // A launch frame carries the JIT; keep one in-memory copy.
	return framed, nil
}

// await consumes the reply to the outstanding exchange. A deadline never
// cancels, signals, resends or frees native ownership: the same exchange is
// resumed by the next await and validated against its original ID.
func (n *nativeSession) await(ctx context.Context) (*nativeReply, error) {
	if n.poisoned {
		return nil, errNativeUnusable
	}
	if n.pending == nil {
		return nil, retained("no native exchange outstanding")
	}
	if !n.sent {
		select {
		case err := <-n.sendDone:
			if err != nil {
				n.poisoned = true
				return nil, err
			}
			n.sent = true
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var raw []byte
	select {
	case raw = <-n.replies:
	case <-n.done:
		// A reply written before exit is still the answer to this exchange.
		select {
		case raw = <-n.replies:
		default:
			n.poisoned = true
			return nil, errors.Join(retained("native owner exited before acknowledgment"), n.waitErr)
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	var envelope nativeEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		n.poisoned = true
		return nil, err
	}
	if envelope.Version != 1 || envelope.OperationID != n.pending.OperationID || envelope.ID != n.pending.ID {
		n.poisoned = true
		return nil, retained("native reply identity mismatch; retain")
	}
	n.pending = nil
	if !envelope.OK {
		return nil, errNativeRetained
	}
	return &envelope.Result, nil
}

// closeInput sends EOF exactly once; it never signals or frees the owner.
func (n *nativeSession) closeInput() error {
	if n.closed {
		return nil
	}
	n.closed = true
	return n.input.Close()
}

// finish sends EOF once, then waits for the actual owner to exit. A deadline
// leaves the same owner running; a later finish resumes the wait.
func (n *nativeSession) finish(ctx context.Context) error {
	if err := n.closeInput(); err != nil {
		return err
	}
	select {
	case <-n.done:
		return n.waitErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
