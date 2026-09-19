package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResolveConfigRepoBranch(t *testing.T) {
	newServer := func(t *testing.T, handler http.HandlerFunc) *httptest.Server {
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		return server
	}

	t.Run("returns the config repo's actual default branch (master)", func(t *testing.T) {
		server := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "master"})
		})
		got, err := resolveConfigRepoBranch(newTestRESTClient(t, server), "o")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "master" {
			t.Errorf("got %q, want master", got)
		}
	})

	t.Run("empty default_branch falls back to main", func(t *testing.T) {
		server := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": ""})
		})
		got, err := resolveConfigRepoBranch(newTestRESTClient(t, server), "o")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "main" {
			t.Errorf("got %q, want main", got)
		}
	})

	t.Run("a read failure is returned as an error (never a silent main)", func(t *testing.T) {
		server := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})
		_, err := resolveConfigRepoBranch(newTestRESTClient(t, server), "o")
		if err == nil {
			t.Fatal("expected an error on a failed config-repo read")
		}
	})
}
