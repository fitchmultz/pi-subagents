package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/actions/scaleset"
	"github.com/bradleyfalzon/ghinstallation/v2"
	"github.com/google/go-github/v88/github"
)

type apiClients struct {
	scale  *scaleset.Client
	github *github.Client
	// app is the REST client's GitHub App installation transport; nil for a PAT.
	app *ghinstallation.Transport
}

func clients(c config, j *journal) (apiClients, error) {
	var auth credentials
	if err := readJSON(c.AuthFile, &auth); err != nil {
		return apiClients{}, err
	}
	options := []scaleset.HTTPOption{scaleset.WithTimeout(90 * time.Second), scaleset.WithRetryMax(0)}
	info := scaleset.SystemInfo{System: "pi-subagents-protected-macos", Subsystem: "controller"}
	if auth.PAT != "" {
		if auth.PrivateKey != "" || auth.InstallationID != 0 {
			return apiClients{}, errors.New("choose PAT or App, not both")
		}
		sdk, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{GitHubConfigURL: repositoryURL, PersonalAccessToken: auth.PAT, SystemInfo: info}, options...)
		if err != nil {
			return apiClients{}, err
		}
		rest, err := github.NewClient(github.WithTimeout(30*time.Second), github.WithAuthToken(auth.PAT))
		return apiClients{scale: sdk, github: rest}, err
	}
	transport, err := ghinstallation.New(http.DefaultTransport, auth.AppID, auth.InstallationID, []byte(auth.PrivateKey))
	if err != nil {
		return apiClients{}, err
	}
	sdk, err := scaleset.NewClientWithGitHubApp(scaleset.ClientWithGitHubAppConfig{GitHubConfigURL: repositoryURL, GitHubAppAuth: scaleset.GitHubAppAuth{ClientID: auth.ClientID, InstallationID: auth.InstallationID, PrivateKey: auth.PrivateKey}, SystemInfo: info}, options...)
	if err != nil {
		return apiClients{}, err
	}
	rest, err := github.NewClient(github.WithTimeout(30*time.Second), github.WithTransport(transport))
	return apiClients{scale: sdk, github: rest, app: transport}, err
}

// appTokenReady completes any due App installation-token refresh through the
// library and requires the token to stay unrefreshed until ctx's deadline, so
// requests within ctx never suspend in authentication. A PAT needs nothing.
func (api apiClients) appTokenReady(ctx context.Context) error {
	if api.app == nil {
		return nil
	}
	if _, err := api.app.Token(ctx); err != nil {
		return err
	}
	_, refreshAt, err := api.app.Expiry()
	if err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); !ok || !refreshAt.After(deadline) {
		return waitingFor("App installation token refresh due before the operation deadline")
	}
	return nil
}

func ensureScaleSet(ctx context.Context, sdk *scaleset.Client, j *journal) (*scaleset.RunnerScaleSet, error) {
	group, err := sdk.GetRunnerGroupByName(ctx, scaleset.DefaultRunnerGroup)
	if err != nil {
		return nil, err
	}
	if group == nil || group.ID <= 0 || !group.IsDefault {
		return nil, errors.New("default repository runner group not proved")
	}
	ss, err := sdk.GetRunnerScaleSet(ctx, group.ID, scaleSetName)
	if err != nil {
		return nil, err
	}
	if ss == nil {
		labels := make([]scaleset.Label, len(requiredLabels))
		for i, label := range requiredLabels {
			labels[i] = scaleset.Label{Name: label}
		}
		ss, err = sdk.CreateRunnerScaleSet(ctx, &scaleset.RunnerScaleSet{Name: scaleSetName, RunnerGroupID: group.ID, Labels: labels, RunnerSetting: scaleset.RunnerSetting{DisableUpdate: false}})
		if err != nil {
			return nil, err
		}
	}
	if ss.ID <= 0 || ss.Name != scaleSetName || ss.RunnerGroupID != group.ID || ss.RunnerSetting.DisableUpdate {
		return nil, errors.New("scale set identity/group/update policy mismatch")
	}
	labels := make([]string, len(ss.Labels))
	for i, label := range ss.Labels {
		labels[i] = label.Name
	}
	if !sameLabels(labels, requiredLabels) {
		return nil, errors.New("scale set does not preserve all four labels")
	}
	old := j.snapshot().ScaleSetID
	if old != 0 && old != ss.ID {
		return nil, errors.New("owned scale set changed; retain prior ownership")
	}
	return ss, j.update(func(s *state) error { s.ScaleSetID = ss.ID; return nil })
}

func sameLabels(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for _, want := range expected {
		count := 0
		for _, got := range actual {
			if got == want {
				count++
			}
		}
		if count != 1 {
			return false
		}
	}
	return true
}

type deadlineClient struct{ *scaleset.MessageSessionClient }

func (c deadlineClient) DeleteMessage(ctx context.Context, id int) error {
	ackCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return c.MessageSessionClient.DeleteMessage(ackCtx, id)
}
