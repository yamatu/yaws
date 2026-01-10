//go:build linux

package main

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
)

type sysInfo struct {
	OSName        string
	OSVersion     string
	Arch          string
	KernelVersion string
	CPUModel      string
	CPUCores      int
}

func getSysInfo() sysInfo {
	info := sysInfo{
		OSName:    runtime.GOOS,
		OSVersion: "",
		Arch:      runtime.GOARCH,
		CPUCores:  runtime.NumCPU(),
	}

	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		info.KernelVersion = strings.TrimSpace(string(b))
	}

	if name, ver := readOSRelease(); name != "" {
		info.OSName = name
		info.OSVersion = ver
	}

	info.CPUModel = readCPUModel()
	return info
}

func readOSRelease() (name, version string) {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "", ""
	}
	m := parseKeyValues(string(b))
	if v := strings.TrimSpace(m["PRETTY_NAME"]); v != "" {
		return trimQuotes(v), ""
	}
	n := trimQuotes(strings.TrimSpace(m["NAME"]))
	ver := trimQuotes(strings.TrimSpace(m["VERSION_ID"]))
	if n == "" {
		return "", ""
	}
	return n, ver
}

func trimQuotes(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "\"")
	s = strings.TrimSuffix(s, "\"")
	return s
}

func parseKeyValues(content string) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(content))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		out[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}
	return out
}

func readCPUModel() string {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	defer f.Close()

	var model string
	var hardware string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "model name") {
			if parts := strings.SplitN(line, ":", 2); len(parts) == 2 {
				model = strings.TrimSpace(parts[1])
				break
			}
		}
		if strings.HasPrefix(line, "Hardware") {
			if parts := strings.SplitN(line, ":", 2); len(parts) == 2 {
				hardware = strings.TrimSpace(parts[1])
			}
		}
	}
	if model != "" {
		return model
	}
	if hardware != "" {
		return hardware
	}
	// fallback: count processors and return generic
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		n := strings.Count(string(b), "\nprocessor\t:")
		if n > 0 {
			return "CPU x" + strconv.Itoa(n)
		}
	}
	return ""
}
