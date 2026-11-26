package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

func randomLoopbackAddress() *net.TCPAddr { return &net.TCPAddr{IP: net.ParseIP("127.0.0.1")} }

func TestBrowserConnectionReusesAddressAndAuthenticationAfterRestart(t *testing.T) {
	directory := t.TempDir()
	first, err := listenForBrowser(directory, randomLoopbackAddress())
	if err != nil {
		t.Fatal(err)
	}
	address, token := first.listener.Addr().String(), first.token
	first.listener.Close()
	second, err := listenForBrowser(directory, randomLoopbackAddress())
	if err != nil {
		t.Fatal(err)
	}
	defer second.listener.Close()
	if second.listener.Addr().String() != address || second.token != token || second.notice != nil {
		t.Fatal("the restored browser would use a different address or key")
	}
	info, err := os.Stat(filepath.Join(directory, "connection.json"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("connection permissions = %o", info.Mode().Perm())
	}
}

func TestBrowserConnectionExplainsPortConflictAndRecordsNewAddress(t *testing.T) {
	directory := t.TempDir()
	first, err := listenForBrowser(directory, randomLoopbackAddress())
	if err != nil {
		t.Fatal(err)
	}
	defer first.listener.Close()
	second, err := listenForBrowser(directory, randomLoopbackAddress())
	if err != nil {
		t.Fatal(err)
	}
	defer second.listener.Close()
	if first.listener.Addr().String() == second.listener.Addr().String() || first.token == second.token || second.notice == nil {
		t.Fatal("the occupied address was not replaced with a usable connection")
	}
	text := messages.ErrorText("en", second.notice)
	for _, want := range []string{"previous address", first.listener.Addr().String(), second.listener.Addr().String()} {
		if !strings.Contains(text, want) {
			t.Fatalf("notice = %q", text)
		}
	}
	saved, err := readBrowserConnection(filepath.Join(directory, "connection.json"))
	if err != nil || saved.Address != second.listener.Addr().String() {
		t.Fatal("the next launch would use the occupied address")
	}
}

func TestExplicitBrowserAddressIsNotChangedWhenInUse(t *testing.T) {
	directory := t.TempDir()
	occupied, err := net.ListenTCP("tcp", randomLoopbackAddress())
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	_, err = listenForBrowser(directory, occupied.Addr().(*net.TCPAddr))
	if err == nil {
		t.Fatal("an explicit --listen address was silently replaced")
	}
	if _, err := os.Stat(filepath.Join(directory, "connection.json")); !os.IsNotExist(err) {
		t.Fatal("an unusable connection was saved")
	}
}

func TestBrowserConnectionRepairsIncompleteRecord(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "connection.json")
	if err := os.WriteFile(file, []byte(`{"format":1,"address":`), 0600); err != nil {
		t.Fatal(err)
	}
	connection, err := listenForBrowser(directory, randomLoopbackAddress())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.listener.Close()
	if connection.notice == nil {
		t.Fatal("the browser did not receive the replacement connection notice")
	}
	saved, err := readBrowserConnection(file)
	if err != nil || saved.Token != connection.token || !validBrowserConnection(saved) {
		t.Fatal("the incomplete connection was not repaired")
	}
}

func TestBrowserConnectionDoesNotOverwriteLinkedFile(t *testing.T) {
	directory := t.TempDir()
	other := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(other, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(directory, "connection.json")); err != nil {
		t.Skipf("cannot create a symbolic link: %v", err)
	}
	if _, err := listenForBrowser(directory, randomLoopbackAddress()); err == nil {
		t.Fatal("a linked connection file was accepted")
	}
	if data, err := os.ReadFile(other); err != nil || string(data) != "untouched" {
		t.Fatal("the linked file changed")
	}
}

func TestBrowserConnectionRejectsInvalidSavedAddresses(t *testing.T) {
	for _, address := range []string{"0.0.0.0:1234", "example.com:1234", "127.0.0.1:0", "127.0.0.1:-1", "127.0.0.1:65536", "127.0.0.1:bad", "localhost:1234"} {
		value := savedBrowserConnection{Format: 1, Address: address, Token: strings.Repeat("a", 64)}
		if validBrowserConnection(value) {
			t.Errorf("accepted %q", address)
		}
	}
	data, _ := json.Marshal(savedBrowserConnection{Format: 1, Address: "127.0.0.1:1234", Token: strings.Repeat("a", 64)})
	file := filepath.Join(t.TempDir(), "connection.json")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBrowserConnection(file); err != nil {
		t.Fatal(err)
	}
}
