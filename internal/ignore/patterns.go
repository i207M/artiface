// Package ignore implements Artiface's display-only Browse filters.
package ignore

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	MaxContentBytes = 64 << 10
	maxPatterns     = 256
	maxPatternBytes = 1024
	maxMatchWork    = 128 << 20
)

// DefaultContent is also the syntax reference presented by the ignore editor.
// Empty content intentionally disables all ignore rules.
const DefaultContent = `# Artiface Browse filters (not full gitignore syntax).
# Blank lines and lines starting with # are ignored; outer whitespace is trimmed.
# Matching is case-sensitive; * and ? match within one path component.
# ** must be a whole component and matches across zero or more directory levels.
# A pattern without / matches a name at any depth.
# A leading / or an internal / anchors the pattern to each project root.
# A trailing / matches directories; ignored directories hide their descendants.
# No negation, escaping, character classes, or inline comments.
# Filters affect Browse only, never direct file access or the Add Folder chooser.
.git/
__pycache__/
node_modules/
.venv/
.pytest_cache/
.mypy_cache/
.ruff_cache/
*.pyc
*.pyo
.ipynb_checkpoints/
.cache/
.tox/
venv/
`

var ErrWorkLimit = errors.New("ignore pattern matching limit reached")

type rule struct {
	expression *regexp.Regexp
	cost       int
}

type Matcher struct {
	rules []rule
}

// Budget is shared by all path matches in one request, including filtered paths.
type Budget struct{ remaining int }

func NewBudget() *Budget { return &Budget{remaining: maxMatchWork} }

func Compile(content string) (*Matcher, error) {
	if len(content) > MaxContentBytes || !utf8.ValidString(content) {
		return nil, errors.New("ignore content must be UTF-8 and at most 64 KiB")
	}
	m := &Matcher{}
	for line, raw := range strings.Split(content, "\n") {
		pattern := strings.TrimSpace(raw)
		if pattern == "" || strings.HasPrefix(pattern, "#") {
			continue
		}
		if len(m.rules) >= maxPatterns || len(pattern) > maxPatternBytes {
			return nil, errors.New("ignore content allows at most 256 patterns of 1024 bytes each")
		}
		if strings.HasPrefix(pattern, "!") || strings.ContainsAny(pattern, `\[]`) ||
			strings.ContainsFunc(pattern, unicode.IsControl) {
			return nil, fmt.Errorf("ignore line %d: negation, escaping, character classes and control characters are unsupported", line+1)
		}
		directory := strings.HasSuffix(pattern, "/")
		anchored := strings.HasPrefix(pattern, "/")
		pattern = strings.TrimSuffix(strings.TrimPrefix(pattern, "/"), "/")
		anchored = anchored || strings.Contains(pattern, "/")
		parts := strings.Split(pattern, "/")
		normalized := make([]string, 0, len(parts))
		for _, part := range parts {
			if part == "**" && len(normalized) > 0 && normalized[len(normalized)-1] == "**" {
				continue
			}
			normalized = append(normalized, part)
		}
		parts = normalized
		var expression strings.Builder
		if anchored {
			expression.WriteString("^")
		} else {
			expression.WriteString("(?:^|/)")
		}
		for i, part := range parts {
			if part == "" || part == "." || part == ".." || strings.Contains(part, "**") && part != "**" {
				return nil, fmt.Errorf("ignore line %d: use nonempty path components and ** only as a whole component", line+1)
			}
			if part == "**" {
				if i < len(parts)-1 {
					expression.WriteString("(?:[^/]+/)*")
				} else if directory && i > 0 {
					expression.WriteString("(?:/[^/]+)*")
				} else if directory {
					expression.WriteString("[^/]+(?:/[^/]+)*")
				} else {
					expression.WriteString(".*")
				}
				continue
			}
			for _, char := range part {
				switch char {
				case '*':
					expression.WriteString("[^/]*")
				case '?':
					expression.WriteString("[^/]")
				default:
					expression.WriteString(regexp.QuoteMeta(string(char)))
				}
			}
			if i < len(parts)-1 && !(directory && i == len(parts)-2 && parts[i+1] == "**") {
				expression.WriteString("/")
			}
		}
		if directory {
			expression.WriteString("/")
		} else {
			expression.WriteString("(?:/|$)")
		}
		re, err := regexp.Compile(expression.String())
		if err != nil {
			return nil, fmt.Errorf("ignore line %d: invalid pattern", line+1)
		}
		m.rules = append(m.rules, rule{expression: re, cost: len(expression.String()) + 1})
	}
	return m, nil
}

// Ignored matches a project-relative path and its directory ancestors.
// Directory rules need a slash, so a regular file named ".git" remains visible.
// RE2 avoids backtracking; the shared budget bounds aggregate matching work.
func (m *Matcher) Ignored(rel string, directory bool, budget *Budget) (bool, error) {
	if rel == "" {
		return false, nil
	}
	if directory {
		rel += "/"
	}
	for _, rule := range m.rules {
		if len(rel) > 64<<10 || rule.cost > budget.remaining/(len(rel)+1) {
			return false, ErrWorkLimit
		}
		budget.remaining -= rule.cost * (len(rel) + 1)
		if rule.expression.MatchString(rel) {
			return true, nil
		}
	}
	return false, nil
}
