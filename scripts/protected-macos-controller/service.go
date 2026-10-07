package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"syscall"
	"time"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

func (c *controller) run(ctx context.Context) error {
	go c.worker()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	listenCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		select {
		case <-signals:
			c.stopping.Store(true)
			c.notify()
		case <-ctx.Done():
			c.stopping.Store(true)
			c.notify()
		case <-listenCtx.Done():
		}
	}()
	go func() {
		select {
		case <-c.workerDone:
			stop()
		case <-listenCtx.Done():
		}
	}()
	c.setListener(false, nil) // A previous process's observation is not this listener.
	for listenCtx.Err() == nil {
		apiCtx, cancel := operationContext(listenCtx)
		ss, err := ensureScaleSet(apiCtx, c.api.scale, c.journal)
		cancel()
		if err != nil {
			c.listenerDown("scale-set", err)
			if !cooldown(listenCtx) {
				break
			}
			continue
		}
		session, err := c.createSession(listenCtx, ss.ID)
		if err != nil {
			c.listenerDown("session", err)
			if !cooldown(listenCtx) {
				break
			}
			continue
		}
		c.setListener(true, nil)
		c.session = session
		activeListener, listenerErr := listener.New(deadlineClient{session}, listener.Config{ScaleSetID: ss.ID, MaxRunners: 0})
		if listenerErr != nil {
			return listenerErr
		}
		c.listenerMu.Lock()
		c.listener = activeListener
		c.listenerMu.Unlock()
		c.adjustCapacity()
		runErr := activeListener.Run(listenCtx, c)
		if listenCtx.Err() != nil {
			c.setListener(false, nil)
		} else {
			c.listenerDown("listener", runErr)
		}
		// Never establish a replacement until the actual old SDK Close succeeds.
		for {
			closeCtx, closeCancel := operationContext(context.Background())
			closeErr := session.Close(closeCtx)
			closeCancel()
			if closeErr == nil || errors.Is(closeErr, scaleset.NotFoundError) {
				break
			}
			if !cooldown(listenCtx) {
				<-c.workerDone
				return errors.Join(c.workerErr, runErr, closeErr)
			}
		}
		c.session = nil
		if listenCtx.Err() == nil && !cooldown(listenCtx) {
			break
		}
	}
	// Listener cancellation never cancels Tart, SSH or the native worker: the
	// listener stops only after the worker settled or failed. A worker failure
	// is the service exit identity so launchd restarts the owner.
	<-c.workerDone
	return c.workerErr
}

// setListener journals this process's local listener observation only when it
// changes. A failed write is the journal's sticky failure: the worker observes
// it and ends the service, so it is not returned here.
func (c *controller) setListener(up bool, d *diagnostic) {
	if s := c.journal.snapshot(); s.ListenerUp == up && reflect.DeepEqual(s.Listener, d) {
		return
	}
	if c.journal.update(func(s *state) error { s.ListenerUp, s.Listener = up, d; return nil }) != nil {
		c.notify()
	}
}

func (c *controller) listenerDown(stage string, err error) {
	d := classify(err)
	d.Code = stage + ": " + d.Code
	c.setListener(false, &d)
}

func (c *controller) createSession(ctx context.Context, id int) (*scaleset.MessageSessionClient, error) {
	owner := c.journal.snapshot().Owner
	for {
		callCtx, cancel := operationContext(ctx)
		session, err := c.api.scale.MessageSessionClient(callCtx, id, owner)
		cancel()
		if err == nil {
			return session, nil
		}
		if !errors.Is(err, scaleset.ConflictError) {
			return nil, err
		}
		// Server success, not a guessed expiry or parsed exception ID, authorizes a
		// new SDK session after a cold crash. Automatic retries remain cancelable.
		c.setListener(false, &diagnostic{Code: "session conflict cooldown", Kind: "waiting"})
		if !cooldown(ctx) {
			return nil, ctx.Err()
		}
	}
}

func cooldown(ctx context.Context) bool {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func (c *controller) adjustCapacity() {
	c.listenerMu.Lock()
	defer c.listenerMu.Unlock()
	if c.listener == nil {
		return
	}
	c.listener.SetMaxRunners(availableCapacity(c.journal.snapshot(), c.stopping.Load()))
}

// availableCapacity is the one capacity rule: the single physical slot is the
// capacity, so none is available while occupied, draining, stopping or while
// cached statistics cannot admit a free slot (statisticsBlocked).
func availableCapacity(s state, stopping bool) int {
	if stopping || s.Drain || s.Active != nil || s.Statistics.TotalRegisteredRunners > 0 || s.StatisticsStale {
		return 0
	}
	return 1
}

// control applies a private drain/recover request. A rejected request is
// reported in status and never blocks the owned lifecycle; only a journal
// failure is returned.
func (c *controller) control() error {
	path := filepath.Join(c.config.Root, "control.json")
	var control struct {
		Action string `json:"action"`
	}
	err := readJSON(path, &control)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	code := "invalid-private-control"
	if err == nil && (control.Action == "drain" || control.Action == "recover") {
		// Journal first: a crash before removal reapplies the same request.
		if err := c.setControl("", control.Action == "drain"); err != nil {
			return err
		}
		if os.Remove(path) == nil {
			return nil
		}
		code = "private-control-not-removed"
	}
	return c.setControl(code, c.journal.snapshot().Drain)
}

func (c *controller) setControl(code string, drain bool) error {
	if s := c.journal.snapshot(); s.Control == code && s.Drain == drain {
		return nil
	}
	return c.journal.update(func(s *state) error { s.Control = code; s.Drain = drain; return nil })
}
