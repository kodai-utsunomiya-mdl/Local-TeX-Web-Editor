//go:build !windows

package platform

func CurrentPackageIdentity() (*PackageIdentity, error) { return nil, nil }

func DefaultConfigDirectories() (ConfigDirectories, error) {
	return unpackagedConfigDirectories()
}
