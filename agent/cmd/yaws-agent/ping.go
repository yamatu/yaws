package main

import (
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type pingRequest struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Target    string `json:"target"`
}
type pingResult struct {
	Type      string   `json:"type"`
	RequestID string   `json:"requestId"`
	LatencyMS *float64 `json:"latencyMs"`
	Error     string   `json:"error,omitempty"`
}

var hostLabel = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)
var latencyPattern = regexp.MustCompile(`(?i)[=<]\s*(\d+(?:[.,]\d+)?)\s*(?:ms|毫秒)`)

func validPingTarget(target string) bool {
	if len(target) == 0 || len(target) > 253 || strings.ContainsAny(target, "%/\\ \t\r\n") {
		return false
	}
	if net.ParseIP(target) != nil {
		return true
	}
	for _, label := range strings.Split(target, ".") {
		if !hostLabel.MatchString(label) {
			return false
		}
	}
	return true
}

type cappedOutput struct{ bytes.Buffer }

func (b *cappedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 32768 {
		_, _ = b.Buffer.Write(p[:min(n, 32768-b.Len())])
	}
	return n, nil
}

func measurePing(ctx context.Context, request pingRequest) pingResult {
	result := pingResult{Type: "ping_result", RequestID: request.RequestID}
	if !validPingTarget(request.Target) {
		result.Error = "bad_target"
		return result
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	args := []string{"-n", "-c", "1", "-W", "2", request.Target}
	if runtime.GOOS == "windows" {
		args = []string{"-n", "1", "-w", "2000", request.Target}
	}
	if runtime.GOOS == "darwin" {
		args = []string{"-n", "-c", "1", "-W", "2000", request.Target}
	}
	cmd := exec.CommandContext(ctx, "ping", args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	var output cappedOutput
	cmd.Stdout = &output
	err := cmd.Run()
	if err != nil {
		if _, ok := err.(*exec.Error); ok {
			result.Error = "ping_unavailable"
		} else {
			result.Error = "timeout_or_unreachable"
		}
		return result
	}
	match := latencyPattern.FindStringSubmatch(output.String())
	if len(match) < 2 {
		result.Error = "timeout_or_unreachable"
		return result
	}
	value, err := strconv.ParseFloat(strings.ReplaceAll(match[1], ",", "."), 64)
	if err != nil {
		result.Error = "invalid_result"
		return result
	}
	result.LatencyMS = &value
	return result
}
