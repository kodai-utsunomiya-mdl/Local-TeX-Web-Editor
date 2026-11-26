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

const macSaveDialogScript = `
ObjC.import('AppKit');
function run(argv) {
  var application = $.NSApplication.sharedApplication;
  application.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  application.activateIgnoringOtherApps(true);
  var panel = $.NSSavePanel.savePanel;
  panel.title = argv[0];
  panel.nameFieldStringValue = argv[1];
  panel.canCreateDirectories = true;
  panel.extensionHidden = false;
  if (panel.runModal == $.NSModalResponseOK) return JSON.stringify(ObjC.unwrap(panel.URL.path));
  return JSON.stringify('');
}`

func showNativeSaveDialog(request *folderPickRequest, suggestedName string) (string, error) {
	if err := request.ctx.Err(); err != nil {
		return "", err
	}
	title := messages.Text(messages.LanguageFromContext(request.ctx), saveDialogTitle)
	command := exec.CommandContext(request.ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", macSaveDialogScript, title, suggestedName)
	var output, errorOutput bytes.Buffer
	command.Stdout, command.Stderr = &output, &errorOutput
	if err := command.Start(); err != nil {
		return "", messages.Errorf("保存先の選択画面を開けません: %w", err)
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
				return "", messages.Errorf("保存先の選択画面を開けません: %s (%w)", strings.TrimSpace(errorOutput.String()), err)
			}
			var path string
			if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &path); err != nil {
				return "", messages.Errorf("選択した保存先を取得できません: %w", err)
			}
			return path, nil
		}
	}
}
