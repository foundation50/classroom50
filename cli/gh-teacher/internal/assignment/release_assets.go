package assignment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// This file holds the release_assets validator and its supporting helpers,
// split out of assignments_json.go to keep that file under the size limit.
// release_assets is an ordered list of exact workspace-relative files the
// autograde runner attaches to each submission Release; the paths are
// hand-editable/untrusted, so every reader re-validates. Hand-mirrored across
// the JSON schema, runner.py, the workflow inline validator, and the web TS
// validator — keep them in lockstep (see AGENTS.md cross-tool contracts).

const (
	releaseAssetsCap          = 50
	releaseAssetsMaxPathBytes = 8 * 1024
)

var releaseAssetBasenamePattern = regexp.MustCompile(
	`^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_-])?$`,
)

func equalFoldASCII(value, lowercaseASCII string) bool {
	if len(value) != len(lowercaseASCII) {
		return false
	}
	for i := range value {
		char := value[i]
		if char >= 'A' && char <= 'Z' {
			char += 'a' - 'A'
		}
		if char != lowercaseASCII[i] {
			return false
		}
	}
	return true
}

// ValidateReleaseAssets rejects unsafe or ambiguous exact Release-asset
// paths. A nil or empty list disables the feature.
func ValidateReleaseAssets(paths []string) error {
	if len(paths) > releaseAssetsCap {
		return fmt.Errorf("release_assets has %d paths (max %d)", len(paths), releaseAssetsCap)
	}
	totalPathBytes := 0
	for _, configuredPath := range paths {
		totalPathBytes += len(configuredPath)
	}
	if totalPathBytes > releaseAssetsMaxPathBytes {
		return fmt.Errorf("release_assets paths total %d bytes (max %d)", totalPathBytes, releaseAssetsMaxPathBytes)
	}
	seenPaths := make(map[string]struct{}, len(paths))
	seenBasenames := make(map[string]struct{}, len(paths))
	for i, configuredPath := range paths {
		if strings.TrimSpace(configuredPath) == "" {
			return fmt.Errorf("release_assets[%d] must not be empty", i)
		}
		if strings.HasPrefix(configuredPath, "/") ||
			(len(configuredPath) >= 2 && configuredPath[1] == ':' &&
				((configuredPath[0] >= 'A' && configuredPath[0] <= 'Z') ||
					(configuredPath[0] >= 'a' && configuredPath[0] <= 'z'))) {
			return fmt.Errorf("release_assets[%d] %q must be relative", i, configuredPath)
		}
		if strings.Contains(configuredPath, `\`) {
			return fmt.Errorf("release_assets[%d] %q must use '/' separators", i, configuredPath)
		}
		if strings.IndexFunc(configuredPath, unicode.IsControl) >= 0 {
			return fmt.Errorf("release_assets[%d] %q must not contain controls", i, configuredPath)
		}
		segments := strings.Split(configuredPath, "/")
		for _, segment := range segments {
			if segment == "" || segment == "." || segment == ".." {
				return fmt.Errorf("release_assets[%d] %q has invalid path segment %q", i, configuredPath, segment)
			}
		}
		if equalFoldASCII(segments[0], ".git") {
			return fmt.Errorf("release_assets[%d] %q must not select the root .git tree", i, configuredPath)
		}
		basename := segments[len(segments)-1]
		if !releaseAssetBasenamePattern.MatchString(basename) || strings.Contains(basename, "..") {
			return fmt.Errorf("release_assets[%d] basename %q is not Release-safe", i, basename)
		}
		if equalFoldASCII(basename, contract.ResultFilename) || equalFoldASCII(basename, contract.ReleaseBodyFilename) {
			return fmt.Errorf("release_assets[%d] basename %q is reserved", i, basename)
		}
		if _, exists := seenPaths[configuredPath]; exists {
			return fmt.Errorf("release_assets[%d] duplicates path %q", i, configuredPath)
		}
		if _, exists := seenBasenames[basename]; exists {
			return fmt.Errorf("release_assets[%d] duplicates basename %q", i, basename)
		}
		seenPaths[configuredPath] = struct{}{}
		seenBasenames[basename] = struct{}{}
	}
	return nil
}

// rejectUnpairedReleaseAssetSurrogates fails when any release_assets element
// carries an unpaired UTF-16 surrogate escape. Runs on the raw JSON before the
// typed decode (which would silently replace an unpaired surrogate with U+FFFD)
// so the schema's surrogate rejection is enforced byte-for-byte on the wire.
func rejectUnpairedReleaseAssetSurrogates(raw json.RawMessage) error {
	var paths []json.RawMessage
	if err := json.Unmarshal(raw, &paths); err != nil {
		return nil // The typed decode below reports malformed release_assets.
	}
	for i, path := range paths {
		if hasUnpairedJSONSurrogate(bytes.TrimSpace(path)) {
			return fmt.Errorf("release_assets[%d] must not contain unpaired Unicode surrogates", i)
		}
	}
	return nil
}

func hasUnpairedJSONSurrogate(raw []byte) bool {
	if len(raw) < 2 || raw[0] != '"' {
		return false
	}
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw)-1 || raw[i] != 'u' {
			continue
		}
		value, ok := parseJSONUnicodeEscape(raw, i)
		if !ok {
			continue // The JSON decoder reports malformed escapes.
		}
		switch {
		case value >= 0xD800 && value <= 0xDBFF:
			nextSlash := i + 5
			if nextSlash >= len(raw)-1 || raw[nextSlash] != '\\' || raw[nextSlash+1] != 'u' {
				return true
			}
			low, ok := parseJSONUnicodeEscape(raw, nextSlash+1)
			if !ok || low < 0xDC00 || low > 0xDFFF {
				return true
			}
			i = nextSlash + 5
		case value >= 0xDC00 && value <= 0xDFFF:
			return true
		default:
			i += 4
		}
	}
	return false
}

func parseJSONUnicodeEscape(raw []byte, u int) (uint64, bool) {
	if u+5 > len(raw) || raw[u] != 'u' {
		return 0, false
	}
	value, err := strconv.ParseUint(string(raw[u+1:u+5]), 16, 16)
	return value, err == nil
}
