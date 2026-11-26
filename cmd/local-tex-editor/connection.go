package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type savedBrowserConnection struct {
	Format  int    `json:"format"`
	Address string `json:"address"`
	Token   string `json:"token"`
}

type browserConnection struct {
	listener *net.TCPListener
	token    string
	notice   error
}

func validBrowserConnection(value savedBrowserConnection) bool {
	host, port, err := net.SplitHostPort(value.Address)
	ip := net.ParseIP(host)
	number, portErr := strconv.Atoi(port)
	key, keyErr := hex.DecodeString(value.Token)
	return value.Format == 1 && err == nil && ip != nil && ip.IsLoopback() && portErr == nil && number > 0 && number <= 65535 && keyErr == nil && len(key) == 32
}

func readBrowserConnection(path string) (savedBrowserConnection, error) {
	var result savedBrowserConnection
	info, err := os.Lstat(path)
	if err != nil {
		return result, err
	}
	regular, err := platform.IsRegularFile(path, info)
	if err != nil || !regular || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4096 {
		return result, errors.New("invalid browser connection file")
	}
	file, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return result, errors.New("browser connection changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) > 4096 || json.Unmarshal(data, &result) != nil || !validBrowserConnection(result) {
		return savedBrowserConnection{}, errors.New("invalid browser connection data")
	}
	return result, nil
}

func saveBrowserConnection(path string, value savedBrowserConnection) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".connection-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return platform.ReplaceFile(file.Name(), path)
}

// The application lock is held by the caller. Reusing one address and key lets
// a restored browser tab connect after the process or the computer restarts.
func listenForBrowser(configDir string, requested *net.TCPAddr) (*browserConnection, error) {
	path := filepath.Join(configDir, "connection.json")
	saved, readErr := readBrowserConnection(path)
	var notice error
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		// A fresh key also lets a normal launch repair an incomplete record left
		// by an interrupted installation, without reusing unverified input.
		if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
			return nil, fmt.Errorf("could not read browser connection: %w", readErr)
		}
		notice = messages.Label("ブラウザの接続情報を作り直しました．以前のタブを閉じ，この画面を使ってください．")
	}
	address := *requested
	if readErr == nil && requested.Port == 0 {
		previous, err := net.ResolveTCPAddr("tcp", saved.Address)
		if err == nil && previous.IP.Equal(requested.IP) {
			address = *previous
		}
	}
	listener, err := net.ListenTCP("tcp", &address)
	if err != nil && requested.Port == 0 && address.Port != 0 {
		// A different local application may have claimed the old port. Keep the
		// editor usable and explain the new address in the page that opens.
		listener, err = net.ListenTCP("tcp", requested)
		if err == nil {
			notice = messages.Errorf("以前の接続先 %s が使用中のため，%s で開きました．以前のタブを閉じ，この画面を使ってください．ブックマークもこのアドレスへ更新できます．", "http://"+address.String()+"/", "http://"+listener.Addr().String()+"/")
		}
	}
	if err != nil {
		return nil, fmt.Errorf("could not start the local server: %w", err)
	}
	value := savedBrowserConnection{Format: 1, Address: listener.Addr().String(), Token: saved.Token}
	if readErr != nil || value.Address != saved.Address {
		secret := make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			listener.Close()
			return nil, err
		}
		value.Token = hex.EncodeToString(secret)
	}
	if value != saved || readErr != nil {
		if err := saveBrowserConnection(path, value); err != nil {
			listener.Close()
			return nil, fmt.Errorf("could not save browser connection: %w", err)
		}
	}
	return &browserConnection{listener: listener, token: value.Token, notice: notice}, nil
}
