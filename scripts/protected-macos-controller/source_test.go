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

func TestCallerSourcesAndUnreviewedTreeFailClosed(t *testing.T) {
	sha := strings.Repeat("a", 40)
	tree := strings.Repeat("b", 40)
	blob := strings.Repeat("c", 40)
	for _, event := range []string{"push", "schedule", "workflow_dispatch"} {
		t.Run(event, func(t *testing.T) {
			var truncated atomic.Bool
			var treePath atomic.Value
			treePath.Store("scripts/tool.sh")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/fitchmultz/pi-subagents/actions/runs/56/attempts/3":
					fmt.Fprintf(w, `{"id":56,"run_attempt":3,"event":"%s","head_sha":"%s","head_branch":"main","repository":{"full_name":"fitchmultz/pi-subagents"}}`, event, sha)
				case "/repos/fitchmultz/pi-subagents/actions/runs/56/attempts/3/jobs":
					fmt.Fprintf(w, `{"total_count":1,"jobs":[{"id":9001,"run_id":56,"run_attempt":3,"runner_id":702,"runner_name":"release-consumer","head_sha":"%s","name":"Reusable caller / matrix Mac"}]}`, sha)
				case "/repos/fitchmultz/pi-subagents/git/commits/" + sha:
					fmt.Fprintf(w, `{"sha":"%s","tree":{"sha":"%s"},"parents":[]}`, sha, tree)
				case "/repos/fitchmultz/pi-subagents/git/trees/" + tree:
					fmt.Fprintf(w, `{"sha":"%s","truncated":%t,"tree":[{"path":%q,"type":"blob","mode":"100755","sha":"%s"}]}`, tree, truncated.Load(), treePath.Load(), blob)
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
			a := slot{RunnerID: 702, RunnerName: "release-consumer", Assignment: &scaleset.JobStarted{RunnerID: 702, RunnerName: "release-consumer", JobMessageBase: scaleset.JobMessageBase{RunnerRequestID: 202, WorkflowRunID: 56, JobID: "opaque-release-job", OwnerName: "fitchmultz", RepositoryName: "pi-subagents", EventName: "workflow_call", JobDisplayName: "SDK formatting is not REST identity", JobWorkflowRef: "fitchmultz/pi-subagents/.github/workflows/ci.yml@refs/heads/main", RequestLabels: []string{"self-hosted", "macOS", "ARM64", "protected-macos-arm64"}}}}
			hook := hookContext{Repository: repository, RunID: 56, Attempt: 3, Event: event, Ref: "refs/heads/main", SHA: sha, Nonce: strings.Repeat("d", 64)}
			binding, err := resolveSource(context.Background(), api, a, hook)
			if err != nil {
				t.Fatal(err)
			}
			if binding.JobID != 9001 || binding.Attempt != 3 || binding.SHA != sha || binding.Files[0].Mode != "100755" || binding.Event != event {
				t.Fatalf("incorrect caller source: %+v", binding)
			}
			wrong := hook
			wrong.Ref = "refs/heads/unrelated"
			if _, err := resolveSource(context.Background(), api, a, wrong); err == nil {
				t.Fatal("caller ref unrelated to run accepted")
			}
			truncated.Store(true)
			if _, err := resolveSource(context.Background(), api, a, hook); err == nil {
				t.Fatal("truncated source tree accepted")
			}
			truncated.Store(false)
			// The native freeze rejects these; Go must not hand them to bind.
			for _, unsafe := range []string{"vendor/.git/config", "scripts/tab\tname.sh"} {
				treePath.Store(unsafe)
				if _, err := resolveSource(context.Background(), api, a, hook); err == nil {
					t.Fatalf("unsafe nested source path %q accepted", unsafe)
				}
			}
		})
	}
}
