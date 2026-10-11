package pdfpreview

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
)

const (
	maxOutlineBytes = 512 << 10
	maxOutlineItems = 500
	maxOutlineDepth = 32
	maxOutlineTitle = 4096
)

func (p *poppler) outline(ctx context.Context, file *os.File, pages int) (Outline, error) {
	if p.pdftohtml == "" {
		return Outline{}, ErrOutlineUnavailable
	}
	// Poppler emits the complete outline after the selected page's XML.
	// stdout/XML/ignore-images avoid generated files; Linux also forbids writes
	// to regular files. The source stays anonymous and is inherited as fd 3.
	output, err := p.runWithFileLimit(ctx, file, p.pdftohtml,
		[]string{"-xml", "-stdout", "-i", "-enc", "UTF-8", "-f", "1", "-l", "1"}, maxOutlineBytes, 0)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return Outline{}, err
		}
		return Outline{}, ErrOutlineUnavailable
	}
	return parseOutline(output, pages)
}

func parseOutline(data []byte, pages int) (Outline, error) {
	if len(data) > maxOutlineBytes {
		return Outline{}, ErrOutlineUnavailable
	}
	result := Outline{Items: []OutlineItem{}}
	// encoding/xml does not fetch the external DTD declared by pdftohtml.
	decoder := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	started, ended := false, false
	for {
		token, err := decoder.Token()
		if err == io.EOF && started && ended {
			return result, nil
		}
		if err != nil {
			return Outline{}, ErrOutlineUnavailable
		}
		switch token := token.(type) {
		case xml.StartElement:
			if !started {
				if token.Name.Local != "pdf2xml" {
					return Outline{}, ErrOutlineUnavailable
				}
				started = true
				continue
			}
			if ended {
				return Outline{}, ErrOutlineUnavailable
			}
			switch token.Name.Local {
			case "outline":
				depth++
			case "item":
				if depth == 0 {
					return Outline{}, ErrOutlineUnavailable
				}
				var item struct {
					Title string `xml:",chardata"`
					Page  string `xml:"page,attr"`
				}
				if err := decoder.DecodeElement(&item, &token); err != nil {
					return Outline{}, ErrOutlineUnavailable
				}
				if depth > maxOutlineDepth || len(result.Items) == maxOutlineItems {
					result.Truncated = true
					continue
				}
				title := strings.TrimSpace(item.Title)
				count := 0
				for offset := range title {
					if count == maxOutlineTitle {
						title = title[:offset]
						result.Truncated = true
						break
					}
					count++
				}
				if title == "" {
					title = "Untitled section"
				}
				entry := OutlineItem{Title: title, Depth: depth - 1}
				if number, err := strconv.Atoi(item.Page); err == nil && number > 0 && number <= pages {
					entry.Page = &number
				}
				result.Items = append(result.Items, entry)
			case "page":
				if depth != 0 || decoder.Skip() != nil {
					return Outline{}, ErrOutlineUnavailable
				}
			default:
				return Outline{}, ErrOutlineUnavailable
			}
		case xml.EndElement:
			switch token.Name.Local {
			case "outline":
				depth--
			case "pdf2xml":
				if depth != 0 {
					return Outline{}, ErrOutlineUnavailable
				}
				ended = true
			default:
				return Outline{}, ErrOutlineUnavailable
			}
		case xml.CharData:
			if strings.TrimSpace(string(token)) != "" {
				return Outline{}, ErrOutlineUnavailable
			}
		}
	}
}
