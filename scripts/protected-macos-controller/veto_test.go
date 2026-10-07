package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/actions/scaleset"
	"github.com/google/go-github/v88/github"
)

func TestGuardVetoRequiresExactOwnedNonSuccessAndDoesNotInventSource(t *testing.T) {
	var green atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/fitchmultz/pi-subagents/actions/runs/55/jobs":
			if r.URL.Query().Get("filter") != "all" {
				w.WriteHeader(400)
				return
			}
			conclusion := "failure"
			if green.Load() {
				conclusion = "success"
			}
			fmt.Fprintf(w, `{"total_count":1,"jobs":[{"id":8099,"run_id":55,"run_attempt":2,"runner_id":703,"runner_name":"vetoed-runner","head_sha":"%s","status":"completed","conclusion":"%s"}]}`, strings.Repeat("a", 40), conclusion)
		case "/repos/fitchmultz/pi-subagents/actions/runs/55/attempts/2":
			fmt.Fprintf(w, `{"id":55,"run_attempt":2,"head_sha":"%s","repository":{"full_name":"fitchmultz/pi-subagents"}}`, strings.Repeat("a", 40))
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	url := server.URL + "/"
	api, err := github.NewClient(github.WithURLs(&url, &url))
	if err != nil {
		t.Fatal(err)
	}
	a := slot{RunnerID: 703, RunnerName: "vetoed-runner", Veto: &guardVeto{Code: "debugger", ReceiptHash: strings.Repeat("e", 64), HookFailed: true, NoACK: true, WindowClosed: true}, Assignment: &scaleset.JobStarted{JobMessageBase: scaleset.JobMessageBase{RunnerRequestID: 303, WorkflowRunID: 55, JobID: "opaque-veto", OwnerName: "fitchmultz", RepositoryName: "pi-subagents", JobWorkflowRef: "fitchmultz/pi-subagents/.github/workflows/ci.yml@refs/heads/main", RequestLabels: []string{"self-hosted", "macOS", "ARM64", "protected-macos-arm64"}}}}
	proof, err := vetoTerminal(context.Background(), api, a)
	if err != nil {
		t.Fatal(err)
	}
	if proof.JobID != 8099 || proof.Attempt != 2 || proof.Conclusion != "failure" || !proof.Vetoed || a.Source != nil {
		t.Fatalf("incorrect failed-job association or fabricated qualified source: %+v", proof)
	}
	green.Store(true)
	if _, err := vetoTerminal(context.Background(), api, a); err == nil {
		t.Fatal("green job was relabeled as integrity-veto failure")
	}
	a.RunnerID = 704
	if _, err := vetoTerminal(context.Background(), api, a); err == nil {
		t.Fatal("foreign runner authorized veto disposal")
	}
}
