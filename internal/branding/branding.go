// Package branding supplies the application's name and icon.
package branding

import _ "embed"

const Name = "Local TeX Web Editor"
const ExecutableName = "local-tex-web-editor"

// DataDirectoryName remains stable so settings, drafts, active instances and
// installed shortcuts from Local TeX Editor continue to work after the rename.
const DataDirectoryName = "LocalTeXEditor"

// Icon contains the same multi-resolution artwork used by the executable.
//
//go:embed app-icon.ico
var Icon []byte
