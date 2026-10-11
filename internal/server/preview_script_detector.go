package server

import (
	"html"
	"strings"
)

const (
	scriptScanLimit = 16 << 20
	scriptTagLimit  = 16 << 10
)

// A bounded streaming hint, not an HTML sanitizer or a security parser.
// Only markup is retained: even a multi-megabyte JSON script body is skipped
// using the raw-text closing-tag matcher, without accumulating its contents.
type scriptDetector struct {
	seen      int
	present   bool
	unknown   bool
	stopped   bool
	oversized bool
	tag       []byte
	quote     byte
	comment   uint32
	inComment bool
	raw       string
	match     int
	plaintext bool
}

func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

func htmlSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'
}

func (d *scriptDetector) feed(data []byte) {
	for _, c := range data {
		if d.present || d.stopped {
			return
		}
		d.seen++
		if d.seen > scriptScanLimit || c == 0 {
			d.unknown = true
			d.stopped = true
			return
		}
		if d.plaintext {
			continue
		}
		if d.inComment {
			d.comment = d.comment<<8 | uint32(c)
			if d.comment&0xffffff == 0x2d2d3e || d.comment == 0x2d2d213e { // --> or --!>
				d.inComment = false
				d.comment = 0
			}
			continue
		}
		if d.raw != "" && len(d.tag) == 0 {
			end := d.raw
			if d.match == len(end) {
				d.match = 0
				if htmlSpace(c) || c == '/' || c == '>' {
					d.tag = append(d.tag[:0], end...)
					d.raw = ""
					d.tagByte(c)
					continue
				}
			}
			if lowerASCII(c) == end[d.match] {
				d.match++
			} else if c == '<' {
				d.match = 1
			} else {
				d.match = 0
			}
			continue
		}
		if len(d.tag) == 0 {
			if c == '<' {
				d.tag = append(d.tag, c)
			}
			continue
		}
		d.tagByte(c)
	}
}

func (d *scriptDetector) tagByte(c byte) {
	if len(d.tag) >= scriptTagLimit {
		d.unknown = true
		d.oversized = true
	}
	if !d.oversized {
		d.tag = append(d.tag, c)
	}
	if len(d.tag) == 4 && string(d.tag) == "<!--" {
		d.tag = d.tag[:0]
		d.inComment = true
		return
	}
	if d.quote != 0 {
		if c == d.quote {
			d.quote = 0
		}
		return
	}
	if c == '"' || c == '\'' {
		d.quote = c
	} else if c == '>' {
		tag := d.tag[1:]
		if !d.oversized {
			tag = tag[:len(tag)-1]
		}
		d.inspectTag(string(tag), !d.oversized)
		d.tag = d.tag[:0]
		d.oversized = false
	}
}

func (d *scriptDetector) inspectTag(tag string, complete bool) {
	if tag == "" || tag[0] == '/' || tag[0] == '!' || tag[0] == '?' {
		return
	}
	end := 0
	for end < len(tag) && !htmlSpace(tag[end]) && tag[end] != '/' {
		end++
	}
	name := strings.ToLower(tag[:end])
	if !complete {
		// Only the prefix was retained. Preserve the raw-text context so a
		// later tag can establish that scripts exist without matching inert text.
		d.rawText(name)
		return
	}
	attrs := scriptAttributes(tag[end:])
	if name == "script" {
		if executableScript(attrs) {
			d.present = true
		} else {
			d.raw = "</" + name
		}
		return
	}
	for name, value := range attrs {
		if len(name) > 2 && strings.HasPrefix(name, "on") && strings.TrimSpace(value) != "" {
			d.present = true
			return
		}
		switch name {
		case "href", "src", "action", "formaction", "xlink:href":
			// URL parsing removes ASCII tabs/newlines, including entity escapes.
			value = strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(value)
			value = strings.TrimLeftFunc(value, func(r rune) bool { return r <= ' ' })
			if strings.HasPrefix(strings.ToLower(value), "javascript:") {
				d.present = true
				return
			}
		}
	}
	d.rawText(name)
}

func (d *scriptDetector) rawText(name string) {
	switch name {
	case "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noscript":
		d.raw = "</" + name
	case "plaintext":
		d.plaintext = true
	}
}

func scriptAttributes(text string) map[string]string {
	attrs := make(map[string]string)
	for len(text) > 0 {
		text = strings.TrimLeft(text, " \t\r\n\f/")
		if text == "" {
			break
		}
		end := 0
		for end < len(text) && !htmlSpace(text[end]) && text[end] != '=' && text[end] != '/' {
			end++
		}
		if end == 0 {
			// Malformed attributes do not cause a loop.
			text = text[1:]
			continue
		}
		name := strings.ToLower(text[:end])
		text = strings.TrimLeft(text[end:], " \t\r\n\f")
		value := ""
		if strings.HasPrefix(text, "=") {
			text = strings.TrimLeft(text[1:], " \t\r\n\f")
			if len(text) > 0 && (text[0] == '"' || text[0] == '\'') {
				quote := text[0]
				text = text[1:]
				end = strings.IndexByte(text, quote)
				if end < 0 {
					end = len(text)
				}
				value, text = text[:end], text[end:]
				if text != "" {
					text = text[1:]
				}
			} else {
				end = 0
				for end < len(text) && !htmlSpace(text[end]) {
					end++
				}
				value, text = text[:end], text[end:]
			}
		}
		if _, exists := attrs[name]; !exists {
			attrs[name] = html.UnescapeString(value)
		}
	}
	return attrs
}

func executableScript(attrs map[string]string) bool {
	value, typed := attrs["type"]
	if !typed {
		if language := attrs["language"]; language != "" {
			value = "text/" + language
		}
	}
	switch strings.ToLower(strings.Trim(value, " \t\r\n\f")) {
	case "", "module",
		"application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
		"text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
		"text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
		"text/x-ecmascript", "text/x-javascript":
		return true
	}
	return false
}

func (d *scriptDetector) result() string {
	if d.present {
		return "present"
	}
	if d.unknown || len(d.tag) != 0 || d.inComment || d.raw != "" {
		return "unknown"
	}
	return "absent"
}
