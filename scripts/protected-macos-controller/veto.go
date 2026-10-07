package main

import (
	"context"

	"github.com/google/go-github/v88/github"
)

// A deterministic native integrity/debugger veto is a failed job, never a
// qualified source. Unknown association or native certainty still retains.
type guardVeto struct {
	Code         string `json:"code"`
	ReceiptHash  string `json:"receiptHash"`
	HookFailed   bool   `json:"hookFailed"`
	NoACK        bool   `json:"noAck"`
	WindowClosed bool   `json:"windowClosed"`
}

func (v guardVeto) validate() error {
	if (v.Code != "debugger" && v.Code != "integrity") || !digestID.MatchString(v.ReceiptHash) || !v.NoACK || !v.WindowClosed {
		return retained("native guard veto is not a deterministic closed no-ACK receipt")
	}
	return nil
}

func vetoTerminal(ctx context.Context, api *github.Client, a slot) (*terminalProof, error) {
	if a.Assignment == nil || a.Veto == nil || !a.Veto.HookFailed {
		return nil, retained("guard-veto failed-hook/assignment evidence incomplete")
	}
	if err := validateJobBase(a.Assignment.JobMessageBase); err != nil {
		return nil, err
	}
	opts := &github.ListWorkflowJobsOptions{Filter: "all", ListOptions: github.ListOptions{PerPage: 100}}
	var matched *github.WorkflowJob
	for page := 1; page <= 10; page++ {
		opts.Page = page
		jobs, response, err := api.Actions.ListWorkflowJobs(ctx, "fitchmultz", "pi-subagents", a.Assignment.WorkflowRunID, opts)
		if err != nil {
			return nil, err
		}
		for _, job := range jobs.Jobs {
			if job.GetRunnerID() != int64(a.RunnerID) || job.GetRunnerName() != a.RunnerName {
				continue
			}
			if matched != nil {
				return nil, retained("multiple REST assignments for guard-veto runner")
			}
			matched = job
		}
		if response.NextPage == 0 {
			break
		}
		if page == 10 {
			return nil, retained("veto assignment metadata exceeds page limit")
		}
	}
	if matched == nil {
		return nil, waitingFor("guard-veto REST job not published yet")
	}
	if matched.GetRunID() != a.Assignment.WorkflowRunID || matched.GetRunAttempt() <= 0 {
		return nil, retained("guard-veto REST job association mismatch")
	}
	if matched.GetStatus() != "completed" {
		return nil, waitingFor("guard-veto REST job not completed yet")
	}
	if matched.GetConclusion() == "" || matched.GetConclusion() == "success" {
		return nil, retained("guard-veto REST job not terminal non-success")
	}
	run, _, err := api.Actions.GetWorkflowRunAttempt(ctx, "fitchmultz", "pi-subagents", matched.GetRunID(), int(matched.GetRunAttempt()), nil)
	if err != nil {
		return nil, err
	}
	if run.GetID() != matched.GetRunID() || run.GetRunAttempt() != int(matched.GetRunAttempt()) || run.GetRepository().GetFullName() != repository || run.GetHeadSHA() != matched.GetHeadSHA() {
		return nil, retained("guard-veto run/job association mismatch")
	}
	return &terminalProof{RunID: matched.GetRunID(), Attempt: int(matched.GetRunAttempt()), JobID: matched.GetID(), RunnerID: a.RunnerID, RunnerName: a.RunnerName, Conclusion: matched.GetConclusion(), RequestID: a.Assignment.RunnerRequestID, Vetoed: true}, nil
}

func (c *controller) recordVeto(a slot, v guardVeto) error {
	if err := v.validate(); err != nil {
		return err
	}
	return c.journal.active(a.OperationID, func(current *slot) error {
		// A frozen but unacknowledged Source still had no ACK; the veto proves it.
		if current.Phase == "bound" {
			return retained("guard veto after source acknowledgment is uncertainty")
		}
		current.Veto = &v
		current.Phase = "veto-settling"
		return nil
	})
}

func (c *controller) settleVeto(a slot) error {
	status, err := c.nativeCall(a, "status", nil)
	if err != nil {
		return err
	}
	if status.Veto == nil {
		return retained("native deterministic veto receipt missing")
	}
	if err := status.Veto.validate(); err != nil {
		return err
	}
	if !status.Veto.HookFailed {
		return retained("native veto lacks actual hook failure")
	}
	if !status.TransportEnded {
		return waitingFor("vetoed job transport still live")
	}
	if a.Veto == nil || a.Veto.ReceiptHash != status.Veto.ReceiptHash {
		return retained("native veto identity changed")
	}
	a.Veto = status.Veto
	ctx, cancel := operationContext(context.Background())
	defer cancel()
	terminal, err := vetoTerminal(ctx, c.api.github, a)
	if err != nil {
		return err
	}
	if err := c.journal.active(a.OperationID, func(current *slot) error { current.Veto = a.Veto; current.Terminal = terminal; return nil }); err != nil {
		return err
	}
	if err := c.removeOffline(ctx, a, nil); err != nil {
		return err
	}
	terminal.RegistrationAbsent = true
	reply, err := c.nativeCall(a, "settle", func(req *nativeRequest) { req.Terminal = terminal })
	if err != nil {
		return err
	}
	if !reply.Disposed || !reply.TransportEnded || !reply.VetoVerified || reply.SourceVerified {
		return retained("veto cleanup lacks actual failed-job native disposal or claims qualified source")
	}
	return c.disposed(a, terminal)
}
