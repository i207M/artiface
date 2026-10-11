package config

import (
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Origins returns the public application and preview URL origins.
// Explicit origins affect request validation, independently of listener addresses.
func (c Config) Origins() (app, preview string) {
	app = canonicalOrigin("http://" + c.Listen)
	if c.AppOrigin != "" {
		app = canonicalOrigin(c.AppOrigin)
	}
	preview = app
	if c.PreviewOrigin != "" {
		preview = canonicalOrigin(c.PreviewOrigin)
	}
	return app, preview
}

func canonicalOrigin(origin string) string {
	u, _ := url.Parse(origin)
	host := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	}
	if port := u.Port(); port != "" && !(u.Scheme == "https" && port == "443" || u.Scheme == "http" && port == "80") {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u.Scheme + "://" + host
}

func validateOrigins(app, preview string) error {
	if app == "" && preview == "" {
		return nil
	}
	a, err := parseOrigin(app)
	if err != nil {
		return err
	}
	if preview == "" {
		return nil
	}
	p, err := parseOrigin(preview)
	if err != nil {
		return err
	}
	if a.Scheme != p.Scheme {
		return errors.New("appOrigin and previewOrigin must use the same HTTP or HTTPS scheme")
	}
	return nil
}

func parseOrigin(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil ||
		u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		strings.ContainsAny(value, "#\\") {
		return nil, errors.New("appOrigin and previewOrigin must both be HTTP or HTTPS origins without paths, queries, fragments or credentials")
	}
	host := u.Hostname()
	if host == "" || strings.HasSuffix(u.Host, ":") || strings.HasSuffix(host, ".") {
		return nil, errors.New("origins must contain a valid hostname")
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsUnspecified() {
			return nil, errors.New("origins must use a reachable hostname or IP address, not a wildcard bind address")
		}
	} else {
		// Browsers reinterpret numeric hostnames as IPv4, including short,
		// octal, hexadecimal and integer forms that net/url leaves unchanged.
		// Require ordinary dotted decimal IPs to keep cookie isolation stable.
		last := host[strings.LastIndex(host, ".")+1:]
		numeric := last != "" && strings.Trim(last, "0123456789") == ""
		_, hexErr := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(last), "0x"), 16, 32)
		if numeric || strings.HasPrefix(strings.ToLower(last), "0x") && hexErr == nil {
			return nil, errors.New("origin IP addresses must use canonical notation")
		}
		if len(host) > 253 {
			return nil, errors.New("origin hostname is too long")
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
				return nil, errors.New("origins must contain a valid hostname")
			}
			for _, c := range label {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
					return nil, errors.New("origins must contain an ASCII hostname")
				}
			}
		}
	}
	if port := u.Port(); port != "" {
		n, err := strconv.ParseUint(port, 10, 16)
		if err != nil || n == 0 || strconv.FormatUint(n, 10) != port {
			return nil, errors.New("origin port must be between 1 and 65535 without leading zeros")
		}
	}
	return u, nil
}
