package main

import (
	"context"
	"strings"

	"github.com/google/go-github/v88/github"
)

func resolveFiles(ctx context.Context, api *github.Client, sha string) ([]sourceFile, error) {
	tree, _, err := api.Git.GetTree(ctx, "fitchmultz", "pi-subagents", sha, true)
	if err != nil {
		return nil, err
	}
	if tree.GetSHA() != sha || tree.Truncated == nil || tree.GetTruncated() || len(tree.Entries) == 0 || len(tree.Entries) > 10000 {
		return nil, retained("immutable source tree missing/truncated/oversized")
	}
	files := make([]sourceFile, 0, len(tree.Entries))
	seen := make(map[string]bool)
	for _, entry := range tree.Entries {
		name := entry.GetPath()
		if !safeSourcePath(name) || seen[name] || !objectID.MatchString(entry.GetSHA()) {
			return nil, retained("unsafe or duplicate source tree path/object")
		}
		seen[name] = true
		if entry.GetType() == "tree" && entry.GetMode() == "040000" {
			continue
		}
		if entry.GetType() != "blob" || (entry.GetMode() != "100644" && entry.GetMode() != "100755" && entry.GetMode() != "120000") {
			return nil, retained("unsupported Git source mode/gitlink")
		}
		files = append(files, sourceFile{Path: name, Mode: entry.GetMode(), SHA: entry.GetSHA()})
	}
	return files, nil
}

// safeSourcePath matches the native freeze manifest: no empty, ".", ".." or
// ".git" component anywhere and no control/backslash bytes in framing.
func safeSourcePath(name string) bool {
	if len(name) == 0 || len(name) >= 4096 || strings.ContainsFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f || r == '\\' }) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || part == ".git" {
			return false
		}
	}
	return true
}
