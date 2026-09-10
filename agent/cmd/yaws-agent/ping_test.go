package main

import (
	"context"
	"os/exec"
	"testing"
)

func TestPingTargets(t *testing.T) {
	for _, target := range []string{"127.0.0.1", "::1", "2001:4860:4860::8888", "google.com"} {
		if !validPingTarget(target) {
			t.Errorf("rejected %q", target)
		}
	}
	for _, target := range []string{"", "-c", "google.com;id", "a b", "a\nb", "a/../b", "localhost%0", "http://google.com"} {
		if validPingTarget(target) {
			t.Errorf("accepted %q", target)
		}
	}
}

func TestPingValidation(t *testing.T) {
	result := measurePing(context.Background(), pingRequest{RequestID: "request-1", Target: "; echo injection"})
	if result.Error != "bad_target" || result.LatencyMS != nil || result.RequestID != "request-1" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestPingReplyParser(t *testing.T) {
	for _, line := range []string{"64 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=18.75 ms", "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128"} {
		if !latencyPattern.MatchString(line) {
			t.Fatalf("missing reply latency: %s", line)
		}
	}
	if latencyPattern.MatchString("From 10.0.0.1 Destination Host Unreachable") {
		t.Fatal("unreachable is not a successful ping")
	}
}

func TestLoopbackProbe(t *testing.T) {
	if _, err := exec.LookPath("ping"); err != nil {
		t.Skip("ping utility unavailable")
	}
	result := measurePing(context.Background(), pingRequest{RequestID: "loopback", Target: "127.0.0.1"})
	if result.Error != "" || result.LatencyMS == nil {
		t.Fatalf("loopback probe failed: %#v", result)
	}
}
