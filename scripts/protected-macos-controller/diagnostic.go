package main

import (
	"context"
	"errors"
	"fmt"
	"net"

	"github.com/actions/scaleset"

	"github.com/google/go-github/v88/github"
)

// diagnostic is the bounded, privacy-safe journal record of why the active slot
// is not progressing. Codes are Go-owned static text or HTTP status classes;
// server bodies, credentials and JIT values never enter it.
type diagnostic struct {
	Code string `json:"code"`
	// waiting: expected progression (live transport, REST publication lag).
	// transient: API/network/deadline failure that is retried automatically.
	// unavailable: credentials/authorization rejected; retried, never working.
	// retained: unknown or contradictory evidence; never auto-released.
	Kind string `json:"kind"`
}

type lifecycleError struct {
	code    string
	waiting bool
}

func (e *lifecycleError) Error() string { return e.code }

// waitingFor marks an expected, non-failing wait for real external progress.
func waitingFor(code string) error { return &lifecycleError{code: code, waiting: true} }

// retained marks contradictory or unknown evidence that keeps the slot occupied.
func retained(code string) error { return &lifecycleError{code: code} }

// sdkSentinels are the SDK's exported error identities, most specific first
// (a queue 401 also wraps the generic 401 sentinel, a runner-not-found the
// HTTP 404 sentinel). The SDK's retrying transport reports exhausted retryable
// responses (429, 5xx except 501) as typed transport errors (net.Error below);
// its other HTTP failures carry no exported status and stay unclassified.
var sdkSentinels = []struct {
	err error
	d   diagnostic
}{
	{scaleset.MessageQueueTokenExpiredError, diagnostic{"sdk-queue-token-expired", "transient"}},
	{scaleset.UnauthorizedError, diagnostic{"sdk-unauthorized", "unavailable"}},
	{scaleset.RunnerNotFoundError, diagnostic{"sdk-runner-not-found", "retained"}},
	{scaleset.RunnerExistsError, diagnostic{"sdk-runner-exists", "retained"}},
	{scaleset.JobStillRunningError, diagnostic{"sdk-job-still-running", "retained"}},
	{scaleset.ConflictError, diagnostic{"sdk-conflict", "retained"}},
	{scaleset.NotFoundError, diagnostic{"sdk-not-found", "retained"}},
	{scaleset.BadRequestError, diagnostic{"sdk-bad-request", "retained"}},
}

func classify(err error) diagnostic {
	var lifecycle *lifecycleError
	if errors.As(err, &lifecycle) {
		if lifecycle.waiting {
			return diagnostic{Code: lifecycle.code, Kind: "waiting"}
		}
		return diagnostic{Code: lifecycle.code, Kind: "retained"}
	}
	for _, sentinel := range sdkSentinels {
		if errors.Is(err, sentinel.err) {
			return sentinel.d
		}
	}
	var rate *github.RateLimitError
	var abuse *github.AbuseRateLimitError
	if errors.As(err, &rate) || errors.As(err, &abuse) {
		return diagnostic{Code: "github-rate-limited", Kind: "transient"}
	}
	var response *github.ErrorResponse
	if errors.As(err, &response) && response.Response != nil {
		status := response.Response.StatusCode
		d := diagnostic{Code: fmt.Sprintf("github-http-%d", status), Kind: "retained"}
		switch {
		case status >= 500 || status == 429:
			d.Kind = "transient"
		case status == 401 || status == 403:
			d.Kind = "unavailable"
		}
		return d
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return diagnostic{Code: "deadline", Kind: "transient"}
	}
	var network net.Error
	if errors.As(err, &network) {
		return diagnostic{Code: "network", Kind: "transient"}
	}
	return diagnostic{Code: "unclassified", Kind: "retained"}
}
