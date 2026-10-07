package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/go-github/v88/github"
	"github.com/google/uuid"
)

const (
	fixtureSHA  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fixtureTree = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// fixtureMessage is one server queue entry; it stays queued until ACKed.
type fixtureMessage struct {
	id      int
	jobs    []map[string]any
	waitFor string // native-published file required before the server offers it
	// ackRequires is a native-published file the server requires before it
	// accepts this message's ACK.
	ackRequires string
}

// sdkFixture is an independent TLS GitHub/Actions service: server-side
// acquisition, registration, queue and REST job association state.
type sdkFixture struct {
	server       *httptest.Server
	sdk          *scaleset.Client
	rest         *github.Client
	mu           sync.Mutex
	queue        []fixtureMessage
	acquireCalls [][]int64
	acquired     map[int64]bool
	started      map[int64]bool // requests the server started on some runner
	denyAcquire  bool
	loseAcquire  bool
	acks         int
	failACK      bool
	conflict     bool
	capacities   []string
	journalPath  string
	nativeRoot   string
	served       []int // message IDs the queue actually delivered
	foreign      int   // registrations of other runners counted in statistics
	status       map[string]int
	jitCalls     int
	loseJIT      bool
	nextRunner   int
	registered   map[string]int
	deleted      []int
	runnerBusy   bool
	busyRaw      string // "omit" or "null": the REST runner's busy field is absent or null
	sessions     int    // actual SDK session creations served
	refreshes    int    // actual SDK queue-token session refreshes served
	scaleSetGets int    // actual SDK scale-set reads by ID served
	scaleSetBad  bool   // the scale-set read omits the owned label
	jobRunner    [2]any // REST association published by the jobs listing
	// restGate holds the first request matching restGatePath ("METHOD /path")
	// after restGateSkip earlier matches (one-shot), signalling restReached.
	restGate     chan struct{}
	restReached  chan struct{}
	restGatePath string
	restGateSkip int
	// shortTokens issues App installation tokens already inside the library's
	// refresh window, so every request refreshes, until a gated refresh issues
	// a long-lived one. armTokenGate moves the gate to the next token refresh
	// once the owned runner's REST read has been served.
	shortTokens  bool
	armTokenGate bool
	lastStats    map[string]int // statistics the queue last served
	// badStats overrides the counts served by badSource ("session", "queue").
	badStats  map[string]int
	badSource string
	cancel    context.CancelFunc
	own       func(end func() error) // see testJournal
	// quit, closed once by release, frees every held fixture request.
	quit    chan struct{}
	release func() error
}

func newSDKFixture(t *testing.T) *sdkFixture {
	t.Helper()
	f := &sdkFixture{acquired: map[int64]bool{}, started: map[int64]bool{}, registered: map[string]int{}, status: map[string]int{}, nextRunner: 701, quit: make(chan struct{})}
	// release frees held requests and native holds so owners can return.
	f.release = sync.OnceValue(func() error {
		close(f.quit)
		return releaseHolds(f.nativeRoot)
	})
	f.server = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(f.server.Certificate())
	sdk, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{GitHubConfigURL: f.server.URL + "/fitchmultz/pi-subagents", PersonalAccessToken: "fixture-only"}, scaleset.WithRootCAs(pool), scaleset.WithTimeout(5*time.Second), scaleset.WithRetryMax(0))
	if err != nil {
		t.Fatal(err)
	}
	url := f.server.URL + "/"
	rest, err := github.NewClient(github.WithHTTPClient(f.server.Client()), github.WithURLs(&url, &url))
	if err != nil {
		t.Fatal(err)
	}
	f.sdk, f.rest = sdk, rest
	return f
}

// newFixtureController wires the fixture SDK/REST and the actual native child
// process (this test binary) around a private journal root.
func newFixtureController(t *testing.T, f *sdkFixture) *controller {
	t.Helper()
	j, own := testJournal(t)
	f.own = own
	f.nativeRoot = j.root
	f.journalPath = filepath.Join(j.root, "controller.json")
	if err := j.update(func(s *state) error { s.ScaleSetID = 7; return nil }); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	c := &controller{journal: j, api: apiClients{scale: f.sdk, github: f.rest}, config: config{Root: j.root, Node: executable, Helper: "-test.run=^$", NativeState: j.root}, wake: make(chan struct{}, 1), workerDone: make(chan struct{})}
	own(func() error { return endNative(j.root, c.native) })
	return c
}

func job(kind string, request int64, extra map[string]any) map[string]any {
	m := map[string]any{"messageType": kind, "runnerRequestId": request, "ownerName": "fitchmultz", "repositoryName": "pi-subagents", "jobId": fmt.Sprintf("opaque-%d", request), "workflowRunId": 55, "jobWorkflowRef": "fitchmultz/pi-subagents/.github/workflows/ci.yml@refs/heads/main", "eventName": "push", "requestLabels": requiredLabels}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// push enqueues a message for server events that already happened: a pushed
// JobStarted's job is running from then on.
func (f *sdkFixture) push(id int, jobs ...map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range jobs {
		if m["messageType"] == "JobStarted" {
			f.started[m["runnerRequestId"].(int64)] = true
		}
	}
	f.queue = append(f.queue, fixtureMessage{id: id, jobs: jobs})
}

// deliver runs the actual SDK listener over TLS until the server queue is
// drained by real ACKs (or found empty), returning the listener's exit error.
func (f *sdkFixture) deliver(t *testing.T, c *controller) error {
	t.Helper()
	session, err := f.sdk.MessageSessionClient(context.Background(), 7, c.journal.snapshot().Owner)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close(context.Background())
	l, err := listener.New(deadlineClient{session}, listener.Config{ScaleSetID: 7, MaxRunners: 1})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	f.mu.Lock()
	f.cancel = cancel
	f.mu.Unlock()
	c.session = session
	c.listenerMu.Lock()
	c.listener = l
	c.listenerMu.Unlock()
	return l.Run(ctx, c)
}

func (f *sdkFixture) serveQueue(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	waitFor := ""
	if len(f.queue) > 0 {
		waitFor = f.queue[0].waitFor
	}
	// Without a deliver run, the production owner long-polls: an empty queue
	// briefly holds the poll before its nil timeout, like the server.
	idle := len(f.queue) == 0 && f.cancel == nil
	f.mu.Unlock()
	if idle {
		time.Sleep(20 * time.Millisecond)
	}
	for deadline := time.Now().Add(5 * time.Second); waitFor != ""; time.Sleep(time.Millisecond) {
		if _, err := os.Stat(filepath.Join(f.nativeRoot, waitFor)); err == nil {
			break
		}
		if time.Now().After(deadline) {
			w.WriteHeader(400)
			return
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.capacities = append(f.capacities, r.Header.Get(scaleset.HeaderScaleSetMaxCapacity))
	if len(f.queue) == 0 {
		// Long-poll timeout with nothing to deliver: the run is over.
		w.WriteHeader(202)
		if f.cancel != nil {
			f.cancel()
		}
		return
	}
	msg := f.queue[0]
	f.served = append(f.served, msg.id)
	body, _ := json.Marshal(msg.jobs)
	stats := f.statistics("queue", len(msg.jobs))
	f.lastStats = stats
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"messageId": msg.id, "messageType": "RunnerScaleSetJobMessages", "body": string(body), "statistics": stats})
}

// statistics are the server's current counts as source serves them.
func (f *sdkFixture) statistics(source string, available int) map[string]int {
	stats := map[string]int{"totalAvailableJobs": available, "totalAssignedJobs": f.assigned(), "totalRunningJobs": f.running(), "totalRegisteredRunners": len(f.registered) + f.foreign}
	if source == f.badSource {
		maps.Copy(stats, f.badStats)
	}
	return stats
}

// running is the server's count of assigned jobs that started on a runner.
func (f *sdkFixture) running() int {
	count := 0
	for id, started := range f.started {
		if started && f.acquired[id] {
			count++
		}
	}
	return count
}

// assigned is the server's count of acquired jobs not yet completed, waiting
// or running.
func (f *sdkFixture) assigned() int {
	count := 0
	for _, acquired := range f.acquired {
		if acquired {
			count++
		}
	}
	return count
}

// durableBeforeACK is the wire-side ACK precondition: every offered request is
// durably journaled, the server itself observed its explicit rejection, or the
// fixture offered it as invalid demand.
func (f *sdkFixture) durableBeforeACK(msg fixtureMessage) bool {
	var s state
	raw, err := os.ReadFile(f.journalPath)
	if err != nil || json.Unmarshal(raw, &s) != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(f.nativeRoot, msg.ackRequires)); msg.ackRequires != "" && err != nil {
		return false
	}
	for _, m := range msg.jobs {
		if m["messageType"] != "JobAvailable" || m["fixtureInvalid"] == true {
			continue
		}
		id := m["runnerRequestId"].(int64)
		rejected := !f.acquired[id] && slices.ContainsFunc(f.acquireCalls, func(ids []int64) bool { return slices.Contains(ids, id) })
		if !rejected && !slices.ContainsFunc(s.Acquisitions, func(a acquisition) bool { return a.Job.RunnerRequestID == id }) {
			return false
		}
	}
	return true
}

func (f *sdkFixture) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	status := f.status[r.URL.Path]
	f.mu.Unlock()
	if status != 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, `{"message":"fixture status"}`)
		return
	}
	if r.URL.Path == "/queue" && r.Method == "GET" {
		f.serveQueue(w, r)
		return
	}
	f.mu.Lock()
	gate, reached := f.restGate, f.restReached
	switch {
	case gate == nil || r.Method+" "+r.URL.Path != f.restGatePath:
		gate = nil
	case f.restGateSkip > 0:
		f.restGateSkip--
		gate = nil
	default:
		f.restGate = nil
	}
	f.mu.Unlock()
	held := gate != nil
	if held {
		select {
		case reached <- struct{}{}:
		case <-f.quit:
		}
		select {
		case <-gate:
		case <-f.quit:
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	const runners = "/repos/fitchmultz/pi-subagents/actions/runners/"
	labels := []map[string]string{{"name": "self-hosted"}, {"name": "macOS"}, {"name": "ARM64"}, {"name": scaleSetName}}
	switch {
	case r.URL.Path == "/api/v3/repos/fitchmultz/pi-subagents/actions/runners/registration-token":
		w.WriteHeader(201)
		fmt.Fprint(w, `{"token":"fixture-registration"}`)
	case r.URL.Path == "/api/v3/actions/runner-registration":
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))})
		signed, _ := token.SignedString([]byte("fixture"))
		_ = json.NewEncoder(w).Encode(map[string]string{"url": f.server.URL, "token": signed})
	case r.URL.Path == "/_apis/runtime/runnerscalesets/7/sessions" && r.Method == "POST":
		if f.conflict {
			f.conflict = false
			w.WriteHeader(409)
			fmt.Fprint(w, `{"typeName":"SessionConflictException","message":"fixture-owned old session"}`)
			return
		}
		var input scaleset.RunnerScaleSetSession
		_ = json.NewDecoder(r.Body).Decode(&input)
		f.sessions++
		_ = json.NewEncoder(w).Encode(map[string]any{"sessionId": uuid.New(), "ownerName": input.OwnerName, "messageQueueUrl": f.server.URL + "/queue", "messageQueueAccessToken": "fixture-queue", "statistics": f.statistics("session", 0)})
	case strings.HasPrefix(r.URL.Path, "/_apis/runtime/runnerscalesets/7/sessions/") && r.Method == "PATCH":
		f.refreshes++
		_ = json.NewEncoder(w).Encode(scaleset.RunnerScaleSetSession{SessionID: uuid.MustParse(strings.TrimPrefix(r.URL.Path, "/_apis/runtime/runnerscalesets/7/sessions/")), MessageQueueURL: f.server.URL + "/queue", MessageQueueAccessToken: "fixture-queue-refreshed"})
	case r.URL.Path == "/_apis/runtime/runnergroups/":
		fmt.Fprint(w, `{"count":1,"value":[{"id":1,"name":"Default","isDefaultGroup":true}]}`)
	case r.URL.Path == "/_apis/runtime/runnerscalesets" && r.Method == "GET":
		_ = json.NewEncoder(w).Encode(map[string]any{"count": 1, "value": []map[string]any{{"id": 7, "name": scaleSetName, "runnerGroupId": 1, "labels": labels}}})
	case r.URL.Path == "/_apis/runtime/runnerscalesets/7" && r.Method == "GET":
		f.scaleSetGets++
		read := map[string]any{"id": 7, "name": scaleSetName, "runnerGroupId": 1, "labels": labels, "statistics": f.statistics("scale-set", 0)}
		if f.scaleSetBad {
			read["labels"] = labels[:3]
		}
		_ = json.NewEncoder(w).Encode(read)
	case r.URL.Path == "/_apis/distributedtask/pools/0/agents":
		name := r.URL.Query().Get("agentName")
		if id, ok := f.registered[name]; ok {
			fmt.Fprintf(w, `{"count":1,"value":[{"id":%d,"name":%q,"runnerScaleSetId":7}]}`, id, name)
			return
		}
		fmt.Fprint(w, `{"count":0,"value":[]}`)
	case r.URL.Path == "/_apis/runtime/runnerscalesets/7/generatejitconfig":
		if _, err := os.Stat(filepath.Join(f.nativeRoot, "prepare-published")); err != nil {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"message":"JIT before actual native prepare acknowledgment"}`)
			return
		}
		f.jitCalls++
		var settings scaleset.RunnerScaleSetJitRunnerSetting
		_ = json.NewDecoder(r.Body).Decode(&settings)
		id := f.nextRunner
		f.nextRunner++
		f.registered[settings.Name] = id
		if f.loseJIT {
			// Server-side registration succeeded; the response is lost.
			f.loseJIT = false
			w.WriteHeader(500)
			return
		}
		_ = json.NewEncoder(w).Encode(scaleset.RunnerScaleSetJitRunnerConfig{Runner: &scaleset.RunnerReference{ID: id, Name: settings.Name, RunnerScaleSetID: 7}, EncodedJITConfig: "Zml4dHVyZS1vbmx5"})
	case r.URL.Path == "/app/installations/9/access_tokens" && r.Method == "POST":
		expires := time.Now() // Inside the one-minute refresh window: already due.
		if held || !f.shortTokens {
			f.shortTokens, expires = false, time.Now().Add(time.Hour)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "fixture-installation-token", "expires_at": expires})
	case r.URL.Path == "/repos/fitchmultz/pi-subagents":
		fmt.Fprint(w, `{"full_name":"fitchmultz/pi-subagents"}`)
	case strings.HasPrefix(r.URL.Path, runners):
		id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, runners))
		name := ""
		for n, registered := range f.registered {
			if registered == id {
				name = n
			}
		}
		if f.armTokenGate && r.Method == "GET" {
			f.armTokenGate, f.restGatePath = false, "POST /app/installations/9/access_tokens"
		}
		if name == "" {
			w.WriteHeader(404)
			fmt.Fprint(w, `{"message":"Not Found"}`)
			return
		}
		if r.Method == "DELETE" {
			// Removal only before any listener launch, or after native proved the
			// launched listener's transport ended.
			_, launched := os.Stat(filepath.Join(f.nativeRoot, "launch-count"))
			_, drained := os.Stat(filepath.Join(f.nativeRoot, "drain-published"))
			_, ended := os.Stat(filepath.Join(f.nativeRoot, "transport-ended"))
			if f.runnerBusy || (launched == nil && drained != nil && ended != nil) {
				w.WriteHeader(422)
				fmt.Fprint(w, `{"message":"DELETE before native transport end or while busy"}`)
				return
			}
			delete(f.registered, name)
			f.deleted = append(f.deleted, id)
			w.WriteHeader(204)
			return
		}
		runner := map[string]any{"id": id, "name": name, "status": "offline", "busy": f.runnerBusy, "labels": labels}
		switch f.busyRaw {
		case "omit":
			delete(runner, "busy")
		case "null":
			runner["busy"] = nil
		}
		_ = json.NewEncoder(w).Encode(runner)
	case r.URL.Path == "/repos/fitchmultz/pi-subagents/actions/runs/55/attempts/1":
		fmt.Fprintf(w, `{"id":55,"run_attempt":1,"event":"push","head_sha":%q,"head_branch":"main","repository":{"full_name":"fitchmultz/pi-subagents"}}`, fixtureSHA)
	case r.URL.Path == "/repos/fitchmultz/pi-subagents/actions/runs/55/attempts/1/jobs":
		for name, id := range f.registered {
			f.jobRunner = [2]any{id, name}
		}
		fmt.Fprintf(w, `{"total_count":1,"jobs":[{"id":8001,"run_id":55,"run_attempt":1,"name":"Mac","runner_id":%d,"runner_name":%q,"head_sha":%q}]}`, f.jobRunner[0], f.jobRunner[1], fixtureSHA)
	case r.URL.Path == "/repos/fitchmultz/pi-subagents/actions/jobs/8001":
		fmt.Fprintf(w, `{"id":8001,"run_id":55,"run_attempt":1,"runner_id":%d,"runner_name":%q,"head_sha":%q,"status":"completed","conclusion":"success"}`, f.jobRunner[0], f.jobRunner[1], fixtureSHA)
	case r.URL.Path == "/repos/fitchmultz/pi-subagents/git/commits/"+fixtureSHA:
		fmt.Fprintf(w, `{"sha":%q,"tree":{"sha":%q},"parents":[]}`, fixtureSHA, fixtureTree)
	case r.URL.Path == "/repos/fitchmultz/pi-subagents/git/trees/"+fixtureTree:
		fmt.Fprintf(w, `{"sha":%q,"truncated":false,"tree":[{"path":"package.json","type":"blob","mode":"100644","sha":%q}]}`, fixtureTree, strings.Repeat("c", 40))
	case r.URL.Path == "/_apis/runtime/runnerscalesets/7/acquirejobs":
		var ids []int64
		_ = json.NewDecoder(r.Body).Decode(&ids)
		f.acquireCalls = append(f.acquireCalls, ids)
		if f.loseAcquire {
			// Server acquired; the response is lost. A replay returns no new IDs.
			f.loseAcquire = false
			for _, id := range ids {
				f.acquired[id] = true
			}
			w.WriteHeader(500)
			return
		}
		var got []int64
		for _, id := range ids {
			if !f.denyAcquire && !f.acquired[id] {
				f.acquired[id] = true
				got = append(got, id)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"count": len(got), "value": got})
	case strings.HasPrefix(r.URL.Path, "/queue/") && r.Method == "DELETE":
		// Independent wire-side observation: ACK must follow real durable intent,
		// not a fake callback/store that supplies the asserted ordering.
		if len(f.queue) == 0 || r.URL.Path != fmt.Sprintf("/queue/%d", f.queue[0].id) || !f.durableBeforeACK(f.queue[0]) {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"message":"missing durable ownership before ACK"}`)
			return
		}
		f.acks++
		if f.failACK {
			f.failACK = false
			w.WriteHeader(500)
			fmt.Fprint(w, `{"message":"controlled lost ACK"}`)
			return
		}
		for _, m := range f.queue[0].jobs {
			switch m["messageType"] {
			case "JobAssigned":
				f.acquired[m["runnerRequestId"].(int64)] = true
			case "JobCompleted":
				delete(f.acquired, m["runnerRequestId"].(int64))
				delete(f.started, m["runnerRequestId"].(int64))
			}
		}
		f.queue = f.queue[1:]
		w.WriteHeader(204)
		if len(f.queue) == 0 && f.cancel != nil {
			f.cancel()
		}
	case r.Method == "DELETE":
		w.WriteHeader(204)
	default:
		w.WriteHeader(404)
		fmt.Fprint(w, `{"message":"unexpected fixture route"}`)
	}
}

// testJournal opens a journal in a private root. own registers an end that
// must prove the actual exit of an owner using the root. Ends run in reverse
// registration order, so an owner registered after what it uses (background
// owner, then its native session, then the journal guard) ends first. The
// first unproved end stops teardown: everything it may still use, including
// the root, is retained for diagnosis.
func testJournal(t *testing.T) (*journal, func(end func() error)) {
	t.Helper()
	root, err := os.MkdirTemp("", "pmc-test-") // Private (0700).
	if err != nil {
		t.Fatal(err)
	}
	var ends []func() error
	t.Cleanup(func() {
		for _, end := range slices.Backward(ends) {
			if err := end(); err != nil {
				t.Errorf("%v; retained %s", err, root)
				return
			}
		}
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	j, err := openJournal(root)
	if err != nil {
		t.Fatal(err)
	}
	ends = append(ends, func() error { _ = j.guard.Close(); return nil }) // Possibly closed already.
	return j, func(end func() error) { ends = append(ends, end) }
}

// owned is a background owner's result, readable any number of times once
// done is closed.
type owned struct {
	done chan struct{}
	err  error
}

func (o *owned) wait() error {
	<-o.done
	return o.err
}

// goOwned runs owner in the background with its join registered first: at
// cleanup, before its native session, guard and root, stop asks it to return,
// fixture holds are released, and its actual return is required in a bound.
func (f *sdkFixture) goOwned(stop func(), owner func() error) *owned {
	o := &owned{done: make(chan struct{})}
	f.own(func() error {
		if stop != nil {
			stop()
		}
		if err := f.release(); err != nil {
			return err
		}
		select {
		case <-o.done:
			return nil
		case <-time.After(20 * time.Second):
			return errors.New("background owner still running")
		}
	})
	go func() {
		defer close(o.done)
		o.err = owner()
	}()
	return o
}

// releaseHolds lets blocked fixture native owners proceed and exit.
func releaseHolds(root string) error {
	for _, name := range []string{"release", "release-exit"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("release"), 0600); err != nil {
			return fmt.Errorf("native owner not released: %w", err)
		}
	}
	return nil
}

// endNative releases every fixture hold, sends EOF and joins the native
// owner's actual exit (whatever its status).
func endNative(root string, n *nativeSession) error {
	if n == nil {
		return nil
	}
	if err := releaseHolds(root); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := n.finish(ctx); err != nil {
		select {
		case <-n.done:
		default:
			return fmt.Errorf("native owner still alive: %w", err)
		}
	}
	return nil
}

// nativeActions reads the actual native child's received-request log.
// view reads or sets fixture server state under its lock.
func (f *sdkFixture) view(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

func nativeActions(t *testing.T, root string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, "actions"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return strings.Fields(string(raw))
}

// advanceUntil steps the current operation until phase, or until it is
// released when phase is "".
func advanceUntil(t *testing.T, c *controller, phase string) {
	t.Helper()
	start := c.journal.snapshot().Active.OperationID
	for range 10 {
		a := c.journal.snapshot().Active
		if a == nil || a.OperationID != start || a.Phase == phase {
			return
		}
		if err := c.advance(*a); err != nil {
			t.Fatalf("advance from %s: %v", a.Phase, err)
		}
	}
	t.Fatalf("phase %s not reached", phase)
}

func TestActualSDKDurableACKReplayAndAcquisitionOutcomes(t *testing.T) {
	for _, mode := range []string{"acquired-lost-ack", "denied", "lost-acquire-response", "settled-then-redelivered"} {
		t.Run(mode, func(t *testing.T) {
			f := newSDKFixture(t)
			c := newFixtureController(t, f)
			f.view(func() {
				f.denyAcquire = mode == "denied"
				f.failACK = mode == "acquired-lost-ack"
				f.loseAcquire = mode == "lost-acquire-response"
			})
			f.push(1, job("JobAvailable", 101, nil))
			err := f.deliver(t, c)
			s := c.journal.snapshot()
			switch mode {
			case "denied":
				f.view(func() {
					if !errors.Is(err, context.Canceled) || s.Active != nil || len(s.Acquisitions) != 0 || f.acks != 1 {
						t.Fatalf("explicit first-attempt rejection must ACK without a slot: %v %+v", err, s)
					}
				})
			case "lost-acquire-response":
				if errors.Is(err, context.Canceled) || s.Active != nil || len(s.Acquisitions) != 1 {
					t.Fatalf("lost acquire response must keep the same intent unacknowledged and unadmitted: %v %+v", err, s)
				}
				// Replays omit the already acquired ID: ambiguous, never a rejection. The
				// fresh session reports the server's assignment, so it is not retired.
				f.push(2, job("JobAssigned", 101, nil))
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				s = c.journal.snapshot()
				f.view(func() {
					for _, ids := range f.acquireCalls {
						if !slices.Equal(ids, []int64{101}) {
							t.Fatalf("replay changed acquisition identity: %v", f.acquireCalls)
						}
					}
					i := findAcquisition(&s, 101)
					if len(f.acquireCalls) < 2 || f.acks != 2 || s.Active == nil || i < 0 || !s.Acquisitions[i].Acquired {
						t.Fatalf("JobAssigned did not resolve ambiguous acquisition: calls=%v %+v", f.acquireCalls, s)
					}
				})
			case "settled-then-redelivered":
				// The unacknowledged lifecycle body is redelivered only after its job
				// settled, with the then-current statistics.
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				writeCaptureTemplate(t, c.journal.root)
				advanceUntil(t, c, "launched")
				a := c.journal.snapshot().Active
				f.view(func() { f.failACK = true })
				f.push(2, job("JobAssigned", 101, nil), job("JobStarted", 101, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName}))
				if err := f.deliver(t, c); errors.Is(err, context.Canceled) || c.journal.snapshot().Active.Assignment == nil {
					t.Fatalf("lifecycle not durable before the lost ACK: %v", err)
				}
				var first map[string]int
				f.view(func() { first = f.lastStats })
				advanceUntil(t, c, "bound")
				if err := os.WriteFile(filepath.Join(c.journal.root, "listener-exited"), []byte("official listener exited"), 0600); err != nil {
					t.Fatal(err)
				}
				advanceUntil(t, c, "")
				f.view(func() { delete(f.acquired, 101) }) // The server's job ended.
				if s := c.journal.snapshot(); s.Active != nil || !slices.Equal(s.CompletedRequests, []int64{101}) {
					t.Fatalf("job not settled before redelivery: %+v", s)
				}
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatalf("redelivered body with current statistics refused: %v", err)
				}
				s = c.journal.snapshot()
				f.view(func() {
					current := f.lastStats
					if len(f.queue) != 0 || f.served[len(f.served)-1] != 2 || current["totalRegisteredRunners"] == first["totalRegisteredRunners"] {
						t.Fatalf("redelivery not ACKed with changed statistics: served=%v first=%v current=%v", f.served, first, current)
					}
					if s.Statistics.TotalRegisteredRunners != current["totalRegisteredRunners"] || s.Statistics.TotalAssignedJobs != current["totalAssignedJobs"] {
						t.Fatalf("current statistics not applied to the redelivered body: %+v %v", s.Statistics, current)
					}
					if s.Active != nil || !slices.Equal(s.CompletedRequests, []int64{101}) || len(s.Acquisitions) != 0 || f.jitCalls != 1 || !slices.Equal(f.deleted, []int{701}) {
						t.Fatalf("redelivered body reopened, reminted or redeleted settled work: %+v jit=%d deleted=%v", s, f.jitCalls, f.deleted)
					}
				})
			case "acquired-lost-ack":
				f.view(func() {
					if errors.Is(err, context.Canceled) || s.Active == nil || s.Active.Phase != "preparing" || len(f.acquireCalls) != 1 || f.acks != 1 {
						t.Fatalf("missing durable acquired lifecycle before lost ACK: %v %+v acquire=%v ACK=%d", err, s.Active, f.acquireCalls, f.acks)
					}
				})
				// Genuine filesystem restart: release singleton and reload journal rather
				// than handing the next owner the old mutable in-memory state.
				_ = c.journal.guard.Close()
				restarted, err := openJournal(c.journal.root)
				if err != nil {
					t.Fatal(err)
				}
				defer restarted.guard.Close()
				c.journal = restarted
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				f.view(func() {
					if len(f.acquireCalls) != 1 || f.acks != 2 || restarted.snapshot().Active.OperationID != s.Active.OperationID {
						t.Fatalf("replay minted acquisition or replaced identity: acquire=%v ACK=%d", f.acquireCalls, f.acks)
					}
				})
			}
		})
	}
}

// Keeper: a negative count from an SDK statistics source (the session's
// initial message or a queue message) is refused before any effect: no ACK,
// acquisition, admission, native owner or journal change. The same delivery is
// accepted once its counts are valid.
func TestActualSDKNegativeStatisticsRefusedWithoutEffect(t *testing.T) {
	for _, source := range []string{"session", "queue"} {
		for _, count := range []string{"totalAvailableJobs", "totalAcquiredJobs", "totalAssignedJobs", "totalRunningJobs", "totalRegisteredRunners"} {
			t.Run(source+"/"+count, func(t *testing.T) {
				f := newSDKFixture(t)
				c := newFixtureController(t, f)
				f.view(func() { f.badSource, f.badStats = source, map[string]int{count: -1} })
				f.push(1, job("JobAvailable", 101, nil))
				if err := f.deliver(t, c); err == nil || errors.Is(err, context.Canceled) {
					t.Fatalf("negative %s accepted: %v", count, err)
				}
				s := c.journal.snapshot()
				f.view(func() {
					// The fixture's valid counts are all zero before any acquisition.
					if f.acks != 0 || len(f.acquireCalls) != 0 || c.native != nil || s.Active != nil || len(s.Acquisitions) != 0 || len(s.Messages) != 0 || s.Statistics != (scaleset.RunnerScaleSetStatistic{}) {
						t.Fatalf("negative %s had an effect: ACK=%d acquire=%v %+v", count, f.acks, f.acquireCalls, s)
					}
					f.badSource = ""
				})
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				s = c.journal.snapshot()
				f.view(func() {
					if f.acks != 1 || !slices.Equal(f.served, map[string][]int{"session": {1}, "queue": {1, 1}}[source]) || len(f.acquireCalls) != 1 || s.Active == nil || findAcquisition(&s, 101) < 0 {
						t.Fatalf("valid delivery not accepted after refusal: ACK=%d served=%v acquire=%v %+v", f.acks, f.served, f.acquireCalls, s)
					}
				})
			})
		}
	}
}

func TestActualSDKConflictRecoveryUsesServerSuccess(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	f.conflict = true
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	session, err := c.createSession(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close(context.Background())
	if session.Session().OwnerName != c.journal.snapshot().Owner || session.Session().SessionID == uuid.Nil {
		t.Fatal("no actual server session publication")
	}
	if s := c.journal.snapshot(); s.ListenerUp || s.Listener == nil || *s.Listener != (diagnostic{Code: "session conflict cooldown", Kind: "waiting"}) {
		t.Fatalf("typed 409 cooldown not journaled as a listener wait: %+v", s.Listener)
	}
}

// Keeper: batched and occupied demand all survive; a failed pre-JIT launch
// keeps its acquired request for a second slot; two serial jobs are served.
func TestActualSDKBatchedOccupiedDemandServesSerialSlots(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	writeCaptureTemplate(t, c.journal.root)
	f.push(1, job("JobAvailable", 101, nil), job("JobAvailable", 102, nil))
	f.push(2, job("JobAvailable", 103, nil))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s := c.journal.snapshot()
	if len(s.Acquisitions) != 3 || s.Active == nil || s.Active.AcquireIntent.RunnerRequestID != 101 {
		t.Fatalf("batched/occupied demand dropped: %+v", s)
	}
	f.view(func() {
		if !slices.Equal(f.capacities, []string{"1", "0"}) {
			t.Fatalf("occupied slot advertised capacity: %v", f.capacities)
		}
	})
	first := s.Active.OperationID

	if err := os.WriteFile(filepath.Join(c.journal.root, "fail-launch"), []byte("native launch fails after saving runner ID"), 0600); err != nil {
		t.Fatal(err)
	}
	advanceUntil(t, c, "prepared")
	if err := c.advance(*c.journal.snapshot().Active); err == nil {
		t.Fatal("failed native launch reported success")
	}
	f.view(func() {
		if saved := c.journal.snapshot().Active; saved.RunnerID != 701 || saved.Phase != "jit-lost" || len(f.deleted) != 0 {
			t.Fatalf("failed launch lost SDK identity or touched registration: %+v", saved)
		}
	})
	if err := os.Remove(filepath.Join(c.journal.root, "fail-launch")); err != nil {
		t.Fatal(err)
	}
	advanceUntil(t, c, "")
	s = c.journal.snapshot()
	f.view(func() {
		if !slices.Equal(f.deleted, []int{701}) || s.LastDisposition != "unlaunched-recovery" || len(s.CompletedRequests) != 0 {
			t.Fatalf("pre-JIT recovery without exact absence, or request completed: %+v", s)
		}
	})
	// Statistics observed before the release may predate a cancellation: the
	// next slot waits for current ones (here a new session's initial statistics).
	if s.Active != nil || s.Admission != "awaiting-current-statistics" {
		t.Fatalf("release admitted from statistics older than the release: %+v", s)
	}
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s = c.journal.snapshot()
	if s.Active == nil || s.Active.OperationID == first || s.Active.AcquireIntent.RunnerRequestID != 101 {
		t.Fatalf("acquired request 101 not re-admitted to a second slot: %+v", s.Active)
	}

	advanceUntil(t, c, "launched")
	slot2 := c.journal.snapshot().Active
	f.view(func() {
		if slot2.RunnerID != 702 || f.jitCalls != 2 {
			t.Fatalf("second slot not launched on its own registration: %+v", slot2)
		}
	})
	entries, err := os.ReadDir(c.journal.root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if raw, err := os.ReadFile(filepath.Join(c.journal.root, entry.Name())); err == nil && strings.Contains(string(raw), "Zml4dHVyZS1vbmx5") {
			t.Fatalf("JIT persisted to host file %s", entry.Name())
		}
	}
	// The SDK documents canceled and requeued attempts of one workflow job: the
	// idle slot's request is canceled, then reassigned and started on this exact
	// runner. Runner identity, not request history, decides.
	f.push(3, job("JobAssigned", 101, nil), job("JobCompleted", 101, map[string]any{"runnerId": 0, "runnerName": "", "result": "canceled"}))
	f.push(4, job("JobAssigned", 101, nil), job("JobStarted", 101, map[string]any{"runnerId": 702, "runnerName": slot2.RunnerName}))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if a := c.journal.snapshot().Active; a.Assignment == nil || a.Assignment.RunnerRequestID != 101 || a.IntentCanceled != nil || a.Completion != nil {
		t.Fatalf("exact-runner start of a reassigned request suppressed by history: %+v", a)
	}
	advanceUntil(t, c, "bound")
	f.push(5, job("JobCompleted", 101, map[string]any{"runnerId": 702, "runnerName": slot2.RunnerName, "result": "succeeded"}))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	advanceUntil(t, c, "")
	s = c.journal.snapshot()
	f.view(func() {
		if s.LastDisposition != "source-consistent-settlement" || !slices.Equal(s.CompletedRequests, []int64{101}) || !slices.Equal(f.deleted, []int{701, 702}) {
			t.Fatalf("first job not settled exactly: %+v deleted=%v", s, f.deleted)
		}
		if !slices.Equal(f.capacities, []string{"1", "0", "0", "0", "0", "0"}) {
			t.Fatalf("occupied slot advertised capacity: %v", f.capacities)
		}
	})
	// Own runner 702 is actually absent, but the cached count observed it, and
	// a fresh session counts one foreign registration: no slot, JIT or native
	// preparation until authoritative statistics show none.
	if s.Active != nil || s.Admission != "blocked-registered-runner" || len(s.Acquisitions) != 2 {
		t.Fatalf("aggregate count waived for a released own runner: %+v", s)
	}
	f.view(func() { f.foreign = 1 })
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f.view(func() {
		if s := c.journal.snapshot(); s.Active != nil || s.Admission != "blocked-registered-runner" || f.jitCalls != 2 || len(f.acquireCalls) != 2 {
			t.Fatalf("foreign registration waived: %+v jit=%d acquire=%v", s, f.jitCalls, f.acquireCalls)
		}
		f.foreign = 0
	})
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s = c.journal.snapshot()
	if s.Active == nil || s.Active.AcquireIntent.RunnerRequestID != 102 || len(s.Acquisitions) != 2 {
		t.Fatalf("next acquired job not served by a serial slot: %+v", s)
	}
}

// Keeper: a JIT whose server registration succeeded but whose response was
// lost, followed by the request's canceled completion, is reconciled by exact
// name lookup, deleted and settled without a second JIT.
func TestActualSDKLostJITResponseWithCanceledCompletionNeverMintsAgain(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	f.push(1, job("JobAvailable", 101, nil))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	advanceUntil(t, c, "prepared")
	f.view(func() { f.loseJIT = true })
	if err := c.advance(*c.journal.snapshot().Active); err == nil {
		t.Fatal("lost JIT response reported success")
	}
	f.view(func() {
		if a := c.journal.snapshot().Active; a.Phase != "jit-intent" || a.RunnerID != 0 || len(f.registered) != 1 {
			t.Fatalf("lost JIT state: %+v", a)
		}
	})
	f.push(2, job("JobCompleted", 101, map[string]any{"runnerId": 0, "runnerName": "", "result": "canceled"}))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	advanceUntil(t, c, "")
	s := c.journal.snapshot()
	f.view(func() {
		if s.Active != nil || f.jitCalls != 1 || len(f.registered) != 0 || !slices.Equal(f.deleted, []int{701}) || !slices.Equal(s.CompletedRequests, []int64{101}) {
			t.Fatalf("lost JIT orphaned, re-minted or never settled: jit=%d registered=%v %+v", f.jitCalls, f.registered, s)
		}
	})
}

func writeCaptureTemplate(t *testing.T, root string) {
	t.Helper()
	var capture nativeCapture
	capture.Nonce = strings.Repeat("d", 64)
	capture.ContextHash = strings.Repeat("e", 64)
	capture.RunnerVersion = "2.338.0"
	capture.WorkerSHA256 = strings.Repeat("f", 64)
	capture.Github.Repository = repository
	capture.Github.SHA = fixtureSHA
	capture.Github.Ref = "refs/heads/main"
	capture.Github.Event = "push"
	capture.Github.RunID = 55
	capture.Github.Attempt = 1
	capture.HookIdentity.PID = 10
	capture.HookIdentity.UID = 502
	capture.HookIdentity.SID = 10
	capture.HookIdentity.BirthSeconds = 1
	raw, err := json.Marshal(capture)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "capture.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

// startedSlot drives an acquired request to a launched slot with JobStarted.
func startedSlot(t *testing.T, f *sdkFixture, c *controller) slot {
	t.Helper()
	writeCaptureTemplate(t, c.journal.root)
	f.push(1, job("JobAvailable", 101, nil))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	advanceUntil(t, c, "launched")
	a := c.journal.snapshot().Active
	f.push(2, job("JobStarted", 101, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName}))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	return *c.journal.snapshot().Active
}

func TestCompletionDuringSourceResolutionPreventsFreezeAndBind(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	stale := startedSlot(t, f, c)
	gate, reached := make(chan struct{}), make(chan struct{})
	f.view(func() {
		f.restGate, f.restReached, f.restGatePath = gate, reached, "GET /repos/fitchmultz/pi-subagents/actions/runs/55/attempts/1/jobs"
	})
	result := f.goOwned(nil, func() error { return c.advance(stale) })
	<-reached // The lifecycle is inside authenticated REST source resolution.
	f.push(3, job("JobCompleted", 101, map[string]any{"runnerId": stale.RunnerID, "runnerName": stale.RunnerName, "result": "canceled"}))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	close(gate)
	err := result.wait()
	if d := classify(err); d.Kind != "retained" || d.Code != "completion accepted before source freeze" {
		t.Fatalf("stale source publication not rejected: %v", err)
	}
	a := c.journal.snapshot().Active
	bound := slices.ContainsFunc(nativeActions(t, c.journal.root), func(action string) bool { return strings.HasPrefix(action, "bind") })
	if a.Source != nil || a.Completion == nil || bound {
		t.Fatalf("source frozen or bound after accepted completion: %+v %v", a, nativeActions(t, c.journal.root))
	}
}

func TestBindCarriesCompletionAcceptedAfterStaleSnapshot(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	started := startedSlot(t, f, c)
	// A source frozen but not yet acknowledged (crash between publish and bind).
	if err := c.journal.active(started.OperationID, func(a *slot) error {
		a.Source = &sourceBinding{Repository: repository, RequestID: 101, RunnerID: a.RunnerID, RunnerName: a.RunnerName}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stale := *c.journal.snapshot().Active
	f.push(3, job("JobCompleted", 101, map[string]any{"runnerId": stale.RunnerID, "runnerName": stale.RunnerName, "result": "canceled"}))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	err := c.advance(stale)
	if d := classify(err); d.Kind != "retained" || d.Code != "job ended before native source acknowledgment" {
		t.Fatalf("completion before ACK not retained: %v", err)
	}
	actions := nativeActions(t, c.journal.root)
	if !slices.Contains(actions, "bind+completion") || slices.Contains(actions, "bind") || c.journal.snapshot().Active.Phase == "bound" {
		t.Fatalf("bind dispatched without the accepted completion: %v", actions)
	}
}

// Keeper: the SDK JobCompleted for a source-bound job is lost with its session;
// a new session replays only statistics. Actual native transport exit plus
// the exact REST terminal still settle the slot and complete the request.
// Another acquired request canceled while unobserved is retired by the new
// session's zero statistics while the slot is active, so its release starts no
// phantom slot and the owner shuts down cleanly; still-assigned demand is
// served by the next real slot.
func TestActualSDKBoundJobSettlesWhenCompletionLostWithSession(t *testing.T) {
	for _, mode := range []string{"other-canceled-unobserved", "other-still-assigned"} {
		t.Run(mode, func(t *testing.T) {
			f := newSDKFixture(t)
			c := newFixtureController(t, f)
			writeCaptureTemplate(t, c.journal.root)
			f.push(1, job("JobAvailable", 101, nil), job("JobAvailable", 102, nil))
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, c, "launched")
			a := c.journal.snapshot().Active
			f.push(2, job("JobStarted", 101, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName}))
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, c, "bound")
			if err := c.advance(*c.journal.snapshot().Active); err != nil || c.journal.snapshot().Active.Phase != "bound" {
				t.Fatalf("live bound job left its phase: %v", err)
			}
			if err := os.WriteFile(filepath.Join(c.journal.root, "listener-exited"), []byte("official listener exited"), 0600); err != nil {
				t.Fatal(err)
			}
			canceled := mode == "other-canceled-unobserved"
			f.view(func() {
				delete(f.acquired, 101) // The server's job ended; its completion message is lost.
				if canceled {
					delete(f.acquired, 102) // Canceled; that message is lost too.
				}
			})
			// New session after expiry: the server offers no job message to replay.
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			if s := c.journal.snapshot(); s.Active == nil || s.Active.Phase != "bound" || len(s.CompletedRequests) != 0 || (canceled && len(s.Acquisitions) != 0) || (!canceled && len(s.Acquisitions) != 2) {
				t.Fatalf("zero statistics freed the slot, fabricated a terminal or misjudged demand: %+v", s)
			}
			advanceUntil(t, c, "")
			s := c.journal.snapshot()
			f.view(func() {
				if s.Active != nil || s.LastDisposition != "source-consistent-settlement" || !slices.Equal(s.CompletedRequests, []int64{101}) || !slices.Equal(f.deleted, []int{701}) || f.jitCalls != 1 {
					t.Fatalf("bound job without SDK completion not settled exactly, or a phantom slot started: %+v deleted=%v jit=%d", s, f.deleted, f.jitCalls)
				}
			})
			if actions := nativeActions(t, c.journal.root); slices.ContainsFunc(actions, func(a string) bool { return strings.HasSuffix(a, "+completion") }) {
				t.Fatalf("an SDK completion was invented: %v", actions)
			}
			if !canceled {
				// Current statistics still assign 102: the next real slot serves it.
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				advanceUntil(t, c, "launched")
				f.view(func() {
					if a := c.journal.snapshot().Active; a.AcquireIntent.RunnerRequestID != 102 || a.RunnerID != 702 || f.jitCalls != 2 {
						t.Fatalf("assigned demand not served after settlement: %+v jit=%d", a, f.jitCalls)
					}
				})
				return
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel() // Owner shutdown request with no owned slot left.
			run := f.goOwned(cancel, func() error { return c.run(ctx) })
			select {
			case <-run.done:
				f.view(func() {
					if err := run.err; err != nil || c.journal.snapshot().Active != nil || f.jitCalls != 1 {
						t.Fatalf("shutdown blocked or phantom slot started: %v jit=%d", err, f.jitCalls)
					}
				})
			case <-time.After(20 * time.Second):
				t.Fatal("owner shutdown wedged by retired demand")
			}
		})
	}
}

// Keeper: a canceled admitted request is intent bookkeeping, not the runner's
// terminal. Same-message demand (acquired, or ambiguous after a lost response)
// retargets the slot; the exact runner's start then binds and settles.
func TestActualSDKCanceledIntentRetargetsThenExactStartBinds(t *testing.T) {
	for _, mode := range []string{"acquired", "lost-acquire-response"} {
		t.Run(mode, func(t *testing.T) {
			f := newSDKFixture(t)
			c := newFixtureController(t, f)
			writeCaptureTemplate(t, c.journal.root)
			f.push(1, job("JobAvailable", 101, nil))
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, c, "launched")
			a := c.journal.snapshot().Active
			f.view(func() { f.loseAcquire = mode == "lost-acquire-response" })
			f.push(2, job("JobCompleted", 101, map[string]any{"runnerId": 0, "runnerName": "", "result": "canceled"}), job("JobAvailable", 102, nil))
			err := f.deliver(t, c)
			if mode == "lost-acquire-response" {
				if errors.Is(err, context.Canceled) {
					t.Fatal("lost acquire response was acknowledged")
				}
				err = f.deliver(t, c) // A new session replays the unacknowledged message.
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			retargeted := c.journal.snapshot().Active
			if retargeted.AcquireIntent.RunnerRequestID != 102 || retargeted.IntentCanceled != nil || retargeted.Completion != nil {
				t.Fatalf("canceled intent not retargeted after the message's acquisition: %+v", retargeted)
			}
			f.push(3, job("JobStarted", 102, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName}))
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, c, "bound")
			if actions := nativeActions(t, c.journal.root); slices.ContainsFunc(actions, func(a string) bool { return strings.HasSuffix(a, "+completion") }) {
				t.Fatalf("intent cancellation closed the actual job's native window: %v", actions)
			}
			f.push(4, job("JobCompleted", 102, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName, "result": "succeeded"}))
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, c, "")
			s := c.journal.snapshot()
			if s.Active != nil || s.LastDisposition != "source-consistent-settlement" || !slices.Equal(s.CompletedRequests, []int64{101, 102}) {
				t.Fatalf("started job on a retargeted slot not settled exactly: %+v", s)
			}
		})
	}
}

// Keeper: invalid demand never rolls back valid lifecycle evidence from the
// same message, and a burst of valid offers beyond any small count (in
// SDK-sized messages of at most 50) is journaled, acquired by exact identity
// and acknowledged in its own session while one physical slot serves it.
func TestActualSDKInvalidAndBurstDemandKeepLifecycle(t *testing.T) {
	for _, mode := range []string{"invalid", "burst"} {
		t.Run(mode, func(t *testing.T) {
			f := newSDKFixture(t)
			c := newFixtureController(t, f)
			var first, second []int64
			batch := []map[string]any{}
			for request := int64(101); request <= 150 && (mode == "burst" || request == 101); request++ {
				first = append(first, request)
				batch = append(batch, job("JobAvailable", request, nil))
			}
			f.push(1, batch...)
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			advanceUntil(t, c, "launched")
			a := c.journal.snapshot().Active
			started := job("JobStarted", 101, map[string]any{"runnerId": a.RunnerID, "runnerName": a.RunnerName})
			if mode == "invalid" {
				f.push(2, started,
					job("JobAvailable", 201, map[string]any{"requestLabels": []string{"self-hosted"}, "fixtureInvalid": true}),
					job("JobAvailable", 202, map[string]any{"jobWorkflowRef": "attacker/fork/.github/workflows/ci.yml@refs/heads/main", "fixtureInvalid": true}),
					job("JobAvailable", 203, nil))
				if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				s := c.journal.snapshot()
				f.view(func() {
					ids := []int64{}
					for _, entry := range s.Acquisitions {
						ids = append(ids, entry.Job.RunnerRequestID)
					}
					if s.Active.Assignment == nil || !slices.Equal(ids, []int64{101, 203}) || s.DemandRejection != "rejected-invalid-demand" || f.acks != 2 || !slices.Equal(f.acquireCalls[len(f.acquireCalls)-1], []int64{203}) {
						t.Fatalf("invalid demand poisoned valid lifecycle or was acquired: %+v acquire=%v ACK=%d", s, f.acquireCalls, f.acks)
					}
				})
				return
			}
			// The start, a duplicate offer of acquired 120 and 48 new offers.
			batch = []map[string]any{started, job("JobAvailable", 120, nil)}
			for request := int64(151); request <= 198; request++ {
				second = append(second, request)
				batch = append(batch, job("JobAvailable", request, nil))
			}
			f.push(2, batch...)
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatalf("burst demand not acknowledged in its own session: %v", err)
			}
			s := c.journal.snapshot()
			f.view(func() {
				ids := []int64{}
				for _, entry := range s.Acquisitions {
					if entry.Acquired {
						ids = append(ids, entry.Job.RunnerRequestID)
					}
				}
				if s.Active.OperationID != a.OperationID || s.Active.Assignment == nil || s.Active.Assignment.RunnerRequestID != 101 || !slices.Equal(ids, append(slices.Clone(first), second...)) || s.DemandRejection != "" || f.acks != 2 || len(f.acquireCalls) != 2 || !slices.Equal(f.acquireCalls[0], first) || !slices.Equal(f.acquireCalls[1], second) || f.jitCalls != 1 {
					t.Fatalf("burst demand dropped, duplicated or given a second slot: acquired=%v acquire=%v ACK=%d jit=%d", ids, f.acquireCalls, f.acks, f.jitCalls)
				}
			})
		})
	}
}

// Keeper: a fresh session's statistics with nothing assigned retire stale
// acquired and ambiguous demand (no slot, no fabricated terminal) while
// offered-only demand is still acquired; an assignment keeps the ledger.
func TestActualSDKFreshSessionStatisticsRetireStaleDemand(t *testing.T) {
	for _, assigned := range []bool{false, true} {
		t.Run(map[bool]string{false: "nothing-assigned", true: "assigned"}[assigned], func(t *testing.T) {
			f := newSDKFixture(t)
			c := newFixtureController(t, f)
			entry := func(request int64, acquired bool, attempts int) acquisition {
				base := scaleset.JobMessageBase{RunnerRequestID: request, WorkflowRunID: 55, JobID: fmt.Sprintf("opaque-%d", request), OwnerName: "fitchmultz", RepositoryName: "pi-subagents", JobWorkflowRef: "fitchmultz/pi-subagents/.github/workflows/ci.yml@refs/heads/main", RequestLabels: requiredLabels}
				return acquisition{Job: &scaleset.JobAvailable{JobMessageBase: base}, Acquired: acquired, Attempts: attempts}
			}
			if err := c.journal.update(func(s *state) error {
				s.Acquisitions = []acquisition{entry(101, true, 1), entry(102, false, 1), entry(103, false, 0)}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			f.view(func() { f.acquired[101] = assigned })
			if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			s := c.journal.snapshot()
			f.view(func() {
				want := map[bool][]int64{false: {103}, true: {102, 103}}[assigned]
				if len(f.acquireCalls) != 1 || !slices.Equal(f.acquireCalls[0], want) || len(s.CompletedRequests) != 0 || s.Active == nil {
					t.Fatalf("offered demand not acquired or terminal fabricated: acquire=%v %+v", f.acquireCalls, s)
				}
			})
			if want := map[bool]int64{false: 103, true: 101}[assigned]; s.Active.AcquireIntent.RunnerRequestID != want || (!assigned && len(s.Acquisitions) != 1) || (assigned && len(s.Acquisitions) != 3) {
				t.Fatalf("stale demand not reconciled against fresh statistics: %+v", s)
			}
		})
	}
}

// Keeper: retained slot uncertainty holds new AcquireJobs (offers stay
// journaled and acknowledged), even after a lesser later failure; only actual
// progress clears it and acquisition resumes.
func TestActualSDKRetainedUncertaintyHoldsAcquisitionUntilProgress(t *testing.T) {
	f := newSDKFixture(t)
	c := newFixtureController(t, f)
	startedSlot(t, f, c)
	var capture nativeCapture
	raw, err := os.ReadFile(filepath.Join(c.journal.root, "capture.json"))
	if err != nil || json.Unmarshal(raw, &capture) != nil {
		t.Fatal(err)
	}
	capture.RunnerVersion = "2.300.0" // An unreviewed actual Worker is native uncertainty.
	if raw, err = json.Marshal(capture); err != nil || os.WriteFile(filepath.Join(c.journal.root, "capture.json"), raw, 0600) != nil {
		t.Fatal(err)
	}
	if err := c.step(*c.journal.snapshot().Active); err != nil {
		t.Fatal(err)
	}
	if d := c.journal.snapshot().Active.Diagnostic; d == nil || d.Kind != "retained" {
		t.Fatalf("unreviewed Worker not retained: %+v", d)
	}
	// An actual transient REST 5xx on the next step is recorded beside, never
	// instead of, the retained uncertainty.
	f.view(func() { f.status["/repos/fitchmultz/pi-subagents"] = 503 })
	if err := c.step(*c.journal.snapshot().Active); err != nil {
		t.Fatal(err)
	}
	if a := c.journal.snapshot().Active; a.Diagnostic == nil || a.Diagnostic.Kind != "retained" || a.LatestDiagnostic == nil || *a.LatestDiagnostic != (diagnostic{"github-http-503", "transient"}) {
		t.Fatalf("lesser failure replaced retained uncertainty: %+v latest=%+v", a.Diagnostic, a.LatestDiagnostic)
	}
	// A successful same-phase wait (native processed a capture request and has
	// no capture) is not certainty either.
	f.view(func() { delete(f.status, "/repos/fitchmultz/pi-subagents") })
	if err := os.Remove(filepath.Join(c.journal.root, "capture.json")); err != nil {
		t.Fatal(err)
	}
	before := len(nativeActions(t, c.journal.root))
	if err := c.step(*c.journal.snapshot().Active); err != nil {
		t.Fatal(err)
	}
	if actions := nativeActions(t, c.journal.root); len(actions) != before+1 || actions[before] != "capture" {
		t.Fatalf("native capture observation not processed: %v", actions[before:])
	}
	if a := c.journal.snapshot().Active; a.Phase != "launched" || a.Diagnostic == nil || a.Diagnostic.Kind != "retained" || a.LatestDiagnostic == nil || a.LatestDiagnostic.Code != "github-http-503" {
		t.Fatalf("same-phase wait cleared retained uncertainty: %+v latest=%+v", a.Diagnostic, a.LatestDiagnostic)
	}
	f.push(3, job("JobAvailable", 102, nil))
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f.view(func() {
		s := c.journal.snapshot()
		i := findAcquisition(&s, 102)
		if len(f.acquireCalls) != 1 || i < 0 || s.Acquisitions[i].Attempts != 0 || f.acks != 3 {
			t.Fatalf("acquired demand during retained uncertainty: acquire=%v %+v", f.acquireCalls, s.Acquisitions)
		}
	})
	writeCaptureTemplate(t, c.journal.root)
	if err := c.step(*c.journal.snapshot().Active); err != nil {
		t.Fatal(err)
	}
	if a := c.journal.snapshot().Active; a.Diagnostic != nil || a.LatestDiagnostic != nil || a.Phase != "bound" {
		t.Fatalf("progress did not clear uncertainty: %+v", a)
	}
	if err := f.deliver(t, c); !errors.Is(err, context.Canceled) { // Long-poll timeout.
		t.Fatal(err)
	}
	f.view(func() {
		if !slices.Equal(f.acquireCalls[len(f.acquireCalls)-1], []int64{102}) || !f.acquired[102] {
			t.Fatalf("acquisition did not resume after certainty: %v", f.acquireCalls)
		}
	})
}

// classify keeps SDK and REST identities distinct without reading bodies.
func TestActualSDKAndRESTErrorsClassifyByExportedIdentity(t *testing.T) {
	f := newSDKFixture(t)
	const agents = "/_apis/distributedtask/pools/0/agents"
	f.view(func() { f.status[agents] = 401 })
	_, err := f.sdk.GetRunnerByName(context.Background(), "any")
	if d := classify(err); d != (diagnostic{"sdk-unauthorized", "unavailable"}) {
		t.Fatalf("SDK 401: %+v", d)
	}
	// The actual queue 401 path: the SDK refreshes the session, retries once,
	// and its second 401 wraps both the queue-token and generic 401 identities.
	session, err := f.sdk.MessageSessionClient(context.Background(), 7, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close(context.Background())
	f.view(func() { f.status["/queue"] = 401 })
	_, err = session.GetMessage(context.Background(), 0, 1)
	f.view(func() {
		if d := classify(err); d != (diagnostic{"sdk-queue-token-expired", "transient"}) || f.refreshes != 1 {
			t.Fatalf("queue 401 after refresh: %+v refreshes=%d", d, f.refreshes)
		}
	})
	// The SDK's retrying transport surfaces an exhausted retryable 5xx as a
	// typed transport error; a non-retryable 5xx has no exported status.
	for status, want := range map[int]diagnostic{503: {"network", "transient"}, 501: {"unclassified", "retained"}} {
		f.view(func() { f.status[agents] = status })
		_, err = f.sdk.GetRunnerByName(context.Background(), "any")
		if d := classify(err); d != want {
			t.Fatalf("SDK %d: %+v", status, d)
		}
	}
	for status, want := range map[int]diagnostic{503: {"github-http-503", "transient"}, 401: {"github-http-401", "unavailable"}, 422: {"github-http-422", "retained"}} {
		f.view(func() { f.status["/repos/fitchmultz/pi-subagents"] = status })
		if d := classify(repositoryAccess(context.Background(), f.rest)); d != want {
			t.Fatalf("REST %d: %+v", status, d)
		}
	}
}
