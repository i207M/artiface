package pdfpreview

import (
	"bytes"
	"context"
	"image/jpeg"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type poppler struct{ pdfinfo, pdftoppm, pdftohtml, prlimit string }

func newPoppler() *poppler {
	p := &poppler{}
	p.pdfinfo, _ = exec.LookPath("pdfinfo")
	p.pdftoppm, _ = exec.LookPath("pdftoppm")
	p.pdftohtml, _ = exec.LookPath("pdftohtml")
	p.prlimit, _ = exec.LookPath("prlimit")
	return p
}

func (p *poppler) available() bool {
	return runtime.GOOS != "windows" && p.pdfinfo != "" && p.pdftoppm != "" && (runtime.GOOS != "linux" || p.prlimit != "")
}

type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	if len(data) > b.limit-b.Len() {
		return 0, ErrInvalid
	}
	return b.Buffer.Write(data)
}

func (p *poppler) run(ctx context.Context, file *os.File, program string, args []string, limit int) ([]byte, error) {
	return p.runWithFileLimit(ctx, file, program, args, limit, 16<<20)
}

func (p *poppler) runWithFileLimit(ctx context.Context, file *os.File, program string, args []string, limit, fileLimit int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	fdPath := "/dev/fd/3"
	if runtime.GOOS == "linux" {
		fdPath = "/proc/self/fd/3"
	}
	args = append(args, fdPath)
	if runtime.GOOS == "linux" {
		args = append([]string{"--as=1073741824", "--cpu=30", "--fsize=" + strconv.Itoa(fileLimit), "--core=0", "--nofile=64", "--", program}, args...)
		program = p.prlimit
	}
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.ExtraFiles = []*os.File{file}
	cmd.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin", "HOME=/nonexistent", "XDG_CACHE_HOME=/nonexistent"}
	cmd.WaitDelay = 2 * time.Second
	output := &boundedBuffer{limit: limit}
	cmd.Stdout = output
	// Parser diagnostics may contain document contents or filesystem paths.
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrInvalid
	}
	return output.Bytes(), nil
}

var pageSizePattern = regexp.MustCompile(`(?m)^Page\s+(?:[0-9]+\s+)?size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts`)
var rotationPattern = regexp.MustCompile(`(?m)^Page\s+(?:[0-9]+\s+)?rot:\s+(-?[0-9]+)`)

func parseInfo(data []byte) (Info, error) {
	var result Info
	for line := range strings.SplitSeq(string(data), "\n") {
		if value, ok := strings.CutPrefix(line, "Pages:"); ok {
			result.Pages, _ = strconv.Atoi(strings.TrimSpace(value))
		}
	}
	// Standard fields follow arbitrary title/author metadata; use the last match.
	sizes := pageSizePattern.FindAllSubmatch(data, -1)
	if len(sizes) == 0 {
		return Info{}, ErrInvalid
	}
	last := sizes[len(sizes)-1]
	result.Width, _ = strconv.ParseFloat(string(last[1]), 64)
	result.Height, _ = strconv.ParseFloat(string(last[2]), 64)
	if result.Pages < 1 || result.Pages > 10000 || result.Width < 1 || result.Height < 1 ||
		result.Width > 100000 || result.Height > 100000 || math.IsNaN(result.Width) || math.IsNaN(result.Height) {
		return Info{}, ErrInvalid
	}
	rotations := rotationPattern.FindAllSubmatch(data, -1)
	if len(rotations) > 0 {
		rotation, _ := strconv.Atoi(string(rotations[len(rotations)-1][1]))
		if rotation%180 != 0 {
			result.Width, result.Height = result.Height, result.Width
		}
	}
	return result, nil
}

func (p *poppler) info(ctx context.Context, file *os.File, page int) (Info, error) {
	output, err := p.run(ctx, file, p.pdfinfo, []string{"-f", strconv.Itoa(page), "-l", strconv.Itoa(page)}, 512<<10)
	if err != nil {
		return Info{}, err
	}
	return parseInfo(output)
}

func (p *poppler) page(ctx context.Context, file *os.File, number, size int) (Page, error) {
	info, err := p.info(ctx, file, number)
	if err != nil {
		return Page{}, err
	}
	output, err := p.run(ctx, file, p.pdftoppm, []string{
		"-f", strconv.Itoa(number), "-l", strconv.Itoa(number), "-singlefile",
		"-scale-to", strconv.Itoa(size), "-jpeg", "-jpegopt", "quality=90,optimize=y", "-cropbox", "-hide-annotations",
	}, 8<<20)
	if err != nil {
		return Page{}, err
	}
	dimensions, err := jpeg.DecodeConfig(bytes.NewReader(output))
	if err != nil || dimensions.Width < 1 || dimensions.Height < 1 || dimensions.Width > size+1 || dimensions.Height > size+1 {
		return Page{}, ErrInvalid
	}
	return Page{JPEG: output, Width: info.Width, Height: info.Height}, nil
}
