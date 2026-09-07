package configrepo

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// PagesBaseURLPattern bounds a classroom's custom Pages base URL, compiled from
// the single-sourced contract.PagesBaseURLPattern.
var PagesBaseURLPattern = regexp.MustCompile(contract.PagesBaseURLPattern)

// ValidatePagesBaseURL checks a custom Pages base URL (classroom.json /
// team-description `pages_base_url`): https, no whitespace/query/fragment (the
// pattern), plus the normalized-form invariants the pattern can't express — no
// trailing slash (URL builders append `/<classroom>/...`) and no userinfo.
// Empty is rejected; callers allowing "no custom domain" branch on emptiness
// first. Mirrors the web's isValidPagesBaseUrl — keep in lockstep.
func ValidatePagesBaseURL(base string) error {
	if !PagesBaseURLPattern.MatchString(base) {
		return fmt.Errorf("invalid pages_base_url %q: must be %s", base, contract.PagesBaseURLPatternDescription)
	}
	if strings.HasSuffix(base, "/") {
		return fmt.Errorf("invalid pages_base_url %q: must not end with a trailing slash", base)
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil {
		return fmt.Errorf("invalid pages_base_url %q: must be %s", base, contract.PagesBaseURLPatternDescription)
	}
	return nil
}
