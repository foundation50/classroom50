// Package cliutil holds cross-cutting CLI helpers that aren't domain logic:
// the HTTP-status and rate-limit classifiers (including the Retry-After wait
// hint) and the exit-code carrier main() maps to a process status. It gives
// per-domain files a small named seam instead of one flat
// package main namespace, and stays free of GitHub-API types (the transport
// seam lives in internal/githubapi).
package cliutil
