//go:build !windows && !darwin

package platform

func StartupStatus(configDir string) (StartupState, error) { return startupUnsupported(), nil }
func SetStartupEnabled(configDir string, enabled bool) (StartupState, error) {
	return startupUnsupported(), ErrStartupUnsupported
}
func OpenStartupSettings() error                        { return ErrStartupUnsupported }
func RefreshStartupRegistration(configDir string) error { return nil }
