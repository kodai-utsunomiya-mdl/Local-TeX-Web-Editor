//go:build darwin

package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

// AppKit supplies the native folder dialog. JXA is part of macOS and does not
// ask for permission to control Finder or System Events.
const macFolderDialogScript = `
ObjC.import('AppKit');
function run(argv) {
  var application = $.NSApplication.sharedApplication;
  application.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  application.activateIgnoringOtherApps(true);
  var panel = $.NSOpenPanel.openPanel;
  panel.title = argv[0];
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.allowsMultipleSelection = false;
  panel.canCreateDirectories = true;
  panel.resolvesAliases = true;
  if (panel.runModal == $.NSModalResponseOK) return JSON.stringify(ObjC.unwrap(panel.URL.path));
  return JSON.stringify('');
}`

const macActivateDialogScript = `
ObjC.import('AppKit');
function run(argv) {
  var application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  application.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
}`

func showNativeFolderDialog(request *folderPickRequest) (string, error) {
	if err := request.ctx.Err(); err != nil {
		return "", err
	}
	title := messages.Text(messages.LanguageFromContext(request.ctx), "TeX のプロジェクトフォルダーを選択")
	command := exec.CommandContext(request.ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", macFolderDialogScript, title)
	var output, errors bytes.Buffer
	command.Stdout, command.Stderr = &output, &errors
	if err := command.Start(); err != nil {
		return "", messages.Errorf("フォルダーの選択画面を開けません: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	for {
		select {
		case <-request.focus:
			focusContext, cancel := context.WithTimeout(request.ctx, 2*time.Second)
			_ = exec.CommandContext(focusContext, "/usr/bin/osascript", "-l", "JavaScript", "-e", macActivateDialogScript, strconv.Itoa(command.Process.Pid)).Run()
			cancel()
		case err := <-done:
			if request.ctx.Err() != nil {
				return "", request.ctx.Err()
			}
			if err != nil {
				return "", messages.Errorf("フォルダーの選択画面を開けません: %s (%w)", strings.TrimSpace(errors.String()), err)
			}
			var path string
			if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &path); err != nil {
				return "", messages.Errorf("選択したフォルダーを取得できません: %w", err)
			}
			return path, nil
		}
	}
}
