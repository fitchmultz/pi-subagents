package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/actions/scaleset"
	"github.com/google/go-github/v88/github"
)

var objectID = regexp.MustCompile(`^[a-f0-9]{40}$`)
var digestID = regexp.MustCompile(`^[a-f0-9]{64}$`)

type sourceFile struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	SHA  string `json:"sha"`
}

type sourceBinding struct {
	Repository    string       `json:"repository"`
	RequestID     int64        `json:"requestId"`
	SDKJobID      string       `json:"sdkJobId"`
	RunnerID      int          `json:"runnerId"`
	RunnerName    string       `json:"runnerName"`
	RunID         int64        `json:"runId"`
	Attempt       int          `json:"attempt"`
	JobID         int64        `json:"jobId"`
	JobName       string       `json:"jobName"`
	Event         string       `json:"event"`
	Ref           string       `json:"ref"`
	SHA           string       `json:"sha"`
	Tree          string       `json:"tree"`
	HeadSHA       string       `json:"headSha"`
	BaseSHA       string       `json:"baseSha,omitempty"`
	PRNumber      int          `json:"prNumber,omitempty"`
	Nonce         string       `json:"nonce"`
	OperationID   string       `json:"operationID"`
	ContextHash   string       `json:"contextHash"`
	Commit        string       `json:"commit"`
	Files         []sourceFile `json:"files"`
	RunnerVersion string       `json:"runnerVersion"`
	WorkerSHA256  string       `json:"workerSHA256"`
}

type terminalProof struct {
	RunID              int64  `json:"runId"`
	Attempt            int    `json:"attempt"`
	JobID              int64  `json:"jobId"`
	RunnerID           int    `json:"runnerId"`
	RunnerName         string `json:"runnerName"`
	Conclusion         string `json:"conclusion"`
	RegistrationAbsent bool   `json:"registrationAbsent"`
	Vetoed             bool   `json:"vetoed,omitempty"`
	RequestID          int64  `json:"requestId,omitempty"`
	NoJob              bool   `json:"noJob,omitempty"`
	Canceled           bool   `json:"canceled,omitempty"`
	// InterruptedUnassigned settles native's proved known-idle EOF interruption:
	// no request was canceled or completed, so no request/run/job fields are set.
	InterruptedUnassigned bool `json:"interruptedUnassigned,omitempty"`
}

func validateJobBase(base scaleset.JobMessageBase) error {
	if base.OwnerName != "fitchmultz" || base.RepositoryName != "pi-subagents" || base.RunnerRequestID <= 0 || base.WorkflowRunID <= 0 || base.JobID == "" {
		return retained("SDK assignment repository/request/run identity mismatch")
	}
	if !strings.HasPrefix(base.JobWorkflowRef, repository+"/.github/workflows/") {
		return retained("SDK workflow source outside repository")
	}
	for _, want := range requiredLabels {
		found := false
		for _, got := range base.RequestLabels {
			if got == want {
				found = true
			}
		}
		if !found {
			return retained("assignment lost protected runner label")
		}
	}
	return nil
}

func resolveSource(ctx context.Context, api *github.Client, a slot, capture hookContext) (*sourceBinding, error) {
	if a.Assignment == nil {
		return nil, retained("no SDK started identity yet")
	}
	job := a.Assignment
	if err := validateJobBase(job.JobMessageBase); err != nil {
		return nil, err
	}
	if capture.Repository != repository || capture.RunID != job.WorkflowRunID || capture.Attempt <= 0 || !objectID.MatchString(capture.SHA) || len(capture.Nonce) < 32 || len(capture.Nonce) > 128 {
		return nil, retained("official hook context does not match SDK assignment")
	}
	run, _, err := api.Actions.GetWorkflowRunAttempt(ctx, "fitchmultz", "pi-subagents", capture.RunID, capture.Attempt, nil)
	if err != nil {
		return nil, err
	}
	if run.GetID() != capture.RunID || run.GetRunAttempt() != capture.Attempt || run.GetEvent() != capture.Event || run.GetRepository().GetFullName() != repository {
		return nil, retained("REST run attempt does not match official hook")
	}
	actual, err := assignedRESTJob(ctx, api, a, capture)
	if err != nil {
		return nil, err
	}
	if actual.GetHeadSHA() != run.GetHeadSHA() {
		return nil, retained("REST job and run head differ")
	}
	if capture.Event != "pull_request" && capture.Ref != "refs/heads/"+run.GetHeadBranch() && capture.Ref != "refs/tags/"+run.GetHeadBranch() {
		return nil, retained("caller ref does not match authoritative run branch/tag")
	}
	binding := &sourceBinding{Repository: repository, RequestID: job.RunnerRequestID, SDKJobID: job.JobID, RunnerID: a.RunnerID, RunnerName: a.RunnerName, RunID: capture.RunID, Attempt: capture.Attempt, JobID: actual.GetID(), JobName: actual.GetName(), Event: capture.Event, Ref: capture.Ref, SHA: capture.SHA, HeadSHA: run.GetHeadSHA(), BaseSHA: "", PRNumber: 0, Nonce: capture.Nonce}
	commit, _, err := api.Git.GetCommit(ctx, "fitchmultz", "pi-subagents", capture.SHA)
	if err != nil {
		return nil, err
	}
	if commit.GetSHA() != capture.SHA || !objectID.MatchString(commit.GetTree().GetSHA()) {
		return nil, retained("public immutable Git object identity mismatch")
	}
	binding.Tree = commit.GetTree().GetSHA()
	binding.Commit = binding.SHA
	files, err := resolveFiles(ctx, api, binding.Tree)
	if err != nil {
		return nil, err
	}
	binding.Files = files
	if err := validateEventSource(binding, capture, commit); err != nil {
		return nil, err
	}
	return binding, nil
}

func assignedRESTJob(ctx context.Context, api *github.Client, a slot, hook hookContext) (*github.WorkflowJob, error) {
	var matched *github.WorkflowJob
	opts := &github.ListOptions{PerPage: 100}
	// Bounded metadata lookup ONLY for the already assigned run/attempt. This is
	// not demand discovery, JobID coercion or a local workflow queue.
	for page := 1; page <= 10; page++ {
		opts.Page = page
		jobs, response, err := api.Actions.ListWorkflowJobsAttempt(ctx, "fitchmultz", "pi-subagents", hook.RunID, int64(hook.Attempt), opts)
		if err != nil {
			return nil, err
		}
		for _, job := range jobs.Jobs {
			if job.GetRunnerID() != int64(a.RunnerID) || job.GetRunnerName() != a.RunnerName {
				continue
			}
			if matched != nil {
				return nil, retained("multiple REST jobs associated with one ephemeral runner")
			}
			if job.GetRunID() != hook.RunID || job.GetRunAttempt() != int64(hook.Attempt) {
				return nil, retained("REST job assignment mismatch")
			}
			matched = job
		}
		if response.NextPage == 0 {
			if matched == nil {
				return nil, waitingFor("assigned REST job not published yet")
			}
			return matched, nil
		}
	}
	return nil, retained("assigned metadata exceeds bounded page limit")
}

func validateEventSource(b *sourceBinding, hook hookContext, commit *github.Commit) error {
	switch b.Event {
	case "pull_request":
		var number int
		if _, err := fmt.Sscanf(hook.Ref, "refs/pull/%d/merge", &number); err != nil || number <= 0 || hook.Ref != fmt.Sprintf("refs/pull/%d/merge", number) {
			return retained("PR must use the original synthetic merge ref")
		}
		b.PRNumber = number
		if len(commit.Parents) != 2 || !objectID.MatchString(commit.Parents[0].GetSHA()) || commit.Parents[1].GetSHA() != b.HeadSHA {
			return retained("synthetic merge parents do not match original run head")
		}
		b.BaseSHA = commit.Parents[0].GetSHA()
	case "push", "schedule", "workflow_dispatch":
		if b.SHA != b.HeadSHA || !strings.HasPrefix(b.Ref, "refs/") {
			return retained("caller event checkout does not match authoritative run head")
		}
		if b.Event == "schedule" && b.Ref != "refs/heads/main" {
			return retained("schedule must qualify default main source")
		}
	default:
		// workflow_call inherits its caller's event. A synthetic workflow_call value
		// without the caller's actual source semantics is not accepted.
		return retained("unsupported assignment event")
	}
	return nil
}

func completedJob(ctx context.Context, api *github.Client, a slot) (*terminalProof, error) {
	b := a.Source
	if b == nil {
		return nil, retained("terminal signal without frozen source")
	}
	job, _, err := api.Actions.GetWorkflowJobByID(ctx, "fitchmultz", "pi-subagents", b.JobID)
	if err != nil {
		return nil, err
	}
	if job.GetRunID() != b.RunID || job.GetRunAttempt() != int64(b.Attempt) || job.GetRunnerID() != int64(b.RunnerID) || job.GetRunnerName() != b.RunnerName || job.GetHeadSHA() != b.HeadSHA {
		return nil, retained("terminal REST assignment identity changed")
	}
	if job.GetStatus() != "completed" || job.GetConclusion() == "" {
		return nil, waitingFor("actual assigned job not terminal yet")
	}
	return &terminalProof{RunID: b.RunID, Attempt: b.Attempt, JobID: b.JobID, RunnerID: b.RunnerID, RunnerName: b.RunnerName, Conclusion: job.GetConclusion()}, nil
}

func repositoryAccess(ctx context.Context, api *github.Client) error {
	repo, _, err := api.Repositories.Get(ctx, "fitchmultz", "pi-subagents")
	if err != nil {
		return err
	}
	if repo.GetFullName() != repository {
		return retained("authenticated repository scope changed")
	}
	return nil
}
