package main

import (
	"os"
	"strconv"
	"testing"
	"time"
)

func TestWindowsCredentialScope(t *testing.T) {
	if os.Getenv("CURRENTMUSIC_TEST_CREDENTIALS") != "1" {
		t.Skip("enable temporary Windows Credential Manager fixture with CURRENTMUSIC_TEST_CREDENTIALS=1")
	}
	store := windowsCredentials{}
	base := "https://credential-fixture-" + strconv.FormatInt(time.Now().UnixNano(), 10) + ".invalid/cm"
	t.Cleanup(func() {
		if err := store.remove(base, 1); err != nil {
			t.Error(err)
		}
	})
	const token = "credential-fixture-value"
	if err := store.save(base, 1, token); err != nil {
		t.Fatal(err)
	}
	if got, err := store.load(base, 1); err != nil || got != token {
		t.Fatalf("credential round trip failed: %v", err)
	}
	if got, err := store.load(base, 2); err != nil || got != "" {
		t.Fatalf("different account saw a credential: %v", err)
	}
	if got, err := store.load(base+"/mirror", 1); err != nil || got != "" {
		t.Fatalf("different API path saw a credential: %v", err)
	}
	if err := store.remove(base, 1); err != nil {
		t.Fatal(err)
	}
	if got, err := store.load(base, 1); err != nil || got != "" {
		t.Fatalf("credential remained after deletion: %v", err)
	}
}
