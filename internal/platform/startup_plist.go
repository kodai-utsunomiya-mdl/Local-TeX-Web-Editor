package platform

import (
	"bytes"
	"encoding/xml"
	"path"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"
)

func startupLaunchAgent(executable string) []byte {
	var escaped bytes.Buffer
	_ = xml.EscapeText(&escaped, []byte(executable))
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>` + startupAgentLabel + `</string>
  <key>ProgramArguments</key><array><string>` + escaped.String() + `</string><string>` + startupArgument + `</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>AssociatedBundleIdentifiers</key><array><string>io.github.kodai-utsunomiya-mdl.local-tex-editor</string></array>
</dict></plist>
`)
}

type startupPlistElement struct {
	XMLName  xml.Name
	Text     string                `xml:",chardata"`
	Children []startupPlistElement `xml:",any"`
}

func startupLaunchAgentExecutable(data []byte) (string, error) {
	var plist startupPlistElement
	if len(data) > 1<<20 || xml.Unmarshal(data, &plist) != nil || plist.XMLName.Local != "plist" || len(plist.Children) != 1 || plist.Children[0].XMLName.Local != "dict" {
		return "", ErrStartupConflict
	}
	entries := plist.Children[0].Children
	if len(entries)%2 != 0 {
		return "", ErrStartupConflict
	}
	values := map[string]startupPlistElement{}
	for index := 0; index < len(entries); index += 2 {
		if entries[index].XMLName.Local != "key" {
			return "", ErrStartupConflict
		}
		key := entries[index].Text
		if _, exists := values[key]; exists {
			return "", ErrStartupConflict
		}
		values[key] = entries[index+1]
	}
	label, arguments := values["Label"], values["ProgramArguments"]
	if label.XMLName.Local != "string" || label.Text != startupAgentLabel || arguments.XMLName.Local != "array" || len(arguments.Children) != 2 || values["RunAtLoad"].XMLName.Local != "true" {
		return "", ErrStartupConflict
	}
	for _, argument := range arguments.Children {
		if argument.XMLName.Local != "string" || len(argument.Children) != 0 {
			return "", ErrStartupConflict
		}
	}
	executable := arguments.Children[0].Text
	if !validStartupMacExecutable(executable) || !validStartupArgument(arguments.Children[1].Text) {
		return "", ErrStartupConflict
	}
	return executable, nil
}

func validStartupMacExecutable(executable string) bool {
	name := path.Base(executable)
	return path.IsAbs(executable) && (name == branding.ExecutableName || name == "LocalTeXWebEditor") &&
		strings.HasSuffix(path.Dir(executable), ".app/Contents/MacOS")
}
