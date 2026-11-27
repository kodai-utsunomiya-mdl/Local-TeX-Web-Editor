package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/app"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/updater"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/web"
)

var version = "development"
var noBrowser bool

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		if !noBrowser {
			platform.ShowError(err.Error())
		}
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) == 3 && os.Args[1] == "--apply-app-update" {
		noBrowser = true
		return updater.RunInstaller(os.Args[2])
	}
	project := flag.String("project", "", "TeX project folder")
	texBin := flag.String("tex-bin", "", "TeX Live executables folder")
	listen := flag.String("listen", "127.0.0.1:0", "loopback address to listen on")
	flag.BoolVar(&noBrowser, "no-browser", false, "do not open a browser automatically")
	background := flag.Bool("background", false, "start for restored browser tabs without opening a window")
	readyFile := flag.String("ready-file", "", "write server information to this file")
	configDir := flag.String("config-dir", "", "application settings and cache folder")
	showVersion := flag.Bool("version", false, "show application version")
	flag.Parse()
	if *background {
		noBrowser = true
	}
	if *showVersion {
		fmt.Println(version)
		return nil
	}
	if *project == "" && flag.NArg() == 1 {
		*project = flag.Arg(0)
	}
	address, err := net.ResolveTCPAddr("tcp", *listen)
	if err != nil || address.IP == nil || !address.IP.IsLoopback() {
		return errors.New("--listen must use a loopback IP address, for example 127.0.0.1:0")
	}
	var importFrom string
	if *configDir == "" {
		directories, err := platform.DefaultConfigDirectories()
		if err != nil {
			return err
		}
		*configDir, importFrom = directories.Directory, directories.ImportFrom
	}
	*configDir, err = filepath.Abs(*configDir)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(*configDir, 0700); err != nil {
		return err
	}
	runContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stopSignals()
	releaseInstance, update, err := acquireStartupInstance(runContext, *configDir, *readyFile, noBrowser, platform.OpenBrowser)
	if *background && errors.Is(err, platform.ErrLocked) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("アプリを起動できません: %w", err)
	}
	if releaseInstance == nil {
		return nil
	}
	defer releaseInstance()
	if update != nil {
		defer update.Close()
	}
	if importFrom != "" {
		if err := app.ImportLegacySettings(importFrom, *configDir); err != nil {
			return fmt.Errorf("could not import settings from the ZIP version: %w", err)
		}
	}
	connection, err := listenForBrowser(*configDir, address)
	if err != nil {
		return err
	}
	listener := connection.listener
	defer listener.Close()
	token := connection.token
	quit := make(chan struct{})
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(func() { close(quit) }) }
	application, err := app.New(app.Options{ConfigDir: *configDir, ProjectPath: *project, TexBin: *texBin, Token: token, Version: version, Shutdown: stop, InstallationError: connection.notice})
	if err != nil {
		return err
	}
	defer application.Close()
	host := listener.Addr().String()
	application.SetAddress(host)
	url := "http://" + host + "/"
	mux := http.NewServeMux()
	mux.Handle("/api/", application.Handler())
	mux.Handle("/", staticFiles(host, web.Files()))
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	ready := map[string]any{"url": url, "token": token, "pid": os.Getpid(), "version": version}
	data, _ := json.Marshal(ready)
	instanceFile := filepath.Join(*configDir, "active.json")
	if err = os.WriteFile(instanceFile, append(data, '\n'), 0600); err != nil {
		return err
	}
	defer os.Remove(instanceFile)
	if *readyFile != "" {
		if err = os.MkdirAll(filepath.Dir(*readyFile), 0700); err != nil {
			return err
		}
		if err = os.WriteFile(*readyFile, append(data, '\n'), 0600); err != nil {
			return err
		}
		defer os.Remove(*readyFile)
	}
	fmt.Println(string(data))
	serveResult := make(chan error, 1)
	go func() { serveResult <- server.Serve(listener) }()
	application.StartAutomaticUpdates()
	if update != nil {
		if !update.Complete(url + "#token=" + token) {
			return nil
		}
	} else if !noBrowser {
		if err = platform.OpenBrowser(url + "#token=" + token); err != nil {
			return err
		}
	}
	if !noBrowser {
		application.StartInstallationUpdate(platform.RefreshInstalledShortcuts, func() error { return platform.RefreshStartupRegistration(*configDir) })
	} else if runtime.GOOS == "darwin" {
		application.StartInstallationUpdate(func() error { return platform.RefreshStartupRegistration(*configDir) })
	}
	select {
	case <-quit:
	case <-runContext.Done():
	case err = <-serveResult:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	application.CloseBrowserSessions()
	return shutdownServer(ctx, server)
}
